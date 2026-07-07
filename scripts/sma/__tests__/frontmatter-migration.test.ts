/**
 * Tests for scripts/sma/lib/frontmatter.mjs (Phase 49 Plan 04, Task 2).
 *
 * The single shared read/write path for all 205 memory notes (RESEARCH §Don't
 * Hand-Roll — narrow parser for the two observed corpus shapes only):
 *   - Test 1: parseNote round-trips a flat `type:` shape; serializeNote(parseNote)
 *     preserves the BODY byte-identically.
 *   - Test 2: parseNote handles the nested `metadata:` block (2-space sub-keys
 *     node_type/type/originSessionId) without corrupting sub-keys.
 *   - Test 3: no-frontmatter file -> {frontmatter: null, body} (structural files).
 *   - Test 4: an unsupported shape throws a loud descriptive error naming the
 *     file + line — never guesses (B12).
 *   - Test 5: serializeNote emits the NORMALIZED schema in a FIXED key order
 *     (description, kind, tags, use-when, importance, supersedes, superseded_by,
 *     superseded_at) — deterministic output for R3 byte-identity.
 *   - Test 6: loadTagsRegistry -> {area:Set, kind:Set, aliases:Map};
 *     resolveAlias maps UF->USE and returns a canonical tag unchanged.
 */

import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  parseNote,
  serializeNote,
  loadTagsRegistry,
  resolveAlias,
} from '../lib/frontmatter.mjs'
import { runMigration, migrateNote, validateTables } from '../migrate-frontmatter.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The committed registry from Task 1. Location-independent (49.1-03 migration):
// prefer the repo's LIVE registry when this tree runs inside a corpus-bearing
// repo (the originating platform); fall back to the verbatim fixture copy when
// the tree runs standalone in the sma-framework product repo.
const LIVE_TAGS_PATH = join(__dirname, '..', '..', '..', '.claude', 'memory', 'TAGS.md')
const TAGS_PATH = existsSync(LIVE_TAGS_PATH)
  ? LIVE_TAGS_PATH
  : join(__dirname, 'fixtures', 'TAGS.md')

// ── Real corpus shapes (verbatim structure from .claude/memory/) ──────────────

const FLAT = `---
name: Back-links must return user to prior page
description: Any back link must return the user to the exact page and scroll position
type: feedback
originSessionId: d6be0d3d-9fcd-49f3-ab81-5041bd46707d
---
On every sub-page the top back link must behave like a real browser back button.

**Why:** user reported the scoliosis back-link always sent them to /quiz.
`

const NESTED = `---
name: when-another-terminal-regresses-my-work-augment-don-t-revert
description: "Parallel-terminal collisions are inevitable when multiple sessions run."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 49856e33-f8b8-412c-b607-70a5772cfc16
---
When working in parallel with the user's other terminal, expect rewrites.

**How to apply:** re-introduce the missing rule additively.
`

const NO_FM = `# Memory Archive — episodic / shipped-phase log

- [Example Platform Project](project_example.md) — market-targeted
`

// A top-level YAML list inside the fence — not one of the two observed shapes.
const UNSUPPORTED = `---
- alpha
- beta
---
body text
`

describe('parseNote', () => {
  it('Test 1: round-trips a flat type: shape; body is byte-identical', () => {
    const { frontmatter, body } = parseNote(FLAT, { file: 'flat.md' })
    expect(frontmatter).not.toBeNull()
    expect(frontmatter.type).toBe('feedback')
    expect(frontmatter.name).toBe('Back-links must return user to prior page')
    // Body preserved byte-for-byte (everything after the closing fence + newline).
    const expectedBody = FLAT.slice(FLAT.indexOf('---\n', 4) + 4)
    expect(body).toBe(expectedBody)
  })

  it('Test 2: handles the nested metadata: block without corrupting sub-keys', () => {
    const { frontmatter } = parseNote(NESTED, { file: 'nested.md' })
    expect(frontmatter.metadata).toBeTypeOf('object')
    expect(frontmatter.metadata.node_type).toBe('memory')
    expect(frontmatter.metadata.type).toBe('feedback')
    expect(frontmatter.metadata.originSessionId).toBe('49856e33-f8b8-412c-b607-70a5772cfc16')
    expect(frontmatter.name).toBe('when-another-terminal-regresses-my-work-augment-don-t-revert')
  })

  it('Test 3: no-frontmatter file returns {frontmatter: null, body}', () => {
    const { frontmatter, body } = parseNote(NO_FM, { file: 'MEMORY.md' })
    expect(frontmatter).toBeNull()
    expect(body).toBe(NO_FM)
  })

  it('Test 4: unsupported shape throws a loud error naming file + line', () => {
    let err
    try {
      parseNote(UNSUPPORTED, { file: 'bad.md' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('bad.md')
    expect(err.message).toMatch(/line \d+/)
  })
})

describe('serializeNote', () => {
  it('Test 5: emits normalized schema in the fixed key order', () => {
    const note = {
      frontmatter: {
        // deliberately scrambled input order
        importance: 'high',
        tags: ['tech', 'decision'],
        description: 'A standalone claim.',
        'superseded_by': null,
        kind: 'decision',
        'use-when': 'deciding X',
      },
      body: 'Body stays.\n',
    }
    const out = serializeNote(note)
    // Extract the frontmatter key lines in emitted order.
    const fence = out.split('---\n')
    const keyOrder = fence[1]
      .split('\n')
      .filter((l) => /^[a-zA-Z][\w-]*:/.test(l))
      .map((l) => l.slice(0, l.indexOf(':')))
    expect(keyOrder).toEqual([
      'description',
      'kind',
      'tags',
      'use-when',
      'importance',
    ])
    // Absent optional keys (supersedes / superseded_at) are omitted;
    // null superseded_by is omitted too.
    expect(out).not.toContain('supersedes:')
    expect(out).not.toContain('superseded_by:')
    expect(out).not.toContain('superseded_at:')
    // Inline tags form + preserved body + LF endings + no BOM.
    expect(out).toContain('tags: [tech, decision]')
    expect(out.endsWith('Body stays.\n')).toBe(true)
    expect(out.charCodeAt(0)).not.toBe(0xfeff)
    expect(out).not.toContain('\r\n')
  })

  it('serialize preserves the flat body byte-identically through a full round trip', () => {
    const parsed = parseNote(FLAT, { file: 'flat.md' })
    const out = serializeNote(parsed)
    // Body after the emitted fence equals the original parsed body exactly.
    const emittedBody = out.slice(out.indexOf('---\n', 4) + 4)
    expect(emittedBody).toBe(parsed.body)
  })
})

describe('loadTagsRegistry + resolveAlias', () => {
  it('Test 6: parses TAGS.md into facets + aliases; resolveAlias maps UF->USE', () => {
    const registry = loadTagsRegistry(TAGS_PATH)
    expect(registry.area).toBeInstanceOf(Set)
    expect(registry.kind).toBeInstanceOf(Set)
    expect(registry.aliases).toBeInstanceOf(Map)

    // Canonical facet members present.
    expect(registry.area.has('messaging')).toBe(true)
    expect(registry.kind.has('procedural-rule')).toBe(true)
    expect(registry.kind.has('bug-lesson')).toBe(true)

    // Alias -> canonical (B2 USE/UF).
    expect(resolveAlias('wa', registry)).toBe('messaging')
    expect(resolveAlias('360dialog', registry)).toBe('messaging')
    // A canonical tag resolves to itself.
    expect(resolveAlias('messaging', registry)).toBe('messaging')
    // An unknown tag is returned unchanged (membership is lint's job, 49-08).
    expect(resolveAlias('totally-unknown', registry)).toBe('totally-unknown')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// migrate-frontmatter.mjs — R2 corpus migration (Plan 11, Task 1 behaviors)
// ══════════════════════════════════════════════════════════════════════════════

const registry = loadTagsRegistry(TAGS_PATH)

/** A fixture note with the NESTED metadata shape + a real description. */
const NESTED_NOTE = `---
name: reference_railway_deploy_notes
description: "Railway hosting notes — deploy, env vars, build limits for the platform."
metadata:
  node_type: memory
  type: reference
  originSessionId: aaaa1111-bbbb-2222-cccc-333344445555
---
Railway is the current dev/staging host. Redeploy pulls a fresh image.
`

/** A fixture note with the FLAT type: shape + a real description. */
const FLAT_NOTE = `---
name: project_whatsapp_live
description: WhatsApp channel LIVE via 360dialog Coexistence, inbound flowing into the CRM inbox.
type: project
---
The WhatsApp number is live end-to-end; inbound messages flow into /crm/inbox.
`

/** An empty-body fixture (SPEC edge: empty R2) — must be SKIPPED. */
const EMPTY_BODY_NOTE = `---
name: feedback_placeholder
description: A placeholder note with no body content at all whatsoever here.
type: feedback
---
`

/** A feedback fixture carrying the D-49-15 bug-lesson form (Why + How to apply). */
const BUGLESSON_NOTE = `---
name: feedback_migration_rename_footgun
description: Drizzle add+drop column in one migration window hangs the Railway deploy.
type: feedback
originSessionId: dddd4444-eeee-5555-ffff-666677778888
---
When a migration adds and drops a column in the same window the deploy hangs.

**Why:** the interactive rename prompt blocks on a non-TTY Railway build.

**How to apply:** pre-ADD COLUMN IF NOT EXISTS in a prior migration, then split.
`

/** Build a throwaway corpus dir seeded with the real TAGS.md + given notes. */
function makeCorpus(notes: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-migrate-'))
  cpSync(TAGS_PATH, join(dir, 'TAGS.md'))
  // A minimal index so description-fallback + orphan logic have something to read.
  writeFileSync(join(dir, 'MEMORY.md'), '# Index\n')
  for (const [name, text] of Object.entries(notes)) {
    writeFileSync(join(dir, name), text)
  }
  return dir
}

describe('migrate-frontmatter (Plan 11 Task 1)', () => {
  it('Test 1: nested metadata shape → normalized schema; kind from KIND_MAP; body byte-identical', () => {
    const res = migrateNote({
      file: 'reference_railway_deploy_notes.md',
      text: NESTED_NOTE,
      registry,
    })
    expect(res.skip).toBeFalsy()
    expect(res.kind).toBe('reference')
    // Body preserved byte-for-byte (everything after the closing fence + newline).
    const originalBody = NESTED_NOTE.slice(NESTED_NOTE.indexOf('---\n', 4) + 4)
    expect(res.body).toBe(originalBody)
    // Normalized frontmatter carries the required fields.
    expect(res.frontmatter.description).toContain('Railway hosting notes')
    expect(res.frontmatter.kind).toBe('reference')
    expect(Array.isArray(res.frontmatter.tags)).toBe(true)
    expect(res.frontmatter.tags.length).toBeGreaterThanOrEqual(1)
    expect(res.frontmatter['use-when']).toBeTruthy()
    expect(Number.isInteger(res.frontmatter.importance)).toBe(true)
    // The serialized note keeps the body verbatim.
    const out = serializeNote({ frontmatter: res.frontmatter, body: res.body })
    expect(out.endsWith(originalBody)).toBe(true)
    expect(out).not.toContain('\r\n')
    expect(out.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('Test 2: flat type: shape migrates equivalently; active project → status kind', () => {
    const res = migrateNote({ file: 'project_whatsapp_live.md', text: FLAT_NOTE, registry })
    expect(res.skip).toBeFalsy()
    // "LIVE" in the description reads active → status, not episodic.
    expect(res.kind).toBe('status')
    expect(res.frontmatter.tags).toContain('messaging')
    const originalBody = FLAT_NOTE.slice(FLAT_NOTE.indexOf('---\n', 4) + 4)
    expect(res.body).toBe(originalBody)
  })

  it('Test 3: empty-body note is SKIPPED and listed, file untouched (SPEC edge: empty R2)', () => {
    const res = migrateNote({ file: 'feedback_placeholder.md', text: EMPTY_BODY_NOTE, registry })
    expect(res.skip).toBe(true)
    expect(res.reason).toMatch(/empty/i)
    expect(res.frontmatter).toBeUndefined()
  })

  it('Test 4: feedback with Why + How-to-apply → kind bug-lesson + a topic tag (D-49-15)', () => {
    const res = migrateNote({
      file: 'feedback_migration_rename_footgun.md',
      text: BUGLESSON_NOTE,
      registry,
    })
    expect(res.skip).toBeFalsy()
    expect(res.kind).toBe('bug-lesson')
    // The body markers survive so MEM-BUGLESSON (lint) stays clean.
    expect(res.body).toContain('**Why:**')
    expect(res.body).toContain('**How to apply:**')
    // A sensible area tag (migration/deploy keywords → payload or railway).
    expect(res.frontmatter.tags.some((t: string) => t === 'payload' || t === 'railway')).toBe(true)
  })

  it('Test 5: second run is idempotent — already-migrated note produces zero changes', () => {
    const dir = makeCorpus({ 'reference_railway_deploy_notes.md': NESTED_NOTE })
    try {
      const first = runMigration({ corpusDir: dir, write: true })
      expect(first.errors).toHaveLength(0)
      expect(first.changed).toContain('reference_railway_deploy_notes.md')
      const afterFirst = readFileSync(join(dir, 'reference_railway_deploy_notes.md'), 'utf8')
      // Second run: nothing changes on disk.
      const second = runMigration({ corpusDir: dir, write: true })
      expect(second.errors).toHaveLength(0)
      expect(second.changed).toHaveLength(0)
      const afterSecond = readFileSync(join(dir, 'reference_railway_deploy_notes.md'), 'utf8')
      expect(afterSecond).toBe(afterFirst)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Test 6: every emitted tag exists in TAGS.md (closed-vocab self-check)', () => {
    // validateTables returns [] when every KIND_MAP/AREA_KEYWORD_MAP target is registered.
    expect(validateTables(registry)).toEqual([])

    // And a real-corpus-style run assigns only registered tags.
    const dir = makeCorpus({
      'reference_railway_deploy_notes.md': NESTED_NOTE,
      'project_whatsapp_live.md': FLAT_NOTE,
      'feedback_migration_rename_footgun.md': BUGLESSON_NOTE,
    })
    try {
      const res = runMigration({ corpusDir: dir, write: false })
      expect(res.errors).toHaveLength(0)
      const known = new Set([...registry.area, ...registry.kind])
      for (const file of res.migrated) {
        const text = readFileSync(join(dir, file), 'utf8')
        const { frontmatter } = parseNote(text, { file })
        // (dry-run: disk unchanged, so re-derive from the migrateNote result instead)
        void frontmatter
      }
      // Re-derive via migrateNote to inspect assigned tags directly.
      for (const [name, text] of [
        ['reference_railway_deploy_notes.md', NESTED_NOTE],
        ['project_whatsapp_live.md', FLAT_NOTE],
        ['feedback_migration_rename_footgun.md', BUGLESSON_NOTE],
      ] as const) {
        const m = migrateNote({ file: name, text, registry })
        for (const t of m.frontmatter.tags) {
          expect(known.has(t)).toBe(true)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
