#!/usr/bin/env node
/**
 * rename.mjs — deterministic, mechanical gsd -> sma rebrand of the sma-core/ tree.
 *
 * Plan 9.1-02 Task 1 (D-9.1-01, FI-7). Zero logic changes: file renames +
 * ordered, case-preserving string substitution only. Emits rename-map.json at
 * the repo root — the machine-readable map the 9.1-07 upstream-watch differ
 * consumes to translate upstream paths/strings into ours.
 *
 * Scope: sma-core/** ONLY. vendor/**, LICENSE, THIRD-PARTY-LICENSES.md,
 * UPSTREAM.json, rename-map.json and tools/** are never touched (exclusions
 * recorded in the emitted map).
 *
 * Idempotent: re-running on an already-renamed tree is a no-op.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOT = path.join(ROOT, 'sma-core')

// Ordered string substitutions — order matters (most specific first, so the
// scoped npm name does not decay into "@opensma/sma-core"). Applied to file
// CONTENTS and to file BASENAMES alike.
const STRING_MAP = [
  // npm package identity: chosen product name is "sma-framework" (no scope) —
  // 9.1-NAMING.md CHOSEN marker, reverified live 2026-07-06.
  { from: '@opengsd/gsd-core', to: 'sma-framework' },
  // GitHub source coordinates -> future product repo github.com/sma-framework/sma
  { from: 'open-gsd/gsd-core', to: 'sma-framework/sma' },
  // residual bare vendor slug (cache slugs, cache file names)
  { from: 'opengsd', to: 'sma-framework' },
  // engine tree + tools shim
  { from: 'gsd-core', to: 'sma-core' },
  { from: 'gsd-tools', to: 'sma-tools' },
  // generic case-preserving brand token (covers /gsd- command prefix,
  // gsd-executor-style agent names, .gsd/ dirs, gsd_run, gsd2-import,
  // GSD_TOOLS/_GSD_SHIM_NAME vars, GsdXxx identifiers)
  { from: 'gsd', to: 'sma' },
  { from: 'GSD', to: 'SMA' },
  { from: 'Gsd', to: 'Sma' },
]

// Paths (repo-root-relative, forward slashes) never scanned or rewritten.
const EXCLUSIONS = [
  'vendor/**  (pristine upstream snapshot — the 9.1-07 diff base)',
  'LICENSE  (upstream MIT text, attribution)',
  'THIRD-PARTY-LICENSES.md  (attribution: "derived from gsd-core" stays verbatim)',
  'UPSTREAM.json  (upstream anchor keeps the original package/source names)',
  'rename-map.json  (this map itself)',
  'tools/**  (rename/verify scripts carry the old tokens as data)',
  'sma-core/aliases/**  (transitional /gsd-* alias layer intentionally carries the old prefix, D-9.1-02)',
  'lines matching /derived from gsd-core/i anywhere (attribution sentences stay verbatim)',
  'the literal string "get-shit-done" / "Get Shit Done" (pre-gsd-core historical migration source names; contains no gsd token, left verbatim)',
]

const ATTRIBUTION_LINE = /derived from gsd-core/i

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'aliases') continue // transitional alias layer — excluded
      walk(p, out)
    } else if (entry.isFile()) {
      out.push(p)
    }
  }
  return out
}

function applyMap(s) {
  let r = s
  for (const { from, to } of STRING_MAP) r = r.split(from).join(to)
  return r
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function isBinary(buf) {
  return buf.includes(0)
}

const fileRenames = []
const contentEdits = []
const skippedBinary = []

// Pass 1: in-file replacements (attribution lines preserved verbatim)
for (const file of walk(SCAN_ROOT)) {
  const buf = fs.readFileSync(file)
  if (isBinary(buf)) {
    skippedBinary.push(rel(file))
    continue
  }
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  const next = lines.map((line) => (ATTRIBUTION_LINE.test(line) ? line : applyMap(line))).join('\n')
  if (next !== text) {
    fs.writeFileSync(file, next, 'utf8')
    contentEdits.push(rel(file))
  }
}

// Pass 2: file renames (basenames only — no directory inside sma-core carries the token)
for (const file of walk(SCAN_ROOT)) {
  const base = path.basename(file)
  const nextBase = applyMap(base)
  if (nextBase !== base) {
    const target = path.join(path.dirname(file), nextBase)
    fs.renameSync(file, target)
    fileRenames.push({ from: rel(file), to: rel(target) })
  }
}

// Emit the machine-readable map (consumed by the 9.1-07 three-way differ)
const map = {
  generated: new Date().toISOString().slice(0, 10),
  plan: '9.1-02',
  decision: 'D-9.1-01 (atomic fork rebrand) + FI-7 (atomic rename lock)',
  package: { from: '@opengsd/gsd-core', to: 'sma-framework', install: 'npx sma-framework init' },
  files: fileRenames,
  strings: STRING_MAP,
  exclusions: EXCLUSIONS,
  notes: [
    'String substitutions are ORDERED — apply top to bottom (most specific first).',
    'File renames apply the same ordered map to basenames.',
    'Attribution lines matching /derived from gsd-core/i are kept verbatim wherever they occur.',
    'Purely mechanical: zero logic changes vs vendor/gsd-core-1.6.1 (Pitfall 5 — keeps the upstream diff base clean).',
  ],
}
fs.writeFileSync(path.join(ROOT, 'rename-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8')

console.log(`renamed files: ${fileRenames.length}`)
console.log(`content edits: ${contentEdits.length}`)
if (skippedBinary.length) console.log(`skipped binary: ${skippedBinary.join(', ')}`)
console.log('rename-map.json written')
