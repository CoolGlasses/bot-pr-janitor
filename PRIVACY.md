# Bot-PR Backlog Janitor — Privacy Policy

_Last updated: November 14, 2026_

Bot-PR Backlog Janitor is a GitHub App that keeps Dependabot and Renovate
pull-request backlogs owned, aged, and escalated. This policy describes
exactly what it handles.

## What the Janitor receives

When installed on a repository, GitHub sends the Janitor `pull_request`,
`check_suite`, and `issue_comment` webhook events for that repository.
From those events and the GitHub API, the Janitor processes:

- Pull request metadata for bot-authored PRs: PR numbers, titles, branch
  names, labels, state, and creation/update timestamps.
- The list of file paths a bot PR changes (paths only, used to resolve
  owners from CODEOWNERS).
- The repository's CODEOWNERS file, to determine who owns a bot PR.
- Check-suite conclusions, to know whether a bot PR's CI is failing.
- Issue comments, only to recognise snooze commands addressed to the
  Janitor (for example `/janitor snooze 14d`) written by users with
  owner, member, or collaborator access.
- Repository and installation identifiers: repository ID, owner login,
  repository name, and the App installation ID.

## What the Janitor never receives or stores

- **No source code contents.** It reads file paths and CODEOWNERS, never
  file bodies.
- **No secrets, environment variables, or artifacts.**
- **No comment text** beyond recognising its own snooze commands.
- **No personal data** beyond GitHub logins needed to request reviewers.

## How the data is used

Metadata is used for one purpose: tracking each bot PR's age, CI state,
owner, and snooze/escalation state so the Janitor can label, assign,
escalate, close superseded bot PRs, and publish a weekly digest issue in
the repository itself.

## Retention and deletion

Per-PR state is retained while the App is installed. Uninstalling the
App stops all processing; stored state for the installation is deleted
on request to the support contact below.

## Contact

Support and privacy questions: coacha810@gmail.com
Source: https://github.com/CoolGlasses/bot-pr-janitor
