/**
 * doc-audit.mjs — deterministic honesty audit over the manual and README positioning
 * (9.3-09, D-9.3-01 + D-9.3-15).
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
 * SUBSTRATE LAW: Node built-ins only; every file read flows through an injected `readFile`
 * so tests never touch the real tree. Tolerant of missing files — a missing audited file,
 * or a missing/unpaired region marker, is itself ONE named violation, never a throw.
 *
 * Violation record shape mirrors lint.mjs: {file, rule, detail}.
 */

import { readFileSync } from 'node:fs'
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
  // v3.6 (BL-162/163/165/174) — the region id `sma:v35` is a STABLE anchor, not a
  // version claim; new surfaces grow THIS manifest so a shipped-but-undocumented
  // surface scores a miss (the same grow-the-guard law as the platform's).
  { id: 'npm-install', en: 'npx -y sma-framework@latest', ru: 'npx -y sma-framework@latest' },
  { id: 'deleteme', en: 'sma deleteme', ru: 'sma deleteme' },
  { id: 'memory-preview', en: 'memory-preview', ru: 'memory-preview' },
  { id: 'claude-embed', en: 'rules block', ru: 'блок правил' },
]

/**
 * The world analogs the positioning region must name honestly (brand tokens).
 * 'Outcomes' joins the list in 9.4-05: after Claude Outcomes shipped separate-context
 * grading, the honest comparison row is load-bearing — dropping it from either
 * language's region is now a scored analog-honesty violation (the same grow-the-guard
 * law as the platform's security guard; the guard only ever grows).
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

/**
 * audit({target, readFile, rootDir}) — {violations, count}. target ∈ manual|readme|all
 * (default all). `readFile` defaults to a real UTF-8 reader but is injectable for tests.
 */
export function audit({ target = 'all', readFile = (p) => readFileSync(p, 'utf8'), rootDir }) {
  let violations = []
  if (target === 'manual' || target === 'all') violations = violations.concat(auditManual({ readFile, rootDir }))
  if (target === 'readme' || target === 'all') violations = violations.concat(auditReadme({ readFile, rootDir }))
  return { violations, count: violations.length }
}
