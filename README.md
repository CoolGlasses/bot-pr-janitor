# Bot-PR Backlog Janitor

A GitHub App that **acts on** the Dependabot/Renovate queue instead of
just charting it. Analytics tools measure the bot-PR backlog; the
Janitor works it:

- **Assigns an owner** to every bot PR from CODEOWNERS (the evidence:
  85% of open bot PRs have no engineer named as the next actor).
- **Labels** PRs as they age, fail CI, or go stale.
- **Closes superseded PRs** — when a newer bump for the same package
  lands, the older one is commented and closed in seconds.
- **Honors snoozes** — `/janitor snooze 14d` in a PR's comments pauses
  the nagging (supersede still applies).
- **Escalates on a schedule** — aging → escalation → stale, each tier
  exactly once, always naming the owner.
- **Posts one digest issue per repo per week** — created once, updated
  in place.

Explicitly out of scope: fixing failing PRs. The Janitor routes and
nags; it never runs or edits customer code.

Zero runtime dependencies. Node ≥ 18.

## Why an App (not an Action)

The queue is cross-repo state: which of 40 repos' bot PRs are
superseded, which major has been red for 90 days, who the human
next-actor is, what was snoozed until when. That state lives between
events and between scheduled escalations. A per-repo Action holds no
org-wide queue and would need a broad PAT in every repo. The server
*is* the product.

## Evidence

Keypup's analysis of one ~1,400-engineer org's real PR data
(Nov 2025–Oct 2026): bots opened **31% of all PRs**; only **44%
merged**; **4,180 bot PRs open**, median age 61 business days; major
bumps **11% merged**; **85% of open bot PRs have no engineer named as
the next actor**. Full gate page: [docs/GATE.md](docs/GATE.md).

## State machine

Per open bot PR (see `src/logic.js` for the authoritative version):

| Condition | Action |
|---|---|
| Newer open PR bumps the same package | `janitor:superseded` label, comment, **close** (fires even while snoozed) |
| Snoozed (`snoozedUntil` in the future) | Nothing — aging/failing/escalation suppressed |
| CI failing and age ≥ `JANITOR_FAILING_GRACE_DAYS` (3) | `janitor:failing` label + comment |
| Age ≥ `JANITOR_AGING_DAYS` (14), tier 1 | `janitor:aging` label, owner requested as reviewer (or `janitor:needs-owner` label) |
| Age ≥ `JANITOR_ESCALATE_DAYS` (30), tier 2 | Escalation comment naming the owner |
| Age ≥ `JANITOR_CRITICAL_DAYS` (60), tier 3 | `janitor:stale` label + comment |

Each tier fires exactly once (`escalationLevel` + `labelsApplied` are
the memory). Ages are calendar days.

## Snooze commands

Maintainers (comment author association OWNER / MEMBER /
COLLABORATOR) control snoozes from any bot PR's comments:

```
/janitor snooze 14d
/janitor snooze 2w
/janitor snooze until 2026-12-01
/janitor snooze            (defaults to 7 days)
/janitor unsnooze
```

## Layout

```
src/github.js   App JWT auth, webhook signature check, REST surface
src/logic.js    Pure core: classification, CODEOWNERS matching,
                state machine, snooze parsing, digest builder
src/store.js    JSON-file store, lockfile transactions (reload-before-
                write) shared by server + cron processes
src/actions.js  Executes state-machine actions; CODEOWNERS owner
                resolution
src/server.js   Webhook server (pull_request, check_suite,
                issue_comment, installation)
src/sweep.js    Cron jobs: `daily` sweep + weekly `digest`
test/run-tests.js
```

## Run it

```bash
cp .env.example .env   # fill in App credentials
npm start              # webhook server on :8932
npm run sweep          # daily sweep (cron)
npm run digest         # weekly digest (cron)
npm test               # 31 tests, mocked GitHub API
```

Suggested cron:

```
15 6 * * *   node src/sweep.js daily
30 7 * * 1   node src/sweep.js digest
```

## GitHub App permissions (for registration, when that day comes)

- Repository permissions: **Issues RW** (labels, comments, digest),
  **Pull requests RW** (close superseded, request reviewers),
  **Contents R** (CODEOWNERS + PR files), **Metadata R**.
- Webhook events: `pull_request`, `check_suite`, `issue_comment`,
  `installation`.
- Pricing (gate page): $29/mo per org (≤25 repos), $49/mo (≤100
  repos), via a free Marketplace listing until 100 installs unlock
  paid plans.

## Notes / deliberate simplifications

- CODEOWNERS matching is a pragmatic subset of GitHub's semantics
  (last-match-wins, `*`/`**`, root-anchored vs. any-depth patterns,
  directory patterns cover their contents). Exotic gitignore edge
  cases (negations, character classes) are not implemented — bot PRs
  touch manifests and lockfiles, which simple patterns cover.
- One installation token cache per process; the store file is the
  only cross-process state.
