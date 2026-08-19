#!/usr/bin/env node
/**
 * terminal-parity-check.mjs — ONE COMMAND OVER ONE RUN DIRECTORY, a numeric verdict.
 *
 * ═══════════════════════════ WHAT THIS COMMAND IS ════════════════════════════════
 * A headless worker session is supposed to be the same session a person gets in their own
 * terminal: the same hooks watching it, the same memory under it, the same project rules
 * around it, the same skills beside it, the same permissions over it. That sentence is
 * worthless as a claim and load-bearing as a receipt, so this command never argues it — it
 * READS what one real attempt left on disk and prints five lines that can each be checked
 * by hand afterwards.
 *
 *     node tools/terminal-parity-check.mjs                 # the latest attempt of this project
 *     node tools/terminal-parity-check.mjs <attemptId>     # a named one
 *     node tools/terminal-parity-check.mjs --attempt <id> --project <dir> --json
 *
 * WHAT IT READS. `<project>/.sma/runs/<attemptId>/` — the directory the daemon writes for
 * every attempt: `run.json` (what the attempt was given: the command line, the capability
 * envelope, the copy, the state of the project's rules), `guards.jsonl` (one line per hook
 * started and answered, one per tool refused), `transcript.jsonl` (a REFERENCE to the
 * attempt's transcript in the ledger, with its digest — never a second copy of it) and
 * `receipt.json` (how the attempt ended, with the memory layer as the live stream observed
 * it). Nothing is inferred from a text sweep, nothing is spawned, nothing is written.
 *
 * WHY THE VERDICT IS NOT COMPUTED HERE. It lives in `scripts/sma/lib/parity-receipts.mjs`,
 * which the daemon imports too. Two implementations of «did the hooks fire» would agree on
 * the day they were written and drift on every day after, and the first person to notice
 * would be the one holding a green report over a red run. This file is the MOUTH: it finds
 * the directory, reads the four files, prints, and returns an exit code.
 *
 * WHAT IT DOES NOT PROVE. That the worker was USEFUL; that the guards refused the right
 * things; that the memory it read was the memory it needed. It proves that the machinery a
 * person's own terminal gives them was present around that session — no more, and it says
 * so on the one line that is allowed to be a warning rather than a pass.
 *
 * OUTPUT CONTRACT. Five lines `«OK|WARN|n/a|FAIL — <receipt>: <detail>»`, then a LAST LINE
 * that is a bare number 0..5 (receipt-hash and scorer friendly). Exit 0 only on a full set;
 * 1 on an incomplete one; 2 on a misused command line. `--json` prints the same verdict as
 * an object first and the same bare number last. Notes that are not receipts — the state of
 * the ledger reference, an empty `.sma/runs` — go to stderr, so the stdout contract never
 * grows a sixth line.
 *
 * Zero deps, zero network, zero spawn: every check is a file read, `fsImpl` is injectable,
 * and the suite drives this entry point over an in-memory filesystem.
 */

import { createHash } from 'node:crypto'
import { readFileSync as fsReadFileSync, existsSync as fsExistsSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from 'node:fs'
import { join } from 'node:path'

import {
  PARITY_RECEIPTS,
  PARITY_RECEIPT_COUNT,
  ARTIFACTS,
  evaluateParity,
  summarize,
} from '../scripts/sma/lib/parity-receipts.mjs'

export { PARITY_RECEIPTS, PARITY_RECEIPT_COUNT, ARTIFACTS }

/** The printable label of every status the shared module can return. */
export const LABEL = Object.freeze({ ok: 'OK', warn: 'WARN', 'n-a': 'n/a', fail: 'FAIL' })

// ── injectable IO ─────────────────────────────────────────────────────────────

/** Normalize an injected fs to the four calls this command makes. */
function io(fsImpl) {
  const f = fsImpl ?? {}
  return {
    existsSync: f.existsSync ?? fsExistsSync,
    readFileSync: f.readFileSync ?? fsReadFileSync,
    readdirSync: f.readdirSync ?? fsReaddirSync,
    statSync: f.statSync ?? fsStatSync,
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
    return null // an absent artifact becomes a FAILED receipt upstream, never a crash
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      /* a corrupt line is skipped — the ledger's own fail-open posture */
    }
  }
  return rows
}

// ── finding the attempt ───────────────────────────────────────────────────────

/** Sanitize an attempt id into the directory stem the writer uses (the same rule, verbatim). */
export function safeStem(attemptId) {
  return String(attemptId).replace(/[^A-Za-z0-9._-]/g, '_')
}

/** `<project>/.sma/runs` — the one place this product keeps the runs of a project. */
export function runsDirOf(projectDir) {
  return join(String(projectDir ?? '.'), '.sma', 'runs')
}

/**
 * latestRunDir(fs, runsDir) → the newest attempt directory, or null when there is none.
 *
 * Age is read from `run.json.startedAt` and falls back to the directory's own mtime: a
 * directory whose `run.json` never landed is exactly the leftover a person is most likely to
 * be looking at, and it must not become invisible for being unreadable.
 */
export function latestRunDir(fs, runsDir) {
  let names = []
  try {
    names = (fs.readdirSync(runsDir) || []).map((n) => (typeof n === 'string' ? n : n && n.name)).filter(Boolean)
  } catch {
    return null // no runs directory yet is a state of the world, not an error
  }
  const dated = []
  for (const name of names) {
    const path = join(runsDir, name)
    let at = Date.parse(String((readJsonFile(fs, join(path, ARTIFACTS.run)) || {}).startedAt ?? ''))
    if (!Number.isFinite(at)) {
      try {
        at = Number(fs.statSync(path).mtimeMs)
      } catch {
        at = 0
      }
    }
    dated.push({ path, at: Number.isFinite(at) ? at : 0 })
  }
  if (!dated.length) return null
  dated.sort((a, b) => b.at - a.at)
  return dated[0].path
}

// ── the ledger reference (a note, never a receipt) ────────────────────────────

/**
 * ledgerNote(fs, transcript, override) → one sentence about the attempt's transcript.
 *
 * `transcript.jsonl` holds ONE line: a reference to the attempt's transcript in the ledger,
 * with the digest of that file at the moment of writing. Comparing the digest tells a reader
 * whether the transcript they are about to open is still the one this run produced.
 *
 * IT IS DELIBERATELY NOT ONE OF THE FIVE. The receipts are about what the SESSION had around
 * it; a ledger that was rotated, moved or rewritten afterwards is a fact about the STORE, and
 * letting it sink the verdict would mean a perfectly parity-complete run going red because a
 * log was tidied up a week later.
 */
export function ledgerNote(fs, transcript, override) {
  if (!Array.isArray(transcript) || !transcript.length) {
    return `данных нет: ссылка на леджер (${ARTIFACTS.transcript})`
  }
  const ref = transcript[0]
  if (!ref || ref.kind !== 'ledger-ref') {
    return `первая строка ${ARTIFACTS.transcript} — не ссылка на леджер`
  }
  const path = override ?? ref.ledgerPath ?? null
  if (!path) return 'леджер недоступен: в ссылке нет пути'
  let raw
  try {
    raw = String(fs.readFileSync(path, 'utf8'))
  } catch {
    return `леджер недоступен: ${path}`
  }
  const sha = createHash('sha256').update(raw, 'utf8').digest('hex')
  if (typeof ref.sha256 === 'string' && ref.sha256 !== sha) {
    return `леджер изменился после записи: в ссылке ${ref.sha256.slice(0, 12)}…, сейчас ${sha.slice(0, 12)}… (${path})`
  }
  const truncated = Number(ref.truncatedLines) || 0
  const tail = truncated ? `, обрезанных строк: ${truncated}` : ''
  return `леджер на месте: строк ${Number(ref.lines) || 0}, дайджест совпал${tail} (${path})`
}

// ── the report ────────────────────────────────────────────────────────────────

/**
 * formatReport(results) → `{lines, fulfilled, exitCode}`. `lines` is the five receipt lines
 * PLUS the bare number as its last element — the numeric last line is the whole contract that
 * makes this command receipt-hashable and scorable.
 */
export function formatReport(results) {
  const byId = new Map((Array.isArray(results) ? results : []).filter((r) => r && r.id).map((r) => [r.id, r]))
  const sum = summarize(results)
  const lines = []
  for (const { id, title } of PARITY_RECEIPTS) {
    const r = byId.get(id) ?? { status: 'fail', detail: 'проверка не выполнялась' }
    lines.push(`${LABEL[r.status] ?? LABEL.fail} — ${title}: ${r.detail}`)
  }
  lines.push(String(sum.fulfilled))
  return { lines, fulfilled: sum.fulfilled, exitCode: sum.fulfilled === PARITY_RECEIPT_COUNT ? 0 : 1 }
}

export const USAGE = [
  'usage: node tools/terminal-parity-check.mjs [<attemptId>] [--attempt <id>] [--project <dir>]',
  '                                            [--dir <runDir>] [--config <path>] [--ledger <path>] [--json]',
  '',
  `  Пять квитанций терминального паритета ОДНОГО прогона: ${PARITY_RECEIPTS.map((r) => r.id).join(', ')}.`,
  '  Паритет доказывается артефактами прогона, а не утверждением: данных нет — квитанция',
  '  не выполнена. Последняя строка вывода — число выполненных (0..5); код 0 только при 5/5.',
  '',
  '  Без идентификатора берётся ПОСЛЕДНЯЯ попытка проекта по startedAt.',
  `  <runDir> по умолчанию <project>/.sma/runs/<attemptId> и содержит: ${Object.values(ARTIFACTS).join(', ')}.`,
  '  --project — корень проекта (по умолчанию текущий каталог); --ledger — путь к леджеру,',
  '  если он переехал; --json печатает объект и то же число последней строкой.',
].join('\n')

/**
 * parseArgv(argv) → `{attemptId, dir, project, config, ledger, json}` or `{error}`.
 *
 * The absence of an attempt id is NOT an error: it means «the latest one», which is what a
 * person almost always wants and what a person almost never wants to type.
 */
export function parseArgv(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : []
  const out = { attemptId: null, dir: null, project: null, config: null, ledger: null, json: false }
  const valued = new Set(['--dir', '--config', '--ledger', '--project', '--attempt'])
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (valued.has(a)) {
      const value = list[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `флаг ${a} требует значения` }
      if (a === '--attempt') {
        if (out.attemptId !== null) return { error: 'идентификатор попытки задан дважды' }
        out.attemptId = value
      } else {
        out[a.slice(2)] = value
      }
      i += 1
    } else if (a === '--json') {
      out.json = true
    } else if (a.startsWith('--')) {
      return { error: `неизвестный флаг ${a}` }
    } else if (out.attemptId === null) {
      out.attemptId = a
    } else {
      return { error: `лишний аргумент "${a}"` }
    }
  }
  return out
}

/**
 * runCheck(argv, {fsImpl, log, err, cwd, now}) → the process exit code (0 = 5/5, 1 = an
 * incomplete set or nothing to read, 2 = a misused command line). The whole CLI body with
 * every seam injected, so the suite exercises the real entry point rather than a rehearsal
 * of it — including the case where the project has no runs at all.
 */
export function runCheck(argv, { fsImpl, log = console.log, err = console.error, cwd = process.cwd(), now } = {}) {
  const parsed = parseArgv(argv)
  if (parsed.error) {
    err(`terminal-parity-check: ${parsed.error}`)
    err(USAGE)
    return 2
  }
  const fs = io(fsImpl)
  const runsDir = runsDirOf(parsed.project ?? cwd)

  let dir = parsed.dir ?? null
  if (!dir) dir = parsed.attemptId ? join(runsDir, safeStem(parsed.attemptId)) : latestRunDir(fs, runsDir)
  if (!dir) {
    // NOT a silent zero: a person who ran this in the wrong directory must be told which
    // directory was looked at, or they will read the five failures as a verdict on the run.
    err(`terminal-parity-check: данных нет: .sma/runs пуст или отсутствует (${runsDir})`)
  }

  const run = dir ? readJsonFile(fs, join(dir, ARTIFACTS.run)) : null
  const guards = dir ? readJsonlFile(fs, join(dir, ARTIFACTS.guards)) : null
  const transcript = dir ? readJsonlFile(fs, join(dir, ARTIFACTS.transcript)) : null
  const receipt = dir ? readJsonFile(fs, join(dir, ARTIFACTS.receipt)) : null

  const configPath = parsed.config ?? (run && run.configPath) ?? null
  const config = configPath ? readJsonFile(fs, configPath) : null
  const workerId = run && run.workerId
  const worker =
    config && Array.isArray(config.workers) && workerId
      ? config.workers.find((w) => w && w.id === workerId) ?? null
      : null

  if (dir) err(`terminal-parity-check: ${ledgerNote(fs, transcript, parsed.ledger)}`)

  const results = evaluateParity({ run, guards, receipt, worker, now })
  const report = formatReport(results)

  if (parsed.json) {
    log(
      JSON.stringify(
        {
          attemptId: (run && run.attemptId) ?? parsed.attemptId ?? null,
          dir,
          receipts: results.map(({ id, status, detail }) => ({ id, status, detail })),
          fulfilled: report.fulfilled,
          exitCode: report.exitCode,
        },
        null,
        2,
      ),
    )
    log(String(report.fulfilled)) // the bare number stays the last line in every mode
    return report.exitCode
  }

  for (const line of report.lines) log(line)
  return report.exitCode
}

// CLI entry: only when executed directly, never on import (the suite imports this module).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/terminal-parity-check.mjs')) {
  process.exit(runCheck(process.argv.slice(2)))
}
