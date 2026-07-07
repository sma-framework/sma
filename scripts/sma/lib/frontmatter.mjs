/**
 * frontmatter.mjs — the single shared read/write path for all ~205 memory notes.
 *
 * DELIBERATELY NARROW (RESEARCH §Don't Hand-Roll; CONTEXT Claude's-Discretion):
 * NO third-party YAML/frontmatter library, NO new npm deps (founder-locked). Corpus
 * is bimodal (RESEARCH §Summary finding 3): 137 files carry a nested one-level
 * `metadata:` block (sub-keys node_type/type/originSessionId); 66 files are flat
 * `type:` scalars; 2 structural files (MEMORY.md, ARCHIVE.md) have NO frontmatter.
 * This parser handles EXACTLY those shapes and throws LOUDLY (B12) on anything
 * else — never guesses, so a later migration (49-11) cannot silently corrupt a note.
 *
 * Exports (shared by lint 49-08, generator/loader 49-09, migration 49-11):
 *   - parseNote(text, {file})   -> {frontmatter|null, body}
 *   - serializeNote({frontmatter, body}) -> normalized note text (fixed key order)
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
  'use-when-pattern', // 49.1-10 (B2): optional precision glob narrowing where a reflex fires
  'reflex', // 49.1-10 (B2): per-note reflex opt-out ('off' — fatigue control 6)
  'importance',
  'supersedes',
  'superseded_by',
  'superseded_at',
  'predicted_from', // 49.1-09 (B19): back-link from a drafted bug-lesson to <planId>-<predId>
  'valid_from', // 49.1-12 (B5): bi-temporal — when a decision/status claim became true
  'valid_until', // 49.1-12 (B5): bi-temporal — when it stopped being true (supersession fix path)
]

/**
 * parseNote(text, {file}) — split a note into {frontmatter, body}.
 *
 * Recognizes a leading `---` fence. Inside it supports ONLY:
 *   - flat `key: value` scalars,
 *   - a `tags:` value as an inline array `[a, b]` or a 2-space dash-list,
 *   - ONE nested one-level block (`metadata:` with 2-space-indented scalar sub-keys).
 * Anything else (top-level YAML list, multi-doc `---` marker inside, unknown
 * nested structure) throws with file+line context (B12).
 *
 * @param {string} text
 * @param {{file?:string}} [opts]
 * @returns {{frontmatter: object|null, body: string}}
 */
export function parseNote(text, opts = {}) {
  const file = opts.file ?? '<unknown>'

  // No leading fence -> structural file (MEMORY.md / ARCHIVE.md). Caller skips.
  if (!text.startsWith('---\n') && text !== '---') {
    return { frontmatter: null, body: text }
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

  const frontmatter = parseFrontmatterBlock(fmBlock, file)
  return { frontmatter, body }
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

    // The ONE nested block we support: `metadata:` with 2-space scalar sub-keys.
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
        nested[sm[1]] = unquote(sm[2])
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

/** parseInlineArray("[a, b]") -> ['a','b']; loud error if not a bracketed list. */
function parseInlineArray(s, file, fileLine) {
  const t = s.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) {
    throw new Error(
      `frontmatter parse error in ${file} line ${fileLine}: tags value "${s}" is not an inline [a, b] array`,
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
 * serializeNote({frontmatter, body}) — emit the NORMALIZED note text.
 *
 * Keys are written in NORMALIZED_KEY_ORDER (deterministic — load-bearing for R3
 * byte-identity). Absent or null optional keys are omitted. `tags` is emitted in
 * inline `tags: [a, b]` form. LF line endings, no BOM. Body appended verbatim.
 *
 * @param {{frontmatter: object|null, body: string}} note
 * @returns {string}
 */
export function serializeNote(note) {
  const { frontmatter, body } = note
  if (frontmatter == null) return body

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
 * @param {string} tagsPath
 * @returns {{area:Set<string>, kind:Set<string>, aliases:Map<string,string>}}
 */
export function loadTagsRegistry(tagsPath) {
  const text = readFileSync(tagsPath, 'utf8')
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
 * (membership validation is lint's job in 49-08, not the parser's).
 *
 * @param {string} tag
 * @param {{aliases:Map<string,string>}} registry
 * @returns {string}
 */
export function resolveAlias(tag, registry) {
  return registry.aliases.get(tag) ?? tag
}
