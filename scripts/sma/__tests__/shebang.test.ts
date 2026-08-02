/**
 * Tests for the strip-shebang rule in vitest.config.mjs — the cure for a CLASS of
 * silently shrinking suites.
 *
 * The failure being prevented: a test imports an executable script, the module
 * runner's inline transform hits `#!/usr/bin/env node`, throws `SyntaxError:
 * Invalid or unexpected token`, and charges it to the IMPORTING file — which then
 * collects zero tests. The report names the victim, not the cause, so the honest
 * reading is "that test file is broken" while its cases quietly leave the count.
 * The old cure was one `server.deps.external` entry per victim, added after each
 * one bled; this is the same cure applied to every file that starts with `#!`.
 *
 * MEASURED, not assumed: the shape that actually breaks is a CRLF interpreter
 * line (`#!/usr/bin/env node\r\n`). The same line ending `\n` survives the current
 * runner. That is not a detail — with `core.autocrlf=true` every shebanged file in
 * a Windows checkout HAS the breaking shape, which is why the tree's executables
 * are loaded guns here and look harmless elsewhere. The fixture below is pinned to
 * CRLF in `.gitattributes` so this suite tests the breaking shape on every
 * platform rather than whichever one checked it out.
 *
 * The load-bearing behaviors:
 *   Test 1 — LIVE: this file imports a fixture whose first line is a CRLF shebang.
 *            Without the rule that import throws and this whole file collects ZERO
 *            tests — verified by running this suite under a config with the plugin
 *            removed — so the tests below existing at all is itself the receipt.
 *   Test 2 — the rule is a pure function: shebang stripped for both line endings,
 *            line numbers kept, non-shebang files untouched, only the FIRST line
 *   Test 3 — the loaded guns in the tree (bin/init.mjs, tools/verify-rebrand.mjs,
 *            tools/terminal-parity-check.mjs) are all covered by the rule, and
 *            each keeps its interpreter line ON DISK — the strip is a read-time
 *            concern, never an edit to product surface
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import { stripShebang } from '../../../vitest.config.mjs'
// Test 1 is this import: a module whose first byte is `#`, loaded by the runner.
import { SHEBANG_FIXTURE, DECLARED_ON_LINE } from './fixtures/shebang-module.mjs'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const FIXTURE = join(__dirname, 'fixtures', 'shebang-module.mjs')

/** The rule's transform, called the way vite calls it. */
function transform(code: string) {
  const plugin = stripShebang() as { transform: (c: string) => { code: string } | null }
  return plugin.transform(code)
}

describe('shebang — a suite that imports an executable module still exists (Test 1)', () => {
  it('loaded the shebanged fixture, so this file collected its tests at all', () => {
    expect(SHEBANG_FIXTURE).toBe('loaded')
    // The file on disk really does open with the BREAKING shape — a CRLF
    // interpreter line — so the import above is not a safe case dressed up as a
    // hard one. `.gitattributes` pins that ending; if this assertion ever fails,
    // the pin was lost and the live proof above went quietly vacuous.
    expect(readFileSync(FIXTURE, 'utf8').startsWith('#!/usr/bin/env node\r\n')).toBe(true)
  })
})

describe('shebang — the rule itself (Test 2)', () => {
  it('strips only the first line and keeps every later line where it was', () => {
    const raw = readFileSync(FIXTURE, 'utf8')
    const out = transform(raw)
    expect(out).not.toBe(null)
    const before = raw.replace(/\r\n/g, '\n').split('\n')
    const after = (out as { code: string }).code.replace(/\r\n/g, '\n').split('\n')
    expect(after.length).toBe(before.length) // blanked, never deleted
    expect(after[0]).toBe('')
    expect(after[DECLARED_ON_LINE - 1]).toContain('export const DECLARED_ON_LINE')
  })

  it('leaves an ordinary module alone (no cost for the 99% case)', () => {
    expect(transform('export const x = 1\n')).toBe(null)
    expect(transform('')).toBe(null)
    // A `#!` that is not the first thing in the file is data, not an interpreter
    // line — touching it would corrupt the module.
    const withHashBang = 'export const s = "#!/usr/bin/env node"\n'
    expect(transform(withHashBang)).toBe(null)
  })

  it('touches nothing after the first newline, even a second shebang-looking line', () => {
    const out = transform('#!/usr/bin/env node\nexport const s = "#!/bin/sh"\n')
    expect((out as { code: string }).code).toBe('\nexport const s = "#!/bin/sh"\n')
  })

  it('strips the CRLF form — the one that actually breaks the runner — carriage return and all', () => {
    const out = transform('#!/usr/bin/env node\r\nexport const x = 1\r\n')
    // The `\r` must go with the line it belongs to: left behind, it is a stray
    // carriage return where the parser expects a statement.
    expect((out as { code: string }).code).toBe('\nexport const x = 1\r\n')
  })
})

describe('shebang — every loaded gun in the tree is covered (Test 3)', () => {
  const EXECUTABLES = ['bin/init.mjs', 'tools/verify-rebrand.mjs', 'tools/terminal-parity-check.mjs']

  it('each executable keeps its interpreter line on disk and is disarmed at read time', () => {
    for (const rel of EXECUTABLES) {
      const raw = readFileSync(join(REPO_ROOT, rel), 'utf8')
      // The line stays in the file: these are executed directly, and the shebang
      // is product surface, not test scaffolding.
      expect(raw.startsWith('#!')).toBe(true)
      const out = transform(raw)
      expect(out).not.toBe(null)
      const code = (out as { code: string }).code
      expect(code.startsWith('#!')).toBe(false)
      expect(code.split('\n').length).toBe(raw.replace(/\r\n/g, '\n').split('\n').length)
    }
  })
})
