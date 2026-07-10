/**
 * Tests for scripts/sma/lib/fragments.mjs (Phase 9.3 Plan 05, Task 2 — D-9.3-07).
 *
 *   - Test 1 (format): parseFragment → {id, trigger, tags, body}; validateFragment flags
 *     over-budget body (FRAG-BYTES), missing/unparseable trigger (FRAG-TRIGGER), and
 *     missing id/frontmatter (FRAG-SCHEMA), each naming the file.
 *   - Test 2 (trigger grammar): parseTrigger accepts path:<glob> | tag:<tag> | cmd:<sub>;
 *     matchTriggers orders by specificity (path > cmd > tag) then id asc, deterministically.
 *   - Test 3 (delivery): at most 2 per event; a fragment already seen this session is
 *     skipped (fatigue); each delivered fragment fires one cite; a throwing cite never
 *     breaks delivery.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  parseFragment,
  validateFragment,
  parseTrigger,
  matchTriggers,
  deliverFragments,
} from '../lib/fragments.mjs'

function frag(id: string, trigger: string, tags: string[] = [], body = 'one fact.') {
  const fm = ['---', `id: ${id}`, `trigger: ${trigger}`, `tags: [${tags.join(', ')}]`, '---', body].join('\n') + '\n'
  return parseFragment(fm, { file: `${id}.md` })
}

describe('parseFragment + validateFragment — format (Test 1)', () => {
  it('parses the fact and flags byte/trigger/schema violations naming the file', () => {
    const good = frag('payload-fk', 'path:src/payload/**', ['payload', 'crm'], 'Payload single-rel fields store as <field>_id columns.')
    expect(good.id).toBe('payload-fk')
    expect(good.trigger).toBe('path:src/payload/**')
    expect(good.tags).toEqual(['payload', 'crm'])
    expect(good.body).toContain('field>_id')
    expect(validateFragment(good)).toEqual([])

    // over-budget body → FRAG-BYTES
    const big = frag('big-fact', 'tag:crm', ['crm'], 'x'.repeat(500))
    const bigV = validateFragment(big)
    expect(bigV.some((v) => v.rule === 'FRAG-BYTES' && v.file === 'big-fact.md')).toBe(true)

    // unparseable trigger → FRAG-TRIGGER
    const badTrig = frag('bad-trig', 'whatever:nope', ['crm'])
    const btV = validateFragment(badTrig)
    expect(btV.some((v) => v.rule === 'FRAG-TRIGGER' && v.file === 'bad-trig.md')).toBe(true)

    // missing frontmatter → FRAG-SCHEMA
    const noFm = parseFragment('just a body, no frontmatter\n', { file: 'nofm.md' })
    const nfV = validateFragment(noFm)
    expect(nfV.some((v) => v.rule === 'FRAG-SCHEMA' && v.file === 'nofm.md')).toBe(true)

    // id != stem → FRAG-SCHEMA
    const mismatch = parseFragment(['---', 'id: other', 'trigger: tag:crm', '---', 'body'].join('\n') + '\n', { file: 'actual.md' })
    expect(validateFragment(mismatch).some((v) => v.rule === 'FRAG-SCHEMA')).toBe(true)
  })
})

describe('parseTrigger + matchTriggers — grammar + ordering (Test 2)', () => {
  it('parses the three trigger kinds and rejects anything else', () => {
    expect(parseTrigger('tag:crm')).toMatchObject({ kind: 'tag', value: 'crm' })
    expect(parseTrigger('cmd:git push')).toMatchObject({ kind: 'cmd', value: 'git push' })
    const p = parseTrigger('path:src/**/*.ts')
    expect(p && p.kind).toBe('path')
    // ** = any depth, * = one segment
    expect(p!.test('src/a/b/c.ts')).toBe(true)
    expect(p!.test('src/x.ts')).toBe(true)
    expect(p!.test('other/x.ts')).toBe(false)
    const seg = parseTrigger('path:src/*.ts')
    expect(seg!.test('src/x.ts')).toBe(true)
    expect(seg!.test('src/a/b.ts')).toBe(false) // * does not cross a segment
    expect(parseTrigger('nonsense')).toBeNull()
    expect(parseTrigger('path:')).toBeNull()
  })

  it('orders matches path > cmd > tag then id asc, deterministically', () => {
    const fragments = [
      frag('z-path', 'path:src/**', []),
      frag('a-tag', 'tag:crm', []),
      frag('m-cmd', 'cmd:migrate', []),
      frag('b-tag', 'tag:crm', []),
    ]
    const toolInput = { file_path: 'src/crm/x.ts', command: 'run migrate now' }
    const order1 = matchTriggers({ toolName: 'Edit', toolInput, tags: ['crm'], fragments }).map((f) => f.id)
    const order2 = matchTriggers({ toolName: 'Edit', toolInput, tags: ['crm'], fragments }).map((f) => f.id)
    expect(order1).toEqual(order2)
    // path first, then cmd, then the two tag matches in id asc order
    expect(order1).toEqual(['z-path', 'm-cmd', 'a-tag', 'b-tag'])
  })
})

describe('deliverFragments — cap + fatigue + citation (Test 3)', () => {
  it('caps at 2, dedups per session, cites each delivered, and survives a throwing cite', () => {
    const fragments = [
      frag('f1', 'tag:crm', []),
      frag('f2', 'tag:crm', []),
      frag('f3', 'tag:crm', []),
    ]
    const seen = { keys: {}, notes: {} as Record<string, number> }
    const cite = vi.fn()

    const first = deliverFragments({ toolName: 'Edit', toolInput: {}, tags: ['crm'], fragments, seen, cite })
    expect(first.delivered.length).toBe(2) // cap
    expect(cite).toHaveBeenCalledTimes(2)

    // second event, same session: the two already-seen fragments are skipped; f3 delivers
    const second = deliverFragments({ toolName: 'Edit', toolInput: {}, tags: ['crm'], fragments, seen, cite })
    expect(second.delivered.map((f) => f.id)).toEqual(['f3'])

    // a throwing citation sink never breaks delivery
    const seen2 = { keys: {}, notes: {} as Record<string, number> }
    const boom = vi.fn(() => {
      throw new Error('sink down')
    })
    const res = deliverFragments({ toolName: 'Edit', toolInput: {}, tags: ['crm'], fragments, seen: seen2, cite: boom })
    expect(res.delivered.length).toBe(2)
  })
})
