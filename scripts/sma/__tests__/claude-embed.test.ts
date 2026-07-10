/**
 * Tests for scripts/sma/lib/claude-embed.mjs (49.4 BL-165, v3.6 — the installer's
 * CLAUDE.md rules block).
 *
 * The load-bearing behaviors:
 *   Test 1 — renderRulesBlock: anchors + the memory pointer + the version stamp
 *   Test 2 — embedRules via fake io: created / appended (user bytes a byte-identical
 *            prefix) / unchanged (idempotent) / replaced (version bump) / corrupt=refused
 *   Test 3 — coexistence: the RULES block never disturbs an SMA:EXPORT block and vice versa
 *   Test 4 — round trip with the off-ramp: deleteme's stripManagedBlocks removes the block
 *   Test 5 — embedSelftest on a real temp dir prints 1 (the P-BL-165 check)
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import { RULES_MARKERS, renderRulesBlock, embedRules, embedSelftest } from '../lib/claude-embed.mjs'
import { stripManagedBlocks } from '../lib/deleteme.mjs'

function fakeIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    exists: (p: string) => files.has(p),
    readFile: (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)!
    },
    writeFile: (p: string, t: string) => void files.set(p, t),
  }
}

describe('claude-embed — renderRulesBlock (Test 1)', () => {
  it('carries the anchors, the memory pointer, and the version', () => {
    const block = renderRulesBlock({ version: '3.6.0' })
    expect(block.startsWith(RULES_MARKERS.beginPrefix)).toBe(true)
    expect(block.endsWith(RULES_MARKERS.end)).toBe(true)
    expect(block).toContain('.claude/memory/MEMORY.md')
    expect(block).toContain('next-slot')
    expect(block).toContain('v3.6.0')
  })
})

describe('claude-embed — embedRules law (Test 2)', () => {
  const P = 'C:\\proj'
  const FILE = join(P, 'CLAUDE.md')

  it('creates a fresh CLAUDE.md, then a re-embed is unchanged', () => {
    const io = fakeIo()
    expect(embedRules({ projectDir: P, version: '3.6.0', io }).action).toBe('created')
    expect(io.files.get(FILE)).toContain('SMA:RULES:BEGIN')
    expect(embedRules({ projectDir: P, version: '3.6.0', io }).action).toBe('unchanged')
  })

  it('appends after user bytes (byte-identical prefix); a version bump replaces only the span', () => {
    const user = '# Project rules\n\nMy prose stays.\n'
    const io = fakeIo({ [FILE]: user })
    expect(embedRules({ projectDir: P, version: '3.6.0', io }).action).toBe('appended')
    expect(io.files.get(FILE)!.startsWith(user)).toBe(true)
    expect(embedRules({ projectDir: P, version: '3.7.0', io }).action).toBe('replaced')
    const after = io.files.get(FILE)!
    expect(after.startsWith(user)).toBe(true)
    expect(after).toContain('v3.7.0')
    expect(after).not.toContain('v3.6.0')
  })

  it('REFUSES a torn anchor pair, file untouched', () => {
    const torn = '<!-- SMA:RULES:BEGIN v1 -->\nno end\n'
    const io = fakeIo({ [FILE]: torn })
    expect(embedRules({ projectDir: P, version: '3.6.0', io }).action).toBe('skipped-corrupt')
    expect(io.files.get(FILE)).toBe(torn)
  })
})

describe('claude-embed — coexistence with the corpus block (Test 3)', () => {
  it('leaves an existing SMA:EXPORT block byte-identical', () => {
    const P = 'C:\\proj'
    const FILE = join(P, 'CLAUDE.md')
    const exportBlock = ['<!-- SMA:EXPORT:BEGIN v1 fmt=CLAUDE.md commit=' + '0'.repeat(40) + ' -->', 'corpus', '<!-- SMA:EXPORT:END -->'].join('\n')
    const io = fakeIo({ [FILE]: `head\n\n${exportBlock}\n` })
    expect(embedRules({ projectDir: P, version: '3.6.0', io }).action).toBe('appended')
    const after = io.files.get(FILE)!
    expect(after).toContain(exportBlock)
    expect(after).toContain('SMA:RULES:BEGIN')
  })
})

describe('claude-embed — off-ramp round trip (Test 4)', () => {
  it('deleteme stripManagedBlocks removes exactly the rules block', () => {
    const io = fakeIo()
    embedRules({ projectDir: 'C:\\proj', version: '3.6.0', io })
    const withBlock = 'user head\n\n' + io.files.get(join('C:\\proj', 'CLAUDE.md'))!
    const res = stripManagedBlocks(withBlock)
    expect(res.removed).toContain('SMA:RULES(md)')
    expect(res.corrupt).toEqual([])
    expect(res.text).toContain('user head')
    expect(res.text).not.toContain('SMA:RULES')
  })
})

describe('claude-embed — the fixture selftest (Test 5)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sma-embed-test-'))
  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* best-effort */
    }
  })

  it('prints 1 across created/unchanged/appended/replaced/corrupt', () => {
    expect(embedSelftest({ tmpRoot: tmp })).toBe(1)
  })
})
