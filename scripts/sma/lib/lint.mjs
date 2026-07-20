/**
 * lint.mjs — memory-lint (R5): the ONE deterministic checker for the whole
 * memory layer. Structural twin of the security guard's checks.mjs:
 * LINT_CHECKS is an array of {id, title, tier, run(ctx)}; runLint drives them,
 * collects findings, and returns a stable-sorted report.
 *
 * DESIGN INVARIANTS (49-08 execution rules):
 *   - READ-ONLY (C4): no check writes, fixes, or deletes anything in the corpus.
 *     This module imports ONLY read APIs from node:fs (readFileSync, readdirSync,
 *     statSync). Auto-fix is out of scope for V1.
 *   - DETERMINISTIC: same tree → byte-identical report. Findings are sorted by
 *     (checkId, file, message); no timestamps inside the report body.
 *   - FAIL-SOFT (T-49-08-02): a check that throws is converted to a WARN finding
 *     rather than crashing the whole run — the commit hook (49-12) is additionally
 *     fail-open.
 *
 * Exports (consumed by the CLI 49-10, migration 49-11, flip 49-14, snapshot 49-13):
 *   - LINT_CHECKS : the array of check objects.
 *   - runLint({corpusDir, tagsPath, indexPath, ...}) -> {critical, warn, info,
 *       findings[], summary}.
 *
 * The corpus is accessed ONLY through frontmatter.mjs (parseNote + loadTagsRegistry
 * + resolveAlias) — the single shared read path (49-04).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { parseNote, loadTagsRegistry, resolveAlias } from './frontmatter.mjs'
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
import { parseReceipts, parseCoverage, validateReceipt } from './receipts.mjs'
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

/** Where the regeneration module lands in the same wave (49-09). */
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
 * ALSO runs on the dogfood platform, whose .planning/phases shares the phase-
 * NUMBER namespace with unrelated GSD medical phases (50-55+). A numeric phase
 * cutover alone would retro-fail those medical summaries (which legitimately use
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
      const { frontmatter, body } = parseNote(text, { file })
      parsed.push({ file, frontmatter, body, text })
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

  return {
    corpusDir,
    tagsPath,
    indexPath,
    registry,
    files,
    parsed,
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

const MEM_SUPERSEDE = {
  id: 'MEM-SUPERSEDE',
  title: 'Supersession-link integrity (B6)',
  tier: 'critical',
  run(ctx) {
    const out = []
    const onDisk = new Set(ctx.files)
    // Map each note file → its parsed frontmatter for back-pointer symmetry.
    const fmByFile = new Map()
    for (const note of ctx.parsed) {
      if (note.frontmatter) fmByFile.set(note.file, note.frontmatter)
    }

    for (const note of ctx.parsed) {
      const fm = note.frontmatter
      if (!fm) continue

      // supersedes / superseded_by targets must exist on disk (CRITICAL).
      for (const key of ['supersedes', 'superseded_by']) {
        const target = fm[key]
        if (!target || String(target).trim() === '') continue
        const targetFile = basename(String(target).trim())
        if (!onDisk.has(targetFile)) {
          out.push(finding('MEM-SUPERSEDE', 'critical', note.file, `${key} target "${targetFile}" does not exist on disk (${note.file})`))
        }
      }

      // Back-pointer symmetry: A.superseded_by=B implies B.supersedes=A (WARN).
      const succ = fm.superseded_by ? basename(String(fm.superseded_by).trim()) : ''
      if (succ && onDisk.has(succ)) {
        const succFm = fmByFile.get(succ)
        const back = succFm?.supersedes ? basename(String(succFm.supersedes).trim()) : ''
        if (back !== note.file) {
          out.push(finding('MEM-SUPERSEDE', 'warn', note.file, `${note.file}.superseded_by="${succ}" has no matching back-pointer supersedes in "${succ}"`))
        }
      }

      // superseded_at without superseded_by is dangling metadata (WARN).
      const hasAt = fm.superseded_at != null && String(fm.superseded_at).trim() !== ''
      const hasBy = fm.superseded_by != null && String(fm.superseded_by).trim() !== ''
      if (hasAt && !hasBy) {
        out.push(finding('MEM-SUPERSEDE', 'warn', note.file, `superseded_at present without superseded_by in ${note.file}`))
      }
    }
    return out
  },
}

const MEM_BUGLESSON = {
  id: 'MEM-BUGLESSON',
  title: 'bug-lesson body form: Why + How to apply (D-9-15)',
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
  title: 'Wikilink integrity: every [[name]] resolves (D-9-15)',
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
      out.push(finding('MEM-REGEN', 'info', ctx.indexPath, `MEMORY.md carries no ${GENERATED_MARKER} header — pending flip (49-14); regeneration byte-compare is not yet enforced`))
      return out
    }
    // Post-flip: byte-compare the committed artifact against regeneration.
    // The generator is injected (test / CLI) or lazy-loaded from generator.mjs.
    const generate = ctx.generate
    if (typeof generate !== 'function') {
      // The module lands in the same wave (49-09) — degrade, never crash (P4).
      const landed = existsSync(GENERATOR_PATH)
      const why = landed
        ? 'generator.mjs is present but no generate() was supplied to runLint'
        : 'generator.mjs has not landed yet (49-09)'
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
  title: 'CLAUDE.md ↔ note duplication (D-9-08)',
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
        out.push(finding('MEM-CLAUDEDUP', 'warn', note.file, `note ${note.file} description duplicates a CLAUDE.md rule line — CLAUDE.md is the source of truth (D-9-08)`))
      }
    }
    return out
  },
}

// ── 9.1-12: MEM-CONTRADICT — bi-temporal same-subject conflicts (B5) ─────────

const MEM_CONTRADICT = {
  id: 'MEM-CONTRADICT',
  title: 'Same-subject conflicting decision/status notes, both active, unlinked (B5)',
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
    for (const plan of ctx.plans) {
      const nowBlock = extractPredictionsBlock(plan.text)
      let firstText
      try {
        // All git ops run with cwd = the plan's own directory and cwd-relative
        // paths (`<hash>:./<name>`), so Windows 8.3 short-path tmpdirs never
        // desync from git's long-name toplevel.
        const cwd = dirname(plan.path)
        const name = basename(plan.path)
        // First commit = the LAST line of the --diff-filter=A first-parent walk.
        const log = String(execGit(['log', '--follow', '--diff-filter=A', '--format=%H', '--', name], { cwd })).trim()
        const hashes = log.split('\n').filter(Boolean)
        if (!hashes.length) continue // never committed — predictions not locked yet
        const first = hashes[hashes.length - 1]
        firstText = String(execGit(['show', `${first}:./${name}`], { cwd }))
      } catch {
        continue // fail-soft: outside a repo / git error → no verdict on this plan
      }
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
            ? 'has no skeptic countersign — a skeptic distinct from the implementer must sign it (pnpm sma skeptic sign)'
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
  title: 'Consequences entries carry the full {id, trigger, blocks, until} contract (D-9.2-12)',
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
    for (const plan of ctx.plans) {
      const nowBlock = extractFrontmatterBlock(plan.text, 'consequences')
      let firstText
      try {
        const cwd = dirname(plan.path)
        const name = basename(plan.path)
        const log = String(execGit(['log', '--follow', '--diff-filter=A', '--format=%H', '--', name], { cwd })).trim()
        const hashes = log.split('\n').filter(Boolean)
        if (!hashes.length) continue // never committed — the law is not locked yet
        const first = hashes[hashes.length - 1]
        firstText = String(execGit(['show', `${first}:./${name}`], { cwd }))
      } catch {
        continue // fail-soft: outside a repo / git error → no verdict on this plan
      }
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
  title: 'A plan with predictions must declare what a class-A miss blocks (D-9.2-15)',
  tier: 'warn',
  run(ctx) {
    const out = []
    for (const plan of ctx.plans) {
      const hasPredictions = extractFrontmatterBlock(plan.text, 'predictions') !== ''
      const hasConsequences = extractFrontmatterBlock(plan.text, 'consequences') !== ''
      if (hasPredictions && !hasConsequences) {
        out.push(finding('CONS-NOBLOCK', 'warn', basename(plan.path), `${basename(plan.path)} carries a predictions block but no consequences block — a prediction without a consequence is a diary entry; declare what a class-A miss blocks (D-9.2-15)`))
      }
    }
    return out
  },
}

// ── 9.2-03: RECEIPT-PROSE — a machine «done» must carry a re-runnable receipt ─

const RECEIPT_PROSE = {
  id: 'RECEIPT-PROSE',
  title: 'A machine-verifiable «done» carries a structural receipt, not prose (D-9.2-06)',
  tier: 'critical',
  run(ctx) {
    const out = []
    for (const s of ctx.summaries ?? []) {
      const phase = summaryPhase(s.path)
      if (phase == null) continue
      // Regime gate: the receipts law is SMA-only. On the dogfood platform the
      // phase-number namespace is shared with unrelated GSD medical phases —
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
      for (const r of receipts) {
        const v = validateReceipt(r)
        if (!v.valid) {
          const why = [...v.missing.map((m) => `missing ${m}`), ...v.errors].join('; ')
          out.push(finding('RECEIPT-PROSE', 'critical', basename(s.path), `receipt "${r.id ?? '<no id>'}" in ${basename(s.path)} is malformed: ${why} — a receipt that cannot be validated cannot re-verify a claim`))
        } else if (!isSafeCommand(r.check_command)) {
          out.push(finding('RECEIPT-PROSE', 'critical', basename(s.path), `receipt "${r.id}" in ${basename(s.path)} has a non-allowlisted check_command — it can never be re-verified across the SAFE_COMMAND boundary`))
        }
      }

      // Every machine-verifiable coverage item (human_judgment: false) MUST bind
      // a valid, allowlisted receipt by coverage_id — else it is prose, not proof.
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
        `kill-switch ${k} has no compensating control in the HAZARDS registry (lib/stpa.mjs) — a switch that can silently disable a protection with no cited mitigation is an STPA violation (D-9.2-14); add a HAZARDS row with a non-empty compensatingControl + birth fixture`,
      ),
    )
  },
}

// ── 9.3-06 (D-9.3-12): LADDER-EVIDENCE — no evidence-free tier escalation ────

const LADDER_EVIDENCE = {
  id: 'LADDER-EVIDENCE',
  title: 'Every ladder tier change carries evidence rows with journalRefs; retirements cite a fixture check (D-9.3-12)',
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
          out.push(finding('LADDER-EVIDENCE', 'critical', file, `rule ${rule.ruleId} sits at tier '${tier}' with no evidence rows carrying journalRefs — a tier change without measured benefit is forbidden (D-9.3-12); tune only via \`pnpm sma tune --apply\`, never a hand-edit`))
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
  title: 'Secret material screened at the corpus door (T-9.1-27)',
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
  title: 'Committed profile carries no unknown/mistyped field (D-9.3-04)',
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
  title: 'Committed profile stores NAMES + facts only, never a secret value (T-9.3-06)',
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
]

// ─────────────────────────── runner ──────────────────────────────────────────

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
 * @param {(committed:string)=>string} [opts.generate]  regeneration fn (49-09 / test)
 * @param {string} [opts.claudeMdPath]  path to CLAUDE.md (for MEM-CLAUDEDUP)
 * @param {string} [opts.plansDir]  root of *-PLAN.md files (for the PRED family, 9.1-09)
 * @param {(args:string[], o?:{cwd?:string})=>string} [opts.execGit]  read-only git runner (PRED-POSTEDIT)
 * @returns {{critical:number, warn:number, info:number, findings:Array, summary:string, exitCode:number}}
 */
export function runLint(opts) {
  const ctx = buildContext(opts)

  let findings = []
  for (const check of LINT_CHECKS) {
    try {
      const res = check.run(ctx)
      if (Array.isArray(res)) findings.push(...res)
    } catch (err) {
      // FAIL-SOFT (T-49-08-02): a broken check becomes a WARN, never a crash.
      findings.push(finding(check.id, 'warn', '', `lint check ${check.id} threw and was skipped: ${err.message}`))
    }
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
    summary: `${critical} critical, ${warn} warn, ${info} info`,
    // The commit-hook tier (49-12) consumes this: critical blocks, warnings do not.
    exitCode: critical > 0 ? 1 : 0,
  }
}
