/**
 * orchestrator.mjs — ОРКЕСТРАТОР: постоянная фигура машины, а не работник в очереди.
 *
 * ЧТО ЭТО. У машины есть исполнители — те, кто берёт задачи, пишет код и отчитывается
 * квитанцией. И есть ОДИН, кто ими не является: он смотрит на всё сразу, отвечает человеку в
 * окне и распоряжается. Раньше его не было вовсе, и разговор вёл первый попавшийся исполнитель
 * с именем вроде «local-1» — тот же, кто в ту же секунду мог держать чужую задачу. Человек,
 * открывший окно, справедливо спросил «а это кто такой»: имя в разговоре принадлежало строке из
 * списка работников, а не роли, с которой он разговаривал.
 *
 * ПОЭТОМУ ОН — НЕ СТРОКА В СПИСКЕ ИСПОЛНИТЕЛЕЙ, А ОТДЕЛЬНЫЙ БЛОК КОНФИГА. Это не оформление:
 * список `workers[]` — это ровно те, среди кого маршрутизатор выбирает, кому отдать инлайн-задачу.
 * Пока роль живёт в этом списке, она соревнуется за места с теми, кто пишет код, и однажды —
 * при каком-нибудь порядке строк — заберёт задачу. Блок `config.orchestrator` в этом выборе не
 * участвует ПО УСТРОЙСТВУ, а не по договорённости.
 *
 * И ВТОРОЙ ЗАМОК, НА СЛУЧАЙ РУКИ. Конфиг правят руками, и однажды кто-нибудь впишет
 * оркестратора обратно в `workers[]` — из лучших побуждений, чтобы «он тоже был виден».
 * Поэтому маршрутизатор спрашивает `isOrchestrator` про КАЖДОГО кандидата и отказывает ему
 * первой же строкой фильтра, до всех прочих условий; а `ensureOrchestrator` при загрузке
 * ВЫНИМАЕТ такую строку из списка работников и делает из неё блок роли. Два независимых
 * замка на одну дверь — потому что дверь одна, а рук много.
 *
 * ОН ПОЯВЛЯЕТСЯ САМ, ПРИ ПОДКЛЮЧЕНИИ. `ensureOrchestrator` работает во время ЗАГРУЗКИ конфига,
 * ровно как `ensureDefaultProject`, и по той же причине: у новой машины оркестратор обязан
 * появиться без ручной правки настроек, а скрипт миграции — это и есть ручная правка. Мята
 * идемпотентна: конфиг, у которого блок уже есть, возвращается ТЕМ ЖЕ объектом.
 *
 * ЧЕРЕЗ ЧЕЙ АККАУНТ ОН ГОВОРИТ. Оркестратор — РОЛЬ, а не пятая подписка (тот же приём, каким
 * `creator` ездит на аккаунте max-1). Своего аккаунта у него нет, пока человек не дал ему
 * отдельный; без этого он говорит через дневной аккаунт машины — тот же, через который
 * разговор говорил и раньше. Правило выбора живёт ЗДЕСЬ и в одном экземпляре: и разговор, и
 * экран команды спрашивают `voiceAccount`, а не считают его каждый по-своему.
 *
 * ТВЁРДЫЕ РЕШЕНИЯ ОСТАЮТСЯ ЗА ЧЕЛОВЕКОМ, И ОНИ НАЗВАНЫ ПОИМЁННО (HARD_CALLS). Оркестратор
 * зовёт человека, а не решает за него. Список машинно-читаемый нарочно: его читает и промпт
 * разговора, и экран «Команда», так что написанное на стекле и написанное в промпте — одна
 * строка, а не два пересказа. Общий закон HUMAN-ONLY живёт в голосе (policy/neutral-policy.md)
 * и этим списком не заменяется: там граница ВСЕЙ системы, здесь — четыре решения, которые
 * владелец назвал именно для верхушки.
 *
 * Node built-ins не нужны вовсе: модуль чистый, без импортов, без часов и без process.env.
 */

/** Идентификатор роли — он же имя блока, и он же то, что нельзя занять работнику. */
export const ORCHESTRATOR_ID = 'orchestrator'

/** Значение поля `role` у профиля оркестратора. */
export const ORCHESTRATOR_ROLE = 'orchestrator'

/** Как он назван человеку — в окне, в разговоре и в README одним словом. */
export const ORCHESTRATOR_NAME = 'Оркестратор'

/** Одной строкой: кто он такой. Экран печатает это под именем, чтобы вопроса не возникало. */
export const ORCHESTRATOR_TITLE = 'Верхушка машины: смотрит на всё, ведёт разговор, распоряжается. Задач не берёт.'

/**
 * ТВЁРДЫЕ РЕШЕНИЯ — те, которые оркестратор НЕ принимает ни при каких обстоятельствах.
 *
 * Четыре, названные владельцем 28.08, каждое со своим `id` (машине) и словами (человеку).
 * Список закрыт: строка, которой здесь нет, — не твёрдое решение, и добавлять её вправе только
 * человек, а не задача, которой так удобнее.
 */
export const HARD_CALLS = Object.freeze([
  Object.freeze({
    id: 'release',
    label: 'Выкат наружу',
    words: 'публикация, слияние в общий ствол, выпуск версии, выкладка на сервер',
  }),
  Object.freeze({
    id: 'phase-boundary',
    label: 'Границы фазы',
    words: 'где фаза кончается, что в неё входит и когда она считается закрытой',
  }),
  Object.freeze({
    id: 'money',
    label: 'Деньги',
    words: 'платный канал, потолки трат, покупки и подключение оплаты',
  }),
  Object.freeze({
    id: 'seizure',
    label: 'Чужой захват',
    words: 'отобрать работу, дерево или аккаунт у того, кто ими сейчас занят',
  }),
])

/**
 * isOrchestrator(profile) → это профиль верхушки?
 *
 * Два написания называют одно и то же лицо: явное поле `role` и занятый идентификатор. Второе
 * нужно потому, что конфиг правят руками, и строка `{"id":"orchestrator", …}` без поля роли —
 * это всё равно оркестратор, каким бы образом она в список ни попала. Всё, что не объект, не
 * является профилем и никем не является.
 *
 * @param {unknown} profile
 * @returns {boolean}
 */
export function isOrchestrator(profile) {
  if (!profile || typeof profile !== 'object') return false
  return profile.role === ORCHESTRATOR_ROLE || profile.id === ORCHESTRATOR_ID
}

/**
 * voiceAccount(config) → аккаунт, ЧЕРЕЗ КОТОРЫЙ эта машина говорит.
 *
 * Порядок: собственный аккаунт оркестратора, когда человек его дал; иначе дневной аккаунт
 * владельца; иначе первый claude-аккаунт машины; иначе `null` — и `null` здесь честный ответ
 * «говорить нечем», а не повод угадать чужую подписку.
 *
 * @param {object} config
 * @returns {object|null}
 */
export function voiceAccount(config) {
  const own = config && config.orchestrator && config.orchestrator.account
  if (own) return own
  const workers = (config && Array.isArray(config.workers) ? config.workers : []).filter(
    (w) => w && !isOrchestrator(w) && (w.provider ?? 'claude') === 'claude',
  )
  const owner = workers.find((w) => w.dayPriorityOwner === true) ?? workers[0]
  return owner ? owner.account : null
}

/**
 * ensureOrchestrator(config) — тихая мята, ровно как `ensureDefaultProject`.
 *
 * Конфиг, у которого блок уже есть И у которого в списке работников оркестратора нет,
 * возвращается ТЕМ ЖЕ объектом — это и есть доказательство идемпотентности. Иначе возвращается
 * копия: блок появляется (или остаётся), а строка-самозванец вынимается из `workers[]` и
 * становится этим блоком, не теряя того, что человек успел ей приписать.
 *
 * @param {object} config
 * @returns {object} тот же конфиг, или копия с блоком роли
 */
export function ensureOrchestrator(config) {
  if (!config || typeof config !== 'object') return config
  const workers = Array.isArray(config.workers) ? config.workers : []
  const impostor = workers.find((w) => isOrchestrator(w)) ?? null
  const existing = config.orchestrator && typeof config.orchestrator === 'object' ? config.orchestrator : null
  if (existing && !impostor) return config

  // Строка из списка исполнителей — это не мусор: человек мог указать в ней аккаунт, модель или
  // усилие. Она поднимается в роль целиком, а поля блока (если он уже был) остаются главнее.
  const lifted = impostor ? { ...impostor } : {}
  delete lifted.lane // полосы у верхушки нет: полоса — это то, откуда берут задачи
  const merged = {
    name: ORCHESTRATOR_NAME,
    provider: 'claude',
    ...lifted,
    ...(existing ?? {}),
    // Имя и роль — не поля, а сама личность: они ставятся ПОСЛЕ слияния, потому что строка,
    // поднятая из списка исполнителей, называет себя как работник, а блок здесь ровно один.
    id: ORCHESTRATOR_ID,
    role: ORCHESTRATOR_ROLE,
  }
  return {
    ...config,
    orchestrator: merged,
    ...(impostor ? { workers: workers.filter((w) => !isOrchestrator(w)) } : {}),
  }
}

/**
 * orchestratorView(config) → то, что видит экран: кто он, через какой аккаунт говорит и чего
 * НЕ решает. `null`, когда блока нет вовсе — окно старого демона так и скажет, вместо того
 * чтобы нарисовать роль, которой на машине не заведено.
 *
 * Имя аккаунта — это ИМЯ, а не профиль: наружу из конфига не уезжает ни `configDir`, ни имя
 * переменной с токеном (тот же закон, по которому ростер отдаёт `account: <name>`).
 *
 * @param {object} config
 * @returns {{id:string, name:string, title:string, account:string|null, hardCalls:object[]}|null}
 */
export function orchestratorView(config) {
  const block = config && config.orchestrator && typeof config.orchestrator === 'object' ? config.orchestrator : null
  if (!block) return null
  const account = voiceAccount(config)
  const accountName = typeof account === 'string' ? account : account && account.name ? account.name : null
  return {
    id: ORCHESTRATOR_ID,
    name: typeof block.name === 'string' && block.name.trim() ? block.name.trim() : ORCHESTRATOR_NAME,
    title: ORCHESTRATOR_TITLE,
    account: accountName,
    hardCalls: HARD_CALLS.map((c) => ({ id: c.id, label: c.label, words: c.words })),
  }
}
