/**
 * flight.mjs — the deterministic pre-compaction FLIGHT RECORDER (49.2-06, D-49.2-09).
 *
 * The #1-world-pain bridge: auto-compaction silently deletes a session's working
 * state. This module makes that moment survivable with PURE FILE ASSEMBLY — zero
 * LLM, zero network, zero child_process anywhere in the path (substrate law, and
 * PreCompact fires at the worst possible moment to spend tokens). It generalizes
 * the V2 per-executor exec-journal to ALL sessions.
 *
 * Five capabilities, all fail-open (C9), all Node built-ins only:
 *   - session flight MARKS — appendMark/readMarks mirror journal.mjs EXACTLY
 *     (per-terminal append-only JSONL under marks/<terminalId>.jsonl, tolerant
 *     reader, no shared-append race on Windows). The generalized exec-journal.
 *   - buildCapsule — a PURE (clock-injected) markdown assembler: 5 fixed-order
 *     sections, byte-deterministic, budgeted to CAPSULE_BUDGET (oldest events
 *     dropped first; header + Current-task NEVER truncated).
 *   - scanForSecrets — a pure deterministic redactor run before EVERY write; a
 *     matched secret is NEVER written in raw form (T-49.2-06A, unconditional).
 *   - nativeProbe — the D-49.2-05 demolition-clause sensor: when a sufficient
 *     native pre-compaction preservation mechanism is detected the whole stream
 *     stands down (writeCapsule -> {skipped:'native'}).
 *   - buildResumeBrief / buildHandoffBrief — continuation briefs assembled from
 *     the flight recorder alone (work after a terminal death, not only compaction);
 *     briefs only ever SUGGEST `pnpm sma ...` commands, never execute anything.
 *
 * PROHIBITIONS (plan frontmatter): no LLM/network/child_process import; no git
 * write; no permissionDecision 'deny' — advisory only; redaction is unconditional
 * even under kill-switch or probe stand-down.
 */

import { appendFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteRaw } from './fs-atomics.mjs'
import { FLIGHT_DIR, CAPSULE_BUDGET, RESTORE_BUDGET } from './constants.mjs'

// Re-export the byte budgets so downstream reads them from the flight surface.
export { CAPSULE_BUDGET, RESTORE_BUDGET } from './constants.mjs'

/** The flight runtime root; dependency-injectable via opts.flightDir (tests). */
function resolveFlightDir(opts = {}) {
  return opts.flightDir ?? FLIGHT_DIR
}

/** True for an env value set to anything truthy (not ''/0/false). */
function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

/** Byte length (UTF-8) — budgets are measured in bytes, never chars. */
function byteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}

/** Collapse whitespace to single spaces + trim (one-line rendering of a slice). */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Read + parse one marks .jsonl, skipping corrupt lines (fail-open C9, journal.mjs posture). */
function parseFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { marks: [], corrupt: 0 }
  }
  const marks = []
  let corrupt = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      marks.push(JSON.parse(trimmed))
    } catch {
      corrupt += 1 // fail-open — skip-and-count, never throw (C9)
    }
  }
  return { marks, corrupt }
}

// ── session flight marks (the generalized exec-journal) ─────────────────────────

/**
 * appendMark(entry, opts) — append one JSONL mark to marks/<terminalId>.jsonl.
 * Structurally mirrors journal.mjs (per-terminal file, seq = last+1, tolerant parse).
 * Mark shape: {ts, terminal, seq, tool, target}. `target` is a file path for Edit/
 * Write or a first-token command SLUG for Bash — NEVER the full command line (secrets
 * ride in command args; T-49.2-06A).
 * @param {{tool?:string, target?:string}} entry
 * @param {{terminalId:string, flightDir?:string, now?:string}} opts
 * @returns {object} the written mark
 */
export function appendMark(entry, opts = {}) {
  const dir = join(resolveFlightDir(opts), 'marks')
  mkdirSync(dir, { recursive: true })
  const terminalId = opts.terminalId ?? 'unknown'
  const file = join(dir, `${terminalId}.jsonl`)

  const { marks } = parseFile(file)
  const lastSeq = marks.length ? marks[marks.length - 1].seq ?? marks.length : 0

  const record = {
    ts: opts.now ?? new Date().toISOString(),
    terminal: terminalId,
    seq: lastSeq + 1,
    tool: entry.tool ?? null,
    target: entry.target ?? null,
  }
  appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}

/** Stable comparator: (ts, terminal, seq). */
function compareMarks(a, b) {
  if (a.ts < b.ts) return -1
  if (a.ts > b.ts) return 1
  const ta = a.terminal ?? ''
  const tb = b.terminal ?? ''
  if (ta < tb) return -1
  if (ta > tb) return 1
  return (a.seq ?? 0) - (b.seq ?? 0)
}

/**
 * readMarks(opts) -> {marks, count, corrupt}. Reads every marks/*.jsonl file, parses
 * line-wise (corrupt lines skipped-and-counted), merge-sorts by (ts, terminal, seq).
 * Missing dir -> zero-mark report. Never throws.
 * @param {{flightDir?:string}} [opts]
 */
export function readMarks(opts = {}) {
  const dir = join(resolveFlightDir(opts), 'marks')
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return { marks: [], count: 0, corrupt: 0 }
  }
  let all = []
  let corrupt = 0
  for (const f of files) {
    const { marks, corrupt: c } = parseFile(join(dir, f))
    all = all.concat(marks)
    corrupt += c
  }
  all.sort(compareMarks)
  return { marks: all, count: all.length, corrupt }
}

// ── the capability probe (demolition-clause sensor, D-49.2-05) ───────────────────

/**
 * nativeProbe(opts) -> {native, reason}. Today NO vendor mechanism preserves a
 * session's working state deterministically across compaction, so native is false
 * unless the documented stand-down override SMA_FLIGHT_NATIVE is truthy — that is
 * also the seam where a real vendor-feature detection lands the day one exists.
 * When native, writeCapsule stands the whole bridge down (D-49.2-05). Deterministic.
 * @param {{env?:object}} [opts]
 * @returns {{native:boolean, reason:string}}
 */
export function nativeProbe(opts = {}) {
  const env = opts.env ?? process.env
  return truthy(env.SMA_FLIGHT_NATIVE)
    ? { native: true, reason: 'SMA_FLIGHT_NATIVE override — a native pre-compaction preservation mechanism is assumed present' }
    : { native: false, reason: 'no native pre-compaction preservation mechanism known' }
}

// ── secret scan (unconditional redaction before EVERY write, T-49.2-06A) ─────────

/**
 * SECRET_PATTERNS — anchored regexes with rule names. Pure data; scanForSecrets and
 * the write paths route every line through them. `keepGroup:1` patterns preserve the
 * assignment operator prefix and redact only the value span.
 */
export const SECRET_PATTERNS = [
  { rule: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'private-key-header', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { rule: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g },
  { rule: 'sk-token', re: /\bsk-[A-Za-z0-9_-]{8,}/g },
  { rule: 'credential-assignment', re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|token)\s*[=:]\s*["']?[^\s"']+/gi },
  { rule: 'long-secret', re: /([=:]\s*["']?)([A-Za-z0-9+/]{40,}={0,2})/g, keepGroup: 1 },
]

/**
 * scanForSecrets(text) -> {text, redactions}. PURE (no fs). Applies each SECRET_PATTERN
 * in order, replacing the matched span with `[redacted:<rule>]`. Clean text passes
 * through byte-identical (nothing matched -> the input string is returned unchanged).
 * @param {string} text
 * @returns {{text:string, redactions:Array<{rule:string}>}}
 */
export function scanForSecrets(text) {
  let out = String(text ?? '')
  const redactions = []
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags)
    out = out.replace(re, (...args) => {
      redactions.push({ rule: p.rule })
      if (p.keepGroup === 1) return `${args[1]}[redacted:${p.rule}]`
      return `[redacted:${p.rule}]`
    })
  }
  return { text: out, redactions }
}

// ── the capsule (pure, budgeted, deterministic) ──────────────────────────────────

/** Render one journal event as a single line (never emits the chain hash). */
function renderJournalLine(e) {
  if (!e || typeof e !== 'object') return collapse(String(e ?? ''))
  const type = e.type ?? 'event'
  const scope = e.scope != null ? (typeof e.scope === 'string' ? e.scope : JSON.stringify(e.scope)) : ''
  const detail = e.detail && typeof e.detail === 'object' && e.detail.reason ? ` — ${e.detail.reason}` : ''
  return collapse(`${type}${scope ? ` ${scope}` : ''}${detail}`)
}

/** The exact next step string, from the injected exec state or the work label. */
function nextStepFrom(inputs) {
  const exec = inputs.execState ?? null
  const label = inputs.label ?? ''
  if (exec && exec.nextUndone != null) {
    return `продолжить план ${exec.planId ?? ''}`.trim() + ` с задачи ${exec.nextUndone}`
  }
  if (exec && exec.complete) return `план ${exec.planId ?? ''} завершён — см. pnpm sma status`.trim()
  if (label) return `продолжить: ${label}`
  return 'см. pnpm sma status'
}

/**
 * buildCapsule(inputs) -> markdown string. PURE — zero fs, zero clock (inputs.now is
 * injected; the determinism precondition, P49.2-06-02). Fixed 5-section order; enforces
 * CAPSULE_BUDGET by dropping the OLDEST events first with one `…truncated` marker. The
 * header and Current-task sections are NEVER truncated.
 * @param {{now, identity, label, trigger, statePosition, stateBlockers, ownClaim, otherClaims, pushClaim, journalTail, marksTail, execState}} inputs
 * @returns {string}
 */
export function buildCapsule(inputs = {}) {
  const now = inputs.now ?? '' // INJECTED — never Date.now()/new Date() here
  const identity = inputs.identity ?? {}
  const label = inputs.label ?? ''
  const trigger = inputs.trigger === 'manual' ? 'manual' : 'auto'
  const terminal = identity.holderIdentity ?? identity.terminalId ?? 'unknown'
  const termId = identity.terminalId && identity.terminalId !== terminal ? ` (${identity.terminalId})` : ''

  // 1. Header — NEVER truncated.
  const header = [
    '# SMA Flight Capsule',
    '',
    '- schema: v1',
    `- ts: ${now}`,
    `- terminal: ${terminal}${termId}`,
    `- label: ${label || '—'}`,
    `- trigger: ${trigger}`,
  ].join('\n')

  // 2. Current task — NEVER truncated.
  const ownClaim = inputs.ownClaim ?? null
  const exec = inputs.execState ?? null
  const ctLines = ['## Current task', '', `- Работа: ${label || '—'}`]
  if (ownClaim) {
    const globs = Array.isArray(ownClaim.globs) && ownClaim.globs.length ? ownClaim.globs.join(', ') : '—'
    ctLines.push(`- Ваш claim: ${globs}${ownClaim.description ? ` — ${collapse(ownClaim.description)}` : ''}`)
  }
  if (inputs.statePosition && collapse(inputs.statePosition)) {
    ctLines.push(`- STATE Current Position: ${collapse(inputs.statePosition)}`)
  }
  if (exec) {
    const next = exec.nextUndone != null ? `следующий шаг: задача ${exec.nextUndone}` : (exec.complete ? 'все задачи выполнены' : '—')
    ctLines.push(`- Активный план: ${exec.planId ?? '—'} → ${next}`)
  }
  const currentTask = ctLines.join('\n')

  // 3. Constraints.
  const cLines = ['## Constraints', '']
  const blockers = Array.isArray(inputs.stateBlockers) ? inputs.stateBlockers : []
  if (blockers.length) {
    cLines.push('Открытые блокеры:')
    for (const b of blockers) cLines.push(`- ${collapse(b)}`)
  }
  const others = Array.isArray(inputs.otherClaims) ? inputs.otherClaims : []
  if (others.length) {
    cLines.push('Не трогать (claim других терминалов):')
    for (const o of others) {
      const globs = Array.isArray(o.globs) && o.globs.length ? o.globs.join(', ') : (o.name ?? '—')
      cLines.push(`- ${o.by ?? o.holderIdentity ?? '?'}: ${globs}`)
    }
  }
  if (inputs.pushClaim && inputs.pushClaim.live) {
    cLines.push(`- Идёт отправка в origin: ${inputs.pushClaim.who ?? '?'} — не пушьте`)
  }
  if (cLines.length === 2) cLines.push('(нет активных ограничений)')
  const constraints = cLines.join('\n')

  // 5. Resume — NEVER truncated (essential).
  const resume = ['## Resume', '', `- Следующий шаг: ${nextStepFrom(inputs)}`, '- Полный бриф: `pnpm sma resume`'].join('\n')

  // 4. Recent decisions & events — the ONLY truncatable section (oldest dropped first).
  const journalTail = Array.isArray(inputs.journalTail) ? inputs.journalTail : []
  const marksTail = Array.isArray(inputs.marksTail) ? inputs.marksTail : []
  const eventLines = []
  for (const e of journalTail) eventLines.push(`- [event] ${renderJournalLine(e)}`)
  for (const m of marksTail) eventLines.push(collapse(`- [mark] ${m.tool ?? '?'} ${m.target ?? ''}`))

  let working = eventLines.slice()
  let dropped = 0
  const render = () => {
    const evLines = ['## Recent decisions & events', '']
    if (dropped > 0) evLines.push(`- …truncated (${dropped} older events dropped)`)
    if (working.length) evLines.push(...working)
    else if (dropped === 0) evLines.push('(нет недавних событий)')
    const events = evLines.join('\n')
    return [header, currentTask, constraints, events, resume].join('\n\n') + '\n'
  }

  let out = render()
  while (byteLen(out) > CAPSULE_BUDGET && working.length > 0) {
    working.shift() // drop the OLDEST event first
    dropped += 1
    out = render()
  }
  return out
}

// ── write paths (probe stand-down + unconditional redaction) ─────────────────────

/**
 * writeCapsule({capsule, terminalId}, opts) — probe stand-down -> redact EVERY line via
 * scanForSecrets -> atomicWriteRaw to BOTH intent.md and capsules/<terminalId>.md.
 * When the probe reports native, writes NOTHING and returns {skipped:'native'} (bridge
 * stands down, D-49.2-05). Returns {written:[paths], redactions}.
 * @param {{capsule:string, terminalId:string}} args
 * @param {{flightDir?:string, env?:object, writeRaw?:Function}} [opts]
 */
export function writeCapsule({ capsule, terminalId }, opts = {}) {
  const probe = nativeProbe({ env: opts.env })
  if (probe.native) return { skipped: 'native' }

  const dir = resolveFlightDir(opts)
  // Unconditional redaction: EVERY line through scanForSecrets before touching disk.
  const redactions = []
  const safe = String(capsule ?? '')
    .split('\n')
    .map((l) => {
      const r = scanForSecrets(l)
      if (r.redactions.length) redactions.push(...r.redactions)
      return r.text
    })
    .join('\n')

  const intentPath = join(dir, 'intent.md')
  const capsulePath = join(dir, 'capsules', `${terminalId}.md`)
  const writeRaw = opts.writeRaw ?? atomicWriteRaw
  writeRaw(intentPath, safe)
  writeRaw(capsulePath, safe)
  return { written: [intentPath, capsulePath], redactions }
}

/**
 * writeHandoff({brief, terminalId}, opts) — redact EVERY line via scanForSecrets, then
 * atomicWriteRaw to handoff-<terminalId>.md. Returns {written:[path], redactions}.
 * @param {{brief:string, terminalId:string}} args
 * @param {{flightDir?:string, writeRaw?:Function}} [opts]
 */
export function writeHandoff({ brief, terminalId }, opts = {}) {
  const dir = resolveFlightDir(opts)
  const redactions = []
  const safe = String(brief ?? '')
    .split('\n')
    .map((l) => {
      const r = scanForSecrets(l)
      if (r.redactions.length) redactions.push(...r.redactions)
      return r.text
    })
    .join('\n')
  const path = join(dir, `handoff-${terminalId}.md`)
  const writeRaw = opts.writeRaw ?? atomicWriteRaw
  writeRaw(path, safe)
  return { written: [path], redactions }
}

// ── continuation briefs (pure assembly) ──────────────────────────────────────────

/** True when the flight inputs carry no session state at all (honest empty brief). */
function isEmptyFlight(inputs) {
  const blockers = Array.isArray(inputs.stateBlockers) ? inputs.stateBlockers : []
  return !inputs.label && !inputs.execState && !inputs.ownClaim && !blockers.length && !inputs.capsuleFresh
}

/** The shared body of both briefs (resume point + claim + blockers + freshness). */
function briefBody(inputs) {
  const label = inputs.label ?? ''
  const exec = inputs.execState ?? null
  const ownClaim = inputs.ownClaim ?? null
  const blockers = Array.isArray(inputs.stateBlockers) ? inputs.stateBlockers : []
  const lines = []
  lines.push(`- Свежесть капсулы: ${inputs.capsuleFresh ?? '—'}`)
  lines.push(`- Текущая работа: ${label || '—'}`)
  if (ownClaim) {
    const globs = Array.isArray(ownClaim.globs) && ownClaim.globs.length ? ownClaim.globs.join(', ') : '—'
    lines.push(`- Ваш claim: ${globs}${ownClaim.description ? ` — ${collapse(ownClaim.description)}` : ''}`)
  }
  if (exec) {
    lines.push(`- Активный план: ${exec.planId ?? '—'} → ${exec.nextUndone != null ? `следующая задача ${exec.nextUndone}` : 'план завершён'}`)
  }
  if (blockers.length) {
    lines.push('- Блокеры:')
    for (const b of blockers) lines.push(`  - ${collapse(b)}`)
  }
  lines.push('')
  lines.push(`Следующий шаг: ${nextStepFrom(inputs)}`)
  return lines
}

/**
 * buildResumeBrief(inputs) -> markdown string. PURE assembly over the same injected
 * inputs as the capsule + capsuleFresh. A fully-empty flight dir yields an honest empty
 * brief (no throw). Only SUGGESTS `pnpm sma ...` — never executes anything.
 */
export function buildResumeBrief(inputs = {}) {
  if (isEmptyFlight(inputs)) {
    return ['# SMA Resume Brief', '', 'Флайт-журнал пуст — начните с `pnpm sma status`.'].join('\n') + '\n'
  }
  return ['# SMA Resume Brief', '', ...briefBody(inputs)].join('\n') + '\n'
}

/**
 * buildHandoffBrief(inputs) -> markdown string. Everything buildResumeBrief has PLUS a
 * claim-transfer section naming the exact `pnpm sma release <slot>` / `pnpm sma claim`
 * commands + the D-49-09 force-clear warning. PURE — the write path (writeHandoff) runs
 * the secret scan. Honest empty when the flight dir is empty.
 */
export function buildHandoffBrief(inputs = {}) {
  if (isEmptyFlight(inputs)) {
    return ['# SMA Handoff Brief', '', 'Флайт-журнал пуст — начните с `pnpm sma status`.'].join('\n') + '\n'
  }
  const ownClaim = inputs.ownClaim ?? null
  const slot = inputs.slot ?? (ownClaim && ownClaim.name) ?? null
  const lines = ['# SMA Handoff Brief', '', ...briefBody(inputs), '', '## Передача claim (claim transfer)', '']
  lines.push(`- Отпустить ваш claim: \`pnpm sma release ${slot ?? '<slot>'}\``)
  lines.push('- Принять на другом терминале: `pnpm sma claim <globs> --description "<что>"`')
  lines.push('- ⚠ Чужой claim снимается только через `pnpm sma force-clear <slot> --yes` — force-clear показывает владельца и требует явного подтверждения (D-49-09).')
  return lines.join('\n') + '\n'
}
