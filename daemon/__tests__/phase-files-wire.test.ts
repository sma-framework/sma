/**
 * ПАПКА ФАЗЫ — ПРОВОД ОТ НАСТОЯЩЕГО КАТАЛОГА НА ДИСКЕ ДО ОТВЕТА ДВЕРИ.
 *
 * ЧЕМ ЭТОТ ФАЙЛ ОТЛИЧАЕТСЯ ОТ СОСЕДНИХ СЬЮТОВ ЭТОЙ ДВЕРИ. Двери фазы рядом проверяются на
 * ПОДДЕЛЬНОЙ файловой системе — и это правильно там, где предмет проверки — арифметика
 * проекции. Здесь предмет другой: ЗАМОК. Обход каталога, ссылка наружу, символ, который
 * разрешается не в то, что написано, — всё это свойства НАСТОЯЩЕЙ файловой системы, и шов,
 * который отвечает то, чего от него ждут, зелен ровно в тот день, когда правило знают
 * неправильно. Поэтому здесь настоящий временный каталог, настоящие файлы и настоящая ссылка.
 *
 * ЧТО УТВЕРЖДАЕТСЯ, И ЗАМОК УТВЕРЖДАЕТСЯ ПЕРВЫМ:
 *
 *   (1) ЧЕТЫРЕ СЦЕНЫ ОБХОДА КРАСНЫЕ — `../`, `..%2F` (тот же обход в процентной записи),
 *       абсолютный путь и ССЫЛКА НАРУЖУ. Все четыре получают ОДИН И ТОТ ЖЕ 400, и ни одна не
 *       отдаёт ни байта того, что лежит за пределами каталога фазы;
 *   (2) ДВЕРЬ ТОЛЬКО ЧИТАЕТ — методы записи на её адресе не существуют, а каталог после всех
 *       обращений байт в байт тот же;
 *   (3) дерево отдаёт то, что в каталоге ЕСТЬ: файлы, подкаталоги и вложенность — а ссылки в
 *       нём нет вовсе, потому что ссылка — не содержимое папки фазы;
 *   (4) файл отдаётся ТЕКСТОМ (`text/plain`, `nosniff`), двоичный файл и превышение потолка
 *       отказываются словами, а не обрезанной полуправдой.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFrontServer, ROUTES } from '../src/front/server.mjs'

const TOKEN = 'f'.repeat(64)

// ── настоящий временный мир ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
const mkDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
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

/**
 * Проект с одной фазой, у которой есть что показать: документы, подкаталог с документом,
 * двоичный файл и файл заведомо больше потолка. Рядом — ЧУЖОЙ каталог с секретом, ради
 * которого и стоит замок, и ссылка на него ИЗНУТРИ папки фазы.
 *
 * Ссылка создаётся тем видом, который на Windows не требует особых прав (`junction` на
 * каталог); если система всё равно отказала — случай не молчит, а говорит об этом, потому что
 * сцена, которая тихо не выполнилась, — это зелёный тест, ничего не проверивший.
 */
function project() {
  const root = mkDir('sma-phase-folder-')
  const phase = join(root, '.planning', 'phases', '12-front')
  mkdirSync(phase, { recursive: true })
  writeFileSync(join(phase, '12-CONTEXT.md'), '# контекст фазы\nвторая строка')
  writeFileSync(join(phase, '12-01-PLAN.md'), '# план 1')
  mkdirSync(join(phase, 'заметки'))
  writeFileSync(join(phase, 'заметки', 'разбор.md'), '# разбор')
  // двоичный: нулевой байт — то же правило, по которому двоичный файл узнаёт git
  writeFileSync(join(phase, 'снимок.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]))
  writeFileSync(join(phase, 'огромный.md'), 'я'.repeat(400_000)) // 800 КБ в UTF-8

  const outside = mkDir('sma-phase-outside-')
  writeFileSync(join(outside, 'секрет.txt'), 'ЭТО НЕ ДОЛЖНО УЕХАТЬ')

  let linked = false
  try {
    symlinkSync(outside, join(phase, 'наружу'), 'junction')
    linked = true
  } catch {
    linked = false
  }

  return { root, phase, outside, linked }
}

// ── поддельные req/res: настоящий здесь диск, а не сокет ───────────────────────────────────

function mkReq(url: string) {
  const req: any = Readable.from([])
  req.method = 'GET'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}` }
  req.socket = { remoteAddress: '10.0.0.9' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    writeHead(code: number, h?: any) {
      res.statusCode = code
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

/** Фронт БЕЗ файлового шва: дверь обязана работать с настоящей fs, иначе замок ничего не значит. */
function front(root: string) {
  return createFrontServer({ config: { token: TOKEN }, deps: { repoDir: root } })
}

async function call(f: any, url: string) {
  const res = mkRes()
  await f.handle(mkReq(url), res)
  return res
}

/** Слепок каталога: имена и содержимое, чтобы «только чтение» проверялось, а не заявлялось. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix === '' ? name.name : `${prefix}/${name.name}`
      // ссылка записывается ИМЕНЕМ: за ней лежит чужой каталог, и слепок папки фазы — не он
      if (name.isSymbolicLink()) out.push(`${rel}:ссылка`)
      else if (name.isDirectory()) walk(join(d, name.name), rel)
      else out.push(`${rel}:${readFileSync(join(d, name.name)).byteLength}`)
    }
  }
  walk(dir, '')
  return out.sort()
}

// ═════════════════════════ ЗАМОК — И ОН ПРОВЕРЯЕТСЯ ПЕРВЫМ ═════════════════════════

describe('GET /api/phase/:id/files — ЗАМОК: из каталога фазы выйти нельзя', () => {
  it('ЧЕТЫРЕ СЦЕНЫ ОБХОДА КРАСНЫЕ: `../`, `..%2F`, абсолютный путь и ссылка наружу', async () => {
    const p = project()
    const f = front(p.root)
    expect(p.linked, 'ссылку наружу создать не удалось — сцена ссылки не была бы проверена').toBe(true)

    const secret = join(p.outside, 'секрет.txt')
    const scenes: Array<[string, string]> = [
      ['../', '../../../.planning/phases/12-front/12-01-PLAN.md'],
      ['..%2F', '..%2F..%2F..%2Fpackage.json'],
      ['абсолютный путь', secret],
      ['ссылка наружу', 'наружу/секрет.txt'],
    ]

    for (const [name, file] of scenes) {
      // `..%2F` едет в адресе как есть: в этом и смысл сцены — обход, переживший декодирование
      const url = `/api/phase/12-front/files?file=${name === '..%2F' ? file : encodeURIComponent(file)}`
      const res = await call(f, url)
      expect(res.statusCode, name).toBe(400)
      expect(res.body, name).toBe('invalid path')
      expect(res.body, name).not.toContain('НЕ ДОЛЖНО УЕХАТЬ')
    }

    // и ещё две записи того же обхода, чтобы «через ссылку» не читалось как «только этой строкой»
    for (const file of ['наружу\\секрет.txt', './наружу/секрет.txt']) {
      const res = await call(f, `/api/phase/12-front/files?file=${encodeURIComponent(file)}`)
      expect(res.statusCode, file).toBe(400)
    }
  })

  it('ТОЛЬКО ЧТЕНИЕ: на адресе двери нет ни одного метода записи, и каталог не изменился', async () => {
    const p = project()
    const before = snapshot(p.phase)
    const f = front(p.root)

    await call(f, '/api/phase/12-front/files')
    await call(f, '/api/phase/12-front/files?file=12-01-PLAN.md')
    await call(f, '/api/phase/12-front/files?file=../секрет')

    expect(snapshot(p.phase)).toEqual(before)
    // таблица дверей знает ровно одну запись про папку фазы, и та — GET
    expect(Object.keys(ROUTES).filter((k) => k.endsWith('/files'))).toEqual(['GET /api/phase/:id/files'])
  })
})

// ═════════════════════════ ДЕРЕВО И ОДИН ФАЙЛ ТЕКСТОМ ═════════════════════════

describe('GET /api/phase/:id/files — дерево каталога и один файл текстом', () => {
  it('дерево отдаёт файлы и подкаталоги фазы — и НЕ отдаёт ссылку наружу', async () => {
    const p = project()
    const res = await call(front(p.root), '/api/phase/12-front/files')

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.phase).toBe('12-front')
    expect(body.root).toBe('.planning/phases/12-front')
    expect(body.truncated).toBe(false)

    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('12-CONTEXT.md')
    expect(names).toContain('заметки')
    // каталоги раньше файлов — так папку читает глаз, привыкший к редактору
    expect(names[0]).toBe('заметки')
    // ссылки в дереве нет вовсе: она не содержимое папки фазы
    expect(names).not.toContain('наружу')

    const sub = body.entries.find((e: any) => e.name === 'заметки')
    expect(sub.kind).toBe('dir')
    expect(sub.children.map((c: any) => c.path)).toEqual(['заметки/разбор.md'])

    const doc = body.entries.find((e: any) => e.name === '12-CONTEXT.md')
    expect(doc.kind).toBe('file')
    expect(doc.size).toBe(Buffer.byteLength('# контекст фазы\nвторая строка', 'utf8'))
    // содержимого в дереве нет: оглавление не читает файлы за человека
    expect(JSON.stringify(body)).not.toContain('контекст фазы\n')
  })

  it('файл отдаётся ТЕКСТОМ, включая файл из подкаталога — и путь берётся из самого дерева', async () => {
    const p = project()
    const f = front(p.root)
    const tree = JSON.parse((await call(f, '/api/phase/12-front/files')).body)
    const sub = tree.entries.find((e: any) => e.name === 'заметки')

    for (const path of ['12-CONTEXT.md', sub.children[0].path]) {
      const res = await call(f, `/api/phase/12-front/files?file=${encodeURIComponent(path)}`)
      expect(res.statusCode, path).toBe(200)
      expect(res.headers['content-type']).toMatch(/^text\/plain/)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toBe('no-store')
    }

    const doc = await call(f, '/api/phase/12-front/files?file=12-CONTEXT.md')
    expect(doc.body).toBe('# контекст фазы\nвторая строка')
  })

  it('двоичный файл и файл больше потолка отказываются СЛОВАМИ, а не половиной правды', async () => {
    const p = project()
    const f = front(p.root)

    const bin = await call(f, `/api/phase/12-front/files?file=${encodeURIComponent('снимок.png')}`)
    expect(bin.statusCode).toBe(400)
    expect(bin.body).toBe('not a text file')

    const big = await call(f, `/api/phase/12-front/files?file=${encodeURIComponent('огромный.md')}`)
    expect(big.statusCode).toBe(413)
    expect(big.body).toBe('payload too large')
  })

  it('каталог — не файл, отсутствующий файл — не отказ пути, чужая фаза — 404', async () => {
    const p = project()
    const f = front(p.root)

    expect((await call(f, `/api/phase/12-front/files?file=${encodeURIComponent('заметки')}`)).statusCode).toBe(400)
    expect((await call(f, `/api/phase/12-front/files?file=${encodeURIComponent('нет.md')}`)).statusCode).toBe(404)
    expect((await call(f, '/api/phase/99/files')).statusCode).toBe(404)
    // номер фазы и имя её каталога — один и тот же адрес: правило «какой каталог у фазы N» одно
    expect((await call(f, '/api/phase/12/files')).statusCode).toBe(200)
  })
})
