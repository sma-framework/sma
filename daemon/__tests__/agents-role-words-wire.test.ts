/**
 * ВЫКЛЮЧЕННАЯ РОЛЬ ОБЪЯСНЯЕТ САМА СЕБЯ — И ЭТО ПРОВОД, А НЕ АБЗАЦ В РАЗМЕТКЕ.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * Владелец открыл два окна и увидел в них противоположное. Настройки «Агенты» показывали
 * четвёртый десяток серых строк со словом «выключен» и одну синюю кнопку «Включить команду
 * (35)». Доска «Команда» в ту же минуту показывала работников, ждущих работы. Его слова 02.09:
 * «почему-то в агентах выключено, и я не понимаю вообще почему оно выключено, а в команде они
 * все ждут работы — либо понять, либо у нас в фронте ошибка».
 *
 * Ошибки в окне не было. Два окна отвечают на два РАЗНЫХ вопроса: «кто приехал с установкой» и
 * «кто уже берёт работу». Но ни одно из двух этого не говорило, а выключенная карточка не
 * называла ни себя, ни того, кто ставит ей задачи. Непонятый экран и сломанный экран для
 * человека — одно и то же.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. ПРОВОД ЦЕЛИКОМ: описание на диске → читающая модель демона (`role`, `pipeline`) → те
 *      самые две фразы, которые человек читает под карточкой. Не «функция считает правильно»,
 *      а «значение доезжает до потребителя»: слова подбираются ПО полям демона, и подмени их
 *      кто-нибудь на догадку по имени файла — этот прогон покраснеет.
 *   2. ФРАЗЫ РАЗНЫЕ ТАМ, ГДЕ РАЗНАЯ ПРИРОДА РОЛИ. Исполнителю ставит задачи очередь,
 *      планировщика зовёт сборка, специалиста поднимает фаза. Одна фраза на всех не ответила бы
 *      на вопрос «почему оно выключено» ни для кого.
 *   3. ГЛАВНАЯ КНОПКА АДРЕСУЕТ ДВЕРЬ, КОТОРАЯ ЕСТЬ. Зарезервированный адрес узкого действия —
 *      один и тот же литерал на обоих концах провода; разъехавшись, кнопка стучалась бы в
 *      несуществующего агента и получала бы отказ вместо включённого конвейера.
 *   4. ЭКРАН ЭТИ СЛОВА ДЕЙСТВИТЕЛЬНО ЗОВЁТ. Вычислено ≠ подключено: модуль фраз, который никто
 *      не импортирует, — это не объяснение, а мёртвый файл рядом с прежним молчанием.
 */

import { readFileSync } from 'node:fs'

import { describe, it, expect } from 'vitest'

import { readStockTeam, STOCK_PIPELINE_TARGET, STOCK_TEAM_TARGET } from '../src/front/harness.mjs'
import { STOCK_PIPELINE_TARGET as FRONT_PIPELINE_TARGET, STOCK_TEAM_TARGET as FRONT_TEAM_TARGET } from '../../spa/src/api/client'
import { roleWords } from '../../spa/src/screens/agents/role-words'

const PLANNER = `---
name: sma-planner
description: Собирает планы фаз.
tools: Read, Write, Edit
---
Тело планировщика.
`

const EXECUTOR = `---
name: sma-executor
description: Пишет код и исправляет баги.
tools: Read, Write, Edit, Bash
---
Тело исполнителя.
`

const VERIFIER = `---
name: sma-verifier
description: Проверяет сделанное.
tools: Read, Bash
---
Тело проверяющего.
`

/** Поставочная установка в дереве проекта: правимая копия рядом с нетронутой. */
function install() {
  const files: Record<string, string> = {
    '/repo/.claude/agents/sma-planner.md': PLANNER,
    '/repo/.claude/agents/sma-executor.md': EXECUTOR,
    '/repo/.claude/agents/sma-verifier.md': VERIFIER,
    '/repo/.claude/sma-core/agents/sma-planner.md': PLANNER,
    '/repo/.claude/sma-core/agents/sma-executor.md': EXECUTOR,
    '/repo/.claude/sma-core/agents/sma-verifier.md': VERIFIER,
  }
  const dirs: Record<string, string[]> = {
    '/repo/.claude/agents': ['sma-planner.md', 'sma-executor.md', 'sma-verifier.md'],
    '/repo/.claude/sma-core/agents': ['sma-planner.md', 'sma-executor.md', 'sma-verifier.md'],
  }
  const norm = (p: string) => String(p).replace(/\\/g, '/')
  const hit = (map: Record<string, unknown>, p: string) => Object.keys(map).find((k) => norm(p).endsWith(k))
  return {
    readFileSync: (p: string) => {
      const k = hit(files, p)
      if (!k) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files[k]
    },
    readdirSync: (p: string) => {
      const k = hit(dirs, p)
      if (!k) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return dirs[k]
    },
  }
}

const NO_HOME = () => '/home/nobody'

/** Карточки такими, какими их видит окно: одно чтение демона, ничего дописанного руками. */
function cards() {
  const team = readStockTeam({
    config: { workers: [] },
    repoDir: '/repo',
    fsImpl: install(),
    env: {},
    homedir: NO_HOME,
  })
  return new Map(team.map((c: any) => [c.id, c]))
}

const SCREEN = readFileSync(new URL('../../spa/src/screens/agents/index.tsx', import.meta.url), 'utf8')

describe('описание на диске → факты демона → фразы под карточкой', () => {
  it('исполнитель: карточка говорит, что задачи ставит ОЧЕРЕДЬ и что даст включение', () => {
    const card = cards().get('sma-executor')
    expect(card).toMatchObject({ enabled: false, pipeline: true, role: 'executor' })
    const words = roleWords(card)
    expect(words.assignedBy).toContain('очередь')
    expect(words.onEnable).toContain('очередь')
  })

  it('планировщик: задачи ставит СБОРКА, и это не те же слова, что у исполнителя', () => {
    const map = cards()
    const planner = roleWords(map.get('sma-planner'))
    const executor = roleWords(map.get('sma-executor'))
    expect(map.get('sma-planner')).toMatchObject({ pipeline: true, role: 'planner' })
    expect(planner.assignedBy).toContain('сборка')
    expect(planner.assignedBy).not.toBe(executor.assignedBy)
    expect(planner.onEnable).not.toBe(executor.onEnable)
  })

  it('специалист: задачи ставит ФАЗА, и сказано, что из очереди он не берёт ничего', () => {
    const card = cards().get('sma-verifier')
    expect(card).toMatchObject({ enabled: false, pipeline: false, role: 'verifier' })
    const words = roleWords(card)
    expect(words.assignedBy).toContain('фаза')
    expect(words.onEnable).toContain('очереди он не берёт ничего')
  })

  it('каждая выключенная карточка получает НЕПУСТЫЕ обе фразы — ни одной молчащей строки', () => {
    for (const card of cards().values()) {
      const words = roleWords(card as any)
      expect(words.assignedBy.length).toBeGreaterThan(20)
      expect(words.onEnable.length).toBeGreaterThan(20)
    }
  })

  it('фразы идут ОТ ПОЛЯ демона, а не от имени: перевернув признак, переворачиваем слова', () => {
    // Роль, объявленную конвейерной рукой человека в профиле, окно обязано объяснять как
    // конвейерную — иначе подпись под карточкой разошлась бы с тем, кого включает кнопка.
    const card = cards().get('sma-verifier')
    expect(roleWords({ ...card, pipeline: true, role: 'planner' }).assignedBy).toContain('сборка')
  })
})

describe('главная кнопка адресует ту дверь, которая есть', () => {
  it('зарезервированный адрес узкого действия — один литерал на обоих концах провода', () => {
    expect(FRONT_PIPELINE_TARGET).toBe(STOCK_PIPELINE_TARGET)
    expect(FRONT_TEAM_TARGET).toBe(STOCK_TEAM_TARGET)
    expect(FRONT_PIPELINE_TARGET).not.toBe(FRONT_TEAM_TARGET)
  })

  it('экран зовёт узкое действие и объясняющие слова — модуль фраз не лежит мимо окна', () => {
    expect(SCREEN).toContain('STOCK_PIPELINE_TARGET')
    expect(SCREEN).toContain('roleWords')
  })
})
