/**
 * Tests for scripts/sma/lib/state-section.mjs (Phase 49.1 Plan 19 — D-49.1-14).
 *
 * The machine-managed STATE.md section: the three contended zones (Current
 * Position / Open Blockers / Active Sessions) live inside a `<!-- SMA-MANAGED -->`
 * fenced region written ONLY through snapshot-semantics verbs with a
 * re-read-before-write guard (RESEARCH Open Question 2 + Pitfall 4).
 *
 * FIXTURE DISCIPLINE (feedback_test_fixtures_mirror_live_files): the section
 * headings + the blocker/session bullets below are copied VERBATIM from this
 * repo's live .planning/STATE.md (LF, no BOM). The Current Position line mirrors
 * the live `**Phase: N ...**` shape the board parser (parse-state.ts) keys on.
 *
 *   - Test 1: round-trip fidelity — writeSection(readSection(file)) is byte-identical.
 *   - Test 2: setPosition OVERWRITES the Current Position body (snapshot rule),
 *     preserving the `Phase: N` line; a second call leaves exactly one heading.
 *   - Test 3: addBlocker appends a parser-compatible bullet; resolveBlocker removes
 *     exactly the matched bullet and leaves the others intact.
 *   - Test 4: every write re-reads immediately before writing; a concurrent
 *     out-of-band change aborts with a retry signal instead of clobbering.
 *   - Test 5: content OUTSIDE the fence is never modified by any verb.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readSection,
  writeSection,
  setPosition,
  addBlocker,
  resolveBlocker,
  setSessions,
  FENCE_START,
  FENCE_END,
} from '../lib/state-section.mjs'

// Verbatim excerpt of the live STATE.md structure (LF), fence markers added.
const LINES = [
  '## Project Reference',
  '',
  'See: .planning/PROJECT.md (updated 2026-03-30)',
  '',
  FENCE_START,
  '',
  '## Current Position',
  '',
  '**Phase: 49.1 (SMA V2) — ИСПОЛНЯЕТСЯ. Планы 16–26 последовательно; этот терминал держит claim 49.1.**',
  '',
  '## Open Blockers',
  '',
  '- **Phase 33 has 3 human DoD gates pending:** flip `user_accepted` / `design_approved` / `live_verified` in `/crm/projects` only after the live verifies pass. (verify)',
  '- **Phase 25.1 needs check:** the board reportedly shows «0 задач» across phases — the per-phase Plans enrichment may not attach on the deployed sync; verify the task checklists populate on the staging deploy after this push and fix if still empty. (verify)',
  '',
  '## Active Sessions (multi-terminal)',
  '',
  '- **Phase 48 (parallel terminal):** owns branch `phase-48-example-module` (a worktree, NOT `main`) — Wave 1 (48-01/02) done, stopped at 48-03; do not touch that branch from here.',
  '',
  '### Quick Tasks Completed (recent — full history in STATE-ARCHIVE.md + git)',
  '',
  '| # | Description | Date | Commit | Directory |',
  '|---|-------------|------|--------|-----------|',
  '| 260703-ffq | BL-108 w1 | 2026-07-03 | a83935ec | dir |',
  '',
  FENCE_END,
  '',
  '## Archive',
  '',
  'Older state lives in `.planning/STATE-ARCHIVE.md` and in git history.',
  '',
]
const FIXTURE = LINES.join('\n')

let dir: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-statesec-'))
  statePath = join(dir, 'STATE.md')
  writeFileSync(statePath, FIXTURE)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = () => readFileSync(statePath, 'utf8')
const count = (s: string, sub: string) => s.split(sub).length - 1

describe('state-section.mjs — machine-managed STATE.md fenced region', () => {
  it('exports the fence markers carrying the SMA-MANAGED sentinel', () => {
    expect(FENCE_START).toContain('SMA-MANAGED')
    expect(FENCE_END).toContain('SMA-MANAGED')
    expect(FENCE_START).toContain('START')
    expect(FENCE_END).toContain('END')
  })

  it('Test 1 — round-trip fidelity: writeSection(readSection(file)) is byte-identical', () => {
    const region = readSection({ statePath })
    const res = writeSection(region, { statePath })
    expect(res.ok).toBe(true)
    expect(read()).toBe(FIXTURE)
  })

  it('Test 2 — setPosition OVERWRITES the Current Position body, one heading, Phase line preserved', () => {
    const r1 = setPosition({ phase: '49.1', text: 'executing wave 15' }, { statePath })
    expect(r1.ok).toBe(true)
    const out = read()
    expect(count(out, '## Current Position')).toBe(1)
    expect(out).toMatch(/\*\*Phase: 49\.1 — executing wave 15\*\*/)
    // parser contract: a `Phase: N` line still resolves.
    expect(out).toMatch(/Phase:\s*49\.1/)

    // second call overwrites (snapshot rule — never appends)
    const r2 = setPosition({ phase: '49.1', text: 'wave 16 next' }, { statePath })
    expect(r2.ok).toBe(true)
    const out2 = read()
    expect(count(out2, '## Current Position')).toBe(1)
    expect(out2).not.toContain('executing wave 15')
    expect(out2).toContain('wave 16 next')
  })

  it('Test 3 — addBlocker appends a parser-compatible bullet; resolveBlocker removes exactly the match', () => {
    const add = addBlocker(
      { phase: '49.1', text: 'state verbs shipping — verify the board parser', kind: 'tech' },
      { statePath },
    )
    expect(add.ok).toBe(true)
    const out = read()
    // parser-compatible: phase-literal + action word + bullet.
    expect(out).toMatch(/- \*\*Phase 49\.1 blocked:\*\* state verbs shipping — verify the board parser \(tech\)/)
    // the bullet lands inside Open Blockers, before Active Sessions.
    expect(out.indexOf('state verbs shipping')).toBeLessThan(out.indexOf('## Active Sessions'))
    expect(out.indexOf('state verbs shipping')).toBeGreaterThan(out.indexOf('## Open Blockers'))

    const res = resolveBlocker({ match: 'state verbs shipping' }, { statePath })
    expect(res.ok).toBe(true)
    const out2 = read()
    expect(out2).not.toContain('state verbs shipping')
    // pre-existing blockers untouched.
    expect(out2).toContain('Phase 33 has 3 human DoD gates pending')
    expect(out2).toContain('Phase 25.1 needs check')
  })

  it('Test 4 — a concurrent out-of-band change between read and write aborts with a retry signal', () => {
    let calls = 0
    const changed = FIXTURE.replace('claim 49.1', 'claim 49.1 CHANGED BY OTHER TERMINAL')
    const readFn = () => {
      calls += 1
      return calls === 1 ? FIXTURE : changed
    }
    let wrote = false
    const writeFn = () => {
      wrote = true
    }
    const res = setPosition(
      { phase: '49.1', text: 'x' },
      { statePath, readFn, writeFn, renameFn: () => {}, mkdirFn: () => {} },
    )
    expect(res.ok).toBe(false)
    expect(res.retry).toBe(true)
    expect(wrote).toBe(false)
    // the real file on disk is untouched.
    expect(read()).toBe(FIXTURE)
  })

  it('Test 5 — content OUTSIDE the fence is never modified by any verb', () => {
    const outsideOf = (s: string) =>
      s.slice(0, s.indexOf(FENCE_START)) + s.slice(s.indexOf('## Archive'))
    const before = outsideOf(FIXTURE)

    setPosition({ phase: '49.1', text: 'moved on' }, { statePath })
    addBlocker({ phase: '49.1', text: 'new thing — clear it', kind: 'ops' }, { statePath })
    resolveBlocker({ match: 'Phase 25.1 needs check' }, { statePath })
    setSessions({ name: 'Phase 49.1 (this terminal)', owns: 'scripts/sma/** — state-section' }, { statePath })

    const after = read()
    expect(outsideOf(after)).toBe(before)
    // and the fence markers survived every mutation.
    expect(count(after, FENCE_START)).toBe(1)
    expect(count(after, FENCE_END)).toBe(1)
  })

  it('setSessions appends a session bullet inside Active Sessions without clobbering existing ones', () => {
    const res = setSessions(
      { name: 'Phase 49.1 (this terminal)', owns: 'scripts/sma/** — state-section' },
      { statePath },
    )
    expect(res.ok).toBe(true)
    const out = read()
    expect(out).toContain('- **Phase 49.1 (this terminal):** scripts/sma/** — state-section')
    // the pre-existing session line is still present.
    expect(out).toContain('Phase 48 (parallel terminal)')
    // the appended bullet sits inside Active Sessions, before the Quick Tasks subsection.
    expect(out.indexOf('this terminal')).toBeLessThan(out.indexOf('### Quick Tasks'))
  })
})
