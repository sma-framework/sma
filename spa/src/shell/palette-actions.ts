import type { ScreenId } from '../screens/registry'

/**
 * palette-actions — every act the palette knows about, and the door each one goes through.
 *
 * ═════════════════ THE PALETTE IS NOT A SECOND SURFACE OF RIGHTS ═════════════════
 *
 * A command palette is the easiest way in a window to accidentally build a second set of
 * permissions: it is a list of verbs, it is fast, and nothing about it forces the verbs to be
 * the ones the screens already offer. This one is built so that it CANNOT become that.
 *
 *   1. The list is a STATIC CONSTANT. Nothing derives entries from a reading, so no act can
 *      appear here because of what happened to be on screen at the time.
 *   2. Every entry names a door, and a door is one of exactly two things: a screen to open,
 *      or a hook the screens themselves already call. There is no third kind, and in
 *      particular there is no «call the api directly» — this file imports no client function
 *      and no api module at all.
 *   3. An act that costs a confirmation on its own screen is opened, never performed. The
 *      modal in front of publishing, of clearing somebody else's reservation, of rebuilding
 *      the index — those ARE the act's door, and a palette that ran the act behind them would
 *      be a way around a question this product decided to ask.
 *
 * ═════════════════ AND WHY EVERY DOOR HERE IS A SCREEN, TODAY ═════════════════════
 *
 * `via: 'hook'` is declared and unused, and that is a measured fact about the window as it
 * stands rather than an unfinished thought. For an act to be safely performed from here it
 * has to be all three of: argument-free (the palette has no notion of «the selected thing»),
 * confirmation-free (see rule 3), and result-free (its answer must not be something only the
 * screen can show). Every mutation the built screens mount fails at least one:
 *
 *   - approving, returning, starting a stage, answering a question, accepting a lesson,
 *     promoting a backlog line, switching a helper or a connection — all need an identifier
 *     the palette cannot know;
 *   - rebuilding the index, clearing a reservation, publishing — all sit behind a question;
 *   - looking through the project for helpers, and minting a pairing invitation, take no
 *     argument and ask nothing, but their ANSWER is the whole point and it is held by the
 *     screen that asked. A pairing invitation minted where nobody can read it is a live
 *     invitation issued into the void.
 *   - running the release gate takes no argument either, and it is the sharpest case: the
 *     report of a run exists in the RESPONSE and nowhere else — the release's own address
 *     table has no route for reading a gate's progress or verdict back. A gate run performed
 *     here would throw away the receipt that the publication door needs, and the only way to
 *     get another is to run the gate again.
 *
 * So the palette opens the button instead of pressing it, which loses a person one keystroke
 * and keeps every act standing in front of the same evidence its screen shows. On the day an
 * act passes all three tests, this file grows one entry with `via: 'hook'`, the palette mounts
 * that screen's own hook, and nothing else about the mechanism changes.
 */

/** Where an entry leads: a screen to open, or a hook the screens already call. */
export type PaletteDoor = { via: 'screen'; screen: ScreenId } | { via: 'hook'; hook: PaletteHookId }

/**
 * The hooks the palette is allowed to call. Empty on purpose — see the header. Naming a hook
 * that the palette does not mount is a compile error rather than a silent no-op.
 */
export type PaletteHookId = never

export interface PaletteAction {
  /** Stable key — the palette's list order is the list below, and a row needs a name. */
  id: string
  /** What the act is called, in the words the button that performs it uses. */
  title: string
  /** Where the button lives and what pressing it will ask for. */
  hint: string
  door: PaletteDoor
}

/**
 * Every act that exists as a button on a built screen. Ordered the way a working day is:
 * the work, the conveyor, the corpus, the shared checkout, the release, then the household.
 *
 * A row here is a PROMISE that the named screen has that button. Adding one for a screen
 * that does not have it yet would put an act in the window's index of acts before the act
 * exists — the palette would be teaching a person a verb the product cannot do.
 */
export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'approve',
    title: 'Одобрить готовую работу',
    hint: '«Задачи» → карточка задачи → «Одобрить»',
    door: { via: 'screen', screen: 'tasks' },
  },
  {
    id: 'return',
    title: 'Вернуть работу с комментарием',
    hint: '«Задачи» → карточка задачи → «Вернуть»',
    door: { via: 'screen', screen: 'tasks' },
  },
  {
    id: 'enqueue',
    title: 'Поставить новую задачу',
    hint: '«Задачи» → форма новой задачи',
    door: { via: 'screen', screen: 'tasks' },
  },
  {
    id: 'phase-stage',
    title: 'Запустить стадию фазы',
    hint: '«Конвейер фаз» → карточка фазы → стадия',
    door: { via: 'screen', screen: 'pipeline' },
  },
  {
    id: 'phase-answer',
    title: 'Ответить на отложенный вопрос',
    hint: '«Конвейер фаз» → карточка фазы → вопросы, которые ждут ответа',
    door: { via: 'screen', screen: 'pipeline' },
  },
  {
    id: 'phase-uat',
    title: 'Отметить строку приёмки',
    hint: '«Конвейер фаз» → карточка фазы → приёмка',
    door: { via: 'screen', screen: 'pipeline' },
  },
  {
    id: 'memory-apply',
    title: 'Принять урок в память',
    hint: '«Память» → черновики: каждый урок принимается отдельно',
    door: { via: 'screen', screen: 'memory' },
  },
  {
    id: 'memory-index',
    title: 'Пересобрать оглавление памяти',
    hint: '«Память» → проверка корпуса. Спрашивает подтверждение — ручные правки в оглавлении заменятся',
    door: { via: 'screen', screen: 'memory' },
  },
  {
    id: 'claim-clear',
    title: 'Снять чужую бронь',
    hint: '«Координация» → бронь → причина обязательна и уходит в журнал',
    door: { via: 'screen', screen: 'coordination' },
  },
  {
    id: 'backlog-promote',
    title: 'Поставить строку бэклога в очередь',
    hint: '«Бэклог» → строка → «Поставить в очередь»',
    door: { via: 'screen', screen: 'backlog' },
  },
  {
    id: 'ship-gate',
    title: 'Прогнать ворота выката',
    hint: '«Выкат» → «Прогнать ворота». Отчёт и квитанция остаются на том экране',
    door: { via: 'screen', screen: 'ship' },
  },
  {
    id: 'ship-publish',
    title: 'Опубликовать выпуск',
    hint: '«Выкат» → публикация. Нужны зелёные ворота и точная строка версии, набранная руками',
    door: { via: 'screen', screen: 'ship' },
  },
  {
    id: 'agent-toggle',
    title: 'Включить или выключить помощника',
    hint: '«Агенты» → карточка помощника',
    door: { via: 'screen', screen: 'agents' },
  },
  {
    id: 'forge',
    title: 'Заказать нового помощника или навык',
    hint: '«Агенты» → заказ: приходит черновиком и ждёт Вашего «да»',
    door: { via: 'screen', screen: 'agents' },
  },
  {
    id: 'skill-assign',
    title: 'Сказать, кто знает навык',
    hint: '«Навыки» → навык → кому он доступен',
    door: { via: 'screen', screen: 'skills' },
  },
  {
    id: 'mcp-toggle',
    title: 'Включить или выключить подключение',
    hint: '«Подключения» → карточка подключения',
    door: { via: 'screen', screen: 'connections' },
  },
  {
    id: 'pair-machine',
    title: 'Связать машину',
    hint: '«Машины и проекты» → приглашение, которое читают на второй машине',
    door: { via: 'screen', screen: 'machines' },
  },
  {
    id: 'add-project',
    title: 'Добавить проект',
    hint: '«Машины и проекты» → папка проекта',
    door: { via: 'screen', screen: 'machines' },
  },
  {
    id: 'import-own',
    title: 'Привести своих агентов',
    hint: '«Агенты» → «Привести своих»: пофайловое «да» по тому, что уже лежит в проекте',
    door: { via: 'screen', screen: 'import-wizard' },
  },
  {
    id: 'chat',
    title: 'Сказать команде',
    hint: '«Разговор» → строка внизу',
    door: { via: 'screen', screen: 'chat' },
  },
] as const
