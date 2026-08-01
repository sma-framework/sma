/**
 * import-scanner.test.ts — дверь импорта: чужое хозяйство читается детерминированно.
 *
 * Доказывает, что проект, у которого УЖЕ есть свои определения агентов и навыков,
 * виден системе за один скан: что нашлось, что с чем конфликтует, что придётся
 * переносить руками. Ни одного обращения к модели, ни одного касания диска —
 * всё хозяйство здесь фикстуры, вся fs подставлена.
 *
 * Покрыто (первая половина — скан):
 *   - валидный чужой субагент и валидный чужой навык становятся кандидатами;
 *   - битый заголовок → кандидат 'unknown' с причиной, скан НЕ падает;
 *   - занятое имя → коллизия с предложением суффикса (тихой перезаписи нет);
 *   - имя файла, не приводимое к слагу → 'unknown';
 *   - правила проекта — информационная строка, не кандидат на автоперенос;
 *   - пустое хозяйство → notReady с человеческой причиной;
 *   - fs, которая бросает на каждый вызов → пустой результат, не исключение;
 *   - реестр форматов заморожен, claude-code первым;
 *   - структурная проверка: в модуле нет модели и нет следов запуска сессий.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { scanEstate, FORMAT_PARSERS } from '../src/front/import-scanner.mjs'

// ── чужие фикстуры (формат Claude Code) ──

const FOREIGN_AGENT = `---
name: twitter-parser
description: Читает публичные твиты по теме и собирает сводку. Работает только на чтение.
tools: Read, Grep, WebFetch
---
# Twitter parser

Собирает короткую сводку по теме.
`

const FOREIGN_SKILL = `---
name: release-notes
description: Собирает заметки к выпуску из истории изменений. Пишет черновик в docs.
use-when: когда готовится очередной выпуск
---
Порядок действий: ...
`

const FOREIGN_BROKEN = `Просто заметка без заголовка.
Никакого фронтматтера тут нет.
`

const FOREIGN_COLLIDING = `---
name: creator
description: Чужой агент, чьё имя уже занято работником парка.
tools: Read
---
тело
`

const FOREIGN_UNSLUGGABLE = `---
name: Иероглифы
description: Имя файла не приводится к латинскому слагу.
tools: Read
---
тело
`

const PROJECT_RULES = `# Правила проекта

Всегда запускайте тесты перед коммитом.
`

/** Ростер и парк, против которых считаются коллизии. */
const REGISTRIES = {
  workers: [{ id: 'max-1' }, { id: 'creator' }],
  agents: [{ id: 'reviewer' }],
  skills: [{ id: 'sp-report' }],
}

/** Чужой проект: всё сразу — валидное, битое, конфликтующее. */
function estate(): Record<string, string> {
  return {
    '/foreign/.claude/agents/twitter-parser.md': FOREIGN_AGENT,
    '/foreign/.claude/agents/broken.md': FOREIGN_BROKEN,
    '/foreign/.claude/agents/creator.md': FOREIGN_COLLIDING,
    '/foreign/.claude/agents/字資.md': FOREIGN_UNSLUGGABLE,
    '/foreign/.claude/skills/release-notes/SKILL.md': FOREIGN_SKILL,
    '/foreign/CLAUDE.md': PROJECT_RULES,
  }
}

// ── подставная fs (никакого диска) ──

const norm = (p: unknown) => String(p).replace(/\\/g, '/')

function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>()
  for (const [k, v] of Object.entries(seed)) files.set(norm(k), v)

  const enoent = (p: string) => {
    const e: any = new Error(`ENOENT: ${p}`)
    e.code = 'ENOENT'
    return e
  }

  return {
    files,
    existsSync(p: unknown) {
      const k = norm(p)
      if (files.has(k)) return true
      const prefix = `${k.replace(/\/+$/, '')}/`
      for (const key of files.keys()) if (key.startsWith(prefix)) return true
      return false
    },
    readFileSync(p: unknown) {
      const k = norm(p)
      if (!files.has(k)) throw enoent(k)
      return files.get(k) as string
    },
    readdirSync(p: unknown) {
      const d = `${norm(p).replace(/\/+$/, '')}/`
      const out = new Set<string>()
      let found = false
      for (const key of files.keys()) {
        if (!key.startsWith(d)) continue
        found = true
        out.add(key.slice(d.length).split('/')[0])
      }
      if (!found) throw enoent(d)
      return [...out]
    },
    writeFileSync(p: unknown, content: unknown) {
      files.set(norm(p), String(content))
    },
    appendFileSync(p: unknown, content: unknown) {
      const k = norm(p)
      files.set(k, `${files.get(k) ?? ''}${String(content)}`)
    },
    mkdirSync() {
      return undefined
    },
  }
}

/** fs, которая ломается на каждом вызове — проверка «скан не падает никогда». */
const hostileFs = {
  existsSync() {
    throw new Error('диск недоступен')
  },
  readFileSync() {
    throw new Error('диск недоступен')
  },
  readdirSync() {
    throw new Error('диск недоступен')
  },
}

/** Кандидат по слагу (или по имени — у 'unknown' слага может не быть). */
function pick(candidates: any[], key: string) {
  return candidates.find((c) => c.slug === key || c.name === key)
}

const MODULE_SRC = readFileSync(new URL('../src/front/import-scanner.mjs', import.meta.url), 'utf8')

// ═══════════════════════════════════════════════════════════════════════════════
describe('scanEstate — чужое хозяйство читается детерминированно', () => {
  it('находит валидного чужого агента: вид, слаг, имя, краткая суть, форма источника', () => {
    const fs = fakeFs(estate())
    const { candidates } = scanEstate({ repoDir: '/foreign', fsImpl: fs, registries: REGISTRIES, targetDir: '/host' })

    const agent = pick(candidates, 'twitter-parser')
    expect(agent).toBeDefined()
    expect(agent.kind).toBe('agent')
    expect(agent.name).toBe('twitter-parser')
    expect(agent.summary).toBe('Читает публичные твиты по теме и собирает сводку.')
    expect(agent.source).toBe('из файлов проекта')
    expect(agent.collision).toBeUndefined()
    // форма для экрана: путей к чужим файлам кандидат не выносит
    expect(JSON.stringify(agent)).not.toContain('/foreign')
  })

  it('находит валидный чужой навык по SKILL.md', () => {
    const fs = fakeFs(estate())
    const { candidates } = scanEstate({ repoDir: '/foreign', fsImpl: fs, registries: REGISTRIES, targetDir: '/host' })

    const skill = pick(candidates, 'release-notes')
    expect(skill).toBeDefined()
    expect(skill.kind).toBe('skill')
    expect(skill.summary).toContain('заметки к выпуску')
  })

  it('битый файл становится кандидатом unknown с причиной — скан не бросает', () => {
    const fs = fakeFs(estate())
    const { candidates } = scanEstate({ repoDir: '/foreign', fsImpl: fs, registries: REGISTRIES, targetDir: '/host' })

    const broken = pick(candidates, 'broken')
    expect(broken).toBeDefined()
    expect(broken.kind).toBe('unknown')
    expect(String(broken.reason)).toMatch(/заголов/i)
  })

  it('занятое имя даёт коллизию с предложением суффикса -imported', () => {
    const fs = fakeFs(estate())
    const { candidates } = scanEstate({ repoDir: '/foreign', fsImpl: fs, registries: REGISTRIES, targetDir: '/host' })

    const clash = pick(candidates, 'creator')
    expect(clash.kind).toBe('agent')
    expect(clash.collision).toBeDefined()
    expect(clash.collision.existingKind).toBe('worker')
    expect(clash.collision.suggestion).toBe('creator-imported')
  })

  it('файл на целевом пути — тоже коллизия (свой файл не перезаписывается)', () => {
    const fs = fakeFs({ ...estate(), '/host/.claude/agents/twitter-parser.md': 'наше определение' })
    const { candidates } = scanEstate({ repoDir: '/foreign', fsImpl: fs, registries: REGISTRIES, targetDir: '/host' })

    const agent = pick(candidates, 'twitter-parser')
    expect(agent.collision).toBeDefined()
    expect(agent.collision.existingKind).toBe('definition-file')
    expect(agent.collision.suggestion).toBe('twitter-parser-imported')
  })

  it('имя файла, не приводимое к слагу, → unknown (решает человек)', () => {
    const fs = fakeFs(estate())
    const { candidates } = scanEstate({ repoDir: '/foreign', fsImpl: fs, registries: REGISTRIES, targetDir: '/host' })

    const odd = candidates.find((c: any) => c.kind === 'unknown' && String(c.reason).match(/слаг/i))
    expect(odd).toBeDefined()
    expect(odd.slug).toBeNull()
  })

  it('правила проекта — информационная строка, не кандидат на автоперенос', () => {
    const fs = fakeFs(estate())
    const { candidates } = scanEstate({ repoDir: '/foreign', fsImpl: fs, registries: REGISTRIES, targetDir: '/host' })

    const rules = candidates.find((c: any) => c.kind === 'rules')
    expect(rules).toBeDefined()
    expect(rules.slug).toBeNull()
    expect(String(rules.reason)).toMatch(/вручную/i)
  })

  it('пустое хозяйство: ноль кандидатов и человеческая причина в notReady', () => {
    const fs = fakeFs({ '/empty/README.md': '# пусто' })
    const { candidates, notReady } = scanEstate({ repoDir: '/empty', fsImpl: fs, registries: REGISTRIES })

    expect(candidates).toEqual([])
    expect(notReady.length).toBe(1)
    expect(String(notReady[0].reason)).toMatch(/определени/i)
  })

  it('fs, которая бросает на каждом вызове, не роняет скан', () => {
    expect(() => scanEstate({ repoDir: '/x', fsImpl: hostileFs as any, registries: REGISTRIES })).not.toThrow()
    const out = scanEstate({ repoDir: '/x', fsImpl: hostileFs as any, registries: REGISTRIES })
    expect(out.candidates).toEqual([])
    expect(out.notReady.length).toBe(1)
  })

  it('неизвестный формат хозяйства — честный notReady, а не исключение', () => {
    const fs = fakeFs(estate())
    const out = scanEstate({ repoDir: '/foreign', fsImpl: fs, registries: REGISTRIES, format: 'нечто' })
    expect(out.candidates).toEqual([])
    expect(String(out.notReady[0].reason)).toMatch(/формат/i)
  })

  it('реестр парсеров заморожен и начинается с claude-code', () => {
    expect(Object.isFrozen(FORMAT_PARSERS)).toBe(true)
    expect(Object.keys(FORMAT_PARSERS)[0]).toBe('claude-code')
    expect(typeof (FORMAT_PARSERS as any)['claude-code']).toBe('function')
  })

  it('коллизии считаются и без реестров (пустой ростер — не повод падать)', () => {
    const fs = fakeFs(estate())
    const out = scanEstate({ repoDir: '/foreign', fsImpl: fs, targetDir: '/host' })
    expect(out.candidates.length).toBeGreaterThan(0)
    expect(pick(out.candidates, 'creator').collision).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('структура модуля — ноль модели, ноль запуска сессий', () => {
  it('в сканере нет обращений к модели и нет импортов из runner/', () => {
    expect(MODULE_SRC).not.toMatch(/from '\.\.\/runner\//)
    expect(MODULE_SRC).not.toMatch(/spawn/)
    expect(MODULE_SRC).not.toMatch(/buildClaudeArgs/)
    expect(MODULE_SRC).not.toMatch(/anthropic|openai/i)
  })

  it('разбор чужого текста — свой, без YAML-пакета и без eval', () => {
    expect(MODULE_SRC).not.toMatch(/require\(|eval\(|new Function/)
    expect(MODULE_SRC).not.toMatch(/from 'js-yaml'|from 'yaml'/)
  })
})
