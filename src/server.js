'use strict';
/*
 * Bot-PR Backlog Janitor server: webhook receiver + live state tracker.
 *
 * Event flow:
 *  - pull_request (bot-authored only):
 *      opened/reopened -> record the PR, resolve its owner from
 *        CODEOWNERS, then run supersede checks both ways: older open
 *        PRs for the same package are closed as superseded by this
 *        one, and if a NEWER PR for the package already exists, this
 *        one is itself superseded (out-of-order delivery).
 *      synchronize -> refresh head/updated timestamp.
 *      closed -> record merged/closed.
 *  - check_suite completed -> CI state (success/failure) for every PR
 *    the suite names.
 *  - issue_comment created on a PR -> `/janitor snooze ...` commands
 *    from OWNER/MEMBER/COLLABORATOR authors set or clear snoozes.
 *  - installation -> bookkeeping.
 *
 * Aging/escalation live in the daily sweep (src/sweep.js); this server
 * keeps the state they evaluate fresh and handles the one action that
 * shouldn't wait a day: supersede.
 */
const http = require('http');
const { verifyWebhookSignature } = require('./github');
const logic = require('./logic');
const { applyActions, resolveOwner } = require('./actions');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function prRecordFromPayload(repo, payload) {
  const pr = payload.pull_request;
  const bump = logic.parseBump(pr.title, pr.head && pr.head.ref);
  return {
    repoId: repo.id,
    repoFullName: repo.full_name,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    bot: logic.botKind(pr.user && pr.user.login),
    authorLogin: pr.user && pr.user.login,
    packageName: bump.packageName,
    bumpType: bump.bumpType,
    fromVersion: bump.fromVersion,
    toVersion: bump.toVersion,
    branch: pr.head && pr.head.ref,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    state: pr.state === 'closed' ? (pr.merged_at ? 'merged' : 'closed') : 'open',
  };
}

function createServer({ store, github, webhookSecret, config, log }) {
  const logger = log || (() => {});
  const cfg = { ...logic.DEFAULT_CONFIG, ...(config || {}) };

  async function evaluateAndApply(repo, repoRecord, pr) {
    const newer = store.findNewerPrForPackage(pr.repoId, pr.packageName, pr.number);
    const actions = logic.evaluatePr(pr, { nowMs: Date.now(), config: cfg, supersededBy: newer ? newer.number : null });
    if (actions.length) await applyActions({ github, store, repo: repoRecord, pr, actions, log: logger });
  }

  async function handlePullRequest(payload) {
    const repo = payload.repository;
    const installationId = payload.installation && payload.installation.id;
    if (!repo || !installationId || !payload.pull_request) return;
    const author = payload.pull_request.user && payload.pull_request.user.login;
    if (!logic.isBotAuthor(author)) return; // human PRs are not our queue
    store.recordRepo(repo, installationId);
    const repoRecord = store.getRepo(repo.id);

    if (payload.action === 'opened' || payload.action === 'reopened') {
      let pr = store.upsertPr(prRecordFromPayload(repo, payload));
      pr = await resolveOwner({ github, store, repo: repoRecord, pr, log: logger });
      // Older open PRs for the same package are superseded by this one.
      const older = store.findOlderPrsForPackage(repo.id, pr.packageName, pr.number);
      for (const old of older) {
        const actions = logic.evaluatePr(old, { nowMs: Date.now(), config: cfg, supersededBy: pr.number });
        if (actions.length) await applyActions({ github, store, repo: repoRecord, pr: old, actions, log: logger });
      }
      // And this one may itself already be superseded (late delivery).
      await evaluateAndApply(repo, repoRecord, store.getPr(repo.id, pr.number) || pr);
      logger(`tracked: ${repo.full_name} #${pr.number} (${pr.bot}, ${pr.packageName || '?'} ${pr.bumpType})`);
      return;
    }

    if (payload.action === 'synchronize') {
      store.upsertPr({ repoId: repo.id, number: payload.pull_request.number, updatedAt: payload.pull_request.updated_at });
      return;
    }

    if (payload.action === 'closed') {
      const merged = Boolean(payload.pull_request.merged_at);
      store.upsertPr({ repoId: repo.id, number: payload.pull_request.number, state: merged ? 'merged' : 'closed' });
      logger(`closed: ${repo.full_name} #${payload.pull_request.number} (${merged ? 'merged' : 'closed'})`);
    }
  }

  async function handleCheckSuite(payload) {
    if (payload.action !== 'completed') return;
    const repo = payload.repository;
    const suite = payload.check_suite;
    if (!repo || !suite) return;
    const ciState = suite.conclusion === 'success' ? 'success' : suite.conclusion === 'failure' ? 'failure' : null;
    if (!ciState) return;
    for (const prRef of suite.pull_requests || []) {
      const existing = store.getPr(repo.id, prRef.number);
      if (existing) store.updatePr(repo.id, prRef.number, { ciState });
    }
  }

  const PRIVILEGED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

  async function handleIssueComment(payload) {
    if (payload.action !== 'created') return;
    const issue = payload.issue;
    const comment = payload.comment;
    if (!issue || !issue.pull_request || !comment) return; // PR comments only
    if (logic.isBotAuthor(comment.user && comment.user.login)) return;
    if (!PRIVILEGED_ASSOCIATIONS.has(comment.author_association)) return;
    const command = logic.parseSnoozeCommand(comment.body, Date.now());
    if (!command) return;
    const repo = payload.repository;
    const installationId = payload.installation && payload.installation.id;
    if (!repo || !installationId) return;
    const pr = store.getPr(repo.id, issue.number);
    if (!pr) return;
    store.recordRepo(repo, installationId);
    const repoRecord = store.getRepo(repo.id);
    const owner = repo.owner.login;

    if (command.type === 'snooze') {
      store.updatePr(repo.id, issue.number, { snoozedUntil: command.untilISO, snoozeSetBy: comment.user.login });
      await github.addLabels(installationId, owner, repo.name, issue.number, [logic.LABELS.snoozed]);
      await github.createComment(installationId, owner, repo.name, issue.number,
        logic.commentBody('snoozed', pr, { nowMs: Date.now(), until: command.untilISO.slice(0, 10) }));
      store.appendEvent({ repoId: repo.id, number: issue.number, action: `snooze:${command.untilISO}` });
      logger(`snoozed: ${repo.full_name} #${issue.number} until ${command.untilISO} by ${comment.user.login}`);
    } else {
      store.updatePr(repo.id, issue.number, { snoozedUntil: null, snoozeSetBy: null });
      await github.removeLabel(installationId, owner, repo.name, issue.number, logic.LABELS.snoozed);
      await github.createComment(installationId, owner, repo.name, issue.number,
        logic.commentBody('unsnoozed', pr, { nowMs: Date.now() }));
      store.appendEvent({ repoId: repo.id, number: issue.number, action: 'unsnooze' });
      logger(`unsnoozed: ${repo.full_name} #${issue.number} by ${comment.user.login}`);
    }
    void repoRecord;
  }

  async function route(event, payload) {
    if (event === 'installation') {
      if (payload.action === 'created') store.recordInstallation(payload.installation);
      if (payload.action === 'deleted' || payload.action === 'suspend') store.suspendInstallation(payload.installation.id);
      return;
    }
    if (event === 'pull_request') await handlePullRequest(payload);
    else if (event === 'check_suite') await handleCheckSuite(payload);
    else if (event === 'issue_comment') await handleIssueComment(payload);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'bot-pr-janitor' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/webhooks') {
      res.writeHead(404); res.end('not found'); return;
    }
    const raw = await readBody(req);
    if (!verifyWebhookSignature(raw, req.headers['x-hub-signature-256'], webhookSecret)) {
      res.writeHead(401); res.end('bad signature'); return;
    }
    // Acknowledge fast; process async so slow API calls don't make
    // GitHub mark the delivery failed.
    res.writeHead(202); res.end('accepted');
    try {
      const payload = JSON.parse(raw.toString('utf8'));
      await route(req.headers['x-github-event'], payload);
    } catch (err) {
      logger(`handler error: ${err.message}`);
    }
  });
  return server;
}

function configFromEnv() {
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    agingDays: num(process.env.JANITOR_AGING_DAYS, logic.DEFAULT_CONFIG.agingDays),
    escalateDays: num(process.env.JANITOR_ESCALATE_DAYS, logic.DEFAULT_CONFIG.escalateDays),
    criticalDays: num(process.env.JANITOR_CRITICAL_DAYS, logic.DEFAULT_CONFIG.criticalDays),
    failingGraceDays: num(process.env.JANITOR_FAILING_GRACE_DAYS, logic.DEFAULT_CONFIG.failingGraceDays),
  };
}

function main() {
  const fs = require('fs');
  const { Store } = require('./store');
  const { makeGithubClient } = require('./github');
  const env = {
    port: parseInt(process.env.PORT || '8932', 10),
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY_PATH
      ? fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')
      : process.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    storePath: process.env.JANITOR_STORE || require('path').join(__dirname, '..', 'data', 'store.json'),
  };
  if (!env.appId || !env.privateKey || !env.webhookSecret) {
    console.error('Missing GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY(_PATH) / GITHUB_WEBHOOK_SECRET');
    process.exit(2);
  }
  const store = new Store(env.storePath);
  const github = makeGithubClient({ appId: env.appId, privateKeyPem: env.privateKey });
  const server = createServer({ store, github, webhookSecret: env.webhookSecret, config: configFromEnv(), log: (m) => console.log(new Date().toISOString(), m) });
  server.listen(env.port, () => console.log(`Bot-PR Janitor listening on :${env.port}`));
}

if (require.main === module) main();

module.exports = { createServer, prRecordFromPayload, configFromEnv };
