/**
 * doc-audit.mjs — deterministic honesty audit over the manual and README positioning.
 *
 * Every promise the docs plan makes is turned into a number a script prints, not a
 * sentence a reviewer trusts. It verifies, zero-LLM and read-only:
 *   - the manual (EN + RU) covers every SURFACE_MANIFEST entry inside its `sma:v35` region;
 *   - both manual footers carry a Munich last-updated stamp parsing to a date on/after
 *     2026-07-07;
 *   - both README positioning regions (`sma:positioning`) name all five ANALOGS and the
 *     per-language WEDGE clause of the defensible-core thesis;
 *   - the positioning regions contain ZERO multiplier claims (the 10x claim lives with
 *     9.2 only) and the RU manual + RU positioning regions contain ZERO em-dashes.
 *
 * THE NUMBERS TARGET (`--target numbers`) extends the same idea to every NUMBER the docs
 * use to describe the product itself. Nothing else in this repo cross-checks prose against
 * code, so a header that promises fewer doors than the table actually holds stays green
 * forever. (The illustration deliberately names no figure of its own: an example carrying
 * today's count becomes a second, unwatched claim about the product the moment the count
 * moves — which is precisely the flaw this target exists to catch.)
 * Four sources of truth, and only four:
 *   - doors       → the ROUTES literal of the daemon front, PARSED from the text and never
 *                   imported: this audit is synchronous and must not drag in a daemon.
 *   - verbs       → the HANDLERS literal of this CLI, parsed for the same reason plus a
 *                   stronger one — importing the CLI runs it.
 *   - tests/files → the MEASURED receipt. An absent receipt means NOT MEASURED: the
 *                   dependent checks are skipped and said out loud in `notes`. Inventing a
 *                   number instead of reading a measured one is the very lie the badge law
 *                   exists to prevent.
 *   - version     → package.json, the single source; every other place is a projection.
 * A missing anchor is always its OWN violation (parse-failed / pattern-missing /
 * region-missing), so a check can never quietly become an empty check that passes.
 * History is NOT policed: past release figures and the historical growth points of the
 * map are measured facts of their own day, not claims about the product today.
 *
 * SUBSTRATE LAW: Node built-ins only; every file read flows through an injected `readFile`
 * and every write through an injected `writeFile`, so tests never touch the real tree.
 * Tolerant of missing files — a missing audited file, or a missing/unpaired region marker,
 * is itself ONE named violation, never a throw.
 *
 * THE ORDER OF THE MEASUREMENT IS ITSELF A RULE (`receipt-measured-before-head`). Twice in
 * two phases a summary announced a green suite while the tip actually handed over was red,
 * and both times the cause was the same: the suite was measured BEFORE the last commit, so
 * the receipt described a tree nobody was going to receive. The rule «measure after the last
 * commit» stood written in the plans and in every brief handed to whoever did the work, and
 * it held zero times out of two. A rule that can be broken without anyone noticing is a
 * wish, not a rule; its place is in a gate. So the audit takes the commit the receipt names
 * and asks git what changed after it: code or tests among the answer means the numbers
 * describe the past. The remint's own landing places (the receipt, the two READMEs that
 * project it, the map, the version marker) are excluded, because writing the measurement
 * down is what creates the next commit, and counting that as drift would make the rule
 * impossible to satisfy. git is reached through an INJECTED runner and its absence is a
 * note, never a failure: this audit has to work inside an unpacked package, which carries
 * no history at all.
 *
 * Violation record shape mirrors lint.mjs: {file, rule, detail}.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Em-dash (U+2014) — banned inside RU regions this plan owns. */
const EM_DASH_RE = /—/

/**
 * MULTIPLIER_RE — any digit-multiplier form (Latin x or Cyrillic х), word-bounded via
 * lookarounds so "0x1A" (hex) and "x64" (letter-first) never match, but "10x", "2.5x"
 * and "10х" (Cyrillic) do. Applied ONLY inside extracted regions — the audit never
 * polices copy this plan does not own.
 */
export const MULTIPLIER_RE = /(?<![\p{L}\d])\d+(?:[.,]\d+)?\s?[xхXХ](?![\p{L}\d])/u

/**
 * SURFACE_MANIFEST — the V3.5 surfaces the manual must document inside its `sma:v35`
 * region, one required verbatim token per language per surface. The tokens are locked
 * here in the SAME plan that writes the manual copy (Task 3), so there is no
 * chicken-and-egg: a shipped surface that the manual stops naming scores a miss.
 */
export const SURFACE_MANIFEST = [
  { id: 'onboarding', en: '/sma-start', ru: '/sma-start' },
  { id: 'passport', en: 'calibration passport', ru: 'паспорт калибровки' },
  { id: 'excavate', en: 'sma excavate', ru: 'sma excavate' },
  { id: 'emit', en: 'sma emit', ru: 'sma emit' },
  { id: 'context', en: 'sma context', ru: 'sma context' },
  { id: 'ladder', en: 'self-tuning', ru: 'самонастройка' },
  { id: 'statusline', en: 'statusline segment', ru: 'сегмент строки состояния' },
  { id: 'pr-passport', en: 'PR evidence passport', ru: 'паспорт доказательств' },
  { id: 'loop', en: 'accountable loop', ru: 'подотчётный цикл' },
  // v3.6 — the region id `sma:v35` is a STABLE anchor, not a
  // version claim; new surfaces grow THIS manifest so a shipped-but-undocumented
  // surface scores a miss (the same grow-the-guard law as the origin project's).
  { id: 'npm-install', en: 'npx -y sma-framework@latest', ru: 'npx -y sma-framework@latest' },
  { id: 'deleteme', en: 'sma deleteme', ru: 'sma deleteme' },
  { id: 'memory-preview', en: 'memory-preview', ru: 'memory-preview' },
  { id: 'claude-embed', en: 'rules block', ru: 'блок правил' },
]

/**
 * The world analogs the positioning region must name honestly (brand tokens).
 * 'Outcomes' joined the list later: after Claude Outcomes shipped separate-context
 * grading, the honest comparison row is load-bearing — dropping it from either
 * language's region is now a scored analog-honesty violation (the same grow-the-guard
 * law as the origin project's security guard; the guard only ever grows).
 */
export const ANALOGS = ['claude-mem', 'Aider', 'Letta', 'ccusage', 'BMAD', 'Outcomes']

/** One distinctive wedge phrase per language from the defensible-core thesis. */
export const WEDGE = {
  en: 'grade its own agent',
  ru: 'оценивать работу своего же агента',
}

/** The oldest acceptable footer stamp (2026-07-07). */
const STAMP_FLOOR = new Date(2026, 6, 7)

/**
 * extractRegion(text, name) — {found, content} for the content between
 * `<!-- name:start -->` and `<!-- name:end -->` (works for HTML and markdown). Missing
 * or unpaired markers return {found:false, content:''} — the caller counts that as one
 * violation, never a throw.
 */
export function extractRegion(text, name) {
  const src = String(text ?? '')
  const start = `<!-- ${name}:start -->`
  const end = `<!-- ${name}:end -->`
  const si = src.indexOf(start)
  const ei = src.indexOf(end)
  if (si === -1 || ei === -1 || ei < si) return { found: false, content: '' }
  return { found: true, content: src.slice(si + start.length, ei) }
}

/** Read a file through the injected reader, returning null on any failure (tolerant). */
function safeRead(readFile, path) {
  try {
    const v = readFile(path)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** Footer stamp check: a DD.MM.YYYY parsing to >= 2026-07-07, else a stale-stamp violation. */
function checkStamp(html, file, violations) {
  const fm = String(html).match(/<footer[\s\S]*?<\/footer>/i)
  const footer = fm ? fm[0] : ''
  const dm = footer.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  if (!dm) {
    violations.push({ file, rule: 'stale-stamp', detail: 'no parseable footer date stamp' })
    return
  }
  const [, dd, mm, yyyy] = dm
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd))
  if (isNaN(d.getTime()) || d < STAMP_FLOOR) {
    violations.push({ file, rule: 'stale-stamp', detail: `${dm[0]} is older than 07.07.2026` })
  }
}

/** Audit one manual file (lang ∈ en|ru) against the SURFACE_MANIFEST + stamp + RU em-dash. */
function auditOneManual(html, file, lang, violations) {
  if (html == null) {
    violations.push({ file, rule: 'file-missing', detail: file })
    return
  }
  const region = extractRegion(html, 'sma:v35')
  if (!region.found) {
    violations.push({ file, rule: 'region-missing', detail: 'sma:v35' })
  } else {
    for (const entry of SURFACE_MANIFEST) {
      const token = entry[lang]
      if (!region.content.includes(token)) {
        violations.push({ file, rule: 'surface-missing', detail: entry.id })
      }
    }
    if (lang === 'ru' && EM_DASH_RE.test(region.content)) {
      violations.push({ file, rule: 'ru-em-dash', detail: 'em-dash (U+2014) in the RU sma:v35 region' })
    }
  }
  checkStamp(html, file, violations)
}

/** Audit one README (lang ∈ en|ru) against ANALOGS + WEDGE + multiplier ban + RU em-dash. */
function auditOneReadme(md, file, lang, violations) {
  if (md == null) {
    violations.push({ file, rule: 'file-missing', detail: file })
    return
  }
  const region = extractRegion(md, 'sma:positioning')
  if (!region.found) {
    violations.push({ file, rule: 'region-missing', detail: 'sma:positioning' })
    return
  }
  for (const analog of ANALOGS) {
    if (!region.content.includes(analog)) {
      violations.push({ file, rule: 'analog-missing', detail: analog })
    }
  }
  const wedge = WEDGE[lang]
  if (!region.content.includes(wedge)) {
    violations.push({ file, rule: 'wedge-missing', detail: wedge })
  }
  if (MULTIPLIER_RE.test(region.content)) {
    violations.push({ file, rule: 'multiplier-claim', detail: 'a digit-multiplier claim appears in the positioning region' })
  }
  if (lang === 'ru' && EM_DASH_RE.test(region.content)) {
    violations.push({ file, rule: 'ru-em-dash', detail: 'em-dash (U+2014) in the RU positioning region' })
  }
}

/** auditManual({readFile, rootDir}) — violations over docs/manual.en.html + manual.ru.html. */
export function auditManual({ readFile, rootDir }) {
  const violations = []
  const enHtml = safeRead(readFile, join(rootDir, 'docs', 'manual.en.html'))
  const ruHtml = safeRead(readFile, join(rootDir, 'docs', 'manual.ru.html'))
  auditOneManual(enHtml, 'docs/manual.en.html', 'en', violations)
  auditOneManual(ruHtml, 'docs/manual.ru.html', 'ru', violations)
  return violations
}

/** auditReadme({readFile, rootDir}) — violations over README.md + README.ru.md positioning. */
export function auditReadme({ readFile, rootDir }) {
  const violations = []
  const enMd = safeRead(readFile, join(rootDir, 'README.md'))
  const ruMd = safeRead(readFile, join(rootDir, 'README.ru.md'))
  auditOneReadme(enMd, 'README.md', 'en', violations)
  auditOneReadme(ruMd, 'README.ru.md', 'ru', violations)
  return violations
}

// ══════════════════════════ the numbers target ══════════════════════════════
//
// Everything below serves ONE rule: a number a doc uses to describe the product is
// derived from the code, or it is a named violation. Nothing below ever invents a
// number, and nothing below polices history.

/** The audited paths, written once so a rule and its writer cannot drift apart. */
const SERVER_FILE = 'daemon/src/front/server.mjs'
const CLI_FILE = 'scripts/sma/cli.mjs'
// The documents that name the verb total live in VERB_COUNT_PLACES below, one entry per
// place: the list is the rule, so a new place is added in exactly one spot.
const GRAPH_FILE = 'docs/master-graph.html'
const PKG_FILE = 'package.json'
const RECEIPT = 'test-receipt.json'
/**
 * DERIVED_PATHS — the places whose whole content IS the remint: the receipt itself, the two
 * READMEs that carry its badge, the map that repeats its numbers, and the version marker.
 * A commit touching only these is the measurement landing, not code moving underneath it,
 * so the freshness rule looks past them. Without the exclusion the rule could never be
 * satisfied: recording a measurement always makes one more commit.
 */
export const DERIVED_PATHS = Object.freeze([
  'test-receipt.json',
  'README.md',
  'README.ru.md',
  'docs/master-graph.html',
  'sma-core/VERSION',
])

/**
 * What counts as code or tests for the freshness rule — the file kinds a change to which can
 * move the number of tests or what they assert. Prose (.md), pictures and templates are not
 * on the list: a paragraph rewritten after the run does not make the run describe something
 * else. .json is on it because configuration and fixtures decide what the suite collects.
 */
const CODE_FILE_RE = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts|vue|svelte|json)$/i

/**
 * receiptDriftFiles(changed) -> the paths among `changed` that are code or tests, with the
 * derived places removed. Pure and exported, so the rule can be proved on a list of names
 * without a repository anywhere near the test.
 *
 * @param {string[]} changed paths as git prints them, repo-relative
 * @returns {string[]}
 */
export function receiptDriftFiles(changed = []) {
  const seen = new Set()
  const out = []
  for (const raw of changed) {
    const rel = String(raw ?? '').trim().replace(/\\/g, '/')
    if (!rel || DERIVED_PATHS.includes(rel) || !CODE_FILE_RE.test(rel)) continue
    if (seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return out
}

/**
 * defaultRunGit(rootDir) — an execFileSync-shaped runner over `git` pinned to one tree, the
 * same shape the snapshot module injects. Every call site passes a FIXED argv array, so
 * nothing read from a file ever becomes a shell word.
 *
 * @param {string} rootDir
 */
export function defaultRunGit(rootDir) {
  return (argv) => execFileSync('git', ['-C', rootDir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * checkReceiptFreshness — the measured numbers must describe the tip they are delivered on.
 * A missing commit, a missing git, or a commit git does not know are NOTES: «not checkable»
 * and «wrong» are different words, and the audit must survive a tree with no history.
 */
function checkReceiptFreshness({ receipt, runGit, violations, notes }) {
  if (!receipt) return // an absent receipt already spoke for itself above
  const commit = typeof receipt.commit === 'string' ? receipt.commit.trim() : ''
  if (!commit) {
    notes.push('the receipt names no commit — there is nothing to ask git about, so the order of the measurement is unchecked')
    return
  }
  const short = commit.slice(0, 7)
  let head = ''
  try {
    head = String(runGit(['rev-parse', 'HEAD']) ?? '').trim()
  } catch {
    head = ''
  }
  if (!head) {
    notes.push(`no readable git history here — whether the receipt (${short}) was measured before the delivered tip is unchecked`)
    return
  }
  if (head === commit || head.startsWith(commit) || commit.startsWith(head)) return // measured on the tip itself
  let changed = null
  try {
    changed = String(runGit(['diff', '--name-only', commit, head]) ?? '')
  } catch {
    changed = null
  }
  if (changed == null) {
    notes.push(`git does not know the commit the receipt names (${short}) — the order of the measurement is unchecked`)
    return
  }
  const drift = receiptDriftFiles(changed.split('\n'))
  if (drift.length === 0) return
  const rest = drift.length > 1 ? ` and ${drift.length - 1} more` : ''
  violations.push({
    file: RECEIPT,
    rule: 'receipt-measured-before-head',
    detail:
      `measured at ${short}, before ${drift.length} code/test change(s) landed on ${head.slice(0, 7)} ` +
      `(${drift[0]}${rest}) — the numbers describe a tree that is not the one being handed over; re-measure on the tip`,
  })
}
const CAPABILITY_FILE = 'sma-core/capabilities/sma/capability.json'
const VERSION_MARKER = 'sma-core/VERSION'
const INSTALLER_FILE = 'bin/init.mjs'

/** The three marked spans of the map that carry TODAY's numbers (the graph is not one). */
export const NUMBER_REGIONS = ['sma:num-meta', 'sma:num-hero', 'sma:num-footer']

/** The four source roots a template's promised writer must actually exist in. */
const SOURCE_ROOTS = ['scripts/sma', 'sma-core/bin', 'daemon/src', 'bin']

const NUMBER_UNITS = {
  ZERO: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9,
  TEN: 10, ELEVEN: 11, TWELVE: 12, THIRTEEN: 13, FOURTEEN: 14, FIFTEEN: 15, SIXTEEN: 16,
  SEVENTEEN: 17, EIGHTEEN: 18, NINETEEN: 19,
}
const NUMBER_TENS = {
  TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50, SIXTY: 60, SEVENTY: 70, EIGHTY: 80, NINETY: 90,
}

/**
 * wordToNumber(word) — 0..99 spelled out, hyphenated compounds included ('SIXTY-ONE' → 61).
 * Case-insensitive. Returns null for anything it does not KNOW: a guessed number would be
 * worse than a refusal, so an unknown word in a guarded sentence scores its own violation
 * instead of silently passing.
 */
export function wordToNumber(word) {
  if (typeof word !== 'string') return null
  const w = word.trim().toUpperCase()
  if (!w) return null
  if (Object.prototype.hasOwnProperty.call(NUMBER_UNITS, w)) return NUMBER_UNITS[w]
  if (Object.prototype.hasOwnProperty.call(NUMBER_TENS, w)) return NUMBER_TENS[w]
  const parts = w.split('-')
  if (parts.length === 2) {
    const tens = NUMBER_TENS[parts[0]]
    const unit = NUMBER_UNITS[parts[1]]
    if (tens !== undefined && unit !== undefined && unit > 0 && unit < 10) return tens + unit
  }
  return null
}

/**
 * sliceBalancedBraces(text, openIndex) — the body between `{` at openIndex and its match,
 * skipping string literals and comments so a brace inside a comment cannot end an object.
 * null when the text is unbalanced (the caller turns that into parse-failed).
 */
function sliceBalancedBraces(text, openIndex) {
  const src = String(text)
  if (src[openIndex] !== '{') return null
  let depth = 0
  let i = openIndex
  let quote = null
  while (i < src.length) {
    const ch = src[i]
    if (quote) {
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      if (nl === -1) return null
      i = nl
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      if (close === -1) return null
      i = close + 2
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(openIndex + 1, i)
    }
    i++
  }
  return null
}

/** The body of the object literal an anchor regex ENDING IN `{` points at, or null. */
function literalBody(text, anchorRe) {
  const src = String(text ?? '')
  const m = anchorRe.exec(src)
  if (!m) return null
  return sliceBalancedBraces(src, m.index + m[0].length - 1)
}

const ROUTES_ANCHOR = /export const ROUTES\s*=\s*Object\.freeze\(\s*\{/
const HANDLERS_ANCHOR = /const HANDLERS\s*=\s*\{/
/** One route entry: 'METHOD /path': 'handlerName' — the shape the table is written in. */
const ROUTE_ENTRY_RE = /^[ \t]*'([A-Z]+) ([^']*)'[ \t]*:[ \t]*'([A-Za-z_$][\w$]*)'[ \t]*,?[ \t]*$/gm
/** One HANDLERS key: quoted or bare, always first on its line. */
const HANDLER_KEY_RE = /^[ \t]*(?:'([^']+)'|([A-Za-z_$][\w$-]*))[ \t]*:/gm

/** parseRouteCount(text) — how many doors the frozen table actually declares; null if unparsable. */
export function parseRouteCount(text) {
  const body = literalBody(text, ROUTES_ANCHOR)
  if (body == null) return null
  const n = [...body.matchAll(ROUTE_ENTRY_RE)].length
  return n > 0 ? n : null
}

/** parseHandlerKeys(text) — the verb names the CLI dispatch table declares; null if unparsable. */
export function parseHandlerKeys(text) {
  const body = literalBody(text, HANDLERS_ANCHOR)
  if (body == null) return null
  const keys = [...body.matchAll(HANDLER_KEY_RE)].map((m) => m[1] ?? m[2])
  return keys.length > 0 ? keys : null
}

/** The verb list the CLI PRINTS: everything between the angle brackets of its usage line. */
const VERB_LIST_RE = /cli\.mjs\s+<([^>]+)>/
/** The allow-list of verbs that print their own help, as a literal. */
const OWN_HELP_RE = /const OWN_HELP\s*=\s*new Set\(\s*\[([^\]]*)\]/
/** The count the comment above that allow-list claims. */
const OTHER_VERBS_RE = /(\d+)\s+other verbs/
/**
 * VERB_COUNT_PLACES — EVERY shipped document that names the total number of verbs, with
 * the phrase that names it there.
 *
 * This table repairs a design error that only showed itself the first time the count
 * actually moved. The rule used to watch exactly ONE file — the CLI's own README, which
 * happened to be the file that was wrong on the day the rule was written. Every other
 * place naming the number was recorded as «already correct, leave it alone» and got no
 * lock at all. The next release added a verb, that one file was brought to the truth, and
 * three shipped documents went on saying the old number while this audit printed zero.
 *
 * A check that merely agrees with today, with no lock on the place it agreed with, is not
 * a gate — it is a snapshot: the place is right when the check is written and stops being
 * right at the first change, and nobody finds out. So every place is watched; every
 * violation carries the name of ITS OWN file, so the report says WHERE the divergence is
 * rather than only that there is one; and a place that stops naming the number at all is
 * its own named violation instead of a silent pass, because a rule left with nothing to
 * match is an empty rule that passes forever.
 *
 * Each pattern is anchored to the surrounding sentence rather than to a bare «N verbs»:
 * the RU README also says «14 команд /sma-…» about the skills, which is a different count
 * with a different owner, and a loose pattern would drag it in here.
 */
const VERB_COUNT_PLACES = [
  { file: 'scripts/sma/README.md', re: /All (\d+), grouped by what they are for/g, what: 'the heading over the verb table' },
  { file: 'README.md', re: /accountability CLI — (\d+) verbs/g, what: 'the CLI section' },
  { file: 'README.ru.md', re: /подотчётный CLI — (\d+) команд/g, what: 'раздел о CLI' },
  { file: 'docs/DETAILS.md', re: /CLI runs underneath — (\d+) verbs/g, what: 'the CLI reference' },
  { file: 'docs/DETAILS.ru.md', re: /подотчётный CLI: (\d+) команд/g, what: 'справочник CLI' },
  { file: 'docs/INSTALL.md', re: /any of the (\d+) verbs/g, what: 'the explain line' },
]
/** «N tests · M files» — the measured pair, wherever the map shows it. */
const STAT_RE = /(\d+) tests · (\d+) files/g
/** A version token of the map: v-major-minor-patch. */
const VERSION_TOKEN_RE = /v\d+\.\d+\.\d+/g
/** The shields.io version badge and its per-language alt text. */
const VERSION_BADGE_RE = /badge\/version-(\d+\.\d+\.\d+)-/g
const VERSION_ALT_RE = /alt="(?:version|версия)\s+(\d+\.\d+\.\d+)"/g
/** A writer name a template promises: a writing verb glued to a CamelCase tail. */
const WRITER_TOKEN_RE = /\b(?:sync|write|update|save|persist|overwrite)[A-Z][A-Za-z0-9_]*/g
/** The two guarded door sentences. The WORD itself must be upper-case to be guarded. */
const EXACT_COUNT_RE = /\bexactly\s+([A-Za-z][A-Za-z-]*)\s+(?:routes|entries)\b/gi
const ALL_LIVE_RE = /\bALL\s+([A-Z][A-Z-]*)\s+ARE LIVE\b/g
/** The assertion the suite itself makes about the size of the table. */
const ROUTE_ASSERT_RE = /Object\.keys\(ROUTES\)\.length\s*===\s*(\d+)/g
/** The installer's version wiring: read once from the package, handed to the block writer. */
const PKG_VERSION_CALL_RE = /const\s+([A-Za-z_$][\w$]*)\s*=\s*pkgVersion\(\)/
const EMBED_RULES_RE = /embedRules\(\s*\{([^}]*)\}/
/** A version literal anywhere in the installer — that copy IS a second source of truth. */
const VERSION_LITERAL_RE = /(?<![\w.])v?\d+\.\d+\.\d+(?![\w.])/

/**
 * Path of `p` relative to `rootDir`, forward-slashed, for the `file` field of a violation.
 * Both sides are normalised before the comparison — on Windows a joined path comes back
 * back-slashed while the root it was joined from may not be, and an unstripped root would
 * leak an absolute machine path into a violation record.
 */
function relPath(rootDir, p) {
  const norm = (s) => String(s ?? '').replace(/\\/g, '/')
  const s = norm(p)
  const r = norm(rootDir).replace(/\/+$/, '')
  const cut = r && s.startsWith(r) ? s.slice(r.length) : s
  return cut.replace(/^\/+/, '')
}

/** Read + JSON.parse through the injected reader; null on a missing or unparsable file. */
function safeReadJson(readFile, path) {
  const raw = safeRead(readFile, path)
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * defaultListSourceFiles(rootDir) — every source file a template's promised writer could
 * live in. Skips node_modules and test folders: a function that exists only in a test is
 * not a function the product ships.
 */
export function defaultListSourceFiles(rootDir) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(mjs|cjs|js|ts)$/.test(e.name)) out.push(full)
    }
  }
  for (const r of SOURCE_ROOTS) walk(join(rootDir, ...r.split('/')))
  return out
}

/** defaultListTemplates(rootDir) — the markdown templates the installer ships. */
export function defaultListTemplates(rootDir) {
  const dir = join(rootDir, 'sma-core', 'templates')
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => join(dir, n))
  } catch {
    return []
  }
}

/**
 * auditNumbers({readFile, listSourceFiles, listTemplates, rootDir, notes}) — the violations
 * of the numbers target. `notes` is an OUT parameter for the things that were not measured
 * rather than found wrong; it is also attached to the returned array for convenience, and
 * it is never counted as a violation — «not measured» and «wrong» are different words.
 */
export function auditNumbers({
  readFile,
  listSourceFiles = defaultListSourceFiles,
  listTemplates = defaultListTemplates,
  rootDir,
  runGit,
  notes = [],
} = {}) {
  const violations = []
  const p = (...parts) => join(rootDir, ...parts)

  // ── the four sources of truth ────────────────────────────────────────────
  const pkg = safeReadJson(readFile, p(PKG_FILE))
  const version = pkg && typeof pkg.version === 'string' ? pkg.version : null
  if (version == null) {
    violations.push({ file: PKG_FILE, rule: 'parse-failed', detail: 'no version string in the package manifest' })
  }

  const serverText = safeRead(readFile, p(...SERVER_FILE.split('/')))
  const doorCount = serverText == null ? null : parseRouteCount(serverText)
  if (serverText == null) {
    violations.push({ file: SERVER_FILE, rule: 'file-missing', detail: SERVER_FILE })
  } else if (doorCount == null) {
    violations.push({ file: SERVER_FILE, rule: 'parse-failed', detail: 'the frozen route table could not be read from the text' })
  }

  const cliText = safeRead(readFile, p(...CLI_FILE.split('/')))
  const handlerKeys = cliText == null ? null : parseHandlerKeys(cliText)
  if (cliText == null) {
    violations.push({ file: CLI_FILE, rule: 'file-missing', detail: CLI_FILE })
  } else if (handlerKeys == null) {
    violations.push({ file: CLI_FILE, rule: 'parse-failed', detail: 'the verb dispatch table could not be read from the text' })
  }

  const receipt = safeReadJson(readFile, p(RECEIPT))
  const haveReceipt = receipt != null && Number.isFinite(Number(receipt.tests)) && Number.isFinite(Number(receipt.files))
  if (!haveReceipt) {
    notes.push('tests/files not measured — receipt absent, the checks that depend on it are skipped')
  } else if (receipt.dirty === true) {
    notes.push(`the receipt was measured on a dirty tree at commit ${String(receipt.commit ?? 'unknown').slice(0, 7)} — the numbers are as measured, freshness is the release gate's job`)
  }

  // ── rule: the receipt describes the tip it is delivered on, not an earlier one ──
  checkReceiptFreshness({
    receipt: haveReceipt ? receipt : null,
    runGit: typeof runGit === 'function' ? runGit : defaultRunGit(rootDir),
    violations,
    notes,
  })

  // ── rule: every assertion about the size of the table names the real size ──
  if (serverText != null && doorCount != null) {
    const asserts = [...serverText.matchAll(ROUTE_ASSERT_RE)]
    if (asserts.length === 0) {
      violations.push({ file: SERVER_FILE, rule: 'pattern-missing', detail: 'no assertion of the route table size to check' })
    }
    for (const m of asserts) {
      if (Number(m[1]) !== doorCount) {
        violations.push({ file: SERVER_FILE, rule: 'route-count-assertion', detail: `asserts ${m[1]} routes, the table declares ${doorCount}` })
      }
    }

    // ── rule: the prose over the table counts the same doors, spelled out ──
    const prose = []
    for (const m of serverText.matchAll(EXACT_COUNT_RE)) {
      if (/^[A-Z][A-Z-]*$/.test(m[1])) prose.push({ word: m[1], phrase: m[0] })
    }
    for (const m of serverText.matchAll(ALL_LIVE_RE)) prose.push({ word: m[1], phrase: m[0] })
    if (prose.length === 0) {
      violations.push({ file: SERVER_FILE, rule: 'pattern-missing', detail: 'no spelled-out door count in the header to check' })
    }
    for (const item of prose) {
      const n = wordToNumber(item.word)
      if (n == null) {
        violations.push({ file: SERVER_FILE, rule: 'unknown-number-word', detail: `«${item.word}» in «${item.phrase}» is not a number this audit knows` })
      } else if (n !== doorCount) {
        violations.push({ file: SERVER_FILE, rule: 'route-count-prose', detail: `«${item.phrase}» says ${n}, the table declares ${doorCount}` })
      }
    }
  }

  // ── rules over the CLI: the printed list, the allow-list comment ──
  let ownHelpSize = null
  if (cliText != null && handlerKeys != null) {
    const listMatch = cliText.match(VERB_LIST_RE)
    if (!listMatch) {
      violations.push({ file: CLI_FILE, rule: 'pattern-missing', detail: 'the printed verb list could not be found' })
    } else {
      const printed = listMatch[1].split('|').map((s) => s.trim()).filter(Boolean)
      const printedSet = new Set(printed)
      const declared = new Set(handlerKeys)
      for (const verb of declared) {
        if (!printedSet.has(verb)) {
          violations.push({ file: CLI_FILE, rule: 'verb-list-parity', detail: `«${verb}» is dispatched but the printed list omits it` })
        }
      }
      for (const verb of printedSet) {
        if (!declared.has(verb)) {
          violations.push({ file: CLI_FILE, rule: 'verb-list-parity', detail: `«${verb}» is printed but no handler answers it` })
        }
      }
    }

    const ownHelpMatch = cliText.match(OWN_HELP_RE)
    if (!ownHelpMatch) {
      violations.push({ file: CLI_FILE, rule: 'pattern-missing', detail: 'the own-help allow-list could not be read' })
    } else {
      ownHelpSize = [...ownHelpMatch[1].matchAll(/'[^']*'|"[^"]*"/g)].length
    }

    const otherMatch = cliText.match(OTHER_VERBS_RE)
    if (!otherMatch) {
      violations.push({ file: CLI_FILE, rule: 'pattern-missing', detail: 'the comment over the own-help allow-list names no count' })
    } else if (ownHelpSize != null) {
      const expected = handlerKeys.length - ownHelpSize
      if (Number(otherMatch[1]) !== expected) {
        violations.push({ file: CLI_FILE, rule: 'own-help-count', detail: `claims ${otherMatch[1]} other verbs, the tables give ${expected}` })
      }
    }
  }

  // ── rule: EVERY document that names the verb total names the dispatched one ──
  if (handlerKeys != null) {
    for (const place of VERB_COUNT_PLACES) {
      const text = safeRead(readFile, p(...place.file.split('/')))
      if (text == null) {
        violations.push({ file: place.file, rule: 'file-missing', detail: place.file })
        continue
      }
      const found = [...text.matchAll(place.re)]
      if (found.length === 0) {
        violations.push({
          file: place.file,
          rule: 'verb-count-missing',
          detail: `${place.what} of ${place.file} names no verb total any more — the sentence this rule watches is gone`,
        })
        continue
      }
      for (const m of found) {
        if (Number(m[1]) !== handlerKeys.length) {
          violations.push({
            file: place.file,
            rule: 'verb-count',
            detail: `«${m[0]}» in ${place.file} says ${m[1]}, the dispatch table holds ${handlerKeys.length}`,
          })
        }
      }
    }
  }

  // ── rules over the map: only the marked spans, never the growth history ──
  const graph = safeRead(readFile, p(...GRAPH_FILE.split('/')))
  if (graph == null) {
    violations.push({ file: GRAPH_FILE, rule: 'file-missing', detail: GRAPH_FILE })
  } else {
    for (const name of NUMBER_REGIONS) {
      const region = extractRegion(graph, name)
      if (!region.found) {
        violations.push({ file: GRAPH_FILE, rule: 'region-missing', detail: name })
        continue
      }
      if (version != null) {
        for (const m of region.content.matchAll(VERSION_TOKEN_RE)) {
          if (m[0] !== `v${version}`) {
            violations.push({ file: GRAPH_FILE, rule: 'graph-region-version', detail: `${name}: ${m[0]} is not v${version}` })
          }
        }
      }
      if (haveReceipt) {
        for (const m of region.content.matchAll(STAT_RE)) {
          if (Number(m[1]) !== Number(receipt.tests) || Number(m[2]) !== Number(receipt.files)) {
            violations.push({ file: GRAPH_FILE, rule: 'graph-region-stats', detail: `${name}: «${m[0]}» is not the measured ${receipt.tests} tests · ${receipt.files} files` })
          }
        }
      }
    }
  }

  // ── rule: the version badge of both READMEs. The TEST badge is not audited here:
  //    it already has an owner (the badge module's own check), and a second checker of
  //    the same number is a second thing to keep in step.
  if (version != null) {
    for (const file of ['README.md', 'README.ru.md']) {
      const md = safeRead(readFile, p(file))
      if (md == null) {
        violations.push({ file, rule: 'file-missing', detail: file })
        continue
      }
      const badges = [...md.matchAll(VERSION_BADGE_RE)]
      const alts = [...md.matchAll(VERSION_ALT_RE)]
      if (badges.length === 0) {
        violations.push({ file, rule: 'pattern-missing', detail: 'no version badge to check' })
      }
      for (const m of [...badges, ...alts]) {
        if (m[1] !== version) {
          violations.push({ file, rule: 'readme-version-badge', detail: `shows ${m[1]}, the package says ${version}` })
        }
      }
    }

    // ── rule: the capability record carries the package version ──
    const cap = safeReadJson(readFile, p(...CAPABILITY_FILE.split('/')))
    if (cap == null) {
      violations.push({ file: CAPABILITY_FILE, rule: 'file-missing', detail: CAPABILITY_FILE })
    } else if (cap.version !== version) {
      violations.push({ file: CAPABILITY_FILE, rule: 'capability-version', detail: `says ${String(cap.version)}, the package says ${version}` })
    }

    // ── rule: the install marker exists AND equals the package version. It must exist:
    //    the updater tells an installed tree from a bare one by this very file and reads
    //    its contents as the installed version. So it is not deleted — it is DERIVED.
    const marker = safeRead(readFile, p(...VERSION_MARKER.split('/')))
    if (marker == null) {
      violations.push({ file: VERSION_MARKER, rule: 'version-marker', detail: 'the install marker is missing — the updater reads it to tell an installed tree from a bare one' })
    } else if (marker.trim() !== version) {
      violations.push({ file: VERSION_MARKER, rule: 'version-marker', detail: `holds ${marker.trim()}, the package says ${version}` })
    }
  }

  // ── rule: the badge check is wired into the ordinary test run ──
  if (pkg != null) {
    const testScript = pkg.scripts && typeof pkg.scripts.test === 'string' ? pkg.scripts.test : ''
    if (!/badge\.mjs\s+--check/.test(testScript)) {
      violations.push({ file: PKG_FILE, rule: 'badge-gate-wired', detail: 'the ordinary test run does not call the badge check — computed is not connected' })
    }
  }

  // ── rule: a template never promises a writer the product does not have ──
  const templates = listTemplates(rootDir) || []
  const wanted = new Map()
  for (const tpl of templates) {
    const text = safeRead(readFile, tpl)
    if (text == null) continue
    for (const m of text.matchAll(WRITER_TOKEN_RE)) {
      if (!wanted.has(m[0])) wanted.set(m[0], relPath(rootDir, tpl))
    }
  }
  if (wanted.size > 0) {
    const pending = new Set(wanted.keys())
    for (const src of listSourceFiles(rootDir) || []) {
      if (pending.size === 0) break
      const text = safeRead(readFile, src)
      if (text == null) continue
      for (const token of [...pending]) {
        if (text.includes(token)) pending.delete(token)
      }
    }
    for (const token of pending) {
      violations.push({ file: wanted.get(token), rule: 'phantom-writer', detail: `promises «${token}», which no shipped source defines` })
    }
  }

  // ── rule: the installer takes the block version from the package and keeps no copy.
  //    This check only READS the installer. Today its wiring is right — which is exactly
  //    why it is pinned: a truth with no guard is only true until the next edit.
  const installer = safeRead(readFile, p(...INSTALLER_FILE.split('/')))
  if (installer == null) {
    violations.push({ file: INSTALLER_FILE, rule: 'file-missing', detail: INSTALLER_FILE })
  } else {
    const call = installer.match(PKG_VERSION_CALL_RE)
    const embed = installer.match(EMBED_RULES_RE)
    if (!call || !embed) {
      violations.push({ file: INSTALLER_FILE, rule: 'version-source-unwired', detail: 'the block version is not visibly read from the package manifest and handed to the block writer' })
    } else {
      const name = call[1]
      if (!new RegExp(`\\b${name}\\b`).test(embed[1])) {
        violations.push({ file: INSTALLER_FILE, rule: 'version-source-unwired', detail: `the block writer is not given «${name}», the value read from the package manifest` })
      }
    }
    const literal = installer.match(VERSION_LITERAL_RE)
    if (literal) {
      violations.push({ file: INSTALLER_FILE, rule: 'version-literal-in-installer', detail: `«${literal[0]}» is a second copy of the version` })
    }
  }

  violations.notes = notes
  return violations
}

/**
 * writeNumbers({readFile, writeFile, rootDir}) — {written, notes}. Rewrites EXACTLY the
 * marked spans of the map and the install marker, from the same sources the audit reads.
 * Nothing outside a marked span is touched, the growth history is never touched, and a
 * second run writes the same bytes. Without a measured receipt the statistics span is
 * left alone and said out loud — a hand-typed count is the failure this whole file exists
 * to prevent.
 */
export function writeNumbers({
  readFile = (p) => readFileSync(p, 'utf8'),
  writeFile = (p, data) => writeFileSync(p, data, 'utf8'),
  rootDir,
} = {}) {
  const written = []
  const notes = []
  const p = (...parts) => join(rootDir, ...parts)

  const pkg = safeReadJson(readFile, p(PKG_FILE))
  const version = pkg && typeof pkg.version === 'string' ? pkg.version : null
  if (version == null) {
    notes.push('nothing written — the package manifest carries no version to write from')
    return { written, notes }
  }

  const receipt = safeReadJson(readFile, p(RECEIPT))
  const haveReceipt = receipt != null && Number.isFinite(Number(receipt.tests)) && Number.isFinite(Number(receipt.files))
  if (!haveReceipt) notes.push('the statistics spans were left as they are — no measured receipt to write from')

  const graphPath = p(...GRAPH_FILE.split('/'))
  const graph = safeRead(readFile, graphPath)
  if (graph == null) {
    notes.push(`${GRAPH_FILE} is missing — no span rewritten`)
  } else {
    let next = graph
    let touched = false
    for (const name of NUMBER_REGIONS) {
      const start = `<!-- ${name}:start -->`
      const end = `<!-- ${name}:end -->`
      const si = next.indexOf(start)
      const ei = next.indexOf(end)
      if (si === -1 || ei === -1 || ei < si) {
        notes.push(`${name} is not marked in the map — nothing written there`)
        continue
      }
      const from = si + start.length
      const inner = next.slice(from, ei)
      let rewritten = inner.replace(VERSION_TOKEN_RE, `v${version}`)
      if (haveReceipt) {
        rewritten = rewritten.replace(STAT_RE, `${receipt.tests} tests · ${receipt.files} files`)
      }
      if (rewritten !== inner) {
        next = next.slice(0, from) + rewritten + next.slice(ei)
        touched = true
      }
    }
    if (touched) {
      writeFile(graphPath, next)
      written.push(GRAPH_FILE)
    }
  }

  const markerPath = p(...VERSION_MARKER.split('/'))
  const marker = safeRead(readFile, markerPath)
  const wantMarker = `${version}\n`
  if (marker !== wantMarker) {
    writeFile(markerPath, wantMarker)
    written.push(VERSION_MARKER)
  }

  return { written, notes }
}

/** The targets audit() answers to. An unknown one is an error, never a quiet zero. */
const TARGETS = new Set(['manual', 'readme', 'numbers', 'all'])

/**
 * audit({target, readFile, listSourceFiles, listTemplates, rootDir}) —
 * {violations, count, notes}. target ∈ manual|readme|numbers|all (default all). An
 * unknown target scores `unknown-target` rather than passing: a typo that always
 * «passes» is worse than no check at all. `notes` carries what was NOT measured; it is
 * deliberately outside the count.
 */
export function audit({
  target = 'all',
  readFile = (p) => readFileSync(p, 'utf8'),
  listSourceFiles,
  listTemplates,
  rootDir,
  runGit,
}) {
  let violations = []
  const notes = []
  if (!TARGETS.has(target)) {
    violations.push({ file: PKG_FILE, rule: 'unknown-target', detail: `«${String(target)}» is not one of ${[...TARGETS].join(', ')}` })
    return { violations, count: violations.length, notes }
  }
  if (target === 'manual' || target === 'all') violations = violations.concat(auditManual({ readFile, rootDir }))
  if (target === 'readme' || target === 'all') violations = violations.concat(auditReadme({ readFile, rootDir }))
  if (target === 'numbers' || target === 'all') {
    violations = violations.concat(auditNumbers({ readFile, listSourceFiles, listTemplates, rootDir, runGit, notes }))
  }
  return { violations, count: violations.length, notes }
}
