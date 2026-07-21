/**
 * spend-adapter.mjs — the VERSIONED log-format adapter (9.2-09, D-9.2-13).
 *
 * ═══════════════════════════ THE QUARANTINE ═══════════════════════════════════
 *
 * This module is the ONLY place in the whole tree that knows the vendor's local
 * session-transcript shape. Claude Code's JSONL log format is NOT ours and WILL
 * drift; by confining every field-name / structural assumption to `ADAPTER_VERSIONS`
 * here, a future log-format change is a ONE-FILE fix (append one adapter entry) and
 * an unrecognized-but-usage-bearing line is COUNTED as drift, never thrown or lost
 * (D-9.2-13). spend.mjs and breaker.mjs import vendor knowledge ONLY via these
 * exports — they never touch a raw transcript field.
 *
 * ═══════════════════════════ THE CANONICAL EVENT ══════════════════════════════
 *
 * parseLogLine normalizes each usage-bearing line into a canonical event whose
 * field names are compatible with the OTel `claude_code.token.usage` metric and
 * the ccusage vocabulary (camelCase):
 *   { ts, sessionId, model, inputTokens, outputTokens, cacheCreationTokens,
 *     cacheReadTokens, costUSD, costSource, isSidechain, adapterVersion }
 * A non-usage / corrupt / duplicate / unrecognized line returns a TYPED skip
 * `{skip: 'non-usage'|'corrupt'|'duplicate'|'unrecognized'}` — parseLogLine NEVER
 * throws on any input (fail-open, C9 substrate law).
 *
 * ═══════════════════════════ COST HONESTY ═════════════════════════════════════
 *
 * A line carrying its own costUSD wins verbatim (costSource 'line'). Otherwise the
 * cost is computed from the static PRICING_USD_PER_MTOK table (cache-write and
 * cache-read priced at their own rates), stamped costSource 'computed'. An UNKNOWN
 * model is booked token-only with costUSD null and costSource 'unpriced' — honesty
 * over guessing; the caller surfaces the `unpriced` count in every report. NO
 * network fetch of pricing EVER (substrate law) — the table is versioned data.
 *
 * ═══════════════════════════ BRIDGE (D-9.2-05) ═══════════════════════════════
 *
 * probeNativeSpend is the demolition-clause sensor: the day the vendor ships a
 * sufficient LOCAL spend surface (per-session + per-model + window totals without
 * network), the probe flips and spend.mjs stands the ledger down. P9.2-09-3 is the
 * registered self-removal prediction; the ledger is NEVER headlined in positioning.
 *
 * Node built-ins only; zero npm deps, zero network, zero LLM.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir as osHomedir } from 'node:os'

/** truthy env flag: set and not ''/0/false. Mirrors the reflex/gates convention. */
function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

/** Number coercion → a finite non-negative integer-ish token count (else 0). */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** String coercion with a default. */
function strOr(v, d) {
  return typeof v === 'string' && v.trim() ? v : d
}

// ═══════════════════════════ pricing (versioned data) ═══════════════════════════

/** The pricing-table version, stamped into every report (no silent table swaps). */
export const pricingVersion = 'claude-pricing-2026-07-21'

/**
 * PRICING_USD_PER_MTOK — USD per MILLION tokens for the known model families. Input,
 * output, cache-write (cache_creation), and cache-read (cache_read) each have their
 * own rate. Static data, NEVER fetched over the network. An unknown model → null
 * (booked token-only, costUSD null, `unpriced`). Family match is a substring test on
 * a lowercased model string so a versioned id ('claude-opus-4-8') maps to its tier.
 *
 * Source: the official Anthropic pricing page, verified 2026-07-21.
 * The prior table (claude-pricing-2026-07) OVERCOUNTED opus 3x (it carried the
 * deprecated Opus 4.1/4 rates $15/$75; current Opus 4.5-4.8 are $5/$25) and had NO
 * fable row (fable-family events went unpriced). cacheWrite = the 5-minute-TTL write
 * rate (the table's single-rate convention); 1h-TTL writes bill higher ($20 fable /
 * $10 opus) — a known, stated approximation, not billing truth. Sonnet row = the
 * promo price THROUGH 2026-08-31 ($2/$10); from Sep 1 it becomes $3/$15 — bump this
 * table + its version then.
 */
export const PRICING_USD_PER_MTOK = {
  fable: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
}

/** pricingFor(model) → the tier rates, or null for an unknown model family. */
function pricingFor(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return PRICING_USD_PER_MTOK.fable
  if (m.includes('opus')) return PRICING_USD_PER_MTOK.opus
  if (m.includes('sonnet')) return PRICING_USD_PER_MTOK.sonnet
  if (m.includes('haiku')) return PRICING_USD_PER_MTOK.haiku
  return null
}

/**
 * priceEvent(ev) — resolve costUSD + costSource. A finite line-carried costUSD wins
 * (source 'line'); else compute from the table (source 'computed'); an unknown model
 * → {costUSD:null, costSource:'unpriced'} (tokens stay booked). Rounded to 1e-6 USD.
 * @param {object} ev the canonical event (mutated in place)
 */
function priceEvent(ev) {
  if (Number.isFinite(ev.costUSD)) {
    ev.costSource = 'line'
    return ev
  }
  const rates = pricingFor(ev.model)
  if (!rates) {
    ev.costUSD = null
    ev.costSource = 'unpriced'
    return ev
  }
  const usd =
    (ev.inputTokens * rates.input +
      ev.outputTokens * rates.output +
      ev.cacheCreationTokens * rates.cacheWrite +
      ev.cacheReadTokens * rates.cacheRead) /
    1e6
  ev.costUSD = Math.round(usd * 1e6) / 1e6
  ev.costSource = 'computed'
  return ev
}

// ═══════════════════════════ the versioned adapters ═════════════════════════════

/**
 * ADAPTER_VERSIONS — the ordered chain of vendor-format adapters. parseLogLine walks
 * detectors IN ORDER; the first to `detect(obj)` owns the line and `normalize(obj)`
 * produces the canonical event (sans cost/adapterVersion, which parseLogLine stamps).
 * ADDING A FUTURE FORMAT = appending one entry here — the whole point of the quarantine.
 *
 * Each entry: { version, detect(obj)->boolean, normalize(obj)->partialEvent }.
 */
export const ADAPTER_VERSIONS = [
  {
    version: 'v1-claude-jsonl-2026-07',
    detect(obj) {
      return !!(
        obj &&
        obj.type === 'assistant' &&
        obj.message &&
        typeof obj.message === 'object' &&
        obj.message.usage &&
        typeof obj.message.usage === 'object'
      )
    },
    normalize(obj) {
      const m = obj.message
      const u = m.usage || {}
      const ev = {
        ts: strOr(obj.timestamp, strOr(obj.ts, null)),
        sessionId: strOr(obj.sessionId, ''),
        model: strOr(m.model, ''),
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheCreationTokens: num(u.cache_creation_input_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        isSidechain: obj.isSidechain === true,
      }
      // A line-carried costUSD is captured here; priceEvent decides precedence.
      if (Number.isFinite(Number(obj.costUSD))) ev.costUSD = Number(obj.costUSD)
      // Dedup identity: (message.id : requestId). Only set when message.id exists so
      // a stream of id-less lines is never collapsed into one.
      const mid = strOr(m.id, '')
      if (mid) ev._dedupId = `${mid}:${strOr(obj.requestId, '')}`
      return ev
    },
  },
]

/**
 * hasTokenSignal(obj) — a bounded heuristic: does this object carry token-usage data
 * even though no adapter recognized its SHAPE? Checks the object itself, `obj.usage`,
 * and `obj.message.usage` for any positive input/output/cache token field. A true
 * here on an unrecognized line is the DRIFT signal (`unrecognized`), never a throw.
 */
function hasTokenSignal(obj) {
  if (!obj || typeof obj !== 'object') return false
  const candidates = [obj.usage, obj.message && obj.message.usage, obj]
  const keys = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'inputTokens',
    'outputTokens',
    'cacheCreationTokens',
    'cacheReadTokens',
  ]
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    for (const k of keys) {
      if (num(c[k]) > 0) return true
    }
  }
  return false
}

/**
 * parseLogLine(rawLine, opts) → canonical event | {skip}. JSON-parses the line, walks
 * ADAPTER_VERSIONS in order, and returns the priced+stamped canonical event or a typed
 * skip. Dedup uses the caller-owned `opts.seen` Set (a full-book build dedups ACROSS
 * files by threading ONE set). NEVER throws on any input (outer try/catch → 'corrupt').
 *
 * @param {string} rawLine
 * @param {{seen?:Set<string>}} [opts]
 * @returns {object} canonical event, or {skip:'non-usage'|'corrupt'|'duplicate'|'unrecognized'}
 */
export function parseLogLine(rawLine, opts = {}) {
  try {
    if (typeof rawLine !== 'string' || !rawLine.trim()) return { skip: 'corrupt' }
    let obj
    try {
      obj = JSON.parse(rawLine)
    } catch {
      return { skip: 'corrupt' }
    }
    if (!obj || typeof obj !== 'object') return { skip: 'non-usage' }

    for (const adapter of ADAPTER_VERSIONS) {
      let matched = false
      try {
        matched = adapter.detect(obj) === true
      } catch {
        matched = false
      }
      if (!matched) continue

      let ev = null
      try {
        ev = adapter.normalize(obj)
      } catch {
        ev = null
      }
      if (!ev || typeof ev !== 'object') continue

      ev.adapterVersion = adapter.version

      // Retry dedup: (message.id : requestId), across-file via the caller's Set.
      const dk = ev._dedupId
      if (dk && opts.seen && typeof opts.seen.has === 'function') {
        if (opts.seen.has(dk)) return { skip: 'duplicate' }
        opts.seen.add(dk)
      }
      delete ev._dedupId

      priceEvent(ev)
      return ev
    }

    // No adapter recognized the shape. A line still carrying token usage is DRIFT.
    return hasTokenSignal(obj) ? { skip: 'unrecognized' } : { skip: 'non-usage' }
  } catch {
    return { skip: 'corrupt' } // ultimate fail-open — parseLogLine NEVER throws
  }
}

// ═══════════════════════════ log discovery ══════════════════════════════════════

/**
 * slugForRepoRoot(root) — the vendor's local-project-log directory name derivation:
 * every non-alphanumeric character becomes a dash (case PRESERVED). Verified against
 * a real ~/.claude/projects entry
 * (e.g. `C:\Users\Jane\projects\my-app` → `C--Users-Jane-projects-my-app`). NOTE: we do NOT
 * route through collision.normalizePath here — that lowercases + folds slashes, which
 * would break the case-sensitive vendor slug.
 * @param {string} root
 * @returns {string}
 */
export function slugForRepoRoot(root) {
  return String(root ?? '').replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * discoverLogsDir(opts) → {dir, files}. Resolves the vendor's local session-log dir,
 * precedence: SMA_SPEND_LOGS_DIR env → DI opts.logsDir → `<homedir>/.claude/projects/
 * <slug>/`. `files` is the list of *.jsonl paths in that dir; a MISSING dir yields
 * {dir, files:[]} — an empty book, NEVER an error (fail-open).
 *
 * @param {{env?:object, logsDir?:string, homedir?:string, repoRoot?:string, readdir?:Function}} [opts]
 * @returns {{dir:string, files:string[]}}
 */
export function discoverLogsDir(opts = {}) {
  const env = opts.env || {}
  const homedir = opts.homedir || osHomedir()
  const repoRoot = opts.repoRoot || process.cwd()
  const reader = typeof opts.readdir === 'function' ? opts.readdir : readdirSync

  let dir
  if (env.SMA_SPEND_LOGS_DIR && String(env.SMA_SPEND_LOGS_DIR).trim()) {
    dir = String(env.SMA_SPEND_LOGS_DIR).trim()
  } else if (opts.logsDir) {
    dir = opts.logsDir
  } else {
    dir = join(homedir, '.claude', 'projects', slugForRepoRoot(repoRoot))
  }

  let files = []
  try {
    files = reader(dir)
      .filter((f) => typeof f === 'string' && f.endsWith('.jsonl'))
      .map((f) => join(dir, f))
      .sort()
  } catch {
    files = [] // missing/unreadable dir → an empty book, never an error
  }
  return { dir, files }
}

// ═══════════════════════════ the capability probe (D-9.2-05) ════════════════════

/** The probe version — bump when the native-detection criteria change (V3.2 re-score). */
export const NATIVE_SPEND_PROBE_VERSION = 1

/**
 * The native-sufficiency criteria, encoded as DATA so a V3.2 re-scoring is a re-run,
 * not a rewrite. A native local spend surface must satisfy ALL three WITHOUT network.
 */
export const NATIVE_SPEND_CRITERIA = [
  'per-session spend totals available locally without network',
  'per-model spend totals available locally without network',
  'rolling-window spend totals available locally without network',
]

/**
 * probeNativeSpend({env}) → {native, probeVersion, criteria}. v1: today NO sufficient
 * native LOCAL spend surface exists (Console analytics is network-bound), so native is
 * false unless the versioned test seam SMA_NATIVE_SPEND is truthy. When native, spend.mjs
 * banners "native surface detected — bridge standing down" and spend-check goes silent
 * (the demolition clause, D-9.2-05a). Deterministic, local, no network.
 * @param {{env?:object}} [opts]
 * @returns {{native:boolean, probeVersion:number, criteria:string[]}}
 */
export function probeNativeSpend({ env = {} } = {}) {
  return {
    native: truthy(env.SMA_NATIVE_SPEND),
    probeVersion: NATIVE_SPEND_PROBE_VERSION,
    criteria: NATIVE_SPEND_CRITERIA,
  }
}
