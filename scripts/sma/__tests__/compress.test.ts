/**
 * Tests for scripts/sma/lib/compress.mjs — proposing the SHORTENING OF NOTE TEXT.
 *
 * The verb is preview-only by construction, and every claim below is taken off a
 * FILE or off a BYTE COUNT rather than off a return value alone: a proposal engine
 * that only promised not to touch the corpus would be believed, not proved.
 *
 *   - the targets: a note standing in the warn zone of the per-note byte budget is
 *     named, a light one is not, the grounds carry the numbers, and the order is
 *     deterministic;
 *   - the zero-write invariant: after a preview the corpus tree OUTSIDE drafts/ is
 *     byte-identical. This case goes red the moment preview touches a note;
 *   - never-clobber: a second preview writes nothing, and a template a human has
 *     filled in is kept, never overwritten;
 *   - every refusal of the apply door: the wrong confirmation, an unfilled
 *     template, a proposal that is not actually smaller (with both numbers in the
 *     refusal), and a target that is gone;
 *   - the successful apply: the note is overwritten, `<draft>.orig` carries the
 *     original byte-for-byte, and the consumed marker exists;
 *   - the rollback: copying `.orig` back over the target returns the corpus to a
 *     byte-identical state — which is the whole reason the copy is written first.
 *
 * The thresholds are IMPORTED. A literal here would be a second yardstick, and the
 * day the shipped budget moved this suite would keep testing the old one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  propose,
  preview,
  apply,
  draftPathFor,
  origPathFor,
  PROPOSAL_HEADING,
  UNFILLED_MARKER,
  DRAFT_KIND,
} from '../lib/compress.mjs'
import { NOTE_BUDGET, BUDGET_WARN_FRACTION } from '../lib/constants.mjs'
import { appliedDraftPath } from '../lib/write-pipeline.mjs'

/** Recursive snapshot of a tree: relpath → content (the write-detection oracle). */
function snapshotTree(root: string, base = root): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name)
    if (statSync(p).isDirectory()) Object.assign(out, snapshotTree(p, base))
    else out[p.slice(base.length)] = readFileSync(p, 'utf8')
  }
  return out
}

/** The corpus tree with drafts/ removed — what preview is forbidden to touch. */
function snapshotOutsideDrafts(root: string): Record<string, string> {
  const all = snapshotTree(root)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(all)) {
    if (k.includes('drafts')) continue
    out[k] = v
  }
  return out
}

/** A parseable note of a REQUESTED byte length (the body is padded to hit it exactly). */
function noteText(id: string, bytes: number): string {
  const head = `---\nid: ${id}\nkind: semantic\ndescription: ${id}\n---\n\n`
  const tail = '\n'
  const fill = Math.max(1, bytes - Buffer.byteLength(head + tail, 'utf8'))
  return head + 'x'.repeat(fill) + tail
}

function writeNote(dir: string, file: string, bytes: number) {
  const text = noteText(file.replace(/\.md$/, ''), bytes)
  writeFileSync(join(dir, file), text, 'utf8')
  return text
}

/** The byte length at which a note enters the warn zone of its own budget. */
const WARN_BYTES = Math.ceil(NOTE_BUDGET * BUDGET_WARN_FRACTION)

/** A frozen date so a template is byte-comparable between runs. */
const FROZEN = new Date('2026-08-22T00:00:00Z')

let tmp: string
let corpusDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-compress-'))
  corpusDir = join(tmp, 'corpus')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'MEMORY.md'), '# индекс памяти (фикстура)\n', 'utf8')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

describe('compress.mjs — какие заметки названы целями и на каких основаниях', () => {
  it('заметка в warn-зоне бюджета названа целью, лёгкие — нет, и основание несёт число', () => {
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    writeNote(corpusDir, 'light-a.md', 200)
    writeNote(corpusDir, 'light-b.md', 180)

    // topN=0 отключает первую эвристику целиком: остаётся ТОЛЬКО warn-зона,
    // поэтому этот случай утверждает именно её, а не сумму двух.
    const { targets, warnBytes } = propose({ corpusDir, topN: 0 })

    expect(targets.map((t) => t.file)).toEqual(['heavy.md'])
    expect(warnBytes).toBe(WARN_BYTES)
    expect(targets[0].bytes).toBe(WARN_BYTES + 40)
    expect(targets[0].budget).toBe(NOTE_BUDGET)
    // Основание — не слово «тяжёлая», а процент от бюджета, который можно перемерить.
    expect(targets[0].grounds.join(' ')).toContain(`${targets[0].pct}% бюджета заметки`)
  })

  it('одна заметка, найденная ОБЕИМИ эвристиками, — одна цель с двумя основаниями', () => {
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    writeNote(corpusDir, 'light.md', 200)

    const { targets } = propose({ corpusDir, topN: 10 })
    const heavy = targets.filter((t) => t.file === 'heavy.md')

    expect(heavy).toHaveLength(1) // не два дубля
    expect(heavy[0].grounds).toHaveLength(2)
    expect(heavy[0].grounds.join(' ')).toContain('по весу корпуса')
    expect(heavy[0].grounds.join(' ')).toContain('бюджета заметки')
  })

  it('порядок целей детерминирован: тяжелее — раньше, при равенстве — по имени', () => {
    writeNote(corpusDir, 'b-same.md', 1000)
    writeNote(corpusDir, 'a-same.md', 1000)
    writeNote(corpusDir, 'zz-heaviest.md', 3000)

    const first = propose({ corpusDir, topN: 10 }).targets.map((t) => t.file)
    const second = propose({ corpusDir, topN: 10 }).targets.map((t) => t.file)

    expect(first).toEqual(['zz-heaviest.md', 'a-same.md', 'b-same.md'])
    expect(second).toEqual(first) // тот же корпус — тот же ответ
  })

  it('индексы и структурные файлы целями не бывают: их переписывает генератор, не человек', () => {
    writeFileSync(join(corpusDir, 'INDEX-tech.md'), noteText('idx', 4000), 'utf8')
    writeFileSync(join(corpusDir, 'TAGS.md'), noteText('tags', 4000), 'utf8')
    writeNote(corpusDir, 'note.md', 300)

    const { targets } = propose({ corpusDir, topN: 10 })

    expect(targets.map((t) => t.file)).toEqual(['note.md'])
  })
})

describe('compress.mjs — preview не трогает корпус и не затирает чужую правку', () => {
  it('после preview дерево корпуса ВНЕ drafts/ байт-в-байт прежнее', () => {
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    writeNote(corpusDir, 'light.md', 200)

    const before = snapshotOutsideDrafts(corpusDir)
    const report = preview({ corpusDir, topN: 10, now: FROZEN })
    const after = snapshotOutsideDrafts(corpusDir)

    expect(report.total).toBeGreaterThan(0) // preview действительно работал
    expect(after).toEqual(before) // и всё равно не тронул ни байта заметок
    expect(existsSync(report.draftsDir)).toBe(true)
  })

  it('шаблон предложения ложится в drafts/ и несёт цель, числа и маркер незаполненности', () => {
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)

    const report = preview({ corpusDir, topN: 0, now: FROZEN })
    const draft = report.drafts.find((d) => d.target === 'heavy.md')!

    expect(draft.status).toBe('written')
    expect(draft.wrote).toBe(true)
    const text = readFileSync(draft.path, 'utf8')
    expect(text).toContain(`draft_kind: ${DRAFT_KIND}`)
    expect(text).toContain('target: heavy.md')
    expect(text).toContain(`bytes: ${WARN_BYTES + 40}`)
    expect(text).toContain(PROPOSAL_HEADING)
    expect(text).toContain(UNFILLED_MARKER)
  })

  it('второй preview подряд не перезаписывает ничего — каталог черновиков байт-в-байт прежний', () => {
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)

    const first = preview({ corpusDir, topN: 10, now: FROZEN })
    const draftsAfterFirst = snapshotTree(first.draftsDir)
    const second = preview({ corpusDir, topN: 10, now: FROZEN })

    expect(second.drafts.every((d) => d.wrote === false)).toBe(true)
    expect(snapshotTree(first.draftsDir)).toEqual(draftsAfterFirst)
  })

  it('правленный человеком черновик — kept-existing, его байты остаются его байтами', () => {
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    const report = preview({ corpusDir, topN: 0, now: FROZEN })
    const path = report.drafts[0].path

    const edited = readFileSync(path, 'utf8').replace(UNFILLED_MARKER, 'текст, который написал человек')
    writeFileSync(path, edited, 'utf8')

    const again = preview({ corpusDir, topN: 0, now: FROZEN })

    expect(again.drafts[0].status).toBe('kept-existing')
    expect(again.drafts[0].wrote).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(edited) // правка человека цела
  })
})

describe('compress.mjs — дверь применения отказывает словами', () => {
  let draftPath: string
  let original: string

  beforeEach(() => {
    original = writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    const report = preview({ corpusDir, topN: 0, now: FROZEN })
    draftPath = report.drafts[0].path
  })

  /** Заполнить черновик предложенным текстом (как это делает рука человека). */
  function fill(text: string) {
    const draft = readFileSync(draftPath, 'utf8')
    const head = draft.slice(0, draft.indexOf(PROPOSAL_HEADING))
    writeFileSync(draftPath, `${head}${PROPOSAL_HEADING}\n\n${text}`, 'utf8')
  }

  it('подтверждение назвало ДРУГУЮ заметку → отказ, заметка не тронута', () => {
    fill(noteText('heavy', 300))
    const res = apply({ draftPath, corpusDir, confirmFile: 'light.md' })

    expect(res.applied).toBe(false)
    expect(res.reason).toContain('подтверждение не совпало')
    expect(readFileSync(join(corpusDir, 'heavy.md'), 'utf8')).toBe(original)
  })

  it('шаблон не заполнен → отказ, заметка не тронута', () => {
    const res = apply({ draftPath, corpusDir, confirmFile: 'heavy.md' })

    expect(res.applied).toBe(false)
    expect(res.reason).toContain('не заполнен')
    expect(readFileSync(join(corpusDir, 'heavy.md'), 'utf8')).toBe(original)
  })

  it('предложение НЕ МЕНЬШЕ исходного → отказ, и в отказе оба числа', () => {
    const bigger = noteText('heavy', WARN_BYTES + 400)
    fill(bigger)

    const res = apply({ draftPath, corpusDir, confirmFile: 'heavy.md' })

    expect(res.applied).toBe(false)
    expect(res.reason).toContain(`было ${Buffer.byteLength(original, 'utf8')} байт`)
    expect(res.reason).toContain(`предложено ${Buffer.byteLength(bigger, 'utf8')}`)
    expect(readFileSync(join(corpusDir, 'heavy.md'), 'utf8')).toBe(original)
  })

  it('предложенный текст не разбирается как заметка → отказ, заметка не тронута', () => {
    fill('просто строка без фронтматтера\n')

    const res = apply({ draftPath, corpusDir, confirmFile: 'heavy.md' })

    expect(res.applied).toBe(false)
    expect(res.reason).toContain('фронтматтера')
    expect(readFileSync(join(corpusDir, 'heavy.md'), 'utf8')).toBe(original)
  })

  it('заметки-цели больше нет в корпусе → отказ, из черновика её не воскрешают', () => {
    fill(noteText('heavy', 300))
    rmSync(join(corpusDir, 'heavy.md'))

    const res = apply({ draftPath, corpusDir, confirmFile: 'heavy.md' })

    expect(res.applied).toBe(false)
    expect(res.reason).toContain('воскрешать')
    expect(existsSync(join(corpusDir, 'heavy.md'))).toBe(false)
  })
})

describe('compress.mjs — применение и откат одной командой', () => {
  it('валидный меньший текст применяется: заметка переписана, .orig несёт исходник байт-в-байт, маркер на месте', () => {
    const original = writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    const report = preview({ corpusDir, topN: 0, now: FROZEN })
    const draftPath = report.drafts[0].path
    const shorter = noteText('heavy', 300)
    const draft = readFileSync(draftPath, 'utf8')
    writeFileSync(
      draftPath,
      `${draft.slice(0, draft.indexOf(PROPOSAL_HEADING))}${PROPOSAL_HEADING}\n\n${shorter}`,
      'utf8',
    )

    const res = apply({ draftPath, corpusDir, confirmFile: 'heavy.md' })

    expect(res.applied).toBe(true)
    expect(res.bytesBefore).toBe(Buffer.byteLength(original, 'utf8'))
    expect(res.bytesAfter).toBeLessThan(res.bytesBefore)
    // Заметка действительно ужата НА ДИСКЕ.
    expect(Buffer.byteLength(readFileSync(join(corpusDir, 'heavy.md'), 'utf8'), 'utf8')).toBe(res.bytesAfter)
    // Файл отката несёт ИСХОДНИК байт-в-байт — иначе откатывать некуда.
    expect(res.orig).toBe(origPathFor(draftPath))
    expect(readFileSync(res.orig, 'utf8')).toBe(original)
    // Предложение потреблено: маркер на месте, второго применения не будет.
    expect(existsSync(appliedDraftPath(draftPath))).toBe(true)
    expect(apply({ draftPath, corpusDir, confirmFile: 'heavy.md' }).applied).toBe(false)
  })

  it('откат: копия .orig поверх цели возвращает дерево корпуса к байт-идентичному состоянию', () => {
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    writeNote(corpusDir, 'light.md', 200)
    const beforeAll = snapshotOutsideDrafts(corpusDir)

    const report = preview({ corpusDir, topN: 0, now: FROZEN })
    const draftPath = report.drafts[0].path
    const draft = readFileSync(draftPath, 'utf8')
    writeFileSync(
      draftPath,
      `${draft.slice(0, draft.indexOf(PROPOSAL_HEADING))}${PROPOSAL_HEADING}\n\n${noteText('heavy', 300)}`,
      'utf8',
    )
    const res = apply({ draftPath, corpusDir, confirmFile: 'heavy.md' })
    expect(res.applied).toBe(true)
    expect(snapshotOutsideDrafts(corpusDir)).not.toEqual(beforeAll) // применение видно

    // Ровно то, что печатает глагол: скопировать .orig поверх цели.
    writeFileSync(res.target, readFileSync(res.orig, 'utf8'), 'utf8')

    expect(snapshotOutsideDrafts(corpusDir)).toEqual(beforeAll)
  })

  it('после применения preview честно говорит «уже применено», а не предлагает то же во второй раз', () => {
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    const report = preview({ corpusDir, topN: 0, now: FROZEN })
    const draftPath = report.drafts[0].path
    const draft = readFileSync(draftPath, 'utf8')
    writeFileSync(
      draftPath,
      `${draft.slice(0, draft.indexOf(PROPOSAL_HEADING))}${PROPOSAL_HEADING}\n\n${noteText('heavy', 300)}`,
      'utf8',
    )
    expect(apply({ draftPath, corpusDir, confirmFile: 'heavy.md' }).applied).toBe(true)

    // Заметка снова разрослась — цель вернулась, но прошлое предложение уже потреблено.
    writeNote(corpusDir, 'heavy.md', WARN_BYTES + 40)
    const again = preview({ corpusDir, topN: 0, now: FROZEN })

    expect(again.drafts[0].status).toBe('already-applied')
    expect(again.drafts[0].wrote).toBe(false)
  })

  it('черновика нет вовсе → отказ, и он это прямо говорит', () => {
    writeNote(corpusDir, 'heavy.md', 300)
    const res = apply({
      draftPath: draftPathFor(join(corpusDir, 'drafts'), 'heavy.md'),
      corpusDir,
      confirmFile: 'heavy.md',
    })

    expect(res.applied).toBe(false)
    expect(res.reason).toContain('черновика нет')
  })
})
