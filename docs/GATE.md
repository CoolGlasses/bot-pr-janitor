# Gate page — Bot-PR Backlog Janitor

Condensed from the full gate page in
`~/workspace/goals/10m-digital-asset-effort/files/problem-hunt-apps-2026-11-13.md`
(candidate #2, scored 26/30). This file is the build contract; the
hunt report is the evidence archive.

## What it is

Acts on the Dependabot/Renovate queue instead of just charting it:
assigns an owner (CODEOWNERS), labels superseded/failing/aging PRs,
snoozes, escalates — one digest per repo.

## Pain + payer

Platform/eng teams at orgs running dependency bots across
tens-to-hundreds of repos. Keypup's analysis of one ~1,400-engineer
org's real PR data, Nov 2025–Oct 2026 (coordinator-verified firsthand):

- Bots opened **31% of all PRs (18,420 of 59,400)**; only **44% merged**
- **4,180 bot PRs open today, median age 61 business days**
- Major bumps **11% merged**
- **85% of open bot PRs have no engineer named as the next actor**

Filippo Valsorda, "Turn Dependabot Off": "Dependabot is a noise
machine." / "False positive alerts are not only a waste of time, they
also reduce security by causing alert fatigue."

**Honest gap in Pays:** teams provably pay Keypup to *measure* this;
nobody in the evidence yet pays for the *cleanup actions*. That is the
wedge and the risk in one sentence.

## Price point

Keypup Full Platform $99/mo minimum — analytics only; measures, does
not assign/close/escalate. Renovate core is free/self-hostable (the
pricing pressure). **Proposed: $29/mo per org (≤25 repos), $49/mo
(≤100 repos)** — under Keypup's floor, charging for actions Keypup
doesn't take.

## Money rail

GitHub Marketplace App — rail verified firsthand. Only Apps can
charge; paid plans require 100 installations earned on a free listing
first; the app must be owned by an organization completing
verified-publisher onboarding; GitHub keeps 5%.

## App-fit

The queue is cross-repo state: which of 40 repos' bot PRs are
superseded by a newer bump, which major has been red for 90 days, who
is the human next-actor, what was snoozed until when. That state lives
between events and between scheduled escalations. A per-repo Action
holds no org-wide queue and would need a broad PAT in every repo to
act across them. The server *is* the product.

## Build shape (what was built)

- Webhook handlers: `pull_request`, `check_suite` (+ `installation`
  bookkeeping, + `issue_comment` for snooze commands — the mechanism
  that makes "snoozes" actionable).
- Daily sweep + weekly digest (one issue per repo, updated in place).
- Per bot PR state: repo, package, bump type, CI state, age, owner,
  snooze/escalation state — a few hundred bytes per row, JSON file
  store with lockfile transactions.
- Actions are API calls only: label, comment, request reviewer,
  close-as-superseded, one digest issue per repo.
- **Explicitly out of scope: fixing failing PRs** (running customer
  code / LLM repair = TOO BIG). Not built, by design.

## Hosting cost

~$5–6/mo droplet from day one; webhook volume trivial. No free-tier
start — webhooks need an always-on endpoint from the first free
install. (SameTree precedent: co-locate on the existing ScoutCreate
droplet at zero marginal cost.)

## Kill criteria (DRAFTED AT BUILD TIME — not in the gate page)

The gate page itself states no kill criteria for this candidate. The
following were drafted while packaging the MVP and are proposals for
review, not gate-page content:

- If the first 20 installs produce no org that lets the Janitor take
  an action (labels/closes) — i.e. everyone wants read-only
  measurement — the Pays gap was fatal; fold the measurement view
  into the digest and stop.
- Escalation comments that draw "this is just more noise" complaints
  in ≥⅓ of active repos mean the tiers are wrong, not the product:
  retune once, then kill if it repeats.
