'use strict';
/*
 * Scheduled jobs for the Janitor.
 *
 *   node src/sweep.js daily    — for every installed repo: backfill any
 *     bot PRs the webhooks missed (restart windows, redeliveries),
 *     resolve missing owners, then evaluate the state machine over all
 *     open bot PRs and execute the resulting actions (aging labels,
 *     reviewer requests, failing labels, escalations, supersede closes).
 *
 *   node src/sweep.js digest   — one digest issue per repo per ISO
 *     week: created on first run of the week, updated (not duplicated)
 *     on later runs. The stored issue number lives in the store.
 *
 * Cron shape (deployment, not in this repo's control):
 *   15 6 * * *   sweep.js daily
 *   30 7 * * 1   sweep.js digest
 */
const logic = require('./logic');
const { applyActions, resolveOwner } = require('./actions');
const { prRecordFromPayload } = require('./server');

async function backfillRepo({ github, store, repo, log }) {
  const logger = log || (() => {});
  let prs;
  try {
    prs = await github.listOpenPullRequests(repo.installationId, repo.owner, repo.name);
  } catch (err) {
    logger(`backfill failed for ${repo.fullName}: ${err.message}`);
    return;
  }
  for (const pr of prs) {
    const author = pr.user && pr.user.login;
    if (!logic.isBotAuthor(author)) continue;
    if (store.getPr(repo.id, pr.number)) continue; // webhooks already track it
    const record = prRecordFromPayload(
      { id: repo.id, full_name: repo.fullName },
      { pull_request: pr },
    );
    store.upsertPr(record);
    logger(`backfilled: ${repo.fullName} #${pr.number} (${record.packageName || '?'})`);
  }
}

async function runDaily({ github, store, config, log }) {
  const logger = log || (() => {});
  const cfg = { ...logic.DEFAULT_CONFIG, ...(config || {}) };
  let acted = 0;
  for (const repo of store.listRepos()) {
    await backfillRepo({ github, store, repo, log: logger });
    for (let pr of store.listPrsForRepo(repo.id)) {
      if (pr.state !== 'open') continue;
      if (!pr.owner) pr = await resolveOwner({ github, store, repo, pr, log: logger });
      const newer = store.findNewerPrForPackage(repo.id, pr.packageName, pr.number);
      const actions = logic.evaluatePr(pr, { nowMs: Date.now(), config: cfg, supersededBy: newer ? newer.number : null });
      if (actions.length) {
        await applyActions({ github, store, repo, pr, actions, log: logger });
        acted++;
      }
    }
  }
  logger(`daily sweep complete: ${acted} PR(s) acted on`);
  return acted;
}

async function runDigest({ github, store, log, nowMs }) {
  const logger = log || (() => {});
  const now = nowMs || Date.now();
  const weekKey = logic.isoWeekKey(new Date(now));
  let count = 0;
  for (const repo of store.listRepos()) {
    if (repo.digestEnabled === false) continue;
    const prs = store.listPrsForRepo(repo.id);
    const body = logic.buildDigestMarkdown(repo.fullName, prs, now);
    const title = `🧹 Bot-PR backlog digest — ${weekKey}`;
    const existing = store.getDigest(repo.id, weekKey);
    if (existing) {
      await github.updateIssue(repo.installationId, repo.owner, repo.name, existing.issueNumber, body);
      logger(`digest updated: ${repo.fullName} issue #${existing.issueNumber} (${weekKey})`);
    } else {
      const issue = await github.createIssue(repo.installationId, repo.owner, repo.name, title, body);
      store.setDigest(repo.id, weekKey, issue.number);
      logger(`digest created: ${repo.fullName} issue #${issue.number} (${weekKey})`);
    }
    count++;
  }
  return count;
}

function main() {
  const fs = require('fs');
  const { Store } = require('./store');
  const { makeGithubClient } = require('./github');
  const { configFromEnv } = require('./server');
  const mode = process.argv[2] || 'daily';
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY_PATH
    ? fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8')
    : process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    console.error('Missing GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY(_PATH)');
    process.exit(2);
  }
  const store = new Store(process.env.JANITOR_STORE || require('path').join(__dirname, '..', 'data', 'store.json'));
  const github = makeGithubClient({ appId, privateKeyPem: privateKey });
  const log = (m) => console.log(new Date().toISOString(), m);
  const run = mode === 'digest'
    ? runDigest({ github, store, log })
    : runDaily({ github, store, config: configFromEnv(), log });
  run.then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

if (require.main === module) main();

module.exports = { runDaily, runDigest, backfillRepo };
