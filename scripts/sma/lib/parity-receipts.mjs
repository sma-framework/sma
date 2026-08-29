/**
 * parity-receipts.mjs — THE FIVE RECEIPTS OF ONE RUN, computed in ONE place.
 *
 * ═════════════════════════ WHAT THIS MODULE IS FOR ═══════════════════════════════
 * «Terminal parity» — a headless worker session is the same session a person gets in their
 * own terminal — is a claim that is worthless when ASSERTED and load-bearing when PROVEN.
 * It is therefore never proven by prose, by a green suite or by the daemon's word: it is
 * proven by the ARTIFACTS one real attempt left behind in `<project>/.sma/runs/<attemptId>/`
 * — `run.json`, `guards.jsonl`, `transcript.jsonl`, `receipt.json`.
 *
 * WHY ONE MODULE AND NOT TWO. The verdict is needed in two places: the command a person runs
 * by hand, and the daemon that writes the verdict back beside the attempt. Two implementations
 * of «did the hooks fire» would agree on the day they were written and drift on every day
 * after, and the first person to notice would be the one holding a green report over a red
 * run. So the evaluation lives here, exported once, and both callers import it. Neither of
 * them is allowed a private copy of the logic — a second opinion here is not resilience, it
 * is a second answer to a question that has one.
 *
 * ═════════════════ THE FIVE, WHAT EACH PROVES AND WHAT IT DOES NOT ═══════════════
 *
 *  (a) hooks  — at least one hook ANSWERED inside this run's own time window. The window is
 *               what makes it a receipt of THIS attempt rather than of the machine's history.
 *               A start with no answer is not «probably fine»: it is written down as a
 *               failure that says so, because a hook that was launched and never replied is
 *               exactly the shape of a guard that was not actually guarding.
 *               PROVES: something was watching in that session.
 *               DOES NOT PROVE: that what it watched was refused correctly.
 *
 *  (b) memory — the corpus was actually READ: the index came back, or the search was called.
 *               The fact is counted by the DAEMON out of the live stream, where a request and
 *               its result are still paired, and this module believes that count instead of
 *               re-deriving it from a transcript that a line cap may have cut in half. That
 *               difference is not a nicety: a read that FAILED (a copy without `.claude/`,
 *               «File does not exist») looks exactly like a read that succeeded to anybody
 *               parsing requests alone, and it was scored as success for a year.
 *               PROVES: the notes reached the session.
 *               DOES NOT PROVE: that the session used what it read.
 *
 *  (c) rules  — the project's own instruction file reached the working copy, materialized
 *               into it or tracked by it. `absent` is a failure and not a footnote: a worker
 *               that never saw the project's rules is not running under them.
 *
 *  (d) skills — the copy carries skills or agents. A project that has NEITHER directory earns
 *               an honest `n/a` WITH THE REASON PRINTED — not a pass. «Not applicable» and
 *               «passed» are different words on purpose: the first one is a fact about the
 *               project, the second would be a fact about the run that nobody established.
 *
 *  (e) rights — BOTH halves of the capability envelope reached the spawn: the tools it granted
 *               equal the allow list on the command line, and the actions it reserved for a
 *               human equal the refusal list on the same command line.
 *
 *               This receipt spent its whole life pinned at `warn` on a perfect match, and the
 *               warning was true: only the grant travelled, and the four human-only actions
 *               were computed, hashed and journalled without ever reaching the process — «the
 *               worker cannot push» was a property of the prompt and of nothing else. It is
 *               allowed to be `ok` now for one reason only: the refusal became an argument, was
 *               measured landing in a live session's denial list, and is compared here as a set
 *               like the grant is. If either half stops travelling, this goes red — an envelope
 *               that names human-only actions while the spawn carries no refusal list is a
 *               FAILURE, not a warning, because that is exactly the state it used to certify.
 *
 *               PROVES: the boundary a run stood under is the boundary its envelope declared.
 *               DOES NOT PROVE: that the boundary cannot be walked around from inside the
 *               session. The refusal list catches the obvious spellings; it is one of three
 *               locks and never the only one.
 *
 * ══════════════════════════ THE LAW OF ABSENT DATA ═══════════════════════════════
 * Missing data is a FAILURE that names what was missing — never a default OK and never a free
 * n/a. This is the whole reason the module exists: the cheapest way to a five-out-of-five is
 * to check nothing, and a checker that treats an empty directory as an unproblematic one is
 * indistinguishable from a checker that lies. `n/a` is available for exactly one situation —
 * a project that demonstrably has no skills — and it carries its reason in the same string.
 *
 * Pure by construction: it is handed the four artifacts already parsed. No disk, no network,
 * no clock beyond «now» for a run that has not ended yet.
 */

// THE ACTION → PATTERN TABLE IS IMPORTED, NEVER RESTATED. The spawn builds its refusal list
// from this same function; a private copy here would agree with it on the day it was written
// and drift on every day after, and the first person to notice would be holding a green
// receipt over a run whose boundary never travelled.
import { humanOnlyDenials } from '../../../daemon/src/queue/capability-envelope.mjs'
// AND SO IS THE READER OF THE COMMAND LINE, for the same reason: what a spawn stood under is
// read back in the exact shape the argument builder pushed it in, by the module that owns that
// shape — never by a private copy of the rule living here.
import { toolListInArgs } from '../../../daemon/src/runner/tool-flags.mjs'

/** The five receipts, in the fixed order they are always evaluated and printed. */
export const PARITY_RECEIPTS = Object.freeze([
  Object.freeze({ id: 'hooks', title: 'хуки: страж ответил в окне прогона' }),
  Object.freeze({ id: 'memory', title: 'память: корпус прочитан, а не только запрошен' }),
  Object.freeze({ id: 'rules', title: 'правила проекта доехали до рабочей копии' }),
  Object.freeze({ id: 'skills', title: 'навыки и агенты проекта видны в копии' }),
  Object.freeze({ id: 'rights', title: 'права: спавн получил и то, что конверт разрешил, и то, что запретил' }),
])

/** A full set is 5 — the number a report's last line must reach for an exit code of 0. */
export const PARITY_RECEIPT_COUNT = 5

/** The four filenames one run directory holds — the writer and every reader agree here. */
export const ARTIFACTS = Object.freeze({
  run: 'run.json',
  guards: 'guards.jsonl',
  transcript: 'transcript.jsonl',
  receipt: 'receipt.json',
})

/** The reason a project without either directory earns n/a rather than a pass. */
const NO_SKILLS_REASON = 'в проекте нет .claude/skills и .claude/agents'

// ── result primitives ─────────────────────────────────────────────────────────

const ok = (id, detail) => ({ id, status: 'ok', detail })
const fail = (id, detail) => ({ id, status: 'fail', detail })
const na = (id, detail) => ({ id, status: 'n-a', detail })

/** The phrase every «missing data» failure starts with, so one grep finds them all. */
const noData = (id, what) => fail(id, `данных нет: ${what}`)

/**
 * A receipt counts as FULFILLED when it is ok, honestly n/a, or a warn that named its own
 * limit. Never when it failed — and never for a status this module did not produce.
 */
export function isFulfilled(result) {
  if (!result || typeof result !== 'object') return false
  return result.status === 'ok' || result.status === 'warn' || result.status === 'n-a'
}

// ── (a) hooks ─────────────────────────────────────────────────────────────────

/** Epoch ms of a guard row's timestamp, or NaN for a row that carries none. */
function rowTime(row) {
  return Date.parse(String((row && row.ts) ?? ''))
}

/**
 * The run's own window. `endedAt` is absent while the attempt is still going, and a live run
 * is measured up to now rather than refused: «not finished» is not «not observed».
 */
function windowOf(run, now) {
  const from = Date.parse(String((run && run.startedAt) ?? ''))
  const rawTo = run && run.endedAt
  const to = rawTo ? Date.parse(String(rawTo)) : now
  return { from, to: Number.isFinite(to) ? to : now }
}

function checkHooks({ run, guards, now }) {
  const id = 'hooks'
  if (!Array.isArray(guards)) return noData(id, `лог стражей (${ARTIFACTS.guards})`)
  const { from, to } = windowOf(run, now)
  if (!Number.isFinite(from)) return noData(id, `окно прогона (run.json без startedAt)`)

  const inWindow = guards.filter((r) => {
    const t = rowTime(r)
    return Number.isFinite(t) && t >= from && t <= to
  })
  const answered = inWindow.filter((r) => r && r.kind === 'hook_response')
  if (answered.length) {
    const names = [...new Set(answered.map((r) => String(r.hookEvent || r.hookName || '?')))]
    return ok(id, `ответов хуков в окне прогона: ${answered.length} (${names.join(', ')})`)
  }
  const started = inWindow.filter((r) => r && r.kind === 'hook_started')
  if (started.length) {
    return fail(id, `хук запущен, ответа нет: ${started.length} запусков без единого ответа`)
  }
  return fail(id, 'в окне прогона нет ни одного ответа хука — никто не сторожил')
}

// ── (b) memory ────────────────────────────────────────────────────────────────

function checkMemory({ receipt }) {
  const id = 'memory'
  const layer = receipt && typeof receipt.memoryLayer === 'object' ? receipt.memoryLayer : null
  if (!layer) return noData(id, `слой памяти (receipt.memoryLayer)`)

  const loadCalls = Number.isFinite(Number(layer.loadCalls)) ? Number(layer.loadCalls) : 0
  if (layer.index === true) {
    const reads = Array.isArray(layer.reads) ? layer.reads.length : 0
    return ok(id, `индекс прочитан; заметок прочитано: ${reads}, вызовов load: ${loadCalls}`)
  }
  if (loadCalls >= 1) return ok(id, `индекс не читался, поиск по корпусу вызван: load ${loadCalls}`)

  const failed = Array.isArray(layer.failed) ? layer.failed : []
  if (failed.length) {
    const named = failed
      .map((f) => `${String((f && (f.id || f.kind)) ?? '?')}: ${String((f && f.reason) ?? 'причина не записана')}`)
      .join('; ')
    return fail(id, `корпус не прочитан, провалы записаны — ${named}`)
  }
  return fail(id, 'корпус не прочитан: ни индекса, ни вызовов load, провалов тоже не записано')
}

// ── (c) rules ─────────────────────────────────────────────────────────────────

/** The states of the project's instruction file that mean it actually reached the copy. */
const RULES_PRESENT = Object.freeze(['materialized', 'tracked'])

function checkRules({ run, receipt }) {
  const id = 'rules'
  // The receipt is the record of the outcome and is preferred; run.json holds the same fact
  // observed at the start, and is the honest fallback for an attempt that ended early.
  const fromReceipt = receipt && typeof receipt.rules === 'object' ? receipt.rules : null
  const fromRun = run && typeof run.rules === 'object' ? run.rules : null
  const source = fromReceipt ? 'receipt.json' : 'run.json'
  const rules = fromReceipt ?? fromRun
  if (!rules) return noData(id, `состояние правил (rules в receipt.json и run.json)`)

  const state = String(rules.claudeMd ?? '')
  if (RULES_PRESENT.includes(state)) return ok(id, `правила проекта в копии: ${state} (по ${source})`)
  if (state === 'absent') return fail(id, `правил проекта в копии нет (absent, по ${source})`)
  return noData(id, `состояние правил (rules.claudeMd в ${source})`)
}

// ── (d) skills ────────────────────────────────────────────────────────────────

function checkSkills({ run, receipt }) {
  const id = 'skills'
  const has = (v) => v && typeof v === 'object'
  const counts = has(receipt && receipt.skillsInCopy)
    ? receipt.skillsInCopy
    : has(run && run.skillsInCopy)
      ? run.skillsInCopy
      : null
  // TWO SILENCES, AND ONLY ONE OF THEM IS A FACT ABOUT THE PROJECT. A record that carries the
  // field and leaves it null is the counter reporting what it saw — this copy holds no `.claude`
  // at all — and that is an honest n/a. A record that does not carry the field means nobody
  // counted, and «the project has no skills and no agents» would then be a statement about
  // something no one looked at, counted towards a full set. Absence of the record is absence of
  // evidence: it goes red and names what is missing.
  if (!counts) {
    const stated = (o) => o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, 'skillsInCopy')
    return stated(receipt) || stated(run) ? na(id, NO_SKILLS_REASON) : noData(id, 'skillsInCopy (копию никто не считал)')
  }

  const skills = Number(counts.skills) || 0
  const agents = Number(counts.agents) || 0
  if (skills + agents > 0) return ok(id, `в копии навыков: ${skills}, агентов: ${agents}`)
  return na(id, NO_SKILLS_REASON)
}

// ── (e) rights ────────────────────────────────────────────────────────────────

/**
 * The tool list as it actually appears on the command line: the `--allowedTools` flag followed
 * by ONE ARGUMENT PER NAME (the shape the argument builder produces). It is read from the
 * arguments rather than from anybody's intention — «what the envelope said» and «what the
 * process was given» are two claims, and this receipt exists to compare them.
 *
 * THE READER IS IMPORTED, NOT WRITTEN HERE, and that is the whole point of the import. This
 * module used to split the flag's single glued value back apart on its own, tracking bracket
 * depth so that a space inside `Bash(git push:*)` would not tear the pattern in half — a
 * careful reader compensating for a lossy writer. The writer is fixed: names travel as
 * separate argument values, delimited by the operating system rather than by a character that
 * also occurs inside them. A private copy of the reading rule here would be a second opinion
 * about a shape that has one owner, and it would drift from that owner the next time it moves.
 *
 * `null` — the flag is not on the command line at all. A record written by the OLDER wire
 * reads as ONE entry containing every pattern, which matches no name and shows up as a
 * divergence: the safe direction, a boundary that is looked at rather than one that passes.
 */
export function allowedToolsInArgs(args) {
  const values = toolListInArgs(args, '--allowedTools')
  return values === null || values.length === 0 ? null : values
}

/**
 * The REFUSAL list as it actually appears on the command line — the `--disallowedTools` flag
 * and one argument per pattern. Read the same way and for the same reason as the grant: this
 * receipt's whole job is to compare what the envelope said against what the process was given,
 * and an intention read off the envelope twice would compare nothing.
 */
export function disallowedToolsInArgs(args) {
  const values = toolListInArgs(args, '--disallowedTools')
  return values === null || values.length === 0 ? null : values
}

/** Two tool lists as SETS: the order on a command line carries no meaning. */
function setDiff(a, b) {
  const right = new Set(b)
  return a.filter((x) => !right.has(x))
}

/**
 * checkRights — the envelope against the command line, in BOTH directions it has.
 *
 * The grant («which tools») and the refusal («which actions belong to a person») are two
 * separate journeys, and for the whole life of this product only the first one was made. So
 * they are measured separately here, and the receipt is green only when both arrived.
 *
 * The mapping from human-only ACTION NAMES to tool patterns is imported, never restated: the
 * spawn builds its refusal list from that same function, and a second copy of the table in
 * this file would let the two agree on the day it was written and drift on every day after —
 * with the first person to notice holding a green receipt over a run that carried nothing.
 */
function checkRights({ run, worker }) {
  const id = 'rights'
  if (!run || !Array.isArray(run.args)) return noData(id, `аргументы спавна (run.args)`)
  const envelope = run.envelope && typeof run.envelope === 'object' ? run.envelope : null
  const expected = envelope && Array.isArray(envelope.allowedTools) ? envelope.allowedTools.map(String) : []
  if (!expected.length) return noData(id, `конверт разрешений (run.envelope.allowedTools)`)

  const who = worker && worker.id ? `работник «${String(worker.id)}»` : 'работник не назван в конфиге'

  // ── (1) что конверт РАЗРЕШИЛ ──
  const observed = allowedToolsInArgs(run.args)
  if (observed === null) {
    return fail(id, `конверт несёт ${expected.length} инструментов, а в аргументах спавна нет --allowedTools (${who})`)
  }
  const missing = setDiff(expected, observed)
  const extra = setDiff(observed, expected)
  if (missing.length || extra.length) {
    const parts = []
    if (missing.length) parts.push(`не доехали: ${missing.join(', ')}`)
    if (extra.length) parts.push(`лишние в аргументах: ${extra.join(', ')}`)
    return fail(id, `конверт и аргументы спавна расходятся — ${parts.join('; ')} (${who})`)
  }

  // ── (2) что конверт ЗАПРЕТИЛ ──
  const { patterns: expectedDenials, unmapped } = humanOnlyDenials(envelope)
  const observedDenials = disallowedToolsInArgs(run.args) ?? []
  if (expectedDenials.length && observedDenials.length === 0) {
    // ИМЕННО ЭТО состояние квитанция удостоверяла раньше зелёным-с-оговоркой. Оно провал.
    return fail(
      id,
      `конверт оставляет человеку ${expectedDenials.length} запретов, а в аргументах спавна нет --disallowedTools — граница осталась в журнале (${who})`,
    )
  }
  const denialsMissing = setDiff(expectedDenials, observedDenials)
  const denialsExtra = setDiff(observedDenials, expectedDenials)
  if (denialsMissing.length || denialsExtra.length) {
    const parts = []
    if (denialsMissing.length) parts.push(`не доехали запреты: ${denialsMissing.join(', ')}`)
    if (denialsExtra.length) parts.push(`лишние запреты в аргументах: ${denialsExtra.join(', ')}`)
    return fail(id, `запреты конверта и аргументы спавна расходятся — ${parts.join('; ')} (${who})`)
  }
  // Действие конверта, для которого у карты нет ни одного шаблона, — это запрет, который
  // существует в журнале и нигде больше; пропустить его молча значит удостоверить его.
  if (unmapped.length) {
    return fail(
      id,
      `у конверта есть человеческие действия без единого шаблона запрета: ${unmapped.join(', ')} — они не доехали никуда (${who})`,
    )
  }

  const denialWords = expectedDenials.length
    ? `${expectedDenials.length} запретов`
    : 'конверт не назвал ни одного человеческого действия'
  return ok(id, `${expected.length} инструментов конверта и ${denialWords} доехали до спавна (${who})`)
}

// ── evaluation ────────────────────────────────────────────────────────────────

/**
 * evaluateParity({run, guards, receipt, worker, now}) → the five results in PARITY_RECEIPTS
 * order, each `{id, status, detail}` with status one of `ok | warn | n-a | fail`.
 *
 * Without BOTH `run.json` and `receipt.json` there is nothing to evaluate at all, and the
 * answer is five failures naming the files — not four failures and a lucky n/a.
 *
 * @param {{run?:object, guards?:object[], receipt?:object, worker?:object, now?:number}} [data]
 * @returns {Array<{id:string, status:string, detail:string}>}
 */
export function evaluateParity(data = {}) {
  const run = data.run && typeof data.run === 'object' ? data.run : null
  const receipt = data.receipt && typeof data.receipt === 'object' ? data.receipt : null
  if (!run || !receipt) {
    const missing = [run ? null : ARTIFACTS.run, receipt ? null : ARTIFACTS.receipt].filter(Boolean).join('/')
    return PARITY_RECEIPTS.map(({ id }) => noData(id, missing))
  }
  const now = Number.isFinite(data.now) ? data.now : Date.now()
  return [
    checkHooks({ run, guards: data.guards, now }),
    checkMemory({ receipt }),
    checkRules({ run, receipt }),
    checkSkills({ run, receipt }),
    checkRights({ run, worker: data.worker }),
  ]
}

/**
 * summarize(results) → `{fulfilled, total, warn, ok, failed}`. A receipt the caller never
 * produced counts as unfulfilled and is named in `failed`: a report that silently shrinks to
 * four lines is the same lie as one that prints a green over an empty directory.
 *
 * @param {Array<{id:string,status:string,detail:string}>} results
 */
export function summarize(results) {
  const byId = new Map((Array.isArray(results) ? results : []).filter((r) => r && r.id).map((r) => [r.id, r]))
  const out = { fulfilled: 0, total: PARITY_RECEIPT_COUNT, warn: 0, ok: 0, failed: [] }
  for (const { id } of PARITY_RECEIPTS) {
    const r = byId.get(id)
    if (!isFulfilled(r)) {
      out.failed.push(id)
      continue
    }
    out.fulfilled += 1
    if (r.status === 'warn') out.warn += 1
    if (r.status === 'ok') out.ok += 1
  }
  return out
}
