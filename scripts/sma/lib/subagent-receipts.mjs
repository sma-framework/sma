/**
 * subagent-receipts.mjs — transcript claim extraction + tree verification + the
 * shared-journal receipt (9.2-04, D-9.2-10).
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
 * Asserted-tier precision (BL-173, 9.4-03; forensics 9.3-PHANTOM-FORENSICS.md proved
 * all 9 asserted phantoms were instrument noise, 0 real). Three false-positive
 * mechanisms fixed:
 *   1. Repo-root basename resolution — a bare basename («Wrote 46.2-DOD.json») no longer
 *      resolves to <repo>/basename → phantom; it cross-matches the SAME receipt's
 *      tool-call paths (endsWith), then `git ls-files`, and demotes to
 *      `unverifiable: ambiguous-basename` when unresolved. NEVER phantom for a bare
 *      basename, NEVER promoted to verified without tool-call or tree evidence.
 *   2. Write-verb line sweep — a NEGATION_STOPLIST (by another terminal / not in /
 *      foreign / untracked / confirmed) + a verb↔token proximity window keep disclaimers
 *      and status reports from becoming asserted write claims.
 *   3. Duplicate receipts — receiptStats dedupes by transcriptSha (dedupeByTranscriptSha),
 *      so an unchanged transcript re-receipted N times counts ONCE.
 *
 * Design invariants:
 *   - DI everywhere ({runGit, statFile, appendEvent, now, readFn}) so tests never
 *     shell out or touch git. The CLI wires runGit = execFileSync('git', args) with
 *     arg arrays and a literal `--` before every claimed path (no shell string is
 *     ever built from transcript content — T-9.2-04-C).
 *   - The tree is the only witness: a subagent's self-report is NEVER trusted as
 *     evidence of a write (D-9.2-10). verifyWrites never throws on a malformed
 *     claim — a null/outside-repo path scores 'unverifiable', never a phantom.
 *   - Receipts ride journal.mjs appendEvent UNCHANGED — plan 03's hash chain then
 *     covers receipt lines for free (D-9.2-07). This module re-implements nothing.
 *   - transcriptSha pins WHAT was verified so plan 10's 5% audit re-derives the
 *     same verdicts (D-9.2-14 hook).
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
 * NEGATION_STOPLIST (BL-173 mechanism 2, forensics rows 2/7/8) — sentence-context
 * markers that turn a write-verb line into a DISCLAIMER or status report, never a
 * first-person write claim: «modified by another terminal», «confirmed foreign/
 * untracked», «modified but not in any commit». A line whose lowercased text hits any
 * of these yields NO asserted claim, even if it carries a write verb + path token.
 */
export const NEGATION_STOPLIST = ['by another terminal', 'not in', 'foreign', 'untracked', 'confirmed']

/**
 * Max character distance between a write verb and a path token for the token to be an
 * asserted claim (BL-173 mechanism 2, proximity guard). A path token far from every
 * write verb on the line (e.g. a status mention that shares a line with an unrelated
 * write) is not a claim. Generous so genuine adjacent claims («Wrote X.json») always land.
 */
const VERB_PROXIMITY = 60

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
    // mechanism 2: a disclaimer / status-report line (negation or foreign attribution)
    // is never a first-person write claim — drop the whole line.
    const lower = rawLine.toLowerCase()
    if (NEGATION_STOPLIST.some((phrase) => lower.includes(phrase))) continue
    // collect every write-verb position on the line for the proximity check.
    const verbPositions = []
    const verbRe = new RegExp(WRITE_VERB.source, 'gi')
    let vm
    while ((vm = verbRe.exec(rawLine)) !== null) verbPositions.push(vm.index)
    let m
    PATH_TOKEN.lastIndex = 0
    while ((m = PATH_TOKEN.exec(rawLine)) !== null) {
      // mechanism 2: only a path token WITHIN the proximity window of some write verb
      // is a claim (a token far from every verb is an incidental mention, not a write).
      const near = verbPositions.some((vp) => Math.abs(vp - m.index) <= VERB_PROXIMITY)
      if (near) claims.push({ path: m[1], tier: 'asserted', toolResultOk: true })
    }
  }

  return { claims, corrupt, sha }
}

/** True when abs is repoRoot or strictly inside it (boundary-safe, not a glob prefix). */
function insideRepo(abs, repoRoot) {
  return abs === repoRoot || abs.startsWith(repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep)
}

/** True when path is a bare basename (no directory separator, either slash flavor). */
function isBareBasename(path) {
  return !path.includes('/') && !path.includes('\\')
}

/**
 * Resolve a bare-basename claim WITHOUT ever scoring it phantom (BL-173 mechanism 1,
 * forensics rows 1/3/4/9). Prose names files by basename («Wrote 46.2-DOD.json»), which
 * `resolve(repoRoot, basename)` would falsely map to <repo>/basename → phantom-missing.
 * Instead:
 *   (a) endsWith-match the basename against the SAME receipt's tool-call claim paths
 *       -> verified (reason basename-crossmatch), the tree-as-witness the receipt already holds;
 *   (b) else `git ls-files` for the basename — EXACTLY one hit -> verified (basename-lsfiles);
 *   (c) else (zero or multiple hits) -> unverifiable: ambiguous-basename.
 * NEVER phantom, NEVER verified without tool-call or tree evidence.
 */
function resolveBasename(base, path, { runGit, toolCallPaths }) {
  const tcPaths = Array.isArray(toolCallPaths) ? toolCallPaths : []
  if (tcPaths.some((tp) => typeof tp === 'string' && tp.endsWith(path))) {
    return { ...base, verdict: 'verified', reason: 'basename-crossmatch' }
  }
  let hits = []
  try {
    const out = typeof runGit === 'function' ? String(runGit('ls-files', ['--', path, `*/${path}`]) ?? '') : ''
    hits = out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    hits = []
  }
  if (hits.length === 1) return { ...base, verdict: 'verified', reason: 'basename-lsfiles' }
  return { ...base, verdict: 'unverifiable', reason: 'ambiguous-basename' }
}

/** Verify a single claim against the tree. Never throws. */
function verifyOne(c, { repoRoot, spawnedAt, runGit, statFile, toolCallPaths }) {
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

  // mechanism 1: an ASSERTED bare basename (prose naming a file by name, «Wrote
  // 46.2-DOD.json») resolves against the receipt's own tool-call paths / the tree BEFORE
  // any repo-root disk check — never phantom for a basename. Tool-call claims carry an
  // authoritative file_path from the tool input and keep the normal disk/git checks.
  if (tier === 'asserted' && isBareBasename(path)) return resolveBasename(base, path, { runGit, toolCallPaths })

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
 * verdict, reason?}]. The verdict matrix (D-9.2-10):
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
  const claimList = Array.isArray(claims) ? claims : []
  // The receipt's own tool-call claim paths — the witness for the basename cross-match
  // (mechanism 1). A basename asserted in prose is verified when its full path was
  // tool-called in the SAME receipt.
  const toolCallPaths = claimList
    .filter((c) => c && c.tier === 'tool-call' && typeof c.path === 'string')
    .map((c) => c.path)
  const ctx = {
    repoRoot,
    spawnedAt: opts.spawnedAt,
    runGit: opts.runGit,
    statFile: opts.statFile,
    toolCallPaths,
  }
  return claimList.map((c) => verifyOne(c, ctx))
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
 * dedupeByTranscriptSha(events) -> events with duplicate receipts collapsed (BL-173
 * mechanism 3, forensics rows 5/6). An unchanged transcript re-receipted N times (same
 * `detail.transcriptSha`, identical claims by construction) is a double-COUNT, not extra
 * coverage. Keeps the LAST receipt per transcriptSha at the FIRST occurrence's position;
 * non-receipt events and receipts with no transcriptSha pass through untouched (they
 * carry no dedupe key and must not be collapsed together).
 */
export function dedupeByTranscriptSha(events) {
  const list = Array.isArray(events) ? events : []
  const out = []
  const shaAt = new Map() // transcriptSha -> index in `out`
  for (const e of list) {
    if (e && e.type === 'subagent-receipt') {
      const sha = e.detail && typeof e.detail.transcriptSha === 'string' ? e.detail.transcriptSha : null
      if (sha) {
        if (shaAt.has(sha)) {
          out[shaAt.get(sha)] = e // keep the LAST receipt for this transcript
        } else {
          shaAt.set(sha, out.length)
          out.push(e)
        }
        continue
      }
    }
    out.push(e)
  }
  return out
}

/**
 * receiptStats(events) -> {coverage, phantoms, phantomsAsserted, packP95, spawnRecords,
 * receipts, empty}. Over the shared journal events (deduped by transcriptSha first, so an
 * unchanged transcript re-receipted N times counts ONCE — BL-173 mechanism 3):
 *   - coverage  = 100 * receipts / spawnRecords ('subagent-pack' events); 100 when empty
 *   - phantoms  = tool-call-tier phantom count (the ==0 prediction's instrument)
 *   - phantomsAsserted = asserted-tier phantoms, counted SEPARATELY (plan 10's audit)
 *   - packP95   = p95 of durationMs over 'subagent-pack' events
 * Honest empty: zero spawns -> coverage 100, phantoms 0, packP95 0, empty:true.
 */
export function receiptStats(events = []) {
  const list = dedupeByTranscriptSha(Array.isArray(events) ? events : [])
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

/**
 * receiptStatsSchemaOk(stats) -> boolean — the `subagent-receipts
 * --schema-check` contract (BL-172, 2026-07-10): a structural receipt over
 * the report surface must pin the report's SHAPE, never its NUMBERS —
 * .sma/subagents state ACCRUES with every spawn, so hashing the `--json`
 * output re-fails on every reverify by construction (the class the 9.2-04 R2
 * assertion already names: «a receipt must never hash accruing
 * .sma/subagents state»). Valid: an object whose six count fields are finite
 * numbers and whose `empty` flag is a boolean.
 *
 * @param {*} stats  a receiptStats() result
 * @returns {boolean}
 */
export function receiptStatsSchemaOk(stats) {
  const s = stats
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false
  for (const k of ['coverage', 'phantoms', 'phantomsAsserted', 'packP95', 'spawnRecords', 'receipts']) {
    if (!Number.isFinite(s[k])) return false
  }
  return typeof s.empty === 'boolean'
}
