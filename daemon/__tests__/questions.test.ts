/**
 * Tests for daemon/src/front/questions.mjs — the parked-discussion engine.
 *
 * A phase parks its open questions in the SAME file the terminal discussion
 * workflow writes, and a person answers them from the screen whenever it suits
 * them. This suite pins that sentence from both ends: the engine reads the
 * workflow's own checkpoint shape, and every answer it writes lands in that shape
 * atomically or does not land at all.
 *
 * The whole engine runs here over an in-memory fs — no real file is created and no
 * socket is opened, which is why this suite belongs with the parallel ones.
 *
 * Direct grep-visible invariants pinned below:
 *   - the engine reads the workflow's own checkpoint, with its options, unchanged
 *   - progress is DERIVED from the artifact on every call, never stored
 *   - an unanswered entry is the queue: open questions come back in file order
 *   - a phase with no parked discussion is zero of zero, not an error
 */

import { describe, it, expect } from 'vitest'

import {
  createQuestions,
  CheckpointFormatError,
  UnknownQuestionError,
  UnknownAnswerKeyError,
  AnswerRejectedError,
  AnswerSecretError,
  MAX_FREE_TEXT,
  PHASES_DIR,
} from '../src/front/questions.mjs'

// ── an in-memory fs: the engine's whole injectable surface, nothing more ──
//
// Paths are normalised to forward slashes so the fixtures read the same on every
// platform; `join` on Windows hands the fake backslashes.

type Fake = {
  existsSync: (p: string) => boolean
  readdirSync: (p: string) => string[]
  readFileSync: (p: string, enc?: string) => string
  mkdirSync: (p: string, opts?: unknown) => void
  writeFileSync: (p: string, text: string) => void
  renameSync: (from: string, to: string) => void
  read: (p: string) => string | undefined
  paths: () => string[]
  writes: string[]
  renames: Array<[string, string]>
}

function makeFakeFs(seed: Record<string, string> = {}): Fake {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const norm = (p: string) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')

  function addDir(p: string) {
    const parts = norm(p).split('/').filter(Boolean)
    let cur = ''
    for (const part of parts) {
      cur = `${cur}/${part}`
      dirs.add(cur)
    }
  }
  function addParents(p: string) {
    const parts = norm(p).split('/')
    parts.pop()
    addDir(parts.join('/'))
  }
  function enoent(p: string) {
    return Object.assign(new Error(`ENOENT: no such file or directory, ${p}`), { code: 'ENOENT' })
  }

  for (const [p, text] of Object.entries(seed)) {
    files.set(norm(p), text)
    addParents(p)
  }

  // Every write and rename is recorded, so the ATOMIC shape of the write is an
  // assertion rather than an assumption: a direct overwrite would leave the same
  // bytes on disk and only the call log tells the two apart.
  const writes: string[] = []
  const renames: Array<[string, string]> = []

  return {
    writes,
    renames,
    existsSync: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    readdirSync: (p) => {
      const base = norm(p)
      if (!dirs.has(base)) throw enoent(base)
      const prefix = `${base}/`
      const out = new Set<string>()
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest !== '') out.add(rest.split('/')[0])
      }
      return [...out]
    },
    readFileSync: (p) => {
      const key = norm(p)
      if (!files.has(key)) throw enoent(key)
      return files.get(key) as string
    },
    mkdirSync: (p) => addDir(p),
    writeFileSync: (p, text) => {
      writes.push(norm(p))
      files.set(norm(p), String(text))
      addParents(p)
    },
    renameSync: (from, to) => {
      const a = norm(from)
      const b = norm(to)
      renames.push([a, b])
      if (!files.has(a)) throw enoent(a)
      files.set(b, files.get(a) as string)
      files.delete(a)
      addParents(to)
    },
    read: (p) => files.get(norm(p)),
    paths: () => [...files.keys()].sort(),
  }
}

const PROJECT = '/proj'
const PHASE_DIR = `${PROJECT}/${PHASES_DIR.replace(/\\/g, '/')}/12-front-workplace`
const CHECKPOINT = `${PHASE_DIR}/12-DISCUSS-CHECKPOINT.json`

/**
 * The workflow's own checkpoint shape, verbatim from its template: two areas, five
 * questions, two of them already answered. The three open ones spell the three
 * spellings of «not answered yet» that a real file carries — an explicit null, an
 * absent field, and a blank string.
 */
function fixture(overrides: Record<string, unknown> = {}) {
  return JSON.stringify(
    {
      phase: '12',
      phase_name: 'front-workplace',
      timestamp: '2026-08-06T20:00:00Z',
      areas_completed: ['Очередь задач'],
      areas_remaining: ['Экран решений'],
      decisions: {
        'Очередь задач': [
          {
            question: 'Как задача попадает в очередь?',
            answer: 'Через дверь постановки',
            options_presented: ['Через дверь постановки', 'Из файла'],
          },
          { question: 'Сколько работников разом?', answer: 'Четверо', options_presented: [] },
        ],
        'Экран решений': [
          {
            question: 'Как показывать вопросы?',
            answer: null,
            options_presented: ['Карточками', 'Списком'],
          },
          { question: 'Нужен ли свой ответ?', options_presented: ['Да', 'Нет'] },
          { question: 'Показывать ли номер раунда?', answer: '   ', options_presented: [] },
        ],
      },
      deferred_ideas: [],
      canonical_refs: [],
      ...overrides,
    },
    null,
    2,
  )
}

function engineOver(seed: Record<string, string>) {
  const fs = makeFakeFs(seed)
  return { fs, questions: createQuestions({ projectDir: PROJECT, fsImpl: fs }) }
}

function parked() {
  return engineOver({ [CHECKPOINT]: fixture() })
}

describe('questions.mjs — the engine reads the workflow’s own checkpoint', () => {
  it('finds the parked checkpoint of a phase by its number', () => {
    const { questions } = parked()
    expect(questions.checkpointPath('12')?.replace(/\\/g, '/')).toBe(CHECKPOINT)
  })

  it('finds it by the directory name too — both spellings reach the daemon', () => {
    const { questions } = parked()
    expect(questions.checkpointPath('12-front-workplace')?.replace(/\\/g, '/')).toBe(CHECKPOINT)
    expect(questions.checkpointPath('012')?.replace(/\\/g, '/')).toBe(CHECKPOINT)
  })

  it('reads the questions with the options the workflow presented', () => {
    const { questions } = parked()
    const state = questions.readCheckpoint('12')

    expect(state).not.toBeNull()
    expect(state.questions).toHaveLength(5)

    const withOptions = state.questions[2]
    expect(withOptions.text).toBe('Как показывать вопросы?')
    expect(withOptions.area).toBe('Экран решений')
    expect(withOptions.options).toEqual([
      { id: 'o0', label: 'Карточками' },
      { id: 'o1', label: 'Списком' },
    ])
    expect(withOptions.answered).toBe(false)
    expect(withOptions.answer).toBeNull()

    const answered = state.questions[0]
    expect(answered.answered).toBe(true)
    expect(answered.answer).toBe('Через дверь постановки')
  })

  it('carries the phase’s own name and a DERIVED round — the schema has no round field', () => {
    const { questions } = parked()
    const state = questions.readCheckpoint('12')

    expect(state.phase).toBe('12')
    expect(state.phaseName).toBe('front-workplace')
    // One area has closed, so the round in progress is the second one.
    expect(state.round).toBe(2)
    expect(JSON.parse(fixture())).not.toHaveProperty('round')
  })

  it('every question carries a stable identifier, and identifiers do not collide', () => {
    const { questions } = parked()
    const ids = questions.readCheckpoint('12').questions.map((q: any) => q.id)

    expect(new Set(ids).size).toBe(5)
    // Reading twice hands back the same identifiers — nothing about them is random.
    expect(questions.readCheckpoint('12').questions.map((q: any) => q.id)).toEqual(ids)
  })
})

describe('questions.mjs — progress and the queue are derived from the artifact', () => {
  it('counts two answered of five, and three still open', () => {
    const { questions } = parked()
    expect(questions.progress('12')).toEqual({ open: 3, answered: 2 })
  })

  it('treats an explicit null, an absent field and a blank string all as «still open»', () => {
    const { questions } = parked()
    const open = questions.openQuestions('12')

    expect(open).toHaveLength(3)
    expect(open.map((q: any) => q.text)).toEqual([
      'Как показывать вопросы?',
      'Нужен ли свой ответ?',
      'Показывать ли номер раунда?',
    ])
  })

  it('hands the queue back in FILE order — the first element is the next question', () => {
    const { questions } = parked()
    expect(questions.openQuestions('12')[0].text).toBe('Как показывать вопросы?')
  })

  it('a phase with no parked discussion is zero of zero, not an error', () => {
    const { questions } = engineOver({ [`${PHASE_DIR}/NOTES.md`]: '# notes' })

    expect(questions.checkpointPath('12')).toBeNull()
    expect(questions.readCheckpoint('12')).toBeNull()
    expect(questions.progress('12')).toEqual({ open: 0, answered: 0 })
    expect(questions.openQuestions('12')).toEqual([])
  })

  it('a project with no phases directory at all answers the same way', () => {
    const { questions } = engineOver({})

    expect(questions.progress('99')).toEqual({ open: 0, answered: 0 })
    expect(questions.openQuestions('99')).toEqual([])
  })
})

describe('questions.mjs — a foreign file is NAMED, never crashed through', () => {
  it('torn JSON raises an error carrying the path, instead of silence', () => {
    const { questions } = engineOver({ [CHECKPOINT]: '{"decisions": {' })

    expect(() => questions.readCheckpoint('12')).toThrow(CheckpointFormatError)
    expect(() => questions.readCheckpoint('12')).toThrow(/DISCUSS-CHECKPOINT\.json/)
  })

  it('a decisions map of the wrong type is refused BY FIELD NAME', () => {
    const { questions } = engineOver({ [CHECKPOINT]: fixture({ decisions: ['nope'] }) })

    expect(() => questions.readCheckpoint('12')).toThrow(/decisions/)
  })

  it('an entry without a question is refused by the path of the offending field', () => {
    const { questions } = engineOver({
      [CHECKPOINT]: fixture({ decisions: { 'Экран решений': [{ answer: 'да' }] } }),
    })

    expect(() => questions.readCheckpoint('12')).toThrow(/decisions\["Экран решений"\]\[0\]\.question/)
  })

  it('an answer that is not text is refused by field name — a number is not a decision', () => {
    const { questions } = engineOver({
      [CHECKPOINT]: fixture({ decisions: { Область: [{ question: 'Сколько?', answer: 7 }] } }),
    })

    expect(() => questions.readCheckpoint('12')).toThrow(/\.answer/)
  })

  it('progress refuses a torn file too — a broken artifact never reads as «nothing waiting»', () => {
    const { questions } = engineOver({ [CHECKPOINT]: 'not json at all' })

    expect(() => questions.progress('12')).toThrow(CheckpointFormatError)
    expect(() => questions.openQuestions('12')).toThrow(CheckpointFormatError)
  })
})

describe('questions.mjs — an answer is mirrored ATOMICALLY into the artifact', () => {
  it('writes the answer into the question that asked it, and leaves the rest verbatim', () => {
    const { fs, questions } = parked()
    const target = questions.openQuestions('12')[0]
    const before = JSON.parse(fs.read(CHECKPOINT) as string)

    const result = questions.recordAnswer('12', target.id, { optionId: 'o1' })

    // The stored answer is the option's own wording — the next round reads prose.
    expect(result.answer).toBe('Списком')
    const after = JSON.parse(fs.read(CHECKPOINT) as string)
    expect(after.decisions['Экран решений'][0].answer).toBe('Списком')

    // Every other field of the workflow's file is carried through untouched.
    expect(after.phase).toBe(before.phase)
    expect(after.phase_name).toBe(before.phase_name)
    expect(after.timestamp).toBe(before.timestamp)
    expect(after.areas_completed).toEqual(before.areas_completed)
    expect(after.areas_remaining).toEqual(before.areas_remaining)
    expect(after.decisions['Очередь задач']).toEqual(before.decisions['Очередь задач'])
    expect(after.deferred_ideas).toEqual(before.deferred_ideas)
    expect(after.canonical_refs).toEqual(before.canonical_refs)
  })

  it('the write is a temp sibling renamed over the target — no torn file is ever observed', () => {
    const { fs, questions } = parked()
    const target = questions.openQuestions('12')[0]

    questions.recordAnswer('12', target.id, { freeText: 'Карточками, по одной' })

    // The checkpoint itself was never written to directly.
    expect(fs.writes).toHaveLength(1)
    expect(fs.writes[0]).not.toBe(CHECKPOINT)

    // What was written is a SAME-DIRECTORY sibling, then renamed over the target:
    // a cross-volume rename is not atomic, so the staging directory is the invariant.
    const [staged] = fs.writes
    expect(staged.slice(0, staged.lastIndexOf('/'))).toBe(PHASE_DIR)
    expect(fs.renames).toEqual([[staged, CHECKPOINT]])

    // And nothing of the staging survives: no torn file is ever left behind.
    expect(fs.paths()).toEqual([CHECKPOINT])
  })

  it('accepts free text and moves the counter — the answer becomes part of the record', () => {
    const { questions } = parked()
    const target = questions.openQuestions('12')[0]

    const result = questions.recordAnswer('12', target.id, { freeText: '  Карточками, но по одной  ' })

    expect(result.answer).toBe('Карточками, но по одной')
    expect(result.progress).toEqual({ open: 2, answered: 3 })
    expect(questions.progress('12')).toEqual({ open: 2, answered: 3 })
  })

  it('SURVIVES A RESTART: a fresh engine over the same directory sees the answer', () => {
    const { fs, questions } = parked()
    const target = questions.openQuestions('12')[0]

    questions.recordAnswer('12', target.id, { freeText: 'Карточками' })

    // A brand-new engine — the daemon restarted, nothing carried in memory.
    const restarted = createQuestions({ projectDir: PROJECT, fsImpl: fs })
    expect(restarted.progress('12')).toEqual({ open: 2, answered: 3 })
    const same = restarted.readCheckpoint('12').questions.find((q: any) => q.id === target.id)
    expect(same.answered).toBe(true)
    expect(same.answer).toBe('Карточками')
  })

  it('answers the queue down one question at a time, in file order', () => {
    const { questions } = parked()

    questions.recordAnswer('12', questions.openQuestions('12')[0].id, { optionId: 'o0' })
    expect(questions.openQuestions('12')[0].text).toBe('Нужен ли свой ответ?')

    questions.recordAnswer('12', questions.openQuestions('12')[0].id, { optionId: 'o0' })
    expect(questions.openQuestions('12')[0].text).toBe('Показывать ли номер раунда?')

    questions.recordAnswer('12', questions.openQuestions('12')[0].id, { freeText: 'Да, показывать' })
    expect(questions.openQuestions('12')).toEqual([])
    expect(questions.progress('12')).toEqual({ open: 0, answered: 5 })
  })
})

describe('questions.mjs — a secret NEVER reaches the checkpoint', () => {
  it('refuses a token-shaped answer and writes NOTHING', () => {
    const { fs, questions } = parked()
    const target = questions.openQuestions('12')[0]
    const before = fs.read(CHECKPOINT)

    expect(() =>
      questions.recordAnswer('12', target.id, { freeText: 'ключ sk-abcdefghijklmnop1234567890' }),
    ).toThrow(AnswerSecretError)

    expect(fs.read(CHECKPOINT)).toBe(before)
    expect(questions.progress('12')).toEqual({ open: 3, answered: 2 })
  })

  it('refuses a long opaque run — the entropy screen, not just a known prefix', () => {
    const { fs, questions } = parked()
    const target = questions.openQuestions('12')[0]
    const before = fs.read(CHECKPOINT)

    expect(() =>
      questions.recordAnswer('12', target.id, {
        freeText: 'вот он: aZ3kQ9mB7xR2tL5vN8pW4jH6yC1sD0gF7uK3eA9iO2zX5bT',
      }),
    ).toThrow(AnswerSecretError)

    expect(fs.read(CHECKPOINT)).toBe(before)
  })

  it('the name of an environment variable is a FACT, not a secret — it is accepted', () => {
    const { questions } = parked()
    const target = questions.openQuestions('12')[0]

    const result = questions.recordAnswer('12', target.id, {
      freeText: 'адрес берём из DATABASE_URL, значение не пишем',
    })

    expect(result.answer).toContain('DATABASE_URL')
  })
})

describe('questions.mjs — the answer form refuses by name, before it writes', () => {
  it('an unknown field is refused WITH ITS OWN NAME in the message', () => {
    const { fs, questions } = parked()
    const target = questions.openQuestions('12')[0]
    const before = fs.read(CHECKPOINT)

    expect(() => questions.recordAnswer('12', target.id, { evil: 1 } as any)).toThrow(
      UnknownAnswerKeyError,
    )
    expect(() => questions.recordAnswer('12', target.id, { evil: 1 } as any)).toThrow(/evil/)
    expect(fs.read(CHECKPOINT)).toBe(before)
  })

  it('an answer that is both a choice and a text, or neither, is a contradiction', () => {
    const { questions } = parked()
    const target = questions.openQuestions('12')[0]

    expect(() =>
      questions.recordAnswer('12', target.id, { optionId: 'o0', freeText: 'и то и другое' }),
    ).toThrow(AnswerRejectedError)
    expect(() => questions.recordAnswer('12', target.id, {})).toThrow(AnswerRejectedError)
  })

  it('free text longer than the cap is refused, and the boundary itself is accepted', () => {
    const { questions } = parked()
    const target = questions.openQuestions('12')[0]

    expect(() =>
      questions.recordAnswer('12', target.id, { freeText: 'я'.repeat(MAX_FREE_TEXT + 1) }),
    ).toThrow(AnswerRejectedError)

    const atCap = questions.recordAnswer('12', target.id, { freeText: 'я'.repeat(MAX_FREE_TEXT) })
    expect(atCap.answer).toHaveLength(MAX_FREE_TEXT)
  })

  it('a blank answer is not an answer — the question stays open', () => {
    const { questions } = parked()
    const target = questions.openQuestions('12')[0]

    expect(() => questions.recordAnswer('12', target.id, { freeText: '   \n  ' })).toThrow(
      AnswerRejectedError,
    )
    expect(questions.progress('12')).toEqual({ open: 3, answered: 2 })
  })

  it('an unknown question, and an option nobody offered, are refused by name', () => {
    const { questions } = parked()
    const target = questions.openQuestions('12')[0]

    expect(() => questions.recordAnswer('12', 'nope-7', { optionId: 'o0' })).toThrow(
      UnknownQuestionError,
    )
    expect(() => questions.recordAnswer('12', target.id, { optionId: 'o9' })).toThrow(/o9/)
  })

  it('answering when nothing is parked is refused, and no checkpoint is invented', () => {
    const { fs, questions } = engineOver({ [`${PHASE_DIR}/NOTES.md`]: '# notes' })

    expect(() => questions.recordAnswer('12', 'anything-0', { optionId: 'o0' })).toThrow(
      UnknownQuestionError,
    )
    expect(fs.paths()).toEqual([`${PHASE_DIR}/NOTES.md`])
  })

  it('THE FIRST ANSWER STANDS: answering the same question twice is refused, not overwritten', () => {
    const { fs, questions } = parked()
    const target = questions.openQuestions('12')[0]

    questions.recordAnswer('12', target.id, { freeText: 'первый ответ' })
    const after = fs.read(CHECKPOINT)

    expect(() => questions.recordAnswer('12', target.id, { freeText: 'второй ответ' })).toThrow(
      AnswerRejectedError,
    )
    expect(fs.read(CHECKPOINT)).toBe(after)
    expect(JSON.parse(fs.read(CHECKPOINT) as string).decisions['Экран решений'][0].answer).toBe(
      'первый ответ',
    )
  })

  it('an answer already written by the TERMINAL is equally untouchable', () => {
    const { questions } = parked()
    const answeredByTerminal = questions
      .readCheckpoint('12')
      .questions.find((q: any) => q.answered)

    expect(() =>
      questions.recordAnswer('12', answeredByTerminal.id, { freeText: 'передумал' }),
    ).toThrow(AnswerRejectedError)
  })
})
