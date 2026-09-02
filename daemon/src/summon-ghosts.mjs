/**
 * summon-ghosts.mjs — СВЕРКА ПЕРЕД ЗОВОМ: не звать человека о том, что уже закрыто.
 *
 * ═══════════════════ ЧТО ТАКОЕ ПРИЗРАК ══════════════════════════════════════════════════
 * Строка, которая по очереди всё ещё ждёт человека, а по реестру ждать давно нечего. Двумя
 * путями:
 *   • КАРТОЧКА ЗАКРЫТА. Владелец отметил строку реестра сделанной (`- [x]`) — руками, в своём
 *     файле, мимо очереди. Очередь об этом не узнала: её строка как стояла на приёмке, так и
 *     стоит, и зов будет звать о ней вечно. Именно эти зовы владелец и назвал шумом: среди
 *     десяти сообщений половина была о работах, закрытых днями раньше.
 *   • СТРОКУ ОТМЕНИЛИ. Кусок сборки, которую владелец бросил (`cancelled`) или из которой этот
 *     кусок выкинул (`skipped`). Отмена сборки НЕ ТРОГАЕТ куски, уже ждущие человека, — и это
 *     правильно, у них своя дверь, — но звать о них после отмены уже не о чем.
 *
 * ═══════════════════ ПОЧЕМУ СВЕРКА, А НЕ ПОДРЕЗКА ПАМЯТИ ════════════════════════════════
 * Память зова подрезается по живому списку очереди, а призрак в этом списке ЖИВОЙ: он и есть
 * строка со статусом «ждёт приёмки». Отличить его можно только у источника, который очередь не
 * читает, — у реестра и у слова владельца о сборке. Поэтому это отдельный вопрос, задаваемый
 * ровно перед словом, а не фильтр списка.
 *
 * ═══════════════════ ПОЧЕМУ У ЧТЕНИЯ РЕЕСТРА ЕСТЬ ВЫДЕРЖКА ══════════════════════════════
 * Файл реестра читается с диска, а зов спрашивают на каждом проходе тика — то есть каждые пять
 * секунд. Выдержка в минуту делает вопрос почти бесплатным и ничего не портит: реестр правят
 * руками, и минута опоздания стоит одного зова, а не потерянной работы. Кэш живёт ЗДЕСЬ, рядом
 * с корнем сборки, а не в тике: закон «в тике нет состояния» тот же, что у памяти старения.
 *
 * Fail-open целиком: нечитаемый реестр значит «ничего не закрыто». Сверка, из-за которой зов
 * замолчал бы обо всём, хуже лишнего сообщения.
 */

import { readFileSync as fsRead, existsSync as fsExists } from 'node:fs'
import { join } from 'node:path'

import { parseBacklogContent, BACKLOG_PATH } from './intake/backlog-scan.mjs'

/** Насколько долго закрытые карточки считаются прочитанными. Минута — см. шапку. */
export const CLOSED_CARDS_TTL_MS = 60000

/**
 * createClosedCards({backlogRoot, fsImpl, clock, ttlMs}) → {isClosed, size}.
 *
 * `backlogRoot` — функция или строка: дом планирования выбирают на ходу (окно переключают
 * между проектами), и застывший корень читал бы реестр не того дома.
 */
export function createClosedCards({ backlogRoot = '', fsImpl, clock = Date.now, ttlMs = CLOSED_CARDS_TTL_MS } = {}) {
  const read = fsImpl?.readFileSync ?? fsRead
  const exists = fsImpl?.existsSync ?? fsExists

  let closed = new Set()
  let readAt = 0
  let readRoot = null

  function rootNow() {
    const raw = typeof backlogRoot === 'function' ? backlogRoot() : backlogRoot
    return typeof raw === 'string' && raw.trim() !== '' ? raw : ''
  }

  function refresh() {
    const root = rootNow()
    const at = clock()
    // Смена дома читается СРАЗУ: выдержка бережёт диск, а не старый ответ о другом дереве.
    if (readRoot === root && at - readAt < ttlMs) return
    readRoot = root
    readAt = at
    closed = new Set()
    if (root === '') return
    const file = join(root, ...BACKLOG_PATH.split('/'))
    let raw = ''
    try {
      if (!exists(file)) return
      raw = String(read(file, 'utf8'))
    } catch {
      return
    }
    for (const item of parseBacklogContent(raw)) if (item && item.open === false) closed.add(item.id)
  }

  return {
    isClosed(id) {
      if (typeof id !== 'string' || id === '') return false
      refresh()
      return closed.has(id)
    },
    /** Сколько карточек сейчас числятся закрытыми — для отладки, не для решений. */
    get size() {
      refresh()
      return closed.size
    },
  }
}

/**
 * createGhostCheck({adapter, closedCards}) → async ({kind, taskId}) → boolean.
 *
 * Отвечает `true` ровно тогда, когда звать НЕ О ЧЕМ. Спрашивается только о работах, о которых
 * зов и так собрался говорить: выдержка отсекает подавляющее большинство проходов раньше, и
 * ни реестр, ни очередь не платят за молчаливые тики.
 */
export function createGhostCheck({ adapter, closedCards } = {}) {
  return async function isGhost({ taskId } = {}) {
    if (typeof taskId !== 'string' || taskId === '') return false
    if (closedCards && typeof closedCards.isClosed === 'function' && closedCards.isClosed(taskId)) return true
    if (!adapter || typeof adapter.payloadOf !== 'function') return false

    let task = null
    try {
      task = await adapter.payloadOf(taskId)
    } catch {
      return false
    }
    if (!task) return false
    if (task.data && task.data.cancelled === true) return true

    const batchId = task.batchId
    if (typeof batchId !== 'string' || batchId === '' || batchId === taskId) return false
    let parent = null
    try {
      parent = await adapter.payloadOf(batchId)
    } catch {
      return false
    }
    const decisions = parent && parent.data
    if (!decisions || typeof decisions !== 'object') return false
    if (decisions.cancelled === true) return true
    return Array.isArray(decisions.skipped) && decisions.skipped.includes(taskId)
  }
}
