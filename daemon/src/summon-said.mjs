/**
 * summon-said.mjs — ПАМЯТЬ «УЖЕ СКАЗАНО», КОТОРАЯ ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК ДЕМОНА.
 *
 * ═══════════════════ ПОЧЕМУ ЭТО ФАЙЛ, А НЕ MAP В ПРОЦЕССЕ ═══════════════════════════════
 * Память зова была объявлена ХИНТОМ: «потеря стоит одного лишнего сообщения после
 * перезапуска». Расчёт не сошёлся дважды за одно утро. Демон стартовал два раза, и владелец
 * получил два одинаковых залпа по десять сообщений: каждая работа, стоящая на решении
 * человека, зовётся заново, потому что процесс, помнивший о ней, кончился. Цена потери —
 * не «одно лишнее сообщение», а ВЕСЬ список ожиданий, помноженный на число перезапусков; а
 * канал, который при каждом подъёме демона высыпает в чат всё, что и так стоит на экране,
 * перестают читать — и тогда он молчит уже про всё.
 *
 * Разница с памятью старения (`policy/aging-memory.mjs`), которая честно живёт в процессе, —
 * в цене потери. Там потеря стоит одной лишней СТРОКИ В ЖУРНАЛЕ, который никто не носит с
 * собой. Здесь — сообщения на телефон человека.
 *
 * ═══════════════════ ПОЧЕМУ NDJSON И ДОПИСЫВАНИЕ, А НЕ ФАЙЛ СОСТОЯНИЯ ═══════════════════
 * Та же осанка, что у реестра остановленных волн и у всех прочих леджеров продукта: одна
 * строка на событие, дописыванием. «Сказано» — это СЛОВО, КОТОРОЕ ПРОИЗНЕСЛИ, и переписывание
 * файла целиком на каждое слово теряет историю ровно в тот момент, когда она нужна: «почему
 * бот молчал вчера с обеда» отвечается перечитыванием файла, а не догадкой. Оборванная строка
 * пропускается, а остальная история читается — падение посреди записи стоит одного забытого
 * слова, а не всей памяти.
 *
 * Свод — по последнему слову о каждом ключе: `said` перезаписывает, `forget` убирает. Файл не
 * растёт вечно: при подъёме, если строк заметно больше, чем живых ожиданий, он пересобирается
 * из свода — единственный писатель у него один (демон), и делать это на старте безопасно.
 *
 * Без `dataDir` объект остаётся ЧЕСТНО ПАМЯТЬЮ ПРОЦЕССА и говорит об этом полем `durable`:
 * зов, собранный без данных демона, ведёт себя ровно как вёл, а не притворяется долговечным.
 *
 * Только встроенные модули; fs и часы внедряются, поэтому тесты детерминированы.
 */

import {
  appendFileSync as fsAppend,
  readFileSync as fsRead,
  writeFileSync as fsWrite,
  mkdirSync as fsMkdir,
  existsSync as fsExists,
} from 'node:fs'
import { join } from 'node:path'

/** Файл памяти зова — в данных демона, рядом с прочими его леджерами. */
export const SUMMON_SAID_FILE = 'summon-said.ndjson'

/** Со скольких строк имеет смысл пересобирать файл из свода при подъёме. */
export const SUMMON_SAID_COMPACT_AT = 400

const num = (v) => (Number.isFinite(v) ? v : 0)

/** Запись ожидания в том виде, в каком она ложится на диск: кого звали, о чём и когда. */
function saidRecord(key, entry) {
  const stamp = Math.max(num(entry.lastSentAt), num(entry.lastTryAt), num(entry.hushedAt), num(entry.firstAt))
  return {
    op: 'said',
    key,
    kind: entry.kind ?? '',
    taskId: entry.taskId ?? '',
    firstAt: num(entry.firstAt),
    lastTryAt: num(entry.lastTryAt),
    lastSentAt: num(entry.lastSentAt),
    hushedAt: num(entry.hushedAt),
    at: new Date(stamp).toISOString(),
  }
}

/**
 * createSaidMemory({dataDir, fsImpl, clock}) → {get, remember, forget, keys, size, durable}.
 *
 * Читается ЛЕНИВО и ровно один раз за жизнь объекта: подъём демона не платит за файл, о
 * котором его никто не спросил, а нечитаемый файл не перечитывается на каждом зове.
 */
export function createSaidMemory({ dataDir = '', fsImpl, clock = Date.now } = {}) {
  const read = fsImpl?.readFileSync ?? fsRead
  const write = fsImpl?.writeFileSync ?? fsWrite
  const append = fsImpl?.appendFileSync ?? fsAppend
  const mkdir = fsImpl?.mkdirSync ?? fsMkdir
  const exists = fsImpl?.existsSync ?? fsExists

  const durable = typeof dataDir === 'string' && dataDir.trim() !== ''
  const file = durable ? join(dataDir, SUMMON_SAID_FILE) : ''
  const entries = new Map()
  let hydrated = !durable

  function compact() {
    try {
      mkdir(dataDir, { recursive: true })
      const body = [...entries].map(([key, entry]) => JSON.stringify(saidRecord(key, entry))).join('\n')
      write(file, body === '' ? '' : `${body}\n`, 'utf8')
    } catch {
      /* пересобрать не вышло — история всё равно читается, просто длиннее */
    }
  }

  function hydrate() {
    if (hydrated) return
    hydrated = true
    let raw = ''
    try {
      if (!exists(file)) return
      raw = String(read(file, 'utf8'))
    } catch {
      return // нечитаемая память — это «ничего не сказано», а не мёртвый зов
    }
    let lines = 0
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (t === '') continue
      lines += 1
      let rec
      try {
        rec = JSON.parse(t)
      } catch {
        continue // оборванная строка пропускается, остальная история читается
      }
      if (!rec || typeof rec.key !== 'string' || rec.key === '') continue
      if (rec.op === 'forget') {
        entries.delete(rec.key)
        continue
      }
      if (rec.op !== 'said') continue
      entries.set(rec.key, {
        kind: typeof rec.kind === 'string' ? rec.kind : '',
        taskId: typeof rec.taskId === 'string' ? rec.taskId : '',
        firstAt: num(rec.firstAt),
        lastTryAt: num(rec.lastTryAt),
        lastSentAt: num(rec.lastSentAt),
        hushedAt: num(rec.hushedAt),
      })
    }
    if (lines > SUMMON_SAID_COMPACT_AT && lines > entries.size * 2) compact()
  }

  function line(record) {
    if (!durable) return
    try {
      mkdir(dataDir, { recursive: true })
      append(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      /* диск не принял слово — зов всё равно состоялся, и повтор его не удвоит в эту выдержку */
    }
  }

  return {
    /** Долговечна ли эта память — то есть переживёт ли она перезапуск демона. */
    durable,

    get(key) {
      hydrate()
      return entries.get(key)
    },

    /** Запомнить ожидание — и в процессе, и на диске одним и тем же словом. */
    remember(key, entry) {
      hydrate()
      const kept = {
        kind: entry?.kind ?? '',
        taskId: entry?.taskId ?? '',
        firstAt: num(entry?.firstAt),
        lastTryAt: num(entry?.lastTryAt),
        lastSentAt: num(entry?.lastSentAt),
        hushedAt: num(entry?.hushedAt),
      }
      entries.set(key, kept)
      line(saidRecord(key, kept))
      return kept
    },

    /** Забыть ожидание: работа ушла с приёмки — помнить о ней нечего. */
    forget(key) {
      hydrate()
      if (!entries.delete(key)) return false
      line({ op: 'forget', key, at: new Date(clock()).toISOString() })
      return true
    },

    /** Ключи снимком: перебор идёт по копии, потому что внутри него ожидания забывают. */
    keys() {
      hydrate()
      return [...entries.keys()]
    },

    get size() {
      hydrate()
      return entries.size
    },
  }
}
