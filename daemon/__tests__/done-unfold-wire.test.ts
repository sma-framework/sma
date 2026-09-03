/**
 * РАСКРЫТИЕ ПРИНЯТОЙ РАБОТЫ — тест ПРОВОДА к доказательствам, а не к строке списка.
 *
 * Список готовых показывал строку и ничего больше. Всё содержательное — чем доказано, какие
 * коммиты, что говорит квитанция слияния, кто принял и когда, сколько было возвратов —
 * лежало в леджере и в git, и дверь карточки этого не отдавала. Следствие хуже неудобства:
 * приёмщиком стал терминал, принимающий сам, и без раскрытия «принято» — слово, а не
 * доказательство: основателю нечем проверить приёмщика.
 *
 * ПОЧЕМУ ИМЕННО ПРИНЯТАЯ РАБОТА. У непринятой ветка ещё стоит, и `HEAD..wt/<id>` отвечает
 * коммитами — дело было бы зелёным и до починки. Приёмка СНОСИТ ветку вместе с копией,
 * поэтому у принятой работы (той единственной, историю которой человек и хочет читать)
 * список коммитов приходил пустым, а квитанции слияния не приходило вовсе. Обе половины
 * доказательства при этом ЗАПИСАНЫ: пара `base` → `cleanup.branchTip` на строке попытки и
 * квитанция слияния в колонке решения.
 *
 * Дел два, потому что приёмщиков два: человек нажимает дверь окна (квитанция ложится в
 * колонку), терминал проводит ритуал сам (квитанция ложится в его собственный журнал). Оба
 * обязаны быть НАЗВАНЫ словом, а не выведены читателем из молчания.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { failedTestWords, runReportWords } from '../../spa/src/screens/today/DoneUnfold'

const TOKEN = 'a'.repeat(64)
const BASE = 'b'.repeat(40)
const TIP = 'c'.repeat(40)
const MERGE_SHA = 'd'.repeat(40)

// ── the smallest fake req/res a door needs ──

function mkReq(url: string) {
  const req: any = Readable.from([])
  req.method = 'GET'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}` }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    setHeader(k: string, v: any) {
      res.headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()]
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function askTaskDoor(deps: any, id: string) {
  const front = createFrontServer({ config: { token: TOKEN, repoDir: '/repo' }, deps })
  const res = mkRes()
  await front.handle(mkReq(`/api/task/${id}`), res)
  return { res, body: res.body ? JSON.parse(res.body) : null }
}

/**
 * ГИТ ПРИНЯТОЙ РАБОТЫ. Ветки больше нет — приёмка снесла её вместе с копией, — поэтому
 * `HEAD..wt/<id>` отвечает ровно тем, чем ответил бы настоящий git: ошибкой. Сохранённая пара
 * коммитов, наоборот, отвечает: она и есть то, что от работы осталось.
 */
function gitOfAcceptedWork(seen: string[][]) {
  return (args: string[]) => {
    seen.push(args)
    const range = args.find((a) => a.includes('..')) ?? ''
    if (range === `${BASE}..${TIP}`) {
      return 'e1e1e1e первый шаг: красный тест\nf2f2f2f второй шаг: починка\n'
    }
    throw new Error("fatal: ambiguous argument 'HEAD..wt/R-177': unknown revision")
  }
}

/** Две попытки: первую человек вернул, вторую принял — и уборка записала, когда именно. */
function ledgerOfAcceptedWork(taskId: string) {
  return {
    readAttempts: () => [
      {
        taskId,
        attempt: 1,
        workerId: 'w1',
        outcome: 'completed',
        startedAt: '2026-08-30T09:00:00.000Z',
        endedAt: '2026-08-30T09:20:00.000Z',
        base: BASE,
        branch: `wt/${taskId}`,
      },
      {
        taskId,
        attempt: 2,
        workerId: 'w1',
        outcome: 'completed',
        startedAt: '2026-08-31T08:00:00.000Z',
        endedAt: '2026-08-31T09:30:00.000Z',
        base: BASE,
        branch: `wt/${taskId}`,
        cleanup: {
          at: '2026-08-31T10:00:00.000Z',
          by: 'approve',
          removedPath: '/copies/wt-R-177',
          removedBranch: `wt/${taskId}`,
          branchTip: TIP,
          ok: true,
        },
      },
    ],
    readJournalEntries: () => [],
  }
}

const repos: string[] = []
afterAll(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true })
})

describe('раскрытие готовой работы — дверь карточки несёт доказательства, а не одну строку', () => {
  it('принятая человеком: непустая квитанция слияния, непустой список коммитов, кто принял и когда', async () => {
    const id = 'R-177'
    const seen: string[][] = []
    const { res, body } = await askTaskDoor(
      {
        adapter: {
          list: async () => [
            {
              id,
              status: 'completed',
              title: 'раскрытие готовой работы',
              acceptance: ['строка раскрывается на месте', 'видно, кто принял'],
              completedAt: 1_788_170_000_000,
              // Квитанция слияния так и лежит в колонке решения: текстом, как её положила приёмка.
              mergeReceipt: JSON.stringify({
                branch: `wt/${id}`,
                resultSha: MERGE_SHA,
                repo: '/repo',
                testsPassed: true,
              }),
              returnedNote: 'вернул: нет красного теста',
            },
          ],
        },
        ledger: ledgerOfAcceptedWork(id),
        execGit: gitOfAcceptedWork(seen),
        repoDir: '/repo',
      },
      id,
    )

    expect(res.statusCode).toBe(200)

    // (1) НЕПУСТОЙ СПИСОК КОММИТОВ у работы, чьей ветки больше нет. Пара `base` → `branchTip`
    //     записана строкой попытки, и спросить её — единственный способ показать человеку то,
    //     что было сделано, после того как копия убрана.
    expect(body.commits.length).toBeGreaterThan(0)
    expect(body.commits[0]).toContain('красный тест')
    expect(seen.some((a) => a.includes(`${BASE}..${TIP}`))).toBe(true)

    // (2) КВИТАНЦИЯ СЛИЯНИЯ СЛОВАМИ: ветка → итоговый коммит, гонялись ли тесты и с каким
    //     исходом. Отпечаток коммита слияния до сих пор доезжал (им отменяют приёмку), а
    //     ветка и судьба тестов молча терялись по дороге.
    expect(body.accepted).toBeTruthy()
    expect(body.accepted.merge).toEqual({
      branch: `wt/${id}`,
      sha: MERGE_SHA,
      testsPassed: true,
      testsNote: null,
      // Зелёный прогон никого не роняет и отчёта после себя не оставляет: пусто и `null`
      // здесь — измерение, а не забытые поля.
      failedTests: [],
      report: null,
    })

    // (3) КТО ПРИНЯЛ И КОГДА. Дверь одобрения — человеческая по построению, и след уборки
    //     называет минуту, в которую приёмка случилась.
    expect(body.accepted.by).toBe('human')
    expect(body.accepted.at).toBe('2026-08-31T10:00:00.000Z')
    expect(body.accepted.terminal).toBeNull()

    // (4) КРУГИ ВОЗВРАТА — сколько было и с какими словами. Попытка, закончившаяся «готово»,
    //     после которой была ещё одна, — это возврат: так решил человек, и это единственный
    //     след его решения.
    expect(body.returns.rounds).toBe(1)
    expect(body.returns.notes).toContain('вернул: нет красного теста')
  })

  /**
   * КРАСНАЯ ПРИЁМКА НА КАРТОЧКЕ — С ИМЕНАМИ И С ПУТЁМ К ОТЧЁТУ.
   *
   * Отказ читают один раз, в секунду нажатия; карточка остаётся, и именно к ней возвращаются,
   * решая, настоящий это красный или ложный (полный прогон при живых соседних сессиях умеет
   * краснеть ни за что). Пока имена и путь стояли только в квитанции, карточка говорила
   * «тесты гонялись — красно» и ни слова о том, что смотреть.
   */
  it('красная квитанция несёт до карточки имена упавших тестов и путь к отчёту прогона', async () => {
    const id = 'R-177-r'
    const report = '/var/sma/data/landing/R-177-r-2026-09-02T18-58-00-000Z.json'
    const { body } = await askTaskDoor(
      {
        adapter: {
          list: async () => [
            {
              id,
              status: 'awaiting_approval',
              title: 'красная приёмка',
              mergeReceipt: JSON.stringify({
                branch: `wt/${id}`,
                resultSha: null,
                repo: '/repo',
                testsPassed: false,
                refused: true,
                failedTest: 'scripts/sma/__tests__/landing.test.ts > посадка > Test 5',
                failedTests: [
                  'scripts/sma/__tests__/landing.test.ts > посадка > Test 5',
                  'daemon/__tests__/broken-import.test.ts',
                ],
                savedReport: report,
              }),
            },
          ],
        },
        ledger: ledgerOfAcceptedWork(id),
        execGit: gitOfAcceptedWork([]),
        repoDir: '/repo',
      },
      id,
    )

    expect(body.accepted.merge.testsPassed).toBe(false)
    expect(body.accepted.merge.failedTests).toEqual([
      'scripts/sma/__tests__/landing.test.ts > посадка > Test 5',
      'daemon/__tests__/broken-import.test.ts',
    ])
    expect(body.accepted.merge.report, 'путь к отчёту не доехал до карточки').toBe(report)
  })

  it('принятая терминалом: приёмщик назван словом и своим именем, квитанция — из его журнала', async () => {
    const id = 'R-177-t'
    const { body } = await askTaskDoor(
      {
        adapter: {
          list: async () => [
            {
              id,
              status: 'completed',
              title: 'принято терминалом',
              completedAt: 1_788_170_000_000,
              // Колонка решения молчит: дверь окна никто не нажимал.
            },
          ],
        },
        ledger: ledgerOfAcceptedWork(id),
        execGit: gitOfAcceptedWork([]),
        repoDir: '/repo',
        // Ритуал слияния, проведённый терминалом, оставляет квитанцию в его СОБСТВЕННОМ
        // журнале — том самом, что скреплён хеш-цепочкой. Это и есть доказательство приёмки,
        // когда приёмщик не человек.
        mergeJournal: async ({ branch }: { branch: string }) =>
          branch === `wt/${id}`
            ? {
                terminal: 'Окно-3',
                at: '2026-08-31T11:00:00.000Z',
                receipt: { branch, resultSha: MERGE_SHA, repo: '/repo', testsPassed: null, testsNote: 'прогонщика нет' },
              }
            : null,
      },
      id,
    )

    expect(body.accepted.by).toBe('terminal')
    expect(body.accepted.terminal).toBe('Окно-3')
    expect(body.accepted.at).toBe('2026-08-31T11:00:00.000Z')
    // Тесты не гонялись — и это НЕ «не прошли»: третье состояние названо своим словом.
    expect(body.accepted.merge.testsPassed).toBeNull()
    expect(body.accepted.merge.testsNote).toBe('прогонщика нет')
  })

  it('о чём записи нет, о том дверь молчит: ни выдуманного приёмщика, ни выдуманных кругов', async () => {
    const id = 'R-177-q'
    const { body } = await askTaskDoor(
      {
        adapter: {
          list: async () => [{ id, status: 'completed', title: 'без следов', completedAt: 1_788_170_000_000 }],
        },
        ledger: { readAttempts: () => [], readJournalEntries: () => [] },
        execGit: () => '',
        repoDir: '/repo',
      },
      id,
    )

    expect(body.accepted).toBeNull()
    expect(body.returns).toEqual({ rounds: 0, notes: [] })
  })
})

/**
 * ДВЕ ФРАЗЫ ПАНЕЛИ, ПРОВЕРЕННЫЕ ПОРОЗНЬ. Провод выше отвечает на вопрос «доехали ли поля до
 * карточки»; здесь — на вопрос «что панель СКАЖЕТ, когда поля не приехали». Второе не следует
 * из первого: молчание прогонятеля и молчание двери выглядят на карточке одинаково, а обе
 * фразы существуют ровно затем, чтобы отличать «названо» от «не названо».
 */
describe('панель раскрытия: пустое поле становится фразой о пустоте, а не прочерком', () => {
  it('имена упавших названы через разделитель, а их отсутствие — словами', () => {
    expect(failedTestWords({ failedTests: ['a > один', 'b > два'] } as any)).toBe('a > один · b > два')
    expect(failedTestWords({ failedTests: [] } as any)).toBe('имён упавших тестов прогонятель не назвал')
    // Квитанции нет вовсе — и это тот же случай: выдуманное имя послало бы чинить не тот тест.
    expect(failedTestWords(null)).toBe('имён упавших тестов прогонятель не назвал')
  })

  it('путь к отчёту отдаётся как известный, а его отсутствие — как неизвестное', () => {
    const known = runReportWords({ report: '/data/landing/wt-R-1-2026.json' } as any)
    expect(known).toEqual({ text: '/data/landing/wt-R-1-2026.json', known: true })
    expect(runReportWords({ report: null } as any).known).toBe(false)
    expect(runReportWords(null)).toEqual({ text: 'отчёта прогона не сохранилось', known: false })
  })
})
