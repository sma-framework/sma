/**
 * lint.mjs — memory-lint (R5): the ONE deterministic checker for the whole
 * memory layer. Structural twin of the security guard's checks.mjs:
 * LINT_CHECKS is an array of {id, title, tier, run(ctx)}; runLint drives them,
 * collects findings, and returns a stable-sorted report.
 *
 * DESIGN INVARIANTS (9-08 execution rules):
 *   - READ-ONLY (C4): no check writes, fixes, or deletes anything in the corpus.
 *     This module imports ONLY read APIs from node:fs (readFileSync, readdirSync,
 *     statSync). Auto-fix is out of scope for V1.
 *   - DETERMINISTIC: same tree → byte-identical report. Findings are sorted by
 *     (checkId, file, message); no timestamps inside the report body.
 *   - FAIL-SOFT (T-9-08-02): a check that throws is converted to a WARN finding
 *     rather than crashing the whole run — the commit hook (9-12) is additionally
 *     fail-open.
 *
 * Exports (consumed by the CLI 9-10, migration 9-11, flip 9-14, snapshot 9-13):
 *   - LINT_CHECKS : the array of check objects.
 *   - runLint({corpusDir, tagsPath, indexPath, ...}) -> {critical, warn, info,
 *       findings[], summary}.
 *
 * The corpus is accessed ONLY through frontmatter.mjs (parseNote + loadTagsRegistry
 * + resolveAlias) — the single shared read path (9-04).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { parseNote, serializeNote, loadTagsRegistry, resolveAlias } from './frontmatter.mjs'
import { parsePredictions, validatePrediction, isSafeCommand } from './predict.mjs'
// 9.3-01 (D-9.3-04): the PROFILE family delegates ALL schema/secret/dead-field
// judgment to the profile lib — one boundary, never duplicated (same lock as
// PRED → predict.mjs). lint renders findings, it never re-implements the checks.
import { validateProfile, normalizeProfile, deadFields, readProfile } from './profile.mjs'
// 9.2-08 (D-9.2-12): the CONS lint family delegates field validation to the
// consequences lib — one boundary, never duplicated (same posture as PRED → predict.mjs).
import { parseConsequences, validateConsequence } from './consequences.mjs'
// 9.2-03 (D-9.2-06): RECEIPT-PROSE delegates ALL parsing/validation to the
// receipts lib (parseReceipts + parseCoverage + validateReceipt) — lint renders
// findings, it NEVER re-implements a parser (same lock as PRED → predict.mjs).
import { parseReceipts, parseCoverage, validateReceipt, isAckedReceipt } from './receipts.mjs'
// 9.2-10 (D-9.2-14): PRED-SKEPTIC delegates the countersign verdict to the
// Goodhart guard (verifySkeptic) — lint renders the advisory, it never re-checks
// the hash. goodhart.mjs imports extractPredictionsBlock BACK from this module
// (one extraction truth); the cycle is safe because both sides use the imported
// binding only inside functions, never at module-eval time.
import { verifySkeptic } from './goodhart.mjs'
// 9.2-10 (D-9.2-14): HAZARD-NOCONTROL is the ENV-INDEPENDENT git-side check that
// every kill-switch cites a compensating control — it is itself the control cited
// by SMA_STPA_OFF's HAZARDS row (the guard cannot silently kill the guard). No cycle:
// stpa.mjs imports gates/journal/calibration, never lint.
import { uncompensatedKillSwitches } from './stpa.mjs'
import { GATES } from './gates.mjs'
// 9.3-06 (D-9.3-12): LADDER-EVIDENCE reads the TRACKED tier registry through the
// ladder lib (readLadder) — the same delegation lock as PRED → predict.mjs. It is the
// env-independent compensating control the SMA_LADDER_OFF HAZARDS row cites: an
// evidence-free tier escalation, or an unchecked retirement, cannot survive a commit.
import { readLadder } from './ladder.mjs'
// The ONE contradiction implementation (9.1-12 T2): lint imports consolidate's
// detector — single subject model shared by `sma consolidate` and MEM-CONTRADICT.
import { findContradictions } from './consolidate.mjs'
// The MEM-* schema-v2 family delegates ALL record legality to the schema module
// (same boundary lock as PRED → predict.mjs): this file decides WHERE a rule
// applies and at which tier, never WHAT the rule says. A second copy of the
// vocabulary is the exact drift schema-v2.mjs exists to abolish.
import { validateRecord, validateId, isPrivateFacet, GRACE_HORIZON, STATUS_VALUES } from './schema-v2.mjs'
// MEM-EPISODE is the ONE check that descends into episodes/ — through the episode
// layer's own reader and its own (lighter) required-field list, never through the
// record validator, which would reject every episode for lacking a `claim`.
import { readEpisodes, episodeRequiredFields, EPISODES_DIRNAME, EPISODE_MEMORY_TYPE } from './episodes.mjs'
// The personal-shape vocabulary is the write pipeline's: it screens this material
// on its way IN, this file screens what is already on disk. Same shapes, one list.
import { PERSONAL_PATTERNS } from './write-pipeline.mjs'
// 9.3-05 (D-9.3-07): the FRAG family delegates ALL fragment schema/byte/trigger
// judgment to the fragments lib (validateFragment over <corpusDir>/fragments/) — one
// boundary, never duplicated (same lock as PRED → predict.mjs). A missing/empty
// fragments/ dir is a valid state (listFragments returns []) — fail-open.
import { listFragments, validateFragment } from './fragments.mjs'
// FI-9/FI-11 layer budgets (9.1-13): the four size lints reference these ONLY —
// no magic byte numbers live in this module.
import {
  CORE_BUDGET,
  NOTE_BUDGET,
  ALWAYS_LOAD_BUDGET,
  STATE_BUDGET,
  BUDGET_WARN_FRACTION,
  RECEIPTS_ENFORCED_FROM,
} from './constants.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The header that marks MEMORY.md as a GENERATED artifact (C1/C5/B9). Its
 * presence is the flip signal: before it, the index is hand-written and MEM-REGEN
 * stays neutral; after it, the committed artifact must byte-match regeneration.
 */
const GENERATED_MARKER = 'GENERATED'

/** Where the regeneration module lands in the same wave (9-09). */
const GENERATOR_PATH = join(__dirname, 'generator.mjs')

/**
 * Structural files that carry no note frontmatter and are exempt from the
 * per-note schema/vocab/etc. checks. The generated index (MEMORY.md) is the
 * subject of MEM-ORPHAN and MEM-REGEN, never of MEM-SCHEMA.
 */
const STRUCTURAL_FILES = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

/**
 * The FI-11 on-demand per-area index files (INDEX-<area>.md, 9.1-13) are
 * structural artifacts too: never notes, never counted against the always-load
 * budget (they are pulled by tag on demand, not loaded whole).
 */
function isStructuralFile(f) {
  return STRUCTURAL_FILES.has(f) || /^INDEX-[^/\\]+\.md$/.test(f)
}

/** A tag on more than this fraction of the corpus is "overbroad" (B4). */
const OVERBROAD_FRACTION = 0.4

/** description heuristic (B10): a standalone claim is at least this many words. */
const MIN_DESCRIPTION_WORDS = 5

// ─────────────────────────── shared helpers ──────────────────────────────────

/** List the note files (*.md, non-structural) in a corpus dir, sorted. */
function listNoteFiles(corpusDir) {
  let entries
  try {
    entries = readdirSync(corpusDir)
  } catch {
    return []
  }
  return entries
    .filter((f) => f.endsWith('.md') && !isStructuralFile(f))
    .filter((f) => {
      try {
        return statSync(join(corpusDir, f)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/** Normalize a body for content-hash comparison: lowercase + collapse whitespace. */
function normalizeBody(body) {
  return body.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** sha256 hex of a string. */
function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** Levenshtein distance (small strings; used only for tag near-duplicate check). */
function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}

/** Crude stem: strip a trailing 'ing' / 'es' / 's' so plural/gerund forms collapse. */
function stem(t) {
  return t.replace(/(ing|es|s)$/, '')
}

/**
 * Two tags are near-duplicate if edit-distance ≤ 2, one is the other's simple
 * plural, or they share a non-trivial stem (plural/stem near-duplicates, B4).
 */
function nearDuplicateTags(a, b) {
  if (a === b) return false
  const plural = a + 's' === b || b + 's' === a || a + 'es' === b || b + 'es' === a
  const sa = stem(a)
  const sb = stem(b)
  const sharedStem = sa.length >= 3 && sa === sb
  return plural || sharedStem || levenshtein(a, b) <= 2
}

/**
 * Parse the memory index (MEMORY.md) into the set of note filenames it links.
 * Recognizes markdown links `](name.md)` — the shape both the hand index and the
 * generated index use.
 */
function parseIndexLinks(indexText) {
  const out = new Set()
  const re = /\]\(([^)]+\.md)\)/g
  let m
  while ((m = re.exec(indexText)) !== null) {
    out.add(basename(m[1]))
  }
  return out
}

/**
 * Recursively list files with a given suffix under plansDir (sorted, fail-soft).
 * The PRED/CONS families (9.1-09 / 9.2-08) lint `-PLAN.md` frontmatter; the
 * RECEIPT-PROSE check (9.2-03) lints `-SUMMARY.md` frontmatter. One walk,
 * parameterized by suffix — never a duplicated tree walk.
 */
function listPlanFiles(plansDir, suffix = '-PLAN.md') {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith(suffix)) out.push(p)
    }
  }
  walk(plansDir)
  return out.sort()
}

/** Read-once {path, text} loader for a file list (fail-soft per file). */
function readOnce(paths) {
  return paths.map((p) => {
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      /* fail-soft — an unreadable file yields no finding */
    }
    return { path: p, text }
  })
}

/**
 * comparePhase(a, b) -> -1|0|1. Splits on '.' and numeric-compares each segment
 * so '9.10' > '9.2' (NEVER a float compare). Used to honor the receipts
 * cutover (RECEIPTS_ENFORCED_FROM): pre-cutover summaries are never retro-failed.
 */
function comparePhase(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0)
  const pb = String(b).split('.').map((n) => Number(n) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** The leading dotted-numeric phase token of a SUMMARY filename ('9.2-03-…' -> '9.2'). */
function summaryPhase(summaryPath) {
  const m = /^(\d+(?:\.\d+)*)-/.exec(basename(summaryPath))
  return m ? m[1] : null
}

/** The raw frontmatter region of a file ('' when there is no leading fence). */
function frontmatterText(text) {
  const t = String(text).replace(/\r\n/g, '\n')
  if (!t.startsWith('---\n')) return ''
  const close = t.indexOf('\n---\n', 3)
  return close === -1 ? '' : t.slice(4, close + 1)
}

/**
 * True when a SUMMARY belongs to the SMA trust-spine regime (subsystem: sma…).
 * The receipts regime is SMA-only: this lint ships in the SMA product repo but
 * ALSO runs on the dogfood origin project, whose .planning/phases shares the phase-
 * NUMBER namespace with unrelated legacy phases (50-55+). A numeric phase
 * cutover alone would retro-fail those legacy summaries (which legitimately use
 * prose coverage); gating on `subsystem: sma…` scopes enforcement to the SMA
 * lineage without a magic upper bound. (9.2-03 deviation, Rule 3.)
 */
function isSmaRegimeSummary(text) {
  return /^subsystem:\s*sma\b/m.test(frontmatterText(text))
}

/**
 * Extract the RAW `<key>:` dash-list block text from a PLAN.md's frontmatter
 * ('' when absent). POSTEDIT lints hash THIS block only — not the whole file —
 * so unrelated frontmatter edits never false-positive (Pitfall 3). The key is
 * parameterized (9.2-08) so PRED-POSTEDIT and CONS-POSTEDIT share one extractor.
 */
function extractFrontmatterBlock(text, key) {
  const t = String(text).replace(/\r\n/g, '\n')
  if (!t.startsWith('---\n')) return ''
  const closeIdx = t.indexOf('\n---\n', 3)
  if (closeIdx === -1) return ''
  const lines = t.slice(4, closeIdx + 1).split('\n')
  const keyRe = new RegExp(`^${key}:`)
  let i = 0
  while (i < lines.length && !keyRe.test(lines[i])) i++
  if (i >= lines.length) return ''
  const block = [lines[i]]
  i++
  while (i < lines.length && (/^\s{2,}/.test(lines[i]) || lines[i].trim() === '')) {
    block.push(lines[i])
    i++
  }
  // Trailing blank lines belong to the NEXT key, not the block hash.
  while (block.length && block[block.length - 1].trim() === '') block.pop()
  return block.join('\n')
}

/**
 * Predictions-block extractor — a thin wrapper so PRED-POSTEDIT is byte-identical.
 * EXPORTED (9.2-10): goodhart.mjs's skeptic countersign hashes THIS exact block
 * so the countersign voids on any post-sign edit, mirroring PRED-POSTEDIT's
 * immutability — one extraction truth, two consumers (never re-derived).
 */
export function extractPredictionsBlock(text) {
  return extractFrontmatterBlock(text, 'predictions')
}

/**
 * Where the product states its own version. capability.json is the single version
 * truth of this product (package.json is pinned TO it, never the other way round),
 * so the fingerprint epoch comparison reads THIS file and nothing else.
 */
const CAPABILITY_RELPATH = join('sma-core', 'capabilities', 'sma', 'capability.json')

/**
 * resolveProductVersion(opts) -> {version, source}
 *
 * Resolution order: an injected version, an injected path, the copy installed
 * beside the corpus (`<corpusDir>/../sma-core/…`), then the source tree this
 * module lives in. Nothing found -> version null, and MEM-FPDRIFT says so out
 * loud: "unverified" and "current" must never be reported as the same thing.
 */
function resolveProductVersion(opts) {
  if (typeof opts.productVersion === 'string' && opts.productVersion.trim() !== '') {
    return { version: opts.productVersion.trim(), source: '<injected>' }
  }
  const candidates = []
  if (typeof opts.capabilityPath === 'string' && opts.capabilityPath.trim() !== '') {
    candidates.push(opts.capabilityPath)
  }
  if (typeof opts.corpusDir === 'string' && opts.corpusDir.trim() !== '') {
    candidates.push(join(opts.corpusDir, '..', CAPABILITY_RELPATH))
  }
  candidates.push(join(__dirname, '..', '..', '..', CAPABILITY_RELPATH))
  for (const path of candidates) {
    try {
      const version = JSON.parse(readFileSync(path, 'utf8')).version
      if (typeof version === 'string' && version.trim() !== '') {
        return { version: version.trim(), source: path }
      }
    } catch {
      /* fail-soft — try the next candidate */
    }
  }
  return { version: null, source: candidates.join(' · ') }
}

/**
 * Build the shared lint context once (single corpus read). Every check reads
 * from this — no check re-reads the disk.
 */
function buildContext(opts) {
  const { corpusDir, tagsPath, indexPath } = opts
  const registry = loadTagsRegistry(tagsPath)
  const files = listNoteFiles(corpusDir)

  const parsed = []
  for (const file of files) {
    const abs = join(corpusDir, file)
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch (err) {
      parsed.push({ file, error: `read failed: ${err.message}` })
      continue
    }
    try {
      // schemaVersion travels with the note: it is the discriminator that decides
      // WHICH family of checks may judge this record (v1 completeness vs the v2
      // record discipline). Without it every check would have to re-sniff the
      // grammar the parser has already decided.
      const { frontmatter, body, schemaVersion } = parseNote(text, { file })
      parsed.push({ file, frontmatter, body, text, schemaVersion })
    } catch (err) {
      // A parse error is surfaced by MEM-SCHEMA as a CRITICAL, not a crash.
      parsed.push({ file, parseError: err.message, text })
    }
  }

  let indexText = ''
  try {
    indexText = readFileSync(indexPath, 'utf8')
  } catch {
    indexText = ''
  }

  // FI-11 (9.1-13): the catalog is now MEMORY.md + the per-area INDEX-<area>.md
  // files. MEM-ORPHAN's "absent from the index" direction must see the union of
  // links across all of them, or every periphery note would false-positive.
  const indexLinks = parseIndexLinks(indexText)
  const areaIndexFiles = []
  try {
    for (const f of readdirSync(corpusDir).sort()) {
      if (!/^INDEX-[^/\\]+\.md$/.test(f)) continue
      areaIndexFiles.push(f)
      try {
        for (const l of parseIndexLinks(readFileSync(join(corpusDir, f), 'utf8'))) indexLinks.add(l)
      } catch {
        /* fail-soft — an unreadable area index contributes no links */
      }
    }
  } catch {
    /* fail-soft — unreadable corpus dir */
  }

  // STATE-SIZE (9.1-13): the state path is dependency-injected so the
  // platform's .planning/STATE.md and any user's path both work. Absent path
  // or unreadable file → null → the check degrades to silence (fail-soft).
  let stateText = null
  if (typeof opts.statePath === 'string' && opts.statePath.trim() !== '') {
    try {
      stateText = readFileSync(opts.statePath, 'utf8')
    } catch {
      stateText = null
    }
  }

  // PROFILE family (9.3-01): read .sma/profile.json ONCE here (tolerant reader).
  // A missing profile is a valid state → profile:null → PROFILE-SCHEMA/PROFILE-SECRET
  // skip (fail-open); PROFILE-DEADFIELD is schema-level and always runs.
  let profile = null
  if (typeof opts.profilePath === 'string' && opts.profilePath.trim() !== '' && existsSync(opts.profilePath)) {
    profile = readProfile({ profilePath: opts.profilePath }).profile
  }

  // LADDER-EVIDENCE (9.3-06): the tracked tier registry, read ONCE here. A missing
  // file is a valid state (no overlay) → ladder:null → the check is silent (fail-open).
  let ladder = null
  if (typeof opts.ladderPath === 'string' && opts.ladderPath.trim() !== '' && existsSync(opts.ladderPath)) {
    ladder = readLadder({ ladderPath: opts.ladderPath })
  }

  // The fingerprint epoch (MEM-FPDRIFT) and today's date (MEM-EXPIRE), resolved
  // ONCE here like every other input. `now` is injectable so a fixture's verdict
  // is a property of the fixture, not of the day the suite happens to run.
  const product = resolveProductVersion(opts)
  const today = utcDay(opts.now ?? new Date())

  // The episode layer, read ONCE like everything else. readEpisodes is loud by
  // design (a history file that vanishes from a read is the failure that layer
  // exists to prevent), so the noise is caught HERE and handed to MEM-EPISODE as
  // a finding: one unreadable episode must not take the whole checker down with it.
  let episodes = []
  let episodesError = null
  try {
    episodes = readEpisodes({ corpusDir })
  } catch (err) {
    episodesError = err.message
  }

  return {
    corpusDir,
    tagsPath,
    indexPath,
    registry,
    files,
    parsed,
    productVersion: product.version,
    productVersionSource: product.source,
    today,
    episodes,
    episodesError,
    // Where a fingerprint's tree_paths are resolved from (repo root by default:
    // undefined lets the injected runner use its own cwd).
    gitCwd: opts.gitCwd,
    indexText,
    indexLinks,
    areaIndexFiles,
    statePath: opts.statePath,
    stateText,
    profilePath: opts.profilePath,
    profile,
    ladderPath: opts.ladderPath,
    ladder,
    // Task 2 injection points (default undefined — checks degrade gracefully):
    generate: opts.generate,
    generateAreas: opts.generateAreas,
    claudeMdPath: opts.claudeMdPath,
    // PRED family (9.1-09): plan files are read ONCE here, like the corpus.
    // execGit is an injected read-only git runner (args, {cwd}) => stdout.
    // plansDir travels with them: the POSTEDIT batch maps a plan path
    // back into git's path space from it.
    plansDir: opts.plansDir,
    plans: opts.plansDir ? readOnce(listPlanFiles(opts.plansDir, '-PLAN.md')) : [],
    // RECEIPT-PROSE (9.2-03): SUMMARY files are read ONCE here, same posture as
    // plans — no check re-reads the disk.
    summaries: opts.plansDir ? readOnce(listPlanFiles(opts.plansDir, '-SUMMARY.md')) : [],
    execGit: opts.execGit,
  }
}

/** A finding factory keeps the shape uniform + sortable. */
function finding(checkId, tier, file, message) {
  return { checkId, tier, file: file ?? '', message }
}

// ─────────────────────────── check classes ───────────────────────────────────

const MEM_VOCAB = {
  id: 'MEM-VOCAB',
  title: 'Closed-vocabulary membership (B3)',
  tier: 'critical',
  run(ctx) {
    const out = []
    // No registry at all → ONE structural finding, not a per-tag flood: the
    // tags are not wrong, the registry is absent (loadTagsRegistry fail-soft).
    if (ctx.registry.missing) {
      out.push(
        finding(
          'MEM-VOCAB',
          'critical',
          ctx.tagsPath,
          `tag registry not found at ${ctx.tagsPath} — create TAGS.md (facets ## area / ## kind / ## phase, lines "- <tag> — <desc>") so the closed vocabulary can be checked`,
        ),
      )
      return out
    }
    const known = new Set([...ctx.registry.area, ...ctx.registry.kind])
    for (const note of ctx.parsed) {
      const tags = note.frontmatter?.tags
      if (!Array.isArray(tags)) continue
      for (const tag of tags) {
        // phase:NN is the one open facet — accept any phase:<n>.
        if (/^phase:\d+$/.test(tag)) continue
        const canonical = resolveAlias(tag, ctx.registry)
        // An alias resolves to a known canonical; that's MEM-ALIAS's job, not a
        // vocab error. Only a tag that is NEITHER canonical NOR a known alias fails.
        if (known.has(tag)) continue
        if (ctx.registry.aliases.has(tag)) continue
        void canonical
        out.push(finding('MEM-VOCAB', 'critical', note.file, `unregistered tag "${tag}" in ${note.file} — add it to TAGS.md in the same commit or fix the tag`))
      }
    }
    return out
  },
}

const MEM_ALIAS = {
  id: 'MEM-ALIAS',
  title: 'Alias used instead of canonical (B2)',
  tier: 'warn',
  run(ctx) {
    const out = []
    for (const note of ctx.parsed) {
      const tags = note.frontmatter?.tags
      if (!Array.isArray(tags)) continue
      for (const tag of tags) {
        if (!ctx.registry.aliases.has(tag)) continue
        const canonical = resolveAlias(tag, ctx.registry)
        out.push(finding('MEM-ALIAS', 'warn', note.file, `tag "${tag}" is an alias — use the canonical "${canonical}" instead (${note.file})`))
      }
    }
    return out
  },
}

const MEM_SCHEMA = {
  id: 'MEM-SCHEMA',
  title: 'Frontmatter completeness (B10)',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const note of ctx.parsed) {
      if (note.parseError) {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `frontmatter parse error in ${note.file}: ${note.parseError}`))
        continue
      }
      const fm = note.frontmatter
      if (fm == null) {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `missing frontmatter in ${note.file}`))
        continue
      }
      // A schema-v2 record answers to MEM-V2SCHEMA, never to the v1 field set: it
      // carries claim/memory_type where a v1 note carries description/kind. Holding
      // it to BOTH would make every migrated record permanently critical for being
      // exactly what the migration made it — the mirror image of the backward-compat
      // law that keeps the v2 checks off v1 notes.
      if (note.schemaVersion === 2) continue
      // description: present + a standalone claim (≥ MIN_DESCRIPTION_WORDS words).
      const desc = typeof fm.description === 'string' ? fm.description.trim() : ''
      if (desc === '') {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `missing required field "description" in ${note.file}`))
      } else if (desc.split(/\s+/).length < MIN_DESCRIPTION_WORDS) {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `field "description" is too short to be a standalone claim (≥ ${MIN_DESCRIPTION_WORDS} words) in ${note.file}`))
      }
      // kind: present.
      if (!fm.kind || String(fm.kind).trim() === '') {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `missing required field "kind" in ${note.file}`))
      }
      // tags: present + non-empty array.
      if (!Array.isArray(fm.tags) || fm.tags.length === 0) {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `missing required field "tags" in ${note.file}`))
      }
      // use-when: present + non-empty.
      const useWhen = fm['use-when']
      if (useWhen == null || String(useWhen).trim() === '') {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `missing required field "use-when" in ${note.file}`))
      }
      // importance: integer 1–10.
      const imp = fm.importance
      const impNum = Number(imp)
      if (imp == null || String(imp).trim() === '') {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `missing required field "importance" in ${note.file}`))
      } else if (!Number.isInteger(impNum) || impNum < 1 || impNum > 10) {
        out.push(finding('MEM-SCHEMA', 'critical', note.file, `field "importance" must be an integer 1–10 (got "${imp}") in ${note.file}`))
      }
    }
    return out
  },
}

const MEM_ORPHAN = {
  id: 'MEM-ORPHAN',
  title: 'Index ↔ files orphans (both directions)',
  tier: 'critical',
  run(ctx) {
    const out = []
    const onDisk = new Set(ctx.files)
    // Direction 1: index references a file that is not on disk.
    for (const linked of [...ctx.indexLinks].sort()) {
      if (isStructuralFile(linked)) continue
      if (!onDisk.has(linked)) {
        out.push(finding('MEM-ORPHAN', 'critical', ctx.indexPath, `index references "${linked}" but that file is not on disk`))
      }
    }
    // Direction 2: a note on disk is absent from the index.
    for (const file of ctx.files) {
      if (!ctx.indexLinks.has(file)) {
        out.push(finding('MEM-ORPHAN', 'critical', file, `note "${file}" is on disk but absent from the index`))
      }
    }
    return out
  },
}

const MEM_DUPE = {
  id: 'MEM-DUPE',
  title: 'Content-hash near-duplicate notes (R2 adjacency)',
  tier: 'warn',
  run(ctx) {
    const out = []
    const byHash = new Map()
    for (const note of ctx.parsed) {
      if (note.parseError || note.error) continue
      const hash = sha256(normalizeBody(note.body ?? ''))
      if (!byHash.has(hash)) byHash.set(hash, [])
      byHash.get(hash).push(note.file)
    }
    for (const [, group] of [...byHash.entries()].sort()) {
      if (group.length < 2) continue
      const sorted = [...group].sort()
      // Emit one WARN per unordered pair so the finding names both files.
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          out.push(finding('MEM-DUPE', 'warn', sorted[i], `near-identical body: "${sorted[i]}" and "${sorted[j]}" share a normalized-content hash`))
        }
      }
    }
    return out
  },
}

const MEM_TAGCHAOS = {
  id: 'MEM-TAGCHAOS',
  title: 'Tag chaos: near-duplicate / single-use / overbroad (B4)',
  tier: 'warn',
  run(ctx) {
    const out = []
    // Count tags across the corpus (registered tags in USE, resolved to canonical
    // only where the tag IS a known alias — an unknown tag is MEM-VOCAB's problem).
    const usage = new Map()
    const total = ctx.parsed.filter((n) => !n.parseError && n.frontmatter).length
    for (const note of ctx.parsed) {
      const tags = note.frontmatter?.tags
      if (!Array.isArray(tags)) continue
      for (const tag of tags) {
        if (/^phase:\d+$/.test(tag)) continue
        usage.set(tag, (usage.get(tag) ?? 0) + 1)
      }
    }
    const tagsInUse = [...usage.keys()].sort()

    // Near-duplicate tags (compare registered tags actually in use).
    for (let i = 0; i < tagsInUse.length; i++) {
      for (let j = i + 1; j < tagsInUse.length; j++) {
        const a = tagsInUse[i]
        const b = tagsInUse[j]
        if (nearDuplicateTags(a, b)) {
          out.push(finding('MEM-TAGCHAOS', 'warn', '', `near-duplicate tags in use: "${a}" and "${b}" — consolidate to one canonical`))
        }
      }
    }
    // Single-use tags.
    for (const tag of tagsInUse) {
      if (usage.get(tag) === 1) {
        out.push(finding('MEM-TAGCHAOS', 'warn', '', `single-use tag "${tag}" — a tag used by exactly one note earns little; fold it into a broader tag`))
      }
    }
    // Overbroad tags (> OVERBROAD_FRACTION of the corpus).
    if (total > 0) {
      for (const tag of tagsInUse) {
        if (usage.get(tag) / total > OVERBROAD_FRACTION) {
          out.push(finding('MEM-TAGCHAOS', 'warn', '', `overbroad tag "${tag}" — on ${usage.get(tag)}/${total} notes (> ${Math.round(OVERBROAD_FRACTION * 100)}%); it no longer discriminates`))
        }
      }
    }
    return out
  },
}

// ── Task 2: supersession / bug-lesson form / wikilinks / regen / CLAUDE.md dup ─

/** The set of note NAMES on disk (basename without the .md extension). */
function noteNameSet(ctx) {
  return new Set(ctx.files.map((f) => f.replace(/\.md$/, '')))
}

/**
 * The canonical identity of a supersession pointer: the note's STEM.
 *
 * The id law makes the stem the identity of a record, and the two writers of
 * these fields spell the same pointer differently — `applyLifecycle` writes a
 * BARE STEM (`supersedes: my-record`) while a hand-authored note may write the
 * filename (`supersedes: my-record.md`). Normalizing BOTH sides on the stem is
 * what lets those spellings resolve to one id. It does not soften the check: a
 * target that is genuinely absent from the corpus has no stem on disk either,
 * so it stays CRITICAL.
 */
function pointerId(value) {
  const base = String(value ?? '').trim().split(/[\\/]/).pop() ?? ''
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

/**
 * A supersession pointer as a list of raw, non-empty strings. `supersedes` is
 * scalar-or-list by construction: the pipeline collapses a single target to a
 * scalar and keeps an array when one record replaces several.
 */
function pointerList(value) {
  const items = Array.isArray(value) ? value : [value]
  return items.map((v) => String(v ?? '').trim()).filter((v) => v !== '')
}

const MEM_SUPERSEDE = {
  id: 'MEM-SUPERSEDE',
  title: 'Supersession-link integrity (B6)',
  tier: 'critical',
  run(ctx) {
    const out = []
    // Every comparison below is stem-to-stem (see pointerId).
    const onDisk = new Set(ctx.files.map(pointerId))
    // Map each note id → its parsed frontmatter for back-pointer symmetry.
    const fmById = new Map()
    for (const note of ctx.parsed) {
      if (note.frontmatter) fmById.set(pointerId(note.file), note.frontmatter)
    }

    for (const note of ctx.parsed) {
      const fm = note.frontmatter
      if (!fm) continue
      const selfId = pointerId(note.file)

      // supersedes / superseded_by targets must exist on disk (CRITICAL).
      // The message quotes the pointer AS WRITTEN — the reader has to find it
      // in the file, and the normalized stem is not what they will see there.
      for (const key of ['supersedes', 'superseded_by']) {
        for (const raw of pointerList(fm[key])) {
          if (!onDisk.has(pointerId(raw))) {
            out.push(finding('MEM-SUPERSEDE', 'critical', note.file, `${key} target "${raw}" does not exist on disk (${note.file})`))
          }
        }
      }

      // Back-pointer symmetry: A.superseded_by=B implies B.supersedes=A (WARN).
      const succ = pointerId(fm.superseded_by)
      if (succ && onDisk.has(succ)) {
        const back = pointerList(fmById.get(succ)?.supersedes).map(pointerId)
        if (!back.includes(selfId)) {
          out.push(finding('MEM-SUPERSEDE', 'warn', note.file, `${note.file}.superseded_by="${succ}" has no matching back-pointer supersedes in "${succ}"`))
        }
      }

      // superseded_at without superseded_by is dangling metadata (WARN).
      const hasAt = fm.superseded_at != null && String(fm.superseded_at).trim() !== ''
      const hasBy = pointerList(fm.superseded_by).length > 0
      if (hasAt && !hasBy) {
        out.push(finding('MEM-SUPERSEDE', 'warn', note.file, `superseded_at present without superseded_by in ${note.file}`))
      }
    }
    return out
  },
}

const MEM_BUGLESSON = {
  id: 'MEM-BUGLESSON',
  title: 'bug-lesson body form: Why + How to apply',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const note of ctx.parsed) {
      const fm = note.frontmatter
      if (!fm) continue
      const kind = resolveAlias(String(fm.kind ?? ''), ctx.registry)
      if (kind !== 'bug-lesson') continue
      const body = note.body ?? ''
      // The structure the ~30 feedback_* notes already carry: bold Why + How.
      if (!/\*\*Why:\*\*/i.test(body)) {
        out.push(finding('MEM-BUGLESSON', 'critical', note.file, `kind=bug-lesson note ${note.file} is missing the **Why:** section`))
      }
      if (!/\*\*How to apply:?\*\*/i.test(body)) {
        out.push(finding('MEM-BUGLESSON', 'critical', note.file, `kind=bug-lesson note ${note.file} is missing the **How to apply:** section`))
      }
    }
    return out
  },
}

const MEM_WIKILINK = {
  id: 'MEM-WIKILINK',
  title: 'Wikilink integrity: every [[name]] resolves',
  tier: 'critical',
  run(ctx) {
    const out = []
    const names = noteNameSet(ctx)
    for (const note of ctx.parsed) {
      const body = note.body ?? ''
      const re = /\[\[([^\]]+)\]\]/g
      let m
      const seen = new Set()
      while ((m = re.exec(body)) !== null) {
        // A wikilink may carry a display alias `[[name|display]]` — take the target.
        const target = m[1].split('|')[0].trim()
        if (target === '' || seen.has(target)) continue
        seen.add(target)
        if (!names.has(target)) {
          out.push(finding('MEM-WIKILINK', 'critical', note.file, `broken wikilink [[${target}]] in ${note.file} — no memory note named "${target}"`))
        }
      }
    }
    return out
  },
}

const MEM_REGEN = {
  id: 'MEM-REGEN',
  title: 'Artifact matches regeneration (R3)',
  tier: 'critical',
  run(ctx) {
    const out = []
    const committed = ctx.indexText
    // Pre-flip: no GENERATED marker → the index is still hand-written. Neutral.
    if (!committed.includes(GENERATED_MARKER)) {
      out.push(finding('MEM-REGEN', 'info', ctx.indexPath, `MEMORY.md carries no ${GENERATED_MARKER} header — pending flip (9-14); regeneration byte-compare is not yet enforced`))
      return out
    }
    // Post-flip: byte-compare the committed artifact against regeneration.
    // The generator is injected (test / CLI) or lazy-loaded from generator.mjs.
    const generate = ctx.generate
    if (typeof generate !== 'function') {
      // The module lands in the same wave (9-09) — degrade, never crash (P4).
      const landed = existsSync(GENERATOR_PATH)
      const why = landed
        ? 'generator.mjs is present but no generate() was supplied to runLint'
        : 'generator.mjs has not landed yet (9-09)'
      out.push(finding('MEM-REGEN', 'warn', ctx.indexPath, `generator unavailable — cannot byte-compare the GENERATED artifact (${why}); rerun once wired`))
      return out
    }
    let regenerated
    try {
      // Regeneration uses the commit hash PARSED FROM the artifact's own anchor,
      // so the compare stays byte-stable even after HEAD moves.
      regenerated = generate(committed, ctx)
    } catch (err) {
      out.push(finding('MEM-REGEN', 'warn', ctx.indexPath, `generator threw during regeneration: ${err.message}`))
      return out
    }
    if (regenerated !== committed) {
      out.push(finding('MEM-REGEN', 'critical', ctx.indexPath, `MEMORY.md differs from regeneration — the GENERATED artifact was hand-edited; regenerate it (do not hand-edit)`))
    }

    // FI-11 (9.1-13): the per-area INDEX-<area>.md files are GENERATED
    // artifacts too — staleness covers them when an area regenerator is wired.
    const generateAreas = ctx.generateAreas
    if (typeof generateAreas === 'function') {
      let areas
      try {
        areas = generateAreas(committed, ctx)
      } catch (err) {
        out.push(finding('MEM-REGEN', 'warn', ctx.indexPath, `area-index generator threw during regeneration: ${err.message}`))
        return out
      }
      const expected = new Map()
      for (const a of Array.isArray(areas) ? areas : []) expected.set(a.file, a.content)
      for (const [file, content] of [...expected.entries()].sort()) {
        let onDisk = null
        try {
          onDisk = readFileSync(join(ctx.corpusDir, file), 'utf8')
        } catch {
          onDisk = null
        }
        if (onDisk == null) {
          out.push(finding('MEM-REGEN', 'critical', file, `${file} is missing on disk but regeneration produces it — regenerate the index (do not hand-edit)`))
        } else if (onDisk !== content) {
          out.push(finding('MEM-REGEN', 'critical', file, `${file} differs from regeneration — the GENERATED area index was hand-edited; regenerate it (do not hand-edit)`))
        }
      }
      // A stale on-disk area file the regeneration no longer produces.
      for (const f of ctx.areaIndexFiles ?? []) {
        if (!expected.has(f)) {
          out.push(finding('MEM-REGEN', 'critical', f, `${f} is on disk but regeneration no longer produces it — stale area index; regenerate the index`))
        }
      }
    }
    return out
  },
}

/** Normalize a CLAUDE.md / description line for duplication comparison. */
function normalizeRuleLine(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const MEM_CLAUDEDUP = {
  id: 'MEM-CLAUDEDUP',
  title: 'CLAUDE.md ↔ note duplication',
  tier: 'warn',
  run(ctx) {
    const out = []
    if (!ctx.claudeMdPath || !existsSync(ctx.claudeMdPath)) return out
    let claudeText
    try {
      claudeText = readFileSync(ctx.claudeMdPath, 'utf8')
    } catch {
      return out
    }
    // Substantive CLAUDE.md lines only: ≥ 8 words, not a heading.
    const claudeLines = new Set()
    for (const raw of claudeText.split('\n')) {
      if (/^\s*#/.test(raw)) continue
      const norm = normalizeRuleLine(raw)
      if (norm.split(' ').filter(Boolean).length >= 8) claudeLines.add(norm)
    }
    for (const note of ctx.parsed) {
      const desc = note.frontmatter?.description
      if (typeof desc !== 'string') continue
      const norm = normalizeRuleLine(desc)
      if (norm.split(' ').filter(Boolean).length < 8) continue
      if (claudeLines.has(norm)) {
        out.push(finding('MEM-CLAUDEDUP', 'warn', note.file, `note ${note.file} description duplicates a CLAUDE.md rule line — CLAUDE.md is the source of truth`))
      }
    }
    return out
  },
}

// ── 9.1-12: MEM-CONTRADICT — bi-temporal same-subject conflicts (B5) ─────────

const MEM_CONTRADICT = {
  id: 'MEM-CONTRADICT',
  title: 'Same-subject conflicting rule-stating notes, both active, unlinked (B5)',
  tier: 'critical',
  run(ctx) {
    // Detection is DELEGATED to consolidate.mjs's findContradictions — the one
    // shared implementation (9.1-12 T2 acceptance). Lint only renders findings.
    const notes = ctx.parsed.filter((n) => n.frontmatter && !n.parseError && !n.error)
    const pairs = findContradictions({ notes, registry: ctx.registry })
    return pairs.map((p) =>
      finding(
        'MEM-CONTRADICT',
        'critical',
        p.files[0],
        `contradiction: "${p.files[0]}" and "${p.files[1]}" are same-subject active ${p.kind} notes with conflicting claims (${p.reason}; shared subject: ${p.shared.join(', ')}) — set valid_until or supersedes on the stale one`,
      ),
    )
  },
}

// ── 9.1-09: PRED family — pre-registration integrity for plan predictions ───

const PRED_NOMETRIC = {
  id: 'PRED-NOMETRIC',
  title: 'Prediction entries carry the full metric contract (B18/B19)',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const plan of ctx.plans) {
      // Field validation is DELEGATED to predict.mjs's validatePrediction —
      // one boundary, never duplicated (9.1-08 lock).
      const { predictions } = parsePredictions(plan.path, { readFn: () => plan.text })
      for (const entry of predictions) {
        const v = validatePrediction(entry)
        if (v.valid) continue
        const parts = []
        if (v.missing.length) parts.push(`missing ${v.missing.join(', ')}`)
        if (v.errors.length) parts.push(v.errors.join('; '))
        out.push(finding('PRED-NOMETRIC', 'critical', basename(plan.path), `prediction "${entry.id ?? '<no id>'}" in ${basename(plan.path)}: ${parts.join('; ')} — a prediction without a machine-checkable metric/check_command/comparator/threshold cannot be scored (HARKing guard)`))
      }
    }
    return out
  },
}

/** Git speaks forward slashes; join() on Windows does not. One path space. */
function toPosixPath(p) {
  return String(p).replace(/\\/g, '/')
}

/**
 * firstCommitTexts(ctx) — ONE git history walk, shared by the two POSTEDIT checks.
 *
 * PRED-POSTEDIT and CONS-POSTEDIT ask the SAME question of the SAME files ("what
 * did this plan look like in its first commit?") and each used to answer it with
 * `git log --follow` + `git show` PER PLAN. On the house corpus (151 plans) that
 * is 604 git processes, and it was 92 % of the whole lint's wall clock — measured
 * 2026-08-05: 176 s of a 193 s run, `git log --follow` alone ~0.55 s a file.
 * A release-gate check nobody can afford to run is a check nobody runs.
 *
 * The replacement asks git once per run and keeps every verdict identical:
 *   - one repo-wide `log --name-status --find-renames` walk gives, per path, the
 *     commits that touched it, newest first; the OLDEST record is its creation;
 *   - a plan whose only commit IS that creation, and whose worktree copy is not
 *     modified against HEAD, needs no `git show` at all — the text already in
 *     memory IS its first-commit text;
 *   - a plan the walk cannot answer for (untracked, renamed — renames are exactly
 *     what `--follow` exists for, and a path space the batch cannot map) falls
 *     back to the per-file `--follow` walk. A verdict is never silently lost.
 *
 * Memoized on ctx: the second check pays nothing.
 */
function firstCommitTexts(ctx) {
  if (ctx._firstCommitTexts) return ctx._firstCommitTexts
  const execGit = ctx.execGit
  const cache = new Map()
  // stderr is dropped on the batch calls: `git diff` narrates CRLF conversions,
  // and lint's own stderr is a progress channel, not git's.
  const readOpts = (cwd) => ({ cwd, stdio: ['ignore', 'pipe', 'ignore'] })

  /** repo-relative path -> [{status, hash}], newest first. */
  const records = new Map()
  let dirty = null
  let prefix = null
  if (typeof execGit === 'function' && typeof ctx.plansDir === 'string' && ctx.plansDir !== '') {
    try {
      const cwd = ctx.plansDir
      prefix = toPosixPath(String(execGit(['rev-parse', '--show-prefix'], readOpts(cwd))).trim())
      // NO pathspec: rename detection must see the whole tree, or a plan moved IN
      // from outside would read as a fresh creation (which `--follow` would not).
      const walk = String(
        execGit(['-c', 'core.quotePath=false', 'log', '--find-renames', '--format=%x00%H', '--name-status'], readOpts(cwd)),
      )
      for (const group of walk.split('\u0000').slice(1)) {
        const lines = group.split('\n')
        const hash = lines[0].trim()
        if (!/^[0-9a-f]{7,40}$/.test(hash)) continue
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].trim() === '') continue
          const parts = lines[i].split('\t')
          const status = parts[0][0]
          // `R100<TAB>old<TAB>new` / `C100<TAB>src<TAB>dst`: the DESTINATION is the
          // path this walk knows, recorded as R so the plan takes the --follow path.
          const path = status === 'R' || status === 'C' ? parts[2] : parts[1]
          if (!path) continue
          const list = records.get(path)
          if (list) list.push({ status, hash })
          else records.set(path, [{ status, hash }])
        }
      }
      const diffOut = String(
        execGit(['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD', '--', '.'], readOpts(cwd)),
      )
      dirty = new Set(diffOut.split('\n').map((s) => s.trim()).filter(Boolean))
    } catch {
      prefix = null // no batch — every plan takes the per-file path, as before
    }
  }

  /** The original per-file walk: `--follow` + `show`, unchanged. */
  const perFile = (plan) => {
    try {
      // All git ops run with cwd = the plan's own directory and cwd-relative
      // paths (`<hash>:./<name>`), so Windows 8.3 short-path tmpdirs never
      // desync from git's long-name toplevel.
      const cwd = dirname(plan.path)
      const name = basename(plan.path)
      // First commit = the LAST line of the --diff-filter=A first-parent walk.
      const log = String(execGit(['log', '--follow', '--diff-filter=A', '--format=%H', '--', name], { cwd })).trim()
      const hashes = log.split('\n').filter(Boolean)
      if (!hashes.length) return null // never committed — the block is not locked yet
      const first = hashes[hashes.length - 1]
      return String(execGit(['show', `${first}:./${name}`], { cwd }))
    } catch {
      return null // fail-soft: outside a repo / git error → no verdict on this plan
    }
  }

  const resolve = (plan) => {
    if (prefix !== null && dirty !== null) {
      const key = prefix + toPosixPath(relative(ctx.plansDir, plan.path))
      const list = records.get(key)
      const oldest = list && list.length ? list[list.length - 1] : null
      if (oldest && oldest.status === 'A') {
        // Only one commit ever touched it and the worktree matches HEAD: the
        // first-commit text and the text in memory are the same bytes.
        if (list.length === 1 && !dirty.has(key)) return plan.text
        try {
          return String(execGit(['show', `${oldest.hash}:./${basename(plan.path)}`], { cwd: dirname(plan.path) }))
        } catch {
          return null
        }
      }
    }
    return typeof execGit === 'function' ? perFile(plan) : null
  }

  const api = {
    textOf(plan) {
      if (cache.has(plan.path)) return cache.get(plan.path)
      const text = resolve(plan)
      cache.set(plan.path, text)
      return text
    },
  }
  ctx._firstCommitTexts = api
  return api
}

const PRED_POSTEDIT = {
  id: 'PRED-POSTEDIT',
  title: 'Predictions are immutable after the plan\'s first commit (HARKing guard)',
  tier: 'critical',
  run(ctx) {
    const out = []
    if (!ctx.plans.length) return out
    const execGit = ctx.execGit
    if (typeof execGit !== 'function') {
      // Degrade like MEM-REGEN: without a git runner the hash-compare cannot run.
      const withBlocks = ctx.plans.some((p) => extractPredictionsBlock(p.text) !== '')
      if (withBlocks) {
        out.push(finding('PRED-POSTEDIT', 'info', '', 'git runner unavailable — predictions post-edit hash-compare skipped (inject execGit to enforce)'))
      }
      return out
    }
    const first = firstCommitTexts(ctx)
    let done = 0
    for (const plan of ctx.plans) {
      if (ctx.overBudget && ctx.overBudget()) {
        ctx.noteTruncation('PRED-POSTEDIT', done, ctx.plans.length, 'plans')
        break
      }
      done++
      if (ctx.tick) ctx.tick('PRED-POSTEDIT', done, ctx.plans.length, 'plans')
      const nowBlock = extractPredictionsBlock(plan.text)
      const firstText = first.textOf(plan)
      if (firstText === null) continue // never committed / no git verdict on this plan
      const firstBlock = extractPredictionsBlock(firstText)
      if (nowBlock === '' && firstBlock === '') continue
      if (sha256(nowBlock) !== sha256(firstBlock)) {
        out.push(finding('PRED-POSTEDIT', 'critical', basename(plan.path), `predictions block in ${basename(plan.path)} differs from the plan's first commit — pre-registered predictions are immutable (HARKing guard); revert the block, new claims go in a NEW plan`))
      }
    }
    return out
  },
}

// ── 9.2-10 (D-9.2-14): PRED-SKEPTIC — predictions need an adversarial countersign ─

const PRED_SKEPTIC = {
  id: 'PRED-SKEPTIC',
  title: 'A 9.2+ plan\'s predictions carry a valid skeptic countersign (Goodhart guard)',
  tier: 'warn',
  run(ctx) {
    const out = []
    for (const plan of ctx.plans) {
      // Only plans that actually pre-register predictions are in scope.
      if (extractPredictionsBlock(plan.text) === '') continue
      // Cutover: enforce only from the trust-spine regime forward (9.2+). The
      // whole V2 history and unrelated pre-9.2 plans are never retro-flagged.
      const phase = summaryPhase(plan.path)
      if (phase == null || comparePhase(phase, RECEIPTS_ENFORCED_FROM) < 0) continue

      // Delegate the verdict to the ONE guard — never re-check the hash here.
      const v = verifySkeptic({ planPath: plan.path, readFn: () => plan.text })
      if (v && v.ok === false) {
        const why =
          v.reason === 'unsigned'
            ? 'has no skeptic countersign — a skeptic distinct from the implementer must sign it (node scripts/sma/cli.mjs skeptic sign)'
            : v.reason === 'hash-mismatch'
              ? 'was edited after countersigning — the countersign is VOID; re-sign from a skeptic terminal'
              : v.reason === 'self-sign'
                ? 'was countersigned by the implementer terminal itself — a countersign must come from a DISTINCT skeptic'
                : `countersign invalid (${v.reason})`
        out.push(
          finding(
            'PRED-SKEPTIC',
            'warn',
            basename(plan.path),
            `predictions block in ${basename(plan.path)} ${why}. Advisory here; the blocking gate is /sma-grill's unresolved-challenge check (D-9.2-11).`,
          ),
        )
      }
    }
    return out
  },
}

/** Normalize a command string for the duplication compare: collapse whitespace. */
function normalizeCommand(s) {
  return String(s).replace(/\s+/g, ' ').trim()
}

const PRED_DUPDOD = {
  id: 'PRED-DUPDOD',
  title: 'Prediction check_command duplicates a DoD dimension check (B19)',
  tier: 'warn',
  run(ctx) {
    const out = []
    for (const plan of ctx.plans) {
      const { predictions } = parsePredictions(plan.path, { readFn: () => plan.text })
      if (!predictions.length) continue
      // Sibling DoD files in the plan's own directory (NN-DOD.json / DOD.json).
      const dodCommands = new Set()
      let entries = []
      try {
        entries = readdirSync(dirname(plan.path))
      } catch {
        continue
      }
      for (const f of entries) {
        if (!/(^|-)DOD\.json$/i.test(f)) continue
        try {
          const dod = JSON.parse(readFileSync(join(dirname(plan.path), f), 'utf8'))
          const dims = Array.isArray(dod?.dimensions) ? dod.dimensions : []
          for (const dim of dims) {
            for (const key of ['command', 'check', 'check_command']) {
              if (typeof dim?.[key] === 'string' && dim[key].trim() !== '') {
                dodCommands.add(normalizeCommand(dim[key]))
              }
            }
          }
        } catch {
          /* unparseable DoD — no verdict */
        }
      }
      if (!dodCommands.size) continue
      for (const entry of predictions) {
        const cmd = normalizeCommand(entry.check_command ?? '')
        if (cmd && dodCommands.has(cmd)) {
          out.push(finding('PRED-DUPDOD', 'warn', basename(plan.path), `prediction "${entry.id ?? '<no id>'}" in ${basename(plan.path)}: check_command duplicates a DoD dimension check — a prediction must claim something DoD does not already verify`))
        }
      }
    }
    return out
  },
}

// ── 9.2-08: CONS family — the consequences block is LAW after first commit ──

const CONS_SCHEMA = {
  id: 'CONS-SCHEMA',
  title: 'Consequences entries carry the full {id, trigger, blocks, until} contract',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const plan of ctx.plans) {
      // Field validation is DELEGATED to consequences.mjs's validateConsequence —
      // one boundary, never duplicated (same lock as PRED-NOMETRIC → validatePrediction).
      const { consequences } = parseConsequences(plan.path, { readFn: () => plan.text })
      for (const entry of consequences) {
        const v = validateConsequence(entry)
        if (v.valid) continue
        const parts = []
        if (v.missing.length) parts.push(`missing ${v.missing.join(', ')}`)
        if (v.errors.length) parts.push(v.errors.join('; '))
        out.push(finding('CONS-SCHEMA', 'critical', basename(plan.path), `consequence "${entry.id ?? '<no id>'}" in ${basename(plan.path)}: ${parts.join('; ')} — a consequence without {id, trigger, blocks, until} cannot gate the ship ritual`))
      }
    }
    return out
  },
}

const CONS_POSTEDIT = {
  id: 'CONS-POSTEDIT',
  title: 'Consequences are immutable after the plan\'s first commit (the law cannot be renegotiated)',
  tier: 'critical',
  run(ctx) {
    const out = []
    if (!ctx.plans.length) return out
    const execGit = ctx.execGit
    if (typeof execGit !== 'function') {
      // Degrade exactly like PRED-POSTEDIT: without a git runner the hash-compare cannot run.
      const withBlocks = ctx.plans.some((p) => extractFrontmatterBlock(p.text, 'consequences') !== '')
      if (withBlocks) {
        out.push(finding('CONS-POSTEDIT', 'info', '', 'git runner unavailable — consequences post-edit hash-compare skipped (inject execGit to enforce)'))
      }
      return out
    }
    // The SAME first-commit index PRED-POSTEDIT built (memoized on ctx): the two
    // checks ask one question of one file set, so they pay for it once.
    const first = firstCommitTexts(ctx)
    let done = 0
    for (const plan of ctx.plans) {
      if (ctx.overBudget && ctx.overBudget()) {
        ctx.noteTruncation('CONS-POSTEDIT', done, ctx.plans.length, 'plans')
        break
      }
      done++
      if (ctx.tick) ctx.tick('CONS-POSTEDIT', done, ctx.plans.length, 'plans')
      const nowBlock = extractFrontmatterBlock(plan.text, 'consequences')
      const firstText = first.textOf(plan)
      if (firstText === null) continue // never committed — the law is not locked yet
      const firstBlock = extractFrontmatterBlock(firstText, 'consequences')
      if (nowBlock === '' && firstBlock === '') continue
      if (sha256(nowBlock) !== sha256(firstBlock)) {
        out.push(finding('CONS-POSTEDIT', 'critical', basename(plan.path), `consequences block in ${basename(plan.path)} differs from the plan's first commit — consequences are immutable after the plan's first commit (the law cannot be renegotiated after the bet is placed); revert the block, new terms go in a NEW plan`))
      }
    }
    return out
  },
}

const CONS_NOBLOCK = {
  id: 'CONS-NOBLOCK',
  title: 'A plan with predictions must declare what a class-A miss blocks',
  tier: 'warn',
  run(ctx) {
    const out = []
    for (const plan of ctx.plans) {
      const hasPredictions = extractFrontmatterBlock(plan.text, 'predictions') !== ''
      const hasConsequences = extractFrontmatterBlock(plan.text, 'consequences') !== ''
      if (hasPredictions && !hasConsequences) {
        out.push(finding('CONS-NOBLOCK', 'warn', basename(plan.path), `${basename(plan.path)} carries a predictions block but no consequences block — a prediction without a consequence is a diary entry; declare what a class-A miss blocks`))
      }
    }
    return out
  },
}

// ── 9.2-03: RECEIPT-PROSE — a machine «done» must carry a re-runnable receipt ─

const RECEIPT_PROSE = {
  id: 'RECEIPT-PROSE',
  title: 'A machine-verifiable «done» carries a structural receipt, not prose',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const s of ctx.summaries ?? []) {
      const phase = summaryPhase(s.path)
      if (phase == null) continue
      // Regime gate: the receipts law is SMA-only. On the dogfood origin project the
      // phase-number namespace is shared with unrelated legacy phases —
      // enforce only on SMA-lineage summaries (subsystem: sma…).
      if (!isSmaRegimeSummary(s.text)) continue
      // Cutover: the whole V2 history (< 9.2) is NEVER retro-failed. The retro
      // look at V2 false-dones is plan 01's baseline harness, not this lint.
      if (comparePhase(phase, RECEIPTS_ENFORCED_FROM) < 0) continue

      const readFn = () => s.text
      // Delegation only — no local parser (parseReceipts + parseCoverage + validateReceipt).
      const { receipts } = parseReceipts(s.path, { readFn })
      const { coverage } = parseCoverage(s.path, { readFn })

      // A malformed receipt, or one whose check_command evades the SAFE_COMMAND
      // boundary, is its OWN critical finding — the lint cannot claim to enforce
      // a boundary receipts routinely evade (CONS-9.2-03-B).
      //
      // THE WAIVER: a receipt may carry `unsafe_ack: true` — the stamp
      // `receipt-hash --unsafe-ack` writes when a human deliberately admits one
      // off-allowlist command. That is not the failure this check exists to
      // catch: the boundary was not evaded, it was crossed on the record, by a
      // person, in writing. So an acked receipt is a WARNING, not critical —
      // and the warning names the waiver, because the one thing a waiver must
      // never be is invisible. It stays a finding for exactly that reason.
      for (const r of receipts) {
        const v = validateReceipt(r)
        if (!v.valid) {
          // An ack cannot rescue a malformed receipt: the waiver speaks about
          // the command, and there is no valid receipt here to speak for.
          const why = [...v.missing.map((m) => `missing ${m}`), ...v.errors].join('; ')
          out.push(finding('RECEIPT-PROSE', 'critical', basename(s.path), `receipt "${r.id ?? '<no id>'}" in ${basename(s.path)} is malformed: ${why} — a receipt that cannot be validated cannot re-verify a claim`))
        } else if (!isSafeCommand(r.check_command)) {
          if (isAckedReceipt(r)) {
            out.push(finding('RECEIPT-PROSE', 'warning', basename(s.path), `receipt "${r.id}" in ${basename(s.path)} has a non-allowlisted check_command admitted by an explicit waiver (unsafe_ack: true) — reverify will SKIP it (verdict skipped-unsafe), so this claim rests on the acking human, not on a re-runnable command`))
          } else {
            out.push(finding('RECEIPT-PROSE', 'critical', basename(s.path), `receipt "${r.id}" in ${basename(s.path)} has a non-allowlisted check_command — it can never be re-verified across the SAFE_COMMAND boundary`))
          }
        }
      }

      // Every machine-verifiable coverage item (human_judgment: false) MUST bind
      // a valid, allowlisted receipt by coverage_id — else it is prose, not proof.
      // The waiver does NOT widen `usable`: an acked command is still one
      // reverify refuses to run, so a coverage item bound only to an acked
      // receipt has no re-runnable proof and stays critical. The ack downgrades
      // the finding about the RECEIPT, never the one about the claim it backs.
      const usable = receipts.filter((r) => validateReceipt(r).valid && isSafeCommand(r.check_command))
      for (const item of coverage) {
        if (item.human_judgment) continue
        const bound = usable.some((r) => r.coverage_id === item.id)
        if (!bound) {
          out.push(finding('RECEIPT-PROSE', 'critical', basename(s.path), `coverage item "${item.id}" in ${basename(s.path)} is machine-verifiable (human_judgment: false) but carries no allowlisted receipt — a done without a re-runnable command is prose, not proof`))
        }
      }
    }
    return out
  },
}

// ── 9.2-10 (D-9.2-14): HAZARD-NOCONTROL — every kill-switch cites a control ──

const HAZARD_NOCONTROL = {
  id: 'HAZARD-NOCONTROL',
  title: 'Every kill-switch cites a compensating control in the HAZARDS registry (STPA)',
  tier: 'critical',
  run() {
    const orphans = uncompensatedKillSwitches({ gates: GATES })
    return orphans.map((k) =>
      finding(
        'HAZARD-NOCONTROL',
        'critical',
        '',
        `kill-switch ${k} has no compensating control in the HAZARDS registry (lib/stpa.mjs) — a switch that can silently disable a protection with no cited mitigation is an STPA violation; add a HAZARDS row with a non-empty compensatingControl + birth fixture`,
      ),
    )
  },
}

// ── 9.3-06 (D-9.3-12): LADDER-EVIDENCE — no evidence-free tier escalation ────

const LADDER_EVIDENCE = {
  id: 'LADDER-EVIDENCE',
  title: 'Every ladder tier change carries evidence rows with journalRefs; retirements cite a fixture check',
  tier: 'critical',
  run(ctx) {
    const ladder = ctx.ladder
    if (!ladder || !Array.isArray(ladder.rules)) return []
    const file = basename(ctx.ladderPath || 'sma-ladder.json')
    const out = []
    for (const rule of ladder.rules) {
      if (!rule || !rule.ruleId) continue
      const tier = rule.tier
      const evidence = Array.isArray(rule.evidence) ? rule.evidence : []
      const hasRefs = evidence.some((e) => e && Array.isArray(e.journalRefs) && e.journalRefs.length > 0)

      // (a) any tier other than the shipped default 'warn' must carry evidence rows
      //     with non-empty journalRefs — a hand-set tier without measured benefit is
      //     an evidence-free enforcement escalation (the exact self-grading V3 kills).
      if (tier && tier !== 'warn') {
        if (!evidence.length || !hasRefs) {
          out.push(finding('LADDER-EVIDENCE', 'critical', file, `rule ${rule.ruleId} sits at tier '${tier}' with no evidence rows carrying journalRefs — a tier change without measured benefit is forbidden (D-9.3-12); tune only via \`node scripts/sma/cli.mjs tune --apply\`, never a hand-edit`))
        }
      }
      // (b) a 'retired' rule must carry a fixtureCheck record (the STPA birth-fixture
      //     sign-off — a rule can never auto-tune into silent removal, D-9.2-14).
      if (tier === 'retired' && (!rule.fixtureCheck || typeof rule.fixtureCheck !== 'object')) {
        out.push(finding('LADDER-EVIDENCE', 'critical', file, `rule ${rule.ruleId} is 'retired' without a fixtureCheck record — retirement requires the 9.2-10 birth-fixture sign-off (D-9.2-14)`))
      }
      // (c) a registered fix command must pass the imported isSafeCommand allowlist.
      if (rule.fix && rule.fix.command && !isSafeCommand(rule.fix.command)) {
        out.push(finding('LADDER-EVIDENCE', 'critical', file, `rule ${rule.ruleId} registers a fix command that fails isSafeCommand — fix commands go through predict.mjs's single allowlist ONLY (T-9.3-60)`))
      }
    }
    return out
  },
}

// ── 9.1-13: FI-9/FI-11 size lints — budgets are law, `sma trim` is the repair ─

/** UTF-8 byte length (budgets are BYTES, not chars — Cyrillic is 2 bytes/char). */
function byteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}

/** WARN at 80% of budget, critical at 100%; below the warn line → null. */
function sizeTier(bytes, budget) {
  if (bytes >= budget) return 'critical'
  if (bytes >= budget * BUDGET_WARN_FRACTION) return 'warn'
  return null
}

/**
 * One uniform size finding. Every CRITICAL names `sma trim` as the auto-repair
 * (FI-9: the trimmer DEMOTES overflow down a layer — nothing is ever deleted).
 */
function sizeFinding(checkId, tier, file, surface, bytes, budget) {
  const pct = Math.round((bytes / budget) * 100)
  const message =
    tier === 'critical'
      ? `${surface} exceeds its ${budget}-byte budget (${bytes} bytes, ${pct}%) — run \`sma trim\` to demote the overflow down a layer (FI-9: demotion, never deletion)`
      : `${surface} is at ${pct}% of its ${budget}-byte budget (${bytes} bytes) — approaching the cap; \`sma trim\` demotes overflow before it blocks`
  return finding(checkId, tier, file, message)
}

/**
 * Extract the CORE section of the generated index: from the `## Ядро` heading
 * line up to (not including) the next `## ` heading. '' when absent (a
 * hand-written index without the section yields no CORE-size verdict).
 */
function extractCoreSection(indexText) {
  const t = String(indexText ?? '')
  const lines = t.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^## Ядро/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const MEM_CORESIZE = {
  id: 'MEM-CORESIZE',
  title: 'CORE section within its byte budget (FI-9)',
  tier: 'critical',
  run(ctx) {
    const core = extractCoreSection(ctx.indexText)
    if (core === '') return []
    const bytes = byteLen(core)
    const tier = sizeTier(bytes, CORE_BUDGET)
    if (!tier) return []
    return [sizeFinding('MEM-CORESIZE', tier, ctx.indexPath, 'the CORE section of MEMORY.md', bytes, CORE_BUDGET)]
  },
}

const MEM_NOTESIZE = {
  id: 'MEM-NOTESIZE',
  title: 'Each memory note within its byte budget (FI-9)',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const note of ctx.parsed) {
      if (typeof note.text !== 'string') continue
      const bytes = byteLen(note.text)
      const tier = sizeTier(bytes, NOTE_BUDGET)
      if (!tier) continue
      out.push(sizeFinding('MEM-NOTESIZE', tier, note.file, `note ${note.file}`, bytes, NOTE_BUDGET))
    }
    return out
  },
}

const MEM_INDEXSIZE = {
  id: 'MEM-INDEXSIZE',
  title: 'Always-load payload within its byte budget (FI-11)',
  tier: 'critical',
  run(ctx) {
    // The ALWAYS-LOAD payload = MEMORY.md whole (CORE + the thin discovery
    // block). The per-area INDEX-<area>.md files are pulled on demand and
    // NEVER count against this budget (FI-11).
    const bytes = byteLen(ctx.indexText)
    const tier = sizeTier(bytes, ALWAYS_LOAD_BUDGET)
    if (!tier) return []
    return [sizeFinding('MEM-INDEXSIZE', tier, ctx.indexPath, 'the always-load payload (MEMORY.md)', bytes, ALWAYS_LOAD_BUDGET)]
  },
}

const STATE_SIZE = {
  id: 'STATE-SIZE',
  title: 'STATE.md snapshot within its byte budget (FI-9, house rule)',
  tier: 'critical',
  run(ctx) {
    if (typeof ctx.stateText !== 'string') return [] // no injected path → silent
    const bytes = byteLen(ctx.stateText)
    const tier = sizeTier(bytes, STATE_BUDGET)
    if (!tier) return []
    return [sizeFinding('STATE-SIZE', tier, ctx.statePath ?? '', 'STATE.md', bytes, STATE_BUDGET)]
  },
}

// ── 9.1-14: MEM-SECRET — screen secrets at the corpus door (T-9.1-27) ───────
//
// The note author -> corpus trust boundary: anything written becomes injectable
// context forever, so a leaked secret would be echoed by any reflex that surfaces
// the note. Write-time screening beats fire-time filtering — this lands BEFORE
// reflex injection goes live platform-wide (9.1-26). Aligned with the security
// guard's secret-pattern conventions (checks.mjs SEC-11/SEC-12/R2-MOUNT-1):
// unambiguous token prefixes + assignment-shaped literals + high-entropy runs,
// with the false-positive classes (env var NAMES, git shas) explicitly allowlisted
// so the gate stays credible (pinned by tests).

/** Shannon entropy in bits/char. A base64/opaque secret runs ~5–6; hex caps at 4.0. */
function shannonEntropy(s) {
  const freq = new Map()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let e = 0
  const n = s.length
  if (n === 0) return 0
  for (const c of freq.values()) {
    const p = c / n
    e -= p * Math.log2(p)
  }
  return e
}

/** Unambiguous credential prefixes — the same shapes the security guard screens. */
const SECRET_PREFIX_PATTERNS = [
  { re: /\bAKIA[0-9A-Z]{12,}\b/, cls: 'AWS access key id' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, cls: 'sk- prefixed API token' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, cls: 'GitHub personal access token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, cls: 'Slack token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, cls: 'PEM private key block' },
]

/**
 * An ALL-CAPS name assigned a 20+ char opaque VALUE (a secret literal). A bare
 * env var NAME with no value never matches (Test 2 — names are fine, values are
 * not); prose never matches (the value must be 20+ CONTIGUOUS opaque chars).
 */
const SECRET_ASSIGNMENT_RE = /\b([A-Z][A-Z0-9_]{2,})\s*[:=]\s*["']?([A-Za-z0-9+/_-]{20,})["']?/g

/**
 * A contiguous opaque run (base64/opaque). `=` is deliberately EXCLUDED from the
 * class: base64 uses `=` only as trailing padding (never internal), so dropping it
 * loses no real secret, but it breaks CLI-flag noise like
 * `NODE_OPTIONS=--max-old-space-size=8192` into short readable pieces that never
 * reach the 32-char floor. Pure-hex runs are allowlisted at match time below.
 */
const OPAQUE_RUN_RE = /[A-Za-z0-9+/_-]{32,}/g

/** Above this bits/char an opaque run is secret-shaped (prose stays well under). */
const SECRET_ENTROPY_THRESHOLD = 4.5

/** True for a pure-hex run — a git sha / content hash, allowlisted by shape. */
function isHexRun(s) {
  return /^[0-9a-fA-F]+$/.test(s)
}

const MEM_SECRET = {
  id: 'MEM-SECRET',
  title: 'Secret material screened at the corpus door',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const note of ctx.parsed) {
      const body = typeof note.body === 'string' ? note.body : ''
      if (body === '') continue
      const hits = new Set()

      // 1) Known token prefixes — unambiguous.
      for (const { re, cls } of SECRET_PREFIX_PATTERNS) {
        if (re.test(body)) hits.add(cls)
      }

      // 2) ALL-CAPS name = 20+ char opaque value. Allowlisted (credibility —
      //    these are NOT secrets): a value that starts with `-` or `/` (a CLI
      //    flag like NODE_OPTIONS=--max-old-space-size, or a path like
      //    FFMPEG=/c/Users/...), and a pure-hex value up to git-sha length (a
      //    commit ref). A longer-than-sha hex value is a key literal; any other
      //    opaque value must look RANDOM (entropy > 4.0) to fire — a readable
      //    flag/word never clears that bar.
      let m
      SECRET_ASSIGNMENT_RE.lastIndex = 0
      while ((m = SECRET_ASSIGNMENT_RE.exec(body)) !== null) {
        const value = m[2]
        if (/^[-/]/.test(value)) continue // CLI flag / file path — not a secret
        if (isHexRun(value)) {
          if (value.length > 40) hits.add(`assignment ${m[1]}=<opaque ${value.length}-char value>`)
          continue
        }
        if (shannonEntropy(value) > 4.0) {
          hits.add(`assignment ${m[1]}=<opaque ${value.length}-char value>`)
        }
      }

      // 3) High-entropy opaque run (base64/opaque secret). Allowlisted: a run
      //    containing `/` is a file path / URL (memory notes are full of them),
      //    and a pure-hex run is a git sha / content hash (caps at 4.0 bits/char
      //    anyway). Only a slash-free, non-hex, high-entropy run fires.
      OPAQUE_RUN_RE.lastIndex = 0
      while ((m = OPAQUE_RUN_RE.exec(body)) !== null) {
        const run = m[0]
        if (run.includes('/')) continue // file path / URL — allowlisted
        if (isHexRun(run)) continue // git sha / hash — allowlisted
        if (shannonEntropy(run) > SECRET_ENTROPY_THRESHOLD) {
          hits.add(`high-entropy ${run.length}-char run`)
        }
      }

      for (const cls of [...hits].sort()) {
        out.push(
          finding(
            'MEM-SECRET',
            'critical',
            note.file,
            `possible secret in ${note.file} (${cls}) — a secret must NEVER enter the corpus (any reflex would echo it); remove or redact it. Env var NAMES are fine; VALUES are not.`,
          ),
        )
      }
    }
    return out
  },
}

// ── 9.3-01 (D-9.3-04): PROFILE family — the profile is schema-bound, secret-free,
// and every schema field has a live consumer (adoption scorecard metric 5) ──────

const PROFILE_DEADFIELD = {
  id: 'PROFILE-DEADFIELD',
  title: 'Every profile schema field has a registered consumer (metric 5)',
  tier: 'critical',
  run() {
    // Schema-level — runs even with NO profile on disk. Delegated to profile.mjs.
    return deadFields().map((f) =>
      finding(
        'PROFILE-DEADFIELD',
        'critical',
        '',
        `profile schema field "${f}" has no registered consumer in PROFILE_CONSUMERS — a field nobody reads is the «700-line rules file» failure in miniature (metric 5); add a consumer in lib/profile.mjs + the reference doc, or drop the field`,
      ),
    )
  },
}

const PROFILE_SCHEMA_LINT = {
  id: 'PROFILE-SCHEMA',
  title: 'Committed profile carries no unknown/mistyped field',
  tier: 'critical',
  run(ctx) {
    if (!ctx.profile) return [] // missing profile = valid state (fail-open)
    const { violations } = validateProfile(normalizeProfile(ctx.profile))
    return violations
      .filter((v) => v.rule === 'PROFILE-SCHEMA')
      .map((v) => finding('PROFILE-SCHEMA', 'critical', ctx.profilePath ?? '', v.message))
  },
}

const PROFILE_SECRET = {
  id: 'PROFILE-SECRET',
  title: 'Committed profile stores NAMES + facts only, never a secret value',
  tier: 'critical',
  run(ctx) {
    if (!ctx.profile) return [] // missing profile = valid state (fail-open)
    const { violations } = validateProfile(normalizeProfile(ctx.profile))
    return violations
      .filter((v) => v.rule === 'PROFILE-SECRET')
      .map((v) => finding('PROFILE-SECRET', 'critical', ctx.profilePath ?? '', v.message))
  },
}

// ── 9.3-05 (D-9.3-07): FRAG family — fragments are atomic (one fact, <= 400 bytes),
// carry a parseable trigger, and are schema-valid (id == filename stem) ──────────
const FRAG_LINT = {
  id: 'FRAG',
  title: 'Fragments are atomic, triggered, schema-valid (one fact per fragment)',
  tier: 'critical',
  run(ctx) {
    const out = []
    let frags
    try {
      frags = listFragments({ corpusDir: ctx.corpusDir }) // missing fragments/ → [] (fail-open)
    } catch {
      return []
    }
    for (const frag of frags) {
      for (const v of validateFragment(frag)) {
        out.push(finding(v.rule, 'critical', `fragments/${v.file}`, v.detail))
      }
    }
    return out
  },
}

// ── The schema-v2 family: record discipline, trust, and placement ─────────────
//
// These checks are the ONLY enforcement surface of the memory record schema —
// there is no second `sma verify-corpus` verb and there must never be one: the
// corpus has exactly one checker, and extending it is cheaper for every consumer
// than remembering which of two commands to run.
//
// Two laws bound the whole family:
//   BACKWARD COMPAT — a note with no schema_version is a v1 note and is invisible
//     to every record check here. A corpus that has not migrated lints today
//     exactly as it linted yesterday.
//   READ-ONLY (C4) — nothing in this family fixes, stamps, deletes or expires
//     anything. A stale fingerprint and an expired claim are REVIEW TRIGGERS;
//     a lint that silently rewrote the corpus it judges could never be trusted
//     to judge it.

/**
 * The v2 half of the corpus: parsed, schema-v2, with frontmatter. Episodes are
 * absent by construction — the corpus walk is flat and never descends into
 * episodes/ (that subdirectory has exactly one reader here, MEM-EPISODE).
 */
function v2Records(ctx) {
  return ctx.parsed.filter((n) => n.schemaVersion === 2 && !n.parseError && n.frontmatter)
}

/** True when the record itself declares it grew out of the v1 grammar. */
function isMigratedRecord(fm) {
  return String(fm.migrated_from ?? '').trim() === 'v1'
}

const MEM_V2SCHEMA = {
  id: 'MEM-V2SCHEMA',
  title: 'Schema-v2 record legality — structure always, discipline under grace',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const note of v2Records(ctx)) {
      const fm = note.frontmatter
      const migrated = isMigratedRecord(fm)
      const { errors, warnings } = validateRecord(fm, { migratedFromV1: migrated })

      // The id law is a separate call by design — the validator never sees a
      // path, and a record whose identity does not survive a move or a copy is a
      // STRUCTURE failure, so it joins the errors rather than forming its own class.
      const idError = validateId(fm.id, note.file)
      const allErrors = idError ? [idError, ...errors] : errors

      // WHICH of the warnings exist only because of the migration grace is the
      // validator's judgment, not this file's: ask it a second time as if the
      // record had been authored natively and diff the answers. No discipline
      // rule is re-derived here, so none of them can drift out of sync.
      const graced = migrated
        ? new Set(validateRecord({ ...fm, migrated_from: null }, { migratedFromV1: false }).errors)
        : null

      // The grammar gets the last word. A record can be legal to the VALIDATOR
      // and unwritable by the SERIALIZER — the parser is more permissive on the
      // way in than the emitter is on the way out (a scalar where a block is
      // required is read happily and refused on write). Such a record lints clean
      // and then breaks the next tool that round-trips it: a migration, a
      // consolidation, the write pipeline. Asking the grammar directly makes that
      // disagreement LOUD without deciding which of the two rules should move.
      try {
        serializeNote({ frontmatter: fm, body: note.body ?? '', schemaVersion: 2 })
      } catch (err) {
        allErrors.push(
          `record: legal to the validator but the shared grammar refuses to write it back (${err.message}) — a record nothing can re-emit is a record the next tool that touches it will reject`,
        )
      }

      for (const message of allErrors) {
        out.push(finding('MEM-V2SCHEMA', 'critical', note.file, `${note.file}: ${message}`))
      }
      for (const message of warnings) {
        // A grace with no stated horizon is an exemption. The horizon is a NAMED
        // milestone rather than a date: the calendar meaning belongs to whoever
        // runs the installation, not to the schema.
        const grace = graced?.has(message)
          ? ` — a record migrated from v1 gets this as a WARNING until ${GRACE_HORIZON}; after that it is an error`
          : ''
        out.push(finding('MEM-V2SCHEMA', 'warn', note.file, `${note.file}: ${message}${grace}`))
      }
    }
    return out
  },
}

/**
 * Line-start dated update markers. Three or more of them in one body is a
 * running log — an EPISODE wearing a reviewed record's clothes. The threshold is
 * deliberately forgiving: two dates are a claim with a history, a dozen are a diary.
 */
const DATED_UPDATE_LINE_RE = /^[ \t]*(?:[-*]\s*)?\d{4}-\d{2}-\d{2}\b/gm
const EPISODE_DISGUISE_THRESHOLD = 3

const MEM_ONECLAIM = {
  id: 'MEM-ONECLAIM',
  title: 'One durable claim per reviewed record (episodes are exempt)',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const note of v2Records(ctx)) {
      const claim = note.frontmatter.claim
      if (Array.isArray(claim)) {
        out.push(
          finding(
            'MEM-ONECLAIM',
            'critical',
            note.file,
            `${note.file}: claim is a list of ${claim.length} — a record carries ONE durable claim; split it into ${claim.length} records, or store the whole thing as an episode where many claims are legal`,
          ),
        )
      } else if (typeof claim !== 'string' || claim.trim() === '') {
        out.push(
          finding(
            'MEM-ONECLAIM',
            'critical',
            note.file,
            `${note.file}: no claim — a reviewed record whose one durable sentence is missing says nothing that can be recalled, superseded or checked`,
          ),
        )
      }

      const body = typeof note.body === 'string' ? note.body : ''
      const dated = body.match(DATED_UPDATE_LINE_RE) ?? []
      if (dated.length >= EPISODE_DISGUISE_THRESHOLD) {
        out.push(
          finding(
            'MEM-ONECLAIM',
            'warn',
            note.file,
            `${note.file}: ${dated.length} dated update lines in the body — this reads as a running log, not as one durable claim; history belongs in episodes/, where many claims are legal, with the claim itself extracted here`,
          ),
        )
      }
    }
    return out
  },
}

/**
 * computeTreeHash({paths, execGit, cwd}) — THE definition of a fingerprint's
 * `tree_hash`, exported so that whoever STAMPS a claim and whoever CHECKS one can
 * never drift apart: sha256 over `<path>:<git blob hash>` lines, paths sorted, one
 * trailing newline. Anything else that computes this value is a second definition,
 * and a second definition means every fingerprint eventually reads as drifted.
 *
 * `git hash-object` reads the WORKING TREE, so a claim goes stale the moment the
 * files it describes change — not only once someone commits them. THROWS with a
 * readable reason (no runner, empty path list, unreadable path) instead of
 * returning a sentinel: the caller turns that into an honest "unverified"
 * finding, and a check that cannot verify must never report "verified".
 *
 * Read-only by construction: `hash-object` writes nothing without `-w`.
 *
 * @param {{paths: string[], execGit?: Function, cwd?: string}} args
 * @returns {string} sha256 hex
 */
export function computeTreeHash({ paths, execGit, cwd } = {}) {
  if (typeof execGit !== 'function') {
    throw new Error('no git runner available — inject execGit to verify a file-bound fingerprint')
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('tree_paths is empty — a hash with no paths can never prove drift')
  }
  const lines = []
  for (const path of paths.map(String).sort()) {
    const blob = String(execGit(['hash-object', '--', path], cwd ? { cwd } : {})).trim()
    if (!/^[0-9a-f]{40,}$/.test(blob)) {
      throw new Error(`git returned no object hash for "${path}"`)
    }
    lines.push(`${path}:${blob}`)
  }
  return sha256(lines.join('\n') + '\n')
}

const MEM_FPDRIFT = {
  id: 'MEM-FPDRIFT',
  title: 'A fingerprinted claim still describes the world it was stamped against',
  tier: 'warn',
  run(ctx) {
    const out = []
    for (const note of v2Records(ctx)) {
      const fp = note.frontmatter.fingerprint
      if (fp == null || typeof fp !== 'object' || Array.isArray(fp)) continue

      // ── the epoch half: which version of the product the claim is about ─────
      const stamped = typeof fp.product_version === 'string' ? fp.product_version.trim() : ''
      if (stamped !== '') {
        if (ctx.productVersion == null) {
          out.push(
            finding(
              'MEM-FPDRIFT',
              'warn',
              note.file,
              `${note.file}: fingerprint.product_version "${stamped}" is UNVERIFIED — no product version could be read (looked at ${ctx.productVersionSource}); the claim's epoch is unchecked, which is not the same as current`,
            ),
          )
        } else if (stamped !== ctx.productVersion) {
          out.push(
            finding(
              'MEM-FPDRIFT',
              'warn',
              note.file,
              `${note.file}: fingerprint.product_version "${stamped}" is not the current product version "${ctx.productVersion}" — the claim describes an older epoch; re-verify it and re-stamp, or retire it (nothing here rewrites the record)`,
            ),
          )
        }
      }

      // ── the file-bound half: whether the files it names still hash the same ─
      const hash = typeof fp.tree_hash === 'string' ? fp.tree_hash.trim() : ''
      if (hash === '') continue
      const paths = Array.isArray(fp.tree_paths) ? fp.tree_paths : []
      let recomputed
      try {
        recomputed = computeTreeHash({ paths, execGit: ctx.execGit, cwd: ctx.gitCwd })
      } catch (err) {
        out.push(
          finding(
            'MEM-FPDRIFT',
            'warn',
            note.file,
            `${note.file}: fingerprint.tree_hash is UNVERIFIED — it could not be recomputed (${err.message}); an unverifiable binding is not a valid one`,
          ),
        )
        continue
      }
      if (recomputed !== hash) {
        out.push(
          finding(
            'MEM-FPDRIFT',
            'warn',
            note.file,
            `${note.file}: fingerprint.tree_hash no longer matches the files it names (${paths.map(String).sort().join(', ')}) — the claim is about a state of those files that has since changed`,
          ),
        )
      }
    }
    return out
  },
}

/**
 * The UTC calendar day of a value ('YYYY-MM-DD'), or null when it is not a date.
 * Date-only on purpose: comparing instants would let the machine's timezone decide
 * whether a claim expired, which is a verdict no lint should hand to a clock offset.
 */
function utcDay(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
  const raw = String(value ?? '').trim()
  if (raw === '') return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

const MEM_EXPIRE = {
  id: 'MEM-EXPIRE',
  title: 'An active claim past its horizon is a stale candidate (never auto-deleted)',
  tier: 'warn',
  run(ctx) {
    const out = []
    const today = ctx.today
    if (today == null) return out
    for (const note of v2Records(ctx)) {
      const fm = note.frontmatter
      // Only ACTIVE claims. A record that already says `expired` has been dealt
      // with; re-reporting it would train the reader to ignore this class.
      if (String(fm.status ?? '').trim() !== 'active') continue
      const until = typeof fm.valid_until === 'string' ? fm.valid_until.trim() : ''
      if (until === '') continue
      const day = utcDay(until)
      if (day == null) {
        out.push(
          finding(
            'MEM-EXPIRE',
            'warn',
            note.file,
            `${note.file}: valid_until "${until}" is not a readable date — a horizon nobody can compare against is the same as no horizon at all`,
          ),
        )
        continue
      }
      if (day < today) {
        // The message deliberately names only the record's OWN date: printing
        // today's would make the report text change every midnight for no reader
        // benefit, and this checker's output is meant to be diffable.
        out.push(
          finding(
            'MEM-EXPIRE',
            'warn',
            note.file,
            `${note.file}: status is active but valid_until ${until} has passed — review it (re-verify and extend, supersede, or set status expired). Expiry is a review trigger: nothing here deletes or rewrites a record.`,
          ),
        )
      }
    }
    return out
  },
}

/** Storage classes that must never sit where a public or preset export can see them. */
const RESTRICTED_CLASSES = new Set(['sensitive', 'encrypted-required'])

/** A facet value that says "this record is meant to be seen from outside". */
const PUBLIC_AUDIENCE_RE = /^(?:public|preset|published|release|open)$/i

/**
 * Every place a record declares a public/preset audience, as `label: value`
 * strings. Deliberately a sweep over the audience-bearing blocks rather than one
 * hard-coded key: the field that names an audience is a schema decision that may
 * move, and a placement check that only knows one spelling of "public" is a
 * placement check that will be silently bypassed by the next one.
 */
function publicAudienceMarkers(fm) {
  const hits = []
  const sweep = (label, value) => {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === 'string' && PUBLIC_AUDIENCE_RE.test(v.trim())) hits.push(`${label}: ${v.trim()}`)
    }
  }
  for (const key of ['scope', 'retrieval']) {
    const block = fm[key]
    if (block == null || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [sub, value] of Object.entries(block)) sweep(`${key}.${sub}`, value)
  }
  sweep('applies_to', fm.applies_to)
  return hits
}

/**
 * Content shapes that mark material as sensitive REGARDLESS of what the record
 * says about itself. This is the retrofit half of the placement check: the notes
 * most likely to be holding this material are the oldest ones, written before
 * there was a sensitivity field to fill in, and a screen that only reads the
 * declared class would never look at them.
 *
 * The personal shapes come from the write pipeline's one vocabulary; the
 * security-posture shape is added here because it is a CORPUS problem (an
 * admission about how something is defended is a fact a note records, not a
 * value a pipeline scrubs).
 */
const SENSITIVE_CONTENT_PATTERNS = [
  {
    cls: 'a security-posture admission (a missing second factor)',
    re: /\b(?:2fa|two[-\s]factor(?:\s+authentication)?|second\s+factor|mfa)\b[^.\n]{0,60}?\b(?:not|no|never|without|disabled|absent|missing|off)\b/i,
  },
  {
    cls: 'a security-posture admission (a missing second factor)',
    re: /\b(?:no|without|disabled|missing|lacks?)\b[^.\n]{0,40}?\b(?:2fa|two[-\s]factor(?:\s+authentication)?|second\s+factor|mfa)\b/i,
  },
  // Non-global copies: a /g RegExp carries lastIndex between .test() calls, which
  // would make the verdict depend on how many notes were scanned before this one.
  ...PERSONAL_PATTERNS.map((p) => ({
    cls: `a personal identifier (${p.rule})`,
    re: new RegExp(p.re.source, p.re.flags.replace('g', '')),
  })),
]

const MEM_SENSPLACE = {
  id: 'MEM-SENSPLACE',
  title: 'Sensitive material never sits where a public or preset export can see it',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const note of ctx.parsed) {
      if (note.parseError || !note.frontmatter) continue
      const fm = note.frontmatter
      const sensitivity = typeof fm.sensitivity === 'string' ? fm.sensitivity.trim() : ''

      // ── declared contradiction: CRITICAL ───────────────────────────────────
      // A record that names itself restricted AND names a public audience is not
      // ambiguous and needs no heuristic — it is wrong on its own terms.
      if (note.schemaVersion === 2 && RESTRICTED_CLASSES.has(sensitivity)) {
        for (const marker of publicAudienceMarkers(fm)) {
          out.push(
            finding(
              'MEM-SENSPLACE',
              'critical',
              note.file,
              `${note.file}: sensitivity "${sensitivity}" is contradicted by ${marker} — a ${sensitivity} record must never carry a public/preset marker; either the class or the audience is a mistake, and guessing which is not this checker's job`,
            ),
          )
        }
      }

      // ── undeclared content: WARN ───────────────────────────────────────────
      // In scope: a record that claims a public class, and any note that declares
      // no class at all (every pre-schema note). Out of scope: internal and
      // restricted classes, which are already stored where such material belongs.
      if (sensitivity !== '' && sensitivity !== 'public') continue
      const haystack = [fm.description, fm.claim, note.body]
        .filter((s) => typeof s === 'string')
        .join('\n')
      if (haystack === '') continue
      const hits = new Set()
      for (const { cls, re } of SENSITIVE_CONTENT_PATTERNS) {
        if (re.test(haystack)) hits.add(cls)
      }
      const where = sensitivity === 'public' ? 'sensitivity: public' : 'no sensitivity field at all (schema v1)'
      for (const cls of [...hits].sort()) {
        out.push(
          finding(
            'MEM-SENSPLACE',
            'warn',
            note.file,
            `${note.file}: the content reads as ${cls}, but the record carries ${where} — classify it (sensitivity: sensitive) or remove the material; a public or preset export would carry it out of this installation as written`,
          ),
        )
      }
    }
    return out
  },
}

const MEM_PRIVFACET = {
  id: 'MEM-PRIVFACET',
  title: 'Installation-private facets stay out of public-class records',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const note of v2Records(ctx)) {
      const fm = note.frontmatter
      // Only PUBLIC-class records. An internal record may carry as many
      // installation-private facets as it likes — that is what internal means.
      if (String(fm.sensitivity ?? '').trim() !== 'public') continue
      const retrieval = fm.retrieval
      const areas =
        retrieval != null && typeof retrieval === 'object' && !Array.isArray(retrieval) ? retrieval.areas : null
      for (const [label, value] of [
        ['applies_to', fm.applies_to],
        ['retrieval.areas', areas],
      ]) {
        const values = Array.isArray(value) ? value : value == null ? [] : [value]
        for (const v of values) {
          if (!isPrivateFacet(v)) continue
          out.push(
            finding(
              'MEM-PRIVFACET',
              'critical',
              note.file,
              `${note.file}: ${label} carries the installation-private facet "${String(v).trim()}" in a public-class record — a phase number means nothing outside the installation that minted it, and this is the same leak the release scan exists to catch. Move the record to sensitivity: internal, or drop the facet.`,
            ),
          )
        }
      }
    }
    return out
  },
}

const MEM_EPISODE = {
  id: 'MEM-EPISODE',
  title: 'Episodes carry their minimal archive fields — and nothing heavier',
  tier: 'warn',
  run(ctx) {
    const out = []
    // LIGHT BY DESIGN. History must not rot unread, but it is not held to the
    // reviewed-record discipline: an episode carries no `claim`, may carry a
    // dozen of them in its body, and would fail the record validator on every
    // line. What an archive genuinely knows about itself is the field list below.
    if (ctx.episodesError != null) {
      return [
        finding(
          'MEM-EPISODE',
          'warn',
          EPISODES_DIRNAME,
          `${EPISODES_DIRNAME}/ could not be read: ${ctx.episodesError} — history that cannot be parsed is history that has already begun to rot`,
        ),
      ]
    }
    for (const episode of ctx.episodes) {
      const where = `${EPISODES_DIRNAME}/${episode.file}`
      const fm = episode.frontmatter
      if (fm == null) {
        out.push(finding('MEM-EPISODE', 'warn', where, `${where}: carries no frontmatter — an episode with no archive fields cannot be found again`))
        continue
      }
      const idError = validateId(fm.id, episode.file)
      if (idError) out.push(finding('MEM-EPISODE', 'warn', where, `${where}: ${idError}`))
      if (Number(fm.schema_version) !== 2) {
        out.push(finding('MEM-EPISODE', 'warn', where, `${where}: schema_version "${fm.schema_version ?? ''}" — episodes are schema v2 records`))
      }
      const memoryType = String(fm.memory_type ?? '').trim()
      if (memoryType !== EPISODE_MEMORY_TYPE) {
        out.push(finding('MEM-EPISODE', 'warn', where, `${where}: memory_type "${memoryType}" — an episode is "${EPISODE_MEMORY_TYPE}" by definition`))
      }
      const status = String(fm.status ?? '').trim()
      if (status !== '' && !STATUS_VALUES.includes(status)) {
        out.push(finding('MEM-EPISODE', 'warn', where, `${where}: status "${status}" is outside the closed vocabulary (${STATUS_VALUES.join(' · ')})`))
      }
      for (const field of episodeRequiredFields) {
        const value = fm[field]
        if (value == null || String(value).trim() === '') {
          out.push(finding('MEM-EPISODE', 'warn', where, `${where}: missing archive field "${field}" — the minimal set an episode must carry to stay findable`))
        }
      }
    }
    return out
  },
}

// The check registry — the full R5 class list plus the two D-9-15 checks
// plus the 9.1-09 PRED family (pre-registration integrity).
export const LINT_CHECKS = [
  MEM_VOCAB,
  MEM_ALIAS,
  MEM_SCHEMA,
  MEM_ORPHAN,
  MEM_DUPE,
  MEM_TAGCHAOS,
  MEM_SUPERSEDE,
  MEM_BUGLESSON,
  MEM_WIKILINK,
  MEM_REGEN,
  MEM_CLAUDEDUP,
  MEM_CONTRADICT,
  MEM_SECRET,
  MEM_CORESIZE,
  MEM_NOTESIZE,
  MEM_INDEXSIZE,
  STATE_SIZE,
  PRED_NOMETRIC,
  PRED_POSTEDIT,
  PRED_SKEPTIC,
  PRED_DUPDOD,
  CONS_SCHEMA,
  CONS_POSTEDIT,
  CONS_NOBLOCK,
  RECEIPT_PROSE,
  HAZARD_NOCONTROL,
  LADDER_EVIDENCE,
  PROFILE_DEADFIELD,
  PROFILE_SCHEMA_LINT,
  PROFILE_SECRET,
  FRAG_LINT,
  MEM_V2SCHEMA,
  MEM_ONECLAIM,
  MEM_FPDRIFT,
  MEM_EXPIRE,
  MEM_SENSPLACE,
  MEM_PRIVFACET,
  MEM_EPISODE,
]

// ─────────────────────────── runner ──────────────────────────────────────────

/**
 * The time budget, in milliseconds, or null for "run to completion" (the default
 * and the only shape the release gate accepts as a verdict).
 *
 * Resolution: `opts.budgetMs` (a number, ms — 0 is a legal budget and means
 * "check nothing, tell me so"), else `SMA_LINT_BUDGET` ("90", "90s", "5m", or a
 * bare ms count via SMA_LINT_BUDGET_MS). Anything unparseable is ignored — a
 * typo must never quietly shrink what got checked.
 */
function resolveBudgetMs(opts) {
  if (typeof opts.budgetMs === 'number' && Number.isFinite(opts.budgetMs) && opts.budgetMs >= 0) return opts.budgetMs
  const rawMs = String(process.env.SMA_LINT_BUDGET_MS ?? '').trim()
  if (rawMs !== '' && /^\d+$/.test(rawMs)) return Number(rawMs)
  const raw = String(process.env.SMA_LINT_BUDGET ?? '').trim()
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(raw)
  if (!m) return null
  const n = Number(m[1])
  return m[2] === 'ms' ? n : m[2] === 'm' ? n * 60_000 : n * 1000
}

/**
 * The progress sink. A lint that walks hundreds of files must say so while it
 * walks — a check that looks hung is a check that gets killed.
 *
 * It writes to STDERR, never stdout: stdout carries the report (`--json` is
 * parsed by receipts and by the commit hook) and must stay byte-stable.
 * Default: on when stderr is a terminal, off when it is a pipe or a file, so
 * nothing that captures output ever sees a new line it did not ask for.
 * `SMA_LINT_PROGRESS=1` forces it on (the backgrounded-run case), `=0` off.
 */
function resolveProgress(opts) {
  if (typeof opts.progress === 'function') return opts.progress
  const raw = String(process.env.SMA_LINT_PROGRESS ?? '').trim().toLowerCase()
  const on = raw === '' ? Boolean(process.stderr && process.stderr.isTTY) : !(raw === '0' || raw === 'false' || raw === 'off')
  if (!on) return null
  return (line) => {
    try {
      process.stderr.write(`SMA lint: ${line}\n`)
    } catch {
      /* a closed stderr must never take the lint down */
    }
  }
}

/** Stable sort key: (checkId, file, message). */
function sortFindings(findings) {
  return findings.slice().sort((a, b) => {
    if (a.checkId !== b.checkId) return a.checkId < b.checkId ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}

/**
 * runLint(opts) — drive every check over one corpus and return a stable report.
 *
 * @param {object} opts
 * @param {string} opts.corpusDir  directory of the memory notes
 * @param {string} opts.tagsPath   path to TAGS.md (the registry)
 * @param {string} opts.indexPath  path to MEMORY.md (the index)
 * @param {(committed:string)=>string} [opts.generate]  regeneration fn (9-09 / test)
 * @param {string} [opts.claudeMdPath]  path to CLAUDE.md (for MEM-CLAUDEDUP)
 * @param {string} [opts.plansDir]  root of *-PLAN.md files (for the PRED family, 9.1-09)
 * @param {(args:string[], o?:{cwd?:string})=>string} [opts.execGit]  read-only git runner (PRED-POSTEDIT)
 * @param {number} [opts.budgetMs]  wall-clock budget; past it the run STOPS and says what it did not check
 * @param {(line:string)=>void} [opts.progress]  progress sink (default: stderr when it is a terminal)
 * @returns {{critical:number, warn:number, info:number, findings:Array, summary:string, exitCode:number,
 *   partial?:boolean, skipped?:string[], truncated?:Array, budgetMs?:number}}
 */
export function runLint(opts) {
  const startedAt = Date.now()
  const budgetMs = resolveBudgetMs(opts)
  const deadline = budgetMs === null ? null : startedAt + budgetMs
  const progress = resolveProgress(opts)
  const truncated = []

  if (progress) progress(`reading corpus${opts.plansDir ? ' + plans' : ''}…`)
  const ctx = buildContext(opts)
  if (progress) {
    progress(`${ctx.files.length} notes, ${ctx.plans.length} plans, ${ctx.summaries.length} summaries, ${LINT_CHECKS.length} checks`)
  }

  // The budget is a property of the RUN, and the checks that walk hundreds of
  // files honour it mid-walk — a budget only enforced between checks would be
  // no budget at all on the corpus that made this necessary.
  ctx.overBudget = deadline === null ? null : () => Date.now() >= deadline
  ctx.noteTruncation = (checkId, done, total, unit) => {
    truncated.push({ checkId, checked: done, total, unit: unit ?? 'items' })
  }
  ctx.tick = progress
    ? (checkId, done, total, unit) => {
        if (done % 25 === 0 || done === total) progress(`  ${checkId} ${done}/${total} ${unit ?? 'items'}`)
      }
    : null

  let findings = []
  const skipped = []
  let n = 0
  for (const check of LINT_CHECKS) {
    n++
    if (deadline !== null && Date.now() >= deadline) {
      skipped.push(check.id)
      continue
    }
    if (progress) progress(`[${n}/${LINT_CHECKS.length}] ${check.id} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
    try {
      const res = check.run(ctx)
      if (Array.isArray(res)) findings.push(...res)
    } catch (err) {
      // FAIL-SOFT (T-9-08-02): a broken check becomes a WARN, never a crash.
      findings.push(finding(check.id, 'warn', '', `lint check ${check.id} threw and was skipped: ${err.message}`))
    }
  }

  // A partial lint SAYS it is partial, in the findings and in the summary line
  // and in the exit code. Silent truncation would turn a budget into a lie.
  const partial = skipped.length > 0 || truncated.length > 0
  if (partial) {
    const cut = truncated.map((t) => `${t.checkId} stopped at ${t.checked}/${t.total} ${t.unit}`)
    // Name the first few and count the rest; the FULL list is in report.skipped,
    // which is the surface a machine reads.
    const named = skipped.slice(0, 8).join(', ') + (skipped.length > 8 ? `, +${skipped.length - 8} more` : '')
    const notRun = skipped.length ? `${skipped.length} of ${LINT_CHECKS.length} checks did not run (${named})` : ''
    findings.push(
      finding(
        'LINT-BUDGET',
        'warn',
        '',
        `PARTIAL RUN — the ${(budgetMs / 1000).toFixed(1)}s budget (SMA_LINT_BUDGET / --budget) ran out: ${[notRun, ...cut].filter(Boolean).join('; ')}. This report is NOT a verdict on what it did not read; re-run without a budget before quoting it.`,
      ),
    )
  }

  findings = sortFindings(findings)
  const critical = findings.filter((f) => f.tier === 'critical').length
  const warn = findings.filter((f) => f.tier === 'warn').length
  const info = findings.filter((f) => f.tier === 'info').length

  return {
    critical,
    warn,
    info,
    findings,
    // The partial fields and the partial suffix appear ONLY on a run that was
    // actually cut short: a complete run's report is byte-identical to the one
    // this verb produced before the budget existed (instrument integrity).
    summary: partial
      ? `${critical} critical, ${warn} warn, ${info} info — PARTIAL (${(budgetMs / 1000).toFixed(1)}s budget; ${skipped.length} of ${LINT_CHECKS.length} checks did not run)`
      : `${critical} critical, ${warn} warn, ${info} info`,
    // The commit-hook tier (9-12) consumes this: critical blocks, warnings do not.
    // 2 is the third answer a budget makes possible: "no verdict — I was stopped".
    // It is non-zero on purpose, so a hook fails CLOSED on an unfinished check.
    exitCode: critical > 0 ? 1 : partial ? 2 : 0,
    ...(partial ? { partial: true, budgetMs, skipped, truncated } : {}),
  }
}
