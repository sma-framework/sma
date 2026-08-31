/**
 * Ритуал слияния при конфликте: ИМЕНА ФАЙЛОВ И ЧИСЛО — и механическое, разведённое без человека.
 *
 * ДЕФЕКТ, РАДИ КОТОРОГО ЭТОТ ФАЙЛ ЕСТЬ. `runMerge` ловил любую беду одним общим catch и
 * отдавал наружу `{ok:false, message:'Command failed: git merge …'}`. Для приёмщика это
 * означало: конфликт есть, а какой — выясняй сам, руками, в чужой копии. Замерено 31.08.2026
 * на пяти приёмках подряд.
 *
 * ЧТО ЗАПЕРТО:
 *   1. конфликт называется списком файлов и их числом, и они стоят В НАЧАЛЕ `message` —
 *      строку обрезают по длине, и обрезаться должна проза git, а не состав конфликта;
 *   2. механическое разводится без человека, и ритуал ИДЁТ ДАЛЬШЕ: тесты гоняются по уже
 *      разведённому дереву, слияние фиксируется;
 *   3. разведённое названо в квитанции — молчаливый автоматический развод неотличим от
 *      слияния, где спора не было;
 *   4. осталось хоть что-то — слияние НЕ фиксируется, дерево откатывается, место отпущено;
 *   5. беда не про конфликт (грязное дерево, исчезнувшая ветка) отвечает ровно как раньше.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runMerge, checkMergeClaim } from '../lib/merge-gate.mjs'

const NUL = String.fromCharCode(0)

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-merge-conflict-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Подделка git: пишет вызовы, отвечает по сценарию. */
function fakeGit(script: Record<string, any> = {}) {
  const calls: string[][] = []
  const git = (args: string[]) => {
    calls.push([...args])
    for (const [key, value] of Object.entries(script)) {
      if (args.join(' ').includes(key)) {
        if (value instanceof Error) throw value
        if (typeof value === 'function') return value(args)
        return value
      }
    }
    return ''
  }
  return { git, calls }
}

const CONFLICT = new Error('Command failed: git merge --no-ff --no-commit wt/T-1')
const UNION_FILE = ['<<<<<<< HEAD', 'абзац main', '||||||| base', '=======', 'абзац ветки', '>>>>>>> wt/T-1'].join('\n')

const io = { readFileSync: () => UNION_FILE, writeFileSync: () => {} }

describe('runMerge — конфликт называется по именам', () => {
  it('неразведённое: имена и число едут наружу, слияние не фиксируется, место отпущено', async () => {
    const { git, calls } = fakeGit({
      'merge --no-ff --no-commit': CONFLICT,
      'diff --name-only': `daemon/src/loop.mjs${NUL}README.md${NUL}`,
    })
    const res: any = await runMerge({
      branch: 'wt/T-1',
      by: 'test',
      execGit: git,
      runTests: () => ({ passed: true }),
      claimsDir: tmp,
      journalDir: tmp,
      cwd: tmp,
      io,
    })
    expect(res.ok).toBe(false)
    expect(res.conflict).toBe(true)
    expect(res.conflictFiles).toEqual(['daemon/src/loop.mjs'])
    expect(res.conflictCount).toBe(1)
    // README развёлся сам — и это СКАЗАНО, а не умолчано
    expect(res.conflictResolved).toEqual([{ file: 'README.md', how: 'union' }])
    // состав конфликта стоит впереди прозы git
    expect(res.message.startsWith('конфликт в 1 файл(ах): daemon/src/loop.mjs')).toBe(true)
    expect(calls.some((c) => c[0] === 'commit')).toBe(false)
    expect(calls.some((c) => c[0] === 'merge' && c.includes('--abort'))).toBe(true)
    expect(checkMergeClaim({ claimsDir: tmp }).live).toBe(false)
  })

  it('всё механическое: ритуал идёт дальше — тесты по разведённому дереву, слияние зафиксировано', async () => {
    const { git, calls } = fakeGit({
      'merge --no-ff --no-commit': CONFLICT,
      'diff --name-only': `README.md${NUL}`,
      'rev-parse -q --verify MERGE_HEAD': 'abc\n',
      'rev-parse HEAD': 'cafebabe\n',
    })
    let ranOn: any = null
    const res: any = await runMerge({
      branch: 'wt/T-1',
      by: 'test',
      execGit: git,
      runTests: (ctx: any) => {
        ranOn = ctx
        return { passed: true }
      },
      claimsDir: tmp,
      journalDir: tmp,
      cwd: tmp,
      io,
    })
    expect(res.merged).toBe(true)
    expect(res.testsPassed).toBe(true)
    expect(ranOn).toMatchObject({ branch: 'wt/T-1', resultSha: null })
    expect(res.mechanicallyResolved).toEqual([{ file: 'README.md', how: 'union' }])
    expect(res.receipt.mechanicallyResolved).toEqual([{ file: 'README.md', how: 'union' }])
    expect(calls.some((c) => c[0] === 'commit')).toBe(true)
    expect(calls.some((c) => c.join(' ').includes('push'))).toBe(false)
  })

  it('красный прогон на разведённом дереве по-прежнему отказывает — гейт не ослаблен', async () => {
    const { git, calls } = fakeGit({
      'merge --no-ff --no-commit': CONFLICT,
      'diff --name-only': `README.md${NUL}`,
      'rev-parse -q --verify MERGE_HEAD': 'abc\n',
    })
    const res: any = await runMerge({
      branch: 'wt/T-1',
      by: 'test',
      execGit: git,
      runTests: () => ({ passed: false }),
      claimsDir: tmp,
      journalDir: tmp,
      cwd: tmp,
      io,
    })
    expect(res.merged).toBe(false)
    expect(res.refused).toBe(true)
    expect(calls.some((c) => c[0] === 'commit')).toBe(false)
  })

  it('беда НЕ про конфликт отвечает как прежде — без выдуманного списка файлов', async () => {
    const { git } = fakeGit({
      'merge --no-ff --no-commit': new Error('error: Your local changes would be overwritten'),
      'diff --name-only': '',
    })
    const res: any = await runMerge({
      branch: 'wt/T-1',
      by: 'test',
      execGit: git,
      runTests: () => ({ passed: true }),
      claimsDir: tmp,
      journalDir: tmp,
      cwd: tmp,
    })
    expect(res.ok).toBe(false)
    expect(res.conflict).toBeUndefined()
    expect(res.conflictFiles).toBeUndefined()
    expect(res.message).toContain('local changes would be overwritten')
  })
})
