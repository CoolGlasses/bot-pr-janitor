# Bot-PR Backlog Janitor — Terms of Service

_Last updated: November 14, 2026_

## The service

Bot-PR Backlog Janitor is a GitHub App that manages the backlog of
bot-authored pull requests (Dependabot, Renovate) in repositories where
it is installed. It labels aging PRs, requests review from the owners
named in CODEOWNERS, escalates PRs that pass configured age tiers,
closes bot PRs that have been superseded by a newer bot PR for the same
update, and publishes a weekly digest issue.

## Behaviour you are opting into

Installing the App is your decision that this behaviour fits your
repository. In particular:

- A superseded bot PR is commented on and closed, even while snoozed.
- Age tiers (14, 30, and 60 days by default) each fire once per PR.
- Snoozes set by comment (`/janitor snooze 14d`, `/janitor unsnooze`)
  suppress aging and escalation actions, never supersede closures.
- The Janitor never edits, fixes, or merges a bot PR.

To stop all actions, uninstall the App — the effect is immediate.

## Availability

The service is provided as-is, without uptime guarantees. The operator
may change or discontinue features with notice in the repository.

## Liability

To the maximum extent permitted by law, the operator is not liable for
indirect or consequential damages arising from use of the App,
including pull requests closed under the supersede rule described
above.

## Contact

coacha810@gmail.com
