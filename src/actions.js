'use strict';
/*
 * Executes the actions logic.evaluatePr returns, and resolves PR
 * ownership from CODEOWNERS. All GitHub writes go through here so the
 * server (live events) and the sweep (scheduled) behave identically.
 */
const { resolveOwners, splitTeam, LABELS } = require('./logic');

const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

// In-process CODEOWNERS cache: repoId -> { text, fetchedAtMs }.
// The sweep is a fresh process each run, so this only dedupes within a
// run — which is exactly where the repeated fetches would happen.
const codeownersCache = new Map();
const CODEOWNERS_TTL_MS = 10 * 60_000;

async function fetchCodeowners(github, repo) {
  const cached = codeownersCache.get(repo.id);
  if (cached && Date.now() - cached.fetchedAtMs < CODEOWNERS_TTL_MS) return cached.text;
  let text = null;
  for (const p of CODEOWNERS_PATHS) {
    text = await github.getFileContent(repo.installationId, repo.owner, repo.name, p);
    if (text) break;
  }
  codeownersCache.set(repo.id, { text: text || '', fetchedAtMs: Date.now() });
  return text || '';
}

/*
 * Resolve and store the owner for a PR that doesn't have one yet.
 * Owner = first CODEOWNERS user whose pattern matches a changed file;
 * when only a team matches, the team (`org/slug`) is stored and used
 * as a team reviewer request. Returns the stored pr record.
 */
async function resolveOwner({ github, store, repo, pr, log }) {
  const logger = log || (() => {});
  if (pr.owner) return pr;
  try {
    const files = await github.listPullRequestFiles(repo.installationId, repo.owner, repo.name, pr.number);
    if (!files.length) return pr;
    const codeowners = await fetchCodeowners(github, repo);
    if (!codeowners) return pr;
    const { users, teams } = resolveOwners(codeowners, files);
    const owner = users[0] || teams[0] || null;
    if (owner) {
      const updated = store.updatePr(pr.repoId, pr.number, { owner, ownerSource: 'CODEOWNERS' });
      logger(`owner: ${repo.fullName} #${pr.number} -> ${owner} (CODEOWNERS)`);
      return updated || pr;
    }
  } catch (err) {
    logger(`owner resolution failed for ${repo.fullName} #${pr.number}: ${err.message}`);
  }
  return pr;
}

async function applyActions({ github, store, repo, pr, actions, log }) {
  const logger = log || (() => {});
  let current = pr;
  const labelsToAdd = new Set();
  for (const action of actions || []) {
    try {
      switch (action.type) {
        case 'add-label':
          labelsToAdd.add(action.label);
          break;
        case 'comment':
          await github.createComment(repo.installationId, repo.owner, repo.name, current.number, action.body);
          store.appendEvent({ repoId: repo.id, number: current.number, action: `comment:${action.kind}` });
          break;
        case 'request-reviewer': {
          if (!current.owner) break;
          const isTeam = String(current.owner).includes('/');
          const req = isTeam
            ? { reviewers: [], teamReviewers: [splitTeam(current.owner).slug] }
            : { reviewers: [current.owner], teamReviewers: [] };
          await github.requestReviewers(repo.installationId, repo.owner, repo.name, current.number, req);
          store.appendEvent({ repoId: repo.id, number: current.number, action: `request-reviewer:${current.owner}` });
          break;
        }
        case 'set-escalation':
          current = store.updatePr(current.repoId, current.number, { escalationLevel: action.level }) || current;
          break;
        case 'close-superseded':
          await github.closePullRequest(repo.installationId, repo.owner, repo.name, current.number);
          current = store.updatePr(current.repoId, current.number, {
            state: 'closed',
            closedAsSuperseded: true,
            supersededBy: action.supersededBy,
          }) || current;
          store.appendEvent({ repoId: repo.id, number: current.number, action: `closed-superseded-by:${action.supersededBy}` });
          logger(`superseded: ${repo.fullName} #${current.number} closed in favor of #${action.supersededBy}`);
          break;
        default:
          logger(`unknown action type: ${action.type}`);
      }
    } catch (err) {
      logger(`action ${action.type} failed for ${repo.fullName} #${current.number}: ${err.message}`);
    }
  }
  // Labels go out as one API call, and are recorded as applied only
  // after the call succeeds — labelsApplied is the state machine's
  // "already notified" memory.
  if (labelsToAdd.size) {
    const labels = [...labelsToAdd];
    await github.addLabels(repo.installationId, repo.owner, repo.name, current.number, labels);
    const applied = [...new Set([...(current.labelsApplied || []), ...labels])];
    current = store.updatePr(current.repoId, current.number, { labelsApplied: applied }) || current;
    store.appendEvent({ repoId: repo.id, number: current.number, action: `labels:${labels.join(',')}` });
  }
  return current;
}

module.exports = { applyActions, resolveOwner, fetchCodeowners, LABELS };
