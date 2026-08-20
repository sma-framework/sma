/**
 * Milestone scoping must not switch itself off in silence.
 *
 * The state file records which milestone is current, and both the roadmap READER
 * (extractCurrentMilestone) and the roadmap WRITER's source (getMilestoneInfo)
 * start from that value. When the recorded value resolves to nothing in the
 * roadmap at hand — a version no heading and no summary carries, or a word that
 * is not a milestone version at all — the old order used it anyway:
 *
 *   - the reader handed back the WHOLE roadmap, so every caller that believed it
 *     was looking at one milestone was looking at all of them, and nothing said so;
 *   - the writer kept the unresolvable version and stamped the placeholder name
 *     'milestone' beside it, and that pair was written back into the state file —
 *     so a bad value re-recorded itself on every call and healed never.
 *
 * Both functions already carried the healthy path (the in-progress marker) and
 * simply never reached it. These tests hold the fix in both, and equally hold the
 * paths that must NOT change: a value that does resolve, and a missing state file.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const require = createRequire(import.meta.url)
const repoRoot = join(__dirname, '..', '..', '..')
const parser = require(join(repoRoot, 'sma-core', 'bin', 'lib', 'roadmap-parser.cjs'))
const { extractCurrentMilestone, getMilestoneInfo } = parser

/**
 * A roadmap with everything the scoping logic has to walk past: a preamble, a
 * milestone checklist, one shipped milestone folded into <details>/<summary>,
 * the live milestone carrying the in-progress marker, and one more milestone
 * after it so the end-of-section cut is exercised too.
 */
const ROADMAP = [
  '# Product Roadmap',
  '',
  'Preamble line that every scoped result keeps.',
  '',
  '## Milestones',
  '',
  '- ✅ **v4.9.0 Shipped Groundwork** — closed',
  '- 🚧 **v5.6 Living Milestone** — in progress',
  '- 📋 **v5.7 Next Milestone** — planned',
  '',
  '<details>',
  '<summary>✅ v4.9.0 Shipped Groundwork — 2 phases</summary>',
  '',
  '### Phase 1: Old work',
  'SHIPPED-BODY-MARK',
  '',
  '</details>',
  '',
  '## 🚧 v5.6 Living Milestone',
  '',
  'LIVE-BODY-MARK',
  '',
  '### Phase 7: Current work',
  'Body of the current phase.',
  '',
  '## 📋 v5.7 Next Milestone',
  '',
  'NEXT-BODY-MARK',
  '',
].join('\n')

/** The same roadmap with no in-progress marker anywhere. */
const ROADMAP_WITHOUT_MARKER = ROADMAP.replace(/🚧/g, '📋')

/** What "no scoping at all" looks like: the whole roadmap minus shipped blocks. */
const UNSCOPED = ROADMAP.replace(/<details>[\s\S]*?<\/details>/gi, '')

const tmpDirs: string[] = []
let savedProject: string | undefined
let savedWorkstream: string | undefined

/**
 * A throwaway workspace on disk: the functions read the state file themselves,
 * through the real filesystem, so the fixture has to be a real directory.
 */
function makeWorkspace(stateMilestone: string | null, roadmap: string = ROADMAP): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-milestone-scope-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, '.planning'), { recursive: true })
  if (stateMilestone !== null) {
    writeFileSync(
      join(dir, '.planning', 'STATE.md'),
      `---\nphase: 7\nmilestone: ${stateMilestone}\nmilestone_name: milestone\n---\n\n# State\n`,
      'utf-8',
    )
  }
  writeFileSync(join(dir, '.planning', 'ROADMAP.md'), roadmap, 'utf-8')
  return dir
}

beforeEach(() => {
  // The planning directory honours these two; left set, the fixture workspace
  // would resolve to a subdirectory that does not exist.
  savedProject = process.env['SMA_PROJECT']
  savedWorkstream = process.env['SMA_WORKSTREAM']
  delete process.env['SMA_PROJECT']
  delete process.env['SMA_WORKSTREAM']
})

afterEach(() => {
  if (savedProject === undefined) delete process.env['SMA_PROJECT']
  else process.env['SMA_PROJECT'] = savedProject
  if (savedWorkstream === undefined) delete process.env['SMA_WORKSTREAM']
  else process.env['SMA_WORKSTREAM'] = savedWorkstream
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
})

describe('reading the current milestone section', () => {
  it('falls back to the in-progress marker when the recorded version resolves to nothing', () => {
    const cwd = makeWorkspace('v2.1.178')
    const result = extractCurrentMilestone(ROADMAP, cwd)
    expect(result).toContain('LIVE-BODY-MARK')
    expect(result).not.toContain('NEXT-BODY-MARK')
    expect(result).not.toContain('SHIPPED-BODY-MARK')
    // The silent degradation this guards: handing back the whole roadmap.
    expect(result).not.toBe(UNSCOPED)
    expect(result).not.toBe(ROADMAP)
  })

  it('falls back to the in-progress marker when the recorded value is not a version at all', () => {
    const wordCwd = makeWorkspace('current-work')
    const markerCwd = makeWorkspace(null)
    expect(extractCurrentMilestone(ROADMAP, wordCwd)).toBe(extractCurrentMilestone(ROADMAP, markerCwd))
    expect(extractCurrentMilestone(ROADMAP, wordCwd)).toContain('LIVE-BODY-MARK')
    expect(extractCurrentMilestone(ROADMAP, wordCwd)).not.toBe(UNSCOPED)
  })

  it('keeps using the recorded version when a heading does carry it', () => {
    const cwd = makeWorkspace('v5.7')
    const result = extractCurrentMilestone(ROADMAP, cwd)
    expect(result).toContain('NEXT-BODY-MARK')
    expect(result).not.toContain('LIVE-BODY-MARK')
    expect(result).not.toContain('SHIPPED-BODY-MARK')
  })

  it('uses the in-progress marker when there is no state file', () => {
    const cwd = makeWorkspace(null)
    const result = extractCurrentMilestone(ROADMAP, cwd)
    expect(result).toContain('LIVE-BODY-MARK')
    expect(result).not.toContain('NEXT-BODY-MARK')
    expect(result).not.toContain('SHIPPED-BODY-MARK')
  })

  it('returns the roadmap without shipped blocks when there is neither a state file nor a marker', () => {
    const cwd = makeWorkspace(null, ROADMAP_WITHOUT_MARKER)
    const result = extractCurrentMilestone(ROADMAP_WITHOUT_MARKER, cwd)
    expect(result).toBe(ROADMAP_WITHOUT_MARKER.replace(/<details>[\s\S]*?<\/details>/gi, ''))
  })
})

describe('resolving the milestone that gets written back into state', () => {
  it('never answers with an unresolvable version and a placeholder name', () => {
    const cwd = makeWorkspace('v2.1.178')
    const info = getMilestoneInfo(cwd)
    expect(info.version).toBe('v5.6')
    expect(info.name).toBe('Living Milestone')
    // The self-sustaining pair: the bad value plus the placeholder, written back
    // into the state file on every call, which is why it never healed.
    expect(info.version).not.toBe('v2.1.178')
    expect(info.name).not.toBe('milestone')
  })

  it('keeps using the recorded version when a heading does carry it', () => {
    const cwd = makeWorkspace('v5.7')
    const info = getMilestoneInfo(cwd)
    expect(info.version).toBe('v5.7')
    expect(info.name).toBe('Next Milestone')
  })
})
