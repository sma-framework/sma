/**
 * СТУПЕНЬ, КОТОРУЮ ФЛОТ СПОСОБЕН ДОВЕСТИ ДО КОНЦА: команда, несущая свои ответы, и
 * путеводитель, у которого есть дорога без спавна.
 *
 * ═══════════ ЧТО ИМЕННО ЗДЕСЬ ПРОВЕРЯЕТСЯ, И ПОЧЕМУ ЭТО НЕ ПРИДИРКА ═══════════════
 * Ступень планирования, запущенная с экрана, шесть раз подряд сгорала примерно за минуту
 * и оставляла ноль файлов. Причин было ДВЕ, и каждая одна убивает попытку целиком:
 *
 *   (1) КОМАНДА СПРАШИВАЕТ В ПУСТОТУ. Путеводитель ступени задаёт вопрос «исследовать
 *       сначала или пропустить?» — и в текстовом режиме печатает список и ждёт цифру.
 *       В сессии демона цифру набрать некому: нет ни клавиатуры, ни человека за ней.
 *       Сессия честно заканчивается нулём, ворота честно отказывают «нет артефакта», и
 *       на карточке остаётся минута сожжённого окна и ни строчки объяснения.
 *   (2) ПУТЕВОДИТЕЛЬ ТРЕБУЕТ ТОГО, ЧЕГО У РАБОТНИКА НЕТ. Он построен на спавне
 *       исследователя, планировщика и проверщика. Работник флота стоит в КОПИИ, куда
 *       материализуются четыре пути (настройки, память, навыки, правила проекта) —
 *       определения агентов среди них нет вовсе. Значит даже отвеченный вопрос упёрся бы
 *       в следующий отказ, и «выдать инструмент субагентов» его бы НЕ снял: инструмент
 *       без определения агента — это вызов с именем, которого в этой копии не существует.
 *
 * ПОЭТОМУ ДОМ ВЫБРАЛ ВСТРОЕННУЮ ДОРОГУ, а не расширение конверта прав: ступень дизайна
 * уже ходит ею («headless path — zero subagents are spawned here»), и она единственная,
 * которая в копии работника ИСПОЛНИМА. Утверждение о конверте здесь тоже стоит — как
 * замок на решении: инструмента субагентов в полосе бумажной работы нет, и появиться он
 * может только сознательной правкой, которая сделает этот файл красным.
 *
 * ЧЕМ ПРОВЕРЯЕТСЯ ПУТЕВОДИТЕЛЬ. Он — текст, который читает модель, поэтому здесь он
 * читается как текст: у КАЖДОГО вопроса в нём должен стоять headless-ответ, и стоять
 * РЯДОМ. Ответ, спрятанный на шестьсот строк выше вопроса, для читателя-модели не
 * существует — это ровно та дистанция, на которой «правило есть» перестаёт означать
 * «правилу следуют».
 *
 * ЭТОТ ФАЙЛ КРАСЕН ПРИ РОЖДЕНИИ. Команда ступени ответов не несёт, у вопросов
 * путеводителя headless-ответа нет, встроенной дороги в нём нет тоже.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { stageCommand, assertNoAutomation } from '../src/policy/phase-cycle.mjs'
import { createBuildArgs } from '../src/runner/build-args.mjs'
import { defaultEnvelope, envelopeSpawnOptions } from '../src/queue/capability-envelope.mjs'
import { HEADLESS_ENV, TERMINAL_PARITY_PATHS } from '../src/runner/args.mjs'
import { documentGate } from '../src/loop.mjs'

const GUIDE_PATH = new URL('../../sma-core/workflows/plan-phase.md', import.meta.url)
const GUIDE = readFileSync(GUIDE_PATH, 'utf8')
const GUIDE_LINES = GUIDE.split(/\r?\n/)

/** Ступень плана на ПУСТОЙ фазе — та самая, что горела шесть раз подряд. */
const PHASE = '20'

// ── the fixtures of the spawn composer (build-args.test.ts's shape, not reinvented) ──

const worker = {
  id: 'max-1',
  lane: 'paperwork',
  provider: 'claude',
  enabled: true,
  account: { name: 'max-1', configDir: '/accounts/max-1', oauthTokenEnv: 'SMA_MAX_1_TOKEN' },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsFs: any = {
  readFileSync: (p: string) => {
    if (String(p).replace(/\\/g, '/').endsWith('settings.json')) return JSON.stringify({ disableClaudeAiConnectors: true })
    throw new Error(`ENOENT ${p}`)
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildArgs = (): any =>
  createBuildArgs({ config: { workers: [worker] }, env: { SMA_MAX_1_TOKEN: 't' }, fsImpl: settingsFs })

const planTask = () => ({
  id: 'S-1788110314981',
  title: 'ступень плана',
  lane: 'paperwork',
  data: { kind: 'document', stage: 'plan', phase: PHASE },
})

const route = () => ({ workerId: 'max-1', provider: 'claude', useApiFallback: false, reason: 'profile' })

// ── the guide, read the way a model reads it: a question and its answer must be neighbours ──

/** Каждая строка путеводителя, которая ЗАДАЁТ вопрос человеку. */
function questionLines(): number[] {
  const out: number[] = []
  GUIDE_LINES.forEach((line, i) => {
    if (/AskUserQuestion|Enter number:/.test(line)) out.push(i)
  })
  return out
}

/** Каждая строка, которая называет headless-режим по имени переменной окружения. */
function headlessLines(): number[] {
  const out: number[] = []
  GUIDE_LINES.forEach((line, i) => {
    if (line.includes(HEADLESS_ENV)) out.push(i)
  })
  return out
}

/**
 * НАСКОЛЬКО ДАЛЕКО ОТ ВОПРОСА ЛЕЖИТ БЛИЖАЙШИЙ ОТВЕТ. Число строк, а не «есть/нет»: файл
 * в тысячу семьсот строк содержит что угодно, и «упоминание где-то в файле» — это не
 * ответ на вопрос, который читатель видит перед собой.
 */
const NEIGHBOURHOOD = 40

describe('команда ступени несёт ответы на свои собственные вопросы', () => {
  it('план запускается с ответом на единственный вопрос, который стоит между ним и планировщиком', () => {
    expect(stageCommand('plan', PHASE)).toBe(`/sma-plan-phase ${PHASE} --text --skip-research`)
  })

  it('ответ — это не автоответ: страж флагов пропускает команду, и слова «auto» в ней нет', () => {
    const command = stageCommand('plan', PHASE) as string
    expect(assertNoAutomation(command)).toBe(command)
    expect(command).not.toMatch(/--auto\b/)
  })

  it('промпт работника — та же команда, собранная из словаря, а не снятая с названия строки', () => {
    const spec = buildArgs()(planTask(), route())
    expect(spec.prompt).toBe(`/sma-plan-phase ${PHASE} --text --skip-research`)
    expect(spec.env[HEADLESS_ENV]).toBe('1')
  })
})

describe('путеводитель плана: у каждого вопроса есть headless-ответ, и он стоит рядом', () => {
  it('вопросы в файле есть — иначе проверка ниже утверждала бы пустоту', () => {
    expect(questionLines().length).toBeGreaterThan(0)
  })

  it('ни один вопрос не остаётся без ответа для сессии, у которой нет человека', () => {
    const answers = headlessLines()
    const orphans = questionLines().filter((q) => !answers.some((a) => Math.abs(a - q) <= NEIGHBOURHOOD))
    expect(
      orphans.map((i) => `${i + 1}: ${GUIDE_LINES[i].trim()}`),
      `вопросы без headless-ответа в пределах ${NEIGHBOURHOOD} строк`,
    ).toEqual([])
  })

  it('headless-дорога объявлена целиком: три роли внутри сессии, ноль спавнов, продукт — PLAN.md', () => {
    const headless = GUIDE.slice(GUIDE.indexOf('## 2.6'))
    expect(GUIDE).toMatch(/^## 2\.6\./m)
    for (const word of ['researcher', 'planner', 'plan-checker', 'PLAN.md']) {
      expect(headless, `headless-дорога не называет ${word}`).toContain(word)
    }
  })

  it('совместимость с рантаймом называет флот и его встроенную дорогу, а не только запрет на inline', () => {
    const block = GUIDE.slice(GUIDE.indexOf('<runtime_compatibility>'), GUIDE.indexOf('</runtime_compatibility>'))
    expect(block).toContain(HEADLESS_ENV)
    expect(block).toMatch(/inline/i)
  })
})

describe('почему встроенная дорога, а не инструмент субагентов — утверждение, а не мнение', () => {
  it('определения агентов в копию работника не материализуются: вызывать было бы нечего', () => {
    expect([...TERMINAL_PARITY_PATHS]).not.toContain('.claude/agents')
  })

  it('конверт бумажной полосы даёт инструменты встроенной дороги и ни одного инструмента спавна', () => {
    const tools = envelopeSpawnOptions(defaultEnvelope('paperwork')).allowedTools as string[]
    for (const need of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Skill']) expect(tools).toContain(need)
    expect(tools).not.toContain('Task')
    expect(tools).not.toContain('Agent')
  })

  it('ступень пишет в каталог фаз — конверт полосы это разрешает', () => {
    expect(defaultEnvelope('paperwork').writePaths).toContain('.planning')
  })
})

// ── ГЕЙТ: пустая фаза → PLAN.md ────────────────────────────────────────────────
//
// «Доезжает до PLAN.md» проверяется тем же способом, каким это утверждает сам демон:
// его собственными воротами документа. Пустая фаза — отказ по имени; фаза, в которой
// ступень оставила план и он достался истории, — квитанция файла и коммита.

const PROJECT = '/proj'
const PHASE_DIR = '20-nazvanie'
const ROOT = `${PROJECT}/.planning/phases`
const SHA = 'beef123'
const PLAN_REL = `.planning/phases/${PHASE_DIR}/20-01-PLAN.md`

function norm(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gate(files: string[], committed: string[]): any {
  const tree: Record<string, string[]> = { [ROOT]: [PHASE_DIR], [`${ROOT}/${PHASE_DIR}`]: files }
  const has = (p: string) => Object.prototype.hasOwnProperty.call(tree, norm(p))
  const set = new Set(committed.map(norm))
  const deps = {
    fsImpl: {
      existsSync: (p: string) => has(p),
      readdirSync: (p: string) => {
        if (!has(p)) throw new Error(`ENOENT: ${norm(p)}`)
        return tree[norm(p)]
      },
    },
    execGit: (args: string[]) => (set.has(norm(args[args.length - 1])) ? `${SHA}\n` : ''),
  }
  return documentGate(deps, { id: 'S-1', data: { kind: 'document', stage: 'plan', phase: PHASE } }, PROJECT)
}

describe('гейт ступени: пустая фаза доезжает до PLAN.md', () => {
  it('пустая фаза — отказ по имени, а не тихое «сделано»', () => {
    const verdict = gate([], [])
    expect(verdict.reason).toBe('no_artifact')
    expect(verdict.detail).toContain('-PLAN.md')
  })

  it('план написан и закоммичен — ворота отдают квитанцию файла и коммита', () => {
    expect(gate(['20-01-PLAN.md'], [PLAN_REL])).toEqual({ receiptRef: `artifact:${PLAN_REL}@${SHA}` })
  })

  it('план есть только на диске — истории он не достался, ворота закрыты', () => {
    expect(gate(['20-01-PLAN.md'], []).reason).toBe('no_artifact')
  })
})
