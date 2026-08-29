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
 * ═════════════ THE PHASE-CYCLE FACTS THIS MODULE OWNS FOR EVERYONE ═════════════
 * Three things below are NOT about questions, and they live here anyway, for one
 * reason each reader can check: more than one module needs them, and a rule with two
 * copies has two answers the day either is edited.
 *
 *   - `findPhaseDir` — «which directory is phase N». The engine finds a checkpoint
 *     with it; the daemon's exit gate finds the document a stage owes with it; the
 *     read model behind the phase card lists phases with it.
 *   - `CHECKPOINT_SUFFIX` / `EXEC_CHECKPOINT_SUFFIX` — the two files a stage may park.
 *   - `STAGE_ARTIFACTS` — «stage → the document that proves it, and the checkpoint it
 *     may park instead». The map used to be assembled in the tick out of the two
 *     suffixes above, which meant HALF of it lived here and half there; the card that
 *     shows a stage as done has to read the same map the gate closes a stage on, or
 *     the screen and the daemon disagree about the same directory. So the whole map
 *     lives where its halves already did.
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

import { atomicWriteJson } from '../../../scripts/sma/lib/fs-atomics.mjs'
import { secretShaped } from '../../../scripts/sma/lib/profile.mjs'

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

/**
 * The OTHER file this same engine reads: the checkpoint an execute stage parks when it reaches
 * a blocking decision with nobody at the keyboard, `<padded phase>-EXEC-CHECKPOINT.json`.
 *
 * It is a different FILE and the same SHAPE, deliberately. A question asked by a discussion
 * and a question asked by an executor are the same thing to the person answering it, so they
 * ride one parser, one open-question convention and one card. What the execute file adds is a
 * `position` block naming where the stage stopped; every field this module does not read is
 * carried through the writer verbatim, so the extra block costs the engine nothing.
 */
export const EXEC_CHECKPOINT_SUFFIX = '-EXEC-CHECKPOINT.json'

/**
 * BOTH names a parked question can wear, as one frozen list.
 *
 * A door that serves «the questions of this phase» cannot know in advance which stage
 * parked them — a discussion round and an execute stage ask the same person the same kind
 * of question, and the screen renders one card for both. Pointing the engine at a single
 * suffix would therefore make one of the two invisible, silently, with a green suite: the
 * file simply would not be found and the phase would report zero questions waiting.
 *
 * The tick still names ONE suffix at a time, because it is asking about one stage it is
 * running. This list is for the readers that are asking about a PHASE.
 */
export const ALL_CHECKPOINT_SUFFIXES = Object.freeze([CHECKPOINT_SUFFIX, EXEC_CHECKPOINT_SUFFIX])

/**
 * STAGE_ARTIFACTS — «stage → what proves it», the ONE map of the phase cycle.
 *
 * `produces` is the document the stage owes: it is what the daemon's documentary exit gate
 * looks for on disk (and in the history) before it calls a stage done, and it is what the
 * phase card reads to show a stage as done. Those two must be the same question asked twice,
 * never two similar questions — a card that used its own criteria would show a stage the
 * daemon is still failing as finished.
 *
 * `checkpoint` is the file that stage may park INSTEAD, when it reaches a question only a
 * person can answer. `null` means that stage has no parking file of its own.
 *
 * ONE HONEST LIMIT, inherited by every reader: a phase produces MANY plans and MANY
 * summaries, and this map answers «does at least one exist», not «are they all there». The
 * gate has always worked that way; the card says exactly what the gate says, so the screen
 * cannot present a stricter or a looser truth than the machine acts on.
 */
export const STAGE_ARTIFACTS = Object.freeze({
  // a discussion ends in the phase's context file, and PARKS in its own checkpoint
  discuss: Object.freeze({ produces: '-CONTEXT.md', checkpoint: CHECKPOINT_SUFFIX }),
  // planning ends in plan files — one per plan of the phase
  plan: Object.freeze({ produces: '-PLAN.md', checkpoint: null }),
  // the drawing stage ends in the phase's design contract. Documentary, exactly like planning
  // and acceptance: it owes a file and it parks nothing of its own — the question it may reach
  // is settled at its own gate, by a person, before any of the work is dispatched
  design: Object.freeze({ produces: '-DESIGN.md', checkpoint: null }),
  // acceptance ends in the verification record
  verify: Object.freeze({ produces: '-VERIFICATION.md', checkpoint: null }),
  // an execute stage produces CODE (it rides the reverify gate), but it can still stop on a
  // question only a person may answer — and then it parks exactly like a discussion round
  execute: Object.freeze({ produces: '-SUMMARY.md', checkpoint: EXEC_CHECKPOINT_SUFFIX }),
})

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
export function phaseNumberOf(name) {
  const withoutPrefix = String(name ?? '').replace(/^phase-/i, '')
  const match = withoutPrefix.match(/^(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

/**
 * findPhaseDir(dirNames, phaseId) → the directory of one phase among the names of a phases
 * directory, or null. An exact name wins; failing that, the first directory whose leading
 * phase number matches. PURE — the caller owns every filesystem call.
 *
 * Exported because it is the one rule for «which directory is phase N», and more than one
 * reader needs it: the questions engine finds a checkpoint with it, and the daemon's exit
 * gate finds the document a stage was supposed to produce. A second copy of this rule would
 * be a second answer the day a layout changes.
 *
 * @param {string[]} dirNames
 * @param {string|number} phaseId
 * @returns {string|null}
 */
export function findPhaseDir(dirNames, phaseId) {
  const wanted = String(phaseId ?? '').trim()
  if (wanted === '') return null
  const names = (Array.isArray(dirNames) ? dirNames : []).map(String).sort()
  const exact = names.find((name) => name === wanted)
  if (exact) return exact
  const wantedNumber = phaseNumberOf(wanted)
  if (wantedNumber === null) return null
  return names.find((name) => phaseNumberOf(name) === wantedNumber) ?? null
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
 * `checkpointSuffix` selects WHICH checkpoint file(s) the engine reads. It takes one name or
 * a LIST of them, and defaults to the discussion's own. The execute stage's parked question is
 * the same shape in a different file (EXEC_CHECKPOINT_SUFFIX) and is read by the same engine
 * rather than a second copy of it; a caller asking about a PHASE rather than about one running
 * stage passes ALL_CHECKPOINT_SUFFIXES and gets both files as one queue.
 *
 * @param {{projectDir?:string, phasesDir?:string, fsImpl?:object,
 *          checkpointSuffix?:string|string[]}} [args]
 */
export function createQuestions({ projectDir = process.cwd(), phasesDir, fsImpl, checkpointSuffix } = {}) {
  const io = resolveIo(fsImpl)
  const rootDir =
    typeof phasesDir === 'string' && phasesDir.trim() !== '' ? phasesDir : join(projectDir, PHASES_DIR)
  // one name or a list of them; an empty or malformed ask falls back to the discussion's own
  const asked = (Array.isArray(checkpointSuffix) ? checkpointSuffix : [checkpointSuffix])
    .filter((s) => typeof s === 'string' && s.trim() !== '')
  const suffixes = asked.length > 0 ? asked : [CHECKPOINT_SUFFIX]

  /**
   * EVERY checkpoint file of one phase, in the order the suffixes were asked for and
   * alphabetically within a suffix. Empty when nothing is parked.
   *
   * Accepts a phase number («12»), a directory name («12-name», «phase-12-name»), because
   * both spellings reach the daemon from different callers.
   */
  function checkpointPaths(phaseId) {
    const wanted = String(phaseId ?? '').trim()
    if (wanted === '') {
      throw new UnknownQuestionError('не указана фаза — у вопросов дискуссии нет адреса без неё')
    }
    if (!io.existsSync(rootDir)) return []

    const dir = findPhaseDir(io.readdirSync(rootDir), wanted)
    if (!dir) return []

    const phaseDir = join(rootDir, dir)
    if (!io.existsSync(phaseDir)) return []
    const names = io.readdirSync(phaseDir).map(String).sort()
    const found = []
    for (const suffix of suffixes) {
      for (const name of names) {
        if (name.endsWith(suffix)) found.push(join(phaseDir, name))
      }
    }
    return found
  }

  /**
   * The FIRST checkpoint file of one phase, or null when none is parked. Kept as the
   * single-file question every caller before the two-name glob was asking, so a reader that
   * names one suffix sees exactly what it always saw.
   */
  function checkpointPath(phaseId) {
    return checkpointPaths(phaseId)[0] ?? null
  }

  /**
   * Load the raw checkpoint exactly as it sits on disk, or null when there is none.
   * A missing file is silence (no discussion is parked); a torn one is an error —
   * the two must never be confused, because the first is normal and the second is a
   * fact somebody has to see.
   */
  function loadAt(path) {
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

  /** The first parked checkpoint of a phase, exactly as it sits on disk, or null. */
  function loadRaw(phaseId) {
    return loadAt(checkpointPath(phaseId))
  }

  /** Every parked checkpoint of a phase, in glob order. A torn one is still an error. */
  function loadAll(phaseId) {
    const out = []
    for (const path of checkpointPaths(phaseId)) {
      const loaded = loadAt(path)
      if (loaded) out.push(loaded)
    }
    return out
  }

  /**
   * readCheckpoint(phaseId) -> the parked discussion, or null when none is parked.
   *
   * The FIRST parked file, because the fields it carries besides the questions — the round,
   * the areas — belong to ONE round of ONE stage and cannot be merged across two. The queue
   * of QUESTIONS is the thing that spans both files, and `openQuestions` / `progress` /
   * `recordAnswer` below all read every file for exactly that reason.
   *
   * @returns {{phase:string|null, phaseName:string|null, round:number, areasCompleted:string[], areasRemaining:string[], questions:object[], path:string}|null}
   */
  function readCheckpoint(phaseId) {
    const loaded = loadRaw(phaseId)
    if (!loaded) return null
    return { ...parseCheckpoint(loaded.data, loaded.path), path: loaded.path }
  }

  /**
   * allQuestions(phaseId) -> every question this phase has parked, from every checkpoint
   * file the engine was pointed at, each carrying the path of the file that asked it.
   */
  function allQuestions(phaseId) {
    const out = []
    for (const loaded of loadAll(phaseId)) {
      for (const question of parseCheckpoint(loaded.data, loaded.path).questions) {
        out.push({ ...question, path: loaded.path })
      }
    }
    return out
  }

  /**
   * openQuestions(phaseId) -> every question still waiting, in the order the files
   * ask them. The first element is «the next one»; the whole list is the queue the
   * cards render.
   */
  function openQuestions(phaseId) {
    return allQuestions(phaseId).filter((q) => !q.answered)
  }

  /**
   * progress(phaseId) -> {open, answered}. Counted from the artifact on every call —
   * nothing is stored, so it cannot drift from the file it describes. No checkpoint
   * means nothing is waiting, which is zero of zero, not an error.
   */
  function progress(phaseId) {
    let open = 0
    let answered = 0
    for (const question of allQuestions(phaseId)) {
      if (question.answered) answered += 1
      else open += 1
    }
    return { open, answered }
  }

  /**
   * recordAnswer(phaseId, questionId, {optionId?, freeText?}) — answer ONE parked
   * question and write it back into the artifact.
   *
   * The order of the gates is the whole safety story, and it is the same order the
   * first-run interview uses: refuse the shape, refuse the secret, and only then
   * open the file. A refusal at any gate leaves the checkpoint byte-for-byte as it
   * was — including the case where the file was never read at all.
   *
   * An answer is DATA. It is stored verbatim in the artifact and read back by the
   * next round as the workflow's own decision record; it is never concatenated into
   * a prompt from here.
   *
   * @param {string} phaseId
   * @param {string} questionId
   * @param {{optionId?:string, freeText?:string}} input
   */
  function recordAnswer(phaseId, questionId, input = {}) {
    // ── gate 1: the shape of the request ──────────────────────────────────────
    if (!isPlainObject(input)) {
      throw new UnknownAnswerKeyError('ответ передаётся объектом с полем optionId или freeText')
    }
    for (const key of Object.keys(input)) {
      if (key !== 'optionId' && key !== 'freeText') {
        throw new UnknownAnswerKeyError(
          `неизвестное поле ответа «${key}» — форма ответа принимает только optionId или freeText`,
        )
      }
    }

    const hasOption = input.optionId !== undefined && input.optionId !== null
    const hasText = input.freeText !== undefined && input.freeText !== null
    // Exactly one of the two: both set is a contradiction, neither is not an answer.
    if (hasOption === hasText) {
      throw new AnswerRejectedError(
        'ответ — это либо выбранный вариант (optionId), либо свой текст (freeText), ровно одно из двух',
      )
    }

    let text = null
    if (hasText) {
      if (typeof input.freeText !== 'string') {
        throw new AnswerRejectedError('поле freeText должно быть строкой')
      }
      if (input.freeText.length > MAX_FREE_TEXT) {
        throw new AnswerRejectedError(
          `ответ длиннее ${MAX_FREE_TEXT} символов — это уже файл, а файлу место в репозитории, не в записи решения`,
        )
      }
      text = normalizeText(input.freeText)
      if (text === '') {
        throw new AnswerRejectedError('пустой ответ не записывается — вопрос остаётся открытым')
      }

      // ── gate 2: the secret, BEFORE the artifact is opened ────────────────────
      // The heuristic is the product's own, imported rather than copied: one screen,
      // one place. A refusal here means nothing was even read, let alone written.
      if (secretShaped(text)) {
        throw new AnswerSecretError(
          'ответ похож на ключ или токен — в запись решения попадают НАЗВАНИЯ переменных и факты, никогда значение ключа',
        )
      }
    }

    // ── gate 3: the question itself, resolved against the files as they are NOW ────
    // EVERY parked file is searched, not just the first: a phase may have a discussion round
    // and an execute stage waiting at the same time, and an answer belongs to whichever of
    // them asked it. Refusing after one file would refuse a question that plainly exists.
    const parked = loadAll(phaseId)
    if (parked.length === 0) {
      throw new UnknownQuestionError(
        `для фазы «${phaseId}» не припарковано ни одного вопроса — отвечать не на что`,
      )
    }
    let loaded = null
    let state = null
    let question = null
    for (const candidate of parked) {
      const parsed = parseCheckpoint(candidate.data, candidate.path)
      const found = parsed.questions.find((q) => q.id === String(questionId))
      if (found) {
        loaded = candidate
        state = parsed
        question = found
        break
      }
    }
    if (!question) {
      throw new UnknownQuestionError(
        `неизвестный вопрос «${questionId}» — в чекпойнте фазы «${phaseId}» такого нет`,
      )
    }
    if (question.answered) {
      throw new AnswerRejectedError(
        `на вопрос «${questionId}» уже отвечено — прежний ответ не перезаписывается`,
      )
    }

    if (hasOption) {
      const chosen = question.options.find((o) => o.id === String(input.optionId))
      if (!chosen) {
        throw new AnswerRejectedError(
          `вариант «${input.optionId}» вопросу «${questionId}» не предлагался`,
        )
      }
      // The stored answer is the option's own wording: the next round reads `answer`
      // as prose, exactly as it does for an answer typed by hand.
      text = chosen.label
    }

    // ── the write: one field, atomically, everything else carried through ──────
    const next = loaded.data
    next.decisions[question.area][question.index].answer = text
    atomicWriteJson(loaded.path, next, {
      mkdirFn: io.mkdirSync,
      writeFn: io.writeFileSync,
      renameFn: io.renameSync,
    })

    return {
      id: question.id,
      area: question.area,
      answer: text,
      round: state.round,
      progress: progress(phaseId),
    }
  }

  return { checkpointPath, checkpointPaths, readCheckpoint, allQuestions, openQuestions, progress, recordAnswer }
}
