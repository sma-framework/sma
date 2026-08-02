/**
 * context-pack.mjs — the deterministic, budgeted task-pack compiler (9.3-05, D-9.3-07).
 *
 * `sma context "<task>"` assembles a MINIMAL pack — catalog cards + inline fragments +
 * note pointers — under PACK_BUDGET with a MANIFEST. Same input (normalized task text +
 * commit + corpus + catalog) yields BYTE-IDENTICAL PACK.md + MANIFEST.json: no wall-clock,
 * no locale, no machine identity, no randomness anywhere in pack bytes (determinism is the
 * feature — it is what makes pack purity falsifiable, D-9.3-07). The manifest carries the
 * pack's OWN prediction (the session touches no file outside the pack), which is what makes
 * pack purity auto-checkable, and every «context not found in time» miss AUTOMATICALLY grows
 * the repo's memory exam.
 *
 * SUBSTRATE CONSUMED, NEVER RE-IMPLEMENTED (D-9.3-02): notes resolve via loader.mjs
 * resolvePeriphery (injectable), ordering rides generator.mjs makeComparator through the
 * loader, cards via catalog.mjs findCards, citations via the SAME journal (recordCitation);
 * fragment ids flow through that journal so usageStats/deadWeight score facts with zero new
 * machinery. profile.mjs readProfile is the fail-soft consumer of `workingStyle` (pack header)
 * and `stack` (tie-break boost for matching-language cards) — this keeps 9.3-01's schema-v2
 * fields alive under PROFILE-DEADFIELD (scorecard metric 5).
 *
 * TOUCHED-NOT-READ HONESTY: P9.3-05-C measures Edit/Write/Bash TOUCHES (the deterministic
 * observable) as the v1 proxy for «read» — hooking Read would add a spawn per file read and
 * blow the 9.2-02 envelope. Timestamps live ONLY in the touch/exam JOURNALS (.jsonl state),
 * never in the regenerable PACK.md / MANIFEST.json bytes.
 *
 * Node built-ins only; everything DI; no child_process anywhere; zero network; zero LLM.
 */

import { readdirSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { loadTagsRegistry, resolveAlias, parseNote } from './frontmatter.mjs'
import { resolvePeriphery } from './loader.mjs'
import { projectNoteAxis } from './generator.mjs'
import { findCards } from './catalog.mjs'
import { listFragments, parseTrigger } from './fragments.mjs'
import { PACK_BUDGET } from './constants.mjs'

/** Language token → catalog class family (profile.stack.languages → card boost). */
const LANG_TO_CLASS = {
  js: 'js', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', python: 'py', rs: 'rs', rust: 'rs', go: 'go', golang: 'go',
}

/** Min touches for a pack to be «settled» (scorePurity / growExam). */
const SETTLED_MIN_TOUCHES = 3
/** Min settled packs before purity is scored (else the -1 insufficient-data sentinel). */
const PURITY_MIN_PACKS = 5

// ─────────────────────────── task tags + id ─────────────────────────────────

/** Lowercase word tokens (non-word split, empties dropped). */
function tokenize(s) {
  return String(s ?? '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
}

/** Load the tag registry fail-soft (a missing TAGS.md → empty facets). */
function loadRegistrySafe(tagsPath) {
  try {
    return loadTagsRegistry(tagsPath)
  } catch {
    return { area: new Set(), kind: new Set(), aliases: new Map() }
  }
}

/**
 * deriveTaskTags(taskText, registry) → the registered facet tags a task text names,
 * alias-resolved, deduped, sorted. Unknown tokens are ignored (never an over-broad query).
 */
export function deriveTaskTags(taskText, registry) {
  const reg = registry ?? { area: new Set(), kind: new Set(), aliases: new Map() }
  const out = new Set()
  for (const tok of tokenize(taskText)) {
    const t = resolveAlias(tok, reg)
    if (reg.area.has(t) || reg.kind.has(t)) out.add(t)
  }
  return [...out].sort()
}

/** Normalize task text for the identity hash ONLY (the header shows the original). */
function normalizeTask(taskText) {
  return String(taskText ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** packId(taskText, commit) → a stable short sha256 of (normalized task + commit). */
export function packId(taskText, commit) {
  return inputHashOf(taskText, commit).slice(0, 12)
}

/** The full input hash (normalized task + commit). */
function inputHashOf(taskText, commit) {
  return createHash('sha256').update(normalizeTask(taskText) + '\n' + String(commit ?? ''), 'utf8').digest('hex')
}

// ─────────────────────────── note pointer helper ────────────────────────────

/** Collapse to one whitespace-normalized line, capped. */
function oneLine(s, max = 120) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Best-effort note description for a pointer line (fail-soft → '').
 *
 * The one-line claim is read through the SHARED projection, so a
 * schema-v2 record's `claim` fills the same slot a v1 note's `description` does —
 * otherwise every migrated record would enter the pack as a nameless pointer.
 */
function noteDescription(corpusDir, file) {
  if (!corpusDir) return ''
  try {
    const { frontmatter } = parseNote(readFileSync(join(corpusDir, file), 'utf8'), { file })
    if (frontmatter == null) return ''
    return oneLine(projectNoteAxis(frontmatter, { file }).description)
  } catch {
    return ''
  }
}

// ─────────────────────────── compile ────────────────────────────────────────

/**
 * compilePack(opts) → {packId, commit, taskText, packMd, manifest, manifestJson, members}.
 * PURE + DETERMINISTIC (no writes, no clock). Priority order (strict prefix under budget):
 *   header → CORE note pointers → periphery note pointers → cards → fragments inline.
 * The header is always the frame; the remaining members fill greedily until the first that
 * would overflow, then iteration STOPS (no backfill — the auditable-prefix property).
 *
 * @param {object} opts
 * @param {string} opts.taskText
 * @param {string} opts.commit
 * @param {string} [opts.corpusDir]
 * @param {string} [opts.tagsPath]
 * @param {object} [opts.dateMap]
 * @param {object} [opts.catalog]   readCatalog() result (or null → zero cards)
 * @param {object} [opts.profile]   normalized profile (or null → no boost/header line)
 * @param {number} [opts.budget]    PACK_BUDGET override
 * @param {Function} [opts.resolve] resolvePeriphery double (default: the real loader)
 * @param {Function} [opts.cite]    (memberId, kind) → recordCitation (packed members only)
 */
export function compilePack(opts = {}) {
  const {
    taskText = '',
    commit = '',
    corpusDir,
    tagsPath,
    dateMap = {},
    catalog = null,
    profile = null,
    budget = PACK_BUDGET,
    resolve = resolvePeriphery,
    cite,
  } = opts

  const registry = loadRegistrySafe(tagsPath)
  const tags = deriveTaskTags(taskText, registry)
  const id = packId(taskText, commit)

  // (1) notes — the compiler's ONLY note-retrieval path (consumed, never re-implemented).
  let core = []
  let periphery = []
  try {
    const res = resolve({ tags, corpusDir, tagsPath, dateMap }) || {}
    core = Array.isArray(res.core) ? res.core : []
    periphery = Array.isArray(res.periphery) ? res.periphery : []
  } catch {
    /* fail-soft — a broken resolve yields a pack of cards + fragments only */
  }

  // (2) cards — catalog-before-grep, with a profile-language tie-break boost.
  const boostClasses = new Set()
  if (profile && profile.stack && Array.isArray(profile.stack.languages)) {
    for (const lang of profile.stack.languages) {
      const cls = LANG_TO_CLASS[String(lang).toLowerCase()]
      if (cls) boostClasses.add(cls)
    }
  }
  const cards =
    catalog && catalog.built !== false && Array.isArray(catalog.cards)
      ? findCards({ catalog, query: taskText, boostClasses })
      : []

  // (3) fragments — at COMPILE time only tag-triggers fire (path/cmd are the at-the-act channel).
  const tagSet = new Set(tags)
  const fragments = []
  for (const frag of listFragments({ corpusDir })) {
    if (!frag || !frag.id) continue
    const trig = parseTrigger(frag.trigger)
    if (trig && trig.kind === 'tag' && tagSet.has(resolveAlias(trig.value, registry))) fragments.push(frag)
  }
  fragments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // (4) profile working-style header line (fail-soft consumer of 9.3-01's field).
  let workingStyleLine = ''
  if (profile && profile.workingStyle && typeof profile.workingStyle === 'object') {
    const parts = Object.keys(profile.workingStyle)
      .sort()
      .filter((k) => profile.workingStyle[k])
      .map((k) => `${k}: ${profile.workingStyle[k]}`)
    if (parts.length) workingStyleLine = parts.join('; ')
  }

  // (5) build the ordered member list and select a strict priority prefix under budget.
  const headerText = renderHeader({ id, commit, taskText, workingStyleLine })
  const members = [{ type: 'header', id: null, path: null, text: headerText, bytes: Buffer.byteLength(headerText, 'utf8') }]
  for (const file of core) {
    const desc = noteDescription(corpusDir, file)
    const text = `- ${file}${desc ? ` — ${desc}` : ''}`
    members.push({ type: 'note', sub: 'core', id: file, path: file, text, bytes: Buffer.byteLength(text, 'utf8') })
  }
  for (const file of periphery) {
    const desc = noteDescription(corpusDir, file)
    const text = `- ${file}${desc ? ` — ${desc}` : ''}`
    members.push({ type: 'note', sub: 'periphery', id: file, path: file, text, bytes: Buffer.byteLength(text, 'utf8') })
  }
  for (const card of cards) {
    const text = JSON.stringify(card)
    members.push({ type: 'card', id: card.path, path: card.path, text, bytes: Buffer.byteLength(text, 'utf8') })
  }
  for (const frag of fragments) {
    const text = frag.body
    members.push({ type: 'fragment', id: frag.id, path: frag.file, text, bytes: Buffer.byteLength(text, 'utf8') })
  }

  // header always included (the frame); the rest fill greedily until the first overflow.
  const included = [members[0]]
  let running = members[0].bytes
  for (let i = 1; i < members.length; i++) {
    const b = members[i].bytes + 1 // + newline
    if (running + b > budget) break // strict prefix — no backfill (auditable-prefix property)
    included.push(members[i])
    running += b
  }

  // (6) cite ONLY the packed notes + fragments (kind 'load') — packed, not merely resolved.
  if (typeof cite === 'function') {
    for (const m of included) {
      if (m.type === 'note' || m.type === 'fragment') {
        try {
          cite(m.id, 'load')
        } catch {
          /* fail-open — a citation never breaks the compile */
        }
      }
    }
  }

  const packMd = renderPack({ header: included[0], members: included })
  const files = []
  const seenPath = new Set()
  const manifestMembers = []
  for (const m of included) {
    if (m.type === 'header') continue
    manifestMembers.push({ type: m.type, id: m.id, path: m.path, bytes: m.bytes })
    if (m.path && !seenPath.has(m.path)) {
      seenPath.add(m.path)
      files.push(m.path)
    }
  }
  const manifest = {
    packId: id,
    v: 1,
    commit: String(commit),
    inputHash: inputHashOf(taskText, commit),
    task: String(taskText),
    budget,
    bytes: Buffer.byteLength(packMd, 'utf8'),
    members: manifestMembers,
    files,
    prediction: { claim: 'session touches no file outside files[]', metric: 'pack_purity' },
  }
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n'

  return { packId: id, commit: String(commit), taskText: String(taskText), tags, packMd, manifest, manifestJson, members: included }
}

/** renderHeader — the pack frame (packId, commit, task, optional working-style line). */
function renderHeader({ id, commit, taskText, workingStyleLine }) {
  const lines = [
    `# Context pack ${id}`,
    '',
    `- commit: ${commit}`,
    `- task: ${oneLine(taskText, 400)}`,
  ]
  if (workingStyleLine) lines.push(`- style: ${oneLine(workingStyleLine, 200)}`)
  return lines.join('\n')
}

/**
 * renderPack({header, members}) → the PACK.md string. Sections render ONLY when they
 * carry included members, in the fixed order core → periphery → cards → fragments.
 * Deterministic (no clock, no randomness). Exported so the CLI + selftest reuse it.
 */
export function renderPack({ header, members = [] }) {
  const coreP = members.filter((m) => m.type === 'note' && m.sub === 'core')
  const periP = members.filter((m) => m.type === 'note' && m.sub === 'periphery')
  const cards = members.filter((m) => m.type === 'card')
  const frags = members.filter((m) => m.type === 'fragment')

  const out = [header && header.text ? header.text : '']
  if (coreP.length) {
    out.push('', '## Core notes')
    for (const m of coreP) out.push(m.text)
  }
  if (periP.length) {
    out.push('', '## Related notes')
    for (const m of periP) out.push(m.text)
  }
  if (cards.length) {
    out.push('', '## Files (catalog cards)')
    for (const m of cards) out.push(m.text)
  }
  if (frags.length) {
    out.push('', '## Facts')
    for (const m of frags) out.push(m.text)
  }
  return out.join('\n') + '\n'
}

// ─────────────────────────── purity + exam growth ───────────────────────────

/** Normalize a touched/manifest path to repo-relative forward slashes. */
function normPath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Read a .jsonl file tolerantly → parsed objects (corrupt lines skipped). */
function readJsonl(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of String(raw).split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* skip corrupt line (fail-open) */
    }
  }
  return out
}

/** List every settled pack: {packId, manifest, touches, outside[]}. */
function settledPacks(contextDir) {
  const packsDir = join(contextDir, 'packs')
  let dirs
  try {
    dirs = readdirSync(packsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return []
  }
  const out = []
  for (const name of dirs) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(packsDir, name, 'MANIFEST.json'), 'utf8'))
    } catch {
      continue
    }
    const touches = readJsonl(join(packsDir, name, 'touched.jsonl'))
    if (touches.length < SETTLED_MIN_TOUCHES) continue
    const fileSet = new Set((manifest.files ?? []).map(normPath))
    const outside = []
    for (const t of touches) {
      const p = normPath(t && t.path)
      if (p && !fileSet.has(p)) outside.push(p)
    }
    out.push({ packId: manifest.packId ?? name, manifest, touches, outside })
  }
  return out
}

/**
 * scorePurity({contextDir}) → {purityPct, settledPacks, outside[]}. Counts only packs
 * with >= 3 touches; fewer than 5 settled packs → purityPct -1 (explicit insufficient-data
 * sentinel — never a fabricated pass). purityPct = inside-touches / total-touches across
 * settled packs (0-100, rounded).
 */
export function scorePurity({ contextDir } = {}) {
  const packs = settledPacks(contextDir)
  let inside = 0
  let total = 0
  const outside = []
  for (const p of packs) {
    total += p.touches.length
    inside += p.touches.length - p.outside.length
    for (const o of p.outside) outside.push({ packId: p.packId, path: o })
  }
  if (packs.length < PURITY_MIN_PACKS) return { purityPct: -1, settledPacks: packs.length, outside }
  const purityPct = total > 0 ? Math.round((inside / total) * 100) : 0
  return { purityPct, settledPacks: packs.length, outside }
}

/** Dedup key for an exam question. */
function examKey(q) {
  return JSON.stringify([String(q.query ?? ''), String(q.expected ?? '')])
}

/**
 * growExam({contextDir}) → {added, total}. Converts every settled pack's outside-pack
 * touches into exam lines {query: pack task text, expected: missed path}, appended to
 * `<contextDir>/exam.jsonl` (dedup on query+expected, append-only). A context failure
 * becomes a standing question — never a shrug (D-9.3-07).
 */
export function growExam({ contextDir } = {}) {
  const examPath = join(contextDir, 'exam.jsonl')
  const existing = new Set(readJsonl(examPath).map(examKey))
  const toAdd = []
  for (const p of settledPacks(contextDir)) {
    const query = String((p.manifest && p.manifest.task) ?? '')
    for (const expected of p.outside) {
      const q = { query, expected, kind: 'auto' }
      const k = examKey(q)
      if (existing.has(k)) continue
      existing.add(k)
      toAdd.push(q)
    }
  }
  if (toAdd.length) {
    mkdirSync(contextDir, { recursive: true })
    appendFileSync(examPath, toAdd.map((q) => JSON.stringify(q)).join('\n') + '\n')
  }
  return { added: toAdd.length, total: existing.size }
}

// ─────────────────────────── note-level gold cases ──────────────────────────

/**
 * A NOTE-level gold case — the retrieval-recall unit of the measurement baseline:
 *   {task, expected_notes[], critical_notes[], forbidden_notes[]}
 *
 * WHY A SEPARATE SCORER, NOT AN EXTENDED runExam: the exam harness above is a
 * FILE-level pass/fail counter over a growing question log — its case model is one
 * {query, expected} pair per line, its ground truth is the manifest's files[] (notes,
 * cards AND fragment files together), and its {count,total,failures} return is what
 * the CLI's exam replay prints. A gold case asks a different question — which NOTES
 * arrive, which of them are critical, and which must NOT arrive — and needs the
 * core/periphery split that files[] deliberately flattens. Widening runExam's return
 * would have bent an existing consumer's contract for a second purpose; this helper
 * sits beside it and reuses the same substrate instead.
 *
 * GROUND TRUTH IS THE REAL LOADER: the loaded set comes from compilePack — task text
 * → deriveTaskTags → resolvePeriphery (generator CORE rule + tag-matched periphery)
 * → budget prefix. Nothing about «what loads» is re-derived here, so the score can
 * never drift from the behavior it claims to measure.
 */

/** Unique + sorted (stable report bytes regardless of input order). */
function uniqSorted(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((s) => String(s)))].sort()
}

/**
 * scoreNoteCases(opts) → {coreLoaded, cases[], totals}. PURE over its inputs (reads the
 * corpus, writes nothing, no clock, no randomness): the same corpus + the same cases
 * always produce the identical object.
 *
 * Per case: {task, loaded, expected, hits, missing, criticalMissing, forbiddenPresent}
 *   - loaded          the note files that actually arrived in the pack, in pack order
 *   - hits/missing    expected_notes split by presence in `loaded`
 *   - criticalMissing critical_notes absent from `loaded` (scored independently of
 *                     expected_notes — a critical note is critical whether or not the
 *                     case bothered to list it twice)
 *   - forbiddenPresent forbidden_notes that loaded anyway
 * A case with no `task` string is skipped (never a fabricated score); non-array note
 * fields degrade to [] rather than throwing.
 *
 * @param {object} opts
 * @param {object[]} opts.cases     gold cases (see the block comment above)
 * @param {string} [opts.corpusDir]
 * @param {string} [opts.tagsPath]
 * @param {object} [opts.dateMap]
 * @param {string} [opts.commit]    injected (affects packId only, never the score)
 * @param {number} [opts.budget]
 * @param {object} [opts.catalog]
 * @param {object} [opts.profile]
 * @param {Function} [opts.resolve] resolvePeriphery double
 * @param {Function} [opts.compile] (taskText) → a compilePack result (default: the real one)
 */
export function scoreNoteCases(opts = {}) {
  const {
    cases = [],
    corpusDir,
    tagsPath,
    dateMap = {},
    commit = '',
    budget = PACK_BUDGET,
    catalog = null,
    profile = null,
    resolve = resolvePeriphery,
    compile,
  } = opts

  const compileOne =
    typeof compile === 'function'
      ? compile
      : (taskText) => compilePack({ taskText, commit, corpusDir, tagsPath, dateMap, catalog, profile, budget, resolve })

  const coreLoaded = new Set()
  const scored = []
  let expectedTotal = 0
  let hitTotal = 0
  let missingTotal = 0
  let criticalMissingTotal = 0
  let casesWithCriticalMiss = 0
  let forbiddenPresentTotal = 0

  for (const gold of Array.isArray(cases) ? cases : []) {
    if (!gold || typeof gold.task !== 'string' || gold.task.trim() === '') continue

    let packMembers = []
    try {
      const res = compileOne(gold.task)
      packMembers = res && Array.isArray(res.members) ? res.members : []
    } catch {
      packMembers = [] // fail-soft — a broken compile scores as «nothing loaded», never a throw
    }
    const notes = packMembers.filter((m) => m && m.type === 'note')
    const loaded = notes.map((m) => String(m.id))
    const loadedSet = new Set(loaded)
    for (const m of notes) if (m.sub === 'core') coreLoaded.add(String(m.id))

    const expected = uniqSorted(gold.expected_notes)
    const critical = uniqSorted(gold.critical_notes)
    const forbidden = uniqSorted(gold.forbidden_notes)

    const hits = expected.filter((f) => loadedSet.has(f))
    const missing = expected.filter((f) => !loadedSet.has(f))
    const criticalMissing = critical.filter((f) => !loadedSet.has(f))
    const forbiddenPresent = forbidden.filter((f) => loadedSet.has(f))

    expectedTotal += expected.length
    hitTotal += hits.length
    missingTotal += missing.length
    criticalMissingTotal += criticalMissing.length
    if (criticalMissing.length) casesWithCriticalMiss += 1
    forbiddenPresentTotal += forbiddenPresent.length

    scored.push({ task: gold.task, loaded, expected, hits, missing, criticalMissing, forbiddenPresent })
  }

  return {
    coreLoaded: [...coreLoaded].sort(),
    cases: scored,
    totals: {
      cases: scored.length,
      expected: expectedTotal,
      hits: hitTotal,
      missing: missingTotal,
      criticalMissing: criticalMissingTotal,
      casesWithCriticalMiss,
      forbiddenPresent: forbiddenPresentTotal,
    },
  }
}

/**
 * appendMiss({query, expected, contextDir}) → {added}. Records a manual «not found in
 * time» case as an exam question (dedup on query+expected, append-only).
 */
export function appendMiss({ query, expected, contextDir } = {}) {
  const examPath = join(contextDir, 'exam.jsonl')
  const existing = new Set(readJsonl(examPath).map(examKey))
  const q = { query: String(query ?? ''), expected: normPath(expected), kind: 'manual' }
  if (existing.has(examKey(q))) return { added: 0 }
  mkdirSync(contextDir, { recursive: true })
  appendFileSync(examPath, JSON.stringify(q) + '\n')
  return { added: 1 }
}

/**
 * runExam({contextDir, compile}) → {count, total, failures[]}. Replays every exam question
 * through the injected compile(query) → manifest; a question whose `expected` member is
 * ABSENT from the manifest's files[] counts as a failure. Corrupt exam lines are skipped
 * tolerantly, never fatal.
 */
export function runExam({ contextDir, compile } = {}) {
  const questions = readJsonl(join(contextDir, 'exam.jsonl'))
  const failures = []
  for (const q of questions) {
    if (!q || typeof q.query !== 'string' || typeof q.expected !== 'string') continue
    let files = []
    try {
      const manifest = compile(q.query)
      files = manifest && Array.isArray(manifest.files) ? manifest.files.map(normPath) : []
    } catch {
      files = []
    }
    if (!files.includes(normPath(q.expected))) failures.push(q)
  }
  return { count: failures.length, total: questions.length, failures }
}
