/**
 * batch.mjs — the /sma-batch MIDDLE lane (Phase 9.3 Plan 12).
 *
 * D-9.3-19 / BL-149 verbatim (the founder's gap): «tasks which are not small, but not
 * phase oriented … 2-3-4 backlog items, plans them and executes, but not in the full
 * scale which takes so long.» The house two-lane rule (inline fix vs full phase) leaves a
 * gap for genuine multi-item work that does not warrant a phase. /sma-batch fills it:
 * it takes 2-4 named backlog items (or self-assembles a compatible set — same area, size
 * S/M, non-overlapping files), runs grill-lite per item, executes with ONE executor
 * (atomic commit per item, targeted tests only), BLIND-REVERIFIES every item, checks the
 * items off the backlog, and writes ONE batch note instead of a phase folder.
 *
 * Two hard guards, both DETERMINISTIC pure predicates:
 *   - RISK FILTER (classifyBatchRisk): anything phase-class — a new collection / migration
 *     / webhook / AI agent / cron / new route or surface — is REJECTED with «this is a
 *     phase» BEFORE any executor runs. A batch silently doing phase-class work would
 *     bypass discuss+plan+grill, the exact guardrail this lane exists to enforce.
 *   - EJECT rule (ejectItem): an item that grows past batch-class mid-run is thrown back
 *     to the backlog with a note («grew past batch-class — replan as a phase») and the
 *     batch CONTINUES with the remaining items — never aborts.
 *
 * RECEIPTS ARE NON-NEGOTIABLE (the accountability floor): every item is blind-reverified
 * (9.2-03 `sma reverify`) after its atomic commit BEFORE its backlog checkbox flips. A
 * green-looking item with no reproduced receipt does NOT get checked off. «Light» means
 * fewer AGENTS (no research / plan-checker / discuss), never fewer RECEIPTS
 * (D-9.3-19: «light does not mean unaccountable»).
 *
 * Consume-never-reimplement (D-9.3-02): this module writes NO second backlog parser, NO
 * second challenge ledger, NO second reverifier, NO second preflight. It COMPOSES the
 * existing substrate, all handed in by DI at the CLI boundary:
 *   - parse-backlog.ts's `parseBacklogContent` reads the `- [ ] **BL-NNN** …` grammar
 *     (the CLI parses; these functions consume the parsed items — this lib has no reader);
 *   - grill.mjs's `grillGate` is grill-lite (the SAME gate, a lighter registration);
 *   - `sma reverify` (9.2-03) produces the receipt;
 *   - `sma preflight` (9.3-10) is the per-item already-built guard.
 * The ONLY new markdown surface is `checkOffBacklogItem` — the companion WRITER that flips
 * exactly the matched `[ ]`→`[x]` line and leaves every other byte identical.
 *
 * Node built-ins only. Everything injectable (backlog IO doubles + preflight / grill /
 * reverify / executor runners) so tests never touch the real BACKLOG.md and never spawn a
 * real executor. No LLM, no network, no child_process in this lib — the CLI injects the
 * real runners.
 */

/**
 * PHASE_CLASS_MARKERS — the deterministic reject list (the house phase-class definition:
 * a new collection / migration / webhook / AI agent / cron / new route|page|surface|
 * endpoint|dashboard / external integration / schema change). A marker match is a
 * STRUCTURAL signal, not a judgment — no LLM. Over-rejection is the SAFE direction: a
 * false reject just routes the item to a full phase, which is exactly the guard's intent.
 */
export const PHASE_CLASS_MARKERS = [
  /\bmigrations?\b/i,
  /\bmigrate\b/i,
  /миграци/i,
  /\bnew collection\b/i,
  /\bpayload collection\b/i,
  /\bcollection\b/i,
  /коллекци/i,
  /\bwebhooks?\b/i,
  /вебхук/i,
  /\bai agents?\b/i,
  /\bnew agent\b/i,
  /\bagent\b/i,
  /агент/i,
  /\bcron\b/i,
  /крон/i,
  /\bnew (route|page|surface|endpoint|dashboard)\b/i,
  /\bnew\s+\/crm\b/i,
  /новый маршрут|новая страница|новый эндпоинт|новая поверхность/i,
  /\bschema change\b/i,
  /\bexternal integration\b/i,
]

/** The single blob a marker is matched against: title + description + declared files. */
function itemBlob(item) {
  const parts = [item?.title, item?.description, ...(item?.files ?? [])]
  return parts.filter(Boolean).join(' ')
}

/**
 * classifyBatchRisk(item) -> {allowed, reason}. Deterministic. A phase-class marker match
 * anywhere in the item's title/description/declared-files rejects it with «this is a
 * phase»; otherwise the item is batch-eligible.
 */
export function classifyBatchRisk(item) {
  const blob = itemBlob(item)
  const hit = PHASE_CLASS_MARKERS.some((re) => re.test(blob))
  return hit ? { allowed: false, reason: 'this is a phase' } : { allowed: true, reason: '' }
}

/** True when two items declare an overlapping file. */
function filesOverlap(a, b) {
  const fb = new Set(b?.files ?? [])
  return (a?.files ?? []).some((f) => fb.has(f))
}

/** True when any two items in the set share a declared file. */
function anyOverlap(list) {
  const seen = new Set()
  for (const it of list) {
    for (const f of it?.files ?? []) {
      if (seen.has(f)) return true
      seen.add(f)
    }
  }
  return false
}

/**
 * selectBatch(ids, backlog) -> {ok, items, reason}. Resolves explicit named ids to their
 * parsed backlog items (in id order). Refuses: a missing id, fewer than 2 / more than 4
 * items, or a file-overlapping set. It does NOT classify risk — the CLI/runBatch applies
 * the risk filter up front (per-item, so a phase-class id is named in the rejection).
 */
export function selectBatch(ids, backlog) {
  const byId = new Map((backlog ?? []).map((i) => [i.id, i]))
  const items = []
  for (const id of ids ?? []) {
    const found = byId.get(id)
    if (!found) return { ok: false, items: [], reason: `backlog item ${id} not found` }
    items.push(found)
  }
  if (items.length < 2) return { ok: false, items, reason: 'a batch needs at least 2 items (use /sma-fix for one)' }
  if (items.length > 4) return { ok: false, items, reason: 'a batch caps at 4 items (split it)' }
  if (anyOverlap(items)) return { ok: false, items, reason: 'items overlap on a declared file — they must be sequenced, not batched' }
  return { ok: true, items, reason: '' }
}

/**
 * assembleCompatibleBatch(backlog) -> {ok, items, reason}. Auto-picks a compatible set:
 * open (not done, not promoted to a phase), size S or M, NOT phase-class, sharing an area,
 * with non-overlapping declared files — capped at 4, minimum 2. An empty compatible set
 * returns {ok:false, items:[], reason} — never a forced batch.
 */
export function assembleCompatibleBatch(backlog) {
  const eligible = (backlog ?? []).filter(
    (i) => !i.done && !i.phase && (i.size === 'S' || i.size === 'M') && classifyBatchRisk(i).allowed,
  )
  // group by area
  const byArea = new Map()
  for (const i of eligible) {
    const key = i.area ?? '(none)'
    if (!byArea.has(key)) byArea.set(key, [])
    byArea.get(key).push(i)
  }
  // find the largest area group that yields a 2-4 non-overlapping set
  let best = []
  for (const group of byArea.values()) {
    const picked = []
    for (const cand of group) {
      if (picked.length >= 4) break
      if (picked.every((p) => !filesOverlap(p, cand))) picked.push(cand)
    }
    if (picked.length >= 2 && picked.length > best.length) best = picked
  }
  if (best.length < 2) {
    return { ok: false, items: [], reason: 'no compatible set — need 2-4 open S/M non-phase items sharing an area with non-overlapping files' }
  }
  return { ok: true, items: best, reason: '' }
}

// - [ ] **BL-007** …  /  - [x] **BL-007** … — the exact parse-backlog.ts open/done anchor.
const OPEN_LINE = (id) => new RegExp(`^(-\\s+\\[)( )(\\]\\s+\\*\\*${escapeId(id)}\\*\\*)`)
const DONE_LINE = (id) => new RegExp(`^-\\s+\\[[xX]\\]\\s+\\*\\*${escapeId(id)}\\*\\*`)
const ANY_LINE = (id) => new RegExp(`^-\\s+\\[[ xX]\\]\\s+\\*\\*${escapeId(id)}\\*\\*`)

function escapeId(id) {
  return String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * checkOffBacklogItem({backlogText, id}) -> {changed, backlogText}. The surgical WRITER
 * (the one new markdown surface, D-9.3-02): flips EXACTLY the matched `- [ ] **BL-NNN**`
 * line to `- [x] **BL-NNN**` and leaves every other byte identical. An already-`[x]` line
 * is a no-op; a missing id returns {changed:false} without touching the text.
 */
export function checkOffBacklogItem({ backlogText, id }) {
  const lines = String(backlogText ?? '').split('\n')
  const open = OPEN_LINE(id)
  let changed = false
  const out = lines.map((line) => {
    if (!changed && open.test(line)) {
      changed = true
      return line.replace(open, '$1x$3') // [ ] -> [x], rest of the line untouched
    }
    return line
  })
  if (!changed) return { changed: false, backlogText }
  return { changed: true, backlogText: out.join('\n') }
}

/**
 * ejectItem({item, backlogText, note}) -> {ejected, note, backlogText}. Returns a grown
 * item to the backlog: un-checks its line back to `[ ]` (if it was flipped) and appends the
 * eject note to that line. If the line is missing, inserts a fresh `[ ]` line under the
 * first `## Backlog` heading. The surrounding batch continues — this never throws.
 */
export function ejectItem({ item, backlogText, note }) {
  const id = item?.id
  const noteText = note ?? 'grew past batch-class — replan as a phase'
  const lines = String(backlogText ?? '').split('\n')
  const any = ANY_LINE(id)
  let touched = false
  const out = lines.map((line) => {
    if (!touched && any.test(line)) {
      touched = true
      // force back to [ ] and append the note if not already there
      let next = line.replace(/^(-\s+\[)[ xX](\])/, '$1 $2')
      if (!next.includes(noteText)) next = `${next} — ${noteText}`
      return next
    }
    return line
  })
  if (!touched) {
    // insert under the first `## Backlog` heading
    const idx = out.findIndex((l) => /^##\s+Backlog\b/i.test(l))
    const fresh = `- [ ] **${id}** · ${item?.title ?? id} — ${noteText}`
    if (idx >= 0) out.splice(idx + 1, 0, fresh)
    else out.push(fresh)
  }
  return { ejected: true, note: noteText, backlogText: out.join('\n') }
}

/**
 * runBatch({items, runPreflight, grillGate, runExecutor, runReverify, backlogIo, now})
 * -> {items:[result], note}. The driver. Per item, in THIS order:
 *   1. RISK FILTER — a phase-class item is rejected «this is a phase», batch continues.
 *   2. preflight (9.3-10) — a `built` verdict SKIPS the item (no tokens on built work).
 *   3. grill-lite gate (grill.mjs, fail-open) — an open challenge BLOCKS that item.
 *   4. ONE executor pass — an atomic commit per item (targeted tests inside the executor).
 *   5. reverify (9.2-03) — the mandatory receipt.
 *   6. checkOffBacklogItem — flips the box ONLY on a clean reverify receipt; a divergent
 *      receipt records a FAILED item and leaves the box `[ ]`.
 * Every runner is injected; the lib spawns nothing. `backlogIo` = {read, write}.
 */
export async function runBatch(opts) {
  const {
    items = [],
    runPreflight,
    grillGate,
    runExecutor,
    runReverify,
    backlogIo,
    now,
  } = opts ?? {}
  const ts = now ?? new Date().toISOString()
  const results = []

  for (const item of items) {
    const rec = { id: item.id, title: item.title, ts, status: 'pending' }

    // 1. risk filter — phase-class is rejected up front; the batch continues.
    const risk = classifyBatchRisk(item)
    if (!risk.allowed) {
      rec.status = 'rejected'
      rec.reason = risk.reason
      results.push(rec)
      continue
    }

    // 2. preflight (fail-open: a missing/errored preflight degrades to a note, not a skip).
    let pf = { verdict: 'absent' }
    if (typeof runPreflight === 'function') {
      try { pf = (await runPreflight(item)) ?? pf } catch { pf = { verdict: 'absent', note: 'preflight unavailable — continued' } }
    }
    rec.preflight = pf.verdict ?? 'absent'
    if (pf.verdict === 'built') {
      rec.status = 'skipped-built'
      results.push(rec)
      continue
    }

    // 3. grill-lite gate (fail-open per grill.mjs — an open challenge blocks THIS item).
    let gate = { allowed: true, grilled: false, open: [] }
    if (typeof grillGate === 'function') {
      try { gate = grillGate(item) ?? gate } catch { gate = { allowed: true, grilled: false, open: [] } }
    }
    rec.grill = gate.grilled ? (gate.allowed ? 'clear' : 'open') : 'ungrilled'
    if (!gate.allowed) {
      rec.status = 'blocked'
      rec.reason = `open grill challenge${gate.open?.length ? ` (${gate.open.length})` : ''}`
      results.push(rec)
      continue
    }

    // 4. ONE executor pass — an atomic commit per item.
    let exec = {}
    try { exec = (await runExecutor(item)) ?? {} } catch (err) {
      rec.status = 'fail'
      rec.reason = `executor error: ${err?.message ?? err}`
      results.push(rec)
      continue
    }
    rec.commit = exec.commit ?? null

    // 5. reverify — the MANDATORY receipt.
    let rv = { verdict: 'error' }
    try { rv = (await runReverify(item)) ?? rv } catch { rv = { verdict: 'error' } }
    rec.reverify = rv.verdict
    rec.receipt = rv.receipt ?? null

    // 6. checkoff ONLY on a clean receipt (the accountability floor).
    if (rv.verdict === 'verified') {
      if (backlogIo && typeof backlogIo.read === 'function' && typeof backlogIo.write === 'function') {
        const before = backlogIo.read()
        const { changed, backlogText } = checkOffBacklogItem({ backlogText: before, id: item.id })
        if (changed) backlogIo.write(backlogText)
        rec.checkedOff = changed
      }
      rec.status = 'pass'
    } else {
      rec.status = 'fail'
      rec.reason = `reverify ${rv.verdict} — receipt not reproduced; box left [ ]`
    }
    results.push(rec)
  }

  return { items: results, note: writeBatchNote(results) }
}

/**
 * writeBatchNote(results) -> string. ONE markdown note (NOT a phase folder, NOT plan
 * files) recording, per item: preflight verdict, grill-lite verdict, reverify receipt,
 * commit sha, pass/fail + reason. The CLI writes this single string to one file.
 */
export function writeBatchNote(results) {
  const rows = (results ?? []).map((r) => {
    const bits = [
      `- **${r.id}** — ${r.status}`,
      r.title ? `  - ${r.title}` : null,
      `  - preflight: ${r.preflight ?? 'n/a'} · grill: ${r.grill ?? 'n/a'} · reverify: ${r.reverify ?? 'n/a'}`,
      r.commit ? `  - commit: ${r.commit}` : null,
      r.receipt ? `  - receipt: claimed=${r.receipt.claimed ?? '?'} reproduced=${r.receipt.reproduced ?? '?'}` : null,
      r.reason ? `  - note: ${r.reason}` : null,
    ]
    return bits.filter(Boolean).join('\n')
  })
  const pass = (results ?? []).filter((r) => r.status === 'pass').length
  const total = (results ?? []).length
  return [
    `# SMA batch note`,
    ``,
    `Middle lane (/sma-batch, D-9.3-19). ${pass}/${total} items passed. Receipts are mandatory — each pass carries a reproduced reverify receipt.`,
    ``,
    ...rows,
    ``,
  ].join('\n')
}
