/**
 * Tests for scripts/sma/lib/fts-index.mjs — the LEXICAL layer of retrieval, in canon
 * order: an exact path/symbol match first, a derived SQLite index second, and never a
 * word of it assumed to exist on the machine it runs on.
 *
 * THE PROPERTY THESE TESTS DEFEND: «it works on the author's laptop» is not a feature.
 * The SQLite module ships only with newer Node, and the official Node build compiles
 * SQLite WITHOUT the full-text extension (nodejs/node#56951) — so both absences are
 * simulated here with doubles rather than waited for on some adopter's machine, where
 * the failure would be silent and remote.
 *
 *   - Test 1 (exact layer): a note is found by the exact file path it declares and by
 *     the exact symbol its claim names — deterministic, and case-insensitive for paths.
 *   - Test 2 (probe): the capability probe answers true on an engine that accepts a
 *     virtual table and false on one that refuses, closing the handle either way.
 *   - Test 3 (module absent): with no SQLite module at all the layer reports itself
 *     unavailable and returns — a missing capability is not an exception, and the
 *     deterministic facet/exact layers keep working underneath it.
 *   - Test 4 (one read path): the exact layer sees the corpus through the shared
 *     projection with read-time visibility applied — a withheld record is not findable
 *     even by an exact match, which is the whole point of filtering before ranking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeFts5, lexicalCapability, queryExact, buildLexicalIndex, queryLexical, indexStatus, LEXICAL_ENGINES } from '../lib/fts-index.mjs'

const EMDASH = String.fromCharCode(0x2014)

const TAGS = `## area\n- crm ${EMDASH} customer relationship\n- auth ${EMDASH} authentication\n\n## kind\n- reference ${EMDASH} a fact\n`

/** The instant every test reads the corpus at — a measurement must not depend on today. */
const NOW = '2026-08-03T00:00:00Z'

let dir: string
let corpusDir: string

function writeNote(file: string, fields: Record<string, string>) {
  const fm = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', 'body text']
  writeFileSync(join(corpusDir, file), fm.join('\n') + '\n', 'utf8')
}

/** A SQLite double that ACCEPTS a virtual table — «this build has full text». */
class Fts5Engine {
  closed = false
  constructor(_path: string) {}
  exec(_sql: string) {}
  close() {
    this.closed = true
  }
}

/** A SQLite double that REFUSES a virtual table — the default official build. */
class NoFts5Engine {
  closed = false
  constructor(_path: string) {}
  exec(sql: string) {
    if (/VIRTUAL TABLE/i.test(sql)) throw new Error('no such module: fts5')
  }
  close() {
    this.closed = true
  }
}

/** A loader that fails the way `require('node:sqlite')` fails on older Node. */
function noModule() {
  throw new Error("Cannot find module 'node:sqlite'")
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-fts-index-'))
  corpusDir = join(dir, 'memory')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'TAGS.md'), TAGS, 'utf8')
  writeFileSync(join(corpusDir, 'MEMORY.md'), '# index\n- a core line\n', 'utf8')

  writeNote('loader-rule.md', {
    description: 'resolvePeriphery keeps one read path for the corpus',
    kind: 'reference',
    tags: '[crm]',
    importance: '5',
    'use-when-pattern': 'scripts/sma/lib/loader.mjs',
  })
  writeNote('pack-rule.md', {
    description: 'compilePack cuts the pack on a strict prefix budget',
    kind: 'reference',
    tags: '[crm]',
    importance: '5',
    'use-when-pattern': 'scripts/sma/lib/context-pack.mjs',
  })
  writeNote('auth-note.md', {
    description: 'tokens are rotated on every refresh',
    kind: 'reference',
    tags: '[auth]',
    importance: '3',
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the exact path/symbol layer', () => {
  it('finds a note by the exact path it declares, case-insensitively', () => {
    const hit = queryExact({ query: 'why does SCRIPTS/SMA/LIB/LOADER.MJS drop a record', corpusDir, now: NOW })

    expect(hit.results.map((r: any) => r.id)).toEqual(['loader-rule.md'])
    expect(hit.results[0].basis).toBe('path')
    expect(hit.results[0].matched).toBe('scripts/sma/lib/loader.mjs')
  })

  it('finds a note by the exact symbol its claim names, and not by an ordinary word', () => {
    const symbol = queryExact({ query: 'who calls compilePack here', corpusDir, now: NOW })
    expect(symbol.results.map((r: any) => r.id)).toEqual(['pack-rule.md'])
    expect(symbol.results[0].basis).toBe('symbol')

    // «the corpus» is a word every note could answer to — an exact layer that matched
    // it would be a bad lexical layer wearing an exact layer's name.
    const prose = queryExact({ query: 'the corpus keeps a record', corpusDir, now: NOW })
    expect(prose.results).toEqual([])
  })

  it('is deterministic: the same query over the same corpus returns the same order', () => {
    const q = 'resolvePeriphery and compilePack in scripts/sma/lib/loader.mjs'
    const a = queryExact({ query: q, corpusDir, now: NOW })
    const b = queryExact({ query: q, corpusDir, now: NOW })
    expect(JSON.stringify(a.results)).toBe(JSON.stringify(b.results))
    expect(a.results.length).toBeGreaterThan(1)
  })
})

describe('the capability probe', () => {
  it('answers true on an engine that accepts a virtual table, and closes it', () => {
    let opened: Fts5Engine | null = null
    const Factory: any = function (path: string) {
      opened = new Fts5Engine(path)
      return opened
    }
    expect(probeFts5(Factory)).toBe(true)
    expect((opened as any).closed).toBe(true)
  })

  it('answers false when the build refuses a virtual table, and still closes it', () => {
    let opened: NoFts5Engine | null = null
    const Factory: any = function (path: string) {
      opened = new NoFts5Engine(path)
      return opened
    }
    expect(probeFts5(Factory)).toBe(false)
    expect((opened as any).closed).toBe(true)
  })

  it('answers a boolean on the real engine of this machine, whatever it is', () => {
    const cap = lexicalCapability()
    expect(typeof cap.module).toBe('boolean')
    expect(typeof cap.fts5).toBe('boolean')
    // the engine name is one of the three the layer knows, never a guess
    expect(Object.values(LEXICAL_ENGINES)).toContain(cap.engine)
  })
})

describe('when the SQLite module is not there at all', () => {
  it('reports itself unavailable instead of throwing', () => {
    const cap = lexicalCapability({ loadSqlite: noModule })
    expect(cap.module).toBe(false)
    expect(cap.fts5).toBe(false)
    expect(cap.engine).toBe(LEXICAL_ENGINES.UNAVAILABLE)
    expect(String(cap.reason)).not.toBe('')
  })

  it('lets every entry point return an honest unavailable answer', () => {
    const dbPath = join(dir, 'index', 'memory-lexical.sqlite')
    const built = buildLexicalIndex({ corpusDir, dbPath, now: NOW, loadSqlite: noModule })
    expect(built.engine).toBe(LEXICAL_ENGINES.UNAVAILABLE)
    expect(built.indexed).toBe(0)

    const found = queryLexical({ query: 'compilePack', dbPath, loadSqlite: noModule })
    expect(found.engine).toBe(LEXICAL_ENGINES.UNAVAILABLE)
    expect(found.results).toEqual([])

    const status = indexStatus({ corpusDir, dbPath, now: NOW, loadSqlite: noModule })
    expect(status.engine).toBe(LEXICAL_ENGINES.UNAVAILABLE)
    expect(status.summary.engine_available).toBe(0)

    // and the deterministic layer underneath is untouched by any of it
    expect(queryExact({ query: 'scripts/sma/lib/loader.mjs', corpusDir, now: NOW }).results.length).toBe(1)
  })
})

describe('one read path', () => {
  it('cannot find a withheld record even by an exact match', () => {
    writeNote('retired-loader-rule.md', {
      description: 'resolvePeriphery used to keep two read paths',
      kind: 'reference',
      tags: '[crm]',
      importance: '9',
      status: 'superseded',
      'use-when-pattern': 'scripts/sma/lib/loader.mjs',
    })
    writeNote('expired-loader-rule.md', {
      description: 'resolvePeriphery was measured once',
      kind: 'reference',
      tags: '[crm]',
      importance: '9',
      valid_until: '2026-01-01',
      'use-when-pattern': 'scripts/sma/lib/loader.mjs',
    })

    const hit = queryExact({ query: 'scripts/sma/lib/loader.mjs', corpusDir, now: NOW })
    expect(hit.results.map((r: any) => r.id)).toEqual(['loader-rule.md'])
    expect(hit.summary.visible_notes).toBe(3)
    expect(hit.summary.corpus_notes).toBe(5)
  })

  it('applies the same visibility to notes handed in directly', () => {
    const notes = [
      { file: 'a.md', description: 'resolvePeriphery is here', pathPattern: 'scripts/sma/lib/loader.mjs', status: '', tags: ['crm'], weight: 5 },
      { file: 'b.md', description: 'resolvePeriphery was here', pathPattern: 'scripts/sma/lib/loader.mjs', status: 'revoked', tags: ['crm'], weight: 5 },
    ]
    const hit = queryExact({ query: 'scripts/sma/lib/loader.mjs', notes, now: NOW })
    expect(hit.results.map((r: any) => r.id)).toEqual(['a.md'])
  })
})
