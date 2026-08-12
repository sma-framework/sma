/**
 * Tests for the CRLF law of scripts/sma/lib/frontmatter.mjs.
 *
 * frontmatter.mjs is the single shared read path for every memory note, and every
 * grammar decision in it reads LF: the `---\n` fence probe, the `split('\n')` line
 * walks, and the `$`-anchored key/bullet regexes (in JS `.` does NOT match `\r`, so
 * a trailing `\r` makes an unanchored `(.*)$` miss outright).
 *
 * On a Windows checkout with core.autocrlf=true — the founder's own machine — every
 * .md file in the tree arrives with `\r\n`. Both entry points then failed SILENTLY,
 * which is the one failure shape this module's loud-throw posture exists to prevent:
 *   - parseNote     — the fence probe missed, so a real note came back as
 *                     `frontmatter: null` (a "structural file"), dropping its
 *                     description / kind / tags / importance out of the memory layer
 *                     with no error at all;
 *   - loadTagsRegistry — every `- tag — desc` bullet missed, so the registry came
 *                     back EMPTY, and lint then called every tag in the corpus
 *                     unregistered.
 *
 * The law under test: `\r\n` is a transport artifact of the checkout, never content.
 * A CRLF note is the SAME note as its LF twin — same frontmatter object, same
 * schemaVersion — and serialization stays LF-only either way.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { parseNote, serializeNote, loadTagsRegistry, resolveAlias } from '../lib/frontmatter.mjs'

const V1_NOTE = `---
description: A reference note used to prove the CRLF read path.
kind: reference
tags: [tech, reference]
use-when: reading a note that a Windows checkout handed over with CRLF
importance: 7
---

# A note

Its body carries two lines.
`

const V2_NOTE = `---
id: mem-crlf-001
schema_version: 2
status: active
memory_type: procedural
claim: A CRLF note is the same note as its LF twin.
scope:
  repo: sma
  paths: [scripts/sma/lib]
evidence:
  - type: test
    ref: test:frontmatter-crlf
---

# v2 body
`

const TAGS_MD = `# TAGS

## area

- tech — infrastructure, build, deploy. · aliases: technical, infra
- workflow — process: planning, execution, verification.

## kind

- reference — a lookup: addresses, versions, tables of fact.
`

/** The same text a Windows checkout would hand over. */
const crlf = (s: string) => s.replace(/\n/g, '\r\n')

describe('parseNote reads a CRLF note as the same note as its LF twin', () => {
  it('v1: CRLF frontmatter is parsed, not misread as a structural file', () => {
    const lf = parseNote(V1_NOTE, { file: 'note.md' })
    const cr = parseNote(crlf(V1_NOTE), { file: 'note.md' })

    // The regression itself: this used to be null, silently losing the record.
    expect(cr.frontmatter).not.toBeNull()
    expect(cr.frontmatter).toEqual(lf.frontmatter)
    expect(cr.frontmatter!.tags).toEqual(['tech', 'reference'])
    expect(cr.frontmatter!.importance).toBe('7')
    expect(cr.schemaVersion).toBe(1)
  })

  it('v1: the body comes back LF, and no stray \\r survives in any value', () => {
    const cr = parseNote(crlf(V1_NOTE), { file: 'note.md' })
    expect(cr.body).not.toContain('\r')
    for (const v of Object.values(cr.frontmatter!)) {
      for (const s of Array.isArray(v) ? v : [v]) expect(String(s)).not.toContain('\r')
    }
  })

  it('v2: the schema_version discriminator and both block shapes survive CRLF', () => {
    const lf = parseNote(V2_NOTE, { file: 'v2.md' })
    const cr = parseNote(crlf(V2_NOTE), { file: 'v2.md' })

    expect(cr.schemaVersion).toBe(2)
    expect(cr.frontmatter).toEqual(lf.frontmatter)
    expect(cr.frontmatter!.scope).toEqual({ repo: 'sma', paths: ['scripts/sma/lib'] })
    expect(cr.frontmatter!.evidence).toEqual([{ type: 'test', ref: 'test:frontmatter-crlf' }])
  })

  it('serialization stays LF-only, so a CRLF note round-trips to its LF twin', () => {
    for (const note of [V1_NOTE, V2_NOTE]) {
      const out = serializeNote(parseNote(crlf(note), { file: 'n.md' }))
      expect(out).not.toContain('\r')
      expect(out).toBe(serializeNote(parseNote(note, { file: 'n.md' })))
    }
  })

  it('a structural file (no fence) still comes back frontmatter: null', () => {
    const res = parseNote(crlf('# MEMORY\n\n- [a](a.md) — hook\n'), { file: 'MEMORY.md' })
    expect(res.frontmatter).toBeNull()
    expect(res.body).not.toContain('\r')
  })
})

describe('loadTagsRegistry reads a CRLF TAGS.md instead of returning an empty vocabulary', () => {
  function registryFor(text: string) {
    const dir = mkdtempSync(join(tmpdir(), 'sma-crlf-tags-'))
    const path = join(dir, 'TAGS.md')
    writeFileSync(path, text)
    return loadTagsRegistry(path)
  }

  it('registers every facet bullet, exactly as it does from LF', () => {
    const cr = registryFor(crlf(TAGS_MD))

    // The regression itself: these three sets used to come back EMPTY, with no error.
    expect([...cr.area].sort()).toEqual(['tech', 'workflow'])
    expect([...cr.kind]).toEqual(['reference'])
    expect(cr.missing).toBeUndefined()

    const lf = registryFor(TAGS_MD)
    expect([...cr.area].sort()).toEqual([...lf.area].sort())
    expect([...cr.kind].sort()).toEqual([...lf.kind].sort())
  })

  it('keeps the UF -> USE alias map working across CRLF', () => {
    const cr = registryFor(crlf(TAGS_MD))
    expect(resolveAlias('infra', cr)).toBe('tech')
    expect(resolveAlias('technical', cr)).toBe('tech')
    expect(resolveAlias('tech', cr)).toBe('tech')
    expect(resolveAlias('unknown-tag', cr)).toBe('unknown-tag')
  })
})
