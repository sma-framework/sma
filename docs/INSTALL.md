# Installing SMA

SMA (sma-framework) is a layered memory + multi-terminal coordination framework
for AI coding agents. This page covers both install paths and what each one
puts on your machine.

> The package is **private until the founder flip (49.1-27)**. Until then the
> npx path only works from a machine with access to the private registry or a
> local checkout; the git-clone fallback below always works.

## Path 1: npx (the front door)

From the root of the project you want SMA installed into:

```bash
npx sma-framework init
```

Options:

| Flag | Meaning |
|---|---|
| `--claude` | Install for Claude Code (default and only runtime today) |
| `--local` / `-l` | Install into the current project (default) |
| `--global` / `-g` | Install into `$CLAUDE_CONFIG_DIR` or `~/.claude` instead |
| `--with-gsd-aliases` | Also install the transitional `/gsd-*` alias skills (D-49.1-02) |
| `--help` / `-h` | Show usage |

Examples:

```bash
npx sma-framework init                     # local install, /sma-* commands only
npx sma-framework init --global            # global install (all your projects)
npx sma-framework init --with-gsd-aliases  # local + transitional /gsd-* aliases
```

## Path 2: git clone (the documented fallback, D-49.1-06)

No registry access needed. Clone anywhere, then run the installer **from the
project you want SMA installed into** (the installer refuses to install into
the clone itself):

```bash
git clone https://github.com/sma-framework/sma.git ../sma-clone
cd <your-project>
node ../sma-clone/bin/init.mjs --local
```

To install into a DIFFERENT project than the clone, run the installer from
that project's root:

```bash
cd /path/to/your-project
node /path/to/sma/bin/init.mjs --local
```

Both paths run the exact same installer (`bin/init.mjs`, Node built-ins only,
zero dependencies).

## What gets installed where

| Payload | Destination (local) | Destination (global) |
|---|---|---|
| Engine (workflows, agents, bin, references, templates) | `<project>/.claude/sma-core/` | `~/.claude/sma-core/` |
| Coordination runtime (cli.mjs + lib) | `<project>/scripts/sma/` | `<project>/scripts/sma/` (always project-level, path parity with hooks) |
| Subagent definitions (`sma-*.md`) | `<project>/.claude/agents/` | `~/.claude/agents/` |
| Command skills (`/sma-*`, 11 commands) | `<project>/.claude/skills/` | `~/.claude/skills/` |
| Transitional `/gsd-*` aliases (flag-gated) | `<project>/.claude/skills/` | `~/.claude/skills/` |
| Hooks (SessionStart + PreToolUse collision checks) | `<project>/.claude/settings.json` | `~/.claude/settings.json` |
| Runtime scaffold | `<project>/.sma/{sessions,claims,journal}` + a `.sma/` line in `.gitignore` | same (project-level) |

The hooks merge is **additive and idempotent**: your existing hook entries are
never removed, reordered, or rewritten, and re-running `init` never duplicates
an SMA entry (entries are matched by their command string). If your
`settings.json` is not valid JSON, the installer refuses to touch it and exits.

## The /gsd-* alias flag

`--with-gsd-aliases` installs 11 thin alias skills (`/gsd-plan-phase`,
`/gsd-execute-phase`, ...) that delegate 1:1 to their `/sma-*` counterparts.
They exist only for the transition period on checkouts with old muscle memory
and are removed once the live platform phases 51/52 close (see
`sma-core/aliases/README.md`). Default installs get the `/sma-*` surface only.

## After installing

Open a Claude Code session in the project and run `/sma-start`.

## Uninstalling

SMA does not scatter files. Remove, from the target you installed into:

```bash
rm -rf .claude/sma-core .sma scripts/sma
rm -rf .claude/skills/sma-* .claude/skills/gsd-*
rm -f  .claude/agents/sma-*.md
```

(For a global install: the same paths under `~/.claude` instead of
`.claude/`, plus the project-level `scripts/sma` and `.sma/`.) Then open
`.claude/settings.json` and delete the hook entries whose command starts with
`node scripts/sma/cli.mjs`. Everything else in `settings.json` is yours and
untouched. Optionally drop the `.sma/` line from `.gitignore`.

## Audited payload manifest (T-49.1-07)

The package uses a **files allowlist** (never a denylist) in `package.json`.
The manifest below is the verbatim output of `npm pack --dry-run` for
`sma-framework@2.0.0-alpha.0` (2026-07-06). Explicitly absent: `vendor/`
(pristine upstream snapshot stays git-only), `.sma/` runtime state, `tools/`,
`.env*`, and all dotfiles. Re-audited at the 49.1-27 pre-flip gate.

Top-level composition (534 files, 1.8 MB packed / 6.6 MB unpacked):

| Path | Files | What it is |
|---|---|---|
| `sma-core/` | 448 | the engine: workflows, agents, references, templates, bin shim, transitional aliases |
| `scripts/sma/` | ~70 | coordination runtime + its tests and fixtures |
| `bin/init.mjs` | 1 | this installer |
| `docs/` | 1+ | this document |
| root | 5 | `package.json`, `LICENSE`, `THIRD-PARTY-LICENSES.md`, `UPSTREAM.json`, `rename-map.json` |

<details>
<summary>Full file list (npm pack --dry-run, 534 files)</summary>

```
LICENSE
THIRD-PARTY-LICENSES.md
UPSTREAM.json
bin/init.mjs
docs/INSTALL.md
package.json
rename-map.json
scripts/sma/README.md
scripts/sma/__tests__/cli.test.ts
scripts/sma/__tests__/collision.test.ts
scripts/sma/__tests__/demo-scenarios.test.ts
scripts/sma/__tests__/fixtures/TAGS.md
scripts/sma/__tests__/fixtures/lint/alias/MEMORY.md
scripts/sma/__tests__/fixtures/lint/alias/TAGS.md
scripts/sma/__tests__/fixtures/lint/alias/reference_uses_alias.md
scripts/sma/__tests__/fixtures/lint/buglesson/MEMORY.md
scripts/sma/__tests__/fixtures/lint/buglesson/TAGS.md
scripts/sma/__tests__/fixtures/lint/buglesson/feedback_broken_lesson.md
scripts/sma/__tests__/fixtures/lint/buglesson/feedback_good_lesson.md
scripts/sma/__tests__/fixtures/lint/claudedup/CLAUDE.md
scripts/sma/__tests__/fixtures/lint/claudedup/MEMORY.md
scripts/sma/__tests__/fixtures/lint/claudedup/TAGS.md
scripts/sma/__tests__/fixtures/lint/claudedup/rule_duplicated.md
scripts/sma/__tests__/fixtures/lint/clean/MEMORY.md
scripts/sma/__tests__/fixtures/lint/clean/TAGS.md
scripts/sma/__tests__/fixtures/lint/clean/feedback_gsd_command_prefix.md
scripts/sma/__tests__/fixtures/lint/clean/reference_local_sandbox.md
scripts/sma/__tests__/fixtures/lint/dupe/MEMORY.md
scripts/sma/__tests__/fixtures/lint/dupe/TAGS.md
scripts/sma/__tests__/fixtures/lint/dupe/reference_one.md
scripts/sma/__tests__/fixtures/lint/dupe/reference_two.md
scripts/sma/__tests__/fixtures/lint/orphan/MEMORY.md
scripts/sma/__tests__/fixtures/lint/orphan/TAGS.md
scripts/sma/__tests__/fixtures/lint/orphan/reference_present.md
scripts/sma/__tests__/fixtures/lint/regen-postflip/MEMORY.md
scripts/sma/__tests__/fixtures/lint/regen-postflip/TAGS.md
scripts/sma/__tests__/fixtures/lint/regen-postflip/reference_note.md
scripts/sma/__tests__/fixtures/lint/regen-preflip/MEMORY.md
scripts/sma/__tests__/fixtures/lint/regen-preflip/TAGS.md
scripts/sma/__tests__/fixtures/lint/regen-preflip/reference_note.md
scripts/sma/__tests__/fixtures/lint/schema/MEMORY.md
scripts/sma/__tests__/fixtures/lint/schema/TAGS.md
scripts/sma/__tests__/fixtures/lint/schema/reference_missing_fields.md
scripts/sma/__tests__/fixtures/lint/supersede/MEMORY.md
scripts/sma/__tests__/fixtures/lint/supersede/TAGS.md
scripts/sma/__tests__/fixtures/lint/supersede/reference_a.md
scripts/sma/__tests__/fixtures/lint/supersede/reference_b.md
scripts/sma/__tests__/fixtures/lint/supersede/reference_broken.md
scripts/sma/__tests__/fixtures/lint/supersede/reference_dated.md
scripts/sma/__tests__/fixtures/lint/tagchaos/MEMORY.md
scripts/sma/__tests__/fixtures/lint/tagchaos/TAGS.md
scripts/sma/__tests__/fixtures/lint/tagchaos/reference_a.md
scripts/sma/__tests__/fixtures/lint/tagchaos/reference_b.md
scripts/sma/__tests__/fixtures/lint/tagchaos/reference_c.md
scripts/sma/__tests__/fixtures/lint/vocab/MEMORY.md
scripts/sma/__tests__/fixtures/lint/vocab/TAGS.md
scripts/sma/__tests__/fixtures/lint/vocab/reference_bad_tag.md
scripts/sma/__tests__/fixtures/lint/wikilink/MEMORY.md
scripts/sma/__tests__/fixtures/lint/wikilink/TAGS.md
scripts/sma/__tests__/fixtures/lint/wikilink/reference_has_links.md
scripts/sma/__tests__/fixtures/lint/wikilink/reference_target.md
scripts/sma/__tests__/frontmatter-migration.test.ts
scripts/sma/__tests__/fs-atomics.test.ts
scripts/sma/__tests__/generator.test.ts
scripts/sma/__tests__/journal.test.ts
scripts/sma/__tests__/lint.test.ts
scripts/sma/__tests__/loader.test.ts
scripts/sma/__tests__/next-slot.test.ts
scripts/sma/__tests__/provenance.test.ts
scripts/sma/__tests__/registry.test.ts
scripts/sma/__tests__/snapshot.test.ts
scripts/sma/cli.mjs
scripts/sma/lib/claims.mjs
scripts/sma/lib/collision.mjs
scripts/sma/lib/constants.mjs
scripts/sma/lib/frontmatter.mjs
scripts/sma/lib/fs-atomics.mjs
scripts/sma/lib/generator.mjs
scripts/sma/lib/journal.mjs
scripts/sma/lib/lint.mjs
scripts/sma/lib/loader.mjs
scripts/sma/lib/registry.mjs
scripts/sma/lib/slots.mjs
scripts/sma/lib/snapshot.mjs
scripts/sma/migrate-frontmatter.mjs
scripts/sma/statusline-snippet.md
sma-core/VERSION
sma-core/agents/sma-advisor-researcher.md
sma-core/agents/sma-ai-researcher.md
sma-core/agents/sma-assumptions-analyzer.md
sma-core/agents/sma-code-fixer.md
sma-core/agents/sma-code-reviewer.md
sma-core/agents/sma-codebase-mapper.md
sma-core/agents/sma-debug-session-manager.md
sma-core/agents/sma-debugger.md
sma-core/agents/sma-doc-classifier.md
sma-core/agents/sma-doc-synthesizer.md
sma-core/agents/sma-doc-verifier.md
sma-core/agents/sma-doc-writer.md
sma-core/agents/sma-domain-researcher.md
sma-core/agents/sma-eval-auditor.md
sma-core/agents/sma-eval-planner.md
sma-core/agents/sma-executor.md
sma-core/agents/sma-framework-selector.md
sma-core/agents/sma-integration-checker.md
sma-core/agents/sma-intel-updater.md
sma-core/agents/sma-mempalace-curator.md
sma-core/agents/sma-nyquist-auditor.md
sma-core/agents/sma-pattern-mapper.md
sma-core/agents/sma-phase-researcher.md
sma-core/agents/sma-plan-checker.md
sma-core/agents/sma-planner.md
sma-core/agents/sma-project-researcher.md
sma-core/agents/sma-research-synthesizer.md
sma-core/agents/sma-roadmapper.md
sma-core/agents/sma-security-auditor.md
sma-core/agents/sma-ui-auditor.md
sma-core/agents/sma-ui-checker.md
sma-core/agents/sma-ui-researcher.md
sma-core/agents/sma-user-profiler.md
sma-core/agents/sma-verifier.md
sma-core/aliases/README.md
sma-core/aliases/gsd-debug/SKILL.md
sma-core/aliases/gsd-discuss-phase/SKILL.md
sma-core/aliases/gsd-execute-phase/SKILL.md
sma-core/aliases/gsd-fast/SKILL.md
sma-core/aliases/gsd-help/SKILL.md
sma-core/aliases/gsd-pause-work/SKILL.md
sma-core/aliases/gsd-plan-phase/SKILL.md
sma-core/aliases/gsd-progress/SKILL.md
sma-core/aliases/gsd-quick/SKILL.md
sma-core/aliases/gsd-resume-work/SKILL.md
sma-core/aliases/gsd-verify-work/SKILL.md
sma-core/bin/check-latest-version.cjs
sma-core/bin/lib/active-workstream-store.cjs
sma-core/bin/lib/adr-parser.cjs
sma-core/bin/lib/agent-command-router.cjs
sma-core/bin/lib/agent-install-check.cjs
sma-core/bin/lib/artifacts.cjs
sma-core/bin/lib/audit-command-router.cjs
sma-core/bin/lib/audit.cjs
sma-core/bin/lib/capability-activation.cjs
sma-core/bin/lib/capability-consent.cjs
sma-core/bin/lib/capability-ledger.cjs
sma-core/bin/lib/capability-lifecycle.cjs
sma-core/bin/lib/capability-loader.cjs
sma-core/bin/lib/capability-lock.cjs
sma-core/bin/lib/capability-registry.cjs
sma-core/bin/lib/capability-source.cjs
sma-core/bin/lib/capability-state.cjs
sma-core/bin/lib/capability-trust.cjs
sma-core/bin/lib/capability-validator.cjs
sma-core/bin/lib/capability-writer.cjs
sma-core/bin/lib/check-command-router.cjs
sma-core/bin/lib/cjs-command-router-adapter.cjs
sma-core/bin/lib/cli-exit.cjs
sma-core/bin/lib/clock.cjs
sma-core/bin/lib/clusters.cjs
sma-core/bin/lib/code-review-flags.cjs
sma-core/bin/lib/command-aliases.cjs
sma-core/bin/lib/command-arg-projection.cjs
sma-core/bin/lib/command-roster.cjs
sma-core/bin/lib/command-routing-hub.cjs
sma-core/bin/lib/commands.cjs
sma-core/bin/lib/config-loader.cjs
sma-core/bin/lib/config-schema.cjs
sma-core/bin/lib/config-types.cjs
sma-core/bin/lib/config.cjs
sma-core/bin/lib/configuration.cjs
sma-core/bin/lib/context-utilization.cjs
sma-core/bin/lib/core-utils.cjs
sma-core/bin/lib/coverage.cjs
sma-core/bin/lib/decisions.cjs
sma-core/bin/lib/docs.cjs
sma-core/bin/lib/drift.cjs
sma-core/bin/lib/edge-probe.cjs
sma-core/bin/lib/eval-command-router.cjs
sma-core/bin/lib/eval.cjs
sma-core/bin/lib/fallow-runner.cjs
sma-core/bin/lib/federated-config.cjs
sma-core/bin/lib/frontmatter.cjs
sma-core/bin/lib/gap-checker.cjs
sma-core/bin/lib/git-base-branch.cjs
sma-core/bin/lib/graphify-command-router.cjs
sma-core/bin/lib/graphify.cjs
sma-core/bin/lib/init-command-router.cjs
sma-core/bin/lib/init.cjs
sma-core/bin/lib/install-profiles.cjs
sma-core/bin/lib/installer-migration-authoring.cjs
sma-core/bin/lib/installer-migration-report.cjs
sma-core/bin/lib/installer-migrations.cjs
sma-core/bin/lib/installer-migrations/000-first-time-baseline.cjs
sma-core/bin/lib/installer-migrations/001-legacy-orphan-files.cjs
sma-core/bin/lib/installer-migrations/002-codex-legacy-hooks-json.cjs
sma-core/bin/lib/installer-migrations/003-rename-get-shit-done-to-sma-core.cjs
sma-core/bin/lib/installer-migrations/004-prune-stale-pristine-snapshots.cjs
sma-core/bin/lib/intel-command-router.cjs
sma-core/bin/lib/intel.cjs
sma-core/bin/lib/io.cjs
sma-core/bin/lib/learnings.cjs
sma-core/bin/lib/legacy-cleanup.cjs
sma-core/bin/lib/loop-host-contract.cjs
sma-core/bin/lib/loop-resolver.cjs
sma-core/bin/lib/markdown-sectionizer.cjs
sma-core/bin/lib/milestone.cjs
sma-core/bin/lib/model-catalog.cjs
sma-core/bin/lib/model-profiles.cjs
sma-core/bin/lib/model-resolver.cjs
sma-core/bin/lib/observability/event.cjs
sma-core/bin/lib/observability/logger.cjs
sma-core/bin/lib/observability/redaction.cjs
sma-core/bin/lib/package-identity.cjs
sma-core/bin/lib/package-legitimacy.cjs
sma-core/bin/lib/phase-command-router.cjs
sma-core/bin/lib/phase-id.cjs
sma-core/bin/lib/phase-lifecycle.cjs
sma-core/bin/lib/phase-locator.cjs
sma-core/bin/lib/phase.cjs
sma-core/bin/lib/phases-command-router.cjs
sma-core/bin/lib/plan-drift-guard.cjs
sma-core/bin/lib/plan-scan.cjs
sma-core/bin/lib/planning-workspace.cjs
sma-core/bin/lib/probe-core.cjs
sma-core/bin/lib/profile-output.cjs
sma-core/bin/lib/profile-pipeline-command-router.cjs
sma-core/bin/lib/profile-pipeline.cjs
sma-core/bin/lib/prohibition-enforcement.cjs
sma-core/bin/lib/project-root.cjs
sma-core/bin/lib/prompt-budget.cjs
sma-core/bin/lib/research-provider.cjs
sma-core/bin/lib/research-store.cjs
sma-core/bin/lib/resolution.cjs
sma-core/bin/lib/review-reviewer-selection.cjs
sma-core/bin/lib/roadmap-command-router.cjs
sma-core/bin/lib/roadmap-parser.cjs
sma-core/bin/lib/roadmap-upgrade.cjs
sma-core/bin/lib/roadmap.cjs
sma-core/bin/lib/runtime-artifact-conversion.cjs
sma-core/bin/lib/runtime-artifact-install-plan.cjs
sma-core/bin/lib/runtime-artifact-layout.cjs
sma-core/bin/lib/runtime-config-adapter-registry.cjs
sma-core/bin/lib/runtime-homes.cjs
sma-core/bin/lib/runtime-hooks-surface.cjs
sma-core/bin/lib/runtime-name-policy.cjs
sma-core/bin/lib/runtime-slash.cjs
sma-core/bin/lib/schema-detect.cjs
sma-core/bin/lib/secrets.cjs
sma-core/bin/lib/security.cjs
sma-core/bin/lib/semver-compare.cjs
sma-core/bin/lib/shell-command-projection.cjs
sma-core/bin/lib/sma2-import.cjs
sma-core/bin/lib/state-command-router.cjs
sma-core/bin/lib/state-document.cjs
sma-core/bin/lib/state.cjs
sma-core/bin/lib/surface.cjs
sma-core/bin/lib/task-command-router.cjs
sma-core/bin/lib/teams-status.cjs
sma-core/bin/lib/template.cjs
sma-core/bin/lib/uat-predicate.cjs
sma-core/bin/lib/uat.cjs
sma-core/bin/lib/ui-safety-gate.cjs
sma-core/bin/lib/update-context.cjs
sma-core/bin/lib/validate-command-router.cjs
sma-core/bin/lib/validate.cjs
sma-core/bin/lib/verification-command-router.cjs
sma-core/bin/lib/verification.cjs
sma-core/bin/lib/verify-command-router.cjs
sma-core/bin/lib/verify.cjs
sma-core/bin/lib/workstream-inventory-builder.cjs
sma-core/bin/lib/workstream-inventory.cjs
sma-core/bin/lib/workstream-name-policy.cjs
sma-core/bin/lib/workstream.cjs
sma-core/bin/lib/worktree-base-ref.cjs
sma-core/bin/lib/worktree-safety.cjs
sma-core/bin/shared/config-defaults.manifest.json
sma-core/bin/shared/config-schema.manifest.json
sma-core/bin/shared/model-catalog.json
sma-core/bin/shared/runtime-aliases.manifest.json
sma-core/bin/sma-tools.cjs
sma-core/bin/sma_run
sma-core/bin/verify-reapply-patches.cjs
sma-core/contexts/dev.md
sma-core/contexts/research.md
sma-core/contexts/review.md
sma-core/references/agent-contracts.md
sma-core/references/ai-evals.md
sma-core/references/ai-frameworks.md
sma-core/references/artifact-types.md
sma-core/references/autonomous-smart-discuss.md
sma-core/references/checkpoints.md
sma-core/references/common-bug-patterns.md
sma-core/references/context-budget.md
sma-core/references/continuation-format.md
sma-core/references/debugger-philosophy.md
sma-core/references/decimal-phase-calculation.md
sma-core/references/doc-conflict-engine.md
sma-core/references/domain-probes.md
sma-core/references/edge-probe-fixtures/01-round-half-even/expected-coverage.json
sma-core/references/edge-probe-fixtures/01-round-half-even/requirements.json
sma-core/references/edge-probe-fixtures/02-merge-intervals/expected-coverage.json
sma-core/references/edge-probe-fixtures/02-merge-intervals/requirements.json
sma-core/references/edge-probe-fixtures/03-truncate-graphemes/expected-coverage.json
sma-core/references/edge-probe-fixtures/03-truncate-graphemes/requirements.json
sma-core/references/edge-probe-fixtures/04-money-rounding/expected-coverage.json
sma-core/references/edge-probe-fixtures/04-money-rounding/requirements.json
sma-core/references/edge-probe-fixtures/05-list-dedupe/expected-coverage.json
sma-core/references/edge-probe-fixtures/05-list-dedupe/requirements.json
sma-core/references/edge-probe-fixtures/06-resolved-mixed/expected-coverage.json
sma-core/references/edge-probe-fixtures/06-resolved-mixed/requirements.json
sma-core/references/edge-probe-fixtures/06-resolved-mixed/resolutions.json
sma-core/references/edge-probe.md
sma-core/references/execute-mvp-tdd.md
sma-core/references/execute-phase-between-wave-reset.md
sma-core/references/execute-phase-context-guard.md
sma-core/references/execute-phase-wave-guard.md
sma-core/references/executor-examples.md
sma-core/references/few-shot-examples/plan-checker.md
sma-core/references/few-shot-examples/verifier.md
sma-core/references/gate-prompts.md
sma-core/references/gates.md
sma-core/references/git-integration.md
sma-core/references/git-planning-commit.md
sma-core/references/ios-scaffold.md
sma-core/references/loop-hook-dispatch.md
sma-core/references/mandatory-initial-read.md
sma-core/references/model-profile-resolution.md
sma-core/references/model-profiles.md
sma-core/references/mvp-concepts.md
sma-core/references/phase-argument-parsing.md
sma-core/references/planner-antipatterns.md
sma-core/references/planner-chunked.md
sma-core/references/planner-gap-closure.md
sma-core/references/planner-graphify-auto-update.md
sma-core/references/planner-guidance.md
sma-core/references/planner-human-verify-mode.md
sma-core/references/planner-interface-context.md
sma-core/references/planner-load-graph-context.md
sma-core/references/planner-mvp-mode.md
sma-core/references/planner-reviews.md
sma-core/references/planner-revision.md
sma-core/references/planner-source-audit.md
sma-core/references/planning-config.md
sma-core/references/prohibition-probe-fixtures/01-streak-reminder/expected.json
sma-core/references/prohibition-probe-fixtures/02-clean-utility/expected.json
sma-core/references/prohibition-probe-fixtures/03-multi-prohibition/expected.json
sma-core/references/prohibition-probe.md
sma-core/references/project-skills-discovery.md
sma-core/references/questioning.md
sma-core/references/research-documentation-lookup.md
sma-core/references/research-philosophy.md
sma-core/references/research-verification-protocol.md
sma-core/references/revision-loop.md
sma-core/references/scout-codebase.md
sma-core/references/security-asvs-levels.md
sma-core/references/skeleton-template.md
sma-core/references/sketch-interactivity.md
sma-core/references/sketch-theme-system.md
sma-core/references/sketch-tooling.md
sma-core/references/sketch-variant-patterns.md
sma-core/references/spidr-splitting.md
sma-core/references/tdd.md
sma-core/references/thinking-models-debug.md
sma-core/references/thinking-models-execution.md
sma-core/references/thinking-models-planning.md
sma-core/references/thinking-models-research.md
sma-core/references/thinking-models-verification.md
sma-core/references/thinking-partner.md
sma-core/references/ui-brand.md
sma-core/references/universal-anti-patterns.md
sma-core/references/untrusted-input-boundary.md
sma-core/references/user-profiling.md
sma-core/references/user-story-template.md
sma-core/references/verification-overrides.md
sma-core/references/verification-patterns.md
sma-core/references/verify-mvp-mode.md
sma-core/references/workstream-flag.md
sma-core/references/worktree-branch-check.md
sma-core/references/worktree-path-safety.md
sma-core/templates/AI-SPEC.md
sma-core/templates/DEBUG.md
sma-core/templates/README.md
sma-core/templates/SECURITY.md
sma-core/templates/UAT.md
sma-core/templates/UI-SPEC.md
sma-core/templates/VALIDATION.md
sma-core/templates/claude-md.md
sma-core/templates/codebase/architecture.md
sma-core/templates/codebase/concerns.md
sma-core/templates/codebase/conventions.md
sma-core/templates/codebase/integrations.md
sma-core/templates/codebase/stack.md
sma-core/templates/codebase/structure.md
sma-core/templates/codebase/testing.md
sma-core/templates/config.json
sma-core/templates/context.md
sma-core/templates/continue-here.md
sma-core/templates/copilot-instructions.md
sma-core/templates/debug-subagent-prompt.md
sma-core/templates/dev-preferences.md
sma-core/templates/discovery.md
sma-core/templates/discussion-log.md
sma-core/templates/milestone-archive.md
sma-core/templates/milestone.md
sma-core/templates/phase-prompt.md
sma-core/templates/planner-subagent-prompt.md
sma-core/templates/project.md
sma-core/templates/requirements.md
sma-core/templates/research-project/ARCHITECTURE.md
sma-core/templates/research-project/FEATURES.md
sma-core/templates/research-project/PITFALLS.md
sma-core/templates/research-project/STACK.md
sma-core/templates/research-project/SUMMARY.md
sma-core/templates/research.md
sma-core/templates/retrospective.md
sma-core/templates/roadmap.md
sma-core/templates/spec.md
sma-core/templates/state.md
sma-core/templates/summary-complex.md
sma-core/templates/summary-minimal.md
sma-core/templates/summary-standard.md
sma-core/templates/summary.md
sma-core/templates/user-profile.md
sma-core/templates/user-setup.md
sma-core/templates/verification-report.md
sma-core/workflows/_runtime-launcher.snippet.sh
sma-core/workflows/add-backlog.md
sma-core/workflows/add-phase.md
sma-core/workflows/add-tests.md
sma-core/workflows/add-todo.md
sma-core/workflows/ai-integration-phase.md
sma-core/workflows/analyze-dependencies.md
sma-core/workflows/audit-fix.md
sma-core/workflows/audit-milestone.md
sma-core/workflows/audit-uat.md
sma-core/workflows/autonomous.md
sma-core/workflows/check-todos.md
sma-core/workflows/cleanup.md
sma-core/workflows/code-review-fix.md
sma-core/workflows/code-review.md
sma-core/workflows/complete-milestone.md
sma-core/workflows/debug.md
sma-core/workflows/diagnose-issues.md
sma-core/workflows/discovery-phase.md
sma-core/workflows/discuss-phase-assumptions.md
sma-core/workflows/discuss-phase-power.md
sma-core/workflows/discuss-phase.md
sma-core/workflows/discuss-phase/modes/advisor.md
sma-core/workflows/discuss-phase/modes/all.md
sma-core/workflows/discuss-phase/modes/analyze.md
sma-core/workflows/discuss-phase/modes/auto.md
sma-core/workflows/discuss-phase/modes/batch.md
sma-core/workflows/discuss-phase/modes/chain.md
sma-core/workflows/discuss-phase/modes/default.md
sma-core/workflows/discuss-phase/modes/power.md
sma-core/workflows/discuss-phase/modes/text.md
sma-core/workflows/discuss-phase/templates/checkpoint.json
sma-core/workflows/discuss-phase/templates/context.md
sma-core/workflows/discuss-phase/templates/discussion-log.md
sma-core/workflows/do.md
sma-core/workflows/docs-update.md
sma-core/workflows/edit-phase.md
sma-core/workflows/eval-review.md
sma-core/workflows/execute-phase.md
sma-core/workflows/execute-phase/steps/codebase-drift-gate.md
sma-core/workflows/execute-phase/steps/per-plan-worktree-gate.md
sma-core/workflows/execute-phase/steps/post-merge-gate.md
sma-core/workflows/execute-phase/steps/worktree-recovery-policy.md
sma-core/workflows/execute-plan.md
sma-core/workflows/explore.md
sma-core/workflows/extract-learnings.md
sma-core/workflows/fast.md
sma-core/workflows/forensics.md
sma-core/workflows/graduation.md
sma-core/workflows/health.md
sma-core/workflows/help.md
sma-core/workflows/help/modes/brief.md
sma-core/workflows/help/modes/default.md
sma-core/workflows/help/modes/full.md
sma-core/workflows/help/modes/topic.md
sma-core/workflows/import.md
sma-core/workflows/inbox.md
sma-core/workflows/ingest-docs.md
sma-core/workflows/insert-phase.md
sma-core/workflows/list-phase-assumptions.md
sma-core/workflows/list-seeds.md
sma-core/workflows/list-workspaces.md
sma-core/workflows/manager.md
sma-core/workflows/map-codebase.md
sma-core/workflows/milestone-summary.md
sma-core/workflows/mvp-phase.md
sma-core/workflows/new-milestone.md
sma-core/workflows/new-project.md
sma-core/workflows/new-workspace.md
sma-core/workflows/next.md
sma-core/workflows/node-repair.md
sma-core/workflows/note.md
sma-core/workflows/pause-work.md
sma-core/workflows/plan-milestone-gaps.md
sma-core/workflows/plan-phase.md
sma-core/workflows/plan-review-convergence.md
sma-core/workflows/plant-seed.md
sma-core/workflows/pr-branch.md
sma-core/workflows/profile-user.md
sma-core/workflows/progress.md
sma-core/workflows/quick.md
sma-core/workflows/reapply-patches.md
sma-core/workflows/remove-phase.md
sma-core/workflows/remove-workspace.md
sma-core/workflows/resume-project.md
sma-core/workflows/review.md
sma-core/workflows/scan.md
sma-core/workflows/secure-phase.md
sma-core/workflows/session-report.md
sma-core/workflows/settings-advanced.md
sma-core/workflows/settings-integrations.md
sma-core/workflows/settings.md
sma-core/workflows/ship.md
sma-core/workflows/sketch-wrap-up.md
sma-core/workflows/sketch.md
sma-core/workflows/spec-phase.md
sma-core/workflows/spike-wrap-up.md
sma-core/workflows/spike.md
sma-core/workflows/stats.md
sma-core/workflows/sync-skills.md
sma-core/workflows/thread.md
sma-core/workflows/transition.md
sma-core/workflows/ui-phase.md
sma-core/workflows/ui-review.md
sma-core/workflows/ultraplan-phase.md
sma-core/workflows/undo.md
sma-core/workflows/update.md
sma-core/workflows/validate-phase.md
sma-core/workflows/verify-phase.md
sma-core/workflows/verify-work.md
```

</details>
