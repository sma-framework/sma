/**
 * summon.mjs — ЗОВ ЧЕЛОВЕКА: провод между «работа встала и без человека не двинется» и телеграмом.
 *
 * ═══════════════════════ ЗАЧЕМ ЭТОТ ФАЙЛ ВООБЩЕ ЕСТЬ ══════════════════════════════════
 * Обе двери были готовы задолго до него и просто не были соединены. Работа умеет вставать на
 * приёмку и умеет парковаться в ожидании решения; телеграм умеет говорить с владельцем в обе
 * стороны (сторож демона шлёт туда «упал» и «поднялся»). Между ними не было ничего — и работа
 * стояла на приёмке двое суток по одной причине: человек не знал, что она там стоит. Экран
 * показывал бы это мгновенно, но экран надо открыть, а телефон человек носит с собой.
 *
 * ═══════════════════════ ЧТО ЗДЕСЬ СЧИТАЕТСЯ ПОВОДОМ ══════════════════════════════════
 * ТОЛЬКО состояние, из которого работу выводит ЧЕЛОВЕК и никто больше:
 *   approval — работа стоит на приёмке: принять или вернуть может только он;
 *   parked   — работник упёрся и остановлен до решения (потолок ходов, нужный доступ,
 *              нужное решение) — повтора за этим концом нет по устройству очереди;
 *   stopped  — очередь исчерпала перевыдачи и больше не вернётся к этой работе сама.
 *
 * И НЕ ПОВОД — ровно по тому же правилу. Обычный провал попытки повода не даёт: следующую
 * попытку заведёт демон, человеку решать нечего. Возврат работы тоже: возврат — это ХОД
 * ЧЕЛОВЕКА, после которого строка снова в очереди и снова ждёт работника, а не его; звать
 * человека на его же нажатие — это шум, а канал, ставший шумом, перестают читать. Падение
 * демона живёт у сторожа (outage.mjs) и здесь НЕ дублируется — этот файл встаёт рядом с ним
 * и говорит тем же языком: три коротких абзаца, обычный текст, ни одной кнопки.
 *
 * ═══════════════════════ ЧТО В СООБЩЕНИИ ═════════════════════════════════════════════
 * Не «событие произошло», а вопрос, на который человек отвечает. Три вещи, и ни одной лишней:
 * ЧТО ждёт (работа по имени и в каком она состоянии), ЧТО от человека требуется (одним
 * действием и где оно делается), СКОЛЬКО она уже стоит. Последнее — не украшение: именно оно
 * отличает «встала минуту назад» от «стоит вторые сутки», и только оно даёт человеку повод
 * бросить то, чем он занят.
 *
 * КНОПОК «ОДОБРИТЬ» ЗДЕСЬ НЕТ И НЕ БУДЕТ. Решение принимается в окне, где видно диффы и
 * квитанции; кнопка в чате — это одобрение вслепую. Телеграм только ЗОВЁТ. Отправка идёт через
 * тот же `sendMessage`, который шлёт ровно {chat_id, text} и никогда `reply_markup`, поэтому
 * запрет держится устройством канала, а не аккуратностью автора сообщения.
 *
 * ═══════════════════════ ГРАНИЦЫ, ЧТОБЫ КАНАЛ НЕ СТАЛ ШУМОМ ══════════════════════════
 *   • ОДНО ОЖИДАНИЕ — ОДНО СООБЩЕНИЕ. Зов зовётся с каждым проходом тика, пока работа стоит;
 *     уходит он один раз. Второй проход молчит.
 *   • ПОВТОР — ТОЛЬКО ЗА ДОЛГОЕ ОЖИДАНИЕ и только редко: `repeatAfterMs` (шесть часов).
 *   • ОТКАЗ КАНАЛА НЕ ПРЕВРАЩАЕТСЯ В ДОЛБЁЖКУ: после неудачной отправки следующая попытка не
 *     раньше `retryAfterMs` (пять минут), а не на следующем тике через пять секунд.
 *   • БОТ НЕ ПОДКЛЮЧЁН — НЕ СОБЫТИЕ. Ни отправки, ни ошибки, ни строки в журнале, и ожидание
 *     НЕ помечается позванным: подключат бота через час — зов состоится, а не окажется
 *     «уже сказанным» в чат, которого не было.
 *
 * ПАМЯТЬ ЗДЕСЬ — ХИНТ, А НЕ ИСТИНА, ровно как дедуп «идёт» у шины событий: потеря её стоит
 * ОДНОГО лишнего сообщения после перезапуска демона и не может стоить ни одной задачи. Закон
 * «в тике нет состояния» соблюдён тем же способом, что и у памяти старения: объект строится в
 * корне сборки и передаётся тику, а тик его только спрашивает.
 *
 * Только встроенные модули; часы и отправка внедряются, поэтому тесты детерминированы.
 */

import { notifyOwner } from './outage.mjs'
import { telegramChatId, telegramConfigured } from './telegram/client.mjs'
import { REASON_LABELS } from './queue/adapter.mjs'

/** Поводы позвать. Слово вне списка — не зов: незнакомый повод молчит, а не выдумывает текст. */
export const SUMMON_KINDS = Object.freeze(['approval', 'parked', 'stopped'])

/** Повтор за долгое ожидание — шесть часов. Реже, чем смена; чаще, чем «двое суток молча». */
export const SUMMON_REPEAT_MS = 6 * 60 * 60 * 1000

/** Выдержка после отказа канала: телеграм молчит — стучимся через пять минут, а не через тик. */
export const SUMMON_RETRY_MS = 5 * 60 * 1000

/** Через сколько ожидание забывается совсем (память подрезается, а не растёт вечно). */
export const SUMMON_FORGET_MS = 24 * 60 * 60 * 1000

/**
 * waitWords(seconds) — «сколько уже стоит» так, как это произносят вслух.
 *
 * Своя, а не `durationWords` сторожа: у того самая крупная единица — минута, потому что провал
 * демона меряется минутами. Здесь меряют часами и сутками, и «2880 мин» на вопрос «сколько
 * стоит» не отвечает.
 */
export function waitWords(seconds) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'неизвестно сколько'
  if (seconds < 60) return 'меньше минуты'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days} сут` : `${days} сут ${restHours} ч`
}

/** Имя работы для человека; названия нет — остаётся её собственный ярлык, но не пустота. */
function nameOf(title, taskId) {
  const t = typeof title === 'string' ? title.trim() : ''
  return t !== '' ? t : String(taskId ?? 'без имени')
}

/** Первый абзац: ЧТО именно ждёт. */
function whatWaits(kind, name, reason) {
  const label = REASON_LABELS[reason] || ''
  if (kind === 'approval') return `Работа «${name}» стоит на приёмке — сама она оттуда не уйдёт.`
  if (kind === 'parked') {
    return label
      ? `Работа «${name}» остановлена и ждёт вас: ${label}.`
      : `Работа «${name}» остановлена и ждёт вашего решения.`
  }
  return label
    ? `Работа «${name}» закрыта очередью и сама больше не повторится: ${label}.`
    : `Работа «${name}» закрыта очередью и сама больше не повторится.`
}

/** Второй абзац: ЧЕГО от человека хотят — одним действием и с адресом, где оно делается. */
function whatIsAsked(kind) {
  if (kind === 'approval') {
    return 'Нужно ваше решение: принять или вернуть. Кнопок в этом чате нет — это делается в окне, где видно диффы и квитанции.'
  }
  if (kind === 'parked') {
    return 'Нужно ваше решение: снять ограничение, разрезать работу или отменить её. Кнопок в этом чате нет — решают в окне, там же видно, что попытка успела сделать.'
  }
  return 'Нужно ваше решение: вернуть работу в очередь, разрезать её или закрыть. Кнопок в этом чате нет — решают в окне.'
}

/**
 * summonWords({kind, taskId, title, reason, since, now, again}) — что человек читает в телеграме.
 * ЧИСТАЯ: те же входы дают тот же текст, поэтому слова проверяются без сети и без часов.
 */
export function summonWords({ kind, taskId, title = '', reason = '', since = null, now = Date.now(), again = false } = {}) {
  const name = nameOf(title, taskId)
  const seconds = Number.isFinite(since) && Number.isFinite(now) && now >= since ? Math.round((now - since) / 1000) : null
  const waited = waitWords(seconds)
  const stands = again ? `Стоит уже ${waited} — и всё ещё ждёт.` : `Стоит ${waited}.`
  return [whatWaits(kind, name, reason), whatIsAsked(kind), stands].join('\n\n')
}

/**
 * createSummons({config, notify, fetchImpl, now, repeatAfterMs, retryAfterMs, forgetAfterMs, log})
 *   → {raise, keepOnly, pending}
 *
 * `config` — ЖИВОЙ объект конфига демона, а не копия его телеграмной части: бота подключают на
 * ходу из окна, и зов обязан увидеть подключение без перезапуска (тот же приём, что у моста).
 *
 * raise(call) → {sent, silenced, reason}. Не бросает НИКОГДА: зов — это разговор о работе, и он
 * не имеет права уронить ни тик, ни попытку, о которой рассказывает.
 */
export function createSummons({
  config = {},
  notify = notifyOwner,
  fetchImpl,
  now = Date.now,
  repeatAfterMs = SUMMON_REPEAT_MS,
  retryAfterMs = SUMMON_RETRY_MS,
  forgetAfterMs = SUMMON_FORGET_MS,
  log = () => {},
} = {}) {
  // ключ ожидания → {firstAt, lastTryAt, lastSentAt}. Хинт, не истина (см. шапку).
  const waiting = new Map()

  const keyOf = (kind, taskId) => `${kind}:${taskId}`

  /** Забыть ожидания, о которых давно не было речи, — память не растёт вместе с журналом. */
  function forgetStale(at) {
    for (const [key, entry] of [...waiting]) {
      if (at - Math.max(entry.lastTryAt, entry.lastSentAt, entry.firstAt) > forgetAfterMs) waiting.delete(key)
    }
  }

  return {
    /** Сколько ожиданий сейчас помнится — для тестов и для отладки, не для решений. */
    get pending() {
      return waiting.size
    },

    /**
     * keepOnly(kind, taskIds) — подрезать память по живому списку: работа ушла с приёмки, значит
     * человек ответил, и помнить о ней нечего. Тот же приём, что у памяти старения, и по той же
     * причине: память обязана описывать очередь как она есть сейчас.
     */
    keepOnly(kind, taskIds) {
      const live = new Set((Array.isArray(taskIds) ? taskIds : []).filter(Boolean).map(String))
      for (const key of [...waiting.keys()]) {
        if (!key.startsWith(`${kind}:`)) continue
        if (!live.has(key.slice(kind.length + 1))) waiting.delete(key)
      }
    },

    async raise({ kind, taskId, title = '', reason = '', since = null } = {}) {
      if (!SUMMON_KINDS.includes(kind) || !taskId) return { sent: false, silenced: false, reason: 'звать не о чем' }

      // БОТ НЕ ПОДКЛЮЧЁН — ВЫХОД ДО ВСЯКОЙ ПАМЯТИ. Ожидание не помечается позванным, в журнал
      // не идёт ни строки, и продукт ведёт себя ровно как вёл до этого файла.
      if (!telegramConfigured(config) || !telegramChatId(config)) {
        return { sent: false, silenced: false, reason: 'бот не подключён' }
      }

      const at = now()
      forgetStale(at)
      const key = keyOf(kind, taskId)
      const seen = waiting.get(key)
      if (seen) {
        // Успевший уйти зов молчит долго; не ушедший — короткую выдержку. Разные числа, потому
        // что это разные события: сказанное слово и неудавшаяся попытка его сказать.
        const quietUntil = seen.lastSentAt > 0 ? seen.lastSentAt + repeatAfterMs : seen.lastTryAt + retryAfterMs
        if (at < quietUntil) return { sent: false, silenced: true, reason: 'уже позвали' }
      }

      const startedAt = seen ? seen.firstAt : Number.isFinite(since) ? since : at
      const entry = seen ?? { firstAt: startedAt, lastTryAt: 0, lastSentAt: 0 }
      entry.firstAt = startedAt
      entry.lastTryAt = at
      waiting.set(key, entry)

      const text = summonWords({ kind, taskId, title, reason, since: startedAt, now: at, again: entry.lastSentAt > 0 })
      let out
      try {
        out = (await notify({ config, text, fetchImpl })) || {}
      } catch (err) {
        // notifyOwner не бросает, но зов не полагается на чужую вежливость.
        out = { sent: false, reason: String((err && err.message) || err) }
      }
      if (out.sent) {
        entry.lastSentAt = at
        log(`зов человека: ${kind} ${taskId} — сказано`)
      } else {
        log(`зов человека: ${kind} ${taskId} — не сказано: ${out.reason || 'причина не названа'}`)
      }
      return { sent: out.sent === true, silenced: false, reason: out.reason || '' }
    },
  }
}
