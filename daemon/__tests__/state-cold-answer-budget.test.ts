/**
 * БЮДЖЕТ ХОЛОДНОГО ОТВЕТА ДВЕРИ СОСТОЯНИЯ — и почему он мерится, а не обещается.
 *
 * ═══════════════ ЧТО БЫЛО ИЗМЕРЕНО ═══════════════
 *
 * Три подряд вызова `/api/state` на живом конвейере: 33 465 мс, 717 мс, 704 мс. Тело 219 КБ,
 * соседняя дверь `/api/projects` — 55 мс. Разница между первым вызовом и вторым — это ровно
 * та память, которую дерайв набирает по ходу первого; пока она пуста, дверь молчит полминуты.
 *
 * Замер этой копии на 136 закрытых работах, 45 работниках и 35 строках очереди: 25 100 мс
 * всего, из них 24 779 мс — git, и ровно 276 СИНХРОННЫХ запусков git. Из них 272 — это
 * закрытые работы, по ДВА запуска на каждую (`log` за коммитами и `diff` за счётом
 * изменений), и ещё 4 — состояние проекта против ствола. То есть 98,6 % холодного ответа
 * стоит список закрытых работ, а не указатель фаз, на который падало подозрение: указатель
 * фаз git не спрашивает вовсе.
 *
 * ═══════════════ ЧТО ЭТО СТОИЛО ЧЕЛОВЕКУ ═══════════════
 *
 * Всё это время у демона ОДИН цикл событий, и синхронный подпроцесс держит его целиком: пока
 * дверь считает коммиты вчерашних работ, окно не получает ни очереди, ни работников, а
 * сторож простоя (`probeDoor`, потолок 3 000 мс) читает живую дверь как мёртвую. Основатель
 * при четырёх работающих работниках и тридцати пяти работах в очереди видел «Работников
 * нет» и «Пока тихо — команда ждёт задач» и прочитал это как правду о доме.
 *
 * ═══════════════ ЧТО ИМЕННО ЗАПИРАЕТСЯ ЗДЕСЬ ═══════════════
 *
 * Не «стало быстрее» — быстрее бывает от тёплой памяти и от быстрой машины. Запирается
 * ПРАВИЛО: на пути запроса дерайв не запускает НИ ОДНОГО git за закрытые работы. Дорогое
 * досылается отдельно (`warmDoneGit`), и до тех пор карточка честно говорит «ещё не
 * спрошено» — `null`, а не пустой список: пустой список означал бы «спросили и узнали, что
 * коммитов нет», а это другое утверждение.
 *
 * Шов git здесь СИНХРОННЫЙ и намеренно медленный (занятое ожидание, как настоящий spawn на
 * этой машине — 62-84 мс). Подделка, отвечающая мгновенно, не отличила бы 272 запуска от
 * нуля, и красного у этого гейта не было бы вовсе.
 */

import { describe, it, expect } from 'vitest'

import { deriveState, warmDoneGit } from '../src/front/state.mjs'

/** Столько стоит один настоящий запуск git на машине основателя (замерено: 62-84 мс). */
const SPAWN_MS = 40

/**
 * ПОТОЛОК ХОЛОДНОГО ОТВЕТА. Окно опрашивает дверь раз в три секунды, а сторож простоя ждёт
 * её три; ответ, не уложившийся в секунду с четвертью, для обоих уже происшествие. При
 * старом устройстве этот же случай стоил 272 × 40 = 10 880 мс — красное на порядок, а не на
 * проценты.
 */
const COLD_BUDGET_MS = 1250

const DONE_ROWS = 136
const WORKER_ROWS = 45
const QUEUED_ROWS = 35
const PROJECT_DIR = '/connected/project'

const NOW = 1_800_000_000_000

/** Занятое ожидание: подпроцесс держит ОДИН цикл событий, и подделка обязана держать так же. */
function burn(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* the event loop is exactly as blocked as a synchronous spawn leaves it */
  }
}

function fixtureRows() {
  const rows: any[] = []
  for (let i = 0; i < DONE_ROWS; i += 1) {
    rows.push({
      id: `T-done-${i}`,
      title: `закрытая ${i}`,
      status: i % 5 === 0 ? 'failed' : 'completed',
      project: 'sma',
      lane: 'prod',
      enqueuedAt: NOW - 9_000_000,
      completedAt: NOW - 8_000_000,
      workerId: `w${i % WORKER_ROWS}`,
      attempt: 1,
    })
  }
  for (let i = 0; i < QUEUED_ROWS; i += 1) {
    rows.push({
      id: `T-queued-${i}`,
      title: `в очереди ${i}`,
      status: 'queued',
      project: 'sma',
      lane: 'prod',
      priority: 0,
      enqueuedAt: NOW - 1_000_000,
    })
  }
  for (let i = 0; i < 4; i += 1) {
    rows.push({
      id: `T-claimed-${i}`,
      title: `в работе ${i}`,
      status: 'claimed',
      project: 'sma',
      lane: 'prod',
      enqueuedAt: NOW - 1_000_000,
      claimedAt: NOW - 500_000,
      leaseRenewedAt: NOW - 10_000,
      workerId: `w${i}`,
    })
  }
  return rows
}

function fixtureConfig() {
  return {
    agingHours: 24,
    budget: { monthlyApiCapUsd: 50 },
    workers: Array.from({ length: WORKER_ROWS }, (_, i) => ({
      id: `w${i}`,
      lane: 'prod',
      account: { name: `acc-${i % 3}` },
    })),
    projects: [{ id: 'sma', name: 'Продукт', path: PROJECT_DIR }],
    activeProject: 'sma',
  }
}

describe('state.mjs — холодный ответ двери состояния не платит за закрытые работы', () => {
  it('дверь отвечает очередью и работниками, не спросив git ни об одной закрытой работе', async () => {
    const calls: { args: string[]; opts: any }[] = []
    const execGit = (args: string[], opts: any = {}) => {
      calls.push({ args, opts })
      burn(SPAWN_MS)
      return args[0] === 'log' ? `abc1234 работа ${args[3]}` : ' 2 files changed, 9 insertions(+)'
    }

    const deps = {
      adapter: { list: async () => fixtureRows() },
      config: fixtureConfig(),
      execGit,
      repoDir: '/served/tree',
      clock: () => NOW,
    }

    const startedAt = Date.now()
    const payload: any = await deriveState(deps)
    const coldMs = Date.now() - startedAt

    // То, ради чего окно и открывают, приезжает ПЕРВЫМ ответом — а не после того, как
    // сосчитаны все закрытые.
    expect(payload.queue).toHaveLength(QUEUED_ROWS)
    expect(payload.workers).toHaveLength(WORKER_ROWS)
    expect(payload.kpis.workersBusy).toBe(4)
    expect(payload.done).toHaveLength(DONE_ROWS)

    // НИ ОДНОГО запуска git за карточку закрытой работы на пути запроса. Состояние проекта
    // против ствола — соседний вопрос: он ограничен числом проектов и помнится десять секунд.
    const cardReads = calls.filter((c) => c.args[0] === 'log' || c.args[0] === 'diff')
    expect(cardReads, 'дверь запросила git за закрытые работы прямо на пути ответа').toHaveLength(0)

    expect(coldMs).toBeLessThan(COLD_BUDGET_MS)
  })

  it('пока git не спрошен, закрытая работа говорит «неизвестно», а не «коммитов нет»', async () => {
    const execGit = (args: string[]) => {
      burn(SPAWN_MS)
      return args[0] === 'log' ? 'abc1234 сделал дело' : ' 2 files changed, 9 insertions(+)'
    }
    const rows = [
      {
        id: 'T-cold-single',
        title: 'ночная',
        status: 'completed',
        project: 'sma',
        completedAt: NOW,
        attempt: 1,
      },
    ]
    const deps = {
      adapter: { list: async () => rows },
      config: fixtureConfig(),
      execGit,
      repoDir: '/served/tree',
      clock: () => NOW,
    }

    const cold: any = await deriveState(deps)
    // `null`, а НЕ `[]`: пустой список — это ответ «коммитов нет», которого никто не получал.
    expect(cold.done[0].commits).toBeNull()
    expect(cold.done[0].diffStat).toBeNull()
    expect(cold.done[0].gitPending).toBe(true)

    // ДОСЫЛКА — отдельным ходом, и она спрашивает git в дереве ПОДКЛЮЧЁННОГО проекта: где
    // ветка работы и лежит. Каталог называет дерайв, досылка его только исполняет.
    const warmCalls: { args: string[]; opts: any }[] = []
    await warmDoneGit({
      execGitAsync: async (args: string[], opts: any = {}) => {
        warmCalls.push({ args, opts })
        return args[0] === 'log' ? 'abc1234 сделал дело' : ' 2 files changed, 9 insertions(+)'
      },
      tasks: ['T-cold-single'],
    })
    expect(warmCalls).toHaveLength(2)
    for (const c of warmCalls) expect(c.opts).toMatchObject({ cwd: PROJECT_DIR })

    const warm: any = await deriveState(deps)
    expect(warm.done[0].commits).toEqual(['abc1234 сделал дело'])
    expect(warm.done[0].diffStat).toBe('2 files changed, 9 insertions(+)')
    expect(warm.done[0].gitPending).toBeUndefined()
  })
})
