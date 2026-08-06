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

  return {
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
      files.set(norm(p), String(text))
      addParents(p)
    },
    renameSync: (from, to) => {
      const a = norm(from)
      const b = norm(to)
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
