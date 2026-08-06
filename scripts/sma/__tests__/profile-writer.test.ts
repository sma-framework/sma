/**
 * Tests for scripts/sma/lib/profile-writer.mjs — the ONE writer of the install
 * profile and its starter corpus notes.
 *
 * The law under test: the profile schema, its serialization and its secret
 * screening live in EXACTLY ONE callable place. The first-run screen and the
 * terminal onboarding both go through this module, so the two paths cannot
 * drift — and byte-identity is PROVEN here, never promised in prose.
 *
 *   - Test 1: the interview map covers every topic screen «Первый запуск» asks
 *     (12 base + 13 optional) and every routed target is a real schema field.
 *   - Test 2: buildProfile is a pure answers -> profile map whose output passes
 *     the existing profile validator (schema v2, profileVersion stamped).
 *   - Test 3: serializeProfile is STABLE — schema key order, 2-space indent,
 *     one trailing newline. Byte-identity rests on this, not on JSON luck.
 *   - Test 4: writeProfile lands .sma/profile.json with exactly those bytes.
 *   - Test 5: IDEMPOTENCE — the same answers written twice produce byte-identical
 *     files (the property the parity test downstream leans on).
 *   - Test 6: SECRET-REJECT — a token-shaped answer is refused by a named error
 *     and NOTHING is written; the discipline the terminal flow already
 *     carried is now mechanical.
 *   - Test 7: OVERWRITE-PROTECTION — an existing profile is never silently
 *     replaced; the explicit flag is the only way through.
 *   - Test 8: an unknown answer key is refused by a named error (no silent drop).
 *   - Test 9: the terminal shape passes through — answers keyed by schema field
 *     land verbatim, so /sma-start keeps writing what it always wrote.
 *   - Test 10: seedCorpusNotes emits notes in the EXISTING note grammar — the five
 *     lint-enforced frontmatter keys, tags registered in the registry it seeds,
 *     bug-lesson notes carrying **Why:** + **How to apply:**.
 *   - Test 11: a corpus that already has a TAGS.md keeps it verbatim; the seed is
 *     byte-idempotent.
 *   - Test 12: the corpus seed refuses a secret too — a secret must not reach git
 *     through the notes door either.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROFILE_VERSION,
  INTERVIEW_MAP,
  buildProfile,
  serializeProfile,
  writeProfile,
  buildCorpusNotes,
  seedCorpusNotes,
  ProfileSecretError,
  ProfileExistsError,
  UnknownAnswerKeyError,
} from '../lib/profile-writer.mjs'
import { PROFILE_SCHEMA, validateProfile } from '../lib/profile.mjs'
import { parseNote, loadTagsRegistry } from '../lib/frontmatter.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-profile-writer-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Answers in the shape screen «Первый запуск» produces — plain language, free text. */
const ANSWERS = {
  about: 'Интернет-магазин детской мебели: заказы, доставка, склад.',
  clients: 'Родители выбирают кроватку и оформляют доставку.',
  core: 'Оплата и оформление заказа ломать нельзя ни при каких условиях.',
  pain: 'Остатки на складе расходятся, отчёты собираю руками.',
  team: 'Я, продавец на телефоне, бухгалтер раз в месяц.',
  flow: 'Проверяю сам и выкладываю вечером.',
  who: 'Решаю я, короткое сообщение в мессенджер после выкладки.',
  window: 'С десяти до восемнадцати по будням.',
  places: 'Сайт магазина и две точки выдачи.',
  done: 'Открывается без ошибок, оплата проходит, письмо приходит.',
  check: 'Цену в корзине и адрес доставки.',
  reject: 'Если цифры не сходятся.',
  small: 'Разные форматы дат мешают сверке.',
  rules: 'Перед выкладкой писать мне.',
  past: 'Письма покупателям ушли дважды.',
  ask: 'Возврат денег и скидка больше десяти процентов.',
}

const profilePath = (root: string) => join(root, '.sma', 'profile.json')

// ─────────────────────────── Test 1 ───────────────────────────

describe('the interview map is the one routing table', () => {
  it('covers every screen topic and routes only into real schema fields', () => {
    const keys = Object.keys(INTERVIEW_MAP)
    // 12 base questions + 13 optional topics = the whole of screen «Первый запуск».
    expect(keys.length).toBe(25)

    const schemaFields = new Set(PROFILE_SCHEMA.map((s) => s.field))
    for (const key of keys) {
      const spec = (INTERVIEW_MAP as any)[key]
      expect(typeof spec.label, `${key} needs a human label`).toBe('string')
      expect(spec.label.length, `${key} label must be non-empty`).toBeGreaterThan(0)
      expect(spec.step, `${key} belongs to one of the four steps`).toBeGreaterThanOrEqual(1)
      expect(spec.step).toBeLessThanOrEqual(4)
      expect(typeof spec.note, `${key} names the corpus note it feeds`).toBe('string')
      if (spec.field) {
        expect(schemaFields.has(spec.field), `${key} routes into unknown field ${spec.field}`).toBe(true)
      }
    }
  })
})

// ─────────────────────────── Test 2 ───────────────────────────

describe('buildProfile', () => {
  it('maps free-text answers onto the schema and validates clean', () => {
    const profile: any = buildProfile(ANSWERS)

    expect(profile.profileVersion).toBe(PROFILE_VERSION)
    // «Где живёт проект» is literally the deploy host.
    expect(profile.deployHost).toBe(ANSWERS.places)
    // «Что отнимает время» / «мелочи» / «не повторять» are the first machine lessons.
    expect(profile.machineLessons).toEqual([ANSWERS.pain, ANSWERS.small, ANSWERS.past])
    // Step «Что значит готово» tunes the working style the context pack prints.
    expect(profile.workingStyle.reviewHabit).toBe(ANSWERS.check)
    expect(profile.workingStyle.doneMeans).toBe(ANSWERS.done)
    expect(profile.workingStyle.rejectWhen).toBe(ANSWERS.reject)
    // Step «Как выкатываете» is free prose — it lands in the free-text field.
    expect(profile.notes).toContain(ANSWERS.flow)
    expect(profile.notes).toContain(ANSWERS.window)

    const { ok, violations } = validateProfile(profile)
    expect(violations).toEqual([])
    expect(ok).toBe(true)
  })

  it('is pure — the same answers always give a deeply equal profile', () => {
    expect(buildProfile(ANSWERS)).toEqual(buildProfile({ ...ANSWERS }))
  })
})

// ─────────────────────────── Test 3 ───────────────────────────

describe('serializeProfile', () => {
  it('is stable: schema key order, 2-space indent, one trailing newline', () => {
    const text = serializeProfile(buildProfile(ANSWERS))

    expect(text.endsWith('}\n')).toBe(true)
    expect(text.endsWith('}\n\n')).toBe(false)
    expect(text).toContain('\n  "profileVersion": 2')

    const emitted = [...text.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1])
    const schemaOrder = PROFILE_SCHEMA.map((s) => s.field).filter((f) => emitted.includes(f))
    expect(emitted).toEqual(schemaOrder)
    // profileVersion leads — the reader learns the shape before the fields.
    expect(emitted[0]).toBe('profileVersion')
  })
})

// ─────────────────────────── Tests 4 + 5 ───────────────────────────

describe('writeProfile', () => {
  it('writes .sma/profile.json with exactly the serialized bytes', () => {
    const res = writeProfile({ answers: ANSWERS, targetDir: dir })

    expect(res.path).toBe(profilePath(dir))
    expect(existsSync(res.path)).toBe(true)
    const onDisk = readFileSync(res.path, 'utf8')
    expect(onDisk).toBe(serializeProfile(buildProfile(ANSWERS)))
    expect(JSON.parse(onDisk).profileVersion).toBe(PROFILE_VERSION)
  })

  it('is idempotent — the same answers written twice are byte-identical', () => {
    writeProfile({ answers: ANSWERS, targetDir: dir })
    const first = readFileSync(profilePath(dir))

    writeProfile({ answers: ANSWERS, targetDir: dir, overwrite: true })
    const second = readFileSync(profilePath(dir))

    expect(Buffer.compare(first, second)).toBe(0)
  })
})

// ─────────────────────────── Test 6 ───────────────────────────

describe('secret rejection', () => {
  it('refuses a token-shaped answer by name and writes nothing', () => {
    const poisoned = { ...ANSWERS, who: 'ключ ghp_0123456789abcdefghijklmnopqrstuvwxyz' }

    expect(() => writeProfile({ answers: poisoned, targetDir: dir })).toThrow(ProfileSecretError)
    expect(existsSync(profilePath(dir))).toBe(false)
  })

  it('leaves an already-written profile untouched when a later answer is a secret', () => {
    writeProfile({ answers: ANSWERS, targetDir: dir })
    const before = readFileSync(profilePath(dir))

    expect(() =>
      writeProfile({
        answers: { ...ANSWERS, rules: 'sk-abcdefghijklmnopqrstuvwx' },
        targetDir: dir,
        overwrite: true,
      }),
    ).toThrow(ProfileSecretError)

    expect(Buffer.compare(before, readFileSync(profilePath(dir)))).toBe(0)
  })
})

// ─────────────────────────── Test 7 ───────────────────────────

describe('overwrite protection', () => {
  it('never replaces an existing profile silently', () => {
    writeProfile({ answers: ANSWERS, targetDir: dir })
    const before = readFileSync(profilePath(dir))

    expect(() => writeProfile({ answers: { about: 'другое' }, targetDir: dir })).toThrow(ProfileExistsError)
    expect(Buffer.compare(before, readFileSync(profilePath(dir)))).toBe(0)
  })
})

// ─────────────────────────── Test 8 ───────────────────────────

describe('unknown answer keys', () => {
  it('are refused by a named error rather than silently dropped', () => {
    expect(() => buildProfile({ ...ANSWERS, favouriteColour: 'синий' })).toThrow(UnknownAnswerKeyError)
  })
})

// ─────────────────────────── Test 9 ───────────────────────────

describe('the terminal shape', () => {
  it('passes schema-field answers through verbatim', () => {
    const profile: any = buildProfile({
      pushTarget: 'github',
      database: 'postgres',
      riskTolerance: 'balanced',
      envVarNames: ['SMA_MAX_1_TOKEN'],
    })

    expect(profile.pushTarget).toBe('github')
    expect(profile.database).toBe('postgres')
    expect(profile.riskTolerance).toBe('balanced')
    expect(profile.envVarNames).toEqual(['SMA_MAX_1_TOKEN'])
    expect(validateProfile(profile).ok).toBe(true)
  })

  it('merges the two shapes without either winning silently', () => {
    const profile: any = buildProfile({ ...ANSWERS, machineLessons: ['старый урок'] })
    expect(profile.machineLessons[0]).toBe('старый урок')
    expect(profile.machineLessons).toContain(ANSWERS.pain)
  })
})

// ─────────────────────────── Tests 10 + 11 ───────────────────────────

describe('seedCorpusNotes', () => {
  it('writes notes in the existing note grammar, with a registry that knows their tags', () => {
    const res = seedCorpusNotes({ answers: ANSWERS, targetDir: dir })

    expect(res.files.length).toBeGreaterThan(0)
    expect(res.registry.created).toBe(true)
    expect(existsSync(res.registry.path)).toBe(true)

    const registry = loadTagsRegistry(res.registry.path)
    expect(registry.missing).toBeUndefined()
    const known = new Set([...registry.area, ...registry.kind])

    let sawBugLesson = false
    for (const file of res.files) {
      const text = readFileSync(file, 'utf8')
      const { frontmatter, body } = parseNote(text, { file })
      expect(frontmatter, `${file} must carry frontmatter`).toBeTruthy()

      const fm: any = frontmatter
      expect(String(fm.description).trim().split(/\s+/).length).toBeGreaterThanOrEqual(5)
      expect(typeof fm.kind).toBe('string')
      expect(Array.isArray(fm.tags)).toBe(true)
      expect(String(fm['use-when']).trim().length).toBeGreaterThan(0)
      expect(Number.isInteger(Number(fm.importance))).toBe(true)
      expect(Number(fm.importance)).toBeGreaterThanOrEqual(1)
      expect(Number(fm.importance)).toBeLessThanOrEqual(10)

      expect(known.has(String(fm.kind)), `kind ${fm.kind} unregistered`).toBe(true)
      for (const tag of fm.tags) {
        expect(known.has(String(tag)), `tag ${tag} unregistered`).toBe(true)
      }

      if (fm.kind === 'bug-lesson') {
        sawBugLesson = true
        expect(body).toMatch(/\*\*Why:\*\*/)
        expect(body).toMatch(/\*\*How to apply:\*\*/)
      }
    }

    // Step «Записная книжка» turns answers into the first lessons.
    expect(sawBugLesson).toBe(true)
    const lesson = res.files.find((f: string) => f.includes('past')) ?? ''
    void lesson
    const all = res.files.map((f: string) => readFileSync(f, 'utf8')).join('\n')
    expect(all).toContain(ANSWERS.past)
    expect(all).toContain(ANSWERS.rules)
    expect(all).toContain(ANSWERS.about)
  })

  it('keeps an existing registry verbatim and is byte-idempotent', () => {
    const memoryDir = join(dir, '.claude', 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const tagsPath = join(memoryDir, 'TAGS.md')
    const mine = '# TAGS — мои\n\n## area\n\n- tech — инфраструктура и сборка проекта.\n- workflow — процесс планирования и исполнения.\n\n## kind\n\n- reference — справка.\n- procedural-rule — правило.\n- bug-lesson — урок из поломки.\n- status — состояние.\n'
    writeFileSync(tagsPath, mine)

    const res = seedCorpusNotes({ answers: ANSWERS, targetDir: dir })
    expect(res.registry.created).toBe(false)
    expect(readFileSync(tagsPath, 'utf8')).toBe(mine)

    const before = res.files.map((f: string) => readFileSync(f))
    const again = seedCorpusNotes({ answers: ANSWERS, targetDir: dir, overwrite: true })
    expect(again.files).toEqual(res.files)
    again.files.forEach((f: string, i: number) => {
      expect(Buffer.compare(before[i], readFileSync(f))).toBe(0)
    })
  })

  it('refuses to seed a secret into the corpus', () => {
    expect(() =>
      seedCorpusNotes({ answers: { ...ANSWERS, past: 'токен ghp_0123456789abcdefghijklmnopqrstuvwxyz' }, targetDir: dir }),
    ).toThrow(ProfileSecretError)
    expect(existsSync(join(dir, '.claude', 'memory'))).toBe(false)
  })

  it('builds nothing for a step nobody answered', () => {
    const notes = buildCorpusNotes({ about: 'только один ответ' })
    expect(notes.length).toBe(1)
    expect(notes[0].file).toContain('project_goal')
  })
})
