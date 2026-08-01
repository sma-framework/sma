/**
 * migrate-v1-v2.mjs — the PREVIEW-ONLY v1 -> v2 migration engine.
 *
 * THE LAW THIS MODULE EXISTS TO ENFORCE (docs/MEMORY-MODEL.md §12.1): migration
 * is preview-only. This tool never rewrites a v1 note in place. It *proposes* a
 * v2 rendering, stages it as a complete draft file, and shows the human a diff.
 * One hundred percent of the v1 corpus stays readable with zero edits — forever,
 * if the owner never accepts a single proposal.
 *
 * Two consequences are load-bearing and must never be softened:
 *
 *   1. `previewMigration` writes into ONE directory: `<corpus>/drafts/`. It has
 *      no other write path at all, and the suite asserts the invariant the only
 *      way it can be trusted — a byte-identity snapshot of the whole canonical
 *      tree taken before and after a full run.
 *
 *   2. `applyProposal` takes ONE draft and ONE explicit confirmation token that
 *      must name the draft's own declared source. There is no bulk-apply export.
 *      A batch is a loop of individually confirmed files, written by the caller,
 *      so "accept all" cannot be typed by accident.
 *
 * WHAT IS MECHANICAL AND WHAT IS NOT. Everything this module does is a
 * deterministic table lookup: the kind seed map (§12), tags -> retrieval.areas
 * 1:1, the importance split, the marker keys. It invents nothing — no authority,
 * no evidence, no fingerprint, no observed_at. A retired note becomes an episode
 * carrying only the MINIMAL archive field set plus a claim-extraction stub whose
 * `claim` is deliberately EMPTY: the stub fails `validateRecord` on purpose, so
 * an unextracted claim physically cannot be applied. Writing that sentence is
 * the agent's (or the human's) job, and it rides this tested rail.
 *
 * Every read and write of note text goes through frontmatter.mjs; every proposal
 * is checked by schema-v2.mjs before it is staged. There is no hand-rolled YAML
 * here and there must never be. Node built-ins only.
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { atomicWriteRaw } from './fs-atomics.mjs'
import { parseNote, serializeNote } from './frontmatter.mjs'
import {
  STATUS_VALUES,
  validateId,
  validateRecord,
} from './schema-v2.mjs'
import {
  EPISODES_DIRNAME,
  EPISODE_MEMORY_TYPE,
  episodeArchiveFields,
  episodeRequiredFields,
  writeEpisode,
} from './episodes.mjs'
import { PERSONAL_PATTERNS } from './write-pipeline.mjs'

/** The ONE staging directory — the product-wide drafts convention. */
export const DRAFTS_DIRNAME = 'drafts'

/**
 * The marker that distinguishes a migration proposal from the other things that
 * live in drafts/ (auto-drafted bug lessons from prediction misses, excavated
 * lessons, mined decisions). It is a DRAFT-only key: `applyProposal` strips
 * every marker before anything is written into the corpus.
 */
export const DRAFT_KIND = 'v2-migration'

/** Keys that exist only while a proposal is a draft. Stripped at apply time. */
export const DRAFT_MARKER_KEYS = Object.freeze(['draft_kind', 'draft_source', 'draft_disposition'])

/** Corpus files that are not notes and are never migration targets. */
const STRUCTURAL_FILES = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

/**
 * KIND_TRANSFORM — the v1 `kind` -> (memory_type, truth_mode) seed map of
 * docs/MEMORY-MODEL.md §12, verbatim. The doc calls it a SEED for a reason: it
 * is confirmed per note by the human at apply time, never assumed.
 *
 * `archive: true` marks the kinds that are history rather than doctrine — those
 * notes are proposed as episodes, not as records (the plan's disposition rule).
 * A `feedback` note (the legacy kind that predates the procedural-rule/bug-lesson
 * split) is resolved by rule strength at transform time — see resolveSeed.
 */
export const KIND_TRANSFORM = Object.freeze({
  'bug-lesson': { memory_type: 'procedural', truth_mode: 'factual' },
  'procedural-rule': { memory_type: 'procedural', truth_mode: 'normative' },
  decision: { memory_type: 'semantic', truth_mode: 'decision' },
  reference: { memory_type: 'semantic', truth_mode: 'factual' },
  feedback: { memory_type: 'preference', truth_mode: 'decision' },
  status: { memory_type: 'episodic', truth_mode: 'observed', archive: true },
  handoff: { memory_type: 'episodic', truth_mode: 'observed', archive: true },
  episodic: { memory_type: 'episodic', truth_mode: 'observed', archive: true },
})

/** An unmapped kind: the least-committal seed the vocabularies allow. */
const DEFAULT_SEED = Object.freeze({ memory_type: 'semantic', truth_mode: 'inferred' })

/**
 * A `feedback` note reads as a NORM rather than a preference when it speaks in
 * standing-rule language. The markers are deliberately few and literal — this is
 * a table lookup, not a classifier, and a wrong guess costs nothing because the
 * human confirms every proposal.
 */
const RULE_STRENGTH_MARKERS = /\b(must|never|always|forbidden|required|hard rule|нельзя|обязательно|всегда|никогда)\b/i

/** Lifecycle states that mean "this is history now". */
const RETIRED_STATUSES = new Set(['superseded', 'revoked', 'expired', 'archived'])

/** v1 fields the transform consumes explicitly — anything else is reported, never guessed at. */
const CONSUMED_V1_KEYS = new Set([
  'description',
  'kind',
  'tags',
  'use-when',
  'use-when-pattern',
  'reflex',
  'importance',
  'predicted_from',
  'excavated_from',
  'valid_from',
  'valid_until',
  'supersedes',
  'superseded_by',
  'superseded_at',
])

// ─────────────────────────── small deterministic helpers ─────────────────────

/** A trimmed string, or '' for anything absent/blank/non-scalar. */
function str(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** UTC date-only stamp. Date-only by design: a preview re-run on the same day is byte-identical. */
function isoDate(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString().slice(0, 10)
}

/**
 * languageOf(text) — D-8-09 requires a language on every record, so every
 * proposal carries one. Script-share, not a language model: the only question a
 * cross-language recall benchmark needs answered is which alphabet the claim is
 * written in, and that is countable.
 */
export function languageOf(text) {
  const s = String(text ?? '')
  const cyrillic = (s.match(/[Ѐ-ӿ]/g) ?? []).length
  const latin = (s.match(/[A-Za-z]/g) ?? []).length
  return cyrillic > latin ? 'ru' : 'en'
}

/**
 * A migrated note is `internal` by default — it lives in the owner's own
 * repository and was never published. It is escalated to `sensitive` when the
 * write pipeline's personal-shape vocabulary matches, so a migration cannot
 * launder a leak into a class the corpus lint stops scanning (the lint's
 * heuristic covers `public` and unclassified records only). The reason is named
 * in the report, so the escalation is visible at acceptance time, not silent.
 */
function classifySensitivity(text) {
  const hits = []
  for (const p of PERSONAL_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.replace('g', ''))
    if (re.test(text)) hits.push(p.rule)
  }
  return hits.length ? { sensitivity: 'sensitive', reasons: hits } : { sensitivity: 'internal', reasons: [] }
}

/**
 * unifiedDiff — a line-based unified diff over the WHOLE file (no hunk elision).
 *
 * The full text is deliberate: threat T-08-07-04 is a silently lossy transform,
 * and a diff that hides context is exactly how a dropped field goes unnoticed.
 * LCS is quadratic, so a pathologically large pair falls back to a whole-file
 * replacement diff rather than hanging a preview run.
 */
export function unifiedDiff(before, after, { fromLabel = 'a', toLabel = 'b' } = {}) {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')
  const head = `--- ${fromLabel}\n+++ ${toLabel}\n`

  if (a.length * b.length > 4_000_000) {
    return head + a.map((l) => `-${l}`).join('\n') + '\n' + b.map((l) => `+${l}`).join('\n') + '\n'
  }

  // Longest common subsequence over lines.
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${a[i]}`)
      i++
    } else {
      out.push(`+${b[j]}`)
      j++
    }
  }
  while (i < n) out.push(`-${a[i++]}`)
  while (j < m) out.push(`+${b[j++]}`)

  return head + out.join('\n') + '\n'
}

// ─────────────────────────── the transform table ─────────────────────────────

/** The (memory_type, truth_mode) seed for a v1 kind, with the feedback split resolved. */
function resolveSeed(kind, text) {
  const seed = KIND_TRANSFORM[kind]
  if (!seed) return { ...DEFAULT_SEED }
  if (kind === 'feedback') {
    return RULE_STRENGTH_MARKERS.test(text)
      ? { memory_type: 'normative', truth_mode: 'normative' }
      : { ...KIND_TRANSFORM.feedback }
  }
  return { ...seed }
}

/** importance -> the two fields §8 seeds from it. An absent importance takes the modest default. */
function splitImportance(raw) {
  const n = Number(str(raw))
  const importance = Number.isFinite(n) ? n : 0
  return {
    criticality: importance >= 8 ? 'high' : 'medium',
    context_priority: importance >= 9 ? 'always' : 'on-demand',
  }
}

/** The retrieval block: areas 1:1 from tags, paths from the precision glob, the trigger kept as a hint. */
function buildRetrieval(fm) {
  const retrieval = {}
  const tags = Array.isArray(fm.tags) ? fm.tags.map((t) => str(t)).filter(Boolean) : []
  if (tags.length) retrieval.areas = tags
  const pattern = str(fm['use-when-pattern'])
  if (pattern) retrieval.paths = [pattern]
  const useWhen = str(fm['use-when'])
  // The doc asks for task_types/paths "where possible, remainder a free-text
  // hint". Parsing prose into facets would be a guess, so the trigger is carried
  // whole: nothing is lost and nothing is invented.
  if (useWhen) retrieval.hint = useWhen
  const reflex = str(fm.reflex)
  if (reflex) retrieval.reflex = reflex
  return Object.keys(retrieval).length ? retrieval : null
}

/** source.refs from the v1 provenance back-links. Authority is NOT invented. */
function buildSource(fm) {
  const refs = []
  const predicted = str(fm.predicted_from)
  if (predicted) refs.push(`prediction:${predicted}`)
  const excavated = str(fm.excavated_from)
  if (excavated) refs.push(`commit:${excavated}`)
  return refs.length ? { refs } : null
}

/** Copy a v1 field onto the v2 record when it is present. */
function carry(target, fm, key) {
  const value = str(fm[key])
  if (value) target[key] = value
}

/**
 * buildV2Record — the mechanical v1 -> v2 rendering of ONE note. Pure: every
 * input is an argument, so two calls with the same arguments produce the same
 * object, which is what makes two preview runs byte-identical.
 */
function buildV2Record({ stem, fm, body, today }) {
  const kind = str(fm.kind)
  const claim = str(fm.description)
  const seed = resolveSeed(kind, `${claim}\n${body}`)
  const { sensitivity, reasons } = classifySensitivity(`${claim}\n${body}`)
  const { criticality, context_priority: contextPriority } = splitImportance(fm.importance)

  const record = {
    id: stem,
    schema_version: '2',
    status: 'active',
    migrated_from: 'v1',
    memory_type: seed.memory_type,
    truth_mode: seed.truth_mode,
    claim,
    language: languageOf(`${claim}\n${body}`),
  }

  const source = buildSource(fm)
  if (source) record.source = source

  record.recorded_at = today
  carry(record, fm, 'valid_from')
  carry(record, fm, 'valid_until')

  record.criticality = criticality
  record.context_priority = contextPriority
  record.sensitivity = sensitivity

  const retrieval = buildRetrieval(fm)
  if (retrieval) record.retrieval = retrieval

  carry(record, fm, 'supersedes')
  carry(record, fm, 'superseded_by')
  carry(record, fm, 'superseded_at')

  return { record, sensitivityReasons: reasons }
}

/**
 * buildEpisodeRecord — the MINIMAL archive rendering. An archived v1 note has no
 * evidence, no fingerprint and no verification plan, and inventing them during
 * an archival pass would fabricate provenance. What an archive genuinely knows
 * is who it is, what state it is in, what replaced it, and when — that list and
 * nothing beyond it (episodes.mjs `episodeArchiveFields`).
 */
function buildEpisodeRecord({ stem, fm, body, today }) {
  const claim = str(fm.description)
  const { sensitivity, reasons } = classifySensitivity(`${claim}\n${body}`)

  const declared = str(fm.status)
  const status = RETIRED_STATUSES.has(declared)
    ? declared
    : str(fm.superseded_by)
      ? 'superseded'
      : 'archived'

  const record = {
    id: stem,
    schema_version: '2',
    memory_type: EPISODE_MEMORY_TYPE,
    status,
  }
  carry(record, fm, 'supersedes')
  carry(record, fm, 'superseded_by')
  carry(record, fm, 'superseded_at')
  record.recorded_at = today
  carry(record, fm, 'valid_from')
  carry(record, fm, 'valid_until')
  record.sensitivity = sensitivity
  record.language = languageOf(`${claim}\n${body}`)

  return { record, sensitivityReasons: reasons }
}

/**
 * buildClaimStub — the record half of an archived note.
 *
 * `claim` is EMPTY on purpose. The stub therefore fails `validateRecord` and
 * `applyProposal` refuses it, which is the whole mechanism: a claim nobody has
 * written yet cannot become memory. Filling that one line is the only
 * agent-authored part of this migration, and it rides the rail this file tests.
 */
function buildClaimStub({ stem, fm, body, today, episodeId }) {
  const claim = str(fm.description)
  const seed = resolveSeed(str(fm.kind), `${claim}\n${body}`)
  const { sensitivity } = classifySensitivity(`${claim}\n${body}`)
  const { criticality, context_priority: contextPriority } = splitImportance(fm.importance)

  const record = {
    id: `${stem}-claim`,
    schema_version: '2',
    status: 'draft',
    migrated_from: 'v1',
    memory_type: seed.memory_type === EPISODE_MEMORY_TYPE ? 'semantic' : seed.memory_type,
    truth_mode: seed.truth_mode,
    claim: '', // fails validateRecord BY DESIGN — an unfilled stub cannot be applied
    language: languageOf(`${claim}\n${body}`),
    recorded_at: today,
    criticality,
    context_priority: contextPriority,
    sensitivity,
    derived_from: episodeId,
  }
  const retrieval = buildRetrieval(fm)
  if (retrieval) record.retrieval = retrieval
  return record
}

/** The human-facing instructions that ride inside a claim stub. */
function stubBody({ stem, claim }) {
  return [
    '',
    '<!--',
    '  CLAIM-EXTRACTION STUB — not a memory record yet, and it cannot become one',
    `  until the empty \`claim:\` above is filled. The history it came from is the`,
    `  episode \`${stem}\` (see derived_from). This file stays in drafts/ until a`,
    '  human accepts it individually, exactly like every other migration proposal.',
    '',
    '  ONE durable sentence. If the note below says several things, that is several',
    '  records — write one stub per claim rather than a list in one field.',
    '-->',
    '',
    '## The v1 note said',
    '',
    claim || '(the v1 note carried no description — read the episode body)',
    '',
  ].join('\n')
}

// ─────────────────────────── draft staging ───────────────────────────────────

/** The draft file for a source stem (and, for the claim half, its `--claim` sibling). */
function draftPathFor(draftsDir, stem, suffix = '') {
  return join(draftsDir, `migration--${stem}${suffix}.md`)
}

/** The consumed-draft marker. Its presence means this proposal was already applied. */
function appliedPathFor(draftPath) {
  return draftPath.replace(/\.md$/, '.applied.md')
}

/**
 * stageDraft — write a draft, but NEVER over a human's edits.
 *
 * Three honest outcomes, the same posture memory-scaffold.mjs and episodes.mjs
 * take: `written` (it was new or byte-identical), `kept-existing` (it is on disk
 * with different bytes — somebody edited it, and a re-preview must not throw
 * that away), `already-applied` (the consumed marker is present).
 */
function stageDraft(draftPath, text) {
  if (existsSync(appliedPathFor(draftPath))) return { draft_status: 'already-applied', written: false }
  if (existsSync(draftPath)) {
    const current = readFileSync(draftPath, 'utf8')
    if (current === text) return { draft_status: 'written', written: false }
    return { draft_status: 'kept-existing', written: false }
  }
  atomicWriteRaw(draftPath, text)
  return { draft_status: 'written', written: true }
}

/** Serialize a proposal into a complete draft file carrying the marker keys. */
function renderDraft({ record, body, sourceFile, disposition }) {
  const frontmatter = {
    ...record,
    draft_kind: DRAFT_KIND,
    draft_source: sourceFile,
    draft_disposition: disposition,
  }
  return serializeNote({ frontmatter, body, schemaVersion: 2 })
}

/** Strip the draft-only marker keys — nothing here may reach the corpus. */
export function stripDraftMarkers(frontmatter) {
  const out = { ...frontmatter }
  for (const key of DRAFT_MARKER_KEYS) delete out[key]
  return out
}

/**
 * The legality of an EPISODE proposal. Episodes carry no `claim`, so
 * `validateRecord` would reject every one of them — 08-05's contract note #3.
 * The lighter rule (episodes.mjs + MEM-EPISODE) is the one that applies.
 */
function validateEpisodeRecord(record, file) {
  const errors = []
  const warnings = []
  const idError = validateId(record.id, file)
  if (idError) errors.push(idError)
  if (String(record.schema_version) !== '2') errors.push('schema_version: an episode is a schema v2 record')
  if (record.memory_type !== EPISODE_MEMORY_TYPE) {
    errors.push(`memory_type: an episode is "${EPISODE_MEMORY_TYPE}" by definition`)
  }
  if (!STATUS_VALUES.includes(record.status)) {
    errors.push(`status: "${record.status}" is outside the closed vocabulary (${STATUS_VALUES.join(' · ')})`)
  }
  for (const field of episodeRequiredFields) {
    if (str(record[field]) === '') errors.push(`${field}: required — the minimal archive field set`)
  }
  for (const key of Object.keys(record)) {
    if (!episodeArchiveFields.includes(key)) {
      warnings.push(`${key}: outside the minimal archive field set — an archive invents nothing`)
    }
  }
  return { errors, warnings }
}

// ─────────────────────────── the preview engine ──────────────────────────────

/** Candidate note files: flat, `.md`, not structural, not a generated index. */
function listNotes(corpusDir) {
  return readdirSync(corpusDir)
    .filter((f) => f.endsWith('.md') && !STRUCTURAL_FILES.has(f) && !f.startsWith('INDEX-'))
    .filter((f) => {
      try {
        return statSync(join(corpusDir, f)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/**
 * previewMigration({corpusDir, draftsDir, now}) -> {proposals, summary}
 *
 * Reads every v1 note, proposes a v2 rendering, stages it in drafts/ and reports
 * the diff plus the validation result. WRITES NOTHING ELSE — that is the module's
 * entire contract and the suite proves it by snapshot rather than by assertion.
 *
 * Each proposal: {source_file, disposition, draft_path, draft_status, validation,
 * diff, target_path, reason, dropped_keys, sensitivity_reasons} and, for an
 * episode disposition, a `stub` carrying the claim-extraction half.
 *
 * @param {{corpusDir:string, draftsDir?:string, now?:Date}} args
 */
export function previewMigration({ corpusDir, draftsDir, now } = {}) {
  if (typeof corpusDir !== 'string' || corpusDir.trim() === '') {
    throw new Error('previewMigration: corpusDir is required (the .claude/memory directory)')
  }
  const staging = draftsDir ?? join(corpusDir, DRAFTS_DIRNAME)
  const today = isoDate(now)

  const proposals = []
  for (const file of listNotes(corpusDir)) {
    proposals.push(previewOne({ corpusDir, staging, file, today }))
  }

  const byDisposition = {}
  for (const p of proposals) byDisposition[p.disposition] = (byDisposition[p.disposition] ?? 0) + 1

  const summary = {
    corpus_dir: corpusDir,
    drafts_dir: staging,
    total: proposals.length,
    by_disposition: byDisposition,
    with_errors: proposals.filter((p) => p.validation && p.validation.errors.length).length,
    with_warnings: proposals.filter((p) => p.validation && p.validation.warnings.length).length,
    stubs_awaiting_extraction: proposals.filter((p) => p.stub).length,
    escalated_sensitivity: proposals.filter((p) => (p.sensitivity_reasons ?? []).length).length,
    recorded_at: today,
  }
  return { proposals, summary }
}

/** One note's proposal. */
function previewOne({ corpusDir, staging, file, today }) {
  const stem = file.slice(0, -3)
  const sourcePath = join(corpusDir, file)
  const sourceText = readFileSync(sourcePath, 'utf8')

  let parsed
  try {
    parsed = parseNote(sourceText, { file })
  } catch (err) {
    return skip(file, `unreadable: ${err.message}`)
  }
  if (parsed.frontmatter == null) return skip(file, 'no frontmatter (structural file)')
  if (parsed.schemaVersion === 2) return skip(file, 'already schema v2 — nothing to migrate')

  const fm = parsed.frontmatter
  const body = parsed.body
  const droppedKeys = Object.keys(fm)
    .filter((k) => !CONSUMED_V1_KEYS.has(k))
    .sort()

  const declaredStatus = str(fm.status)
  const retired =
    RETIRED_STATUSES.has(declaredStatus) ||
    str(fm.superseded_by) !== '' ||
    (str(fm.valid_until) !== '' && str(fm.valid_until) <= today)
  const archiveKind = KIND_TRANSFORM[str(fm.kind)]?.archive === true

  if (retired || archiveKind) {
    return previewEpisode({ staging, file, stem, fm, body, sourceText, today, droppedKeys })
  }
  return previewRecord({ staging, file, stem, fm, body, sourceText, today, droppedKeys })
}

function skip(file, reason) {
  return {
    source_file: file,
    disposition: 'skip',
    draft_path: null,
    draft_status: 'none',
    target_path: null,
    validation: null,
    diff: '',
    reason,
    dropped_keys: [],
    sensitivity_reasons: [],
  }
}

function previewRecord({ staging, file, stem, fm, body, sourceText, today, droppedKeys }) {
  const { record, sensitivityReasons } = buildV2Record({ stem, fm, body, today })
  const proposedText = serializeNote({ frontmatter: record, body, schemaVersion: 2 })
  const draftPath = draftPathFor(staging, stem)
  const draftText = renderDraft({ record, body, sourceFile: file, disposition: 'v2-markup' })
  const staged = stageDraft(draftPath, draftText)

  return {
    source_file: file,
    disposition: 'v2-markup',
    draft_path: draftPath,
    draft_status: staged.draft_status,
    target_path: join(staging, '..', file),
    validation: validateRecord(record),
    diff: unifiedDiff(sourceText, proposedText, { fromLabel: `a/${file}`, toLabel: `b/${file}` }),
    reason: `v1 kind "${str(fm.kind) || '(none)'}" is doctrine — proposed as a schema-v2 record`,
    dropped_keys: droppedKeys,
    sensitivity_reasons: sensitivityReasons,
  }
}

function previewEpisode({ staging, file, stem, fm, body, sourceText, today, droppedKeys }) {
  const { record, sensitivityReasons } = buildEpisodeRecord({ stem, fm, body, today })
  const proposedText = serializeNote({ frontmatter: record, body, schemaVersion: 2 })
  const draftPath = draftPathFor(staging, stem)
  const staged = stageDraft(
    draftPath,
    renderDraft({ record, body, sourceFile: file, disposition: 'episode-archive' }),
  )

  const stubRecord = buildClaimStub({ stem, fm, body, today, episodeId: stem })
  const stubPath = draftPathFor(staging, stem, '--claim')
  const stubText = stubBody({ stem, claim: str(fm.description) })
  const stubStaged = stageDraft(
    stubPath,
    renderDraft({ record: stubRecord, body: stubText, sourceFile: file, disposition: 'claim-stub' }),
  )

  return {
    source_file: file,
    disposition: 'episode-archive',
    draft_path: draftPath,
    draft_status: staged.draft_status,
    target_path: join(staging, '..', EPISODES_DIRNAME, file),
    validation: validateEpisodeRecord(record, file),
    diff: unifiedDiff(sourceText, proposedText, {
      fromLabel: `a/${file}`,
      toLabel: `b/${EPISODES_DIRNAME}/${file}`,
    }),
    reason: RETIRED_STATUSES.has(str(fm.status)) || str(fm.superseded_by)
      ? 'the note declares its own retirement — proposed as an episode archive'
      : `v1 kind "${str(fm.kind)}" is history — proposed as an episode archive`,
    dropped_keys: droppedKeys,
    sensitivity_reasons: sensitivityReasons,
    stub: {
      draft_path: stubPath,
      draft_status: stubStaged.draft_status,
      target_path: join(staging, '..', `${stubRecord.id}.md`),
      // An unfilled stub MUST fail: that refusal is what stops an unwritten
      // claim from becoming memory.
      validation: validateRecord(stubRecord),
      diff: unifiedDiff('', serializeNote({ frontmatter: stubRecord, body: stubText, schemaVersion: 2 }), {
        fromLabel: '/dev/null',
        toLabel: `b/${stubRecord.id}.md`,
      }),
    },
  }
}

// ─────────────────────────── the apply path ──────────────────────────────────

/**
 * applyProposal({draftPath, corpusDir, confirmFile}) -> {applied, target_path, reason}
 *
 * The ONE door from drafts/ into the corpus, and it is deliberately narrow:
 *
 *   - `confirmFile` is the human-acceptance token (D-8-04). It must name the
 *     draft's own `draft_source`. A mismatch refuses and writes nothing.
 *   - A draft whose embedded validation has ERRORS refuses. That is what keeps
 *     an unfilled claim stub in drafts/ where it belongs.
 *   - Applying consumes the draft (renamed with an `.applied` marker), so a
 *     second apply of the same proposal is impossible.
 *
 * There is NO bulk-apply export. A batch is a caller-side loop over individually
 * confirmed files — «accept all» must be something a person types file by file.
 *
 * @param {{draftPath:string, corpusDir:string, confirmFile:string}} args
 */
export function applyProposal({ draftPath, corpusDir, confirmFile } = {}) {
  if (typeof draftPath !== 'string' || draftPath.trim() === '') {
    throw new Error('applyProposal: draftPath is required')
  }
  if (typeof corpusDir !== 'string' || corpusDir.trim() === '') {
    throw new Error('applyProposal: corpusDir is required (the .claude/memory directory)')
  }
  const refuse = (reason) => ({ applied: false, target_path: null, reason })

  if (!existsSync(draftPath)) {
    return refuse(
      existsSync(appliedPathFor(draftPath))
        ? `the draft ${basename(draftPath)} was already applied (consumed marker present) — a proposal is applied once`
        : `no draft at ${draftPath}`,
    )
  }

  let parsed
  try {
    parsed = parseNote(readFileSync(draftPath, 'utf8'), { file: basename(draftPath) })
  } catch (err) {
    return refuse(`the draft cannot be parsed: ${err.message}`)
  }
  if (parsed.frontmatter == null || parsed.schemaVersion !== 2) {
    return refuse('the draft is not a schema-v2 record')
  }

  const fm = parsed.frontmatter
  if (str(fm.draft_kind) !== DRAFT_KIND) {
    return refuse(`the draft is not a migration proposal (draft_kind "${str(fm.draft_kind)}" ≠ "${DRAFT_KIND}")`)
  }

  const declaredSource = str(fm.draft_source)
  const confirmed = basename(str(confirmFile))
  if (confirmed === '' || confirmed !== declaredSource) {
    return refuse(
      `confirmation mismatch: this proposal declares source "${declaredSource}", the confirmation named "${confirmed || '(nothing)'}" — every apply names its own file`,
    )
  }

  const disposition = str(fm.draft_disposition)
  const record = stripDraftMarkers(fm)
  const body = parsed.body

  const validation =
    disposition === 'episode-archive'
      ? validateEpisodeRecord(record, `${str(record.id)}.md`)
      : validateRecord(record)
  if (validation.errors.length) {
    return refuse(`the proposal does not validate — ${validation.errors.length} error(s): ${validation.errors[0]}`)
  }

  let targetPath
  if (disposition === 'episode-archive') {
    const written = writeEpisode({ corpusDir, id: str(record.id), frontmatter: record, body })
    if (!written.written) {
      return refuse(`an episode already exists at ${written.path} — it was left byte-for-byte alone`)
    }
    targetPath = written.path
    // Move semantics: the v1 note becomes the episode, it is not copied into it.
    const sourcePath = join(corpusDir, declaredSource)
    if (existsSync(sourcePath)) rmSync(sourcePath)
  } else if (disposition === 'claim-stub') {
    targetPath = join(corpusDir, `${str(record.id)}.md`)
    if (existsSync(targetPath)) {
      return refuse(`a record already exists at ${targetPath} — it was left byte-for-byte alone`)
    }
    atomicWriteRaw(targetPath, serializeNote({ frontmatter: record, body, schemaVersion: 2 }))
  } else if (disposition === 'v2-markup') {
    targetPath = join(corpusDir, declaredSource)
    if (!existsSync(targetPath)) {
      return refuse(`the source note ${declaredSource} is gone — refusing to resurrect it from a draft`)
    }
    atomicWriteRaw(targetPath, serializeNote({ frontmatter: record, body, schemaVersion: 2 }))
  } else {
    return refuse(`unknown draft_disposition "${disposition}"`)
  }

  // Consume the draft: a proposal is applied exactly once.
  renameSync(draftPath, appliedPathFor(draftPath))

  return { applied: true, target_path: targetPath, reason: `applied as ${disposition}` }
}
