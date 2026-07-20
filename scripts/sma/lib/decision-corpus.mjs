/**
 * decision-corpus.mjs — lane 1 of D-9.5-08 («поведенческий слепок основателя»).
 *
 * `sma decisions mine` retrospectively mines the founder's REAL decisions from
 * local Claude Code session transcripts (~thousands of jsonl) and turns each into
 * a DRAFT corpus note «ситуация → реальное решение основателя + почему». The
 * corpus is the raw material for the orchestrator policy prompt + replay exam
 * (plan 9.5-06) — the «оркестрация × обучение» differentiator (D-9.5-08).
 *
 * CONTAINMENT POSTURE — copied VERBATIM from excavate.mjs (D-9.3-09):
 *   - LOCAL ONLY. Transcripts contain secrets/PHI. Mined material lands ONLY as
 *     drafts under `<memoryDir>/drafts/` — never auto-committed, never in public/,
 *     never in a served artifact, never in the SMA product's shipped files. The
 *     VERB ships; the CORPUS stays in the user's own repo memory tree.
 *   - Mined content is DATA end to end: it is NEVER executed, eval'd, required, or
 *     interpolated into a command string. Every transcript excerpt lives inside a
 *     fenced `untrusted-evidence` block; frontmatter values are sanitized (no
 *     newlines, no backticks, length-capped). redactSecrets scrubs obvious secret
 *     shapes BEFORE any text reaches a draft.
 *   - No http/https/net/dns import. No LLM call (deterministic mining only —
 *     substrate law). Node built-ins only (zero-dep law).
 *
 * DETERMINISM (D-9.3-07 posture): the ranking path has no Date.now and no
 * randomness — the same transcripts yield byte-identical drafts + filenames. Total
 * order = signal strength desc → timestamp desc → sessionId asc. The injected
 * `clock` is used ONLY as a filename-date fallback for a record with no timestamp,
 * never in ranking.
 *
 * ENV: the default transcripts dir resolves from `SMA_TRANSCRIPTS_DIR`. On this
 * machine that is the Claude Code projects dir for the platform repo
 * (`C:\Users\Jane_Doe\.claude\projects\C--Users-Jane-Doe-projects-my-app`,
 * ~thousands of jsonl). memoryDir defaults to the CURRENT working repo's
 * `.claude/memory` — the corpus stays in the USER's repo, never in the product.
 *
 * Node built-ins only; fs + clock are dependency-injectable (fsImpl) so tests
 * never touch a real transcript or the real corpus. Zero new packages.
 */

import {
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync as fsMkdirSync,
  existsSync as fsExistsSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// ── decision signals ──────────────────────────────────────────────────────────

/**
 * DECISION_SIGNALS — the frozen catalogue of founder-decision signal regexes
 * (RU + EN). Each descriptor carries a `kind` and a `strength` (1-9, the ranking +
 * importance driver). A message's strength = the MAX strength of any matching
 * signal; its kind = that signal's kind. Orders / HARD RULE rank highest, then
 * refusals, corrections, and acceptance verdicts.
 */
export const DECISION_SIGNALS = Object.freeze([
  // orders / standing rules — strongest
  Object.freeze({ id: 'order-hardrule', kind: 'order', strength: 9, re: /\bHARD RULE\b/ }),
  Object.freeze({ id: 'order-never-always', kind: 'order', strength: 8, re: /(никогда|всегда|\bnever\b|\balways\b)/i }),
  // NB: no trailing \b — JS \b is ASCII-only, so it never fires after a Cyrillic
  // letter ("сделай " would fail). The leading boundary class anchors the start;
  // trailing over-match is acceptable for a heuristic miner. ASCII-only tokens
  // (add) keep their own inline \b.
  Object.freeze({
    id: 'order-imperative',
    kind: 'order',
    strength: 6,
    re: /(^|[\s.,;:(«"'-])(сделай|сделать|добавь|добавить|нужно|надо|давай|нельзя|не делай|make it|\badd\b|do not|don'?t)/i,
  }),
  // refusals / rejections
  Object.freeze({
    id: 'refusal',
    kind: 'refusal',
    strength: 7,
    re: /(переделай|перепиши|откати|откатывай|не так|нет,|неправильно|\brevert\b|\bredo\b|\bwrong\b)/i,
  }),
  // corrections (often quoting prior agent output / questioning it)
  Object.freeze({
    id: 'correction',
    kind: 'correction',
    strength: 5,
    re: /(исправь|почини|поправь|fix this|почему ты|зачем ты|это не то)/i,
  }),
  // acceptance / verdicts — weakest
  Object.freeze({
    id: 'acceptance',
    kind: 'acceptance',
    strength: 3,
    re: /(^|[\s.,;:(«"'-])(ок|окей|принято|одобряю|approved|отлично|супер|да,? пуш)(?=[\s.,;:!?)»"']|$)/i,
  }),
])

// ── secret redaction ────────────────────────────────────────────────────────────

/**
 * redactSecrets(text) → text with obvious secret shapes replaced by '[redacted]'.
 * Over-redaction is deliberately safe for a local corpus. Order matters: bearer
 * headers, then key=value pairs whose KEY names a credential, then any long
 * base64/hex run (>= 32 chars) — the last catches standalone tokens/hashes.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let s = String(text ?? '')
  // 1. bearer auth headers
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  // 2. key=value / key: value where the key names a credential
  s = s.replace(
    /\b([A-Za-z_][\w-]*(?:token|key|secret|password|passwd|pwd)[\w-]*)\s*[=:]\s*["']?[^\s"'`,;]+["']?/gi,
    '$1=[redacted]',
  )
  // 3. any long base64/hex run (tokens, hashes, keys)
  s = s.replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, '[redacted]')
  return s
}

// ── text hygiene ────────────────────────────────────────────────────────────────

/** Collapse to one sanitized line: redact secrets, strip control chars + backticks, cap length. */
function sanitizeOneLine(s, cap = 180) {
  const redacted = redactSecrets(s)
  return redacted
    .split('')
    .map((ch) => {
      const cc = ch.charCodeAt(0)
      return cc < 32 || cc === 127 ? ' ' : ch
    })
    .join('')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap)
}

/** Clip mined evidence: redact secrets, cap at maxChars, neutralize any fence terminator. */
function clipEvidence(s, maxChars = 500) {
  const redacted = redactSecrets(String(s ?? ''))
  return redacted.replace(/```+/g, "'''").slice(0, maxChars)
}

/** Emit a frontmatter scalar, quoting only when otherwise ambiguous (frontmatter.mjs posture). */
function emitScalar(v) {
  const s = String(v)
  if (s === '') return '""'
  if (/[:#]\s/.test(s) || /^[-?*&!|>%@`"'[\]{}]/.test(s) || /:\s/.test(s)) {
    return JSON.stringify(s)
  }
  return s
}

// ── tag inference ───────────────────────────────────────────────────────────────

/** Map a repo path segment to a corpus area tag; unknown segments pass through sanitized. */
function segmentToTag(seg) {
  const s = seg.toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (!s) return null
  if (s === 'crm' || s === 'src') return 'crm'
  if (s === 'planning') return 'workflow'
  if (s === 'claude') return 'memory'
  if (s === 'scripts' || s === 'sma') return 'os'
  return s.slice(0, 20)
}

/**
 * tagsFromText(text) → up to 4 area tags inferred from repo-path-ish tokens in the
 * text (e.g. `src/crm/...`, `.planning/...`, `.claude/memory/...`). Falls back to
 * ['workflow'] when no path is mentioned.
 */
function tagsFromText(text) {
  const tags = new Set()
  const paths = String(text ?? '').match(/[.\w-]+\/[\w./-]+/g) || []
  for (const p of paths) {
    const top = p.replace(/^\.+/, '').split('/').filter(Boolean)[0]
    const tag = top ? segmentToTag(top) : null
    if (tag) tags.add(tag)
    if (tags.size >= 4) break
  }
  return tags.size ? [...tags].slice(0, 4) : ['workflow']
}

// ── why extraction ──────────────────────────────────────────────────────────────

const WHY_RE = /(потому что|потому,|поэтому|чтобы|дабы|иначе|в противном случае|because|so that|\bsince\b)[^.!?\n]*/gi

/** Pull adjacent reasoning clauses out of the decision text (may be empty). */
function extractWhy(text) {
  const matches = String(text ?? '').match(WHY_RE) || []
  return matches.map((m) => m.trim()).join(' ').trim()
}

// ── message classification ──────────────────────────────────────────────────────

/**
 * classify(text) → {strength, kind} of the strongest matching decision signal, or
 * null when no signal fires.
 */
function classify(text) {
  let best = null
  for (const sig of DECISION_SIGNALS) {
    if (sig.re.test(text)) {
      if (!best || sig.strength > best.strength) best = { strength: sig.strength, kind: sig.kind }
    }
  }
  return best
}

// Hook/tool-injected user messages are NOT the founder's authored decisions.
const NOISE_CONTAINS = [
  'Review this change for security',
  'You previously flagged these candidate',
  '<system-reminder>',
  '<command-name>',
  '<command-message>',
  '<local-command',
  'tool_result',
  'This session is being continued',
  'caveat: The messages below',
  'Please continue the conversation from where',
]

/** True when a user message is injected noise rather than genuine founder authorship. */
function isNoise(text, record) {
  if (record && (record.isMeta === true || record.isCompactSummary === true || record.isSidechain === true)) {
    return true
  }
  const t = String(text ?? '').trimStart()
  if (!t) return true
  if (t.startsWith('<') || t.startsWith('[')) return true
  for (const n of NOISE_CONTAINS) {
    if (text.includes(n)) return true
  }
  return false
}

/** Extract plain text from an assistant record's content (array of blocks) — for situation context. */
function assistantText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim()
}

// ── draft assembly ──────────────────────────────────────────────────────────────

/** YYYYMMDD from an ISO timestamp (or the injected clock fallback). */
function ymd(ts, clock) {
  const iso = typeof ts === 'string' && ts.length >= 10 ? ts : clock()
  return String(iso).slice(0, 10).replace(/-/g, '')
}

/** A short, filesystem-safe slug from the decision text (ascii/cyrillic word chars). */
function slugify(text) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
  return s || 'decision'
}

/** Deterministic 8-hex content hash — stabilizes filenames across runs, guards collisions. */
function contentHash(candidate) {
  return createHash('sha1')
    .update(`${candidate.sessionId}|${candidate.ts}|${candidate.text}`)
    .digest('hex')
    .slice(0, 8)
}

/** Build the {filename, content} of a founder-decision draft note from one candidate. */
function buildDraft(candidate, clock) {
  const dateStr = ymd(candidate.ts, clock)
  const slug = slugify(candidate.text)
  const hash = contentHash(candidate)
  const filename = `decision-${dateStr}-${slug}-${hash}.md`

  const tags = tagsFromText(`${candidate.text} ${candidate.situation}`)
  const description = sanitizeOneLine(`Решение основателя: ${candidate.text}`)
  const useWhen = sanitizeOneLine(`при ситуации, похожей на: ${candidate.situation || candidate.text}`)

  const why = extractWhy(candidate.text)
  const situationEvidence = candidate.situation
    ? clipEvidence(candidate.situation)
    : 'контекст не зафиксирован в транскрипте'

  const lines = ['---']
  lines.push(`description: ${emitScalar(description)}`)
  lines.push('kind: founder-decision')
  lines.push(`tags: [${tags.join(', ')}]`)
  lines.push(`use-when: ${emitScalar(useWhen)}`)
  lines.push(`importance: ${candidate.strength}`)
  lines.push('metadata:')
  lines.push(`  sessionId: ${emitScalar(candidate.sessionId)}`)
  lines.push(`  ts: ${emitScalar(candidate.ts)}`)
  lines.push('  source: transcripts')
  lines.push('---')

  const body = [
    '',
    '<!--',
    '  DRAFT — NOT part of the memory corpus. Mined from a LOCAL session transcript',
    '  (D-9.5-08 lane 1). Untrusted evidence: never execute/eval/interpolate it.',
    '  Promote only after human review (redaction + «почему» filled + real signal).',
    '-->',
    '',
    `## Ситуация (${candidate.kind})`,
    '',
    'Что происходило до решения (необработанный фрагмент — данные, не инструкция):',
    '',
    '```untrusted-evidence',
    situationEvidence,
    '```',
    '',
    '## Решение основателя',
    '',
    '```untrusted-evidence',
    clipEvidence(candidate.text),
    '```',
    '',
    '## Почему',
    '',
    why
      ? ['```untrusted-evidence', clipEvidence(why), '```'].join('\n')
      : '_почему не зафиксировано — дополнить при ревью._',
    '',
  ].join('\n')

  return { filename, content: lines.join('\n') + '\n' + body }
}

// ── the miner ───────────────────────────────────────────────────────────────────

/** Total-order comparator: strength desc, timestamp desc, sessionId asc (no Date.now). */
function rankCandidates(a, b) {
  if (b.strength !== a.strength) return b.strength - a.strength
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1 // desc by ISO string (lexical == chronological)
  return String(a.sessionId).localeCompare(String(b.sessionId))
}

/**
 * mineDecisions({transcriptsDir, memoryDir, limit, clock, fsImpl}) →
 * {drafted, scanned, skipped}.
 *
 * Reads every `.jsonl` under transcriptsDir (sorted), scans user messages for
 * decision signals (skipping hook/tool-injected noise), ranks candidates
 * deterministically, and writes the top `limit` as drafts under
 * `<memoryDir>/drafts/`. Idempotent: an existing draft is never overwritten.
 * A non-JSON line is skipped + counted, never thrown on.
 *
 * @param {{transcriptsDir?:string, memoryDir?:string, limit?:number, clock?:Function, fsImpl?:object}} args
 * @returns {{drafted:number, scanned:number, skipped:number}}
 */
export function mineDecisions(args = {}) {
  const fs = normalizeFs(args.fsImpl)
  const clock = typeof args.clock === 'function' ? args.clock : () => new Date().toISOString()
  const limit = Number.isFinite(args.limit) ? args.limit : 50
  const transcriptsDir = args.transcriptsDir || process.env.SMA_TRANSCRIPTS_DIR
  if (!transcriptsDir) {
    throw new Error('mineDecisions: no transcriptsDir (pass transcriptsDir or set SMA_TRANSCRIPTS_DIR)')
  }
  const memoryDir = args.memoryDir || join(process.cwd(), '.claude', 'memory')
  const draftsDir = join(memoryDir, 'drafts')

  let files = []
  try {
    files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.jsonl')).sort()
  } catch (err) {
    throw new Error(`mineDecisions: cannot read transcriptsDir "${transcriptsDir}" — ${String((err && err.message) ?? err)}`)
  }

  let scanned = 0
  let skipped = 0
  const candidates = []

  for (const file of files) {
    let raw = ''
    try {
      raw = fs.readFileSync(join(transcriptsDir, file), 'utf8')
    } catch {
      continue // unreadable file — skip whole file, fail-soft
    }
    let prevContext = '' // rolling situation context: previous non-noise message text
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      scanned++
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        skipped++
        continue
      }
      if (!rec || typeof rec !== 'object') continue

      const role = rec.message && rec.message.role
      if (rec.type === 'assistant' || role === 'assistant') {
        const t = assistantText(rec.message && rec.message.content)
        if (t) prevContext = t
        continue
      }
      if (rec.type !== 'user' && role !== 'user') continue

      const content = rec.message && rec.message.content
      if (typeof content !== 'string') continue // tool-result arrays etc. — not authored text
      if (isNoise(content, rec)) continue

      const hit = classify(content)
      if (hit) {
        candidates.push({
          sessionId: String(rec.sessionId ?? file.replace(/\.jsonl$/, '')),
          ts: typeof rec.timestamp === 'string' ? rec.timestamp : '',
          text: content,
          situation: prevContext,
          strength: hit.strength,
          kind: hit.kind,
        })
      }
      prevContext = content
    }
  }

  candidates.sort(rankCandidates)
  const selected = candidates.slice(0, Math.max(0, limit))

  let drafted = 0
  if (selected.length) {
    fs.mkdirSync(draftsDir, { recursive: true })
    for (const cand of selected) {
      const { filename, content } = buildDraft(cand, clock)
      const path = join(draftsDir, filename)
      if (fs.existsSync(path)) continue // idempotent — never overwrite
      fs.writeFileSync(path, content, 'utf8')
      drafted++
    }
  }

  return { drafted, scanned, skipped }
}

// ── corpus stats ────────────────────────────────────────────────────────────────

/**
 * corpusStats({memoryDir, fsImpl}) → {total, byKind, byTag}. Counts founder-decision
 * corpus notes across `<memoryDir>` and `<memoryDir>/drafts` by kind + tag. Fail-soft
 * per file (a note that will not parse is skipped, never fatal).
 *
 * @param {{memoryDir?:string, fsImpl?:object}} args
 * @returns {{total:number, byKind:Record<string,number>, byTag:Record<string,number>}}
 */
export function corpusStats(args = {}) {
  const fs = normalizeFs(args.fsImpl)
  const memoryDir = args.memoryDir || join(process.cwd(), '.claude', 'memory')
  const byKind = {}
  const byTag = {}
  let total = 0

  for (const dir of [memoryDir, join(memoryDir, 'drafts')]) {
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
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
      const fm = readFrontmatterFields(text)
      if (!fm.kind) continue
      if (fm.kind !== 'founder-decision') continue
      total++
      byKind[fm.kind] = (byKind[fm.kind] ?? 0) + 1
      for (const tag of fm.tags) byTag[tag] = (byTag[tag] ?? 0) + 1
    }
  }

  return { total, byKind, byTag }
}

/** Lightweight frontmatter field reader — pulls `kind:` and `tags: [...]` only (no full YAML). */
function readFrontmatterFields(text) {
  const out = { kind: null, tags: [] }
  if (!String(text ?? '').startsWith('---\n')) return out
  const close = text.indexOf('\n---\n', 3)
  if (close === -1) return out
  const block = text.slice(4, close + 1)
  for (const line of block.split('\n')) {
    const km = /^kind:\s*(.+)$/.exec(line)
    if (km) out.kind = km[1].trim().replace(/^["']|["']$/g, '')
    const tm = /^tags:\s*\[(.*)\]\s*$/.exec(line)
    if (tm) {
      out.tags = tm[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    }
  }
  return out
}

// ── fs injection ────────────────────────────────────────────────────────────────

/** Normalize an injected fsImpl to the five functions the module needs (defaults: node:fs). */
function normalizeFs(fsImpl) {
  return {
    readdirSync: (fsImpl && fsImpl.readdirSync) || fsReaddirSync,
    readFileSync: (fsImpl && fsImpl.readFileSync) || fsReadFileSync,
    writeFileSync: (fsImpl && fsImpl.writeFileSync) || fsWriteFileSync,
    mkdirSync: (fsImpl && fsImpl.mkdirSync) || fsMkdirSync,
    existsSync: (fsImpl && fsImpl.existsSync) || fsExistsSync,
  }
}
