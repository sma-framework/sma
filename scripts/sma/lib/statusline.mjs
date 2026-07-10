/**
 * statusline.mjs — the native Claude Code statusline SEGMENT (9.3-07, D-9.3-13).
 *
 * ONE segment of the founder's existing statusline (NEVER a whole-line takeover)
 * that keeps the coordination + budget state always in view: the terminal's own
 * active claim, today's collision count, the window-budget %, the open gates, and
 * the unscored-predictions count. It is a PURE FUNCTION over INJECTED + CACHED
 * local state (the collision.mjs pure-function-over-injected-state posture): the
 * caller (cli.mjs) runs gatherSummary + resolveTerminalIdentity and hands the
 * summary + own lease IN; this module never re-derives sessions from disk and
 * never imports cli.mjs.
 *
 * FAIL-OPEN EVERYWHERE (carried V1/V2 lock, prohibitions): renderSegment returns
 * '' on any error and readStatuslineState returns an honest all-'—' state — a
 * statusline bug can NEVER wedge a session or print a stack trace onto the trust
 * surface built to create trust. A missing 9.2 module (spend/consequences/breaker)
 * degrades its OWN sub-segment to null (rendered '—'), everything else still works.
 *
 * COST DISCIPLINE (P9.3-07-1): a two-tier TTL cache under dirs.statuslineDir keeps
 * the warm render cheap. The fast tier (window-budget % + open gates) refreshes on
 * STATUSLINE_TTL_MS; the EXPENSIVE unscored-predictions scan refreshes on its own
 * slower PREDS_TTL_MS. A warm render touches ONE json file (cache.json) plus the
 * cheap injected summary + own-lease — no plans walk, no spend rebuild.
 *
 * NO NETWORK IMPORT: this module is display-only. The webhook lives in notify.mjs;
 * statusline.mjs never imports it (nor cli.mjs). The vendor-stdin knowledge is
 * quarantined to parseStatusStdin (the spend-adapter quarantine posture).
 *
 * Node built-ins only; zero npm deps; every fs touch behind try/catch. The .sma
 * dir is dependency-injected (dirs.statuslineDir) — no hardcoded '.sma/' path.
 */

import { join, dirname } from 'node:path'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'

/** Fast-tier cache TTL (window-budget % + open gates). 15 s — cheap enough for the
 * per-update statusline cadence, fresh enough that a just-tripped gate shows quickly. */
export const STATUSLINE_TTL_MS = 15000

/** Slow-tier cache TTL for the EXPENSIVE unscored-predictions plans scan. 2 min — the
 * scan reads every phase PLAN.md, so it refreshes far less often than the fast tier. */
export const PREDS_TTL_MS = 120000

/** Per-render timeout for the WRAPPED user statusline command (composition). User code —
 * a hung command is cut here and the render falls back to the SMA segment alone (fail-open,
 * never a blank line). 2000 ms, NOT lower: a bare `node` child under a Windows shell measures
 * ~815 ms startup on the reference machine (Defender + shims), so a ~900 ms bound made the
 * founder's own statusline.js flaky at the boundary (817 ms OK / 916 ms ETIMEDOUT observed).
 * 2000 ms gives real user statuslines headroom while still bounding a genuine hang. */
export const WRAPPED_TIMEOUT_MS = 2000

/** The three pulse states + their glyphs. Canonical value set lives on the lease as
 * `fpStatus` (registry.FP_STATUS_VALUES, D-9.3-21) and in notify.PULSE_VALUES; kept
 * local here so the display module imports no network/heavy graph. */
const PULSE_GLYPH = { working: '▸', 'waiting-for-human': '◆', idle: '·' }

/**
 * renderSegment(state, opts) — PURE. Deterministic compact one-liner over a fully
 * resolved state; same input -> same output. Sub-segments in FIXED order:
 *   pulse glyph+word · own claim · collision count · window-budget % · open gates · unscored preds
 * A null/absent numeric sub-segment renders '—' (graceful degradation). Never throws.
 * Plain ASCII beside the pulse glyph; ANSI coloring ONLY when opts.ansi.
 *
 * @param {{pulse?:string, claim?:string|null, collisions?:number, windowPct?:number|null, gates?:number|null, unscored?:number|null}} state
 * @param {{ansi?:boolean}} [opts]
 * @returns {string}
 */
export function renderSegment(state = {}, opts = {}) {
  try {
    const s = state && typeof state === 'object' ? state : {}
    const pulse = PULSE_GLYPH[s.pulse] ? s.pulse : 'idle'
    const glyph = PULSE_GLYPH[pulse]
    const claim = typeof s.claim === 'string' && s.claim.trim() ? s.claim.trim() : '—'
    const coll = Number.isFinite(s.collisions) ? s.collisions : 0
    const win = Number.isFinite(s.windowPct) ? `${s.windowPct}%` : '—'
    const gates = Number.isFinite(s.gates) ? String(s.gates) : '—'
    const preds = Number.isFinite(s.unscored) ? String(s.unscored) : '—'

    const parts = [
      `${glyph}${pulse}`,
      `claim ${claim}`,
      `coll ${coll}`,
      `win ${win}`,
      `gates ${gates}`,
      `preds ${preds}`,
    ]
    const seg = 'sma ' + parts.join(' · ')
    return opts && opts.ansi ? colorize(seg, pulse) : seg
  } catch {
    return '' // fail-open — a render bug prints nothing, never a stack trace
  }
}

/** Minimal ANSI coloring of the whole segment by pulse (behind SMA_STATUSLINE_ANSI=1).
 * working=green, waiting-for-human=yellow, idle=dim. Best-effort; never throws. */
function colorize(seg, pulse) {
  const code = pulse === 'waiting-for-human' ? '33' : pulse === 'working' ? '32' : '2'
  return `[${code}m${seg}[0m`
}

/**
 * readStatuslineState(opts) — merge the INJECTED cheap state (summary collisions +
 * own-lease claim/pulse) with the CACHED expensive loaders (spend %, gates, unscored),
 * refreshing each tier only past its TTL. Returns the render-ready state object.
 *
 * The cheap axes (claim, collisions, pulse) are recomputed on every call from the
 * injected summary/ownSession — no fs beyond what the caller already read. The
 * expensive axes (windowPct, gates, unscored) come from the two-tier cache. A corrupt
 * cache.json is treated as absent -> a silent full rebuild (readJsonSafe -> null).
 *
 * @param {{
 *   dirs?:{statuslineDir?:string, spendDir?:string, breakerDir?:string, calibrationDir?:string, smaRoot?:string, repoRoot?:string},
 *   summary?:object, ownSession?:object|null, pulse?:string,
 *   now?:number|Function, force?:boolean,
 *   loaders?:{loadSpend?:Function, loadGates?:Function, loadUnscored?:Function}
 * }} [opts]
 * @returns {Promise<{pulse:string, claim:string|null, collisions:number, windowPct:number|null, gates:number|null, unscored:number|null}>}
 */
export async function readStatuslineState(opts = {}) {
  const fallback = { pulse: 'idle', claim: null, collisions: 0, windowPct: null, gates: null, unscored: null }
  try {
    const dirs = opts.dirs || {}
    const summary = opts.summary || {}
    const ownSession = opts.ownSession || null
    const loaders = opts.loaders || {}
    const now = resolveNow(opts.now)
    const force = !!opts.force

    const cacheFile = dirs.statuslineDir ? join(dirs.statuslineDir, 'cache.json') : null
    const cached = cacheFile ? readJsonSafe(cacheFile) : null
    const cache = cached && typeof cached === 'object' ? cached : {}

    // ── fast tier: window-budget % + open gates ──────────────────────────────
    let fast = cache.fast && typeof cache.fast === 'object' ? cache.fast : null
    const fastFresh = !force && fast && Number.isFinite(fast.refreshedAt) && now - fast.refreshedAt < STATUSLINE_TTL_MS
    if (!fastFresh) {
      const windowPct = await safeLoad(loaders.loadSpend || defaultLoadSpend, dirs)
      const gates = await safeLoad(loaders.loadGates || defaultLoadGates, dirs)
      fast = { windowPct, gates, refreshedAt: now }
    }

    // ── slow tier: the expensive unscored-predictions scan ───────────────────
    let preds = cache.preds && typeof cache.preds === 'object' ? cache.preds : null
    const predsFresh = !force && preds && Number.isFinite(preds.refreshedAt) && now - preds.refreshedAt < PREDS_TTL_MS
    if (!predsFresh) {
      const unscored = await safeLoad(loaders.loadUnscored || defaultLoadUnscored, dirs)
      preds = { unscored, refreshedAt: now }
    }

    if ((!fastFresh || !predsFresh) && cacheFile) {
      try {
        atomicWriteJson(cacheFile, { fast, preds })
      } catch {
        /* fail-open — a cache-write failure only costs a recompute next call */
      }
    }

    return {
      pulse: resolvePulse(opts.pulse, ownSession),
      claim: ownClaimLabel(ownSession),
      collisions: Number.isFinite(summary.collisions) ? summary.collisions : 0,
      windowPct: numOrNull(fast.windowPct),
      gates: numOrNull(fast.gates),
      unscored: numOrNull(preds.unscored),
    }
  } catch {
    return fallback // fail-open — honest empty state, never a throw
  }
}

/**
 * refreshCache(opts) — force a full two-tier rebuild + cache write, returning the
 * fresh state. The `statusline install`/manual-refresh entry when a stale render is
 * suspected. Never throws (delegates to readStatuslineState with force).
 * @param {object} [opts] same shape as readStatuslineState
 * @returns {Promise<object>}
 */
export async function refreshCache(opts = {}) {
  return readStatuslineState({ ...opts, force: true })
}

/**
 * parseStatusStdin(raw) — the QUARANTINED vendor-stdin adapter. Claude Code pipes a
 * status JSON (session/model/workspace/cost shape) to a statusLine command on stdin;
 * this is the ONLY function in the module that knows that shape. It extracts ONLY the
 * tolerated optional display extras {modelName?, contextPct?}; garbage bytes, an empty
 * string, or an unfamiliar shape return {} — it NEVER throws (the spend-adapter
 * quarantine posture: one function owns the foreign shape, the rest stay pure).
 * @param {string} raw
 * @returns {{modelName?:string, contextPct?:number}}
 */
export function parseStatusStdin(raw) {
  try {
    if (!raw || !String(raw).trim()) return {}
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out = {}
    const model = obj.model
    if (model && typeof model === 'object') {
      const name = model.display_name ?? model.displayName ?? model.id
      if (typeof name === 'string' && name.trim()) out.modelName = name.trim()
    }
    // context percentage — tolerate a couple of shapes; never required.
    const ctx = obj.context && typeof obj.context === 'object' ? obj.context : obj.cost && typeof obj.cost === 'object' ? obj.cost : null
    if (ctx) {
      const pct = ctx.used_pct ?? ctx.usedPct ?? ctx.context_pct ?? ctx.contextPct
      if (Number.isFinite(pct)) out.contextPct = pct
    }
    return out
  } catch {
    return {} // fail-open — vendor stdin never breaks the statusline
  }
}

// ── COMPOSITION with a pre-existing user statusline (segment-not-takeover, D-9.3-13) ──
//
// A PROJECT-scope statusLine entry SHADOWS the user-scope ~/.claude/settings.json one in
// Claude Code — installing our segment must not cost the adopter the statusline they
// already had (context %, window budgets, anything). So the render COMPOSES: the user's
// own line runs FIRST (their info is primary), then ' · ' + the SMA segment. Resolution
// is fail-open and zero-config: an explicit wrapped-command.json wins; else the USER-scope
// settings.json statusLine.command is auto-detected (skipped iff it is our own invocation —
// the self-reference guard, or the compose would recurse). The wrapped call is USER CODE
// and is deliberately NOT TTL-cached — their context % changes every turn; the p95
// instrument (bench-render-p95-ms) measures the SMA segment alone, by design.

/** True when a statusLine command already points into our own cli.mjs statusline —
 * the self-reference guard (kept in sync with cli.mjs's install-idempotence copy). */
export function isSmaStatuslineCmd(cmd) {
  return typeof cmd === 'string' && /scripts[\\/]+sma[\\/]+cli\.mjs\s+statusline/.test(cmd)
}

/**
 * resolveWrappedCommand({dirs, homedirFn, readFn}) — the wrapped-command resolution order:
 *   (a) an explicit `command` in dirs.statuslineDir/wrapped-command.json (set by
 *       `statusline install` when it wrapped a pre-existing project command) wins;
 *   (b) else AUTO-DETECT: the USER-scope ~/.claude/settings.json statusLine.command,
 *       used iff present and NOT our own invocation (self-reference guard).
 * Returns {command, source:'config'|'user-scope'} or null. Fail-open: any error -> null.
 * @param {{dirs?:object, homedirFn?:Function, readFn?:Function}} [opts]
 * @returns {{command:string, source:string}|null}
 */
export function resolveWrappedCommand(opts = {}) {
  try {
    const dirs = opts.dirs || {}
    // (a) explicit config — install-wrap provenance wins.
    if (dirs.statuslineDir) {
      const stored = readJsonSafe(join(dirs.statuslineDir, 'wrapped-command.json'), opts.readFn ? { readFn: opts.readFn } : undefined)
      if (stored && typeof stored.command === 'string' && stored.command.trim()) {
        return { command: stored.command.trim(), source: 'config' }
      }
    }
    // (b) auto-detect the USER-scope statusline (the shadowed one).
    const home = typeof opts.homedirFn === 'function' ? opts.homedirFn() : homedir()
    if (!home) return null
    const settings = readJsonSafe(join(home, '.claude', 'settings.json'), opts.readFn ? { readFn: opts.readFn } : undefined)
    const sl = settings && settings.statusLine
    const cmd = sl && typeof sl === 'object' ? sl.command : typeof sl === 'string' ? sl : null
    if (typeof cmd === 'string' && cmd.trim() && !isSmaStatuslineCmd(cmd)) {
      return { command: cmd.trim(), source: 'user-scope' }
    }
    return null
  } catch {
    return null // fail-open — no wrapped line, the segment renders alone
  }
}

/**
 * runWrappedCommand(command, {stdin, execFn, timeoutMs}) — execute the user's own statusline
 * command with the SAME raw stdin bytes Claude Code piped to us (byte-identical passthrough),
 * inherited env, WRAPPED_TIMEOUT_MS timeout, bounded output. Returns the FIRST output line
 * with the trailing newline stripped — ANSI escapes pass through UNTOUCHED (their colors are
 * theirs). Any error / timeout / empty output -> '' (the caller composes the segment alone).
 * NOT TTL-cached by design: user code, fresh every render (context % changes every turn).
 * @param {string} command
 * @param {{stdin?:string, execFn?:Function, timeoutMs?:number}} [opts]
 * @returns {string}
 */
export function runWrappedCommand(command, opts = {}) {
  try {
    if (typeof command !== 'string' || !command.trim()) return ''
    const execFn =
      typeof opts.execFn === 'function'
        ? opts.execFn
        : (cmd, o) => execSync(cmd, { ...o, shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const out = execFn(command, {
      input: typeof opts.stdin === 'string' ? opts.stdin : '',
      timeout: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : WRAPPED_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    })
    const text = out == null ? '' : out.toString('utf8')
    // FIRST line only, trailing CR/LF stripped; leading bytes (incl. ANSI) untouched.
    return (text.split('\n')[0] || '').replace(/\r$/, '')
  } catch {
    return '' // non-zero exit / timeout / over-buffer -> segment alone (fail-open)
  }
}

/**
 * composeStatusline(wrappedLine, segment) — the render order contract: the user's own line
 * FIRST (their context/window info is primary), then ' · ' + the SMA segment. An empty
 * wrapped line composes to the segment alone. Pure; never throws.
 * @param {string} wrappedLine
 * @param {string} segment
 * @returns {string}
 */
export function composeStatusline(wrappedLine, segment) {
  const seg = typeof segment === 'string' ? segment : ''
  const w = typeof wrappedLine === 'string' ? wrappedLine.replace(/[\r\n]+$/, '') : ''
  return w ? `${w} · ${seg}` : seg
}

/**
 * countUnscoredPredictions({phasesDir, calibrationDir}) — the unscored math, exported
 * for direct testing. Scans every `*-PLAN.md` under phasesDir for prediction ids, reads
 * the calibration ledger for ids that already carry a verdict, and returns the count of
 * plan ids WITHOUT a verdict. A plan with malformed frontmatter is skipped-and-counted
 * (never fatal). Returns null when the phases tree cannot be read at all (renders '—').
 * @param {{phasesDir?:string, calibrationDir?:string}} opts
 * @returns {Promise<number|null>}
 */
export async function countUnscoredPredictions(opts = {}) {
  try {
    const predict = await import('./predict.mjs')
    const calibration = await import('./calibration.mjs')
    const phasesDir = opts.phasesDir
    if (!phasesDir) return null

    let phaseDirs
    try {
      phaseDirs = readdirSync(phasesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return null // no phases tree here (e.g. the sma repo itself) -> honest '—'
    }

    // scored ids: any ledger record carrying an id AND a verdict.
    const scored = new Set()
    try {
      const { records } = calibration.readLedger({ calibrationDir: opts.calibrationDir })
      for (const r of records || []) {
        if (r && typeof r.id === 'string' && r.verdict != null && r.verdict !== '') scored.add(r.id)
      }
    } catch {
      /* fail-open — an unreadable ledger just means nothing is scored yet */
    }

    const ids = new Set()
    for (const pd of phaseDirs) {
      let planFiles
      try {
        planFiles = readdirSync(join(phasesDir, pd)).filter((f) => /-PLAN\.md$/i.test(f))
      } catch {
        continue // unreadable phase dir -> skip
      }
      for (const pf of planFiles) {
        try {
          const { predictions } = predict.parsePredictions(join(phasesDir, pd, pf))
          for (const p of predictions || []) {
            if (p && typeof p.id === 'string' && p.id.trim()) ids.add(p.id.trim())
          }
        } catch {
          /* malformed frontmatter -> skipped-and-counted, never fatal */
        }
      }
    }

    let unscored = 0
    for (const id of ids) if (!scored.has(id)) unscored += 1
    return unscored
  } catch {
    return null
  }
}

// ── default lazy-tolerant loaders (each individually try/caught; absence -> null) ──

/** window-budget % from spend.mjs (9.2-09); null when no cap set or the module is absent. */
async function defaultLoadSpend(dirs = {}) {
  try {
    const spend = await import('./spend.mjs')
    const spendDir = dirs.spendDir
    if (!spendDir) return null
    const budget = spend.readBudget({ spendDir })
    if (!Number.isFinite(budget.capUsd) || budget.capUsd <= 0) return null // report-only cap -> '—'
    const book = spend.buildBook({ spendDir, repoRoot: dirs.repoRoot, env: process.env, persist: false })
    const win = spend.windowSpend({ book, windowHours: budget.windowHours })
    return Math.round((win.usd / budget.capUsd) * 100)
  } catch {
    return null // module absent / shape drift -> '—'
  }
}

/** open-gates count = consequences openBlocks (9.2-08) + tripped breaker markers
 * (9.2-09); null ONLY when BOTH modules are absent (so a genuine 0 shows as 0). */
async function defaultLoadGates(dirs = {}) {
  let any = false
  let count = 0
  try {
    const consequences = await import('./consequences.mjs')
    const { blocks } = consequences.openBlocks({ calibrationDir: dirs.calibrationDir })
    count += Array.isArray(blocks) ? blocks.length : 0
    any = true
  } catch {
    /* consequences absent */
  }
  try {
    const breaker = await import('./breaker.mjs')
    const markers = breaker.listMarkers({ breakerDir: dirs.breakerDir })
    count += Array.isArray(markers) ? markers.length : 0
    any = true
  } catch {
    /* breaker absent */
  }
  return any ? count : null
}

/** unscored-predictions count over the repo's .planning/phases tree; null when absent. */
async function defaultLoadUnscored(dirs = {}) {
  const repoRoot = dirs.repoRoot || (dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd())
  return countUnscoredPredictions({
    phasesDir: join(repoRoot, '.planning', 'phases'),
    calibrationDir: dirs.calibrationDir,
  })
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** now as a number: a function is called, a finite number used verbatim, else Date.now(). */
function resolveNow(now) {
  if (typeof now === 'function') return now()
  return Number.isFinite(now) ? now : Date.now()
}

/** Await a loader fn and normalize its result to a finite number or null. Never throws. */
async function safeLoad(fn, dirs) {
  if (typeof fn !== 'function') return null
  try {
    const v = await fn(dirs)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** A finite number passes through; anything else (null/undefined/NaN) -> null. */
function numOrNull(v) {
  return Number.isFinite(v) ? v : null
}

/** The own-claim label: the lease work label (FI-10), else the claimed scope description,
 * else null (rendered '—' = unclaimed). 'idle' work label counts as unclaimed. */
function ownClaimLabel(lease) {
  if (!lease || typeof lease !== 'object') return null
  const label = typeof lease.label === 'string' ? lease.label.trim() : ''
  if (label && label !== 'idle') return label
  const desc = lease.scope && typeof lease.scope.description === 'string' ? lease.scope.description.trim() : ''
  return desc || null
}

/** The pulse to render: an explicitly-derived value wins (notify.derivePulse in the CLI),
 * else the lease's own fpStatus (the attention axis, D-9.3-21), else idle. */
function resolvePulse(explicit, lease) {
  if (PULSE_GLYPH[explicit]) return explicit
  if (lease && typeof lease === 'object' && PULSE_GLYPH[lease.fpStatus]) return lease.fpStatus
  return 'idle'
}
