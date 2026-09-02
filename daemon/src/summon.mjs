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
 *   stopped  — очередь исчерпала перевыдачи и больше не вернётся к этой работе сама;
 *   batch    — сборка встала на сорвавшемся элементе и держит ОСТАЛЬНЫЕ свои элементы, пока
 *              владелец не выберет «пропустить / повторить / отменить». Повода честнее не
 *              бывает: очередь не выдаёт больше ни одного куска этой сборки по устройству,
 *              и ждать она будет ровно столько, сколько человек не будет знать, что она ждёт.
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
 *   • ОДИН ПРОХОД — ОДНО СООБЩЕНИЕ. Десять работ, вставших на приёмку, — это десять поводов и
 *     ОДИН вопрос: «разгреби приёмку». Он и уходит одной сводкой (`raiseDigest`), а не залпом
 *     по сообщению на каждую: залп читается как авария, а после второго его перестают читать.
 *   • ПОВТОР — ТОЛЬКО ЗА ДОЛГОЕ ОЖИДАНИЕ и только редко: `repeatAfterMs` (шесть часов).
 *   • ОТКАЗ КАНАЛА НЕ ПРЕВРАЩАЕТСЯ В ДОЛБЁЖКУ: после неудачной отправки следующая попытка не
 *     раньше `retryAfterMs` (пять минут), а не на следующем тике через пять секунд.
 *   • БОТ НЕ ПОДКЛЮЧЁН — НЕ СОБЫТИЕ. Ни отправки, ни ошибки, ни строки в журнале, и ожидание
 *     НЕ помечается позванным: подключат бота через час — зов состоится, а не окажется
 *     «уже сказанным» в чат, которого не было.
 *   • ЗАКРЫТОЕ НЕ ЗОВЁТ. Перед словом — сверка (`isGhost`): карточка, отмеченную владельцем
 *     сделанной, и строка отменённой сборки молчат, даже если очередь всё ещё держит их
 *     ждущими человека.
 *
 * ПАМЯТЬ ЗДЕСЬ ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК — и это исправление, а не украшение. Пока она была хинтом
 * в процессе, цена её потери считалась «одним лишним сообщением»; измерено 02.09 — цена равна
 * ВСЕМУ списку ожиданий, помноженному на число подъёмов демона: два старта за утро дали два
 * одинаковых залпа по десять сообщений. Запись «о чём, кому и когда сказали» лежит в данных
 * демона (`summon-said.mjs`), и новый процесс читает её как своё же прошлое. Закон «в тике нет
 * состояния» соблюдён тем же способом, что и у памяти старения: объект строится в корне сборки
 * и передаётся тику, а тик его только спрашивает.
 *
 * Только встроенные модули; часы, диск и отправка внедряются, поэтому тесты детерминированы.
 */

import { notifyOwner } from './outage.mjs'
import { telegramChatId, telegramConfigured } from './telegram/client.mjs'
import { REASON_LABELS } from './queue/adapter.mjs'
import { createSaidMemory } from './summon-said.mjs'

/** Поводы позвать. Слово вне списка — не зов: незнакомый повод молчит, а не выдумывает текст. */
export const SUMMON_KINDS = Object.freeze(['approval', 'parked', 'stopped', 'batch'])

/**
 * ВЫДЕРЖКА ПОВТОРА — ШЕСТЬ ЧАСОВ, и число выбрано, а не унаследовано.
 *
 * Снизу его держит рабочий день: повтор чаще, чем раз в несколько часов, застаёт человека за
 * тем же делом, за которым застал первый зов, и ничего к нему не добавляет — а канал, звонящий
 * о том, что человек уже знает, перестают читать. Сверху его держит сутки: работа, вставшая
 * утром, обязана быть названной ДО того, как рабочий день кончится, иначе повтор приходит на
 * следующее утро и стоит суток простоя — ровно того случая, ради которого этот файл написан.
 * Шесть часов — не больше четырёх сообщений в сутки на всю приёмку разом (повтор идёт одной
 * сводкой, а не по сообщению на работу) и не длиннее половины дня.
 */
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

/** Сколько работ сводка называет поимённо, прежде чем перейти на счёт. */
export const SUMMON_DIGEST_NAMES = 5

/** «1 работа / 2 работы / 5 работ» — по-русски, потому что это читает человек, а не машина. */
function worksWord(n) {
  const hundred = Math.abs(n) % 100
  const ten = hundred % 10
  if (hundred >= 11 && hundred <= 14) return 'работ'
  if (ten === 1) return 'работа'
  if (ten >= 2 && ten <= 4) return 'работы'
  return 'работ'
}

/** «Стоит столько-то» в секундах; неизвестное время остаётся неизвестным, а не нулём. */
function secondsWaited(since, now) {
  return Number.isFinite(since) && Number.isFinite(now) && now >= since ? Math.round((now - since) / 1000) : null
}

/** Первый абзац: ЧТО именно ждёт. */
function whatWaits(kind, name, reason, itemName) {
  const label = REASON_LABELS[reason] || ''
  if (kind === 'approval') return `Работа «${name}» стоит на приёмке — сама она оттуда не уйдёт.`
  if (kind === 'batch') {
    // ИМЕНАМИ, А НЕ ЧИСЛАМИ: «сборка N стоит на элементе M» человек читает с телефона и по
    // этим двум именам находит карточку. Сборка без имени зовёт по ярлыку — как и работа.
    return itemName
      ? `Сборка «${name}» стоит на элементе «${itemName}» — остальные её элементы очередь не выдаёт.`
      : `Сборка «${name}» стоит на сорвавшемся элементе — остальные её элементы очередь не выдаёт.`
  }
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
  if (kind === 'batch') {
    // Три ответа названы теми же словами, какими их предлагает карточка сборки. Здесь они
    // ПЕРЕЧИСЛЕНЫ, а не нажимаются: выбор делается там, где видно, на чём кусок сломался.
    return 'Нужен ваш выбор: пропустить элемент, повторить его или отменить сборку. Кнопок в этом чате нет — выбирают на карточке сборки в окне.'
  }
  if (kind === 'parked') {
    return 'Нужно ваше решение: снять ограничение, разрезать работу или отменить её. Кнопок в этом чате нет — решают в окне, там же видно, что попытка успела сделать.'
  }
  return 'Нужно ваше решение: вернуть работу в очередь, разрезать её или закрыть. Кнопок в этом чате нет — решают в окне.'
}

/**
 * summonWords({kind, taskId, title, reason, since, now, again, itemId, itemTitle}) — что человек
 * читает в телеграме. ЧИСТАЯ: те же входы дают тот же текст, поэтому слова проверяются без сети
 * и без часов.
 *
 * `itemId`/`itemTitle` называют КУСОК вставшей сборки и читаются только поводом `batch`: у
 * остальных поводов куска нет, и подставлять его было бы вымыслом.
 */
export function summonWords({
  kind,
  taskId,
  title = '',
  reason = '',
  since = null,
  now = Date.now(),
  again = false,
  itemId = '',
  itemTitle = '',
} = {}) {
  const name = nameOf(title, taskId)
  const item = kind === 'batch' && (itemTitle || itemId) ? nameOf(itemTitle, itemId) : ''
  const waited = waitWords(secondsWaited(since, now))
  const stands = again ? `Стоит уже ${waited} — и всё ещё ждёт.` : `Стоит ${waited}.`
  return [whatWaits(kind, name, reason, item), whatIsAsked(kind), stands].join('\n\n')
}

/** Первый абзац сводки: СКОЛЬКО ждёт — тем же словом, каким об одной работе говорит `whatWaits`. */
function whatWaitsMany(kind, n) {
  if (kind === 'approval') return `На приёмке ${n} ${worksWord(n)} — сами они оттуда не уйдут.`
  if (kind === 'batch') return `${n} ${worksWord(n)} стоят на сорвавшихся элементах — остальные их элементы очередь не выдаёт.`
  if (kind === 'parked') return `${n} ${worksWord(n)} остановлены и ждут вашего решения.`
  return `${n} ${worksWord(n)} закрыты очередью и сами больше не повторятся.`
}

/**
 * summonDigestWords({kind, items, now, limit}) — ОДИН ВОПРОС О МНОГИХ ОЖИДАНИЯХ.
 *
 * Почему сводка, а не сообщение на каждую работу. Десять работ на приёмке — это не десять
 * разных вопросов, а один: «разгреби приёмку». Десять сообщений подряд человек читает как
 * аварию, а второй такой залп — как поломку канала, и после него канал перестают открывать.
 * Измерено 02.09: два залпа по десять сообщений за двадцать минут, ни одного действия по ним.
 *
 * Что сводка обязана сохранить от одиночного зова: СРОК СТАРШЕЙ. Именно он отличает «встало
 * час назад» от «стоит вторые сутки» и остаётся единственной причиной бросить текущее дело.
 * Поэтому список отсортирован по сроку, старшая названа в первом же абзаце, а имена перечислены
 * с их собственными сроками — до `limit`, дальше идёт счёт: письмо в тридцать строк не читают.
 *
 * ЧИСТАЯ: те же входы дают тот же текст, поэтому слова проверяются без сети и без часов.
 */
export function summonDigestWords({ kind = 'approval', items = [], now = Date.now(), limit = SUMMON_DIGEST_NAMES } = {}) {
  const rows = (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map((i) => ({ name: nameOf(i.title, i.taskId), seconds: secondsWaited(i.since, now) }))
    .sort((a, b) => (b.seconds ?? -1) - (a.seconds ?? -1))
  const n = rows.length
  const head = `${whatWaitsMany(kind, n)} Старшая ждёт ${waitWords(n > 0 ? rows[0].seconds : null)}.`
  const shown = rows.slice(0, Math.max(1, limit)).map((r) => `«${r.name}» — ${waitWords(r.seconds)}`)
  if (n > shown.length) shown.push(`…и ещё ${n - shown.length}`)
  return [head, whatIsAsked(kind), shown.join('\n')].join('\n\n')
}

/**
 * createSummons({config, notify, fetchImpl, now, dataDir, fsImpl, isGhost, repeatAfterMs,
 *   retryAfterMs, forgetAfterMs, log}) → {raise, raiseDigest, keepOnly, pending, durable}
 *
 * `config` — ЖИВОЙ объект конфига демона, а не копия его телеграмной части: бота подключают на
 * ходу из окна, и зов обязан увидеть подключение без перезапуска (тот же приём, что у моста).
 *
 * `dataDir` — где лежит память «сказано». С ним она переживает перезапуск демона; без него
 * объект честно остаётся памятью процесса и говорит об этом полем `durable`.
 *
 * `isGhost({kind, taskId})` — СВЕРКА ПЕРЕД ЗОВОМ. Спрашивается только о работах, о которых зов
 * и так собрался говорить, и только после того, как выдержка их пропустила: закрытая карточка
 * молчит, но проверка её закрытости не стоит ни одного лишнего чтения на молчаливом тике.
 *
 * raise(call) → {sent, silenced, reason}. Не бросает НИКОГДА: зов — это разговор о работе, и он
 * не имеет права уронить ни тик, ни попытку, о которой рассказывает.
 */
export function createSummons({
  config = {},
  notify = notifyOwner,
  fetchImpl,
  now = Date.now,
  dataDir = '',
  fsImpl,
  isGhost = null,
  repeatAfterMs = SUMMON_REPEAT_MS,
  retryAfterMs = SUMMON_RETRY_MS,
  forgetAfterMs = SUMMON_FORGET_MS,
  log = () => {},
} = {}) {
  // ключ ожидания → {kind, taskId, firstAt, lastTryAt, lastSentAt, hushedAt}. ИСТИНА, а не хинт:
  // с `dataDir` эта память лежит на диске демона и читается новым процессом (см. шапку).
  const waiting = createSaidMemory({ dataDir, fsImpl, clock: now })

  const keyOf = (kind, taskId) => `${kind}:${taskId}`

  /**
   * До какого момента об этом ожидании молчат. Три разных числа, потому что это три разных
   * события: сказанное слово ждёт долгой выдержки, неудавшаяся попытка сказать — короткой, а
   * замолчанный призрак — той же долгой, чтобы реестр не перечитывался каждые пять секунд и
   * чтобы вновь открытая карточка всё-таки дождалась своего зова.
   */
  function quietUntil(entry) {
    if (entry.hushedAt > 0) return entry.hushedAt + repeatAfterMs
    if (entry.lastSentAt > 0) return entry.lastSentAt + repeatAfterMs
    return entry.lastTryAt + retryAfterMs
  }

  /** Забыть ожидания, о которых давно не было речи, — память не растёт вместе с журналом. */
  function forgetStale(at) {
    for (const key of waiting.keys()) {
      const entry = waiting.get(key)
      if (!entry) continue
      const last = Math.max(entry.lastTryAt, entry.lastSentAt, entry.hushedAt, entry.firstAt)
      if (at - last > forgetAfterMs) waiting.forget(key)
    }
  }

  /** Fail-open: сверка, которая упала, значит «не призрак». Молчание обо всём хуже шума. */
  async function ghostly(kind, taskId) {
    if (typeof isGhost !== 'function') return false
    try {
      return (await isGhost({ kind, taskId })) === true
    } catch {
      return false
    }
  }

  /** Замолчать призрака: не сказано ни слова, но и спрашивать о нём снова — не на этом тике. */
  function hush({ key, kind, taskId, seen, firstAt, at }) {
    waiting.remember(key, {
      kind,
      taskId,
      firstAt,
      lastTryAt: seen ? seen.lastTryAt : 0,
      lastSentAt: seen ? seen.lastSentAt : 0,
      hushedAt: at,
    })
    log(`зов человека: ${kind} ${taskId} — не сказано: карточка закрыта`)
  }

  return {
    /** Сколько ожиданий сейчас помнится — для тестов и для отладки, не для решений. */
    get pending() {
      return waiting.size
    },

    /** Переживёт ли эта память перезапуск демона — то, ради чего у зова появился свой файл. */
    get durable() {
      return waiting.durable
    },

    /**
     * keepOnly(kind, taskIds) — подрезать память по живому списку: работа ушла с приёмки, значит
     * человек ответил, и помнить о ней нечего. Тот же приём, что у памяти старения, и по той же
     * причине: память обязана описывать очередь как она есть сейчас.
     *
     * Список даётся ТЕМИ ЖЕ адресами, какими зовут: у повода с куском это `<id>:<idКуска>`.
     * Иначе подрезка не нашла бы ни одного своего ключа и молча ничего не забывала бы.
     */
    keepOnly(kind, taskIds) {
      const live = new Set((Array.isArray(taskIds) ? taskIds : []).filter(Boolean).map(String))
      for (const key of waiting.keys()) {
        if (!key.startsWith(`${kind}:`)) continue
        if (!live.has(key.slice(kind.length + 1))) waiting.forget(key)
      }
    },

    /**
     * `itemId` — АДРЕС ОЖИДАНИЯ ВНУТРИ ОДНОЙ ЕДИНИЦЫ РАБОТЫ, и он входит в ключ памяти.
     *
     * Без него сборка из шести кусков была бы «одним ожиданием» на все шесть: владелец
     * пропустил сломавшийся кусок, следующий сорвался через минуту — и зов промолчал бы шесть
     * часов, потому что о ЭТОЙ СБОРКЕ уже говорили. Каждый кусок — своё ожидание и свой вопрос;
     * запрет на шум остаётся тем же самым, просто он теперь считает то, что и правда одно.
     */
    async raise({ kind, taskId, title = '', reason = '', since = null, itemId = '', itemTitle = '' } = {}) {
      if (!SUMMON_KINDS.includes(kind) || !taskId) return { sent: false, silenced: false, reason: 'звать не о чем' }

      // БОТ НЕ ПОДКЛЮЧЁН — ВЫХОД ДО ВСЯКОЙ ПАМЯТИ. Ожидание не помечается позванным, в журнал
      // не идёт ни строки, и продукт ведёт себя ровно как вёл до этого файла.
      if (!telegramConfigured(config) || !telegramChatId(config)) {
        return { sent: false, silenced: false, reason: 'бот не подключён' }
      }

      const at = now()
      forgetStale(at)
      const key = keyOf(kind, itemId ? `${taskId}:${itemId}` : taskId)
      const seen = waiting.get(key)
      // Успевший уйти зов молчит долго; не ушедший — короткую выдержку (см. `quietUntil`).
      if (seen && at < quietUntil(seen)) return { sent: false, silenced: true, reason: 'уже позвали' }

      const startedAt = seen ? seen.firstAt : Number.isFinite(since) ? since : at

      // СВЕРКА ПЕРЕД СЛОВОМ. Спрашивается ПОСЛЕ выдержки и ДО отправки: закрытая карточка не
      // зовёт, но и реестр не читается на каждом молчаливом проходе.
      if (await ghostly(kind, taskId)) {
        hush({ key, kind, taskId, seen, firstAt: startedAt, at })
        return { sent: false, silenced: true, reason: 'карточка закрыта' }
      }

      const saidBefore = seen ? seen.lastSentAt : 0
      waiting.remember(key, { kind, taskId, firstAt: startedAt, lastTryAt: at, lastSentAt: saidBefore, hushedAt: 0 })

      const text = summonWords({
        kind,
        taskId,
        title,
        reason,
        since: startedAt,
        now: at,
        again: saidBefore > 0,
        itemId,
        itemTitle,
      })
      let out
      try {
        out = (await notify({ config, text, fetchImpl })) || {}
      } catch (err) {
        // notifyOwner не бросает, но зов не полагается на чужую вежливость.
        out = { sent: false, reason: String((err && err.message) || err) }
      }
      if (out.sent) {
        waiting.remember(key, { kind, taskId, firstAt: startedAt, lastTryAt: at, lastSentAt: at, hushedAt: 0 })
        log(`зов человека: ${kind} ${taskId} — сказано`)
      } else {
        log(`зов человека: ${kind} ${taskId} — не сказано: ${out.reason || 'причина не названа'}`)
      }
      return { sent: out.sent === true, silenced: false, reason: out.reason || '' }
    },

    /**
     * raiseDigest({kind, calls}) → {sent, silenced, reason, taskIds} — ОДИН ПРОХОД, ОДНО СЛОВО.
     *
     * Дверь для повода, у которого ожиданий бывает МНОГО СРАЗУ: приёмка. Тик отдаёт сюда весь
     * список стоящих работ целиком и ничего о шуме не решает — решает здесь, ровно как и
     * раньше, потому что дедуп, обойти который можно вторым проводом, дедупом не является.
     *
     * Что делает: отсеивает по выдержке (у каждой работы своя — та же память, тот же ключ),
     * сверяется о выживших с реестром, и если после этого остаётся хоть одна — отправляет ОДНО
     * сообщение. Одна работа получает свой полный текст, много — сводку. Помечаются сказанными
     * ВСЕ вошедшие в сообщение, и только они: работа, промолчавшая по выдержке, свою выдержку
     * не продлевает, а призрак не получает отметки «сказано» о слове, которого не было.
     */
    async raiseDigest({ kind, calls = [] } = {}) {
      const rows = (Array.isArray(calls) ? calls : []).filter((c) => c && c.taskId)
      if (!SUMMON_KINDS.includes(kind) || rows.length === 0) {
        return { sent: false, silenced: false, reason: 'звать не о чем', taskIds: [] }
      }
      // БОТ НЕ ПОДКЛЮЧЁН — ВЫХОД ДО ВСЯКОЙ ПАМЯТИ, ровно как у одиночного зова.
      if (!telegramConfigured(config) || !telegramChatId(config)) {
        return { sent: false, silenced: false, reason: 'бот не подключён', taskIds: [] }
      }

      const at = now()
      forgetStale(at)

      const due = []
      for (const call of rows) {
        const taskId = String(call.taskId)
        const key = keyOf(kind, taskId)
        const seen = waiting.get(key)
        if (seen && at < quietUntil(seen)) continue
        const firstAt = seen ? seen.firstAt : Number.isFinite(call.since) ? call.since : at
        if (await ghostly(kind, taskId)) {
          hush({ key, kind, taskId, seen, firstAt, at })
          continue
        }
        due.push({ key, taskId, title: call.title ?? '', firstAt, saidBefore: seen ? seen.lastSentAt : 0 })
      }
      if (due.length === 0) return { sent: false, silenced: true, reason: 'уже позвали', taskIds: [] }

      const text =
        due.length === 1
          ? summonWords({
              kind,
              taskId: due[0].taskId,
              title: due[0].title,
              since: due[0].firstAt,
              now: at,
              again: due[0].saidBefore > 0,
            })
          : summonDigestWords({
              kind,
              now: at,
              items: due.map((d) => ({ taskId: d.taskId, title: d.title, since: d.firstAt })),
            })

      let out
      try {
        out = (await notify({ config, text, fetchImpl })) || {}
      } catch (err) {
        out = { sent: false, reason: String((err && err.message) || err) }
      }
      const sent = out.sent === true
      for (const d of due) {
        waiting.remember(d.key, {
          kind,
          taskId: d.taskId,
          firstAt: d.firstAt,
          lastTryAt: at,
          lastSentAt: sent ? at : d.saidBefore,
          hushedAt: 0,
        })
      }
      const named = due.map((d) => d.taskId).join(', ')
      if (sent) log(`зов человека: ${kind} — сказано о ${due.length}: ${named}`)
      else log(`зов человека: ${kind} — не сказано: ${out.reason || 'причина не названа'}`)
      return { sent, silenced: false, reason: out.reason || '', taskIds: due.map((d) => d.taskId) }
    },
  }
}
