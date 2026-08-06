/**
 * questions.mjs — the parked-discussion engine: the queue of questions a phase is
 * waiting on, and the answers a person gives to them whenever it suits them.
 *
 * WHAT IT IS: a reader and a one-field writer over ONE artifact — the discussion
 * checkpoint the terminal workflow already writes,
 * `.planning/phases/<dir>/<NN>-DISCUSS-CHECKPOINT.json`. A round parks its
 * questions in that file and stops; the person answers them from the screen when it
 * suits them; the next round wakes on the answers. Nothing is asked twice and
 * nothing waits on a terminal being open.
 *
 * THE LAW IT ENFORCES — THE ARTIFACT IS THE ONLY SOURCE OF TRUTH. The screen and
 * the terminal are interchangeable at every step because they are not two stores
 * kept in sync: they are ONE FILE read by two readers. This module caches nothing,
 * remembers nothing between calls, and does not parse the worker's console output —
 * a second source of truth is a source of disagreement, and the file is the one that
 * survives a restart.
 *
 *   terminal /sma-discuss-phase ─┐
 *                                ├─▶ <NN>-DISCUSS-CHECKPOINT.json ─▶ next round
 *   screen «Вопросы»  ───────────┘
 *
 * THE SCHEMA IS NOT OURS TO CHANGE. Every field read here belongs to the workflow's
 * own checkpoint template; this module adds no field and renames none. The one
 * convention it relies on is additive and already legal in that shape: an entry of
 * `decisions[area]` whose `answer` is absent, null or blank is a question still
 * OPEN. The terminal only ever writes entries that already carry an answer, so it
 * cannot produce an open one — and when this module fills one in, the result is
 * byte-for-byte the shape the terminal writes and already knows how to resume from.
 *
 * DESIGN LAWS:
 *   - THE ENGINE ONLY. Questions, cursor, progress, one answer. HTTP handlers live
 *     at the door and rendering lives in the screen — a state machine that can be
 *     driven from a test without a socket is the point.
 *   - THE ONLY THING THIS MODULE WRITES IS AN ANSWER. It does not write CONTEXT.md,
 *     it does not add or complete an area, and it never deletes the checkpoint. The
 *     round lifecycle belongs to the workflow; borrowing one field of it is the
 *     whole mandate.
 *   - THE CURSOR IS DERIVED, NEVER STORED. «What is still open» and «how many of how
 *     many» are counted from the file on every call. A stored counter is a counter
 *     that will one day disagree with the artifact it counts.
 *   - AN ANSWER IS NEVER LOST TO A RESTART. The write is a same-directory temp file
 *     renamed over the target, so a reader sees the previous checkpoint or the new
 *     one, never a torn one.
 *   - SECRETS ARE REFUSED AT THE DOOR. The product's own heuristic runs on free text
 *     BEFORE the checkpoint is even opened: a token typed into a text box must not
 *     survive in a file that is on its way into git.
 *   - UNKNOWN KEYS ARE REFUSED BY NAME. A field the answer form does not offer
 *     throws with its own name in the message instead of landing in a file nobody
 *     reads it from.
 *   - A FOREIGN FILE IS NAMED, NEVER CRASHED THROUGH. Torn JSON, or a shape from
 *     some other tool, raises an error carrying the offending field's path. The
 *     daemon serves many projects and must never die of one bad file on disk.
 *   - AN ANSWER IS DATA, NEVER AN INSTRUCTION. What a person types is stored
 *     verbatim in the artifact and read back by the next round as workflow data. It
 *     is never concatenated into a prompt from here.
 *
 * Node built-ins only; zero npm deps. Every fs call is dependency-injectable.
 */

import {
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** Named error: the file on disk is torn, or carries a shape this engine does not know. */
export class CheckpointFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CheckpointFormatError'
  }
}

/** Named error: no question by that identifier is parked for this phase. */
export class UnknownQuestionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownQuestionError'
  }
}

/** Named error: the answer form was handed a field it does not offer. */
export class UnknownAnswerKeyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownAnswerKeyError'
  }
}

/** Named error: a well-formed request that must not be written (already answered, empty, too long). */
export class AnswerRejectedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AnswerRejectedError'
  }
}

/** Named error: the free text looks like a credential — nothing was written. */
export class AnswerSecretError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AnswerSecretError'
  }
}

/** The workflow's own file name ending — the checkpoint is `<padded phase>-DISCUSS-CHECKPOINT.json`. */
export const CHECKPOINT_SUFFIX = '-DISCUSS-CHECKPOINT.json'

/** Where phases live, relative to a project root. */
export const PHASES_DIR = join('.planning', 'phases')

/**
 * The longest free-text answer accepted. A discussion answer is a sentence or a
 * paragraph; anything past this is a pasted file, and a pasted file belongs in the
 * repository, not in a decision record.
 */
export const MAX_FREE_TEXT = 2000

/** Resolve the injectable fs surface; defaults are the real node:fs calls. */
function resolveIo(fsImpl) {
  const io = fsImpl ?? {}
  return {
    existsSync: io.existsSync ?? fsExistsSync,
    readdirSync: io.readdirSync ?? fsReaddirSync,
    readFileSync: io.readFileSync ?? fsReadFileSync,
    mkdirSync: io.mkdirSync ?? fsMkdirSync,
    writeFileSync: io.writeFileSync ?? fsWriteFileSync,
    renameSync: io.renameSync ?? fsRenameSync,
  }
}

/** A plain object — an array is not one, and neither is null. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trim and normalize line endings; a blank answer is «не ответил», not an empty string. */
function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
}

/**
 * The leading phase number of a directory name, tolerating both layouts in the
 * wild: `12-name`, `012-name`, `phase-12-name`, and decimal phases like `01.1-fix`.
 * Returns null when the name carries no phase number at all.
 */
function phaseNumberOf(name) {
  const withoutPrefix = String(name ?? '').replace(/^phase-/i, '')
  const match = withoutPrefix.match(/^(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

/**
 * A short, stable tag for an area name. Question identifiers are derived rather
 * than stored (there is no field in the schema to store them in), and deriving them
 * from the area's NAME rather than its position means that appending or reordering
 * an area cannot silently point an identifier at somebody else's question: a renamed
 * area stops resolving and says so, which is the honest failure.
 */
function areaTag(area) {
  return createHash('sha1').update(String(area), 'utf8').digest('hex').slice(0, 6)
}

/**
 * Read one entry of `decisions[area]` into the engine's own view, naming the
 * offending field if the shape is foreign.
 */
function parseEntry(entry, area, index, path) {
  const where = `decisions["${area}"][${index}]`
  if (!isPlainObject(entry)) {
    throw new CheckpointFormatError(`${path}: поле ${where} должно быть объектом вопроса`)
  }

  if (typeof entry.question !== 'string' || entry.question.trim() === '') {
    throw new CheckpointFormatError(`${path}: поле ${where}.question должно быть непустой строкой`)
  }

  if (entry.answer !== undefined && entry.answer !== null && typeof entry.answer !== 'string') {
    throw new CheckpointFormatError(`${path}: поле ${where}.answer должно быть строкой или отсутствовать`)
  }

  const presented = entry.options_presented
  if (presented !== undefined && presented !== null && !Array.isArray(presented)) {
    throw new CheckpointFormatError(`${path}: поле ${where}.options_presented должно быть массивом`)
  }
  const labels = Array.isArray(presented) ? presented : []
  labels.forEach((label, optionIndex) => {
    if (typeof label !== 'string') {
      throw new CheckpointFormatError(
        `${path}: поле ${where}.options_presented[${optionIndex}] должно быть строкой`,
      )
    }
  })

  const answer = normalizeText(entry.answer)

  return {
    id: `${areaTag(area)}-${index}`,
    area,
    index,
    text: entry.question,
    options: labels.map((label, optionIndex) => ({ id: `o${optionIndex}`, label })),
    answer: answer === '' ? null : answer,
    answered: answer !== '',
  }
}

/**
 * Read the whole checkpoint into the engine's view. ONLY the template's own fields
 * are touched; anything else in the file is carried along untouched by the writer.
 */
function parseCheckpoint(data, path) {
  if (!isPlainObject(data)) {
    throw new CheckpointFormatError(`${path}: содержимое чекпойнта должно быть объектом`)
  }

  const areasCompleted = data.areas_completed
  if (areasCompleted !== undefined && areasCompleted !== null && !Array.isArray(areasCompleted)) {
    throw new CheckpointFormatError(`${path}: поле areas_completed должно быть массивом`)
  }
  const areasRemaining = data.areas_remaining
  if (areasRemaining !== undefined && areasRemaining !== null && !Array.isArray(areasRemaining)) {
    throw new CheckpointFormatError(`${path}: поле areas_remaining должно быть массивом`)
  }

  const decisions = data.decisions
  if (decisions !== undefined && decisions !== null && !isPlainObject(decisions)) {
    throw new CheckpointFormatError(`${path}: поле decisions должно быть объектом «область → вопросы»`)
  }

  /** @type {ReturnType<typeof parseEntry>[]} */
  const questions = []
  for (const [area, entries] of Object.entries(decisions ?? {})) {
    if (!Array.isArray(entries)) {
      throw new CheckpointFormatError(`${path}: поле decisions["${area}"] должно быть массивом вопросов`)
    }
    entries.forEach((entry, index) => {
      questions.push(parseEntry(entry, area, index, path))
    })
  }

  const completed = Array.isArray(areasCompleted) ? areasCompleted : []

  return {
    phase: typeof data.phase === 'string' || typeof data.phase === 'number' ? String(data.phase) : null,
    phaseName: typeof data.phase_name === 'string' ? data.phase_name : null,
    // DERIVED, never stored: the round in progress is the one after every area that
    // has already closed. There is no `round` field in the schema and this engine
    // does not add one.
    round: completed.length + 1,
    areasCompleted: completed,
    areasRemaining: Array.isArray(areasRemaining) ? areasRemaining : [],
    questions,
  }
}

/**
 * createQuestions({projectDir, phasesDir, fsImpl}) — the parked-discussion engine.
 *
 * `projectDir` is the root of the project being discussed; `phasesDir` overrides the
 * conventional `.planning/phases` beneath it. `fsImpl` is the injectable fs surface,
 * so the whole engine — including the atomic write — runs in a test with no real
 * files and no socket.
 *
 * @param {{projectDir?:string, phasesDir?:string, fsImpl?:object}} [args]
 */
export function createQuestions({ projectDir = process.cwd(), phasesDir, fsImpl } = {}) {
  const io = resolveIo(fsImpl)
  const rootDir =
    typeof phasesDir === 'string' && phasesDir.trim() !== '' ? phasesDir : join(projectDir, PHASES_DIR)

  /**
   * The checkpoint file of one phase, or null when no discussion is parked.
   * Accepts a phase number («12»), a directory name («12-name», «phase-12-name»),
   * because both spellings reach the daemon from different callers.
   */
  function checkpointPath(phaseId) {
    const wanted = String(phaseId ?? '').trim()
    if (wanted === '') {
      throw new UnknownQuestionError('не указана фаза — у вопросов дискуссии нет адреса без неё')
    }
    if (!io.existsSync(rootDir)) return null

    const wantedNumber = phaseNumberOf(wanted)
    const dirs = io.readdirSync(rootDir).map(String).sort()
    const dir =
      dirs.find((name) => name === wanted) ??
      (wantedNumber === null ? undefined : dirs.find((name) => phaseNumberOf(name) === wantedNumber))
    if (!dir) return null

    const phaseDir = join(rootDir, dir)
    if (!io.existsSync(phaseDir)) return null
    const file = io
      .readdirSync(phaseDir)
      .map(String)
      .sort()
      .find((name) => name.endsWith(CHECKPOINT_SUFFIX))
    return file ? join(phaseDir, file) : null
  }

  /**
   * Load the raw checkpoint exactly as it sits on disk, or null when there is none.
   * A missing file is silence (no discussion is parked); a torn one is an error —
   * the two must never be confused, because the first is normal and the second is a
   * fact somebody has to see.
   */
  function loadRaw(phaseId) {
    const path = checkpointPath(phaseId)
    if (!path || !io.existsSync(path)) return null

    let text
    try {
      text = io.readFileSync(path, 'utf8')
    } catch (err) {
      throw new CheckpointFormatError(`${path}: чекпойнт дискуссии не читается — ${err && err.message}`)
    }

    let data
    try {
      data = JSON.parse(text)
    } catch (err) {
      throw new CheckpointFormatError(`${path}: чекпойнт дискуссии не разбирается как JSON — ${err && err.message}`)
    }

    return { path, data }
  }

  /**
   * readCheckpoint(phaseId) -> the parked discussion, or null when none is parked.
   *
   * @returns {{phase:string|null, phaseName:string|null, round:number, areasCompleted:string[], areasRemaining:string[], questions:object[], path:string}|null}
   */
  function readCheckpoint(phaseId) {
    const loaded = loadRaw(phaseId)
    if (!loaded) return null
    return { ...parseCheckpoint(loaded.data, loaded.path), path: loaded.path }
  }

  /**
   * openQuestions(phaseId) -> every question still waiting, in the order the file
   * asks them. The first element is «the next one»; the whole list is the queue the
   * cards render.
   */
  function openQuestions(phaseId) {
    const state = readCheckpoint(phaseId)
    if (!state) return []
    return state.questions.filter((q) => !q.answered)
  }

  /**
   * progress(phaseId) -> {open, answered}. Counted from the artifact on every call —
   * nothing is stored, so it cannot drift from the file it describes. No checkpoint
   * means nothing is waiting, which is zero of zero, not an error.
   */
  function progress(phaseId) {
    const state = readCheckpoint(phaseId)
    if (!state) return { open: 0, answered: 0 }
    let open = 0
    let answered = 0
    for (const question of state.questions) {
      if (question.answered) answered += 1
      else open += 1
    }
    return { open, answered }
  }

  return { checkpointPath, readCheckpoint, openQuestions, progress }
}
