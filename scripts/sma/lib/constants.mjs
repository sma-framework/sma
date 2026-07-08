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
export const SLOT_CLAIM_TTL_MS = 1800000 //     30 min — TTL of a number-slot claim; an UNconsumed
//                                              claim older than this is abandoned and re-issued (49.1-23, B17)
export const PUSH_CLAIM_TTL_MS = 1800000 //     30 min — TTL of the founder-reserved push claim
export const JOURNAL_TAIL_FOR_SNAPSHOT = 20 //       bounded journal tail per snapshot payload

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

// ── FI-9 / FI-11 layer byte budgets (49.1-13) ────────────────────────────────
// Machine-enforced hot-surface budgets, measured in UTF-8 BYTES (not chars).
// Lint (MEM-CORESIZE / MEM-NOTESIZE / MEM-INDEXSIZE / STATE-SIZE) warns at 80%
// and goes critical at 100%; `sma trim` is the auto-repair — overflow DEMOTES
// down a layer, it is never deleted (FI-9 founder lock).
export const CORE_BUDGET = 6144 //          6 KB — the CORE section of MEMORY.md
export const NOTE_BUDGET = 8192 //          8 KB — each individual memory note
export const ALWAYS_LOAD_BUDGET = 12288 // 12 KB — MEMORY.md whole (CORE + discovery block)
export const STATE_BUDGET = 40960 //       40 KB — STATE.md snapshot (the house rule, FI-9)
export const BUDGET_WARN_FRACTION = 0.8 //  WARN threshold as a fraction of each budget

// ── 49.2-03 (D-49.2-06): structural-receipts cutover ─────────────────────────
// The phase from which RECEIPT-PROSE enforces a machine receipt on every
// machine-verifiable coverage item. Pre-cutover summaries (the whole V2 history,
// ~27 files) are NOT retro-failed — the retro look at V2 false-dones is plan 01's
// baseline harness, not the lint. Phase compare splits on '.' and numeric-compares
// each segment ('49.10' > '49.2'), NEVER a float compare.
export const RECEIPTS_ENFORCED_FROM = '49.2'
