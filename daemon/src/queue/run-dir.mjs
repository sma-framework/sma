/**
 * daemon/src/queue/run-dir.mjs — THE RUN DIRECTORY OF ONE ATTEMPT.
 *
 * WHAT IT IS. Every attempt leaves a small directory in the connected project —
 * `<projectDir>/.sma/runs/<attemptId>/` — holding five files:
 *
 *   run.json        what the attempt was GIVEN: the command line, the names of the
 *                   environment variables, the envelope, the copy it ran in, the personal
 *                   layer, the servers, and what the session's own opening frame said back;
 *   guards.jsonl    one line per hook the CLI started and answered, and one per tool the
 *                   guards refused — the evidence that something was actually watching;
 *   transcript.jsonl a REFERENCE to the attempt's transcript in the ledger, with its digest,
 *                   its line count and its size — never a second copy of it;
 *   receipt.json    how the try ENDED: the outcome, the gate that decided it, the verdict,
 *                   the lesson, the memory layer as the stream observed it, and what the try
 *                   cost in the provider's own four numbers (`tokens` — in, out, cache read,
 *                   cache write; `null` when no final frame ever arrived to read them off);
 *   continuation.md THE HANDOVER SUMMARY — what the next try at this task needs to know about
 *                   this one, in prose: the approach that was taken, how it ended and why,
 *                   what the person said when they handed the work back, and which files
 *                   were touched.
 *
 * WHY THE FIFTH FILE IS PROSE AND NOT A FIELD. It has TWO readers that must never disagree —
 * the prompt of the next attempt and the window a person looks at. A field would be rendered
 * twice, shortened twice and would drift twice; a file is read by both, byte for byte. That is
 * also why the ceiling below is applied AT THE WRITE and nowhere else: two readers cutting the
 * same text at lengths of their own is a difference nobody would ever notice.
 *
 * AND NO MODEL IS ASKED TO WRITE IT. Everything in it was already recorded by the attempt —
 * the approach note it printed, the outcome the gate decided, the remark the person left, the
 * answer git gave about the branch. Asking a model to summarise would cost money on every
 * attempt and give a different text each time for the very same facts.
 *
 * WHY A DIRECTORY AND NOT A LOG LINE. The claim a person actually wants checked is «the
 * worker really ran under my rules, with my memory, behind my guards». That claim is made of
 * facts that are scattered across a stream, an operator log and a ledger row, each of which
 * is overwritten, rotated or capped on its own schedule. Gathered into one directory named by
 * the attempt, they become a thing a checking tool can READ — and a thing a person can look
 * at a month later without asking anybody to remember anything.
 *
 * WHY THE TRANSCRIPT IS A REFERENCE. The ledger already holds megabytes of stream per day.
 * A copy beside it would double the disk for nothing and would drift the moment either half
 * were touched. The reference carries the digest of the file at the moment of writing, so a
 * transcript that was replaced afterwards can be told apart from one that was not.
 *
 * SECRETS ARE ABSENT BY CONSTRUCTION, NOT BY FILTERING. `run.json` carries the NAMES of the
 * environment variables the spawn was handed and never their values; the prompt is reduced to
 * a digest and a size. `sanitizeRun` is the second belt, not the first: it is handed the
 * values the caller knows to be secret and redacts any string that still contains one.
 *
 * ROTATION LEAVES A TRACE. The directory is bounded (200 by default) because an unbounded one
 * is a disk failure waiting for a busy week. Every removal writes one line to the operator's
 * log naming what was removed — «it can be rolled back» and «it is visible what was removed»
 * are two different guarantees, and a silent sweep only ever provides the first.
 *
 * EVERYTHING HERE IS FAIL-OPEN. A run directory that cannot be written is a lost record, not
 * a lost attempt: every entry point reports through the injected `log` and returns an honest
 * absence rather than throwing into the tick.
 */

import { createHash } from 'node:crypto'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

import { safeName } from './attempt-ledger.mjs'
import { ATTEMPT_LOG_LINE_CAP } from '../front/journal.mjs'

/** The schema tag on `run.json` — a reader must never have to guess which shape it holds. */
export const RUN_SCHEMA = 'sma-run/1'
/**
 * ОТКАЗ ВТОРОМУ ПИСАТЕЛЮ — одно слово, которым каталог попытки защищает уже записанную правду.
 *
 * ЗАЧЕМ ОНО ПОЯВИЛОСЬ, ПО ОТПЕЧАТКАМ, А НЕ ПО РАССУЖДЕНИЮ. У живой задачи в каталоге «попытка
 * 2» лежал промпт, побайтно равный промпту попытки 1, тогда как промпт второй попытки видели
 * живьём и он был другим: в каталог писала попытка, стартовавшая четырьмя секундами позже под
 * тем же номером. Каталог назван номером подхода, номер повторился — и запись первого писателя
 * молча ушла под запись второго.
 *
 * ЧТО ИМЕННО ЛОМАЕТСЯ ОТ ПЕРЕЗАПИСИ. Не «файлы устарели», а разбор попытки начинает ВРАТЬ:
 * отпечаток промпта, свидетель снимка и квитанция отвечают на вопрос «что видел работник в
 * ЭТОЙ попытке» данными чужого подхода, и отличить это от честного ответа нельзя ничем.
 *
 * ПОЧЕМУ ОТКАЗ, А НЕ ВТОРОЕ ИМЯ КАТАЛОГА. Имя попытки — это `<taskId>#<n>`, и его знает не
 * только этот модуль: по нему названы стенограмма в реестре, строка журнала и путь на карточке.
 * Переименовать каталог значило бы развести его с ними; отказать — значит оставить провод как
 * есть и потерять ровно одну запись вместо ровно одной правды. Уникальность номера чинится
 * там, где номер выдают (очередь), а это — последний пояс, который держит, даже если тот
 * порвётся.
 */
export const RUN_DIR_TAKEN = 'run_dir_taken'
/** The schema tag on `receipt.json`. */
export const RECEIPT_SCHEMA = 'sma-receipt/1'
/** How many attempt directories the project keeps before the oldest are swept. */
export const RUN_DIRS_KEEP = 200
/** The name of the handover summary — spelled ONCE, by the writer and by both readers. */
export const CONTINUATION_FILE = 'continuation.md'

/**
 * HOW LONG A HANDOVER SUMMARY MAY EVER BE ON DISK — eight thousand characters, applied AT THE
 * WRITE and exactly once.
 *
 * The number is a contract, not a detail. Both readers of this file take the text as it lies;
 * if either of them cut it to a length of its own, a person would be reading one summary on the
 * screen while the worker was handed another, and nothing would say so. A bounded write is also
 * the only thing standing between a pathological attempt and a prompt swollen by its own history.
 */
export const CONTINUATION_CAP = 8000

/**
 * The mark a shortened summary carries INSIDE ITS OWN TEXT. It travels with the words, so a
 * reader that never heard of this module still learns it is holding a part rather than a whole —
 * silence there is how «the attempt said nothing more» gets confused with «the rest did not fit».
 */
export const CONTINUATION_TRUNCATED_MARK = '\n\n[конспект обрезан по потолку в 8000 знаков]\n'

/**
 * СНИМОК КОНТЕКСТА ЗАДАЧИ — ИМЯ ОДНО НА ДВА МЕСТА, И ЭТО НАМЕРЕННО.
 *
 * Этим же именем документ ложится в корень рабочей копии, где его читает работник. Здесь,
 * в каталоге попытки, лежит его второй экземпляр — для человека и для двери карточки. Это
 * ОДИН документ «что попытке дали» в двух экземплярах для двух читателей; разные имена
 * разорвали бы очевидность тождества, а владелец у имени должен быть один, и он здесь.
 *
 * ЗАЧЕМ ЭКЗЕМПЛЯР У ПОПЫТКИ, если он уже есть в копии. Копию убирают, а строку очереди
 * человек правит: через месяц ни одна из них не ответит, с каким снимком запускали ИМЕННО
 * ЭТУ попытку. У каждой попытки свой каталог и своя правда о том, что ей дали.
 */
export const TASK_CONTEXT_FILE = 'task_context.md'

/** The six names, in one place: the writer and any reader agree by construction. */
export const RUN_FILES = Object.freeze([
  'run.json',
  'guards.jsonl',
  'transcript.jsonl',
  'receipt.json',
  CONTINUATION_FILE,
  TASK_CONTEXT_FILE,
])

/**
 * The shape of an environment variable name whose VALUE must never be written anywhere.
 * Deliberately broad: a name nobody thought of is a leak, and a name matched by mistake costs
 * only that one value being treated as a secret.
 */
export const SECRET_ENV_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION_ID)/i

/** The mark a redacted string leaves — visible in a file, useless to anybody who finds it. */
const REDACTED = '[redacted]'

/** A value short enough to appear inside ordinary prose is not treated as a secret needle. */
const MIN_SECRET_LEN = 8

/** The filesystem seam: injected in tests, the real one in a daemon. */
function io(fsImpl) {
  const f = fsImpl && typeof fsImpl === 'object' ? fsImpl : {}
  return {
    mkdirSync: f.mkdirSync || mkdirSync,
    writeFileSync: f.writeFileSync || writeFileSync,
    readFileSync: f.readFileSync || readFileSync,
    readdirSync: f.readdirSync || readdirSync,
    renameSync: f.renameSync || renameSync,
    rmSync: f.rmSync || rmSync,
    statSync: f.statSync || statSync,
  }
}

/** Report through the injected log; a log that throws is still not allowed to cost a run. */
function say(log, entry) {
  if (typeof log !== 'function') return
  try {
    log(entry)
  } catch {
    /* even the complaint is fail-open */
  }
}

/** How many outstanding tool calls one stream remembers before it forgets the oldest. */
export const PENDING_TOOLS_CAP = 2000

/**
 * createToolPairing({cap}) — the little bookkeeping that turns «работник попросил файл» into
 * «файл вернулся»: a bounded map of tool calls waiting for their result, plus the set of calls
 * a guard already refused so a frame and its failed result never become two records.
 *
 * WHY IT LIVES HERE AND NOT IN THE TICK. `loop.mjs` holds no keyed collection by law — the
 * daemon is a poll over durable state and every in-process registry it ever grew became a
 * thing that disagreed with the database after a restart. The law names its own way out: a
 * keyed lookup belongs in a helper module. This is that module — the pairing exists only to
 * fill the attempt's own record, and it dies with the stream that made it.
 *
 * BOUNDED ON PURPOSE. A session that asks for thousands of tools and is cut off before their
 * results arrive must not grow this forever; the oldest entry is dropped, which costs one
 * unpaired observation and never a night of memory.
 *
 * @param {{cap?:number}} [opts]
 */
export function createToolPairing({ cap = PENDING_TOOLS_CAP } = {}) {
  const asked = new Map()
  const refused = new Set()
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : PENDING_TOOLS_CAP
  return {
    /** Remember one asked-for call. An id-less block is simply not remembered. */
    remember(id, entry) {
      if (typeof id !== 'string' || id === '') return
      if (asked.size >= limit) {
        const oldest = asked.keys().next()
        if (!oldest.done) asked.delete(oldest.value)
      }
      asked.set(id, entry)
    },
    /** The call this result answers, removed as it is handed over — a result arrives once. */
    take(id) {
      if (typeof id !== 'string' || id === '') return null
      const entry = asked.get(id) ?? null
      asked.delete(id)
      return entry
    },
    /** Was this call already recorded as refused by a guard? */
    refused(id) {
      return typeof id === 'string' && refused.has(id)
    },
    /** Record it as refused, so the failed result that follows adds no second line. */
    markRefused(id) {
      if (typeof id === 'string' && id !== '') refused.add(id)
    },
  }
}

/** `<projectDir>/.sma/runs` — the ONE place this product keeps the runs of a project. */
export function runsDirOf(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null
  return join(projectDir, '.sma', 'runs')
}

/**
 * attemptRunDir({runsDir, attemptId}) → the directory of ONE attempt, or null.
 *
 * ONE EXPRESSION, TWO CALLERS, AND THAT IS THE POINT. The record at the END of an attempt
 * writes here, and now the SPAWN at the beginning needs the same path — it hands it to the
 * child so a gate running inside the worker's own process knows where its tickets live. Two
 * places joining the same three pieces by hand is exactly how a path comes to be spelled two
 * ways, and a gate writing tickets into a directory nobody reads is a gate that silently
 * does nothing.
 */
export function attemptRunDir({ runsDir, attemptId } = {}) {
  if (typeof runsDir !== 'string' || runsDir.trim() === '' || !attemptId) return null
  return join(runsDir, safeName(attemptId))
}

/**
 * runOwnerOf({dir, fsImpl}) → КТО УЖЕ ЗАПИСАЛ СЕБЯ В ЭТОТ КАТАЛОГ, или `null`, если никто.
 *
 * ЗАНЯТОСТЬ ЧИТАЕТСЯ ПО `run.json`, А НЕ ПО СУЩЕСТВОВАНИЮ КАТАЛОГА, и это не деталь: каталог
 * создаёт СПАВН в самом начале попытки — до того, как хоть что-нибудь о ней известно, — чтобы
 * страж внутри работника знал, куда класть свои квитки. Пустой каталог поэтому означает
 * «попытка идёт», а занят он ровно тогда, когда в нём лежит чья-то запись начала.
 *
 * НЕЧИТАЕМЫЕ БАЙТЫ — ТОЖЕ ЗАНЯТО. Испорченный `run.json` не даёт назвать владельца по имени, но
 * он доказывает, что сюда уже писали; прочитать его как «свободно» значило бы затереть чужую
 * запись именно там, где с ней уже что-то не так.
 *
 * @returns {{attemptId:(string|null), startedAt:(string|null), sessionId:(string|null)}|null}
 */
export function runOwnerOf({ dir, fsImpl } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return null
  const fs = io(fsImpl)
  let raw
  try {
    raw = String(fs.readFileSync(join(dir, 'run.json'), 'utf8'))
  } catch {
    return null // никто здесь не писал — каталог свободен
  }
  let record = null
  try {
    record = JSON.parse(raw)
  } catch {
    /* байты есть, прочесть их нельзя — владелец безымянный, но каталог занят */
  }
  const said = (k) => (record && typeof record === 'object' && typeof record[k] === 'string' ? record[k] : null)
  return { attemptId: said('attemptId'), startedAt: said('startedAt'), sessionId: said('sessionId') }
}

/**
 * The values of `env` whose NAMES say they are secret — the needles `sanitizeRun` looks for.
 * The caller passes the spawn's own environment: nothing else knows which of its names the
 * account happens to use for a token on this host.
 *
 * @param {Record<string,string>} [env]
 * @returns {string[]}
 */
export function secretValuesOf(env) {
  if (!env || typeof env !== 'object') return []
  const out = []
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LEN) continue
    if (SECRET_ENV_RE.test(name)) out.push(value)
  }
  return out
}

/**
 * sanitizeRun(run, {secretValues}) — the SECOND belt over a record that already carries no
 * secret by construction. Any string anywhere in the object that contains one of the given
 * values is replaced whole: a partially masked token is still a token in two pieces.
 *
 * @param {object} run
 * @param {{secretValues?:string[]}} [opts]
 * @returns {object} a copy, never the argument
 */
export function sanitizeRun(run, { secretValues } = {}) {
  const needles = (Array.isArray(secretValues) ? secretValues : []).filter(
    (v) => typeof v === 'string' && v.length >= MIN_SECRET_LEN,
  )
  const walk = (value) => {
    if (typeof value === 'string') return needles.some((n) => value.includes(n)) ? REDACTED : value
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = walk(v)
      return out
    }
    return value
  }
  return walk(run && typeof run === 'object' ? run : {})
}

/** Write one file so a reader never sees half of it; a seam without rename writes directly. */
function writeAtomic(fs, path, text) {
  const tmp = `${path}.tmp`
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, path)
    return
  } catch {
    /* an in-memory seam may know no rename — the direct write below is the honest fallback */
  }
  fs.writeFileSync(path, text, 'utf8')
}

/**
 * ledgerRef({ledgerPath, fsImpl}) → the ONE line `transcript.jsonl` holds.
 *
 * `truncatedLines` is the count of transcript rows the ledger's line cap cut short. It is
 * written down because it is the difference between «the stream said nothing about this» and
 * «the stream said it and the record could not hold it» — the second is a fact about the
 * STORE, and a checking tool that cannot tell the two apart reports a false absence.
 *
 * A ledger that cannot be read yields a reference that says so, never a throw: the attempt's
 * transcript may have been rotated away, and that is a state of the world, not an error.
 *
 * @param {{ledgerPath?:string, fsImpl?:object}} [args]
 * @returns {{kind:string, ledgerPath:(string|null), sha256:(string|null), lines:number,
 *           bytes:number, truncatedLines:number, unreadable?:boolean}}
 */
export function ledgerRef({ ledgerPath, fsImpl } = {}) {
  const path = typeof ledgerPath === 'string' && ledgerPath.trim() !== '' ? ledgerPath : null
  const base = { kind: 'ledger-ref', ledgerPath: path, sha256: null, lines: 0, bytes: 0, truncatedLines: 0 }
  if (!path) return { ...base, unreadable: true }
  const fs = io(fsImpl)
  let raw
  try {
    raw = String(fs.readFileSync(path, 'utf8'))
  } catch {
    return { ...base, unreadable: true }
  }
  const rows = raw.split('\n').filter((l) => l.trim() !== '')
  let truncated = 0
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row)
      if (typeof parsed.line === 'string' && parsed.line.length >= ATTEMPT_LOG_LINE_CAP) truncated += 1
    } catch {
      /* a row this reader cannot parse is still a row — it is counted and not judged */
    }
  }
  return {
    ...base,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    lines: rows.length,
    bytes: Buffer.byteLength(raw, 'utf8'),
    truncatedLines: truncated,
  }
}

/**
 * writeRunStart({runsDir, attemptId, run, guards, ledgerPath, secretValues, fsImpl, log})
 * → `{dir}` — the three files that are known BEFORE any gate has decided anything.
 *
 * `receipt.json` is deliberately NOT written here. An empty receipt would be indistinguishable
 * from an attempt still running, and the difference between «it has not ended yet» and «it
 * ended and nobody wrote down how» is the whole reason this directory exists.
 *
 * ОДИН КАТАЛОГ — ОДНА ПОПЫТКА, И ВТОРОЙ ПИСАТЕЛЬ ПОЛУЧАЕТ ОТКАЗ (см. RUN_DIR_TAKEN). Запись,
 * которая уже лежит, не переписывается ничем: она — точка возврата, и точка возврата, которую
 * можно затереть следующим подходом, точкой возврата не является. Отказ возвращается ЧЕСТНЫМ
 * отсутствием каталога (`dir: null`) и НАЗЫВАЕТСЯ в журнале оператора — попытка без каталога
 * бывает и по другим причинам, и человек обязан уметь отличить «номер был занят» от «диск не
 * дал писать».
 *
 * @returns {{dir:(string|null), refused?:string, owner?:object}}
 */
export function writeRunStart({ runsDir, attemptId, run, guards, ledgerPath, secretValues, fsImpl, log } = {}) {
  if (typeof runsDir !== 'string' || runsDir.trim() === '' || !attemptId) {
    say(log, { type: 'run_dir.error', reason: 'no_runs_dir', attemptId: attemptId ?? null })
    return { dir: null }
  }
  const fs = io(fsImpl)
  // THE SAME EXPRESSION THE SPAWN USED. It is not joined here a second time: the spawn
  // created this directory before the process existed, and if the two ever spelled the path
  // differently the record would land beside the tickets instead of among them.
  const dir = attemptRunDir({ runsDir, attemptId })
  // ЗАНЯТО — ЗНАЧИТ ЧУЖОЕ. Спрошено ДО первой записи: отказ после того, как `run.json` уже
  // переписан, был бы отказом, который сам сделал то, что запрещает.
  const owner = runOwnerOf({ dir, fsImpl })
  if (owner) {
    say(log, { type: 'run_dir.taken', reason: RUN_DIR_TAKEN, attemptId: String(attemptId), dir, owner })
    return { dir: null, refused: RUN_DIR_TAKEN, owner }
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const record = sanitizeRun({ schema: RUN_SCHEMA, attemptId: String(attemptId), ...(run || {}) }, { secretValues })
    writeAtomic(fs, join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
    // ALWAYS WRITTEN, EVEN EMPTY: zero lines is the statement «no hook spoke and no tool was
    // refused», which is a finding. A missing file would only say «nobody wrote one».
    const lines = (Array.isArray(guards) ? guards : []).map((g) => JSON.stringify(sanitizeRun(g, { secretValues })))
    writeAtomic(fs, join(dir, 'guards.jsonl'), lines.length ? `${lines.join('\n')}\n` : '')
    writeAtomic(fs, join(dir, 'transcript.jsonl'), `${JSON.stringify({ ...ledgerRef({ ledgerPath, fsImpl }), writtenAt: new Date().toISOString() })}\n`)
    return { dir }
  } catch (err) {
    say(log, { type: 'run_dir.error', attemptId: String(attemptId), error: String((err && err.message) || err) })
    return { dir: null }
  }
}

/**
 * writeRunReceipt({dir, receipt, fsImpl, log}) → did the outcome reach the directory?
 * Called by whoever KNOWS the outcome — the door that completes or refuses the attempt.
 *
 * @returns {boolean}
 */
export function writeRunReceipt({ dir, receipt, fsImpl, log } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return false
  const fs = io(fsImpl)
  try {
    const record = { schema: RECEIPT_SCHEMA, ...(receipt || {}), writtenAt: new Date().toISOString() }
    writeAtomic(fs, join(dir, 'receipt.json'), `${JSON.stringify(record, null, 2)}\n`)
    return true
  } catch (err) {
    say(log, { type: 'run_dir.error', dir, error: String((err && err.message) || err) })
    return false
  }
}

/**
 * ЧЕТЫРЕ ЧИСЛА ПОСТАВЩИКА, НАЗВАННЫЕ ОДИН РАЗ — теми же именами, какими их пишет квитанция.
 *
 * Второе написание этих имён в модуле-читателе — ровно тот способ молча получить нули на
 * квитанции, которая всё сказала: поле `cacheRead`, прочитанное как `cache_read`, отсутствует
 * совершенно честно на вид.
 */
export const TOKEN_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite'])

/** «Потрачено ноль» — четыре числа, а не пустой объект: складывающий не должен знать имён. */
export function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/**
 * readRunTokens({dir, fsImpl}) → четыре числа ОДНОЙ попытки, или `null`.
 *
 * ЧИТАТЕЛЬ ЖИВЁТ РЯДОМ С ПИСАТЕЛЕМ — как и у конспекта, и у свидетеля снимка выше. Имя файла и
 * имя поля принадлежат этому модулю; дверь, которая полезла бы в `receipt.json` сама, завела бы
 * второе мнение о том, где лежат числа и как они называются.
 *
 * NULL — ЭТО УТВЕРЖДЕНИЕ, и оно то же самое, что делает сама квитанция: финального кадра не
 * было, попытка старше этого поля, каталог подмели — «поставщик ничего не сказал». Нули на этом
 * месте были бы утверждением «поставщик сказал ноль», а это другое предложение.
 *
 * НЕЧИСЛО ВНУТРИ НАЗВАННОГО ОБЪЕКТА — НОЛЬ, а не отказ: квитанция, у которой поле есть, уже
 * сказала «числа здесь»; спорить с ней целиком из-за одного испорченного счётчика значит терять
 * три хороших числа ради одного плохого.
 *
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number}|null}
 */
export function readRunTokens({ dir, fsImpl } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return null
  const fs = io(fsImpl)
  let record
  try {
    record = JSON.parse(String(fs.readFileSync(join(dir, 'receipt.json'), 'utf8')))
  } catch {
    return null
  }
  const tokens = record && typeof record === 'object' ? record.tokens : null
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null
  const out = zeroTokens()
  for (const field of TOKEN_FIELDS) {
    const n = Number(tokens[field])
    if (Number.isFinite(n)) out[field] = n
  }
  return out
}

/**
 * sumRunTokens({runsDir, attemptIds, fsImpl}) → четыре числа, сложенные по НАЗВАННЫМ попыткам,
 * или `null`, когда складывать негде.
 *
 * ДЕШЁВАЯ ЧЕСТНОСТЬ ВМЕСТО ПОЛНОТЫ, и разница между двумя видами «нечего показать» — весь смысл
 * возвращаемого значения. Попытка, чья квитанция без чисел (или подметена вместе с каталогом),
 * даёт НОЛЬ и не роняет сумму: она правда ничего не сообщила, а работа остальных попыток от
 * этого не перестаёт быть измеренной. А вот каталога прогонов, которого нет вовсе — задача чужой
 * машины, проект не подключён — не бывает «на ноль»: там мы не измеряли, и сумма честно
 * отсутствует.
 *
 * ИДЕНТИФИКАТОРЫ ПОПЫТОК ПРИХОДЯТ СНАРУЖИ. Правило «как зовут попытку номер N задачи X» живёт у
 * того, кто его завёл; здешнее дело — сложить то, что лежит в названных каталогах.
 *
 * @param {{runsDir?:string, attemptIds?:string[], fsImpl?:object}} [args]
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number}|null}
 */
export function sumRunTokens({ runsDir, attemptIds, fsImpl } = {}) {
  if (typeof runsDir !== 'string' || runsDir.trim() === '') return null
  const total = zeroTokens()
  for (const attemptId of Array.isArray(attemptIds) ? attemptIds : []) {
    const part = readRunTokens({ dir: attemptRunDir({ runsDir, attemptId }), fsImpl })
    if (!part) continue
    for (const field of TOKEN_FIELDS) total[field] += part[field]
  }
  return total
}

/**
 * One entry of the changed-file list as a person reads it, a rename naming both its sides.
 * EXPORTED because it is now asked for by TWO writers — the attempt's own log line and the
 * handover summary below — and two spellings of one format is how one of them starts lying.
 */
export function fileWord(f) {
  return f && f.from ? `${f.status} ${f.from} → ${f.path}` : `${(f && f.status) || '?'} ${(f && f.path) || ''}`
}

/**
 * buildContinuationSummary({...}) → the text of `continuation.md`, assembled from facts the
 * attempt ALREADY recorded. Nothing here is computed, asked or inferred: the approach note the
 * worker printed, the outcome the closing door decided, the remark the person left when they
 * handed the work back, and git's own answer about the branch.
 *
 * A SUMMARY WITH NOTHING IN IT SAYS SO. An attempt that left no note, changed no file and was
 * returned without a word still gets a file — one that states in words that there is nothing to
 * hand over. An absent file would say «this product does not write summaries»; an empty one
 * would say nothing at all. Both are worse than a short honest sentence, because the next
 * attempt reads this to decide whether it is starting over or carrying on.
 *
 * @returns {string}
 */
export function buildContinuationSummary({
  taskId,
  attempt,
  outcome,
  failureReason,
  verdict,
  approach,
  rejected,
  returnNote,
  files,
  deletions,
} = {}) {
  const nth = Number.isFinite(Number(attempt)) ? Number(attempt) : '?'
  const head = [
    `# Конспект передачи — задача ${String(taskId ?? '?')}, подход ${nth}`,
    '',
    '## Чем кончился прошлый подход',
    `исход: ${String(outcome ?? 'неизвестен')}`,
  ]
  if (failureReason) head.push(`причина: ${String(failureReason)}`)
  if (verdict) head.push(`вердикт: ${String(verdict)}`)

  // ЧТО ПОПЫТКА ДЕЙСТВИТЕЛЬНО ОСТАВИЛА ПОСЛЕ СЕБЯ. Исход есть всегда — его пишет дверь;
  // всё остальное бывает и не бывает, а пустой заголовок над отсутствующим содержимым читается
  // как утверждение, которого никто не делал.
  const said = []
  if (approach) said.push('', '## Какой подход был выбран', String(approach))
  const turnedDown = (Array.isArray(rejected) ? rejected : []).filter(Boolean)
  if (turnedDown.length > 0) said.push('', '## Что было отвергнуто', ...turnedDown.map((r) => `- ${String(r)}`))
  // ЗАГОЛОВОК НАЗЫВАЕТ ТО, ЧТО ПРАВДА. Конспект пишется в КОНЦЕ подхода, и замечание,
  // которое лежит на строке задачи в этот момент, — это то, с которым задачу отдали В ЭТОТ
  // подход, а не то, с которым её вернут из него: второго ещё не существует. Назвать его
  // «замечанием при возврате» значило бы приписать человеку слова на один подход вперёд.
  if (returnNote) said.push('', '## С чем человек отдал задачу в этот подход', String(returnNote))
  const touched = (Array.isArray(files) ? files : []).filter(Boolean)
  if (touched.length > 0) said.push('', '## Какие файлы были тронуты', ...touched.map((f) => `- ${fileWord(f)}`))
  const gone = (Array.isArray(deletions) ? deletions : []).filter(Boolean)
  if (gone.length > 0) said.push('', '## Что после подхода исчезло', ...gone.map((x) => `- ${String(x)}`))

  if (said.length === 0) {
    head.push(
      '',
      'Прошлому подходу нечего передать: ни записки о подходе, ни изменённых файлов, и человек при возврате ничего не сказал.',
    )
  } else {
    head.push(...said)
  }
  return `${head.join('\n')}\n`
}

/**
 * writeContinuation({dir, text, secretValues, fsImpl, log}) → did the summary reach the disk?
 *
 * TWO BELTS, IN THIS ORDER AND NOT THE OTHER. Secrets are cut FIRST, line by line, through the
 * very same walker every other file of this directory goes through — a needle sliced in half by
 * the ceiling would match nothing and would leave one half of a token lying in a file. Only then
 * is the text shortened, once, and the mark is appended AFTER the cut so the mark itself can
 * never be the thing that gets truncated.
 *
 * @returns {boolean}
 */
export function writeContinuation({ dir, text, secretValues, fsImpl, log } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return false
  const fs = io(fsImpl)
  try {
    // THE SAME SECOND BELT, applied per LINE. Handed the whole document, the walker would
    // redact all of it over one bad line; handed a line, it redacts a line — which is the
    // behaviour the rest of this directory already has, every other record being a tree of
    // short strings rather than one long one.
    const safe = sanitizeRun({ lines: String(text ?? '').split('\n') }, { secretValues }).lines.join('\n')
    const capped =
      safe.length > CONTINUATION_CAP
        ? `${safe.slice(0, CONTINUATION_CAP - CONTINUATION_TRUNCATED_MARK.length)}${CONTINUATION_TRUNCATED_MARK}`
        : safe
    writeAtomic(fs, join(dir, CONTINUATION_FILE), capped)
    return true
  } catch (err) {
    say(log, { type: 'run_dir.error', dir, error: String((err && err.message) || err) })
    return false
  }
}

/**
 * writeTaskContext({dir, text, secretValues, fsImpl, log}) → доехал ли свидетель до диска?
 *
 * ЧТО ЭТО. Экземпляр снимка контекста, оставленный У ПОПЫТКИ: рабочую копию однажды уберут,
 * а строку очереди человек перепишет — и тогда единственным местом, где сохранится ответ
 * «с каким снимком запускали ИМЕННО ЭТУ попытку», останется её каталог.
 *
 * ОДИН ПОЯС, А НЕ ДВА. Секреты режутся первыми, по строкам, тем же обходчиком, что у всех
 * остальных файлов этого каталога. А вот второго потолка здесь НЕТ — намеренно, и это
 * отличие от соседней функции: у конспекта передачи писатель и есть единственный вход, а у
 * снимка вход один и он в другом месте — дверь постановки, где потолок ОТКАЗЫВАЕТ, а не
 * режет. Подрезать здесь второй раз значило бы завести вторую правду о длине, которая
 * разъедется с первой молча.
 *
 * ПУСТОЙ ТЕКСТ НЕ ПИШЕТСЯ ВОВСЕ: отсутствие файла — это «человек ничего не сказал», а пустой
 * файл сказал бы, что сказал и промолчал.
 *
 * @returns {boolean}
 */
export function writeTaskContext({ dir, text, secretValues, fsImpl, log } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return false
  const raw = String(text ?? '')
  if (raw.trim() === '') return false
  const fs = io(fsImpl)
  try {
    const safe = sanitizeRun({ lines: raw.split('\n') }, { secretValues }).lines.join('\n')
    writeAtomic(fs, join(dir, TASK_CONTEXT_FILE), `${safe}\n`)
    return true
  } catch (err) {
    say(log, { type: 'run_dir.error', dir, error: String((err && err.message) || err) })
    return false
  }
}

/**
 * readTaskContext({dir, fsImpl}) → текст свидетеля снимка, или null, если его нет.
 *
 * ЧИТАТЕЛЬ ЖИВЁТ РЯДОМ С ПИСАТЕЛЕМ, а не у двери, которой он понадобился первой: имя файла
 * принадлежит замороженному списку этого каталога, и второе написание имени в другом модуле —
 * ровно тот способ прочитать не тот файл, который положили. Читателей у свидетеля будет больше
 * одного (дверь карточки — только первый), и все они спрашивают отсюда.
 *
 * NULL — ЭТО УТВЕРЖДЕНИЕ. Снимка не было вовсе, попытка старше этого файла, файл пуст — всё
 * это «показывать нечего», и вызывающий превращает его в ОТСУТСТВИЕ поля, а не в пустую
 * строку: «нечего показать» и «не знаем» — разные предложения.
 *
 * НИЧЕГО НЕ РЕЖЕТ И НЕ ПРАВИТ: текст отдаётся ровно тем, чем лежит на диске. Второй потолок у
 * читателя означал бы, что человек в окне видит не то, что получил работник.
 *
 * @returns {string|null}
 */
export function readTaskContext({ dir, fsImpl } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return null
  const fs = io(fsImpl)
  let raw
  try {
    raw = String(fs.readFileSync(join(dir, TASK_CONTEXT_FILE), 'utf8'))
  } catch {
    return null
  }
  return raw.trim() === '' ? null : raw
}

/**
 * readContinuation({dir, fsImpl}) → `{text, truncated}`, or null when this attempt left none.
 *
 * NULL IS A STATEMENT. A first attempt has no predecessor, and a task older than this file has
 * none either; both are ordinary and neither is an error. The callers turn that null into an
 * ABSENCE — no block in the prompt, no panel on the screen — rather than into an empty string,
 * because «нечего показать» and «не знаем» are different sentences and only one of them is true.
 *
 * WHETHER IT WAS SHORTENED IS READ OFF THE TEXT, never off a neighbouring field: the mark lives
 * in the words, so there is one source and no second opinion to drift from it.
 *
 * @returns {{text:string, truncated:boolean}|null}
 */
export function readContinuation({ dir, fsImpl } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return null
  const fs = io(fsImpl)
  let raw
  try {
    raw = String(fs.readFileSync(join(dir, CONTINUATION_FILE), 'utf8'))
  } catch {
    return null
  }
  if (raw.trim() === '') return null
  return { text: raw, truncated: raw.includes(CONTINUATION_TRUNCATED_MARK.trim()) }
}

/**
 * pruneRunDirs({runsDir, keep, fsImpl, log}) → `{removed, kept}`.
 *
 * The newest `keep` directories stay; the rest are removed, each one named in the operator's
 * log as it goes. Age is read from `run.json.startedAt` and falls back to the directory's own
 * mtime — a directory whose run.json never landed is exactly the kind of leftover a sweep is
 * for, and it must not be immortal for being unreadable.
 *
 * @param {{runsDir?:string, keep?:number, fsImpl?:object, log?:Function}} [args]
 * @returns {{removed:string[], kept:number}}
 */
export function pruneRunDirs({ runsDir, keep = RUN_DIRS_KEEP, fsImpl, log } = {}) {
  const out = { removed: [], kept: 0 }
  if (typeof runsDir !== 'string' || runsDir.trim() === '') return out
  const limit = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : RUN_DIRS_KEEP
  const fs = io(fsImpl)

  let names = []
  try {
    names = (fs.readdirSync(runsDir) || []).map((n) => (typeof n === 'string' ? n : n && n.name)).filter(Boolean)
  } catch {
    return out // no runs directory yet is the state we wanted
  }

  const dated = []
  for (const name of names) {
    const path = join(runsDir, name)
    let at = NaN
    try {
      at = Date.parse(String(JSON.parse(String(fs.readFileSync(join(path, 'run.json'), 'utf8'))).startedAt))
    } catch {
      /* an unreadable run.json falls through to the directory's own mtime below */
    }
    if (!Number.isFinite(at)) {
      try {
        at = Number(fs.statSync(path).mtimeMs)
      } catch {
        continue // an entry that vanished under us needs no deleting
      }
    }
    dated.push({ name, path, at: Number.isFinite(at) ? at : 0 })
  }

  dated.sort((a, b) => b.at - a.at) // newest first — the survivors are the head of the list
  out.kept = Math.min(dated.length, limit)
  for (const entry of dated.slice(limit)) {
    try {
      fs.rmSync(entry.path, { recursive: true, force: true })
      out.removed.push(entry.name)
      // THE TRACE THE LAW ASKS FOR: what was removed, by what, and when it had started. A
      // sweep nobody can name afterwards is indistinguishable from a directory that was
      // never written at all.
      say(log, { type: 'run-dir-pruned', dir: entry.path, attemptId: entry.name, startedAt: new Date(entry.at).toISOString() })
    } catch {
      out.kept += 1 // a directory we may not delete is one we keep, never a thrown tick
    }
  }
  return out
}
