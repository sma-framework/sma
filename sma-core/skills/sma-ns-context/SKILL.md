---
name: sma-ns-context
description: "codebase intel | map graphify docs learnings mempalace"
allowed-tools:
  - Read
  - Skill
---


Route to the appropriate codebase-intelligence skill based on the user's intent.
`sma-scan` and `sma-intel` were folded into `sma-map-codebase` flags by #2790.

| User wants | Invoke |
|---|---|
| Map the full codebase structure | sma-map-codebase |
| Quick lightweight codebase scan | sma-map-codebase --fast |
| Query mapped intelligence files | sma-map-codebase --query |
| Generate a knowledge graph | sma-graphify |
| Update project documentation | sma-docs-update |
| Extract learnings from a completed phase | sma-extract-learnings |
| Recall prior decisions and patterns before planning | sma-mempalace-recall |
| File a phase artifact into MemPalace | sma-mempalace-capture |

Invoke the matched skill directly using the Skill tool.
