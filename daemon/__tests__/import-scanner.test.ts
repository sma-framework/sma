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
 *
 * Покрыто (вторая половина — запись через дверь кузницы):
 *   - выбранный агент ложится черновиком РОВНО на путь кузницы, проходит её же lint
 *     и получает её же квитанцию; состояние — ожидание одобрения человеком;
 *   - навык ложится в .claude/skills/<слаг>/SKILL.md;
 *   - чужое определение, требующее себе запретных прав, ловится СУЩЕСТВУЮЩИМ потолком
 *     кузницы — второй проверки способностей у двери импорта нет;
 *   - коллизия без переименования → отказ ЭТОГО элемента, чужой файл байт-неизменен;
 *   - переименование принимается только для помеченного коллизией и перепроверяется;
 *   - красный lint не хоронит партию: остальные элементы едут дальше;
 *   - правила и неопознанное не энроллятся — «вручную»;
 *   - движок ничего не включает: пишутся только черновик и квитанция.
 *
 * Покрыто (третья часть — ДВЕРЬ С ФРОНТА, две ручки замороженной таблицы):
 *   - POST /api/import/scan ничего не пишет и повторяется без последствий;
 *   - тело обеих ручек — явная выборка: лишнее поле (и снаружи, и внутри элемента)
 *     отвергается ДО того, как движок вызван хоть раз;
 *   - партия ограничена потолком SELECTIONS_CAP;
 *   - отказ элемента (занятое имя без переименования) приезжает В ТЕЛЕ ответа, а не
 *     роняет партию пятисотым; переименование по предложению уезжает черновиком;
 *   - кадр import.updated несёт только batchId и count — ни имён, ни слагов.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

import { scanEstate, enrollSelections, FORMAT_PARSERS } from '../src/front/import-scanner.mjs'
import { createFrontServer } from '../src/front/server.mjs'

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

/** Чужое определение, требующее себе запретных прав — потолок кузницы обязан поймать. */
const FOREIGN_GREEDY = `---
name: deployer
description: Раскатывает изменения по кнопке, ни у кого не спрашивая.
tools: Bash, push to main, merge the release branch
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
    '/foreign/.claude/agents/deployer.md': FOREIGN_GREEDY,
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
describe('enrollSelections — выбранное становится черновиками за дверью кузницы', () => {
  /** Хозяйство чужое (/foreign), черновики ложатся в наш проект (/host). */
  function enroll(selections: any[], seed: Record<string, string> = {}) {
    const fs = fakeFs({ ...estate(), ...seed })
    const out = enrollSelections({
      selections,
      repoDir: '/foreign',
      targetDir: '/host',
      fsImpl: fs,
      registries: REGISTRIES,
      dataDir: '/data',
      taskId: 'import-1',
    })
    return { fs, out }
  }

  it('агент ложится ровно на путь кузницы, проходит её lint и получает квитанцию', () => {
    const { fs, out } = enroll([{ slug: 'twitter-parser', kind: 'agent' }])
    const res = out.results[0]

    expect(res.status).toBe('awaiting_approval')
    expect(res.path).toBe('.claude/agents/twitter-parser.md')
    expect(res.lint.ok).toBe(true)
    expect(res.lint.findings).toEqual([])
    expect(res.receiptRef).toMatch(/^forge:import-1:/)

    const written = fs.files.get('/host/.claude/agents/twitter-parser.md') as string
    expect(written).toBeDefined()
    expect(written).toMatch(/^---\n/)
    expect(written).toContain('lane: research')
    expect(written).toContain('ТРЕТЬЕСТОРОННИЙ')
    // черновик не включает себя: никакого поля активации
    expect(written).not.toMatch(/^enabled:/m)
    expect(written).not.toMatch(/^assigned:/m)
    // квитанция кузницы записана
    expect(fs.files.get('/data/receipts/forge.jsonl')).toContain('"passed":true')
  })

  it('навык ложится в .claude/skills/<слаг>/SKILL.md', () => {
    const { fs, out } = enroll([{ slug: 'release-notes', kind: 'skill' }])
    const res = out.results[0]

    expect(res.path).toBe('.claude/skills/release-notes/SKILL.md')
    expect(res.lint.ok).toBe(true)
    expect(fs.files.get('/host/.claude/skills/release-notes/SKILL.md')).toContain('use-when:')
  })

  it('чужое определение с запретным правом ловит СУЩЕСТВУЮЩИЙ потолок кузницы', () => {
    const { out } = enroll([{ slug: 'deployer', kind: 'agent' }])
    const res = out.results[0]

    expect(res.status).toBe('awaiting_approval') // черновик написан, человек увидит его diff'ом
    expect(res.lint.ok).toBe(false)
    expect(res.lint.findings.map((f: any) => f.name)).toContain('capability-ceiling')
  })

  it('коллизия без переименования: отказ элемента, чужой файл байт-неизменен', () => {
    const OURS = '---\nname: наше\n---\nне трогать\n'
    const { fs, out } = enroll([{ slug: 'twitter-parser', kind: 'agent' }], {
      '/host/.claude/agents/twitter-parser.md': OURS,
    })
    const res = out.results[0]

    expect(res.status).toBe('refused')
    expect(String(res.reason)).toMatch(/занят/i)
    expect(fs.files.get('/host/.claude/agents/twitter-parser.md')).toBe(OURS)
  })

  it('занятое ростером имя без переименования — тоже отказ', () => {
    const { out } = enroll([{ slug: 'creator', kind: 'agent' }])
    expect(out.results[0].status).toBe('refused')
    expect(String(out.results[0].reason)).toContain('creator-imported')
  })

  it('переименование по предложению принимается и уезжает под суффиксом', () => {
    const { fs, out } = enroll([{ slug: 'creator', kind: 'agent', overrideSlug: 'creator-imported' }])
    const res = out.results[0]

    expect(res.status).toBe('awaiting_approval')
    expect(res.slug).toBe('creator-imported')
    expect(res.path).toBe('.claude/agents/creator-imported.md')
    expect(res.renamedFrom).toBe('creator')
    expect(fs.files.has('/host/.claude/agents/creator-imported.md')).toBe(true)
  })

  it('переименование НЕ принимается для кандидата без коллизии', () => {
    const { fs, out } = enroll([{ slug: 'twitter-parser', kind: 'agent', overrideSlug: 'reviewer' }])
    expect(out.results[0].status).toBe('refused')
    expect(fs.files.has('/host/.claude/agents/reviewer.md')).toBe(false)
  })

  it('переименование перепроверяется: занятое новое имя тоже отказ', () => {
    const { fs, out } = enroll([{ slug: 'creator', kind: 'agent', overrideSlug: 'max-1' }])
    expect(out.results[0].status).toBe('refused')
    expect(fs.files.has('/host/.claude/agents/max-1.md')).toBe(false)
  })

  it('красный элемент не хоронит партию: остальные едут дальше', () => {
    const { out } = enroll([
      { slug: 'creator', kind: 'agent' }, // коллизия → отказ
      { slug: 'twitter-parser', kind: 'agent' }, // чистый → черновик
      { slug: 'deployer', kind: 'agent' }, // красный lint → черновик с находками
      { slug: 'release-notes', kind: 'skill' }, // чистый → черновик
    ])

    expect(out.results.length).toBe(4)
    expect(out.results.map((r: any) => r.status)).toEqual([
      'refused',
      'awaiting_approval',
      'awaiting_approval',
      'awaiting_approval',
    ])
    expect(out.results[1].lint.ok).toBe(true)
    expect(out.results[2].lint.ok).toBe(false)
  })

  it('правила и неопознанное не энроллятся — «вручную»', () => {
    const { out } = enroll([
      { kind: 'rules' },
      { slug: 'broken', kind: 'unknown' },
    ])
    expect(out.results.map((r: any) => r.status)).toEqual(['manual', 'manual'])
    expect(String(out.results[0].reason)).toMatch(/вручную/i)
  })

  it('несуществующий выбор — честный отказ, а не исключение', () => {
    const { out } = enroll([{ slug: 'нет-такого', kind: 'agent' }, {} as any])
    expect(out.results.map((r: any) => r.status)).toEqual(['refused', 'refused'])
  })

  it('движок ничего не включает: пишутся только черновик и квитанция', () => {
    const before = new Set(Object.keys(estate()))
    const { fs } = enroll([
      { slug: 'twitter-parser', kind: 'agent' },
      { slug: 'release-notes', kind: 'skill' },
    ])
    const added = [...fs.files.keys()].filter((k) => !before.has(k))

    expect(added.sort()).toEqual([
      '/data/receipts/forge.jsonl',
      '/host/.claude/agents/twitter-parser.md',
      '/host/.claude/skills/release-notes/SKILL.md',
    ])
    // ни конфига ростера, ни реестра инструментов
    expect(added.some((k) => /config\.json|mcp\.json/.test(k))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('структура модуля — ноль модели, ноль запуска сессий', () => {
  it('в сканере нет обращений к модели и нет импортов из слоя запуска', () => {
    expect(MODULE_SRC).not.toMatch(/from '\.\.\/runner\//)
    expect(MODULE_SRC).not.toMatch(/spawn/)
    expect(MODULE_SRC).not.toMatch(/buildClaudeArgs/)
    expect(MODULE_SRC).not.toMatch(/anthropic|openai/i)
  })

  it('разбор чужого текста — свой, без YAML-пакета и без eval', () => {
    expect(MODULE_SRC).not.toMatch(/require\(|eval\(|new Function/)
    expect(MODULE_SRC).not.toMatch(/from 'js-yaml'|from 'yaml'/)
  })

  it('дверь одна: lint и квитанция кузницы зовутся, своей проверки способностей нет', () => {
    expect(MODULE_SRC).toMatch(/lintDraft/)
    expect(MODULE_SRC).toMatch(/draftPathFor/)
    expect(MODULE_SRC).toMatch(/writeForgeReceipt/)
    expect(MODULE_SRC).not.toMatch(/FORBIDDEN/)
  })

  it('включения из движка нет ни одного', () => {
    expect(MODULE_SRC).not.toMatch(/Toggle/)
    expect(MODULE_SRC).not.toMatch(/apply(Agent|Skill|Mcp)/)
    expect(MODULE_SRC).not.toMatch(/handleApprove/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ДВЕРЬ С ФРОНТА: POST /api/import/scan и POST /api/import/enroll.
//
// Дверь не повторяет ни одного правила движка — она ограничивает ФОРМУ тела и зовёт
// сканер. Поэтому здесь проверяется ровно то, что принадлежит двери: явная выборка
// полей, потолок партии, поэлементные отказы в теле ответа и содержимое кадра.

const TOKEN = 'a'.repeat(64)

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
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
    end(c?: any) {
      if (c != null) res.body += String(c)
      return res
    },
  }
  return res
}

const jsonHeaders = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })

/**
 * Хозяйство САМОГО проекта, который обслуживает демон: чужие определения лежат ровно
 * там, куда лягут черновики. Именно так это выглядит в жизни — поэтому дверь считает
 * коллизии против своего же дерева, а имя файла, не приводимое к кебабу, уезжает
 * чисто (`Twitter Parser.md` → слаг `twitter-parser`, путь свободен).
 */
function ownEstate(): Record<string, string> {
  return {
    '/repo/.claude/agents/Twitter Parser.md': FOREIGN_AGENT,
    '/repo/.claude/agents/creator.md': FOREIGN_COLLIDING,
    '/repo/.claude/skills/Release Notes/SKILL.md': FOREIGN_SKILL,
    '/repo/CLAUDE.md': PROJECT_RULES,
  }
}

function door(seed: Record<string, string> = {}) {
  const fs = fakeFs({ ...ownEstate(), ...seed })
  const events: any[] = []
  const front = createFrontServer({
    config: { token: TOKEN, workers: [{ id: 'max-1' }, { id: 'creator' }] },
    deps: { repoDir: '/repo', dataDir: '/data', fsImpl: fs, hub: { emit: (e: any) => events.push(e) }, clock: () => 777 },
  })
  const call = async (method: string, url: string, body?: any) => {
    const res = mkRes()
    await front.handle(mkReq({ method, url, headers: jsonHeaders(), body }), res)
    return res
  }
  const snapshot = () => [...fs.files.keys()].sort()
  return { fs, events, call, snapshot }
}

describe('POST /api/import/scan — дверь читает хозяйство и НИЧЕГО не пишет', () => {
  it('отдаёт кандидатов с коллизиями; повторный скан безопасен и не меняет диск', async () => {
    const d = door()
    const before = d.snapshot()

    const first = await d.call('POST', '/api/import/scan', {})
    expect(first.statusCode).toBe(200)
    const out = JSON.parse(first.body)
    expect(out.format).toBe('claude-code')

    const clean = out.candidates.find((c: any) => c.slug === 'twitter-parser')
    expect(clean.kind).toBe('agent')
    expect(clean.collision).toBeUndefined()

    const clash = out.candidates.find((c: any) => c.slug === 'creator')
    expect(clash.collision.existingKind).toBe('worker')
    expect(clash.collision.suggestion).toBe('creator-imported')

    const again = await d.call('POST', '/api/import/scan', {})
    expect(again.statusCode).toBe(200)
    expect(again.body).toBe(first.body)
    expect(d.snapshot()).toEqual(before) // скан — чтение, и только чтение
    expect(d.events).toHaveLength(0) // читающая ручка не шлёт подсказок
  })

  it('лишнее поле в теле → 400, диск не тронут (тело скана пусто по контракту)', async () => {
    const d = door()
    const before = d.snapshot()
    const res = await d.call('POST', '/api/import/scan', { repoDir: '/etc', command: 'rm -rf /' })
    expect(res.statusCode).toBe(400)
    expect(d.snapshot()).toEqual(before)
  })
})

describe('POST /api/import/enroll — партия едет черновиками, отказы поэлементные', () => {
  it('занятое имя отказывается В ТЕЛЕ, остальные элементы едут дальше', async () => {
    const d = door()
    const res = await d.call('POST', '/api/import/enroll', {
      selections: [{ slug: 'creator', kind: 'agent' }, { slug: 'twitter-parser', kind: 'agent' }],
    })

    expect(res.statusCode).toBe(200) // отказ элемента — не пятисотая партии
    const { drafts } = JSON.parse(res.body)
    expect(drafts[0]).toMatchObject({ slug: 'creator', status: 'refused' })
    expect(String(drafts[0].reason)).toContain('creator-imported')
    expect(drafts[1]).toMatchObject({ slug: 'twitter-parser', status: 'awaiting_approval', path: '.claude/agents/twitter-parser.md' })
    expect(drafts[1].lint.ok).toBe(true)
    expect(drafts[1].receiptRef).toMatch(/^forge:/)

    // черновик действительно лёг, а занятый файл остался прежним
    expect(d.fs.files.get('/repo/.claude/agents/twitter-parser.md')).toContain('ТРЕТЬЕСТОРОННИЙ')
    expect(d.fs.files.get('/repo/.claude/agents/creator.md')).toBe(FOREIGN_COLLIDING)
  })

  it('кадр import.updated несёт ТОЛЬКО batchId и count — ни имён, ни слагов', async () => {
    const d = door()
    await d.call('POST', '/api/import/enroll', {
      selections: [{ slug: 'creator', kind: 'agent' }, { slug: 'twitter-parser', kind: 'agent' }],
    })

    expect(d.events).toHaveLength(1)
    const frame = d.events[0]
    expect(Object.keys(frame).sort()).toEqual(['batchId', 'count', 'event'])
    expect(frame.event).toBe('import.updated')
    expect(frame.count).toBe(1) // ровно столько черновиков легло
    expect(JSON.stringify(frame)).not.toMatch(/twitter|creator|parser/i)
  })

  it('переименование по предложению уезжает черновиком под суффиксом', async () => {
    const d = door()
    const res = await d.call('POST', '/api/import/enroll', {
      selections: [{ slug: 'creator', kind: 'agent', overrideSlug: 'creator-imported' }],
    })

    expect(res.statusCode).toBe(200)
    const { drafts } = JSON.parse(res.body)
    expect(drafts[0]).toMatchObject({ slug: 'creator-imported', status: 'awaiting_approval', renamedFrom: 'creator' })
    expect(d.fs.files.has('/repo/.claude/agents/creator-imported.md')).toBe(true)
  })

  it('партия сверх потолка → 400 и ни одной записи', async () => {
    const d = door()
    const before = d.snapshot()
    const selections = Array.from({ length: 51 }, () => ({ slug: 'twitter-parser', kind: 'agent' }))
    const res = await d.call('POST', '/api/import/enroll', { selections })
    expect(res.statusCode).toBe(400)
    expect(d.snapshot()).toEqual(before)
    expect(d.events).toHaveLength(0)
  })

  it('лишний ключ ВНУТРИ элемента → 400 до единого касания диска', async () => {
    const d = door()
    const before = d.snapshot()
    const res = await d.call('POST', '/api/import/enroll', {
      selections: [{ slug: 'twitter-parser', kind: 'agent', targetDir: '/etc' }],
    })
    expect(res.statusCode).toBe(400)
    expect(d.snapshot()).toEqual(before)
  })

  it('пустой и неправильной формы список — честная четырёхсотая', async () => {
    const d = door()
    expect((await d.call('POST', '/api/import/enroll', { selections: [] })).statusCode).toBe(400)
    expect((await d.call('POST', '/api/import/enroll', { selections: 'все' })).statusCode).toBe(400)
    expect((await d.call('POST', '/api/import/enroll', {})).statusCode).toBe(400)
  })
})
