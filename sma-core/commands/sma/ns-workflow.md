---
name: sma-workflow
description: "workflow | discuss plan execute verify phase progress"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [discuss-phase, spec-phase, plan-phase, execute-phase, verify-work, phase, progress, next, ultraplan-phase, plan-review-convergence, add-tests, ai-integration-phase, autonomous, fast, mvp-phase, quick]
---

Route to the appropriate phase-pipeline skill based on the user's intent.
Sub-skill names below are post-#2790 consolidated targets — `sma-phase`
absorbs the former add/insert/remove/edit-phase commands and `sma-progress`
absorbs the former next/do workflow-advance commands. The reclaimed
`sma-next` target is the state-aware smart-entry launcher, not the retired
workflow-advance command.

| User wants | Invoke |
|---|---|
| Gather context before planning | sma-discuss-phase |
| Clarify what a phase delivers | sma-spec-phase |
| Create a PLAN.md | sma-plan-phase |
| Execute plans in a phase | sma-execute-phase |
| Verify built features through UAT | sma-verify-work |
| Add / insert / remove / edit a phase | sma-phase |
| Advance to the next logical step | sma-progress |
| Open the state-aware smart-entry launcher | sma-next |
| Offload planning to the ultraplan cloud | sma-ultraplan-phase |
| Cross-AI plan review convergence loop | sma-plan-review-convergence |
| Generate tests for a completed phase | sma-add-tests |
| Design an AI-integration phase | sma-ai-integration-phase |
| Run all remaining phases autonomously | sma-autonomous |
| Execute a trivial task inline | sma-fast |
| Plan a phase as a vertical MVP slice | sma-mvp-phase |
| Execute a quick task with SMA guarantees | sma-quick |

Invoke the matched skill directly using the Skill tool.
