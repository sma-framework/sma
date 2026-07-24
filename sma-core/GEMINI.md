# SMA Core — Antigravity CLI context

> **Gemini CLI was sunset by Google on 2026-06-18** and is no longer served for
> free/Pro/Ultra tiers. Antigravity CLI is its official successor, and this file
> is the context Antigravity reads automatically (its `contextFileName` is
> `GEMINI.md`, inherited from the shared Gemini 3 backend).

This context gives Antigravity the operating context for
[SMA Core](https://github.com/sma-framework/sma), a meta-prompting,
context-engineering, and spec-driven development system for AI coding agents.

## What SMA is

SMA turns a vague goal into shipped software through an explicit,
resumable workflow: **explore → plan → execute → verify → ship**. Work is
organised into milestones and phases under a `.planning/` directory, with each
phase carrying a SPEC, a PLAN, and verification criteria. The system favours
small, atomic, test-backed commits and keeps durable context in version-tracked
files rather than in the conversation.

## The slash commands (installed separately)

> **This file ships only the context above — not the slash commands.** To
> install the `/sma-*` command set, agents, and hooks into `~/.gemini/antigravity/`,
> run the dedicated installer:
>
> ```bash
> npx sma-core --antigravity --global
> ```
>
> The commands below are available only once that installer has run.

If you have installed the sma commands, the workflow is driven by these `/sma-*`
slash commands (Antigravity registers sma's commands under a hyphenated
namespace):

- `/sma-new-project` — initialise a project and gather deep context.
- `/sma-progress` — the unified situational command: check progress, advance the
  workflow, or dispatch a freeform intent.
- `/sma-plan-phase <N>` — produce a detailed phase plan with a verification loop.
- `/sma-execute-phase <N>` — execute a phase's plans with wave-based parallelism.
- `/sma-verify-work` — validate built features through conversational UAT.
- `/sma-ship` — open a PR, run review, and prepare for merge.
- `/sma-help` — list every available command.

## Working with SMA

- Treat `.planning/` as the source of truth for project state — read it before
  acting, and keep it current as work progresses.
- Prefer the smallest change that satisfies the phase's verification criteria.
- Run the project's tests and linters before declaring a phase done.
- When unsure what to do next, and the sma commands are installed, `/sma-progress`
  is the situational entry point.

Learn more: <https://github.com/sma-framework/sma>
