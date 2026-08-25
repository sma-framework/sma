/**
 * constants.mjs — cadence / TTL constants for the SMA coordination layer.
 *
 * Founder-accepted values (planner-tuned within +/-20%). Every module of the
 * coordination layer imports these, so the timing contract lives in one place.
 * Node built-ins only; zero npm deps (founder-locked: deterministic Node scripts).
 */

import { join } from 'node:path'

// ── Cadence / TTL (milliseconds) ──────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 180000 //   3 min — session heartbeat cadence
export const ATTENTION_AFTER_MISSES = 3 //            missed heartbeats -> attention
export const SESSION_TTL_MS = 1800000 //        30 min — a session is stale after this
export const GRACE_MS = 900000 //               15 min — grace before reclaiming a slot
export const SLOT_COOLDOWN_MS = 600000 //       10 min — cooldown after a slot release (B27)
// ── live work fingerprint windows ──────────────────────────────────────────
// "files touched last N min": 3 heartbeats (== the attention tier boundary) so the
// fingerprint's recent-touch window matches the liveness cadence already in the lease.
export const FINGERPRINT_FILES_WINDOW_MS = 3 * HEARTBEAT_INTERVAL_MS // ~9 min
export const FINGERPRINT_FILES_MAX = 12 //           cap on filesRecent[] entries (burst guard)
export const AMBIENT_DIGEST_MS = 600000 //      10 min — ambient all-terminals digest cadence
//                                              (a renewTime-age throttle, NEVER a timer/daemon)
export const SLOT_CLAIM_TTL_MS = 1800000 //     30 min — TTL of a number-slot claim; an UNconsumed
//                                              claim older than this is abandoned and re-issued
export const PUSH_CLAIM_TTL_MS = 1800000 //     30 min — TTL of the founder-reserved push claim
// ── serialized merge gate ──────────────────────────────────────────────────
// The merge-in-progress advisory slot mirrors the push claim EXACTLY: one holder at a
// time, a stale claim past this TTL is flagged for a human (never auto-cleared, P3). A
// worktree branch enters main ONLY through the `sma merge` ritual under this slot.
export const MERGE_CLAIM_TTL_MS = 1800000 //   30 min — TTL of the serialized merge claim (mirrors PUSH_CLAIM_TTL_MS)
export const MERGE_SLOT_NAME = 'merge-in-progress' //  the single serialized-merge advisory slot
export const JOURNAL_TAIL_FOR_SNAPSHOT = 20 //       bounded journal tail per snapshot payload
// ── fragment catalog + context compiler ────────────────────────────────────
export const CATALOG_REFRESH_CAP = 50 //             max files re-carded per in-hook incremental refresh;
//                                              beyond it the `context` stream defers to an explicit
//                                              `sma catalog refresh`, protecting the hook's latency SLO.
export const PACK_ACTIVE_TTL_MS = 14400000 //   4 h — an active pack older than this stops collecting
//                                              touches (joins the TTL family; scorePurity/growExam only
//                                              ever consume touches from a still-active pack).
export const FRAGMENT_BUDGET = 400 //           UTF-8 bytes over the fragment BODY — one fact, the grill-
//                                              approved atom. The citation journal scores FACTS, so the
//                                              atom must be small enough that a citation means THE fact
//                                              was useful (not an 8 KB note).
export const PACK_BUDGET = 16384 //             UTF-8 bytes over the rendered PACK.md — 2x NOTE_BUDGET: a
//                                              pack that replaces opening five files should never outweigh
//                                              two notes (a discretion call, not a measured law).

// ── .sma/ directory contract (local files are the sole coordination truth) ─────────
export const SMA_ROOT = '.sma'
export const SESSIONS_DIR = join(SMA_ROOT, 'sessions')
export const CLAIMS_DIR = join(SMA_ROOT, 'claims')
export const JOURNAL_DIR = join(SMA_ROOT, 'journal')
export const CALIBRATION_DIR = join(SMA_ROOT, 'calibration') // prediction-calibration ledger
export const REFLEX_DIR = join(SMA_ROOT, 'reflex') // per-session reflex seen-store
export const USAGE_DIR = join(SMA_ROOT, 'usage') // usage-citation ledger
export const EXEC_DIR = join(SMA_ROOT, 'exec') // per-plan execution progress journal
export const STALL_DIR = join(SMA_ROOT, 'stall') // per-session rolling PostToolUse window
export const SUBAGENTS_DIR = join(SMA_ROOT, 'subagents') // spawn records + receipt stats
export const FLIGHT_DIR = join(SMA_ROOT, 'flight') // pre-compaction capsule + session flight marks
export const SPEND_DIR = join(SMA_ROOT, 'spend') // spend book incremental cache + window budget
export const BREAKER_DIR = join(SMA_ROOT, 'breaker') // loop-breaker markers (per-ruleId; the disarm path reads them)
// ── integrity guards (Goodhart + STPA) ─────────────────────────────────────
export const SKEPTIC_DIR = join(SMA_ROOT, 'skeptic') // skeptic countersign files (<planId>.json)
export const CANARY_DIR = join(SMA_ROOT, 'canary') // sealed canary ledger the blind verifier NEVER reads
export const NEARMISS_DIR = join(SMA_ROOT, 'nearmiss') // scoring-immune near-miss channel (ASRS class)
export const DISARM_DIR = join(SMA_ROOT, 'disarm') // per-gate kill-switch provenance leases (auto-re-arm)
// ── model-version sightings for the stale-priors guard ──────────────────────
export const MODEL_DIR = join(SMA_ROOT, 'model') // append-only sightings.jsonl feeding the calibration-passport badge guard
// ── self-tuning enforcement (maturation ladder + miss-curriculum) ──────────────────────
export const CURRICULUM_DIR = join(SMA_ROOT, 'curriculum') // weekly miss-curriculum: templates.jsonl (append-only) + brief-<yyyy>-W<ww>.md
// ── native-statusline segment + pulse webhook runtime dir ──────────────────────
// cache.json (two-tier TTL render cache), webhook.json (user-configured URL + provenance),
// last-webhook.json (edge-trigger cooldown marker), wrapped-command.json (the user's own
// statusLine command preserved verbatim for wrap+uninstall). All gitignored (.sma/), all
// fail-open. The TTL constants (STATUSLINE_TTL_MS / PREDS_TTL_MS) live in statusline.mjs
// beside the cache logic; the webhook cadence constants live in notify.mjs beside the fetch.
export const STATUSLINE_DIR = join(SMA_ROOT, 'statusline')
// ── PR evidence passport runtime dir ───────────────────────────────────────
// buildManifest writes the deterministic evidence pack here as <headSha>.json +
// .md. Gitignored (.sma/); the manifest is a READER over Track A outputs — it
// computes no verdict, only assembles + renders what the ledger already holds.
export const MANIFEST_DIR = join(SMA_ROOT, 'manifest')
// The tier registry is TRACKED at the REPO ROOT (deliberately NOT under gitignored .sma/):
// every tier change is a `git diff` a human reviews. Only the basename lives here; the CLI
// joins it against dirname(dirs.smaRoot) = the repo root.
export const LADDER_FILE = 'sma-ladder.json'

// ── layer byte budgets ──────────────────────────────────────────────────────
// Machine-enforced hot-surface budgets, measured in UTF-8 BYTES (not chars).
// Lint (MEM-CORESIZE / MEM-NOTESIZE / MEM-INDEXSIZE / STATE-SIZE) warns at 80%
// and goes critical at 100%; `sma trim` is the auto-repair — overflow DEMOTES
// down a layer, it is never deleted (a founder lock).
export const CORE_BUDGET = 6144 //          6 KB — the CORE section of MEMORY.md
export const NOTE_BUDGET = 8192 //          8 KB — each individual memory note
export const ALWAYS_LOAD_BUDGET = 12288 // 12 KB — MEMORY.md whole (CORE + discovery block)
export const STATE_BUDGET = 40960 //       40 KB — STATE.md snapshot (the house rule)
export const CAPSULE_BUDGET = 8192 //       8 KB — the pre-compaction flight capsule
export const RESTORE_BUDGET = 6144 //       6 KB — the post-compact restore injection cap
export const BUDGET_WARN_FRACTION = 0.8 //  WARN threshold as a fraction of each budget

// ── `sma emit` per-format managed-block byte budgets ────────────────────────
// Measured in UTF-8 BYTES over the WHOLE managed export block (BEGIN anchor +
// preamble + entries + footer + END anchor). The priority-prefix fill reserves
// scaffold bytes (anchors + preamble + widest footer) then stops at the first
// entry that would overflow — so over-budget is structurally impossible.
// Discretion call: 8 KiB matches NOTE_BUDGET so an
// exported block never outweighs the single-note ceiling; .cursorrules is smaller
// (plain-text legacy format Cursor injects into every request — less headroom).
export const EMIT_BUDGETS = { claude: 8192, agents: 8192, cursorrules: 6144, gemini: 8192 }

// ── structural-receipts cutover ────────────────────────────────────────────
// The phase from which RECEIPT-PROSE enforces a machine receipt on every
// machine-verifiable coverage item. Pre-cutover summaries (the whole V2 history,
// ~27 files) are NOT retro-failed — the retro look at V2 false-dones belongs to the
// baseline harness, not the lint. Phase compare splits on '.' and numeric-compares
// each segment ('9.10' > '9.2'), NEVER a float compare.
export const RECEIPTS_ENFORCED_FROM = '9.2'

// ── the closing gate for predictions ───────────────────────────────────────
// The DATE from which a closed plan owes a verdict on every prediction of its
// own that could actually be checked. A DATE and not a release number on
// purpose: the rule is about when the gate started existing in this tree, and
// the close date of a plan is a fact git already knows about its summary file.
// Everything closed BEFORE this date is history, not debt: some of it points at
// trees that no longer exist and cannot be re-scored at all. That backlog is
// left VISIBLE and named as a number rather than quietly swept up — a rule that
// is born red and then softened until it is green teaches only that gates can
// be argued with. Compared as a plain ISO day string, never parsed into a date.
export const PREDICTIONS_SCORED_FROM = '2026-08-20'

// A prediction whose check_command invokes a SELFTEST measures the instrument's
// own self-check, and a self-check passes by construction — every such entry is
// a guaranteed hit, so the form inflates the hit rate without promising anything
// about the WORK. The owner ruled the form out. History is not rewritten: an
// entry in a plan closed before this day is MARKED (warn) and stays visible —
// pre-registered blocks are immutable, and quietly sweeping the legacy up would
// teach that gates can be argued with. From this day on the form is a critical
// finding. Compared as a plain ISO day string, never parsed into a date.
export const PREDICTIONS_MEASURE_WORK_FROM = '2026-08-25'

// ── the git airbag gate ────────────────────────────────────────────────────
// Recovery points are pinned under one hierarchical ref namespace so a single
// `for-each-ref` enumerates snapshot GROUPS by the <id> segment. These live only
// in the LOCAL object store (outside default push refspecs — never pushed).
export const AIRBAG_REF_PREFIX = 'refs/sma/airbag/'
// Untracked-capture caps (the cap-explosion guard): a snapshot pins
// at most this many untracked files / total bytes; the rest are recorded by NAME
// only and the receipt carries untrackedTruncated:true. Ignored files (a `clean -x`
// blast) are NEVER enumerated — ignoredNotCaptured:true instead.
export const AIRBAG_UNTRACKED_MAX_FILES = 200
export const AIRBAG_UNTRACKED_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
// Prune retention: keep the newest N snapshot groups, drop groups older than the age.
export const AIRBAG_KEEP = 20
export const AIRBAG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

// ── per-terminal worktree isolation ────────────────────────────────────────
// The branch-name stem for a per-SESSION worktree. `sma worktree provision`
// names a terminal's branch `${WORKTREE_BRANCH_PREFIX}${terminalId}` so parallel
// human Claude Code sessions get physically distinct working trees on ONE shared,
// auto-deploy checkout — «your push carried my half-built work» becomes impossible.
// A slash-namespaced ref (valid in git) keeps these branches grouped + easy to sweep.
export const WORKTREE_BRANCH_PREFIX = 'sma-wt/'

// ── the write-pipeline provenance rule ─────────────────────────────────────
// The DATE from which a note found in the corpus owes machine evidence that it
// walked the write pipeline. A DATE for the same reason as the closing gate
// above: the rule is about when it started existing in a tree, and git already
// knows when a note file was first added.
//
// THE TIER IS A DECISION, NOT A DEFAULT. A note filed BEFORE this day is a WARN:
// an inherited corpus is a debt to be seen, not a pile of accidents to be
// prosecuted, and a rule born red and then argued down teaches only that rules
// can be argued with. A note filed AFTER it is CRITICAL: from that day the
// pipeline was there to be used, and walking around it was a choice.
// Compared as a plain ISO day string, never parsed into a date.
export const MEMORY_PIPELINE_REQUIRED_FROM = '2026-08-20'

// WHERE EVERY WORKING COPY LIVES — a SIBLING of the main checkout, never a directory inside
// it (a nested copy makes `git worktree remove` capable of emptying the tree it sits in).
// Named here rather than spelled at each call site because three different modules act on
// this directory: the verb that creates a copy, the daemon that asks for one per task, and
// the cleanup that refuses to delete anything outside it. Three spellings of one directory
// is how provisioning comes to put a copy where cleanup is not allowed to look.
export const WORKTREE_COPIES_DIR = '.sma-worktrees'
