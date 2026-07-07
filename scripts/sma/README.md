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

`pnpm sma <status|heartbeat|session-start|collision-check|claim|release|next-slot|force-clear|lint|build-index|load|snapshot>`

Every subcommand accepts `--json` for a single-line JSON object (the statusline / hook
contract). Hook-facing subcommands (`session-start`, `collision-check`, `heartbeat`)
ALWAYS exit 0 (fail-open, see below); direct-CLI subcommands return meaningful codes.

| Subcommand | Purpose | Key flags |
|---|---|---|
| `status` | statusline/hook JSON: active sessions, collisions, next slots | `--json` |
| `heartbeat` | renew this session's lease (cadence: every 3 min) | — |
| `session-start` | register this terminal's session lease | — |
| `collision-check` | read-only scope-collision + hot-file advisory scan | `--json` |
| `claim` | claim a work scope | `<name> --globs "<glob>" --desc "<text>"` |
| `release` | release your OWN claim | `<name>` |
| `next-slot` | allocate the next migration number or release version | `migration` \| `release` |
| `force-clear` | clear a stale/foreign claim (with confirmation, P3) | `<name>` |
| `lint` | run memory-lint over the corpus | `--json` |
| `build-index` | (re)generate MEMORY.md | `--write` (DRY by default) |
| `load` | resolve a tag set into CORE + periphery notes | `--tags <csv> [--json]` |
| `snapshot` | push a bounded, allowlisted state view to the CRM cockpit | `--json` |

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

## Fail-open contract (P3 / P4 / P5)

- **P3 — foreign claims are never auto-cleared.** A stale foreign claim is flagged
  `needsHuman`, never silently removed; force-clear is an interactive, confirmed action.
- **P4 — hooks never block the session.** Hook-facing subcommands swallow all errors
  and exit 0. A broken SMA layer degrades to "no advisory", never to a stuck session.
- **P5 — the deploy operation stays founder-reserved.** SMA issues ONLY read-only git
  subcommands (fetch/show/tag/rev-parse/log). It NEVER runs the push/deploy operation;
  the release slot advises the next V1.N, a human performs the deploy.
