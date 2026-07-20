/**
 * replay-exam.mjs — lane 4 of D-9.5-08 («экзамен-реплей», the calibration metric).
 *
 * `sma exam` replays HELD-OUT historical founder situations through the synthetic
 * orchestrator and computes a match rate against the founder's REAL decisions — the
 * calibration metric for the orchestrator policy prompt (plan 9.5-06). It is the
 * measurement half of the «оркестрация × обучение» differentiator (D-9.5-08): the
 * policy's fidelity is MEASURED, not asserted.
 *
 *   - buildExam samples founder-decision corpus notes deterministically (seeded
 *     shuffle → same seed yields the same exam), STRIPS the «Решение основателя» +
 *     «Почему» into a hidden answer key, and writes the exam + key as two files.
 *   - scoreExam reads externally-graded rows {id, verdict}, computes the match rate,
 *     appends the score to a durable ledger keyed by policy_version, and prints the
 *     rate as the numeric LAST stdout line (machine-readable for calibration).
 *
 * BLIND-EXAM INVARIANT (T-9.5-18): the answer key is written to a SEPARATE file
 * whose name carries the `-key` suffix (`exam-<date>-key.jsonl`). The examinee
 * (sma-synthetic-orchestrator) is handed ONLY the `exam-<date>.jsonl` items — the
 * key file is NEVER passed to it. The path convention IS the enforcement: a
 * consumer that reads `exam-<date>.jsonl` can never see the stripped answers.
 *
 * CONTAINMENT (copied from decision-corpus.mjs / excavate.mjs, D-9.3-09): all
 * artifacts land under `<memoryDir>/exam/` — a LOCAL repo tree, never public/, never
 * a served artifact, never shipped with the SMA product. Mined situation text is
 * DATA end to end: it is copied verbatim into an item's `situation` field and is
 * NEVER executed, eval'd, required, or interpolated into a command string.
 *
 * DETERMINISM (D-9.3-07 posture): the selection path has NO Date.now and NO
 * Math.random — a seeded PRNG (xmur3 → mulberry32) drives a Fisher-Yates shuffle over
 * a filename-sorted base order, so the same corpus + same seed yields byte-identical
 * exam + key files. The injected `clock` is used ONLY for the filename date + the
 * score-ledger timestamp, never in selection.
 *
 * Node built-ins only; fs + clock are dependency-injectable (fsImpl/clock) so tests
 * never touch a real corpus. Zero new packages.
 */

import {
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  appendFileSync as fsAppendFileSync,
  mkdirSync as fsMkdirSync,
  existsSync as fsExistsSync,
} from 'node:fs'
import { join } from 'node:path'

// ── seeded PRNG (deterministic, no Math.random) ──────────────────────────────

/** xmur3 string→seed hash (produces a 32-bit seed stream from any seed value). */
function xmur3(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

/** mulberry32 PRNG → [0,1). Deterministic for a given 32-bit seed. */
function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A [0,1) random function seeded deterministically from any seed value. */
function seededRandom(seed) {
  const s = xmur3(String(seed))
  return mulberry32(s())
}

/** Deterministic Fisher-Yates shuffle (in place) driven by a seeded [0,1) rng. */
function seededShuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

// ── corpus reading ────────────────────────────────────────────────────────────

/** True when frontmatter names a founder-decision note. */
function isFounderDecision(text) {
  if (!String(text ?? '').startsWith('---\n')) return false
  const close = text.indexOf('\n---\n', 3)
  if (close === -1) return false
  const block = text.slice(4, close + 1)
  for (const line of block.split('\n')) {
    const km = /^kind:\s*(.+)$/.exec(line)
    if (km) return km[1].trim().replace(/^["']|["']$/g, '') === 'founder-decision'
  }
  return false
}

/**
 * sectionBody(text, titleRe) → the trimmed body of a `## <title>…` section, or ''.
 * Captures from the header line to the next `## ` (or end of file).
 */
function sectionBody(text, titleRe) {
  const re = new RegExp('^##\\s+' + titleRe + '[^\\n]*$', 'm')
  const m = re.exec(String(text ?? ''))
  if (!m) return ''
  const rest = text.slice(m.index + m[0].length)
  const next = /\n##\s/.exec(rest)
  const chunk = next ? rest.slice(0, next.index) : rest
  return chunk.trim()
}

/**
 * parseNoteToPair(id, text) → {id, situation, decision, why}. Splits a
 * founder-decision note into the visible situation and the hidden answer (the
 * decision + why that get stripped into the key). Situation text is DATA, copied
 * verbatim (never interpreted).
 */
function parseNoteToPair(id, text) {
  return {
    id,
    situation: sectionBody(text, 'Ситуация') || '(контекст не зафиксирован)',
    decision: sectionBody(text, 'Решение основателя') || '(решение не зафиксировано)',
    why: sectionBody(text, 'Почему') || '',
  }
}

/** YYYY-MM-DD from an ISO timestamp / clock. */
function ymd(clock) {
  const iso = clock()
  return String(iso).slice(0, 10)
}

/** The fixed answer-format contract handed to the examinee per item. */
const ANSWER_FORMAT = '{decision: string, reasoning: string, confidence: number 0..1}'

// ── the exam builder ────────────────────────────────────────────────────────────

/**
 * buildExam({memoryDir, holdoutPct=20, seed, clock, fsImpl}) →
 * {examPath, keyPath, count, total}.
 *
 * Reads every founder-decision note under `<memoryDir>` and `<memoryDir>/drafts`,
 * sorts by filename (stable base order), seeded-shuffles, holds out `holdoutPct`% as
 * the exam set (min 1 when the corpus is non-empty), strips each note into a visible
 * item {id, situation, answerFormat} + a hidden key row {id, decision, why}, and
 * writes:
 *   - `<memoryDir>/exam/exam-<date>.jsonl`      (items — handed to the examinee)
 *   - `<memoryDir>/exam/exam-<date>-key.jsonl`  (answers — NEVER handed to the examinee)
 *
 * Deterministic: same corpus + same seed → byte-identical files.
 *
 * @param {{memoryDir?:string, holdoutPct?:number, seed?:(number|string), clock?:Function, fsImpl?:object}} args
 * @returns {{examPath:string, keyPath:string, count:number, total:number}}
 */
export function buildExam(args = {}) {
  const fs = normalizeFs(args.fsImpl)
  const clock = typeof args.clock === 'function' ? args.clock : () => new Date().toISOString()
  const memoryDir = args.memoryDir || join(process.cwd(), '.claude', 'memory')
  const holdoutPct = Number.isFinite(args.holdoutPct) ? args.holdoutPct : 20
  const seed = args.seed ?? 0

  // Collect founder-decision notes (root + drafts), keyed by a stable id (filename).
  const pairs = []
  for (const dir of [memoryDir, join(memoryDir, 'drafts')]) {
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const file of files) {
      let text = ''
      try {
        text = fs.readFileSync(join(dir, file), 'utf8')
      } catch {
        continue
      }
      if (!isFounderDecision(text)) continue
      pairs.push(parseNoteToPair(file.replace(/\.md$/, ''), text))
    }
  }

  // Stable base order (id asc) before the seeded shuffle → determinism.
  pairs.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const total = pairs.length

  const rng = seededRandom(seed)
  seededShuffle(pairs, rng)

  const pct = Math.max(0, Math.min(100, holdoutPct))
  const count = total === 0 ? 0 : Math.max(1, Math.floor((total * pct) / 100))
  const held = pairs.slice(0, count)
  // Re-sort the held set by id so the written files are order-stable for a given seed.
  held.sort((a, b) => String(a.id).localeCompare(String(b.id)))

  const date = ymd(clock)
  const examDir = join(memoryDir, 'exam')
  const examPath = join(examDir, `exam-${date}.jsonl`)
  const keyPath = join(examDir, `exam-${date}-key.jsonl`)

  const itemLines = held.map((p) =>
    JSON.stringify({ id: p.id, situation: p.situation, answerFormat: ANSWER_FORMAT }),
  )
  const keyLines = held.map((p) => JSON.stringify({ id: p.id, decision: p.decision, why: p.why }))

  fs.mkdirSync(examDir, { recursive: true })
  fs.writeFileSync(examPath, itemLines.join('\n') + (itemLines.length ? '\n' : ''), 'utf8')
  fs.writeFileSync(keyPath, keyLines.join('\n') + (keyLines.length ? '\n' : ''), 'utf8')

  return { examPath, keyPath, count, total }
}

// ── the scorer ──────────────────────────────────────────────────────────────────

const VALID_VERDICTS = new Set(['match', 'partial', 'miss'])

/**
 * scoreExam({gradesPath, memoryDir, policyVersion, clock, out, fsImpl}) →
 * {matchRate, total, match, partial, miss, malformed}.
 *
 * Reads externally-graded rows {id, verdict: match|partial|miss} (grading is done by
 * the founder or a judge agent OUTSIDE this harness — the score is spoofing-resistant
 * because the grading input is external, T-9.5-19). Computes
 *   matchRate = floor( (match + 0.5*partial) / total * 100 )   [0 when total==0]
 * appends the score to `<memoryDir>/exam/scores.jsonl` with the policy_version + the
 * grades path (audit trail), and prints the match rate as the numeric LAST stdout
 * line (integer percent). A malformed / non-JSON / invalid-verdict row is counted in
 * `malformed` and excluded from the denominator — never thrown on.
 *
 * @param {{gradesPath:string, memoryDir?:string, policyVersion?:(number|string), clock?:Function, out?:Function, fsImpl?:object}} args
 * @returns {{matchRate:number, total:number, match:number, partial:number, miss:number, malformed:number}}
 */
export function scoreExam(args = {}) {
  const fs = normalizeFs(args.fsImpl)
  const clock = typeof args.clock === 'function' ? args.clock : () => new Date().toISOString()
  const out = typeof args.out === 'function' ? args.out : (s) => process.stdout.write(s)
  const gradesPath = args.gradesPath
  if (!gradesPath) {
    throw new Error('scoreExam: no gradesPath (pass the path to the graded rows file)')
  }

  let raw = ''
  try {
    raw = fs.readFileSync(gradesPath, 'utf8')
  } catch (err) {
    throw new Error(`scoreExam: cannot read gradesPath "${gradesPath}" — ${String((err && err.message) ?? err)}`)
  }

  let match = 0
  let partial = 0
  let miss = 0
  let malformed = 0

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    const verdict = row && typeof row.verdict === 'string' ? row.verdict.trim().toLowerCase() : null
    if (!verdict || !VALID_VERDICTS.has(verdict)) {
      malformed++
      continue
    }
    if (verdict === 'match') match++
    else if (verdict === 'partial') partial++
    else miss++
  }

  const total = match + partial + miss
  const matchRate = total === 0 ? 0 : Math.floor(((match + 0.5 * partial) / total) * 100)

  // Append to the durable score ledger keyed by policy_version (audit trail).
  const memoryDir = args.memoryDir || join(process.cwd(), '.claude', 'memory')
  const examDir = join(memoryDir, 'exam')
  const scoresPath = join(examDir, 'scores.jsonl')
  const record = {
    ts: clock(),
    policyVersion: args.policyVersion ?? null,
    matchRate,
    total,
    match,
    partial,
    miss,
    malformed,
    gradesPath: String(gradesPath),
  }
  try {
    fs.mkdirSync(examDir, { recursive: true })
    fs.appendFileSync(scoresPath, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    /* ledger append is best-effort — never fail the score on a write error */
  }

  // Numeric LAST stdout line — machine-readable calibration contract.
  out(`${matchRate}\n`)

  return { matchRate, total, match, partial, miss, malformed }
}

// ── fs injection ────────────────────────────────────────────────────────────────

/** Normalize an injected fsImpl to the functions the module needs (defaults: node:fs). */
function normalizeFs(fsImpl) {
  return {
    readdirSync: (fsImpl && fsImpl.readdirSync) || fsReaddirSync,
    readFileSync: (fsImpl && fsImpl.readFileSync) || fsReadFileSync,
    writeFileSync: (fsImpl && fsImpl.writeFileSync) || fsWriteFileSync,
    appendFileSync: (fsImpl && fsImpl.appendFileSync) || fsAppendFileSync,
    mkdirSync: (fsImpl && fsImpl.mkdirSync) || fsMkdirSync,
    existsSync: (fsImpl && fsImpl.existsSync) || fsExistsSync,
  }
}
