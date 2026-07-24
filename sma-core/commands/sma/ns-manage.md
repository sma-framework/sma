---
name: sma-manage
description: "config workspace | workstreams thread update ship inbox"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [config, workspace, workstreams, thread, pause-work, resume-work, update, ship, inbox, pr-branch, undo, cleanup, health, manager, settings, stats, surface, help]
---

Route to the appropriate management skill based on the user's intent.
`sma-config` (settings + advanced + integrations + profile) and `sma-workspace`
(new + list + remove) are post-#2790 consolidated entries.

| User wants | Invoke |
|---|---|
| Configure SMA settings (basic / advanced / integrations / profile) | sma-config |
| Manage workspaces (create / list / remove) | sma-workspace |
| Manage parallel workstreams | sma-workstreams |
| Continue work in a fresh context thread | sma-thread |
| Pause current work | sma-pause-work |
| Resume paused work | sma-resume-work |
| Update the SMA installation | sma-update |
| Ship completed work | sma-ship |
| Process inbox items | sma-inbox |
| Create a clean PR branch | sma-pr-branch |
| Undo the last SMA action | sma-undo |
| Archive accumulated phase directories | sma-cleanup |
| Diagnose planning directory health | sma-health |
| Open the interactive command center | sma-manager |
| Configure workflow toggles and model profile | sma-settings |
| Show project statistics | sma-stats |
| Toggle which skills are surfaced | sma-surface |
| Show the SMA command guide | sma-help |

Invoke the matched skill directly using the Skill tool.
