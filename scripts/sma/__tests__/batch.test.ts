/**
 * Tests for scripts/sma/lib/batch.mjs (Phase 49.3 Plan 12 — the /sma-batch middle lane).
 *
 * D-49.3-19 / BL-149: the lane between an inline fix and a full phase. It takes 2-4
 * named backlog items (or self-assembles a compatible set), runs grill-lite per item,
 * executes with ONE executor (atomic commit per item), blind-reverifies every item,
 * checks the items off the backlog, and writes ONE batch note — with two hard guards:
 * a RISK FILTER that rejects phase-class work («this is a phase») and an EJECT rule that
 * throws a growing item back to the backlog while the batch continues.
 *
 * The six load-bearing behaviors (Test 1 risk filter, Test 3 surgical writer, Test 5
 * mandatory-receipt gate are the guards this lane exists to prove):
 *   Test 1 — classifyBatchRisk: phase-class markers rejected, S/M non-overlapping accepted, deterministic
 *   Test 2 — assembleCompatibleBatch: same-area S/M non-overlapping set, honest empty result
 *   Test 3 — checkOffBacklogItem: surgical [ ]→[x] on exactly the matched line, byte-identical elsewhere
 *   Test 4 — ejectItem: a grown item returns to the backlog as [ ] with the note; the batch continues
 *   Test 5 — runBatch order + mandatory receipts: preflight→grill→executor→reverify→checkoff; divergent = no checkoff
 *   Test 6 — writeBatchNote: ONE note (no phase folder); 3 items → 3 commits + 1 note
 *
 * DI everywhere — no real BACKLOG.md write, no real executor spawn (the next-slot.test.ts convention).
 */

import { describe, it, expect } from 'vitest'
import {
  PHASE_CLASS_MARKERS,
  classifyBatchRisk,
  selectBatch,
  assembleCompatibleBatch,
  checkOffBacklogItem,
  ejectItem,
  runBatch,
  writeBatchNote,
} from '../lib/batch.mjs'

// Verbatim-format excerpt mirroring the live .planning/BACKLOG.md `## Backlog` grammar.
const BACKLOG_FIXTURE = `# Backlog — fixture

## Backlog

- [ ] **BL-201** · Поправить подпись кнопки — исправить RU-текст на «Готово». \`size:S\` \`area:crm\` \`added:2026-07-09\`
- [ ] **BL-202** · Увеличить таймаут ретрая — поднять задержку до 5с. \`size:S\` \`area:crm\` \`added:2026-07-09\`
- [ ] **BL-203** · Отсортировать список — сортировать по дате по возрастанию. \`size:M\` \`area:crm\` \`added:2026-07-09\`
- [ ] **BL-204** · Новая коллекция Payload для документов — add a new collection + migration. \`size:L\` \`area:tech\` \`added:2026-07-09\`
- [x] **BL-205** · Уже закрытая задача — дедупнуть массив. \`size:S\` \`area:content\` \`added:2026-07-08\`

## Actions
`

// Parsed item shape (what parse-backlog.ts's parseBacklogContent yields, plus an optional
// files[] the batch layer uses for overlap detection).
const items = {
  BL201: { id: 'BL-201', title: 'Поправить подпись кнопки', description: 'исправить RU-текст на «Готово»', size: 'S', area: 'crm', done: false, files: ['src/a.ts'] },
  BL202: { id: 'BL-202', title: 'Увеличить таймаут ретрая', description: 'поднять задержку до 5с', size: 'S', area: 'crm', done: false, files: ['src/b.ts'] },
  BL203: { id: 'BL-203', title: 'Отсортировать список', description: 'сортировать по дате', size: 'M', area: 'crm', done: false, files: ['src/c.ts'] },
  // phase-class: mentions a new collection + migration
  BL204: { id: 'BL-204', title: 'Новая коллекция Payload', description: 'add a new collection + migration', size: 'L', area: 'tech', done: false, files: ['src/d.ts'] },
  // overlaps BL-201 on files
  BL201b: { id: 'BL-206', title: 'Другой фикс', description: 'править тот же файл', size: 'S', area: 'crm', done: false, files: ['src/a.ts'] },
}

describe('49.3-12 batch — risk filter (Test 1)', () => {
  it('rejects every phase-class item with «this is a phase» and accepts S/M non-overlapping items', () => {
    const phaseClass = [
      { id: 'BL-301', title: 'Add a migration', description: 'schema change' },
      { id: 'BL-302', title: 'New webhook', description: 'inbound webhook route' },
      { id: 'BL-303', title: 'New AI agent', description: 'a new agent in the orchestrator' },
      { id: 'BL-304', title: 'Cron job', description: 'weekly cron poll' },
      { id: 'BL-305', title: 'New route', description: 'a new /crm surface page' },
      { id: 'BL-306', title: 'New collection', description: 'a Payload collection' },
    ]
    for (const it of phaseClass) {
      const r = classifyBatchRisk(it)
      expect(r.allowed).toBe(false)
      expect(r.reason).toBe('this is a phase')
    }
    for (const it of [items.BL201, items.BL202, items.BL203]) {
      expect(classifyBatchRisk(it).allowed).toBe(true)
    }
  })

  it('is deterministic — identical input yields identical classification', () => {
    const a = classifyBatchRisk(items.BL204)
    const b = classifyBatchRisk(items.BL204)
    expect(a).toEqual(b)
    expect(a.allowed).toBe(false)
  })

  it('exports a non-empty marker list', () => {
    expect(Array.isArray(PHASE_CLASS_MARKERS)).toBe(true)
    expect(PHASE_CLASS_MARKERS.length).toBeGreaterThan(0)
  })
})

describe('49.3-12 batch — selection + compatibility assembly (Test 2)', () => {
  it('selectBatch resolves named ids, caps at 4, refuses a file-overlapping set', () => {
    const ok = selectBatch(['BL-201', 'BL-202', 'BL-203'], Object.values(items))
    expect(ok.ok).toBe(true)
    expect(ok.items.map((i) => i.id)).toEqual(['BL-201', 'BL-202', 'BL-203'])

    // file overlap (BL-201 and BL-206 share src/a.ts)
    const overlap = selectBatch(['BL-201', 'BL-206'], Object.values(items))
    expect(overlap.ok).toBe(false)
    expect(overlap.reason).toMatch(/overlap/i)

    // a missing id is honest
    const missing = selectBatch(['BL-201', 'BL-999'], Object.values(items))
    expect(missing.ok).toBe(false)
    expect(missing.reason).toMatch(/BL-999/)
  })

  it('assembleCompatibleBatch picks a same-area S/M non-overlapping set, never a phase-class item', () => {
    const r = assembleCompatibleBatch(Object.values(items))
    expect(r.ok).toBe(true)
    expect(r.items.length).toBeGreaterThanOrEqual(2)
    expect(r.items.length).toBeLessThanOrEqual(4)
    // all same area, all S/M, none phase-class, none done
    const areas = new Set(r.items.map((i) => i.area))
    expect(areas.size).toBe(1)
    for (const i of r.items) {
      expect(['S', 'M']).toContain(i.size)
      expect(classifyBatchRisk(i).allowed).toBe(true)
      expect(i.done).toBeFalsy()
    }
    // no file overlap within the set
    const seen = new Set()
    for (const i of r.items) for (const f of i.files ?? []) {
      expect(seen.has(f)).toBe(false)
      seen.add(f)
    }
  })

  it('returns an honest empty result when no compatible set exists', () => {
    const r = assembleCompatibleBatch([items.BL204]) // only a phase-class L item
    expect(r.ok).toBe(false)
    expect(r.items).toEqual([])
    expect(typeof r.reason).toBe('string')
    expect(r.reason.length).toBeGreaterThan(0)
  })
})

describe('49.3-12 batch — surgical backlog writer (Test 3)', () => {
  it('flips exactly the matched line to [x] and leaves every other byte identical', () => {
    const before = BACKLOG_FIXTURE
    const { changed, backlogText } = checkOffBacklogItem({ backlogText: before, id: 'BL-202' })
    expect(changed).toBe(true)

    const beforeLines = before.split('\n')
    const afterLines = backlogText.split('\n')
    expect(afterLines.length).toBe(beforeLines.length)
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i].includes('**BL-202**')) {
        expect(afterLines[i]).toBe(beforeLines[i].replace('- [ ]', '- [x]'))
      } else {
        expect(afterLines[i]).toBe(beforeLines[i]) // byte-identical
      }
    }
  })

  it('is a no-op on an already-[x] line', () => {
    const r = checkOffBacklogItem({ backlogText: BACKLOG_FIXTURE, id: 'BL-205' })
    expect(r.changed).toBe(false)
    expect(r.backlogText).toBe(BACKLOG_FIXTURE)
  })

  it('does not touch the file for a missing id', () => {
    const r = checkOffBacklogItem({ backlogText: BACKLOG_FIXTURE, id: 'BL-777' })
    expect(r.changed).toBe(false)
    expect(r.backlogText).toBe(BACKLOG_FIXTURE)
  })
})

describe('49.3-12 batch — eject on growth (Test 4)', () => {
  it('returns the item to the backlog as [ ] with the eject note and keeps the text valid', () => {
    // start from a backlog where BL-203 was checked off mid-run, then grows
    const checked = checkOffBacklogItem({ backlogText: BACKLOG_FIXTURE, id: 'BL-203' }).backlogText
    const r = ejectItem({ item: items.BL203, backlogText: checked, note: 'grew past batch-class — replan as a phase' })
    expect(r.ejected).toBe(true)
    expect(r.note).toMatch(/replan as a phase/)
    // the BL-203 line is back to [ ] and carries the note
    const line = r.backlogText.split('\n').find((l) => l.includes('**BL-203**'))
    expect(line).toBeTruthy()
    expect(line).toContain('- [ ]')
    expect(line).toMatch(/replan as a phase/)
  })
})

describe('49.3-12 batch — orchestration order + mandatory receipts (Test 5)', () => {
  function makeIo(initial) {
    let text = initial
    const order = []
    return {
      order,
      io: {
        read: () => text,
        write: (t) => { order.push('checkoff'); text = t },
      },
      get text() { return text },
    }
  }

  it('drives preflight→grill→executor→reverify→checkoff in that order and checks the item off on a clean receipt', async () => {
    const bag = makeIo(BACKLOG_FIXTURE)
    const runPreflight = async () => { bag.order.push('preflight'); return { verdict: 'absent', code: 2 } }
    const grillGate = () => { bag.order.push('grill'); return { allowed: true, grilled: true, open: [] } }
    const runExecutor = async () => { bag.order.push('executor'); return { commit: 'abc1234' } }
    const runReverify = async () => { bag.order.push('reverify'); return { verdict: 'verified', receipt: { claimed: 'x', reproduced: 'x' } } }

    const res = await runBatch({ items: [items.BL201], runPreflight, grillGate, runExecutor, runReverify, backlogIo: bag.io })

    expect(bag.order).toEqual(['preflight', 'grill', 'executor', 'reverify', 'checkoff'])
    expect(res.items[0].status).toBe('pass')
    expect(res.items[0].commit).toBe('abc1234')
    // the box actually flipped in the backlog text
    expect(bag.text.split('\n').find((l) => l.includes('**BL-201**'))).toContain('- [x]')
  })

  it('does NOT check off an item whose reverify diverges — the box stays [ ]', async () => {
    const bag = makeIo(BACKLOG_FIXTURE)
    const runPreflight = async () => ({ verdict: 'absent', code: 2 })
    const grillGate = () => ({ allowed: true, grilled: true, open: [] })
    const runExecutor = async () => ({ commit: 'def5678' })
    const runReverify = async () => ({ verdict: 'divergent', receipt: { claimed: 'x', reproduced: 'y' } })

    const res = await runBatch({ items: [items.BL201], runPreflight, grillGate, runExecutor, runReverify, backlogIo: bag.io })

    expect(res.items[0].status).toBe('fail')
    expect(bag.order).not.toContain('checkoff') // never written
    expect(bag.text.split('\n').find((l) => l.includes('**BL-201**'))).toContain('- [ ]')
  })

  it('skips an already-built item (preflight built) without running the executor', async () => {
    const bag = makeIo(BACKLOG_FIXTURE)
    let executed = false
    const runPreflight = async () => ({ verdict: 'built', code: 0 })
    const grillGate = () => ({ allowed: true, grilled: true, open: [] })
    const runExecutor = async () => { executed = true; return { commit: 'zzz' } }
    const runReverify = async () => ({ verdict: 'verified' })

    const res = await runBatch({ items: [items.BL202], runPreflight, grillGate, runExecutor, runReverify, backlogIo: bag.io })
    expect(executed).toBe(false)
    expect(res.items[0].status).toBe('skipped-built')
  })

  it('blocks an item whose grill-lite gate has an open challenge — no executor, no checkoff', async () => {
    const bag = makeIo(BACKLOG_FIXTURE)
    let executed = false
    const runPreflight = async () => ({ verdict: 'absent', code: 2 })
    const grillGate = () => ({ allowed: false, grilled: true, open: [{ id: 'C1' }] })
    const runExecutor = async () => { executed = true; return { commit: 'zzz' } }
    const runReverify = async () => ({ verdict: 'verified' })

    const res = await runBatch({ items: [items.BL203], runPreflight, grillGate, runExecutor, runReverify, backlogIo: bag.io })
    expect(executed).toBe(false)
    expect(res.items[0].status).toBe('blocked')
    expect(bag.order).not.toContain('checkoff')
  })

  it('rejects a phase-class item up front and continues the batch with the rest', async () => {
    const bag = makeIo(BACKLOG_FIXTURE)
    const commits = []
    const runPreflight = async () => ({ verdict: 'absent', code: 2 })
    const grillGate = () => ({ allowed: true, grilled: true, open: [] })
    const runExecutor = async (item) => { commits.push(item.id); return { commit: item.id } }
    const runReverify = async () => ({ verdict: 'verified' })

    const res = await runBatch({ items: [items.BL204, items.BL201], runPreflight, grillGate, runExecutor, runReverify, backlogIo: bag.io })
    // BL-204 is phase-class → rejected; BL-201 still processes
    expect(res.items.find((r) => r.id === 'BL-204').status).toBe('rejected')
    expect(res.items.find((r) => r.id === 'BL-204').reason).toBe('this is a phase')
    expect(commits).toEqual(['BL-201'])
  })
})

describe('49.3-12 batch — one note, not a phase folder (Test 6)', () => {
  it('writeBatchNote emits a single note carrying every item; 3 items → 3 commits + 1 note', async () => {
    const bag = { read: () => BACKLOG_FIXTURE, write: () => {} }
    const commits = []
    const runPreflight = async () => ({ verdict: 'absent', code: 2 })
    const grillGate = () => ({ allowed: true, grilled: true, open: [] })
    const runExecutor = async (item) => { commits.push(item.id); return { commit: `sha-${item.id}` } }
    const runReverify = async () => ({ verdict: 'verified', receipt: { claimed: 'a', reproduced: 'a' } })

    const res = await runBatch({ items: [items.BL201, items.BL202, items.BL203], runPreflight, grillGate, runExecutor, runReverify, backlogIo: bag })
    expect(commits.length).toBe(3)

    const note = writeBatchNote(res.items)
    expect(typeof note).toBe('string')
    for (const id of ['BL-201', 'BL-202', 'BL-203']) expect(note).toContain(id)
    // the note records receipts (accountability floor)
    expect(note).toMatch(/reverify|receipt|verified/i)
    // res.note is the same single note (one note, no phase folder)
    expect(res.note).toContain('BL-201')
  })
})
