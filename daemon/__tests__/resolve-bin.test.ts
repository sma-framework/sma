/**
 * Tests for daemon/src/runner/resolve-bin.mjs — HOW a named worker CLI is started here.
 *
 * WHY THIS MODULE EARNED A SUITE. The Codex lane was fixed end to end — the per-task home
 * created, seeded and authenticated, the sandbox on the command line, the CLI accepting every
 * argument handed to it — and it still could not run a single task, because `spawn codex`
 * answered ENOENT. On Windows an npm-installed CLI is a `.cmd` SHIM rather than a program:
 * `CreateProcess` will not run a batch file and Node refuses to spawn one without a shell
 * (CVE-2024-27980), which is exactly what the safe-child contract forbids. The Claude lane
 * worked throughout for one accidental reason — it ships as a real `.exe`. A lane correct in
 * every part and unable to start is, from the screen, a lane that was never built.
 *
 * WHAT IS ASSERTED, and it is the pair of rules rather than a happy path:
 *   - the translation is an ARGUMENT VECTOR, never a shell: node, plus the script the shim
 *     names, and the CLI's own arguments unchanged behind it;
 *   - the module SPEAKS ONLY WHEN THE BARE NAME WOULD FAIL — a directly executable hit, every
 *     non-Windows platform, and every shape it does not recognise are returned untouched, so
 *     nothing that works today starts differently because this module exists.
 *
 * Every case builds a REAL shim on disk under the OS temp directory and drives the resolver
 * with an injected PATH: the assertions are about files, not about a mock agreeing with itself.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { resolveWorkerBin, EXECUTABLE_EXTENSIONS, SHIM_EXTENSIONS } from '../src/runner/resolve-bin.mjs'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'

/** npm's own cmd-shim template, trimmed to the line that matters and kept verbatim in shape. */
const npmShim = (relativeScript: string) =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeScript}" %*`,
  ].join('\r\n')

/** A PATH directory holding one installed CLI, in whichever shape the case is about. */
function installDir(opts: { name: string; shape: 'exe' | 'shim' | 'foreign-shim' | 'dangling-shim'; script?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'sma-resolve-bin-'))
  const { name, shape } = opts
  const script = opts.script ?? 'node_modules\\@vendor\\cli\\bin\\cli.js'

  if (shape === 'exe') {
    writeFileSync(join(dir, `${name}.exe`), 'MZ')
    return { dir, script: null as string | null }
  }

  // The FOREIGN shim quotes a real script path and simply never mentions node — so the case
  // below isolates the «must name node» rule rather than passing because nothing matched.
  writeFileSync(
    join(dir, `${name}.cmd`),
    shape === 'foreign-shim' ? `@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\${script}" %*` : npmShim(script),
  )
  if (shape === 'shim' || shape === 'foreign-shim') {
    const segments = script.split('\\')
    mkdirSync(join(dir, ...segments.slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, ...segments), '// the entry point the shim hands to node')
  }
  return { dir, script: shape === 'shim' ? join(dir, ...script.split('\\')) : null }
}

const win = (over: Record<string, unknown> = {}) => ({
  platform: 'win32',
  execPath: NODE,
  ...over,
})

describe('resolveWorkerBin — the npm shim a shell-less spawn cannot start', () => {
  it('translates a .cmd shim into node plus the script it names — an argument vector, never a shell', () => {
    const { dir, script } = installDir({ name: 'codex', shape: 'shim' })
    const out = resolveWorkerBin(win({ name: 'codex', env: { PATH: dir } }))

    expect(out.how).toBe('node-shim')
    expect(out.bin).toBe(NODE)
    expect(out.prefixArgs).toEqual([script])
    // both files are NAMED, so the choice is readable in a spawn record rather than mysterious
    expect(out.shim).toBe(join(dir, 'codex.cmd'))
    expect(out.script).toBe(script)
  })

  it('the CLI\'s own arguments are untouched — the prefix goes in FRONT of them', () => {
    const { dir, script } = installDir({ name: 'codex', shape: 'shim' })
    const out = resolveWorkerBin(win({ name: 'codex', env: { PATH: dir } }))
    const cliArgs = ['exec', '--json', '--strict-config', '--sandbox', 'read-only', '-']

    expect([...out.prefixArgs, ...cliArgs]).toEqual([script, ...cliArgs])
  })

  /**
   * ГОВОРИТ, ТОЛЬКО КОГДА ГОЛОЕ ИМЯ НЕ ЗАРАБОТАЛО БЫ. Полоса claude работает сегодня ровно
   * потому, что её CLI — настоящий .exe; переписывать командную строку, которая и так
   * стартует, значит купить ноль и рискнуть разрешиться в другой файл, чем разрешился бы сам
   * запуск. Поэтому исполняемое попадание возвращает имя нетронутым.
   */
  it('a directly executable hit is returned untouched', () => {
    const { dir } = installDir({ name: 'claude', shape: 'exe' })
    const out = resolveWorkerBin(win({ name: 'claude', env: { PATH: dir } }))

    expect(out).toEqual({ bin: 'claude', prefixArgs: [], how: 'as-named' })
  })

  it('an executable earlier on PATH wins over a shim later on it, exactly as the system would search', () => {
    const exe = installDir({ name: 'codex', shape: 'exe' })
    const shim = installDir({ name: 'codex', shape: 'shim' })
    const out = resolveWorkerBin(win({ name: 'codex', env: { PATH: `${exe.dir};${shim.dir}` } }))

    expect(out.how).toBe('as-named')
    expect(out.prefixArgs).toEqual([])
  })

  it('every non-Windows platform is returned untouched, with no filesystem call at all', () => {
    const fsImpl = {
      existsSync: () => {
        throw new Error('the resolver must not touch a disk on this platform')
      },
      readFileSync: () => {
        throw new Error('the resolver must not touch a disk on this platform')
      },
    }
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      expect(resolveWorkerBin({ name: 'codex', platform, env: { PATH: '/usr/bin' }, fsImpl })).toEqual({
        bin: 'codex',
        prefixArgs: [],
        how: 'as-named',
      })
    }
  })

  /**
   * ЧЕГО ОН НЕ УГАДЫВАЕТ. Пакетный файл, не называющий node, — это обёртка, теории о которой у
   * этого модуля нет; придуманный для неё интерпретатор был бы хуже той самой ENOENT, которую
   * он заменяет. Так же и путь, который шим называет, а на диске его нет.
   */
  it('a .cmd that does not run node is left alone — an invented interpreter is worse than ENOENT', () => {
    // The file quotes a script path that IS on the disk, and that path contains «node_modules»
    // as every npm layout does. Only naming node as a PROGRAM counts: a bare substring search
    // would have handed practically every batch file on the machine to node on that evidence.
    const { dir } = installDir({ name: 'codex', shape: 'foreign-shim' })
    expect(resolveWorkerBin(win({ name: 'codex', env: { PATH: dir } })).how).toBe('as-named')
  })

  it('a shim naming a script that is not on the disk is left alone', () => {
    const { dir } = installDir({ name: 'codex', shape: 'dangling-shim' })
    expect(resolveWorkerBin(win({ name: 'codex', env: { PATH: dir } })).how).toBe('as-named')
  })

  it('nothing on PATH at all → the bare name, so the spawn produces its own honest ENOENT', () => {
    expect(resolveWorkerBin(win({ name: 'codex', env: { PATH: '' } })).how).toBe('as-named')
    expect(resolveWorkerBin(win({ name: 'codex', env: {} })).how).toBe('as-named')
    expect(resolveWorkerBin(win({ name: '', env: {} })).bin).toBe('')
  })

  it('an explicit .cmd path an operator wrote is translated too; any other path is left alone', () => {
    const { dir, script } = installDir({ name: 'codex', shape: 'shim' })
    const byPath = resolveWorkerBin(win({ name: join(dir, 'codex.cmd'), env: {} }))
    expect(byPath.how).toBe('node-shim')
    expect(byPath.prefixArgs).toEqual([script])

    const exe = join(dir, 'codex.exe')
    expect(resolveWorkerBin(win({ name: exe, env: {} }))).toEqual({ bin: exe, prefixArgs: [], how: 'as-named' })
  })

  it('a quoted PATH entry and a repeated one do not change the answer', () => {
    const { dir, script } = installDir({ name: 'codex', shape: 'shim' })
    const out = resolveWorkerBin(win({ name: 'codex', env: { PATH: `"${dir}";${dir};` } }))
    expect(out.prefixArgs).toEqual([script])
  })

  it('an unreadable candidate is an absent one, never a crash on the way to a spawn', () => {
    const { dir } = installDir({ name: 'codex', shape: 'shim' })
    const out = resolveWorkerBin(
      win({
        name: 'codex',
        env: { PATH: dir },
        fsImpl: {
          existsSync: () => {
            throw new Error('EACCES')
          },
        },
      }),
    )
    expect(out.how).toBe('as-named')
  })

  it('the two extension families are stated once and are what the resolver searches', () => {
    expect(EXECUTABLE_EXTENSIONS).toEqual(['.exe', '.com'])
    expect(SHIM_EXTENSIONS).toEqual(['.cmd', '.bat'])
  })
})
