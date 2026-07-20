# Vendor ledger — the standing Anthropic-update triage

This is the append-only record of every Anthropic developer update SMA has
looked at, and what we decided to do about it. It mechanizes the founder's
standing mandate: **every** vendor capability sighting becomes one row here with
a mandatory verdict and a mandatory disposition — nothing ships past us
untriaged.

It is a **human-honesty instrument**, not an automation. A person or agent reads
the release notes / changelog / blog and appends a row; the `sma vendor` verb is
a deterministic reader that keeps the rows honest (it fails any row missing a
verdict or disposition) and never writes a verdict itself. It performs zero
network calls — the judgment is human, the linter only enforces that a judgment
was recorded.

## The verdict vocabulary

Every row's `verdict` cell is exactly one of:

| Verdict | Meaning |
|---|---|
| `CORE-threat` | The vendor is moving into a lane SMA claims as its own. This creates SMA surface — a build. |
| `BRIDGE-candidate` | Worth a thin adapter behind a seam, with a self-removal tripwire prediction (D-9.2-05). Never headlined. |
| `ABSORB` | The idea is good and already fits an existing SMA mechanism — fold it in, no new surface. |
| `IRRELEVANT` | Does not touch SMA's problem (or is API-runtime-only with no SMA hook). Recorded so it is not re-litigated. |
| `WATCH` | Not actionable yet, but might become so. Carries a tripwire disposition to re-check when a named condition flips. |

Every row's `disposition` cell is a backlog id (`BL-160`), a tripwire prediction
id (`tripwire P9.4-05-B`), or the literal `none`.

**Why negative verdicts are on file:** the `IRRELEVANT` and `WATCH` rows are the
point. They are what stop the same vendor feature from being re-argued every
quarter — the same reason the `nearmiss` and `disposition` ledgers exist.

## Cadence — two hooks into existing rituals, no new ceremony

1. **Product ship gate.** The `/sma-ship` release ritual runs
   `node scripts/sma/cli.mjs vendor --count untriaged`. A non-zero count blocks
   the release until every sighting is triaged (or the founder dispositions the
   miss). A release with untriaged rows is the process not existing.
2. **Weekly reading slot.** The platform's weekly miss-curriculum slot (9.3-06)
   is the natural rhythm to read Anthropic's changelog / blog and append the new
   week's sightings.

## How to add a row

Append one line to the `## Ledger` table below with all seven columns filled.
Keep each capability cell to one line and free of the `|` character. The
`triaged-by` cell records who made the call (a phase id, a terminal, a name).

## Ledger

| date | source | capability | runtime | verdict | disposition | triaged-by |
|---|---|---|---|---|---|---|
| 2026-07-09 | S1 multi-agent | Managed-Agents multi-agent sessions: hub-and-spoke, 20 agents, depth 1 | api | IRRELEVANT | none | 9.4 research |
| 2026-07-10 | S1 / D3 memory stores | memory-store endpoints split to their own `agent-memory-2026-07-22` beta track | api | WATCH | none | 9.4 research |
| 2026-07-10 | S1 / D5 self-copies | coordinator roster accepts `{"type":"self"}` self-copies | api | IRRELEVANT | none | 9.4 research |
| 2026-07-09 | S2 cookbook | plan-big-execute-small: Fable-5 coordinator (no tools) + Sonnet-5 workers | api | ABSORB | none | 9.4 research |
| 2026-07-10 | S3 advisor tool | advisor tool (Messages API only; NOT exposed inside Claude Code sessions) | api | WATCH | tripwire P9.4-05-C | 9.4 research |
| 2026-07-10 | D1 agent-teams | agent-teams reworked at v2.1.178: TeamCreate/TeamDelete deleted, team_name deprecated, still session-scoped and off by default | claude-code | WATCH | tripwire P9.4-05-B | 9.4 research |
| 2026-07-10 | D2 subagents | subagents run in background by default since v2.1.198 (shifts SubagentStop timing) | claude-code | BRIDGE-candidate | BL-173 | 9.4 research |
| 2026-07-10 | D4 pricing | Managed-Agents pricing published: $0.08 per session-hour; Sonnet-5 intro $2/$10 until 2026-08-31 | api | IRRELEVANT | none | 9.4 research |
| 2026-07-09 | S4 loops article | loop primitives /goal /loop /schedule (points at git worktrees for parallelism) | claude-code | IRRELEVANT | none | 9.4 research |
| 2026-07-09 | S6 outcomes | Outcomes grader is opaque — verifiable but not auditable (the lane SMA answers) | api | CORE-threat | BL-160 | 9.4 research |
| 2026-07-10 | sma emit target | proposed `sma emit` fifth target: the vendor memory-store format | api | WATCH | none | 9.4 research |
| 2026-07-10 | dream-parity | proposed corpus dream-parity curation pass (duplicate/staleness) | | IRRELEVANT | none | 9.4 research |
| 2026-07-10 | arena attribution | benchmark-arena coordinator/worker token attribution | claude-code | WATCH | none | 9.4 research |
| 2026-07-10 | BL-172 note | receipt re-pin to structural checks — owned «в работе» by another terminal | | IRRELEVANT | BL-172 | 9.4 research |
