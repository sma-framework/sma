/**
 * frontmatter.mjs — the single shared read/write path for all ~205 memory notes.
 *
 * DELIBERATELY NARROW (RESEARCH §Don't Hand-Roll; CONTEXT Claude's-Discretion):
 * NO third-party YAML/frontmatter library, NO new npm deps (founder-locked). Corpus
 * is bimodal (RESEARCH §Summary finding 3): 137 files carry a nested one-level
 * `metadata:` block (sub-keys node_type/type/originSessionId); 66 files are flat
 * `type:` scalars; 2 structural files (MEMORY.md, ARCHIVE.md) have NO frontmatter.
 * This parser handles EXACTLY those shapes and throws LOUDLY (B12) on anything
 * else — never guesses, so a later migration (9-11) cannot silently corrupt a note.
 *
 * SCHEMA v2 (docs/MEMORY-MODEL.md) rides on the SAME read/write path behind a
 * `schema_version` discriminator that is read FIRST, before any other grammar
 * decision. The key ABSENT means v1, unconditionally — the v1 grammar below is
 * untouched, so 100% of the existing corpus keeps parsing and re-serializing
 * byte-identically. `schema_version: 2` selects the v2 grammar, which adds
 * exactly two shapes on top of the flat scalars and inline arrays:
 *   - labeled nested blocks with 2-space scalar / inline-array / 4-space
 *     dash-list sub-keys: scope, source, fingerprint, retrieval, verification;
 *   - labeled arrays-of-objects (`  - key: value` + `    key: value` lines):
 *     evidence, links.
 * Any other schema_version value, any unknown block label, and any deeper
 * nesting throw with file+line context. The v2 branch is GRAMMAR-ONLY: it
 * decides SHAPE, never enum or field legality (that is schema-v2.mjs's job) —
 * and it must never import schema-v2.mjs (no cycles).
 *
 * Exports (shared by lint 9-08, generator/loader 9-09, migration 9-11):
 *   - parseNote(text, {file})   -> {frontmatter|null, body, schemaVersion}
 *   - serializeNote({frontmatter, body, schemaVersion}) -> normalized note text
 *   - V2_KEY_ORDER — the fixed schema-v2 top-level emit order (serialization law)
 *   - loadTagsRegistry(tagsPath) -> {area:Set, kind:Set, aliases:Map}
 *   - resolveAlias(tag, registry) -> canonical tag (UF->USE, B2)
 *
 * Node built-ins only; the module is PURE except loadTagsRegistry (the one read).
 */

import { readFileSync } from 'node:fs'

/** The normalized target schema, in the FIXED emit order R3 byte-identity depends on. */
const NORMALIZED_KEY_ORDER = [
  'description',
  'kind',
  'tags',
  'use-when',
  'use-when-pattern', // optional precision glob narrowing where a reflex fires
  'reflex', // per-note reflex opt-out ('off' — fatigue control 6)
  'importance',
  'supersedes',
  'superseded_by',
  'superseded_at',
  'predicted_from', // back-link from a drafted bug-lesson to <planId>-<predId>
  'excavated_from', // provenance back-link from an excavated bug-lesson to <repoLabel>@<sha7>
  'valid_from', // bi-temporal — when a decision/status claim became true
  'valid_until', // bi-temporal — when it stopped being true (supersession fix path)
]

/**
 * The FIXED schema-v2 top-level emit order (docs/MEMORY-MODEL.md). Like
 * NORMALIZED_KEY_ORDER for v1, this order is load-bearing for R3 byte-identity:
 * a v2 record written in this order re-serializes to the exact same bytes.
 */
export const V2_KEY_ORDER = [
  'id',
  'schema_version',
  'status',
  'migrated_from',
  'memory_type',
  'truth_mode',
  'claim',
  'language',
  'scope',
  'applies_to',
  'source',
  'evidence',
  'fingerprint',
  'observed_at',
  'recorded_at',
  'valid_from',
  'valid_until',
  'criticality',
  'frequency',
  'confidence',
  'freshness',
  'context_priority',
  'risk',
  'sensitivity',
  'retention',
  'retrieval',
  'verification',
  'links',
  'derived_from',
  'supersedes',
  'superseded_by',
  'superseded_at',
]

/** v2 labels whose value is a one-level block of scalar / array sub-keys. */
const V2_NESTED_BLOCKS = new Set(['scope', 'source', 'fingerprint', 'retrieval', 'verification'])

/** v2 labels whose value is an array of one-level objects (`- key: value` items). */
const V2_ARRAY_BLOCKS = new Set(['evidence', 'links'])

/**
 * parseNote(text, {file}) — split a note into {frontmatter, body, schemaVersion}.
 *
 * Recognizes a leading `---` fence. `schema_version` inside the fence is read
 * FIRST and picks the grammar; the key's ABSENCE means v1, unconditionally.
 *
 * v1 (unchanged) supports ONLY:
 *   - flat `key: value` scalars,
 *   - a `tags:` value as an inline array `[a, b]` or a 2-space dash-list,
 *   - ONE nested one-level block (`metadata:` with 2-space-indented scalar sub-keys).
 * v2 additionally supports the labeled nested blocks and arrays-of-objects
 * listed in the module header.
 *
 * Anything else (top-level YAML list, multi-doc `---` marker inside, unknown
 * nested structure, unknown schema_version) throws with file+line context (B12).
 *
 * @param {string} text
 * @param {{file?:string}} [opts]
 * @returns {{frontmatter: object|null, body: string, schemaVersion: 1|2}}
 */
export function parseNote(text, opts = {}) {
  const file = opts.file ?? '<unknown>'

  // No leading fence -> structural file (MEMORY.md / ARCHIVE.md). Caller skips.
  if (!text.startsWith('---\n') && text !== '---') {
    return { frontmatter: null, body: text, schemaVersion: 1 }
  }

  // Find the closing fence. The opening `---\n` is 4 chars; search from there.
  const closeIdx = text.indexOf('\n---\n', 3)
  if (closeIdx === -1) {
    throw new Error(
      `frontmatter parse error in ${file}: opening --- fence at line 1 has no closing --- fence`,
    )
  }

  const fmBlock = text.slice(4, closeIdx + 1) // between the fences, incl trailing \n
  const body = text.slice(closeIdx + 5) // after `\n---\n`

  // The discriminator is read BEFORE any other grammar decision — a v1 note can
  // never fall into the v2 branch and vice versa (no grammar bleed).
  const schemaVersion = detectSchemaVersion(fmBlock, file)
  const frontmatter =
    schemaVersion === 2 ? parseV2Block(fmBlock, file) : parseFrontmatterBlock(fmBlock, file)
  return { frontmatter, body, schemaVersion }
}

/**
 * detectSchemaVersion — read the top-level `schema_version:` line, if any.
 * Absent -> 1 (today's grammar). `2` -> the v2 grammar. Anything else throws:
 * a note from a future schema is NOT guessed at (B12).
 */
function detectSchemaVersion(block, file) {
  const m = /^schema_version:[ \t]*(.*)$/m.exec(block)
  if (!m) return 1
  const raw = unquote(m[1])
  if (raw === '2') return 2
  throw new Error(
    `frontmatter parse error in ${file}: unsupported schema_version "${raw}" — this parser reads schema v1 (no schema_version key) and schema v2 only, and refuses to guess`,
  )
}

/**
 * parseFrontmatterBlock — line-oriented parse of the two supported shapes.
 * `lineBase` maps block-relative line numbers to file line numbers (fence = line 1).
 */
function parseFrontmatterBlock(block, file) {
  const lines = block.replace(/\n$/, '').split('\n')
  const out = {}
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const fileLine = i + 2 // +1 for the opening fence, +1 for 1-based

    if (raw.trim() === '') {
      i++
      continue
    }

    // A top-level YAML list marker is NOT one of the two shapes.
    if (/^\s*-\s/.test(raw) && !/^  /.test(raw)) {
      throw new Error(
        `frontmatter parse error in ${file} line ${fileLine}: top-level YAML list is not a supported shape (expected flat key: value or a metadata: block)`,
      )
    }

    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(raw)
    if (!m) {
      throw new Error(
        `frontmatter parse error in ${file} line ${fileLine}: unrecognized line "${raw}" (expected key: value)`,
      )
    }

    const key = m[1]
    const rest = m[2]

    // The ONE nested block we support: `metadata:` with 2-space scalar sub-keys,
    // plus a 4-space dash-list value under a sub-key (`  tags:` followed by
    // `    - item` lines) — the block-sequence shape the auto-memory hook emits for
    // tags. Any other nested structure throws loudly (B12).
    if (key === 'metadata' && rest.trim() === '') {
      const nested = {}
      i++
      while (i < lines.length && /^  \S/.test(lines[i])) {
        const subLine = lines[i]
        const subFileLine = i + 2
        const sm = /^  ([A-Za-z][\w-]*):\s?(.*)$/.exec(subLine)
        if (!sm) {
          throw new Error(
            `frontmatter parse error in ${file} line ${subFileLine}: unsupported nested structure under metadata: "${subLine}" (only 2-space scalar sub-keys are supported)`,
          )
        }
        const subKey = sm[1]
        const subRest = sm[2]
        // A 4-space dash-list value under a sub-key → collect `    - item` lines.
        if (subRest.trim() === '' && i + 1 < lines.length && /^    -\s/.test(lines[i + 1])) {
          const arr = []
          i++
          while (i < lines.length && /^    -\s/.test(lines[i])) {
            arr.push(unquote(lines[i].replace(/^    -\s+/, '').trim()))
            i++
          }
          nested[subKey] = arr
          continue
        }
        nested[subKey] = unquote(subRest)
        i++
      }
      out.metadata = nested
      continue
    }

    // `tags:` — inline array, or a following 2-space dash-list.
    if (key === 'tags') {
      if (rest.trim() !== '') {
        out.tags = parseInlineArray(rest, file, fileLine)
        i++
        continue
      }
      const arr = []
      i++
      while (i < lines.length && /^  -\s/.test(lines[i])) {
        arr.push(unquote(lines[i].replace(/^  -\s+/, '').trim()))
        i++
      }
      out.tags = arr
      continue
    }

    // Any other key must be a flat scalar. An empty value that ISN'T metadata/tags
    // would begin an unsupported nested block -> loud error.
    if (rest.trim() === '' && i + 1 < lines.length && /^  /.test(lines[i + 1])) {
      throw new Error(
        `frontmatter parse error in ${file} line ${fileLine}: nested block under "${key}:" is not supported (only metadata: may nest)`,
      )
    }

    out[key] = unquote(rest)
    i++
  }

  return out
}

/**
 * parseV2Block — line-oriented parse of the schema-v2 grammar.
 *
 * Top level: flat scalars, inline `[a, b]` arrays, an empty value (-> null), the
 * five nested blocks and the two arrays-of-objects. Every other shape throws
 * with file+line context — the v2 branch guesses exactly as little as the v1 one.
 */
function parseV2Block(block, file) {
  const lines = block.replace(/\n$/, '').split('\n')
  const out = {}
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const fileLine = i + 2 // +1 for the opening fence, +1 for 1-based

    if (raw.trim() === '') {
      i++
      continue
    }

    if (/^\s*-\s/.test(raw) && !/^ /.test(raw)) {
      throw new Error(
        `frontmatter parse error in ${file} line ${fileLine}: top-level YAML list is not a supported schema-v2 shape (expected key: value or a labeled block)`,
      )
    }

    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(raw)
    if (!m) {
      throw new Error(
        `frontmatter parse error in ${file} line ${fileLine}: unrecognized line "${raw}" (expected key: value)`,
      )
    }

    const key = m[1]
    const rest = m[2]

    if (rest.trim() === '') {
      const next = i + 1 < lines.length ? lines[i + 1] : null
      const opensBlock = next != null && /^\s+\S/.test(next)
      if (!opensBlock) {
        // An empty scalar (e.g. an open-ended `valid_until:`) is null, and the
        // omit-null law drops it on the way out.
        out[key] = null
        i++
        continue
      }
      if (V2_NESTED_BLOCKS.has(key)) {
        const r = parseV2NestedBlock(lines, i + 1, file, key)
        out[key] = r.value
        i = r.next
        continue
      }
      if (V2_ARRAY_BLOCKS.has(key)) {
        const r = parseV2ObjectArray(lines, i + 1, file, key)
        out[key] = r.value
        i = r.next
        continue
      }
      throw new Error(
        `frontmatter parse error in ${file} line ${fileLine}: nested block under "${key}:" is not a supported schema-v2 shape (blocks: ${[...V2_NESTED_BLOCKS].join(', ')}; arrays of objects: ${[...V2_ARRAY_BLOCKS].join(', ')})`,
      )
    }

    out[key] = parseV2Leaf(rest, file, fileLine, key)
    i++
  }

  return out
}

/**
 * parseV2NestedBlock — the `metadata:` sub-walk generalized to a labeled v2
 * block: 2-space `key: value` scalars, inline `[a, b]` arrays, and the 4-space
 * dash-list form. A block inside a block throws (v2 nests exactly one level).
 */
function parseV2NestedBlock(lines, start, file, label) {
  const nested = {}
  let i = start

  while (i < lines.length && /^  \S/.test(lines[i])) {
    const subLine = lines[i]
    const subFileLine = i + 2
    const sm = /^  ([A-Za-z][\w-]*):\s?(.*)$/.exec(subLine)
    if (!sm) {
      throw new Error(
        `frontmatter parse error in ${file} line ${subFileLine}: unsupported structure under "${label}:" — "${subLine}" (only 2-space key: value sub-keys are supported)`,
      )
    }
    const subKey = sm[1]
    const subRest = sm[2]

    if (subRest.trim() === '') {
      const next = i + 1 < lines.length ? lines[i + 1] : null
      if (next != null && /^ {4}-\s/.test(next)) {
        const arr = []
        i++
        while (i < lines.length && /^ {4}-\s/.test(lines[i])) {
          arr.push(unquote(lines[i].replace(/^ {4}-\s+/, '').trim()))
          i++
        }
        nested[subKey] = arr
        continue
      }
      if (next != null && /^ {4,}\S/.test(next)) {
        throw new Error(
          `frontmatter parse error in ${file} line ${subFileLine + 1}: a nested block inside "${label}.${subKey}" is not supported (schema v2 nests exactly one level)`,
        )
      }
      nested[subKey] = null
      i++
      continue
    }

    nested[subKey] = parseV2Leaf(subRest, file, subFileLine, `${label}.${subKey}`)
    i++
  }

  if (Object.keys(nested).length === 0) {
    throw new Error(
      `frontmatter parse error in ${file} line ${start + 2}: unsupported structure under "${label}:" — "${lines[start]}" (expected 2-space key: value sub-keys)`,
    )
  }
  return { value: nested, next: i }
}

/**
 * parseV2ObjectArray — a labeled array of one-level objects:
 *   evidence:
 *     - type: test
 *       ref: test:checkout-retry-idempotency
 * A `  - ` line opens an item; `    key: value` lines extend it. Anything else
 * indented under the label throws.
 */
function parseV2ObjectArray(lines, start, file, label) {
  const arr = []
  let current = null
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    const fileLine = i + 2

    const item = /^ {2}- ([A-Za-z][\w-]*):\s?(.*)$/.exec(line)
    if (item) {
      current = { [item[1]]: parseV2Leaf(item[2], file, fileLine, `${label}[].${item[1]}`) }
      arr.push(current)
      i++
      continue
    }

    const cont = current && /^ {4}([A-Za-z][\w-]*):\s?(.*)$/.exec(line)
    if (cont) {
      current[cont[1]] = parseV2Leaf(cont[2], file, fileLine, `${label}[].${cont[1]}`)
      i++
      continue
    }

    if (/^\s+\S/.test(line)) {
      throw new Error(
        `frontmatter parse error in ${file} line ${fileLine}: unsupported item under "${label}:" — "${line}" (expected "  - key: value" followed by "    key: value" lines)`,
      )
    }
    break
  }

  if (arr.length === 0) {
    throw new Error(
      `frontmatter parse error in ${file} line ${start + 2}: "${label}:" opens an array of objects but no "  - key: value" item follows`,
    )
  }
  return { value: arr, next: i }
}

/** A v2 leaf value: an empty scalar is null, `[a, b]` is an array, else a scalar. */
function parseV2Leaf(rest, file, fileLine, label) {
  const t = rest.trim()
  if (t === '') return null
  if (t.startsWith('[')) return parseInlineArray(t, file, fileLine, label)
  return unquote(rest)
}

/** parseInlineArray("[a, b]") -> ['a','b']; loud error if not a bracketed list. */
function parseInlineArray(s, file, fileLine, label = 'tags') {
  const t = s.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) {
    throw new Error(
      `frontmatter parse error in ${file} line ${fileLine}: ${label} value "${s}" is not an inline [a, b] array`,
    )
  }
  const inner = t.slice(1, -1).trim()
  if (inner === '') return []
  return inner.split(',').map((x) => unquote(x.trim()))
}

/** Strip one layer of surrounding single/double quotes if present. */
function unquote(v) {
  const t = v.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * serializeNote({frontmatter, body, schemaVersion}) — emit the NORMALIZED text.
 *
 * v1 (the default whenever no schema_version is in play): keys are written in
 * NORMALIZED_KEY_ORDER (deterministic — load-bearing for R3 byte-identity).
 * v2: keys are written in V2_KEY_ORDER with the blocks re-emitted in their
 * parsed sub-key order. In both grammars absent or null optional keys are
 * omitted, arrays are inline `[a, b]`, endings are LF, there is no BOM, and the
 * body is appended verbatim.
 *
 * @param {{frontmatter: object|null, body: string, schemaVersion?: 1|2}} note
 * @returns {string}
 */
export function serializeNote(note) {
  const { frontmatter, body } = note
  if (frontmatter == null) return body
  if (resolveSchemaVersion(note) === 2) return serializeV2(frontmatter, body)

  const lines = ['---']
  for (const key of NORMALIZED_KEY_ORDER) {
    if (!(key in frontmatter)) continue
    const val = frontmatter[key]
    if (val == null) continue // omit null optional keys
    if (key === 'tags') {
      const arr = Array.isArray(val) ? val : [val]
      lines.push(`tags: [${arr.join(', ')}]`)
    } else {
      lines.push(`${key}: ${serializeScalar(val)}`)
    }
  }
  lines.push('---')
  return lines.join('\n') + '\n' + (body ?? '')
}

/**
 * resolveSchemaVersion — which grammar serializeNote must emit. An explicit
 * `schemaVersion` on the note wins (that is what parseNote hands back); failing
 * that, the frontmatter's own `schema_version` decides; failing that, v1. An
 * unknown value throws rather than silently writing a note in the wrong grammar.
 */
function resolveSchemaVersion(note) {
  if (note.schemaVersion != null) {
    if (note.schemaVersion === 1 || note.schemaVersion === 2) return note.schemaVersion
    throw new Error(
      `serializeNote: unsupported schemaVersion "${note.schemaVersion}" (only 1 and 2 exist)`,
    )
  }
  const raw = note.frontmatter?.schema_version
  if (raw == null) return 1
  const v = String(raw).trim()
  if (v === '2') return 2
  throw new Error(
    `serializeNote: unsupported schema_version "${v}" (only 1 — the key absent — and 2 exist)`,
  )
}

/**
 * serializeV2 — emit a schema-v2 record in V2_KEY_ORDER.
 *
 * Keys outside V2_KEY_ORDER are NOT dropped (silent data loss is the failure
 * this module exists to prevent): they are emitted after the known keys in
 * sorted order, which keeps the output deterministic. A block whose every
 * sub-value is null is omitted entirely rather than left as a dangling label.
 */
function serializeV2(frontmatter, body) {
  const lines = ['---']
  const emitted = new Set()

  for (const key of V2_KEY_ORDER) {
    emitted.add(key)
    if (!(key in frontmatter)) continue
    emitV2Key(lines, key, frontmatter[key])
  }
  for (const key of Object.keys(frontmatter).sort()) {
    if (emitted.has(key)) continue
    emitV2Key(lines, key, frontmatter[key])
  }

  lines.push('---')
  return lines.join('\n') + '\n' + (body ?? '')
}

/** Emit one v2 top-level key: an array-of-objects block, a nested block, or a leaf. */
function emitV2Key(lines, key, val) {
  if (val == null) return // omit null optional keys

  if (V2_ARRAY_BLOCKS.has(key)) {
    if (!Array.isArray(val)) {
      throw new Error(`serializeNote: schema-v2 "${key}" must be an array of objects`)
    }
    const items = val.filter((item) => item != null)
    if (items.length === 0) return
    lines.push(`${key}:`)
    for (const item of items) {
      if (typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`serializeNote: schema-v2 "${key}" items must be objects`)
      }
      const entries = Object.entries(item).filter(([, v]) => v != null)
      if (entries.length === 0) {
        throw new Error(`serializeNote: schema-v2 "${key}" carries an item with no values`)
      }
      entries.forEach(([k, v], idx) => {
        lines.push(`${idx === 0 ? '  - ' : '    '}${k}: ${serializeV2Leaf(v)}`)
      })
    }
    return
  }

  if (V2_NESTED_BLOCKS.has(key)) {
    if (typeof val !== 'object' || Array.isArray(val)) {
      throw new Error(`serializeNote: schema-v2 "${key}" must be a block of sub-keys`)
    }
    const entries = Object.entries(val).filter(([, v]) => v != null)
    if (entries.length === 0) return
    lines.push(`${key}:`)
    for (const [k, v] of entries) lines.push(`  ${k}: ${serializeV2Leaf(v)}`)
    return
  }

  lines.push(`${key}: ${serializeV2Leaf(val)}`)
}

/** A v2 leaf: an array is inline `[a, b]`, everything else goes through serializeScalar. */
function serializeV2Leaf(v) {
  if (Array.isArray(v)) return `[${v.map((x) => String(x)).join(', ')}]`
  return serializeScalar(v)
}

/** Quote a scalar only when it would otherwise be ambiguous (contains a colon-space or leading special char). */
function serializeScalar(v) {
  const s = String(v)
  if (s === '') return '""'
  if (/[:#]\s/.test(s) || /^[-?*&!|>%@`"'\[\]{}]/.test(s) || /:\s/.test(s)) {
    return JSON.stringify(s)
  }
  return s
}

/**
 * loadTagsRegistry(tagsPath) — parse TAGS.md's strict line grammar into facets.
 *
 * Headings `## area` / `## kind` / `## phase` open a facet; lines of the form
 * `- <tag> — <desc> · aliases: <a>, <b>` register the canonical tag under the
 * current facet and map each alias -> canonical (B2 USE/UF). The `phase` facet is
 * open-form (documented, no enumerated tags) so its bullet-less prose is ignored.
 *
 * A corpus WITHOUT a TAGS.md is a valid degraded state (pre-onboarding install,
 * mid-migration adoption): every consumer of the single shared read path used to
 * crash on the missing file. Instead, an absent registry returns empty facets
 * plus `missing: true` so a consumer can report it ONCE (lint MEM-VOCAB) or
 * degrade gracefully (generator's `misc` bucket) — same fail-soft posture as the
 * rest of the read path. Any error other than ENOENT still throws loudly (B12).
 *
 * @param {string} tagsPath
 * @returns {{area:Set<string>, kind:Set<string>, aliases:Map<string,string>, missing?:true}}
 */
export function loadTagsRegistry(tagsPath) {
  let text
  try {
    text = readFileSync(tagsPath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { area: new Set(), kind: new Set(), aliases: new Map(), missing: true }
    }
    throw err
  }
  const area = new Set()
  const kind = new Set()
  const aliases = new Map()

  let facet = null
  for (const line of text.split('\n')) {
    const h = /^##\s+(\S+)/.exec(line)
    if (h) {
      facet = h[1] // 'area' | 'kind' | 'phase'
      continue
    }
    if (!facet || facet === 'phase') continue

    const m = /^- ([^\s—]+)\s+—\s+(.*)$/.exec(line)
    if (!m) continue // header prose / blank lines

    const tag = m[1]
    const target = facet === 'area' ? area : facet === 'kind' ? kind : null
    if (!target) continue
    target.add(tag)

    const aliasMatch = /·\s*aliases:\s*(.+)$/.exec(m[2])
    if (aliasMatch) {
      for (const a of aliasMatch[1].split(',')) {
        const alias = a.trim()
        if (alias) aliases.set(alias, tag)
      }
    }
  }

  return { area, kind, aliases }
}

/**
 * resolveAlias(tag, registry) — map a UF alias to its canonical USE tag (B2).
 * A canonical tag resolves to itself; an unknown tag is returned unchanged
 * (membership validation is lint's job in 9-08, not the parser's).
 *
 * @param {string} tag
 * @param {{aliases:Map<string,string>}} registry
 * @returns {string}
 */
export function resolveAlias(tag, registry) {
  return registry.aliases.get(tag) ?? tag
}
