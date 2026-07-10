#!/usr/bin/env node
/**
 * migrate-frontmatter.mjs — R2 corpus migration (Phase 49 Plan 11).
 *
 * The FIRST corpus-mutating work in the phase. Migrates every non-structural
 * .claude/memory/*.md note from its legacy frontmatter (flat `type:` scalar OR a
 * nested one-level `metadata:` block) to the NORMALIZED schema that the flip
 * (49-14) requires:
 *
 *   description  — a standalone claim (existing field; MEMORY.md index fallback)
 *   kind         — one of TAGS.md `## kind` (via KIND_MAP)
 *   tags         — ≥1 area tag from TAGS.md `## area` (via AREA_KEYWORD_MAP)
 *   use-when     — a relevance trigger (existing use-when, else derived B10)
 *   importance   — integer 1–10 (via IMPORTANCE_RULES)
 *   supersedes / superseded_by / superseded_at — preserved verbatim if present
 *
 * CONTRACT (the reviewable judgment surface is the three exported tables below):
 *   - DRY-RUN by default; --write applies; --only <file> re-runs one note.
 *   - The ONLY corpus I/O path is frontmatter.mjs (parseNote / serializeNote) +
 *     loadTagsRegistry — no third-party YAML, no new deps (49-04 discipline).
 *   - Note BODIES are byte-preserved — only the frontmatter block is rewritten
 *     (serializeNote appends `body` verbatim; T-49-11-01).
 *   - A note whose parse throws, or whose body is empty/whitespace, or that has
 *     no derivable description, is SKIPPED and LISTED with a reason — never
 *     guessed (T-49-11-03, SPEC edge: empty R2).
 *   - Every tag assigned MUST be in TAGS.md — an unknown mapping target is a
 *     script ERROR, never an unregistered-tag write (closed vocab, B3).
 *   - Structural files (MEMORY.md / ARCHIVE.md / TAGS.md) are excluded.
 *   - The FOUR parallel-terminal files below are ALSO excluded by name — a
 *     parallel session owns their uncommitted edits (Plan 11 critical exclusion).
 *   - Windows-safe atomic writes: same-dir temp → renameWithRetry (fs-atomics).
 *
 * Node built-ins only; zero npm deps.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseNote, serializeNote, loadTagsRegistry, resolveAlias } from './lib/frontmatter.mjs'
import { renameWithRetry } from './lib/fs-atomics.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const DEFAULT_CORPUS = join(REPO_ROOT, '.claude', 'memory')

// ─────────────────────────── exclusion lists ─────────────────────────────────

/** Structural files: no note frontmatter by design (RESEARCH finding 3). */
export const STRUCTURAL_FILES = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

/**
 * Parallel-terminal exclusions (Plan 11 critical-exclusions block): another
 * session owns UNCOMMITTED edits to these. Migrating them would mix foreign
 * half-done work into this plan's commit. Skipped by name, counted separately,
 * documented in the SUMMARY as RESIDUAL — migrate after the parallel commit.
 */
function loadLocalExclusions() {
  // Machine-local by design: which corpus files a PARALLEL live session owns (or a
  // hook actively rewrites) is state of THIS checkout, not of the product. The
  // optional config carries a JSON array of corpus filenames; absent → empty set.
  try {
    const raw = readFileSync(join(REPO_ROOT, '.sma', 'frontmatter-migrate-exclusions.json'), 'utf8')
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
export const PARALLEL_TERMINAL_FILES = loadLocalExclusions()

/** All files this migration must never touch (structural ∪ parallel-terminal). */
export const EXCLUDED_FILES = new Set([...STRUCTURAL_FILES, ...PARALLEL_TERMINAL_FILES])

// ─────────────────────────── mapping tables (THE judgment surface) ────────────

/**
 * KIND_MAP — derive the normalized `kind` from filename prefix + legacy type.
 *
 * feedback_* splits on body markers (D-49-15): a note carrying BOTH the bold
 * **Why:** and **How to apply:** sections is a `bug-lesson`; every other
 * feedback_* is a `procedural-rule`. That marker split is applied in
 * deriveKind() (it needs the body), NOT here — this table is the prefix default.
 *
 * project_* → `status` when the legacy type/body reads active/live/current, else
 * `episodic` (a session log / incident). reference_* → `reference`.
 * A legacy type that already names a kind (decision) is honored.
 */
export const KIND_MAP = {
  // legacy `type:` scalar → kind (used when no stronger signal applies)
  feedback: 'procedural-rule', // refined to bug-lesson by body markers (D-49-15)
  reference: 'reference',
  project: 'episodic', // refined to status by active-signal in deriveKind()
  decision: 'decision',
}

/** The kind for a feedback_* note whose body carries the D-49-15 bug-lesson form. */
export const BUG_LESSON_KIND = 'bug-lesson'

/**
 * AREA_KEYWORD_MAP — ordered keyword patterns → an `area` tag from TAGS.md.
 *
 * Matched against `${filename} ${description}` lowercased. FIRST match wins for
 * the primary area; a note may collect additional area tags from later matches
 * (deduped). Every value here MUST be a canonical area tag in TAGS.md — the
 * closed-vocab self-check (validateTables) fails the run otherwise (B3).
 *
 * The kind facet is carried by the `kind` FIELD and is deliberately NOT
 * duplicated as a tag (D-49-12 facet separation).
 */
export const AREA_KEYWORD_MAP = [
  // messaging channels (aliases sms/gateway/push/vk/inbox → messaging)
  [/\b(sms|gateway|push|\bvk\b|inbox|messaging|legacyvoip|legacyinbox|legacygw|dispatcher|channel)\b/, 'messaging'],
  // payload CMS
  [/\b(payload|collection|local api|migration|drizzle|cms|afterchange|field-hook|relationship)\b/, 'payload'],
  // railway / hosting / deploy
  [/\b(railway|deploy|hosting|nixpack|oom|build|smtp|redeploy|aws|cli blocked)\b/, 'railway'],
  // security / rbac
  [/\b(security|rbac|webhook|secret|xss|regress|guard|access|auth|idor)\b/, 'security'],
  // phi / privacy
  [/\b(phi|gdpr|privacy|encryption|pii|bedrock)\b/, 'phi'],
  // seo / geo
  [/\b(seo|searchidx|geo|ai-search|schema\.org|sitemap|visibility)\b/, 'seo'],
  // design / brand / ui
  [/\b(design|brand|ui|token|visual|frontend|figma|css|scroll|body reset|back-link|backlink)\b/, 'design'],
  // release / version / push
  [/\b(release|version|v1\.|changelog|push|tag)\b/, 'release'],
  // finance / billing
  [/\b(finance|billing|invoice|settlement|payment|spend|cost)\b/, 'finance'],
  // agents / ai / orchestrator
  [/\b(agent|orchestrator|prompt|triage|command center|llm|gpt|openai|reasoning-model)\b/, 'agents'],
  // testing / ci
  [/\b(test|fixture|vitest|tsc|\bci\b|type check|type-check|type 'never')\b/, 'testing'],
  // memory / sma / notes
  [/\b(memory|sma|notes|index|tags|hygiene|mempalace|wikilink)\b/, 'memory'],
  // workflow / gsd / process
  [/\b(gsd|workflow|process|discuss|plan-phase|execute-phase|verify|phase work|subagent|worktree)\b/, 'workflow'],
  // os / framework / backlog / tracker / map
  [/\b(backlog|tracker|master-map|master map|operation|framework|internal-framework|roadmap|state\.md|projects board|dod|action)\b/, 'os'],
  // content / seo-pages / blog (CIS content)
  [/\b(content|blog|article|landing|microsite|expert|translation|russian|cis|copy)\b/, 'content'],
  // crm — tickets/patients/funnel/internal screens (broad; placed late so specific channels win first)
  [/\b(crm|ticket|account|funnel|approval|pipeline|board|kanban|master-map)\b/, 'crm'],
  // governance — rules/decisions/DoD/audit/compliance/sources-of-truth
  [/\b(governance|decision|audit|compliance|source of truth|source-of-truth|rule|honesty|convention)\b/, 'governance'],
]

/** Fallback area when no keyword matches — governance (rules/meta default). */
export const AREA_FALLBACK = 'governance'

/**
 * IMPORTANCE_RULES — an ordered predicate list → an importance integer 1–10.
 *
 * Each rule is {test(ctx), importance}. FIRST matching rule wins. ctx carries
 * {file, kind, description, body, oldType}. The scale (SPEC B / IMPORTANCE):
 *   9–10  truly load-bearing standing rules (CORE candidacy)
 *   8–9   bug-lesson / procedural-rule (HARD RULES)
 *   7     active status / decision
 *   5–6   reference
 *   3–4   episodic / archive-adjacent
 */
export const IMPORTANCE_RULES = [
  // The ~dozen load-bearing standing rules (CORE candidacy) → 9.
  {
    test: (c) =>
      /\b(hard rule|never push|fail-closed|fail closed|full suite|verify actual code|augment.*revert|compliance work deferred|security-regression|design-prompt-first|wire ui)\b/i.test(
        `${c.file} ${c.description}`,
      ),
    importance: 9,
  },
  // bug-lesson → 8 (HARD-RULE lessons).
  { test: (c) => c.kind === 'bug-lesson', importance: 8 },
  // procedural-rule → 8 (standing how-to rules).
  { test: (c) => c.kind === 'procedural-rule', importance: 8 },
  // active status / decision → 7.
  { test: (c) => c.kind === 'status' || c.kind === 'decision', importance: 7 },
  // reference → 6.
  { test: (c) => c.kind === 'reference', importance: 6 },
  // episodic / everything else → 4.
  { test: () => true, importance: 4 },
]

// ─────────────────────────── derivation helpers ──────────────────────────────

/** Legacy type from either the flat scalar or the nested metadata block. */
function legacyType(fm) {
  if (fm.type && String(fm.type).trim()) return String(fm.type).trim()
  if (fm.metadata && fm.metadata.type && String(fm.metadata.type).trim()) {
    return String(fm.metadata.type).trim()
  }
  return ''
}

/** Filename prefix bucket (project / reference / feedback / other). */
function prefixOf(file) {
  const m = /^(project|reference|feedback)_/.exec(file)
  return m ? m[1] : ''
}

/** A feedback body carries the D-49-15 bug-lesson form: BOTH **Why:** and **How to apply:**. */
function hasBugLessonForm(body) {
  return /\*\*Why:\*\*/i.test(body) && /\*\*How to apply:?\*\*/i.test(body)
}

/** A project note reads as an active/live status rather than a past episode. */
function readsActive(description, body, oldType) {
  const hay = `${description} ${body.slice(0, 400)} ${oldType}`.toLowerCase()
  return /\b(live|active|current|in progress|shipped|pending|blocked|inert behind|behind flag|open blocker)\b/.test(hay)
}

/**
 * deriveKind(file, fm, body) → a canonical kind from TAGS.md, or throws if the
 * mapping produced an unknown kind (closed vocab).
 */
function deriveKind({ file, fm, body, registry }) {
  const prefix = prefixOf(file)
  const oldType = legacyType(fm)

  // IDEMPOTENCE: an already-normalized note carries a `kind` field and NO legacy
  // `type:`. Re-deriving from prefix alone would lose the original signal (e.g. a
  // HARD-RULE feedback note stored under a project_ filename). If a valid kind is
  // already present, preserve it — a re-run must not reclassify (B12 / R3).
  if (registry && fm.kind && !oldType) {
    const k = resolveAlias(String(fm.kind).trim(), registry)
    if (registry.kind.has(k)) return k
  }

  // decision-like legacy type is honored first.
  if (oldType === 'decision') return 'decision'

  if (prefix === 'feedback' || oldType === 'feedback') {
    return hasBugLessonForm(body) ? BUG_LESSON_KIND : KIND_MAP.feedback
  }
  if (prefix === 'reference' || oldType === 'reference') {
    return KIND_MAP.reference
  }
  if (prefix === 'project' || oldType === 'project') {
    return readsActive(fm.description ?? '', body, oldType) ? 'status' : KIND_MAP.project
  }
  // Unknown prefix/type: fall back to the legacy type through KIND_MAP if known.
  if (oldType && KIND_MAP[oldType]) return KIND_MAP[oldType]
  // No signal at all → episodic (a bare note is treated as a log).
  return 'episodic'
}

/**
 * deriveAreas(file, description) → an ordered, deduped list of area tags. Always
 * ≥1 (AREA_FALLBACK). All values are canonical TAGS.md area tags (validated).
 */
function deriveAreas({ file, description }) {
  const hay = `${file} ${description}`.toLowerCase()
  const areas = []
  for (const [re, area] of AREA_KEYWORD_MAP) {
    if (re.test(hay) && !areas.includes(area)) areas.push(area)
  }
  if (areas.length === 0) areas.push(AREA_FALLBACK)
  // Cap at 3 area tags — minimal + discriminating (B4 anti-overbroad).
  return areas.slice(0, 3)
}

/** deriveImportance(ctx) → integer 1–10 via the first matching IMPORTANCE_RULE. */
function deriveImportance(ctx) {
  for (const rule of IMPORTANCE_RULES) {
    if (rule.test(ctx)) return rule.importance
  }
  return 4
}

/**
 * deriveDescription(fm, indexLine) → a standalone-claim description string, or ''
 * if none is derivable (caller skips). Uses the existing description; falls back
 * to the MEMORY.md index one-liner (the text after the `— `).
 */
/**
 * unescapeInnerQuotes — the shared parser's unquote() strips ONE outer quote
 * layer but leaves any inner `\"` (a YAML-escaped quote inside a quoted scalar)
 * as a literal backslash-quote. serializeScalar() then JSON.stringifies that,
 * escaping the backslash — so a naive round-trip DOUBLES the escaping every run.
 * Collapsing `\"`→`"` (and a runaway `\\`→`\`) here makes the value the true
 * clean string, so serialization is stable and the migration is idempotent.
 */
function unescapeInnerQuotes(s) {
  let out = s
  // Collapse repeated backslash-escaped quotes down to a single real quote.
  while (/\\+"/.test(out)) out = out.replace(/\\+"/g, '"')
  // Collapse any residual runaway backslash runs (leave lone single backslashes).
  out = out.replace(/\\{2,}/g, '\\')
  return out
}

function deriveDescription(fm, indexLine) {
  const existing = typeof fm.description === 'string' ? unescapeInnerQuotes(fm.description).trim() : ''
  if (existing) return existing
  if (indexLine) {
    // index line shape: `- [Title](file.md) — claim text`
    const m = /—\s*(.+)$/.exec(indexLine)
    if (m && m[1].trim()) return m[1].trim()
  }
  return ''
}

/**
 * deriveUseWhen(fm, description) → an existing use-when, else a derived trigger
 * (B10 "при работе с <topic>" style) from the description's leading topic.
 */
/** The prefix marking an AUTO-derived use-when (vs a human-authored trigger). */
const AUTO_USEWHEN_PREFIX = 'при работе с:'

function deriveUseWhen(fm, description) {
  const existing = typeof fm['use-when'] === 'string' ? fm['use-when'].trim() : ''
  // Preserve a HUMAN-authored use-when verbatim. An AUTO-derived one (our own
  // "при работе с:" form) is regenerated from the clean description each run, so
  // a re-run cannot compound escaping / mid-word truncation from a prior pass
  // (idempotence — the description is the single clean source, not the old trigger).
  if (existing && !existing.startsWith(AUTO_USEWHEN_PREFIX)) return existing
  // Topic = the first clause of the description. Split on an em-dash clause break,
  // or on sentence/clause punctuation ONLY when followed by whitespace/end — so a
  // token like "MEMORY.md" or "08:00" is never cut mid-word. Strip embedded quotes
  // so the trigger is not noised by \"...\" escapes, and cap at a WORD boundary
  // near 70 chars so the trigger never cuts mid-word (B10).
  let topic = description
    .split(/\s+—\s+|[;.,:](?=\s|$)/)[0]
    .replace(/["'«»\\]/g, '')
    .trim()
  if (topic.length > 70) {
    const cut = topic.slice(0, 70)
    const lastSpace = cut.lastIndexOf(' ')
    topic = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim()
  }
  return topic ? `${AUTO_USEWHEN_PREFIX} ${topic}` : ''
}

// ─────────────────────────── index-line parsing ──────────────────────────────

/** Map basename(.md) → its MEMORY.md index one-line claim (for description fallback). */
function loadIndexLines(corpusDir) {
  const out = new Map()
  let text
  try {
    text = readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')
  } catch {
    return out
  }
  const re = /\]\(([^)]+\.md)\)/
  for (const line of text.split('\n')) {
    const m = re.exec(line)
    if (m) out.set(basename(m[1]), line.trim())
  }
  return out
}

// ─────────────────────────── table self-check (B3) ────────────────────────────

/**
 * validateTables(registry) — every kind/area the tables can emit MUST exist in
 * TAGS.md. An unknown target is a script ERROR (never an unregistered-tag write).
 */
export function validateTables(registry) {
  const errors = []
  const knownKinds = registry.kind
  const knownAreas = registry.area

  const emittableKinds = new Set([...Object.values(KIND_MAP), BUG_LESSON_KIND, 'status', 'episodic'])
  for (const k of emittableKinds) {
    const canon = resolveAlias(k, registry)
    if (!knownKinds.has(k) && !knownKinds.has(canon)) {
      errors.push(`KIND_MAP emits "${k}" which is not a TAGS.md ## kind`)
    }
  }
  const emittableAreas = new Set([...AREA_KEYWORD_MAP.map(([, a]) => a), AREA_FALLBACK])
  for (const a of emittableAreas) {
    const canon = resolveAlias(a, registry)
    if (!knownAreas.has(a) && !knownAreas.has(canon)) {
      errors.push(`AREA_KEYWORD_MAP emits "${a}" which is not a TAGS.md ## area`)
    }
  }
  return errors
}

// ─────────────────────────── core migration ──────────────────────────────────

/**
 * buildNormalizedFrontmatter — the normalized frontmatter object for one note,
 * or {skip, reason} when the note cannot be migrated without guessing.
 *
 * @param {{file:string, text:string, indexLine?:string, registry:object}} args
 * @returns {{frontmatter?:object, body?:string, kind?:string, skip?:boolean, reason?:string}}
 */
export function migrateNote({ file, text, indexLine, registry }) {
  // CRLF normalization (Plan 11 project rule: memory schema mandates LF). A tiny
  // minority of legacy notes were saved with CRLF endings; the shared 49-04 parser
  // only recognizes the LF `---\n` fence, so a CRLF note would be misread as a
  // structural (no-frontmatter) file and silently skipped. Normalizing to LF here
  // (a) lets the shared parser recognize the real frontmatter and (b) satisfies
  // the LF-only schema. Recorded as a normalization so it is visible in the diff.
  let crlfNormalized = false
  if (text.includes('\r\n')) {
    text = text.replace(/\r\n/g, '\n')
    crlfNormalized = true
  }

  let parsed
  try {
    parsed = parseNote(text, { file })
  } catch (err) {
    return { skip: true, reason: `parse error: ${err.message}` }
  }
  const { frontmatter: fm, body } = parsed
  void crlfNormalized

  // Structural (no fence) → not a migration target.
  if (fm == null) return { skip: true, reason: 'no frontmatter (structural file)' }

  // Empty / whitespace-only body → skip, never guess (SPEC edge: empty R2).
  if (!body || body.trim() === '') return { skip: true, reason: 'empty/whitespace body' }

  const description = deriveDescription(fm, indexLine)
  if (!description) return { skip: true, reason: 'no derivable description (no field + no index line)' }

  const kind = deriveKind({ file, fm, body, registry })
  const tags = deriveAreas({ file, description })
  const useWhen = deriveUseWhen(fm, description)
  const importance = deriveImportance({
    file,
    kind,
    description,
    body,
    oldType: legacyType(fm),
  })

  const normalized = { description, kind, tags, 'use-when': useWhen, importance }

  // Preserve supersession keys verbatim if present (either flat or nested).
  for (const key of ['supersedes', 'superseded_by', 'superseded_at']) {
    const v = fm[key] ?? fm.metadata?.[key]
    if (v != null && String(v).trim() !== '') normalized[key] = String(v).trim()
  }

  return { frontmatter: normalized, body, kind }
}

/** List candidate note files (non-excluded *.md), sorted. */
function listCandidates(corpusDir) {
  return readdirSync(corpusDir)
    .filter((f) => f.endsWith('.md') && !EXCLUDED_FILES.has(f))
    .sort()
}

/** Windows-safe atomic raw-text write (same-dir temp → renameWithRetry). */
function atomicWriteText(targetPath, text) {
  const dir = dirname(targetPath)
  const tmp = join(dir, `.tmp-migrate-${process.pid}-${Math.random().toString(36).slice(2)}`)
  writeFileSync(tmp, text) // utf8, LF preserved (serializeNote emits LF, no BOM)
  renameWithRetry(tmp, targetPath)
}

/**
 * runMigration(opts) — enumerate, migrate, and (if write) apply.
 *
 * @param {{corpusDir?:string, write?:boolean, only?:string}} opts
 * @returns {{migrated:string[], skipped:{file:string,reason:string}[],
 *            kindCounts:object, excluded:string[], errors:string[], changed:string[]}}
 */
export function runMigration(opts = {}) {
  const corpusDir = opts.corpusDir ?? DEFAULT_CORPUS
  const write = opts.write === true
  const only = typeof opts.only === 'string' ? basename(opts.only) : null

  const registry = loadTagsRegistry(join(corpusDir, 'TAGS.md'))
  const tableErrors = validateTables(registry)
  if (tableErrors.length) {
    return { migrated: [], skipped: [], kindCounts: {}, excluded: [], errors: tableErrors, changed: [] }
  }

  const indexLines = loadIndexLines(corpusDir)
  let files = listCandidates(corpusDir)
  if (only) files = files.filter((f) => f === only)

  const migrated = []
  const changed = []
  const skipped = []
  const kindCounts = {}
  const errors = []

  for (const file of files) {
    const abs = join(corpusDir, file)
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch (err) {
      skipped.push({ file, reason: `read failed: ${err.message}` })
      continue
    }
    const res = migrateNote({ file, text, indexLine: indexLines.get(file), registry })
    if (res.skip) {
      skipped.push({ file, reason: res.reason })
      continue
    }
    const out = serializeNote({ frontmatter: res.frontmatter, body: res.body })
    migrated.push(file)
    kindCounts[res.kind] = (kindCounts[res.kind] ?? 0) + 1
    if (out !== text) {
      changed.push(file)
      if (write) atomicWriteText(abs, out)
    }
  }

  const excluded = [...EXCLUDED_FILES].filter((f) => {
    try {
      return readdirSync(corpusDir).includes(f)
    } catch {
      return false
    }
  })

  return { migrated, skipped, kindCounts, excluded, errors, changed }
}

// ─────────────────────────── report ──────────────────────────────────────────

function printReport(report, { write, only }) {
  const mode = write ? 'WRITE' : 'DRY-RUN'
  const scope = only ? ` (--only ${only})` : ''
  const lines = []
  lines.push(`SMA migrate-frontmatter [${mode}]${scope}`)
  if (report.errors.length) {
    lines.push(`  ERRORS (${report.errors.length}) — no files written:`)
    for (const e of report.errors) lines.push(`    ✗ ${e}`)
    return lines.join('\n')
  }
  lines.push(`  migrated: ${report.migrated.length}  changed: ${report.changed.length}  skipped: ${report.skipped.length}  excluded: ${report.excluded.length}`)
  lines.push(`  per-kind: ${Object.entries(report.kindCounts).sort().map(([k, n]) => `${k}=${n}`).join(', ') || '(none)'}`)
  if (report.skipped.length) {
    lines.push('  skip-list:')
    for (const s of report.skipped.sort((a, b) => a.file < b.file ? -1 : 1)) {
      lines.push(`    - ${s.file} — ${s.reason}`)
    }
  }
  if (report.excluded.length) {
    lines.push(`  excluded (untouched): ${report.excluded.sort().join(', ')}`)
  }
  return lines.join('\n')
}

// ─────────────────────────── CLI entry ───────────────────────────────────────

function isMain() {
  return process.argv[1] && basename(process.argv[1]) === 'migrate-frontmatter.mjs'
}

if (isMain()) {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const onlyIdx = argv.indexOf('--only')
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null
  const corpusIdx = argv.indexOf('--corpus')
  const corpusDir = corpusIdx !== -1 ? argv[corpusIdx + 1] : undefined

  const report = runMigration({ corpusDir, write, only })
  process.stdout.write(printReport(report, { write, only }) + '\n')
  process.exit(report.errors.length ? 1 : 0)
}
