'use strict';
/*
 * Pure core of the Janitor: bot-PR classification, CODEOWNERS owner
 * resolution, the aging/snooze/escalation state machine, snooze-command
 * parsing, and the weekly digest builder. No I/O here — server.js and
 * sweep.js feed it records and execute the actions it returns, which is
 * what makes the state machine unit-testable with mocked payloads.
 *
 * State machine (per open bot PR, evaluated by the daily sweep and by
 * live events):
 *
 *   superseded  a newer open PR bumps the same package in the same repo
 *               -> label + comment + close. Terminal. Fires even while
 *               snoozed: a snoozed PR that got superseded is done.
 *   snoozed     snoozedUntil in the future -> no nagging actions at all
 *               (aging, failing, escalation all suppressed).
 *   failing     CI conclusion is failure and age >= failingGraceDays
 *               -> `janitor:failing` label + one comment.
 *   aging tiers by calendar age, tracked by escalationLevel so each
 *               tier fires exactly once:
 *                 tier 1 (>= agingDays):    `janitor:aging` label,
 *                     owner requested as reviewer (or `janitor:needs-owner`)
 *                 tier 2 (>= escalateDays): escalation comment naming owner
 *                 tier 3 (>= criticalDays): `janitor:stale` label + comment
 *
 * Explicitly out of scope (gate page): fixing failing PRs. The Janitor
 * routes and nags; it never touches customer code.
 */

const BOT_LOGINS = new Set(['dependabot[bot]', 'renovate[bot]', 'dependabot-preview[bot]']);

const DEFAULT_CONFIG = {
  agingDays: 14,
  escalateDays: 30,
  criticalDays: 60,
  failingGraceDays: 3,
};

const LABELS = {
  aging: 'janitor:aging',
  failing: 'janitor:failing',
  superseded: 'janitor:superseded',
  stale: 'janitor:stale',
  needsOwner: 'janitor:needs-owner',
  snoozed: 'janitor:snoozed',
};

function isBotAuthor(login) {
  return BOT_LOGINS.has(login);
}

function botKind(login) {
  if (!login) return 'other';
  if (login.startsWith('renovate')) return 'renovate';
  if (login.startsWith('dependabot')) return 'dependabot';
  return 'other';
}

function parseVersion(v) {
  const m = String(v || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function classifyBump(fromVersion, toVersion) {
  const a = parseVersion(fromVersion);
  const b = parseVersion(toVersion);
  if (!a || !b) return 'unknown';
  if (b[0] !== a[0]) return 'major';
  if (b[1] !== a[1]) return 'minor';
  if (b[2] !== a[2]) return 'patch';
  return 'unknown';
}

/*
 * Extract { packageName, fromVersion, toVersion, bumpType } from a bot
 * PR title (branch as fallback for the package name).
 *  Dependabot: "Bump lodash from 4.17.20 to 4.17.21"
 *              "Bump actions/checkout from 3 to 4" (docker/action style)
 *  Renovate:   "Update dependency lodash to v4.17.21"
 *              "Update lodash to 4.17.21"
 */
function parseBump(title, branch) {
  const t = String(title || '');
  let m = t.match(/^[Bb]ump\s+(.+?)\s+from\s+(\S+)\s+to\s+(\S+)\s*$/);
  if (m) {
    return { packageName: m[1], fromVersion: m[2], toVersion: m[3], bumpType: classifyBump(m[2], m[3]) };
  }
  m = t.match(/^[Uu]pdate\s+dependency\s+(.+?)\s+to\s+v?(\S+)\s*$/);
  if (m) {
    return { packageName: m[1], fromVersion: null, toVersion: m[2], bumpType: 'unknown' };
  }
  m = t.match(/^[Uu]pdate\s+(.+?)\s+to\s+v?(\S+)\s*$/);
  if (m) {
    return { packageName: m[1], fromVersion: null, toVersion: m[2], bumpType: 'unknown' };
  }
  // Fallback: renovate branch names look like "renovate/lodash-4.x".
  let packageName = null;
  if (branch) {
    const b = String(branch).replace(/^(renovate|dependabot)\//, '');
    packageName = b.replace(/-\d+(\.\d+)?\.x$/, '') || null;
  }
  return { packageName, fromVersion: null, toVersion: null, bumpType: 'unknown' };
}

/* ---------------- CODEOWNERS ----------------
 * Pragmatic subset of GitHub's CODEOWNERS semantics:
 *  - blank lines and # comments are ignored
 *  - the LAST matching pattern for a file wins
 *  - a pattern with no slash matches a path segment at any depth
 *  - a pattern containing a slash (or starting with /) is root-anchored
 *  - `*` matches within a segment, `**` across segments
 *  - a trailing-/ pattern matches everything under that directory
 * Owners are `@user` or `@org/team`.
 */
function parseCodeowners(text) {
  const rules = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    rules.push({ pattern: parts[0], owners: parts.slice(1).filter((o) => o.startsWith('@')) });
  }
  return rules;
}

function patternToRegex(pattern) {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
    } else {
      re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    }
  }
  if (dirOnly) re += '(/.*)?';
  // A pattern that names a directory also covers everything under it.
  if (anchored) return new RegExp(`^${re}(/.*)?$`);
  // Unanchored: pattern matches any trailing segment sequence.
  return new RegExp(`(^|/)${re}(/.*)?$`);
}

function resolveOwners(codeownersText, filePaths) {
  const rules = parseCodeowners(codeownersText).map((r) => ({ ...r, regex: patternToRegex(r.pattern) }));
  const users = new Set();
  const teams = new Set();
  for (const file of filePaths || []) {
    const path = String(file).replace(/^\//, '');
    let matched = null;
    for (const rule of rules) {
      if (rule.regex.test(path)) matched = rule; // last match wins
    }
    if (!matched) continue;
    for (const owner of matched.owners) {
      const bare = owner.slice(1);
      if (bare.includes('/')) teams.add(bare); else users.add(bare);
    }
  }
  return { users: [...users], teams: [...teams] };
}

function splitTeam(team) {
  const idx = team.indexOf('/');
  return { org: team.slice(0, idx), slug: team.slice(idx + 1) };
}

/* ---------------- state machine ---------------- */

function ageInDays(pr, nowMs) {
  return (nowMs - Date.parse(pr.createdAt)) / 86_400_000;
}

function isSnoozed(pr, nowMs) {
  return Boolean(pr.snoozedUntil) && Date.parse(pr.snoozedUntil) > nowMs;
}

function commentBody(kind, pr, extra) {
  const age = Math.floor((extra.nowMs - Date.parse(pr.createdAt)) / 86_400_000);
  const ownerPing = pr.owner ? ` (owner: @${String(pr.owner).replace(/^@/, '')})` : '';
  switch (kind) {
    case 'superseded':
      return `🧹 **Bot-PR Janitor:** this ${pr.packageName || 'dependency'} update is superseded by #${extra.supersededBy}, which bumps the same package to a newer version. Closing this PR so the queue holds one live candidate per package.`;
    case 'failing':
      return `🧹 **Bot-PR Janitor:** CI has been failing on this bot PR for ${age} days. It will not merge itself — the owning engineer needs to look, rebase, or close it.${ownerPing}`;
    case 'aging':
      return `🧹 **Bot-PR Janitor:** this bot PR has been open for ${age} days with no human next step. Assigning ownership so it stops being everyone's problem and starts being someone's.${ownerPing}`;
    case 'escalation':
      return `🧹 **Bot-PR Janitor:** escalation — this bot PR is now ${age} days old and still unmerged. Please merge it, close it with a reason, or snooze it (\`/janitor snooze 14d\`) if the team is deliberately waiting.${ownerPing}`;
    case 'critical':
      return `🧹 **Bot-PR Janitor:** this bot PR is ${age} days old. Stale dependency PRs are how the queue reached its current size — merge, close, or snooze it today.${ownerPing}`;
    case 'snoozed':
      return `🧹 **Bot-PR Janitor:** snoozed until ${extra.until}. Aging and escalation are paused; a newer bump for the same package will still supersede this PR.`;
    case 'unsnoozed':
      return `🧹 **Bot-PR Janitor:** snooze cleared. Aging and escalation resume.`;
    default:
      return `🧹 **Bot-PR Janitor:** ${kind}`;
  }
}

/*
 * Evaluate one PR record. ctx: { nowMs, config, supersededBy }
 * supersededBy: number of a newer open PR for the same package in the
 * same repo, or null. Returns an array of action objects; actions.js
 * executes them and writes the resulting state back.
 */
function evaluatePr(pr, ctx) {
  const config = { ...DEFAULT_CONFIG, ...(ctx.config || {}) };
  const nowMs = ctx.nowMs;
  const actions = [];
  if (!pr || pr.state !== 'open') return actions;

  if (ctx.supersededBy && !pr.closedAsSuperseded) {
    actions.push({ type: 'add-label', label: LABELS.superseded });
    actions.push({ type: 'comment', kind: 'superseded', body: commentBody('superseded', pr, { nowMs, supersededBy: ctx.supersededBy }) });
    actions.push({ type: 'close-superseded', supersededBy: ctx.supersededBy });
    return actions;
  }

  if (isSnoozed(pr, nowMs)) return actions;

  const age = ageInDays(pr, nowMs);
  const applied = new Set(pr.labelsApplied || []);

  if (pr.ciState === 'failure' && age >= config.failingGraceDays && !applied.has(LABELS.failing)) {
    actions.push({ type: 'add-label', label: LABELS.failing });
    actions.push({ type: 'comment', kind: 'failing', body: commentBody('failing', pr, { nowMs }) });
  }

  const tier = age >= config.criticalDays ? 3 : age >= config.escalateDays ? 2 : age >= config.agingDays ? 1 : 0;
  const level = pr.escalationLevel || 0;
  if (tier > level) {
    if (tier === 1) {
      if (!applied.has(LABELS.aging)) actions.push({ type: 'add-label', label: LABELS.aging });
      if (pr.owner) {
        actions.push({ type: 'request-reviewer' });
      } else if (!applied.has(LABELS.needsOwner)) {
        actions.push({ type: 'add-label', label: LABELS.needsOwner });
      }
      actions.push({ type: 'comment', kind: 'aging', body: commentBody('aging', pr, { nowMs }) });
    } else if (tier === 2) {
      actions.push({ type: 'comment', kind: 'escalation', body: commentBody('escalation', pr, { nowMs }) });
    } else if (tier === 3) {
      if (!applied.has(LABELS.stale)) actions.push({ type: 'add-label', label: LABELS.stale });
      actions.push({ type: 'comment', kind: 'critical', body: commentBody('critical', pr, { nowMs }) });
    }
    actions.push({ type: 'set-escalation', level: tier });
  }

  return actions;
}

/* ---------------- snooze commands ----------------
 * Maintainers control snoozes from PR comments:
 *   /janitor snooze 14d        (d = days, w = weeks)
 *   /janitor snooze until 2026-12-01
 *   /janitor unsnooze
 * Returns { type:'snooze', untilISO } | { type:'unsnooze' } | null.
 */
function parseSnoozeCommand(commentText, nowMs) {
  const text = String(commentText || '');
  const m = text.match(/\/janitor\s+(unsnooze|snooze)\b([^\n]*)/i);
  if (!m) return null;
  if (m[1].toLowerCase() === 'unsnooze') return { type: 'unsnooze' };
  const rest = m[2] || '';
  const untilMatch = rest.match(/until\s+(\d{4}-\d{2}-\d{2})/i);
  if (untilMatch) {
    const d = new Date(`${untilMatch[1]}T23:59:59Z`);
    if (!Number.isNaN(d.getTime())) return { type: 'snooze', untilISO: d.toISOString() };
  }
  const durMatch = rest.match(/(\d+)\s*(d|w)/i);
  if (durMatch) {
    const days = Number(durMatch[1]) * (durMatch[2].toLowerCase() === 'w' ? 7 : 1);
    return { type: 'snooze', untilISO: new Date(nowMs + days * 86_400_000).toISOString() };
  }
  // Bare "/janitor snooze" defaults to 7 days.
  return { type: 'snooze', untilISO: new Date(nowMs + 7 * 86_400_000).toISOString() };
}

/* ---------------- digest ---------------- */

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildDigestMarkdown(repoFullName, prs, nowMs) {
  const open = (prs || []).filter((p) => p.state === 'open');
  const byAge = [...open].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const failing = open.filter((p) => p.ciState === 'failure');
  const snoozed = open.filter((p) => isSnoozed(p, nowMs));
  const noOwner = open.filter((p) => !p.owner);
  const escalated = open.filter((p) => (p.escalationLevel || 0) >= 2);
  const majors = open.filter((p) => p.bumpType === 'major');

  const lines = [];
  lines.push(`## 🧹 Bot-PR backlog — ${repoFullName}`);
  lines.push('');
  lines.push(`**${open.length}** open bot PRs · **${failing.length}** failing CI · **${escalated.length}** escalated · **${snoozed.length}** snoozed · **${noOwner.length}** with no owner · **${majors.length}** major bumps`);
  lines.push('');
  if (!open.length) {
    lines.push('The queue is empty. Nothing to do — this is the goal state.');
    return lines.join('\n');
  }
  lines.push('| PR | Package | Bump | Age (d) | CI | Owner | State |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const pr of byAge) {
    const state = isSnoozed(pr, nowMs) ? `snoozed → ${String(pr.snoozedUntil).slice(0, 10)}` : (pr.escalationLevel || 0) >= 2 ? 'escalated' : (pr.escalationLevel || 0) === 1 ? 'aging' : 'new';
    lines.push(`| #${pr.number} | ${pr.packageName || '—'} | ${pr.bumpType} | ${Math.floor(ageInDays(pr, nowMs))} | ${pr.ciState} | ${pr.owner ? '@' + String(pr.owner).replace(/^@/, '') : '**none**'} | ${state} |`);
  }
  if (noOwner.length) {
    lines.push('');
    lines.push('### No owner named');
    lines.push('These PRs have no CODEOWNERS match — 85% of open bot PRs in the wild have no engineer named as the next actor. Add a CODEOWNERS rule or assign them by hand:');
    for (const pr of noOwner) lines.push(`- #${pr.number} — ${pr.title}`);
  }
  if (failing.length) {
    lines.push('');
    lines.push('### Failing CI');
    for (const pr of failing) lines.push(`- #${pr.number} — ${pr.title}`);
  }
  lines.push('');
  lines.push('_One digest per repo, updated weekly by Bot-PR Backlog Janitor. Snooze a PR with `/janitor snooze 14d` in its comments._');
  return lines.join('\n');
}

module.exports = {
  BOT_LOGINS,
  DEFAULT_CONFIG,
  LABELS,
  isBotAuthor,
  botKind,
  parseVersion,
  classifyBump,
  parseBump,
  parseCodeowners,
  patternToRegex,
  resolveOwners,
  splitTeam,
  ageInDays,
  isSnoozed,
  commentBody,
  evaluatePr,
  parseSnoozeCommand,
  isoWeekKey,
  buildDigestMarkdown,
};
