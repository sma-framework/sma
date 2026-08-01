/**
 * Tests for daemon/src/front/onboarding.mjs — the first-run interview engine
 * (D-9.7-16, T-9.7-44).
 *
 * The screen «Первый запуск» asks four steps of plain-language questions and then
 * produces the SAME artifacts the terminal onboarding produces. This suite pins
 * both halves of that sentence: the state machine (one question at a time, a draft
 * that survives a restart, unknown keys refused) and — the main case — that the
 * profile it writes is BYTE-IDENTICAL to the one the writer produces directly.
 * That parity case is the standing guard against a second writer of the schema.
 *
 *   - Test 1: STEPS mirror the screen — four steps, 12 base questions, 13 optional
 *     topics, every key known to the writer's routing table.
 *   - Test 2: a project with no profile needs onboarding, and starts at step 1 q1.
 *   - Test 3: one question at a time — answering advances the cursor across steps.
 *   - Test 4: an unknown key, or a key from another step, is refused by name.
 *   - Test 5: an empty answer is a SKIP — visited, unanswered, cursor moves on.
 *   - Test 6: optional topics — a chip joins the queue, and answering an unadded
 *     chip adds it.
 *   - Test 7: the «Что уже готово» panel derives from what has accumulated.
 *   - Test 8: RESTART — the draft outlives the engine; a new engine over the same
 *     directory resumes with the answers intact.
 *   - Test 9: complete() writes profile + notes, drops the draft, needed -> false.
 *   - Test 10: PARITY — the same answers through complete() and through the writer
 *     called directly give byte-identical `.sma/profile.json`.
 *   - Test 11: complete() delegates — with a writer that writes nothing, NOTHING is
 *     written; the engine has no write path of its own.
 *   - Test 12: a secret-shaped answer is refused at the door and never reaches the
 *     draft on disk (T-9.7-43).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOnboarding, STEPS, UnknownQuestionError } from '../src/front/onboarding.mjs'
import { writeProfile, INTERVIEW_MAP, ProfileSecretError } from '../../scripts/sma/lib/profile-writer.mjs'

let dir: string
let other: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-onboarding-'))
  other = mkdtempSync(join(tmpdir(), 'sma-onboarding-b-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

/** A full pass over the base questions, in screen order. */
const FULL = {
  about: 'Интернет-магазин детской мебели: заказы, доставка, склад.',
  clients: 'Родители выбирают кроватку и оформляют доставку.',
  core: 'Оплата и оформление заказа ломать нельзя.',
  pain: 'Остатки на складе расходятся, отчёты собираю руками.',
  flow: 'Проверяю сам и выкладываю вечером.',
  who: 'Решаю я, сообщение в мессенджер после выкладки.',
  window: 'С десяти до восемнадцати по будням.',
  done: 'Открывается без ошибок и оплата проходит.',
  check: 'Цену в корзине и адрес доставки.',
  reject: 'Если цифры не сходятся.',
  rules: 'Перед выкладкой писать мне.',
  past: 'Письма покупателям ушли дважды.',
}

/** Feed every base answer through the engine, in the order the screen asks them. */
function feedAll(engine: any) {
  for (const step of STEPS) {
    for (const q of step.questions) {
      const text = (FULL as any)[q.key]
      if (text) engine.answer({ step: step.step, key: q.key, text })
    }
  }
}

const draftPath = (root: string) => join(root, '.sma', 'onboarding-draft.json')
const profileFile = (root: string) => join(root, '.sma', 'profile.json')

// ─────────────────────────── Test 1 ───────────────────────────

describe('STEPS mirror the screen', () => {
  it('are the four steps with 12 base questions and 13 optional topics', () => {
    expect(STEPS.map((s: any) => s.label)).toEqual([
      'О проекте',
      'Как выкатываете',
      'Что значит готово',
      'Записная книжка',
    ])
    expect(STEPS.map((s: any) => s.step)).toEqual([1, 2, 3, 4])

    const base = STEPS.flatMap((s: any) => s.questions)
    const extras = STEPS.flatMap((s: any) => s.extras)
    expect(base.length).toBe(12)
    expect(extras.length).toBe(13)

    for (const q of [...base, ...extras]) {
      expect((INTERVIEW_MAP as any)[q.key], `${q.key} is unknown to the writer`).toBeTruthy()
      expect(typeof q.title).toBe('string')
      expect(q.question.length).toBeGreaterThan(0)
      expect(q.hint.length).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────── Tests 2 + 3 ───────────────────────────

describe('the state machine', () => {
  it('needs onboarding when there is no profile and opens on the first question', () => {
    const engine = createOnboarding({ targetDir: dir })
    const state = engine.getState()

    expect(state.needed).toBe(true)
    expect(state.step).toBe(1)
    expect(state.questionIndex).toBe(0)
    expect(state.question.key).toBe('about')
    expect(state.totalAnswered).toBe(0)
  })

  it('asks one question at a time and walks across the steps', () => {
    const engine = createOnboarding({ targetDir: dir })

    engine.answer({ step: 1, key: 'about', text: FULL.about })
    expect(engine.getState().question.key).toBe('clients')

    engine.answer({ step: 1, key: 'clients', text: FULL.clients })
    engine.answer({ step: 1, key: 'core', text: FULL.core })
    engine.answer({ step: 1, key: 'pain', text: FULL.pain })

    const state = engine.getState()
    expect(state.step).toBe(2)
    expect(state.questionIndex).toBe(0)
    expect(state.question.key).toBe('flow')
    expect(state.totalAnswered).toBe(4)
  })

  it('refuses an unknown key and a key that belongs to another step', () => {
    const engine = createOnboarding({ targetDir: dir })

    expect(() => engine.answer({ step: 1, key: 'favourite', text: 'x' })).toThrow(UnknownQuestionError)
    expect(() => engine.answer({ step: 1, key: 'done', text: 'x' })).toThrow(UnknownQuestionError)
    expect(() => engine.answer({ step: 9, key: 'about', text: 'x' })).toThrow(UnknownQuestionError)
    expect(engine.getState().totalAnswered).toBe(0)
  })

  it('treats an empty answer as a skip — visited, unanswered, cursor moves on', () => {
    const engine = createOnboarding({ targetDir: dir })

    engine.answer({ step: 1, key: 'about', text: '   ' })
    const state = engine.getState()

    expect(state.question.key).toBe('clients')
    expect(state.totalAnswered).toBe(0)
    expect(state.answers.about).toBeUndefined()
    expect(state.visited.about).toBe(true)
  })
})

// ─────────────────────────── Test 6 ───────────────────────────

describe('optional topics', () => {
  it('queues a chip and accepts an answer to a chip nobody queued', () => {
    const engine = createOnboarding({ targetDir: dir })

    const chips = engine.getState().extraTopics.filter((t: any) => t.step === 1)
    expect(chips.map((t: any) => t.key)).toEqual(['team', 'tools', 'season', 'goal'])
    expect(chips.every((t: any) => t.added === false)).toBe(true)

    engine.addTopic({ step: 1, key: 'team' })
    const queued = engine.getState().extraTopics.find((t: any) => t.key === 'team')
    expect(queued.added).toBe(true)

    // The added chip is asked after the base questions of its step.
    engine.answer({ step: 1, key: 'about', text: FULL.about })
    engine.answer({ step: 1, key: 'clients', text: FULL.clients })
    engine.answer({ step: 1, key: 'core', text: FULL.core })
    engine.answer({ step: 1, key: 'pain', text: FULL.pain })
    expect(engine.getState().question.key).toBe('team')
    expect(engine.getState().question.optional).toBe(true)

    // Answering a chip nobody queued adds it on the spot.
    engine.answer({ step: 1, key: 'season', text: 'Август и декабрь.' })
    expect(engine.getState().answers.season).toBe('Август и декабрь.')

    expect(() => engine.addTopic({ step: 2, key: 'team' })).toThrow(UnknownQuestionError)
  })
})

// ─────────────────────────── Test 7 ───────────────────────────

describe('the «Что уже готово» panel', () => {
  it('derives from what has accumulated', () => {
    const engine = createOnboarding({ targetDir: dir })

    const atStart = engine.getState().ready
    expect(atStart.length).toBe(3)
    expect(atStart[0].done).toBe(true) // the team exists before the first answer
    expect(atStart[1].done).toBe(false)
    expect(atStart[2].done).toBe(false)

    engine.answer({ step: 2, key: 'flow', text: FULL.flow })
    expect(engine.getState().ready[1].done).toBe(true)

    engine.answer({ step: 4, key: 'rules', text: FULL.rules })
    expect(engine.getState().ready[2].done).toBe(true)
  })
})

// ─────────────────────────── Test 8 ───────────────────────────

describe('the draft', () => {
  it('outlives the engine — a restart resumes where the interview stopped', () => {
    const first = createOnboarding({ targetDir: dir })
    first.answer({ step: 1, key: 'about', text: FULL.about })
    first.answer({ step: 1, key: 'clients', text: FULL.clients })
    expect(existsSync(draftPath(dir))).toBe(true)

    const resumed = createOnboarding({ targetDir: dir })
    const state = resumed.getState()

    expect(state.answers.about).toBe(FULL.about)
    expect(state.answers.clients).toBe(FULL.clients)
    expect(state.question.key).toBe('core')
    expect(state.totalAnswered).toBe(2)
  })
})

// ─────────────────────────── Tests 9 + 10 + 11 ───────────────────────────

describe('complete()', () => {
  it('writes the profile and the starter notes, drops the draft, and closes the need', () => {
    const engine = createOnboarding({ targetDir: dir })
    feedAll(engine)

    const result = engine.complete()

    expect(existsSync(profileFile(dir))).toBe(true)
    expect(result.profilePath).toBe(profileFile(dir))
    expect(result.notes.length).toBeGreaterThan(0)
    expect(existsSync(draftPath(dir))).toBe(false)
    expect(engine.getState().needed).toBe(false)
    expect(engine.getState().done).toBe(true)

    const profile = JSON.parse(readFileSync(profileFile(dir), 'utf8'))
    expect(profile.profileVersion).toBe(2)
  })

  it('PARITY: the screen and the writer produce byte-identical profiles', () => {
    const engine = createOnboarding({ targetDir: dir })
    feedAll(engine)
    engine.complete()

    writeProfile({ answers: FULL, targetDir: other })

    const fromScreen = readFileSync(profileFile(dir))
    const fromWriter = readFileSync(profileFile(other))
    expect(Buffer.compare(fromScreen, fromWriter)).toBe(0)
  })

  it('delegates every write — an inert writer leaves the disk empty', () => {
    const calls: string[] = []
    const inert = {
      writeProfile: (args: any) => {
        calls.push('writeProfile')
        expect(args.answers.about).toBe(FULL.about)
        return { path: join(args.targetDir, '.sma', 'profile.json'), profile: {}, text: '' }
      },
      seedCorpusNotes: (args: any) => {
        calls.push('seedCorpusNotes')
        return { dir: args.targetDir, files: [], registry: { path: '', created: false } }
      },
    }

    const engine = createOnboarding({ targetDir: dir, writer: inert })
    feedAll(engine)
    engine.complete()

    expect(calls).toEqual(['writeProfile', 'seedCorpusNotes'])
    expect(existsSync(profileFile(dir))).toBe(false)
    expect(existsSync(join(dir, '.claude', 'memory'))).toBe(false)
  })
})

// ─────────────────────────── Test 12 ───────────────────────────

describe('secrets at the door (T-9.7-43)', () => {
  it('refuses a secret-shaped answer before it reaches the draft', () => {
    const engine = createOnboarding({ targetDir: dir })
    engine.answer({ step: 1, key: 'about', text: FULL.about })

    expect(() =>
      engine.answer({ step: 1, key: 'clients', text: 'ключ ghp_0123456789abcdefghijklmnopqrstuvwxyz' }),
    ).toThrow(ProfileSecretError)

    expect(engine.getState().answers.clients).toBeUndefined()
    expect(readFileSync(draftPath(dir), 'utf8')).not.toContain('ghp_')
  })
})
