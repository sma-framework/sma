/**
 * constants.mjs — D-49-11 cadence / TTL constants for the SMA coordination layer.
 *
 * Founder-accepted values (planner-tuned within +/-20%). Every SMA plan
 * (49-05/06/08/09/11/13) imports these so the timing contract lives in one place.
 * Node built-ins only; zero npm deps (founder-locked: deterministic Node scripts).
 */

import { join } from 'node:path'

// ── Cadence / TTL (milliseconds) ──────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 180000 //   3 min — session heartbeat cadence
export const ATTENTION_AFTER_MISSES = 3 //            missed heartbeats -> attention
export const SESSION_TTL_MS = 1800000 //        30 min — a session is stale after this
export const GRACE_MS = 900000 //               15 min — grace before reclaiming a slot
export const SLOT_COOLDOWN_MS = 600000 //       10 min — cooldown after a slot release (B27)
// ── 49.3-13 (D-49.3-21) — live work fingerprint windows ──────────────────────
// "files touched last N min": 3 heartbeats (== the attention tier boundary) so the
// fingerprint's recent-touch window matches the liveness cadence already in the lease.
export const FINGERPRINT_FILES_WINDOW_MS = 3 * HEARTBEAT_INTERVAL_MS // ~9 min
export const FINGERPRINT_FILES_MAX = 12 //           cap on filesRecent[] entries (burst guard)
export const AMBIENT_DIGEST_MS = 600000 //      10 min — ambient all-terminals digest cadence
//                                              (a renewTime-age throttle, NEVER a timer/daemon)
export const SLOT_CLAIM_TTL_MS = 1800000 //     30 min — TTL of a number-slot claim; an UNconsumed
//                                              claim older than this is abandoned and re-issued (49.1-23, B17)
export const PUSH_CLAIM_TTL_MS = 1800000 //     30 min — TTL of the founder-reserved push claim
// ── 49.3-15 (D-49.3-24d) — serialized merge gate ─────────────────────────────
// The merge-in-progress advisory slot mirrors the push claim EXACTLY: one holder at a
// time, a stale claim past this TTL is flagged for a human (never auto-cleared, P3). A
// worktree branch enters main ONLY through the `sma merge` ritual under this slot.
export const MERGE_CLAIM_TTL_MS = 1800000 //   30 min — TTL of the serialized merge claim (mirrors PUSH_CLAIM_TTL_MS)
export const MERGE_SLOT_NAME = 'merge-in-progress' //  the single serialized-merge advisory slot
export const JOURNAL_TAIL_FOR_SNAPSHOT = 20 //       bounded journal tail per snapshot payload
// ── 49.3-05 (D-49.3-06/07) — fragment catalog + context compiler ─────────────
export const CATALOG_REFRESH_CAP = 50 //             max files re-carded per in-hook incremental refresh;
//                                              beyond it the `context` stream defers to an explicit
//                                              `sma catalog refresh`, protecting the 49.2-02 hook SLO.
export const PACK_ACTIVE_TTL_MS = 14400000 //   4 h — an active pack older than this stops collecting
//                                              touches (joins the TTL family; scorePurity/growExam only
//                                              ever consume touches from a still-active pack).
export const FRAGMENT_BUDGET = 400 //           UTF-8 bytes over the fragment BODY — one fact, the grill-
//                                              approved atom. The citation journal scores FACTS, so the
//                                              atom must be small enough that a citation means THE fact
//                                              was useful (not an 8 KB note).
export const PACK_BUDGET = 16384 //             UTF-8 bytes over the rendered PACK.md — 2x NOTE_BUDGET: a
//                                              pack that replaces opening five files should never outweigh
//                                              two notes (discretion call, 49.3-CONTEXT Claude's-Discretion).

// ── .sma/ directory contract (D-49-05: local files are the sole coordination truth) ─
export const SMA_ROOT = '.sma'
export const SESSIONS_DIR = join(SMA_ROOT, 'sessions')
export const CLAIMS_DIR = join(SMA_ROOT, 'claims')
export const JOURNAL_DIR = join(SMA_ROOT, 'journal')
export const CALIBRATION_DIR = join(SMA_ROOT, 'calibration') // 49.1-08 (B20) — prediction-calibration ledger
export const REFLEX_DIR = join(SMA_ROOT, 'reflex') // 49.1-10 (B2) — per-session reflex seen-store
export const USAGE_DIR = join(SMA_ROOT, 'usage') // 49.1-11 (B4) — usage-citation ledger
export const EXEC_DIR = join(SMA_ROOT, 'exec') // 49.1-20 (B14) — per-plan execution progress journal
export const STALL_DIR = join(SMA_ROOT, 'stall') // 49.1-21 (B16) — per-session rolling PostToolUse window
export const SUBAGENTS_DIR = join(SMA_ROOT, 'subagents') // 49.2-04 (D-49.2-10) — spawn records + receipt stats
export const FLIGHT_DIR = join(SMA_ROOT, 'flight') // 49.2-06 (D-49.2-09) — pre-compaction capsule + session flight marks
export const SPEND_DIR = join(SMA_ROOT, 'spend') // 49.2-09 (D-49.2-13) — spend book incremental cache + window budget
export const BREAKER_DIR = join(SMA_ROOT, 'breaker') // 49.2-09 (D-49.2-13) — loop-breaker markers (per-ruleId, disarm-path input for plan 10)
// ── 49.2-10 (D-49.2-14) — integrity guards (Goodhart + STPA) ─────────────────
export const SKEPTIC_DIR = join(SMA_ROOT, 'skeptic') // skeptic countersign files (<planId>.json)
export const CANARY_DIR = join(SMA_ROOT, 'canary') // sealed canary ledger the blind verifier NEVER reads
export const NEARMISS_DIR = join(SMA_ROOT, 'nearmiss') // scoring-immune near-miss channel (ASRS class)
export const DISARM_DIR = join(SMA_ROOT, 'disarm') // per-gate kill-switch provenance leases (auto-re-arm)
// ── 49.3-02 (D-49.3-10) — model-version sightings for the stale-priors guard ──
export const MODEL_DIR = join(SMA_ROOT, 'model') // append-only sightings.jsonl feeding the calibration-passport badge guard
// ── 49.3-06 (D-49.3-12) — self-tuning enforcement (maturation ladder + miss-curriculum) ──
export const CURRICULUM_DIR = join(SMA_ROOT, 'curriculum') // weekly miss-curriculum: templates.jsonl (append-only) + brief-<yyyy>-W<ww>.md
// ── 49.3-07 (D-49.3-13) — native-statusline segment + pulse webhook runtime dir ──
// cache.json (two-tier TTL render cache), webhook.json (user-configured URL + provenance),
// last-webhook.json (edge-trigger cooldown marker), wrapped-command.json (the user's own
// statusLine command preserved verbatim for wrap+uninstall). All gitignored (.sma/), all
// fail-open. The TTL constants (STATUSLINE_TTL_MS / PREDS_TTL_MS) live in statusline.mjs
// beside the cache logic; the webhook cadence constants live in notify.mjs beside the fetch.
export const STATUSLINE_DIR = join(SMA_ROOT, 'statusline')
// ── 49.3-08 (D-49.3-11) — PR evidence passport runtime dir ───────────────────
// buildManifest writes the deterministic evidence pack here as <headSha>.json +
// .md. Gitignored (.sma/); the manifest is a READER over Track A outputs — it
// computes no verdict, only assembles + renders what the ledger already holds.
export const MANIFEST_DIR = join(SMA_ROOT, 'manifest')
// The tier registry is TRACKED at the REPO ROOT (deliberately NOT under gitignored .sma/):
// every tier change is a `git diff` a human reviews. Only the basename lives here; the CLI
// joins it against dirname(dirs.smaRoot) = the repo root.
export const LADDER_FILE = 'sma-ladder.json'

// ── FI-9 / FI-11 layer byte budgets (49.1-13) ────────────────────────────────
// Machine-enforced hot-surface budgets, measured in UTF-8 BYTES (not chars).
// Lint (MEM-CORESIZE / MEM-NOTESIZE / MEM-INDEXSIZE / STATE-SIZE) warns at 80%
// and goes critical at 100%; `sma trim` is the auto-repair — overflow DEMOTES
// down a layer, it is never deleted (FI-9 founder lock).
export const CORE_BUDGET = 6144 //          6 KB — the CORE section of MEMORY.md
export const NOTE_BUDGET = 8192 //          8 KB — each individual memory note
export const ALWAYS_LOAD_BUDGET = 12288 // 12 KB — MEMORY.md whole (CORE + discovery block)
export const STATE_BUDGET = 40960 //       40 KB — STATE.md snapshot (the house rule, FI-9)
export const CAPSULE_BUDGET = 8192 //       8 KB — the pre-compaction flight capsule (49.2-06, D-49.2-09)
export const RESTORE_BUDGET = 6144 //       6 KB — the post-compact restore injection cap (49.2-06)
export const BUDGET_WARN_FRACTION = 0.8 //  WARN threshold as a fraction of each budget

// ── 49.3-04 (D-49.3-08): `sma emit` per-format managed-block byte budgets ─────
// Measured in UTF-8 BYTES over the WHOLE managed export block (BEGIN anchor +
// preamble + entries + footer + END anchor). The priority-prefix fill reserves
// scaffold bytes (anchors + preamble + widest footer) then stops at the first
// entry that would overflow — so over-budget is structurally impossible.
// Discretion call (D-49.3 Claude's-Discretion): 8 KiB matches NOTE_BUDGET so an
// exported block never outweighs the single-note ceiling; .cursorrules is smaller
// (plain-text legacy format Cursor injects into every request — less headroom).
export const EMIT_BUDGETS = { claude: 8192, agents: 8192, cursorrules: 6144, gemini: 8192 }

// ── 49.2-03 (D-49.2-06): structural-receipts cutover ─────────────────────────
// The phase from which RECEIPT-PROSE enforces a machine receipt on every
// machine-verifiable coverage item. Pre-cutover summaries (the whole V2 history,
// ~27 files) are NOT retro-failed — the retro look at V2 false-dones is plan 01's
// baseline harness, not the lint. Phase compare splits on '.' and numeric-compares
// each segment ('49.10' > '49.2'), NEVER a float compare.
export const RECEIPTS_ENFORCED_FROM = '49.2'

// ── 49.2-05 (D-49.2-08): the git airbag gate ─────────────────────────────────
// Recovery points are pinned under one hierarchical ref namespace so a single
// `for-each-ref` enumerates snapshot GROUPS by the <id> segment. These live only
// in the LOCAL object store (outside default push refspecs — never pushed, T-49.2-05-06).
export const AIRBAG_REF_PREFIX = 'refs/sma/airbag/'
// Untracked-capture caps (the cap-explosion guard, T-49.2-05-03): a snapshot pins
// at most this many untracked files / total bytes; the rest are recorded by NAME
// only and the receipt carries untrackedTruncated:true. Ignored files (a `clean -x`
// blast) are NEVER enumerated — ignoredNotCaptured:true instead.
export const AIRBAG_UNTRACKED_MAX_FILES = 200
export const AIRBAG_UNTRACKED_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
// Prune retention: keep the newest N snapshot groups, drop groups older than the age.
export const AIRBAG_KEEP = 20
export const AIRBAG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

// ── 49.3-14 (D-49.3-24a): per-terminal worktree isolation ────────────────────
// The branch-name stem for a per-SESSION worktree. `sma worktree provision`
// names a terminal's branch `${WORKTREE_BRANCH_PREFIX}${terminalId}` so parallel
// human Claude Code sessions get physically distinct working trees on ONE shared,
// auto-deploy checkout — «your push carried my half-built work» becomes impossible.
// A slash-namespaced ref (valid in git) keeps these branches grouped + easy to sweep.
export const WORKTREE_BRANCH_PREFIX = 'sma-wt/'
