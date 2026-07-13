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
`build-index|emit|load|snapshot|upstream-check|predict-score|calibration|usage|consolidate|trim|`
`state|exec-journal|metrics|report|bench|reverify|receipt-hash|chain-tip|chain-verify|`
`pretask-pack|subagent-verify|subagent-receipts|precompact-capsule|resume|handoff|flight|`
`grill|blind-verify|evidence|integrity|skeptic|canary|nearmiss|passport|model|excavate|manifest|`
`worktree|merge|explain|doc-audit|deleteme|memory-preview|vendor>`

The v3.6 surfaces:

| Subcommand | Purpose | Key flags |
|---|---|---|
| `deleteme` | One-click uninstall (BL-162): reverses every installer artifact — engine, runtime, agents, skills, hooks, statusline, managed blocks, `.sma/` — and PRESERVES `.claude/memory/**`. Dry-run by default; never-clobber settings surgery; a torn anchor pair is refused, never repaired. Direct CLI, not hook-facing. | `--yes` \| `--global` \| `--selftest` \| `--json` |
| `memory-preview` | Onboarding memory-graph preview (BL-174): an ASCII graph of how SMA will lay out THIS repo's memory — CORE / periphery areas from `git ls-files` / reflex candidates from excavate's history mining. Read-only, zero network, byte-deterministic at one HEAD; an empty repo degrades to the fresh-project layout. Rendered during /sma-start TEACH. | `--project <path>` \| `--lang en\|ru` \| `--json` \| `--selftest` |

The V4 maintainer-process surface:

| Subcommand | Purpose | Key flags |
|---|---|---|
| `vendor` | Anthropic capability ledger linter (49.4-01, BL-160): parses `docs/VENDOR-LEDGER.md`, fails rows missing a verdict or disposition; `--count untriaged` prints the bare number as a last line (scorer contract) that the `/sma-ship` gate blocks on; `--selftest` proves the linter against a fixture pair. Read-only, zero network, never writes a verdict. NOT hook-facing. | `[--count untriaged]` \| `--selftest` \| `--json` |
| `memory` | Deterministic corpus token-cost report (49.4-06, BL-176): `memory stats` prices the MEMORY.md core load, every note, every INDEX file, and the top-N heaviest with a VERSIONED estimator (`ESTIMATOR_VERSION` stamped, approximation not billing truth); `--stat core-tokens\|corpus-tokens` prints the bare number (scorer contract); `--selftest` proves determinism. Compress is deliberately absent — deferred until stats shows measured pain. NOT hook-facing. | `stats [--top N]` \| `--stat core-tokens\|corpus-tokens` \| `--selftest` \| `--json` |
| `ship-lane` | The ship lanes (49.4-08, BL-177): a DETERMINISTIC quick-ship precondition (`check` — origin-delta <= 5 commits AND no migrations AND no foreign push-claim, else refuses «this is a full /sma-ship» naming every failing leg), a deterministic conventional-commit changelog drafter (`changelog`, the full lane consumes it too), and a lane-outcome ledger (`record`/`report`, pending runs listed first + >24h orphaned-watch flag). `--stat quick-active-p50-min\|quick-red-minus-full-red-pct` prints the bare number (scorer contract); `--selftest` proves the fixture pack. READ-ONLY — never pushes, tags, or deploys. NOT hook-facing. | `check [--base <b>] [--max-delta N]` \| `changelog [--base <b>]` \| `record --lane quick\|full --outcome green\|red\|pending --started <iso> [--ended <iso>]` \| `report` \| `--stat <name>` \| `--selftest` \| `--json` |

The V3.5 docs / teaching surfaces:

| Subcommand | Purpose | Key flags |
|---|---|---|
| `explain` | In-product explainer for any concept or command; an unknown topic lists the catalog and exits 0. `--coverage` prints the count of HANDLERS keys with no explainer as a bare last line (P49.3-09-A scorer). Reads `cli.mjs` as text, never imports it. NOT hook-facing. | `[topic]` \| `--list` \| `--coverage [--count]` \| `--lang en\|ru` \| `--json` |
| `doc-audit` | Deterministic honesty audit over the manual (`sma:v35` region) + README positioning (`sma:positioning` region): surface coverage, footer freshness, analog honesty, multiplier ban, RU em-dash ban. `--count` prints the bare total as a last line (P49.3-09-B/C scorer). Read-only, injected `readFile`. NOT hook-facing. | `--target manual\|readme\|all` \| `--count` \| `--json` |
| `profile` | Deterministic reader/validator/recap for `.sma/profile.json` (49.3-01) plus the BL-167 quick-update path (49.4-04): `--quick` prints the interview plan of ONLY the unset schema fields, in askStage order, with zero teaching (`--count` prints the bare number as a last line, the scorer contract); `--selftest` proves the planner against a fixture pair (prints 1/0); `--profile <path>` targets a specific profile.json for any mode. Also `--lint` / `--coverage` / `--recap`. Read-only planning; the write still flows through /sma-start + validateProfile. NOT hook-facing. | `--quick [--count]` \| `--selftest` \| `--profile <path>` \| `--lint` \| `--coverage` \| `--recap` \| `--json` |

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
| `reverify` | re-run every SUMMARY receipt across the SAFE_COMMAND boundary; diff observed-vs-expected hashes; append verdicts to the `sma.receipts` ledger (49.2-03). The footprint receipt (49.4-07) compares a plan's frontmatter `footprint:` claim against `git diff --numstat` actuals — an overrun is a scored `sma.economy` miss | `--summary <path>` \| `--all` \| `--fresh-clone` \| `--count <verdict>` \| `--footprint <plan>` \| `--footprint-selftest` \| `--footprint-overruns` \| `--json` |
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
| `grill` | The adversarial pre-build gate. Register a challenge, resolve it (→ registered prediction, withdrawn, or founder-accepted), gate the build, or run the budget-aware pre-push grill over `origin..main`. | `<plan-path> --challenge "promise::attack"` \| `--resolve <CH-id> --as <converted\|withdrawn\|accepted-risk> [--prediction <P-id>]` \| `--gate` \| `--standing` \| `--standing-selftest` \| `--land <CH-id>` \| `--pre-push [--budget N] [--name-only]` \| `--stats` |
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

### Calibration passport + public badge (D-49.3-10)

The passport is the public trust-telemetry surface: one deterministic script over
the calibration ledger + the reverify receipts writes `PASSPORT.md` (with an
embedded machine snapshot) and a managed README badge block. The badge is a **pure
function of the committed snapshot** — never the live ledger — so the two cannot
silently disagree. A Claude-model change raises a stale-priors flag and **hides**
the hit-rate claim until `BADGE_MIN_N` (20) fresh hit/miss verdicts accrue under the
new model. No LLM, no network: the shields.io URL is a string the viewer's browser
resolves; the build never fetches.

| Subcommand | Purpose | Usage |
|---|---|---|
| `passport` | Build / verify / read the calibration passport + README badge. | `passport --build` \| `passport --verify` \| `passport --check-badge` \| `passport --json` |
| `model` | Model-version guard surface — sighting timeline, current model, guard state. | `model --json` \| `model --count sightings` \| `model --set <id>` |
| `calibration` | Per-domain hit-rate table + low-calibration escalation list. Grade the grader (49.4-02): any separate-context LLM verdict is itself a prediction, scored against deterministic ground truth (revert / rework / red CI / founder rejection) and sliced by judge model; a contradicted «satisfied» is a class-A ship-blocker. | `[--domain <d>]` \| `--json` \| `--grader` (+ `--stat recorded-verdicts`, numeric last line) \| `--grader-record --plan <id> --verdict <satisfied\|unsatisfied> --source <blind-verify\|verifier\|vendor> [--horizon <spec>]` \| `--grader-selftest` (1/0, scorer contract) |

- `passport --build` — rebuild `PASSPORT.md` + the README badge from the live ledger.
- `passport --verify` — clone the repo into a throwaway dir and re-derive the passport
  + badge from the **committed** embedded snapshot; prints `1` (byte-identical) or `0`
  as the last line, always exit 0. This proves render determinism, not ledger
  truthfulness (that is owned by the canary + 5% audit, 49.2-10).
- `passport --check-badge` — the live README badge equals `renderBadgeBlock(committed snapshot)`; `1`/`0` last line.
- `passport --json` — the committed snapshot as canonical JSON (the read surface for the statusline / PR passport / docs).
- `model --set <id>` — record a manual sighting (source `manual`) when the harness exposes no model id.

**Reproduce it yourself (a stranger, zero trust):**

```bash
git clone <this-repo> sma-check && cd sma-check
node scripts/sma/cli.mjs passport --verify   # prints 1 -> the published numbers re-derive byte-identically
```

### PR evidence passport — `sma manifest` (D-49.3-11)

The passport a reviewer meets a pull request with: `sma manifest` deterministically
assembles an evidence pack from the Track A artifacts — which predictions were
registered and how they scored, a receipt per claim, the blind-verify verdict, token
spend, per-area hit rate, plus the journal `chainTip` and the stale-priors guard state
as the audit-trail footer. It is a **reader**, never a second grader: every number is
READ from a calibration-ledger record, a frozen `.sma/blind/<planId>.json`, or the
spend book — `manifest.mjs` computes zero new verdicts and takes NO command runner or
network seam at all (the blind-verify barrier idiom, applied to assembly).

| verb | what it does | modes |
|---|---|---|
| `manifest` | Assemble + render the PR evidence passport; write `.sma/manifest/<headSha>.{json,md}`. Reader-only, fail-open, no network. | `--range <a>..<b>` \| `--json` \| `--md` \| `--stat <name>` |

- default range `origin/main..HEAD` (override with `--range`); the CLI derives the
  changed files from a read-only `git diff --name-only`, scans `.planning/phases/**`
  for the plan index, and selects the in-range plans.
- `--json` / `--md` print the canonical JSON / the markdown (the markdown's FIRST line
  is the managed-comment marker `<!-- sma-manifest:v1 -->` — the CI upsert key).
- `--stat determinism|prediction-coverage|bench-build-ms` — each prints a single numeric
  last line and exits 0 (the scorer measurement surface): `determinism` byte-compares two
  builds under one pinned `now` (`1`/`0`), `prediction-coverage` is the % of registered
  predictions present (loss-detectable), `bench-build-ms` is the p95 build cost.

Determinism is the substrate law: same tree + same `.sma` state + same injected `now`
yields a byte-identical manifest, so the audit trail is trustworthy. The `sma-ship`
ritual attaches the passport as ONE upserted PR comment and pins its sha256 as
`SMA-Manifest:` in the annotated `V1.N` tag; a CI terminal
(`.github/workflows/sma-manifest.yml`) builds + upserts the same comment on
`pull_request` and evaluates predictions at merge through the shipped `predict-score`
engine (objective re-run of commands, never an LLM judge). Nothing here can block a
merge, wedge CI, or stop a ship — observation is its job; the LAW (`sma preship`) keeps
the gating.

```bash
node scripts/sma/cli.mjs manifest --md                 # render the passport (marker on line 1)
node scripts/sma/cli.mjs manifest --stat determinism   # prints 1 -> the pack re-derives byte-identically
```

### Excavate — day-one value (D-49.3-09)

The adoption wedge: point `excavate` at ANY repository and it mines that repo's own
git history for prevented-loss evidence, then prints CATCHES — «this reflex would
have fired before this push, here». A newcomer sees a concrete loss the system would
have caught, in the first five minutes, before changing a single habit.

```bash
node scripts/sma/cli.mjs excavate            # mine the current repo, print CATCHES
node scripts/sma/cli.mjs excavate ../other   # mine another repo (read-only)
node scripts/sma/cli.mjs excavate --write-drafts   # also write reviewable lesson drafts
```

**What it mines (three evidence classes):**

- **commit ↔ revert pairs** — the git-standard «This reverts commit `<sha>`» (and a
  `Revert "<subject>"` fallback): a change that had to be undone.
- **typo / oops fix chains** — a same-author, fix-ish follow-up (`typo`/`oops`/`fixup`/
  `forgot`/`missed`) on a shared file inside a 48h window.
- **red-CI fix-forward chains** — a `fix` + `ci`/`build`/`test`/`lint`/`type`/`compile`/
  `pipeline` follow-up that shares a file with, or names, an earlier commit. There is
  **no network**, so real CI state is never observed — this class is INFERRED from the
  fix-forward evidence in the history itself, and is labeled as a proxy, not a fact.

**The contract (why it is safe to run on a stranger's repo):**

- **Read-only git.** The only git subcommands are `log`, `rev-parse`, `remote get-url`,
  each run via an argument-array runner with the shell disabled. A hostile commit
  subject/body/path is DATA end to end — never executed, eval'd, or shell-interpolated.
- **No network, no LLM.** Deterministic history mining only.
- **Deterministic.** Same repo at the same HEAD → identical output (evidence strength,
  then author date, then sha). `excavate --stats --metric determinism` prints `1` on demand.
- **Honest links.** A recognized origin (github/gitlab/bitbucket) yields a real commit
  URL; an unrecognized remote prints the short sha with NO fabricated link.

**Approved catches → the corpus (through the one existing gate):** `--write-drafts`
writes each catch as a `bug-lesson` draft under `.claude/memory/drafts/` (idempotent,
never auto-committed, mined text confined to a fenced untrusted block). Promotion is
the SAME 3-condition human/agent-reviewed gate every drafted lesson uses — move the
file OUT of `drafts/` into `.claude/memory/` once (1) a verified fix exists, (2) the
failure is named, (3) the dead-end is ruled out. A promoted excavate lesson carries a
`use-when-pattern` precision glob so the shipped V2 reflex consumer fires on the
incident class, and an `excavated_from: <repoLabel>@<sha7>` provenance back-link.

**Instruments (`--stats --metric <m>`, numeric last line):**

| metric | prints | prediction |
|---|---|---|
| `approved-lessons` | count of corpus notes carrying `excavated_from` (fresh install: `0`) | P49.3-03-A |
| `firing-ready-pct` | integer % of those notes that replay firing-ready (no notes: `0`) | P49.3-03-B |
| `determinism` | `1` when two mineRepo runs on the current repo are serialized-equal, else `0` | P49.3-03-C |

`excavate` is a direct CLI command — it is **not** hook-facing and never rides `sma pre`,
so it cannot touch the V3 self-cost envelope; its failures exit `1` honestly.

### Pre-dispatch: `sma preflight` (D-49.3-17)

The already-built gate. Before an executor is dispatched for a plan, `preflight` asks
one question of the **real code tree**: is this plan already built? It parses the plan's
`must_haves` (artifact paths + `contains` needles) with 49.2-01's own bench parser,
checks them against the tree, and returns exactly one verdict — **built / partial /
absent → skip / reconcile-only / execute**. Deterministic, read-only, **zero LLM
tokens**. It mechanizes the house verify-before-execute HARD RULE (the 23-02 incident,
where a parallel terminal had already committed the plan's code and a re-execute would
have clobbered it) so no tokens are spent re-building work the tree already carries.

```sh
sma preflight <plan>                 # human summary: verdict + per-artifact table
sma preflight <plan> --json          # the full result object
sma preflight <plan> --count         # the verdict CODE as the LAST stdout line
sma preflight <plan> --run-verify    # ALSO run allowlisted verify commands (opt-in)
sma preflight --selftest             # built/partial/absent fixtures, twice → prints 1
```

**Verdict codes** (also the process exit code, so a shell gate can branch on `$?`):

| code | verdict | meaning | dispatch |
|---|---|---|---|
| `0` | `built` | every artifact exists AND every needle is present | **skip** |
| `1` | `partial` | some artifacts present, at least one divergent | **reconcile-only** (hands the divergent set to blind-verify) |
| `2` | `absent` | nothing satisfied, OR any parse/read error (fail-open) | **execute** |

**Safety boundary.** The default path spawns **nothing** — a `contains` needle is a
read-only `String.includes` over the file bytes; mined/plan content is never executed. A
verify command runs **only** when it is BOTH `isSafeCommand`-allowlisted (predict.mjs's
`node scripts/sma/` / `pnpm vitest run` / `pnpm sma` prefixes, no shell metacharacters)
AND the operator passed `--run-verify`; a non-allowlisted command is reported
`skipped-unsafe`, never run. A false `built` is the one forbidden failure — any doubt
lands `partial` or the conservative `absent` (execute), never a skip of real work.

**Consume-never-reimplement (D-49.3-02):** bench.mjs parses, predict.mjs gates commands,
blind-verify.mjs reconciles — `preflight` composes, it writes no second frontmatter
parser, allowlist, or tree-comparison engine.

**Integration recipe** — `/sma-execute-phase` gates each plan before spawning an
executor, and 49.3-12 `/sma-batch` runs it on every item first (D-49.3-19). Both invoke
it across the CLI boundary and branch on the exit code:

```sh
node scripts/sma/cli.mjs preflight "$PLAN" --count
case $? in
  0) echo "already built → skip" ;;
  1) echo "partial → reconcile-only (blind-verify the divergent set)" ;;
  *) echo "absent → dispatch executor" ;;
esac
```

`preflight` is a direct CLI command — **not** hook-facing (it may exit nonzero), never
rides `sma pre`, so it cannot touch the V3 self-cost envelope.

### Benchmark arena: `sma arena` (D-49.3-18, BL-142)

The **«why to trust us»** asset. The calibration passport (above) proves SMA is honest on
**our** repo; the arena proves the adoption claim against **named rivals on neutral
ground**. It hardens the founder-run n=1 pilot into a reproducible **n≥4 four-arm
comparison** — vanilla Claude Code / GSD only / Superpowers only / SMA — over a **fixed
ticket set on a public repo**, scored **fully deterministically**: git-diff LOC (M4),
acceptance-test pass count (M1 first-done, M2 rounds-to-green), tokens+cost (M3) via the
**49.2-09 spend-adapter** (the sole cost source, D-49.3-02), plus a **separate adversarial
safety tier** (M7).

**The tested claim is cost-per-RESULT, not cost-per-task.** The headline is M1
(done-right-first-time) + M2 (rework rounds). M3 (raw tokens/$) is **reported but never
the headline and never the sort key**. Where SMA is the most expensive *per task*, its row
is **published as-is** — suppressing a negative result is the exact self-grading dishonesty
V3 exists to kill. The `suppressed` guard is empty **by construction**; no arm is ever
dropped for looking bad.

```sh
sma arena report <records.json> [--out <html>]   # static graphs page (sma report posture)
sma arena report <records.json> --json           # the aggregate object instead
sma arena --selftest                              # deterministic re-score+re-render → prints 1
sma arena --selftest-negative                     # SMA's expensive row survives, ranked by result → prints 1
```

**How to reproduce** — the harness runs **outside this repo**, in throwaway per-arm clones
with a per-arm `CLAUDE_CONFIG_DIR` (so the machine's global skills cannot leak into the
vanilla arm). The full four-arm setup, the isolation check, the git-clone-by-tag SMA
install, the identical prompt, the attempt budget, the run order, and the M3 collection
recipe (`SMA_SPEND_LOGS_DIR=<arm-cfg>/... sma spend`) are frozen **before the first run**
in `49.3-11-ARENA-RUNBOOK.md` + `49.3-11-ARENA-SCORING.md`. The operator collects per-arm
records, runs `arena report`, and the static page **rebuilds from the raw records** — an
outsider can catch a doctored figure, and the negatives are on the page.

The scorer is **pure** (no wall-clock, no randomness in any aggregate or the rendered
report body — the footer timestamp is the sole dated field), imports **no LLM / network /
child_process** on the score path, and is a direct CLI command — **not** hook-facing.

### Three lanes: fix / batch / phase — `sma batch` (D-49.3-19, BL-149)

There are now **three** ways to move work, and the lane is picked by the task, not by habit:

| Lane | When | Ceremony | Receipts |
|---|---|---|---|
| **`/sma-fix`** (inline) | ONE change to existing code — a bug, a copy tweak, a small logic fix; no new route/collection/migration/agent | inline in the session, no subagents, targeted tests only | none required |
| **`/sma-batch`** (middle) | 2-4 backlog items that are not small but do not warrant a phase — same area, size S/M, non-overlapping files | grill-lite per item (must_haves + ONE falsifiable check, **no** research/plan-checker/discuss), ONE executor with an atomic commit per item, ONE batch note | **mandatory** — every item is `sma reverify`-blind-reverified before its backlog box flips |
| **full phase** | a new route / page / CRM surface / collection / migration / AI agent / cron / webhook / external integration, or genuine multi-wave work | discuss → plan → grill → execute → verify, wave-parallel subagents | full receipts + consequences ledger |

`/sma-batch` is the founder's gap-filler (D-49.3-19, verbatim: «tasks which are not small,
but not phase oriented … 2-3-4 backlog items»). It fills the gap **without dropping the
accountability floor**: «light» means fewer AGENTS, never fewer RECEIPTS.

```sh
sma batch <BL-ids...>          # select 2-4 named backlog items, risk-filter, prepare the ordered run
sma batch --assemble          # auto-pick a compatible set (same area, S/M, non-overlapping files)
sma batch ... --json          # the prepared batch object (ordered items + guard status)
sma batch --selftest-riskfilter  # classify a bundled fixture set → prints 1 (P49.3-12-A)
sma batch --selftest-checkoff    # surgical single-line [ ]→[x] over a fixture → prints 1 (P49.3-12-C)
```

**The two hard guards** (both deterministic, `batch.mjs`):

- **RISK FILTER** — anything phase-class (a new collection / migration / webhook / AI agent
  / cron / new route or surface) is **rejected up front** with **«this is a phase»**, naming
  the offending id. A batch silently doing phase-class work would bypass discuss+plan+grill —
  the exact guardrail this lane exists to enforce. This is the **boundary that forces a phase.**
- **EJECT rule** — an item that **grows past batch-class mid-run** is thrown back to the
  backlog with a note («grew past batch-class — replan as a phase») and the batch **continues**
  with the remaining items; it never aborts.

**Order per item** (every stage a call to an existing verb, D-49.3-02): `preflight` (49.3-10,
already-built guard) → **grill-lite** (grill.mjs's `grillGate`, a lighter registration of the
SAME gate) → ONE executor (atomic commit, targeted tests) → **`sma reverify`** (49.2-03, the
mandatory receipt) → `checkOffBacklogItem` (the ONE new markdown writer — flips exactly the
matched `[ ]`→`[x]` line). An item is checked off **only** on a clean reverify receipt; a
divergent receipt records a failed item and leaves the box `[ ]`. Output = checked-off BL items
+ **one batch note**, never a phase folder.

**Consume-never-reimplement (D-49.3-02):** `batch.mjs` writes no second backlog parser, no
second challenge ledger, no second reverifier, no second preflight — parse-backlog.ts reads,
grill.mjs gates, `sma reverify` verifies, `sma preflight` guards. `batch` is a direct CLI
command — **not** hook-facing (it may exit nonzero).

### Bridges — opt-in, never headlined (D-49.2-05)

Each bridge sits behind a capability probe and registers a falsifiable self-removal
prediction; it stands down the day a sufficient native equivalent ships. See the
**Pre-compaction flight recorder** section below for the capsule bridge
(`precompact-capsule` / `resume` / `handoff` / `flight`) and the **CLI subcommands**
table above for the git airbag (`undo` / `airbag`).

| Subcommand | Bridge | Key flags |
|---|---|---|
| `spend` | Deterministic spend ledger — per session/subagent/model book parsed from local logs via a versioned adapter; budget reflexes warn at 70/90%; soft-deny NEW subagents over cap; OTel/ccusage-compatible fields. Plus the 49.4-06 economy meters: `lane open\|close\|report\|derive` (per-lane fix/quick/batch/build budgets from OUR own p75 percentiles; overrun = scored calibration miss + drafted lesson; overlap-flagged runs excluded) and `self-cost` (SMA's own static per-session injection overhead). | `[--by model\|session\|day\|agent]` \| `--window <hours>` \| `set-cap <usd> [--window-hours N]` \| `lane open\|close\|report\|derive` \| `self-cost` \| `--selftest` \| `--stat <name>` \| `--json` |
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

#### `sma emit` — one corpus, any agent (D-49.3-08)

`pnpm sma emit` compiles the learned memory corpus into a **managed export block**
inside each of `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `GEMINI.md`, every block
under a per-format byte budget (`EMIT_BUDGETS`: 8 KiB / 8 KiB / 6 KiB / 8 KiB).
Selection is deterministic — the SAME importance-ordered comparator MEMORY.md and the
loader share (importance desc → last-commit-date desc → name asc), filled as a strict
priority prefix until the budget is reached. Portability = anti-lock-in: the corpus
stays the single source, and even a non-Claude-Code tool reads the same learned rules.

The **managed-block law** (three bullets):

- **create / append / replace** — an absent file is created holding only the block; a
  file with no block gets the block appended (every pre-existing byte unchanged); a
  file already carrying a block has exactly its `BEGIN..END` span replaced. Bytes
  outside the span are always byte-identical before and after.
- **corrupt = refuse** — a file whose anchor pair is broken (BEGIN without END, END
  before BEGIN, a duplicate BEGIN) is NEVER written; that format reports
  `skipped-corrupt` and the file stays untouched. User content is never destroyed to
  make emit succeed.
- **regenerate, never hand-edit inside** — the block is machine-generated from the
  corpus; editing inside it is overwritten on the next emit. emit performs git READ
  ops only and NEVER commits or pushes — the output is a reviewable working-tree diff.

`pnpm sma emit --check` writes nothing and prints machine-countable
drift / over-budget / corrupt / missing counts; `--count <drift|over-budget|corrupt|missing>`
prints the bare number as the last line (the prediction-scorer contract). The re-emit is
idempotent: at the same commit over an already-emitted tree it reports `unchanged` for
every format and performs zero writes.

**Workflow:** run `pnpm sma emit` after the corpus changes (a consolidation or a
`build-index`) so `pnpm sma emit --check --count drift` stays at zero.

**The installer's sibling block (v3.6, BL-165):** `npx sma-framework init` embeds a
SECOND managed block — the SMA operating rules — into the project's CLAUDE.md via
`lib/claude-embed.mjs`: the same splice law (create/append/replace/unchanged/
corrupt=refuse), its OWN anchor family (`SMA:RULES`), so the corpus block and the
rules block never fight over one span. `deleteme` removes both.

```
pnpm sma emit                       # write the managed blocks (reviewable diff)
pnpm sma emit --check               # counts only, writes nothing
pnpm sma emit --check --count drift # the bare drift number (scorer contract)
pnpm sma emit --formats claude,gemini --target-dir ./somewhere
```

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

## Search rule: catalog before grep (49.3-05, D-49.3-06/07)

Every git-tracked repo file gets ONE deterministic one-line **card** — path, language
class, key symbols, import targets, git stats (last-commit ISO + commit count), size — and
**nothing derived by an LLM** (the meaning-string is CUT per D-49.3-06). A card is a pure
function of (file bytes, injected git data): same input → the same card, byte-for-byte. The
catalog lives in the gitignored `.sma/catalog/cards.jsonl` (rebuildable anywhere, committed
nowhere) and refreshes ON COMMIT with zero new spawns (the `context` PreToolUse stream
re-cards only the changed files when HEAD moves past the catalog's commit).

**The rule — FIRST the catalog, THEN grep:**

1. `pnpm sma catalog find "<query>"` — deterministically-ranked cards (whole-token match
   count desc → last-commit desc → path asc). This answers «which file declares/​imports X»
   from symbols + import specifiers + git stats.
2. `grep` **only** for what a card cannot answer — string literals, values, comment text.
   Card fields are identifiers + imports + git stats **by design** (a card is safe to show
   anywhere the path itself is safe; secrets live in file bodies, which the catalog never
   copies).

```bash
pnpm sma catalog refresh --full     # build/rebuild every card (explicit; the stream keeps it fresh on commit)
pnpm sma catalog find "webhook handler"
pnpm sma catalog --check --count    # drift count: 0 clean, -1 = never built (honest not-built sentinel)
```

### `sma context "<task>"` — the deterministic budgeted pack

`sma context "<task>"` assembles a MINIMAL task pack — catalog cards + inline fragments +
note pointers — under `PACK_BUDGET` (16 KB) with a `MANIFEST.json`. **Same input (normalized
task + commit + corpus + catalog) → byte-identical `PACK.md` + `MANIFEST.json`** — no
wall-clock, no locale, no machine identity, no randomness in the pack bytes (determinism is
what makes pack purity falsifiable, D-49.3-07). The manifest carries the pack's OWN prediction
(«the session touches no file outside `files[]`»), which is what makes purity auto-checkable.

```bash
pnpm sma context "wire the crm inbox webhook"   # compile → .sma/context/packs/<packId>/{PACK.md,MANIFEST.json} + active.json
pnpm sma context score --count                  # purity % of settled packs (-1 until >= 5 settle); ALSO grows the exam
pnpm sma context miss "<query>" --expected <path>   # record a «not found in time» case by hand
pnpm sma context exam --count                   # replay every exam question through the compiler → failure count
pnpm sma context --selftest                     # double-compile the committed fixture in-process → prints 1 (deterministic)
```

Work → `context score` closes the loop: every settled pack's out-of-pack touches AUTOMATICALLY
become new exam questions (a context miss becomes a standing question, never a shrug).

> **Touched-not-read honesty.** Purity measures Edit/Write/Bash **touches** (the deterministic
> observable) as the v1 proxy for «read» — hooking Read would add a spawn per file read and blow
> the 49.2-02 hook envelope. Timestamps live ONLY in the touch/exam `.jsonl` journals, never in
> the regenerable `PACK.md` / `MANIFEST.json` bytes.

### Fragments — one fact, one file, a trigger

Knowledge is stored as **atomic fragments**: one fact = one `.md` file under
`.claude/memory/fragments/` (a subdirectory so the note pipeline never indexes them), body
**≤ 400 UTF-8 bytes** (`FRAGMENT_BUDGET`), with a **required parseable trigger**. The
citation journal now scores the usefulness of each FACT (every delivered/​packed fragment id
rides `recordCitation`, kind `fire` at the act / `load` in a pack).

```markdown
---
id: payload-relationship-fk       # id MUST equal the filename stem
trigger: path:src/payload/**      # path:<glob> | tag:<tag> | cmd:<substring>
tags: [payload, crm]
source: feedback_payload_relationship_column_naming.md
---
A Payload single relationship field is stored as an inline FK column `<field>_id`.
```

`pnpm sma lint` enforces the fragment corpus in the SAME run that guards notes:
**FRAG-SCHEMA** (frontmatter + `id == filename stem`), **FRAG-BYTES** (body ≤ 400 bytes), and
**FRAG-TRIGGER** (a parseable trigger). A missing/empty `fragments/` dir is a valid state.

The `context` PreToolUse stream delivers trigger-matched fragments as WARN-context AT the
matching Edit/Write/Bash event (capped at 2, session-fatigued via the shared seen-store). It
is a **strict no-op** until you opt in by building a catalog / adding a fragment / compiling a
pack — installing SMA changes nothing until then. Kill-switch: **`SMA_CONTEXT_DISABLE`**.

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

### Per-terminal worktrees — `sma worktree` (49.3-14, D-49.3-24a/b, BL-156)

The founder runs several Claude Code sessions against ONE checkout that auto-deploys
`main`. Two sessions editing the same files means one terminal's push carries the
other's half-built work — the recurring red-`main`. Per-terminal worktrees make that
physically impossible: each session gets its OWN working directory + branch.

```bash
pnpm sma worktree provision [--branch <name>] [--path <dir>]   # reuse-or-create THIS terminal's worktree
pnpm sma worktree list                                         # all active working trees
pnpm sma worktree remove <path> [--force]                      # remove one (refuses a dirty tree without --force)
pnpm sma worktree sibling                                      # resolved path of the sibling product repo (../sma)
```

**The model is per-TERMINAL, not per-phase or executor-only (D-49.3-24a).** Three
sessions sit on ONE phase today and the pain is human-driven parallel sessions — so
one worktree per terminal is the model. Per-phase (two sessions on one phase still
collide) and executor-only (misses the human-parallel case) are rejected. The branch
defaults to `sma-wt/<terminalId>`; the directory defaults to a sibling
`.sma-worktrees/<terminalId>` (a sibling dir, not nested inside the repo — the nested
path is what makes `git worktree remove` fail with «filename too long» on Windows).

**Coordination stays shared for free (D-49.3-02).** `.sma/` (the claims, sessions,
journal, fingerprint) resolves to the MAIN checkout from inside any worktree via
`git rev-parse --git-common-dir` (registry.smaRoot). So every worktree session still
registers in the one shared `.sma/` — nothing about coordination is re-plumbed; only
working-tree directories are created.

**The sibling product repo resolves from an ABSOLUTE path (D-49.3-24b).** Scripts that
operate on `../sma/scripts/sma/**` from inside a worktree cannot trust a relative
`../sma`. `sma worktree sibling` resolves in a fixed order — the `SMA_PRODUCT_REPO`
env, then a `.sma/config.json` value, then the /sma-start profile's recorded path,
then the relative `../sma` fallback (the primary-checkout default). Every miss degrades
to the next source; it never throws.

**The two Windows guards are mandatory.** Provisioning captures
`EXPECTED_BASE = git rev-parse HEAD`, verifies the new worktree branched from it, and
runs `git reset --hard $EXPECTED_BASE` on a mismatch (a Windows worktree can branch
from an OLDER commit than HEAD — it fired 3/4 in Phase 17.2 and 3/3 on 2026-07-03).
Every git command passes an EXPLICIT cwd via the injected runner — never a bare
`cd <dir> && git ...` — so a teleported shell CWD cannot run git on the wrong branch.

**Integration path.** A worktree branch enters `main` ONLY through 49.3-15's
`sma merge` (serialized, local only). This command NEVER runs `git push` or
`git merge`; push stays founder-ordered via /sma-ship.

`worktree --selftest` proves the base + teleport guards over a mock-git recorder;
`worktree --selftest-sibling` proves the resolution order — each prints a bare `1`.

## Serialized merge + enforcing scopes (49.3-15, D-49.3-24c/d/e/f)

Per-terminal worktrees (above) make parallel sessions physically isolated; `sma merge`
is the integration path that keeps `main` honest. A worktree branch enters `main` ONLY
through this ritual, under a merge-claim slot:

```
pnpm sma merge <branch>            # serialized local merge of a worktree branch into main
pnpm sma merge --selftest          # mock-recorder ritual + concurrent soft-deny (prints 1)
pnpm sma merge --selftest-enforce  # verified-live soft-deny / stale warn / error allow (prints 1)
```

The ritual, in order: acquire the `merge-in-progress` slot (a concurrent merge is
**soft-denied with an override**, never hard-blocked) → merge the branch into `main`
**locally** → run targeted tests **on the merge result** (not on either branch alone) →
journal a receipt (pass OR fail, honestly) → release the slot. The merge-claim mirrors
the push-claim on `claimSlot` (mkdir-EEXIST) — no bespoke lockfile.

**`sma merge` never pushes and never deploys.** Integration is local; push stays
founder-ordered via `/sma-ship` (slots.mjs header law). A red merge is surfaced honestly
(the receipt records the failure), never silently blessed.

**Enforcing scopes** (opt-in, default OFF behind `SMA_ENFORCE_SCOPES`) turn the collision
WARN into a **soft-deny with an override token** for the ONE safe case: a **verified-LIVE**
foreign claim (fresh touches + a live heartbeat, via plan 13's `verifyClaimEvidence`). A
stale or unverified claim stays WARN-only; a cooling-down / force-cleared scope is never
enforced (the founder word, D-49-09, always wins). The stream is fail-open: any error
degrades to allow — a gate bug can never wedge a session. Hard deny stays the security
guard's alone; `SMA_ENFORCE_SCOPES_DISABLE` is the kill-switch.

> **Vendor-absorbable (D-49.2-05 BRIDGE).** Serialized-merge multiplayer is a bridge, not
> a moat — a demolition clause with a self-removal disposition if a vendor ships it natively.

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

## Coordination trust — the live fingerprint + claim repair (49.3-13, D-49.3-21/22/23)

«What is each terminal doing RIGHT NOW, and can I trust this collision warning?» is
answerable from the local `.sma/` files, in the agent's own language — between the lines,
not from ROADMAP/STATE.

### The live work fingerprint (D-49.3-21)

Each terminal's `sma pre` hook SELF-CAPTURES its own touched files onto its OWN session
lease at the moment of touching — riding the existing once-per-tool-call heartbeat, **zero
new spawns**. Attribution is self-capture ONLY: `git status` is never read (on a shared
tree it shows the union of every terminal's work). The lease (no parallel store — D-49.3-02)
now carries, alongside the work-axis `status`:

- `intent` — the agent-maintained one-line string («чиню тест dispatcher, не трогайте
  sender.ts»);
- `filesRecent[]` — the files touched in the last ~9 min ({path, ts}, windowed + capped);
- `fpStatus` — the attention axis (`working` | `waiting-for-human` | `idle`).

`buildFingerprint` reads these back; `pnpm sma status`, the pre-injection, and plan-07's
statusline all render this ONE fingerprint.

**Injection is two channels, never per-tool-call spam:** (1) an ambient digest of all live
terminals (one line each — status + intent + phase), throttled to ~10 min via a renewTime-age
compare (never a timer/daemon); PLUS (2) the FULL fingerprint of terminal B injected
immediately when you touch a file/scope inside B's fingerprint.

### Claim trust repair (D-49.3-22)

Claims auto-release on **exactly two triggers** — never an idle timer (a timer would reap a
terminal that thinks/researches long before editing):

1. **SessionEnd** — a NEW `SessionEnd` hook (`node scripts/sma/cli.mjs session-end`) releases
   all of the window's own claims («сессия завершена»). It does NOT touch the `Stop` hook
   (Stop fires per turn — releasing every claim per turn would destroy the system).
2. **Commit-evidence** — when the claimed scope is clean vs HEAD AND a commit landed in scope
   after the claim's renewTime, the work is provably done → release immediately, no TTL wait.

Every collision WARN is **self-verifying**: a live warn carries «занято … правки N мин назад,
намерение: …»; a stale warn carries «claim устарел (скоуп чист, коммит abc123 уже в HEAD) —
можно работать». A `.cooldown-*` marker after a force-clear reads «недавно освобождён», never
«занято» (force-clear keeps provenance + explicit confirmation, D-49-09 — unchanged).

**BL-158 absorbed:** `attention` is distinguished from `fresh` (a fresh owner reads «занято»,
an attention owner reads «внимание»; the active count splits the two tiers); the reaper's
failures are observable (`reapStaleObservable` journals a countable `reap` / `reap-fail`);
liveness relies on renewTime freshness ONLY (pid is never consulted — it is stale across
Claude restarts).

### Instruments + the `sma ask` demand stub (D-49.3-23)

- `pnpm sma status --stale-warn-share` — the deterministic % of shown collision warns that
  were noise over 7 days (a WARN whose claim then auto-released with zero further touches).
- `pnpm sma status --stale-count` — dead/stale sessions still surviving the reap (0 = clean).
- `pnpm sma status --cleanup-stale` — the one-time sweep of accumulated dead claims + stale
  sessions (provenance kept).
- `pnpm sma ask <терминал> "<вопрос>"` — a DEMAND STUB: prints the target's fingerprint and
  journals the unmet question. The ask-bus is DEFERRED to V3.1, gated on ≥10 journaled cases
  the fingerprint could not answer (`ask --unmet-count`) — demand is measured, not assumed.
  Multi-terminal coordination is vendor-absorbable (OpenAI acquired Multi in 2024), so the
  bus is only built once the field proves the passive fingerprint is insufficient.

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
