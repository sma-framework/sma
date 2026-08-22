/**
 * compress.mjs — proposing the COMPRESSION OF NOTE TEXT, and nothing else.
 *
 * THE NICHE, stated so it cannot drift. This module shortens the TEXT of a note
 * that has grown heavy. It does NOT move a record down a layer and it does NOT
 * decide what the corpus is made of:
 *
 *   - demoting an overfull CORE section, splitting an oversized note and moving
 *     a STATE tail into the archive belong to the trim, which already owns them;
 *   - merging two notes that say the same thing, promoting an episode into a
 *     rule and naming a contradiction belong to consolidation, which already
 *     owns them.
 *
 * The first version therefore looks at TWO deterministic signals and no others:
 * the heaviest notes by the corpus token meter, and the notes standing in the
 * warn zone of the per-note byte budget. Near-duplicates and dead weight are
 * DELIBERATELY out of scope — `consolidate` already names the first by subject
 * overlap and `usage` already names the second by the citation ledger, and a
 * third detector saying the same thing in different numbers would be a second
 * yardstick, which this house does not build.
 *
 * NO MODEL RUNS INSIDE THIS VERB. The module measures, names the grounds in
 * numbers and writes a TEMPLATE into drafts/ — the shortened text itself is
 * written by the person or the session agent reading that template. A verb that
 * rewrote memory text on its own would be rewriting something already accepted,
 * with nobody in the loop.
 *
 * Exports:
 *   - propose({corpusDir, topN})            -> {targets} — read-only, deterministic
 *   - preview({corpusDir, topN, draftsDir}) -> {total, drafts, draftsDir} — writes
 *       ONLY inside drafts/, never over a human's edits
 *   - apply({draftPath, corpusDir, confirmFile}) -> the one narrow door back into
 *       the corpus: per-file confirmation, a rollback copy first, refusals in words
 *
 * DESIGN INVARIANTS:
 *   - PREVIEW BY DEFAULT: outside drafts/ not one byte changes until `apply` is
 *     called with a confirmed target (the suite pins the tree byte-for-byte).
 *   - WEIGHT IS NOT RECOMPUTED: the token meter is `corpusStats`, the budget and
 *     the warn fraction are the shipped constants. No number is copied here.
 *   - NO BULK APPLY: there is no export that applies more than one draft. A batch
 *     is something a person types file by file.
 *   - Node built-ins only — no child processes, no network, no model call.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'

import { atomicWriteRaw } from './fs-atomics.mjs'
import { corpusStats } from './economy.mjs'
import { NOTE_BUDGET, BUDGET_WARN_FRACTION } from './constants.mjs'
import { parseNote } from './frontmatter.mjs'
// ONE implementation of what «already applied» looks like on disk, shared with the
// other door out of drafts/ — two copies would drift the day one side learned
// something the other had not.
import { DRAFTS_DIRNAME, appliedDraftPath } from './write-pipeline.mjs'

// ── the draft grammar ────────────────────────────────────────────────────────

/** The marker that says a draft belongs to THIS door and no other. */
export const DRAFT_KIND = 'compress-proposal'

/** The heading the shortened text goes under. */
export const PROPOSAL_HEADING = '## Предлагаемый текст'

/**
 * The unfilled-template marker. Its presence is a refusal: an empty proposal
 * must never be able to overwrite a note that already says something.
 */
export const UNFILLED_MARKER =
  '(не заполнено — впишите сюда ужатый текст заметки ЦЕЛИКОМ, включая фронтматтер; ' +
  'применение откажет, пока маркер на месте)'

/** Byte length, the same reading trim and the size lint take. */
function byteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}

/** Structural files are not notes — the same set every corpus reader uses. */
function isStructuralFile(f) {
  return f === 'MEMORY.md' || f === 'ARCHIVE.md' || f === 'TAGS.md' || /^INDEX-[^/\\]+\.md$/.test(f)
}

/** ISO calendar date (never a clock reading — a draft is compared byte-for-byte). */
function isoDate(now) {
  const d = now instanceof Date ? now : new Date()
  return d.toISOString().slice(0, 10)
}

/** The draft file for one target note. */
export function draftPathFor(draftsDir, noteFile) {
  const stem = String(noteFile).replace(/\.md$/, '')
  return join(draftsDir, `compress-${stem}.md`)
}

/** The rollback copy that is written BEFORE the note is overwritten. */
export function origPathFor(draftPath) {
  return `${draftPath}.orig`
}

// ── propose: the targets, with the grounds in numbers ────────────────────────

/**
 * propose({corpusDir, topN}) -> {targets, budget, warnBytes}
 *
 * Read-only. Two heuristics, merged without duplicates:
 *
 *   1. the top-N heaviest NOTES as the corpus token meter already sorts them
 *      (`corpusStats` — the weight is not recomputed here);
 *   2. every note standing at or above the warn fraction of the per-note byte
 *      budget (the shipped constants, imported, never literals).
 *
 * A note found by both is ONE target carrying BOTH grounds. Order is
 * deterministic: heaviest first, ties by file name.
 *
 * @param {{corpusDir:string, topN?:number}} opts
 * @returns {{targets:Array<{file:string,bytes:number,budget:number,pct:number,grounds:string[]}>,
 *            budget:number, warnBytes:number}}
 */
export function propose({ corpusDir, topN = 10 } = {}) {
  if (typeof corpusDir !== 'string' || corpusDir.trim() === '') {
    throw new Error('compress.propose: corpusDir is required (the .claude/memory directory)')
  }
  const warnBytes = Math.ceil(NOTE_BUDGET * BUDGET_WARN_FRACTION)

  const stats = corpusStats({ corpusDir, topN })
  // Only notes are compressible text: a generated index is rewritten by the
  // generator, and shortening it by hand would be undone on the next build.
  const noteFiles = new Set((stats.notes ?? []).map((n) => n.file))

  /** @type {Map<string, {file:string, bytes:number, grounds:string[]}>} */
  const byFile = new Map()
  const bytesOf = (file) => {
    try {
      return byteLen(readFileSync(join(corpusDir, file), 'utf8'))
    } catch {
      return null
    }
  }
  const add = (file, ground) => {
    if (isStructuralFile(file)) return
    let entry = byFile.get(file)
    if (!entry) {
      const bytes = bytesOf(file)
      if (bytes == null) return
      entry = { file, bytes, grounds: [] }
      byFile.set(file, entry)
    }
    if (!entry.grounds.includes(ground)) entry.grounds.push(ground)
  }

  // 1. the heaviest, in the meter's own order
  let rank = 0
  for (const row of stats.top ?? []) {
    if (!noteFiles.has(row.file)) continue
    rank += 1
    add(row.file, `top-${rank} по весу корпуса (${row.tokens} токенов)`)
  }

  // 2. the warn zone of the per-note byte budget
  for (const row of stats.notes ?? []) {
    const bytes = bytesOf(row.file)
    if (bytes == null || bytes < warnBytes) continue
    add(row.file, `${Math.round((bytes / NOTE_BUDGET) * 100)}% бюджета заметки`)
  }

  const targets = [...byFile.values()]
    .map((t) => ({
      file: t.file,
      bytes: t.bytes,
      budget: NOTE_BUDGET,
      pct: Math.round((t.bytes / NOTE_BUDGET) * 100),
      grounds: t.grounds,
    }))
    .sort((a, b) => b.bytes - a.bytes || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  return { targets, budget: NOTE_BUDGET, warnBytes }
}

// ── preview: the templates, and nothing outside drafts/ ──────────────────────

/** Render one proposal template. Deterministic for a given target + date. */
function renderDraft({ target, today }) {
  return [
    '---',
    `draft_kind: ${DRAFT_KIND}`,
    `target: ${target.file}`,
    `bytes: ${target.bytes}`,
    `budget: ${target.budget}`,
    `pct: ${target.pct}`,
    `grounds: ${target.grounds.join('; ')}`,
    `created: ${today}`,
    '---',
    '',
    PROPOSAL_HEADING,
    '',
    UNFILLED_MARKER,
    '',
  ].join('\n')
}

/**
 * stageDraft — write a template, but NEVER over a human's edits. The three
 * outcomes are the ones the other draft door already takes: `written` (new, or
 * byte-identical to what is on disk), `kept-existing` (different bytes are on
 * disk — somebody filled it in, and a re-preview must not throw that away),
 * `already-applied` (the consumed marker is present).
 */
function stageDraft(draftPath, text) {
  if (existsSync(appliedDraftPath(draftPath))) return { status: 'already-applied', wrote: false }
  if (existsSync(draftPath)) {
    let current = ''
    try {
      current = readFileSync(draftPath, 'utf8')
    } catch {
      current = ''
    }
    if (current === text) return { status: 'written', wrote: false }
    return { status: 'kept-existing', wrote: false }
  }
  atomicWriteRaw(draftPath, text)
  return { status: 'written', wrote: true }
}

/**
 * preview({corpusDir, topN, draftsDir, now}) -> {total, drafts, draftsDir, targets}
 *
 * Puts one template per target into drafts/ and reports what happened to each.
 * OUTSIDE drafts/ this function creates, touches and deletes NOTHING — that is
 * the whole contract, and the suite proves it by comparing the tree byte-for-byte
 * rather than by trusting this sentence.
 *
 * @param {{corpusDir:string, topN?:number, draftsDir?:string, now?:Date}} opts
 */
export function preview({ corpusDir, topN, draftsDir, now } = {}) {
  const { targets, budget, warnBytes } = propose({ corpusDir, topN })
  const staging = draftsDir ?? join(corpusDir, DRAFTS_DIRNAME)
  const today = isoDate(now)

  const drafts = targets.map((target) => {
    const path = draftPathFor(staging, target.file)
    const staged = stageDraft(path, renderDraft({ target, today }))
    return { path, target: target.file, status: staged.status, wrote: staged.wrote }
  })

  return { total: targets.length, drafts, draftsDir: staging, targets, budget, warnBytes }
}

// ── apply: the one narrow door back into the corpus ──────────────────────────

/** Read the draft's own header (a flat `key: value` block between the first fences). */
function readDraftHeader(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n')
  if (!src.startsWith('---\n')) return null
  const close = src.indexOf('\n---\n', 3)
  if (close === -1) return null
  const header = {}
  for (const line of src.slice(4, close + 1).split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line)
    if (m) header[m[1]] = m[2].trim()
  }
  return { header, body: src.slice(close + 5) }
}

/** The shortened text the human wrote under the heading, or null if the section is absent. */
function readProposedText(body) {
  const idx = String(body ?? '').indexOf(PROPOSAL_HEADING)
  if (idx === -1) return null
  return String(body).slice(idx + PROPOSAL_HEADING.length).replace(/^\n+/, '')
}

/**
 * apply({draftPath, corpusDir, confirmFile}) -> {applied, ...}
 *
 * Deliberately paranoid, because this is the only place where a proposal can
 * overwrite something the corpus already accepted:
 *
 *   - `confirmFile` is the acceptance token and must name the draft's own
 *     `target`; a mismatch refuses and writes nothing;
 *   - an unfilled, empty or unparseable proposal refuses;
 *   - a proposal that is NOT smaller than the original refuses, with both
 *     numbers in the refusal — a compression that does not compress is a bug,
 *     not a proposal;
 *   - on success the original note is copied to `<draft>.orig` BEFORE the
 *     overwrite, so the rollback is one copy command, and the draft is consumed
 *     so the same proposal cannot be applied twice.
 *
 * There is no bulk-apply export, by design.
 *
 * @param {{draftPath:string, corpusDir:string, confirmFile:string}} args
 */
export function apply({ draftPath, corpusDir, confirmFile } = {}) {
  if (typeof draftPath !== 'string' || draftPath.trim() === '') {
    throw new Error('compress.apply: draftPath is required')
  }
  if (typeof corpusDir !== 'string' || corpusDir.trim() === '') {
    throw new Error('compress.apply: corpusDir is required (the .claude/memory directory)')
  }
  const refuse = (reason) => ({ applied: false, target: null, orig: null, reason })

  if (!existsSync(draftPath)) {
    return refuse(
      existsSync(appliedDraftPath(draftPath))
        ? `черновик ${basename(draftPath)} уже применён (маркер на месте) — предложение применяется один раз`
        : `черновика нет: ${draftPath}`,
    )
  }

  const parsedDraft = readDraftHeader(readFileSync(draftPath, 'utf8'))
  if (!parsedDraft) return refuse(`черновик ${basename(draftPath)} не несёт заголовка предложения`)
  const { header, body } = parsedDraft

  if (header.draft_kind !== DRAFT_KIND) {
    return refuse(
      `черновик не является предложением ужатия (draft_kind "${header.draft_kind ?? ''}" ≠ "${DRAFT_KIND}")`,
    )
  }
  const declaredTarget = header.target ?? ''
  if (declaredTarget === '') return refuse('черновик не называет заметку-цель')
  if (String(confirmFile ?? '') !== declaredTarget) {
    return refuse(
      `подтверждение не совпало: черновик правит "${declaredTarget}", а --confirm назвал ` +
        `"${String(confirmFile ?? '')}" — приёмка пофайловая, подтверждают именно ту заметку, которую переписывают`,
    )
  }

  const proposed = readProposedText(body)
  if (proposed == null) return refuse(`в черновике нет секции «${PROPOSAL_HEADING}»`)
  const newText = proposed.replace(/\s+$/, '') + '\n'
  if (newText.trim() === '') return refuse('секция предлагаемого текста пуста — ужимать нечем')
  if (proposed.includes(UNFILLED_MARKER)) {
    return refuse('шаблон не заполнен: маркер «не заполнено» на месте — впишите ужатый текст заметки целиком')
  }

  const targetPath = join(corpusDir, declaredTarget)
  if (!existsSync(targetPath)) {
    return refuse(`заметки ${declaredTarget} нет в корпусе — воскрешать её из черновика отказываюсь`)
  }

  try {
    const parsed = parseNote(newText, { file: declaredTarget })
    if (parsed.frontmatter == null) {
      return refuse('предложенный текст не несёт фронтматтера — это не заметка, а фрагмент')
    }
  } catch (err) {
    return refuse(`предложенный текст не разбирается как заметка: ${err.message}`)
  }

  const originalText = readFileSync(targetPath, 'utf8')
  const bytesBefore = byteLen(originalText)
  const bytesAfter = byteLen(newText)
  if (bytesAfter >= bytesBefore) {
    return refuse(
      `предложение не ужимает: было ${bytesBefore} байт, предложено ${bytesAfter} — ` +
        'ужатие обязано быть меньше исходного',
    )
  }

  // The rollback copy goes down FIRST. If the first apply already left one, it
  // owns the rollback — a second copy would overwrite the true original with an
  // already-compressed one.
  const origPath = origPathFor(draftPath)
  if (!existsSync(origPath)) atomicWriteRaw(origPath, originalText)

  atomicWriteRaw(targetPath, newText)

  // Consume the draft: a proposal is applied exactly once.
  const marker = appliedDraftPath(draftPath)
  try {
    renameSync(draftPath, marker)
  } catch {
    atomicWriteRaw(marker, readFileSync(draftPath, 'utf8'))
  }

  return {
    applied: true,
    target: targetPath,
    orig: origPath,
    marker,
    bytesBefore,
    bytesAfter,
    reason: `ужато: ${bytesBefore} → ${bytesAfter} байт`,
  }
}
