/**
 * subagent-pack.mjs — deterministic PreTask context-pack assembly + the PreToolUse
 * `updatedInput` injection payload (49.2-04, D-49.2-10).
 *
 * Anthropic closed the native subagent-inheritance request «not planned», so a
 * spawned subagent starts rule-blind unless an outer layer injects the context.
 * This module is that layer's brain: it assembles ONE markdown block — CORE rules
 * digest, active claims, the parent task slice, task-scoped lessons — and the CLI
 * (`pretask-pack`) prepends it to the subagent's prompt via the PreToolUse hook's
 * `updatedInput`. Inheritance by construction.
 *
 * Design invariants (mirror digest.mjs exactly):
 *   - PURE assembly over INJECTED sources ({loadCore, loadPeriphery, readClaims,
 *     readSessions, execTail, vocab}) — zero I/O of its own, so tests never touch
 *     the filesystem. The CLI wires the real sources (loader/claims/registry/exec).
 *   - Per-source try/catch: ONE failing source degrades to a PARTIAL pack with a
 *     collected warning, never a throw (T-49.2-04, digest.mjs T-49.1-37 posture) —
 *     `pretask-pack` is HOOK_FACING and must never wedge a Task spawn.
 *   - Hard byte budget (PACK_BUDGET_BYTES, UTF-8 bytes). When over budget the trim
 *     order is lessons (from the END of the loader-ordered list) -> parent slice ->
 *     claims; the CORE digest layer is NEVER trimmed (untouchable).
 *   - Deterministic: the same inputs produce a byte-identical pack. No timestamps,
 *     no Date.now(), no randomness in the assembled text — ages come from injected
 *     ageMs so the output is stable across runs.
 *
 * Node built-ins only; zero npm deps, zero network, zero LLM (substrate law).
 */

import { displayIdentity } from './registry.mjs'

/** Hard byte budget of the whole assembled pack (UTF-8 bytes; FI-9 budget convention). */
export const PACK_BUDGET_BYTES = 8192

/** Sentinel lines bounding the pack — the grep-able marker the dogfood probe looks for. */
const PACK_OPEN = '=== SMA-PACK v1 ==='
const PACK_CLOSE = '=== END SMA-PACK ==='

/** Byte length under UTF-8 (the budget is measured in bytes, not chars). */
function bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** A short error string for the warnings array (never leaks a stack). */
function errMsg(e) {
  return e && e.message ? String(e.message) : String(e)
}

/**
 * deriveTags(taskInput, vocab) — the lowercase word-intersection of the Task
 * tool_input.description + prompt against the tags-registry vocabulary. Output is
 * sorted + deduped; zero vocab hits -> [] (assemblePack then degrades to a
 * CORE-only pack — an honest empty lessons layer, never an error).
 *
 * @param {{description?:string, prompt?:string}} taskInput
 * @param {Set<string>|string[]} [vocab]  registered area/kind tags (lowercase)
 * @returns {string[]}
 */
export function deriveTags(taskInput = {}, vocab) {
  const has =
    vocab && typeof vocab.has === 'function'
      ? (t) => vocab.has(t)
      : Array.isArray(vocab)
        ? ((set) => (t) => set.has(t))(new Set(vocab.map((v) => String(v).toLowerCase())))
        : () => false

  const text = [
    taskInput && typeof taskInput.description === 'string' ? taskInput.description : '',
    taskInput && typeof taskInput.prompt === 'string' ? taskInput.prompt : '',
  ]
    .join(' ')
    .toLowerCase()

  const hits = new Set()
  for (const w of text.split(/[^a-z0-9:._-]+/)) {
    if (w && has(w)) hits.add(w)
  }
  return [...hits].sort()
}

/** Render a {title, oneLiner} (or bare title string) as a `- <title>: <one-liner>` bullet. */
function renderTitleOneLiner(x) {
  if (!x) return ''
  const title = typeof x === 'string' ? x : x.title != null ? String(x.title) : ''
  const oneLiner = x && typeof x === 'object' && x.oneLiner != null ? String(x.oneLiner) : ''
  const t = title.trim()
  if (!t) return ''
  const o = oneLiner.trim()
  return o ? `- ${t}: ${o}` : `- ${t}`
}

/**
 * renderClaims(claims, sessions) — each live claim as `- «<name>» held by <who>
 * (<ageMin> min)` using the displayIdentity convention (the SAME naming
 * collision-check uses), so the subagent sees foreign scopes before touching them.
 * The named identity is resolved by matching the claim's provenance.by against a
 * live session (label/phase enrich the name); otherwise the bare holder string.
 */
function renderClaims(claims, sessions) {
  const list = Array.isArray(claims) ? claims : []
  const byHolder = new Map()
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s && s.holderIdentity != null) byHolder.set(String(s.holderIdentity), s)
  }
  const out = []
  for (const c of list) {
    if (!c || !c.name) continue
    const by = c.provenance && c.provenance.by != null ? String(c.provenance.by) : ''
    const s = byHolder.get(by)
    const who = s
      ? displayIdentity({ holderIdentity: s.holderIdentity, label: s.label, phase: s.phase })
      : displayIdentity({ holderIdentity: by })
    const ageMin = Number.isFinite(c.ageMs) ? Math.round(c.ageMs / 60000) : 0
    out.push(`- «${c.name}» held by ${who} (${ageMin} min)`)
  }
  return out
}

/**
 * renderSlice(taskInput, execTail) — the parent task slice: the Task
 * tool_input.description verbatim + the last 5 events of the active plan's exec
 * journal (injected execTail). Unresolvable / empty -> [] so the caller omits the
 * whole layer (honest empty, never a fabricated heading).
 */
function renderSlice(taskInput, execTail) {
  const lines = []
  const desc = taskInput && typeof taskInput.description === 'string' ? taskInput.description.trim() : ''
  if (desc) lines.push(desc)
  let events = []
  try {
    if (typeof execTail === 'function') events = execTail() || []
  } catch {
    events = [] // an exec-journal read failure just drops the events, never throws
  }
  for (const e of (Array.isArray(events) ? events : []).slice(-5)) {
    if (!e) continue
    const ev = e.event != null ? String(e.event) : 'event'
    const task = e.task != null ? ` task ${e.task}` : ''
    lines.push(`- ${ev}${task}`)
  }
  return lines
}

/** Assemble the sentinel-bounded pack, omitting any empty layer's heading. */
function renderPack({ digestItems, claimItems, sliceLines, lessonItems }) {
  const blocks = []
  if (digestItems.length) blocks.push('## Правила (CORE)\n' + digestItems.join('\n'))
  if (claimItems.length) blocks.push('## Активные claims\n' + claimItems.join('\n'))
  if (sliceLines.length) blocks.push('## Задача родителя\n' + sliceLines.join('\n'))
  if (lessonItems.length) blocks.push('## Уроки по задаче\n' + lessonItems.join('\n'))
  return [PACK_OPEN, ...blocks, PACK_CLOSE].join('\n\n')
}

/**
 * assemblePack({taskInput, sources, budgetBytes}) — assemble the four-layer pack in
 * FIXED order (CORE digest -> claims -> parent slice -> lessons), under the byte
 * budget, with per-source partial degradation. Never throws.
 *
 * @param {object} o
 * @param {{description?:string, prompt?:string}} [o.taskInput]  Task tool_input
 * @param {object} [o.sources]  injected sources:
 *   - loadCore(): [{title, oneLiner}]        the always-load CORE rules digest
 *   - loadPeriphery(tags): [{title, oneLiner}]  tag-matched lessons (loader order)
 *   - readClaims(): [{name, provenance, ageMs}]  live scope claims
 *   - readSessions(): [{holderIdentity, label, phase}]  live sessions (identity)
 *   - execTail(): [event]                     the active plan's recent exec journal
 *   - vocab: Set<string>|string[]             tags-registry vocabulary for deriveTags
 * @param {number} [o.budgetBytes]  budget override (default PACK_BUDGET_BYTES)
 * @returns {{pack:string, bytes:number, layers:{digest:number, claims:number, slice:number, lessons:number}, warnings:string[]}}
 */
export function assemblePack({ taskInput = {}, sources = {}, budgetBytes = PACK_BUDGET_BYTES } = {}) {
  const warnings = []
  const maxBytes = Number.isFinite(budgetBytes) ? budgetBytes : PACK_BUDGET_BYTES

  // Layer 1 — CORE rules digest (untouchable, never trimmed).
  let digestItems = []
  try {
    const core = typeof sources.loadCore === 'function' ? sources.loadCore() : []
    digestItems = (Array.isArray(core) ? core : []).map(renderTitleOneLiner).filter(Boolean)
  } catch (e) {
    warnings.push('digest: ' + errMsg(e))
  }

  // Layer 2 — active claims.
  let claimItems = []
  try {
    const claims = typeof sources.readClaims === 'function' ? sources.readClaims() : []
    let sessions = []
    try {
      sessions = typeof sources.readSessions === 'function' ? sources.readSessions() : []
    } catch (e) {
      warnings.push('claims-sessions: ' + errMsg(e))
    }
    claimItems = renderClaims(claims, sessions)
  } catch (e) {
    warnings.push('claims: ' + errMsg(e))
  }

  // Layer 3 — parent task slice (description verbatim + exec-journal tail).
  let sliceLines = []
  try {
    sliceLines = renderSlice(taskInput, sources.execTail)
  } catch (e) {
    warnings.push('slice: ' + errMsg(e))
  }

  // Layer 4 — task-scoped lessons (deriveTags -> loadPeriphery, loader order preserved).
  let lessonItems = []
  try {
    const tags = deriveTags(taskInput, sources.vocab)
    const lessons = typeof sources.loadPeriphery === 'function' ? sources.loadPeriphery(tags) : []
    lessonItems = (Array.isArray(lessons) ? lessons : []).map(renderTitleOneLiner).filter(Boolean)
  } catch (e) {
    warnings.push('lessons: ' + errMsg(e))
  }

  // Trim to budget: lessons (from the END) -> slice (whole) -> claims (whole).
  // The CORE digest is untouchable — if it alone overflows, it still ships.
  let curLessons = lessonItems.slice()
  let curSlice = sliceLines.slice()
  let curClaims = claimItems.slice()
  const render = () =>
    renderPack({ digestItems, claimItems: curClaims, sliceLines: curSlice, lessonItems: curLessons })

  let pack = render()
  while (bytes(pack) > maxBytes && curLessons.length) {
    curLessons.pop()
    pack = render()
  }
  if (bytes(pack) > maxBytes && curSlice.length) {
    curSlice = []
    pack = render()
  }
  if (bytes(pack) > maxBytes && curClaims.length) {
    curClaims = []
    pack = render()
  }

  return {
    pack,
    bytes: bytes(pack),
    layers: {
      digest: digestItems.length,
      claims: curClaims.length,
      slice: curSlice.length,
      lessons: curLessons.length,
    },
    warnings,
  }
}

/**
 * buildUpdatedInput(evt, pack) — the PreToolUse injection payload. The pack is
 * PREPENDED to the subagent's prompt; the original prompt survives byte-identical
 * after it. permissionDecision is 'allow' in EVERY branch — this hook injects
 * context, it never gates (fail-open; hard-deny stays the security guard's alone).
 *
 * @param {{tool_input?:object}} evt  the PreToolUse(Task) hook event
 * @param {string} pack               the assembled pack
 * @returns {{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'allow', updatedInput:object}}}
 */
export function buildUpdatedInput(evt = {}, pack = '') {
  const toolInput = evt && typeof evt.tool_input === 'object' && evt.tool_input ? evt.tool_input : {}
  const original = typeof toolInput.prompt === 'string' ? toolInput.prompt : ''
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, prompt: `${pack}\n\n${original}` },
    },
  }
}
