/**
 * Tests for scripts/sma/lib/rules-parity.mjs — the rule
 * that says what «the same rules as your terminal» is allowed to mean.
 *
 * THE RULE UNDER TEST, in one sentence: the NARROWING half (deny, ask) must match rule for
 * rule; the WIDENING half (allow, defaultMode) is declared not-mirrored and must be absent
 * from the worker. Read literally, «the same list of rules» would demand that a worker
 * inherit the allow list of a person sitting at a keyboard — and that list is what a person
 * grants himself, including the one line that lets a push through. Mirroring it would hand a
 * headless session the rights of the human. So the rule has two halves and they are not
 * symmetric on purpose, and this file is where that asymmetry stops being prose.
 *
 *   Case A — the pure comparison: equal sets pass, order does not matter, a rule missing on
 *     either side is named by its own text, a repeated rule is counted rather than folded.
 *   Case B — the lock: a widening key on the worker's side is a failure that names the key,
 *     and a missing declaration is a failure («the difference was never declared»), never a
 *     silent pass.
 *   Case C — absence: a settings file that is not there is «нет данных», never «совпало».
 *   Case D — the module writes nothing: its source contains no filesystem write at all.
 *
 * Every case runs on freshly minted temporary directories. The real configuration
 * directories of this machine are never read and never written by this file.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  compareRules,
  notMirroredDeclaration,
  NOT_MIRRORED,
  WIDENING_KEYS,
  NARROWING_KEYS,
} from '../lib/rules-parity.mjs'

const DECLARED = notMirroredDeclaration()

/** A settings object in the shape both real files have. */
function settings(perms: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { theme: 'dark', ...extra, permissions: { ...perms } }
}

describe('Case A — the narrowing half is compared rule for rule', () => {
  it('equal deny and ask lists pass, and the verdict says so', () => {
    const terminal = settings({ deny: ['Read(.env)', 'Read(.secrets)'], ask: [], allow: ['Bash(git push:*)'], defaultMode: 'auto' })
    const worker = settings({ deny: ['Read(.env)', 'Read(.secrets)'], ask: [] })
    const out = compareRules({ terminal, worker, declaration: DECLARED })
    expect(out.denyEqual).toBe(true)
    expect(out.askEqual).toBe(true)
    expect(out.diffs).toEqual([])
    expect(out.verdict).toBe('ok')
  })

  it('the order of the rules is not part of the rule', () => {
    const terminal = settings({ deny: ['b', 'a', 'c'], ask: ['x'] })
    const worker = settings({ deny: ['c', 'b', 'a'], ask: ['x'] })
    const out = compareRules({ terminal, worker, declaration: DECLARED })
    expect(out.denyEqual).toBe(true)
    expect(out.verdict).toBe('ok')
  })

  it('a rule the person has and the worker lacks is named by its own text', () => {
    const terminal = settings({ deny: ['Read(.env)', 'Read(.secrets)'] })
    const worker = settings({ deny: ['Read(.env)'] })
    const out = compareRules({ terminal, worker, declaration: DECLARED })
    expect(out.denyEqual).toBe(false)
    expect(out.verdict).toBe('fail')
    expect(out.diffs).toHaveLength(1)
    expect(out.diffs[0].rule).toBe('Read(.secrets)')
    expect(out.diffs[0].side).toBe('terminal')
    expect(out.diffs[0].list).toBe('deny')
  })

  it('a rule the worker has and the person lacks is a divergence too, named the other way', () => {
    const terminal = settings({ deny: ['Read(.env)'] })
    const worker = settings({ deny: ['Read(.env)', 'Read(.ssh)'] })
    const out = compareRules({ terminal, worker, declaration: DECLARED })
    expect(out.verdict).toBe('fail')
    expect(out.diffs[0].rule).toBe('Read(.ssh)')
    expect(out.diffs[0].side).toBe('worker')
  })

  it('the lists are multisets: the same rule written twice is not the same as once', () => {
    const terminal = settings({ deny: ['Read(.env)', 'Read(.env)'] })
    const worker = settings({ deny: ['Read(.env)'] })
    const out = compareRules({ terminal, worker, declaration: DECLARED })
    expect(out.verdict).toBe('fail')
    expect(out.diffs[0]).toMatchObject({ rule: 'Read(.env)', side: 'terminal', count: 1 })
  })

  it('the `ask` list is compared by the same rule as `deny`', () => {
    const terminal = settings({ deny: [], ask: ['Bash(rm:*)'] })
    const worker = settings({ deny: [], ask: [] })
    const out = compareRules({ terminal, worker, declaration: DECLARED })
    expect(out.askEqual).toBe(false)
    expect(out.diffs[0].list).toBe('ask')
    expect(NARROWING_KEYS).toEqual(['deny', 'ask'])
  })
})

describe('Case B — расширяющее не зеркалируется, и это замок, а не стиль', () => {
  it('a mirrored allow list on the worker fails, and the failure names the key', () => {
    const terminal = settings({ deny: ['Read(.env)'], allow: ['Bash(git push:*)'] })
    const worker = settings({ deny: ['Read(.env)'], allow: ['Bash(git push:*)'] })
    const out = compareRules({ terminal, worker, declaration: DECLARED })
    expect(out.verdict).toBe('fail')
    expect(out.widened).toEqual(['allow'])
    expect(out.reasons.join(' ')).toContain('allow')
  })

  it('a mirrored defaultMode on the worker fails the same way — a regime, not a convenience', () => {
    const terminal = settings({ deny: [], defaultMode: 'auto' })
    const worker = settings({ deny: [], defaultMode: 'auto' })
    const out = compareRules({ terminal, worker, declaration: DECLARED })
    expect(out.verdict).toBe('fail')
    expect(out.widened).toEqual(['defaultMode'])
    expect(WIDENING_KEYS).toEqual(['allow', 'defaultMode'])
  })

  it('a difference nobody declared is a failure, never a silent pass', () => {
    const terminal = settings({ deny: ['Read(.env)'], allow: ['Bash(git push:*)'] })
    const worker = settings({ deny: ['Read(.env)'] })
    const out = compareRules({ terminal, worker, declaration: null })
    expect(out.allowDeclared).toBe(false)
    expect(out.defaultModeDeclared).toBe(false)
    expect(out.verdict).toBe('fail')
    expect(out.reasons.join(' ')).toContain('не объявлен')
  })

  it('a declaration that carries a real list instead of the words is not a declaration', () => {
    const terminal = settings({ deny: [], allow: ['Bash(git push:*)'] })
    const worker = settings({ deny: [] })
    const out = compareRules({
      terminal,
      worker,
      declaration: { allow: ['Bash(git push:*)'], defaultMode: NOT_MIRRORED },
    })
    expect(out.allowDeclared).toBe(false)
    expect(out.defaultModeDeclared).toBe(true)
    expect(out.verdict).toBe('fail')
  })
})

describe('Case C — нет файла значит нет данных, а не «совпало»', () => {
  it('a missing terminal file fails with the reason, and no comparison is claimed', () => {
    const out = compareRules({ terminal: null, worker: settings({ deny: [] }), declaration: DECLARED })
    expect(out.verdict).toBe('fail')
    expect(out.denyEqual).toBe(false)
    expect(out.reasons.join(' ')).toContain('данных нет')
    expect(out.counts.terminal).toBe(null)
  })

  it('a missing worker file fails the same way', () => {
    const out = compareRules({ terminal: settings({ deny: [] }), worker: null, declaration: DECLARED })
    expect(out.verdict).toBe('fail')
    expect(out.reasons.join(' ')).toContain('данных нет')
    expect(out.counts.worker).toBe(null)
  })
})

describe('Case D — the module writes nothing at all', () => {
  it('its source carries no filesystem write', () => {
    const src = readFileSync(resolve(__dirname, '..', 'lib', 'rules-parity.mjs'), 'utf8')
    expect(/writeFile|appendFile|mkdir|rename|rmSync|unlinkSync/.test(src)).toBe(false)
    // …and it never reaches for a filesystem at all: a pure function cannot touch one.
    expect(/from 'node:fs'/.test(src)).toBe(false)
  })
})
