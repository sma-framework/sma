#!/usr/bin/env node
/**
 * verify-rebrand.mjs — integrity gate for the gsd -> sma atomic rebrand.
 *
 * Plan 9.1-02 Task 2 (T-9.1-03 / T-9.1-04 mitigations). Three checks:
 *   (a) DISPATCH: every subagent_type value in sma-core/workflows/** resolves
 *       to an existing sma-core/agents/<name>.md (broken dispatch is invisible
 *       until a command runs — FI-7).
 *   (b) ZERO RESIDUE: no old brand token (gsd / GSD / Gsd, case-sensitive
 *       alternation — avoids camelCase false positives like "learningsDelete")
 *       anywhere in sma-core/** contents or filenames, outside the fixed
 *       exclusions (the aliases/ layer intentionally carries the old prefix).
 *   (c) COLORS: every sma-core/agents/sma-*.md frontmatter carries a color field.
 *   (d) INTERNAL IDS: no internal register id (threat `T-<phase>-<n>`, decision
 *       `D-<phase>-<n>`, deferred item `D-<phase>-DEFER-<n>`, private backlog
 *       `SB-<n>`) survives in a PUBLISHED surface. These ids are house
 *       bookkeeping; read by an adopter they are noise that references a
 *       register the adopter cannot open.
 *   (e) INTERNAL PLAN SHAPES: no bare house plan id (a plan/phase word followed
 *       by a compound `9.5-10` id, by a wildcard `49.x` id, or by a zero-padded
 *       slash pair `05/09`) survives in published markdown. Same reason as (d):
 *       it points at a register the adopter cannot read.
 *
 * WHAT "PUBLISHED" MEANS HERE — the git-tracked set, and the reason for it.
 * A push publishes the REPOSITORY, not the npm tarball: `files[]` in package.json
 * is the narrower shop window, and scanning only it left the agent-facing markdown
 * under `sma-core/**` and the root test config unread while both become
 * world-readable the moment `main` is pushed. So checks (d) and (e) enumerate
 * `git ls-files`. If git cannot be run, the tool SAYS SO on stderr and falls back
 * to a filesystem walk — a surface it cannot enumerate is a finding, not a pass.
 *
 * Inside that set, per file class:
 *   - MARKDOWN (`*.md`), wherever it lives: every line. Markdown has no "comment"
 *     class — every line ships as content. This now includes `sma-core/**`, whose
 *     earlier exclusion ("agent-facing instructions, not adopter-facing output")
 *     was the hole: an agent-facing file is still a published file.
 *   - ROOT BUILD/TEST CONFIG (`*.config.{mjs,js,cjs,ts}` at the repo root): the
 *     whole file, comments included. A handful of short hand-written files whose
 *     comments ARE their documentation — there is no archaeology to lose.
 *   - OTHER SHIPPED CODE: string literals only (see below).
 *   - `description` in any package.json (the npm shop window).
 * What is deliberately NOT scanned, and why:
 *   - COMMENT TEXT inside the runtime source trees (`scripts/`, `daemon/`, `spa/`,
 *     `supervisor/`, `tools/`, `bin/`, `sma-core/bin/`). It ships in source but
 *     never prints, and several hundred such comments carry decision ids that are
 *     the only surviving link between a line of code and the reasoning that put it
 *     there. Whether they go is an OPEN DECISION with a real archaeology cost, and
 *     this tool must not pre-empt it by conflating the two classes.
 *   - `__tests__/`, `fixtures/`, `assets/demos/` — synthetic and sample ids are
 *     sanctioned there (a demo of decision-locking must show decision ids).
 *   - `BL-<n>`: NOT an internal-only shape. It is the PRODUCT's own backlog item
 *     id — minted and parsed by `scripts/sma/lib/batch.mjs`, documented in
 *     `docs/VENDOR-LEDGER.md`. Banning it would fail the product's own vocabulary.
 *   - single-letter register prefixes (`P5`, `B14`, `FI-2`): a residue of the same
 *     class, left uncovered on purpose — the shapes collide with ordinary prose and
 *     with product vocabulary, so a blind ban costs more false positives than the
 *     leak is worth. Removed by hand where found, not by rule.
 *   - an UNPADDED slash pair (`phases 51/52`, `plans 12/13`): the same variant of
 *     (e), left uncovered on purpose. The zero padding is what separates a house
 *     cross-reference from progress notation ("15/15 plans executed", "Phase
 *     63/7"); without it the two shapes are the same three characters and a ban
 *     costs more false positives than the leak is worth. The padded half IS armed
 *     — see PLAN_PAIR below for the three discriminators it leans on.
 *   - bare plan/phase numbering (`9.4-01`) STANDING ALONE — check (e) picks up only
 *     the narrower case where a plan/phase word introduces it.
 *   - prediction ids (`P9.3-12-A`) IN PROSE — they are legitimate data in the
 *     documented `prediction` / `tripwire` table columns, where removing them
 *     would break the traceability that makes a prediction checkable. They are
 *     banned from string literals only, where they are noise.
 *
 * Exit 0 = rebrand intact. Exit 1 = violations listed on stderr.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE = path.join(ROOT, 'sma-core')
const AGENTS = path.join(CORE, 'agents')
const WORKFLOWS = path.join(CORE, 'workflows')

const OLD_TOKEN = /gsd|GSD|Gsd/ // case-sensitive alternation, not /gsd/i
const ATTRIBUTION_LINE = /derived from gsd-core/i

const errors = []

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (path.relative(CORE, p).split(path.sep)[0] === 'aliases') continue // D-9.1-02 exclusion
      walk(p, out)
    } else if (entry.isFile()) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

/** Unfiltered recursive walk (check (d) does its own exclusions). */
function walkAll(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walkAll(p, out)
    } else if (entry.isFile()) out.push(p)
  }
  return out
}

// ---- (a) dispatch integrity -------------------------------------------------
const agentFiles = new Set(fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')))
const DISPATCH_RE = /subagent_type\s*[=:]\s*"([A-Za-z0-9._-]+)"/g
let dispatchCount = 0
for (const file of walk(WORKFLOWS)) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(DISPATCH_RE)) {
    const name = m[1]
    if (name === 'general-purpose') continue // built-in harness agent, not ours
    dispatchCount++
    if (!agentFiles.has(name)) {
      errors.push(`DISPATCH: ${rel(file)} dispatches "${name}" but sma-core/agents/${name}.md does not exist`)
    }
    if (/^gsd-/.test(name)) {
      errors.push(`DISPATCH: ${rel(file)} still dispatches old-brand agent "${name}"`)
    }
  }
}

// ---- (b) zero residue -------------------------------------------------------
let residueHits = 0
for (const file of walk(CORE)) {
  if (OLD_TOKEN.test(path.basename(file))) {
    errors.push(`RESIDUE(filename): ${rel(file)}`)
    residueHits++
  }
  const buf = fs.readFileSync(file)
  if (buf.includes(0)) continue // binary
  const lines = buf.toString('utf8').split('\n')
  lines.forEach((line, i) => {
    if (ATTRIBUTION_LINE.test(line)) return // attribution stays verbatim (fixed exclusion)
    if (OLD_TOKEN.test(line)) {
      errors.push(`RESIDUE: ${rel(file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
      residueHits++
    }
  })
}

// ---- (d) internal register ids in published surfaces ------------------------
/**
 * Internal register id. Three house shapes:
 *   `T-9.1-43` / `D-11-08`  — threat and decision ids;
 *   `D-11-DEFER-05`         — the deferred-item register. The WORD segment is why
 *                             the older pattern walked past it: that pattern wants
 *                             digits straight after the phase number, and this
 *                             shape has a word there;
 *   `SB-031`                — the private product backlog.
 * NOT bare plan numbering (`9.4-01`), which is public, and NOT `BL-<n>`, which is
 * the product's own backlog id format (see the header).
 */
const INTERNAL_ID = /\b(?:[TDQ]-\d+(?:\.\d+)?-(?:[A-Z]{2,}-)?\d+[a-z]?|SB-\d{3})\b/
/**
 * Prediction register id (`P9.3-12-A`). Applied to CODE STRING LITERALS ONLY, not
 * to docs: a prediction id is legitimate DATA in a documented table column (the
 * `prediction` column of the instruments table, the `tripwire` column of
 * docs/VENDOR-LEDGER.md), where deleting it would destroy the traceability that
 * makes the prediction checkable. In printed output it is pure noise, and the
 * count there is currently zero — this rule keeps it zero.
 */
const PREDICTION_ID = /\bP\d+\.\d+-\d+(?:-[A-Za-z0-9]+)?\b/

/** Sanctioned: synthetic ids belong here. */
const ID_EXCLUDED = /(^|\/)(node_modules|__tests__|fixtures|assets\/demos)(\/|$)/
/** Code whose comment text is the open-decision class: string literals only. */
const CODE_EXT = /\.(?:mjs|js|cjs|ts|tsx)$/
/** Root build/test config: short, hand-written, its comments are its documentation. */
const ROOT_CONFIG = /^[^/]+\.config\.(?:mjs|js|cjs|ts)$/

/**
 * The published surface: everything git tracks. A push publishes the repository,
 * so the git index — not `files[]` — is the honest enumeration. Fail LOUD, never
 * quiet: a surface this tool cannot enumerate is a finding.
 */
function publishedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return out.split('\0').filter(Boolean)
  } catch (e) {
    console.error(`WARNING: \`git ls-files\` failed (${String(e.message).split('\n')[0]}) — falling back to a filesystem walk, which may include untracked files`)
    return walkAll(ROOT).map(rel)
  }
}

/**
 * Lines of `text` whose id sits inside a quoted literal (not a comment). Keeps
 * check (d) off the comment class, which is out of scope by design.
 */
function idsInStringLiterals(text) {
  const hits = []
  const LITERAL = /(['"`])[^'"`]*(?:[TDQ]-\d+(?:\.\d+)?-(?:[A-Z]{2,}-)?\d+[a-z]?|SB-\d{3}|P\d+\.\d+-\d+(?:-[A-Za-z0-9]+)?)[^'"`]*\1/
  text.split('\n').forEach((line, i) => {
    if (!INTERNAL_ID.test(line) && !PREDICTION_ID.test(line)) return
    const t = line.trim()
    if (/^(\/\/|\*|\/\*|#)/.test(t)) return // whole-line comment
    const c = t.indexOf('//')
    const head = t.slice(0, c)
    if (c > -1 && !INTERNAL_ID.test(head) && !PREDICTION_ID.test(head)) return // id lives in a trailing comment
    if (!LITERAL.test(t)) return // not in a literal
    hits.push({ n: i + 1, line: t.slice(0, 120) })
  })
  return hits
}

const PUBLISHED = publishedFiles()
let idScanned = 0
let mdScanned = 0
{
  for (const r of PUBLISHED) {
    if (ID_EXCLUDED.test(r)) continue
    const abs = path.join(ROOT, r)
    if (!fs.existsSync(abs)) continue // tracked, but deleted in the worktree
    const isDoc = r.endsWith('.md')
    const isCode = CODE_EXT.test(r)
    const isPkg = path.basename(r) === 'package.json'
    if (!isDoc && !isCode && !isPkg) continue
    const buf = fs.readFileSync(abs)
    if (buf.includes(0)) {
      // A NUL byte makes a text scan meaningless — and skipping SILENTLY once hid
      // five runtime files from this check. A file the scan cannot read is a
      // finding, not an exemption: put the byte in a \u0000 escape and it scans.
      errors.push(`INTERNAL-ID: ${r}: carries raw NUL bytes, so check (d) cannot read it — replace them with \\u0000 escapes`)
      continue
    }
    const text = buf.toString('utf8')
    idScanned++
    if (isDoc) mdScanned++
    // Markdown and root config are read WHOLE, comments included; other shipped
    // code is read through its string literals only — header's scope block says why.
    if (isDoc || (isCode && ROOT_CONFIG.test(r))) {
      if (!INTERNAL_ID.test(text)) continue
      text.split('\n').forEach((line, i) => {
        if (INTERNAL_ID.test(line)) errors.push(`INTERNAL-ID: ${r}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    } else if (isPkg) {
      if (!INTERNAL_ID.test(text)) continue
      let pkg
      try { pkg = JSON.parse(text) } catch { continue }
      if (typeof pkg.description === 'string' && INTERNAL_ID.test(pkg.description)) {
        errors.push(`INTERNAL-ID: ${r}: package description carries an internal register id`)
      }
    } else {
      // Prediction ids are banned from literals too, so the cheap pre-filter has to
      // ask about BOTH shapes — asking about one silently skipped the other.
      if (!INTERNAL_ID.test(text) && !PREDICTION_ID.test(text)) continue
      for (const h of idsInStringLiterals(text)) errors.push(`INTERNAL-ID: ${r}:${h.n}: ${h.line}`)
    }
  }
}

// ---- (e) internal plan shapes in published markdown -------------------------
/**
 * A house plan id in PUBLISHED markdown. The leak shape is a plan/phase word
 * introducing a compound id (`plan 9.5-10`, `плана 9.1-04`, `phase 9.1-26`), a
 * wildcard one (`plan 49.x`), or a zero-padded slash pair (`plans 05/09`). The
 * number names a register no adopter can read.
 *
 * The match is CONTEXTUAL — the word has to introduce the number — which is what
 * keeps the false-positive floor honest. Deliberately NOT flagged:
 *   - semver (`5.1.0`), dates (`20.07.2026`), ports (`:5433`): none of them carry
 *     the `N.N-NN` / `N.x` shape, and none is introduced by a plan word;
 *   - bare `Phase 2.1`, `/sma-plan-phase 5.1`: the ADOPTER'S OWN numbering, which
 *     is documented product vocabulary in the templates, workflows and help;
 *   - a bare id nobody introduces (`- [ ] 02.1-01: [Description]`, the documented
 *     plan-file naming convention) — same reason.
 */
const PLAN_WORD = String.raw`(?:plans?|phases?|план\p{L}*|фаз\p{L}*)`
/**
 * Words that turn a number pair into PROGRESS. Used as a negative lookahead on the
 * slash-pair branch only — a cross-reference is followed by punctuation or prose,
 * a count is followed by what is being counted.
 */
const PROGRESS_WORD = String.raw`(?:complete|completed|done|executed|passed|verified|green|remaining|left|answered|tasks?|steps?|plans?|phases?|выполн\p{L}*|заверш\p{L}*|готов\p{L}*|осталось|шаг\p{L}*|задач\p{L}*)`
/**
 * ARMED 2026-08-05 — the slash-pair cross-reference (`plans 05/09`, «планы 05/09»).
 * It was deliberately unarmed until now because the naive two-number pair collides
 * with progress notation, which this repository's own markdown is full of ("3/3
 * plans executed", "Phase 63/7", "Plans: 3/5 complete", "2/2 plans complete").
 * Three discriminators, read off that real corpus, keep the two apart:
 *
 *   1. ZERO PADDING. A house plan number is padded to two digits (`05`, `09`); a
 *      count never is. Across every git-tracked markdown file exactly two padded
 *      pairs exist, and one of them was the offender this rule was armed for.
 *   2. WORD ORDER. The plan word has to INTRODUCE the pair, which is inherited
 *      from check (e)'s contextual shape. Progress puts the word after the count
 *      ("15/15 plans executed") or behind a colon ("Plans: 3/5"), and neither
 *      reaches this pattern.
 *   3. WHAT FOLLOWS. A pair trailed by a counting word is progress even when it is
 *      padded, and an identical pair (`05/05`) is a count of itself, never a
 *      cross-reference between two plans. Both are excluded by name.
 *
 * A pair followed by another `/` is a date or a longer id, not this shape.
 */
const PLAN_PAIR = String.raw`(?!(?<pp>\d{2})/\k<pp>)(?:0\d/\d{2}|\d{2}/0\d)(?!/)(?!\s+${PROGRESS_WORD})`
const PLAN_SHAPE = String.raw`(?:\d{1,2}\.\d{1,2}-\d{1,3}|\d{1,2}\.x|${PLAN_PAIR})`
const INTERNAL_PLAN = new RegExp(
  // trailing guard: not a longer number, and not the `02.1-01-PLAN.md` file name
  String.raw`(?<![\p{L}\p{N}])${PLAN_WORD}\s*[№#]?\s*${PLAN_SHAPE}(?![\p{L}\p{N}]|-[A-Za-z])`,
  'iu',
)

// Same surface as check (d): the git-tracked set, not `files[]`. The npm allowlist
// was the narrower of the two and left published markdown unread.
let shippedDocsScanned = 0
for (const r of PUBLISHED) {
  if (!r.endsWith('.md')) continue
  if (ID_EXCLUDED.test(r)) continue
  const abs = path.join(ROOT, r)
  if (!fs.existsSync(abs)) continue
  shippedDocsScanned++
  const text = fs.readFileSync(abs, 'utf8')
  if (!INTERNAL_PLAN.test(text)) continue
  text.split('\n').forEach((line, i) => {
    if (INTERNAL_PLAN.test(line)) errors.push(`PLAN-ID: ${r}:${i + 1}: ${line.trim().slice(0, 120)}`)
  })
}

// ---- (c) colors -------------------------------------------------------------
let colorCount = 0
for (const name of fs.readdirSync(AGENTS).sort()) {
  if (!name.endsWith('.md')) continue
  const text = fs.readFileSync(path.join(AGENTS, name), 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m || !/^color:\s*\S+/m.test(m[1])) {
    errors.push(`COLOR: sma-core/agents/${name} has no color field in frontmatter`)
  } else colorCount++
}

// ---- report -----------------------------------------------------------------
console.log(`dispatch sites checked: ${dispatchCount}`)
console.log(`agents with color: ${colorCount}/${[...fs.readdirSync(AGENTS)].filter((f) => f.endsWith('.md')).length}`)
console.log(`residue hits: ${residueHits}`)
console.log(`published files scanned for internal ids: ${idScanned} (of which markdown: ${mdScanned})`)
console.log(`published markdown scanned for internal plan shapes: ${shippedDocsScanned}`)
if (errors.length) {
  console.error(`\nFAIL — ${errors.length} violation(s):`)
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log('OK — rebrand intact (dispatch resolves, zero residue, colors applied, no internal ids in published markdown / root config / user-facing strings, no internal plan shapes in published markdown)')
