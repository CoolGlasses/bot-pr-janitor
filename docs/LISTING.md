# Marketplace listing copy — Bot-PR Backlog Janitor (DRAFT)

- Name: Bot-PR Backlog Janitor (or the final registered app name/slug)
- Short description (no trailing punctuation): "Gives every Dependabot and Renovate PR an owner, an age, and an escalation path"
- Primary category: Dependency management
- Secondary category: Project management
- Support URL: https://github.com/CoolGlasses/bot-pr-janitor
- Privacy policy URL: https://github.com/CoolGlasses/bot-pr-janitor/blob/main/PRIVACY.md
- Terms URL: https://github.com/CoolGlasses/bot-pr-janitor/blob/main/TERMS.md
- Contact email (all leads): coacha810@gmail.com
- Free plan: "Free" — $0. Description: "Bot-PR ownership, aging labels,
  escalation, supersede cleanup, and a weekly backlog digest."
  Bullets:
  - CODEOWNERS-based owner assignment for every bot PR
  - Age tiers at 14/30/60 days with one-shot escalation
  - Superseded bot PRs closed automatically
  - Weekly digest issue, updated in place

## Intro description

Dependabot and Renovate open pull requests faster than most teams close
them. The result is a backlog nobody owns: hundreds of open bot PRs, no
next actor, and no signal about which ones matter. Bot-PR Backlog
Janitor gives every bot PR an owner from CODEOWNERS, tracks its age and
CI state, escalates it on a schedule, and quietly closes the ones a
newer bot PR has already superseded — with a weekly digest so the
backlog has a number, not just a feeling.

## Detailed description

See README.md in the repository for the full behaviour specification,
including the aging/escalation state machine, snooze commands
(`/janitor snooze 14d`), the failing-CI grace rule, and the supersede
rule. The Janitor measures and manages the queue; it never edits,
fixes, or merges a bot PR.
