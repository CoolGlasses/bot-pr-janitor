'use strict';
/*
 * Zero-dependency test runner: plain node + assert, in the SameTree
 * style. Covers the pure state machine, the store's cross-process
 * transaction discipline, the webhook server end-to-end over HTTP
 * with a mocked GitHub client, and the sweep/digest jobs.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const logic = require('../src/logic');
const { Store } = require('../src/store');
const { verifyWebhookSignature } = require('../src/github');
const { createServer } = require('../src/server');
const { runDaily, runDigest } = require('../src/sweep');

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok - ${name}`); })
    .catch((err) => { failed++; failures.push({ name, err }); console.log(`  FAIL - ${name}: ${err.message}`); });
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-test-'));
  return new Store(path.join(dir, 'store.json'));
}

function basePr(overrides) {
  return {
    repoId: 42,
    repoFullName: 'acme/widgets',
    number: 7,
    title: 'Bump lodash from 4.17.20 to 4.17.21',
    url: 'https://github.com/acme/widgets/pull/7',
    bot: 'dependabot',
    authorLogin: 'dependabot[bot]',
    packageName: 'lodash',
    bumpType: 'patch',
    branch: 'dependabot/npm_and_yarn/lodash-4.17.21',
    createdAt: new Date(NOW).toISOString(),
    state: 'open',
    ciState: 'unknown',
    owner: null,
    escalationLevel: 0,
    labelsApplied: [],
    snoozedUntil: null,
    closedAsSuperseded: false,
    ...overrides,
  };
}

/* ---------------- mock GitHub client ---------------- */
function makeMockGithub() {
  const calls = [];
  const codeowners = ['/src @alice', '*.md @acme/docs-team', '/src @bob', ''].join('\n');
  return {
    calls,
    find: (method) => calls.filter((c) => c.method === method),
    async addLabels(inst, owner, repo, number, labels) { calls.push({ method: 'addLabels', number, labels }); return {}; },
    async removeLabel(inst, owner, repo, number, label) { calls.push({ method: 'removeLabel', number, label }); return {}; },
    async createComment(inst, owner, repo, number, body) { calls.push({ method: 'createComment', number, body }); return { id: 1 }; },
    async requestReviewers(inst, owner, repo, number, req) { calls.push({ method: 'requestReviewers', number, req }); return {}; },
    async closePullRequest(inst, owner, repo, number) { calls.push({ method: 'closePullRequest', number }); return {}; },
    async listPullRequestFiles() { return ['src/index.js', 'README.md']; },
    async getFileContent(inst, owner, repo, p) { return p === '.github/CODEOWNERS' ? codeowners : null; },
    async listOpenPullRequests() { return []; },
    async createIssue(inst, owner, repo, title, body) { calls.push({ method: 'createIssue', title, body }); return { number: 99 }; },
    async updateIssue(inst, owner, repo, number, body) { calls.push({ method: 'updateIssue', number, body }); return {}; },
  };
}

/* ---------------- webhook fixtures ---------------- */
const REPO = { id: 42, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } };

function prPayload({ number, title, branch, authorLogin, createdAt }) {
  return {
    action: 'opened',
    installation: { id: 555 },
    repository: REPO,
    pull_request: {
      number,
      title,
      html_url: `https://github.com/acme/widgets/pull/${number}`,
      user: { login: authorLogin },
      head: { ref: branch },
      created_at: createdAt,
      updated_at: createdAt,
      state: 'open',
      merged_at: null,
    },
  };
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function postEvent(port, secret, event, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${port}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(secret, body) },
    body,
  });
  return res.status;
}

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main() {
  console.log('logic: classification');
  await test('isBotAuthor / botKind', () => {
    assert.strictEqual(logic.isBotAuthor('dependabot[bot]'), true);
    assert.strictEqual(logic.isBotAuthor('renovate[bot]'), true);
    assert.strictEqual(logic.isBotAuthor('alice'), false);
    assert.strictEqual(logic.botKind('renovate[bot]'), 'renovate');
    assert.strictEqual(logic.botKind('dependabot[bot]'), 'dependabot');
  });

  await test('parseBump: dependabot patch/minor/major', () => {
    assert.deepStrictEqual(logic.parseBump('Bump lodash from 4.17.20 to 4.17.21'),
      { packageName: 'lodash', fromVersion: '4.17.20', toVersion: '4.17.21', bumpType: 'patch' });
    assert.strictEqual(logic.parseBump('Bump lodash from 4.17.20 to 4.18.0').bumpType, 'minor');
    assert.strictEqual(logic.parseBump('Bump react from 17.0.2 to 18.2.0').bumpType, 'major');
  });

  await test('parseBump: renovate title + branch fallback', () => {
    const r = logic.parseBump('Update dependency lodash to v4.17.21');
    assert.strictEqual(r.packageName, 'lodash');
    assert.strictEqual(r.toVersion, '4.17.21');
    const b = logic.parseBump('chore(deps): update all non-major dependencies', 'renovate/all-minor-patch');
    assert.strictEqual(b.packageName, 'all-minor-patch');
  });

  console.log('logic: CODEOWNERS');
  await test('resolveOwners: anchored, glob, team, last-match-wins', () => {
    const text = ['/src @alice', '*.md @acme/docs-team', '/src @bob', ''].join('\n');
    const { users, teams } = logic.resolveOwners(text, ['src/index.js', 'README.md']);
    assert.deepStrictEqual(users, ['bob']); // /src @bob is the later rule
    assert.deepStrictEqual(teams, ['acme/docs-team']);
  });

  await test('resolveOwners: unanchored pattern matches at any depth', () => {
    const { users } = logic.resolveOwners('package.json @carol\n', ['deep/nested/package.json']);
    assert.deepStrictEqual(users, ['carol']);
  });

  console.log('logic: state machine');
  await test('evaluatePr: fresh PR -> no actions', () => {
    assert.deepStrictEqual(logic.evaluatePr(basePr(), { nowMs: NOW, supersededBy: null }), []);
  });

  await test('evaluatePr: aging tier 1 with owner -> label + reviewer + escalation 1', () => {
    const pr = basePr({ createdAt: new Date(NOW - 20 * DAY).toISOString(), owner: 'alice' });
    const actions = logic.evaluatePr(pr, { nowMs: NOW, supersededBy: null });
    const types = actions.map((a) => a.type);
    assert.ok(types.includes('add-label'));
    assert.ok(actions.some((a) => a.label === logic.LABELS.aging));
    assert.ok(types.includes('request-reviewer'));
    assert.ok(actions.some((a) => a.type === 'set-escalation' && a.level === 1));
  });

  await test('evaluatePr: aging tier 1 without owner -> needs-owner label, no reviewer request', () => {
    const pr = basePr({ createdAt: new Date(NOW - 20 * DAY).toISOString(), owner: null });
    const actions = logic.evaluatePr(pr, { nowMs: NOW, supersededBy: null });
    assert.ok(actions.some((a) => a.label === logic.LABELS.needsOwner));
    assert.ok(!actions.some((a) => a.type === 'request-reviewer'));
  });

  await test('evaluatePr: tier does not refire once reached', () => {
    const pr = basePr({ createdAt: new Date(NOW - 20 * DAY).toISOString(), escalationLevel: 1, labelsApplied: [logic.LABELS.aging], owner: 'alice' });
    assert.deepStrictEqual(logic.evaluatePr(pr, { nowMs: NOW, supersededBy: null }), []);
  });

  await test('evaluatePr: tier 2 escalation at 45d, tier 3 stale at 90d', () => {
    const t2 = logic.evaluatePr(basePr({ createdAt: new Date(NOW - 45 * DAY).toISOString(), escalationLevel: 1 }), { nowMs: NOW, supersededBy: null });
    assert.ok(t2.some((a) => a.type === 'comment' && a.kind === 'escalation'));
    assert.ok(t2.some((a) => a.type === 'set-escalation' && a.level === 2));
    const t3 = logic.evaluatePr(basePr({ createdAt: new Date(NOW - 90 * DAY).toISOString(), escalationLevel: 2 }), { nowMs: NOW, supersededBy: null });
    assert.ok(t3.some((a) => a.label === logic.LABELS.stale));
    assert.ok(t3.some((a) => a.type === 'set-escalation' && a.level === 3));
  });

  await test('evaluatePr: failing CI past grace -> failing label; inside grace -> none', () => {
    const old = logic.evaluatePr(basePr({ ciState: 'failure', createdAt: new Date(NOW - 5 * DAY).toISOString() }), { nowMs: NOW, supersededBy: null });
    assert.ok(old.some((a) => a.label === logic.LABELS.failing));
    const young = logic.evaluatePr(basePr({ ciState: 'failure', createdAt: new Date(NOW - 1 * DAY).toISOString() }), { nowMs: NOW, supersededBy: null });
    assert.deepStrictEqual(young, []);
  });

  await test('evaluatePr: snoozed PR is never nagged', () => {
    const pr = basePr({ ciState: 'failure', createdAt: new Date(NOW - 90 * DAY).toISOString(), snoozedUntil: new Date(NOW + 7 * DAY).toISOString() });
    assert.deepStrictEqual(logic.evaluatePr(pr, { nowMs: NOW, supersededBy: null }), []);
  });

  await test('evaluatePr: superseded closes even while snoozed', () => {
    const pr = basePr({ snoozedUntil: new Date(NOW + 7 * DAY).toISOString() });
    const actions = logic.evaluatePr(pr, { nowMs: NOW, supersededBy: 12 });
    assert.ok(actions.some((a) => a.type === 'close-superseded' && a.supersededBy === 12));
    assert.ok(actions.some((a) => a.label === logic.LABELS.superseded));
  });

  await test('evaluatePr: closed PR -> no actions', () => {
    const pr = basePr({ state: 'merged', createdAt: new Date(NOW - 90 * DAY).toISOString() });
    assert.deepStrictEqual(logic.evaluatePr(pr, { nowMs: NOW, supersededBy: 12 }), []);
  });

  console.log('logic: snooze commands + digest');
  await test('parseSnoozeCommand: durations, until, unsnooze, defaults, non-commands', () => {
    assert.strictEqual(logic.parseSnoozeCommand('/janitor snooze 14d', NOW).untilISO, new Date(NOW + 14 * DAY).toISOString());
    assert.strictEqual(logic.parseSnoozeCommand('/janitor snooze 2w', NOW).untilISO, new Date(NOW + 14 * DAY).toISOString());
    assert.strictEqual(logic.parseSnoozeCommand('/janitor snooze until 2026-12-01', NOW).untilISO, '2026-12-01T23:59:59.000Z');
    assert.strictEqual(logic.parseSnoozeCommand('/janitor snooze', NOW).untilISO, new Date(NOW + 7 * DAY).toISOString());
    assert.deepStrictEqual(logic.parseSnoozeCommand('/janitor unsnooze', NOW), { type: 'unsnooze' });
    assert.strictEqual(logic.parseSnoozeCommand('looks good to me', NOW), null);
  });

  await test('isoWeekKey matches the system ISO calendar', () => {
    assert.strictEqual(logic.isoWeekKey(new Date('2026-11-13T12:00:00Z')), '2026-W46');
  });

  await test('buildDigestMarkdown: counts + no-owner section', () => {
    const prs = [
      basePr({ number: 7 }),
      basePr({ number: 8, ciState: 'failure', owner: 'alice', packageName: 'react', createdAt: new Date(NOW - 40 * DAY).toISOString(), escalationLevel: 2 }),
    ];
    const md = logic.buildDigestMarkdown('acme/widgets', prs, NOW);
    assert.ok(md.includes('**2** open bot PRs'));
    assert.ok(md.includes('**1** failing CI'));
    assert.ok(md.includes('### No owner named'));
    assert.ok(md.includes('#7'));
  });

  console.log('store');
  await test('upsertPr: null fields never erase known values', () => {
    const store = tmpStore();
    store.upsertPr(basePr());
    store.upsertPr({ repoId: 42, number: 7, ciState: 'failure', packageName: null });
    const pr = store.getPr(42, 7);
    assert.strictEqual(pr.ciState, 'failure');
    assert.strictEqual(pr.packageName, 'lodash');
  });

  await test('store: two processes transacting do not lose each other\'s writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-race-'));
    const file = path.join(dir, 'store.json');
    const a = new Store(file);
    const b = new Store(file);
    a.upsertPr(basePr({ number: 1 }));
    // b still holds its stale empty snapshot in memory; its transact
    // must reload before writing or PR #1 is lost.
    b.upsertPr(basePr({ number: 2 }));
    const check = new Store(file);
    assert.ok(check.getPr(42, 1));
    assert.ok(check.getPr(42, 2));
  });

  await test('store: supersede oracles', () => {
    const store = tmpStore();
    store.upsertPr(basePr({ number: 5 }));
    store.upsertPr(basePr({ number: 9 }));
    store.upsertPr(basePr({ number: 9, state: 'closed' }));
    store.upsertPr(basePr({ number: 9, state: 'open' }));
    assert.strictEqual(store.findNewerPrForPackage(42, 'lodash', 5).number, 9);
    assert.strictEqual(store.findNewerPrForPackage(42, 'lodash', 9), null);
    assert.deepStrictEqual(store.findOlderPrsForPackage(42, 'lodash', 9).map((p) => p.number), [5]);
    assert.strictEqual(store.findNewerPrForPackage(42, null, 5), null);
  });

  console.log('github');
  await test('verifyWebhookSignature accepts good, rejects bad', () => {
    const body = Buffer.from('{"a":1}');
    const good = sign('sekrit', body);
    assert.strictEqual(verifyWebhookSignature(body, good, 'sekrit'), true);
    assert.strictEqual(verifyWebhookSignature(body, good, 'other'), false);
    assert.strictEqual(verifyWebhookSignature(body, null, 'sekrit'), false);
  });

  console.log('server (mocked GitHub)');
  const secret = 'test-secret';
  const store = tmpStore();
  const mock = makeMockGithub();
  const server = createServer({ store, github: mock, webhookSecret: secret, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const todayISO = new Date().toISOString();

  await test('bad signature -> 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks`, { method: 'POST', headers: { 'x-github-event': 'ping' }, body: '{}' });
    assert.strictEqual(res.status, 401);
  });

  await test('bot PR opened -> tracked with CODEOWNERS owner', async () => {
    const status = await postEvent(port, secret, 'pull_request', prPayload({
      number: 7, title: 'Bump lodash from 4.17.20 to 4.17.21',
      branch: 'dependabot/npm_and_yarn/lodash-4.17.21', authorLogin: 'dependabot[bot]', createdAt: todayISO,
    }));
    assert.strictEqual(status, 202);
    await waitFor(() => { const pr = store.getPr(42, 7); return pr && pr.owner; });
    const pr = store.getPr(42, 7);
    assert.strictEqual(pr.owner, 'bob'); // mocked files hit /src; last CODEOWNERS rule wins
    assert.strictEqual(pr.packageName, 'lodash');
    assert.strictEqual(pr.bumpType, 'patch');
  });

  await test('newer PR for same package closes the older as superseded', async () => {
    await postEvent(port, secret, 'pull_request', prPayload({
      number: 12, title: 'Bump lodash from 4.17.21 to 4.17.22',
      branch: 'dependabot/npm_and_yarn/lodash-4.17.22', authorLogin: 'dependabot[bot]', createdAt: todayISO,
    }));
    await waitFor(() => { const pr = store.getPr(42, 7); return pr && pr.closedAsSuperseded; });
    const pr = store.getPr(42, 7);
    assert.strictEqual(pr.state, 'closed');
    assert.strictEqual(pr.supersededBy, 12);
    assert.ok(mock.find('closePullRequest').some((c) => c.number === 7));
    assert.ok(mock.find('createComment').some((c) => c.number === 7 && c.body.includes('superseded by #12')));
  });

  await test('human PR is ignored', async () => {
    await postEvent(port, secret, 'pull_request', prPayload({
      number: 30, title: 'Add feature', branch: 'feat', authorLogin: 'alice', createdAt: todayISO,
    }));
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(store.getPr(42, 30), null);
  });

  await test('check_suite failure sets ciState on tracked PRs', async () => {
    await postEvent(port, secret, 'check_suite', {
      action: 'completed', installation: { id: 555 }, repository: REPO,
      check_suite: { conclusion: 'failure', pull_requests: [{ number: 12 }] },
    });
    await waitFor(() => { const pr = store.getPr(42, 12); return pr && pr.ciState === 'failure'; });
    assert.strictEqual(store.getPr(42, 12).ciState, 'failure');
  });

  await test('snooze command from a MEMBER sets snoozedUntil', async () => {
    await postEvent(port, secret, 'issue_comment', {
      action: 'created', installation: { id: 555 }, repository: REPO,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: '/janitor snooze 14d', user: { login: 'alice' }, author_association: 'MEMBER' },
    });
    await waitFor(() => { const pr = store.getPr(42, 12); return pr && pr.snoozedUntil; });
    const until = Date.parse(store.getPr(42, 12).snoozedUntil);
    assert.ok(until > Date.now() + 13 * DAY);
  });

  await test('snooze command from an unprivileged author is ignored', async () => {
    store.updatePr(42, 12, { snoozedUntil: null });
    await postEvent(port, secret, 'issue_comment', {
      action: 'created', installation: { id: 555 }, repository: REPO,
      issue: { number: 12, pull_request: { url: 'x' } },
      comment: { body: '/janitor snooze 30d', user: { login: 'stranger' }, author_association: 'NONE' },
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(store.getPr(42, 12).snoozedUntil, null);
  });

  await test('pull_request closed marks state merged', async () => {
    await postEvent(port, secret, 'pull_request', {
      action: 'closed', installation: { id: 555 }, repository: REPO,
      pull_request: { number: 12, title: 'Bump lodash from 4.17.21 to 4.17.22', user: { login: 'dependabot[bot]' }, head: { ref: 'x' }, created_at: todayISO, updated_at: todayISO, state: 'closed', merged_at: todayISO, html_url: 'u' },
    });
    await waitFor(() => { const pr = store.getPr(42, 12); return pr && pr.state === 'merged'; });
    assert.strictEqual(store.getPr(42, 12).state, 'merged');
  });

  server.close();

  console.log('sweep + digest (mocked GitHub)');
  await test('runDaily: 20-day-old PR gets aging label + reviewer request, once', async () => {
    const s = tmpStore();
    const m = makeMockGithub();
    s.recordRepo(REPO, 555);
    s.upsertPr(basePr({ number: 3, createdAt: new Date(Date.now() - 20 * DAY).toISOString(), owner: 'alice', repoId: 42 }));
    await runDaily({ github: m, store: s, config: {}, log: () => {} });
    const pr = s.getPr(42, 3);
    assert.strictEqual(pr.escalationLevel, 1);
    assert.ok(pr.labelsApplied.includes(logic.LABELS.aging));
    assert.ok(m.find('requestReviewers').some((c) => c.number === 3));
    const callsBefore = m.calls.length;
    await runDaily({ github: m, store: s, config: {}, log: () => {} });
    assert.strictEqual(m.calls.length, callsBefore); // second sweep is a no-op for this PR
  });

  await test('runDigest: creates the weekly issue once, then updates it', async () => {
    const s = tmpStore();
    const m = makeMockGithub();
    s.recordRepo(REPO, 555);
    s.upsertPr(basePr({ number: 4, repoId: 42 }));
    const n1 = await runDigest({ github: m, store: s, log: () => {} });
    const n2 = await runDigest({ github: m, store: s, log: () => {} });
    assert.strictEqual(n1, 1);
    assert.strictEqual(n2, 1);
    assert.strictEqual(m.find('createIssue').length, 1);
    assert.strictEqual(m.find('updateIssue').length, 1);
    assert.strictEqual(m.find('updateIssue')[0].number, 99);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`\nFAIL: ${f.name}\n${f.err.stack}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
