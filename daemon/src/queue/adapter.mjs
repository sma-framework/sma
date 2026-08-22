/**
 * adapter.mjs — the QueueAdapter seam: ONE interface, a reusable contract test
 * factory, and an in-memory reference backend.
 *
 * WHY THIS FILE EXISTS: the pg-boss backend, the runner, the tick and the front all
 * build against THIS interface. Interface-first — the contract lands before any
 * implementation. The seam is honest because `queueAdapterContractSuite` is an
 * EXECUTABLE spec: the pg-boss backend re-runs this exact suite, and the deferred file
 * backend will re-run it too. A backend that passes the suite IS a conforming
 * QueueAdapter; nothing else certifies it.
 *
 * BACKEND-FREE BY LAW: this module imports NO backend (no pg-boss, no pg, no fs
 * beyond none). The interface must never learn its implementations. The future file
 * backend (deferred) will implement its atomic checkout via the
 * claims.mjs `mkdirSync`-EEXIST primitive + a JSONL journal of transitions — this is
 * a SEAM NOTE only; it is not implemented here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TASK SHAPE (single source of truth — every later plan consumes this):
 *
 * task = {
 *   id: string,                 // 'BL-96' (backlog), 'R-<epochMs>' (roster), 'F-<epochMs>' (forge)
 *   source: 'backlog'|'roster'|'return',
 *   title: string,              // <= 200 chars, plain text
 *   lane: 'prod'|'research'|'paperwork'|'forge',  // 'forge' = draft generation
 *   provider?: 'claude'|'codex'|'api',            // per-task override of lane routing
 *   model?: string, effort?: string,              // per-task overrides
 *   priority: number,           // 0 default; higher fetched first
 *   attempt: number,            // 1-based; incremented on requeue
 *   storyPoints?: number,       // CUE estimate, Fibonacci ONLY: 1|2|3|5|8|13; REQUIRED when source==='backlog'
 *   description?: string,       // что это за работа, свободным текстом, <= 2000 — DATA, never instructions
 *   acceptance?: string|string[], // признаки успеха: ОДНО поле, ДВА формата — see WHAT IS PROMISED below
 *   note?: string,              // return-with-comment text, <= 2000
 *   project?: string,           // V5.1: the project slug this task belongs to.
 *                               // Optional on the wire, ALWAYS present on a read row.
 *   batchId?: string,           // the batch this row belongs to — see BATCH below
 *   forge?: {                   // REQUIRED iff lane==='forge', forbidden otherwise
 *     kind: 'agent'|'skill'|'mcp',
 *     description: string       // founder free text, <= 2000 — DATA, never instructions
 *   }
 * }
 *
 * ═══════ WHAT IS PROMISED — ONE FIELD, TWO FORMATS, AND NO SECOND FIELD ═══════════
 * «Что обещано» is asked by three different readers — the worker whose prompt states the
 * contract, the person reading the task card, and the check that judges the work afterwards.
 * They must be reading THE SAME SENTENCE, so there is exactly one field for it: `acceptance`.
 *
 * A second field of criteria beside it (the shape an earlier draft proposed) would be two
 * places to write the same promise, and the two would disagree the first time either was
 * edited — with nothing in the product able to say which one the work was judged by. That is
 * the whole reason the list lives INSIDE the existing field rather than beside it.
 *
 * The field therefore accepts BOTH shapes and means one thing:
 *   - a STRING  — one criterion. Every row written before this existed is exactly this, and
 *                 it stays valid, unrewritten and readable, for ever;
 *   - a LIST of strings — several criteria, bounded by CAP_ACCEPTANCE_ITEMS and by the same
 *                 per-item ceiling one criterion always had.
 *
 * AND EVERY READER NORMALIZES: `acceptanceItems()` turns either shape into a list (a string
 * becomes a list of one), and that is the only way this field is ever read. Nobody branches
 * on «is it an array» twice, so nobody can branch on it differently.
 *
 * `description` is the neighbouring free text — what the work IS, as opposed to what will
 * make it done. Both are DATA and reach a worker only inside a fence.
 *
 * ═══════════ A BATCH IS A FACT OF THE QUEUE, NEVER A GROUPING ON A SCREEN ═══════════
 * One request of the owner («разгреби мелочь перед демо») fans out into N pieces of work and
 * converges back into one assembly. Both halves of that sentence have to be true somewhere
 * durable, or a screen drawing a batch would be drawing a word over ordinary tasks: kinship
 * that lives only in a payload the front assembles is kinship two readers can disagree about.
 *
 * So the queue carries both halves and nothing else does:
 *   - AN ITEM names its batch in `batchId`. It is ordinary work in every other respect —
 *     claimed, run, completed and failed exactly like a task with no batch at all.
 *   - THE REQUEST ITSELF is a row too, marked `data.batch === 'parent'` and carrying the same
 *     `batchId` (its own id, so nothing has to hold two identifiers that could disagree).
 *
 * AND THE PARENT IS NEVER HANDED TO A WORKER. It is a record of what was asked, not a piece
 * of work: `claimNext` may not return it on any ordering, and `stats()` does not count it as
 * queued work — a row no worker will ever take, counted in the number beside «в очереди»,
 * is a number that never goes down. Each backend keeps that promise its own way (the
 * reference backend by refusing the record, the durable one by keeping parents out of the
 * lane queues entirely), and the contract suite asserts the PROMISE rather than either
 * mechanism. What holds an assembly open is computed by a reader from the items' statuses and
 * is never stored — a stored one would be a second truth about the same five statuses.
 *
 * ═══════════ ONE PIECE AT A TIME — WHOSE TURN IT IS, AND WHO DECIDES ═══════════════
 * The owner's rule for a batch is that its pieces go one after another, never side by side:
 * one worker takes a piece, finishes it, and only then is the next one handed out. So «whose
 * turn is it» is a question of the QUEUE, not of a screen — `batchTurnOf` answers it from the
 * rows themselves, and both backends obey the same answer:
 *
 *   - a piece is UNDER WAY (claimed)  → the batch has no turn; nothing else of it is handed out
 *   - a piece FAILED                  → the batch STOPS and its owner is asked what to do
 *                                       (skip / repeat / cancel). NOTHING is retried by itself
 *   - otherwise                       → the turn is the first waiting piece, in enqueue order
 *
 * A piece that produced and is waiting for a person's acceptance does NOT hold the turn: the
 * assembly is what the owner accepts, and stalling a worker on each piece's acceptance would
 * turn one batch into five separate waits for a human.
 *
 * THE OWNER'S WORD IS RECORDED ON THE REQUEST ROW — `data.skipped` (the pieces he chose to
 * skip) and `data.cancelled`. Facts, not derivations: what the owner said is not recomputable
 * from anything else, and a skipped piece must stay skipped across restarts. Everything else
 * about a batch (what holds it, whether it is closed) stays computed at every read.
 *
 * A BATCH NEVER FREEZES THE QUEUE. The turn rule speaks about the pieces of ONE batch: work of
 * other batches and ordinary tasks are claimed exactly as before, so a long assembly occupies
 * one worker and no more.
 *
 * ═══════════════ PROJECT IS ADDITIVE, AND IT IS STAMPED ONCE — NEVER GUESSED ═════════════
 * `project` is optional on the wire. An adapter is constructed with the config's
 * `activeProject`, and the ONE moment it is used is the enqueue: a task put in while a
 * project is selected is stamped with it, because that is the only instant when there is
 * anybody to ask. LANE and PROJECT are independent dimensions — a forge task in another
 * project is perfectly valid.
 *
 * ON READ NOTHING IS FILLED IN. A row written before the field existed states no project,
 * and it reads back stating none (`project: null`, via `withStatedProject`). The read path
 * used to complete such a row with whatever project was selected at that second, so the same
 * forty rows belonged to whichever project was being looked at, and the counters of both
 * agreed. A confident wrong answer is worse than a missing one: by it you cannot notice that
 * the answer is missing. The row is still never rewritten on disk — the daemon is not the
 * source of truth for its own history — but «read completely» now means «read as written».
 *
 * The adapter stays BACKEND-FREE and IMPORT-FREE: the active project arrives by injection,
 * so this module still learns nothing about the config module or any backend. The slug
 * grammar below is deliberately a local constant rather than an import for the same reason.
 *
 * QueueAdapter methods (all async):
 *   enqueue(task)                 → {id, coalesced, coalesceCount}; validateTask on every path
 *   claimNext(workerId, {lanes})  → atomic checkout RESTRICTED to `lanes`; null when empty or
 *                                   no queued task in those lanes. The tick derives eligible
 *                                   lanes from OPEN workers BEFORE claiming,
 *                                   so a claimed task is always runnable. lanes:[] → null,
 *                                   no mutation. lanes omitted → all lanes eligible.
 *   touch(taskId)                 → refresh the liveness clock on a claimed task
 *   resolveBatch(batchId, word)   → record the owner's word about a stopped assembly
 *                                   ({skip:<itemId>} | {cancel:true}) and make it take effect
 *   setWords(taskId, words)       → replace `description` / `acceptance` on a task whose work
 *                                   is not over yet; false on an unknown or finished task
 *   complete(taskId, result)      → result MUST carry `receiptRef` else NoReceiptError
 *   fail(taskId, reason)          → reason ∈ FAIL_REASONS else InvalidFailReasonError
 *   cancelTask(taskId)            → A PERSON STOPPED THIS WORK. The row is closed TERMINALLY
 *                                   with the reason `manual`, and no worker is ever handed it
 *                                   again — not on the next tick, not on any later one. Returns
 *                                   true when a live task was found and closed, false when
 *                                   there is no such task or its work is already over (what is
 *                                   closed stays closed, exactly as with setWords).
 *   list(filter)                  → rows expose enqueuedAt/claimedAt/leaseRenewedAt/completedAt
 *   stats()                       → per-status counts, one key per TASK_STATUSES entry
 *
 * FINISHED IS NOT ACCEPTED. `complete()` carries a receipt, and a receipt is the worker's
 * half of done — the other half is a person saying so. So a completed task reads back as
 * `awaiting_approval`, never as `completed`, at EVERY backend: the status a screen shows is
 * a property of the task, and a front that had to derive «waiting for a person» for itself
 * would be a second reading path, silently diverging from the first.
 *
 * TIMESTAMPS: enqueue stamps enqueuedAt, claimNext stamps claimedAt,
 * complete stamps completedAt — the raw material for post-pilot flow metrics (cycle
 * time, aging WIP). No dashboard in V5; recording them now is three fields, migrating
 * pilot data later would be a chore.
 *
 * A FOURTH ONE, BECAUSE «TAKEN» AND «STILL ALIVE» ARE TWO FACTS. `touch` renews the lease, and
 * a durable backend renews it by restamping the very clock it recorded the claim on — so for as
 * long as one field answered both questions, every running task reported a duration of about
 * zero, refreshed every couple of minutes, while the work actually ran for an hour. `claimedAt`
 * is now the moment the attempt in flight was taken and is never moved by a renewal;
 * `leaseRenewedAt` is the renewal clock, and it is what a liveness sweep must read. Both are
 * null while nothing holds the task. The contract suite asserts the difference on every backend
 * — a backend that keeps answering both from one clock is not a conforming adapter.
 *
 * Node built-ins only — ONE of them, and it is named here because this file used to need
 * none: the randomness the attempt token is minted from. A token derived from anything this
 * module could compute (a counter, a clock, an id) would be guessable by the very caller it
 * fences out. `clock` is dependency-injected so the liveness/expiry path is deterministic in
 * tests; the randomness is NOT injected, because a test that could predict a token would be
 * certifying a fence with a hole in it. The contract suite reads the vitest API from
 * globalThis (test.globals) — NO top-level vitest import, so the production daemon can
 * import this module without dev dependencies.
 */

import { randomBytes } from 'node:crypto'

// ── constants (the closed vocabularies) ──

/** Task intake origins. `backlog` = BL-item scan, `roster` = a founder button, `return` = requeue-with-comment. */
export const TASK_SOURCES = Object.freeze(['backlog', 'roster', 'return'])

/** Execution lanes. `forge` = draft generation for the «Создатель» role. */
export const TASK_LANES = Object.freeze(['prod', 'research', 'paperwork', 'forge'])

/**
 * THE CLOSED STATUS VOCABULARY of a read row — every `list()` row and every `stats()` key
 * of every backend is one of these five, and a backend that answers anything else is not a
 * conforming adapter.
 *
 *   queued            — waiting for a WORKER
 *   claimed           — a worker holds it
 *   awaiting_approval — the work is done and certified, and now owes a PERSON a word
 *   completed         — a person said yes
 *   failed            — the attempt did not produce
 *
 * `awaiting_approval` is here rather than derived on a screen for one reason: a durable
 * backend already RECORDS that state (the daemon's own approval row), so deriving it a
 * second time in the front would be a second source of the same truth. The two would
 * disagree the first time either changed, and nothing would say so.
 */
export const TASK_STATUSES = Object.freeze([
  'queued',
  'claimed',
  'awaiting_approval',
  'completed',
  'failed',
])

/**
 * The human-readable failure taxonomy. `fail(taskId, reason)` accepts ONLY
 * these; the roster renders the RU подпись from REASON_LABELS, never the raw code.
 *   no_receipt      — the exit gate produced no reverify receipt
 *   no_journal      — the attempt left no approach note: the work may be
 *                     certified, but it never explained itself, and an unexplained attempt
 *                     is incomplete by the same law that makes an uncertified one incomplete
 *   agent_error     — the worker process errored
 *   provider_error  — the run the WORKER DID NOT END: the vendor refused mid-word (an
 *                     overload, a server error) and the CLI stopped. Kept apart from
 *                     agent_error because a live attempt killed by a 529 used to reach the
 *                     window as «нет записки о подходе» — the note could not exist, the
 *                     worker was cut off writing it — and the two ask a person for opposite
 *                     things: wait and press again, or go and fix something
 *   turns_exhausted — the run WE ended: the attempt reached the turn ceiling this daemon put
 *                     on its own command line and stopped there, leaving neither note nor
 *                     receipt because it was stopped. Apart from provider_error because the
 *                     decision was ours, and the remedy is a bigger ceiling or a smaller task
 *   tests_red       — a red reverify receipt (targeted tests failed)
 *   needs_decision  — the worker surfaced a call only a human can make
 *   missing_access  — credentials / permissions absent
 *   no_artifact     — a DOCUMENTARY stage claimed to be done and left no document: the file
 *                     its stage is supposed to produce is absent from the phase directory, or
 *                     it is on disk but was never committed. It is the exact counterpart of
 *                     `no_receipt` for work whose product is prose rather than code — the two
 *                     exist so that «done» is never the worker's own word on either side
 *   personal_layer_error — the layer the founder himself works under could not be put into
 *                     the worker’s account before the spawn. NOT an infra cause and not the
 *                     worker’s fault: a session started without those files runs under rules
 *                     nobody chose — his instructions absent, his hooks silent, and whatever
 *                     hosted connectors the vendor felt like attaching that minute. Refusing
 *                     by name costs one attempt; spawning anyway spends the subscription on
 *                     work done under the wrong profile, and no card could ever say so
 *   timeout / runtime_offline / window_exhausted — infra causes
 *   manual          — a human stopped it
 */
/**
 * THE QUEUE'S OWN LAST WORD ABOUT A ROW IT WILL NOT HAND OUT AGAIN.
 *
 * Named apart from every worker's reason because nothing is wrong with the WORK here and
 * nobody did anything wrong: the row simply used up the re-issues it was given, and the queue
 * stopped. A person reading `tests_red` goes and looks at tests; a person reading this one
 * either raises the ceiling or cuts the task in half — the same distinction `turns_exhausted`
 * already draws for a ceiling of a different kind. Kept apart from `timeout` too: a lease
 * timing out is what STARTS a re-issue and is survivable, and using one name for both would
 * make «it timed out again» and «it will never be tried again» indistinguishable on a card.
 */
export const ATTEMPTS_EXHAUSTED = 'attempts_exhausted'

export const FAIL_REASONS = Object.freeze([
  'no_receipt',
  'no_journal',
  // THE THIRD CONDITION: the attempt left neither a lesson nor a word about why there is
  // none. Kept apart from no_journal because the two omissions are different facts — the
  // note explains THIS work to the person accepting it, the lesson is what the next attempt
  // gets to start from. A machine cannot judge whether a lesson was worth writing, so it
  // judges only whether the worker answered the question at all.
  'no_lesson',
  'no_artifact',
  'agent_error',
  'provider_error',
  // THE RUN THE WORKER DID NOT END EITHER — but this one WE ended. The attempt walked into the
  // turn ceiling this daemon itself put on its command line and stopped there in silence: no
  // note, no receipt, nothing to judge. Kept apart from provider_error because the cause is
  // ours rather than the vendor's, and the two ask a person for different things — «wait and
  // press again» against «raise the ceiling or cut the task in half». Kept apart from
  // agent_error because nothing is wrong with the work: a card saying «ошибка работника» here
  // sends somebody to fix a number he set himself.
  'turns_exhausted',
  'tests_red',
  'needs_decision',
  'missing_access',
  'timeout',
  'runtime_offline',
  'window_exhausted',
  // THE RE-ISSUES RAN OUT. Not the worker's failure and not an outage: the row was handed
  // back as many times as it was allowed to be, and the queue closed it rather than spending
  // another paid attempt on the same work. See ATTEMPTS_EXHAUSTED above.
  ATTEMPTS_EXHAUSTED,
  'personal_layer_error',
  'manual',
])

/** RU подписи для красной карточки ростера — единственный источник: сервер передаёт, экран рендерит. */
export const REASON_LABELS = Object.freeze({
  no_receipt: 'нет квитанции — работа не подтверждена',
  no_journal: 'нет записки о подходе — попытка не объяснена',
  no_lesson: 'нет урока — попытка не оставила ни заметки, ни причины',
  no_artifact: 'нет документа — стадия не оставила своего файла',
  agent_error: 'ошибка работника',
  provider_error: 'оборвал провайдер — работник тут ни при чём, попробуйте ещё раз',
  turns_exhausted: 'упёрся в потолок ходов — работа не доделана, поднимите потолок или разбейте задачу',
  tests_red: 'тесты красные',
  needs_decision: 'нужно решение человека',
  missing_access: 'нужен человек: не хватает доступа',
  timeout: 'истекло время',
  runtime_offline: 'среда исполнения недоступна',
  window_exhausted: 'окно подписки исчерпано',
  [ATTEMPTS_EXHAUSTED]: 'попытки исчерпаны — очередь больше не перевыдаёт эту работу',
  personal_layer_error: 'личный слой не перенесён в аккаунт работника — запускать было нельзя',
  manual: 'остановлено вручную',
})

/**
 * THE ONE LIVENESS VALUE. Two mechanisms answer «has this worker gone silent»: the tick's
 * explicit sweep (liveness.mjs) and the queue's own lease expiry inside the backend. They
 * are belt and suspenders for the SAME event, so they must read the same number — and until
 * now they did not: the config's value reached the sweep, the backend was constructed
 * without it, and its lease ran on the built-in default no matter what the operator wrote.
 * Nothing said so; the two clocks simply disagreed. The constant and the resolver live HERE,
 * in the interface both the sweep and every backend already build against, so neither side
 * owns a private copy of the number.
 */
export const DEFAULT_EXPIRE_MS = 120000

/**
 * THE ONE ATTEMPT BORDER. How many times a row may be handed back after a lost lease —
 * the ceiling `fail`/expiry is measured against, in ONE place for every backend.
 *
 * It lives here, beside the lease duration, for the same reason that one does: two mechanisms
 * answer «may this be tried again» — the durable queue's own re-issue plan and the reference
 * backend's sweep — and until this constant existed they answered DIFFERENTLY. The durable one
 * has always refused past its limit; the reference one, which is the executable spec every
 * other backend is written against, had no limit at all and re-issued for ever. Nothing said
 * so: the suite asked neither backend the question.
 *
 * The number is the one the durable seeding already used, so nothing about live behaviour
 * moves — it is lifted out of a literal at the send call, not invented here.
 *
 * A PIECE OF A BATCH GETS ZERO, and that is a decision, not a tuning: the library's own retry
 * is exactly the silent repetition the owner forbade — a piece that broke must STOP its
 * assembly and ask him, and a queue quietly running it again two more times is the loop that
 * cost a day. It has been true of the durable backend since that day; it is stated here so it
 * is true of every backend.
 */
export const DEFAULT_RETRY_LIMIT = 2
export const BATCH_ITEM_RETRY_LIMIT = 0

/**
 * resolveExpireMs(config) → the liveness/lease duration in ms for THIS config.
 *
 * A hand-edited config file is a trust boundary and this number does not stay inside the
 * process: the backend divides it by 1000 and hands `expireInSeconds` to the queue. So
 * anything that is not a positive finite number — `"5m"`, 0, a negative, NaN, Infinity —
 * falls back to the default rather than travelling on as a lease made out of a typo. PURE.
 *
 * @param {{expireMs?:number}} [config]
 * @returns {number}
 */
export function resolveExpireMs(config) {
  const raw = config && typeof config === 'object' ? config.expireMs : undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_EXPIRE_MS
  return raw
}

const PROVIDERS = Object.freeze(['claude', 'codex', 'api'])
const FORGE_KINDS = Object.freeze(['agent', 'skill', 'mcp'])
const STORY_POINTS = Object.freeze([1, 2, 3, 5, 8, 13]) // Fibonacci ONLY

/**
 * WHAT KIND OF WORK THIS IS — and therefore WHICH EXIT GATE it must pass.
 *
 *   code     — the product changes. Done = a green reverify receipt (the original law).
 *   document — a stage of the phase cycle changes documents. Done = the document its stage
 *              is supposed to produce, on disk AND committed.
 *
 * The distinction rides in `data` rather than in a new LANE on purpose: a lane is a routing
 * dimension (which worker, which window), and these two are routed identically. Adding a
 * fifth lane would have made every lane table, every envelope and every eligibility probe
 * grow a member that means nothing to any of them.
 */
export const TASK_KINDS = Object.freeze(['code', 'document'])

/**
 * The stages of the phase cycle a task may stand for. The exit gate asks a different question
 * of each, so the vocabulary is CLOSED: a stage nobody declared cannot silently pick the
 * loosest gate. `execute` is the one stage whose product is code AND whose questions are
 * documents — which is exactly why it is named here alongside the other three.
 */
export const TASK_STAGES = Object.freeze(['discuss', 'plan', 'execute', 'verify'])

/**
 * The role a row plays in its batch — a CLOSED vocabulary of exactly one value, and the one
 * value names the exception rather than the rule.
 *
 * There is deliberately no 'item' here. An item is already recognised by carrying a
 * `batchId`, and a second way of saying the same thing is a second thing that can be wrong:
 * a row marked 'item' with no batch id, or a row with a batch id and no mark, would each
 * have to mean something, and no reader could say what. Only the ROLE THAT CHANGES
 * BEHAVIOUR — the request itself, which no worker may ever be handed — is declared.
 */
export const BATCH_PARENT = 'parent'
const BATCH_ROLES = Object.freeze([BATCH_PARENT])

/**
 * The keys the `data` envelope may carry — a field allowlist inside the field allowlist.
 *
 * `skipped` and `cancelled` belong to the REQUEST row and to nothing else: they are the owner's
 * own word about a stopped assembly («этот кусок пропускаем», «сборку отменяем»), and a word
 * somebody said is not derivable from any status — it has to be written down or it is lost on
 * the next read. They are declared here, in the same closed vocabulary as everything else that
 * travels, so a typo cannot invent a third kind of decision.
 *
 * `wave` is the ECHELON of execution a task belongs to — several plans of one phase are worked
 * at once, then the next several. It is declared beside `phase` and behaves exactly like it:
 * OPTIONAL, and absent rather than guessed. A source that does not know which echelon it is
 * producing work for writes no key at all — an invented «wave 1» would make that work stoppable
 * by an order nobody gave about it.
 */
const ALLOWED_DATA_KEYS = Object.freeze(['kind', 'stage', 'phase', 'wave', 'batch', 'skipped', 'cancelled'])

/** The explicit field allowlist — the ONLY keys a task record carries (notify.mjs explicit-pick posture). */
const ALLOWED_TASK_KEYS = Object.freeze([
  'id', 'source', 'title', 'lane', 'provider', 'model', 'effort',
  'priority', 'attempt', 'storyPoints', 'description', 'acceptance', 'note', 'project', 'batchId', 'forge', 'data',
  // HOW MANY RE-ISSUES THIS WORK IS OWED, travelling on the task itself rather than as an
  // argument of one backend's enqueue: the durable queue stores it ON THE ROW (its own
  // `retry_limit` column, written at send), so a border kept anywhere else would be a second
  // copy of a number the queue already holds — and the two would part company the first time
  // either moved. Optional: a source that names none gets the default (see retryLimitOf).
  'retryLimit',
  // ЧТО ЧЕЛОВЕК ЗНАЕТ ОБ ЭТОЙ ЗАДАЧЕ И ЧЕГО НЕ ЗНАЕТ РАБОТНИК — снимок контекста, живущий
  // НА СТРОКЕ и нигде больше. Одно имя на всех швах: словарь, валидатор, двери, строитель
  // промпта, дверь карточки. Всё остальное — файл в рабочей копии, забор в промпте, панель
  // окна — это МАТЕРИАЛИЗАЦИИ этой строки, а не вторые её копии: снимок, положенный ещё
  // куда-нибудь, разъедется с ней при первой же правке, и тогда работник получит один
  // текст, а человек будет смотреть на другой.
  //
  // ЭТО ДАННЫЕ, А НЕ КОМАНДА. Текст пишет человек, и в промпт он поедет за забором, как
  // конспект-передача, — приклеивать его к инструкциям нельзя ни здесь, ни ниже по течению.
  //
  // НЕ ЕДЕТ В КАЖДЫЙ ПОЛЛ. Читающая форма строки (см. row() ниже) его НЕ отдаёт намеренно:
  // окно перечитывает список по нескольку раз в секунду, а снимок нужен дважды за попытку —
  // при провизии рабочей копии и когда человек открыл карточку. Отдаёт его дверь карточки.
  'taskContext',
])

/**
 * How many criteria one promise may carry. A CEILING, not a target — a task whose success is
 * described by more than a dozen separate sentences is a task nobody will read to the end,
 * and an unbounded list is an unbounded prompt paid for on every attempt.
 */
export const CAP_ACCEPTANCE_ITEMS = 12

/**
 * acceptanceItems(acceptance) → the promise as a LIST, whichever shape it was written in.
 *
 * THE ONE READING PATH for `acceptance` in the whole product: a string is a list of one, a
 * list is itself, anything else is nothing. Empty and blank entries are dropped, because a
 * blank criterion rendered as a bullet is a promise nobody made.
 *
 * Exported so the prompt builder, the read model behind the screen and the doors all ask the
 * same function. Two of them branching on `Array.isArray` for themselves is two chances to
 * disagree about what an old row promised.
 *
 * @param {string|string[]|null|undefined} acceptance
 * @returns {string[]}
 */
/**
 * The statuses a task's words may still be edited in — the ones where the work is NOT over.
 *
 * A promise is edited BEFORE it is judged, never after. Rewriting what «done» meant on a task
 * that already produced, failed or is waiting for a person would rewrite the standard the work
 * was measured by, after the measuring — and the row would then read as though it had always
 * promised that. Both backends refuse it and the contract suite says so.
 */
export const WORDS_EDITABLE_STATUSES = Object.freeze(['queued', 'claimed'])

/**
 * validateWords(patch) → the same patch, gated by exactly the caps an enqueue applies.
 *
 * It runs the ENQUEUE GATE ITSELF over a synthetic task rather than restating the ceilings,
 * so a criterion cannot be longer, or a list bigger, through the editing door than through the
 * door that put the task there. Two copies of a cap are two caps, and the looser one is the
 * one that matters. Throws InvalidTaskError; the caller turns that into its own refusal.
 *
 * The DoR gate is deliberately NOT re-applied: readiness is a question asked of a task on its
 * way IN, and a task that is already in the queue was answered once.
 *
 * @param {{description?:string, acceptance?:(string|string[])}} [patch]
 * @returns {{description?:string, acceptance?:(string|string[])}}
 */
export function validateWords(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new InvalidTaskError('words must be an object')
  }
  const probe = { id: 'words', source: 'roster', title: 'words', lane: 'prod' }
  if (patch.description !== undefined) probe.description = patch.description
  if (patch.acceptance !== undefined) probe.acceptance = patch.acceptance
  validateTask(probe)
  const out = {}
  if (patch.description !== undefined) out.description = patch.description
  if (patch.acceptance !== undefined) out.acceptance = patch.acceptance
  return out
}

export function acceptanceItems(acceptance) {
  if (Array.isArray(acceptance)) {
    return acceptance.filter((s) => typeof s === 'string').map((s) => s.trim()).filter((s) => s !== '')
  }
  if (typeof acceptance !== 'string') return []
  const one = acceptance.trim()
  return one === '' ? [] : [one]
}

/**
 * isBatchParent(taskOrRow) → is this the REQUEST of a batch rather than a piece of its work?
 *
 * ONE predicate for a task on its way in and for a row on its way out, because both carry the
 * envelope under the same name — and because a backend, a door and a screen answering this
 * question three times in three files is three chances to answer it differently. PURE; a
 * nullish argument is simply not a parent.
 *
 * @param {object|null} taskOrRow
 * @returns {boolean}
 */
export function isBatchParent(taskOrRow) {
  const env = taskOrRow && typeof taskOrRow === 'object' ? taskOrRow.data : null
  return !!env && typeof env === 'object' && env.batch === BATCH_PARENT
}

/**
 * retryLimitOf(task) → HOW MANY TIMES THIS WORK MAY BE HANDED BACK after a lost lease.
 *
 * The one place the border is decided, for every backend: the durable one maps the answer onto
 * its library's `retry_limit` at send, the reference one measures its own sweep against it.
 * Written as a function rather than as a constant read at two call sites because the answer
 * depends on WHAT THE WORK IS — a piece of a batch is never repeated by itself — and that rule
 * had lived as a literal inside one backend's enqueue, where the other backend could not see it.
 *
 * A task that names its own border gets it (the gate has already refused anything that is not
 * a whole number of retries). PURE.
 *
 * @param {object|null} task
 * @returns {number}
 */
export function retryLimitOf(task) {
  const named = task && typeof task === 'object' ? task.retryLimit : undefined
  if (typeof named === 'number' && Number.isInteger(named) && named >= 0) return named
  const piece = !!task && !isBatchParent(task) && typeof task.batchId === 'string'
  return piece ? BATCH_ITEM_RETRY_LIMIT : DEFAULT_RETRY_LIMIT
}

/** Epoch ms out of a timestamp that may arrive as a number or as an ISO string; NaN otherwise. */
function msOf(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : NaN
}

/**
 * compareBatchItems(a, b) → the ONE order the pieces of a batch are read in.
 *
 * BY IDENTIFIER, NUMERICALLY, and only then by arrival. A piece's place in an assembly is
 * where its owner put it — the door mints the pieces of one press as `<batch>-1`, `<batch>-2`
 * — and that place must not move because the piece was TOUCHED later: a piece he asked to
 * repeat comes back to its own position, not to the end of the queue behind work that was
 * meant to follow it. The numeric comparison is what keeps the tenth piece after the second.
 *
 * Exported so the queue (whose turn is it) and the read model behind the screen (in which
 * order are they drawn) can never answer «which piece is next» differently.
 *
 * @param {{id:string, enqueuedAt?:number|string}} a
 * @param {{id:string, enqueuedAt?:number|string}} b
 * @returns {number}
 */
export function compareBatchItems(a, b) {
  const byId = String(a && a.id).localeCompare(String(b && b.id), undefined, { numeric: true })
  if (byId !== 0) return byId
  return (msOf(a && a.enqueuedAt) || 0) - (msOf(b && b.enqueuedAt) || 0)
}

/**
 * batchDecisionsOf(requestRow) → `{skipped:string[], cancelled:boolean}` — what the owner has
 * already said about this assembly. Tolerant by construction: a row written before the fields
 * existed, or one carrying rubbish in them, reads as «he has said nothing yet» rather than
 * throwing inside a claim path.
 *
 * @param {object|null} requestRow
 * @returns {{skipped:string[], cancelled:boolean}}
 */
export function batchDecisionsOf(requestRow) {
  const env = requestRow && typeof requestRow === 'object' ? requestRow.data : null
  const raw = env && typeof env === 'object' ? env : {}
  return {
    skipped: Array.isArray(raw.skipped) ? raw.skipped.filter((x) => typeof x === 'string') : [],
    cancelled: raw.cancelled === true,
  }
}

/**
 * latestRowPerId(rows) → the same rows with at most ONE row per task id, the newest kept.
 *
 * A repeated piece is enqueued under its own id again (the same door `/api/return` has always
 * used), and a durable queue keeps the previous job row beside the new one. Two rows for one
 * piece would make the turn rule see a failure that the owner has already answered — so the
 * rule reads the LAST word about each id and nothing older.
 *
 * EXPORTED so the queue (whose turn is it, has this piece been answered) and the read model
 * behind the screen (how many tasks are waiting for a word) can never answer «what is the last
 * word about this task» differently. The screen learned the same lesson the hard way: while a
 * returned task was being redone it was counted twice, because the rows were filtered by status
 * and nothing folded them by task. One sentence, written once.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function latestRowPerId(rows) {
  const live = (r) => r.status === 'queued' || r.status === 'claimed'
  const out = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const i = out.findIndex((x) => x.id === r.id)
    if (i < 0) {
      out.push(r)
      continue
    }
    const prev = out[i]
    const dt = (msOf(prev.enqueuedAt) || 0) - (msOf(r.enqueuedAt) || 0)
    // Two rows stamped in the same millisecond (a repeat asked for the moment the failure was
    // seen) are separated by which of them is STILL ALIVE: the last word about a piece the
    // owner asked for again is the row a worker can still take, never the one it broke on.
    out[i] = dt > 0 || (dt === 0 && (live(prev) || !live(r))) ? prev : r
  }
  return out
}

/**
 * batchItemsOf(rows, batchId, decisions) → the pieces of ONE batch, deduped and in order.
 * Exported for the read model, which draws exactly this list.
 *
 * @param {object[]} rows every queue row (requests may be among them; they are not pieces)
 * @param {string} batchId
 * @returns {object[]}
 */
export function batchItemsOf(rows, batchId) {
  const all = Array.isArray(rows) ? rows : []
  return latestRowPerId(all.filter((r) => r && r.batchId === batchId && !isBatchParent(r))).sort(compareBatchItems)
}

/**
 * batchHeldOf(rows) → the ids of the waiting pieces that MAY NOT be handed out right now,
 * because it is not their turn. At most one piece of a batch is ever left out of this list.
 *
 * WHY IT NAMES THE WITHHELD ONES RATHER THAN THE TURN. A piece whose request row is not (yet)
 * in the queue is deliberately NOT governed by this rule: the door writes the request LAST, so
 * a half-written batch reads as loose work a person can simply run — and a rule that listed
 * «the turns» would have quietly frozen every such piece forever. Silence here means «this is
 * ordinary work», which is the safe meaning of the two.
 *
 * PURE, and the SINGLE place the rule lives. The reference backend keeps the promise by
 * skipping the pieces named here; the durable one by holding every piece at the queue and
 * releasing the ones NOT named. Two mechanisms, one sentence — which is why the contract suite
 * asserts the sentence rather than either mechanism.
 *
 * @param {object[]} rows every queue row, requests included
 * @returns {string[]}
 */
export function batchHeldOf(rows) {
  const all = Array.isArray(rows) ? rows : []
  const held = []
  for (const req of all.filter(isBatchParent)) {
    const batchId = req.batchId || req.id
    const { skipped, cancelled } = batchDecisionsOf(req)
    const items = batchItemsOf(all, batchId).filter((r) => !skipped.includes(r.id))
    const waiting = items.filter((r) => r.status === 'queued')
    // AN ABANDONED ASSEMBLY HANDS OUT NOTHING, ever again. Its unstarted pieces are taken out
    // of the queue by the door that recorded the word; this is the belt to that braces.
    // A PIECE UNDER WAY holds the whole assembly — one worker, one piece at a time.
    // A BROKEN PIECE STOPS IT and asks its owner: nothing is repeated by itself, so the rest
    // stays withheld until he says skip, repeat or cancel.
    const stopped =
      cancelled || items.some((r) => r.status === 'claimed') || items.some((r) => r.status === 'failed')
    for (let i = 0; i < waiting.length; i += 1) {
      if (stopped || i > 0) held.push(waiting[i].id)
    }
  }
  return held
}

/**
 * waveAddressOf(taskOrRow) → `{phase, wave}` as STRINGS, or null when the row names no echelon.
 *
 * BOTH HALVES OR NOTHING. An echelon is «волна 2 ФАЗЫ 14», never «волна 2» — the second plan of
 * one phase and the second plan of another are different work, and an address that dropped the
 * phase would stop them together. A row carrying only one of the two names no echelon at all,
 * and is therefore untouched by every rule below.
 *
 * @param {object|null} taskOrRow
 * @returns {{phase:string, wave:string}|null}
 */
export function waveAddressOf(taskOrRow) {
  const env = taskOrRow && typeof taskOrRow === 'object' ? taskOrRow.data : null
  if (!env || typeof env !== 'object') return null
  const ok = (v) => typeof v === 'string' || typeof v === 'number'
  if (!ok(env.phase) || !ok(env.wave)) return null
  const phase = String(env.phase).trim()
  const wave = String(env.wave).trim()
  if (phase === '' || wave === '') return null
  return { phase, wave }
}

/**
 * normalizeWaveHolds(holds) → the stop list as `[{phase, wave}]` of trimmed strings.
 *
 * TOLERANT ON PURPOSE. The list is read off a written register that a person's door appends to,
 * and it is consulted inside the claim path: a torn line or a stray shape must cost the claim
 * nothing at all. Anything unreadable is simply not an order.
 *
 * @param {any} holds
 * @returns {{phase:string, wave:string}[]}
 */
export function normalizeWaveHolds(holds) {
  if (!Array.isArray(holds)) return []
  const out = []
  for (const h of holds) {
    const addr = h && typeof h === 'object' ? waveAddressOf({ data: { phase: h.phase, wave: h.wave } }) : null
    if (addr && !out.some((x) => x.phase === addr.phase && x.wave === addr.wave)) out.push(addr)
  }
  return out
}

/**
 * waveHeldOf(rows, holds) → the ids of the WAITING rows a stopped echelon may not hand out.
 *
 * PURE, and the SINGLE place this rule lives — the twin of `batchHeldOf` and deliberately built
 * the same way. The reference backend keeps the promise by skipping the ids named here; the
 * durable one by deferring their rows and putting back the ones no longer named. The contract
 * suite asserts the sentence, not either mechanism.
 *
 * THE ADDRESS IS EXACT AND THE SILENCE IS SAFE. Only a row that names BOTH a phase and a wave
 * matching an order is withheld: another echelon of the same phase, another phase entirely, and
 * every task that never said which echelon it belongs to keep moving. A stop that widened to
 * «everything nearby» would be the founder's own machine going quiet for a reason he cannot see.
 *
 * Only rows still WAITING are named. Work already under way is not un-handed by a list — it is
 * asked to finish its current step and stand (the loop does that through the steering channel
 * the founder already has), because killing a live session is exactly what a stop must not do.
 *
 * @param {object[]} rows every queue row
 * @param {{phase:any, wave:any}[]} holds
 * @returns {string[]}
 */
export function waveHeldOf(rows, holds) {
  const list = normalizeWaveHolds(holds)
  if (list.length === 0) return []
  const all = Array.isArray(rows) ? rows : []
  const held = []
  for (const r of all) {
    if (!r || typeof r !== 'object') continue
    if (r.status !== undefined && r.status !== 'queued') continue
    const addr = waveAddressOf(r)
    if (!addr) continue
    if (list.some((h) => h.phase === addr.phase && h.wave === addr.wave)) held.push(r.id)
  }
  return held
}

/**
 * batchWorkerOf(rows, batchId, exceptId) → the worker this assembly is pinned to, or null.
 *
 * The pieces of one batch belong to ONE worker («один работник, по одному за раз»), and which
 * worker that is only becomes known when the first piece is routed. So it is not stored: it is
 * read back off the pieces themselves — the last one that named an executor.
 *
 * `exceptId` is the piece being routed RIGHT NOW, and passing it is not optional politeness: a
 * task is checked out by the daemon before a worker is chosen for it, so the row of the piece
 * in flight already names an executor — the daemon itself — and reading that back as «the
 * assembly's worker» would answer the question with the question.
 *
 * @param {object[]} rows
 * @param {string} batchId
 * @param {string} [exceptId]
 * @returns {string|null}
 */
export function batchWorkerOf(rows, batchId, exceptId) {
  if (!batchId) return null
  const items = batchItemsOf(rows, batchId).filter((r) => r.id !== exceptId)
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (typeof items[i].workerId === 'string' && items[i].workerId !== '') return items[i].workerId
  }
  return null
}

/**
 * The project slug grammar. A LOCAL constant, not an import: this module must
 * stay free of the config module to keep the backend-free/import-free law intact. Kept in
 * agreement with config.mjs's PROJECT_ID_RE by the tests on both sides.
 */
const TASK_PROJECT_RE = /^[a-z0-9-]{1,64}$/

/**
 * The batch identifier grammar. It is minted by a door from a clock, but it ARRIVES on the
 * wire like everything else, and it ends up inside a `data->>` comparison and beside task ids
 * in logs — so it is bounded and spelled out here rather than trusted for being ours. Same
 * shape and same cap as a task id.
 */
const TASK_BATCH_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * The slug of the project a fresh install starts with.
 *
 * NOTHING FALLS BACK TO IT ANY MORE, and the name is kept saying so on purpose: this used to
 * be the last resort of a read path that completed a row naming no project, which is exactly
 * the guess this queue no longer makes. A row states its project or states none.
 */
export const DEFAULT_PROJECT_ID = 'default'

/**
 * Заголовок строки очереди — СТРОКА, а не документ.
 *
 * Экспортирован, потому что двери, которые СОБИРАЮТ заголовок из чужого текста (строка
 * бэклога едет в очередь как «идентификатор · слова файла»), обязаны знать, сколько в него
 * влезает. Собственного числа они писать не должны: две копии капа — это два капа, и работает
 * более слабый. До экспорта дверь просто отдавала в ворота то, что получилось, и на настоящем
 * бэклоге с длинными строками вся постановка отвечала отказом (найдено живым прогоном).
 */
export const CAP_TITLE = 200
const CAP_TEXT = 2000

/**
 * Потолок снимка контекста задачи — СВОЙ, и он крупнее потолка описания намеренно.
 *
 * Снимок — это то, что человек рассказывает работнику про мир вокруг задачи: где лежат
 * данные, к кому идти за доступом, чего делать нельзя. Это абзацы, а не строка, поэтому
 * мерить его потолком описания было бы враньём про то, чего мы ждём.
 *
 * И всё же потолок обязателен: снимок едет в промпт И в рабочую копию КАЖДОЙ попытки,
 * а у долговечной очереди — ещё и в payload джоба, который копируется при каждой
 * перевыдаче. Безразмерный снимок — это безразмерный промпт, оплачиваемый на каждой
 * попытке, и распухающая строка в базе. Масштаб взят с потолка конспекта-передачи: тот же
 * род текста — одна сторона пишет, двое читают.
 *
 * Экспортирован, потому что двери, собирающие это поле из чужого ввода, обязаны знать
 * число: две копии капа — это два капа, и работает более слабый.
 */
export const TASK_CONTEXT_CAP = 8000

// ── named errors ──

export class InvalidTaskError extends Error {
  constructor(message) { super(message); this.name = 'InvalidTaskError' }
}
/** DoR gate: a backlog task without a CUE estimate + acceptance is not ready to dispatch. */
export class NotReadyError extends Error {
  constructor(message) { super(message); this.name = 'NotReadyError' }
}
export class InvalidStoryPointsError extends Error {
  constructor(message) { super(message); this.name = 'InvalidStoryPointsError' }
}
/** No self-certified done — complete() refuses without a receiptRef. */
export class NoReceiptError extends Error {
  constructor(message) { super(message); this.name = 'NoReceiptError' }
}
export class InvalidFailReasonError extends Error {
  constructor(message) { super(message); this.name = 'InvalidFailReasonError' }
}
export class UnknownTaskError extends Error {
  constructor(message) { super(message); this.name = 'UnknownTaskError' }
}

// ── the fencing token of an attempt ──

/**
 * ═══════ ОГРАЖДАЮЩИЙ ЖЕТОН ПОПЫТКИ — ОДНО ИМЯ НА ВСЕ ШВЫ ═══════
 *
 * ЧТО ОН ОГРАЖДАЕТ. Завершение, провал и продление адресуют работу ПО НОМЕРУ ЗАДАЧИ и находят
 * ту её строку, которая сейчас идёт, — какой бы попытки та строка ни была. Между захватом и
 * завершением аренда может истечь, очередь перевыдаёт строку другому работнику, а первый —
 * живой и ничего не знающий об отъёме — в конце зовёт завершение и закрывает ЧУЖУЮ, свежую
 * попытку. Это не рассуждение: сценарий снят живым прогоном на настоящей очереди, и в нём
 * закрылась вторая попытка по слову первого, а сам второй работник свою же работу закрыть НЕ
 * СМОГ — активной строки для него уже не было. Дыра отнимает не только чужую работу, но и
 * право закрыть свою.
 *
 * ЖЕТОН СЛУЧАЕН, А НЕ НОМЕР ПОПЫТКИ. Номер уже однажды плавал: счётчик выдач двигался под
 * попыткой, которая этого не заметила, и одна физическая попытка легла в аудит как две (см.
 * attemptNumberOf в долговременном бэкенде). Жетон, выведенный из номера, унаследовал бы ту же
 * болезнь — и «свой» жетон совпал бы с «чужим» ровно там, где различить их и надо.
 *
 * ЖЕТОН НЕ ЕДЕТ В ЧИТАЮЩИЙ ПУТЬ. list() отдаёт строки в окно, а жетон — не описание работы, а
 * право её закрыть: он выдаётся тому, кто захватил, и больше никому. Поэтому его нет ни в
 * одной сборке строки для читателя, и это решение, а не забывчивость.
 */
export const STALE_ATTEMPT_TOKEN = 'stale_attempt_token'

/**
 * ОТКАЗ РАЗЛИЧИМ ОТ УСПЕХА, И ПО ПРЕЦЕДЕНТУ САМИХ МЕТОДОВ: завершение и провал отвечают
 * успехом или БРОСАЮТ названную ошибку, продление отвечает true/false. Поэтому отказ по жетону
 * — именованная ошибка там, где методы бросают, и false там, где метод отвечает. Имя причины
 * одно на всех швах и лежит полем, чтобы звонящему не приходилось разбирать прозу.
 */
export class StaleAttemptError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StaleAttemptError'
    this.reason = STALE_ATTEMPT_TOKEN
  }
}

/**
 * mintAttemptToken() → свежий случайный жетон одной выдачи.
 *
 * ОДНА ЧЕКАНКА НА ОБА БЭКЕНДА: два выражения в двух файлах разъезжаются молча, и тогда «жетон
 * случаен» остаётся правдой в одном месте и надписью в другом.
 */
export function mintAttemptToken() {
  return randomBytes(16).toString('hex')
}

/**
 * attemptTokenIsStale(heldToken, presentedToken) → предъявлен ли ЧУЖОЙ жетон.
 *
 * ДВА «НЕТ» ЗДЕСЬ — РЕШЕНИЯ, НАЗВАННЫЕ ВСЛУХ, А НЕ ДЫРЫ:
 *   • звонящий НЕ предъявил жетона — поведение сегодняшнее. Наш цикл понесёт жетон всегда, но
 *     сторож живости закрывает попытку молчащего работника по праву ВЛАСТИ, а не работника, и
 *     жетона у него нет и быть не должно. Переход обязан кончиться: провод цикла кладётся
 *     следующей работой, и до тех пор это место — единственная дверь, через которую устаревший
 *     работник ещё может пройти;
 *   • у строки НЕТ жетона (она посеяна или захвачена до этого обновления) — отсутствие есть
 *     отсутствие, а не лицензия выдумывать и не повод падать на живой очереди.
 */
export function attemptTokenIsStale(heldToken, presentedToken) {
  if (typeof presentedToken !== 'string' || presentedToken === '') return false
  if (typeof heldToken !== 'string' || heldToken === '') return false
  return heldToken !== presentedToken
}

/**
 * refuseStaleAttempt(method, taskId, heldToken, presentedToken) — бросить названный отказ,
 * если предъявлен чужой жетон; ничего не делать, если жетон свой или его нет.
 */
export function refuseStaleAttempt(method, taskId, heldToken, presentedToken) {
  if (!attemptTokenIsStale(heldToken, presentedToken)) return
  throw new StaleAttemptError(
    `${method}("${taskId}") refused: ${STALE_ATTEMPT_TOKEN} — the attempt this token belongs to ` +
      `is over; the row carries another one now, and closing it would close somebody else's work`,
  )
}

// ── validateTask (the enqueue gate — field allowlist + caps + DoR + forge) ──

/**
 * validateTask(task) → a normalized, explicit-pick copy (defaults applied). Throws a
 * named error on any violation. The single validation path every enqueue routes through.
 *
 * @param {object} task
 * @returns {object} normalized task
 */
export function validateTask(task) {
  if (!task || typeof task !== 'object') throw new InvalidTaskError('task is not an object')
  if (!task.id || typeof task.id !== 'string') throw new InvalidTaskError('task missing string "id"')
  if (!TASK_SOURCES.includes(task.source)) throw new InvalidTaskError(`task "${task.id}" has invalid source "${task.source}"`)
  if (typeof task.title !== 'string' || task.title.length === 0) throw new InvalidTaskError(`task "${task.id}" missing "title"`)
  if (task.title.length > CAP_TITLE) throw new InvalidTaskError(`task "${task.id}" title exceeds ${CAP_TITLE} chars`)
  if (!TASK_LANES.includes(task.lane)) throw new InvalidTaskError(`task "${task.id}" has invalid lane "${task.lane}"`)
  if (task.provider !== undefined && !PROVIDERS.includes(task.provider)) {
    throw new InvalidTaskError(`task "${task.id}" has invalid provider "${task.provider}"`)
  }
  if (task.note !== undefined && String(task.note).length > CAP_TEXT) {
    throw new InvalidTaskError(`task "${task.id}" note exceeds ${CAP_TEXT} chars`)
  }
  if (task.description !== undefined && String(task.description).length > CAP_TEXT) {
    throw new InvalidTaskError(`task "${task.id}" description exceeds ${CAP_TEXT} chars`)
  }
  // СНИМОК КОНТЕКСТА — ТЕКСТ И ТОЛЬКО ТЕКСТ, и слишком длинный снимок дверь ОТВЕРГАЕТ, а не
  // подрезает. Это слова человека: обрезанный на середине мысли абзац уехал бы работнику как
  // законченное указание, и не узнал бы об этом никто — ни тот, кто писал, ни тот, кто читал.
  // Так же ведут себя все прочие поля словаря; форма отказа повторена с них.
  if (task.taskContext !== undefined) {
    if (typeof task.taskContext !== 'string') {
      throw new InvalidTaskError(`task "${task.id}" taskContext must be a string`)
    }
    if (task.taskContext.length > TASK_CONTEXT_CAP) {
      throw new InvalidTaskError(`task "${task.id}" taskContext exceeds ${TASK_CONTEXT_CAP} chars`)
    }
  }
  // ONE FIELD, TWO FORMATS (see the header). A string is what every row written before this
  // existed carries and it is bounded exactly as it always was; a list is bounded twice —
  // per criterion by that same ceiling, and in NUMBER, because a promise nobody capped is a
  // prompt nobody capped, paid for on every attempt of the task.
  if (task.acceptance !== undefined) {
    if (Array.isArray(task.acceptance)) {
      if (task.acceptance.length > CAP_ACCEPTANCE_ITEMS) {
        throw new InvalidTaskError(`task "${task.id}" acceptance carries more than ${CAP_ACCEPTANCE_ITEMS} criteria`)
      }
      for (const item of task.acceptance) {
        if (typeof item !== 'string') {
          throw new InvalidTaskError(`task "${task.id}" acceptance must be a string or a list of strings`)
        }
        if (item.length > CAP_TEXT) {
          throw new InvalidTaskError(`task "${task.id}" acceptance exceeds ${CAP_TEXT} chars`)
        }
      }
    } else if (String(task.acceptance).length > CAP_TEXT) {
      throw new InvalidTaskError(`task "${task.id}" acceptance exceeds ${CAP_TEXT} chars`)
    }
  }
  if (task.priority !== undefined && typeof task.priority !== 'number') {
    throw new InvalidTaskError(`task "${task.id}" priority must be a number`)
  }
  // THE ATTEMPT BORDER IS AN INTEGER OR NOTHING. It travels into the durable queue's own
  // `retry_limit`, an integer column: a border written as text or as a fraction would arrive
  // there as a silent zero or as a driver error months later, and either way the work would
  // be repeated a number of times nobody chose. Refused at the gate, like every other field.
  if (task.retryLimit !== undefined) {
    if (typeof task.retryLimit !== 'number' || !Number.isInteger(task.retryLimit) || task.retryLimit < 0) {
      throw new InvalidTaskError(`task "${task.id}" retryLimit must be a whole number of retries, zero or more`)
    }
  }
  // project: STRUCTURAL only. Whether the slug names a REGISTERED project is
  // the door's question (it owns the config); the adapter never learns the registry.
  if (task.project !== undefined && (typeof task.project !== 'string' || !TASK_PROJECT_RE.test(task.project))) {
    throw new InvalidTaskError(`task "${task.id}" has an invalid project "${task.project}"`)
  }
  // batchId: STRUCTURAL only, exactly like project. Whether a batch with this id has a
  // request row is the DOOR's question — it is the one that writes both halves in one action.
  if (task.batchId !== undefined && (typeof task.batchId !== 'string' || !TASK_BATCH_ID_RE.test(task.batchId))) {
    throw new InvalidTaskError(`task "${task.id}" has an invalid batchId "${task.batchId}"`)
  }

  // forge object: REQUIRED iff lane==='forge', forbidden otherwise
  if (task.lane === 'forge') {
    if (!task.forge || typeof task.forge !== 'object') {
      throw new InvalidTaskError(`forge task "${task.id}" requires a forge object`)
    }
    if (!FORGE_KINDS.includes(task.forge.kind)) {
      throw new InvalidTaskError(`forge task "${task.id}" has invalid forge.kind "${task.forge.kind}"`)
    }
    if (typeof task.forge.description !== 'string' || task.forge.description.length === 0) {
      throw new InvalidTaskError(`forge task "${task.id}" requires a non-empty forge.description`)
    }
    if (task.forge.description.length > CAP_TEXT) {
      throw new InvalidTaskError(`forge task "${task.id}" description exceeds ${CAP_TEXT} chars`)
    }
  } else if (task.forge !== undefined) {
    throw new InvalidTaskError(`non-forge task "${task.id}" must not carry a forge object`)
  }

  // data envelope: OPTIONAL (absent → a plain code task, byte-for-byte today's behaviour), and
  // fail-closed when present. A typo in `kind` or `stage` must never fall through to «code» by
  // default — a document stage silently gated on reverify would fail red forever with nothing
  // saying why, and a code task silently gated on an artifact would complete without one.
  if (task.data !== undefined) {
    if (typeof task.data !== 'object' || task.data === null || Array.isArray(task.data)) {
      throw new InvalidTaskError(`task "${task.id}" data must be an object`)
    }
    for (const key of Object.keys(task.data)) {
      if (!ALLOWED_DATA_KEYS.includes(key)) throw new InvalidTaskError(`task "${task.id}" data has unknown key "${key}"`)
    }
    if (task.data.kind !== undefined && !TASK_KINDS.includes(task.data.kind)) {
      throw new InvalidTaskError(`task "${task.id}" has invalid data.kind "${task.data.kind}"`)
    }
    if (task.data.stage !== undefined && !TASK_STAGES.includes(task.data.stage)) {
      throw new InvalidTaskError(`task "${task.id}" has invalid data.stage "${task.data.stage}"`)
    }
    if (
      task.data.phase !== undefined &&
      typeof task.data.phase !== 'string' &&
      typeof task.data.phase !== 'number'
    ) {
      throw new InvalidTaskError(`task "${task.id}" data.phase must be a string or a number`)
    }
    // The echelon, spelled the same way as the phase it belongs to: a number in most hands, a
    // string in the ones that read it off a plan's own header. Refused when it is neither,
    // because an object here would end up inside a `data->>` comparison meaning nothing.
    if (
      task.data.wave !== undefined &&
      typeof task.data.wave !== 'string' &&
      typeof task.data.wave !== 'number'
    ) {
      throw new InvalidTaskError(`task "${task.id}" data.wave must be a string or a number`)
    }
    if (task.data.batch !== undefined && !BATCH_ROLES.includes(task.data.batch)) {
      throw new InvalidTaskError(`task "${task.id}" has invalid data.batch "${task.data.batch}"`)
    }
    // THE OWNER'S WORD RIDES ON THE REQUEST ROW AND NOWHERE ELSE. A piece carrying «cancelled»
    // would be a second place to look for the same decision, and the two would disagree the
    // first time either moved.
    if ((task.data.skipped !== undefined || task.data.cancelled !== undefined) && !isBatchParent(task)) {
      throw new InvalidTaskError(`task "${task.id}" carries a batch decision but is not a batch request`)
    }
    if (task.data.skipped !== undefined) {
      if (!Array.isArray(task.data.skipped) || task.data.skipped.some((x) => typeof x !== 'string' || !TASK_BATCH_ID_RE.test(x))) {
        throw new InvalidTaskError(`task "${task.id}" data.skipped must be a list of item ids`)
      }
    }
    if (task.data.cancelled !== undefined && typeof task.data.cancelled !== 'boolean') {
      throw new InvalidTaskError(`task "${task.id}" data.cancelled must be a boolean`)
    }
  }

  // A REQUEST THAT NAMES NO BATCH IS NOT A REQUEST. The parent exists to be the thing items
  // hang off; without an id nothing can hang off it, and it would sit in the queue forever as
  // a row no worker may take and no reader can group. Refused at the gate rather than becoming
  // an orphan the front has to learn to ignore.
  if (isBatchParent(task) && task.batchId === undefined) {
    throw new InvalidTaskError(`batch request "${task.id}" requires a batchId`)
  }

  // DoR gate: backlog REQUIRES storyPoints ∈ Fibonacci AND non-empty acceptance.
  // roster/return are founder-explicit and exempt (expedite by nature — no friction).
  if (task.source === 'backlog') {
    // Read through the ONE normalizer, so an empty LIST is as unready as an empty string —
    // a promise of nothing, written in the newer shape, is still a promise of nothing.
    const hasAcceptance = acceptanceItems(task.acceptance).length > 0
    if (task.storyPoints === undefined || !hasAcceptance) {
      throw new NotReadyError(
        `backlog task "${task.id}" is not ready: a backlog task must carry both a storyPoints ` +
          `estimate and acceptance criteria before it can be dispatched`,
      )
    }
    if (!STORY_POINTS.includes(task.storyPoints)) {
      throw new InvalidStoryPointsError(`task "${task.id}" storyPoints must be one of ${STORY_POINTS.join('|')}`)
    }
  } else if (task.storyPoints !== undefined && !STORY_POINTS.includes(task.storyPoints)) {
    // exempt from the DoR requirement, but a supplied estimate must still be valid Fibonacci
    throw new InvalidStoryPointsError(`task "${task.id}" storyPoints must be one of ${STORY_POINTS.join('|')}`)
  }

  // explicit-pick normalized copy (allowlist) + defaults
  const out = {}
  for (const k of ALLOWED_TASK_KEYS) if (task[k] !== undefined) out[k] = task[k]
  // ПУСТОЙ СНИМОК ЕСТЬ ОТСУТСТВИЕ СНИМКА. Поле, которого нет, и поле, в котором пусто, вниз
  // по течению читаются по-разному: пустая строка положила бы в рабочую копию пустой файл, а
  // в промпт — пустой забор, и оба сказали бы «человек ничего не написал» так, будто он писал.
  // Текст, в котором есть хоть что-то, сохраняется КАК ЕСТЬ — его отступы и переносы тоже его.
  if (typeof out.taskContext === 'string' && out.taskContext.trim() === '') delete out.taskContext
  out.priority = typeof task.priority === 'number' ? task.priority : 0
  out.attempt = typeof task.attempt === 'number' && task.attempt >= 1 ? task.attempt : 1
  return out
}

/**
 * withStatedProject(row) → the same row saying exactly what it says about its project:
 * its own when it named one, `null` when it never did.
 *
 * THIS FUNCTION USED TO GUESS. It took the currently selected project and handed it to
 * every row that named none, so a row written before the field existed reported ownership
 * nobody had ever recorded — and reported a DIFFERENT owner the moment the person switched
 * the switcher. The key is kept and set to null rather than dropped: readers ask for it, and
 * «нет такого поля» and «поле есть, а факта нет» are different statements to a screen.
 * Pure; a nullish row passes through.
 *
 * @param {object|null} row
 * @returns {object|null}
 */
export function withStatedProject(row) {
  if (!row || typeof row !== 'object') return row
  if (typeof row.project === 'string' && row.project !== '') return row
  return { ...row, project: null }
}

// ── in-memory reference backend (the executable spec) ──

/**
 * createMemoryQueue({clock, expireMs, activeProject}) — the reference QueueAdapter over
 * plain Maps.
 * Used by the contract suite AND as the executable spec for the pg-boss backend
 * and the future file backend. Any `Map` of live tasks in the DAEMON
 * would be a bug (the tick is stateless by law) — but THIS is the reference backend
 * itself, whose whole job is to hold the durable state a real backend keeps in PG.
 *
 * `activeProject` is the config's currently selected project, injected by the
 * composition root — the adapter never reads the config itself. An ENQUEUE stamps it onto a
 * task that names no project, and that is the only use it has: no read path completes a row
 * with it. A row that predates the field reads back with `project: null`, because that is
 * what it says.
 *
 * @param {{clock?:Function|number, expireMs?:number, activeProject?:string}} [opts]
 * @returns {object} a QueueAdapter
 */
export function createMemoryQueue({ clock = Date.now, expireMs = 15 * 60 * 1000, activeProject } = {}) {
  /** id -> internal record */
  const records = new Map()
  const now = () => (typeof clock === 'function' ? clock() : clock)

  /** Liveness sweep: a claimed task not touched within expireMs returns to queued, attempt+1. */
  function sweep() {
    const t = now()
    for (const rec of records.values()) {
      if (rec.status === 'claimed' && t - rec.lastTouch > expireMs) {
        // HOW MANY TIMES THIS ROW HAS ALREADY BEEN HANDED BACK, against the border it was given.
        // `attempt` is 1-based, so the re-issues spent so far are `attempt - 1` and the one about
        // to happen would be the `attempt`-th.
        //
        // WITHOUT THIS THE SWEEP RE-ISSUED FOR EVER, and «for ever» is not a figure of speech: a
        // task no worker can finish was claimed, went silent, came back, was claimed again — and
        // every turn of that wheel spends a paid attempt on work that already failed the same way.
        // The durable queue has refused past its own limit since the day it was written; this
        // backend is the executable spec, and a spec more generous than every real backend
        // certifies a promise nobody keeps.
        if (rec.attempt > retryLimitOf(rec.task)) {
          rec.status = 'failed'
          // THE QUEUE'S OWN WORD, not a worker's: nothing is wrong with the work, and a row
          // closed with no reason at all reaches a card as «причина не записана».
          rec.failure_reason = ATTEMPTS_EXHAUSTED
          rec.workerId = null
          rec.claimedAt = null
          rec.lastTouch = null
          continue
        }
        rec.status = 'queued'
        rec.workerId = null
        rec.claimedAt = null
        rec.lastTouch = null
        rec.attempt += 1
        rec.task = { ...rec.task, attempt: rec.attempt }
        // THE ATTEMPT TOKEN IS NOT CLEARED HERE, and that is a deliberate copy of what a
        // durable queue does rather than a tidier version of it: its re-issue DELETES the row
        // and INSERTS it back with the payload copied, so the mark of the try that just ended
        // lives on until the next claim overwrites it (measured on the live queue). A
        // reference backend tidier than every real one would certify a promise nobody keeps.
      }
    }
  }

  function row(rec) {
    return withStatedProject({
      id: rec.task.id,
      source: rec.task.source,
      lane: rec.task.lane,
      project: rec.task.project,
      title: rec.task.title,
      priority: rec.task.priority,
      status: rec.status,
      // THE STAGE ENVELOPE TRAVELS ON THE ROW. Without it the only thing a reader could
      // recognise a phase stage by is its title — text a person can retype — and the door
      // that must refuse to start the same stage twice would have nothing to ask. It is the
      // same object the tick reads to choose a gate; carried only when the task has one, so a
      // row of ordinary code work states nothing about a stage rather than carrying a null.
      ...(rec.task.data ? { data: rec.task.data } : {}),
      // THE KINSHIP TRAVELS ON THE ROW, and only when there is one: a row of ordinary work
      // states nothing about a batch rather than carrying a null every grouping would then
      // have to skip. Without it, a reader could group items by nothing but their titles.
      ...(rec.task.batchId ? { batchId: rec.task.batchId } : {}),
      attempt: rec.attempt,
      coalesceCount: rec.coalesceCount,
      workerId: rec.workerId,
      storyPoints: rec.task.storyPoints,
      // THE WORDS OF THE TASK, carried out exactly as they were written in: `acceptance`
      // keeps its shape (string or list) rather than being normalized here, because
      // normalizing on the way OUT would quietly rewrite what an old row says. Every reader
      // calls acceptanceItems() instead — one path, and the row stays the row.
      description: rec.task.description,
      acceptance: rec.task.acceptance,
      enqueuedAt: rec.enqueuedAt,
      // WHEN THE WORK WAS TAKEN, and — a DIFFERENT fact — when its lease was last renewed.
      // A screen asking «how long has this been running» measures from the first, and a sweep
      // asking «is this worker still alive» measures from the second. One field cannot answer
      // both: a durable backend renews the lease by restamping its clock, so a shared field
      // made every live task report a duration of about zero no matter how long it had run.
      // Both are null while nothing holds the task — a waiting row has nothing to measure, and
      // a zero there reads as «just started» rather than as «not started».
      claimedAt: rec.claimedAt,
      leaseRenewedAt: rec.lastTouch ?? null,
      completedAt: rec.completedAt,
      failure_reason: rec.failure_reason,
    })
  }

  async function enqueue(task) {
    const norm = validateTask(task)
    // a task that names no project joins the currently active one.
    if (norm.project === undefined && activeProject) norm.project = activeProject
    const existing = records.get(norm.id)
    if (existing && existing.status === 'queued') {
      // Pattern 5: ONE pending entry per item — coalesce, keep the original enqueuedAt.
      existing.coalesceCount += 1
      return { id: norm.id, coalesced: true, coalesceCount: existing.coalesceCount }
    }
    const t = now()
    records.set(norm.id, {
      task: norm,
      status: 'queued',
      coalesceCount: 1,
      attempt: norm.attempt,
      workerId: null,
      enqueuedAt: t,
      claimedAt: null,
      completedAt: null,
      lastTouch: null,
      /** The fencing token of the attempt in flight; null while nobody holds the row. */
      attemptToken: null,
      result: null,
      failure_reason: null,
    })
    return { id: norm.id, coalesced: false, coalesceCount: 1 }
  }

  async function claimNext(workerId, { lanes, holds } = {}) {
    sweep()
    // lanes:[] → nothing eligible, return null WITHOUT mutating anything.
    if (Array.isArray(lanes) && lanes.length === 0) return null
    const laneSet = Array.isArray(lanes) ? new Set(lanes) : null
    // WHOSE TURN IS IT. Computed from this backend's own rows, by the rule that lives in one
    // place for the whole product: a piece of a batch waits while another piece of the SAME
    // batch is under way, while a broken one is waiting for its owner's word, and after he has
    // abandoned the assembly. Work of every other kind is untouched by it.
    const rows = [...records.values()].map(row)
    const held = batchHeldOf(rows)
    // AND WHICH ECHELON HAS BEEN STOPPED. A second rule, the same shape: the orders arrive from
    // the caller (they live in a register on disk, which this module may not read — it stays
    // free of the filesystem), and they name phase+wave exactly. Everything else moves.
    const waveHeld = waveHeldOf(rows, holds)

    let best = null
    for (const rec of records.values()) {
      if (rec.status !== 'queued') continue
      if (held.includes(rec.task.id)) continue
      if (waveHeld.includes(rec.task.id)) continue
      // THE REQUEST OF A BATCH IS NOT WORK. Handing it to a worker would dispatch «разгреби
      // мелочь перед демо» as a task of its own, in parallel with the very items it was
      // broken into. Skipped BEFORE the ordering so no priority and no arrival time can
      // surface it — the durable backend keeps the same promise by never putting a parent in
      // a lane queue at all.
      if (isBatchParent(rec.task)) continue
      if (laneSet && !laneSet.has(rec.task.lane)) continue
      if (!best) { best = rec; continue }
      if (rec.task.priority > best.task.priority) best = rec
      else if (rec.task.priority === best.task.priority && rec.enqueuedAt < best.enqueuedAt) best = rec
    }
    if (!best) return null

    const t = now()
    best.status = 'claimed'
    best.workerId = workerId
    best.claimedAt = t
    best.lastTouch = t
    // A FRESH TOKEN PER HAND-OUT, minted here and nowhere else: this is the only moment an
    // attempt begins, so it is the only moment a token may be born. The previous attempt's
    // token dies by being overwritten — the worker still holding it can no longer close the
    // row, which is the entire promise.
    best.attemptToken = mintAttemptToken()
    // The token travels ON THE CLAIM and only on the claim: it is what this worker will have
    // to present to close its own work. It is not part of the row every reader sees (see the
    // read shape above, which does not carry it).
    return withStatedProject({ ...best.task, attemptToken: best.attemptToken })
  }

  async function touch(taskId, { attemptToken } = {}) {
    const rec = records.get(taskId)
    if (!rec || rec.status !== 'claimed') return false
    // A STALE WORKER MAY NOT HOLD SOMEBODY ELSE'S ATTEMPT ALIVE. `false` is this method's own
    // way of saying no — the same answer it already gives about a row nobody holds.
    if (attemptTokenIsStale(rec.attemptToken, attemptToken)) return false
    rec.lastTouch = now()
    return true
  }

  /**
   * assignWorker(taskId, workerId) — record WHICH worker executes a claimed task.
   *
   * The claim is made by the daemon; routing picks the worker one step later, so the
   * executing identity is only knowable after the checkout. Every reader of «who is busy»
   * — the board, the worker strip, the busy counter — matches a claimed row's workerId
   * against the configured workers, so a row that never gets one reads as nobody working.
   */
  async function assignWorker(taskId, workerId) {
    const rec = records.get(taskId)
    if (!rec || rec.status !== 'claimed') return false
    rec.workerId = workerId ?? null
    return true
  }

  /**
   * resolveBatch(batchId, {skip, cancel}) — write down the OWNER'S WORD about a stopped
   * assembly, and make it take effect. Returns false when no such request row exists.
   *
   * `skip` names the piece he chose to leave out: it is remembered on the request row, stops
   * holding the assembly, and the next piece becomes the turn. `cancel` abandons the assembly:
   * the word is remembered AND every piece still IN FLIGHT is closed — the ones nobody has
   * started, because a cancelled batch whose pieces went on sitting in «в очереди» would be a
   * counter that never goes down, and THE ONE ALREADY TAKEN, because a piece left «в работе»
   * on an abandoned assembly is worse than a counter: nothing on the board can ever close it.
   * It is not waiting for a person (that column is for work that asks a question), the owner
   * has no button for it, and the lease only ever hands it back to a queue nobody is served
   * from. The reason both get is the true one — a human stopped this.
   *
   * Work that already produced is never touched, and neither is work already waiting for a
   * person: the first is closed, and the second has a door of its own to close by.
   */
  async function resolveBatch(batchId, { skip, cancel } = {}) {
    const rec = [...records.values()].find(
      (r) => isBatchParent(r.task) && (r.task.batchId || r.task.id) === batchId,
    )
    if (!rec) return false
    const current = batchDecisionsOf(rec.task)
    const data = { ...(rec.task.data || {}) }
    if (typeof skip === 'string' && skip !== '') {
      data.skipped = current.skipped.includes(skip) ? current.skipped : [...current.skipped, skip]
    }
    if (cancel === true) data.cancelled = true
    rec.task = { ...rec.task, data }
    if (cancel === true) {
      for (const r of records.values()) {
        if (r.task.batchId !== batchId || isBatchParent(r.task)) continue
        if (r.status !== 'queued' && r.status !== 'claimed') continue
        r.status = 'failed'
        r.failure_reason = 'manual'
        // Nothing else is cleared, and nothing needs to be: the liveness sweep asks for
        // `claimed` rows only, so a closed piece is out of its reach — while the clock of the
        // attempt that was under way stays on the row, where a person can still read it.
      }
    }
    return true
  }

  /**
   * setWords(taskId, {description, acceptance}) — replace the words of a task that is still
   * live. Returns false when there is no such task or its work is already over.
   *
   * Only the keys PRESENT in the patch move: a door sending a description alone must not
   * silently erase a promise it never mentioned.
   */
  async function setWords(taskId, patch = {}) {
    const rec = records.get(taskId)
    if (!rec) return false
    if (!WORDS_EDITABLE_STATUSES.includes(rec.status)) return false
    const words = validateWords(patch)
    rec.task = { ...rec.task, ...words }
    return true
  }

  async function complete(taskId, result) {
    const rec = records.get(taskId)
    if (!rec) throw new UnknownTaskError(`complete: unknown task "${taskId}"`)
    if (!result || !result.receiptRef) {
      throw new NoReceiptError(
        `complete("${taskId}") refused: result must carry a receiptRef — work is never ` +
          `certified done on the runner's own word`,
      )
    }
    // WHOSE ATTEMPT IS BEING CLOSED. Refused BEFORE any mutation, like the missing receipt
    // above: a row half-closed by a stranger is worse than one not closed at all.
    refuseStaleAttempt('complete', taskId, rec.attemptToken, result.attemptToken)
    // NOT 'completed': the receipt certifies the WORK, and the work now owes a person a
    // word. The durable backend records exactly this state in its own approval row; the
    // reference backend has to say the same thing or the contract suite would certify two
    // different meanings of the same call.
    rec.status = 'awaiting_approval'
    rec.completedAt = now()
    rec.result = result
    return true
  }

  async function fail(taskId, reason, { attemptToken } = {}) {
    if (!FAIL_REASONS.includes(reason)) {
      throw new InvalidFailReasonError(`fail: "${reason}" is not one of ${FAIL_REASONS.join('|')}`)
    }
    const rec = records.get(taskId)
    if (!rec) throw new UnknownTaskError(`fail: unknown task "${taskId}"`)
    // A STALE WORKER MAY NOT BREAK SOMEBODY ELSE'S ATTEMPT EITHER, and this half matters as
    // much as the other one: a failure is the RETRYABLE outcome, so a stranger's failure would
    // hand a running attempt's work to yet another worker while the first is still doing it.
    refuseStaleAttempt('fail', taskId, rec.attemptToken, attemptToken)
    rec.status = 'failed'
    rec.failure_reason = reason
    return true
  }

  /**
   * cancelTask(taskId) — A PERSON STOPPED THIS WORK, and stopped means stopped.
   *
   * The body says exactly what the owner's word about an abandoned assembly already says
   * about each of its pieces: the row is closed, and the reason is the true one — a human
   * stopped this. Nothing else needs clearing, and this is deliberate: the liveness sweep
   * asks for `claimed` rows only, so a closed row is already out of its reach, while the
   * clock of the attempt that WAS under way stays on the row where a person can still read
   * how long it ran before being stopped.
   *
   * IT IS NOT `fail`, AND THAT DISTINCTION IS THE WHOLE POINT. A failure is a RETRYABLE
   * outcome — the durable queue hands the very same row back for another try, after a
   * backoff. So a stop written as a failure would close the card, drop the counter, look
   * done — and then give the stopped work to a worker minutes later. A stop that looks
   * successful and is not is worse than no stop at all, which is why this is a path of its
   * own rather than a reason inside the other one.
   *
   * ONLY LIVE WORK CAN BE STOPPED. Work that already produced, already failed or already
   * waits for a person is not stopped but finished, and `false` says so rather than
   * rewriting it — the same «what is closed stays closed» the words door keeps.
   */
  async function cancelTask(taskId) {
    const rec = records.get(taskId)
    if (!rec) return false
    if (rec.status !== 'queued' && rec.status !== 'claimed') return false
    rec.status = 'failed'
    rec.failure_reason = 'manual'
    // THE TRY COUNT IS NOT TOUCHED, and its stillness is an assertion: a failure raises it
    // because a next try stands behind it. Behind a stop stands nothing.
    return true
  }

  async function list(filter = {}) {
    sweep()
    let rows = [...records.values()]
    if (filter.status) rows = rows.filter((r) => r.status === filter.status)
    if (filter.lane) rows = rows.filter((r) => r.task.lane === filter.lane)
    // AN OPTIONAL PROJECT FILTER; its absence still means EVERY project.
    //
    // THIS FILTER USED TO GUESS, and it was the last place that did. It compared the
    // narrowing against «the row's project, else the one currently selected, else the
    // default slug», so a row that had never named a project answered as though it
    // belonged to whatever was on the screen — and answered DIFFERENTLY the moment the
    // person switched the switcher. The read path stopped doing that; this one had not,
    // and this backend is the executable spec: while it filters by a rule the real queue
    // no longer obeys, the next test written «to spec» encodes the very lie that was removed.
    //
    // The rule is the one the state reader already applies: a row belongs where IT says it
    // belongs, and a row that names no project belongs to NOBODY — so no narrowing may hide
    // it. Work that every filter hides is invisible work, and an honest «owner unknown»
    // beats a confident wrong owner.
    if (filter.project) {
      rows = rows.filter((r) => {
        const own = typeof r.task.project === 'string' && r.task.project ? r.task.project : null
        return own === null || own === filter.project
      })
    }
    return rows.map(row)
  }

  async function stats() {
    sweep()
    // Every status of the closed vocabulary is a KEY, present at zero — a counter that
    // appears only once something lands in it reads as «no such thing» on the screen that
    // asks for it, which is a different statement from «none right now».
    // STATS COUNT WORK, and a batch request is not work: it is queued, nobody will ever
    // claim it, and counted here it would add one to «в очереди» that no amount of working
    // could ever take away. It stays in list() — a reader has to see it to draw the batch.
    const work = [...records.values()].filter((rec) => !isBatchParent(rec.task))
    const s = { total: work.length }
    for (const st of TASK_STATUSES) s[st] = 0
    for (const rec of work) s[rec.status] = (s[rec.status] ?? 0) + 1
    return s
  }

  return { enqueue, claimNext, touch, assignWorker, resolveBatch, setWords, complete, fail, cancelTask, list, stats }
}

// ── the reusable contract suite (executable spec any backend must pass) ──

/**
 * queueAdapterContractSuite(name, makeAdapter) — register the full QueueAdapter
 * contract as a vitest describe/it block against ANY adapter factory. This is what
 * makes the seam honest: the pg-boss backend re-runs this exact suite, and the future
 * file backend re-runs it too.
 *
 * `makeAdapter({clock, expireMs})` returns a fresh adapter. The suite owns a mutable
 * fake clock per test so the liveness/expiry path is deterministic.
 *
 * The vitest API is read from globalThis (test.globals) — NO top-level vitest import,
 * so the production daemon imports this module dependency-free.
 *
 * @param {string} name
 * @param {(opts:{clock:Function, expireMs:number}) => object} makeAdapter
 */
export function queueAdapterContractSuite(name, makeAdapter) {
  const { describe, it, expect } = globalThis
  if (!describe || !it || !expect) {
    throw new Error('queueAdapterContractSuite requires the vitest globals (test.globals: true)')
  }

  const backlog = (over = {}) => ({
    id: 'BL-96',
    source: 'backlog',
    title: 'do the thing',
    lane: 'prod',
    priority: 0,
    attempt: 1,
    storyPoints: 3,
    acceptance: 'green targeted tests + reverify receipt',
    ...over,
  })

  const clockOf = (start = 1000) => {
    const s = { now: start }
    return { fn: () => s.now, advance: (ms) => (s.now += ms) }
  }

  describe(`QueueAdapter contract: ${name}`, () => {
    it('enqueue then claimNext returns the task; a second claimNext returns null (atomic checkout)', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      const claimed = await q.claimNext('w1', {})
      expect(claimed.id).toBe('BL-96')
      expect(await q.claimNext('w2', {})).toBeNull()
    })

    /**
     * ═══════ ЧТО ЧЕЛОВЕК НАПИСАЛ О ЗАДАЧЕ, ТО РАБОТНИК И ПОЛУЧАЕТ ═══════
     *
     * ПОЧЕМУ ЭТО ДЕЛО ЖИВЁТ ЗДЕСЬ, А НЕ В ФАЙЛЕ ОДНОГО БЭКЕНДА. Снимок контекста едет в
     * рабочую копию и в промпт КАЖДОЙ попытки, и единственный его источник — строка очереди.
     * «Захваченная задача несёт снимок» — утверждение о ХРАНИЛИЩЕ, а хранилищ у контракта два:
     * памятное отдаёт нормализованную задачу как есть, долговечное везёт её в payload'е джоба
     * и собирает обратно после выборки. Проверенное на одном и не проверенное на другом —
     * ровно тот класс, который стоил дня: каждый кусок написан, покрыт делами и зелёный, и ни
     * один не присоединён к соседнему. Это дело утверждает ПРОВОД, а не вычисление.
     */
    it('captured task carries taskContext — the human\'s snapshot survives the hand-out', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      const snapshot = 'счета лежат в /invoices, доступ у Ольги'
      await q.enqueue(backlog({ taskContext: snapshot }))
      const claimed = await q.claimNext('w1', {})
      expect(claimed.taskContext).toBe(snapshot)
    })

    it('a repeated enqueue while pending coalesces to one entry with a counter', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      const again = await q.enqueue(backlog())
      expect(again.coalesced).toBe(true)
      expect(again.coalesceCount).toBe(2)
      expect(await q.list({ status: 'queued' })).toHaveLength(1)
    })

    it('complete refuses without a receiptRef (NoReceiptError) and accepts one with it', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      await expect(q.complete('BL-96', {})).rejects.toThrow(/receipt/i)
      await q.complete('BL-96', { receiptRef: 'reverify:abc' })
      const [r] = await q.list({})
      expect(r.status).toBe('awaiting_approval')
    })

    // COMPLETED WORK IS REPORTED AS AWAITING APPROVAL. Certified work is not accepted work:
    // the receipt is the worker's half and a person owes the other half. Every backend has
    // to say so in its own read path, because the screen that shows «ждут решения» reads
    // list()/stats() and nothing else — where this row said 'completed', that screen was
    // empty at all times and the counter beside it read zero while work piled up.
    it('after complete() with a receipt the row reads awaiting_approval, never completed, and stats() counts it', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      await q.complete('BL-96', { receiptRef: 'reverify:abc' })

      const [r] = await q.list({})
      expect(r.status).toBe('awaiting_approval')
      expect(r.status).not.toBe('completed')

      // the filter the front's «ждут решения» screen actually runs
      expect(await q.list({ status: 'awaiting_approval' })).toHaveLength(1)
      expect(await q.list({ status: 'completed' })).toHaveLength(0)

      const s = await q.stats()
      expect(s.awaiting_approval).toBe(1)
      expect(s.completed).toBe(0)
    })

    it('fail rejects an unknown reason and records a valid one', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      await expect(q.fail('BL-96', 'bogus')).rejects.toThrow()
      await q.fail('BL-96', 'missing_access')
      const [r] = await q.list({})
      expect(r.status).toBe('failed')
      expect(r.failure_reason).toBe('missing_access')
    })

    /**
     * ═══════ ОСТАНОВЛЕННОЕ ЧЕЛОВЕКОМ ОСТАНОВЛЕНО НАВСЕГДА ═══════
     *
     * ПОЧЕМУ ЭТО ДЕЛО ЖИВЁТ ЗДЕСЬ, А НЕ В ФАЙЛЕ ОДНОГО БЭКЕНДА. «Отмена терминальна» — это
     * утверждение о ХРАНИЛИЩЕ, и хранилищ у контракта два. Два одинаковых дела, написанных в
     * двух файлах, разъезжаются молча при первой же правке одного из них, и тогда «терминально»
     * остаётся правдой в одном месте и надписью в другом. Одно дело в общем сьюте — единственная
     * форма, в которой «терминально ВЕЗДЕ» держится конструкцией, а не надеждой.
     *
     * ПОЧЕМУ ОТМЕНА — НЕ ОТКАЗ, И ЭТО НЕ ВОПРОС ВКУСА. Отказ у долговременной очереди по
     * конструкции возвращаемый: строка физически удаляется и вставляется обратно в состоянии
     * повтора, с отложенным стартом. Значит отмена, написанная отказом, выглядела бы сделанной
     * — карточка покраснела бы, счётчик упал бы, — а через задержку повтора остановленная
     * человеком задача снова ушла бы работнику. Это худший из исходов, потому что он похож на
     * успех. Поэтому главное дело ниже не спрашивает «как выглядит строка»; оно ПЫТАЕТСЯ ВЗЯТЬ
     * СЛЕДУЮЩУЮ ЗАДАЧУ, несколько раз и после продвижения часов — то есть ровно там, где
     * отложенный повтор успел бы созреть.
     */
    it('cancelTask is terminal: a task a person stopped is handed to nobody — not on the next tick, not on any later one', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-90' })) // остановят эту
      c.advance(10)
      await q.enqueue(backlog({ id: 'BL-91' })) // а эта обязана продолжать жить

      expect(await q.cancelTask('BL-90')).toBe(true)

      // Соседняя работа не пострадала: отмена — про одну строку, а не про очередь.
      const first = await q.claimNext('w1', {})
      expect(first.id).toBe('BL-91')
      await q.complete('BL-91', { receiptRef: 'reverify:neighbour' })

      // ТРИ ПОПЫТКИ ВЗЯТЬ СЛЕДУЮЩУЮ, с ходом часов между ними: отложенный повтор — это
      // задержка, а не отмена, и на любой из этих трёх попыток он бы себя показал.
      const handed = []
      for (let i = 0; i < 3; i += 1) {
        handed.push(await q.claimNext('w2', {}))
        c.advance(120000)
      }
      expect(handed).toEqual([null, null, null])

      // И строка читается закрытой, с человеческой причиной, а не пустотой.
      const stopped = (await q.list({})).find((r) => r.id === 'BL-90')
      expect(stopped.status).toBe('failed')
      expect(stopped.status).not.toBe('queued')
      expect(stopped.failure_reason).toBe('manual')
      expect(REASON_LABELS[stopped.failure_reason].length).toBeGreaterThan(0)
    })

    it('отмена ЖДУЩЕЙ строки убирает её из очереди — счётчик «в очереди» падает, а не висит', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-92' }))
      expect((await q.stats()).queued).toBe(1)

      expect(await q.cancelTask('BL-92')).toBe(true)

      expect(await q.list({ status: 'queued' })).toHaveLength(0)
      expect((await q.stats()).queued).toBe(0)
    })

    it('отмена ИДУЩЕЙ строки снимает её с работника — «в работе» больше её не считает', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(backlog({ id: 'BL-93' }))
      const taken = await q.claimNext('w1', {})
      expect(taken.id).toBe('BL-93')
      expect((await q.stats()).claimed).toBe(1)

      expect(await q.cancelTask('BL-93')).toBe(true)

      expect((await q.stats()).claimed).toBe(0)
      const stopped = (await q.list({})).find((r) => r.id === 'BL-93')
      expect(stopped.status).toBe('failed')
      expect(stopped.failure_reason).toBe('manual')
    })

    it('отмена задачи, которой нет, отвечает честным «нет такой», а не тишиной', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      expect(await q.cancelTask('BL-does-not-exist')).toBe(false)
    })

    it('отмена уже закрытой задачи не переписывает закрытое — что закрыто, то закрыто', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(backlog({ id: 'BL-94' }))
      await q.claimNext('w1', {})
      await q.complete('BL-94', { receiptRef: 'reverify:done' }) // работа кончилась, ждёт человека

      expect(await q.cancelTask('BL-94')).toBe(false)

      const r = (await q.list({})).find((x) => x.id === 'BL-94')
      expect(r.status).toBe('awaiting_approval') // отмена ничего не переписала
    })

    /**
     * ОТЛИЧИЕ ОТ ОТКАЗА УТВЕРЖДАЕТСЯ ПРЯМО, а не подразумевается соседними делами: у отказа
     * счёт попыток растёт, потому что за отказом стоит следующая попытка. За отменой не стоит
     * ничего — значит и счёт не двигается. Если он вырос, отмена сделана отказом.
     */
    it('после отмены счёт попыток НЕ растёт — этим отмена и отличается от отказа', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(backlog({ id: 'BL-95' }))
      await q.claimNext('w1', {})
      const before = (await q.list({})).find((r) => r.id === 'BL-95').attempt

      expect(await q.cancelTask('BL-95')).toBe(true)

      const after = (await q.list({})).find((r) => r.id === 'BL-95').attempt
      expect(after).toBe(before)
    })

    /**
     * РАБОТУ, ВЕРНУВШУЮСЯ В ОЧЕРЕДЬ ПОСЛЕ СОРВАННОЙ ПОПЫТКИ, ОСТАНОВИТЬ ТОЖЕ МОЖНО.
     *
     * Это не редкий угол, а самый обычный день: задача, чей работник замолчал, возвращается
     * в очередь сторожем живости и ждёт следующей попытки. Для человека у экрана она ничем
     * не отличается от любой другой ждущей — так её и называет читающий путь. Значит и
     * остановить её он вправе ровно так же; «нет такой задачи» в ответ на строку, которую он
     * видит в очереди, — это отказ, замаскированный под пустоту.
     */
    it('a task handed back after a lost attempt can still be stopped — a person sees waiting work and may stop waiting work', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-97' }))
      await q.claimNext('w1', {})
      c.advance(5000) // аренда потеряна: строка вернулась в очередь на следующую попытку

      const back = (await q.list({})).find((r) => r.id === 'BL-97')
      expect(back.status).toBe('queued') // именно это человек и видит

      expect(await q.cancelTask('BL-97')).toBe(true)
      expect(await q.claimNext('w2', {})).toBeNull()
    })

    it('a claimed task not touched within expireMs returns to queued with attempt+1', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      c.advance(6000) // past expireMs, no touch
      const [r] = await q.list({})
      expect(r.status).toBe('queued')
      expect(r.attempt).toBe(2)
    })

    /**
     * A RE-ISSUE HAS A CEILING, AND THE CEILING IS PART OF THE CONTRACT.
     *
     * A lost lease hands the row back for another try — and without a limit it hands it back
     * for ever: a task nobody can finish is claimed, expires, is claimed again, and every one
     * of those turns spends a paid attempt on work that has already failed the same way twice.
     * The durable queue has always had the ceiling (its library refuses to re-issue past
     * `retry_limit`); the reference backend had none at all, so the two backends kept
     * DIFFERENT promises about the same call — and the reference one is the executable spec
     * every future backend is written against. These cases are what makes the ceiling one
     * promise instead of two.
     */
    it('строка с границей в ноль повторов после первой потерянной аренды закрывается — и больше не выдаётся', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-90', retryLimit: 0 }))
      expect(await q.claimNext('w1', {})).not.toBeNull()
      c.advance(6000) // аренда потеряна, и повторов этой строке не отпущено

      const [r] = await q.list({})
      expect(r.status).toBe('failed')
      expect(await q.claimNext('w2', {})).toBeNull() // никакой перевыдачи
    })

    it('строка с границей в два повтора переживает две потерянные аренды и закрывается на третьей', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-91', retryLimit: 2 }))

      // первая попытка + два повтора: три выдачи, и все три состоялись
      for (const worker of ['w1', 'w2', 'w3']) {
        expect(await q.claimNext(worker, {})).not.toBeNull()
        c.advance(6000)
      }

      const [r] = await q.list({})
      expect(r.status).toBe('failed')
      expect(await q.claimNext('w4', {})).toBeNull()
    })

    /**
     * ЧЕМ ЗАКРЫТА ИСЧЕРПАННАЯ СТРОКА — ВОПРОС К ОЧЕРЕДИ, А НЕ К РАБОТНИКУ.
     *
     * Причина провала едет на карточку словами, и «попытки кончились» — это другой разговор с
     * человеком, чем «тесты красные»: во втором случае есть что чинить, в первом — работу надо
     * пересобрать или поднять границу. Строка, закрытая очередью без своей причины, приходит на
     * экран как «причина не записана» — ровно тот красный без объяснения, который отмена сборки
     * уже однажды закрывала.
     */
    it('причина закрытия по исчерпанной границе — своя, а не та, что записал бы работник', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-92', retryLimit: 0 }))
      await q.claimNext('w1', {})
      c.advance(6000)

      const exhausted = (await q.list({})).find((r) => r.id === 'BL-92')
      expect(exhausted.failure_reason).toBe(ATTEMPTS_EXHAUSTED)

      // а рядом — строка, которую закрыл работник: её причина осталась её собственной
      await q.enqueue(backlog({ id: 'BL-93' }))
      await q.claimNext('w2', {})
      await q.fail('BL-93', 'tests_red')
      const byWorker = (await q.list({})).find((r) => r.id === 'BL-93')
      expect(byWorker.failure_reason).toBe('tests_red')
    })

    it('без явной границы работа держит ровно столько повторов, сколько даёт умолчание — расхождения умолчаний нет', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-89' })) // границы не назвал никто

      // первая выдача + DEFAULT_RETRY_LIMIT перевыдач — все состоялись
      for (let i = 0; i <= DEFAULT_RETRY_LIMIT; i += 1) {
        expect(await q.claimNext(`w${i}`, {})).not.toBeNull()
        c.advance(6000)
      }

      const [r] = await q.list({})
      expect(r.status).toBe('failed')
      expect(await q.claimNext('wN', {})).toBeNull()
    })

    it('touch keeps a claimed task alive past what would otherwise expire it', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      c.advance(4000)
      await q.touch('BL-96')
      c.advance(4000) // 8000 since claim, but only 4000 since touch
      const [r] = await q.list({})
      expect(r.status).toBe('claimed')
    })

    /**
     * RENEWING THE LEASE MAY NEVER MOVE THE MOMENT THE WORK WAS TAKEN.
     *
     * The durable backend has no renewal call in its library, so it renews by restamping the
     * job's own start clock — and that clock was ALSO the answer to «when was this taken». So
     * a task that had been running for an hour reported a couple of minutes, then a couple of
     * minutes again, forever: the number on the screen was not a measurement of anything. The
     * two facts now live in two fields, and this case is the one that keeps them apart on
     * every backend — a backend answering both from one clock fails here rather than on a
     * screen.
     */
    it('a lease renewal moves leaseRenewedAt and NEVER claimedAt — «how long» is measured from the claim', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})

      const [claimed] = await q.list({})
      expect(claimed.claimedAt).toBe(1000)
      expect(claimed.leaseRenewedAt).toBe(1000)

      c.advance(4000)
      await q.touch('BL-96')

      const [renewed] = await q.list({})
      expect(renewed.status).toBe('claimed')
      expect(renewed.claimedAt).toBe(1000) // the claim did not happen again
      expect(renewed.leaseRenewedAt).toBe(5000) // only the lease clock moved
    })

    /**
     * A row waiting for a worker has nothing to measure, and says so with a null rather than
     * with a zero: a zero renders as «just started», which is a statement about work that is
     * not happening.
     */
    it('a task that lost its lease and went back to the queue reports NO claim time and no renewal', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      c.advance(6000) // past the lease, no renewal

      const [r] = await q.list({})
      expect(r.status).toBe('queued')
      expect(r.claimedAt).toBeNull()
      expect(r.leaseRenewedAt).toBeNull()
    })

    /**
     * The claim stamp belongs to the ATTEMPT IN FLIGHT, not to the task's first ever claim: a
     * second attempt that reported the first attempt's clock would say the work has been
     * running since before it started.
     */
    it('an attempt claimed again after a requeue is measured from the NEW claim', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog())
      await q.claimNext('w1', {})
      c.advance(6000) // the lease expires, the task returns to the queue
      c.advance(1000)
      const again = await q.claimNext('w2', {})
      expect(again.id).toBe('BL-96')

      const [r] = await q.list({})
      expect(r.status).toBe('claimed')
      expect(r.claimedAt).toBe(8000)
      expect(r.leaseRenewedAt).toBe(8000)
    })

    /**
     * ═══════ ОГРАЖДАЮЩИЙ ЖЕТОН ПОПЫТКИ ═══════
     *
     * ЧТО ИЗМЕРЕНО, А НЕ ПРЕДПОЛОЖЕНО. Живой прогон на настоящей очереди: работник захватил
     * задачу, его аренда истекла, очередь ПЕРЕВЫДАЛА строку второму работнику — и тогда
     * первый, живой и ничего не знающий об отъёме, позвал завершение. Оно было ПРИНЯТО:
     * строка ушла в «закрыто» со счётом выдач второй попытки. Мало того — второй работник,
     * который работу действительно делал, свою же попытку закрыть НЕ СМОГ: активной строки
     * для него уже не было. Дыра отнимает не только чужую работу, но и право закрыть свою.
     *
     * ПОЧЕМУ ДЕЛА ЖИВУТ В ОБЩЕМ СЬЮТЕ, А НЕ В ФАЙЛЕ ОДНОГО БЭКЕНДА. Жетон — обещание
     * КОНТРАКТА, а не деталь хранилища: цикл зовёт завершение через шов адаптера и не знает,
     * какой бэкенд под ним. Два одинаковых дела в двух файлах разъезжаются молча при первой
     * правке одного из них, и «чужой не закроет» остаётся правдой в одном месте и надписью
     * в другом. Одно дело здесь держит оба бэкенда конструкцией.
     *
     * ЧЕГО ЭТИ ДЕЛА НЕ ДОКАЗЫВАЮТ И НЕ МОГУТ. Одновременность двух захватов — свойство
     * настоящей базы (её оператор выдачи блокирует строку), и подделка, «правильно» отдающая
     * одну строку двум, доказывала бы подделку. Гонка меряется живой пробой, эти дела — про
     * КОНТРАКТ жетона: форму возврата, отказ чужому, новый жетон на каждой выдаче.
     */
    it('claimNext hands out an attempt token, and two claims never carry the same one', async () => {
      const c = clockOf()
      // аренда намеренно длинная: истечение здесь НЕ предмет дела, а памятная очередь
      // истекает арендой сама, внутри claimNext/list/stats
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(backlog({ id: 'BL-80' }))
      await q.enqueue(backlog({ id: 'BL-81' }))

      const first = await q.claimNext('w1', {})
      const second = await q.claimNext('w2', {})

      expect(typeof first.attemptToken).toBe('string')
      expect(first.attemptToken.length).toBeGreaterThan(15)
      expect(typeof second.attemptToken).toBe('string')
      expect(second.attemptToken).not.toBe(first.attemptToken)
      // ЖЕТОН — НЕ НОМЕР ПОПЫТКИ, и это утверждается, а не подразумевается: номер уже
      // однажды плавал под попыткой, которая этого не заметила, и жетон, выведенный из
      // счётчика, унаследовал бы ту же болезнь.
      expect(first.attemptToken).not.toBe(String(first.attempt))
      expect(first.attemptToken).not.toBe(String(first.id))
    })

    it('a stale worker cannot close the FRESH attempt of another — and the worker who holds it still can', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-82' }))

      const stale = await q.claimNext('w1', {}) // первая попытка
      c.advance(6000) // аренда потеряна — очередь перевыдаёт строку
      c.advance(1000)
      const fresh = await q.claimNext('w2', {}) // вторая попытка, у неё свой жетон
      expect(fresh.id).toBe('BL-82')
      expect(fresh.attemptToken).not.toBe(stale.attemptToken)

      // устаревший работник предъявляет то, что вернул ЕГО захват
      await expect(
        q.complete('BL-82', { receiptRef: 'reverify:stale', attemptToken: stale.attemptToken }),
      ).rejects.toThrow(/stale_attempt_token/)

      // строка НЕ ТРОНУТА: свежая попытка идёт дальше, как шла
      const [mid] = await q.list({})
      expect(mid.status).toBe('claimed')
      expect(mid.status).not.toBe('awaiting_approval')

      // ВТОРАЯ ПОЛОВИНА, БЕЗ КОТОРОЙ ЧИНИТЬ МОЖНО БЫЛО БЫ «ОТВЕРГАТЬ ВСЁ»: тот, кто держит
      // попытку, закрывает её своим жетоном.
      expect(await q.complete('BL-82', { receiptRef: 'reverify:fresh', attemptToken: fresh.attemptToken })).toBe(true)
      const [after] = await q.list({})
      expect(after.status).toBe('awaiting_approval')
    })

    it('fail with a foreign token is refused and leaves the row where it was; the token in flight is accepted', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-83' }))

      const stale = await q.claimNext('w1', {})
      c.advance(6000)
      c.advance(1000)
      const fresh = await q.claimNext('w2', {})

      await expect(q.fail('BL-83', 'missing_access', { attemptToken: stale.attemptToken })).rejects.toThrow(
        /stale_attempt_token/,
      )
      const [mid] = await q.list({})
      expect(mid.status).toBe('claimed') // чужой провал не уронил чужую попытку
      expect(mid.failure_reason).toBeNull()

      expect(await q.fail('BL-83', 'missing_access', { attemptToken: fresh.attemptToken })).toBe(true)
      const [after] = await q.list({})
      expect(after.status).toBe('failed')
      expect(after.failure_reason).toBe('missing_access')
    })

    /**
     * ПРОДЛЕНИЕ ЧУЖИМ ЖЕТОНОМ — САМЫЙ ТИХИЙ ИЗ ТРЁХ СЛУЧАЕВ. Устаревший работник, который
     * продолжает стучать «я жив», держал бы ЧУЖУЮ аренду вечно: сторож живости никогда не
     * отобрал бы строку у работника, который на самом деле давно молчит. Поэтому дело не
     * довольствуется ответом «false» — оно доводит часы до точки, где продлённая аренда была
     * бы ещё жива, и смотрит, вернулась ли строка в очередь.
     */
    it('touch with a foreign token does not renew the lease — a stale worker cannot hold somebody else’s attempt alive', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-84' }))

      const stale = await q.claimNext('w1', {})
      c.advance(6000)
      c.advance(1000)
      const fresh = await q.claimNext('w2', {}) // часы: 8000

      // жетон попытки в полёте продлевает, как продлевал: отказ не сплошной
      c.advance(4000) // 12000
      expect(await q.touch('BL-84', { attemptToken: fresh.attemptToken })).toBe(true)
      c.advance(4000) // 16000 — от продления прошло 4000 из 5000
      expect((await q.list({}))[0].status).toBe('claimed')

      // а чужой жетон не продлевает — и это видно не по ответу, а по судьбе строки
      expect(await q.touch('BL-84', { attemptToken: stale.attemptToken })).toBe(false)
      c.advance(2000) // 18000 — от ПОСЛЕДНЕГО законного продления прошло 6000 из 5000
      const [r] = await q.list({})
      expect(r.status).toBe('queued')
    })

    /**
     * КАЖДАЯ ПЕРЕВЫДАЧА РОЖДАЕТ НОВЫЙ ЖЕТОН, А ПРЕЖНИЙ МЁРТВ НАВСЕГДА, а не до следующей
     * выдачи: работник первой попытки может проснуться на третьей и позвать завершение —
     * и обязан получить отказ так же, как получил бы его на второй.
     */
    it('every re-issue mints a NEW token, and every older one stays dead', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-86' }))

      const one = await q.claimNext('w1', {})
      c.advance(7000)
      const two = await q.claimNext('w2', {})
      c.advance(7000)
      const three = await q.claimNext('w3', {})

      expect(new Set([one.attemptToken, two.attemptToken, three.attemptToken]).size).toBe(3)

      await expect(
        q.complete('BL-86', { receiptRef: 'reverify:one', attemptToken: one.attemptToken }),
      ).rejects.toThrow(/stale_attempt_token/)
      await expect(
        q.complete('BL-86', { receiptRef: 'reverify:two', attemptToken: two.attemptToken }),
      ).rejects.toThrow(/stale_attempt_token/)
      expect(await q.complete('BL-86', { receiptRef: 'reverify:three', attemptToken: three.attemptToken })).toBe(true)
    })

    /**
     * ЗВОНЯЩИЙ БЕЗ ЖЕТОНА — ЭТО ПЕРЕХОДНОЕ РЕШЕНИЕ, НАЗВАННОЕ ВСЛУХ, А НЕ НЕДОСМОТР.
     *
     * Жетона нет у двух звонящих, и по разным причинам. Сторож живости закрывает попытку
     * молчащего работника по праву ВЛАСТИ, а не работника: жетона у него нет и быть не
     * должно. А строка, посеянная или захваченная до этого обновления, жетона не носит
     * вовсе — отсутствие есть отсутствие, и падать на ней нельзя.
     *
     * ЧЕМ ЭТО ОБЯЗАНО КОНЧИТЬСЯ. Наш цикл понесёт жетон ВСЕГДА — этот провод кладётся
     * следующей работой, и до тех пор дверь, через которую устаревший работник ещё может
     * пройти, остаётся открытой ровно здесь. Дело стоит именно для того, чтобы переход был
     * виден и имел конец, а не растворился в умолчании.
     */
    it('a caller that presents NO token gets today’s behaviour — a named transitional decision, not an oversight', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 5000 })
      await q.enqueue(backlog({ id: 'BL-85' }))

      await q.claimNext('w1', {})
      c.advance(6000)
      c.advance(1000)
      const fresh = await q.claimNext('w2', {})
      expect(typeof fresh.attemptToken).toBe('string')

      expect(await q.touch('BL-85')).toBe(true)
      expect(await q.complete('BL-85', { receiptRef: 'reverify:no-token' })).toBe(true)
      const [r] = await q.list({})
      expect(r.status).toBe('awaiting_approval')
    })

    it('assignWorker records the executing worker, and list() reports it', async () => {
      // WHY THIS IS A CONTRACT TEST AND NOT A BACKEND DETAIL: the claim is made by the
      // daemon, and routing picks the actual worker one step later. Every «who is busy»
      // reader — the board, the worker strip, the busy counter — answers by matching a
      // claimed row's workerId against the configured workers. A backend that accepts the
      // assignment and forgets it renders as an empty queue and an idle worker while an
      // attempt is running, which is exactly what shipped on 12.08.2026.
      const q = makeAdapter({ clock: clockOf().fn, expireMs: 60000 })
      await q.enqueue(backlog())
      await q.claimNext('daemon', {})

      expect(await q.assignWorker('BL-96', 'local-1')).toBe(true)
      const [r] = await q.list({})
      expect(r.status).toBe('claimed')
      expect(r.workerId).toBe('local-1')

      // An unknown task is answered, never thrown at: the caller is a fail-open dispatcher.
      expect(await q.assignWorker('BL-does-not-exist', 'local-1')).toBe(false)
    })

    // ── the batch: kinship is a fact of the queue, and the request is not work ──

    /** The request row of a batch: a roster action, marked as the parent, naming its batch. */
    const parent = (batchId, over = {}) => ({
      id: batchId,
      source: 'roster',
      title: 'разгреби мелочь перед демо',
      lane: 'prod',
      batchId,
      data: { batch: 'parent' },
      ...over,
    })

    // ── THE WORDS OF A TASK: one field of promise, two shapes, and a free-text description ──
    //
    // The cases below are the whole compatibility story of that field, and they are in the
    // CONTRACT suite rather than beside one backend because the shape has to survive the trip
    // through a real database exactly as it survives the trip through a Map.

    it('a promise written as ONE STRING — the shape every older row carries — reads back as a list of one', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({
        id: 'R-old',
        source: 'roster',
        title: 'запись, написанная до списка',
        lane: 'prod',
        acceptance: 'тесты по задаче зелёные',
      })
      const [row] = await q.list({})
      // the row keeps the string it was written with — nothing rewrote anybody's history…
      expect(row.acceptance).toBe('тесты по задаче зелёные')
      // …and every reader still gets a list, because that is the only way this field is read
      expect(acceptanceItems(row.acceptance)).toEqual(['тесты по задаче зелёные'])
    })

    it('a promise of three criteria travels to the row AS A LIST, and the description travels beside it', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({
        id: 'R-words',
        source: 'roster',
        title: 'починить импорт агентов',
        lane: 'prod',
        description: 'Импорт падает на втором файле; починить и закрыть кейсом.',
        acceptance: ['импорт проходит на всех файлах', 'кейс на второй файл зелёный', 'записка о подходе оставлена'],
      })
      const [row] = await q.list({})
      expect(row.description).toBe('Импорт падает на втором файле; починить и закрыть кейсом.')
      expect(acceptanceItems(row.acceptance)).toEqual([
        'импорт проходит на всех файлах',
        'кейс на второй файл зелёный',
        'записка о подходе оставлена',
      ])
    })

    it('the promise is CAPPED in both directions: too many criteria and an over-long one are each refused', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      const base = { source: 'roster', title: 'работа', lane: 'prod' }
      await expect(
        q.enqueue({ ...base, id: 'R-many', acceptance: Array.from({ length: CAP_ACCEPTANCE_ITEMS + 1 }, (_, i) => `критерий ${i}`) }),
      ).rejects.toThrow(/criteria/)
      await expect(q.enqueue({ ...base, id: 'R-long', acceptance: ['x'.repeat(2001)] })).rejects.toThrow(/acceptance/)
      await expect(q.enqueue({ ...base, id: 'R-desc', description: 'д'.repeat(2001) })).rejects.toThrow(/description/)
      // a refusal writes nothing at all
      expect(await q.list({})).toHaveLength(0)
    })

    it('the words of a LIVE task can be replaced, one field at a time', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({
        id: 'R-edit',
        source: 'roster',
        title: 'починить импорт',
        lane: 'prod',
        description: 'первая редакция',
        acceptance: ['первый признак'],
      })
      expect(await q.setWords('R-edit', { acceptance: ['поправленный признак', 'и второй'] })).toBe(true)
      let [row] = await q.list({})
      expect(acceptanceItems(row.acceptance)).toEqual(['поправленный признак', 'и второй'])
      // the field the patch did not name is exactly where it was
      expect(row.description).toBe('первая редакция')

      expect(await q.setWords('R-edit', { description: 'вторая редакция' })).toBe(true)
      ;[row] = await q.list({})
      expect(row.description).toBe('вторая редакция')
      expect(acceptanceItems(row.acceptance)).toEqual(['поправленный признак', 'и второй'])
    })

    /**
     * A PROMISE IS EDITED BEFORE IT IS JUDGED. Once the work is over — produced and waiting
     * for a person, accepted or broken — rewriting what «done» meant would change the standard
     * after the measuring, and the row would then read as though it had always said so.
     */
    it('the words of a task whose work is OVER are refused — the standard is not rewritten afterwards', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({ id: 'R-done', source: 'roster', title: 'работа', lane: 'prod', acceptance: ['обещано так'] })
      await q.claimNext('w1', {})
      // still live while a worker holds it
      expect(await q.setWords('R-done', { acceptance: ['ещё можно'] })).toBe(true)

      await q.complete('R-done', { receiptRef: 'reverify:abc' })
      expect(await q.setWords('R-done', { acceptance: ['так уже нельзя'] })).toBe(false)
      const [row] = await q.list({})
      expect(acceptanceItems(row.acceptance)).toEqual(['ещё можно'])

      // and a task nobody ever put in is answered, never thrown at
      expect(await q.setWords('R-nobody', { description: 'x' })).toBe(false)
    })

    /**
     * РАБОТУ, ВЕРНУВШУЮСЯ В ОЧЕРЕДЬ ПОСЛЕ СОРВАННОЙ ПОПЫТКИ, МОЖНО И ПЕРЕПИСАТЬ.
     *
     * Она ничем не отличается от любой другой ждущей: читающий путь называет её «в очереди», и
     * человек у доски видит ровно это. Больше того — это как раз тот момент, когда переписать
     * слова хочется сильнее всего: попытка сорвалась, и следующей стоит уйти с исправленным
     * заданием, а не с тем же самым. Дверь, отвечающая «нет такой задачи» на строку, которую
     * доска показывает в очереди, — это отказ, переодетый в пустоту.
     */
    it('задаче, вернувшейся в очередь после сорванной попытки, слова переписать можно — и новые слова видит следующая выдача', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-98', description: 'первая редакция' }))
      await q.claimNext('w1', {})
      c.advance(5000) // аренда потеряна: строка вернулась в очередь на следующую попытку

      const back = (await q.list({})).find((r) => r.id === 'BL-98')
      expect(back.status).toBe('queued') // именно это человек и видит

      expect(await q.setWords('BL-98', { description: 'вторая редакция' })).toBe(true)

      const next = await q.claimNext('w2', {})
      expect(next.id).toBe('BL-98')
      expect(next.description).toBe('вторая редакция')
    })

    it('the words door is bounded by the SAME caps the enqueue is', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({ id: 'R-cap', source: 'roster', title: 'работа', lane: 'prod' })
      await expect(
        q.setWords('R-cap', { acceptance: Array.from({ length: CAP_ACCEPTANCE_ITEMS + 1 }, (_, i) => `к ${i}`) }),
      ).rejects.toThrow(/criteria/)
      await expect(q.setWords('R-cap', { description: 'д'.repeat(2001) })).rejects.toThrow(/description/)
      const [row] = await q.list({})
      expect(row.description).toBeUndefined()
    })

    it('an item states which batch it belongs to, and the row says so', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({ id: 'B-1-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-1' })
      await q.enqueue({ id: 'R-alone', source: 'roster', title: 'сама по себе', lane: 'prod' })

      const rows = await q.list({})
      expect(rows.find((r) => r.id === 'B-1-1').batchId).toBe('B-1')
      // A task belonging to no batch says nothing about one — never a null to be skipped.
      expect(rows.find((r) => r.id === 'R-alone').batchId).toBeUndefined()
    })

    /**
     * The parent is a RECORD OF WHAT WAS ASKED. A worker handed it would run the founder's
     * sentence as a task of its own, beside the items it was already broken into — so no
     * priority, no arrival order and no lane filter may surface it.
     */
    it('the request of a batch is NEVER claimed — not at the top priority, not when it arrived first', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(parent('B-2', { priority: 9 })) // first in, and the loudest
      await q.enqueue({ id: 'B-2-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-2', priority: 0 })

      const claimed = await q.claimNext('w1', {})
      expect(claimed.id).toBe('B-2-1')
      // and with the item gone there is still nothing to hand out
      expect(await q.claimNext('w2', {})).toBeNull()
    })

    it('a batch request is not counted as queued WORK, and is still listed so a reader can draw it', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(parent('B-3'))
      await q.enqueue({ id: 'B-3-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-3' })

      const s = await q.stats()
      expect(s.queued).toBe(1) // the item — the request is not work waiting for a worker

      const rows = await q.list({})
      const row = rows.find((r) => r.id === 'B-3')
      expect(row.batchId).toBe('B-3')
      expect(row.data.batch).toBe('parent')
    })

    /**
     * THE VOCABULARY IS STILL CLOSED, and it is closed in the two different ways it always
     * was — worth stating in one case, because the batch added a key to each list.
     *
     * A key outside the task allowlist is DROPPED: the normalized copy is explicit-pick, so
     * an invented field cannot ride into the queue and be read back out by anybody. A key
     * inside the `data` envelope is REFUSED outright, because that envelope is what chooses a
     * gate and a role — a typo there falling through to a default is the fault the refusal
     * was written for. Neither loosened when `batchId` and `data.batch` joined them.
     */
    it('the vocabulary stayed CLOSED: an unknown key never travels, an unknown batch role is refused', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue({ ...parent('B-4'), whenever: 'tomorrow' })
      const [row] = await q.list({})
      expect(row.id).toBe('B-4')
      expect(JSON.stringify(row)).not.toContain('tomorrow')

      await expect(q.enqueue({ ...parent('B-5'), data: { batch: 'child' } })).rejects.toThrow(/data\.batch/)
      // ...and a request that names no batch is not a request at all
      await expect(q.enqueue({ ...parent('B-6'), batchId: undefined })).rejects.toThrow(/batchId/)
      expect(await q.list({})).toHaveLength(1)
    })

    // ── ONE PIECE AT A TIME, AND NOTHING HAPPENS BY ITSELF ──
    //
    // The cases below assert the PROMISE, not the mechanism. The reference backend keeps the
    // pieces of a batch in order by skipping the ones whose turn it is not; the durable one by
    // holding every piece at the queue and releasing exactly one. A backend that finds a third
    // way is a conforming backend — one that hands out two pieces of an assembly at once is
    // not, whatever it does inside.

    /** A piece of a batch: ordinary work in every respect but its kinship. */
    const piece = (batchId, n, over = {}) => ({
      id: `${batchId}-${n}`,
      source: 'roster',
      title: `кусок ${n}`,
      lane: 'prod',
      batchId,
      ...over,
    })

    it('while a piece is under way, NO other piece of the same batch is handed to anybody', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-7'))
      await q.enqueue(piece('B-7', 1))
      c.advance(10)
      await q.enqueue(piece('B-7', 2))

      const first = await q.claimNext('w1', {})
      expect(first.id).toBe('B-7-1')
      // not to this worker, not to another one, not at any priority: the assembly is busy
      expect(await q.claimNext('w2', {})).toBeNull()

      // and the second piece is not lost — it is waiting, visibly, in the queue
      const rows = await q.list({})
      expect(rows.find((r) => r.id === 'B-7-2').status).toBe('queued')
    })

    it('the next piece is handed out once the previous one produced — in the order they were asked for', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-8'))
      await q.enqueue(piece('B-8', 1))
      c.advance(10)
      await q.enqueue(piece('B-8', 2))

      expect((await q.claimNext('w1', {})).id).toBe('B-8-1')
      await q.complete('B-8-1', { receiptRef: 'reverify:one' })
      expect((await q.claimNext('w1', {})).id).toBe('B-8-2')
    })

    /**
     * A BATCH OCCUPIES ONE WORKER, NEVER THE QUEUE. The rule is about the pieces of ONE
     * assembly; anything else waiting is claimed exactly as it always was — otherwise a long
     * batch would be a way for one request to stop the whole machine.
     */
    it('a batch under way does not stop the queue: other work is claimed beside it', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-9'))
      await q.enqueue(piece('B-9', 1))
      c.advance(10)
      await q.enqueue(piece('B-9', 2))
      c.advance(10)
      await q.enqueue(backlog({ id: 'BL-beside' }))

      expect((await q.claimNext('w1', {})).id).toBe('B-9-1')
      // the SECOND worker gets the ordinary task — not the batch's next piece
      expect((await q.claimNext('w2', {})).id).toBe('BL-beside')
      expect(await q.claimNext('w3', {})).toBeNull()
    })

    /**
     * THE LOOP OF 12.08.2026, FORBIDDEN BY CONTRACT. A broken piece stopped nothing and was
     * simply run again — three live sessions on one task, a burnt subscription and an empty
     * board. Here a failure STOPS the assembly and waits for the owner: claim after claim
     * after claim, the queue hands out nothing of that batch and never repeats the piece.
     */
    it('a broken piece stops the assembly, and no amount of claiming repeats it or moves on', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-10'))
      await q.enqueue(piece('B-10', 1))
      c.advance(10)
      await q.enqueue(piece('B-10', 2))

      expect((await q.claimNext('w1', {})).id).toBe('B-10-1')
      await q.fail('B-10-1', 'tests_red')

      for (let i = 0; i < 3; i += 1) expect(await q.claimNext('w1', {})).toBeNull()
      const rows = await q.list({})
      expect(rows.find((r) => r.id === 'B-10-1' && r.status === 'failed')).toBeTruthy()
      expect(rows.find((r) => r.id === 'B-10-2').status).toBe('queued')
    })

    it('«пропустить» is the owner\'s word, and it is what lets the assembly go on', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-11'))
      await q.enqueue(piece('B-11', 1))
      c.advance(10)
      await q.enqueue(piece('B-11', 2))

      await q.claimNext('w1', {})
      await q.fail('B-11-1', 'agent_error')
      expect(await q.claimNext('w1', {})).toBeNull() // stopped until a person says something

      expect(await q.resolveBatch('B-11', { skip: 'B-11-1' })).toBe(true)
      expect((await q.claimNext('w1', {})).id).toBe('B-11-2')

      // the word is REMEMBERED on the request row — a skip that had to be repeated after a
      // restart would be a decision the machine forgot the owner ever made
      const rows = await q.list({})
      expect(rows.find((r) => r.id === 'B-11').data.skipped).toEqual(['B-11-1'])
    })

    it('«повторить» is the owner\'s word too: the SAME piece goes back into its batch', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-12'))
      await q.enqueue(piece('B-12', 1))
      c.advance(10)
      await q.enqueue(piece('B-12', 2))

      await q.claimNext('w1', {})
      await q.fail('B-12-1', 'tests_red')
      c.advance(10)
      await q.enqueue(piece('B-12', 1, { attempt: 2 })) // the repeat: the same id, the same batch

      const again = await q.claimNext('w1', {})
      expect(again.id).toBe('B-12-1') // the repeated piece, not the next one
      expect(again.batchId).toBe('B-12')
    })

    it('«отменить» takes the unstarted pieces OUT of the queue — nobody is handed them, nothing counts them', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-13'))
      await q.enqueue(piece('B-13', 1))
      c.advance(10)
      await q.enqueue(piece('B-13', 2))

      await q.claimNext('w1', {})
      await q.complete('B-13-1', { receiptRef: 'reverify:one' }) // what produced stays produced
      expect(await q.resolveBatch('B-13', { cancel: true })).toBe(true)

      expect(await q.claimNext('w1', {})).toBeNull()
      const rows = await q.list({})
      expect(rows.find((r) => r.id === 'B-13').data.cancelled).toBe(true)
      expect(rows.find((r) => r.id === 'B-13-2').status).not.toBe('queued')
      const s = await q.stats()
      expect(s.queued).toBe(0) // a counter an abandoned batch could never bring down
    })

    /**
     * ОТМЕНА ЗАКРЫВАЕТ И ТОТ КУСОК, КОТОРЫЙ УЖЕ НАЧАЛИ — иначе он висит вечно.
     *
     * Отмена снимала из очереди только НЕНАЧАТОЕ, а взятый в работу кусок оставался
     * `claimed` навсегда: в «ждут вас» такой не попадает (там ждут решения человека), закрыть
     * его из окна нечем, и на доске отменённой сборки остаётся хвост, которого никакая работа
     * уже не уберёт. Аренда его тоже не спасает: подметание вернёт молчащего работника в
     * очередь, а очередь отменённой сборки никому не выдаётся — тот же вечный хвост, только
     * под другим словом.
     *
     * Терминальный исход у него теперь есть, и он ЧЕЛОВЕЧЕСКИЙ: сборку остановил человек.
     * Произведённое по-прежнему неприкосновенно, и ждущее человека — тоже: у первого работа
     * закончена, у второго есть чем закрыться.
     */
    it('«отменить» закрывает и НАЧАТЫЙ кусок — с причиной, а не вечным «в работе»', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-14'))
      await q.enqueue(piece('B-14', 1))
      c.advance(10)
      await q.enqueue(piece('B-14', 2))

      const taken = await q.claimNext('w1', {}) // первый кусок ушёл в работу и там остался
      expect(taken.id).toBe('B-14-1')
      expect((await q.list({})).find((r) => r.id === 'B-14-1').status).toBe('claimed')

      expect(await q.resolveBatch('B-14', { cancel: true })).toBe(true)

      const rows = await q.list({})
      const started = rows.find((r) => r.id === 'B-14-1')
      expect(started.status).toBe('failed') // терминально: доска больше его не держит
      expect(started.failure_reason).toBe('manual') // и это слова, а не пустота
      expect(REASON_LABELS[started.failure_reason].length).toBeGreaterThan(0)

      const s = await q.stats()
      expect(s.claimed).toBe(0) // счётчик «в работе» отменённая сборка больше не завышает
    })

    /**
     * ОСТАНОВЛЕННАЯ СБОРКА ЗАБИРАЕТ И ТОТ КУСОК, КОТОРЫЙ ЖДЁТ ПОСЛЕ СОРВАННОЙ ПОПЫТКИ.
     *
     * Кусок, чей работник замолчал, возвращается в очередь — и для каждого читателя это
     * обыкновенная ждущая работа, ровно как любая другая. Отмена, которая забирает соседей и
     * молча проходит мимо него, оставляет брошенной сборке живой хвост: задержка повтора
     * кончится, и очередь выдаст этот кусок работнику сборки, которую человек остановил. Это
     * второе — и последнее — обещание, которому положено своё решение о втором состоянии
     * ожидания, и вот его дело.
     */
    it('отмена остановленной сборки забирает и кусок, вернувшийся в очередь после сорванной попытки', async () => {
      const c = clockOf(1000)
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(parent('B-16'))
      // граница повторов названа куску ЯВНО: по умолчанию сборка не повторяет своего куска
      // вовсе, и без этой строки во второе состояние ожидания он попасть просто не может
      await q.enqueue(piece('B-16', 1, { retryLimit: 2 }))

      expect((await q.claimNext('w1', {})).id).toBe('B-16-1')
      c.advance(5000) // работник замолчал: кусок вернулся в очередь на следующую попытку

      expect((await q.list({})).find((r) => r.id === 'B-16-1').status).toBe('queued')

      expect(await q.resolveBatch('B-16', { cancel: true })).toBe(true)

      const after = (await q.list({})).find((r) => r.id === 'B-16-1')
      expect(after.status).toBe('failed') // изъят, а не оставлен ждать своей задержки
      expect(await q.claimNext('w2', {})).toBeNull() // и никому больше не выдаётся
    })

    it('отмена не трогает ни произведённое, ни ждущее человека — им есть чем закрыться', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-15'))
      await q.enqueue(piece('B-15', 1))
      c.advance(10)
      await q.enqueue(piece('B-15', 2))

      await q.claimNext('w1', {})
      await q.complete('B-15-1', { receiptRef: 'reverify:one' }) // ждёт человека
      await q.claimNext('w1', {})
      await q.complete('B-15-2', { receiptRef: 'reverify:two' })

      expect(await q.resolveBatch('B-15', { cancel: true })).toBe(true)
      const rows = await q.list({})
      expect(rows.find((r) => r.id === 'B-15-1').status).toBe('awaiting_approval')
      expect(rows.find((r) => r.id === 'B-15-2').status).toBe('awaiting_approval')
    })

    it('a word about a batch nobody asked for is answered, never thrown at', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      expect(await q.resolveBatch('B-does-not-exist', { cancel: true })).toBe(false)
    })

    /**
     * THE WEDGE, at the level the queue owns it. An urgent task is louder than the assembly's
     * next piece and is handed out first — and then the assembly carries on where it stood. It
     * belongs in the contract because the two rules that produce it (priority, and one piece at
     * a time) live in different places, and «they compose» is a claim about the pair.
     */
    it('an urgent task goes ahead of the batch\'s next piece — and the assembly then carries on', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(parent('B-14'))
      await q.enqueue(piece('B-14', 1))
      c.advance(10)
      await q.enqueue(piece('B-14', 2))

      expect((await q.claimNext('w1', {})).id).toBe('B-14-1')
      c.advance(10)
      await q.enqueue(backlog({ id: 'BL-urgent', priority: 9 })) // typed while the piece runs
      await q.complete('B-14-1', { receiptRef: 'reverify:one' })

      expect((await q.claimNext('w1', {})).id).toBe('BL-urgent')
      expect((await q.claimNext('w1', {})).id).toBe('B-14-2')
    })

    // ── «ОСТАНОВИ ВОЛНУ 2»: AN ECHELON ITS OWNER STOPPED HANDS OUT NOTHING ──
    //
    // The same shape as the batch cases above: the promise, not the mechanism. The reference
    // backend skips the withheld rows in its choice; the durable one defers them at the queue
    // and puts them back when the order is lifted. What both must agree on is narrow and
    // testable — the addressed echelon stops, and NOTHING ELSE DOES.

    /** A task of one echelon: ordinary work that says which phase and which wave it belongs to. */
    const inWave = (id, phase, wave, over = {}) => ({
      id,
      source: 'roster',
      title: `план ${id}`,
      lane: 'prod',
      data: { phase, wave },
      ...over,
    })

    it('a task may say which echelon it belongs to, and the word travels on its row', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(inWave('W-1', '14', 2))
      const [row] = await q.list({})
      expect(String(row.data.phase)).toBe('14')
      expect(String(row.data.wave)).toBe('2')
      // ...and the envelope is as closed as it ever was: a neighbour key is still refused
      await expect(q.enqueue(inWave('W-2', '14', 2, { data: { phase: '14', wave: 2, echelon: 2 } }))).rejects.toThrow(
        /unknown key/,
      )
      await expect(q.enqueue(inWave('W-3', '14', { deep: true }))).rejects.toThrow(/data\.wave/)
    })

    it('a stopped echelon is not handed out — and the wave beside it, and the phase beside THAT, are', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(inWave('W-14-2', '14', 2))
      c.advance(10)
      await q.enqueue(inWave('W-14-1', '14', 1))
      c.advance(10)
      await q.enqueue(inWave('W-15-2', '15', 2))
      c.advance(10)
      await q.enqueue(backlog({ id: 'BL-nowave' })) // says nothing about any echelon

      const holds = [{ phase: '14', wave: 2 }]
      const handed = []
      for (let i = 0; i < 4; i += 1) {
        const t = await q.claimNext(`w${i}`, { holds })
        if (t) handed.push(t.id)
      }
      expect(handed).not.toContain('W-14-2')
      expect(handed).toEqual(expect.arrayContaining(['W-14-1', 'W-15-2', 'BL-nowave']))

      // the stopped one is not lost — it waits, visibly, exactly where it was
      const rows = await q.list({})
      expect(rows.find((r) => r.id === 'W-14-2').status).toBe('queued')
    })

    it('lifting the stop hands the very same row out again — nothing was thrown away', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(inWave('W-20-2', '20', 2))

      expect(await q.claimNext('w1', { holds: [{ phase: '20', wave: 2 }] })).toBeNull()
      // claim after claim, the stop keeps standing: nothing times its own way out of it
      expect(await q.claimNext('w1', { holds: [{ phase: '20', wave: 2 }] })).toBeNull()
      c.advance(600000)
      expect(await q.claimNext('w1', { holds: [{ phase: '20', wave: 2 }] })).toBeNull()

      const back = await q.claimNext('w1', { holds: [] })
      expect(back.id).toBe('W-20-2')
      expect(back.attempt).toBe(1) // the same first attempt — a stop is not a failure
    })

    it('a stop nobody can read is not an order: rubbish in the register costs the claim nothing', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 600000 })
      await q.enqueue(inWave('W-21-2', '21', 2))
      const t = await q.claimNext('w1', { holds: [null, { phase: '', wave: 2 }, { wave: 2 }, 'волна 2'] })
      expect(t.id).toBe('W-21-2')
    })

    it('higher priority is claimed first', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-low', priority: 0 }))
      await q.enqueue(backlog({ id: 'BL-high', priority: 5 }))
      const claimed = await q.claimNext('w1', {})
      expect(claimed.id).toBe('BL-high')
    })

    it('enqueue stamps enqueuedAt, claimNext claimedAt, complete completedAt — all in list() rows', async () => {
      const c = clockOf(5000)
      const q = makeAdapter({ clock: c.fn, expireMs: 100000 })
      await q.enqueue(backlog())
      c.advance(100)
      await q.claimNext('w1', {})
      c.advance(100)
      await q.complete('BL-96', { receiptRef: 'reverify:xyz' })
      const [r] = await q.list({})
      expect(r.enqueuedAt).toBe(5000)
      expect(r.claimedAt).toBe(5100)
      expect(r.completedAt).toBe(5200)
    })

    it('the DoR gate rejects a backlog task with no estimate; a roster task is exempt', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await expect(q.enqueue(backlog({ storyPoints: undefined }))).rejects.toThrow(/not ready|DoR/i)
      await q.enqueue({ id: 'R-1', source: 'roster', title: 'expedite', lane: 'prod' })
      expect(await q.list({ status: 'queued' })).toHaveLength(1)
    })

    it('claimNext with a lane filter returns ONLY those lanes even when a higher-priority other-lane task waits', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-prod', lane: 'prod', priority: 9 }))
      await q.enqueue({ id: 'R-res', source: 'roster', title: 'research it', lane: 'research', priority: 0 })
      const claimed = await q.claimNext('w-research', { lanes: ['research'] })
      expect(claimed.id).toBe('R-res')
      // the high-priority prod task is untouched
      const prod = (await q.list({ lane: 'prod' }))[0]
      expect(prod.status).toBe('queued')
    })

    it('claimNext with lanes:[] returns null and mutates nothing', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog())
      expect(await q.claimNext('w1', { lanes: [] })).toBeNull()
      const [r] = await q.list({})
      expect(r.status).toBe('queued')
    })

    it('stats() reflects every transition', async () => {
      const c = clockOf()
      const q = makeAdapter({ clock: c.fn, expireMs: 1000 })
      await q.enqueue(backlog({ id: 'BL-a' }))
      await q.enqueue(backlog({ id: 'BL-b' }))
      await q.claimNext('w1', {})
      const s = await q.stats()
      expect(s.total).toBe(2)
      expect(s.queued).toBe(1)
      expect(s.claimed).toBe(1)
    })
  })
}
