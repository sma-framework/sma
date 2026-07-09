# SMA — Shared Memory & Automation (Phase 49, V1)

> **This is the CANONICAL copy of the SMA runtime layer** (sma-framework product
> repo, migrated in 49.1-03 per FI-1 / D-49.1-05). The originating platform's
> `scripts/sma/` copy is FROZEN for the duration of phase 49.1: all V2 pillar
> work (P1-P6, plans 49.1-07..24) extends THIS tree. The platform re-syncs from
> here at the dogfood step (49.1-26). Path parity is deliberate: hook commands
> (`node scripts/sma/cli.mjs ...`) stay valid unchanged in any install target.

SMA is the layered-memory + multi-terminal coordination framework that sits on top
of gsd-core in this repo. It has two pillars:

1. **Layered memory (R1–R4)** — `.claude/memory/MEMORY.md` is a *generated* build
   artifact: an always-loaded CORE section plus a sparse one-line-per-fact index,
   built from the memory corpus. Peripheral facts are pulled on demand by facet tags.
2. **Multi-terminal coordination (R7–R11)** — local `.sma/` files are the sole
   source of coordination truth: session leases, scope claims, a shared journal,
   and three external-state slots (migration number, V1.N release, deploy signal).

Everything is deterministic Node (built-ins only, zero npm deps). All CLI verbs run
through `pnpm sma <subcommand>` (`scripts/sma/cli.mjs`).

> **CLAUDE.md is frozen for V1 (D-49-08).** The agent-facing protocol lives in the
> CORE-bound memory note `.claude/memory/reference_sma_protocol.md` and in this
> README, not in CLAUDE.md. The SPEC's in-scope wording ("a CLAUDE.md section") is
> satisfied this way; the founder may relocate it into CLAUDE.md in a later version.

---

## CLI subcommands

`pnpm sma <status|heartbeat|session-start|pre|pre-bench|collision-check|reflex-check|`
`gates-check|airbag-check|undo|airbag|spend|spend-check|breaker|stall-check|gates-report|`
`gates-ack|gates|claim|release|next-slot|tia|consume|force-clear|preship|disposition|lint|`
`build-index|load|snapshot|upstream-check|predict-score|calibration|usage|consolidate|trim|`
`state|exec-journal|metrics|report|bench|reverify|receipt-hash|chain-tip|chain-verify|`
`pretask-pack|subagent-verify|subagent-receipts|precompact-capsule|resume|handoff|flight|`
`grill|blind-verify|evidence|integrity|skeptic|canary|nearmiss>`

Every subcommand accepts `--json` for a single-line JSON object (the statusline / hook
contract). Hook-facing subcommands (`session-start`, `pre`, `heartbeat`, `pretask-pack`,
`subagent-verify`, `precompact-capsule`, `airbag-check`, `spend-check`, `stall-check`)
ALWAYS exit 0 (fail-open, see below); direct-CLI subcommands return meaningful codes.

The V1/V2 coordination + memory core is documented in the tables below; the **V3
trust-spine** verbs (`grill`, `blind-verify`, `preship`/`disposition`, `evidence`,
`subagent-verify`/`subagent-receipts`/`pretask-pack`, `bench`, `spend`/`breaker`,
`integrity`/`skeptic`/`canary`/`nearmiss`, `resume`/`handoff`/`flight`) get their own
section: **[V3 trust-spine subcommands](#v3-trust-spine-subcommands)**.

| Subcommand | Purpose | Key flags |
|---|---|---|
| `status` | statusline/hook JSON: active sessions, collisions, next slots | `--json` |
| `heartbeat` | renew this session's lease (cadence: every 3 min) | — |
| `session-start` | register this terminal's session lease | — |
| `pre` | **the PreToolUse multiplexer (49.2-02) — ONE spawn per Edit/Write/Bash** dispatching collision → reflex → gates | — |
| `pre-bench` | SLO instrument for `pre`: full-spawn p95, spawn-count, dispatch parity | `--runs N` \| `--metric spawn-count\|parity` |
| `collision-check` | DEPRECATED single-stream alias (delegates to `pre`'s collision stream; kept for back-compat) | `--json` |
| `reflex-check` | DEPRECATED single-stream alias (reflex stream) | — |
| `gates-check` | DEPRECATED single-stream alias (gates stream) | — |
| `airbag-check` | DEPRECATED single-stream alias (airbag stream; the canonical wiring is `pre`) | — |
| `undo` | restore the newest airbag snapshot (HEAD + dirty tracked + untracked) in one action; self-snapshots first | `[--to <id>] [--dry-run] [--yes] [--json]` |
| `airbag` | airbag snapshot admin | `list` \| `prune [--keep N] [--max-age-days N]` \| `probe` \| `stats` \| `--json` |
| `claim` | claim a work scope | `<name> --globs "<glob>" --desc "<text>"` |
| `release` | release your OWN claim | `<name>` |
| `next-slot` | allocate the next migration number or release version | `migration` \| `release` |
| `force-clear` | clear a stale/foreign claim (with confirmation, P3) | `<name>` |
| `lint` | run memory-lint over the corpus | `--json` |
| `build-index` | (re)generate MEMORY.md | `--write` (DRY by default) |
| `load` | resolve a tag set into CORE + periphery notes | `--tags <csv> [--json]` |
| `snapshot` | push a bounded, allowlisted state view to the CRM cockpit | `--json` |
| `reverify` | re-run every SUMMARY receipt across the SAFE_COMMAND boundary; diff observed-vs-expected hashes; append verdicts to the `sma.receipts` ledger (49.2-03) | `--summary <path>` \| `--all` \| `--fresh-clone` \| `--count <verdict>` \| `--json` |
| `receipt-hash` | the emit path: run one allowlisted command and print the observation sha256 as the last line (paste into a SUMMARY `receipts:` block) | `<command> [--hash-stdout] [--cwd <path>]` |
| `chain-tip` | print the deterministic merged journal chain tip (pinned into the release tag) | `--json` |
| `chain-verify` | verify the tamper-evident journal chain; list breaks | `--count breaks` \| `--json` |

### Tamper-evident journal + release-tag pin (D-49.2-07)

Every `.sma/journal` line is hash-chained: `prev` = sha256 of the previous raw
line (`genesis` for the first). The whole V2 history is a legacy prev-less
PREFIX that is never retro-broken; tamper-evidence starts the moment the first
chained line lands. `chain-verify` reports any edit, deletion, or post-chain
insertion (a break is NEVER auto-repaired — append a new chain-start on top,
preserving the break).

`chain-tip` emits a deterministic merged tip; the **sma-ship release ritual
pins `SMA-Journal-Tip: <tip>`** as the final line of the annotated `V1.N` tag
(product releases follow the same convention). To audit a past release:
`git tag -n99 V1.N`, read the pinned tip, and recompute `chain-tip` against the
journal state at that commit — a mismatch is evidence of a local edit.

### Structural receipts (D-49.2-06)

A SUMMARY may carry a `receipts:` frontmatter block — machine-checkable claims
`{id, assertion, check_command, expected_sha256}` (plus optional `expected_exit`,
`hash_stdout`, `coverage_id`) layered over the V2 `coverage:` block. `reverify`
re-runs each `check_command` across the SAME `isSafeCommand` boundary as
predictions; `--fresh-clone` runs on a `git clone --no-hardlinks` so only
COMMITTED evidence counts. The RECEIPT-PROSE lint fails any 49.2+ SUMMARY whose
machine-verifiable coverage item (`human_judgment: false`) carries no receipt —
a prose-only «done» cannot pass lint.

---

## V3 trust-spine subcommands

The accountability layer (Phase 49.2). Every verb here is a deterministic script on
the same files+git substrate — no LLM in the hot path. The narrative overview, with
diagrams, lives in the root [README.md](../../README.md#the-trust-spine-process-by-process).

### Verification + consequences

| Subcommand | Purpose | Key flags / usage |
|---|---|---|
| `blind-verify` | Re-derive every «done» from the `-PLAN.md` + code tree ALONE; a SUMMARY/exec-journal on input is structurally refused (`BLIND_FORBIDDEN`). A claimed-pass / reproduced-fail divergence is the heaviest ledger event and blocks ship (D-49.2-11). | `<plan-path>` \| `--stats --metric divergence-count` \| `--json` |
| `grill` | The adversarial pre-build gate. Register a challenge, resolve it (→ registered prediction, withdrawn, or founder-accepted), gate the build, or run the budget-aware pre-push grill over `origin..main`. | `<plan-path> --challenge "promise::attack"` \| `--resolve <CH-id> --as <converted\|withdrawn\|accepted-risk> [--prediction <P-id>]` \| `--gate` \| `--land <CH-id>` \| `--pre-push [--budget N] [--name-only]` \| `--stats` |
| `preship` | The consequences gate the `sma ship` ritual calls: lists open class-A events (a class-A miss or a divergence) that BLOCK the ship. Read-only; never unblocks. | `[--count]` (numeric last line, scorer contract) \| `--selftest` \| `--json` |
| `disposition` | The ONLY way to clear a `preship` block — the founder records an explicit verdict into the append-only ledger. The agent can never call this on its own behalf. | `<eventKey> --verdict <accept\|fix-forward\|rollback> --reason "<why>" --yes` |
| `evidence` | Burden-of-proof record required before a risky op (extends the D-49-09 force-clear provenance pattern). | `<force-push\|allowlist-edit\|foreign-claim-clear> --target <…> --reason "<why>" --checked "a; b"` \| `--stats` |

```bash
# a plan promise → a registered prediction, else the build does not start
pnpm sma grill .planning/phases/12-x/12-01-PLAN.md --challenge "rejects 101st::burst at t=0 slips through"
pnpm sma grill .planning/phases/12-x/12-01-PLAN.md --resolve CH-1 --as converted --prediction PRED-03
pnpm sma grill .planning/phases/12-x/12-01-PLAN.md --gate            # blocks while any challenge is open

# blind pass — re-derives «done» from the tree; refuses the executor's own report
pnpm sma blind-verify .planning/phases/12-x/12-01-PLAN.md

# the ship gate + the founder's disposition
pnpm sma preship
pnpm sma disposition blind-divergence:sma.receipts:R-01 --verdict fix-forward --reason "regression fixed in <sha>" --yes
```

### Subagent honesty (D-49.2-10)

| Subcommand | Purpose | Key flags |
|---|---|---|
| `pretask-pack` | **`PreToolUse(Task)` hook** — injects the assembled context pack (rules digest, task-scoped lessons, active claims, the parent task slice) into a subagent: inheritance by construction. Fail-open, exits 0. | — (hook-facing) |
| `subagent-verify` | **`SubagentStop` hook** — verifies EVERY claimed file write against the real tree; a receipt lands in the shared journal, a phantom write (claimed, not on disk) is flagged deterministically. | `[--since <ts>]` \| `--json` |
| `subagent-receipts` | Report: receipt coverage, phantom-write count, PreTask pack p95. | `[--stat <name>]` \| `--json` |

**Wire the two new subagent hook events** in `.claude/settings.json`:

```json
"PreToolUse": [
  { "matcher": "Task",
    "hooks": [ { "type": "command", "command": "node scripts/sma/cli.mjs pretask-pack", "timeout": 5 } ] }
],
"SubagentStop": [
  { "hooks": [ { "type": "command", "command": "node scripts/sma/cli.mjs subagent-verify", "timeout": 5 } ] }
]
```

### Measurement — `bench` (D-49.2-01)

The 8-metric scorecard harness that shipped BEFORE the spine (no measured base, no
target). Each metric emits exactly one numeric last line (the scorer contract).

| Usage | Purpose |
|---|---|
| `bench --metric <false-done-rate\|airbag-coverage\|compaction-exam\|phantom-writes\|time-to-context-ratio\|cross-machine-drill\|self-cost\|canary-catch>` | score one scorecard metric (S1…S8) |
| `bench --freeze` / `bench --capture` | freeze / capture the V2 baseline (honored `SMA_BENCH_FORCE` for the 2026-07-08 force-freeze) |
| `bench exam --new` \| `bench exam --grade <answers> --key <key>` | the 10-question post-compaction exam (S3) |
| `bench ab …` \| `--timing` \| `--json` | A/B + timing helpers |

```bash
pnpm sma bench --metric self-cost      # S7 — measured ms-per-tool-call
pnpm sma bench --metric canary-catch   # S8 — planted-canary catch rate
```

### Integrity guards (D-49.2-14)

| Subcommand | Purpose | Usage |
|---|---|---|
| `skeptic` | Goodhart guard — a non-implementer countersigns a plan's predictions; `verify` checks the signature. | `skeptic <sign\|verify> <plan-path>` |
| `canary` | Plant/score/sweep deliberate false-«done» canaries the blind verifier must catch (S8; below 90% catch, «zero divergence» means a lazy verifier). | `canary plant <claims-path>` \| `canary score [--count-scored]` \| `canary sweep <claims-path>` |
| `integrity` | STPA disarm-path guard — every kill-switch must cite a compensating control; the birth-fixture shadow-runs while off and auto-re-arms. | `integrity <hazards\|shadow\|disarms\|disarm-renew>` \| `disarm-renew <gateId> --reason "<why>"` \| `--json` \| `--count-uncompensated` \| `--count-silent` |
| `nearmiss` | Scoring-immune near-miss channel (ASRS-style) — report what nearly went wrong without it counting against calibration. | `nearmiss "<what nearly went wrong>"` |

### Bridges — opt-in, never headlined (D-49.2-05)

Each bridge sits behind a capability probe and registers a falsifiable self-removal
prediction; it stands down the day a sufficient native equivalent ships. See the
**Pre-compaction flight recorder** section below for the capsule bridge
(`precompact-capsule` / `resume` / `handoff` / `flight`) and the **CLI subcommands**
table above for the git airbag (`undo` / `airbag`).

| Subcommand | Bridge | Key flags |
|---|---|---|
| `spend` | Deterministic spend ledger — per session/subagent/model book parsed from local logs via a versioned adapter; budget reflexes warn at 70/90%; soft-deny NEW subagents over cap; OTel/ccusage-compatible fields. | `[--by model\|session\|day\|agent]` \| `--window <hours>` \| `set-cap <usd> [--window-hours N]` \| `--stat <name>` \| `--json` |
| `spend-check` | Pre-less fallback for the spend stream (budget reflexes + loop-breaker); the canonical wiring is the `pre` multiplexer. | — (hook-facing) |
| `breaker` | Loop-breaker admin — a rule that fires runaway per the journal is disarmed until review. | `breaker <list\|re-arm <ruleId>>` |
| `resume` | Continuation brief assembled from the flight recorder alone (works after a terminal death, not only after compaction). | `--json` |
| `handoff` | Teammate brief + claim-transfer steps (`.sma/flight/handoff-<terminalId>.md`). | — |
| `flight` | Flight instruments. | `flight <probe\|determinism-check\|tail [n]>` \| `--json` |

```bash
pnpm sma spend --by session            # window totals grouped by session
pnpm sma spend set-cap 25 --window-hours 5   # a founder cap (a soft-deny needs one)
pnpm sma spend --stat bench-check-p95-ms     # the S7 self-cost scorer line
```

### Memory (pillar 1)

- `pnpm sma build-index` — DRY by default (prints the artifact); add `--write` to
  overwrite `.claude/memory/MEMORY.md`. Output is byte-deterministic: the build-anchor
  commit hash and per-file last-commit dates are injected, never read from the clock,
  so a re-build is byte-identical and lint's MEM-REGEN can byte-compare.
- `pnpm sma load --tags <a,b>` — facet intersection over TAGS.md; returns the ordered
  CORE + periphery notes. Example bug-lesson recall: `--tags bug-lesson,payload`.
- `pnpm sma lint` — see the memory-lint checks below. `--json` emits `{findings:[...]}`.

#### How notes are written (sanctioned write path, B6)

**NEVER write or edit a note under `.claude/memory/**` with an agent's Write tool.**
Claude Code's built-in auto-memory feature (`settings.json` → `autoMemoryDirectory`)
intercepts every Write-tool call to that directory and REWRITES the note into a legacy
shape: it prepends `name: ""`, moves `kind`/`tags`/`use-when`/`importance` into a nested
`metadata:` block, and injects `node_type: memory` + the session `originSessionId`. A
schema-correct flat note comes back nested and non-conformant — `MEM-SCHEMA` then fails
and the generator skips it (`MEM-ORPHAN`). This is the B6 hook↔schema conflict; it was
re-confirmed with a probe in 49.1-14 (still reproduces).

Use the sanctioned write path instead:

- **Normalization** — `node scripts/sma/migrate-frontmatter.mjs --write` (or `--only <file>`).
- **A one-off note / surgical fix** — a small `node -e` / bash `fs.writeFileSync`, or the
  `serializeNote()` path in `scripts/sma/lib/frontmatter.mjs`. Plain `fs` writes bypass the
  Write-tool interception.
- **Reflex guard (49.1-10)** — the lesson note `feedback_memory_write_via_fs_not_write_tool.md`
  carries `use-when-pattern: .claude/memory/**`, so a future Write attempt into the corpus
  WARNS with this rule (the reflex system solving its own B6).

Regenerate the index with `sma build-index --write` ONLY when the corpus is free of
broken residuals — regeneration DROPS any note it cannot parse, so a stale broken note
would silently fall out of the index.

### Coordination (pillar 2)

- `pnpm sma claim memory-flip --globs ".claude/memory/**" --desc "D-49-06 flip prep"`
- `pnpm sma release memory-flip`
- `pnpm sma next-slot migration` — the ONLY sanctioned way to pick a migration number.
- `pnpm sma next-slot release` — the ONLY sanctioned way to pick the next V1.N; re-check
  freedom immediately before deploy (`verifyReleaseStillFree`).
- `pnpm sma force-clear <name>` — clears a foreign/stale claim; requires confirmation.

---

## `.sma/` layout (D-49-05: local files are the sole coordination truth)

```
.sma/
  sessions/   # one lease file per terminal session (heartbeat renews mtime/renewTime)
  claims/     # one file per active scope/slot claim; the file name IS the lock (mkdir gate)
  journal/    # append-only event log (claim/release/warn/collision/snapshot events)
```

Slot claims (`migration-NNN`, `push-in-progress`) live under `claims/` too — the
deterministic slot name is the atomic lock (a lost race retries at N+1).

---

## Staleness tiers + TTLs (D-49-11)

Session liveness is graduated by age since the last heartbeat renew:

| Tier | Meaning | Threshold |
|---|---|---|
| `fresh` | recently renewed | age < 3 × 3 min (ATTENTION window) |
| `attention` | missed ≥3 heartbeats | age ≥ 9 min |
| `reap-clean` | past TTL+grace, claimed globs have NO fresh mtimes → auto-reapable | age > 30 min + 15 min |
| `needs-human` | reap-eligible but a claimed file changed after the last renew (DIRTY) → NEVER auto-deleted (P3) | — |

| Constant | Value |
|---|---|
| `HEARTBEAT_INTERVAL_MS` | 180000 (3 min) |
| `ATTENTION_AFTER_MISSES` | 3 |
| `SESSION_TTL_MS` | 1800000 (30 min) |
| `GRACE_MS` | 900000 (15 min) |
| `SLOT_COOLDOWN_MS` | 600000 (10 min after a slot release, B27) |
| `PUSH_CLAIM_TTL_MS` | 1800000 (30 min) |
| `JOURNAL_TAIL_FOR_SNAPSHOT` | 20 (bounded tail per snapshot) |

---

## Sorted-insert rule (B21, migration numbering)

Verbatim, printed by the CLI with every migration slot result:

> Новая запись миграции вставляется строго по числовому месту в конец массива,
> вплотную к предыдущему номеру. Так две попытки вставить один и тот же номер дают
> git-конфликт при слиянии, а не тихое дублирование записи.

Counters are compared as INTEGERS, never lexicographically (099 → 100, V1.9 → V1.10).

---

## Snapshot allowlist + env vars

The snapshot module projects ONLY a bounded, explicitly-allowlisted view of local
state toward the CRM cockpit — never an object spread of raw local state (P1). Any key
outside the allowlist is stripped defensively before send.

| Env var | Purpose |
|---|---|
| `SMA_TERMINAL_NAME` | the stable per-window human name (e.g. «Мозг»); falls back to `T-<pid>` |
| `SMA_SNAPSHOT_TOKEN` | auth token for the CRM receiver route (operator-provisioned) |
| `SMA_SNAPSHOT_URL` | receiver URL; REQUIRED alongside the token — there is no built-in default (without it the sender no-ops with reason `no-url`) |

Statusline pointer: the machine-local statusline snippet lives at
`scripts/sma/statusline-snippet.md` (added by 49-12) and edits `~/.claude/statusline.js`
to surface active sessions / collisions / next slots.

---

## Multi-terminal conventions

### Hot files (D-49-16)

`.planning/STATE.md`, `.planning/ROADMAP.md`, `.claude/memory/MEMORY.md` are
high-content and edited by many terminals. When ≥2 sessions are `fresh`, an
informational WARN («N сессий активны; файл высококонтентный; перечитайте перед
записью») rides the advisory channel EVEN WITHOUT a claim. Re-read these files
immediately before writing them. Info-tier warns are never counted in the collision
total (the statusline counts `tier: 'warn'` only).

### STATE.md blocker ownership + provenance stamp (D-49-17)

A terminal edits ONLY the `## Open Blockers` lines for its OWN phase (lines are keyed
by the literal `Phase N`). Each edited blocker line carries a provenance-lite stamp:

```
upd YYYY-MM-DD, terminal <имя>
```

A lint check for these stamps is optional in v1.5; for now it is a convention, not an
automated gate.

### Browser / Playwright (deferred slot candidate, 2026-07-02)

The machine-global browser-profile lock ("Browser is already in use" when a second
terminal launches) is NOT in the V1 slot list (V1 focus: migration / V1.N / push
signal). Workaround convention: the second terminal uses chrome-devtools
isolatedContext. It becomes a slot candidate in v1.5+ if the slot list grows.

---

## memory-lint checks (49-08)

| Check | Tier | What it enforces |
|---|---|---|
| `MEM-SCHEMA` | critical | every note has `description/kind/tags/use-when/importance` |
| `MEM-VOCAB` | critical | every tag exists in TAGS.md (closed vocab, aliases resolved) |
| `MEM-BUGLESSON` | critical | `kind: bug-lesson` notes carry `**Why:**` + `**How to apply:**` |
| `MEM-WIKILINK` | critical | every `[[name]]` resolves to a note on disk |
| `MEM-SUPERSEDE` | critical | `supersedes`/`superseded_by` targets exist (symmetric back-pointers) |
| `MEM-ORPHAN` | critical | index ↔ corpus symmetry (clears once MEMORY.md is generated) |
| `MEM-REGEN` | critical | committed MEMORY.md == a fresh regeneration (active post-flip) |
| `MEM-SECRET` | critical | screens note bodies for secret material at the corpus door (49.1-14) |
| `MEM-TAGCHAOS` | warn | near-duplicate / single-use / overbroad tags |
| `MEM-CLAUDEDUP` | warn | a memory note duplicating a CLAUDE.md rule verbatim |

**Never weaken a check, its allowlist, or a fixture to make the scan pass** — fix the
corpus or escalate (same ethic as the security-regression guard).

---

## Hook wiring (PreToolUse — the `sma pre` multiplexer, 49.2-02)

The canonical PreToolUse wiring is **ONE** spawn per tool call — the `pre` multiplexer,
which reads the hook event once and dispatches the ordered internal stream pipeline
(collision → reflex → gates). Put this single entry in your `.claude/settings.json`:

```json
"PreToolUse": [
  { "matcher": "Edit|Write|Bash",
    "hooks": [ { "type": "command", "command": "node scripts/sma/cli.mjs pre", "timeout": 5 } ] }
]
```

`collision-check` / `reflex-check` / `gates-check` remain as DEPRECATED single-stream
aliases (they delegate to the same stream objects `pre` uses, so behavior is identical)
for any external wiring that still calls them — but new installs wire only `pre`.

**Kill-switches (fail-open, carried forward):**

| Env var | Effect |
|---|---|
| `SMA_PRE_DISABLE=1` | instant no-op — `pre` runs NO stream (global off switch) |
| `SMA_REFLEX_DISABLE=1` | skip ONLY the reflex stream (collision + gates still run) |
| `SMA_GATES_DISABLE=1` | skip ONLY the gates stream (also skips the HEAD-sha git probe) |
| `SMA_PRE_BUDGET_MS=<n>` | soft time-budget (default 1500 ms); once a call exceeds it, remaining streams are SKIPPED, never overrun |

**The `PRE_CHECKS` stream contract (for downstream stream authors — plans 05/09):**
`lib/pre.mjs` exports an ordered array `PRE_CHECKS` of stream objects
`{ id, tools, killSwitchEnv, mayDeny, run(ctx) -> { warns: string[], deny?: {text} } }`.
To add a stream, append ONE object literal to that array — there is no dynamic
registration API; consolidation is structural and the one-spawn guarantee holds by
construction. Only a `mayDeny:true` stream (today: `gates`) can surface a `deny`; a
`deny` returned by any other stream is downgraded to a warn line (posture protection).
`pre-bench --metric parity` re-verifies merged-vs-single-stream parity after any change.

## Pre-compaction flight recorder (49.2-06, D-49.2-09)

Auto-compaction silently deletes a session's working state. The flight recorder makes
that moment survivable with **pure file assembly** — zero LLM, zero network, zero
child_process anywhere in the path (PreCompact fires at the worst possible moment to
spend tokens). It generalizes the V2 per-executor exec-journal to ALL sessions.

- **`precompact-capsule`** (the NEW `PreCompact` hook): deterministically assembles a
  capsule from the journal tail + claims + exec-journal + STATE slices and writes
  `.sma/flight/intent.md` + `.sma/flight/capsules/<terminalId>.md` BEFORE compaction.
- **Restore reflex**: the EXISTING `session-start` hook detects stdin `source: "compact"`
  and re-injects the capsule as the FIRST `additionalContext` part — the session resumes
  knowing its task, constraints, and recent decisions. NO new hook spawn for restore.
- **`resume` / `handoff`**: `pnpm sma resume` assembles a continuation brief from the
  flight recorder alone (works after a terminal death, not only after compaction);
  `pnpm sma handoff` writes a teammate brief (`.sma/flight/handoff-<terminalId>.md`) with
  claim-transfer steps.
- **Flight marks**: every PostToolUse appends one mark via the EXISTING `stall-check`
  spawn (zero new per-tool-call process) to `.sma/flight/marks/<terminalId>.jsonl`.

**Wire it — add ONE new hook event** (`session-start` already carries the restore branch):

```json
"PreCompact": [
  { "hooks": [ { "type": "command", "command": "node scripts/sma/cli.mjs precompact-capsule", "timeout": 10 } ] }
]
```

**gitignore stanza (DEC-49.2-06-01):** capsules + briefs are git-TRACKED (vendor-proof
durability) after an unconditional secret-scan; the high-churn per-tool-call marks stay
local runtime. After the existing `.sma/*` + `!.sma/README.md` lines add:

```gitignore
!.sma/flight/
.sma/flight/marks/
```

**Secret scan (unconditional, T-49.2-06A):** `writeCapsule` and `writeHandoff` route
every line through `scanForSecrets` before touching a tracked path — an AWS key, a
`-----BEGIN … PRIVATE KEY-----` header, a `Bearer …`/`sk-…` token, or a `secret=`/
`password=` assignment is redacted to `[redacted:<rule>]`, even under kill-switch or probe
stand-down. Bash marks record a command SLUG only, never the full arg line.

**Kill-switch / probe:**

| Env var | Effect |
|---|---|
| `SMA_FLIGHT_DISABLE=1` | instant no-op — no capsule write, no restore injection, no mark append. **Compensating control (D-49.2-14):** the V2 exec-journal resume ritual still reconstructs the resume point from `.sma/exec/*.jsonl`. |
| `SMA_FLIGHT_NATIVE=1` | the capability probe reports native — the whole bridge STANDS DOWN (writeCapsule → `{skipped:'native'}`). This is the D-49.2-05 demolition-clause seam: the day the vendor ships a sufficient native pre-compaction preservation mechanism, this stream retires. |

**Bridge posture (D-49.2-05):** the flight recorder is a BRIDGE, not a headline. It is
probe-gated, registers a falsifiable prediction of its own removal (P49.2-06-03), and is
never positioned as a defensible feature — the accountability layer is the core, this is
a bridge that retires when a sufficient native equivalent arrives.

## Fail-open contract (P3 / P4 / P5)

- **P3 — foreign claims are never auto-cleared.** A stale foreign claim is flagged
  `needsHuman`, never silently removed; force-clear is an interactive, confirmed action.
- **P4 — hooks never block the session.** Hook-facing subcommands swallow all errors
  and exit 0. A broken SMA layer degrades to "no advisory", never to a stuck session.
- **P5 — the deploy operation stays founder-reserved.** SMA issues ONLY read-only git
  subcommands (fetch/show/tag/rev-parse/log). It NEVER runs the push/deploy operation;
  the release slot advises the next V1.N, a human performs the deploy.
