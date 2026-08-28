/**
 * outage.mjs — ПАДЕНИЕ ДЕМОНА КАК СОБЫТИЕ, О КОТОРОМ ЧЕЛОВЕКУ СКАЗАЛИ.
 *
 * ═════════════ ЧТО ЗДЕСЬ РЕШАЕТСЯ ════════════════════════════════════════════════
 * Окно — это веб-морда самого демона, и опрос телеграма ведёт тот же процесс. Значит
 * падение демона гасит СРАЗУ ОБА канала, и человек узнаёт об этом единственным способом:
 * всё замолчало. Молчание бота в этот момент неотличимо от «сегодня нечего сказать» — а это
 * разные вещи, и разница стоит ночи работы.
 *
 * Этот модуль — общая память двух процессов об одном таком провале:
 *   - СТОРОЖ (supervisor/daemon-watch.mjs) видит, что дверь замолчала, ОТКРЫВАЕТ провал
 *     (`outage.json` рядом с данными демона) и говорит о падении в телеграм — потому что
 *     сказать больше некому: тот, кто мог бы, и есть покойник;
 *   - ДЕМОН, поднявшись, читает эту запись, СНАЧАЛА стучится в собственную дверь и лишь
 *     после ответа говорит «поднялся», после чего ЗАКРЫВАЕТ провал квитанцией со временами.
 *
 * ═════════════ «ПОДНЯЛСЯ» ГОВОРИТ ТОТ, КТО ПОДНЯЛСЯ ══════════════════════════════
 * Это не стилистика, а закон этого файла. Сторож знает только то, что он ЗАПУСТИЛ подъём;
 * между запуском и живой дверью стоят очередь, порт и целый boot, который умеет падать. Если
 * бы «поднялся» слал сторож, человек получал бы обещание, а не факт, — и однажды получил бы
 * его над мёртвой машиной. Поэтому сообщение о подъёме отправляет сам поднявшийся процесс,
 * и отправляет его ПОСЛЕ того, как его собственная дверь ответила на настоящий запрос
 * (`probeDoor` — GET /api/state, существующая дверь замороженной таблицы; новых адресов этот
 * модуль не открывает). Дверь не ответила — сообщения нет вовсе: ненаписанное честнее
 * неправды.
 *
 * ═════════════ ЗАПИСЬ, А НЕ ФЛАГ ═════════════════════════════════════════════════
 * Маркер провала несёт ВРЕМЕНА, а не факт: когда дверь замолчала (первое молчание, а не
 * момент, когда сторож решился), когда провал был объявлен, ушло ли сообщение о падении и
 * во сколько, и каждую попытку подъёма. Из него вырастает квитанция: тот же набор плюс
 * момент, когда дверь ответила снова, и момент, когда о подъёме сказали. По ней проверяется
 * ровно то, что здесь заявлено, — порядок, а не намерение.
 *
 * Node built-ins плюс атомарная запись. Каждый шов — часы, файловый ввод-вывод, стук в
 * дверь, отправка — внедряется, поэтому весь этот разбор проверяется без живого процесса,
 * без сокета и без телеграма.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, rmSync as fsRmSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { dirname, join } from 'node:path'

import { atomicWriteJson } from '../../scripts/sma/lib/fs-atomics.mjs'
import { resolveConfigPath } from './config.mjs'
import { probeDoor, doorUrl } from './control.mjs'
import { createTelegramClient, telegramApiBase, telegramChatId, telegramConfigured } from './telegram/client.mjs'

/** Открытый провал: он существует, пока о нём не отчитался поднявшийся. */
export const OUTAGE_MARKER_FILE = 'outage.json'

/** Закрытые провалы: одна квитанция на один провал, именем со временем падения. */
export const OUTAGE_RECEIPTS_DIR = 'outages'

/** Сколько поднявшийся ждёт собственную дверь, прежде чем признать, что сказать нечего. */
export const DOOR_WAIT_MS = 60000

/** Как часто он её при этом спрашивает. */
export const DOOR_POLL_MS = 1000

// ── где лежит запись ──────────────────────────────────────────────────────────────

/**
 * outageMarkerPath(config, io) — рядом с данными демона, ровно как `daemon.pid`: тот же
 * каталог, тот же SMA_DAEMON_CONFIG, а значит второй демон на одной машине держит свой
 * собственный провал и не путает его с чужим.
 */
export function outageMarkerPath(config = {}, { env = process.env, homedir = osHomedir } = {}) {
  const dir = config.dataDir || dirname(resolveConfigPath({ env, homedir }))
  return join(dir, OUTAGE_MARKER_FILE)
}

/** outageReceiptsDir(config, io) — куда ложатся закрытые провалы. */
export function outageReceiptsDir(config = {}, io = {}) {
  return join(dirname(outageMarkerPath(config, io)), OUTAGE_RECEIPTS_DIR)
}

/** Имя квитанции — от момента падения: один провал, один файл, и он сам себя датирует. */
export function outageReceiptPath(config = {}, marker = {}, io = {}) {
  const stamp = String(marker.downAt || '').replace(/[:.]/g, '-') || 'unknown'
  return join(outageReceiptsDir(config, io), `outage-${stamp}.json`)
}

/**
 * readOutage({config}) → запись или null. Отсутствующий, нечитаемый, порванный или
 * бесформенный файл — это ОТСУТСТВИЕ провала, никогда не бросок: следующий ход у читателя
 * один и тот же во всех четырёх случаях, а поднявшийся демон, умерший на разборе чужого
 * мусора, — это ровно то падение, которое этот модуль обязан пережить.
 */
export function readOutage({ config = {}, io = {}, fsImpl = {} } = {}) {
  const existsSync = fsImpl.existsSync ?? fsExistsSync
  const readFileSync = fsImpl.readFileSync ?? fsReadFileSync
  const path = outageMarkerPath(config, io)
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.downAt !== 'string' || raw.downAt === '') return null
    return {
      downAt: raw.downAt,
      declaredAt: typeof raw.declaredAt === 'string' ? raw.declaredAt : raw.downAt,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      door: typeof raw.door === 'string' ? raw.door : '',
      fallNotifiedAt: typeof raw.fallNotifiedAt === 'string' ? raw.fallNotifiedAt : null,
      fallNotice: typeof raw.fallNotice === 'string' ? raw.fallNotice : '',
      lifts: Array.isArray(raw.lifts) ? raw.lifts.filter((l) => l && typeof l.at === 'string') : [],
      // О НЕУДАВШЕМСЯ ПОДЪЁМЕ ГОВОРЯТ ОДИН РАЗ, И ПОМНИТ ОБ ЭТОМ ЗАПИСЬ, А НЕ ПРОЦЕСС. Сторож,
      // перезапущенный посреди провала, обязан продолжить чужую историю: не повторять уже
      // сказанное и не начинать заново цикл подъёмов, от которого уже отказались.
      liftFailNotifiedAt: typeof raw.liftFailNotifiedAt === 'string' ? raw.liftFailNotifiedAt : null,
      liftFailNotice: typeof raw.liftFailNotice === 'string' ? raw.liftFailNotice : '',
      liftGaveUpAt: typeof raw.liftGaveUpAt === 'string' ? raw.liftGaveUpAt : null,
      path,
    }
  } catch {
    return null
  }
}

/** writeOutage({config, marker}) → путь. Атомарно: рваную запись читает другой процесс. */
export function writeOutage({ config = {}, marker = {}, io = {}, writeOpts = {} } = {}) {
  const path = outageMarkerPath(config, io)
  const { path: _drop, ...body } = marker
  atomicWriteJson(path, body, writeOpts)
  return path
}

/** clearOutage({config}) → true, если запись убрана. Никогда не бросает. */
export function clearOutage({ config = {}, io = {}, fsImpl = {} } = {}) {
  const rmSync = fsImpl.rmSync ?? fsRmSync
  try {
    rmSync(outageMarkerPath(config, io), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * openOutage({config, downAt, reason}) → запись о провале.
 *
 * ЧАС ПАДЕНИЯ — ЭТО ПЕРВОЕ МОЛЧАНИЕ, а не момент, когда сторож перестал сомневаться. Сторож
 * ждёт несколько подряд неотвеченных стуков, прежде чем объявить провал (одна потерянная
 * посылка — не падение), и если бы записывалось время объявления, каждая квитанция врала бы
 * человеку на эту выдержку в меньшую сторону.
 *
 * Уже открытый провал НЕ переоткрывается: сторож, перезапущенный посреди провала, обязан
 * продолжить чужую запись, иначе один провал станет двумя, а человек получит два сообщения
 * о падении и одно о подъёме.
 */
export function openOutage({ config = {}, downAt, reason = '', now = Date.now, io = {}, fsImpl = {}, writeOpts = {} } = {}) {
  const existing = readOutage({ config, io, fsImpl })
  if (existing) return existing
  const marker = {
    downAt: new Date(downAt ?? now()).toISOString(),
    declaredAt: new Date(now()).toISOString(),
    reason: String(reason ?? ''),
    door: doorUrl(config),
    fallNotifiedAt: null,
    fallNotice: '',
    lifts: [],
    liftFailNotifiedAt: null,
    liftFailNotice: '',
    liftGaveUpAt: null,
  }
  const path = writeOutage({ config, marker, io, writeOpts })
  return { ...marker, path }
}

/**
 * stampOutage({config, marker, patch}) → запись с дополненными полями, уже на диске.
 * Один способ дописать в открытый провал — чтобы «сообщение ушло» и «подъём запущен»
 * ложились туда же, откуда их прочтёт поднявшийся.
 */
export function stampOutage({ config = {}, marker = {}, patch = {}, io = {}, writeOpts = {} } = {}) {
  const next = { ...marker, ...patch }
  const path = writeOutage({ config, marker: next, io, writeOpts })
  return { ...next, path }
}

/**
 * settleLifts(lifts, doorAt, falseAlarm) — исход последней попытки, названный живой дверью.
 *
 * Сторож помечает ЗАПУЩЕННЫЙ подъём словом `pending` и сам называет исход только тогда, когда
 * отпущенное время вышло, а дверь так и не ответила. Дверь, ответившая раньше этого срока, и
 * есть исход попытки, на руках у которой она открылась, — и закрывающий провал обязан записать
 * это, а не оставить в квитанции вечное «не знаю». Ложная тревога — исход третьего рода:
 * дверь ответила, но тем же самым процессом, значит подъём не поднял ничего и поднимать было
 * нечего. Три разных факта, три разных слова; ни одно из них не «ok».
 */
function settleLifts(lifts, doorAt, falseAlarm) {
  if (!Array.isArray(lifts) || lifts.length === 0) return []
  const last = lifts[lifts.length - 1]
  if (!last || last.outcome !== 'pending') return lifts
  return [...lifts.slice(0, -1), { ...last, outcome: falseAlarm ? 'no-need' : 'up', doorAt }]
}

/**
 * closeOutage({config, marker, doorBackAt, roseAt, notice}) → {path, receipt}.
 *
 * Квитанция пишется ПЕРЕД тем, как убрать маркер: порядок держит инвариант «провал либо
 * открыт, либо описан». Обратный порядок оставляет окно, в котором машина, умершая между
 * двумя операциями, теряет провал вовсе.
 */
export function closeOutage({
  config = {},
  marker = {},
  doorBackAt,
  roseAt,
  riseNotifiedAt = null,
  riseNotice = '',
  falseAlarm = false,
  now = Date.now,
  io = {},
  fsImpl = {},
  writeOpts = {},
} = {}) {
  const stamp = (v) => (typeof v === 'string' ? v : new Date(v ?? now()).toISOString())
  const receipt = {
    // ЛОЖНАЯ ТРЕВОГА — ТОЖЕ ИСХОД, И ЕГО НАДО НАЗВАТЬ. Квитанция без этого поля читается как
    // «падение было и кончилось», хотя падения не было вовсе: дверь просто отвечала дольше
    // отпущенного, пока демон был занят. Такая квитанция врёт умолчанием, а по ним потом
    // считают надёжность.
    ...(falseAlarm ? { falseAlarm: true } : {}),
    downAt: marker.downAt ?? null,
    declaredAt: marker.declaredAt ?? null,
    reason: marker.reason ?? '',
    door: marker.door || doorUrl(config),
    fallNotifiedAt: marker.fallNotifiedAt ?? null,
    fallNotice: marker.fallNotice ?? '',
    lifts: settleLifts(marker.lifts, stamp(doorBackAt), falseAlarm),
    liftFailNotifiedAt: marker.liftFailNotifiedAt ?? null,
    liftFailNotice: marker.liftFailNotice ?? '',
    liftGaveUpAt: marker.liftGaveUpAt ?? null,
    roseAt: stamp(roseAt),
    doorBackAt: stamp(doorBackAt),
    riseNotifiedAt: riseNotifiedAt === null ? null : stamp(riseNotifiedAt),
    riseNotice: String(riseNotice ?? ''),
    downSeconds: outageSeconds({ ...marker, doorBackAt: stamp(doorBackAt) }),
  }
  const path = outageReceiptPath(config, marker, io)
  atomicWriteJson(path, receipt, writeOpts)
  clearOutage({ config, io, fsImpl })
  return { path, receipt }
}

/** Сколько длился провал, в секундах. Непарсимые времена дают null, а не ноль. */
export function outageSeconds(marker = {}) {
  const from = Date.parse(marker.downAt ?? '')
  const to = Date.parse(marker.doorBackAt ?? '')
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return Math.max(0, Math.round((to - from) / 1000))
}

// ── слова, которые видит человек ──────────────────────────────────────────────────

/** «14:07» по местным часам машины — человеку нужен его час, не UTC. */
function hhmm(iso) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return '?'
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** «4 мин 12 с» — длительность так, как её произносят вслух. */
export function durationWords(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return 'неизвестно сколько'
  if (seconds < 60) return `${seconds} с`
  const min = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${min} мин` : `${min} мин ${rest} с`
}

/**
 * fallWords(marker) — что человек читает в телеграме о падении.
 *
 * Три вещи, и ни одной лишней: демон не отвечает (с какого часа), молчание бота — это ТО ЖЕ
 * САМОЕ падение, а не пустой день, и подъём запущен. Слова «поднялся» здесь нет и быть не
 * может: сторож знает только про свой запуск.
 *
 * И ровно поэтому здесь обещано ВТОРОЕ сообщение на случай неудачи. «Поднимаю», после
 * которого не приходит ничего, — это обещание, которое человек принимает за исход: ночью на
 * 29.08 подъём не состоялся вовсе, а картина в телеграме осталась «упал, поднимаю».
 */
export function fallWords(marker = {}) {
  return [
    `Демон не отвечает с ${hhmm(marker.downAt)}. Дверь ${marker.door || 'окна'} молчит${marker.reason ? ` (${marker.reason})` : ''}.`,
    'Окно и этот бот — один процесс, так что тишина здесь сейчас означает падение, а не «нечего сказать».',
    'Поднимаю. Ответит дверь — о подъёме скажет сам вернувшийся демон, этим же чатом. Не выйдет поднять — скажу об этом отдельным сообщением, а не промолчу.',
  ].join('\n\n')
}

/**
 * ГДЕ ИСКАТЬ ПРИЧИНУ — ЭТО ЧАСТЬ СООБЩЕНИЯ, А НЕ ЗНАНИЕ ЧИТАТЕЛЯ. Запуск, умерший молча,
 * оставляет свой вывод в отдельном журнале (`daemon-lift-<день>.log`); его хвост едет в
 * сообщение целиком, потому что «смотрите логи» ночью читается как «разбирайся сам».
 */
function whyWords(why, logPath) {
  const tail = String(why ?? '').trim()
  if (tail) return `Вот что оставил сам запуск:\n\n${tail}`
  return logPath
    ? `Запуск не оставил ни строки — журнал ${logPath} пуст. Это и есть улика: процесс не начался.`
    : 'Запуск не оставил ни строки: процесс, похоже, не начался вовсе.'
}

/**
 * liftFailedWords({marker, attempt, attempts, attemptsMax, waitMs, nextInMs, why}) — ВТОРОЕ
 * сообщение человеку: подъём не удался.
 *
 * Оно существует потому, что молчание после «поднимаю» хуже, чем отсутствие сторожа: на
 * сторожа полагаются. Ночью на 29.08 человек получил «упал, поднимаю» и больше ничего — а
 * подъём не состоялся вовсе, и демон пролежал бы до утра. Здесь названы три вещи, которых
 * тогда не хватило: что попытка ПРОВАЛИЛАСЬ, почему (хвост вывода самого запуска) и что будет
 * дальше — повтор с выдержкой, а не тишина.
 */
export function liftFailedWords({ marker = {}, attempt = {}, attempts = 1, attemptsMax = 1, waitMs = 0, nextInMs = 0, why = '' } = {}) {
  return [
    `Поднять не смог. Дверь ${marker.door || 'окна'} не ответила за ${durationWords(Math.round(waitMs / 1000))} после запуска (попытка ${attempts} из ${attemptsMax}).`,
    whyWords(why, attempt.log),
    `Повторю через ${durationWords(Math.round(nextInMs / 1000))}. Если не выйдет и с последней попытки — скажу отдельно и больше пробовать не буду.`,
  ].join('\n\n')
}

/**
 * liftGaveUpWords({marker, attempts, why}) — сторож перестал поднимать и зовёт человека.
 *
 * Бесконечный цикл подъёмов — это не настойчивость, а способ никогда не признать, что дело
 * уже не в машине. После нескольких неудач вопрос переходит к человеку, и звать надо ЕГО, а
 * не крутить попытки дальше в тишине.
 */
export function liftGaveUpWords({ marker = {}, attempts = 0, why = '', attempt = {} } = {}) {
  return [
    `Поднять не смог: ${attempts} ${attempts === 1 ? 'попытка' : attempts < 5 ? 'попытки' : 'попыток'}, дверь ${marker.door || 'окна'} так и молчит. Больше не пробую — дальше нужны Вы.`,
    `Демон не отвечает с ${hhmm(marker.downAt)}.`,
    whyWords(why, attempt.log),
    'Руками: `npm run daemon:restart` из каталога продукта. Как только дверь ответит, о подъёме скажет сам поднявшийся демон.',
  ].join('\n\n')
}

/**
 * riseWords({marker, doorBackAt}) — что человек читает о подъёме. Отправляется только после
 * живого ответа двери, поэтому здесь можно говорить в прошедшем времени.
 */
export function riseWords({ marker = {}, doorBackAt } = {}) {
  const seconds = outageSeconds({ ...marker, doorBackAt })
  return [
    `Демон поднялся: дверь ${marker.door || 'окна'} снова отвечает (${hhmm(doorBackAt)}).`,
    `Не отвечал ${durationWords(seconds)} — с ${hhmm(marker.downAt)}.`,
    'Окно и бот снова работают.',
  ].join('\n\n')
}

// ── как это уезжает человеку ──────────────────────────────────────────────────────

/**
 * notifyOwner({config, text}) → {sent, reason}.
 *
 * Единственная отправка в паре сторож–демон, и она НЕ БРОСАЕТ: и падение, и подъём — это
 * события, которые важнее любого исхода их доставки. Не настроен бот — так и сказано,
 * не выдумано; телеграм отказал — причина названа и уедет в квитанцию.
 *
 * Адрес Bot API берётся из конфига (`telegram.apiBase`, по умолчанию настоящий): это тот же
 * шов, которым живой прогон гоняет НАСТОЯЩУЮ отправку через настоящий сокет, не трогая
 * api.telegram.org и не сваливая учебные сообщения в чат владельца.
 */
export async function notifyOwner({ config = {}, text = '', fetchImpl, client } = {}) {
  if (!telegramConfigured(config)) return { sent: false, reason: 'бот не подключён' }
  const chatId = telegramChatId(config)
  if (!chatId) return { sent: false, reason: 'чат не спарен' }
  try {
    const api = client ?? createTelegramClient({ config, fetchImpl, apiBase: telegramApiBase(config) })
    await api.sendMessage({ chatId, text })
    return { sent: true, reason: '' }
  } catch (err) {
    return { sent: false, reason: String((err && err.message) || err) }
  }
}

// ── голос поднявшегося ────────────────────────────────────────────────────────────

/**
 * announceRecovery(deps) → {announced, receiptPath, reason, doorBackAt}.
 *
 * Вызывается демоном на загрузке, сразу после того, как дверь связана. Порядок здесь и есть
 * предмет обещания:
 *
 *   1. ЕСТЬ ЛИ ЧТО РАССКАЗЫВАТЬ. Нет открытого провала — обычный запуск, и он не событие:
 *      ни сообщения, ни квитанции. Иначе каждый штатный перезапуск будил бы человека.
 *   2. ОТВЕЧАЕТ ЛИ ДВЕРЬ. Связанный сокет — ещё не работающая дверь: между ними стоит вся
 *      сборка. Спрашиваем НАСТОЯЩИМ запросом, до тех пор, пока не ответит или не кончится
 *      отпущенное время.
 *   3. ДВЕРЬ ОТВЕТИЛА — говорим «поднялся», и только теперь.
 *   4. ЗАКРЫВАЕМ ПРОВАЛ квитанцией со всеми временами, включая момент отправки.
 *
 * Дверь так и не ответила — не сказано ничего и НЕ закрыто ничего: провал остаётся открытым,
 * сторож продолжает его вести, а человек не получает «поднялся» над машиной, которая не
 * поднялась. Это единственный честный исход, и он проверяется тестом.
 */
export async function announceRecovery({
  config = {},
  probe = (cfg) => probeDoor({ config: cfg }),
  send = (o) => notifyOwner(o),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  log = () => {},
  io = {},
  fsImpl = {},
  writeOpts = {},
  doorWaitMs = DOOR_WAIT_MS,
  pollMs = DOOR_POLL_MS,
} = {}) {
  const marker = readOutage({ config, io, fsImpl })
  if (!marker) return { announced: false, receiptPath: '', reason: 'провала не было', doorBackAt: null }

  const roseAt = new Date(now()).toISOString()
  const until = now() + doorWaitMs
  let knock = null
  for (;;) {
    knock = await probe(config)
    if (knock && knock.answered) break
    if (now() >= until) {
      log(
        `[SmaDaemon] провал с ${marker.downAt} остаётся открытым: собственная дверь не ответила за ${Math.round(doorWaitMs / 1000)} с — о подъёме молчу.`,
      )
      return { announced: false, receiptPath: '', reason: 'дверь не ответила', doorBackAt: null }
    }
    await sleep(pollMs)
  }

  const doorBackAt = new Date(now()).toISOString()
  const said = await send({ config, text: riseWords({ marker, doorBackAt }) })
  const riseNotifiedAt = said.sent ? new Date(now()).toISOString() : null
  const { path } = closeOutage({
    config,
    marker,
    doorBackAt,
    roseAt,
    riseNotifiedAt,
    riseNotice: said.reason,
    now,
    io,
    fsImpl,
    writeOpts,
  })
  log(
    said.sent
      ? `[SmaDaemon] поднялся после провала с ${marker.downAt}; сказал об этом в телеграм. Квитанция: ${path}`
      : `[SmaDaemon] поднялся после провала с ${marker.downAt}; в телеграм сказать не вышло (${said.reason}). Квитанция: ${path}`,
  )
  return { announced: said.sent, receiptPath: path, reason: said.reason, doorBackAt }
}
