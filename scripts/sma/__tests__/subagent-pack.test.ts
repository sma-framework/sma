/**
 * Tests for subagent-pack.mjs — deterministic PreTask context-pack assembly +
 * the PreToolUse `updatedInput` injection payload (Phase 49.2 Plan 04, Task 1).
 *
 * Everything is DI: sources are injected functions, so tests never touch the
 * filesystem, never shell out, and are fully deterministic (ages come from
 * injected ageMs; no Date.now() in the assembled text).
 */

import { describe, it, expect } from 'vitest'

import {
  assemblePack,
  deriveTags,
  buildUpdatedInput,
  PACK_BUDGET_BYTES,
} from '../lib/subagent-pack.mjs'

/** A fully-populated source bundle (all four layers non-empty). */
function fullSources(over: any = {}) {
  return {
    loadCore: () => [
      { title: 'Security guard every session', oneLiner: 'run the regression guard' },
      { title: 'Verify code before execute', oneLiner: 'the tree is the truth' },
    ],
    // honors empty tags (the real loader contract): no tags → no lessons.
    loadPeriphery: (tags: string[]) =>
      tags && tags.length
        ? [
            { title: 'lesson-a', oneLiner: 'first lesson' },
            { title: 'lesson-b', oneLiner: 'second lesson' },
          ]
        : [],
    readClaims: () => [
      { name: 'memory-corpus', provenance: { by: 'Tom' }, ageMs: 5 * 60000 },
    ],
    readSessions: () => [{ holderIdentity: 'Tom', label: 'phase:49.2', phase: '49.2' }],
    execTail: () => [
      { event: 'task_start', task: 1 },
      { event: 'task_complete', task: 1 },
    ],
    vocab: new Set(['crm', 'testing']),
    ...over,
  }
}

const TASK_INPUT = {
  description: 'wire the testing crm panel',
  prompt: 'Please build the panel and add tests.',
}

describe('Task 1 — subagent-pack assembly', () => {
  it('Test 1: returns ONE sentinel-bounded block with the four layers in fixed order under ## headings', () => {
    const { pack } = assemblePack({ taskInput: TASK_INPUT, sources: fullSources() })
    expect(pack.startsWith('=== SMA-PACK v1 ===')).toBe(true)
    expect(pack.trimEnd().endsWith('=== END SMA-PACK ===')).toBe(true)

    const iDigest = pack.indexOf('## Правила (CORE)')
    const iClaims = pack.indexOf('## Активные claims')
    const iSlice = pack.indexOf('## Задача родителя')
    const iLessons = pack.indexOf('## Уроки по задаче')
    // all four present…
    expect(iDigest).toBeGreaterThan(-1)
    expect(iClaims).toBeGreaterThan(-1)
    expect(iSlice).toBeGreaterThan(-1)
    expect(iLessons).toBeGreaterThan(-1)
    // …in the FIXED order digest -> claims -> slice -> lessons.
    expect(iDigest).toBeLessThan(iClaims)
    expect(iClaims).toBeLessThan(iSlice)
    expect(iSlice).toBeLessThan(iLessons)
    // named-identity claim line uses the displayIdentity convention.
    expect(pack).toContain('«memory-corpus» held by P49.2 Tom (5 min)')
  })

  it('Test 2: determinism + budget — byte-identical across runs; overflow drops lessons from the END, digest never trimmed', () => {
    const a = assemblePack({ taskInput: TASK_INPUT, sources: fullSources() })
    const b = assemblePack({ taskInput: TASK_INPUT, sources: fullSources() })
    expect(a.pack).toBe(b.pack) // byte-identical

    // Many big lessons overflow the (real) 8192-byte budget → lessons drop from the end.
    const bigLessons = Array.from({ length: 60 }, (_v, i) => ({
      title: `lesson-${String(i).padStart(3, '0')}`,
      oneLiner: 'x'.repeat(300),
    }))
    const { pack, layers, bytes } = assemblePack({
      taskInput: TASK_INPUT,
      sources: fullSources({ loadPeriphery: () => bigLessons }),
    })
    expect(bytes).toBeLessThanOrEqual(PACK_BUDGET_BYTES)
    expect(layers.lessons).toBeLessThan(60) // trimmed
    // the CORE digest layer is never trimmed — both rules survive.
    expect(layers.digest).toBe(2)
    expect(pack).toContain('Security guard every session')
    // trim takes from the END of the loader order: an early lesson stays, a late one goes.
    expect(pack).toContain('lesson-000')
    expect(pack).not.toContain('lesson-059')
  })

  it('Test 3: deriveTags word-intersection is sorted+deduped; zero hits → CORE-only pack', () => {
    const vocab = new Set(['crm', 'testing', 'finance'])
    const tags = deriveTags({ description: 'testing CRM crm work', prompt: 'add testing' }, vocab)
    expect(tags).toEqual(['crm', 'testing']) // sorted, deduped, only vocab hits

    expect(deriveTags({ description: 'nothing matches here', prompt: '' }, vocab)).toEqual([])

    // zero vocab hits → lessons layer empty, pack degrades to CORE(+claims+slice), no error.
    const { pack, layers } = assemblePack({
      taskInput: { description: 'zzz none', prompt: 'zzz' },
      sources: fullSources({ vocab: new Set(['finance']) }),
    })
    expect(layers.lessons).toBe(0)
    expect(pack).not.toContain('## Уроки по задаче')
    expect(pack).toContain('## Правила (CORE)')
  })

  it('Test 4: buildUpdatedInput prepends the pack, preserves the original prompt byte-identical, permissionDecision allow', () => {
    const original = 'ORIGINAL PROMPT — keep me exact.'
    const evt = { tool_name: 'Task', tool_input: { description: 'd', prompt: original, subagent_type: 'x' } }
    const pack = '=== SMA-PACK v1 ===\n\n## Правила (CORE)\n- r\n\n=== END SMA-PACK ==='
    const out = buildUpdatedInput(evt, pack)

    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow')
    const ui = out.hookSpecificOutput.updatedInput
    expect(ui.prompt).toBe(`${pack}\n\n${original}`)
    // the original prompt survives byte-identical after the pack.
    expect(ui.prompt.endsWith(original)).toBe(true)
    // other tool_input fields pass through untouched.
    expect(ui.subagent_type).toBe('x')
    expect(ui.description).toBe('d')
  })

  it('Test 5: a throwing source yields a PARTIAL pack (layer omitted + warning) and never throws', () => {
    const sources = fullSources({
      readClaims: () => {
        throw new Error('claims boom')
      },
    })
    let res: any
    expect(() => {
      res = assemblePack({ taskInput: TASK_INPUT, sources })
    }).not.toThrow()
    expect(res.layers.claims).toBe(0)
    expect(res.pack).not.toContain('## Активные claims')
    expect(res.warnings.some((w: string) => w.includes('claims'))).toBe(true)
    // the other layers still assembled.
    expect(res.pack).toContain('## Правила (CORE)')
    expect(res.pack).toContain('## Уроки по задаче')
  })
})
