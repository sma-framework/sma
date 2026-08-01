#!/usr/bin/env node
/**
 * terminal-parity-check.mjs — FIVE RECEIPTS OF ONE RUN, one command, a numeric verdict.
 *
 * ═══════════════════════ THE LAW THIS TOOL ENFORCES ══════════════════════════════
 * «Terminal parity» — a headless worker session is the SAME session the founder gets in
 * his own terminal — is a claim that is worthless when ASSERTED and load-bearing when
 * PROVEN. So it is never proven by prose, by a green test, or by the daemon's word: it is
 * proven by ARTIFACTS a real run left behind, each read from ONE named source, each with
 * its own way of being absent. Nothing here infers, guesses or scores «probably fired» —
 * a missing artifact is a missing receipt, full stop (the repudiation mitigation: a run
 * that cannot show its five artifacts did not demonstrate parity).
 *
 * THE FIVE RECEIPTS, one source each:
 *   (a) guards   — the guard log carries at least one entry inside the run's own time
 *                  window: the checkout's hooks actually executed in that session.
 *   (b) memory   — the session TOUCHED the corpus: a tool call in the transcript whose
 *                  input names `.claude/memory` (or, failing a transcript, the attempt
 *                  journal's memory layer is non-empty). Deliberately NOT a text search
 *                  over the whole transcript: the task prompt itself names the memory
 *                  index, so a text match would certify the INSTRUCTION as if it were
 *                  the READ — the exact self-certifying loop this tool exists to refuse.
 *   (c) skill    — a `Skill` tool invocation in the transcript. For a worker whose profile
 *                  enables no skills this receipt is honestly marked n/a and does NOT sink
 *                  the run: an honest four-and-one beats a manufactured five.
 *   (d) receipt  — the attempt's reverify receipt exists and PARSES (schema-checked by the
 *                  product's own validateReceipt when it carries a structural digest).
 *   (e) profile  — the model/effort actually present in the spawn's argument array equals
 *                  what the worker profile in the config demands (per-task override is the
 *                  documented precedence). Read by the runner's OWN reader, so «what ran»
 *                  can never drift from «what the builder produced».
 *
 * OUTPUT CONTRACT: five lines «OK|FAIL|n-a — <receipt>: <detail>», then a LAST LINE that is
 * a bare NUMBER 0..5 (receipt-hash and prediction-scorer friendly), and exit 0 ONLY on a
 * full set. n/a counts as fulfilled, and says so on its own line.
 *
 * USAGE:
 *   node tools/terminal-parity-check.mjs <attemptId> [--dir <runDir>] [--config <path>] [--ledger <dir>]
 *
 * The run directory (default `.sma/runs/<attemptId>`) holds the artifacts of ONE attempt:
 *   run.json        {attemptId, taskId, attempt, workerId, startedAt, endedAt, args[],
 *                    task?{model,effort}, configPath?, ledgerDir?}
 *   guards.jsonl    the guard/hook event log (rows carry ts | recordedAt | at)
 *   transcript.jsonl the session transcript (Claude Code JSONL)
 *   receipt.json    the attempt's reverify receipt
 *
 * Zero deps, zero network, zero spawn: every check is a file read, `fsImpl` is injectable,
 * and each check is a small pure function the suite drives on fixtures.
 */

import { readFileSync as fsReadFileSync, existsSync as fsExistsSync } from 'node:fs'
import { join } from 'node:path'

import { modelEffortOf, expectedModelEffort } from '../daemon/src/runner/args.mjs'
import { validateReceipt } from '../scripts/sma/lib/receipts.mjs'

/** The five receipts, in the fixed order they are always printed. */
export const PARITY_RECEIPTS = Object.freeze([
  { id: 'guards', title: 'лог гардов: хуки сработали в окне прогона' },
  { id: 'memory', title: 'след обращения к корпусу памяти в сессии' },
  { id: 'skill', title: 'маркер вызова скилла в транскрипте' },
  { id: 'receipt', title: 'квитанция reverify попытки разбирается' },
  { id: 'profile', title: 'модель/усилие спавна совпадают с профилем работника' },
])

/** A full set is 5 — the number the last output line must reach for exit 0. */
export const PARITY_RECEIPT_COUNT = 5

/** The artifact filenames one run directory holds. */
export const ARTIFACTS = Object.freeze({
  run: 'run.json',
  guards: 'guards.jsonl',
  transcript: 'transcript.jsonl',
  receipt: 'receipt.json',
})

/** The corpus path a session must touch for receipt (b) — matched inside TOOL INPUTS only. */
const MEMORY_MARKER = '.claude/memory'

/** The tool name a skill invocation carries in the transcript (receipt (c)). */
const SKILL_TOOL = 'Skill'

// ── result primitives ─────────────────────────────────────────────────────────

const ok = (id, detail) => ({ id, status: 'ok', detail })
const fail = (id, detail) => ({ id, status: 'fail', detail })
const na = (id, detail) => ({ id, status: 'n-a', detail })

/** A receipt counts as FULFILLED when it is ok or honestly n/a (never when it failed). */
export function isFulfilled(result) {
  return Boolean(result) && (result.status === 'ok' || result.status === 'n-a')
}

// ── injectable IO ─────────────────────────────────────────────────────────────

/** Normalize an injected fs to the two calls this tool makes. */
function io(fsImpl) {
  const f = fsImpl ?? {}
  return {
    existsSync: f.existsSync ?? fsExistsSync,
    readFileSync: f.readFileSync ?? fsReadFileSync,
  }
}

/** Read + parse a JSON file; a missing or corrupt file yields null (never throws). */
export function readJsonFile(fs, path) {
  try {
    return JSON.parse(String(fs.readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** Read a JSONL file into rows; a MISSING file yields null, a corrupt LINE is skipped. */
export function readJsonlFile(fs, path) {
  let raw
  try {
    raw = String(fs.readFileSync(path, 'utf8'))
  } catch {
    return null // absent artifact — the caller turns this into a FAILED receipt, not a crash
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      /* skip a corrupt line (the ledger's fail-open posture) */
    }
  }
  return rows
}

// ── transcript readers (structural, never a text sweep) ───────────────────────

/** The content[] array of a transcript entry (tolerant of message-wrapped shapes). */
function contentItems(entry) {
  if (!entry || typeof entry !== 'object') return []
  const m = entry.message && typeof entry.message === 'object' ? entry.message : entry
  return Array.isArray(m.content) ? m.content : []
}

/** Every tool_use item of a transcript, in order. */
function toolUses(transcript) {
  const out = []
  for (const entry of Array.isArray(transcript) ? transcript : []) {
    for (const item of contentItems(entry)) {
      if (item && item.type === 'tool_use') out.push(item)
    }
  }
  return out
}

/**
 * memoryTouchesIn(transcript) → the tool calls whose INPUT names the corpus. Tool inputs
 * only — the task prompt (a user message) names the memory index too, and certifying the
 * instruction as the read would make this receipt self-fulfilling.
 */
export function memoryTouchesIn(transcript) {
  return toolUses(transcript).filter((t) => {
    let text = ''
    try {
      text = JSON.stringify(t.input ?? {})
    } catch {
      return false
    }
    return text.replace(/\\\\/g, '/').includes(MEMORY_MARKER)
  })
}

/** skillInvocationsIn(transcript) → every `Skill` tool call (receipt (c)'s only source). */
export function skillInvocationsIn(transcript) {
  return toolUses(transcript).filter((t) => t.name === SKILL_TOOL)
}

// ── the five checks (pure; each reads ONE source) ─────────────────────────────

/** Coerce any of the accepted timestamp fields of a log row to epoch ms, or NaN. */
function rowTime(row) {
  const raw = row && (row.ts ?? row.recordedAt ?? row.at ?? row.timestamp)
  return Date.parse(String(raw ?? ''))
}

/**
 * (a) guards — the guard log carries at least one entry inside [startedAt, endedAt].
 * The WINDOW is what makes this a receipt of THIS run rather than of the machine's history.
 */
export function checkGuards({ run, guards } = {}) {
  const id = 'guards'
  if (!Array.isArray(guards)) return fail(id, `лог гардов не найден (${ARTIFACTS.guards})`)
  const from = Date.parse(String(run && run.startedAt))
  const to = Date.parse(String(run && run.endedAt))
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return fail(id, 'окно прогона не задано: run.json без startedAt/endedAt')
  }
  const hits = guards.filter((r) => {
    const t = rowTime(r)
    return Number.isFinite(t) && t >= from && t <= to
  })
  return hits.length
    ? ok(id, `${hits.length} записей гардов в окне прогона`)
    : fail(id, 'в окне прогона нет ни одной записи гардов — хуки не сработали')
}

/**
 * (b) memory — a corpus touch in the transcript, or (when no transcript was captured) a
 * non-empty memory layer on the attempt's decision journal. Two sources, ONE meaning: the
 * session actually reached for the notes.
 */
export function checkMemory({ transcript, journal, attempt } = {}) {
  const id = 'memory'
  const touches = memoryTouchesIn(transcript)
  if (touches.length) return ok(id, `${touches.length} обращений к ${MEMORY_MARKER} в транскрипте`)

  const rows = (Array.isArray(journal) ? journal : []).filter((r) => {
    if (!r || r.layer !== 'memory') return false
    if (attempt != null && r.attempt != null && Number(r.attempt) !== Number(attempt)) return false
    const p = r.payload ?? {}
    return (Array.isArray(p.notes) && p.notes.length > 0) || (Array.isArray(p.reflexes) && p.reflexes.length > 0)
  })
  if (rows.length) return ok(id, `слой memory журнала попытки не пуст (${rows.length} записей)`)

  return Array.isArray(transcript)
    ? fail(id, 'ни обращения к корпусу в транскрипте, ни записей слоя memory')
    : fail(id, `транскрипт не найден (${ARTIFACTS.transcript}) и слой memory пуст`)
}

/**
 * (c) skill — a Skill invocation in the transcript. n/a (and fulfilled, with the reason
 * printed) when the worker profile enables no skills: the honest answer to «did a skill
 * fire» for a worker that has none is «not applicable», never a manufactured OK.
 */
export function checkSkill({ transcript, worker } = {}) {
  const id = 'skill'
  // n/a is a claim about a KNOWN profile that enables no skills. An ABSENT profile is not
  // that claim — it is ignorance, and ignorance never earns a receipt (it would turn every
  // artifact-less run into a free n/a, the exact laundering this tool exists to refuse).
  if (!worker) return fail(id, 'профиль работника не найден — неизвестно, триггерная ли задача')
  const skills = Array.isArray(worker.skills) ? worker.skills.filter(Boolean) : []
  if (!skills.length) return na(id, 'у профиля работника нет включённых скиллов — задача нетриггерная')
  if (!Array.isArray(transcript)) return fail(id, `транскрипт не найден (${ARTIFACTS.transcript})`)
  const hits = skillInvocationsIn(transcript)
  return hits.length
    ? ok(id, `вызовов скилла: ${hits.length} (профиль несёт ${skills.length})`)
    : fail(id, `профиль несёт ${skills.length} скиллов, в транскрипте ни одного вызова`)
}

/**
 * (d) receipt — the reverify receipt exists and parses. A structural receipt (one carrying
 * expected_sha256) is schema-checked by the PRODUCT's own validateReceipt rather than by a
 * second opinion invented here.
 */
export function checkReceipt({ receipt } = {}) {
  const id = 'receipt'
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return fail(id, `квитанция reverify отсутствует или не разбирается (${ARTIFACTS.receipt})`)
  }
  if (typeof receipt.expected_sha256 === 'string') {
    const v = validateReceipt(receipt)
    return v.valid
      ? ok(id, `структурная квитанция «${receipt.id}» проходит схему`)
      : fail(id, `квитанция не проходит схему: ${[...v.missing, ...v.errors].join('; ')}`)
  }
  const verdict = String(receipt.verdict ?? '').trim()
  return verdict
    ? ok(id, `квитанция с вердиктом «${verdict}»`)
    : fail(id, 'квитанция без вердикта и без expected_sha256 — нечего разбирать')
}

/**
 * (e) profile — the spawn's own argument array versus the worker profile in the config.
 * Uses the runner's readers (modelEffortOf / expectedModelEffort), so this receipt can
 * never disagree with the builder that produced the arguments.
 */
export function checkProfile({ run, worker } = {}) {
  const id = 'profile'
  if (!run || !Array.isArray(run.args)) return fail(id, 'в run.json нет массива аргументов спавна')
  if (!worker) return fail(id, 'профиль работника не найден в конфиге (--config / run.json configPath)')
  const observed = modelEffortOf(run.args)
  const expected = expectedModelEffort({ worker, task: run.task })
  const shown = (v) => (v === null ? '(по умолчанию)' : v)
  for (const field of ['model', 'effort']) {
    if (observed[field] !== expected[field]) {
      return fail(id, `${field}: в аргументах ${shown(observed[field])}, в профиле ${shown(expected[field])}`)
    }
  }
  return ok(id, `модель ${shown(observed.model)}, усилие ${shown(observed.effort)} — как в профиле «${worker.id}»`)
}

// ── evaluation + report ───────────────────────────────────────────────────────

/**
 * evaluate(data) → the five results in PARITY_RECEIPTS order. Pure: it receives artifacts
 * that were already loaded, so the suite drives it with fixtures and no disk at all.
 *
 * @param {{run?:object, guards?:object[], transcript?:object[], receipt?:object,
 *          journal?:object[], worker?:object}} data
 * @returns {Array<{id:string, status:string, detail:string}>}
 */
export function evaluate(data = {}) {
  const attempt = data.run && data.run.attempt
  return [
    checkGuards({ run: data.run, guards: data.guards }),
    checkMemory({ transcript: data.transcript, journal: data.journal, attempt }),
    checkSkill({ transcript: data.transcript, worker: data.worker }),
    checkReceipt({ receipt: data.receipt }),
    checkProfile({ run: data.run, worker: data.worker }),
  ]
}

/** The printable label of a status (the three the output contract allows). */
const LABEL = { ok: 'OK', fail: 'FAIL', 'n-a': 'n-a' }

/**
 * formatReport(results) → {lines, fulfilled, exitCode}. `lines` is the five receipt lines
 * PLUS the bare number as its last element — the numeric last line is the whole contract
 * that makes this command receipt-hashable and scorable.
 */
export function formatReport(results) {
  const byId = new Map((Array.isArray(results) ? results : []).map((r) => [r.id, r]))
  const lines = []
  let fulfilled = 0
  for (const { id, title } of PARITY_RECEIPTS) {
    const r = byId.get(id) ?? fail(id, 'проверка не выполнялась')
    if (isFulfilled(r)) fulfilled += 1
    lines.push(`${LABEL[r.status] ?? 'FAIL'} — ${title}: ${r.detail}`)
  }
  lines.push(String(fulfilled))
  return { lines, fulfilled, exitCode: fulfilled === PARITY_RECEIPT_COUNT ? 0 : 1 }
}

export const USAGE = [
  'usage: node tools/terminal-parity-check.mjs <attemptId> [--dir <runDir>] [--config <path>] [--ledger <dir>]',
  '',
  `  Пять квитанций терминального паритета ОДНОГО прогона: ${PARITY_RECEIPTS.map((r) => r.id).join(', ')}.`,
  '  Паритет доказывается артефактами прогона, а не утверждением: отсутствующий артефакт —',
  '  невыполненная квитанция. Последняя строка вывода — число выполненных (0..5); код 0 только при 5/5.',
  '',
  `  <runDir> по умолчанию .sma/runs/<attemptId> и содержит: ${Object.values(ARTIFACTS).join(', ')}.`,
].join('\n')

/** Sanitize an attempt id ('BL-301#1') into the safe directory stem the ledger law uses. */
function safeStem(attemptId) {
  return String(attemptId).replace(/[^A-Za-z0-9._-]/g, '_')
}

/** The task id of an attempt id — `<taskId>#<attempt>` (attemptIdFor's inverse). */
function taskIdOf(attemptId) {
  const s = String(attemptId ?? '')
  const hash = s.lastIndexOf('#')
  return hash > 0 ? s.slice(0, hash) : s
}

/** Parse argv into {attemptId, dir, config, ledger} or {error}. */
export function parseArgv(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : []
  const out = { attemptId: null, dir: null, config: null, ledger: null }
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (a === '--dir' || a === '--config' || a === '--ledger') {
      const value = list[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `флаг ${a} требует значения` }
      out[a.slice(2)] = value
      i += 1
    } else if (a.startsWith('--')) {
      return { error: `неизвестный флаг ${a}` }
    } else if (out.attemptId === null) {
      out.attemptId = a
    } else {
      return { error: `лишний аргумент "${a}"` }
    }
  }
  if (!out.attemptId) return { error: 'не задан идентификатор попытки' }
  return out
}

/**
 * runCheck(argv, {fsImpl, log, err, cwd}) → the process exit code (0 = 5/5, 1 = incomplete,
 * 2 = usage). The whole CLI body, with every seam injected, so the suite exercises the real
 * entry point — including the no-arguments case, which must print usage and NOT exit 0.
 */
export function runCheck(argv, { fsImpl, log = console.log, err = console.error, cwd = process.cwd() } = {}) {
  const parsed = parseArgv(argv)
  if (parsed.error) {
    err(`terminal-parity-check: ${parsed.error}`)
    err(USAGE)
    return 2
  }
  const fs = io(fsImpl)
  const dir = parsed.dir ?? join(cwd, '.sma', 'runs', safeStem(parsed.attemptId))

  const run = readJsonFile(fs, join(dir, ARTIFACTS.run))
  const guards = readJsonlFile(fs, join(dir, ARTIFACTS.guards))
  const transcript = readJsonlFile(fs, join(dir, ARTIFACTS.transcript))
  const receipt = readJsonFile(fs, join(dir, ARTIFACTS.receipt))

  const configPath = parsed.config ?? (run && run.configPath) ?? null
  const config = configPath ? readJsonFile(fs, configPath) : null
  const workerId = run && run.workerId
  const worker =
    config && Array.isArray(config.workers) && workerId
      ? config.workers.find((w) => w && w.id === workerId) ?? null
      : null

  const ledgerDir = parsed.ledger ?? (run && run.ledgerDir) ?? null
  const attemptId = (run && run.attemptId) ?? parsed.attemptId
  const journal = ledgerDir
    ? readJsonlFile(fs, join(ledgerDir, `${safeStem(taskIdOf(attemptId))}.journal.jsonl`))
    : null

  const report = formatReport(evaluate({ run, guards, transcript, receipt, journal, worker }))
  for (const line of report.lines) log(line)
  return report.exitCode
}

// CLI entry: only when executed directly, never on import (the suite imports this module).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/terminal-parity-check.mjs')) {
  process.exit(runCheck(process.argv.slice(2)))
}
