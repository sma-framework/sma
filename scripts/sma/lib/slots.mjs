/**
 * slots.mjs — R9 external-state slot coordination for three shared counters that
 * have burned this repo: migration numbers (index.ts contention), the V1.N release
 * counter, and the founder-reserved deploy-signal advisory claim.
 *
 * Design invariants:
 *   - All git access goes through an INJECTABLE runner (execGit) so tests never touch
 *     the network. The real runner (defaultExecGit) uses execFileSync('git', [args])
 *     with args ARRAYS — no shell string, no interpolation (T-49-06-03).
 *   - Read-only git: this module issues ONLY read subcommands (fetch/show/tag/
 *     rev-parse/log). It NEVER performs the founder-reserved deploy operation
 *     (git-push) — that stays a human action outside SMA (P5, T-49-06-01). The
 *     SMA-3 guard greps this file for the two-word invocation; every reference here
 *     is hyphenated ("git-push") or phrased as "отправка в origin" so it never
 *     matches, and the args-array runner never yields the adjacent literal.
 *   - Numeric domain: counters are compared as INTEGERS (parseInt/Number), never
 *     lexicographically, so 099 -> 100 and V1.9 -> V1.10 are correct (SPEC boundary).
 *   - Fail-open (C9): if fetch fails (offline) we compute from local state and attach
 *     a WARN rather than throwing.
 *   - Atomic claim gate: slot contention is resolved by claimSlot's mkdir gate — the
 *     deterministic slot name IS the lock (49-03). A lost race retries at N+1.
 *   - Foreign claims are never auto-cleared (P3, T-49-06-02): a stale deploy signal is
 *     flagged needsHuman, never silently removed.
 *
 * Node built-ins only; zero npm deps.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  claimSlot,
  isCoolingDown,
  readClaims,
  releaseSlot,
  reconcileExpiredClaim,
  markConsumed,
} from './claims.mjs'
import { appendEvent } from './journal.mjs'
import { PUSH_CLAIM_TTL_MS, SLOT_CLAIM_TTL_MS } from './constants.mjs'

/**
 * B21 sorted-insert rule — printed by the CLI with every migration slot result and
 * embedded in 49-14's README. Exported as a string constant so both consume one text.
 */
export const SORTED_INSERT_RULE =
  'Новая запись миграции вставляется строго по числовому месту в конец массива, ' +
  'вплотную к предыдущему номеру. Так две попытки вставить один и тот же номер дают ' +
  'git-конфликт при слиянии, а не тихое дублирование записи.'

/** Default real git runner: execFileSync with an args ARRAY (no shell interpolation). */
export function defaultExecGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

/**
 * journalOpt(o) — the appendEvent dir opt for slot events (WR-03). Slot activity is
 * journal data (read by readJournal, the status collision counter, the snapshot
 * collisionFeed, the statusline) — it MUST land in the journal dir. Prefer an explicit
 * o.journalDir; fall back to o.claimsDir ONLY for backward compat with callers that have
 * not yet been updated (so a parallel terminal on old code does not crash), and default
 * to {} (the constants-derived JOURNAL_DIR) when neither is supplied.
 */
function journalOpt(o) {
  if (o && o.journalDir) return { journalDir: o.journalDir }
  if (o && o.claimsDir) return { journalDir: o.claimsDir } // legacy fallback (WR-03)
  return {}
}

/**
 * extractMaxNumber(text) -> {max:number, name:string|null}. Parses three-digit-prefixed
 * migration entry names (NNN_snake_name) and returns the numeric maximum + its entry
 * name. Integer parse only — no lexicographic ordering. Empty/garbage -> {max:-1}.
 */
export function extractMaxNumber(text) {
  if (!text || typeof text !== 'string') return { max: -1, name: null }
  const re = /name:\s*'(\d{3})_([a-z0-9_]+)'/g
  let max = -1
  let name = null
  let m
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10) // integer domain — never lexicographic
    if (Number.isFinite(n) && n > max) {
      max = n
      name = `${m[1]}_${m[2]}`
    }
  }
  return { max, name }
}

function padMigration(n) {
  return String(n).padStart(3, '0')
}

/**
 * nextMigrationSlot — fetch (fail-open) + numeric max over local file AND origin blob
 * + atomic claim; a lost race retries at N+1 (bounded). Returns
 * {number, name, won, warn?}.
 *
 * @param {object} o
 * @param {(args:string[])=>string} [o.execGit]        injectable git runner
 * @param {string} [o.migrationsPath]                   path to the local migrations index
 * @param {string} o.by                                 holder identity (D-49-01)
 * @param {string} [o.session]
 * @param {string} [o.claimsDir]                        test override for the claims dir
 * @param {string} [o.journalDir]                       journal dir (WR-03: events go here,
 *                                                       NOT the claims dir)
 * @param {string} [o.terminalId]                       journal terminal id
 */
export function nextMigrationSlot(o = {}) {
  const execGit = o.execGit ?? defaultExecGit
  const migrationsPath = o.migrationsPath ?? 'src/migrations/index.ts'
  const terminalId = o.terminalId ?? o.by ?? 'unknown'

  let warn = null

  // (1) fetch — fail-open (C9). Read-only; never the founder-reserved deploy op (P5).
  try {
    execGit(['fetch', 'origin'])
  } catch {
    warn = 'origin недоступен — номер может быть занят'
  }

  // (2) numeric max over the local file AND the origin/main blob of the same path.
  let localText = ''
  try {
    localText = readFileSync(migrationsPath, 'utf8')
  } catch {
    localText = ''
  }
  let originText = ''
  try {
    originText = execGit(['show', `origin/main:src/migrations/index.ts`])
  } catch {
    // blob unreadable (offline / path absent) -> local-only, keep any fetch warn
    originText = ''
  }

  const local = extractMaxNumber(localText)
  const origin = extractMaxNumber(originText)
  const currentMax = Math.max(local.max, origin.max)
  const currentMaxEntryName = local.max >= origin.max ? local.name : origin.name

  // (3) candidate = max + 1 (integer math); (4) skip cooldown; (5) claim, retry on loss.
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  let candidate = currentMax + 1
  let raceWarn = null
  for (let i = 0; i < 5; i += 1) {
    const slotName = `migration-${padMigration(candidate)}`

    if (isCoolingDown(slotName, claimOpts)) {
      candidate += 1
      continue // B27 — a cooling-down slot is skipped, next number offered
    }

    const res = claimSlot(
      slotName,
      {
        by: o.by,
        session: o.session ?? null,
        expectedPrev: currentMaxEntryName,
        reason: 'migration-number',
      },
      claimOpts,
    )

    if (res.won) {
      const finalWarn = raceWarn ?? warn
      appendEvent(
        { type: 'claim', scope: slotName, detail: { number: candidate, warn: finalWarn ?? undefined } },
        { terminalId, ...journalOpt(o) },
      )
      return {
        number: candidate,
        name: `${padMigration(candidate)}_<phaseNN>_<snake_name>`,
        won: true,
        ...(finalWarn ? { warn: finalWarn } : {}),
      }
    }

    // 49.1-23 (B17): before leaking this number to N+1, try to reconcile an EXPIRED
    // unconsumed claim on the SAME slot — an abandoned number is nobody's. On success,
    // reclaim the same candidate immediately (the claimed-number-lost class ends).
    const rec = reconcileExpiredClaim(slotName, { ...claimOpts, ttlMs: SLOT_CLAIM_TTL_MS })
    if (rec.reconciled) {
      appendEvent(
        { type: 'reconcile', scope: slotName, detail: { number: candidate, reclaimedFrom: rec.holder && rec.holder.by ? rec.holder.by : null, ageMs: rec.ageMs } },
        { terminalId, ...journalOpt(o) },
      )
      const res2 = claimSlot(
        slotName,
        { by: o.by, session: o.session ?? null, expectedPrev: currentMaxEntryName, reason: 'migration-number' },
        claimOpts,
      )
      if (res2.won) {
        const finalWarn = raceWarn ?? warn
        appendEvent(
          { type: 'claim', scope: slotName, detail: { number: candidate, reconciled: true, warn: finalWarn ?? undefined } },
          { terminalId, ...journalOpt(o) },
        )
        return {
          number: candidate,
          name: `${padMigration(candidate)}_<phaseNN>_<snake_name>`,
          won: true,
          reconciled: true,
          ...(finalWarn ? { warn: finalWarn } : {}),
        }
      }
    }

    // Lost the race — journal a warn + retry at candidate+1 (B21 allocate-on-write).
    const holderBy = res.holder && res.holder.by ? res.holder.by : 'другой терминал'
    raceWarn = `слот ${slotName} уже занят (${holderBy}) — выдан следующий свободный номер`
    appendEvent(
      { type: 'warn', scope: slotName, detail: { lostTo: holderBy } },
      { terminalId, ...journalOpt(o) },
    )
    candidate += 1
  }

  // Bounded retries exhausted — surface a warn, no claim held.
  return {
    number: candidate,
    name: `${padMigration(candidate)}_<phaseNN>_<snake_name>`,
    won: false,
    warn: raceWarn ?? warn ?? 'не удалось занять слот номера миграции за 5 попыток',
  }
}

// ── R9b/c — V1.N release counter + deploy-signal advisory claim ────────────────────

const PUSH_SLOT_NAME = 'push-in-progress'
const VERSION_RE = /^V(\d+)\.(\d+)$/

/**
 * listReleaseTags(execGit) -> string[] of V1.* tags after a tags fetch (fail-open).
 * fetch --tags is issued BEFORE the listing (B22). Read-only subcommands only (P5).
 */
function listReleaseTags(execGit) {
  let warn = null
  try {
    execGit(['fetch', '--tags', 'origin']) // read-only; deploy op stays founder-reserved (P5)
  } catch {
    warn = 'origin недоступен — версия может быть занята'
  }
  let out = ''
  try {
    out = execGit(['tag', '-l', 'V1.*'])
  } catch {
    out = ''
  }
  const tags = out
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => VERSION_RE.test(t))
  return { tags, warn }
}

/** maxMinor(tags) -> highest minor of V1.<minor> as an integer (-1 when none). */
function maxMinor(tags) {
  let max = -1
  for (const t of tags) {
    const m = VERSION_RE.exec(t)
    if (!m) continue
    const minor = Number(m[2]) // integer domain — V1.9 < V1.10
    if (Number.isFinite(minor) && minor > max) max = minor
  }
  return max
}

/**
 * nextReleaseVersion({execGit}) -> {version, warn?}. fetch --tags (fail-open) then
 * numeric max over V1.* tags + 1. Never lexicographic (V1.9 -> V1.10).
 */
export function nextReleaseVersion(o = {}) {
  const execGit = o.execGit ?? defaultExecGit
  const { tags, warn } = listReleaseTags(execGit)
  const next = maxMinor(tags) + 1
  return { version: `V1.${next}`, ...(warn ? { warn } : {}) }
}

/**
 * verifyReleaseStillFree(version, {execGit}) -> boolean. Re-fetch + re-list; false when
 * the version is now taken (the immediately-before-deploy re-check, B22).
 */
export function verifyReleaseStillFree(version, o = {}) {
  const execGit = o.execGit ?? defaultExecGit
  const { tags } = listReleaseTags(execGit)
  return !tags.includes(version)
}

/**
 * acquirePushClaim({by, session, plannedVersion, claimsDir}) — claim the single
 * deploy-in-progress advisory slot. This is an ADVISORY signal only: nothing here runs
 * the founder-reserved deploy operation (P5). Returns {acquired, holder?}.
 */
export function acquirePushClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const terminalId = o.by ?? 'unknown'
  // claimSlot (49-03) persists a FIXED provenance shape {by,pid,session,at,expectedPrev,
  // reason}; it does not carry arbitrary fields. To keep plannedVersion readable by
  // checkPushClaim without changing the 49-03 stamp, it rides in reason as a suffix.
  const plannedVersion = o.plannedVersion ?? null
  const res = claimSlot(
    PUSH_SLOT_NAME,
    {
      by: o.by,
      session: o.session ?? null,
      expectedPrev: null,
      reason: plannedVersion ? `push-in-progress:${plannedVersion}` : 'push-in-progress',
    },
    claimOpts,
  )
  if (res.won) {
    appendEvent(
      { type: 'claim', scope: PUSH_SLOT_NAME, detail: { plannedVersion: o.plannedVersion ?? null } },
      { terminalId, ...journalOpt(o) },
    )
    return { acquired: true }
  }
  return { acquired: false, holder: res.holder ?? null }
}

/**
 * releasePushClaim({by, claimsDir}) — release the caller's OWN deploy signal (the
 * post-confirm / timeout path). A foreign claim is refused (P3) — force-clear lives in
 * the interactive CLI (49-10), never here.
 */
export function releasePushClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const terminalId = o.by ?? 'unknown'
  const res = releaseSlot(PUSH_SLOT_NAME, { by: o.by, ...claimOpts })
  if (res.released) {
    appendEvent(
      { type: 'release', scope: PUSH_SLOT_NAME },
      { terminalId, ...journalOpt(o) },
    )
  }
  return res
}

/**
 * checkPushClaim({by, claimsDir, now}) — inspect the deploy signal without mutating it.
 *   - live claim within TTL   -> {live:true, warn, who, since, plannedVersion, howToClear}
 *   - claim older than TTL     -> {live:false, stale:true, needsHuman:true, who, since}
 *   - no claim                 -> {live:false}
 * Queue-never-cancel (B23): a foreign live claim is NEVER removed here; a stale one is
 * flagged for a human, never auto-deleted (P3).
 */
export function checkPushClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const claims = readClaims(claimOpts)
  const entry = claims.find((c) => c.name === PUSH_SLOT_NAME)
  if (!entry) return { live: false }

  const prov = entry.provenance
  const who = prov && prov.by ? prov.by : 'неизвестный терминал'
  const since = prov && prov.at ? prov.at : null
  // plannedVersion rides in reason as 'push-in-progress:V1.N' (see acquirePushClaim).
  const reason = (prov && prov.reason) || ''
  const versionMatch = /push-in-progress:(.+)$/.exec(reason)
  const plannedVersion = versionMatch ? versionMatch[1] : null

  const now = o.now ?? Date.now()
  const startedMs = since ? Date.parse(since) : NaN
  const ageMs = Number.isFinite(startedMs) ? now - startedMs : entry.ageMs

  if (ageMs > PUSH_CLAIM_TTL_MS) {
    // Stale — flag for a human; DO NOT auto-delete a foreign claim (P3, B23).
    return { live: false, stale: true, needsHuman: true, who, since, plannedVersion }
  }

  return {
    live: true,
    who,
    since,
    plannedVersion,
    warn: `отправка в origin уже идёт: ${who}${since ? ` (с ${since})` : ''} — дождитесь завершения`,
    howToClear: 'дождитесь / pnpm sma force-clear push-in-progress',
  }
}

// ── B11 — all-counter slots: bl / action / decision / phase ─────────────────────────
//
// The A-202 anomaly class (a hand-typed ID far above the real max, so the next naive
// scan collided) ends here: EVERY shared counter that lives in a planning source file
// gets one generic next-free-number allocator. BL-117..120 (the founder's auto-numbering
// asks) are the demand evidence (FI-5) — proof the slot concept deserves this reach.
//
// Each kind is a READ-ONLY scanner over its source file(s) (prohibition: next-slot never
// mutates BACKLOG/ACTIONS/ROADMAP/CONTEXT), reusing the exact claim + sorted-insert
// concurrency machinery as nextMigrationSlot so two terminals racing one kind resolve to
// different numbers.

/** The counter kinds this module allocates beyond migration/release. */
export const COUNTER_KINDS = ['bl', 'action', 'decision', 'phase']

/** Read a source file, fail-open to '' (a missing/unreadable file -> max -1 -> first slot). */
function safeReadText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * extractMaxByRegex(text, re) -> highest integer captured by group 1 of `re` (a /g
 * regex). Integer domain only (parseInt), never lexicographic. Empty/garbage -> -1.
 */
export function extractMaxByRegex(text, re) {
  if (!text || typeof text !== 'string') return -1
  let max = -1
  let m
  re.lastIndex = 0
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/**
 * findContextPath(planningRoot, phase) -> the phase's -CONTEXT.md path, or null.
 * Resolves the `.planning/phases/<phase>-...` dir then its `-CONTEXT.md` by directory
 * scan (fail-open).
 */
function findContextPath(planningRoot, phase) {
  try {
    const phasesDir = join(planningRoot, 'phases')
    const dir = readdirSync(phasesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(`${phase}-`))
      .map((d) => d.name)[0]
    if (!dir) return null
    const context = readdirSync(join(phasesDir, dir)).find((f) => /-CONTEXT\.md$/.test(f))
    return context ? join(phasesDir, dir, context) : null
  } catch {
    return null
  }
}

/**
 * counterSpec(kind, o) -> {sourceText, re, format, slotPrefix, max} for the kind, or
 * null when the kind is unknown / required input (decision --phase) is missing. Paths
 * come via DI (o.backlogPath / o.actionsPath / o.roadmapPath / o.contextPath) with
 * `.planning`-relative defaults derived from o.planningRoot.
 */
function counterSpec(kind, o = {}) {
  const planningRoot = o.planningRoot ?? '.planning'

  if (kind === 'bl') {
    const path = o.backlogPath ?? join(planningRoot, 'BACKLOG.md')
    return {
      sourceText: safeReadText(path),
      re: /\*\*BL-(\d+)\*\*/g,
      format: (n) => `BL-${n}`,
      slotPrefix: 'bl',
    }
  }
  if (kind === 'action') {
    const path = o.actionsPath ?? join(planningRoot, 'ACTIONS.md')
    return {
      sourceText: safeReadText(path),
      re: /\*\*A-(\d+)\*\*/g,
      format: (n) => `A-${String(n).padStart(3, '0')}`,
      slotPrefix: 'action',
    }
  }
  if (kind === 'decision') {
    const phase = o.phase
    if (!phase) return null
    const path = o.contextPath ?? findContextPath(planningRoot, phase)
    const escaped = String(phase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return {
      sourceText: path ? safeReadText(path) : '',
      re: new RegExp(`D-${escaped}-(\\d+)`, 'g'),
      format: (n) => `D-${phase}-${String(n).padStart(2, '0')}`,
      slotPrefix: `decision-${phase}`,
    }
  }
  if (kind === 'phase') {
    const path = o.roadmapPath ?? join(planningRoot, 'ROADMAP.md')
    return {
      sourceText: safeReadText(path),
      // Dotted headings (### Phase 49.1) match too; the capture is the INTEGER part, so
      // the next phase is the next whole number above the highest integer seen.
      re: /^###\s+Phase\s+(\d+)/gm,
      format: (n) => `${n}`,
      slotPrefix: 'phase',
    }
  }
  return null
}

/**
 * nextCounterSlot(kind, o) — the generic next-free-number allocator for a shared
 * planning counter (B11). Scans the source (read-only), takes the numeric max + 1, then
 * runs the SAME atomic claim / retry-at-N+1 loop as nextMigrationSlot so concurrent
 * allocations of one kind never collide. `o.dryRun` reports the number WITHOUT claiming.
 *
 * @param {'bl'|'action'|'decision'|'phase'} kind
 * @param {object} o
 * @param {string} [o.by]                holder identity
 * @param {string} [o.phase]             REQUIRED for kind='decision' (e.g. '49.1')
 * @param {string} [o.planningRoot]      default '.planning'
 * @param {string} [o.backlogPath|o.actionsPath|o.roadmapPath|o.contextPath] path overrides (DI)
 * @param {string} [o.claimsDir] [o.journalDir] [o.terminalId] [o.session]
 * @param {boolean} [o.dryRun]           scan + report only, no claim
 * @returns {{kind, number, id, won, warn?, dryRun?}}
 */
export function nextCounterSlot(kind, o = {}) {
  const spec = counterSpec(kind, o)
  if (!spec) {
    return {
      kind,
      won: false,
      warn: kind === 'decision' ? 'kind=decision требует --phase' : `неизвестный счётчик: ${kind}`,
    }
  }

  const max = extractMaxByRegex(spec.sourceText, spec.re)
  let candidate = max + 1
  if (candidate < 1) candidate = 1 // an empty source starts the series at 1

  if (o.dryRun) {
    return { kind, number: candidate, id: spec.format(candidate), won: true, dryRun: true }
  }

  const terminalId = o.terminalId ?? o.by ?? 'unknown'
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const expectedPrev = max >= 0 ? String(max) : null
  let raceWarn = null

  for (let i = 0; i < 5; i += 1) {
    const slotName = `${spec.slotPrefix}-${candidate}`

    if (isCoolingDown(slotName, claimOpts)) {
      candidate += 1
      continue // B27 — a cooling-down slot is skipped
    }

    const res = claimSlot(
      slotName,
      { by: o.by, session: o.session ?? null, expectedPrev, reason: `${spec.slotPrefix}-number` },
      claimOpts,
    )

    if (res.won) {
      appendEvent(
        { type: 'claim', scope: slotName, detail: { number: candidate, kind, warn: raceWarn ?? undefined } },
        { terminalId, ...journalOpt(o) },
      )
      return {
        kind,
        number: candidate,
        id: spec.format(candidate),
        won: true,
        ...(raceWarn ? { warn: raceWarn } : {}),
      }
    }

    // 49.1-23 (B17): reconcile an EXPIRED unconsumed claim on the SAME slot before
    // leaking the number to N+1 — the claimed-number-lost class ends for counters too.
    const rec = reconcileExpiredClaim(slotName, { ...claimOpts, ttlMs: SLOT_CLAIM_TTL_MS })
    if (rec.reconciled) {
      appendEvent(
        { type: 'reconcile', scope: slotName, detail: { number: candidate, kind, reclaimedFrom: rec.holder && rec.holder.by ? rec.holder.by : null, ageMs: rec.ageMs } },
        { terminalId, ...journalOpt(o) },
      )
      const res2 = claimSlot(
        slotName,
        { by: o.by, session: o.session ?? null, expectedPrev, reason: `${spec.slotPrefix}-number` },
        claimOpts,
      )
      if (res2.won) {
        appendEvent(
          { type: 'claim', scope: slotName, detail: { number: candidate, kind, reconciled: true, warn: raceWarn ?? undefined } },
          { terminalId, ...journalOpt(o) },
        )
        return {
          kind,
          number: candidate,
          id: spec.format(candidate),
          won: true,
          reconciled: true,
          ...(raceWarn ? { warn: raceWarn } : {}),
        }
      }
    }

    const holderBy = res.holder && res.holder.by ? res.holder.by : 'другой терминал'
    raceWarn = `слот ${slotName} уже занят (${holderBy}) — выдан следующий свободный номер`
    appendEvent(
      { type: 'warn', scope: slotName, detail: { lostTo: holderBy, kind } },
      { terminalId, ...journalOpt(o) },
    )
    candidate += 1
  }

  return {
    kind,
    number: candidate,
    id: spec.format(candidate),
    won: false,
    warn: raceWarn ?? `не удалось занять слот ${spec.slotPrefix} за 5 попыток`,
  }
}

// ── 49.1-23 (B17) — consume: mark a claimed number as ACTUALLY used ──────────────────

/**
 * slotNameForKind(kind, n, o) -> the claim-dir name for a number slot, or null when the
 * kind is unknown or a required input (decision --phase) is missing. Mirrors the slot
 * names minted by nextMigrationSlot / nextCounterSlot so `consume` targets the right dir.
 */
export function slotNameForKind(kind, n, o = {}) {
  if (kind === 'migration') return `migration-${padMigration(n)}`
  if (kind === 'bl' || kind === 'action' || kind === 'phase') return `${kind}-${n}`
  if (kind === 'decision') return o.phase ? `decision-${o.phase}-${n}` : null
  return null // release is git-tag based (no persisted number slot); unknown -> null
}

/**
 * markSlotConsumed(kind, n, o) — mark the number slot consumed so reconcile never
 * reclaims it. Thin wrapper over claims.markConsumed with the kind->slot-name mapping.
 * @returns {{consumed:boolean, reason?:string, slot?:string}}
 */
export function markSlotConsumed(kind, n, o = {}) {
  const name = slotNameForKind(kind, n, o)
  if (!name) return { consumed: false, reason: kind === 'decision' ? 'decision-requires-phase' : 'unknown-kind' }
  const res = markConsumed(name, o.claimsDir ? { claimsDir: o.claimsDir } : {})
  return { ...res, slot: name }
}
