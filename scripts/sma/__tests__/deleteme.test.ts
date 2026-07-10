/**
 * Tests for scripts/sma/lib/deleteme.mjs (49.4 BL-162, v3.6 — the one-click off-ramp).
 *
 * The load-bearing behaviors:
 *   Test 1 — cutBlock: whole-line span removal; zero anchors no-op; torn/duplicate pair REFUSED
 *   Test 2 — stripManagedBlocks: both families (SMA:EXPORT + SMA:RULES) cut; corrupt reported
 *   Test 3 — removeSmaHooks: the exact inverse of mergeHooks — foreign siblings survive
 *   Test 4 — restoreStatusline: the wrapped-command.json contract (hadNone / original / ours / foreign)
 *   Test 5 — applyDeleteme (fake io): right actions planned, unparseable settings refused,
 *            the memory corpus NEVER appears as a target
 *   Test 6 — deletemeSelftest: the full fixture round-trip on a real temp dir prints 1
 *
 * DI everywhere — Test 5 injects a fake io; only Test 6 touches a real (temp) fs.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import {
  BLOCK_ANCHORS,
  cutBlock,
  stripManagedBlocks,
  isSmaHookCommand,
  removeSmaHooks,
  isSmaStatuslineCmd,
  restoreStatusline,
  applyDeleteme,
  deletemeSelftest,
} from '../lib/deleteme.mjs'

const MD_EXPORT = BLOCK_ANCHORS.find((a) => a.token === 'SMA:EXPORT' && a.style === 'md')!

describe('deleteme — cutBlock (Test 1)', () => {
  it('removes exactly the BEGIN..END span and collapses the seam to one blank line', () => {
    const text = ['user head', '', '<!-- SMA:EXPORT:BEGIN v1 fmt=CLAUDE.md -->', 'body', '<!-- SMA:EXPORT:END -->', '', 'user tail'].join('\n')
    const res = cutBlock(text, MD_EXPORT)
    expect(res.action).toBe('removed')
    expect(res.text).toBe(['user head', '', 'user tail'].join('\n'))
  })

  it('is a no-op on text with no anchors', () => {
    const res = cutBlock('plain text\nno anchors', MD_EXPORT)
    expect(res.action).toBe('none')
    expect(res.text).toBe('plain text\nno anchors')
  })

  it('REFUSES a torn or duplicated anchor pair, text untouched', () => {
    const torn = ['<!-- SMA:EXPORT:BEGIN v1 -->', 'body — no end'].join('\n')
    expect(cutBlock(torn, MD_EXPORT).action).toBe('corrupt')
    expect(cutBlock(torn, MD_EXPORT).text).toBe(torn)
    const dup = ['<!-- SMA:EXPORT:BEGIN v1 -->', '<!-- SMA:EXPORT:BEGIN v1 -->', '<!-- SMA:EXPORT:END -->'].join('\n')
    expect(cutBlock(dup, MD_EXPORT).action).toBe('corrupt')
  })
})

describe('deleteme — stripManagedBlocks (Test 2)', () => {
  it('cuts BOTH families and leaves user bytes', () => {
    const text = [
      '# Head',
      '<!-- SMA:RULES:BEGIN v1 -->',
      'rules',
      '<!-- SMA:RULES:END -->',
      'middle',
      '<!-- SMA:EXPORT:BEGIN v1 -->',
      'corpus',
      '<!-- SMA:EXPORT:END -->',
      'tail',
    ].join('\n')
    const res = stripManagedBlocks(text)
    expect(res.removed).toContain('SMA:EXPORT(md)')
    expect(res.removed).toContain('SMA:RULES(md)')
    expect(res.corrupt).toEqual([])
    expect(res.text).toContain('# Head')
    expect(res.text).toContain('middle')
    expect(res.text).toContain('tail')
    expect(res.text).not.toContain('SMA:')
  })

  it('reports a corrupt family and leaves its span alone while cutting the clean one', () => {
    const text = ['<!-- SMA:RULES:BEGIN v1 -->', 'no end for rules', '<!-- SMA:EXPORT:BEGIN v1 -->', 'corpus', '<!-- SMA:EXPORT:END -->'].join('\n')
    const res = stripManagedBlocks(text)
    expect(res.corrupt).toContain('SMA:RULES(md)')
    expect(res.removed).toContain('SMA:EXPORT(md)')
    expect(res.text).toContain('SMA:RULES:BEGIN')
  })
})

describe('deleteme — removeSmaHooks (Test 3)', () => {
  it('strips SMA entries, preserves a foreign sibling in the same group, drops emptied events', () => {
    const settings: any = {
      model: 'opus',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node scripts/sma/cli.mjs session-start' }] }],
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              { type: 'command', command: 'node scripts/sma/cli.mjs pre' },
              { type: 'command', command: 'node my-guard.mjs' },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'node security-scan.mjs' }] }],
      },
    }
    const removed = removeSmaHooks(settings)
    expect(removed).toBe(2)
    expect(settings.hooks.SessionStart).toBeUndefined()
    expect(settings.hooks.PreToolUse[0].hooks).toEqual([{ type: 'command', command: 'node my-guard.mjs' }])
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('node security-scan.mjs')
    expect(settings.model).toBe('opus')
  })

  it('recognizes both path separators', () => {
    expect(isSmaHookCommand('node scripts/sma/cli.mjs pre')).toBe(true)
    expect(isSmaHookCommand('node scripts\\sma\\cli.mjs pre')).toBe(true)
    expect(isSmaHookCommand('node other/cli.mjs')).toBe(false)
  })
})

describe('deleteme — restoreStatusline (Test 4)', () => {
  it('hadNone -> removes OUR key; a stored original -> verbatim restore', () => {
    const s1: any = { statusLine: { type: 'command', command: 'node scripts/sma/cli.mjs statusline' } }
    expect(restoreStatusline(s1, { hadNone: true })).toBe('removed')
    expect(s1.statusLine).toBeUndefined()

    const orig = { type: 'command', command: 'node user-line.mjs' }
    const s2: any = { statusLine: { type: 'command', command: 'node scripts/sma/cli.mjs statusline --wrap' } }
    expect(restoreStatusline(s2, { original: orig, hadNone: false })).toBe('restored')
    expect(s2.statusLine).toEqual(orig)
  })

  it('no record: OUR command is removed, a foreign one is a noop', () => {
    const ours: any = { statusLine: { type: 'command', command: 'node scripts/sma/cli.mjs statusline' } }
    expect(restoreStatusline(ours, null)).toBe('removed')
    const foreign: any = { statusLine: { type: 'command', command: 'node their-line.mjs' } }
    expect(restoreStatusline(foreign, null)).toBe('noop')
    expect(foreign.statusLine.command).toBe('node their-line.mjs')
    expect(isSmaStatuslineCmd('node scripts/sma/cli.mjs statusline')).toBe(true)
  })
})

describe('deleteme — applyDeleteme with fake io (Test 5)', () => {
  const P = 'C:\\proj'
  const C = 'C:\\proj\\.claude'
  function fakeInstall() {
    const files = new Map<string, string>()
    const dirs = new Set<string>()
    const removed: string[] = []
    dirs.add(join(C, 'sma-core'))
    dirs.add(join(P, 'scripts', 'sma'))
    dirs.add(join(C, 'agents'))
    dirs.add(join(C, 'skills'))
    dirs.add(join(C, 'skills', 'sma-start'))
    dirs.add(join(C, 'skills', 'my-own'))
    dirs.add(join(C, 'memory'))
    dirs.add(join(P, '.sma'))
    files.set(join(C, 'agents', 'sma-executor.md'), 'x')
    files.set(join(C, 'agents', 'keep.md'), 'x')
    files.set(join(C, 'skills', 'my-own', 'SKILL.md'), 'user')
    files.set(join(C, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'node scripts/sma/cli.mjs session-start' }] }] } }))
    files.set(join(P, 'CLAUDE.md'), 'head\n<!-- SMA:EXPORT:BEGIN v1 -->\nb\n<!-- SMA:EXPORT:END -->\n')
    files.set(join(P, '.gitignore'), '.sma/\nnode_modules/\n')
    const io = {
      exists: (p: string) => files.has(p) || dirs.has(p),
      isDir: (p: string) => dirs.has(p),
      readFile: (p: string) => {
        if (!files.has(p)) throw new Error('ENOENT')
        return files.get(p)!
      },
      writeFile: (p: string, t: string) => void files.set(p, t),
      readdir: (p: string) => {
        const kids = new Set<string>()
        for (const f of [...files.keys(), ...dirs]) {
          if (f !== p && f.startsWith(p + '\\')) kids.add(f.slice(p.length + 1).split('\\')[0])
        }
        return [...kids]
      },
      rm: (p: string) => {
        removed.push(p)
        files.delete(p)
        dirs.delete(p)
        for (const f of [...files.keys()]) if (f.startsWith(p + '\\')) files.delete(f)
        for (const d of [...dirs]) if (d.startsWith(p + '\\')) dirs.delete(d)
      },
    }
    return { io, files, removed }
  }

  it('dry-run lists actions without touching anything; apply removes the artifacts', () => {
    const { io, files, removed } = fakeInstall()
    const dry = applyDeleteme({ project: P, configDir: C, io, dryRun: true })
    expect(dry.actions.every((a) => a.status === 'would-remove')).toBe(true)
    expect(removed).toEqual([])

    const res = applyDeleteme({ project: P, configDir: C, io, dryRun: false })
    expect(res.actions.some((a) => a.status === 'error')).toBe(false)
    expect(removed).toContain(join(C, 'sma-core'))
    expect(removed).toContain(join(P, 'scripts', 'sma'))
    expect(removed).toContain(join(C, 'agents', 'sma-executor.md'))
    expect(removed).toContain(join(C, 'skills', 'sma-start'))
    expect(removed).toContain(join(P, '.sma'))
    // survivors
    expect(files.has(join(C, 'agents', 'keep.md'))).toBe(true)
    expect(files.has(join(C, 'skills', 'my-own', 'SKILL.md'))).toBe(true)
    expect(files.get(join(P, 'CLAUDE.md'))).not.toContain('SMA:EXPORT')
    expect(files.get(join(P, 'CLAUDE.md'))).toContain('head')
    expect(files.get(join(P, '.gitignore'))).not.toContain('.sma/')
    const settings = JSON.parse(files.get(join(C, 'settings.json'))!)
    expect(settings.hooks).toBeUndefined()
    // the memory corpus is NEVER a target
    expect(res.actions.some((a) => a.target.includes('memory'))).toBe(false)
    expect(removed.some((p) => p.includes('memory'))).toBe(false)
  })

  it('refuses an unparseable settings.json (never-clobber)', () => {
    const { io, files } = fakeInstall()
    files.set(join(C, 'settings.json'), '{not json')
    const res = applyDeleteme({ project: P, configDir: C, io, dryRun: false })
    const s = res.actions.find((a) => a.kind === 'settings')
    expect(s?.status).toBe('skipped-unparseable')
    expect(files.get(join(C, 'settings.json'))).toBe('{not json')
  })
})

describe('deleteme — the full fixture selftest (Test 6)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sma-deleteme-test-'))
  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* best-effort */
    }
  })

  it('prints 1: artifacts gone, user assets survive, second run is a clean no-op', () => {
    expect(deletemeSelftest({ tmpRoot: tmp })).toBe(1)
  })
})
