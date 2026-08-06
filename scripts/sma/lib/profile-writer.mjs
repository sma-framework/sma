/**
 * profile-writer.mjs — the ONE writer of the install profile and its starter
 * corpus notes.
 *
 * WHAT IT IS: the callable form of a contract that used to live only as PROSE in
 * `sma-core/workflows/sma-start.md`. That workflow told an agent what
 * `.sma/profile.json` should contain and how the first memory notes should look;
 * the first-run SCREEN needs the same result without an agent reading prose. Two
 * readers of one prose contract is two writers of one schema — and two writers
 * drift. So the schema, the serialization, the secret screening and the starter
 * notes live HERE, and both paths call this module.
 *
 *   terminal  /sma-start ─┐
 *                         ├─▶ writeProfile + seedCorpusNotes ─▶ .sma/profile.json
 *   screen «Первый запуск»┘                                     .claude/memory/*.md
 *
 * WHERE IT LIVES: `scripts/sma/lib/`, not the daemon. The profile schema is the
 * product core's property; the daemon is a CONSUMER of it (the same direction
 * `daemon/src/config.mjs` already imports `fs-atomics.mjs`). No new CLI verb is
 * introduced — the terminal path stays a workflow, which now POINTS here for the
 * schema instead of restating it.
 *
 * DESIGN LAWS:
 *   - ONE SCHEMA, BORROWED NOT COPIED. The field set, the type rules and the
 *     secret heuristic come from `profile.mjs` (PROFILE_SCHEMA / validateProfile /
 *     secretShaped). This module adds the WRITE side only: routing, ordering,
 *     bytes. A field added to `profile.mjs` needs no edit here.
 *   - STABLE SERIALIZATION IS THE MECHANISM OF PARITY. Key order is
 *     PROFILE_SCHEMA order (nested object keys sorted), indent is two spaces,
 *     the file ends in exactly one newline. Byte-identity of the two onboarding
 *     paths is therefore a property of this function, not of luck — and the
 *     downstream parity test compares BYTES, not structures.
 *   - PURE CORE, THIN SHELL. buildProfile / serializeProfile / buildCorpusNotes
 *     are pure functions of their answers: no Date.now(), no random, no network.
 *     Only writeProfile / seedCorpusNotes touch a disk, through the existing
 *     atomic writer, with every fs call dependency-injectable.
 *   - SECRETS NEVER LAND. A secret-shaped answer is refused by a NAMED
 *     error before anything is written — to the profile AND to the corpus, since
 *     both are committed to git. This is the discipline /sma-start already carried
 *     in prose, made mechanical.
 *   - NOTHING IS OVERWRITTEN SILENTLY. An existing profile survives unless the
 *     caller passes `overwrite: true`; an existing tag registry is never touched.
 *
 * Node built-ins only; zero npm deps. No child_process anywhere.
 */

import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync, renameSync as fsRenameSync } from 'node:fs'
import { join } from 'node:path'

import { PROFILE_SCHEMA, validateProfile, secretShaped } from './profile.mjs'
import { serializeNote } from './frontmatter.mjs'
import { atomicWriteRaw } from './fs-atomics.mjs'
import { STARTER_TAGS } from './memory-scaffold.mjs'

/** The schema version this writer stamps — same value `sma-start.md` documents. */
export const PROFILE_VERSION = 2

/** Named error: an answer carried a secret-shaped value. */
export class ProfileSecretError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProfileSecretError'
  }
}

/** Named error: a profile already exists and `overwrite` was not requested. */
export class ProfileExistsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProfileExistsError'
  }
}

/** Named error: the built profile failed the shared validator. */
export class ProfileSchemaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProfileSchemaError'
  }
}

/** Named error: an answer key belongs to neither the schema nor the interview. */
export class UnknownAnswerKeyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownAnswerKeyError'
  }
}

// ─────────────────────────── the routing table ───────────────────────────────
//
// Screen «Первый запуск» asks 12 base questions across four steps plus 13 optional
// topics, all in plain language — «чем занимается проект», not «pushTarget». This
// table is the ONE place that says where each answer goes: into a schema field, or
// into a starter note, or both. Declaration order is the order everything derived
// from it is emitted (machine lessons, the free-text block, the note bodies), so
// the same answers always produce the same bytes.
//
//   field: a PROFILE_SCHEMA field this answer feeds
//   mode:  'string' (the field IS the answer) | 'list' (appended to a string[])
//          | 'notes' (a labelled line of the free-text field)
//   sub:   a sub-key of an object field
//   note:  the starter corpus note this answer's text joins
//
// An answer with no `field` is corpus-only: the profile has no field for «кто
// ваши клиенты», and inventing one would be a dead field the moment it shipped.

/** @typedef {{step:number, label:string, note:string, field?:string, mode?:string, sub?:string}} InterviewSpec */

/** @type {Record<string, InterviewSpec>} */
export const INTERVIEW_MAP = {
  // Шаг 1 — О проекте
  about: { step: 1, label: 'Чем занимается проект', note: 'project_goal' },
  clients: { step: 1, label: 'Клиенты', note: 'project_goal' },
  core: { step: 1, label: 'Что нельзя ломать', note: 'reference_constraints' },
  pain: { step: 1, label: 'Что отнимает время', note: 'bug_lesson_time_sinks', field: 'machineLessons', mode: 'list' },
  team: { step: 1, label: 'Кто помогает', note: 'project_goal' },
  tools: { step: 1, label: 'Где ведёте дела', note: 'project_goal' },
  season: { step: 1, label: 'Сезонность', note: 'project_goal' },
  goal: { step: 1, label: 'Цель на три месяца', note: 'project_goal' },

  // Шаг 2 — Как выкатываете
  flow: { step: 2, label: 'Порядок выкладки', note: 'reference_infra', field: 'notes', mode: 'notes' },
  who: { step: 2, label: 'Кто решает', note: 'reference_infra', field: 'notes', mode: 'notes' },
  window: { step: 2, label: 'Когда можно', note: 'reference_infra', field: 'notes', mode: 'notes' },
  rollback: { step: 2, label: 'Если сломалось', note: 'reference_infra', field: 'notes', mode: 'notes' },
  notify: { step: 2, label: 'Кого предупредить', note: 'reference_infra', field: 'notes', mode: 'notes' },
  places: { step: 2, label: 'Где живёт проект', note: 'reference_infra', field: 'deployHost', mode: 'string' },

  // Шаг 3 — Что значит готово
  done: { step: 3, label: 'Признаки готовой работы', note: 'reference_ready', field: 'workingStyle', sub: 'doneMeans' },
  check: { step: 3, label: 'Что проверяете первым', note: 'reference_ready', field: 'workingStyle', sub: 'reviewHabit' },
  reject: { step: 3, label: 'Когда вернёте назад', note: 'reference_ready', field: 'workingStyle', sub: 'rejectWhen' },
  tone: { step: 3, label: 'Тон текстов', note: 'reference_ready', field: 'workingStyle', sub: 'tone' },
  small: { step: 3, label: 'Мелочи', note: 'reference_ready', field: 'machineLessons', mode: 'list' },
  report: { step: 3, label: 'Как отчитываться', note: 'reference_ready', field: 'workingStyle', sub: 'reportShape' },

  // Шаг 4 — Записная книжка
  rules: { step: 4, label: 'Что запомнить', note: 'rule_remember' },
  past: { step: 4, label: 'Не повторять', note: 'bug_lesson_do_not_repeat', field: 'machineLessons', mode: 'list' },
  words: { step: 4, label: 'Ваши слова', note: 'reference_vocabulary' },
  ask: { step: 4, label: 'Когда спрашивать Вас', note: 'rule_ask_the_owner' },
  people: { step: 4, label: 'Кому писать', note: 'rule_who_to_contact' },
}

const SCHEMA_FIELDS = new Set(PROFILE_SCHEMA.map((s) => s.field))

// ─────────────────────────── answer hygiene ──────────────────────────────────

/** Trim and normalize line endings; a blank answer counts as «не ответил». */
function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim()
}

/** Collect every string leaf of a value (the secret scan walks answers, not just fields). */
function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
  else if (value && typeof value === 'object') for (const k of Object.keys(value)) collectStrings(value[k], out)
}

/**
 * assertNoSecrets(answers) — refuse BEFORE anything is written.
 *
 * The scan covers every answer, including the corpus-only ones: a secret typed
 * into «не повторять» would reach git through a note just as surely as through
 * the profile. The heuristic itself is `profile.mjs`'s — one screen, one place.
 *
 * @param {object} answers
 */
export function assertNoSecrets(answers) {
  const src = answers && typeof answers === 'object' ? answers : {}
  for (const key of Object.keys(src)) {
    const strings = []
    collectStrings(src[key], strings)
    for (const s of strings) {
      if (secretShaped(s)) {
        throw new ProfileSecretError(
          `ответ «${key}» похож на секрет — в профиль и в заметки попадают только НАЗВАНИЯ переменных и факты, никогда значение ключа`,
        )
      }
    }
  }
}

/** Refuse a key that is neither a schema field nor an interview topic. */
function assertKnownKeys(answers) {
  for (const key of Object.keys(answers ?? {})) {
    if (SCHEMA_FIELDS.has(key)) continue
    if (INTERVIEW_MAP[key]) continue
    throw new UnknownAnswerKeyError(
      `неизвестный ключ ответа «${key}» — он не поле профиля и не тема интервью; исправьте ключ или заведите поле в profile.mjs`,
    )
  }
}

// ─────────────────────────── build (pure) ────────────────────────────────────

/**
 * buildProfile(answers) -> profile object. PURE.
 *
 * Two shapes are accepted and merged in a fixed order:
 *   1. schema-field keys, verbatim — the terminal path, which asks field by field;
 *   2. interview keys, routed through INTERVIEW_MAP — the screen, which asks in
 *      plain language.
 * The terminal values are laid down first, so an interview answer ADDS to them
 * rather than silently replacing an explicit one (machine lessons append; the
 * free-text block appends). An unknown key is an error, never a silent drop.
 *
 * @param {object} answers
 * @returns {object}
 */
export function buildProfile(answers = {}) {
  assertKnownKeys(answers)
  const profile = { profileVersion: PROFILE_VERSION }

  // 1. Verbatim schema fields (the terminal path).
  for (const entry of PROFILE_SCHEMA) {
    if (entry.field === 'profileVersion') continue
    const value = answers[entry.field]
    if (value === undefined || value === null) continue
    profile[entry.field] = value
  }

  // 2. Interview answers, in table order — the source of byte-stability.
  const lessons = []
  const freeLines = []
  for (const [key, spec] of Object.entries(INTERVIEW_MAP)) {
    const text = normalizeText(answers[key])
    if (!text) continue
    if (spec.mode === 'list') lessons.push(text)
    else if (spec.mode === 'notes') freeLines.push(`${spec.label}: ${text}`)
    else if (spec.mode === 'string') profile[spec.field] = text
    else if (spec.sub) profile[spec.field] = { ...(profile[spec.field] ?? {}), [spec.sub]: text }
  }

  if (lessons.length) {
    const existing = Array.isArray(profile.machineLessons) ? profile.machineLessons : []
    profile.machineLessons = [...existing, ...lessons]
  }
  if (freeLines.length) {
    const existing = typeof profile.notes === 'string' && profile.notes.trim() ? [profile.notes] : []
    profile.notes = [...existing, ...freeLines].join('\n')
  }

  return profile
}

/** Recursively order a value: arrays keep insertion order, object keys sort. */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key])
    return out
  }
  return value
}

/**
 * serializeProfile(profile) -> the exact bytes of `.sma/profile.json`. PURE.
 *
 * Top-level keys follow PROFILE_SCHEMA order (so `profileVersion` leads and a
 * reader meets the shape before the values); nested object keys are sorted; the
 * indent is two spaces; the text ends in exactly one newline. Every caller that
 * wants byte-identity gets it from HERE.
 *
 * @param {object} profile
 * @returns {string}
 */
export function serializeProfile(profile) {
  const src = profile && typeof profile === 'object' ? profile : {}
  const ordered = {}
  for (const entry of PROFILE_SCHEMA) {
    const value = src[entry.field]
    if (value === undefined || value === null) continue
    ordered[entry.field] = stableValue(value)
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

// ─────────────────────────── starter corpus notes ────────────────────────────
//
// The «Записная книжка» step of the screen — and Stage B/D of the terminal flow —
// promise the same artifact: the user's own answers become the corpus's first
// notes. One fact per file, the exact frontmatter the linter enforces
// (description / kind / tags / use-when / importance), tags drawn only from the
// two UNIVERSAL areas so a registry written by either path already knows them.

/** @typedef {{id:string, file:string, title:string, kind:string, tags:string[], importance:number, description:string, useWhen:string, why?:string, how?:string}} NoteGroup */

/** @type {NoteGroup[]} */
export const NOTE_GROUPS = [
  {
    id: 'project_goal',
    file: 'project_goal.md',
    title: 'Чем занят проект',
    kind: 'status',
    tags: ['workflow', 'status'],
    importance: 9,
    description: 'Проект занимается своим делом для своих клиентов и оценивается их результатом.',
    useWhen: 'Когда нужно понять, ради чего делается задача и кто увидит её результат.',
  },
  {
    id: 'reference_constraints',
    file: 'reference_constraints.md',
    title: 'Что нельзя ломать',
    kind: 'procedural-rule',
    tags: ['workflow', 'procedural-rule'],
    importance: 10,
    description: 'В проекте есть части, которые нельзя ломать ни при каких условиях.',
    useWhen: 'Перед изменением, которое задевает деньги, заказы или письма клиентам.',
  },
  {
    id: 'bug_lesson_time_sinks',
    file: 'bug_lesson_time_sinks.md',
    title: 'Что отнимает время',
    kind: 'bug-lesson',
    tags: ['workflow', 'bug-lesson'],
    importance: 8,
    description: 'Одни и те же места проекта регулярно отнимают время владельца.',
    useWhen: 'Когда планируется работа рядом с местом, которое уже подводило.',
    why: 'Место, которое подводит регулярно, подведёт и в следующий раз — расписание строится вокруг этого, а не вопреки.',
    how: 'Прежде чем трогать это место, проверьте его руками и заложите время на разбор.',
  },
  {
    id: 'reference_infra',
    file: 'reference_infra.md',
    title: 'Как работа попадает к людям',
    kind: 'reference',
    tags: ['tech', 'reference'],
    importance: 8,
    description: 'Порядок выкладки описывает, как изменения доходят до пользователей проекта.',
    useWhen: 'Перед выкладкой, откатом или сообщением о том, что работа готова.',
  },
  {
    id: 'reference_ready',
    file: 'reference_ready.md',
    title: 'Что значит готово',
    kind: 'reference',
    tags: ['workflow', 'reference'],
    importance: 9,
    description: 'Готовой считается работа, которая проходит проверки владельца проекта.',
    useWhen: 'Перед тем как показать работу владельцу и назвать её готовой.',
  },
  {
    id: 'rule_remember',
    file: 'rule_remember.md',
    title: 'Что запомнить на будущее',
    kind: 'procedural-rule',
    tags: ['workflow', 'procedural-rule'],
    importance: 9,
    description: 'Владелец назвал правила, которые действуют в работе постоянно.',
    useWhen: 'В начале любой задачи по этому проекту.',
  },
  {
    id: 'bug_lesson_do_not_repeat',
    file: 'bug_lesson_do_not_repeat.md',
    title: 'Так больше не делаем',
    kind: 'bug-lesson',
    tags: ['workflow', 'bug-lesson'],
    importance: 9,
    description: 'Этот случай уже произошёл и повторять его больше не нужно.',
    useWhen: 'Когда задача похожа на ту, что однажды закончилась плохо.',
    why: 'Случай уже стоил владельцу времени или доверия клиентов — второй раз он стоит дороже.',
    how: 'Найдите в задаче тот же шаг и остановитесь на нём: спросите владельца, прежде чем повторить.',
  },
  {
    id: 'reference_vocabulary',
    file: 'reference_vocabulary.md',
    title: 'Ваши слова',
    kind: 'reference',
    tags: ['workflow', 'reference'],
    importance: 6,
    description: 'У владельца есть свои слова со своим значением внутри проекта.',
    useWhen: 'Когда в задаче встретилось слово владельца и его нужно понять буквально.',
  },
  {
    id: 'rule_ask_the_owner',
    file: 'rule_ask_the_owner.md',
    title: 'Когда спрашивать владельца',
    kind: 'procedural-rule',
    tags: ['workflow', 'procedural-rule'],
    importance: 10,
    description: 'Некоторые решения владелец принимает сам и не делегирует их работникам.',
    useWhen: 'Перед действием, которое стоит денег или видно клиентам.',
  },
  {
    id: 'rule_who_to_contact',
    file: 'rule_who_to_contact.md',
    title: 'Кому писать',
    kind: 'procedural-rule',
    tags: ['workflow', 'procedural-rule'],
    importance: 7,
    description: 'Когда владельца нет на связи, обращаться нужно к названным людям.',
    useWhen: 'Когда решение не ждёт, а владелец недоступен.',
  },
]

/**
 * The starter tag registry now has a THIRD writer — the installer, which
 * scaffolds an empty corpus so `.claude/memory/` exists before any onboarding
 * runs. Three writers of one vocabulary is three dialects waiting to happen, so
 * the constant moved to `memory-scaffold.mjs` and is IMPORTED here: identity,
 * not a copy. Only the two UNIVERSAL areas (`tech`, `workflow`) and the closed
 * kind set — exactly the vocabulary `sma-start.md` prescribes, so seeded notes
 * are registered whichever path wrote the registry.
 */

/**
 * buildCorpusNotes(answers) -> [{file, text}]. PURE.
 *
 * One file per note group that got at least one answer; groups nobody answered
 * are simply absent (never an empty placeholder note). Body lines follow
 * INTERVIEW_MAP order, so the same answers give the same bytes. bug-lesson groups
 * carry the **Why:** + **How to apply:** structure the linter requires.
 *
 * @param {object} answers
 * @returns {{file:string, text:string}[]}
 */
export function buildCorpusNotes(answers = {}) {
  assertKnownKeys(answers)

  /** @type {Map<string, {label:string, text:string}[]>} */
  const byGroup = new Map()
  for (const [key, spec] of Object.entries(INTERVIEW_MAP)) {
    const text = normalizeText(answers[key])
    if (!text) continue
    if (!byGroup.has(spec.note)) byGroup.set(spec.note, [])
    byGroup.get(spec.note).push({ label: spec.label, text })
  }

  const out = []
  for (const group of NOTE_GROUPS) {
    const entries = byGroup.get(group.id)
    if (!entries || entries.length === 0) continue

    const body = [`# ${group.title}`, '']
    for (const entry of entries) {
      body.push(`**${entry.label}:** ${entry.text}`, '')
    }
    if (group.kind === 'bug-lesson') {
      body.push(`**Why:** ${group.why}`, '', `**How to apply:** ${group.how}`, '')
    }

    out.push({
      file: group.file,
      text: serializeNote({
        frontmatter: {
          description: group.description,
          kind: group.kind,
          tags: group.tags,
          'use-when': group.useWhen,
          importance: group.importance,
        },
        body: body.join('\n'),
      }),
    })
  }
  return out
}

// ─────────────────────────── write (the thin shell) ──────────────────────────

/** Resolve the injectable fs surface; defaults are the real node:fs calls. */
function resolveIo(fsImpl) {
  const io = fsImpl ?? {}
  return {
    existsSync: io.existsSync ?? fsExistsSync,
    mkdirSync: io.mkdirSync ?? fsMkdirSync,
    writeFileSync: io.writeFileSync ?? fsWriteFileSync,
    renameSync: io.renameSync ?? fsRenameSync,
  }
}

/**
 * writeProfile({answers, targetDir, fsImpl, overwrite}) — write `.sma/profile.json`.
 *
 * Order matters and is the whole safety story: screen the answers for secrets,
 * build, validate through the SHARED validator, refuse to clobber, and only then
 * write — atomically, through the existing same-dir temp + rename helper. A
 * refusal at any step leaves the disk exactly as it was.
 *
 * @param {{answers:object, targetDir?:string, fsImpl?:object, overwrite?:boolean}} args
 * @returns {{path:string, profile:object, text:string}}
 */
export function writeProfile({ answers, targetDir = process.cwd(), fsImpl, overwrite = false } = {}) {
  const io = resolveIo(fsImpl)

  assertNoSecrets(answers)
  const profile = buildProfile(answers)

  const { ok, violations } = validateProfile(profile)
  if (!ok) {
    const secret = violations.find((v) => v.rule === 'PROFILE-SECRET')
    if (secret) throw new ProfileSecretError(secret.message)
    throw new ProfileSchemaError(violations.map((v) => `${v.rule}: ${v.message}`).join('; '))
  }

  const path = join(targetDir, '.sma', 'profile.json')
  if (io.existsSync(path) && !overwrite) {
    throw new ProfileExistsError(
      `профиль уже существует: ${path} — перезапись только явным флагом overwrite (ответы пользователя не затираются молча)`,
    )
  }

  const text = serializeProfile(profile)
  atomicWriteRaw(path, text, { mkdirFn: io.mkdirSync, writeFn: io.writeFileSync, renameFn: io.renameSync })
  return { path, profile, text }
}

/**
 * seedCorpusNotes({answers, targetDir, fsImpl, overwrite}) — write the starter
 * notes into `.claude/memory/`, plus the tag registry when the corpus has none.
 *
 * An EXISTING `TAGS.md` is never touched: the user's own vocabulary outranks a
 * starter one. Notes are refused, not merged, when they already exist unless
 * `overwrite` is set — the same «never clobber an answer» posture as the profile.
 * The caller still regenerates the index (`sma build-index --write`); this module
 * writes files and shells out to nothing.
 *
 * @param {{answers:object, targetDir?:string, fsImpl?:object, overwrite?:boolean}} args
 * @returns {{dir:string, files:string[], registry:{path:string, created:boolean}}}
 */
export function seedCorpusNotes({ answers, targetDir = process.cwd(), fsImpl, overwrite = false } = {}) {
  const io = resolveIo(fsImpl)

  assertNoSecrets(answers)
  const notes = buildCorpusNotes(answers)

  const dir = join(targetDir, '.claude', 'memory')
  const registryPath = join(dir, 'TAGS.md')
  const writeOpts = { mkdirFn: io.mkdirSync, writeFn: io.writeFileSync, renameFn: io.renameSync }

  if (notes.length === 0) {
    return { dir, files: [], registry: { path: registryPath, created: false } }
  }

  const registryExisted = io.existsSync(registryPath)
  if (!registryExisted) atomicWriteRaw(registryPath, STARTER_TAGS, writeOpts)

  const files = []
  for (const note of notes) {
    const path = join(dir, note.file)
    if (io.existsSync(path) && !overwrite) {
      files.push(path)
      continue // an existing note is the user's — never silently replaced
    }
    atomicWriteRaw(path, note.text, writeOpts)
    files.push(path)
  }

  return { dir, files, registry: { path: registryPath, created: !registryExisted } }
}
