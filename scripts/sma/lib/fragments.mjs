/**
 * fragments.mjs — atomic knowledge facts with triggers (49.3-05, D-49.3-07).
 *
 * A fragment is ONE fact: an individual .md file under `<corpusDir>/fragments/` — a
 * SUBDIRECTORY precisely so the V2 note pipeline (readNotes / build-index / MEMORY.md
 * regen) never sees it (its file listers are non-recursive). Frontmatter is parsed by
 * frontmatter.mjs parseNote (NO new YAML): required `id` (filename stem must equal id)
 * and `trigger`; optional `tags` + `source` (the note/incident it was distilled from);
 * the body is the fact, capped at FRAGMENT_BUDGET (400 UTF-8 bytes) — small enough that
 * a citation on it means THE fact was useful, so the shipped V2 citation journal now
 * scores facts, not 8 KB notes.
 *
 * Triggers bring the fact AT the act: `path:<glob>` (Edit/Write file), `cmd:<substring>`
 * (Bash command), `tag:<tag>` (derived facet). Delivery reuses the reflex fatigue posture
 * (once per session, via the SHARED seen-store under a 'frag:' namespace) and cites each
 * delivered fact through recordCitation kind 'fire' — the SAME usage journal notes ride
 * (D-49.3-02: consumed, never re-implemented).
 *
 * Node built-ins only; everything DI; no child_process anywhere; zero network; zero LLM.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

import { parseNote, resolveAlias } from './frontmatter.mjs'
import { FRAGMENT_BUDGET } from './constants.mjs'

/** At most this many fragments delivered per Edit/Write/Bash event (fatigue cap 1). */
export const DELIVER_CAP = 2

// ─────────────────────────── parse + validate ───────────────────────────────

/**
 * parseFragment(text, {file}) → {id, trigger, tags, source, body, file, parseError?}.
 * Tolerant: an unparseable/absent frontmatter returns a record with parseError set +
 * null id/trigger (validateFragment renders that as FRAG-SCHEMA). Body is trimmed.
 */
export function parseFragment(text, opts = {}) {
  const file = opts.file ?? '<unknown>'
  let frontmatter = null
  let body = ''
  try {
    const parsed = parseNote(String(text ?? ''), { file })
    frontmatter = parsed.frontmatter
    body = parsed.body ?? ''
  } catch (err) {
    return { id: null, trigger: null, tags: [], source: null, body: '', file, parseError: err && err.message }
  }
  if (frontmatter == null) {
    return { id: null, trigger: null, tags: [], source: null, body: String(body).trim(), file, parseError: 'no frontmatter' }
  }
  return {
    id: typeof frontmatter.id === 'string' ? frontmatter.id.trim() : null,
    trigger: typeof frontmatter.trigger === 'string' ? frontmatter.trigger.trim() : null,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    source: frontmatter.source ?? null,
    body: String(body).trim(),
    file,
  }
}

/**
 * validateFragment(frag) → [{file, rule, detail}]. The SAME record shape lint renders.
 * Rules:
 *   - FRAG-SCHEMA : missing frontmatter/id, or id !== filename stem.
 *   - FRAG-BYTES  : body over FRAGMENT_BUDGET UTF-8 bytes.
 *   - FRAG-TRIGGER: missing or unparseable trigger.
 * Each violation names the file.
 */
export function validateFragment(frag) {
  const out = []
  const file = frag && frag.file ? frag.file : '<unknown>'

  if (!frag || frag.parseError || !frag.id) {
    out.push({ file, rule: 'FRAG-SCHEMA', detail: `fragment ${file} has no parseable frontmatter with an id${frag && frag.parseError ? ` (${frag.parseError})` : ''}` })
  } else {
    const stem = basename(file).replace(/\.md$/i, '')
    if (stem && frag.id !== stem) {
      out.push({ file, rule: 'FRAG-SCHEMA', detail: `fragment id "${frag.id}" must equal its filename stem "${stem}"` })
    }
  }

  if (frag) {
    const bytes = Buffer.byteLength(String(frag.body ?? ''), 'utf8')
    if (bytes > FRAGMENT_BUDGET) {
      out.push({ file, rule: 'FRAG-BYTES', detail: `fragment body is ${bytes} bytes (> ${FRAGMENT_BUDGET}) — one fact per fragment; split it` })
    }
    if (!frag.trigger || parseTrigger(frag.trigger) == null) {
      out.push({ file, rule: 'FRAG-TRIGGER', detail: `fragment ${file} has no parseable trigger (need path:<glob> | tag:<tag> | cmd:<substring>)` })
    }
  }

  return out
}

// ─────────────────────────── trigger grammar ────────────────────────────────

/** Compile a glob subset to an anchored RegExp: * = one segment, ** = any depth. */
function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches ANY depth INCLUDING zero directories (standard glob); a bare
        // `**` matches any run of characters.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp('^' + re + '$')
}

/**
 * parseTrigger(str) → {kind, value, test?} or null (invalid). Exactly one of:
 *   - path:<glob>      → kind 'path', test(pathStr)
 *   - tag:<tag>        → kind 'tag', value
 *   - cmd:<substring>  → kind 'cmd', value (case-sensitive)
 */
export function parseTrigger(str) {
  const s = String(str ?? '').trim()
  if (s.startsWith('path:')) {
    const glob = s.slice(5).trim()
    if (!glob) return null
    let test
    try {
      const re = globToRegExp(glob)
      test = (p) => re.test(String(p ?? '').replace(/\\/g, '/'))
    } catch {
      return null
    }
    return { kind: 'path', value: glob, test }
  }
  if (s.startsWith('tag:')) {
    const tag = s.slice(4).trim()
    return tag ? { kind: 'tag', value: tag } : null
  }
  if (s.startsWith('cmd:')) {
    const sub = s.slice(4)
    return sub ? { kind: 'cmd', value: sub } : null
  }
  return null
}

/** Specificity rank for match ordering (path > cmd > tag). */
const KIND_RANK = { path: 0, cmd: 1, tag: 2 }

/**
 * matchTriggers({toolName, toolInput, tags, fragments, registry}) → matched
 * fragments, ordered by specificity (path > cmd > tag) then id asc. Deterministic
 * over identical input. `tags` are the derived facet tags (alias-resolved by the
 * caller, or here when a registry is provided). path/cmd match the tool input;
 * tag matches the derived tag set.
 */
export function matchTriggers({ toolName, toolInput = {}, tags = [], fragments = [], registry } = {}) {
  const tagSet = new Set(
    (Array.isArray(tags) ? tags : []).map((t) => (registry ? resolveAlias(String(t), registry) : String(t))),
  )
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : ''
  const command = typeof toolInput.command === 'string' ? toolInput.command : ''

  const matched = []
  for (const frag of fragments) {
    if (!frag || !frag.id) continue
    const trig = parseTrigger(frag.trigger)
    if (!trig) continue
    let hit = false
    if (trig.kind === 'path') hit = filePath ? trig.test(filePath) : false
    else if (trig.kind === 'cmd') hit = command ? command.indexOf(trig.value) !== -1 : false
    else if (trig.kind === 'tag') hit = tagSet.has(registry ? resolveAlias(trig.value, registry) : trig.value)
    if (hit) matched.push({ frag, kind: trig.kind })
  }
  matched.sort((a, b) => {
    const ra = KIND_RANK[a.kind] ?? 9
    const rb = KIND_RANK[b.kind] ?? 9
    if (ra !== rb) return ra - rb
    return a.frag.id < b.frag.id ? -1 : a.frag.id > b.frag.id ? 1 : 0
  })
  return matched.map((m) => m.frag)
}

// ─────────────────────────── delivery (at the act) ──────────────────────────

/**
 * deliverFragments({toolName, toolInput, tags, fragments, seen, cite, registry, cap}) →
 * {delivered, seen}. At most DELIVER_CAP per event; a fragment already seen this session
 * under its 'frag:<id>' key is skipped (fatigue mirrors the reflex posture — once per
 * session, not once per keystroke). Each delivered fragment triggers ONE cite(frag.id)
 * (the caller wires recordCitation kind 'fire'); a citation sink that throws NEVER breaks
 * delivery. Pure over its injected state; the caller persists `seen`.
 */
export function deliverFragments({ toolName, toolInput, tags = [], fragments = [], seen, cite, registry, cap = DELIVER_CAP } = {}) {
  const store = seen && typeof seen === 'object' ? seen : {}
  if (!store.notes || typeof store.notes !== 'object') store.notes = {}

  const matches = matchTriggers({ toolName, toolInput, tags, fragments, registry })
  const delivered = []
  for (const frag of matches) {
    if (delivered.length >= cap) break
    const key = 'frag:' + frag.id
    if (store.notes[key]) continue // already surfaced this session (fatigue)
    store.notes[key] = (store.notes[key] ?? 0) + 1
    if (typeof cite === 'function') {
      try {
        cite(frag.id)
      } catch {
        /* fail-open — a citation failure never breaks delivery */
      }
    }
    delivered.push(frag)
  }
  return { delivered, seen: store }
}

// ─────────────────────────── listing ────────────────────────────────────────

/**
 * listFragments({corpusDir, fragmentsDir}) → parsed fragments (tolerant). Reads
 * `<corpusDir>/fragments/*.md` (or an explicit fragmentsDir). A missing dir is a
 * valid state → []. A file that fails to read is skipped (fail-soft).
 */
export function listFragments({ corpusDir, fragmentsDir } = {}) {
  const dir = fragmentsDir || (corpusDir ? join(corpusDir, 'fragments') : null)
  if (!dir) return []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return [] // missing fragments/ dir is a valid state
  }
  const out = []
  for (const f of entries.filter((e) => e.endsWith('.md')).sort()) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    out.push(parseFragment(text, { file: f }))
  }
  return out
}
