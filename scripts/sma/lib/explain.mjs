/**
 * explain.mjs — in-product explainers with a command-coverage tripwire (49.3-09).
 *
 * `pnpm sma explain <topic>` prints a plain-language explainer for every core SMA
 * concept AND, via the COMMAND_TOPICS alias map, for every CLI subcommand registered
 * in cli.mjs's HANDLERS block. An unknown topic lists the catalog and exits 0 — the
 * teaching surface never punishes curiosity (D-49.3-15).
 *
 * THE DRIFT TRIPWIRE (P49.3-09-A): `coverage()` reads cli.mjs as TEXT (anchored regex
 * over the `const HANDLERS = {` block) and reports every HANDLERS key with no resolvable
 * explainer topic. A sibling plan that lands a new command WITHOUT extending COMMAND_TOPICS
 * flips the uncovered count above 0 and scores a miss. That is by design — docs cannot
 * silently lag the product.
 *
 * SUBSTRATE LAW: Node built-ins only (fs, path). Zero LLM, zero network, zero
 * child_process. All paths are dependency-injected. This module NEVER imports cli.mjs
 * (its top-level main() executes on import) — it parses cli.mjs as text.
 *
 * Topic file format (scripts/sma/explainers/<id>.md):
 *   line 1:  `# <title>`
 *   line 2:  (blank)
 *   line 3:  one-line summary
 *   then:    `## en` section (8-25 lines) and `## ru` section (8-25 lines).
 * RU sections carry NO em-dash (U+2014) and use formal Вы (enforced by lintTopics).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Em-dash detector (U+2014) — RU explainer sections must be free of it. */
const EM_DASH_RE = /—/

/**
 * COMMAND_TOPICS — the exhaustive alias map from every LIVE cli.mjs HANDLERS key to an
 * explainer topic id. This is the join between the command surface and the topic corpus.
 * A later sibling adding a HANDLERS key without extending this map flips P49.3-09-A — the
 * designed drift tripwire. Keep this map exhaustive against the live HANDLERS block.
 */
export const COMMAND_TOPICS = {
  // coordination — sessions, claims, slots, journal
  status: 'coordination',
  heartbeat: 'coordination',
  ask: 'coordination',
  claim: 'coordination',
  release: 'coordination',
  'force-clear': 'coordination',
  'next-slot': 'coordination',
  consume: 'coordination',
  tia: 'coordination',
  worktree: 'coordination',
  merge: 'merge', // 49.3-15 — the serialized merge ritual has its own topic

  // hooks — the four hook points
  'session-start': 'hooks',
  'session-end': 'hooks',
  pre: 'hooks',
  'pre-bench': 'hooks',
  'collision-check': 'hooks',
  'stall-check': 'hooks',

  // reflexes — lesson -> WARN at the act, and how rules mature
  'reflex-check': 'reflexes',
  ladder: 'reflexes',
  tune: 'reflexes',
  curriculum: 'reflexes',

  // gates — advisory WARN, dormant soft-deny, kill-switches, budget + integrity guards
  gates: 'gates',
  'gates-check': 'gates',
  'gates-report': 'gates',
  'gates-ack': 'gates',
  'airbag-check': 'gates',
  airbag: 'gates',
  undo: 'gates',
  spend: 'gates',
  'spend-check': 'gates',
  breaker: 'gates',
  preship: 'gates',
  integrity: 'gates',
  skeptic: 'gates',
  canary: 'gates',
  nearmiss: 'gates',
  preflight: 'gates',

  // memory-layers — core / topic notes / corpus health
  lint: 'memory-layers',
  'build-index': 'memory-layers',
  load: 'memory-layers',
  snapshot: 'memory-layers',
  usage: 'memory-layers',
  consolidate: 'memory-layers',
  trim: 'memory-layers',

  // calibration — ledger, per-domain hit-rate, benchmarks, dispositions
  'predict-score': 'calibration',
  calibration: 'calibration',
  disposition: 'calibration',
  bench: 'calibration',
  arena: 'calibration',

  // predictions — the frontmatter block + the grill
  grill: 'predictions',

  // receipts — structural claims, blind re-verification, subagent receipts
  reverify: 'receipts',
  'receipt-hash': 'receipts',
  'chain-tip': 'receipts',
  'chain-verify': 'receipts',
  'pretask-pack': 'receipts',
  'subagent-verify': 'receipts',
  'subagent-receipts': 'receipts',
  'blind-verify': 'receipts',
  evidence: 'receipts',

  // loop — the accountable loop, the flight recorder + continuation
  state: 'loop',
  'exec-journal': 'loop',
  metrics: 'loop',
  report: 'loop',
  'precompact-capsule': 'loop',
  resume: 'loop',
  handoff: 'loop',
  flight: 'loop',
  batch: 'loop',

  // substrate — files + git, no daemon/DB/cloud
  'upstream-check': 'substrate',

  // passport — PASSPORT.md + badge + model-version guard (49.3-02)
  passport: 'passport',
  model: 'passport',

  // the adoption wedges — each its own topic
  excavate: 'excavate',
  emit: 'emit',
  catalog: 'context',
  context: 'context',
  statusline: 'statusline',
  pulse: 'statusline',
  manifest: 'pr-passport',

  // the teaching layer itself
  profile: 'tour',
  explain: 'tour',
  'doc-audit': 'tour',

  // v3.6 — the off-ramp and the onboarding preview
  deleteme: 'deleteme',
  'memory-preview': 'memory-preview',
}

/**
 * extractHandlersKeys(cliSource) — extract every key from the `const HANDLERS = {` block
 * of cli.mjs, given its source as TEXT. Handles both quoted ('predict-score', 'next-slot')
 * and bare (status, claim) keys. Anchored to the block opening and stopping at its closing
 * brace, so text outside the block never contributes keys. NEVER imports cli.mjs.
 */
export function extractHandlersKeys(cliSource) {
  const src = String(cliSource ?? '')
  const marker = 'const HANDLERS = {'
  const anchor = src.indexOf(marker)
  if (anchor === -1) return []
  const after = src.slice(anchor + marker.length)
  // The HANDLERS block is a flat object literal; its close is the first line-start `}`.
  const endMatch = after.match(/\n\}/)
  const block = endMatch ? after.slice(0, endMatch.index) : after
  const keys = []
  // Each entry begins a line: optional-quote key optional-quote colon.
  const re = /(?:^|\n)\s*'?([A-Za-z][\w-]*)'?\s*:/g
  let m
  while ((m = re.exec(block)) !== null) keys.push(m[1])
  return keys
}

/** Parse a raw topic file into {ok, id, title, summary, en, ru, missing}. */
function parseTopic(id, raw) {
  const text = String(raw ?? '')
  const lines = text.split(/\r?\n/)
  const title = (lines[0] || '').replace(/^#\s*/, '').trim()
  // summary = first non-empty, non-heading line after the title.
  let summary = ''
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) continue
    if (l.startsWith('#')) break
    summary = l
    break
  }
  const enMatch = text.match(/\n##\s*en\s*\r?\n([\s\S]*?)(?=\n##\s+\w|$)/i)
  const ruMatch = text.match(/\n##\s*ru\s*\r?\n([\s\S]*?)(?=\n##\s+\w|$)/i)
  const en = enMatch ? enMatch[1].trim() : ''
  const ru = ruMatch ? ruMatch[1].trim() : ''
  const missing = []
  if (!title) missing.push('title')
  if (!summary) missing.push('summary')
  if (!en) missing.push('en')
  if (!ru) missing.push('ru')
  if (missing.length) return { ok: false, id, title, summary, en, ru, missing }
  return { ok: true, id, title, summary, en, ru }
}

/**
 * getTopic(id, {explainersDir}) — read + parse one topic file. A missing file returns
 * {ok:false, missing:['file']}; a malformed file returns {ok:false, missing:[...sections]}.
 * Never throws (tolerant read).
 */
export function getTopic(id, { explainersDir }) {
  const file = join(explainersDir, `${id}.md`)
  if (!existsSync(file)) return { ok: false, id, missing: ['file'] }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, id, missing: ['file'] }
  }
  return parseTopic(id, raw)
}

/** listTopics({explainersDir}) — [{id, summary}] for every *.md topic, sorted by id. */
export function listTopics({ explainersDir }) {
  let files = []
  try {
    files = readdirSync(explainersDir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  return files
    .map((f) => f.replace(/\.md$/, ''))
    .sort()
    .map((id) => {
      const t = getTopic(id, { explainersDir })
      return { id, summary: t.summary || '' }
    })
}

/**
 * renderTopic(id, {explainersDir, lang}) — {found, id, title, summary, lang, body} for a
 * known topic; {found:false, catalog:[...]} for an unknown or malformed one (the CLI prints
 * the catalog and exits 0 — teaching-surface contract). Default lang: en.
 */
export function renderTopic(id, { explainersDir, lang = 'en' }) {
  const t = getTopic(id, { explainersDir })
  if (!t.ok) return { found: false, catalog: listTopics({ explainersDir }) }
  const body = lang === 'ru' ? t.ru : t.en
  return { found: true, id, title: t.title, summary: t.summary, lang, body }
}

/**
 * coverage({cliSource, explainersDir}) — {uncovered:[...keys], count}. A HANDLERS key
 * absent from COMMAND_TOPICS counts; a key mapped to a topic whose file does not exist
 * ALSO counts. `count` is the number P49.3-09-A scores (0 at phase verify).
 */
export function coverage({ cliSource, explainersDir }) {
  const keys = extractHandlersKeys(cliSource)
  const uncovered = []
  for (const k of keys) {
    const topic = COMMAND_TOPICS[k]
    if (!topic) {
      uncovered.push(k)
      continue
    }
    const t = getTopic(topic, { explainersDir })
    if (!t.ok) uncovered.push(k)
  }
  return { uncovered, count: uncovered.length }
}

/**
 * lintTopics({explainersDir}) — {violations:[{file, rule, detail}]} over the REAL corpus.
 * Every file must parse (title, summary, both sections); every `## ru` section must be
 * free of em-dashes. Mirrors the lint.mjs violation shape.
 */
export function lintTopics({ explainersDir }) {
  const violations = []
  let files = []
  try {
    files = readdirSync(explainersDir).filter((f) => f.endsWith('.md'))
  } catch {
    return { violations }
  }
  for (const f of files.sort()) {
    const id = f.replace(/\.md$/, '')
    const t = getTopic(id, { explainersDir })
    if (!t.ok) {
      for (const miss of t.missing) {
        violations.push({ file: f, rule: 'topic-incomplete', detail: `missing ${miss}` })
      }
      continue
    }
    if (EM_DASH_RE.test(t.ru)) {
      violations.push({ file: f, rule: 'ru-em-dash', detail: 'em-dash (U+2014) in ## ru section' })
    }
  }
  return { violations }
}
