/**
 * subagent-receipts.mjs — transcript claim extraction + tree verification + the
 * shared-journal receipt (49.2-04, D-49.2-10).
 *
 * The workspace paper's finding: an agent's self-report is structurally incomplete,
 * so «done» must rest on observable tree consequences, never on the subagent's word.
 * On SubagentStop this module extracts every CLAIMED file write from the transcript
 * (tool-call tier = the Write/Edit/MultiEdit/NotebookEdit tool_use lines; asserted
 * tier = write-verb sentences in the FINAL assistant message), verifies each against
 * the REAL git tree (existence + dirty-state + commits-since-spawn), and lands ONE
 * hash-chained journal receipt with per-claim verdicts. Phantom writes (claimed but
 * absent / tree-unchanged) are flagged deterministically, zero LLM.
 *
 * Design invariants:
 *   - DI everywhere ({runGit, statFile, appendEvent, now, readFn}) so tests never
 *     shell out or touch git. The CLI wires runGit = execFileSync('git', args) with
 *     arg arrays and a literal `--` before every claimed path (no shell string is
 *     ever built from transcript content — T-49.2-04-C).
 *   - The tree is the only witness: a subagent's self-report is NEVER trusted as
 *     evidence of a write (D-49.2-10). verifyWrites never throws on a malformed
 *     claim — a null/outside-repo path scores 'unverifiable', never a phantom.
 *   - Receipts ride journal.mjs appendEvent UNCHANGED — plan 03's hash chain then
 *     covers receipt lines for free (D-49.2-07). This module re-implements nothing.
 *   - transcriptSha pins WHAT was verified so plan 10's 5% audit re-derives the
 *     same verdicts (D-49.2-14 hook).
 *
 * Node built-ins only; no child_process (git is injected), no network, no LLM.
 */

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * VERDICTS — the fixed enum plan 01's bench and plan 10's audit consume. A recorded
 * verdict is ALWAYS one of these five (never a free string).
 */
export const VERDICTS = ['verified', 'phantom-missing', 'phantom-unchanged', 'divergent', 'unverifiable']

/** The four write tools whose tool_use lines are tool-call-tier claims. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** A write verb on the SAME line as a path token makes an asserted-tier claim. */
const WRITE_VERB = /(wrote|created|updated|added|modified)\b/i

/**
 * A repo-relative path token with a real (letter-initial) file extension. The
 * letter-initial extension excludes version numbers («3.14») from inflating the
 * asserted denominator — a read-mention without a write verb is never a claim.
 */
const PATH_TOKEN = /([A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[A-Za-z][A-Za-z0-9]*)/g

/** The content[] array of a transcript entry (tolerant of message-wrapped shapes). */
function contentItems(entry) {
  if (!entry) return []
  const m = entry.message && typeof entry.message === 'object' ? entry.message : entry
  return Array.isArray(m.content) ? m.content : []
}

/** The role/type of a transcript entry ('assistant' | 'user' | …). */
function roleOf(entry) {
  if (!entry) return ''
  if (entry.message && entry.message.role) return String(entry.message.role)
  if (entry.role) return String(entry.role)
  if (entry.type) return String(entry.type)
  return ''
}

/** Concatenated text of an assistant entry (text content items, or a string body). */
function assistantText(entry) {
  const items = contentItems(entry)
  if (items.length) {
    return items
      .filter((i) => i && i.type === 'text' && typeof i.text === 'string')
      .map((i) => i.text)
      .join('\n')
  }
  const m = entry.message && typeof entry.message === 'object' ? entry.message : entry
  if (typeof m.content === 'string') return m.content
  if (typeof m.text === 'string') return m.text
  return ''
}

/**
 * extractClaimedWrites(transcriptPath, opts) -> {claims, corrupt, sha}. Tolerant
 * line-wise JSON parse (corrupt lines skipped-and-counted, never a throw). Two tiers:
 *   - tool-call: every Write|Edit|MultiEdit|NotebookEdit tool_use, path from
 *     input.file_path / input.notebook_path, toolResultOk from the paired
 *     tool_result (is_error absent/false -> ok).
 *   - asserted: in the FINAL assistant message only, a write-verb line's path tokens.
 * sha = sha256 of the transcript bytes (pins WHAT was verified).
 *
 * @param {string} transcriptPath
 * @param {{readFn?:(p:string)=>string}} [opts]  inject readFn so tests never touch disk
 * @returns {{claims:Array<{path:(string|null), tier:string, toolResultOk:boolean}>, corrupt:number, sha:(string|null)}}
 */
export function extractClaimedWrites(transcriptPath, opts = {}) {
  const readFn = opts.readFn ?? ((p) => readFileSync(p, 'utf8'))
  let raw
  try {
    raw = readFn(transcriptPath)
  } catch {
    return { claims: [], corrupt: 0, sha: null } // missing transcript -> honest empty (fail-open)
  }
  const sha = createHash('sha256').update(String(raw), 'utf8').digest('hex')

  const parsed = []
  let corrupt = 0
  for (const line of String(raw).split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      parsed.push(JSON.parse(t))
    } catch {
      corrupt += 1 // fail-open — skip-and-count (journal.mjs posture)
    }
  }

  // tool_result pairing: tool_use id -> is_error (true means the tool call failed).
  const resultErr = new Map()
  for (const entry of parsed) {
    for (const item of contentItems(entry)) {
      if (item && item.type === 'tool_result' && item.tool_use_id != null) {
        resultErr.set(String(item.tool_use_id), item.is_error === true)
      }
    }
  }

  const claims = []

  // tool-call tier: the four write tools.
  for (const entry of parsed) {
    for (const item of contentItems(entry)) {
      if (item && item.type === 'tool_use' && WRITE_TOOLS.has(item.name)) {
        const input = item.input && typeof item.input === 'object' ? item.input : {}
        const path =
          typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.notebook_path === 'string'
              ? input.notebook_path
              : null
        const id = item.id != null ? String(item.id) : null
        claims.push({ path, tier: 'tool-call', toolResultOk: resultErr.get(id) !== true })
      }
    }
  }

  // asserted tier: the FINAL assistant message only.
  let finalText = ''
  for (const entry of parsed) {
    if (roleOf(entry) === 'assistant') {
      const txt = assistantText(entry)
      if (txt) finalText = txt // keep the LAST assistant text
    }
  }
  for (const rawLine of finalText.split('\n')) {
    if (!WRITE_VERB.test(rawLine)) continue // read-mentions without a verb do not inflate the denominator
    let m
    PATH_TOKEN.lastIndex = 0
    while ((m = PATH_TOKEN.exec(rawLine)) !== null) {
      claims.push({ path: m[1], tier: 'asserted', toolResultOk: true })
    }
  }

  return { claims, corrupt, sha }
}

/** True when abs is repoRoot or strictly inside it (boundary-safe, not a glob prefix). */
function insideRepo(abs, repoRoot) {
  return abs === repoRoot || abs.startsWith(repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep)
}

/** Verify a single claim against the tree. Never throws. */
function verifyOne(c, { repoRoot, spawnedAt, runGit, statFile }) {
  const tier = c && c.tier ? c.tier : 'tool-call'
  const path = c && typeof c.path === 'string' ? c.path : null
  const base = { path, tier }

  // malformed / outside-repo -> unverifiable (WARN, never a phantom).
  if (!path) return { ...base, verdict: 'unverifiable', reason: 'no-path' }
  let abs
  try {
    abs = resolve(repoRoot, path)
  } catch {
    return { ...base, verdict: 'unverifiable', reason: 'unresolvable' }
  }
  if (!insideRepo(abs, repoRoot)) return { ...base, verdict: 'unverifiable', reason: 'outside-repo' }

  // the tool call errored yet the write is claimed -> divergent (report says done, git said no).
  if (c.toolResultOk === false) return { ...base, verdict: 'divergent', reason: 'tool-error-claimed' }

  // disk truth first — missing means phantom no matter what the report says.
  let exists = false
  try {
    exists = !!(typeof statFile === 'function' ? statFile(abs) : false)
  } catch {
    exists = false
  }
  if (!exists) return { ...base, verdict: 'phantom-missing' }

  // exists + dirty in the working tree -> verified.
  let porcelain = ''
  try {
    porcelain = typeof runGit === 'function' ? String(runGit('status', ['--porcelain', '--', path]) ?? '') : ''
  } catch {
    porcelain = ''
  }
  if (porcelain.trim()) return { ...base, verdict: 'verified', reason: 'dirty' }

  // exists + clean + at least one commit since spawn -> verified; else phantom-unchanged.
  let log = ''
  try {
    const args = ['--format=%H']
    if (spawnedAt) args.unshift(`--since=${spawnedAt}`)
    args.push('--', path)
    log = typeof runGit === 'function' ? String(runGit('log', args) ?? '') : ''
  } catch {
    log = ''
  }
  if (log.trim()) return { ...base, verdict: 'verified', reason: 'committed' }
  return { ...base, verdict: 'phantom-unchanged' }
}

/**
 * verifyWrites(claims, {repoRoot, spawnedAt, runGit, statFile}) -> [{path, tier,
 * verdict, reason?}]. The verdict matrix (D-49.2-10):
 *   exists + dirty                         -> verified
 *   exists + clean + commit since spawn    -> verified
 *   exists + clean + no commit since spawn -> phantom-unchanged
 *   missing from disk                      -> phantom-missing
 *   tool_result errored but still claimed  -> divergent
 *   path outside repoRoot / malformed      -> unverifiable
 * runGit is invoked as (cmd, argsArray) with a literal `--` before every path.
 * Never throws.
 */
export function verifyWrites(claims, opts = {}) {
  // Normalize repoRoot to the OS-native form (resolve() output uses OS separators):
  // in production repoRoot arrives forward-slashed (registry.smaRoot normalizes to '/'),
  // but resolve(repoRoot, path) yields backslashes on Windows — comparing the two raw
  // would score EVERY claim 'unverifiable' on Windows. Resolving both sides fixes it.
  const repoRoot = resolve(opts.repoRoot ?? process.cwd())
  const ctx = { repoRoot, spawnedAt: opts.spawnedAt, runGit: opts.runGit, statFile: opts.statFile }
  return (Array.isArray(claims) ? claims : []).map((c) => verifyOne(c, ctx))
}

/** Per-tier phantom / verdict tally over a verified-claim list. */
function computeCounts(verdicts) {
  const counts = { verified: 0, phantomToolCall: 0, phantomAsserted: 0, divergent: 0, unverifiable: 0 }
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    if (!v) continue
    if (v.verdict === 'verified') counts.verified += 1
    else if (v.verdict === 'divergent') counts.divergent += 1
    else if (v.verdict === 'unverifiable') counts.unverifiable += 1
    else if (v.verdict === 'phantom-missing' || v.verdict === 'phantom-unchanged') {
      if (v.tier === 'asserted') counts.phantomAsserted += 1
      else counts.phantomToolCall += 1
    }
  }
  return counts
}

/**
 * correlateSpawn(records, {windowToken, at}) -> the nearest-in-time UNCONSUMED spawn
 * record for a parent window, or null (a missing record still lands a receipt with
 * spawn:null — fail-open honest). Scoped to the window token when given, else the
 * whole unconsumed pool.
 */
export function correlateSpawn(records, o = {}) {
  const unconsumed = (Array.isArray(records) ? records : []).filter((r) => r && !r.consumed)
  const scoped = o.windowToken ? unconsumed.filter((r) => r.windowToken === o.windowToken) : unconsumed
  const pool = scoped.length ? scoped : unconsumed
  if (!pool.length) return null
  const t = o.at ? Date.parse(o.at) : NaN
  if (!Number.isFinite(t)) return pool[0]
  let best = pool[0]
  let bestDelta = Infinity
  for (const r of pool) {
    const rt = r.at ? Date.parse(r.at) : NaN
    const d = Number.isFinite(rt) ? Math.abs(rt - t) : Infinity
    if (d < bestDelta) {
      bestDelta = d
      best = r
    }
  }
  return best
}

/**
 * writeReceipt({verdicts, transcriptSha, spawn}, {appendEvent, terminalId, journalDir})
 * -> the receipt record. Appends EXACTLY ONE journal event
 * `{type:'subagent-receipt', detail:{claims, counts, spawn, transcriptSha}}` via the
 * injected appendEvent (rides journal.mjs unchanged — the hash chain covers it).
 * A missing spawn record still lands a receipt with spawn:null.
 */
export function writeReceipt(args = {}, opts = {}) {
  const verdicts = Array.isArray(args.verdicts) ? args.verdicts : []
  const record = {
    type: 'subagent-receipt',
    detail: {
      claims: verdicts,
      counts: computeCounts(verdicts),
      spawn: args.spawn ?? null,
      transcriptSha: args.transcriptSha ?? null,
    },
  }
  if (typeof opts.appendEvent === 'function') {
    opts.appendEvent(record, { terminalId: opts.terminalId, journalDir: opts.journalDir })
  }
  return record
}

/** p95-style nearest-rank percentile over a numeric list (0 for empty). */
function percentile(values, p) {
  const arr = (Array.isArray(values) ? values : []).slice().sort((a, b) => a - b)
  if (!arr.length) return 0
  const rank = Math.ceil((p / 100) * arr.length)
  return arr[Math.min(arr.length - 1, Math.max(0, rank - 1))]
}

/**
 * receiptStats(events) -> {coverage, phantoms, phantomsAsserted, packP95, spawnRecords,
 * receipts, empty}. Over the shared journal events:
 *   - coverage  = 100 * receipts / spawnRecords ('subagent-pack' events); 100 when empty
 *   - phantoms  = tool-call-tier phantom count (the ==0 prediction's instrument)
 *   - phantomsAsserted = asserted-tier phantoms, counted SEPARATELY (plan 10's audit)
 *   - packP95   = p95 of durationMs over 'subagent-pack' events
 * Honest empty: zero spawns -> coverage 100, phantoms 0, packP95 0, empty:true.
 */
export function receiptStats(events = []) {
  const list = Array.isArray(events) ? events : []
  const packs = list.filter((e) => e && e.type === 'subagent-pack')
  const receipts = list.filter((e) => e && e.type === 'subagent-receipt')
  const spawnRecords = packs.length

  const coverage = spawnRecords === 0 ? 100 : Math.round((100 * receipts.length) / spawnRecords)

  let phantoms = 0
  let phantomsAsserted = 0
  for (const r of receipts) {
    const c = r.detail && r.detail.counts ? r.detail.counts : {}
    phantoms += Number(c.phantomToolCall) || 0
    phantomsAsserted += Number(c.phantomAsserted) || 0
  }

  const durations = packs
    .map((e) => e.detail && Number(e.detail.durationMs))
    .filter((n) => Number.isFinite(n))
  const packP95 = durations.length ? percentile(durations, 95) : 0

  return {
    coverage,
    phantoms,
    phantomsAsserted,
    packP95,
    spawnRecords,
    receipts: receipts.length,
    empty: spawnRecords === 0 && receipts.length === 0,
  }
}
