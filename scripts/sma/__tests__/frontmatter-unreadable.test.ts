/**
 * РАЗБОР ЗАГОЛОВКА ПЕРЕЖИВАЕТ НЕЧИТАЕМОЕ СОДЕРЖИМОЕ — И НАЗЫВАЕТ ФАЙЛ.
 *
 * Что было. `parseMustHavesBlock` и `extractFrontmatter` начинались с `content.match(...)` и
 * `content.startsWith(...)`, то есть с допущения, что вызывающий уже доказал читаемость файла.
 * Вызывающий, который этого не сделал (путь, который никуда не разрешился; чтение, вернувшее
 * null), превращал РАЗБОР в `TypeError: content.match is not a function` — и TypeError убивал
 * КОМАНДУ, а не разбор. Замерено 01.09.2026: попытка, отработавшая 77 минут и положившая три
 * коммита, была выброшена, потому что упал инструмент, которым её закрывали; стек назвал файл
 * `frontmatter.cjs` и ни одного документа.
 *
 * Что проверяется здесь — ПОВЕДЕНИЕ ПРОДУКТА, а не наличие этих строк:
 *   1. оба читателя переживают null / undefined / не-строку и отвечают ПУСТО, а не броском;
 *   2. предупреждение НАЗЫВАЕТ файл-виновник, когда вызывающий его назвал, и честно говорит,
 *      что файла не назвали, когда не назвал;
 *   3. пустая строка — не поломка и слова не стоит: у нулевого документа заголовка и правда нет;
 *   4. настоящий документ разбирается ровно как прежде — глушитель не проглотил работу.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const frontmatter = require_('../../../sma-core/bin/lib/frontmatter.cjs')
const { extractFrontmatter, parseMustHavesBlock } = frontmatter

/** Один вызов под перехваченным stderr: что вернули и что при этом сказали человеку. */
function underStderr<T>(run: () => T): { value: T; said: string } {
  const said: string[] = []
  const original = process.stderr.write
  // @ts-expect-error — подменяем ровно на время вызова, восстанавливаем ниже и в afterEach
  process.stderr.write = (chunk: any) => (said.push(String(chunk)), true)
  try {
    return { value: run(), said: said.join('') }
  } finally {
    process.stderr.write = original
  }
}

const originalWrite = process.stderr.write
afterEach(() => {
  process.stderr.write = originalWrite
})

const PLAN = [
  '---',
  'phase: 21',
  'must_haves:',
  '  artifacts:',
  '    - path: docs/THING.md',
  '      provides: the thing',
  '---',
  '',
  '# body',
  '',
].join('\n')

describe('frontmatter: нечитаемое содержимое не убивает команду', () => {
  for (const [name, value] of [
    ['null', null],
    ['undefined', undefined],
    ['число', 42],
    ['объект', { path: 'x' }],
  ] as [string, unknown][]) {
    it(`parseMustHavesBlock переживает ${name} и отвечает пустым списком`, () => {
      const { value: out, said } = underStderr(() => parseMustHavesBlock(value, 'artifacts', '/plans/21-PLAN.md'))
      expect(out).toEqual([])
      expect(said).toContain('/plans/21-PLAN.md')
    })

    it(`extractFrontmatter переживает ${name} и отвечает пустым объектом`, () => {
      const { value: out, said } = underStderr(() => extractFrontmatter(value, '/plans/21-PLAN.md'))
      expect(out).toEqual({})
      expect(said).toContain('/plans/21-PLAN.md')
    })
  }

  it('вызывающий, не назвавший файла, получает предупреждение, которое об этом ГОВОРИТ', () => {
    const { said } = underStderr(() => parseMustHavesBlock(null, 'artifacts'))
    expect(said).toMatch(/parseMustHavesBlock\(artifacts\)/)
    expect(said).toMatch(/caller named no file/)
  })

  it('пустая строка — не поломка: пусто в ответе и НИ СЛОВА в stderr', () => {
    const a = underStderr(() => parseMustHavesBlock('', 'artifacts', '/plans/21-PLAN.md'))
    const b = underStderr(() => extractFrontmatter('', '/plans/21-PLAN.md'))
    expect(a.value).toEqual([])
    expect(b.value).toEqual({})
    expect(a.said).toBe('')
    expect(b.said).toBe('')
  })

  it('настоящий документ разбирается как прежде — глушитель ничего не проглотил', () => {
    const { value: items, said } = underStderr(() => parseMustHavesBlock(PLAN, 'artifacts', '/plans/21-PLAN.md'))
    expect(items).toEqual([{ path: 'docs/THING.md', provides: 'the thing' }])
    expect(said).toBe('')
    expect(extractFrontmatter(PLAN, '/plans/21-PLAN.md').phase).toBe('21')
  })

  it('третий аргумент необязателен: старые вызовы на настоящем документе работают без него', () => {
    expect(parseMustHavesBlock(PLAN, 'artifacts')).toEqual([{ path: 'docs/THING.md', provides: 'the thing' }])
    expect(extractFrontmatter(PLAN).phase).toBe('21')
  })
})
