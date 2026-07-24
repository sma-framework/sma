# SMA Canonical Artifact Registry

This directory contains the template files for every artifact that SMA workflows officially produce. The table below is the authoritative index: **if a `.planning/` root file is not listed here, `sma-health` will flag it as W019** (unrecognized artifact).

Agents should query this file before treating a `.planning/` file as authoritative. If the file name does not appear below, it is not a canonical SMA artifact.

---

## `.planning/` Root Artifacts

These files live directly at `.planning/` — not inside phase subdirectories.

| File | Template | Produced by | Purpose |
|------|----------|-------------|---------|
| `PROJECT.md` | `project.md` | `/sma:new-project` | Project identity, goals, requirements summary |
| `ROADMAP.md` | `roadmap.md` | `/sma:new-milestone`, `/sma:new-project` | Phase plan with milestones and progress tracking |
| `STATE.md` | `state.md` | `/sma:new-project`, `/sma:health --repair` | Current session state, active phase, last activity |
| `REQUIREMENTS.md` | `requirements.md` | `/sma:new-milestone` | Functional requirements with traceability |
| `MILESTONES.md` | `milestone.md` | `/sma:complete-milestone` | Log of completed milestones with accomplishments |
| `BACKLOG.md` | *(inline)* | `/sma-add-backlog` | Pending ideas and deferred work |
| `LEARNINGS.md` | *(inline)* | `/sma:extract-learnings`, `/sma:execute-phase` | Phase retrospective learnings for future plans |
| `THREADS.md` | *(inline)* | `/sma:thread` | Persistent discussion threads |
| `config.json` | `config.json` | `/sma:new-project`, `/sma:health --repair` | Project-specific SMA configuration |
| `CLAUDE.md` | `claude-md.md` | `/sma-profile` | Auto-assembled Claude Code context file |
| `RETROSPECTIVE.md` | *(inline)* | `/sma:complete-milestone` | Living milestone retrospective updated at each milestone close |

### Version-stamped artifacts (pattern: `vX.Y-*.md`)

| Pattern | Produced by | Purpose |
|---------|-------------|---------|
| `vX.Y-MILESTONE-AUDIT.md` | `/sma:audit-milestone` | Milestone audit report before archiving |

These files are archived to `.planning/milestones/` by `/sma:complete-milestone`. Finding them at the `.planning/` root after completion indicates the archive step was skipped.

---

## Phase Subdirectory Artifacts (`.planning/phases/NN-name/`)

These files live inside a phase directory. They are NOT checked by W019 (which only inspects the `.planning/` root).

| File Pattern | Template | Produced by | Purpose |
|-------------|----------|-------------|---------|
| `NN-MM-PLAN.md` | `phase-prompt.md` | `/sma:plan-phase` | Executable implementation plan |
| `NN-MM-SUMMARY.md` | `summary.md` | `/sma:execute-phase` | Post-execution summary with learnings |
| `NN-CONTEXT.md` | `context.md` | `/sma:discuss-phase` | Scoped discussion decisions for the phase |
| `NN-RESEARCH.md` | `research.md` | `/sma:plan-phase`, `/sma:plan-phase --research-phase <N>` | Technical research for the phase |
| `NN-VALIDATION.md` | `VALIDATION.md` | `/sma:plan-phase` (Nyquist) | Validation architecture (Nyquist method) |
| `NN-UAT.md` | `UAT.md` | `/sma:validate-phase` | User acceptance test results |
| `NN-PATTERNS.md` | *(inline)* | `/sma:plan-phase` (pattern mapper) | Analog file mapping for the phase |
| `NN-UI-SPEC.md` | `UI-SPEC.md` | `/sma:ui-phase` | UI design contract |
| `NN-SECURITY.md` | `SECURITY.md` | `/sma:secure-phase` | Security threat model |
| `NN-AI-SPEC.md` | `AI-SPEC.md` | `/sma:ai-integration-phase` | AI integration spec with eval strategy |
| `NN-DEBUG.md` | `DEBUG.md` | `/sma:debug` | Debug session log |
| `NN-REVIEWS.md` | *(inline)* | `/sma:review` | Cross-AI review feedback |

---

## Milestone Archive (`.planning/milestones/`)

Files archived by `/sma:complete-milestone`. These are never checked by W019.

| File Pattern | Source |
|-------------|--------|
| `vX.Y-ROADMAP.md` | Snapshot of ROADMAP.md at milestone close |
| `vX.Y-REQUIREMENTS.md` | Snapshot of REQUIREMENTS.md at milestone close |
| `vX.Y-MILESTONE-AUDIT.md` | Moved from `.planning/` root |
| `vX.Y-phases/` | Archived phase directories (if `--archive-phases` used) |

---

## Adding a New Canonical Artifact

When a new workflow produces a `.planning/` root file:

1. Add the file name to `CANONICAL_EXACT` in `sma-core/bin/lib/artifacts.cjs`
2. Add a row to the **`.planning/` Root Artifacts** table above
3. Add the template to `sma-core/templates/` if one exists
