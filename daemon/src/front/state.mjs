/**
 * state.mjs — the roster's ONE-POLL payload: derive everything, store nothing.
 *
 * ═══════════════════════ DERIVE, NEVER STORE ════════════════════════════════════
 * deriveState re-computes the WHOLE roster truth from durable sources every call — the
 * pg-boss rows (adapter.list), the per-attempt ledger, the honest window model, and the
 * usage book. No cache, no memo: a poll after ANY daemon restart is correct by
 * construction (the daemon holds no task state). The poll cadence (2-5s) is the researched
 * choice; the live-hint SSE layer (Task 4) is additive, never the source of truth.
 *
 * ═══════════════════════ PATTERN 2 — TWO LIVENESS AXES ══════════════════════════
 * The payload exposes BOTH axes but labels them: the QUEUE axis (counts, status,
 * agedForHours) drives requeue decisions UPSTREAM (the tick), never the roster; the
 * PULSE axis (pulseAgeSec) is an attention hint for the human. `presence` is a PURE
 * derive (window open × active task × touch freshness) — there is NO stored «working»
 * flag anywhere for it to read — a stored «working» flag was Multica's top prod complaint.
 *
 * ═══════════════════════ WHAT THE ROSTER RENDERS ════════════════════════════════
 *   - agedForHours on a queue row ONLY when it has been queued past config.agingHours
 *     (pure derive from the enqueuedAt timestamp, never a stored flag); on a row waiting
 *     for a PERSON the same field is the wait itself — fractional hours since the work
 *     stopped (completedAt), with no threshold and no field at all where the stop was
 *     never marked;
 *   - `acceptance` («обещано») carried onto done rows when the task had one, omitted
 *     when it did not (roster/return tasks are DoR-exempt);
 *   - failed rows carry {reason, reasonLabel} — reasonLabel from REASON_LABELS
 *     (adapter.mjs, the single source); the raw code still travels for machines.
 *
 * ═══════════ V5.1 — PROJECTS, MACHINES, FEDERATION ══════════════════════════════
 * The payload gains `projects[]`, `activeProject`, `machines[]` and `federation` — all
 * DERIVED, none stored: projects come from the config registry, their counts from the
 * queue selection, the machine from the config plus its federation role.
 *
 * THE SHAPE IS FINAL NOW, ON PURPOSE. `machines[]` holds this machine
 * ({id, title, role:'self', online:true}) and `federation.hubReachable` exists before
 * anything probes a hub. The SPA types the contract once and never revises it.
 * `hubReachable` is an injectable seam (`deps.hubReachable`) defaulting to true: nothing
 * has proven a hub unreachable until a probe is wired.
 *
 * ═══════════ THE AGGREGATOR SEAM — FILLED, NEVER REDEFINED ══════════════════════
 * A HUB daemon injects `deps.aggregator`: the last step of the derive hands the finished
 * local payload to it and returns what comes back — federation.mjs merges each peer's
 * machines[] entry and its rows into the SAME key set. Three properties make this seam
 * safe to have in the hot path of every poll:
 *   - ABSENT MEANS UNCHANGED. A standalone daemon injects nothing and gets byte-identical
 *     output to the pre-federation derive; the whole feature is invisible to it.
 *   - FAIL-OPEN. An aggregator that throws or returns a non-object is DISCARDED and the
 *     local payload is served. A peer storm must never blank the founder's own machine.
 *   - THIS FILE STILL STORES NOTHING. The peer snapshots (and their documented
 *     derive-never-store exception) live inside federation.mjs; deriveState only composes.
 *
 * Every task row carries its project and its machine, so a screen FILTERS instead of
 * guessing. The optional `project` filter narrows tasks and the kpis; it deliberately does
 * NOT narrow `projects[]` or `machines[]` — the project switcher has to see all of them,
 * and per-project counts are what make it useful.
 *
 * A ROW'S PROJECT IS THE ROW'S OWN, AND `null` WHEN IT HAS NONE. This file used to fill the
 * gap in with the project currently selected, which made every row that never named one
 * belong to whatever was being looked at — the same tasks under both projects, counters
 * agreeing with both, and no way to see it from the screen. The narrowing keeps rows of
 * unknown ownership rather than dropping them: work no filter shows is work nobody can act
 * on. They ride with `project: null`, and the window says «неизвестен» in words.
 *
 * Nothing here carries a peer url, a peer token or free text: the federation
 * field is a role and a boolean, and that is the whole of it.
 *
 * ═══════════ V5.1 — THE SETTINGS READ MODELS ════════════════════════════════════
 * The settings screens («Правила», «Аккаунты») ride the payload of the EXISTING state
 * route. The frozen table is the table of ROUTES; the shape of a payload was never the
 * frozen thing, and a new route per screen would have been the expensive way to say the
 * same sentence. `rules` and `accounts` are pure derives of the config plus the window
 * seam the roster already rides — no new stored field exists for them to disagree with.
 *
 * Neither section carries a secret VALUE, a credential env-var NAME, or an account's local
 * config path: they carry an account by NAME and nothing else.
 *
 * `memory` and `style` join them as SURFACES over local artifacts: counters, tags and
 * pointers for the corpus (never a note's body), metrics and already-redacted quotes for the
 * snapshot (never a transcript, never the exam's answer key). Both degrade to {absent:true}
 * on a machine that has none of it — a fresh install with no style is the normal case, not
 * an error case. `style` СЕГОДНЯ НИКТО НЕ ЧИТАЕТ — экран, который его показывал, снят
 * владельцем 28.08.2026; кто его читатель и почему счёт всё же остаётся, сказано словами над
 * `deriveStyle`.
 *
 * Every collaborator (adapter, ledger reader, the window-state function, usageReader,
 * the git/receipt readers, clock) is dependency-injected, so tests derive from fixtures
 * with no real Postgres / git / fs. Node built-ins only; zero deps; zero network.
 */

import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { networkInterfaces as osNetworkInterfaces } from 'node:os'
import { join } from 'node:path'

import { activeProjectEntry, apiCapUsd, codeTreeOf, pipelineEnabled, planningHomeOf } from '../config.mjs'
import { isOpen } from '../policy/windows.mjs'
import {
  accountNameOf,
  apiSpendUsd,
  monthToDateApiSpendUsd,
  spendAccountNames,
} from '../policy/spend.mjs'
import { isOrchestrator, orchestratorView } from '../policy/orchestrator.mjs'
// РОЛЬ РАБОТНИКА ЧИТАЕТСЯ ОДНИМ ВЫРАЖЕНИЕМ НА ВЕСЬ ПРОДУКТ — тем же, каким её читает
// маршрутизатор. Иначе «кто здесь исполнитель» стало бы вопросом с двумя ответами.
import { isExecutor, roleOf } from '../policy/worker-role.mjs'
import {
  isBatchParent,
  batchItemsOf,
  batchDecisionsOf,
  brokenItemOf,
  latestRowPerId,
  waveAddressOf,
  // ЧЬИ ФАЙЛЫ ЗАНЯТЫ ИДУЩЕЙ РАБОТОЙ — та же функция, по которой очередь эти строки и не
  // выдаёт. Второе выражение того же правила у окна разошлось бы с первым в первый же день.
  fileHoldsOf,
  REASON_LABELS,
  // ЧЕМ КОНЧАЕТСЯ РАБОТА, КОТОРУЮ НЕ БУДУТ ДЕЛАТЬ — тот же закрытый словарь, что принимает
  // дверь закрытия словами: подпись на карточке и слово в двери обязаны быть одним списком.
  CLOSING_REASON_LABELS,
  failureAwaitsAPerson,
  awaitsAutoRetry,
  autoRetriesSpent,
  autoRetryLimitFor,
  turnCapOffer,
} from '../queue/adapter.mjs'
// ТРИАЖ СТРОКИ РЕЕСТРА — ОДНО ЧТЕНИЕ НА ОБА ПУТИ ВХОДА. Часовой скан и дверь «в работу»
// обязаны отвечать одинаково на «какой у строки приоритет», «чего она ждёт» и «почему она не
// взята»: два читателя одного файла — это два триажа, и тише выигрывает случайный.
import { depsOf, headlineOf, intakeVerdict, queuePriority, readLineTags } from '../intake/backlog-scan.mjs'
import { readWaveHolds } from '../queue/wave-holds.mjs'
// ПОТОЛОК МЕСТ читается ТЕМ ЖЕ выражением, которым его читает тик перед тем, как отказать в
// месте: у дома идущих попыток. Своё чтение настройки здесь означало бы подпись под экраном,
// которая однажды разойдётся с поведением машины.
import { concurrencyCap } from '../queue/in-flight.mjs'
// НАСТРОЙКИ, ПРИМЕНЯЮЩИЕСЯ ТОЛЬКО С НОВОГО ЗАПУСКА, и их расхождение с файлом. Список
// таких настроек ОДИН и живёт там; здесь он только читается — второй список рядом с
// экраном означал бы, что окно однажды начнёт помечать не те настройки.
import { deriveRestartScoped } from '../config-restart.mjs'
import { readAttempts, foldAttemptRows } from '../queue/attempt-ledger.mjs'
import { attemptIdFor } from './journal.mjs'
import { taskChangeArgs, taskBranch, TASK_BRANCH_PREFIX } from './task-changes.mjs'
import { runsDirOf, sumRunTokens, zeroTokens, TOKEN_FIELDS, RUN_DIRS_KEEP } from '../queue/run-dir.mjs'
import { parseNote } from '../../../scripts/sma/lib/frontmatter.mjs'
import { PIPELINE_DRAFT_KIND } from '../../../scripts/sma/lib/write-pipeline.mjs'
import { parseNoteToPair } from '../../../scripts/sma/lib/replay-exam.mjs'
import {
  createQuestions,
  findPhaseDir,
  phaseNumberOf,
  STAGE_ARTIFACTS,
  ALL_CHECKPOINT_SUFFIXES,
  CHECKPOINT_SUFFIX,
  EXEC_CHECKPOINT_SUFFIX,
} from './questions.mjs'

const HOUR_MS = 3600000
const DAY_MS = 24 * HOUR_MS
const DONE_COMMIT_CAP = 10

/** Generated / registry artifacts of the corpus — structural files, not notes. */
const MEMORY_STRUCTURAL = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])
/** How many corpus pointers the «Память» screen gets — a surface, not a feed. */
const MEMORY_RECENT_CAP = 10
/**
 * How much of a note's own line travels. A v2 `claim` is a full sentence and sometimes three;
 * a row on the screen is one line, and the whole note is read where it lives. The generated
 * corpus indexes cut their own lines at the same order of magnitude.
 */
const MEMORY_TITLE_CAP = 200
/** How much of the training history and how many drafts travel on one poll. */
const STYLE_TRAININGS_CAP = 20
const STYLE_DECISIONS_CAP = 20
/** Each redacted excerpt is a quote on a card, not a document. */
const STYLE_TEXT_CAP = 400

/** Coerce an epoch-ms number or an ISO string to ms, or NaN. */
function toMs(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : NaN
}

function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function boolOrNull(v) {
  return typeof v === 'boolean' ? v : null
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/**
 * derivePresence({windowOpen, hasActiveTask, pulseAgeSec}) → 'работает'|'ждёт окно'|
 * 'свободен'. PURE: no storage is ever read — the fixtures carry no such field to read.
 *
 * ВЗЯТАЯ СТРОКА ДОМИНИРУЕТ, и это главное правило здесь: работник, у которого в руках
 * захваченная строка, — «работает». Три слова отвечают на два разных вопроса, и порядок
 * между ними именно такой:
 *
 *   · «работает»  — держит взятую строку. Что делает.
 *   · «ждёт окно» — не держит ничего, окно закрыто: взять работу НЕ МОЖЕТ.
 *   · «свободен»  — не держит ничего, окно открыто: взять работу может.
 *
 * ПОЧЕМУ УШЛА ПРОВЕРКА СВЕЖЕСТИ. Раньше «работает» требовало ещё и касания не старше
 * FRESH_TOUCH_SEC, и работник, замолчавший дольше трёх минут (аренда продлевается только на
 * ЦЕЛЫХ кадрах потока — TOUCH_THROTTLE_MS в loop.mjs, — а думать молча дольше он имеет
 * полное право), становился «свободен», не выпуская из рук ни строки, ни места. В одной и той
 * же выдаче доска говорила «в работе 4» и рисовала четыре карточки со словом «свободен» —
 * доска спорила сама с собой (замерено 31.08 сверкой счётчика со списком). Молчание — это НЕ
 * освобождение: строку у замолчавшего забирает сторож живости (queue/liveness.mjs), и вот
 * ТОГДА она перестаёт быть взятой и слово меняется само. А насколько давно был сигнал жизни,
 * карточка и так говорит рядом — `pulseAgeSec` едет отдельным полем именно за этим.
 *
 * ЗАКРЫТОЕ ОКНО БОЛЬШЕ НЕ ПЕРЕБИВАЕТ ВЗЯТУЮ РАБОТУ. Оно перебивает ожидающую («даже при
 * непустой очереди» — ради этого правило и заводилось): вопрос окна — «может ли он ВЗЯТЬ
 * работу», а не «делает ли он её сейчас». Карточка, показывающая название задачи в руках и
 * слово «ждёт окно» под ним, — то же самое противоречие, только другими словами.
 *
 * @param {{windowOpen:boolean, hasActiveTask:boolean, pulseAgeSec?:(number|null|undefined)}} o
 * @returns {'работает'|'ждёт окно'|'свободен'}
 */
export function derivePresence({ windowOpen, hasActiveTask } = {}) {
  if (hasActiveTask) return 'работает'
  if (!windowOpen) return 'ждёт окно'
  return 'свободен'
}

/**
 * ЧЕМ КОНЧИЛАСЬ РАБОТА — одно слово из закрытого списка, и оно всегда чьё-то.
 *
 * Два разных этажа правды отвечают на этот вопрос, и они НЕ равны:
 *
 *   · ПОСЛЕДНЕЕ СЛОВО О ЗАДАЧЕ — статус строки очереди. «Принята» и «возвращена» — это акты
 *     ЧЕЛОВЕКА, и никакого другого источника у них нет: леджер попыток знает, чем кончился
 *     подход, и не знает, что о нём сказали потом. Поэтому когда чтение ещё несёт строку,
 *     слово берётся у неё.
 *   · СЛОВО САМОГО ПОДХОДА — `completed` / `failed` из леджера. Оно остаётся, когда строки уже
 *     нет вовсе (очередь свою историю подрезает, файлы леджера — нет), и говорит ровно то, что
 *     знает: работа была доведена или сорвалась. «Принята» отсюда не выводится — приёмки
 *     никто не наблюдал, и назвать её было бы выдумкой ровно того сорта, ради запрета которой
 *     этот файл написан.
 *
 * `completed` НА СТРОКЕ ЗНАЧИТ ТО ЖЕ, что и в леджере, и намеренно не переименовано в
 * «принята»: `approved` — отдельный статус, и он существует именно потому, что «сделана» и
 * «принята» — разные новости.
 */
const HISTORY_OUTCOME_BY_STATUS = Object.freeze({
  approved: 'approved',
  returned: 'returned',
  failed: 'failed',
  completed: 'completed',
  awaiting_approval: 'awaiting',
  approving: 'awaiting',
  queued: 'running',
  claimed: 'running',
  running: 'running',
})

/**
 * historyRow({taskId, endedAt, outcome}, row) → одна строка истории работника.
 *
 * `title`, `kind` и `phase` — слова СТРОКИ ОЧЕРЕДИ, и когда строки в чтении нет, все три
 * молчат: `title: null` и `kind: null` значат «сказать некому», а не «безымянная инлайн-
 * задача». Экран обязан различать это, потому что иначе фаза, чью строку очередь уже
 * подрезала, тихо переехала бы в столбец инлайн-задач.
 *
 * РОД РАБОТЫ ЧИТАЕТСЯ ТАМ ЖЕ, ГДЕ ЕГО ЧИТАЕТ ИСПОЛНИТЕЛЬ, — в конверте `data` строки: тик
 * узнаёт стадию фазы по `data.phase` и ничему другому. Второе определение «что такое фаза»
 * разошлось бы с первым, и разошлось бы молча.
 */
function historyRow(entry, row) {
  const data = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : null
  const phase = data && data.phase !== undefined && data.phase !== null ? String(data.phase).trim() : ''
  return {
    taskId: entry.taskId,
    endedAt: entry.endedAt,
    title: row && typeof row.title === 'string' && row.title !== '' ? row.title : null,
    kind: row ? (phase !== '' ? 'phase' : 'task') : null,
    ...(phase !== '' ? { phase } : {}),
    outcome: (row && HISTORY_OUTCOME_BY_STATUS[row.status]) || entry.outcome,
  }
}

/**
 * parseReceiptSummary(receiptRef, {readReceipt}) → {testsPassed, testsTotal, tscClean,
 * guardClean}. The receiptRef may ALREADY be a structured receipt object (the common
 * case — the loop writes the rich attempt row) or a string ref resolved via an injected
 * readReceipt reader. Missing / unreadable → an all-null summary (never throws). Data
 * comes ONLY from the durable receipt, never a guess.
 *
 * @param {*} receiptRef
 * @param {{readReceipt?:Function}} [opts]
 * @returns {{testsPassed:number|null, testsTotal:number|null, tscClean:boolean|null, guardClean:boolean|null}}
 */
export function parseReceiptSummary(receiptRef, { readReceipt } = {}) {
  let r = null
  if (receiptRef && typeof receiptRef === 'object') r = receiptRef
  else if (typeof receiptRef === 'string' && typeof readReceipt === 'function') {
    try {
      r = readReceipt(receiptRef)
    } catch {
      r = null
    }
  }
  if (!r || typeof r !== 'object') {
    return { testsPassed: null, testsTotal: null, tscClean: null, guardClean: null }
  }
  return {
    testsPassed: numOrNull(r.testsPassed ?? r.passed),
    testsTotal: numOrNull(r.testsTotal ?? r.total),
    tscClean: boolOrNull(r.tscClean),
    guardClean: boolOrNull(r.guardClean),
  }
}

/**
 * THE SHAPES A RECEIPT REFERENCE REALLY TAKES, and what each one PROVES.
 *
 * Every finished attempt carries a `receiptRef` STRING written by the tick at the moment its
 * exit gate opened. The four numbers `parseReceiptSummary` looks for — tests passed, tests
 * total, build clean, rules clean — have no producer anywhere in this system: the reverify
 * verb re-runs a recorded command and compares HASHES, deliberately knowing nothing about
 * what kind of run is inside, so it reports a verdict and not a count. A card that waits for
 * those numbers therefore shows nothing, forever, on every task.
 *
 * So this reads the proof that DOES exist. Each prefix is written in exactly one place in
 * loop.mjs and means one thing:
 *   reverify:<sha>          the code gate opened — the work was re-verified on the branch
 *   artifact:<path>@<sha>   a documentary stage really produced its document, and committed it
 *   answer:<attemptId>      the attempt correctly changed no code and answered instead
 *   moot:<attemptId>@<ref>  the SUBJECT of the task no longer exists, and `<ref>` is what the
 *                           daemon itself confirmed the finding on — a commit that closed the
 *                           complaint, or a file that was read. Kept apart from `answer:`
 *                           deliberately: «разобрался и ответил» and «предмета нет» send a
 *                           person to two different places, and only the second one carries
 *                           evidence a machine already re-checked
 *   preflight:<taskId>      the work was already on the branch before anybody was spawned
 *   forge:<...>             an agent draft passed its lint and was committed
 *
 * PURE, never throws, and it INVENTS NOTHING: an unrecognised reference is returned under
 * kind 'other' with its text intact rather than dressed up as a pass.
 */
const RECEIPT_KINDS = Object.freeze([
  { kind: 'reverify', re: /^reverify:(.*)$/ },
  { kind: 'artifact', re: /^artifact:(.*)$/ },
  { kind: 'answer', re: /^answer:(.*)$/ },
  { kind: 'moot', re: /^moot:(.*)$/ },
  { kind: 'preflight', re: /^preflight:(.*)$/ },
  { kind: 'forge', re: /^forge:(.*)$/ },
])

/**
 * parseReceiptProof(receiptRef) → {kind, ref, path?, sha?} | null — the durable proof a
 * finished attempt left, in a shape a screen can render as a sentence.
 *
 * TWO FORMS, AND ONLY ONE OF THEM WAS EVER READ.
 *
 * The tick writes this reference as a STRING when a receipt exists, and as an OBJECT in
 * exactly the two cases where one does not: the differential gate («красными остались только
 * рецепты, что были красны и до работника») and the tree that holds no recipes at all. That
 * object carries `unverified`, the reason in one word, and the numbers the verdict was made
 * from. This reader accepted the string alone — so every attempt closed by either of those
 * two gates produced an EMPTY proof, and «готово» read exactly like «готово, но никто не
 * перепроверял». Those are opposite sentences, and the second one had never once reached a
 * screen although the tick has been computing it since the differential gate existed. An
 * absence rendered as a pass is the lie this whole surface exists to prevent, so the object
 * form is read here, beside the string, and nothing about the string form changes by a byte.
 *
 * NOTHING IS INVENTED, on either path: a key absent from the object is absent from the proof,
 * and an object that names no gate reason is not a gate proof at all (the four-number receipt
 * summary is a different reader's job and is never dressed up as a verdict).
 *
 * @param {*} receiptRef
 * @returns {{kind:string, ref:string, path?:string, sha?:string, evidence?:string, unverified?:boolean, reason?:string, branch?:string, base?:string, commits?:number, preexistingRed?:number, newRed?:number}|null}
 */
export function parseReceiptProof(receiptRef) {
  // ── THE OBJECT FORM: what the gate concluded when there was no receipt to point at ──
  if (receiptRef && typeof receiptRef === 'object' && !Array.isArray(receiptRef)) {
    const reason = typeof receiptRef.reason === 'string' ? receiptRef.reason.trim() : ''
    if (!reason) return null
    const num = (v) => (Number.isFinite(v) ? { value: v } : null)
    const commits = num(receiptRef.commits)
    const preexistingRed = num(receiptRef.preexistingRed)
    const newRed = num(receiptRef.newRed)
    const branch = typeof receiptRef.branch === 'string' && receiptRef.branch.trim() ? receiptRef.branch.trim() : null
    const base = typeof receiptRef.base === 'string' && receiptRef.base.trim() ? receiptRef.base.trim() : null
    return {
      kind: 'gate',
      // The reference verbatim: for this form the stored reason IS the reference — there is
      // no second text to quote, and minting a friendlier one would be an invention.
      ref: reason,
      unverified: receiptRef.unverified === true,
      reason,
      ...(branch ? { branch } : {}),
      ...(base ? { base } : {}),
      ...(commits ? { commits: commits.value } : {}),
      ...(preexistingRed ? { preexistingRed: preexistingRed.value } : {}),
      ...(newRed ? { newRed: newRed.value } : {}),
    }
  }
  const ref = typeof receiptRef === 'string' ? receiptRef.trim() : ''
  if (!ref) return null
  for (const { kind, re } of RECEIPT_KINDS) {
    const m = re.exec(ref)
    if (!m) continue
    const rest = String(m[1] || '').trim()
    if (kind === 'artifact') {
      // `path@sha` — split on the LAST @ so a path may contain one and still resolve.
      const at = rest.lastIndexOf('@')
      const path = at > 0 ? rest.slice(0, at) : rest
      const sha = at > 0 ? rest.slice(at + 1) : ''
      return { kind, ref, ...(path ? { path } : {}), ...(sha ? { sha } : {}) }
    }
    if (kind === 'moot') {
      // `<attemptId>@<evidence>` — split on the LAST @ for the same reason artifact does:
      // the evidence may be a path, and a path may legally carry one.
      const at = rest.lastIndexOf('@')
      const evidence = at > 0 ? rest.slice(at + 1) : ''
      return { kind, ref, ...(evidence ? { evidence } : {}) }
    }
    if (kind === 'reverify') return { kind, ref, ...(rest ? { sha: rest } : {}) }
    return { kind, ref }
  }
  return { kind: 'other', ref }
}

/**
 * attemptsReader(deps) → (taskId) => attempts[]. The per-attempt ledger is a DI SEAM so
 * tests derive from fixtures with no fs: `ledger` may be a function `(taskId)=>rows`, an
 * object `{readAttempts}`, otherwise `ledgerDir` binds the real readAttempts. Always
 * fail-open ([] on any error).
 *
 * ONE RECORD PER TRY, whichever seam the rows came through. The ledger holds TWO rows for one
 * attempt (the state machine's transition and the tick's richer row), so counting rows here
 * reported twice the tries that happened — «6 подходов» over three. The fold is applied at this
 * one reading seam rather than at each counter, so a consumer added later cannot re-acquire the
 * defect; `foldAttemptRows` owns the merge rule and the ledger file keeps every row it wrote.
 */
function attemptsReader(deps) {
  const { ledger, ledgerDir } = deps
  if (typeof ledger === 'function') {
    return (id) => {
      try {
        return foldAttemptRows(ledger(id) || [])
      } catch {
        return []
      }
    }
  }
  if (ledger && typeof ledger.readAttempts === 'function') {
    return (id) => {
      try {
        return foldAttemptRows(ledger.readAttempts(id) || [])
      } catch {
        return []
      }
    }
  }
  if (ledgerDir) {
    return (id) => {
      try {
        return foldAttemptRows(readAttempts(ledgerDir, id))
      } catch {
        return []
      }
    }
  }
  return () => []
}

/** The window-state function seam: windows(account) → {fiveHour, week, closedUntil?}. */
function windowFor(windows, account) {
  // NOT «zero per cent» — nothing heard. A daemon assembled without the seam knows nothing
  // about any window, and saying so is the whole point of this change.
  const fallback = { fiveHour: { status: 'unknown' }, week: { status: 'unknown' } }
  if (typeof windows !== 'function') return fallback
  try {
    const w = windows(account)
    return w && typeof w === 'object' ? w : fallback
  } catch {
    return fallback
  }
}

/**
 * projectOf(row) → the project the ROW ITSELF names, or null when it names none.
 *
 * IT NO LONGER FILLS THE GAP IN, and that is the whole point of it. This function used to
 * answer «its own, else whatever project is on the screen right now», which sounds like a
 * courtesy and was measured to be a lie: of the forty rows in the live queue not one carried
 * the fact, so every task belonged to whichever project was being looked at. Switch the
 * switcher and the same work re-registered itself under the other project, counters and all —
 * the window looked like it was working and was wrong in complete silence.
 *
 * A row that never said which project it is stays saying nothing. Ownership nobody measured is
 * an invented number like any other, only about whose work it is, and a confident wrong answer
 * is worse than none: nobody can tell it apart from a right one. The window says «неизвестен»
 * in words instead.
 *
 * ЭКСПОРТИРУЕТСЯ, ПОТОМУ ЧТО СПРАШИВАЮЩИХ ДВОЕ. Дверь одной задачи называет штамп тем же
 * правилом, каким его читает общая картина: два написания одного правила и есть способ
 * получить две поверхности, рассказывающие об одной задаче разное.
 */
export function projectOf(row) {
  const own = row && row.project
  return typeof own === 'string' && own !== '' ? own : null
}

/**
 * inProject(row, project) → does this row belong in a selection narrowed to `project`?
 *
 * ITS OWN PROJECT MATCHES, OR IT NAMES NONE AT ALL. A row of unknown ownership dropped by
 * every filter is INVISIBLE WORK — the one outcome worse than an honest «неизвестен», because
 * a person cannot act on what no screen draws, and cannot even discover that it exists. So it
 * rides along in every selection carrying its own truth (null), and the window labels it.
 */
function inProject(row, project) {
  const own = projectOf(row)
  return own === null || own === project
}

// ═════════ ЧТО ЛЕЖИТ НЕОТПРАВЛЕННЫМ: проект против своего ствола ═════════════════
//
// ЗАМЕРЕНО 28.08.2026: в продукте лежало 108 коммитов, которых нет на origin, публичный
// репозиторий стоял на 24.08, локальная вершина — на 28.08, и НИ ОДИН экран этого не
// показывал. Вопрос «что мы можем выкатить прямо сейчас» — главный перед выпуском, и
// ответить на него из окна было нельзя: приходилось идти в терминал и спрашивать git руками.
//
// ЧЕТЫРЕ ФАКТА, И ВСЕ ЧЕТЫРЕ — ОТ GIT. Сколько коммитов не отправлено на удалённый ствол,
// когда удалённый ствол двигался последний раз, есть ли незакоммиченное в дереве, и сколько
// веток задач в ствол не слито. Ни один из них не выводится из другого и ни один не
// придумывается: не смогли спросить — говорим словами.
//
// НОЛЬ — ЭТО УТВЕРЖДЕНИЕ, А НЕ ПУСТОЕ МЕСТО. «0 не отправлено» читается как «всё уехало», и
// для проекта без удалённого ствола это ложь противоположного знака: отправлять было НЕКУДА,
// а экран сказал бы, что всё в порядке. Поэтому всякий исход, кроме измеренного, несёт
// `status` и СЛОВА (`note`), а числа остаются null — их никто не мерил.
//
// ЧЕМ МЕРЯЕТСЯ «НЕ ОТПРАВЛЕНО» — ОДНОЙ КОМАНДОЙ, И ЭТО `rev-list --count <удалённый>..<ствол>`.
// `git status` умеет отвечать «+N −M» сам, но ТОЛЬКО когда у ветки настроен upstream, — а на
// собственном дереве этого продукта (замерено 28.08) upstream у `main` не настроен, зато
// `origin/main` на месте и 128 коммитов поверх него. Ответить на это «удалённого нет» было бы
// формально верно и по делу — ложь. Поэтому удалённый ствол ИЩЕТСЯ: сначала тот, который
// назвал сам git, и только потом одноимённая ветка единственного (или названного `origin`)
// удалённого. Найденный ref едет на провод полем `remote` — что с чем сравнили, человек
// читает, а не додумывает. Счёт при этом ОДИН на оба пути: два способа посчитать одно число
// однажды разошлись бы, и никто бы не узнал какой.
//
// ЧЕТЫРЕ-ШЕСТЬ ПОДПРОЦЕССОВ НА ПРОЕКТ, И ПОТОМУ ПАМЯТЬ НА ДЕСЯТЬ СЕКУНД. Они СИНХРОННЫЕ, а
// опрос окна идёт каждые 3 секунды через один цикл событий — тот самый счёт, который однажды
// стоил дерайву 26 секунд (см. DONE_GIT_CACHE ниже). Память живёт ДЕСЯТЬ СЕКУНД и ключом
// берёт САМ ШОВ git: у production он один на весь процесс, а у каждого теста свой, поэтому
// два разных ответа git не могут попасть друг другу в чужую ячейку.
const TRUNK_CACHE = new WeakMap() // execGit -> Map<dir, {at:number, trunk:object}>
const TRUNK_CACHE_MS = 10_000

/** Слова на каждый исход, который не измерен. Экран показывает их вместо числа. */
const TRUNK_WORDS = Object.freeze({
  'not-connected': 'у записи нет папки на этой машине — сравнивать нечего',
  'no-git': 'спросить git нечем — окно собрано без него',
  'no-remote': 'у ствола нет удалённого — отправлять некуда',
  detached: 'голова отсоединена — ствол не назван',
  unreadable: 'git не смог прочитать это дерево',
})

/** Одна форма ответа на все исходы: неизмеренное поле — null, и никогда 0. */
function trunkVerdict(status, extra = {}) {
  return {
    status,
    note: status === 'measured' ? null : TRUNK_WORDS[status] ?? null,
    branch: null,
    remote: null,
    unpushed: null,
    remoteMovedAt: null,
    dirty: null,
    unmergedBranches: null,
    ...extra,
  }
}

/**
 * `git status --porcelain=v2 --branch`, прочитанный как есть: ствол, его удалённый, счёт
 * расхождения и грязь дерева. Формат машинный и стабильный по контракту git — заголовки
 * начинаются с «# », а любая строка записи (1/2/u/?) означает, что в дереве есть
 * незакоммиченное. Бросает ровно то, что бросил git: «это не репозиторий» — обстоятельство,
 * решать о нём словами — дело вызывающего.
 *
 * `--no-optional-locks` СТОИТ ПЕРВЫМ И НЕ УКРАШЕНИЕ. Обычный `git status` освежает индекс и
 * берёт для этого `index.lock` — а это ЧУЖОЕ рабочее дерево, в котором человек в ту же
 * секунду делает свой коммит, и опрос окна ходит сюда каждые несколько секунд. Читатель,
 * который может отобрать замок у хозяина дерева, читателем быть перестал.
 */
function readTrunkStatus(execGit, cwd) {
  const raw = String(execGit(['--no-optional-locks', 'status', '--porcelain=v2', '--branch'], { cwd }) || '')
  let branch = null
  let upstream = null
  let dirty = false
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') continue
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim() || null
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim() || null
    else if (!line.startsWith('# ')) dirty = true
  }
  return { branch, upstream, dirty }
}

/**
 * Куда этот ствол отправляют, когда git сам этого не объявил. Ветка без upstream — не редкость
 * и не поломка: так выглядит всякая, созданную без `-u`, и именно так стоит `main` в дереве
 * этого продукта. Ответить на это «удалённого нет» значило бы назвать 128 неотправленных
 * коммитов пустым местом.
 *
 * ИСКАТЬ — НЕ ЗНАЧИТ ВЫДУМЫВАТЬ. Берётся ОДНОИМЁННАЯ ветка `origin` (или единственного
 * удалённого, если он назван иначе), и только если она в этой копии ДЕЙСТВИТЕЛЬНО есть —
 * git спрашивают о ней прямо. Несколько удалённых без `origin` — это выбор, которого никто
 * не делал, и он не делается здесь: тогда удалённого ствола у нас нет.
 */
function findRemoteTrunk(execGit, cwd, branch) {
  let remotes = []
  try {
    remotes = String(execGit(['remote'], { cwd }) || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  const named = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null
  if (named === null) return null
  const ref = `${named}/${branch}`
  try {
    // `--verify --quiet`: молчит и выходит с единицей, когда такой ветки нет — шов бросает
    return String(execGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], { cwd }) || '').trim() === ''
      ? null
      : ref
  } catch {
    return null
  }
}

/**
 * Сколько коммитов ствола не доехало до удалённого — ТОТ САМЫЙ вопрос, которым это меряют
 * руками: `git rev-list --count <удалённый>..<ствол>`. Один счёт на оба способа найти
 * удалённый ствол: второй способ считать однажды разошёлся бы с первым.
 */
function countUnpushed(execGit, cwd, remoteRef, branch) {
  try {
    const n = Number(String(execGit(['rev-list', '--count', `${remoteRef}..${branch}`], { cwd }) || '').trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** Когда удалённый ствол двигался последний раз — время коммита, в ISO, или ничего. */
function readRefMovedAt(execGit, cwd, ref) {
  try {
    return String(execGit(['log', '-1', '--format=%cI', ref], { cwd }) || '').trim() || null
  } catch {
    return null
  }
}

/**
 * Сколько веток задач не слито в ствол. Префикс веток задач берётся из ОДНОГО места
 * (task-changes.mjs) — второе написание однажды разошлось бы с тем, которое создаёт ветки.
 * `--no-merged=<ствол>` пишется со знаком равенства намеренно: у этого ключа значение
 * необязательное, и отдельным словом git прочитал бы ствол как ШАБЛОН имени ветки.
 */
function countUnmergedTaskBranches(execGit, cwd, trunk) {
  try {
    const out = String(
      execGit(
        ['for-each-ref', `--no-merged=${trunk}`, '--format=%(refname:short)', `refs/heads/${TASK_BRANCH_PREFIX}`],
        { cwd },
      ) || '',
    )
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean).length
  } catch {
    return null
  }
}

/**
 * deriveProjectTrunk(entry, execGit) → состояние ОДНОГО проекта против его ствола.
 *
 * Дерево читается локально даже там, где удалённого ствола нет: грязь и неслитые ветки —
 * факты о копии, а не о сервере, и молчать о них за компанию было бы вторым враньём.
 */
function deriveProjectTrunk(entry, execGit) {
  const dir = typeof entry.path === 'string' && entry.path.trim() !== '' ? entry.path.trim() : null
  if (dir === null) return trunkVerdict('not-connected')
  if (typeof execGit !== 'function') return trunkVerdict('no-git')

  let seamCache = TRUNK_CACHE.get(execGit)
  if (!seamCache) {
    seamCache = new Map()
    TRUNK_CACHE.set(execGit, seamCache)
  }
  const hit = seamCache.get(dir)
  if (hit && Date.now() - hit.at < TRUNK_CACHE_MS) return hit.trunk

  const trunk = measureTrunk(execGit, dir)
  seamCache.set(dir, { at: Date.now(), trunk })
  return trunk
}

function measureTrunk(execGit, dir) {
  let head
  try {
    head = readTrunkStatus(execGit, dir)
  } catch {
    return trunkVerdict('unreadable')
  }
  if (head.branch === null || head.branch === '(detached)') return trunkVerdict('detached', { dirty: head.dirty })

  const local = {
    branch: head.branch,
    dirty: head.dirty,
    unmergedBranches: countUnmergedTaskBranches(execGit, dir, head.branch),
  }
  const remote = head.upstream ?? findRemoteTrunk(execGit, dir, head.branch)
  if (remote === null) return trunkVerdict('no-remote', local)

  // Удалённый ствол НАЗВАН, а счёт по нему не сошёлся — это не «ноль не отправлено» и не
  // «удалённого нет»: это неизмеренное, и оно называется словами.
  const unpushed = countUnpushed(execGit, dir, remote, head.branch)
  if (unpushed === null) {
    return trunkVerdict('unreadable', {
      ...local,
      remote,
      note: `удалённый ствол ${remote} назван, но сосчитать по нему git не смог`,
    })
  }
  return trunkVerdict('measured', {
    ...local,
    remote,
    unpushed,
    remoteMovedAt: readRefMovedAt(execGit, dir, remote),
  })
}

/**
 * deriveProjects(rows, config) → [{id, name, connected, taskCounts}] over the WHOLE selection.
 * Counts are per project by construction, so they are computed from every row regardless
 * of an active filter — that is exactly what makes the switcher readable.
 *
 * A ROW COUNTS TOWARDS THE PROJECT IT ITSELF NAMES, and towards no other. While the missing
 * fact was filled in with the project on screen, these counters said the whole queue belonged
 * to whatever was being looked at and the other project stood at a permanent zero — two
 * numbers that moved together with the switcher and measured nothing. Work whose owner is
 * unknown is counted by NEITHER project: a count is a measurement, and this one has not been
 * made.
 *
 * `connected` is whether the registry entry names a folder on disk. The
 * default entry every install mints carries a NAME and no path, so the screens showed a
 * project they could not read a single file of: «Память» answered «нет подключённого
 * проекта» while «Машины и проекты» listed the project by name. An entry that names a
 * project it cannot open is the worst of the three states, so the fact travels and the
 * screens say it. The PATH itself never does — an absolute path on the wire is a
 * disclosure, and a boolean is the whole of what a screen needs.
 *
 * `trunk` is the same entry read AS A CHECKOUT: what of it is not pushed yet — see
 * deriveProjectTrunk above. It rides here rather than on a screen of its own because the
 * list of projects is where a person already looks to ask «что у нас открыто».
 */
function deriveProjects(rows, config, { execGit } = {}) {
  const registry = Array.isArray(config.projects) ? config.projects : []
  return registry.map((p) => {
    const mine = rows.filter((r) => projectOf(r) === p.id)
    const taskCounts = { queued: 0, claimed: 0, awaiting_approval: 0, completed: 0, failed: 0, total: mine.length }
    for (const r of mine) {
      if (Object.prototype.hasOwnProperty.call(taskCounts, r.status)) taskCounts[r.status] += 1
    }
    return {
      id: p.id,
      name: p.name,
      connected: typeof p.path === 'string' && p.path.trim() !== '',
      taskCounts,
      trunk: deriveProjectTrunk(p, execGit),
    }
  })
}

/**
 * deriveMachines(config) → the LOCAL machine list: exactly this machine. The injected
 * aggregator appends the peers into the SAME shape (their url/token stay out).
 */
function deriveMachines(config) {
  return [
    {
      id: config.machineId ?? 'self',
      title: config.machineTitle ?? 'Эта машина',
      role: 'self',
      online: true,
    },
  ]
}

/**
 * deriveRules(config, {switchMode}) → the «Правила» read model: the lanes with the workers
 * riding them, the worker profiles, the budget stops and the sub→API mode.
 *
 * PURE OVER THE CONFIG. Every field here already exists in the daemon config — this adds no
 * stored field, no second place a rule could be written down and then disagree with the one
 * the runner obeys. `switchMode` is passed IN rather than recomputed: the spend strip works
 * it out from the live windows, and a rule that reports a different mode than the strip is
 * worse than no rule at all.
 *
 * WHAT IT DELIBERATELY DROPS: the account OBJECT. A worker's account carries `configDir` (a
 * local path) and `oauthTokenEnv` (the NAME of the env var holding the token — a secret in
 * its own right). The read model carries the account NAME and nothing else, so a
 * payload that travels the LAN can never carry either.
 *
 * `configOnDisk` — ФАЙЛ НАСТРОЕК, КАК ОН ЛЕЖИТ НА ДИСКЕ, и это единственная причина, по
 * которой этот derive перестал быть чистым над одной копией настроек. Настройки второго
 * класса (config-restart.mjs) применяются только с нового запуска, поэтому число в файле и
 * число, по которому демон работает, — два РАЗНЫХ факта, и молчание о втором уже стоило
 * человеку двух неверных выводов подряд. Не передали файл — расхождение не утверждается
 * вовсе: «сравнивать не с чем» честнее, чем «всё совпадает».
 *
 * @param {object} config
 * @param {{switchMode?:'subscription'|'api', configOnDisk?:object|null}} [opts]
 * @returns {{lanes:object[], workers:object[], budgetStops?:object, subApiSwitch:object, restartScoped:object[]}}
 */
export function deriveRules(config = {}, { switchMode, configOnDisk = null } = {}) {
  const workersCfg = Array.isArray(config.workers) ? config.workers : []
  const lanes = []
  const byLane = new Map()

  const workers = workersCfg.map((w) => {
    const lane = w.lane ?? null
    let bucket = byLane.get(lane)
    if (!bucket) {
      bucket = { lane, workers: [] }
      byLane.set(lane, bucket)
      lanes.push(bucket) // config order — the order the founder wrote them in
    }
    bucket.workers.push(w.id)
    return {
      id: w.id,
      lane,
      account: accountNameOf(w.account, w.id),
      // a profile field the config does not carry is OMITTED, never invented as null
      ...(w.provider !== undefined ? { provider: w.provider } : {}),
      ...(w.model !== undefined ? { model: w.model } : {}),
      ...(w.effort !== undefined ? { effort: w.effort } : {}),
      enabled: w.enabled === undefined ? true : Boolean(w.enabled),
      // РОЛЬ — И ТУТ ЖЕ ОТВЕТ, РАЗБИРАЕТ ЛИ ЭТА СТРОКА ОЧЕРЕДЬ. Таблица «Кто что делает»
      // перечисляла сорок пять строк подряд, и включённый специалист выглядел в ней ровно как
      // включённый исполнитель — при том, что задачу он не возьмёт ни при каком порядке.
      role: roleOf(w),
      inQueue: isExecutor(w) && w.enabled !== false && !isOrchestrator(w),
    }
  })

  const budget = config.budget
  const capUsd = apiCapUsd(budget)
  return {
    lanes,
    workers,
    // THE CONVEYOR'S OWN SWITCH, READ. A toggle that can only be written is a toggle no
    // screen can show as off, and «off» is the state this product ships in — so a window
    // that could not read it would present a stopped machine as a running one. It is
    // DERIVED here by the same predicate the tick is gated on (config.mjs pipelineEnabled),
    // never stored a second time: the answer on the screen and the answer in the tick are
    // one comparison, so they cannot come to disagree.
    pipeline: { enabled: pipelineEnabled(config) },
    // НАСТРОЙКИ, КОТОРЫЕ ПРИМЕНЯТСЯ ТОЛЬКО ПРИ ПЕРЕЗАПУСКЕ — каждая помечена такой ПОИМЁННО,
    // и рядом с ней стоит, что говорит о ней файл. Ключ присутствует всегда: список пустым
    // не бывает, а «нет ключа» экран читал бы как «таких настроек не существует» — то самое
    // молчание, из-за которого «записано и показано» дважды прочли как «действует».
    restartScoped: deriveRestartScoped(config, configOnDisk),
    ...(budget
      ? {
          budgetStops: {
            monthlyApiCapUsd: capUsd,
            ...(budget.warnPct !== undefined ? { warnPct: budget.warnPct } : {}),
          },
        }
      : {}),
    subApiSwitch: {
      mode: switchMode === 'api' ? 'api' : 'subscription',
      capUsd,
      budgeted: capUsd > 0, // no cap → there is no API fallback to switch TO
    },
  }
}

/**
 * deriveRoles(config) → КОГО ВООБЩЕ МОЖНО НАЗВАТЬ, СТАВЯ ЗАДАЧУ. Одна строка на РОЛЬ, а не на
 * работника: форма постановки спрашивает «кто это сделает», и ответом на этот вопрос является
 * роль, а не конкретный счёт.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ. Разведение работников и агентов оставляло человеку половину: окно говорило
 * «чтобы отдать инлайн-задачу специалисту, назовите его роль при постановке» — а назвать её
 * было негде, поле `role` существовало только для того, кто пишет запросы руками. Обещание,
 * которое окно даёт и само же не держит, хуже отсутствия обещания.
 *
 * ЧТО В СТРОКЕ:
 *   • `role` — каноническое имя, ровно то, которое поедет на задаче и которое сравнит
 *     маршрутизатор (одна нормализация на обе стороны, policy/worker-role.mjs);
 *   • `title` — имя, под которым человек видит этого работника в окне (идентификатор первой
 *     строки конфига с такой ролью): в списке агентов он читает `sma-ai-researcher`, и форма
 *     обязана называть его так же;
 *   • `executor` — ИСПОЛНИТЕЛЬ ли это, приезжает СЧИТАННЫМ. Экран, сравнивающий имя роли со
 *     словом «executor» у себя, завёл бы второй словарь ролей в другом языке;
 *   • `ready` — сколько таких работников включено ПРЯМО СЕЙЧАС. Ноль означает «есть, но
 *     выключен»: маршрут на названную роль ответит `role_unavailable`, и форма не должна
 *     предлагать выбор, который заведомо вернётся человеку;
 *   • `total` — сколько их всего, включая выключенных, чтобы окно могло сказать, скольких
 *     человек не видит в списке и почему.
 *
 * ВЕРХУШКА СЮДА НЕ ПОПАДАЕТ ВОВСЕ — она не берёт инлайн-задач ни при какой роли, и предложить
 * её значило бы предложить выбор, который маршрутизатор отвергает первой же строкой фильтра.
 *
 * ПОРЯДОК: исполнитель первым (это выбор по умолчанию), остальные по алфавиту. Порядок строк
 * конфига здесь не сохраняется намеренно: именно он и был той «случайностью», из-за которой
 * задача заведена.
 *
 * @param {object} config
 * @returns {{role:string, title:string, executor:boolean, ready:number, total:number}[]}
 */
export function deriveRoles(config = {}) {
  const workersCfg = Array.isArray(config.workers) ? config.workers : []
  const byRole = new Map()
  for (const w of workersCfg) {
    if (!w || isOrchestrator(w)) continue
    const role = roleOf(w)
    let entry = byRole.get(role)
    if (!entry) {
      entry = { role, title: w.id ?? role, executor: isExecutor(w), ready: 0, total: 0 }
      byRole.set(role, entry)
    }
    entry.total += 1
    if (w.enabled !== false) entry.ready += 1
  }
  return [...byRole.values()].sort((a, b) =>
    a.executor === b.executor ? a.role.localeCompare(b.role) : a.executor ? -1 : 1,
  )
}

/**
 * deriveAccounts(config, windows) → the «Аккаунты» read model: one entry per SUBSCRIPTION
 * (deduped — several workers ride one account), its window bars, the workers riding it, and
 * the MACHINE it lives on.
 *
 * THE MACHINE BINDING IS THE POINT. A subscription belongs to exactly one machine (config.mjs:
 * federation aggregates views, never credentials), and this is the screen that makes that law
 * visible instead of folklore. Every locally-configured account is bound to THIS machine; a
 * peer's accounts arrive, if at all, through the peer's own payload.
 *
 * Same omission as deriveRules: the account object never travels, only its name.
 *
 * @param {object} config
 * @param {(account:any)=>object} [windows] the window-state seam
 * @returns {object[]}
 */
export function deriveAccounts(config = {}, windows) {
  const workersCfg = Array.isArray(config.workers) ? config.workers : []
  const machineId = config.machineId ?? 'self'
  const byName = new Map()
  const out = []
  for (const w of workersCfg) {
    const name = accountNameOf(w.account, w.id)
    let entry = byName.get(name)
    if (!entry) {
      entry = { name, machineId, windows: windowBar(windowFor(windows, w.account ?? name)), workers: [] }
      byName.set(name, entry)
      out.push(entry)
    }
    // the founder's daytime account — a property of the ACCOUNT, flagged by
    // whichever worker profile carries it
    if (w.dayPriorityOwner) entry.dayPriorityOwner = true
    entry.workers.push(w.id)
  }
  return out
}

// ══════════════════ «Работать удалённо»: the FACT about the door ════════════════
//
// deriveRemoteAccess(config, {networkInterfaces}) → what a person needs to know before
// deciding whether their daemon can be reached from a second machine, and NOTHING they
// could act on by accident. It reads the door out of the config and the interfaces out of
// the operating system; it changes neither, and there is no writing sibling to this
// function anywhere in the product.
//
// IT RIDES THE STATE PAYLOAD ON PURPOSE. The onboarding screen asks one question the daemon
// already knows the answer to — «where am I bound, and who can see me» — and a route of its
// own would have been the expensive way to say it, exactly as it would have been for
// «Правила» and «Аккаунты». The frozen table is the table of ROUTES.
//
// THE NETWORK IS RECOGNISED BY ITS ADDRESSES, NEVER BY A VENDOR. The product does not ask
// whether some particular mesh is installed — it looks for the address ranges an encrypted
// private network hands out (CGNAT 100.64.0.0/10 for IPv4, unique-local fc00::/7 for IPv6).
// Any private network that issues one is seen; none is named in this code, and a person who
// prefers a different one is not told they are using the product wrong. RFC1918 addresses
// are carried too, but as `lan` — a shared office wire is not an encrypted tunnel, and
// calling it one would be the screen's first lie.
//
// WHAT IT MAY NOT CARRY, said here so a later reader has to argue with a sentence: the
// daemon's token, in any form. The whole point of the screen is that the token becomes a
// real password the moment the daemon is reachable; a field that carried it would put that
// password on the wire of the very poll the screen renders. The machine's OWN private
// address does travel — it is the one thing a person cannot look up from the second machine
// and the reason they opened the screen at all.

/** A bind that means «this machine and nobody else». */
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1'])

/** A bind that means «every interface this machine has» — including ones nobody meant. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', ''])

/** `family` arrives as 'IPv4'/'IPv6' on current Node and as 4/6 on older ones. */
function familyOf(family) {
  if (family === 4 || family === 'IPv4') return 'IPv4'
  if (family === 6 || family === 'IPv6') return 'IPv6'
  return String(family ?? '')
}

/**
 * What KIND of network an address belongs to — `mesh` (an encrypted private network),
 * `lan` (an ordinary local wire) or null (anything else, including public addresses, which
 * this function deliberately does not report at all).
 */
function networkKindOf(address, family) {
  if (familyOf(family) === 'IPv4') {
    const parts = address.split('.').map((n) => Number(n))
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return null
    const [a, b] = parts
    if (a === 100 && b >= 64 && b <= 127) return 'mesh' // CGNAT — what the meshes hand out
    if (a === 10) return 'lan'
    if (a === 172 && b >= 16 && b <= 31) return 'lan'
    if (a === 192 && b === 168) return 'lan'
    return null
  }
  // fc00::/7 — unique-local, the IPv6 half of the same idea.
  return /^f[cd]/i.test(address) ? 'mesh' : null
}

/** An address as a url host: IPv6 goes in brackets, or the url is not a url at all. */
function urlHost({ address, family }) {
  return familyOf(family) === 'IPv6' ? `[${address}]` : address
}

/**
 * The read model behind «Работать удалённо». Fail-soft to the last line: a machine whose
 * interfaces cannot be listed says so (`readable:false`) instead of claiming there is no
 * private network — «I could not look» and «I looked and there is nothing» are different
 * answers, and only one of them should send a person to reinstall their tunnel.
 */
export function deriveRemoteAccess(config = {}, { networkInterfaces } = {}) {
  const bind = typeof config.bind === 'string' && config.bind !== '' ? config.bind : '127.0.0.1'
  const port = Number.isFinite(config.port) ? config.port : 7777
  const reach = LOOPBACK_BINDS.has(bind)
    ? 'this_machine_only'
    : WILDCARD_BINDS.has(bind)
      ? 'every_interface'
      : 'named_address'
  const visibleBeyondThisMachine = reach !== 'this_machine_only'

  const read = typeof networkInterfaces === 'function' ? networkInterfaces : osNetworkInterfaces
  let readable = true
  const interfaces = []
  try {
    const table = read() ?? {}
    for (const [name, list] of Object.entries(table)) {
      for (const entry of list ?? []) {
        if (!entry || entry.internal) continue
        // An IPv6 address can carry a zone («fe80::1%en0»); the zone is not part of the address.
        const address = String(entry.address ?? '').split('%')[0]
        const kind = address === '' ? null : networkKindOf(address, entry.family)
        if (!kind) continue
        interfaces.push({ interface: name, address, family: familyOf(entry.family), kind })
      }
    }
  } catch {
    readable = false
    interfaces.length = 0
  }

  const mesh = interfaces.find((i) => i.kind === 'mesh') ?? null

  // WHERE THE SECOND MACHINE WOULD TYPE, or null — and null is the interesting case. A
  // private network can be up while the daemon still listens to the loopback alone: the
  // network is not the door, and the screen has to be able to say exactly that instead of
  // printing an address that answers nothing.
  const openFrom =
    reach === 'this_machine_only'
      ? null
      : reach === 'named_address'
        ? `http://${urlHost({ address: bind, family: bind.includes(':') ? 'IPv6' : 'IPv4' })}:${port}`
        : mesh
          ? `http://${urlHost(mesh)}:${port}`
          : null

  return {
    bind,
    port,
    reach,
    visibleBeyondThisMachine,
    privateNetwork: { detected: mesh !== null, readable, interfaces },
    openFrom,
  }
}

// ══════════════════ the corpus read models: memory + style ══════════════════════
//
// Both are READERS of artifacts that already exist on this machine, through an injectable
// fs seam, and both are fail-soft to the last line: an unreadable directory, an unparsable
// note and a malformed ledger row are ALL normal states of a working install. A settings
// screen that 500s because a note has a typo in its frontmatter is worse than a screen
// that shows one note fewer.

/** The three fs calls these readers make, defaulted to node:fs and injectable for tests. */
function fsSeam(fsImpl) {
  const io = fsImpl ?? {}
  return {
    readdirSync: io.readdirSync ?? fsReaddirSync,
    readFileSync: io.readFileSync ?? fsReadFileSync,
    statSync: io.statSync ?? fsStatSync,
  }
}

/** Sorted *.md in a directory; an absent/unreadable directory is an empty list. */
function listMarkdown(io, dir) {
  try {
    const entries = io.readdirSync(dir) || []
    return entries.filter((f) => typeof f === 'string' && f.endsWith('.md')).sort()
  } catch {
    return []
  }
}

/** Read a file as text, or null. Never throws. */
function readTextOrNull(io, path) {
  try {
    const text = io.readFileSync(path, 'utf8')
    return text == null ? null : String(text)
  } catch {
    return null
  }
}

/** A note file is anything that is not a generated index or the tag registry. */
function isNoteFile(file) {
  return !MEMORY_STRUCTURAL.has(file) && !/^INDEX-.+\.md$/.test(file)
}

/** Frontmatter of a note, or null when it is missing / unparsable (lint owns schema errors). */
function noteFrontmatter(text, file) {
  try {
    return parseNote(text, { file }).frontmatter
  } catch {
    return null
  }
}

/**
 * The note's own line, in whichever generation of the schema wrote it.
 *
 * A schema-v2 record states its subject in `claim`; the v1 note that came before it used
 * `description`. This read model was written against v1 and only ever looked at
 * `description`, so on the founder's own corpus — 34 notes, `generation: v2`, nothing pending
 * — every row came back with an empty title and the screen showed a column of bare file ids.
 * The corpus was not wrong and no migration was outstanding: the reader simply predated the
 * format it was reading.
 *
 * v2 first, v1 as the fallback, because older corpora exist and both are legitimate.
 */
function noteTitle(fm) {
  for (const value of [fm && fm.claim, fm && fm.description]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, MEMORY_TITLE_CAP)
  }
  return ''
}

/**
 * The tag surface of ONE note — what the «О чём записи» cloud counts.
 *
 * A v2 record carries two facet fields and they are two different vocabularies: `retrieval.areas`
 * is the topical axis the loader itself retrieves by (`load --tags os,memory`), and `applies_to`
 * is the narrower scope a claim is about. The areas are therefore the tag surface, and
 * `applies_to` stands in for a record that declares no areas — mixing both into one cloud would
 * put two vocabularies under one heading. `tags` is the v1 spelling and stays as the last fallback.
 *
 * The first non-empty list wins per note; nothing is merged.
 */
function noteTagSurface(fm) {
  const areas = fm && fm.retrieval && Array.isArray(fm.retrieval.areas) ? fm.retrieval.areas : null
  for (const list of [areas, fm && fm.applies_to, fm && fm.tags]) {
    if (!Array.isArray(list)) continue
    const clean = list.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    if (clean.length > 0) return clean
  }
  return []
}

/** Last-modified ms, or 0 when the platform / seam cannot say. */
function mtimeOf(io, path) {
  try {
    const st = io.statSync(path)
    const ms = Number(st && st.mtimeMs)
    return Number.isFinite(ms) ? ms : 0
  } catch {
    return 0
  }
}

/**
 * deriveMemory({memoryDir, fsImpl}) → {noteCount, coreSize, tags, recent} | {absent:true}.
 *
 * THE CORPUS AS A SURFACE, NOT A WINDOW. The «Память» screen answers how much there is,
 * what it is about, and what moved recently — a note's BODY is deliberately not in the
 * contract. Reading a note is a terminal's job with the whole loader behind it; a LAN
 * payload that carried note bodies would be a copy of the memory tree leaving the machine
 * every few seconds for no screen that needed it.
 *
 * The cost is bounded by the note count, and notes are small by budget (the corpus lint
 * caps them), so this stays a few milliseconds on a poll that already talks to Postgres.
 *
 * @param {{memoryDir?:string, fsImpl?:object}} [args]
 * @returns {object}
 */
export function deriveMemory({ memoryDir, fsImpl } = {}) {
  if (!memoryDir) return { absent: true } // nothing wired — a valid state, not an error
  const io = fsSeam(fsImpl)

  const index = readTextOrNull(io, join(memoryDir, 'MEMORY.md'))
  const coreSize = index == null ? 0 : Buffer.byteLength(index, 'utf8')

  const tagCounts = new Map()
  const notes = []
  for (const file of listMarkdown(io, memoryDir)) {
    if (!isNoteFile(file)) continue
    const path = join(memoryDir, file)
    const text = readTextOrNull(io, path)
    if (text == null) continue
    const fm = noteFrontmatter(text, file)
    if (!fm) continue
    for (const tag of noteTagSurface(fm)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
    notes.push({
      id: file.replace(/\.md$/, ''),
      title: noteTitle(fm),
      mtimeMs: mtimeOf(io, path),
    })
  }

  if (notes.length === 0 && coreSize === 0) return { absent: true } // a fresh install

  const tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  const recent = notes
    .slice()
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, MEMORY_RECENT_CAP)
    .map(({ id, title }) => ({ id, title }))

  return { noteCount: notes.length, coreSize, tags, recent }
}

/**
 * fencedEvidence(section) → the concatenated content of the section's fenced blocks, or ''.
 *
 * THIS IS THE REDACTION BOUNDARY, and it is a whitelist. The distillation writes its mined
 * material inside fenced `untrusted-evidence` blocks AFTER running it through the secret
 * scrubber; anything a human typed around those fences went through no scrubber at all.
 * Publishing only what is inside a fence means the payload can carry a decision the miner
 * produced and can NEVER carry a sentence nobody redacted.
 */
function fencedEvidence(section) {
  const text = String(section ?? '')
  const re = /```[^\n]*\n([\s\S]*?)```/g
  const blocks = []
  let m
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trim())
  return blocks.join('\n').slice(0, STYLE_TEXT_CAP).trim()
}

/** The exam score ledger, oldest first. A malformed row is skipped, never thrown on. */
function readScoreLedger(io, memoryDir) {
  const raw = readTextOrNull(io, join(memoryDir, 'exam', 'scores.jsonl'))
  if (raw == null) return []
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object') rows.push(row)
    } catch {
      /* a ledger line that will not parse is a skipped row, not a broken screen */
    }
  }
  return rows
}

/** One training row of the history: when, over how many situations, and how it scored. */
function toTraining(row) {
  const n = (v) => Number(v) || 0
  return {
    date: String(row.ts ?? '').slice(0, 10),
    decisionsCount: n(row.total),
    ...(row.policyVersion != null ? { policyVersion: row.policyVersion } : {}),
    summary: `совпадение ${n(row.matchRate)}% · ${n(row.match)} / ${n(row.partial)} / ${n(row.miss)}`,
  }
}

/** The distillation drafts, newest id first, as redacted situation → decision → why. */
function readDecisionDrafts(io, memoryDir) {
  const draftsDir = join(memoryDir, 'drafts')
  const out = []
  for (const file of listMarkdown(io, draftsDir)) {
    if (!isNoteFile(file)) continue
    const text = readTextOrNull(io, join(draftsDir, file))
    if (text == null) continue
    const fm = noteFrontmatter(text, file)
    if (!fm || fm.kind !== 'founder-decision') continue
    const id = file.replace(/\.md$/, '')
    const pair = parseNoteToPair(id, text) // the SAME split the exam builder uses
    const situation = fencedEvidence(pair.situation)
    const decision = fencedEvidence(pair.decision)
    if (!situation && !decision) continue // nothing redacted to show — publish nothing
    out.push({ id, situation, decision, why: fencedEvidence(pair.why) })
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, STYLE_DECISIONS_CAP)
}

/**
 * deriveStyle({memoryDir, fsImpl}) → {policyVersion?, matchRate?, trainings, decisions}
 * | {absent:true}.
 *
 * THE SNAPSHOT AS METRICS AND ALREADY-REDACTED QUOTES. Two artifacts feed it and no third:
 * the exam score ledger (the training history keyed by policy version, and the latest match
 * rate — fidelity is MEASURED, not asserted) and the distillation's own drafts.
 *
 * WHAT IT NEVER OPENS, BY CONSTRUCTION:
 *   - the session transcripts. The raw material of the corpus never leaves the disk; this
 *     reader does not know where it lives and has no code path to it.
 *   - the exam ANSWER KEY (`exam-<date>-key.jsonl`). The blind-exam invariant is a path
 *     convention, and a payload that quietly read the key would dissolve it. This reader
 *     opens exactly one file under `exam/`: the score ledger.
 *   - the corpus root. A promoted, hand-written decision note went through no scrubber;
 *     only the miner's drafts are redacted artifacts.
 *
 * A metric the artifacts do not carry is OMITTED rather than invented: an install that has
 * never been graded has no matchRate, and a fresh machine has no style at all.
 *
 * КТО ЭТО ЧИТАЕТ СЕГОДНЯ — НИКТО, И ЭТО СКАЗАНО ЗДЕСЬ ВСЛУХ. Единственным читателем был экран
 * «Мой стиль», и владелец снял его 28.08.2026 словами «мой стиль вообще не работает… убери
 * пока экран»: витрина без провода — ни одной своей двери, и ни один промпт этих чисел не
 * читал (`resolvePolicyVoice` в chat.mjs берёт готовый дистиллят с диска, а не этот счёт).
 *
 * ПОЧЕМУ СЧЁТ ВСЁ РАВНО ОСТАЁТСЯ. Артефакты под ним живые: экзамен продолжает оцениваться, а
 * дистилляция — писать черновики решений, и голос беседы уже сегодня встаёт на их результат.
 * Снят ЭКРАН, а не обучение. Цена сказана честно: это чтение двух файлов на КАЖДОМ чтении
 * состояния, то есть на каждом опросе окна, ради поля, которое сейчас никто не открывает.
 * Поэтому решение временное: появится читатель (строка стиля в промпте или вернувшийся экран)
 * — он назовётся здесь; не появится — удаляются вместе и эта функция, и поле `style` в
 * payload, и типы под него.
 *
 * @param {{memoryDir?:string, fsImpl?:object}} [args]
 * @returns {object}
 */
export function deriveStyle({ memoryDir, fsImpl } = {}) {
  if (!memoryDir) return { absent: true }
  const io = fsSeam(fsImpl)

  const scores = readScoreLedger(io, memoryDir)
  const decisions = readDecisionDrafts(io, memoryDir)
  if (scores.length === 0 && decisions.length === 0) return { absent: true } // never taught

  const last = scores.length ? scores[scores.length - 1] : null
  const matchRate = last == null ? null : Number(last.matchRate)
  return {
    ...(last && last.policyVersion != null ? { policyVersion: last.policyVersion } : {}),
    ...(Number.isFinite(matchRate) ? { matchRate } : {}),
    trainings: scores.slice().reverse().slice(0, STYLE_TRAININGS_CAP).map(toTraining),
    decisions,
  }
}

/**
 * ONE window, as it goes on the wire.
 *
 * `status` is always one of three words, so a screen never has to tell an absent field from a
 * false one. `resetsAt` travels as an ISO string because that is what every clock face in the
 * window already reads. `pct` is null unless the vendor itself sent a fraction — the screens
 * draw a number only when there is a number.
 *
 * `source` rides ONLY when the fact was not the account's own reading: today that means
 * `terminal` — a reading taken by a status line signed into this very account's config
 * directory, which is how the five-hour row stopped being permanently empty. It is ABSENT for
 * an account's own reading rather than spelled `account`, so the shape a screen has always
 * received is the shape it still receives, and a label appears exactly where there is
 * something to label.
 */
function windowFact(fact) {
  const f = fact && typeof fact === 'object' ? fact : {}
  const status = f.status === 'open' || f.status === 'exhausted' ? f.status : 'unknown'
  const resetsAt = toMs(f.resetsAt)
  return {
    status,
    resetsAt: Number.isFinite(resetsAt) ? new Date(resetsAt).toISOString() : null,
    // An absent percentage must stay absent. `numOrNull(null)` is 0, because Number(null) is 0 —
    // so an unknown window went on the wire as «0%», which is the one wrong answer this whole
    // change exists to stop: a zero bar is read as «the quota is free».
    pct: f.pct == null ? null : numOrNull(f.pct),
    ...(f.source === 'terminal' ? { source: 'terminal' } : {}),
  }
}

/** A payload window bar: the two windows, plus a refusal when one is standing. */
function windowBar(win) {
  return {
    fiveHour: windowFact(win.fiveHour),
    week: windowFact(win.week),
    ...(win.closedUntil != null ? { closedUntil: win.closedUntil } : {}),
  }
}

/**
 * The TERMINAL'S OWN window reading, as it goes on the wire.
 *
 * It is the one place a real percentage comes from: the provider pipes it to the status line
 * command of the person's own terminal, and that reading counts the sessions he ran himself —
 * which on a real machine is most of them. It travels as its own block rather than as an
 * account's bar because nothing in that payload names an account, and pinning it on one would
 * be a guess.
 *
 * `observed` distinguishes «never heard» from «heard, but that window has since turned over»,
 * and `observedAt` survives the expiry so the screen can name the moment instead of drawing a
 * zero. Absent seam → honestly empty, never an error.
 */
function terminalBar(read) {
  const empty = { observed: false, observedAt: null, fiveHour: windowFact(null), week: windowFact(null) }
  if (typeof read !== 'function') return empty
  try {
    const t = read()
    if (!t || typeof t !== 'object') return empty
    return {
      observed: !!t.observed,
      observedAt: typeof t.observedAt === 'string' ? t.observedAt : null,
      fiveHour: windowFact(t.fiveHour),
      week: windowFact(t.week),
    }
  } catch {
    return empty
  }
}

// ══════════════ the CONNECTED PROJECT's corpus — a surface over a foreign tree ═══════════
//
// The window shows a project the daemon does not own: its
// memory, READ-ONLY, plus — when the corpus is still in the older format — a per-file
// preview of what a migration would change. Three properties are load-bearing:
//
//   - THE READERS ARE INJECTED. `readProjectMemory` and `previewProjectMigration` live in
//     project-sync.mjs, which imports `deriveMemory` from THIS file. Injecting them instead
//     of importing them keeps that edge one-way; a static import back would make the two
//     modules a cycle, and the composition root is where a daemon module learns about
//     another one anyway.
//   - LIVENESS IS NEVER ASSUMED. The section says `polling` unless the watcher seam actively
//     says `live`. A screen that claims live and shows stale is the failure the watcher's
//     whole reconcile exists to prevent, so the DEFAULT here is the modest claim.
//   - READ-ONLY IS ON THE WIRE. `readOnly: true` is carried rather than left implicit, so
//     the screen states the boundary from the payload rather than from a hard-coded belief
//     about what the daemon happens to do today.

/**
 * The connected project: the ACTIVE registry entry, and only when it names a folder on disk.
 * A registry entry with no `path` is a label for grouping tasks, not a connection — reading
 * it as one would be how the screen ends up showing a corpus that belongs to nobody.
 *
 * ДВА КАТАЛОГА, ПОТОМУ ЧТО У ПРОЕКТА ДВА АДРЕСА. `dir` — дерево кода: репозиторий, коммиты,
 * каталоги прогонов, корпус памяти. `planningDir` — дом планирования: `.planning` этого же
 * продукта, который в двухрепном доме лежит в другом каталоге. Второй адрес не задан — оба
 * поля называют одну папку, и каждый читатель ниже ведёт себя ровно как раньше.
 */
function connectedProject(config = {}) {
  const entry = activeProjectEntry(config)
  const dir = codeTreeOf(entry)
  if (!dir) return null
  return { id: entry.id, name: entry.name ?? entry.id, dir, planningDir: planningHomeOf(entry) }
}

/** The watcher's own word on whether it is watching or merely polling. Fail-modest. */
function resolveLiveness(seam) {
  try {
    const v = typeof seam === 'function' ? seam() : seam
    return v === 'live' ? 'live' : 'polling'
  } catch {
    return 'polling' // a seam that throws has told us nothing, and nothing is not «live»
  }
}

/**
 * deriveProjectMemory(deps) → the connected project's corpus surface, or {absent:true}.
 *
 * Nothing connected, nothing readable, no corpus, or a reader that throws — all four are the
 * SAME declared-absent value, because from the screen's chair they are the same fact: there
 * is no project memory to show. None of them is an error and none of them wedges the poll.
 *
 * The returned surface carries no path and no note body; that is the contract `deriveMemory`
 * already holds and this section inherits it unchanged.
 *
 * @param {{config?:object, readProjectMemory?:Function, previewProjectMigration?:Function,
 *          projectLiveness?:Function|string, migrationStagingDir?:string, fsImpl?:object,
 *          clock?:Function}} [deps]
 * @returns {object}
 */
export function deriveProjectMemory(deps = {}) {
  const project = connectedProject(deps.config || {})
  if (!project) return { absent: true }
  if (typeof deps.readProjectMemory !== 'function') return { absent: true }

  let surface
  try {
    surface = deps.readProjectMemory({ projectDir: project.dir, fsImpl: deps.fsImpl })
  } catch {
    return { absent: true }
  }
  if (!surface || surface.absent) return { absent: true }

  const out = {
    project: { id: project.id, name: project.name },
    liveness: resolveLiveness(deps.projectLiveness),
    readOnly: true,
    ...surface,
  }

  // The preview is offered ONLY when there is something to migrate: a corpus already in the
  // current format pays nothing for this section existing.
  if (surface.migratable && typeof deps.previewProjectMigration === 'function') {
    try {
      const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
      const migration = deps.previewProjectMigration({
        projectDir: project.dir,
        stagingDir: deps.migrationStagingDir,
        now: new Date(clock()),
      })
      if (migration) out.migration = migration
    } catch {
      /* a preview that cannot run is a section the screen does not show, never a broken poll */
    }
  }
  return out
}

// ══════════════ THE WORKBENCH: DRAFTS, RESERVATIONS, THE BACKLOG ════════════════
//
// Three read models over the CONNECTED project — the same project «Память» already shows,
// resolved through the same `connectedProject`. That is not a detail: the drafts panel and the
// corpus panel sit on one screen, and a drafts list read out of a different tree than the
// corpus beside it would be a screen where two halves disagree and neither says so.
//
// ALL THREE DERIVE AND STORE NOTHING. A draft is a file the write pipeline put in `drafts/`; a
// reservation is a directory in `.sma/claims`; a backlog line is a line of a markdown file a
// person edits by hand. Every one of them changes without this daemon's knowledge — which is
// exactly why none of them may be remembered here.
//
// AND NONE OF THEM WRITES. Applying a draft, clearing a reservation and putting a backlog line
// into the queue are three other doors, each standing in front of a mechanism that already
// exists. What is here is only the reading.

/** How many drafts / backlog rows one answer carries — a panel, never a feed. */
const DRAFTS_CAP = 200
const BACKLOG_CAP = 500

/**
 * How much of a draft travels as its preview.
 *
 * A person agreeing to a lesson is agreeing to WHAT IT SAYS, so the preview is the record
 * itself rather than its title. It is capped because a card is not a document — and a draft
 * past this size is one a person should open in an editor before saying yes to it.
 */
const DRAFT_PREVIEW_CAP = 16 * 1024

/** Where the corpus of a project sits, and where the pipeline stages what it will not write. */
const CORPUS_SEGMENTS = Object.freeze(['.claude', 'memory'])
const DRAFTS_SEGMENT = 'drafts'

/** The consumed-draft marker the apply doors leave behind — a spent draft is not a draft. */
const APPLIED_DRAFT_SUFFIX = '.applied.md'

/**
 * A draft's addressable name: the file's own stem, bounded so it can only ever name a file
 * INSIDE the drafts directory. No separator, no leading dot — the same posture the record-id
 * law of the write pipeline holds, for the same reason: this string is joined onto a path.
 */
const DRAFT_STEM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * ONE BACKLOG LINE, BY SHAPE AND NEVER BY DICTIONARY.
 *
 * A bulleted entry, optionally carrying a task checkbox, whose bold lead is an identifier:
 * some letters, a dash, a number. WHICH letters is the project's business — this daemon does
 * not know what they mean and must never grow an opinion about them, because the moment it
 * carries a list of known prefixes it is a window that works for one backlog and silently
 * shows nothing for everybody else's.
 */
export const BACKLOG_ID_RE = /^[A-Z][A-Z0-9]{1,7}-\d{1,6}$/
const BACKLOG_LINE_RE = /^[-*]\s+(?:\[([ xX])\]\s+)?\*\*([A-Z][A-Z0-9]{1,7}-\d{1,6})\*\*\s*(.*)$/

/** A `key:2026-08-07`-shaped inline-code tag — a date by SHAPE, not by the word in front. */
const BACKLOG_AGE_TAG_RE = /`([A-Za-z][A-Za-z0-9_-]{0,31}:\d{4}-\d{2}-\d{2})`/

/** A row's own text is a line on a board, not the paragraph the file keeps behind it. */
const BACKLOG_TITLE_CAP = 400

/**
 * How long ago, in the words a person uses.
 *
 * ONE implementation for every «age» on the workbench (a draft, a session, a reservation),
 * because three of them formatted three ways is how one panel ends up saying «2 ч» beside
 * «2 hours» beside an ISO timestamp. The contract calls this field a string and means a
 * duration; a timestamp under that name would be a fact the screen has to undo.
 */
function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч`
  return `${Math.floor(hours / 24)} дн`
}

/** The «now» every age on this screen is measured against — injected like everywhere else. */
function nowOf(clock) {
  return typeof clock === 'function' ? clock() : Date.now()
}

/**
 * deriveMemoryDrafts({config, fsImpl, clock}) → {drafts:[{id, targetFile, preview, age}]}.
 *
 * Every staged record of the connected project's corpus, read off disk on every call. A
 * project that is not connected, a corpus that has no drafts directory and a directory that
 * cannot be read are all the SAME answer — an empty list — because from the screen's chair
 * they are the same fact and none of them is an error.
 *
 * A draft that cannot be parsed still travels: it is a file somebody has to look at, and a
 * list that silently dropped it would be a list that hides the one row that needs a person.
 * Its `targetFile` then falls back to its own name, which is the honest answer to «what would
 * this become» for a file whose frontmatter nobody can read.
 *
 * @param {{config?:object, fsImpl?:object, clock?:Function}} [deps]
 * @returns {{drafts:object[]}}
 */
export function deriveMemoryDrafts({ config, fsImpl, clock } = {}) {
  const project = connectedProject(config || {})
  if (!project) return { drafts: [] }

  const io = fsSeam(fsImpl)
  const dir = join(project.dir, ...CORPUS_SEGMENTS, DRAFTS_SEGMENT)
  const now = nowOf(clock)

  const names = safeList(io, dir)
    .filter((f) => f.endsWith('.md') && !f.endsWith(APPLIED_DRAFT_SUFFIX))
    .sort()
    .slice(0, DRAFTS_CAP)

  const drafts = []
  for (const name of names) {
    const id = name.slice(0, -3)
    // A name this daemon could not hand back to the apply door is a name it does not show:
    // a row a person can see and cannot act on is worse than a row that is not there.
    if (!DRAFT_STEM_RE.test(id)) continue

    let text = ''
    try {
      text = String(io.readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue // the file went away between the listing and the read — it is simply not a row
    }

    let targetFile = name
    let kind = ''
    try {
      const parsed = parseNote(text, { file: name })
      const fm = (parsed && parsed.frontmatter) || null
      const recordId = fm ? String(fm.id ?? '').trim() : ''
      if (recordId !== '') targetFile = `${recordId}.md`
      kind = fm ? String(fm.draft_kind ?? '').trim() : ''
    } catch {
      /* an unparseable draft keeps its own name as its target — see the header */
    }

    let ageMs = 0
    try {
      const st = io.statSync(join(dir, name))
      const mtime = st && Number.isFinite(st.mtimeMs) ? st.mtimeMs : NaN
      ageMs = Number.isFinite(mtime) ? now - mtime : 0
    } catch {
      ageMs = 0
    }

    drafts.push({
      id,
      targetFile,
      // THE WHOLE FILE IS THE DIFF. The apply path refuses to write over a record that already
      // exists, so what a person is agreeing to is a NEW note — every line of it added. There
      // is no other side to show, and rendering an empty left column would invent one.
      preview: text.length > DRAFT_PREVIEW_CAP ? text.slice(0, DRAFT_PREVIEW_CAP) : text,
      age: humanAge(ageMs),
      // WHICH DOOR OWNS THIS DRAFT, said out loud on the row.
      //
      // A corpus keeps drafts of more than one kind, and the apply door in front of this list
      // is the STAGED-RECORD one — the pipeline refuses anything else, by name and correctly. A
      // list that did not carry the kind would be a panel of rows whose button always fails,
      // and the reader would learn why only by pressing it. `applicable` is not a second
      // decision: the pipeline still decides, and this is the same fact read early so a screen
      // can show the difference instead of discovering it.
      kind,
      applicable: kind === PIPELINE_DRAFT_KIND,
    })
  }
  return { drafts }
}

/**
 * deriveCoordination({config, readLedger, clock}) → {sessions, claims, collisions}.
 *
 * WHO ELSE HAS THIS CHECKOUT OPEN, what they reserved before touching it, and where two
 * reservations met. The ledger itself is read by the INJECTED reader — the composition root
 * hands over the coordination runtime's own readers, so this daemon never grows a second
 * parser of `.sma/`. What happens here is the shaping: explicit-pick, one age format, and
 * NOT ONE PATH from the founder's disk (a glob is a pattern the person typed; a session's
 * file name and a claim's directory are this machine's business).
 *
 * @param {{config?:object, readLedger?:Function, clock?:Function}} [deps]
 * @returns {{sessions:object[], claims:object[], collisions:object[]}}
 */
export async function deriveCoordination({ config, readLedger, clock } = {}) {
  const empty = { sessions: [], claims: [], collisions: [] }
  const project = connectedProject(config || {})
  if (!project || typeof readLedger !== 'function') return empty

  // The production reader is ASYNC — it imports the project runtime's own readers — and for
  // one release this derive consumed its Promise as though it were the ledger: `.sessions`
  // of a Promise is undefined, so the panel said «кроме Вас никого» while a session was
  // editing files in the checkout (QA D3, 11.08.2026). The await is the fix. The catch
  // below is thereby REACHABLE for the first time, and it no longer launders a failure:
  // an unreadable ledger is reported as such — the door answers 503 and the screen's
  // error branch shows it — never passed off as an empty checkout.
  let ledger
  try {
    ledger = await readLedger({ projectDir: project.dir })
  } catch {
    return { ...empty, unreadable: true }
  }
  if (!ledger || typeof ledger !== 'object') return empty

  const now = nowOf(clock)
  const list = (v) => (Array.isArray(v) ? v : [])

  return {
    sessions: list(ledger.sessions).map((s) => ({
      id: String((s && s.id) ?? ''),
      title: String((s && s.title) ?? ''),
      age: humanAge(Number.isFinite(s && s.ageMs) ? s.ageMs : now - toMs((s && s.since) ?? NaN)),
    })),
    claims: list(ledger.claims).map((c) => ({
      name: String((c && c.name) ?? ''),
      globs: list(c && c.globs).map(String),
      desc: String((c && c.desc) ?? ''),
      age: humanAge(Number.isFinite(c && c.ageMs) ? c.ageMs : now - toMs((c && c.since) ?? NaN)),
    })),
    collisions: list(ledger.collisions).map((x) => ({
      a: String((x && x.a) ?? ''),
      b: String((x && x.b) ?? ''),
      overlap: list(x && x.overlap).map(String),
    })),
  }
}

/**
 * deriveBacklog({config, fsImpl}) → {rows:[{id, title, ageLine, headline, priority, notReady}]}.
 *
 * ЧИТАЕТСЯ ИЗ ДОМА ПЛАНИРОВАНИЯ, А НЕ ИЗ ДЕРЕВА КОДА. Беклог — планирование, и в доме, где
 * код и планирование разведены по репозиториям, он лежит в другом каталоге. Пока адрес был
 * один, этот читатель честно смотрел в дерево кода и честно отвечал «пусто» о файле, который
 * существует; беклог показывался только если завести дом планирования вторым проектом. Второй
 * адрес не задан — это тот же самый каталог, и ответ не меняется.
 *
 * The project's own `.planning/BACKLOG.md`, read as rows. NO FILE IS AN EMPTY LIST, honestly:
 * a project that keeps no backlog is not a broken project, and a 404 here would make the panel
 * look like a fault instead of an absence.
 *
 * The parser knows one SHAPE and no vocabulary (see BACKLOG_LINE_RE). A line that does not
 * carry an identifier is not a row — it is prose, a heading or a note to self, and the board
 * shows what the file marked as an entry rather than everything it happens to contain.
 *
 * ═══════ ПОЧЕМУ СТРОКА НЕ ВЗЯТА — ВИДНО ЗДЕСЬ, А НЕ ТОЛЬКО В ЖУРНАЛЕ ═══════
 *
 * Часовой скан отказывал молча: 15 из 17 карточек с весом не доезжали до очереди, слова
 * отказа оставались в журнале демона, и человек у окна видел ровно то же, что и всегда, —
 * строку, которая просто не поехала. Поэтому каждая строка доски несёт ТРИ вычисленных факта,
 * и все три считаются ТЕМИ ЖЕ функциями, которыми считает скан: `headline` — заголовок,
 * которым строка поедет в очередь; `priority` — число, на котором она там встанет; `notReady`
 * — почему скан её не берёт, словами человека (пусто — возьмёт).
 *
 * `title` при этом остаётся строкой ФАЙЛА целиком, с тегами: доска показывает то, что
 * написано, а не то, что из этого поняла машина.
 *
 * @param {{config?:object, fsImpl?:object}} [deps]
 * @returns {{rows:object[]}}
 */
export function deriveBacklog({ config, fsImpl } = {}) {
  const project = connectedProject(config || {})
  if (!project) return { rows: [] }

  const io = fsSeam(fsImpl)
  let text = ''
  try {
    text = String(io.readFileSync(join(project.planningDir, '.planning', 'BACKLOG.md'), 'utf8'))
  } catch {
    return { rows: [] }
  }

  // ЧТО В РЕЕСТРЕ ОТКРЫТО — по ВСЕМУ файлу и до сборки строк: зависимость называет карточку,
  // которая может стоять ниже по списку, и цикл, спрашивающий только уже пройденное, ответил
  // бы «ничего не ждёт» ровно в половине случаев.
  const lines = text.split(/\r?\n/)
  const openIds = new Set()
  for (const line of lines) {
    const m = BACKLOG_LINE_RE.exec(line)
    if (m && !(m[1] && m[1].toLowerCase() === 'x')) openIds.add(m[2])
  }

  const rows = []
  for (const line of lines) {
    const m = BACKLOG_LINE_RE.exec(line)
    if (!m) continue
    // A finished line is not work waiting to be done. The file's own checkbox says so, and
    // dropping it here is the difference between a board and a history.
    if (m[1] && m[1].toLowerCase() === 'x') continue
    const tail = String(m[3] ?? '').trim()
    const age = BACKLOG_AGE_TAG_RE.exec(tail)
    const { text: words, tags } = readLineTags(tail)
    const sp = tags.sp !== undefined ? Number.parseInt(tags.sp, 10) : NaN
    const verdict = intakeVerdict(
      {
        id: m[2],
        open: true,
        phase: tags.phase ?? null,
        storyPoints: Number.isFinite(sp) ? sp : null,
        deps: depsOf(tags),
      },
      openIds,
    )
    rows.push({
      id: m[2],
      title: tail.replace(/^[·—–\-:]\s*/, '').slice(0, BACKLOG_TITLE_CAP),
      ageLine: age ? age[1] : '',
      headline: headlineOf(words).title,
      priority: queuePriority({ size: tags.size ?? null, priority: tags.priority ?? null }),
      notReady: verdict.reason,
    })
    if (rows.length >= BACKLOG_CAP) break
  }
  return { rows }
}

// ══════════════ THE PHASE CYCLE, DERIVED FROM THE DIRECTORY IT LIVES IN ══════════
//
// The card of a phase is READ, never remembered. Every number on it — which stages are done,
// how many questions are waiting, which plans exist and what a person said about each line of
// the acceptance — is counted off `.planning/phases/<dir>` at the moment the screen asks, for
// the same reason the discussion engine stores nothing: a phase is worked on from a terminal
// as often as from this window, and a daemon that kept its own copy would be the one holding
// the stale one.
//
// TWO RULES ARE BORROWED, NOT RESTATED. «Which directory is phase N» is `findPhaseDir`, the
// same function the daemon's exit gate finds a stage's document with. «Which document proves
// which stage» is `STAGE_ARTIFACTS`, the same map that gate closes a stage on. A card that
// answered either question its own way would show a stage as finished while the machine kept
// failing it — which is worse than showing nothing, because it looks like an answer.
//
// NO PATH ON THE FOUNDER'S DISK LEAVES HERE. What travels for a document is the name it has
// and the REPOSITORY-RELATIVE path the artefact door accepts, rooted at `.planning/` — which
// is the only root that door opens. The directory this all sits under stays on this side.

/** The stages, in the order a phase goes through them. */
export const PHASE_STAGES = Object.freeze(['discuss', 'plan', 'design', 'execute', 'verify'])

/** Where phases live under a checkout, in the forward-slashed form the artefact door takes. */
const PHASES_PATH = '.planning/phases'

/**
 * Ступень, чей результат подтверждает ЧЕЛОВЕК ГЛАЗАМИ, а не ворота по документу на диске.
 *
 * Названа здесь ровно затем, чтобы карточка ниже спрашивала о ней у той же карты припаркованных
 * строк, что и вопросы, — второе написание этого слова было бы вторым ответом на «какая ступень
 * ждёт человека».
 */
const DESIGN_STAGE = 'design'

/** A UAT file of a phase: the acceptance record `/sma-verify-work` keeps. */
const UAT_FILE_RE = /-UAT[^/\\]*\.md$/

/** One test block of that file: `### N. Name` / `expected:` / `result:` (+ an optional note). */
const UAT_ITEM_RE =
  /^###\s*(\d+)\.\s*(.+?)\s*$\n(?:expected:[^\n]*\n)?result:\s*\[?([A-Za-z_]+)\]?\s*$(?:\n(?:reported|reason):\s*([^\n]*))?/gm

/**
 * What a recorded UAT result means as a verdict.
 *
 * The template's own vocabulary is pass / issue / pending / skipped / blocked, and the door
 * that writes a verdict writes THAT vocabulary — `fail` is the word the screen uses and
 * `issue` is the word the file uses, and translating at the boundary is what keeps the file
 * readable by the workflow that owns it. Anything not yet decided is `null`, never `fail`:
 * «nobody has looked at this» and «somebody looked and it was broken» are different facts.
 */
function uatVerdictOf(result) {
  if (result === 'pass') return 'pass'
  if (result === 'issue' || result === 'fail') return 'fail'
  return null
}

/** Read a directory, or nothing at all. An unreadable phase root is «no phases», not a fault. */
function safeList(io, dir) {
  try {
    const entries = io.readdirSync(dir)
    return Array.isArray(entries) ? entries.map(String) : []
  } catch {
    return []
  }
}

/** Is this entry of the phases root a directory? An unstattable entry is not one. */
function isDir(io, path) {
  try {
    const st = io.statSync(path)
    return !!(st && typeof st.isDirectory === 'function' && st.isDirectory())
  } catch {
    return false
  }
}

/**
 * The human half of a phase directory's name: `phase-12-front-workplace` → `front-workplace`.
 * A directory that carries no number is its own name — inventing one would be a guess.
 */
function phaseNameOf(dir) {
  const m = String(dir).match(/^(?:phase-)?\d+(?:\.\d+)?[-_.]?(.*)$/i)
  const rest = m && m[1] ? m[1].trim() : ''
  return rest === '' ? String(dir) : rest
}

/** `front-workplace` → `front workplace`. A slug is a file name; a screen is read by a person. */
function readableSlug(slug) {
  return String(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** `### Phase 12: SMA — Рабочее место во фронте` → title, keyed by phase number. */
const ROADMAP_HEADING = /^#{2,4}\s*Phase\s+(\d+(?:\.\d+)?)\s*[:.—-]\s*(.+?)\s*$/i

/**
 * A title that OPENS with a bracketed aside is carrying bookkeeping in front of its name —
 * «(экс-49.7) SMA V5.1 — Импорт…», «(new, split out by the audit) …». The aside is written for
 * whoever maintains the roadmap; the person looking at the screen wants the name. Only a
 * LEADING group is removed, and only when something is left after it: a bracket in the middle
 * is part of the sentence, and a title that is nothing but an aside keeps it rather than
 * becoming blank.
 */
function stripLeadingAside(title) {
  const text = String(title).trim()
  const m = text.match(/^\([^)]*\)\s*(.+)$/)
  return m && m[1].trim() !== '' ? m[1].trim() : text
}

/**
 * `- [x] **Phase 12: …` — ГАЛОЧКА ЧЕЛОВЕКА о том, что фаза закрыта.
 *
 * Это ТРЕТИЙ источник о готовности фазы рядом с диском и очередью, и единственный, где говорит
 * сам человек. Форма — та же, что читает командная строка: список фаз в шапке роадмапа, где
 * закрытое отмечено крестиком. Жирная разметка вокруг слова «Phase» необязательна, потому что
 * роадмапы пишут руками и обе формы встречаются.
 */
const ROADMAP_CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*(?:\*\*)?\s*Phase\s+(\d+(?:\.\d+)?)\b/

/**
 * roadmapTitles(projectDir, io) → Map(phase number → the title the ROADMAP gives it).
 *
 * WHY THE ROADMAP AND NOT THE DIRECTORY NAME. A directory name is a file-system identifier and
 * it reads like one: `11-49-9-sma-v5-3`, `49.2-sma-v3-trust-spine`. Shown on a screen that is
 * the whole point of not using a terminal, that is noise — the person recognises none of their
 * own work in it. The roadmap already holds the phase's name in the words its author chose,
 * and those words are what the person is looking for.
 *
 * Read once per derive, never cached: the roadmap is edited by hand and a screen that shows
 * yesterday's title is a smaller bug than one nobody can explain. A project without a roadmap,
 * or with headings in another shape, simply gets an empty map and the fallback below.
 */
function roadmapTitles(projectDir, io) {
  const byNumber = new Map()
  const headings = []
  // Отмеченные крестиком — собираются ТЕМ ЖЕ единственным чтением файла, что и заголовки.
  // Список фаз стоит в шапке роадмапа, ВЫШЕ разделов, поэтому применяется он после обоих
  // проходов: иначе галочка приходила бы раньше строки, которую она закрывает.
  const ticked = new Set()

  for (const rel of ['ROADMAP.md', 'ROADMAP.ru.md']) {
    let raw = ''
    try {
      raw = String(io.readFileSync(join(projectDir, '.planning', rel), 'utf8'))
    } catch {
      continue // no roadmap of that name — not an error, just no titles from it
    }
    const lines = raw.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const tick = lines[i].match(ROADMAP_CHECKBOX)
      if (tick && tick[1] !== ' ') ticked.add(Number(tick[2]))
      const m = lines[i].match(ROADMAP_HEADING)
      if (!m) continue
      const n = Number(m[1])
      const full = m[2].trim()
      headings.push({ n, full })
      // FIRST heading wins: a roadmap that mentions a phase twice is naming it once and
      // referring to it afterwards.
      //
      // `lead` — абзац, который стоит ПОД этим заголовком. Он читается здесь, тем же единственным
      // чтением файла, потому что нужен он ровно тогда, когда у фазы нет своего CONTEXT.md, и
      // второе открытие того же роадмапа ради одной строки было бы вторым источником одного факта.
      if (!byNumber.has(n)) {
        // `closed: false` СТАВИТСЯ СРАЗУ: «галочки не стоит» — это ответ, а не молчание, и
        // отсутствие поля читалось бы вторым способом сказать то же самое.
        byNumber.set(n, { n, title: stripLeadingAside(full), lead: paragraphAt(lines, i + 1), closed: false })
      }
    }
  }

  // SECOND PASS — the old number a phase used to carry, when the roadmap says so plainly.
  //
  // Directories outlive renumbering: `49.2-sma-v3-trust-spine` is «Phase 3» in the roadmap now,
  // and its heading says which one it used to be — «(экс-49.2)». Reading that turns six historic
  // directories from slugs into names.
  //
  // THE RULE IS DELIBERATELY NARROW, because the naive version is WRONG here and it is worth
  // saying how. Phase 8's aside reads «(новая — «дни 1–30» канона, выделена из экс-49.7 аудитом
  // K1)» — it MENTIONS 49.7, which belongs to Phase 9, and a rule that scanned asides for any
  // number would have given Phase 9's directory Phase 8's name. So an alias is taken only from a
  // SHORT aside carrying EXACTLY ONE number: prose is refused, and «is this an identifier or a
  // sentence» is decided by shape rather than by hope. A number already claimed by a heading of
  // its own is never overwritten — second pass, and primaries win.
  for (const { n, full } of headings) {
    const alias = shortAsideNumber(full)
    if (alias === null || byNumber.has(alias)) continue
    const primary = byNumber.get(n)
    if (primary) byNumber.set(alias, primary)
  }

  // ТРЕТИЙ ПРОХОД — галочки. Он последний, потому что список фаз стоит выше разделов, а запись
  // об одной фазе тут одна на оба её номера: псевдоним — тот же объект, и закрытие достаётся
  // папке, которая всё ещё носит старый номер, вместе с названием.
  for (const n of ticked) {
    const entry = byNumber.get(n)
    if (entry) entry.closed = true
  }

  return byNumber
}

/**
 * `(экс-49.2)` → 49.2. `(ex-3)` → 3. Long prose, or a bracket holding two numbers, or none →
 * null. Fourteen characters is the whole of the judgement: an identifier is short, a sentence
 * is not.
 */
function shortAsideNumber(title) {
  const m = String(title).match(/^\(([^)]{0,14})\)/)
  if (!m) return null
  const numbers = m[1].match(/\d+(?:\.\d+)?/g)
  return numbers && numbers.length === 1 ? Number(numbers[0]) : null
}

/**
 * ОПИСАНИЕ ФАЗЫ СЛОВАМИ — сколько его вообще едет и откуда оно берётся.
 *
 * Абзац, а не документ: карточка отвечает на вопрос «о чём эта фаза», а сам файл открывается
 * одним кликом через дверь артефактов — то единственное место, где чтение файла ограничено.
 * Потолок здесь по той же причине, что у шапки плана рядом: файл на диске написан тем, кто его
 * написал, и абзац, приехавший на сорок тысяч знаков, должен стоить ограниченной работы.
 */
const DESCRIPTION_CAP = 600
const DESCRIPTION_HEAD_CHARS = 8192

/** `- **слово** — текст` → `слово — текст`. Разметка снимается, слова остаются. */
function stripMarkdownLine(line) {
  return String(line)
    .replace(/^[>\s]*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .trim()
}

/**
 * paragraphAt(lines, from) → первый связный абзац начиная с этой строки, или null.
 *
 * Пустые строки и заголовки ПЕРЕД абзацем пропускаются (описание почти всегда стоит под
 * названием), пустая строка или заголовок ПОСЛЕ его начала — конец абзаца. Ничего не
 * додумывается: файл, в котором после этого места только заголовки, честно отдаёт null.
 */
function paragraphAt(lines, from) {
  const out = []
  for (let i = Math.max(0, from); i < lines.length; i += 1) {
    const line = String(lines[i] ?? '').trim()
    const blank = line === '' || line.startsWith('#')
    if (out.length === 0) {
      if (blank) continue
    } else if (blank) {
      break
    }
    const words = stripMarkdownLine(line)
    if (words !== '') out.push(words)
  }
  const text = out.join(' ').trim()
  if (text === '') return null
  return text.length > DESCRIPTION_CAP ? `${text.slice(0, DESCRIPTION_CAP).trimEnd()}…` : text
}

/** Первый абзац файла, мимо его собственной шапки-фронтматтера. */
function firstParagraph(text) {
  if (text == null) return null
  const lines = String(text).slice(0, DESCRIPTION_HEAD_CHARS).split(/\r?\n/)
  let from = 0
  // Фронтматтер — это учётная запись файла, а не рассказ о фазе.
  if ((lines[0] ?? '').trim() === '---') {
    from = 1
    while (from < lines.length && lines[from].trim() !== '---') from += 1
    from += 1
  }
  return paragraphAt(lines, from)
}

/**
 * phaseDescription(...) → {text, source} — о чём эта фаза, СЛОВАМИ ЕЁ СОБСТВЕННОГО ДОКУМЕНТА,
 * или null, когда сказать нечем.
 *
 * ИСТОЧНИК И ЗАПАСНОЙ ПУТЬ НАЗВАНЫ ЗДЕСЬ ОДИН РАЗ. Основной — `-CONTEXT.md` самой фазы: это
 * документ, которым кончается её обсуждение, и в нём стоят слова владельца, а не пересказ.
 * Запасной — абзац роадмапа под заголовком этой фазы: фаза, обсуждение которой ещё не дошло до
 * контекста, всё равно чем-то названа. Ни один из двух не выдумывается: нет обоих — `null`, и
 * экран говорит «описания нет» словами вместо пустого места, которое читается как поломка.
 *
 * `source` едет вместе с текстом, потому что «это из контекста фазы» и «это из роадмапа» —
 * разные по весу утверждения, и человек имеет право видеть, какое из них перед ним.
 */
function phaseDescription(io, root, dir, files, titles) {
  const contextName = files.find((f) => f.endsWith(STAGE_ARTIFACTS.discuss.produces))
  if (contextName) {
    const text = firstParagraph(readTextOrNull(io, join(root, dir, contextName)))
    if (text) return { text, source: 'context' }
  }
  const dirNumber = phaseNumberOf(dir)
  const entry = dirNumber === null ? null : titles.get(dirNumber)
  return entry && entry.lead ? { text: entry.lead, source: 'roadmap' } : null
}

/**
 * The name a PERSON should see for a phase directory: its NUMBER, then the roadmap's title
 * when the phase number is in the roadmap, and a readable version of the directory's own slug
 * when it is not.
 *
 * THE NUMBER LEADS, and it is not decoration. A phase is referred to by number in every other
 * surface of this product — the commands take one, the plans are named by one, and a person
 * saying «двенадцатая» means the number. Taking the title from the roadmap dropped it, because
 * a roadmap heading names the phase and the heading's own number is stripped as part of
 * parsing it; the screen then read as a list of unrelated sentences. Restored here rather than
 * by keeping the slug, so the row says both what it IS and how to ask for it.
 *
 * Never invents: a phase the roadmap does not mention keeps its own words, only spelled with
 * spaces instead of dashes — and still carries its number.
 */
function phaseTitleOf(dir, titles) {
  const dirNumber = phaseNumberOf(dir)
  const entry = dirNumber === null ? null : titles.get(dirNumber)
  // The ROADMAP's number when the roadmap knows this phase — including through the old number
  // its directory still carries. `49.2-sma-v3-trust-spine` is «3 · SMA V3 — The Trust Spine»,
  // because three is what the phase is called now and the directory is only where it lives.
  if (entry) return `${entry.n} · ${entry.title}`
  const words = readableSlug(phaseNameOf(dir))
  return dirNumber === null ? words : `${dirNumber} · ${words}`
}

/**
 * The number a phase is SORTED by: the roadmap's, when it has one, and the directory's when it
 * does not. Newest first is the order a person wants — the phase they are working on is the one
 * they open, and it is the highest number, not the first line of an alphabet.
 *
 * Sorting by directory name put `10-…` before `9-…` and buried phase 12 under six directories
 * numbered 49.x that are, in the roadmap's own numbering, the OLDEST work in the project.
 */
function phaseOrderOf(dir, titles) {
  const dirNumber = phaseNumberOf(dir)
  const entry = dirNumber === null ? null : titles.get(dirNumber)
  if (entry) return entry.n
  return dirNumber === null ? Number.NEGATIVE_INFINITY : dirNumber
}

/**
 * СТОИТ ЛИ В РОАДМАПЕ ГАЛОЧКА «ЭТА ФАЗА ЗАКРЫТА» — по номеру фазы, а не по имени папки.
 *
 * Это ФАКТ, а не вывод: что сказать человеку о фазе, которую роадмап закрыл, а диск не
 * подтверждает, решает окно — там же оно и называет расхождение словами. Здесь только читается
 * галочка, и ступени она не подделывает: диск продолжает говорить своё.
 *
 * Фаза, которой роадмап не знает вовсе, закрытой не объявляется: `false` — это «галочки не
 * стоит», и оно ровно то же самое, что «роадмапа нет». Приписать закрытие молчанию значило бы
 * объявить сделанной работу, о которой никто ничего не сказал.
 */
function roadmapClosedOf(dir, titles) {
  const dirNumber = phaseNumberOf(dir)
  const entry = dirNumber === null ? null : titles.get(dirNumber)
  return !!entry && entry.closed === true
}

/** Where a stage stands, read off the files of the phase directory and nothing else. */
function stageStatusOf(files, spec) {
  if (!spec) return 'none'
  if (files.some((f) => f.endsWith(spec.produces))) return 'done'
  // a parked checkpoint is the honest middle state: the stage ran, and it stopped to ask
  if (spec.checkpoint && files.some((f) => f.endsWith(spec.checkpoint))) return 'in-progress'
  return 'none'
}

/**
 * Каждая ступень фазы → 'none' | 'in-progress' | 'done' | 'skipped'.
 *
 * ЧЕТВЁРТОЕ СЛОВО СУЩЕСТВУЕТ РАДИ ОДНОГО КЛАССА ФАЗ, и он не редкий: ступень рисования
 * появилась ПОЗЖЕ, чем начались работы. У фазы, чьё исполнение уже шло или уже кончилось,
 * чертежа нет и никогда не будет — требовать его задним числом значило бы запереть работу,
 * которая идёт прямо сейчас, и объявить незавершёнными все закрытые фазы дома.
 *
 * «Пропущена» — это НЕ «не начата»: второе значит «ждём чертежа», и ворота исполнения читают
 * эти два слова противоположно. Признак берётся ПОЛОЖИТЕЛЬНЫЙ и по той же карте артефактов,
 * какой меряются все ступени: чертежа нет И исполнение уже оставило след (итог или
 * припаркованный чекпойнт). Фаза, которая ещё ничего не делала, честно остаётся «не начата».
 *
 * Слово принадлежит ТОЛЬКО ступени рисования: остальные четыре не «пропускались» — их либо
 * прошли, либо нет.
 */
export function stagesOf(files) {
  const out = {}
  for (const stage of PHASE_STAGES) out[stage] = stageStatusOf(files, STAGE_ARTIFACTS[stage])
  if (out.design === 'none' && out.execute !== 'none') out.design = 'skipped'
  return out
}

/** The documents of one kind, as {name, path} the artefact door will accept. */
function artifactsOf(files, dir, suffix) {
  return files
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((name) => ({ name, path: `${PHASES_PATH}/${dir}/${name}` }))
}

/** The two documents a plan of a phase is made of — named once, so the pairing below cannot drift. */
const PLAN_SUFFIX = '-PLAN.md'
const SUMMARY_SUFFIX = '-SUMMARY.md'

/**
 * HOW MUCH OF A PLAN FILE IS EVEN LOOKED AT. A header is a dozen short lines at the very top;
 * everything past this bound is the plan's body, which a card has no business reading. The
 * limit is here for the same reason the log summariser has one: a file on disk is written by
 * whatever wrote it, and a header that arrives as forty thousand lines must cost a bounded
 * amount of work rather than the whole poll. (The READ itself is the file, exactly as the
 * acceptance document a few lines below is read whole — bounding that too would be a second,
 * different rule for the same directory.)
 */
const PLAN_HEAD_CHARS = 8192
const PLAN_HEAD_LINES = 80
/** A title is a line on a screen; a plan that opened with an essay is cut, never wrapped. */
const PLAN_TITLE_CAP = 200
/** A status is a word from whoever wrote the file — bounded, because it is not our vocabulary. */
const PLAN_STATUS_CAP = 40
/** What a plan whose own header could not be read is called. It is NEVER called «done». */
const PLAN_UNREAD_STATUS = 'не прочитан'

/** `"03"` → `03`; `Живой прогон…` → itself. A quoted scalar is the quoted thing, not the quotes. */
function unquoteScalar(value) {
  const text = String(value ?? '').trim()
  const m = /^(['"])([\s\S]*)\1$/.exec(text)
  return (m ? m[2] : text).trim()
}

/**
 * The three things a plan's own header says about it: {wave, status, title}. `null` when the
 * file could not be read at all — which is a DIFFERENT answer from «read, and it says nothing».
 *
 * WHY THIS IS FOUR LINES OF STRING WORK AND NOT A YAML LIBRARY. The keys wanted are three
 * scalars at the top level of a header, and every parser already accepted into this codebase
 * reads exactly that way. A general parser would bring a dependency, a second failure mode and
 * a much larger blast radius for the sake of shapes no plan file uses. A key nested under
 * another is deliberately NOT found: `wave` is a top-level fact about the plan, and a `wave:`
 * sitting inside somebody's prediction block is not it.
 */
function planHeader(io, path) {
  const text = readTextOrNull(io, path)
  if (text == null) return null
  const out = { wave: null, status: null, title: null }
  const lines = text.slice(0, PLAN_HEAD_CHARS).split(/\r?\n/)
  // No opening fence is «this plan states nothing about itself», not a torn file: a plan
  // written before headers existed is still a plan, and it still belongs on the card.
  if ((lines[0] ?? '').trim() !== '---') return out
  for (let i = 1; i < lines.length && i <= PLAN_HEAD_LINES; i += 1) {
    const line = lines[i]
    if (line.trim() === '---') break
    const m = /^(wave|status|title)\s*:\s*(.+)$/.exec(line)
    if (!m) continue
    const value = unquoteScalar(m[2])
    if (value === '') continue
    if (m[1] === 'wave') {
      const n = Number(value)
      if (Number.isFinite(n)) out.wave = n
    } else if (m[1] === 'status') {
      out.status = value.slice(0, PLAN_STATUS_CAP)
    } else {
      out.title = value.slice(0, PLAN_TITLE_CAP)
    }
  }
  return out
}

/**
 * wavesOf(io, root, dir, files) → [{wave, plans:[{name, path, wave, status, title}]}], by wave
 * ascending.
 *
 * WHY THE CARD OPENS THE PLANS. A phase is EXECUTED in waves — several plans at once, then the
 * next several — and that shape exists in exactly one place: the `wave` line each plan writes
 * in its own header. Listing the plan file names (which is all this card did) shows a flat
 * column of thirteen identifiers and answers none of the questions a person has in front of a
 * running phase: what is going on right now, what it is waiting for, what is left.
 *
 * WHERE A STATUS COMES FROM, and why it is two sources rather than one. A plan states its own
 * `status` when somebody wrote one. Most never do — and for those, the phase directory holds
 * the fact anyway: a plan is finished when its SUMMARY exists beside it, which is the same rule
 * the roadmap's own progress count is made of, and the same documents this card already lists
 * under `summaries`. Neither source present → `null`, so a screen says «нет данных» in words
 * instead of showing a plan as done because nothing said otherwise.
 *
 * FAIL-SOFT, in the posture `progressOf` established next door: an unreadable plan file costs
 * that plan its metadata and NOTHING ELSE. It still appears, under the honest status word
 * «не прочитан», in the group of plans that named no wave. A phase card is how a person finds
 * the phase they need — including the phase they need in order to fix that very file.
 */
function wavesOf(io, root, dir, files) {
  const groups = new Map()
  for (const { name, path } of artifactsOf(files, dir, PLAN_SUFFIX)) {
    const head = planHeader(io, join(root, dir, name))
    const summaryDone = files.includes(`${name.slice(0, -PLAN_SUFFIX.length)}${SUMMARY_SUFFIX}`)
    const plan =
      head === null
        ? { name, path, wave: null, status: PLAN_UNREAD_STATUS, title: null }
        : {
            name,
            path,
            wave: head.wave,
            status: head.status ?? (summaryDone ? 'done' : null),
            title: head.title,
          }
    const key = plan.wave
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(plan)
  }
  // Wave one first, and the plans that named no wave at the END: they are the ones nobody has
  // placed in the order of work yet, and putting them in front would read as «this is first».
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([wave, plans]) => ({ wave, plans }))
}

/** The questions engine over a project's phases, reading BOTH parking files as one queue. */
function questionsEngine(projectDir, fsImpl) {
  return createQuestions({ projectDir, fsImpl, checkpointSuffix: ALL_CHECKPOINT_SUFFIXES })
}

/**
 * {open, answered} for one phase — and zero of zero for a phase whose checkpoint is torn.
 *
 * A single unreadable file on disk must not take the whole index down with it: the index is
 * how a person finds the phase they need, including the one they need in order to fix that
 * file. The engine names a torn checkpoint by throwing; here that is one row's counters, not
 * the poll.
 */
function progressOf(engine, phaseId) {
  try {
    return engine.progress(phaseId)
  } catch {
    return { open: 0, answered: 0 }
  }
}

/**
 * derivePhaseIndex({projectDir, fsImpl}) → {phases:[{id, name, stages, roadmapClosed, open, answered}]}.
 *
 * Every directory of `.planning/phases`, in name order, with where each stage of it stands,
 * whether the ROADMAP carries a person's tick against it, and how many questions it is holding.
 * Диск и галочка едут РЯДОМ, а не сведёнными в одно слово: сводит их окно, и оно же называет
 * расхождение человеку. `id` is the DIRECTORY NAME — the one spelling that is
 * unambiguous, and one both this module and the daemon's gate resolve through the same
 * `findPhaseDir`, so a phase number reaches the same row.
 *
 * @param {{projectDir?:string, fsImpl?:object}} [deps]
 * @returns {{phases:object[]}}
 */
export function derivePhaseIndex({ projectDir, fsImpl } = {}) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return { phases: [] }
  const io = fsSeam(fsImpl)
  const root = join(projectDir, '.planning', 'phases')
  const engine = questionsEngine(projectDir, fsImpl)
  // Read ONCE for the whole list rather than per row: the roadmap is one file and this is the
  // screen that shows every phase at once. It decides both the names and the order below.
  const titles = roadmapTitles(projectDir, io)
  const dirs = safeList(io, root)
    .filter((name) => isDir(io, join(root, name)))
    // NEWEST FIRST. The phase somebody is working on is the highest-numbered one, and it should
    // be the first row rather than something to scroll past. Ties and unnumbered directories
    // fall back to their name so the order is total and stable.
    .sort((a, b) => phaseOrderOf(b, titles) - phaseOrderOf(a, titles) || String(a).localeCompare(String(b)))

  return {
    phases: dirs.map((dir) => {
      const files = safeList(io, join(root, dir))
      const { open, answered } = progressOf(engine, dir)
      return {
        id: dir,
        name: phaseTitleOf(dir, titles),
        stages: stagesOf(files),
        roadmapClosed: roadmapClosedOf(dir, titles),
        open,
        answered,
      }
    }),
  }
}

/** The status of a row that has stopped and is waiting for a person — the parked round. */
const PARKED_STATUS = 'awaiting_approval'

/**
 * Which stage parked this question, read off the checkpoint file that asked it.
 *
 * There are exactly two files and therefore exactly two stages that can park a question: a
 * discussion round and an execute stage. `plan` and `verify` produce documents and never stop
 * to ask, so a path that is neither is not a stage — it is a file this function does not know,
 * and it says so rather than guessing.
 */
function stageOfCheckpoint(path) {
  const text = String(path ?? '')
  if (text.endsWith(EXEC_CHECKPOINT_SUFFIX)) return 'execute'
  if (text.endsWith(CHECKPOINT_SUFFIX)) return 'discuss'
  return null
}

/**
 * stage → the id of the row parked for it, for ONE phase directory.
 *
 * A row is matched to this phase through `findPhaseDir` — the same one rule for «which
 * directory is phase N» that resolved the card itself. That matters because the row records
 * the phase AS IT WAS TYPED at the door («12») while the card is a directory name
 * («phase-12-front-workplace»), and comparing those two strings would find nothing.
 *
 * Keyed by STAGE and not by phase, because one phase can hold two parked rows at once: the
 * queue's 409 forbids two rows for the same stage of the same phase, and nothing more. A
 * discussion and an execute stage of one phase can both be waiting, their questions arrive on
 * one card, and answering the last question of one must wake THAT one.
 */
function parkedStageTasks(rows, dirs, dir) {
  const out = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.status !== PARKED_STATUS) continue
    const data = row.data && typeof row.data === 'object' ? row.data : null
    const stage = data && data.stage
    if (!stage || out.has(stage)) continue
    if (findPhaseDir(dirs, data.phase) !== dir) continue
    out.set(stage, String(row.id))
  }
  return out
}

/**
 * phaseTaskRows(rows, dirs, dir) → строки работы, которые сами назвали ЭТУ фазу — по одной на
 * задачу, последним её словом.
 *
 * ИМЯ ФАЗЫ РАЗРЕШАЕТСЯ ТЕМ ЖЕ ПРАВИЛОМ, что у припаркованных раундов рядом: конверт строки
 * говорит «12», каталог зовётся «12-front», и знает об этом соответствии один findPhaseDir.
 * Сравнение строк напрямую отдало бы фазе пустой список ровно тогда, когда у неё есть работа.
 *
 * СВЁРНУТО ПО ЗАДАЧЕ. Повторённая задача лежит в очереди двумя строками, и сумма по строкам
 * посчитала бы её подходы дважды — задача платит за себя один раз.
 */
function phaseTaskRows(rows, dirs, dir) {
  const named = (Array.isArray(rows) ? rows : []).filter((row) => {
    const data = row && typeof row.data === 'object' && row.data !== null ? row.data : null
    if (!data || (typeof data.phase !== 'string' && typeof data.phase !== 'number')) return false
    return findPhaseDir(dirs, data.phase) === dir
  })
  return latestRowPerId(named)
}

/**
 * СКОЛЬКО ПОДХОДОВ ЗАПИСАНО НА СТРОКЕ — одно правило на фазу и на батч.
 *
 * Ноль здесь значит «ни одного», а не «неизвестно»: строка, которую ещё никто не брал, честно
 * не потратила ни хода, и это ИЗМЕРЕННЫЙ ноль. Второе написание этого разбора у батча однажды
 * посчитало бы те же ходы иначе — сборка и фаза меряют одни и те же строки очереди.
 */
function attemptsOf(row) {
  const n = Number(row && row.attempt)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0
}

/**
 * phaseWork(rows) → {tasks, done, attempts, startedAt} — чем фаза меряется, кроме расхода.
 *
 * ПО ТЕМ ЖЕ САМЫМ СТРОКАМ, по которым складываются токены рядом: окошко показателей не может
 * назвать одну фазу двумя разными объёмами работы, потому что список задач у обоих чисел один.
 *
 * `startedAt` — САМЫЙ РАННИЙ МОМЕНТ, КОГДА ЗАДАЧУ ФАЗЫ ВЗЯЛИ В РАБОТУ, а не когда её поставили
 * в очередь: «фаза идёт с 06:12» — про работу, а не про намерение. `null` — ни одну задачу ещё
 * не брали, и экран говорит это прочерком, а не сегодняшней полночью.
 */
function phaseWork(rows) {
  const list = Array.isArray(rows) ? rows : []
  let done = 0
  let attempts = 0
  let startedAt = null
  for (const row of list) {
    if (row && row.status === 'completed') done += 1
    attempts += attemptsOf(row)
    const at = toMs(row && row.claimedAt)
    if (Number.isFinite(at) && (startedAt === null || at < startedAt)) startedAt = at
  }
  return { tasks: list.length, done, attempts, startedAt }
}

/**
 * derivePhaseCard({projectDir, phaseId, fsImpl, parkedRows, taskRows}) → one phase in full, or
 * null when the project has no such directory.
 *
 * {id, name, stages, questions, plans, waves, summaries, uat}. The plans and summaries travel as
 * NAMES and door-relative paths — never their contents: a card is a table of contents, and the
 * document itself is one click through the artefact door, which is the one place the reading
 * of a file is bounded.
 *
 * WHY A QUESTION CARRIES A TASK ID. The decision door records an answer always, and wakes the
 * parked round only when the answer was the LAST one AND the caller named the row to wake. The
 * screen can only name it if something told it which row that is — and this is that something.
 * Without it the door recorded every answer and woke nothing, so a discussion started from the
 * window could never get past its first question: the answer was on disk and the round was
 * still asleep.
 *
 * `parkedRows` is the queue's rows, passed IN rather than read here: this module stays a pure
 * function of the filesystem, and the door that has the adapter is the one that hands them
 * over. A card built without them is still a card — every question simply carries no id, which
 * is exactly the state the door treats as «record it, wake nothing».
 *
 * `taskRows` is the queue's rows again — passed IN for the same reason `parkedRows` is, and used
 * for a different question: во что фаза обошлась. A card built without them simply carries no
 * sum, which is the honest reading of «спросить было не у кого».
 *
 * @param {{projectDir?:string, phaseId?:string|number, fsImpl?:object, parkedRows?:object[],
 *          taskRows?:object[]}} [deps]
 * @returns {object|null}
 */
export function derivePhaseCard({ projectDir, phaseId, fsImpl, parkedRows, taskRows } = {}) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null
  const wanted = String(phaseId ?? '').trim()
  if (wanted === '') return null

  const io = fsSeam(fsImpl)
  const root = join(projectDir, '.planning', 'phases')
  const dirs = safeList(io, root).filter((name) => isDir(io, join(root, name)))
  const dir = findPhaseDir(dirs, wanted)
  if (!dir) return null

  const files = safeList(io, join(root, dir))
  const engine = questionsEngine(projectDir, fsImpl)

  const parked = parkedStageTasks(parkedRows, dirs, dir)

  let questions = []
  try {
    questions = engine.allQuestions(dir).map((q) => {
      // The question knows which FILE asked it; the file names the stage; the stage names the
      // row. No step of that chain is a guess, which is why a phase holding two parked stages
      // still sends every answer to its own round.
      const stage = stageOfCheckpoint(q.path)
      const taskId = stage === null ? undefined : parked.get(stage)
      return {
        id: q.id,
        area: q.area,
        question: q.text,
        options: q.options,
        answer: q.answer,
        // ABSENT, never empty: the door reads «no id» as «record the answer and wake nothing»,
        // and an empty string would be a value that fails its grammar instead.
        ...(taskId ? { taskId } : {}),
      }
    })
  } catch {
    // a torn checkpoint costs the card its question list, never the card
    questions = []
  }

  const acceptance = readAcceptance(io, root, dir, files)
  // Роадмап читается ОДИН раз на карточку: из него берутся и имя фазы, и запасной абзац
  // описания. Два чтения одного файла ради двух его строк — это два ответа на один вопрос.
  const titles = roadmapTitles(projectDir, io)
  // Задачи фазы узнаются один раз: по ним считаются и расход, и её собственные счётчики.
  const rows = phaseTaskRows(taskRows, dirs, dir)

  return {
    id: dir,
    name: phaseTitleOf(dir, titles),
    // О ЧЁМ ЭТА ФАЗА — абзац её контекста, а если контекста ещё нет, абзац роадмапа. `null`
    // означает ровно «сказать нечем», и экран говорит это словами.
    description: phaseDescription(io, root, dir, files, titles),
    stages: stagesOf(files),
    questions,
    plans: artifactsOf(files, dir, PLAN_SUFFIX),
    summaries: artifactsOf(files, dir, SUMMARY_SUFFIX),
    // The same plans, in the shape the phase is actually WORKED in — see wavesOf. `plans` stays
    // exactly as it was: the artefact list is what the document links are built from, and a
    // screen that wanted the flat column must not have to walk a tree to rebuild it.
    waves: wavesOf(io, root, dir, files),
    uat: acceptance.items,
    // ВО ЧТО ОБОШЛАСЬ ФАЗА — сумма четырёх чисел поставщика по ЕЁ задачам, а по каждой задаче
    // по всем её подходам. Фаза — это то, чем человек меряет кусок ночи; расход, посчитанный
    // только по одной попытке, отвечает не на тот вопрос.
    //
    // ЗАДАЧИ ФАЗЫ УЗНАЮТСЯ ТЕМ ЖЕ ПРАВИЛОМ, каким узнаются её припаркованные раунды: конверт
    // строки называет фазу, а какой каталог за этим именем — знает findPhaseDir, и второго
    // ответа на это здесь не заводится.
    //
    // `null` — «мерить негде»: строк не передали, задач у фазы нет, каталога прогонов не
    // существует. Ноль на этом месте назвал бы бесплатной работу, которую никто не измерял.
    tokens: totalTokens(rows.map(taskTokensReader({ runsDir: runsDirOf(projectDir), fsImpl }))),
    // ЧЕМ ЕЩЁ МЕРЯЕТСЯ ФАЗА, кроме расхода: сколько у неё задач, сколько из них закрыто, сколько
    // подходов на них потрачено и когда за неё взялись впервые. Всё — по тем же самым строкам,
    // по которым сложены токены, поэтому окошко показателей не может назвать одну и ту же фазу
    // двумя разными объёмами работы.
    //
    // `null` — «спросить было не у кого»: строк не передали вовсе. Пустой список строк — это
    // ИЗМЕРЕННЫЙ ноль (у фазы нет задач), и он отличается от неизвестности честно.
    work: Array.isArray(taskRows) ? phaseWork(rows) : null,
    // WHICH FILE IS THE ACCEPTANCE DOCUMENT is answered HERE and nowhere else. The door that
    // writes a verdict into it needs the same answer, and it takes it off this card rather
    // than looking the directory up a second time: two spellings of one rule is how a screen
    // ends up reading one file while a write lands in another.
    ...(acceptance.document ? { uatDocument: acceptance.document } : {}),
    // ЧЕРТЁЖ, КОТОРЫЙ ЖДЁТ СЛОВА ЧЕЛОВЕКА — номером строки, и только когда она правда стоит.
    //
    // Это НЕ новое чтение: `parked` выше уже сложил карту «ступень → строка, ждущая решения»
    // ради вопросов, и номер строки чертежа лежал в ней невостребованным. Ворота дизайна на
    // стекле открываются ТОЙ ЖЕ дверью приёмки, что и всякая работа, а дверь эта generic по
    // номеру задачи — без номера кнопка на карточке была бы нарисованной: посчитано, но никому
    // не предъявлено. Поле ОТСУТСТВУЕТ, когда ждущей строки нет: `null` на этом месте пришлось
    // бы отличать от «демон постарше и полей таких не знает», а отсутствие говорит и то, и то.
    ...(parked.get(DESIGN_STAGE) ? { designTask: { id: parked.get(DESIGN_STAGE) } } : {}),
  }
}

/**
 * The acceptance document of a phase and the lines inside it, or an empty answer.
 *
 * Read in the format `/sma-verify-work` writes and the `audit-uat` verb parses — this module
 * neither invents a second format nor migrates the one that exists. No UAT file is an empty
 * list: a phase nobody has accepted yet is a normal state, not a missing one.
 */
function readAcceptance(io, root, dir, files) {
  const file = files.filter((f) => UAT_FILE_RE.test(f)).sort()[0]
  if (!file) return { document: null, items: [] }
  const document = { name: file, path: `${PHASES_PATH}/${dir}/${file}` }
  const text = readTextOrNull(io, join(root, dir, file))
  if (text == null) return { document, items: [] }

  const items = []
  UAT_ITEM_RE.lastIndex = 0
  let m
  while ((m = UAT_ITEM_RE.exec(text)) !== null) {
    const note = typeof m[4] === 'string' ? m[4].trim().replace(/^"|"$/g, '') : ''
    items.push({
      item: m[1],
      name: m[2],
      verdict: uatVerdictOf(m[3]),
      ...(note ? { note } : {}),
    })
  }
  return { document, items }
}

/**
 * WHAT ONE ITEM OF A BATCH READS AS — the five queue statuses said in the words the assembly
 * cares about. The queue's vocabulary answers «where is this row»; a batch asks a different
 * question, «is anybody needed here», and the two are not the same sentence.
 */
const BATCH_ITEM_STATE = Object.freeze({
  completed: 'done',
  failed: 'failed',
  awaiting_approval: 'awaiting_decision',
  claimed: 'running',
  queued: 'waiting',
})

/**
 * THE SIXTH WORD, AND IT IS NOT A STATUS AT ALL: «пропущен» is what the OWNER said about a
 * piece, not where that piece stands in the queue. It overrules the status because it is a
 * later fact about the same piece — the queue still holds a broken row, and the person who
 * owns the assembly has decided it does not hold it any more.
 */
const BATCH_ITEM_SKIPPED = 'skipped'

/**
 * THE THREE ANSWERS A STOPPED ASSEMBLY OFFERS, in one place because they are offered in two —
 * the card a person presses and the door that accepts what he pressed have to be the same
 * three, or a screen would show a button nothing answers.
 *
 * WHY THERE IS NO FOURTH, «повторить автоматически»: by the time this question is asked at all,
 * the automatic repeat has already been spent. The queue repeats a broken piece by itself —
 * with a ceiling, a growing pause and a line in the log for each try (`awaitsAutoRetry`) — and
 * only what those repeats could not fix ever reaches a person. So a fourth button would offer
 * him the very thing that has just been tried and failed. The loop of 12.08.2026 was that same
 * repetition WITHOUT the ceiling, the pause and the words; those three are what make it safe.
 */
export const BATCH_DECISIONS = Object.freeze([
  Object.freeze({ id: 'skip', label: 'Пропустить элемент' }),
  Object.freeze({ id: 'retry', label: 'Повторить' }),
  Object.freeze({ id: 'cancel', label: 'Отменить батч' }),
])

/**
 * THE ORDER OF LOUDNESS — the first of these present among the items is what the batch reads
 * as, and the item wearing it is what HOLDS the assembly.
 *
 * A failure comes before a decision, and both come before anything that is merely under way:
 * the founder's rule for a batch is that a failed piece STOPS it and asks its owner what to do
 * (skip / retry / abandon). Which is also why a failed item does not close: it is terminal for
 * the QUEUE and unfinished for the ASSEMBLY, and a batch reading «готово» with a failed piece in
 * it would be the plainest lie this screen could tell. Only work that actually produced counts
 * as closed.
 *
 * «СОРВАЛАСЬ» ЗДЕСЬ ЗНАЧИТ «СОРВАЛАСЬ ОКОНЧАТЕЛЬНО». Кусок, у которого остались автоповторы,
 * этого слова не носит вовсе (см. состояние элемента выше): за ним стоит очередь, а не человек,
 * и самое громкое слово сборки о нём было бы просьбой решить уже решённое.
 */
const BATCH_STATE_ORDER = Object.freeze(['failed', 'awaiting_decision', 'running', 'waiting', 'done'])

/**
 * taskTokensReader({runsDir, fsImpl}) → (row) → четыре числа поставщика, сложенные по ВСЕМ
 * попыткам этой задачи, или `null`.
 *
 * ПОЧЕМУ НЕ ЧЕРЕЗ ЛЕДЖЕР. Номер последнего подхода лежит на самой строке — очередь его туда и
 * пишет, — а числа лежат в каталогах прогона, названных по задаче и номеру. Спрашивать ради
 * этого книгу попыток значило бы читать второй источник на каждый опрос экрана ради факта,
 * который уже в руках.
 *
 * ПОТОЛОК ПЕРЕБОРА — ЁМКОСТЬ САМОГО КАТАЛОГА, и он не «тихое урезание»: каталог прогонов хранит
 * ровно столько попыток, а запрошенные сверх того гарантированно отсутствуют и добавили бы к
 * сумме нули. Это защита от испорченной строки, которая назвалась миллионным подходом, а не
 * граница измерения.
 *
 * @param {{runsDir?:string|null, fsImpl?:object}} [args]
 * @returns {(row:object)=>({input:number,output:number,cacheRead:number,cacheWrite:number}|null)}
 */
function taskTokensReader({ runsDir, fsImpl } = {}) {
  return (row) => {
    const id = row && typeof row.id === 'string' ? row.id : ''
    if (id === '') return null
    const n = Number(row.attempt)
    const last = Math.min(Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1, RUN_DIRS_KEEP)
    const attemptIds = []
    for (let i = 1; i <= last; i += 1) attemptIds.push(attemptIdFor(id, i))
    return sumRunTokens({ runsDir, attemptIds, fsImpl })
  }
}

/**
 * totalTokens(parts) → сумма четырёх чисел по нескольким задачам, или `null`, когда ни одна из
 * них ничего не сказала.
 *
 * ДВА ВИДА «НУЛЯ» РАЗЛИЧАЮТСЯ ЗДЕСЬ ТОЖЕ. Задача, чьи квитанции молчат, приходит сюда как `null`
 * и в сумму не входит; но сборка, где НИ ОДНА задача не измерялась (каталога прогонов нет —
 * чужая машина, проект не подключён), честно отдаёт отсутствие, а не бодрый ноль.
 */
function totalTokens(parts) {
  const known = (Array.isArray(parts) ? parts : []).filter(Boolean)
  if (known.length === 0) return null
  const out = zeroTokens()
  for (const part of known) for (const field of TOKEN_FIELDS) out[field] += Number(part[field]) || 0
  return out
}

/**
 * deriveBatches(requests, rows, ctx) → the batches, each with its items, its own reading and
 * the item that is holding it.
 *
 * COMPUTED AT EVERY READ, NEVER STORED. «What holds this assembly» is a function of the items'
 * statuses and of nothing else; written down anywhere it would be a second truth about the
 * same five statuses, and the two would disagree the first time either moved — silently,
 * because nothing compares them. Same for «готово»: a batch is closed when its items are, and
 * a stored closed-flag is a promise the items can contradict.
 *
 * PURE over its arguments. An orphan item (a batch id with no request row) is deliberately NOT
 * invented into a batch of its own: the door writes the request last precisely so a half-written
 * batch reads as loose work, which a person can see and run.
 *
 * @param {object[]} requests the batch request rows
 * @param {object[]} rows     every WORK row (the requests are not among them)
 * @param {{machineId?:string, taskTokens?:(row:object)=>object|null, now?:number}} ctx
 * @returns {object[]}
 */
function deriveBatches(requests, rows, { machineId, taskTokens, now = Date.now() } = {}) {
  if (!Array.isArray(requests) || requests.length === 0) return []

  return [...requests]
    .sort((a, b) => (toMs(a.enqueuedAt) || 0) - (toMs(b.enqueuedAt) || 0))
    .map((req) => {
      // The request's own id IS the batch id (the door mints one identifier, not two); the
      // field is read first all the same, so a row written by anything else still groups.
      const batchId = req.batchId || req.id
      // WHAT THE OWNER HAS ALREADY SAID about this assembly — the one fact here that is not
      // recomputed from statuses, because nothing else can produce it.
      const { skipped, cancelled } = batchDecisionsOf(req)
      // The grouping, the de-duplication of a repeated piece and the order are the QUEUE's own
      // (adapter.mjs): the screen draws the pieces in the very order the next one is handed out
      // in, and two answers to «which piece is next» would be two batches on one request.
      const itemRows = batchItemsOf(rows, batchId)
      const items = itemRows.map((r) => ({
        id: r.id,
        title: r.title ?? null,
        status: r.status,
        // СОРВАВШИЙСЯ КУСОК, У КОТОРОГО ОСТАЛИСЬ АВТОПОВТОРЫ, ЖДЁТ МАШИНУ, А НЕ ЧЕЛОВЕКА — и
        // читается он поэтому как ждущий своей выдачи, а не как «сорвался». Слово тут не
        // косметика: «сорвалась» — самое громкое состояние сборки (см. BATCH_STATE_ORDER), и
        // сборка, которой очередь через минуту сама вернёт кусок, называлась бы сорванной, стояла
        // бы красной в «ЖДУТ ВАС» и звала бы человека выбирать за уже принятое решение. Правило
        // спрашивается у очереди — тем же вызовом, каким она решает, кого держать.
        state: skipped.includes(r.id)
          ? BATCH_ITEM_SKIPPED
          : awaitsAutoRetry(r)
            ? 'waiting'
            : (BATCH_ITEM_STATE[r.status] ?? 'waiting'),
      }))

      const loudest = BATCH_STATE_ORDER.find((s) => items.some((i) => i.state === s))
      // CLOSED BY ITS ASSEMBLY, and only when every piece produced OR was let go by the owner.
      // A skipped piece does not hold the assembly — that is what skipping it MEANT — and it
      // is still shown, by name, saying «пропущен»: a decision that left no trace is a decision
      // nobody can be held to.
      const closed =
        items.length > 0 && items.every((i) => i.state === 'done' || i.state === BATCH_ITEM_SKIPPED)
      // AN ABANDONED ASSEMBLY READS AS ABANDONED, above every other word: its pieces were taken
      // out of the queue and what they say about themselves no longer describes the batch.
      const state = cancelled ? 'cancelled' : closed ? 'done' : (loudest ?? 'waiting')
      // КАКОЙ КУСОК ОСТАНОВИЛ СБОРКУ — правилом ОЧЕРЕДИ, а не вторым его написанием здесь.
      // Тем же вызовом очередь придерживает остальные куски, а тик зовёт человека: вопрос на
      // карточке и зов в телеграм обязаны говорить об ОДНОМ И ТОМ ЖЕ элементе.
      const brokenRow = cancelled ? null : brokenItemOf(itemRows, skipped)
      const broken = brokenRow ? (items.find((i) => i.id === brokenRow.id) ?? null) : null
      // СКОЛЬКО СБОРКА УЖЕ СТОИТ — от момента, когда кусок сорвался и сборка стала должна
      // владельцу решение. Отметку ставит сама очередь на закрытии строки; там, где её нет
      // (строка старше отметки), оба поля ЧЕСТНО ОТСУТСТВУЮТ. Ноль на этом месте прочитался бы
      // как «встала только что» — то самое утверждение, из-за которого простой в 15 часов
      // выглядел как работа, идущая прямо сейчас.
      const stalledSince = brokenRow ? toMs(brokenRow.completedAt) : null
      const stalledKnown = Number.isFinite(stalledSince)
      return {
        id: req.id,
        title: req.title ?? null,
        project: projectOf(req),
        machine: machineId,
        state,
        items,
        // КОГДА ВЛАДЕЛЕЦ ЭТО ПОПРОСИЛ — момент, записанный дверью батча на строку запроса.
        // Читается со строки, а не считается: «когда нажали» не выводится ни из одного статуса,
        // и отметка самой очереди говорит о другом — когда строку записали (запрос пишется
        // последним, и на длинной сборке это уже другая секунда). Строка, записанная до этого
        // поля, честно молчит: `null`, а не подставленный `enqueuedAt`, который выглядел бы
        // ровно так же и врал бы на величину, которую никто не заметит.
        requestedAt: Number.isFinite(Number(req.data && req.data.requestedAt))
          ? Number(req.data.requestedAt)
          : null,
        // ВО ЧТО ОБОШЛАСЬ ВСЯ СБОРКА — сумма четырёх чисел по её кускам, а по каждому куску —
        // по всем его подходам. Кусок, чьи квитанции молчат, даёт ноль и суммы не роняет;
        // `null` — «мерить негде», то есть каталога прогонов нет вовсе.
        tokens: typeof taskTokens === 'function' ? totalTokens(itemRows.map((r) => taskTokens(r))) : null,
        // СКОЛЬКО ХОДОВ СТОИЛА СБОРКА — подходы её кусков, сложенные тем же правилом, каким их
        // считает фаза рядом. Это ИЗМЕРЕННОЕ число, а не оценка: строки сборки известны поимённо,
        // и подход, записанный на строке, — единственное, что о ходах вообще известно.
        attempts: itemRows.reduce((n, r) => n + attemptsOf(r), 0),
        // WHAT IS HOLDING THE ASSEMBLY, named rather than left for a reader to work out: the
        // loudest item, and its state IS the reason (waiting for a person / under way / not
        // started). Null when there is nothing to wait for.
        holding: cancelled || closed ? null : (items.find((i) => i.state === state) ?? null),
        // THE QUESTION THE ASSEMBLY OWES ITS OWNER. Present exactly while a piece is broken and
        // he has not answered: the batch stops, hands out nothing, and asks — skip, repeat, or
        // abandon. It carries the piece by NAME and the three answers by name, so the card is
        // built from the daemon's own words and a button can never offer an answer no door
        // accepts. Absent when there is nothing to ask, rather than present and empty.
        ...(broken
          ? {
              question: {
                itemId: broken.id,
                itemTitle: broken.title,
                text: `«${broken.title ?? broken.id}» не получилось. Что делаем?`,
                options: BATCH_DECISIONS.map((o) => ({ ...o })),
              },
              // С КАКОГО МОМЕНТА СБОРКА СТОИТ — рядом с вопросом, который этот простой и
              // породил. ОТМЕТКА, А НЕ ДЛИТЕЛЬНОСТЬ, ровно как у останова эшелона (`heldSince`):
              // «сколько уже» рисующий считает от неё своими часами, и число на экране растёт
              // между опросами, вместо того чтобы прыгать раз в опрос. Второе поле с той же
              // длительностью было бы вторым местом, где это число однажды разойдётся с первым.
              ...(stalledKnown ? { stalledSince } : {}),
            }
          : {}),
      }
    })
}

/**
 * deriveWaves(rows, holds, ctx) → the ECHELONS, each with the work it actually consists of and
 * whether its owner has stopped it.
 *
 * WHY THIS EXISTS AT ALL, and it is the whole reason: «Останови волну 2» has to be answered with
 * WHO exactly will finish their step and stand and WHO is already standing. Without this list
 * the window could only say the sentence from the mockup with the numbers typed into it — the
 * one thing the founder's own acceptance criterion forbids. The rows are the answer, and the
 * screen composes his sentence out of them.
 *
 * COMPUTED AT EVERY READ, like every other reading here. Only the STOP is remembered (it is a
 * word somebody said and nothing derives it); who is running and who is waiting is a function of
 * the queue's own statuses.
 *
 * AN ECHELON IS LISTED WHEN THE QUEUE KNOWS OF IT **OR** WHEN IT IS STOPPED. The second half is
 * not symmetry for its own sake: an order given about an echelon whose tasks have not been put
 * in yet must stay visible, or the screen would show a stop that quietly is not there — and the
 * next tick would still be honouring it.
 *
 * ЧЕЙ ЭШЕЛОН — СЧИТАЕТСЯ ИЗ ЕГО СОБСТВЕННЫХ СТРОК, А НЕ ИЗ ТОГО, КУДА СМОТРЯТ. Раньше здесь
 * стояла подстановка «выбранный проект, а если его нет — „default“»: у эшелона появлялся
 * владелец, которого никто не записывал, и он менялся вместе со взглядом человека. Это та же
 * ошибка, что была на строках, только этажом выше — принадлежность домысливалась. Теперь эшелон
 * принадлежит проекту тогда и только тогда, когда его собственная незакрытая работа называет
 * ОДИН и тот же проект; эшелон из строк без проекта, из строк разных проектов и эшелон, о
 * котором известен только приказ об остановке, честно отдаются с `project: null`.
 *
 * @param {object[]} rows every queue row
 * @param {{phase:string, wave:string, since:number|null}[]} holds
 * @param {{machineId?:string}} ctx — только машина: проект эшелона считается из его строк
 * @returns {object[]}
 */
function deriveWaves(rows, holds, { machineId } = {}) {
  const all = Array.isArray(rows) ? rows : []
  const stops = Array.isArray(holds) ? holds : []
  const byKey = new Map()
  const keyOf = (phase, wave) => JSON.stringify([phase, wave])
  const slot = (phase, wave) => {
    const key = keyOf(phase, wave)
    if (!byKey.has(key)) {
      // `projects` — множество проектов, НАЗВАННЫХ собственными строками эшелона. Пусто —
      // никто не назвал; больше одного — эшелон общий, и назвать один было бы выдумкой.
      byKey.set(key, { phase, wave, held: false, heldSince: null, running: [], waiting: [], projects: new Set() })
    }
    return byKey.get(key)
  }

  for (const stop of stops) {
    const row = slot(String(stop.phase), String(stop.wave))
    row.held = true
    row.heldSince = Number.isFinite(stop.since) ? stop.since : null
  }
  for (const r of all) {
    const address = waveAddressOf(r)
    if (!address) continue
    // Только незакрытая работа: доведённое и провалившееся об эшелоне больше ничего не решает,
    // и в вопросе «кого остановит приказ» им не место.
    if (r.status !== 'queued' && r.status !== 'claimed') continue
    const row = slot(address.phase, address.wave)
    const named = { id: r.id, title: r.title ?? null }
    const own = projectOf(r)
    if (own !== null) row.projects.add(own)
    if (r.status === 'claimed') row.running.push(named)
    else row.waiting.push(named)
  }

  return [...byKey.values()]
    .map(({ projects, ...w }) => ({
      ...w,
      project: projects.size === 1 ? [...projects][0] : null,
      machine: machineId,
    }))
    .sort((a, b) => {
      const byPhase = String(a.phase).localeCompare(String(b.phase), undefined, { numeric: true })
      return byPhase !== 0 ? byPhase : String(a.wave).localeCompare(String(b.wave), undefined, { numeric: true })
    })
}

/**
 * deriveState(deps) → the one-poll roster payload {kpis, queue, awaiting, workers, done,
 * spend}. (Task 4 augments it with costs.series over GET /api/state.) Pure over its
 * injected collaborators; re-derives fresh every call.
 *
 * `awaiting` exists because the day screen rides ROWS: it has to name the tasks that are
 * holding for a person's word, and a counter gives it nothing to show. It is derived from
 * the same rows the counter is, so the two can never fall out of step.
 *
 * `batches` is the third kind of unit of work: one request of the owner and the pieces it was
 * broken into, with the piece that is holding the assembly NAMED. Every part of it is computed
 * from the queue's own rows at this call — see deriveBatches.
 *
 * @param {{
 *   adapter: {list:Function},
 *   ledgerDir?: string,
 *   windows?: (account:any)=>object,      // windowState per account (an injected seam)
 *   terminalWindows?: ()=>object,         // the terminal's own window reading (an injected seam)
 *   config?: object,                      // workers[], agingHours, budget
 *   usageReader?: (args:object)=>{costUsd?:number},
 *   readReceipt?: Function,               // resolve a receiptRef string → receipt object
 *   execGit?: (args:string[], opts?:object)=>string,
 *   clock?: ()=>number,
 *   project?: string,                     // optional filter — narrows tasks, never the lists
 *   hubReachable?: boolean,               // hub-probe seam; absent = true
 *   aggregator?: (payload:object)=>object, // hub-only federation merge; absent = local only
 *   inFlight?: {size:()=>number},         // ДОМ ИДУЩИХ ПОПЫТОК — сколько мест занято прямо сейчас
 *   configOnDisk?: ()=>object|null,       // ФАЙЛ НАСТРОЕК С ДИСКА — против копии, по которой демон живёт
 * }} deps
 * @returns {Promise<object>}
 */
export async function deriveState(deps = {}) {
  const { adapter, windows, config = {}, usageReader, readReceipt, execGit } = deps
  const readTaskAttempts = attemptsReader(deps)
  // «Сделано / не получилось» ЗА ПЕРИОД — an injected read model over the attempt ledger
  // (front/worker-stats.mjs), wired at the composition root like every other collaborator, so
  // this file grows no static edge onto it and a daemon that wires none simply carries nothing.
  // The alternative it replaces was the screen counting the done[] slice of this very payload:
  // a figure that moved with the length of a list rather than with the work.
  const workerStats = deps.workerStats && typeof deps.workerStats.statsFor === 'function' ? deps.workerStats : null
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now
  const now = clock()
  const workersCfg = Array.isArray(config.workers) ? config.workers : []
  const agingMs = (config.agingHours ?? 24) * HOUR_MS

  let allRows = []
  try {
    allRows = (await adapter.list({})) || []
  } catch {
    allRows = []
  }

  // ── THE REQUESTS OF BATCHES ARE SEPARATED FIRST, and everything below this line sees only
  // WORK. A batch request is a record of what was asked: no worker will ever take it, so
  // counted among the queued rows it would add a unit to «в очереди» that never comes off,
  // and shown in the queue list it would be a card nobody can act on. It is read for one
  // purpose — to be the batch — and it is read here, once. ──
  const batchRequestRows = allRows.filter(isBatchParent)
  allRows = allRows.filter((r) => !isBatchParent(r))

  // ── projects / machines / federation — derived from the config, never stored ──
  const projectRegistry = Array.isArray(config.projects) ? config.projects : []
  const activeProject = config.activeProject ?? (projectRegistry[0] && projectRegistry[0].id) ?? null
  const projects = deriveProjects(allRows, config, { execGit })
  const machines = deriveMachines(config)
  const machineId = machines[0].id
  const federation = {
    role: (config.federation && config.federation.role) || 'standalone',
    hubReachable: typeof deps.hubReachable === 'boolean' ? deps.hubReachable : true,
  }

  // The project filter narrows the TASKS only (the lists above are already built), and it
  // keeps the rows of UNKNOWN ownership — see inProject: work no filter shows is work nobody
  // can act on, and it is carried with its own truth rather than repainted as ours.
  const rows = deps.project ? allRows.filter((r) => inProject(r, deps.project)) : allRows

  // THE TREE THE WORK HAPPENED IN, resolved through the SAME expression the workbench and the
  // phase cycle already use: the connected project, and the served tree only when nothing is
  // connected. It is named HERE, above the first reader, because two of them now ask for it —
  // the commit log of a finished row below, and the run directories the batches are costed
  // from. A second spelling of it would cost one of the two its answer, silently.
  const gitDir =
    (connectedProject(config) || {}).dir ||
    (typeof deps.repoDir === 'string' && deps.repoDir.trim() !== '' ? deps.repoDir : null)
  // ЧЕМ СЧИТАЕТСЯ РАСХОД ЗАДАЧИ — один читатель на весь опрос: каталог прогонов подключённого
  // проекта плюс номер последнего подхода со строки. Проект не подключён — читателя нет, и
  // каждая сумма честно отсутствует вместо того, чтобы быть нулём.
  const taskTokens = taskTokensReader({ runsDir: runsDirOf(gitDir), fsImpl: deps.fsImpl })

  // The batches ride the SAME project filter as the tasks — a batch is work of one project.
  const batches = deriveBatches(
    deps.project ? batchRequestRows.filter((r) => inProject(r, deps.project)) : batchRequestRows,
    rows,
    { machineId, taskTokens, now },
  )

  // ── ЭШЕЛОНЫ: что за волны в работе и какие из них владелец остановил ──
  //
  // The stop is READ FROM THE REGISTER the loop obeys — the same file, not a second copy — so
  // the screen cannot show «идёт» over work the dispatcher is already withholding. Fail-open:
  // an unreadable register means «nothing is stopped», the reading that keeps the screen honest
  // about the queue rather than inventing a stop nobody ordered.
  let waveHolds = []
  try {
    if (config && config.dataDir) waveHolds = readWaveHolds({ dataDir: config.dataDir, fsImpl: deps.fsImpl })
  } catch {
    /* a register that will not read costs the payload its stops, never the payload */
  }
  const waves = deriveWaves(
    deps.project ? rows.filter((r) => inProject(r, deps.project)) : rows,
    waveHolds,
    { machineId },
  )

  // ── ONE TASK, ONE LINE — IN EVERY SECTION OF THE LIST ──
  //
  // A returned task is enqueued again under its OWN id, and a durable queue keeps the row it
  // stopped on beside the new one. Filtering by status alone therefore counted a single piece
  // of work as two for the whole span of the return: «ЖДУТ ВАС: 2» over one task, one of the
  // two lines nameless. So the rows are folded to the LAST WORD about each task first — the
  // QUEUE'S OWN rule, imported rather than restated, because a second definition of «which row
  // wins» is a second answer waiting to disagree. While the task is being redone its last word
  // is «в работе» and it owes nobody a decision; once it stands for approval again it is one
  // line. The counters below read the lengths of these very lists, so they are fixed by the
  // same move.
  //
  // THE FOLD USED TO STOP AT THE WAITING LIST, with the reason that the defect had been
  // measured only in the waiting count and that widening the edit would change screens nobody
  // asked about. A live press measured the same defect one screen up and retired that reason:
  // a task sent back three times drew FOUR lines on the top-level list — three closed
  // approaches plus the live one — while its own card honestly showed one task on its fourth
  // approach. The length of that list is how a person measures the size of his night, so it has
  // to count TASKS. Every section now reads the same folded rows, and a task stands in the
  // section of its LAST word: queued while it waits for a worker, «в работе» while one holds it,
  // «сделано» only once nothing newer exists.
  const foldedRows = latestRowPerId(rows)
  const queuedRows = foldedRows.filter((r) => r.status === 'queued')
  const claimedRows = foldedRows.filter((r) => r.status === 'claimed')
  const awaitingRows = foldedRows.filter((r) => r.status === 'awaiting_approval')
  // ═══ РАБОТА, КОТОРУЮ ПРЯМО СЕЙЧАС САЖАЮТ, ОСТАЁТСЯ НА ЭКРАНЕ ══════════════════════
  //
  // `approving` — это НЕ мгновение между двумя состояниями. За кнопкой приёмки стоит посадка:
  // свод с вершиной, полный прогон набора, когда квитанция работника это дерево уже не
  // описывает, и штамп чисел. Это минуты, и всё это время строка не попадала НИ В ОДИН
  // список: ни в очередь (там ждут работника), ни в «ждут вас», ни в «сделано». Человек
  // нажимал — и работа исчезала с экрана до конца прогона, то есть ровно тогда, когда ему
  // важнее всего видеть, что она идёт.
  //
  // СЧЁТЧИК «ЖДУТ ВАС» ЕЁ НЕ СЧИТАЕТ, И ЭТО НАМЕРЕННО: он мерит работу, которая ДОЛЖНА
  // человеку слово, а эта своё слово уже получила и его исполняет. Список и счётчик здесь
  // отвечают на разные вопросы, поэтому и читают разные наборы строк.
  const landingRows = foldedRows.filter((r) => r.status === 'approving')
  const doneRows = foldedRows.filter((r) => r.status === 'completed' || r.status === 'failed')

  // ── ONE task row, named field by field. An adapter row may carry anything at all; a
  // payload carries only what a screen was promised, so the pick is explicit and both
  // task lists below ride exactly the same one. ──
  const toTaskRow = (r, i) => {
    const enq = toMs(r.enqueuedAt)
    const ageMs = Number.isFinite(enq) ? now - enq : 0
    const out = {
      id: r.id,
      title: r.title ?? null,
      lane: r.lane ?? null,
      project: projectOf(r),
      machine: machineId,
      ...(r.provider ? { provider: r.provider } : {}),
      priority: Number(r.priority) || 0,
      status: r.status,
      position: i + 1,
      // WHEN THE WORK WAS TAKEN, and — a different fact — when its lease was last renewed. The
      // queue keeps the two apart now (a renewal used to move both, so every running task
      // reported a duration of about zero), and a screen that measures «идёт столько-то» has to
      // read the first. Carried as NULL rather than as a zero wherever the queue does not know:
      // a row waiting for a worker has nothing to measure, and a zero there renders as «just
      // started», which is a statement about work that is not happening.
      claimedAt: r.claimedAt ?? null,
      leaseRenewedAt: r.leaseRenewedAt ?? null,
    }
    // ── HOW LONG IT HAS BEEN WAITING, and the two lists are aged by DIFFERENT clocks ──
    //
    // A row waiting for a WORKER is aged from `enqueuedAt` past the configured patience: that
    // reading is a «застряла» signal, and below the threshold there is nothing to report.
    //
    // A row waiting for a PERSON is aged from `completedAt` — the mark put down at the moment
    // the work stopped and started owing somebody a word (both backends write it: the memory
    // queue in complete(), the durable one out of completed_on). It is NOT the claim time and
    // NOT the lease renewal: those say when a worker took the task and when it last said it
    // lived, which are facts about the work, not about the wait. Three screens — the «ждут вас»
    // strip, the list line, the card and the console pill — already read `agedForHours` off this
    // row and printed «сколько ждёт — нет данных» because nothing ever computed it.
    //
    // FRACTIONAL HOURS, and no patience threshold. The screens turn anything under an hour into
    // minutes themselves, so a floor here would hand every fresh decision the word «ноль часов»;
    // and waiting for a person is the whole cost of the row, so no span of it is «не считается».
    // Where the stop was never marked (a row reconstructed after the fact) the field is ABSENT —
    // a zero would read as «остановилась только что», which is a claim about work nobody watched.
    if (r.status === 'awaiting_approval' || r.status === 'approving') {
      const stoppedAt = toMs(r.completedAt)
      if (Number.isFinite(stoppedAt) && now - stoppedAt >= 0) out.agedForHours = (now - stoppedAt) / HOUR_MS
    } else if (ageMs > agingMs) {
      out.agedForHours = Math.floor(ageMs / HOUR_MS) // «застряла» signal
    }
    return out
  }

  // ── queue[] — ordered by priority desc, then enqueuedAt asc (the claimNext order) ──
  const orderedQueue = [...queuedRows].sort((a, b) => {
    const pa = Number(a.priority) || 0
    const pb = Number(b.priority) || 0
    if (pb !== pa) return pb - pa
    return (toMs(a.enqueuedAt) || 0) - (toMs(b.enqueuedAt) || 0)
  })
  const queue = orderedQueue.map(toTaskRow)

  // ── awaiting[] — the work that is finished but still owes a person a word. The day
  // screen shows those tasks, not a number beside them, so the payload has to carry the
  // rows: a counter alone leaves the screen with nothing to draw. The one that has waited
  // longest comes first — waiting is the whole cost here, so priority has no say — and the
  // wait is measured from the moment the work STOPPED, the same mark the row's age is stated
  // from, falling back to the queue mark only where the stop was never written. The
  // queue keeps meaning what it says: rows waiting for a WORKER, never for a person. ──
  const waitingSince = (r) => {
    const stopped = toMs(r.completedAt)
    return Number.isFinite(stopped) ? stopped : toMs(r.enqueuedAt) || 0
  }
  const awaiting = [...awaitingRows, ...landingRows].sort((a, b) => waitingSince(a) - waitingSince(b)).map(toTaskRow)

  // ── ЧТО ЭТОТ РАБОТНИК ВЁЛ — the ledger's durable spine, joined to the words of the queue ──
  //
  // The ledger names the WORKER of every try and survives everything (it is files); the queue
  // row holds the TITLE, the KIND of work and the last word a PERSON said about it, and the
  // queue is where those three live. So the list of pieces comes from the ledger and the words
  // beside each piece come from the row — a join, never a second count.
  //
  // WHY NOT FROM THE ROWS ALONE. A row's `workerId` is CLEARED the moment the work is re-queued
  // or the attempts run out (adapter.mjs does it deliberately, and the durable backend does the
  // same), so «кто это вёл» is exactly the fact the rows stop carrying at the moment it becomes
  // interesting. A roster built off them would show a worker's failures vanishing one by one.
  //
  // THE LOOKUP IS BUILT OFF THE UNNARROWED ROWS on purpose. The project filter narrows the
  // TASK LISTS — it is not a statement about who did what, and a worker whose history went
  // titleless because a person had narrowed the board to another project would be a screen
  // answering a question nobody asked.
  const rowById = new Map(latestRowPerId(allRows).map((r) => [r.id, r]))

  // ── workers[] — presence is a PURE derive. The roster is ALSO the only list
  // that names a claimed task, so the three facts a screen needs to place that task travel
  // with it: its id, its NAME and its PROJECT. Without the last two a board can only print
  // the routing id where a title belongs, and its project filter has to let every running
  // card through — a column that answers a narrowed question with unnarrowed rows. All
  // three ride the same conditional: a worker holding nothing states nothing about a task,
  // rather than carrying nulls a filter would then have to special-case. ──
  const workers = workersCfg.map((w) => {
    const accountName = accountNameOf(w.account, w.id)
    const win = windowFor(windows, w.account ?? accountName)
    const bar = windowBar(win)
    const open = isOpen(bar, () => now)

    const active = claimedRows.find((r) => r.workerId === w.id) || null
    // The sign of life is the RENEWAL clock: «событие N секунд назад» is a statement about the
    // last time the worker said it lives, not about when it started. The two older names stay as
    // the fallback for a reading that carries only one of them.
    const touchMs = active ? toMs(active.leaseRenewedAt ?? active.lastTouch ?? active.claimedAt) : NaN
    const pulseAgeSec = Number.isFinite(touchMs) ? Math.max(0, Math.round((now - touchMs) / 1000)) : undefined
    const presence = derivePresence({ windowOpen: open, hasActiveTask: !!active, pulseAgeSec })

    // The period figures. ABSENT rather than zeroed when the ledger could not be read (or none
    // is wired): on the card a zero reads as «этот ничего не сделал», which is a measurement,
    // and «нет данных» is the truth. A readable but empty ledger DOES yield zeros — the
    // catalogue was opened and nothing concluded in the period, and that is a measurement.
    const stats30d = workerStats ? workerStats.statsFor(w.id) : null

    // The pieces this one led, over the SAME period and out of the SAME pass that counted
    // them. Absent — never empty — when the ledger could not be read: an empty list reads as
    // «этот ничего не вёл», which is a claim, and the card must be able to say «нет данных».
    const history =
      workerStats && typeof workerStats.historyFor === 'function' ? workerStats.historyFor(w.id) : null

    return {
      id: w.id,
      lane: w.lane,
      // КТО ЭТО ПО РОЛИ И БЕРЁТ ЛИ ОН ЗАДАЧИ ИЗ ОЧЕРЕДИ. Экран «Команда» рисовал одну сетку из
      // сорока пяти карточек и называл её работниками, хотя тридцать восемь из них — специалисты,
      // которых поднимает фаза, а не очередь. Оба поля СЧИТАНЫ здесь и тем же выражением, каким
      // их читает маршрутизатор: экран, выводящий «исполнитель ли это» сам, стал бы вторым
      // мнением о том же — а два мнения об одном работнике и есть способ перестать верить обоим.
      role: roleOf(w),
      // «В ОЧЕРЕДИ» — ЭТО ТРИ УСЛОВИЯ СРАЗУ, и ни одного из них не видно на карточке по
      // отдельности: он исполнитель, он включён, и он не верхушка. Именно это число человек
      // читает как «работников», и именно оно расходилось с составом пула на порядок.
      inQueue: isExecutor(w) && w.enabled !== false && !isOrchestrator(w),
      enabled: w.enabled !== false,
      account: accountName,
      ...(active
        ? {
            taskId: active.id,
            taskTitle: active.title ?? null,
            project: projectOf(active),
            branch: `wt/${active.id}`,
            // WHEN THIS WORK WAS TAKEN — and it rides HERE because the roster is the only list
            // that names a claimed task: queue[] carries rows waiting for a worker and awaiting[]
            // rows waiting for a person, so a screen building a running row builds it from the
            // worker holding it. A claim time that reached only the task lists would be computed
            // and delivered to nobody. Null while the queue cannot say; the renewal clock is
            // already stated beside it as pulseAgeSec.
            taskClaimedAt: active.claimedAt ?? null,
          }
        : {}),
      window: bar,
      ...(pulseAgeSec !== undefined ? { pulseAgeSec } : {}),
      presence,
      ...(stats30d ? { stats30d } : {}),
      ...(history ? { history: history.map((h) => historyRow(h, rowById.get(h.taskId))) } : {}),
    }
  })

  // ── done[] — «сделано за ночь»; durable sources only ──
  // The tree the work happened in is named once, above the batches — without it the card's git
  // reads ran in the daemon's launch directory.
  const done = doneRows.map((r) =>
    buildDoneRow(r, { readTaskAttempts, readReceipt, execGit, gitDir, machineId }),
  )

  // ── accounts — the deduped subscription list the spend strip ALSO rides (one dedup,
  // one window read per account, one order both sections agree on) ──
  const accounts = deriveAccounts(config, windows)
  // The spend strip carries the WHOLE window bar, not two numbers off it. «Расходы» used to
  // rebuild half of this by hunting for the worker riding each account, which meant an account
  // nobody was riding lost the very facts the screen is there to state.
  const spendAccounts = accounts.map((a) => ({ name: a.name, ...a.windows }))

  // ОДИН НАБОР АККАУНТОВ НА ОБА ЧИСЛА — И ТОТ ЖЕ, ЧТО У ПОРОГА ОСТАНОВКИ ДЕНЕГ. Читает не
  // этот файл: policy/spend.mjs, та же функция, из которой берёт своё число правило отката.
  // Прежде это чтение жило здесь целиком и отличалось от чтения порога тремя вещами сразу —
  // полем (`apiCostUsd` против `costUsd`), набором аккаунтов и окном.
  const spendAccountsRead = spendAccountNames(config)
  const todayUsd = apiSpendUsd({ usageReader, accountNames: spendAccountsRead, windowMs: DAY_MS, clock: () => now })
  // «ЗА МЕСЯЦ» — ЭТО КАЛЕНДАРНЫЙ МЕСЯЦ, И ЭТО ЖЕ ЧИСЛО СРАВНИВАЕТ С ПОТОЛКОМ ПОРОГ СТОПА.
  // Здесь стояли скользящие тридцать суток, а порог считал с первого числа: на экране одно,
  // деньги останавливаются по другому — и человек узнаёт об этом в тот день, когда полоса
  // встанет «раньше времени». Потолок назван «в месяц», значит месяц у него календарный.
  const monthUsd = monthToDateApiSpendUsd({ usageReader, accountNames: spendAccountsRead, clock: () => now })
  const capUsd = apiCapUsd(config.budget)
  const anyClosed = workers.some((w) => !isOpen(w.window, () => now))
  const switchMode = anyClosed && capUsd > 0 ? 'api' : 'subscription'
  const spend = {
    accounts: spendAccounts,
    // The figure the person reads on his own status line, carried through unchanged.
    terminal: terminalBar(deps.terminalWindows),
    apiFallback: {
      // ДОЛЛАРЫ, И ИМЯ ПОЛЯ ЭТО ГОВОРИТ. Поставщик выставляет `total_cost_usd`, пересчёта
      // курса в продукте нет; называть эти же числа «Eur» значило бы прятать отсутствие
      // курса в имени поля. Сказать об этом словами — обязанность экрана (FX_NOTE).
      todayUsd: round2(todayUsd),
      monthUsd: round2(monthUsd),
      capUsd,
      switchMode,
    },
  }

  // ── costs.series — the SPA's cost view rides GET /api/state:
  // cheaper than a new endpoint since this derive already holds the usage seam. A
  // dedicated per-account/per-day reader is injected (usageSeries); absent → an empty
  // (but always-present) series, so the 9.6 contract is stable from day one. ──
  let series = []
  if (typeof deps.usageSeries === 'function') {
    try {
      series = deps.usageSeries({ days: 14, accounts: spendAccounts.map((a) => a.name), clock: () => now }) || []
    } catch {
      series = []
    }
  }
  const costs = { series, apiFallback: spend.apiFallback }

  // ── kpis ──
  const windowsOpen = workers.filter((w) => isOpen(w.window, () => now)).length
  // ── МЕСТА: сколько их всего и сколько занято прямо сейчас ──
  //
  // ОБА ЧИСЛА БЕРУТСЯ У ТОГО, КТО МЕСТАМИ РАСПОРЯЖАЕТСЯ. Занятые — у дома идущих попыток
  // (`deps.inFlight.size()`), тем же счётом, по которому тик отказывает в месте; общее — из
  // `concurrencyCap`, тем же чтением настройки, по которому он этот отказ выносит. Пересчитать
  // занятость по карточкам работников было бы вторым мнением: карточка говорит, что у
  // работника в руках строка очереди, а место занимает ПРОХОД ТИКА — и как раз тогда, когда
  // потолок начнёт себя вести не так, как думает человек, эти два счёта и разойдутся.
  //
  // ЗАНЯТО — `null`, А НЕ НОЛЬ, когда дома не передали. Ноль читается как «мест полно, всё
  // свободно», то есть как измерение; отсутствие дома — это «сказать нечем». Потолок при этом
  // называется всегда: он есть у любого демона, даже у того, чей дом не подключён.
  const seatsTotal = concurrencyCap(config)
  const seatsBusy =
    deps.inFlight && typeof deps.inFlight.size === 'function' ? deps.inFlight.size() : null
  // ── «РАБОТНИКОВ N» — ЭТО ПУЛ ОЧЕРЕДИ, А НЕ ДЛИНА СПИСКА В КОНФИГЕ ──
  //
  // Доска говорила «работников 44», когда задачи разбирали шестеро: `workersCfg.length` считал
  // ВСЕХ — вместе с тридцатью восемью выключенными и вместе со специалистами, которых очередь
  // не раздаёт вовсе. Человек читает это число как «столько народу разбирает мою очередь» и
  // верит ему; ошибиться в нём в семь раз — значит соврать о пропускной способности машины.
  //
  // ПУЛ — ЭТО ТРИ УСЛОВИЯ, И ВСЕ ТРИ ОБЯЗАТЕЛЬНЫ: он исполнитель (специалиста берут поимённо,
  // а не в порядке очереди), он включён, и он не верхушка. То же самое, что спрашивает фильтр
  // маршрутизатора, — и спрошено тем же выражением, чтобы «сколько их» и «кого выберут» не
  // могли разойтись.
  //
  // ЗАНЯТЫЕ СЧИТАЮТСЯ ПО ТОМУ ЖЕ НАБОРУ. Пара «занято X из N» обязана быть парой об одном и том
  // же множестве: занятые по всем сорока пяти против общего по шести давали бы «занято 3 из 6»
  // сегодня и «занято 8 из 6» в тот день, когда человек позовёт специалистов поимённо.
  //
  // СЧЁТЧИК СЧИТАЕТ КАРТОЧКИ, А НЕ РЕШАЕТ ЗАНОВО, КТО ЗАНЯТ. «Занято» жило здесь СВОИМ
  // выражением (`!!w.taskId`), а слово под работником — своим (derivePresence), и два
  // правила об одном факте разошлись ровно так, как расходятся всегда: в одной выдаче
  // `workersBusy = 4` и четыре карточки со словом «свободен» (31.08). Теперь читается тот же
  // `presence`, который увидит человек, — счётчик и список не могут разойтись по построению,
  // потому что выражение осталось одно. Тот же закон уже записан на карточке работника
  // («вторая копия вывода была бы вторым мнением») и на снимке доски для разговора.
  const queuePool = workers.filter((w) => w.inQueue)
  const kpis = {
    workersBusy: queuePool.filter((w) => w.presence === 'работает').length,
    workersTotal: queuePool.length,
    queued: queuedRows.length,
    awaitingApproval: awaitingRows.length,
    // ── СБОРКИ, КОТОРЫЕ ЖДУТ РЕШЕНИЯ ЧЕЛОВЕКА — СВОЁ ЧИСЛО, А НЕ СПРЯТАННОЕ СОСТОЯНИЕ ──
    //
    // ЭТО НЕ ТО ЖЕ, ЧТО `awaitingApproval`, и потому оно и стоит рядом отдельной цифрой.
    // Сосед считает ГОТОВУЮ работу, которую надо принять или вернуть; здесь — сборка, которая
    // ОСТАНОВИЛАСЬ на сорвавшемся куске и не двинется, пока владелец не скажет «пропустить,
    // повторить или отменить». Строка ожидания жила ТОЛЬКО на карточке батча: в счётчиках она
    // не считалась, в очередь не попадала, наружу не кричала — и батч простоял 15 часов, а
    // доска показывала ноль ждущих. Ноль был правдой про приёмку и ложью про день.
    //
    // Считается по САМИМ сборкам этого чтения — по наличию вопроса, который карточка задаёт, —
    // так что цифра и вопрос не могут разойтись: они выведены из одного места одним правилом.
    batchesAwaitingDecision: batches.filter((b) => !!b.question).length,
    // СИНОНИМ `costs.apiFallback.todayUsd`, и взят ИЗ НЕГО, а не посчитан второй раз. Число
    // одно, экранов у него может быть много, но выражение должно остаться одно: два
    // `round2(todayUsd)` рядом — это две правки, из которых однажды сделают одну.
    spentTodayUsd: spend.apiFallback.todayUsd,
    windowsOpen,
    seatsBusy,
    seatsTotal,
  }

  // ── the settings read models — the SAME route, a fuller payload ──
  //
  // ФАЙЛ НАСТРОЕК ЧИТАЕТСЯ ЗДЕСЬ ЗАНОВО, и это не дубль загрузки: `config` — это копия,
  // прочитанная НА ЗАПУСКЕ демона, а файл с тех пор мог поменять человек руками. Ровно эти
  // два значения и расходятся у настроек второго класса, и назвать расхождение можно только
  // подержав оба разом. Шов — функция: демон подключает настоящее чтение с диска, сцена и
  // тесты подставляют своё, а демон, который не подключил ничего, просто ничего не
  // утверждает про файл.
  let configOnDisk = null
  if (typeof deps.configOnDisk === 'function') {
    try {
      const read = deps.configOnDisk()
      configOnDisk = read && typeof read === 'object' && !Array.isArray(read) ? read : null
    } catch {
      configOnDisk = null // нечитаемый файл — обычное состояние, а не отказ двери
    }
  }
  const rules = deriveRules(config, { switchMode, configOnDisk })
  // The corpus lives in the repository the daemon serves; an explicit memoryDir wins, so a
  // test (and a future multi-repo wiring) never has to own the layout convention.
  const memoryDir = deps.memoryDir ?? (deps.repoDir ? join(deps.repoDir, '.claude', 'memory') : null)
  const memory = deriveMemory({ memoryDir, fsImpl: deps.fsImpl })
  const style = deriveStyle({ memoryDir, fsImpl: deps.fsImpl })
  // The CONNECTED project's corpus — a different question from `memory`, which is the corpus
  // of the repository this daemon itself serves. Additive: a daemon with no project
  // connected answers {absent:true} and every existing key keeps its exact shape.
  const projectMemory = deriveProjectMemory({
    config,
    readProjectMemory: deps.readProjectMemory,
    previewProjectMigration: deps.previewProjectMigration,
    projectLiveness: deps.projectLiveness,
    migrationStagingDir: deps.migrationStagingDir,
    fsImpl: deps.fsImpl,
    clock,
  })

  // ── WHY THE QUEUE IS NOT MOVING, said out loud. A queued row that nothing will pick up
  // used to look exactly like a queued row seconds from running — the founder learned the
  // difference by waiting (recon 11.08, the Multica anti-pattern «Queued без причины и
  // предела»). The reason is a DERIVE from facts this function already holds, in priority
  // order: a switched-off conveyor beats everything (nothing runs, whatever the windows
  // say); then all-windows-closed with no paid budget (nowhere to run); then a paid
  // channel that exists but is already spent (budget stop). Windows closed WITH budget
  // left is not idle — the fallback engages — so it stays unmarked. ──
  // ТО ЖЕ ЧИСЛО, что на «Расходах» и в пороге стопа — `spend.apiFallback.monthUsd`, взятое
  // из него, а не посчитанное здесь заново: объяснение «деньги кончились» обязано читать ту
  // же цифру, по которой они и кончаются.
  const monthUsdSpent = spend.apiFallback.monthUsd
  const queueIdleReason = !pipelineEnabled(config)
    ? 'pipeline_off'
    : windowsOpen === 0 && capUsd === 0
      ? 'windows_closed'
      : windowsOpen === 0 && capUsd > 0 && monthUsdSpent >= capUsd
        ? 'budget_stop'
        : null
  if (queueIdleReason) for (const q of queue) q.idleReason = queueIdleReason

  // ── …И ПОЧЕМУ НЕ ДВИГАЕТСЯ ИМЕННО ЭТА СТРОКА, когда весь остальной конвейер идёт ──
  //
  // Очередь не выдаёт разом две работы, чьи объявленные файлы пересекаются: вторая ждёт, пока
  // первая освободит файл, — иначе обе отводятся от одной вершины и приезжают на приёмку
  // конфликтом, который система создала себе сама (замерено 31.08.2026: пять готовых работ из
  // шести не слились с первого раза). Но УДЕРЖАНИЕ, О КОТОРОМ НИКТО НЕ ЗНАЕТ, — это молча
  // остановленная очередь: строка стоит, работники свободны, и человек читает это как «вот-вот
  // начнётся». Долговечный бэкенд откладывает такую строку на 2999 год, и без этой строки
  // причину было бы неоткуда взять вовсе.
  //
  // ПРАВИЛО ЧИТАЕТСЯ ПО НЕСУЖЕННЫМ СТРОКАМ. Держать может работа ЛЮБОГО проекта — файл один на
  // дерево, — а `queue` уже сужен взглядом человека; спросить сужённое значило бы объявить
  // свободным файл, занятый работой из соседнего проекта.
  //
  // ОБЩАЯ ПРИЧИНА СИЛЬНЕЕ ЧАСТНОЙ. Выключенный конвейер (или закрытые окна) объясняет ВСЮ
  // очередь разом, и своё «ждёт файла» поверх него было бы правдой, отвечающей не на тот
  // вопрос: пока тумблер выключен, эта строка не двинулась бы и с пустыми файлами. Поэтому
  // код причины ставится только там, где общей причины нет, — а СОСТАВ удержания (`heldBy`)
  // отдаётся всегда: он факт о строке, а не объяснение простоя.
  const fileHolds = new Map(fileHoldsOf(allRows).map((h) => [h.id, h]))
  if (fileHolds.size > 0) {
    for (const q of queue) {
      const hold = fileHolds.get(q.id)
      if (!hold) continue
      q.heldBy = { files: hold.files, holders: hold.holders }
      if (!q.idleReason) q.idleReason = 'files_busy'
    }
  }

  // ── ВЕРХУШКА ЕДЕТ ОТДЕЛЬНЫМ КЛЮЧОМ, А НЕ СТРОКОЙ В `workers[]`. Это не оформление: экран
  // «Команда» рисует `workers[]` карточками исполнителей и считает по ним «работают / ждут
  // окно / свободны», а оркестратор ни к одному из этих слов не относится — он задач не берёт.
  // Ключ присутствует ВСЕГДА и равен `null` там, где роли на машине не заведено: ключ,
  // появляющийся только вместе с данными, читается экраном как «такого не бывает». ──
  const orchestrator = orchestratorView(config)

  const payload = {
    kpis,
    queue,
    batches,
    waves,
    awaiting,
    workers,
    // КОГО МОЖНО НАЗВАТЬ ПРИ ПОСТАНОВКЕ — рядом с ростером, потому что это тот же состав,
    // свёрнутый по ролям. Ключ присутствует ВСЕГДА: пустой список на машине без работников —
    // это факт, а отсутствующий ключ форма прочла бы как «выбирать тут нечего никогда».
    roles: deriveRoles(config),
    orchestrator,
    done,
    spend,
    costs,
    projects,
    activeProject,
    machines,
    federation,
    rules,
    accounts,
    memory,
    style,
    projectMemory,
    // ЧТО ЗА ДВЕРЬ У ЭТОГО ДЕМОНА И КОМУ ОНА ВИДНА — факт, на котором стоит онбординг
    // приватной сети. Ключ присутствует ВСЕГДА: на машине без приватной сети это
    // `detected:false`, а не отсутствующий ключ, который экран прочёл бы как «такого не бывает».
    remoteAccess: deriveRemoteAccess(config, { networkInterfaces: deps.networkInterfaces }),
  }

  // ── the federation merge (hub only) — FILLS this payload, never redefines it ──
  return applyAggregator(payload, deps.aggregator)
}

/**
 * applyAggregator(payload, aggregator) — hand the finished local payload to the injected
 * federation merge and return its result, FAIL-OPEN: no aggregator, a throw, or anything
 * that is not a plain object → the local payload is served untouched. A peer storm degrades
 * the peers, never the founder's own machine. The merge may be async (the hub polls its
 * peers inside it), so a REJECTED promise is caught by the same fail-open arm.
 *
 * @param {object} payload the local derive
 * @param {*} aggregator   a function (or {aggregateState}) injected by the composition root
 * @returns {Promise<object>}
 */
async function applyAggregator(payload, aggregator) {
  const merge =
    typeof aggregator === 'function'
      ? aggregator
      : aggregator && typeof aggregator.aggregateState === 'function'
        ? (p) => aggregator.aggregateState(p)
        : null
  if (!merge) return payload
  try {
    const merged = await merge(payload)
    return merged && typeof merged === 'object' && !Array.isArray(merged) ? merged : payload
  } catch {
    return payload
  }
}

/**
 * Build ONE «сделано за ночь» row from a durable done/failed adapter row + the ledger.
 *
 * `gitDir` is WHERE THE TWO GIT READS RUN, and it is not optional bookkeeping: both used to be
 * called with no cwd at all, so they ran in the directory the daemon PROCESS was launched from.
 * On an install where the daemon serves one repository and the founder's project is another,
 * the branch `wt/<taskId>` does not exist there — git exits non-zero, both catches fire, and a
 * finished task's card showed no commits and no diff at all. The tree the work happened in is
 * the connected project, and that is what the caller passes.
 */
/**
 * How long ONE attempt ran, in milliseconds, from its own two ledger marks — or `null`.
 *
 * Both marks or nothing: a length derived from one of them would be a length measured against
 * «now», and «now» is when somebody happened to open the screen rather than when the work
 * stopped. A negative span (clocks moved, a row was rewritten) is refused for the same reason —
 * it is evidence the two marks are not comparable, not a number to show.
 */
function attemptDuration(attempt) {
  const from = toMs(attempt && attempt.startedAt)
  const to = toMs(attempt && attempt.endedAt)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const ms = to - from
  return ms >= 0 ? ms : null
}

/**
 * The GIT PART of a finished card, remembered per task — because it is history.
 *
 * Both reads are SYNCHRONOUS subprocesses, and the done list is every finished task the fold
 * still carries. Measured 26.08.2026 on the founder's machine: two spawns per finished task
 * per poll, an uncapped list, a 3-second poll — /api/state answered in 26,7 s while
 * /api/diff (one spawn) answered in 0,4 s, and for those 26 s the ONE event loop served
 * nobody. A finished task's commit log does not change after it finishes, so paying that
 * price more than once per task is pure waste. That is what the memory below is for.
 *
 * ═══════════ И ПОЧЕМУ ПАМЯТИ ОКАЗАЛОСЬ МАЛО ═══════════
 *
 * Память лечит ВТОРОЙ опрос и не лечит ПЕРВЫЙ. Замерено 31.08.2026 на живом конвейере: три
 * подряд вызова двери — 33 465 мс, 717 мс, 704 мс. Разница между первым и вторым и есть цена
 * набора этой памяти, и платит её тот единственный человек, который открыл окно после
 * перезапуска демона. В той же копии на 136 закрытых работах: 25 100 мс всего, 24 779 мс из
 * них — git, ровно 276 запусков, из которых 272 — это ДВА запуска на каждую закрытую работу.
 * 98,6 % холодного ответа. И всё это время окно показывало «Работников нет» и «Пока тихо»
 * при четырёх работающих работниках и тридцати пяти работах в очереди, а сторож простоя
 * (`probeDoor`, потолок 3 000 мс) читал живую дверь как мёртвую.
 *
 * ПОЭТОМУ НА ПУТИ ЗАПРОСА GIT НЕ СПРАШИВАЮТ ВОВСЕ. `doneGitFacts` только ЧИТАЕТ память; чего
 * в ней нет — записывается в список желаемого, а спрашивается у git отдельным ходом
 * (`warmDoneGit`), который зовёт композиционный корень ПОСЛЕ того, как ответ уехал человеку.
 * Дверь отдаёт сразу то, что уже знает — очередь, работников, приёмку, — а история закрытых
 * работ доезжает к следующему опросу.
 *
 * ЧЕГО НЕ ЗНАЮТ — НАЗЫВАЮТ НЕИЗВЕСТНЫМ. Незаполненная карточка едет с `commits: null` и
 * `gitPending: true`, а не с пустым списком: пустой список означает «спросили и узнали, что
 * коммитов нет», и это ДРУГОЕ утверждение. Ровно та же разница, по какой в этом файле нигде
 * не стоит ноль вместо молчания.
 *
 * An EMPTY answer is remembered too, but only briefly: after approve the branch is deleted,
 * so the oldest cards fail both reads on every poll — the full spawn price for an exit code.
 * Briefly, not forever, because empty can also mean «asked in the wrong tree» (a project
 * connected a moment later), and that answer deserves a second chance. Устаревшую пустоту
 * дверь при этом ПРОДОЛЖАЕТ отдавать, пока досылка не принесёт новый ответ: измеренная
 * когда-то пустота — всё ещё измерение, а «неизвестно» на её месте было бы шагом назад.
 */
const DONE_GIT_CACHE = new Map() // `${taskId}|${cwd}` -> { commits, diffStat, emptyAt }
const DONE_GIT_CACHE_CAP = 1000
const DONE_GIT_EMPTY_RETRY_MS = 60_000

/**
 * ЧЕГО ЕЩЁ НЕ СПРАШИВАЛИ У GIT — очередь желаемого, которую наполняет дерайв и разбирает
 * досылка. Ограничена сверху по той же причине, по какой ограничено всё остальное здесь:
 * список закрытых работ растёт сам по себе, и неограниченный список — это память, которая
 * однажды станет утечкой.
 */
const DONE_GIT_WANTED = new Map() // key -> { taskId, cwd }
const DONE_GIT_WANTED_CAP = 5000

/** «Ещё не спрошено» — одна форма на все карточки, и ни одного нуля в ней. */
const DONE_GIT_UNKNOWN = Object.freeze({ commits: null, diffStat: null, pending: true })

/** Одно написание ключа памяти на читателя и на досылку. */
function doneGitKey(taskId, cwd) {
  return `${taskId}|${cwd || ''}`
}

/** Чем спрашивается лента коммитов закрытой работы — одно написание на читателя и досылку. */
function doneCommitArgs(taskId) {
  return ['log', '--oneline', `-${DONE_COMMIT_CAP}`, taskBranch(taskId)]
}

function wantDoneGit(key, taskId, cwd) {
  if (DONE_GIT_WANTED.has(key) || DONE_GIT_WANTED.size >= DONE_GIT_WANTED_CAP) return
  DONE_GIT_WANTED.set(key, { taskId, cwd: cwd || null })
}

function rememberDoneGit(key, entry) {
  DONE_GIT_CACHE.set(key, entry)
  if (DONE_GIT_CACHE.size > DONE_GIT_CACHE_CAP) {
    // the Map iterates in insertion order — the first key is the oldest memory
    DONE_GIT_CACHE.delete(DONE_GIT_CACHE.keys().next().value)
  }
}

/**
 * Что известно про git этой закрытой работы ПРЯМО СЕЙЧАС — без единого подпроцесса.
 * Неизвестное записывается в желаемое и называется неизвестным.
 */
function doneGitFacts(taskId, execGit, gitOpts) {
  // Шва git нет вовсе — это не «ещё не спросили», а «спрашивать нечем»: досылка сюда никогда
  // не придёт, и карточка честно живёт без истории вместо вечного «считаю».
  if (typeof execGit !== 'function') return { commits: [], diffStat: null }
  const key = doneGitKey(taskId, gitOpts.cwd)
  const hit = DONE_GIT_CACHE.get(key)
  if (hit) {
    if (hit.emptyAt !== null && Date.now() - hit.emptyAt >= DONE_GIT_EMPTY_RETRY_MS) {
      wantDoneGit(key, taskId, gitOpts.cwd)
    }
    return hit
  }
  wantDoneGit(key, taskId, gitOpts.cwd)
  return DONE_GIT_UNKNOWN
}

/** Одна досылка за раз: второй заход поверх первого удвоил бы ровно те подпроцессы, которых мы и избегаем. */
let doneGitWarmInFlight = null

/**
 * warmDoneGit({execGit, execGitAsync, tasks, concurrency}) → сколько работ досчитано.
 *
 * ХОД, КОТОРЫЙ ЧЕЛОВЕК НЕ ЖДЁТ. Зовётся композиционным корнем ПОСЛЕ того, как ответ двери
 * уехал, и наполняет память для следующего опроса. Ничего не решает сам: КАКИЕ работы и в
 * КАКОМ дереве спрашивать, уже решил дерайв — здесь только исполнение, поэтому «карточка
 * читает git в подключённом проекте» остаётся одним правилом, живущим в одном месте.
 *
 * `execGitAsync` — предпочтительный шов: подпроцесс, не держащий цикл событий. Синхронный
 * `execGit` принимается как запасной (им пользуются тесты и демон, который асинхронного не
 * подключил), но тогда досылка стоит ровно столько же, сколько стоила дверь, — просто платит
 * это не человек у окна.
 *
 * `tasks` сужает досылку до названных работ. Нужен там, где важно, что спрошено РОВНО про
 * них: общая очередь желаемого живёт на модуле и переживает отдельный вызов.
 *
 * FAIL-OPEN ПОШТУЧНО: работа, о которой git отказался говорить, запоминается пустой (это и
 * есть старое поведение) и не мешает соседним.
 */
export async function warmDoneGit({ execGit, execGitAsync, tasks, concurrency = 4 } = {}) {
  if (doneGitWarmInFlight) return doneGitWarmInFlight
  const only = Array.isArray(tasks) ? new Set(tasks) : null
  const wanted = [...DONE_GIT_WANTED.entries()].filter(([, job]) => only === null || only.has(job.taskId))
  if (wanted.length === 0) return 0
  for (const [key] of wanted) DONE_GIT_WANTED.delete(key)

  const ask =
    typeof execGitAsync === 'function'
      ? execGitAsync
      : typeof execGit === 'function'
        ? async (args, opts) => execGit(args, opts)
        : null
  if (ask === null) return 0 // спрашивать нечем — желаемое просто снято, без выдуманных ответов

  const run = (async () => {
    let next = 0
    const lanes = Math.max(1, Math.min(Number(concurrency) || 1, wanted.length))
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        while (next < wanted.length) {
          const [key, job] = wanted[next++]
          await warmOneDoneGit(key, job, ask)
        }
      }),
    )
    return wanted.length
  })()
  doneGitWarmInFlight = run.finally(() => {
    doneGitWarmInFlight = null
  })
  return doneGitWarmInFlight
}

async function warmOneDoneGit(key, job, ask) {
  const gitOpts = job.cwd ? { cwd: job.cwd } : {}
  let commits = []
  let diffStat = null
  try {
    commits = String((await ask(doneCommitArgs(job.taskId), gitOpts)) || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, DONE_COMMIT_CAP)
  } catch {
    commits = []
  }
  try {
    // WHAT THIS TASK CHANGED — asked through the ONE seam that owns that question
    // (front/task-changes.mjs). The diff door answers the same question for the same card,
    // and while each surface built its own range they answered it differently: this one
    // counted the whole branch, that one showed the last commit. The range lives in one
    // place now, so the panel and the door cannot tell a person two different stories.
    diffStat = String((await ask(taskChangeArgs(job.taskId, 'count'), gitOpts)) || '').trim() || null
  } catch {
    diffStat = null
  }
  rememberDoneGit(key, {
    commits,
    diffStat,
    emptyAt: commits.length === 0 && diffStat === null ? Date.now() : null,
  })
}

/**
 * turnSpentOf(attempt) → `{cap, used, kinds}` со строки попытки, или `null`.
 *
 * ТРИ ЧИСЛА, КОТОРЫЕ НЕЛЬЗЯ ПОСЧИТАТЬ ПОЗЖЕ. Поток попытки к моменту чтения свёрнут, копия
 * выметена — если попытка не записала, сколько ей дали и сколько она взяла, ответа больше нет
 * нигде. Поэтому здесь только ЧТЕНИЕ строки: ни одного числа эта функция не выводит сама.
 *
 * `null` вместо нулей, когда строка молчит. Ноль на экране читается как измерение — «попытка
 * не сделала ни хода», — а молчание строки означает «никто не мерил». Разные утверждения.
 */
function turnSpentOf(attempt) {
  if (!attempt || typeof attempt !== 'object') return null
  const cap = Number.isFinite(attempt.turnCap) ? attempt.turnCap : null
  const used = Number.isFinite(attempt.turnsUsed) ? attempt.turnsUsed : null
  const kinds = attempt.turnKinds && typeof attempt.turnKinds === 'object' ? { ...attempt.turnKinds } : null
  if (cap === null && used === null && kinds === null) return null
  return { cap, used, kinds }
}

function buildDoneRow(r, { readTaskAttempts, readReceipt, execGit, gitDir, machineId }) {
  const attempts = readTaskAttempts(r.id)
  const last = attempts.length ? attempts[attempts.length - 1] : null
  const receipt = parseReceiptSummary(last && last.receiptRef, { readReceipt })

  const branch = `wt/${r.id}`
  const gitOpts = gitDir ? { cwd: gitDir } : {}
  const { commits, diffStat, pending: gitPending } = doneGitFacts(r.id, execGit, gitOpts)

  const out = {
    id: r.id,
    title: r.title ?? null,
    project: projectOf(r),
    machine: machineId ?? 'self',
    finishedAt: r.completedAt ?? null,
    // HOW LONG IT ACTUALLY TOOK, from the two marks the ledger put down on the attempt that
    // CLOSED it — not from the first attempt to the last, which would silently include the hours
    // the task spent back in the queue between two tries and call that «работа».
    //
    // The two marks are what makes it honest. A finished row already carried `finishedAt`, and
    // the list beside it therefore printed «—» in the length column of every completed task —
    // the reading existed one field away and nobody handed it over. Where either mark is missing
    // (a row reconstructed after the fact, an attempt whose end was never written) this is NULL:
    // a zero would render as «заняло нисколько», which is a claim, and «нечего мерить» is the
    // truth.
    finishedDuration: attemptDuration(last),
    workerId: (last && last.workerId) ?? r.workerId ?? null,
    receipt,
    // The proof that really exists, beside the summary that waits for numbers nobody writes.
    proof: parseReceiptProof(last && last.receiptRef),
    diffStat,
    branch,
    commits,
    // ГИТ ЕЩЁ НЕ СПРОШЕН — сказано ключом, а не выведено экраном из пустоты. Без него
    // `commits: null` пришлось бы читать как «коммитов нет», и карточка вынесла бы приговор
    // работе, о которой никто ничего не спрашивал.
    ...(gitPending ? { gitPending: true } : {}),
    attempts: attempts.length || (Number.isFinite(r.attempt) ? r.attempt : 0),
  }
  // acceptance («обещано») — carried ONLY when the task had one (roster/return exempt).
  if (r.acceptance != null && String(r.acceptance).trim() !== '') out.acceptance = r.acceptance
  // ═══ ЗАКРЫТО СЛОВАМИ: ЧТО ЧЕЛОВЕК СКАЗАЛ О РАБОТЕ, КОТОРУЮ ДЕЛАТЬ НЕ БУДУТ ═══════════════
  //
  // Поле ЕСТЬ только там, где слово сказано, и это не про цвет строки: работа могла кончиться
  // и удачей, и срывом, а закрытие словами — про то, что дальше её никто не двинет. Поэтому
  // оно живёт РЯДОМ с `failed`, а не внутри него: закрытая словами удачная строка тоже несёт
  // своё слово, и «сделано иначе» на зелёной карточке — законное предложение.
  //
  // Подпись берётся из того же словаря, которым дверь судит принятое слово: экран не сочиняет
  // второго перевода, а незнакомое слово честно остаётся без подписи, а не выдумывает её.
  if (r.closedByPerson && typeof r.closedByPerson === 'object') {
    const closingReason = r.closedByPerson.reason ?? null
    out.closed = {
      reason: closingReason,
      reasonLabel: closingReason ? (CLOSING_REASON_LABELS[closingReason] ?? null) : null,
      note:
        typeof r.closedByPerson.note === 'string' && r.closedByPerson.note.trim() !== ''
          ? r.closedByPerson.note
          : null,
    }
  }
  // failed red-card fields.
  if (r.status === 'failed') {
    const reason = r.failure_reason ?? (last && last.failureReason) ?? null
    // НА ЧТО УШЛИ ХОДЫ — у КАЖДОЙ красной карточки, а не только у той, что упёрлась в
    // потолок. Попытка, съевшая девяносто ходов и упавшая на красных тестах, и попытка,
    // упавшая на третьем, — разные события, и до сих пор экран показывал их одинаково.
    // Читается с последней попытки: строка реестра пишется ею же и её потолком.
    const spent = turnSpentOf(last)
    out.failed = {
      reason,
      reasonLabel: reason ? REASON_LABELS[reason] ?? null : null,
      // ПОЧЕМУ ИМЕННО У ЭТОЙ ПОПЫТКИ. Подпись выше — про КЛАСС отказа и одинакова у всех
      // отказов этого рода; строка ниже — про эту попытку: чем отказал гейт и на чём она в
      // последний раз споткнулась. Пока её не было, три подряд сгоревшие попытки выглядели
      // на экране одной и той же фразой, а причина оставалась в стенограмме, которую надо
      // открыть. `null` — сказать нечего: пустая строка читалась бы как молчание о причине.
      detail: (last && typeof last.failureDetail === 'string' && last.failureDetail.trim() !== '' ? last.failureDetail : null),
      attemptsCount: attempts.length || (Number.isFinite(r.attempt) ? r.attempt : 0),
      spent,
      // ПРЕДЛОЖЕНИЕ — ТОЛЬКО ТАМ, ГДЕ СЛЕДУЮЩЕЙ ПОПЫТКИ НЕ БУДЕТ. У всех прочих концов её
      // делает очередь сама, и три кнопки над строкой, которая и так поедет снова, — это
      // выбор, которого у человека не спрашивали. Развилка не выводится здесь заново:
      // спрашивается тот же список, по которому тик выбирает дверь (`AWAITS_A_PERSON`), —
      // второе место, где живёт то же правило, разошлось бы с первым молча.
      ...(failureAwaitsAPerson(reason)
        ? {
            offer: turnCapOffer({
              turnsBurned: spent ? spent.used : null,
              cap: spent ? spent.cap : null,
              kinds: spent ? spent.kinds : null,
            }),
          }
        : {}),
      // …А ЗДЕСЬ — ОБРАТНАЯ СТОРОНА ТОГО ЖЕ ПРЕДЛОЖЕНИЯ: строка, которую очередь перевыдаст сама,
      // говорит об этом номером. Без него красная карточка зовёт человека к работе, которая
      // поедет и без него, — тот самый шум, из-за которого столбик ожидания перестают читать.
      // Поле ЕСТЬ, только пока повторы остались; кончились — сказать больше нечего, и молчание
      // здесь и есть «дальше решаете вы». Правило спрашивается у очереди, а не выводится заново.
      ...(awaitsAutoRetry(r)
        ? { repeats: { attempt: autoRetriesSpent(r) + 1, of: autoRetryLimitFor(reason) } }
        : {}),
    }
  }
  return out
}
