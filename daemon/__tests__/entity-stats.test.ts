/**
 * ОКОШКО ПОКАЗАТЕЛЕЙ ФАЗЫ И БАТЧА — ПРОВЕРЯЕТСЯ КАК ПРОЕКЦИЯ, А НЕ ГЛАЗОМ ПО ВЁРСТКЕ.
 *
 * Страницы фазы и батча показывают человеку числа, которых он больше нигде не увидит: во что
 * обошлась ночь работы, сколько ходов на неё ушло, когда за неё взялись. Число, посчитанное
 * прямо в разметке, проверяется ровно одним способом — взглядом на живой экран, — и потому
 * расходится с правдой молча: никто не заметит, что «6/9 задач» считает строки вместе с
 * повторами, а «токены в/из» показывают кэш.
 *
 * Поэтому сборка показателей живёт в `spa/src/shell/stats.ts` чистой функцией, и здесь
 * утверждается ОНА — с известными числами на входе.
 *
 * ЧТО ИМЕННО УТВЕРЖДАЕТСЯ:
 *
 *   (1) фаза с известными числами → каждый показатель окошка равен тому, что сказала дверь;
 *   (2) фаза, о которой числа НЕ измеряли (попытки старше поля, строк не передали) → прочерк
 *       с названной причиной, а не бодрый ноль;
 *   (3) то же самое для сборки, включая момент просьбы владельца и длительность от него;
 *   (4) ВЕСЬ ПРОВОД ЦЕЛИКОМ: настоящие квитанции на диске → настоящая карточка фазы (описание
 *       из её `-CONTEXT.md`, задачи и ходы из строк очереди) → окошко показателей. Ровно этот
 *       класс дефекта — «посчитано, записано и никому не отдано» — в этом дереве уже случался.
 *
 * Числа на входе все разные: совпадение перепутанных полей исключено.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { derivePhaseCard, deriveState } from '../src/front/state.mjs'
import { NOT_MEASURED, batchStats, missingWords, phaseStats } from '../../spa/src/shell/stats'
import type { Stat } from '../../spa/src/shell/stats'

// ── временный проект ───────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
function mkProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-stats-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не роняет сьют */
    }
  }
})

/** Каталог прогона одной попытки — ровно там и с тем же именем файла, что оставляет тик. */
function writeReceipt(projectDir: string, attemptId: string, tokens: object | null) {
  const dir = join(projectDir, '.sma', 'runs', attemptId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'receipt.json'),
    `${JSON.stringify({ schema: 'sma-receipt/1', outcome: 'completed', tokens }, null, 2)}\n`,
    'utf8',
  )
}

/** Показатель по имени — прогон ищет его по `key`, а не по месту в списке. */
function by(stats: Stat[], key: string): Stat {
  const found = stats.find((s) => s.key === key)
  if (!found) throw new Error(`показателя «${key}» в окошке нет`)
  return found
}

/** Момент местного времени — так «старт 06:12» читается одинаково на любой машине. */
const START = new Date(2026, 7, 25, 6, 12, 0, 0).getTime()
const MINUTE = 60_000

// ═══════════ ФАЗА ══════════════════════════════════════════════════════════════════════════

const PHASE_CARD: any = {
  id: '17.7-telefon',
  name: 'Фаза 17.7 · Телефон',
  stages: { discuss: 'done', plan: 'done', design: 'done', execute: 'in-progress', verify: 'none' },
  questions: [],
  plans: [1, 2, 3, 4].map((n) => ({ name: `17.7-0${n}-PLAN.md`, path: `phases/17.7-telefon/0${n}` })),
  waves: [],
  summaries: [],
  uat: [],
  description: { text: 'Демон умеет позвонить.', source: 'context' },
  tokens: { input: 1_900_000, output: 214_000, cacheRead: 1_600_000, cacheWrite: 98_000 },
  work: { tasks: 9, done: 6, attempts: 41, startedAt: START },
}

describe('окошко показателей фазы', () => {
  it('известные числа → каждый показатель равен тому, что сказала дверь', () => {
    const stats = phaseStats(PHASE_CARD, START + 160 * MINUTE)

    expect(by(stats, 'stage').value).toBe('4 из 5')
    expect(by(stats, 'plans').value).toBe('4')
    expect(by(stats, 'tasks').value).toBe('6/9')
    expect(by(stats, 'attempts').value).toBe('41')
    // «1,9М/214К» — крупное число человеческим глазом; запятая или точка зависит от машины,
    // сами числа — нет.
    expect(by(stats, 'tokens').value).toMatch(/^1[.,]9М\/214К$/)
    expect(by(stats, 'cache').value).toMatch(/^1[.,]6М\/98К$/)
    expect(by(stats, 'startedAt').value).toBe('06:12')
    expect(by(stats, 'running').value).toBe('2 ч 40 м')

    for (const key of ['stage', 'plans', 'tasks', 'attempts', 'tokens', 'cache', 'startedAt', 'running']) {
      expect(by(stats, key).known).toBe(true)
    }
  })

  it('денег по фазе никто не считает → прочерк с причиной, а не «$0» из токенов по своему курсу', () => {
    const stats = phaseStats(PHASE_CARD, START)
    for (const key of ['subscription', 'paidApi']) {
      expect(by(stats, key).known).toBe(false)
      expect(by(stats, key).value).toBe(NOT_MEASURED)
      expect(by(stats, key).why).toBeTruthy()
    }
    expect(missingWords(stats)).toContain('не измеряли')
  })

  it('чисел нет по-честному (попытки старше поля, строк не передали) → прочерк, а не ноль', () => {
    const stats = phaseStats({ ...PHASE_CARD, tokens: null, work: null }, START)

    for (const key of ['tasks', 'attempts', 'tokens', 'cache', 'startedAt', 'running']) {
      expect(by(stats, key).known).toBe(false)
      expect(by(stats, key).value).toBe(NOT_MEASURED)
    }
    // Стадия и планы — это чтение каталога: они известны всегда, пока есть сама карточка.
    expect(by(stats, 'stage').known).toBe(true)
    expect(by(stats, 'plans').value).toBe('4')

    const words = missingWords(stats)
    expect(words).toContain('квитанций с числами нет')
    expect(words).toContain('строк работы окно не получило')
  })

  it('измеренный ноль остаётся нулём: за задачи фазы ещё никто не брался', () => {
    const stats = phaseStats(
      { ...PHASE_CARD, work: { tasks: 3, done: 0, attempts: 0, startedAt: null } },
      START,
    )
    expect(by(stats, 'tasks').value).toBe('0/3')
    expect(by(stats, 'attempts').value).toBe('0')
    expect(by(stats, 'attempts').known).toBe(true)
    // …а вот старта у неё честно нет: мерить не от чего.
    expect(by(stats, 'startedAt').known).toBe(false)
  })
})

// ═══════════ БАТЧ ══════════════════════════════════════════════════════════════════════════

const BATCH_ROW: any = {
  id: 'B-7',
  title: 'Разгреби мелочь перед показом',
  project: 'sma',
  machine: 'okno',
  state: 'running',
  items: [
    { id: 'B-7-1', title: 'кусок 1', status: 'completed', state: 'done' },
    { id: 'B-7-2', title: 'кусок 2', status: 'claimed', state: 'running' },
    { id: 'B-7-3', title: 'кусок 3', status: 'queued', state: 'waiting' },
  ],
  holding: null,
  requestedAt: START,
  attempts: 9,
  tokens: { input: 188_000, output: 21_000, cacheRead: 142_000, cacheWrite: 9_000 },
}

describe('окошко показателей батча', () => {
  it('известные числа → элементы, ходы, расход и момент просьбы владельца', () => {
    const stats = batchStats(BATCH_ROW, START + 49 * MINUTE)

    expect(by(stats, 'items').value).toBe('1/3')
    expect(by(stats, 'attempts').value).toBe('9')
    expect(by(stats, 'tokens').value).toBe('188К/21К')
    expect(by(stats, 'cache').value).toBe('142К/9К')
    expect(by(stats, 'requestedAt').value).toBe('06:12')
    expect(by(stats, 'running').value).toBe('49 м')
  })

  it('сборка старше отметки о просьбе → прочерк с причиной, а не подставленный момент', () => {
    const stats = batchStats(
      { ...BATCH_ROW, requestedAt: null, tokens: null, attempts: undefined },
      START + 49 * MINUTE,
    )

    for (const key of ['requestedAt', 'running', 'tokens', 'cache', 'attempts']) {
      expect(by(stats, key).value).toBe(NOT_MEASURED)
      expect(by(stats, key).known).toBe(false)
    }
    // Элементы — это сама сборка: они известны всегда.
    expect(by(stats, 'items').value).toBe('1/3')
    expect(missingWords(stats)).toContain('сборка старше отметки')
  })
})

// ═══════════ ВЕСЬ ПРОВОД: ДИСК → ДВЕРЬ → ОКОШКО ════════════════════════════════════════════

const FIRST = { input: 100, output: 11, cacheRead: 1000, cacheWrite: 5 }
const SECOND = { input: 200, output: 22, cacheRead: 2000, cacheWrite: 7 }

describe('от квитанции на диске до окошка показателей', () => {
  it('карточка фазы: описание из её CONTEXT.md, задачи и ходы из строк, расход из квитанций', () => {
    const projectDir = mkProject()
    const dir = join(projectDir, '.planning', 'phases', '17.7-telefon')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '17.7-CONTEXT.md'),
      '# Фаза 17.7 · Телефон\n\nДемон умеет позвонить: событие очереди будит спящее окно.\n\nВторой абзац сюда не едет.\n',
      'utf8',
    )
    writeFileSync(join(dir, '17.7-01-PLAN.md'), '# план\n', 'utf8')
    writeReceipt(projectDir, 'S-1_1', FIRST)
    writeReceipt(projectDir, 'S-1_2', SECOND)
    writeReceipt(projectDir, 'S-2_1', FIRST)

    const rows = [
      {
        id: 'S-1',
        status: 'completed',
        lane: 'paperwork',
        title: 'обсуждение',
        attempt: 2,
        claimedAt: START + MINUTE,
        data: { kind: 'document', stage: 'discuss', phase: '17.7' },
      },
      {
        id: 'S-2',
        status: 'claimed',
        lane: 'paperwork',
        title: 'план',
        attempt: 1,
        claimedAt: START,
        data: { kind: 'document', stage: 'plan', phase: '17.7' },
      },
      {
        id: 'S-9',
        status: 'completed',
        lane: 'paperwork',
        title: 'чужая фаза',
        attempt: 7,
        claimedAt: START - 5 * MINUTE,
        data: { kind: 'document', stage: 'plan', phase: '18' },
      },
    ]

    const card: any = derivePhaseCard({ projectDir, phaseId: '17.7', taskRows: rows })
    expect(card).not.toBe(null)
    // Описание — ПЕРВЫЙ абзац контекста, без его заголовка и без второго абзаца.
    expect(card.description).toEqual({
      text: 'Демон умеет позвонить: событие очереди будит спящее окно.',
      source: 'context',
    })
    // Чужая фаза не приносит сюда ни своих ходов, ни своего старта.
    expect(card.work).toEqual({ tasks: 2, done: 1, attempts: 3, startedAt: START })

    const stats = phaseStats(card, START + 30 * MINUTE)
    expect(by(stats, 'tasks').value).toBe('1/2')
    expect(by(stats, 'attempts').value).toBe('3')
    expect(by(stats, 'plans').value).toBe('1')
    // 100+200+100 / 11+22+11 — сумма по задачам фазы, по каждой по всем её подходам.
    expect(by(stats, 'tokens').value).toBe('400/44')
    expect(by(stats, 'cache').value).toBe('4К/17')
    expect(by(stats, 'startedAt').value).toBe('06:12')
    expect(by(stats, 'running').value).toBe('30 м')
  })

  it('фаза без документа обсуждения → честное «описания нет», а не пустое место', () => {
    const projectDir = mkProject()
    mkdirSync(join(projectDir, '.planning', 'phases', '19-tishina'), { recursive: true })

    const card: any = derivePhaseCard({ projectDir, phaseId: '19' })
    expect(card).not.toBe(null)
    expect(card.description).toBe(null)
    expect(card.work).toBe(null)
  })

  it('строка батча: момент просьбы, ходы кусков и расход сборки доезжают до окошка', async () => {
    const projectDir = mkProject()
    writeReceipt(projectDir, 'B-7-1_1', FIRST)
    writeReceipt(projectDir, 'B-7-2_1', SECOND)

    const rows = [
      {
        id: 'B-7',
        batchId: 'B-7',
        status: 'queued',
        lane: 'prod',
        title: 'Разгреби мелочь перед показом',
        priority: 0,
        data: { batch: 'parent', requestedAt: START },
      },
      { id: 'B-7-1', batchId: 'B-7', status: 'completed', lane: 'prod', title: 'кусок 1', attempt: 1, priority: 0 },
      { id: 'B-7-2', batchId: 'B-7', status: 'claimed', lane: 'prod', title: 'кусок 2', attempt: 2, priority: 0 },
    ]

    const payload: any = await deriveState({
      adapter: { list: async () => rows },
      config: {},
      repoDir: projectDir,
      clock: () => START,
    } as any)

    expect(payload.batches).toHaveLength(1)
    const stats = batchStats(payload.batches[0], START + 49 * MINUTE)
    expect(by(stats, 'items').value).toBe('1/2')
    expect(by(stats, 'attempts').value).toBe('3')
    expect(by(stats, 'tokens').value).toBe('300/33')
    expect(by(stats, 'requestedAt').value).toBe('06:12')
    expect(by(stats, 'running').value).toBe('49 м')
  })
})
