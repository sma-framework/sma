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
 *   (d) INTERNAL IDS: no internal register id (threat `T-<phase>-<n>` / decision
 *       `D-<phase>-<n>`) survives in a USER-FACING surface. These ids are house
 *       bookkeeping; printed at an adopter they are noise that references a
 *       register the adopter cannot read.
 *
 * SCOPE BOUNDARY of check (d) — stated honestly, because "is this string printed
 * to a user?" is not statically decidable. What IS scanned:
 *   - string literals in shipped runtime JS (USER_FACING_CODE below), i.e. the
 *     lint/check titles, warn+error texts and CLI output that reach a terminal;
 *   - shipped user-facing prose (USER_FACING_DOCS): the READMEs, docs/*.md, the
 *     engine README, the statusline snippet an adopter pastes into a config;
 *   - `description` fields in any package.json (the npm shop window).
 * What is deliberately NOT scanned, and why:
 *   - CODE COMMENTS. They ship in source but never print. Scanning them would
 *     force ~980 rewrites across 168 files and would delete the design rationale
 *     that makes the code auditable. Tracked as a known, accepted residue.
 *   - `sma-core/**` workflow/agent/reference prompts — agent-facing instructions,
 *     not adopter-facing output.
 *   - `__tests__/`, `fixtures/`, `assets/demos/` — synthetic and sample ids are
 *     sanctioned there (a demo of decision-locking must show decision ids).
 *   - bare plan/phase numbering (`9.4-01`) — the sanctioned public numbering used
 *     across docs/DETAILS*.md history sections. Only the `T-`/`D-` register
 *     shapes are internal.
 *   - prediction ids (`P9.3-12-A`) IN PROSE — they are legitimate data in the
 *     documented `prediction` / `tripwire` table columns, where removing them
 *     would break the traceability that makes a prediction checkable. They are
 *     banned from string literals only, where they are noise.
 *
 * Exit 0 = rebrand intact. Exit 1 = violations listed on stderr.
 */
import fs from 'node:fs'
import path from 'node:path'
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

// ---- (d) internal register ids in user-facing surfaces ----------------------
/** Threat / decision register id. NOT bare plan numbering (`9.4-01`), which is public. */
const INTERNAL_ID = /\b[TD]-\d+(?:\.\d+)?-\d+[a-z]?\b/
/**
 * Prediction register id (`P9.3-12-A`). Applied to CODE STRING LITERALS ONLY, not
 * to docs: a prediction id is legitimate DATA in a documented table column (the
 * `prediction` column of the instruments table, the `tripwire` column of
 * docs/VENDOR-LEDGER.md), where deleting it would destroy the traceability that
 * makes the prediction checkable. In printed output it is pure noise, and the
 * count there is currently zero — this rule keeps it zero.
 */
const PREDICTION_ID = /\bP\d+\.\d+-\d+(?:-[A-Za-z0-9]+)?\b/

/** Shipped runtime trees whose STRING LITERALS reach an adopter's terminal. */
const USER_FACING_CODE = ['scripts/sma', 'daemon/src', 'bin', 'tools', 'supervisor']
/** Shipped prose an adopter reads. */
const USER_FACING_DOCS = ['README.md', 'README.ru.md', 'ROADMAP.md', 'ROADMAP.ru.md', 'PASSPORT.md', 'THIRD-PARTY-LICENSES.md', 'docs', 'scripts/sma/README.md', 'scripts/sma/statusline-snippet.md']
/** Sanctioned: synthetic ids belong here. */
const ID_EXCLUDED = /(^|\/)(node_modules|__tests__|fixtures|assets\/demos)(\/|$)/

const inTree = (relPath, roots) => roots.some((r) => relPath === r || relPath.startsWith(r + '/'))

/**
 * Lines of `text` whose id sits inside a quoted literal (not a comment). Keeps
 * check (d) off the comment class, which is out of scope by design.
 */
function idsInStringLiterals(text) {
  const hits = []
  const LITERAL = /(['"`])[^'"`]*(?:[TD]-\d+(?:\.\d+)?-\d+[a-z]?|P\d+\.\d+-\d+(?:-[A-Za-z0-9]+)?)[^'"`]*\1/
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

let idScanned = 0
const idRoots = [...new Set([...USER_FACING_CODE, ...USER_FACING_DOCS])]
for (const root of idRoots) {
  const abs = path.join(ROOT, root)
  if (!fs.existsSync(abs)) continue
  const files = fs.statSync(abs).isDirectory() ? walkAll(abs) : [abs]
  for (const file of files) {
    const r = rel(file)
    if (ID_EXCLUDED.test(r)) continue
    const isDoc = file.endsWith('.md')
    const isCode = /\.(mjs|js|cjs|ts)$/.test(file)
    const isPkg = path.basename(file) === 'package.json'
    if (!isDoc && !isCode && !isPkg) continue
    const buf = fs.readFileSync(file)
    if (buf.includes(0)) continue
    const text = buf.toString('utf8')
    idScanned++
    if (!INTERNAL_ID.test(text)) continue
    if (isDoc) {
      text.split('\n').forEach((line, i) => {
        if (INTERNAL_ID.test(line)) errors.push(`INTERNAL-ID: ${r}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    } else if (isPkg) {
      let pkg
      try { pkg = JSON.parse(text) } catch { continue }
      if (typeof pkg.description === 'string' && INTERNAL_ID.test(pkg.description)) {
        errors.push(`INTERNAL-ID: ${r}: package description carries an internal register id`)
      }
    } else {
      for (const h of idsInStringLiterals(text)) errors.push(`INTERNAL-ID: ${r}:${h.n}: ${h.line}`)
    }
  }
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
console.log(`user-facing files scanned for internal ids: ${idScanned}`)
if (errors.length) {
  console.error(`\nFAIL — ${errors.length} violation(s):`)
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log('OK — rebrand intact (dispatch resolves, zero residue, colors applied, no internal ids in user-facing strings)')
