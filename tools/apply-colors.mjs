#!/usr/bin/env node
/**
 * apply-colors.mjs — apply the house palette to every sma-core agent (FI-7).
 *
 * Plan 9.1-02 Task 2. Founder requirement: the stock orange/yellow chip goes,
 * agents carry the house palette.
 *
 * Palette intent (brand book): blue #3B82F6 for the execution family, teal
 * #3CC0A0 for the research/verify family. CONSTRAINT: Claude Code agent
 * frontmatter renders only NAMED colors (red/blue/green/yellow/purple/orange/
 * pink/cyan) — hex values are not rendered. Per the plan's fallback branch we
 * use the nearest named values: blue (= #3B82F6 family) and cyan (= #3CC0A0
 * family). The constraint is recorded in sma-executor.md and the SUMMARY.
 *
 * Idempotent: rewrites the color line to the target value.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AGENTS = path.join(ROOT, 'sma-core', 'agents')

// research/verify family -> cyan (#3CC0A0 family); everything else -> blue (#3B82F6 family)
const CYAN_FAMILY = /(researcher|verifier|auditor|plan-checker)\.md$/

const CONSTRAINT_COMMENT =
  '# house palette: blue = #3B82F6 family (execution), cyan = #3CC0A0 family (research/verify).\n' +
  '# Claude Code agent frontmatter accepts NAMED colors only — hex is not rendered (FI-7 fallback branch, 9.1-02).'

let changed = 0
for (const name of fs.readdirSync(AGENTS).sort()) {
  if (!name.endsWith('.md')) continue
  const file = path.join(AGENTS, name)
  const text = fs.readFileSync(file, 'utf8')
  const color = CYAN_FAMILY.test(name) ? 'cyan' : 'blue'

  // frontmatter = between the first two '---' lines
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) {
    console.error(`NO FRONTMATTER: ${name}`)
    process.exitCode = 1
    continue
  }
  let fm = m[1]
  const needsComment = name === 'sma-executor.md' && !fm.includes('house palette:')
  const colorLine = needsComment ? `${CONSTRAINT_COMMENT}\ncolor: ${color}` : `color: ${color}`
  if (/^color:\s*.*$/m.test(fm)) {
    fm = fm.replace(/^color:\s*.*$/m, colorLine)
  } else {
    fm = fm.replace(/^(name:\s*.*)$/m, `$1\n${colorLine}`)
  }
  const next = text.slice(0, m.index) + `---\n${fm}\n---` + text.slice(m.index + m[0].length)
  if (next !== text) {
    fs.writeFileSync(file, next, 'utf8')
    changed++
  }
}
console.log(`agents recolored: ${changed}`)
