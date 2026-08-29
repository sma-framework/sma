/**
 * bug-journal.mjs — ЕДИНЫЙ ЖУРНАЛ СРЫВОВ: одна строка на каждую сорвавшуюся задачу, один
 * файл на все проекты, `<ledgerDir>/bugs.jsonl`.
 *
 * ЗАЧЕМ ОН НУЖЕН, ЕСЛИ О СРЫВЕ И ТАК ПИШУТ ТРИ МЕСТА. Именно потому, что три. О сорвавшейся
 * задаче сегодня знают:
 *   · СТРОКА ОЧЕРЕДИ — слово, которое видит экран (`failure_reason`). Оно приходит из вывода
 *     задания: `manual` пишет остановка человеком, `turns_exhausted` — паркующая дверь, а
 *     `attempts_exhausted` вообще не пишется никем и выводится ПРИ ЧТЕНИИ из сообщения
 *     библиотеки. Строка задания живёт по сроку хранения очереди: сметут — слова не станет.
 *   · РЕЕСТР ПОПЫТОК — слово машины, по одному на попытку (`failureReason`), долговечное и
 *     никем не сметаемое.
 *   · ЖУРНАЛ РЕШЕНИЙ — записка работника о подходе, по слоям.
 * Экран показывает ОДНО из первых двух слов: `r.failure_reason ?? last.failureReason`
 * (front/state.mjs). Когда они расходятся — а на живой очереди они расходятся часто:
 * попытка умерла от `liveness_killed`, человек потом снял задачу, и карточка сказала
 * «остановлено вручную» — второе слово не теряется физически, но становится недоступным
 * никому, у кого нет оболочки и часа времени. Вопрос «почему у нас вообще срывается работа»
 * не задаётся ни одному из трёх мест: у каждого из них своя единица (строка задания, попытка,
 * слой) и ни у одного — задача целиком.
 *
 * ЭТОТ ФАЙЛ — ТО САМОЕ МЕСТО, и он не заводит четвёртой правды: он ничего не вычисляет сам,
 * а СВОДИТ уже записанное — слово очереди и слово реестра рядом, в одной строке, под именем
 * задачи. Строка, где два слова разошлись, и есть находка; строка, где оба пусты, — честное
 * «причина не сохранилась нигде».
 *
 * ОДИН ФАЙЛ НА ВСЕ ПРОЕКТЫ, И ЭТО НАМЕРЕННО. Реестр у демона один, а проектов много: «почему
 * срывается работа» — вопрос о машине и о людях, а не о репозитории, и ответ на него нельзя
 * получить, читая два файла по очереди. Проект при этом назван В СТРОКЕ, так что разрез по
 * проекту остаётся возможным, а слияние — бесплатным.
 *
 * ДОПИСЫВАЕТСЯ, НИКОГДА НЕ ПЕРЕПИСЫВАЕТСЯ — тот же закон, что у реестра попыток по соседству:
 * функции, которая правит строку, в этом модуле нет по построению. Один срыв даёт одну строку:
 * правило «не дважды об одном» держит проход ниже (`sweepBugJournal`), который и так держит
 * весь файл в памяти, — а не запись, которая от этого стала бы читать файл на каждый вызов.
 *
 * ВСЁ ЗДЕСЬ FAIL-OPEN. Журнал — это наблюдение за работой, а не условие её: нечитаемый или
 * незаписываемый файл стоит человеку картины и никогда — задачи. Ни одна функция не бросает.
 *
 * ТОЛЬКО КОДЫ, НИКАКИХ ЯРЛЫКОВ. Русские подписи причин живут в одном месте (REASON_LABELS в
 * adapter.mjs) и ставятся читателем; второе их написание здесь означало бы, что строка на
 * диске спорит с экраном о словах, которых на диске никто не просил.
 */

import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { foldAttemptRows } from './attempt-ledger.mjs'

/** Имя журнала — пишется ОДИН раз, читается всеми отсюда же. */
export const BUG_JOURNAL_FILE = 'bugs.jsonl'

/**
 * Потолок на любую строку текста в записи. Заголовок задачи человек пишет сам и может
 * написать сколько угодно; журнал же обязан оставаться файлом, который открывают глазами.
 */
export const BUG_TEXT_CAP = 200

/** ЕДИНСТВЕННЫЕ ключи строки журнала — явный список, тот же закон, что у реестра попыток. */
export const ALLOWED_BUG_KEYS = Object.freeze([
  // кого сорвало и где
  'taskId',
  'project',
  'title',
  // ЧИСЛО ПОПЫТОК, названное очередью: сколько их было к моменту, когда работа закрылась.
  'attempt',
  // ── ДВА СЛОВА О ПРИЧИНЕ, И НИКОГДА ОДНО ──────────────────────────────────────────────
  // `reason` — слово ОЧЕРЕДИ: ровно то, что видит человек на карточке. `cause` — слово
  // РЕЕСТРА: чем кончилась последняя сорвавшаяся попытка по мнению машины. Они совпадают
  // чаще, чем расходятся, и именно расхождение — то, ради чего этот файл заведён: строка,
  // где `reason: manual`, а `cause: turns_exhausted`, говорит, что человек убрал задачу,
  // которая до него уже упёрлась в потолок ходов, — а экран показал только его руку.
  'reason',
  'cause',
  // Номер той самой попытки, чьё слово стоит в `cause`. Без него «причина» повисает между
  // тремя подходами и читается как утверждение обо всей задаче.
  'causeAttempt',
  // Сколько подходов реестр вообще записал. НОЛЬ — это утверждение: попытки не было ни одной
  // (задачу сняли из очереди), и тогда `cause: null` означает «машине нечего было сказать»,
  // а не «сказала и потеряли».
  'attemptsRecorded',
  'workerId',
  'endedAt',
  // Кто дописал строку: `sweep` — проход демона по живой очереди. Одно поле вместо догадки
  // по форме строки.
  'source',
  'recordedAt',
])

/** `<ledgerDir>/bugs.jsonl` — единственное место, где это имя соединяется с каталогом. */
export function bugJournalPath(ledgerDir) {
  return join(ledgerDir, BUG_JOURNAL_FILE)
}

/** Файловый шов: в тестах подставной, в демоне настоящий. */
function io(fsImpl) {
  const f = fsImpl && typeof fsImpl === 'object' ? fsImpl : {}
  return {
    appendFileSync: f.appendFileSync || appendFileSync,
    readFileSync: f.readFileSync || readFileSync,
    mkdirSync: f.mkdirSync || mkdirSync,
  }
}

/** Строка не длиннее потолка, или null — пустое слово не пишется вовсе. */
function text(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (t === '') return null
  return t.length > BUG_TEXT_CAP ? t.slice(0, BUG_TEXT_CAP) : t
}

/**
 * Число или null: «не измерено» и «ноль» — разные утверждения, и оба здесь встречаются.
 *
 * ПУСТОТА ОТСЕИВАЕТСЯ ДО ПРЕОБРАЗОВАНИЯ, и это не придирка: `Number(null)` — ноль, а ноль в
 * поле «номер подхода» читается как «подход номер ноль», то есть как измерение, которого
 * никто не делал. Ровно так в журнал и попали нули у задач, где не было ни одной попытки.
 */
function num(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Отметка времени как СТРОКА ISO, чем бы она ни пришла.
 *
 * Читатель очереди отдаёт `completedAt` объектом `Date` — так его возвращает драйвер базы, —
 * и текстовая проверка молча роняла его в null: журнал полутора сотен строк стоял без единой
 * даты, выглядя при этом совершенно исправным. Дата, которую невозможно разобрать, — тоже
 * null: выдуманная отметка хуже отсутствующей.
 */
function stamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null
  return text(value)
}

/**
 * bugKey(row) → ЧТО СЧИТАЕТСЯ ОДНИМ И ТЕМ ЖЕ СРЫВОМ.
 *
 * Задача, сорвавшаяся, перевыданная человеком и сорвавшаяся снова, — это ДВА срыва, и число
 * попыток очереди их разводит. Один и тот же срыв, увиденный проходом сто раз подряд, — одна
 * строка. Слово причины входит в ключ намеренно: если очередь переменит своё слово о том же
 * подходе (так бывает — остановка человеком поверх упёршейся в потолок попытки), это новая
 * правда о том же срыве, и она обязана попасть в журнал, а не быть проглоченной как дубль.
 */
export function bugKey(row) {
  if (!row || typeof row !== 'object') return null
  const id = typeof row.taskId === 'string' ? row.taskId : null
  if (!id) return null
  const attempt = num(row.attempt)
  return `${id}#${attempt === null ? '-' : attempt}|${text(row.reason) ?? '-'}`
}

/**
 * normalizeBug(entry) → строка журнала по явному списку ключей, или null, если писать нечего.
 *
 * ОТКАЗ ВМЕСТО ВЫДУМКИ: запись без имени задачи — это наблюдение ни о чём, и она не пишется.
 * А вот запись без единого слова о причине пишется охотно: «причина не сохранилась нигде» —
 * это и есть тот ответ, ради которого заводят журнал.
 */
export function normalizeBug(entry) {
  if (!entry || typeof entry !== 'object') return null
  const taskId = text(entry.taskId)
  if (!taskId) return null
  const row = {
    taskId,
    project: text(entry.project),
    title: text(entry.title),
    attempt: num(entry.attempt),
    reason: text(entry.reason),
    cause: text(entry.cause),
    causeAttempt: num(entry.causeAttempt),
    attemptsRecorded: num(entry.attemptsRecorded) ?? 0,
    workerId: text(entry.workerId),
    endedAt: stamp(entry.endedAt),
    source: text(entry.source) ?? 'sweep',
    recordedAt: stamp(entry.recordedAt),
  }
  // Явный список — и как список ключей, и как их ПОРЯДОК: строка на диске должна читаться
  // глазами, а порядок полей, зависящий от того, что пришло от вызывающего, — это файл,
  // который каждый день выглядит иначе.
  const out = {}
  for (const k of ALLOWED_BUG_KEYS) if (row[k] !== undefined) out[k] = row[k]
  return out
}

/**
 * appendBug(ledgerDir, entry, {fsImpl, now}) → дописанная строка, или null.
 *
 * ПРОСТО ДОПИСЫВАЕТ. Правило «не дважды об одном срыве» живёт у прохода, который уже держит
 * весь файл в памяти: перенесённое сюда, оно означало бы чтение всего журнала на каждую
 * запись — цена, купленная ни за что, и второе место, где живёт то же правило.
 *
 * @param {string} ledgerDir
 * @param {object} entry
 * @param {{fsImpl?:object, now?:Function|number}} [opts]
 * @returns {object|null}
 */
export function appendBug(ledgerDir, entry, { fsImpl, now = Date.now } = {}) {
  if (typeof ledgerDir !== 'string' || ledgerDir.trim() === '') return null
  const row = normalizeBug(entry)
  if (!row) return null
  if (!row.recordedAt) row.recordedAt = new Date(typeof now === 'function' ? now() : now).toISOString()
  const fs = io(fsImpl)
  try {
    fs.mkdirSync(ledgerDir, { recursive: true })
    fs.appendFileSync(bugJournalPath(ledgerDir), `${JSON.stringify(row)}\n`, 'utf8')
    return row
  } catch {
    return null // наблюдение за работой не бывает условием работы
  }
}

/**
 * readBugs(ledgerDir, {fsImpl}) → все строки журнала в порядке записи.
 *
 * Отсутствующий журнал читается как ПУСТОЙ, а не как ошибка: до первого срыва его и не должно
 * быть. Испорченная строка пропускается — тот же fail-open, что у всех читателей рядом.
 */
export function readBugs(ledgerDir, { fsImpl } = {}) {
  if (typeof ledgerDir !== 'string' || ledgerDir.trim() === '') return []
  const fs = io(fsImpl)
  let raw
  try {
    raw = String(fs.readFileSync(bugJournalPath(ledgerDir), 'utf8'))
  } catch {
    return []
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      /* испорченную строку пропускаем, никогда не бросаем */
    }
  }
  return rows
}

/**
 * causeOf(attemptRows) → `{cause, causeAttempt, attemptsRecorded, workerId}` — что о срыве
 * говорит РЕЕСТР ПОПЫТОК.
 *
 * Берётся ПОСЛЕДНЯЯ сорвавшаяся попытка, а не последняя вообще: у задачи, которую сняли
 * рукой после трёх падений, последняя строка реестра — та самая рука, а вопрос журнала —
 * «на чём машина сломалась». Строки складываются по номеру подхода (`foldAttemptRows`),
 * потому что о каждой попытке пишут двое, и считать строки за попытки — значит сообщать
 * человеку шесть подходов вместо трёх.
 *
 * @param {object[]} attemptRows — строки реестра одной задачи, как их отдаёт readAttempts
 */
export function causeOf(attemptRows) {
  const records = foldAttemptRows(Array.isArray(attemptRows) ? attemptRows : [])
  let last = null
  for (const rec of records) if (rec && rec.outcome === 'failed') last = rec
  return {
    cause: last ? (text(last.failureReason) ?? null) : null,
    causeAttempt: last ? num(last.attempt) : null,
    attemptsRecorded: records.length,
    workerId: last ? (text(last.workerId) ?? null) : null,
  }
}

/**
 * bugFromRow(row, attemptRows) → запись журнала об ОДНОЙ сорвавшейся задаче, или null, если
 * задача не сорвалась.
 *
 * Единица здесь — ЗАДАЧА, а не попытка, и это единственная причина, по которой сведение
 * вообще имеет смысл: у попытки уже есть свой долговечный дом (строка реестра), а у вопроса
 * «эта работа не вышла — почему» дома не было.
 */
export function bugFromRow(row, attemptRows) {
  if (!row || typeof row !== 'object' || row.status !== 'failed') return null
  const led = causeOf(attemptRows)
  return normalizeBug({
    taskId: row.id,
    project: row.project,
    title: row.title,
    attempt: row.attempt,
    reason: row.failure_reason,
    cause: led.cause,
    causeAttempt: led.causeAttempt,
    attemptsRecorded: led.attemptsRecorded,
    workerId: led.workerId ?? row.workerId,
    endedAt: row.completedAt,
    source: 'sweep',
  })
}

/**
 * summarizeBugs(rows) → `{tasks, byReason, byProject, silent, disagreed, queueOnly}` — журнал,
 * сведённый в числа, которые человек читает первыми.
 *
 * Три величины здесь — про КАЧЕСТВО ЗАПИСИ, а не про качество работы, и потому считаются
 * отдельно от гистограммы причин:
 *   · `silent` — о причине не сказал НИКТО: ни очередь, ни реестр. Ответ на вопрос «по каким
 *     задачам причина не сохранилась нигде» — это ровно этот список.
 *   · `disagreed` — два слова разошлись: экран показывает не то, на чём работа сломалась.
 *   · `queueOnly` — слово есть ТОЛЬКО у очереди. Оно правдиво сегодня и смертно: строка
 *     задания живёт по сроку хранения очереди, а реестр — нет. Такая задача через месяц
 *     переедет в `silent`, если её причину не переписать в журнал сейчас.
 *
 * По задаче берётся ПОСЛЕДНЯЯ её строка: журнал дописывается, и более поздняя правда об одной
 * и той же задаче — та, что стоит ниже.
 */
export function summarizeBugs(rows) {
  const last = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row.taskId === 'string') last.set(row.taskId, row)
  }
  const out = { tasks: last.size, byReason: {}, byProject: {}, silent: [], disagreed: [], queueOnly: [] }
  for (const row of last.values()) {
    const word = row.reason ?? row.cause ?? '(причина нигде не записана)'
    out.byReason[word] = (out.byReason[word] ?? 0) + 1
    const proj = row.project ?? '(проект не назван)'
    out.byProject[proj] = (out.byProject[proj] ?? 0) + 1
    if (!row.reason && !row.cause) out.silent.push(row.taskId)
    else if (row.reason && row.cause && row.reason !== row.cause) out.disagreed.push(row.taskId)
    if (row.reason && !row.cause) out.queueOnly.push(row.taskId)
  }
  return out
}

/**
 * sweepBugJournal({rows, adapter, ledger, clock}) → `{examined, appended, skipped}`.
 *
 * ОДИН ПРОХОД ДЕЛАЕТ ОБЕ РАБОТЫ — и в этом весь смысл. Он же наполняет журнал историей при
 * первом запуске, он же дописывает каждый новый срыв: «журнал заполнили один раз руками, а
 * дальше пишет другой код» — ровно та конструкция, которая расходится с собой через месяц и
 * о которой никто не узнает.
 *
 * ЧИТАЕТ ЖУРНАЛ ОДИН РАЗ ЗА ПРОХОД и держит ключи в памяти прохода — не в памяти демона:
 * реестр, живущий между тиками, разошёлся бы с файлом после любой правки руками, а закон
 * цикла и так запрещает ему хранить ключевые коллекции.
 *
 * FAIL-OPEN ЦЕЛИКОМ, как у соседних проходов тика: одна нечитаемая задача стоит журналу одной
 * строки, а не всего прохода; отсутствие швов — это «нечего делать», а не ошибка.
 *
 * ЧТО ЭТО СТОИТ, СКАЗАНО ВСЛУХ: одно долговечное чтение очереди за проход (то же, что уже
 * делает сверка попыток по соседству) плюс чтение реестра тех задач, которые очередь называет
 * сорвавшимися и о которых в журнале ещё нет строки. У задачи, уже записанной, реестр не
 * читается вовсе — иначе тик каждые несколько секунд перечитывал бы всю историю дома.
 *
 * @param {{rows?:object[], adapter?:object, ledger?:object, clock?:Function|number}} opts
 * @returns {Promise<{examined:number, appended:number, skipped:number}>}
 */
export async function sweepBugJournal({ rows, adapter, ledger, clock = Date.now } = {}) {
  const summary = { examined: 0, appended: 0, skipped: 0 }
  if (!ledger || typeof ledger.appendBug !== 'function' || typeof ledger.readBugs !== 'function') return summary
  if (typeof ledger.readAttempts !== 'function') return summary

  let list = Array.isArray(rows) ? rows : null
  if (!list) {
    if (!adapter || typeof adapter.list !== 'function') return summary
    try {
      list = await adapter.list({})
    } catch {
      return summary // очередь, которая не отвечает, стоит журналу прохода и ничего больше
    }
  }

  let known
  try {
    known = new Set(ledger.readBugs().map((r) => bugKey(r)).filter(Boolean))
  } catch {
    return summary // нечитаемый журнал — не повод дописать в него всё заново
  }

  const now = () => (typeof clock === 'function' ? clock() : clock)
  for (const row of list) {
    if (!row || row.status !== 'failed') continue
    summary.examined += 1
    try {
      // ДЕШЁВАЯ ПРОВЕРКА ПЕРВОЙ: ключ строится из того, что уже лежит в строке очереди, и
      // задача, о которой журнал знает, не стоит нам чтения её реестра.
      const seen = bugKey({ taskId: row.id, attempt: row.attempt, reason: row.failure_reason })
      if (seen && known.has(seen)) {
        summary.skipped += 1
        continue
      }
      const entry = bugFromRow(row, ledger.readAttempts(row.id) || [])
      if (!entry) continue
      const key = bugKey(entry)
      if (key && known.has(key)) {
        summary.skipped += 1
        continue
      }
      const written = ledger.appendBug({ ...entry, recordedAt: new Date(now()).toISOString() })
      if (!written) continue
      if (key) known.add(key)
      summary.appended += 1
    } catch {
      /* одна задача, о которой не вышло написать, никогда не останавливает проход */
    }
  }
  return summary
}
