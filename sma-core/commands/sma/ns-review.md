---
name: sma-quality
description: "quality gates | code review debug audit security eval ui"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [code-review, audit-uat, secure-phase, eval-review, ui-review, validate-phase, debug, forensics, audit-fix, review, ui-phase]
---

Route to the appropriate quality / review skill based on the user's intent.
`sma-code-review-fix` was absorbed by `sma-code-review --fix` in #2790.

| User wants | Invoke |
|---|---|
| Review code for quality and correctness | sma-code-review |
| Auto-fix code review findings | sma-code-review --fix |
| Audit UAT / acceptance testing | sma-audit-uat |
| Security review of a phase | sma-secure-phase |
| Evaluate AI response quality | sma-eval-review |
| Review UI for design and accessibility | sma-ui-review |
| Validate phase outputs | sma-validate-phase |
| Debug a failing feature or error | sma-debug |
| Forensic investigation of a broken system | sma-forensics |
| Autonomous audit-to-fix pipeline | sma-audit-fix |
| Cross-AI peer review of plans | sma-review |
| Generate a UI design contract | sma-ui-phase |

Invoke the matched skill directly using the Skill tool.
