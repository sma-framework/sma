/**
 * ПРОВОД «КОЛОКОЛ ЗАДАЧИ → КАРТОЧКА ПЕРЕЧИТАЛА СЕБЯ» — и ничего, кроме него.
 *
 * ═══════════════ ДЕФЕКТ, КОТОРЫЙ ЭТОТ ФАЙЛ СТОРОЖИТ ═══════════════
 *
 * Живой клик владельца 25.08: после «Одобрить» карточка задачи оставалась в прежнем
 * состоянии, и «принято/слито» человек видел только после F5. Всё по отдельности работало:
 * дверь принимала, демон звонил `task.approved`, окно этот колокол СЛЫШАЛО — и применяло его
 * к общей картине (`state`), потому что заплатка на картину и была единственным читателем.
 * Карточка живёт своим чтением (`task/:id`), и его не трогал никто. Отрезок провода между
 * колоколом и ЭТИМ чтением не был проверен ни одним прогоном, поэтому его отсутствие ничего
 * не роняло — оно просто выглядело как «окно тормозит».
 *
 * ═══════════════ ЧТО ЗДЕСЬ УТВЕРЖДАЕТСЯ ═══════════════
 *
 * Только подписка, и намеренно не вёрстка: дерево компонентов в таком прогоне проверяло бы
 * что угодно, кроме провода. Отсюда четыре утверждения:
 *
 *   (1) колокол ЭТОЙ задачи → заказано перечитывание ЕЁ ключа, и ровно его;
 *   (2) колокол чужой задачи и колокол не про задачу (`spend.updated`) → не заказано ничего:
 *       перечитывать карточку на каждый чужой звон — это тот самый поток запросов, ради
 *       отказа от которого живой слой и существует;
 *   (3) отписка снимает ровно то, что повесила, а карточка, открытая ни с чем, не подписана;
 *   (4) СКВОЗНОЙ ОТРЕЗОК: настоящий кадр с именем `task.approved`, поданный в настоящий
 *       `subscribeHints` через настоящий `listenToFrames`, доходит до настоящего `watchTask`.
 *       Именно на стыке этих модулей дефект и жил, и подделка любого из них ответила бы из
 *       того самого допущения, которое проверяется.
 *
 * Байты сокета сюда не тянутся сознательно: соседний сьют (`live-hints-wire`) уже ведёт
 * настоящий кадр от хаба демона через настоящий порт до `onFrame`. Здесь начинается
 * следующий отрезок того же провода — от `onFrame` до перезапроса карточки.
 *
 * ═══════════════ И ОТДЕЛЬНО — СЛОВАРЬ НЕ РАЗОШЁЛСЯ ═══════════════
 *
 * Список имён, по которым карточка узнаёт «это про задачу», обязан быть ПОДМНОЖЕСТВОМ того,
 * что демон вообще умеет звонить. Разойдись он на одно имя — карточка молча перестанет
 * обновляться на этом событии, и выглядеть это будет как «иногда не работает».
 */

import { describe, it, expect } from 'vitest'

import { EVENT_TYPES } from '../src/front/events.mjs'
import { subscribeHints, onFrame, TASK_EVENTS } from '../../spa/src/api/hints'
import { watchTask, aboutTask } from '../../spa/src/api/task-live'
import type { HintsChannel } from '../../spa/src/api/hints'
import type { EventFrame } from '../../spa/src/api/types'

// ── чем здесь заменён клиент запросов ───────────────────────────────────────────────────
//
// Ровно двумя методами, которые провод и трогает: заказом перечитывания и записью заплатки в
// картину. Настоящий клиент притащил бы за собой кэш, таймеры и планировщик — то есть три
// причины, по которым прогон мог бы позеленеть или покраснеть не из-за провода.

function mkClient() {
  const invalidated: unknown[][] = []
  return {
    invalidated,
    client: {
      invalidateQueries: (arg: { queryKey: readonly unknown[] }) => {
        invalidated.push([...arg.queryKey])
        return Promise.resolve()
      },
      setQueryData: () => undefined,
    } as never,
  }
}

/** Колокол в той форме, в какой его отдаёт живой слой окна. */
function frame(event: string, taskId?: string, status?: string): EventFrame {
  return { id: 1, event, ts: '2026-08-25T10:00:00.000Z', taskId, status } as EventFrame
}

// ── поддельный канал: та же форма, что у настоящего, и ни одной лишней способности ───────

function mkChannel() {
  const byName = new Map<string, Set<(e: MessageEvent<string>) => void>>()
  let closed = false
  const channel: HintsChannel = {
    addEventListener(name: string, listener: (e: MessageEvent<string>) => void) {
      let set = byName.get(name)
      if (!set) byName.set(name, (set = new Set()))
      set.add(listener)
    },
    removeEventListener(name: string, listener: (e: MessageEvent<string>) => void) {
      byName.get(name)?.delete(listener)
    },
    close() {
      closed = true
    },
  }
  return {
    channel,
    get closed() {
      return closed
    },
    /** Кадр, названный по имени, — как его пишет хаб демона и читает EventSource. */
    deliver(evt: EventFrame) {
      const listeners = byName.get(evt.event)
      if (!listeners) return 0
      const msg = { data: JSON.stringify(evt) } as MessageEvent<string>
      for (const l of [...listeners]) l(msg)
      return listeners.size
    },
  }
}

describe('карточка задачи: провод подписки', () => {
  it('колокол этой задачи заказывает перечитывание её ключа — и только его', () => {
    const { client, invalidated } = mkClient()
    const listeners: ((e: EventFrame) => void)[] = []
    const stop = watchTask(client, 'R-1', {
      subscribe: (l) => {
        listeners.push(l)
        return () => {
          listeners.splice(listeners.indexOf(l), 1)
        }
      },
    })

    listeners[0](frame('task.approved', 'R-1', 'completed'))

    expect(invalidated).toEqual([['task', 'R-1']])
    stop()
  })

  it('чужая задача и колокол не про задачу не заказывают ничего', () => {
    const { client, invalidated } = mkClient()
    const listeners: ((e: EventFrame) => void)[] = []
    watchTask(client, 'R-1', {
      subscribe: (l) => {
        listeners.push(l)
        return () => {}
      },
    })

    listeners[0](frame('task.approved', 'R-2', 'completed'))
    listeners[0](frame('spend.updated'))
    listeners[0](frame('machine.presence'))

    expect(invalidated).toEqual([])
  })

  it('отписка снимает ровно то, что повесила; карточка без задачи не подписана', () => {
    let attached = 0
    const subscribe = (_l: (e: EventFrame) => void) => {
      attached += 1
      return () => {
        attached -= 1
      }
    }
    const { client } = mkClient()

    const stop = watchTask(client, 'R-1', { subscribe })
    expect(attached).toBe(1)
    stop()
    expect(attached).toBe(0)

    watchTask(client, null, { subscribe })
    expect(attached).toBe(0)
  })

  it('aboutTask отвечает только про названную задачу', () => {
    expect(aboutTask(frame('task.returned', 'R-1'), 'R-1')).toBe(true)
    expect(aboutTask(frame('task.returned', 'R-1'), 'R-2')).toBe(false)
    expect(aboutTask(frame('chat.reply', 'R-1'), 'R-1')).toBe(false)
    expect(aboutTask(null, 'R-1')).toBe(false)
    expect(aboutTask(frame('task.returned', 'R-1'), null)).toBe(false)
  })

  it('СКВОЗНОЙ ОТРЕЗОК: названный кадр в живом слое доходит до перезапроса карточки', () => {
    const { client, invalidated } = mkClient()
    const chan = mkChannel()

    const hints = subscribeHints(client, { openChannel: () => chan.channel })
    const stop = watchTask(client, 'R-7', { subscribe: onFrame })

    // Кадр приходит НАЗВАННЫМ — по спецификации именно так, и именно на этом однажды
    // потерялся весь живой слой окна.
    expect(chan.deliver(frame('task.approved', 'R-7', 'completed'))).toBeGreaterThan(0)
    expect(invalidated).toEqual([['task', 'R-7']])

    // Закрытая карточка перестаёт заказывать перечитывания, канал при этом жив.
    stop()
    chan.deliver(frame('task.returned', 'R-7', 'queued'))
    expect(invalidated).toEqual([['task', 'R-7']])

    hints.close()
    expect(chan.closed).toBe(true)
  })

  it('имена, по которым карточка узнаёт задачу, демон умеет звонить', () => {
    for (const name of TASK_EVENTS) expect(EVENT_TYPES).toContain(name)
  })
})
