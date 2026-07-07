#!/usr/bin/env node
/**
 * verify-rebrand.mjs — integrity gate for the gsd -> sma atomic rebrand.
 *
 * Plan 49.1-02 Task 2 (T-49.1-03 / T-49.1-04 mitigations). Three checks:
 *   (a) DISPATCH: every subagent_type value in sma-core/workflows/** resolves
 *       to an existing sma-core/agents/<name>.md (broken dispatch is invisible
 *       until a command runs — FI-7).
 *   (b) ZERO RESIDUE: no old brand token (gsd / GSD / Gsd, case-sensitive
 *       alternation — avoids camelCase false positives like "learningsDelete")
 *       anywhere in sma-core/** contents or filenames, outside the exclusions
 *       recorded in rename-map.json (aliases/ layer intentionally carries the
 *       old prefix per D-49.1-02).
 *   (c) COLORS: every sma-core/agents/sma-*.md frontmatter carries a color field.
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
      if (path.relative(CORE, p).split(path.sep)[0] === 'aliases') continue // D-49.1-02 exclusion
      walk(p, out)
    } else if (entry.isFile()) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

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
    if (ATTRIBUTION_LINE.test(line)) return // attribution stays verbatim (rename-map exclusion)
    if (OLD_TOKEN.test(line)) {
      errors.push(`RESIDUE: ${rel(file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
      residueHits++
    }
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
if (errors.length) {
  console.error(`\nFAIL — ${errors.length} violation(s):`)
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log('OK — rebrand intact (dispatch resolves, zero residue, colors applied)')
