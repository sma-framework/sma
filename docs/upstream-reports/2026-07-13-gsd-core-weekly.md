# Weekly upstream check — gsd-core — 2026-07-13

**Cadence:** weekly (founder order 2026-07-13). First report in this series.
**Our pin:** `@opengsd/gsd-core` **1.6.1** (source `github.com/open-gsd/gsd-core`, snapshot 2026-07-06 — see `UPSTREAM.json`).

## Verdict: NO ACTION this week

Latest upstream **stable** is still **v1.6.1** (2026-07-01) — the same version our snapshot vendors. All three of its bug fixes (Phase 0/999 backlog-sentinel exclusion in milestone/roadmap; `is_last_phase` mis-report on checkbox checklists inside `<details>`; Windows double-quoting of `$CLAUDE_PROJECT_DIR`-anchored node hook paths) are already inside our 2026-07-06 snapshot. Nothing to port.

## Watchlist: v1.7.0 release candidates (npm `next` dist-tag, rc.2 → rc.6, 2026-07-03..12)

Not vendoring pre-releases; noting what lands when 1.7.0 goes stable:

| Item | Why it matters to SMA |
|---|---|
| **EoS migration** — Embeddable Orchestration System; Claude Code, Codex, Cursor, Cline, Hermes, Qwen Code and others migrated onto one adapter layer | Structural rework of gsd-core internals. Our vendored fork faces a **large rebase** at 1.7.0-stable — plan it as its own task, not a routine bump. Also mirrors our own multi-agent-runtime direction (9.4 vendor ledger). |
| **Verifier abstention on insufficient specification** | Aligns with SMA honesty rules (a verifier that refuses to certify beats one that guesses). Candidate absorb into sma-core verify flow at stable. |
| **Portability AST rules + Windows fixes** | We run Windows daily; historically hit Windows-only breakage (e.g. payload types bin). Port relevant fixes at stable. |
| **STATE.md Transition Module (ADR-1769)** | Touches STATE.md handling — collides with our house STATE.md-as-snapshot rule; review carefully before absorbing. |

## Process note

Once 9.4-01 lands (`sma vendor` ledger + `docs/VENDOR-LEDGER.md`), this weekly check should become a **ledger row** (`source: github.com/open-gsd/gsd-core`, cadence: weekly, pin: 1.6.1) so the ship gate carries it and the cadence cannot be silently dropped. Until then: next manual check **2026-07-20**, report to this directory.
