---
name: sma-ns-project
description: "project lifecycle | milestones audits summary"
allowed-tools:
  - Read
  - Skill
---


Route to the appropriate project / milestone skill based on the user's intent.
`sma-plan-milestone-gaps` was deleted by #2790 — gap planning now happens
inline as part of `sma-audit-milestone`'s output.

| User wants | Invoke |
|---|---|
| Start a new project | sma-new-project |
| Onboard an existing codebase | sma-onboard |
| Create a new milestone | sma-new-milestone |
| Complete the current milestone | sma-complete-milestone |
| Audit a milestone for issues | sma-audit-milestone |
| Summarize milestone status | sma-milestone-summary |
| Import an external plan | sma-import |
| Bootstrap planning from existing docs | sma-ingest-docs |
| Generate a developer profile | sma-profile-user |
| Review and promote backlog items | sma-review-backlog |

Invoke the matched skill directly using the Skill tool.
