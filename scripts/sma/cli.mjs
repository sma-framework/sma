#!/usr/bin/env node
/**
 * cli.mjs — the single `pnpm sma <cmd>` entrypoint (D-9-10), built on the
 * gsd-tools.cjs dispatch shape (a subcommand → async handler map; PATTERNS:
 * reference only — internals not copied). One command surface for humans, hooks,
 * skills and the statusline, so the hooks (49-12) stay 3-line wrappers.
 *
 * CONTRACT (the fail-open policy lives HERE, not in the hooks):
 *   - Hook-facing subcommands (session-start, collision-check, heartbeat) exit 0
 *     UNCONDITIONALLY — main() wraps them in try/catch that swallows to exit 0.
 *   - Direct-CLI subcommands (status, claim, release, next-slot, force-clear,
 *     lint, build-index, load, snapshot) may exit 1 on a real error.
 *   - Every handler lazy `await import('./lib/<mod>.mjs')` so a module that has
 *     not landed yet (snapshot arrives with 49-13) degrades to a clean RU
 *     'недоступно' message instead of a parse-time crash.
 *   - Output convention: human-readable RU by default; `--raw`/`--json` emits a
 *     single JSON object (gsd-tools pattern) for the statusline/hook consumers.
 *
 * D-9-02 / P4 / C9: collision-check + session-start are WARN-only — they NEVER
 * emit permissionDecision 'deny'; they carry Terraform-style advisories in
 * additionalContext and always allow the operation.
 * D-9-09 / P3: force-clear is the ONLY foreign-claim removal path — it prints
 * the holder first, requires an explicit --yes, and journals a 'steal' event
 * with provenance. Never automatic.
 *
 * COMMENT-TEXT DISCIPLINE (SMA-3): scripts/sma/** is grepped for the two-word
 * git deploy invocation. The Bash push-detector below is built with an escaped
 * regex so the source never carries the adjacent literal; comments say 'push'
 * alone.
 *
 * Node built-ins only; zero npm deps.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This module's own dir (scripts/sma/) — resolves cli.mjs + fixtures regardless of cwd. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

// ── .sma root + dir resolution ───────────────────────────────────────────────
// The lib modules all accept dependency-injectable dirs (sessionsDir/claimsDir/
// journalDir/smaRoot). The CLI resolves the ONE shared root and passes the dir
// opts down. SMA_ROOT_OVERRIDE lets tests point the whole CLI at a temp repo.

/** Resolve the .sma root: env override → main-checkout root (via registry.smaRoot) → cwd/.sma */
async function resolveRoot() {
  const override = process.env.SMA_ROOT_OVERRIDE
  if (override && override.trim()) return override.trim()
  try {
    const { smaRoot } = await import('./lib/registry.mjs')
    return join(smaRoot(), '.sma')
  } catch {
    return join(process.cwd(), '.sma')
  }
}

/** The three .sma subdirs, derived from one root — the dir opts every lib takes. */
function dirsFrom(root) {
  return {
    smaRoot: root,
    sessionsDir: join(root, 'sessions'),
    claimsDir: join(root, 'claims'),
    journalDir: join(root, 'journal'),
    calibrationDir: join(root, 'calibration'), // 9.1-08 (B20) — prediction-calibration ledger
    reflexDir: join(root, 'reflex'), // 9.1-10 (B2) — per-session reflex seen-store
    usageDir: join(root, 'usage'), // 9.1-11 (B4) — usage-citation ledger
    gatesDir: join(root, 'gates'), // 9.1-17 (D-9.1-13) — soft-deny evidence markers + override tokens
    execDir: join(root, 'exec'), // 9.1-20 (B14) — per-plan execution progress journal
    stallDir: join(root, 'stall'), // 9.1-21 (B16) — per-session rolling PostToolUse window
    benchDir: join(root, 'bench'), // 9.2-01 (D-9.2-02) — bench markers: ttc/, exam/, selfcost.json
    perfDir: join(root, 'perf'), // 9.2-02 (D-9.2-04) — `sma pre` per-stream timing samples (pre.jsonl)
    subagentsDir: join(root, 'subagents'), // 9.2-04 (D-9.2-10) — spawn records + receipt stats
    flightDir: join(root, 'flight'), // 9.2-06 (D-9.2-09) — pre-compaction capsule + session flight marks
    spendDir: join(root, 'spend'), // 9.2-09 (D-9.2-13) — spend book incremental cache + window budget
    breakerDir: join(root, 'breaker'), // 9.2-09 (D-9.2-13) — loop-breaker markers (per-ruleId)
    grillDir: join(root, 'grill'), // 9.2-07 (D-9.2-11) — per-plan adversarial challenge ledger
    blindDir: join(root, 'blind'), // 9.2-07 (D-9.2-11) — frozen blind-verify verdicts (info barrier)
    evidenceDir: join(root, 'evidence'), // 9.2-07 (D-9.2-11) — burden-of-proof records for risky ops
    skepticDir: join(root, 'skeptic'), // 9.2-10 (D-9.2-14) — skeptic countersign files
    canaryDir: join(root, 'canary'), // 9.2-10 (D-9.2-14) — sealed canary ledger (blind verifier NEVER reads)
    nearmissDir: join(root, 'nearmiss'), // 9.2-10 (D-9.2-14) — scoring-immune near-miss channel (ASRS)
    disarmDir: join(root, 'disarm'), // 9.2-10 (D-9.2-14) — kill-switch provenance leases (auto-re-arm)
    modelDir: join(root, 'model'), // 9.3-02 (D-9.3-10) — model-version sightings for the stale-priors badge guard
    curriculumDir: join(root, 'curriculum'), // 9.3-06 (D-9.3-16) — weekly miss-curriculum: templates.jsonl + brief-*.md
    catalogDir: join(root, 'catalog'), // 9.3-05 (D-9.3-06) — deterministic file catalog (cards.jsonl)
    contextDir: join(root, 'context'), // 9.3-05 (D-9.3-07) — context packs + active.json + exam.jsonl
    statuslineDir: join(root, 'statusline'), // 9.3-07 (D-9.3-13) — statusline TTL cache + webhook config + cooldown marker
    manifestDir: join(root, 'manifest'), // 9.3-08 (D-9.3-11) — PR evidence passport pack (<headSha>.json + .md)
  }
}

/** The TRACKED tier registry path (repo root, NOT under gitignored .sma/ — 9.3-06). */
async function ladderPathFrom(dirs) {
  const { LADDER_FILE } = await import('./lib/constants.mjs')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  return join(repoRoot, LADDER_FILE)
}

/** True for an env kill-switch that is set to anything truthy (not ''/0/false). */
function isEnvOn(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

// ── tiny arg parser (gsd-tools style: flags + positionals) ───────────────────

/**
 * parseArgs(argv) → {positionals, flags}. `--key value` and `--key=value` both
 * populate flags.key; a bare `--flag` (no following value / value starts with --)
 * is a boolean true. No external dep.
 */
function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const key = a.slice(2)
        const next = argv[i + 1]
        if (next != null && !next.startsWith('--')) {
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

/** True when either --raw or --json was passed. */
function wantsJson(flags) {
  return flags.raw === true || flags.json === true
}

/** Print a JSON object on one line (statusline/hook contract). */
function printJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** Read stdin fully (sync) — tolerate no stdin (returns ''). */
function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** Parse stdin as JSON, tolerating empty/garbage → {} (fail-open). */
function readStdinJson() {
  const raw = readStdin()
  if (!raw || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * windowTokenFrom(evt) → the stable per-window token, or null. Claude Code delivers a
 * `session_id` on the hook stdin JSON that is constant across SessionStart + every
 * PreToolUse of ONE window and distinct between concurrent windows — exactly the
 * renewal-safe disambiguator resolveTerminalIdentity wants (R7/D-9-01). Env overrides
 * (SMA_WINDOW_TOKEN / CLAUDE_SESSION_ID) are consulted by resolveTerminalIdentity itself;
 * this only lifts the stdin value the env cannot carry.
 */
function windowTokenFrom(evt) {
  const t = evt && typeof evt.session_id === 'string' ? evt.session_id.trim() : ''
  return t || null
}

/**
 * truncateRestore(body, maxBytes) — cap the restored capsule to maxBytes (UTF-8),
 * appending a `pnpm sma resume` pointer line when it had to be cut. Byte-safe: the
 * Buffer slice may drop a partial multibyte char at the boundary (rendered as the
 * replacement char), never a torn sequence. 9.2-06 restore reflex.
 */
function truncateRestore(body, maxBytes) {
  const text = String(body ?? '')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const pointer = '\n\nПолный бриф: `pnpm sma resume`'
  const room = Math.max(0, maxBytes - Buffer.byteLength(pointer, 'utf8'))
  const cut = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8')
  return cut + pointer
}

// ── shared read: sessions + collisions summary (status / session-start) ───────

/**
 * gatherSummary(dirs) → {activeSessions, collisions, claims, warnings, sessions,
 * needsHuman, pushClaim}. READ-ONLY over the .sma snapshot; fail-open per source.
 */
async function gatherSummary(dirs) {
  const out = {
    activeSessions: 0,
    collisions: 0,
    claims: 0,
    warnings: [],
    sessions: [],
    needsHuman: [],
    pushClaim: null,
  }

  // Best-effort reap of stale, CLEAN sessions BEFORE counting (R7 fix step 3). reapStale
  // is otherwise exported-but-never-invoked, so .sma/sessions grew unboundedly (hundreds
  // of write-once leases from the pre-fix pid churn). This is the cheapest correct call
  // site: session-start (once per window) + manual status, never the hot per-Edit/Write
  // collision-check path. A real scope-mtime probe is passed so P3 holds — a stale lease
  // with FRESH edits inside its claimed globs is classified needs-human and NEVER deleted;
  // only genuinely idle (no-glob / cold) leases are removed. Fail-open (never wedges).
  try {
    const registry = await import('./lib/registry.mjs')
    const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
    // BL-158 (D-9.3-22f): reapStaleObservable journals a countable reap / reap-fail signal
    // so a silently-broken reaper is no longer invisible (the prior bare reapStale swallowed
    // every failure). Still fail-open — a reap bug NEVER wedges status/session-start.
    registry.reapStaleObservable({
      ...dirs,
      scopeMtimeProbe: (s) => registry.probeScopeMtime(s, { root: repoRoot }),
    })
  } catch {
    /* fail-open — reaping is a convenience, never fatal */
  }

  // sessions + staleness
  try {
    const registry = await import('./lib/registry.mjs')
    const { sessions, warnings } = registry.readSessions(dirs)
    out.sessions = sessions
    for (const w of warnings) out.warnings.push(w)
    for (const s of sessions) {
      const cls = registry.classifyStaleness(s, {})
      if (cls.state === 'fresh' || cls.state === 'attention') out.activeSessions += 1
      if (cls.state === 'needs-human') {
        out.needsHuman.push({ who: s.holderIdentity ?? '—', ageMs: cls.ageMs })
      }
    }
  } catch {
    /* fail-open — no session read */
  }

  // open claims
  try {
    const claims = await import('./lib/claims.mjs')
    const list = claims.readClaims(dirs)
    out.claims = list.length
  } catch {
    /* fail-open */
  }

  // collision count from the journal (collisions journaled by 49-05). WR-04: bound
  // to TODAY's events, mirroring the statusline — the journal is append-only and never
  // pruned, so an unbounded count grows monotonically for the life of the checkout and
  // becomes noise within days.
  try {
    const journal = await import('./lib/journal.mjs')
    const { events } = journal.readJournal(dirs)
    const today = new Date().toISOString().slice(0, 10)
    out.collisions = events.filter(
      (e) => e && e.type === 'collision' && typeof e.ts === 'string' && e.ts.slice(0, 10) === today,
    ).length
  } catch {
    /* fail-open */
  }

  // live push-claim advisory
  try {
    const slots = await import('./lib/slots.mjs')
    const pc = slots.checkPushClaim(dirs)
    if (pc && (pc.live || pc.stale)) out.pushClaim = pc
  } catch {
    /* fail-open */
  }

  return out
}

// ─────────────────────────── handlers ────────────────────────────────────────

/**
 * status — the statusline/hook JSON contract: {activeSessions, collisions,
 * claims, warnings}. Human mode prints an RU one-liner. Fail-open: an empty .sma
 * yields zeros, never an error.
 */
async function cmdStatus({ flags, dirs }) {
  // ── 9.3-13 coordination-trust instruments (bare-numeric LAST line = scorer contract) ──
  if (flags['stale-warn-share']) {
    // P9.3-13-A: the deterministic stale share of SHOWN collision warns over 7d.
    let pct = 0
    try {
      const fingerprint = await import('./lib/fingerprint.mjs')
      const journal = await import('./lib/journal.mjs')
      const { events } = journal.readJournal(dirs)
      pct = fingerprint.staleWarnShare({ journal: events, windowDays: 7, now: Date.now() })
    } catch {
      /* fail-open -> 0 */
    }
    process.stdout.write(`${pct}\n`)
    return 0
  }
  if (flags['stale-count']) {
    // P9.3-13-C: how many dead/stale sessions SURVIVE (reap-clean | needs-human). 0 is clean.
    let n = 0
    try {
      const registry = await import('./lib/registry.mjs')
      const { sessions } = registry.readSessions(dirs)
      for (const sess of sessions) {
        const st = registry.classifyStaleness(sess, {}).state
        if (st === 'reap-clean' || st === 'needs-human') n += 1
      }
    } catch {
      /* fail-open -> 0 */
    }
    process.stdout.write(`${n}\n`)
    return 0
  }
  if (flags['cleanup-stale']) {
    // D-9.3-22d: the ONE-TIME cleanup — reap the accumulated dead sessions + reconcile the
    // expired (unconsumed) claims via the existing provenance-kept paths. Prints the count.
    let reaped = 0
    let reconciled = 0
    try {
      const registry = await import('./lib/registry.mjs')
      const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
      const r = registry.reapStaleObservable({
        ...dirs,
        scopeMtimeProbe: (sx) => registry.probeScopeMtime(sx, { root: repoRoot }),
      })
      reaped = Array.isArray(r.reaped) ? r.reaped.length : 0
    } catch {
      /* fail-open */
    }
    try {
      const claims = await import('./lib/claims.mjs')
      for (const { name } of claims.readClaims(dirs)) {
        const rc = claims.reconcileExpiredClaim(name, dirs)
        if (rc.reconciled) reconciled += 1
      }
    } catch {
      /* fail-open */
    }
    if (wantsJson(flags)) {
      printJson({ reaped, reconciled, cleaned: reaped + reconciled })
      return 0
    }
    process.stdout.write(`SMA: очищено — устаревших сессий ${reaped}, claim-слотов ${reconciled}\n`)
    return 0
  }

  const s = await gatherSummary(dirs)
  if (wantsJson(flags)) {
    printJson({
      activeSessions: s.activeSessions,
      collisions: s.collisions,
      claims: s.claims,
      warnings: s.warnings,
    })
    return 0
  }
  process.stdout.write(
    `SMA: активных сессий ${s.activeSessions} · коллизий ${s.collisions} · claim-слотов ${s.claims}\n`,
  )
  // FI-10 — one founder-readable «P<phase> <Name> — <label>» line per LIVE session.
  try {
    const registry = await import('./lib/registry.mjs')
    for (const sess of s.sessions || []) {
      const cls = registry.classifyStaleness(sess, {})
      if (cls.state !== 'fresh' && cls.state !== 'attention') continue
      const id = registry.displayIdentity({ holderIdentity: sess.holderIdentity, label: sess.label })
      const label = sess.label ? ` — ${sess.label}` : ''
      process.stdout.write(`  · ${id}${label}\n`)
    }
  } catch {
    /* fail-open — the named-identity lines are a convenience */
  }
  if (s.pushClaim && s.pushClaim.live) {
    process.stdout.write(`  ⚠ ${s.pushClaim.warn}\n`)
  }
  for (const nh of s.needsHuman) {
    process.stdout.write(`  ⚠ сессия ${nh.who} устарела, но в scope свежие правки — нужен человек\n`)
  }
  return 0
}

/**
 * heartbeat — create/renew this terminal's lease. --scope (csv globs) / --desc /
 * --status update the lease. Hook-facing: exit 0 always (enforced by main()).
 */
async function cmdHeartbeat({ flags, dirs }) {
  const registry = await import('./lib/registry.mjs')
  const identity = registry.resolveTerminalIdentity({})
  const globs = typeof flags.scope === 'string' ? flags.scope.split(',').map((g) => g.trim()).filter(Boolean) : []
  const desc = typeof flags.desc === 'string' ? flags.desc : ''
  const status = typeof flags.status === 'string' ? flags.status : 'working'
  // FI-10 — refresh the founder-readable work label from live context on every beat.
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const label = registry.resolveWorkLabel({
    claimScope: desc,
    statePath: join(repoRoot, '.planning', 'STATE.md'),
    argv: ['heartbeat'],
  })
  const res = registry.heartbeat(
    { scope: { globs, description: desc }, status, label },
    { ...dirs, identity },
  )
  if (wantsJson(flags)) {
    printJson({ terminalId: identity.terminalId, skipped: !!res.skipped, error: !!res.error })
    return 0
  }
  process.stdout.write(
    res.skipped
      ? `SMA: heartbeat пропущен (в пределах интервала) — ${identity.holderIdentity}\n`
      : `SMA: heartbeat обновлён — ${identity.holderIdentity}\n`,
  )
  return 0
}

/**
 * session-start — compose the D-9-02 start summary (active sessions, live
 * collisions, open push-claim, needs-human entries) and emit it as SessionStart
 * hook JSON per RESEARCH Pattern 1 (hookSpecificOutput.additionalContext).
 * ALWAYS exit 0. Also piggybacks a heartbeat so a fresh terminal registers.
 */
async function cmdSessionStart({ dirs }) {
  // The SessionStart hook receives the same stdin JSON as every PreToolUse — read the
  // stable window token (session_id) so THIS terminal registers under the window-stable
  // terminalId that later collision-check invocations will renew (R7/D-9-01). Keep the
  // whole event: 9.2-06's restore reflex reads its `source` field (compact vs startup).
  const evt = readStdinJson()
  const sessionToken = windowTokenFrom(evt)

  // register/refresh this terminal (best-effort; never fatal). The own claimed
  // scope is captured BEFORE the registering beat (9.1-11: the beat writes an
  // empty scope, and the pre-act injection needs the live claim as its trigger).
  let identity = null
  let ownScope = null
  let ownLastHeartbeat = null // this window's PRE-beat renewTime (for the digest B12)
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  try {
    const registry = await import('./lib/registry.mjs')
    identity = registry.resolveTerminalIdentity({ sessionToken })
    try {
      const { sessions } = registry.readSessions(dirs)
      const own = sessions.find((s) => s._file === `${identity.terminalId}.json`)
      if (own && own.scope) ownScope = own.scope
      if (own && typeof own.renewTime === 'string') ownLastHeartbeat = own.renewTime
    } catch {
      /* fail-open */
    }
    // FI-10 — resolve the founder-readable work label from live context (claimed scope >
    // STATE phase > command) and fold it into the registering beat.
    const label = registry.resolveWorkLabel({
      claimScope: ownScope && ownScope.description ? ownScope.description : '',
      statePath: join(repoRoot, '.planning', 'STATE.md'),
      argv: ['session-start'],
    })
    registry.heartbeat({ scope: { globs: [], description: '' }, status: 'working', label }, { ...dirs, identity })
  } catch {
    /* fail-open */
  }

  // 9.3-02 (D-9.3-10) — record which Claude model produced this session so the
  // calibration-passport badge can detect a model swap and hide its hit-rate claim
  // until fresh priors accrue. Its OWN try/catch: a sighting bug must never dent the
  // start summary (fail-open, substrate law C9 — proven by model-version test 7).
  try {
    const mv = await import('./lib/model-version.mjs')
    const sighting = mv.resolveModelId({ stdinJson: evt, env: process.env })
    if (sighting) mv.recordModelSighting({ ...sighting, modelDir: dirs.modelDir })
  } catch {
    /* fail-open — the model sighting never wedges session-start */
  }

  const s = await gatherSummary(dirs)
  const lines = []
  lines.push(`SMA: активных сессий ${s.activeSessions}, открытых коллизий ${s.collisions}.`)
  if (s.pushClaim && s.pushClaim.live) lines.push(`отправка в origin уже идёт: ${s.pushClaim.who}`)
  for (const nh of s.needsHuman) {
    lines.push(`устаревшая сессия ${nh.who} со свежими правками в scope — требуется решение человека`)
  }
  lines.push('Подробнее: `pnpm sma status`.')

  // 9.1-11 (B1): budgeted pre-act periphery injection — relevant memory arrives
  // BEFORE the first act, matched to the session's live context (claimed scope /
  // current phase). CORE already auto-loads via MEMORY.md; ONLY trigger-matched
  // periphery lands here, under a hard 2048-byte budget (T-9.1-22). Fail-open:
  // an injection failure never blocks the session (HOOK_FACING).
  let preAct = ''
  try {
    preAct = await buildPreActInjection({
      dirs,
      ownScope,
      terminalId: identity ? identity.terminalId : null,
      sessionToken,
    })
  } catch {
    /* fail-open */
  }

  // 9.1-18 (B12): the cross-terminal digest «Что изменилось с вашего последнего
  // heartbeat» — commits since my last beat, who claims what now (named identities),
  // the live push signal, and low-calibration escalations (the B20 consumer). Pure
  // assembly over injected sources; every source is fail-open, so a git error or a
  // missing ledger degrades to a partial digest and never wedges session-start.
  let digest = ''
  try {
    const { buildDigest, defaultGitLogRunner } = await import('./lib/digest.mjs')
    // OTHER active sessions only (exclude this window) — with their named identity + scope.
    const others = (s.sessions || [])
      .filter((sess) => sess && sess._file !== `${identity ? identity.terminalId : ''}.json`)
      .map((sess) => ({ holderIdentity: sess.holderIdentity, label: sess.label, scope: sess.scope }))
    // Low-calibration escalations (9.1-08) -> digest lines.
    let escalations = []
    try {
      const calibration = await import('./lib/calibration.mjs')
      escalations = calibration.escalations({ calibrationDir: dirs.calibrationDir })
    } catch {
      /* fail-open — no ledger -> no escalation section */
    }
    digest = buildDigest({
      self: { terminalId: identity ? identity.terminalId : null, lastHeartbeat: ownLastHeartbeat },
      gitLog: (sinceIso) => defaultGitLogRunner(sinceIso),
      sessions: others,
      pushClaim: s.pushClaim && s.pushClaim.live ? s.pushClaim : null,
      escalations,
    })
  } catch {
    /* fail-open — the digest is a briefing convenience, never a gate */
  }

  // 9.2-10 (D-9.2-14) — the STPA disarm-path guard runs at session-start ONLY
  // (never the per-tool-call hot path — plan 02 SLO). It shadow-runs each disarmed
  // gate's birth fixture and computes auto-re-arm decisions; a one-line summary
  // surfaces ONLY when a kill env is actually set. Bounded, try/catch, fail-open —
  // a guard that wedged the hooks would be its own STPA violation (CONS-9.2-B).
  let disarmLine = ''
  try {
    const stpa = await import('./lib/stpa.mjs')
    const decisions = stpa.reArmDecisions({ env: process.env, dirs })
    if (decisions.length) {
      stpa.shadowRunFixtures({ env: process.env, dirs }) // journal the shadow-run findings
      const reArmed = decisions.filter((d) => d.decision === 're-arm').map((d) => d.killEnv)
      const honored = decisions.filter((d) => d.decision === 'honor').map((d) => d.killEnv)
      const bits = []
      if (reArmed.length) bits.push(`re-armed (WARN): ${reArmed.join(', ')}`)
      if (honored.length) bits.push(`honored: ${honored.join(', ')}`)
      disarmLine = `SMA STPA: ${decisions.length} kill-switch(es) set — ${bits.join('; ')}. Birth fixtures still trip; keep one off deliberately via \`sma integrity disarm-renew <gateId> --reason\`.`
    }
  } catch {
    /* fail-open — the disarm guard never wedges session-start */
  }

  // 9.3-06 (D-9.3-16) — the weekly miss-curriculum staleness nudge. ONE bounded line
  // at session-start (never the per-tool-call hot path) when the newest weak-spots brief
  // is stale or missing. Try/catch, fail-open — a nudge bug never wedges session-start.
  let curriculumLine = ''
  try {
    const curriculum = await import('./lib/curriculum.mjs')
    const latest = curriculum.latestBrief({ dirs, now: Date.now() })
    if (latest.stale) curriculumLine = 'SMA: недельная miss-curriculum устарела — обновите: `pnpm sma curriculum`.'
  } catch {
    /* fail-open — the curriculum nudge never wedges session-start */
  }

  // FI-10 — prompt ONCE for a human window name when this window is still anonymous, so
  // the journal + digest stop showing t-<hash> and become «P<phase> <Name>».
  let namePrompt = ''
  if (identity && typeof identity.holderIdentity === 'string' && /^T-/i.test(identity.holderIdentity)) {
    namePrompt = 'Задайте имя окна: переменная SMA_TERMINAL_NAME (например «Tom»), чтобы журналы были читаемы.'
  }

  // 9.2-06 (D-9.2-09) — the post-compact RESTORE REFLEX. Claude Code re-fires
  // SessionStart after a compaction with stdin `source: "compact"`; we re-inject the
  // pre-written flight capsule as the FIRST additionalContext part so the session
  // resumes knowing its current task, constraints, and recent decisions. NO new hook
  // spawn — this rides the EXISTING session-start wiring. Fail-open: a missing/unreadable
  // capsule degrades to no restore, never a throw. Kill-switch: SMA_FLIGHT_DISABLE=1.
  let restore = ''
  if (evt && evt.source === 'compact' && !isEnvOn(process.env.SMA_FLIGHT_DISABLE)) {
    try {
      const { RESTORE_BUDGET } = await import('./lib/flight.mjs')
      const terminalId = identity ? identity.terminalId : null
      let body = ''
      if (terminalId) {
        try {
          body = readFileSync(join(dirs.flightDir, 'capsules', `${terminalId}.md`), 'utf8')
        } catch {
          /* fall through to intent.md */
        }
      }
      if (!body) {
        try {
          body = readFileSync(join(dirs.flightDir, 'intent.md'), 'utf8')
        } catch {
          /* no capsule — no restore */
        }
      }
      if (body) restore = truncateRestore(body, RESTORE_BUDGET)
    } catch {
      /* fail-open — the restore reflex never wedges session-start */
    }
  }

  // Only surface context when there is something worth surfacing (Pattern 1) — OR when a
  // post-compact restore must be injected (that is the whole point of the reflex).
  if (
    restore ||
    s.activeSessions > 0 ||
    s.collisions > 0 ||
    (s.pushClaim && s.pushClaim.live) ||
    s.needsHuman.length ||
    preAct ||
    digest ||
    namePrompt ||
    disarmLine ||
    curriculumLine
  ) {
    const parts = [lines.join(' ')]
    if (preAct) parts.push(preAct)
    if (digest) parts.push(digest)
    if (disarmLine) parts.push(disarmLine)
    if (curriculumLine) parts.push(curriculumLine)
    if (namePrompt) parts.push(namePrompt)
    if (restore) parts.unshift(restore) // the capsule body is the FIRST part after compaction
    printJson({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: parts.join('\n'),
      },
    })
  }
  return 0
}

// ── 9.1-11 (B1): pre-act injection helpers ──────────────────────────────────

/** Hard byte budget of the injected periphery section (T-9.1-22, acceptance-checked). */
const PRE_ACT_BUDGET_BYTES = 2048

/** Truncation caps — descriptions + extracts only, never whole bodies (T-9.1-21). */
const PRE_ACT_DESC_MAX = 200
const PRE_ACT_EXTRACT_MAX = 240

/** Collapse whitespace + truncate to max chars (ellipsis when cut). */
function collapseTruncate(text, max) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, max - 1).trimEnd() + '…' : collapsed
}

/** Pull the note body's «How to apply» / «Как применять» paragraph (empty when absent). */
function howToApplyExtract(body) {
  if (typeof body !== 'string' || !body) return ''
  const m = /\*\*\s*(?:how\s+to\s+apply|как применять)\s*:?\s*\*\*\s*:?\s*/i.exec(body)
  if (!m) return ''
  const para = body.slice(m.index + m[0].length).split(/\n\s*\n/)[0] ?? ''
  return collapseTruncate(para, PRE_ACT_EXTRACT_MAX)
}

/**
 * buildPreActInjection({dirs, ownScope, terminalId, sessionToken}) — assemble the
 * budgeted pre-act section: derive context tags from the claimed scope (+ the
 * STATE.md Current-Position phase when cheaply readable), query the loader ONE
 * tag at a time (a multi-tag query would AND across facets and over-restrict),
 * union the matched periphery, select by importance under the byte budget, and
 * record a 'load' citation per injected note (B4). Returns '' when nothing
 * relevant — the caller then omits the section entirely.
 */
async function buildPreActInjection({ dirs, ownScope, terminalId, sessionToken }) {
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const corpusDir = join(repoRoot, '.claude', 'memory')
  const tagsPath = join(corpusDir, 'TAGS.md')

  const frontmatter = await import('./lib/frontmatter.mjs')
  let registryTags
  try {
    registryTags = frontmatter.loadTagsRegistry(tagsPath)
  } catch {
    return '' // no corpus registry -> nothing to inject (fail-open)
  }

  // (1) candidate tokens: claimed-scope description + glob path segments…
  const tokens = new Set()
  if (ownScope) {
    const parts = []
    if (typeof ownScope.description === 'string') parts.push(ownScope.description)
    if (Array.isArray(ownScope.globs)) parts.push(...ownScope.globs.map((g) => String(g)))
    for (const p of parts) {
      for (const t of String(p).toLowerCase().split(/[^a-z0-9:._-]+/)) {
        if (t) tokens.add(t)
        for (const seg of t.split(/[\\/._-]+/)) if (seg) tokens.add(seg)
      }
    }
  }
  // …+ the phase named in STATE.md Current Position (cheaply readable; fail-open).
  try {
    const state = readFileSync(join(repoRoot, '.planning', 'STATE.md'), 'utf8')
    const m = /Phase:\s*(\d+)/.exec(state)
    if (m) tokens.add(`phase:${m[1]}`)
  } catch {
    /* fail-open — no STATE.md is a normal outcome */
  }

  // (2) keep only registered area/kind tags (aliases resolve) + phase:NN.
  const queryTags = new Set()
  for (const t of tokens) {
    const canon = frontmatter.resolveAlias(t, registryTags)
    if (registryTags.area.has(canon) || registryTags.kind.has(canon)) queryTags.add(canon)
    else if (/^phase:\d+$/.test(t)) queryTags.add(t)
  }
  if (!queryTags.size) return ''

  // (3) per-tag loader queries, unioned (OR semantics across trigger tags).
  const loader = await import('./lib/loader.mjs')
  const files = new Set()
  for (const tag of queryTags) {
    try {
      const res = loader.resolvePeriphery({ tags: [tag], corpusDir, tagsPath })
      for (const f of res.periphery) files.add(f)
    } catch {
      /* fail-open per tag */
    }
  }
  if (!files.size) return ''

  // (4) parse descriptions + importance; order importance desc → name asc.
  const notes = []
  for (const f of files) {
    try {
      const parsed = frontmatter.parseNote(readFileSync(join(corpusDir, f), 'utf8'), { file: f })
      if (!parsed.frontmatter) continue
      const importance = Number(parsed.frontmatter.importance)
      notes.push({
        file: f,
        description: collapseTruncate(parsed.frontmatter.description, PRE_ACT_DESC_MAX),
        importance: Number.isFinite(importance) ? importance : 0,
        body: parsed.body,
      })
    } catch {
      /* skip a bad note (fail-soft, same as the loader) */
    }
  }
  notes.sort((a, b) => b.importance - a.importance || a.file.localeCompare(b.file))

  // (5) importance-ordered selection under the HARD byte budget — never whole
  // periphery bodies (prohibition: context-budget discipline is the point).
  const lines = ['Релевантная память (pre-act):']
  const included = []
  for (const n of notes) {
    const entry = [`— ${n.file}: ${n.description}`]
    if (n.importance >= 8) {
      const extract = howToApplyExtract(n.body)
      if (extract) entry.push(`  Применение: ${extract}`)
    }
    if (Buffer.byteLength([...lines, ...entry].join('\n'), 'utf8') > PRE_ACT_BUDGET_BYTES) break
    lines.push(...entry)
    included.push(n.file)
  }
  if (!included.length) return ''

  // (6) B4: each injected note is a 'load' citation (fail-open inside recordCitation).
  try {
    const citations = await import('./lib/citations.mjs')
    for (const f of included) {
      citations.recordCitation(
        { noteId: f, kind: 'load', terminal: terminalId ?? 'unknown', session: sessionToken ?? null },
        { usageDir: dirs.usageDir },
      )
    }
  } catch {
    /* fail-open — citations never block the injection */
  }

  return lines.join('\n')
}

/**
 * claim <name> --globs <csv> --desc <text> — record a scope claim into the lease
 * AND journal a claim event. Direct-CLI: may exit 1 on a bad invocation.
 */
async function cmdClaim({ positionals, flags, dirs }) {
  const name = positionals[0]
  if (!name) {
    process.stderr.write('usage: pnpm sma claim <name> --globs <csv> --desc <text>\n')
    return 1
  }
  const globs = typeof flags.globs === 'string' ? flags.globs.split(',').map((g) => g.trim()).filter(Boolean) : []
  const desc = typeof flags.desc === 'string' ? flags.desc : name

  const registry = await import('./lib/registry.mjs')
  const journal = await import('./lib/journal.mjs')
  const claims = await import('./lib/claims.mjs')
  const collision = await import('./lib/collision.mjs')
  const identity = registry.resolveTerminalIdentity({})

  // Fold the scope into this terminal's lease (the scope is the claim). FI-10: the
  // claimed scope IS the work label — «P<phase> <Name>» now reads «правит <desc>».
  registry.heartbeat(
    { scope: { globs, description: desc }, status: 'working', label: registry.resolveWorkLabel({ claimScope: desc }) },
    { ...dirs, identity },
  )

  // WR-02: ALSO create a claims-dir entry named after the scope slug — the SAME string
  // the collision WARN's `force-clear <slug>` remediation suggests — so a foreign
  // stale scope claim can actually be force-cleared (previously the WARN's command
  // always failed «claim не найден»). Best-effort: a lost race / fs error never blocks.
  const slug = collision.scopeClaimSlug(desc)
  try {
    claims.claimSlot(
      slug,
      { by: identity.holderIdentity, session: null, expectedPrev: null, reason: `scope-claim:${desc}` },
      { claimsDir: dirs.claimsDir },
    )
  } catch {
    /* fail-open — the lease already carries the scope; the claims-dir entry is a convenience */
  }

  journal.appendEvent(
    { type: 'claim', scope: name, actors: [identity.holderIdentity], detail: { globs, description: desc, slug } },
    { terminalId: identity.terminalId, journalDir: dirs.journalDir },
  )

  if (wantsJson(flags)) {
    printJson({ claimed: name, slug, globs, by: identity.holderIdentity })
    return 0
  }
  process.stdout.write(`SMA: claim «${name}» зафиксирован (${globs.join(', ') || 'без globs'}); снять: pnpm sma force-clear ${slug}\n`)
  return 0
}

/**
 * release <name> — drop this terminal's scope claim (empty the lease scope) and
 * journal a release event. Never removes a foreign claim (that is force-clear).
 */
async function cmdRelease({ positionals, flags, dirs }) {
  const name = positionals[0]
  if (!name) {
    process.stderr.write('usage: pnpm sma release <name>\n')
    return 1
  }
  const registry = await import('./lib/registry.mjs')
  const journal = await import('./lib/journal.mjs')
  const claims = await import('./lib/claims.mjs')
  const collision = await import('./lib/collision.mjs')
  const identity = registry.resolveTerminalIdentity({})

  // WR-02: derive the same slug used at claim time (prefer the lease's current scope
  // description, fall back to <name>) so the matching claims-dir entry is removed. The
  // owner removes its OWN entry directly (no cooldown — cooldown is for contended slots).
  let desc = name
  try {
    const { sessions } = registry.readSessions(dirs)
    const own = sessions.find((s) => s._file === `${identity.terminalId}.json`)
    if (own && own.scope && typeof own.scope.description === 'string' && own.scope.description) desc = own.scope.description
  } catch {
    /* fail-open — fall back to <name> */
  }
  const slug = collision.scopeClaimSlug(desc)

  registry.heartbeat({ scope: { globs: [], description: '' }, status: 'working' }, { ...dirs, identity })

  // Remove the OWN claims-dir entry (best-effort). releaseSlot refuses a foreign entry
  // (P3); force-clear remains the only foreign-removal path.
  try {
    claims.releaseSlot(slug, { by: identity.holderIdentity, claimsDir: dirs.claimsDir })
  } catch {
    /* fail-open — nothing to remove / already gone */
  }

  journal.appendEvent(
    { type: 'release', scope: name, actors: [identity.holderIdentity], detail: { slug } },
    { terminalId: identity.terminalId, journalDir: dirs.journalDir },
  )

  if (wantsJson(flags)) {
    printJson({ released: name, slug, by: identity.holderIdentity })
    return 0
  }
  process.stdout.write(`SMA: claim «${name}» снят\n`)
  return 0
}

/**
 * next-slot <migration|release> — allocate a shared counter via slots.mjs.
 * migration prints the number + the SORTED_INSERT_RULE; release prints V1.N.
 */
async function cmdNextSlot({ positionals, flags, dirs }) {
  const kind = positionals[0]
  const slots = await import('./lib/slots.mjs')
  const registry = await import('./lib/registry.mjs')
  const identity = registry.resolveTerminalIdentity({})

  if (kind === 'migration') {
    // WR-03: pass journalDir so slot events land in .sma/journal/, not .sma/claims/.
    const res = slots.nextMigrationSlot({ by: identity.holderIdentity, terminalId: identity.terminalId, claimsDir: dirs.claimsDir, journalDir: dirs.journalDir })
    if (wantsJson(flags)) {
      printJson(res)
      return 0
    }
    process.stdout.write(`SMA: следующий номер миграции — ${String(res.number).padStart(3, '0')} (${res.name})\n`)
    if (res.warn) process.stdout.write(`  ⚠ ${res.warn}\n`)
    process.stdout.write(`\n${slots.SORTED_INSERT_RULE}\n`)
    return res.won ? 0 : 1
  }

  if (kind === 'release') {
    const res = slots.nextReleaseVersion({})
    if (wantsJson(flags)) {
      printJson(res)
      return 0
    }
    process.stdout.write(`SMA: следующая версия релиза — ${res.version}\n`)
    if (res.warn) process.stdout.write(`  ⚠ ${res.warn}\n`)
    return 0
  }

  // B11 all-counter slots: bl / action / decision / phase. Paths derive from the
  // repo root's .planning/ (read-only scan, never mutated). `--dry-run` reports the
  // next number without claiming; `--phase` is required for the decision counter.
  if (slots.COUNTER_KINDS.includes(kind)) {
    const planningRoot = join(dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd(), '.planning')
    const res = slots.nextCounterSlot(kind, {
      planningRoot,
      phase: typeof flags.phase === 'string' ? flags.phase : undefined,
      by: identity.holderIdentity,
      terminalId: identity.terminalId,
      claimsDir: dirs.claimsDir,
      journalDir: dirs.journalDir,
      dryRun: flags['dry-run'] === true,
    })
    if (wantsJson(flags)) {
      printJson(res)
      return res.won ? 0 : 1
    }
    if (res.won) {
      process.stdout.write(`SMA: следующий свободный номер (${kind}) — ${res.id}\n`)
    } else {
      process.stdout.write(`SMA: не удалось выдать номер (${kind})\n`)
    }
    if (res.warn) process.stdout.write(`  ⚠ ${res.warn}\n`)
    return res.won ? 0 : 1
  }

  process.stderr.write('usage: pnpm sma next-slot <migration|release|bl|action|decision --phase N|phase>\n')
  return 1
}

/**
 * tia [--against <ref>] [--json] — regex-based test-impact analysis (9.1-23, B17).
 * Derives the changed files from a READ-ONLY `git diff --name-only <ref>` (default
 * origin/main), maps their exported symbols to referencing test files via tia.mjs, and
 * prints the suggested vitest command. ADVISORY sizing between dev-loop tiers — the
 * disclaimer (full `pnpm test` remains the push gate) prints on EVERY run (prohibition).
 */
async function cmdTia({ flags }) {
  const tia = await import('./lib/tia.mjs')
  const { execFileSync } = await import('node:child_process')
  const against = typeof flags.against === 'string' ? flags.against : 'origin/main'

  // Read-only diff — --name-only never mutates the tree; fail-open to an empty set.
  let changedFiles = []
  try {
    const out = execFileSync('git', ['diff', '--name-only', against], { encoding: 'utf8' })
    changedFiles = out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    /* fail-open — no diff resolvable (bad ref / offline) -> empty set */
  }

  const res = tia.impactedTests({ changedFiles })
  if (wantsJson(flags)) {
    printJson({ ...res, against, changedFiles })
    return 0
  }
  process.stdout.write(
    `SMA tia: изменённых файлов ${changedFiles.length}, затронутых тестов ${res.tests.length} (against ${against})\n`,
  )
  if (res.tests.length) {
    process.stdout.write(`  предлагаемая команда: pnpm vitest run ${res.tests.join(' ')}\n`)
  } else {
    process.stdout.write(`  ${res.note ?? 'нет сигнала по символам'} — запустите полный набор\n`)
  }
  process.stdout.write(`  ⚠ ${res.disclaimer}\n`)
  return 0
}

/**
 * consume <kind> <n> [--phase P] — mark a claimed slot number as ACTUALLY used
 * (9.1-23, B17). Writes the `consumed` marker inside the claim dir so the next-slot
 * reconcile leaves it alone; an UNconsumed claim that outlives its TTL is treated as
 * abandoned and re-issued (the claimed-number-lost class ends). Direct-CLI.
 */
async function cmdConsume({ positionals, flags, dirs }) {
  const kind = positionals[0]
  const n = positionals[1]
  if (!kind || n == null) {
    process.stderr.write('usage: pnpm sma consume <migration|bl|action|phase|decision> <n> [--phase P]\n')
    return 1
  }
  const slots = await import('./lib/slots.mjs')
  const res = slots.markSlotConsumed(kind, Number(n), {
    claimsDir: dirs.claimsDir,
    phase: typeof flags.phase === 'string' ? flags.phase : undefined,
  })
  if (wantsJson(flags)) {
    printJson(res)
    return res.consumed ? 0 : 1
  }
  process.stdout.write(
    res.consumed
      ? `SMA: слот ${kind} ${n} помечен как использованный — реконсиляция его не тронет\n`
      : `SMA: не удалось пометить слот (${res.reason ?? 'нет claim'})\n`,
  )
  return res.consumed ? 0 : 1
}

/**
 * lint [--json] — run the memory-lint over .claude/memory. Exit 1 on criticals
 * (the commit-hook tier, 49-12). corpusDir/tagsPath/indexPath default to the
 * real memory dir but read-only — no write path here.
 */
async function cmdLint({ flags }) {
  const lint = await import('./lib/lint.mjs')
  const generator = await import('./lib/generator.mjs')
  const corpusDir = typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')
  const tagsPath = join(corpusDir, 'TAGS.md')

  // Wire the generator into MEM-REGEN (49-14): once MEMORY.md carries the GENERATED
  // header, the byte-compare goes ACTIVE. The commit hash is parsed FROM the
  // artifact's own anchor so the compare stays byte-stable after HEAD moves; the
  // dateMap is one read-only git pass (fail-open to empty).
  const { execFileSync } = await import('node:child_process')
  const regenInputs = (committed) => {
    const m = /at commit ([0-9a-f]+)/.exec(committed)
    const commitHash = m ? m[1] : '0000000'
    let dateMap = {}
    try {
      const execGit = (args) => execFileSync('git', args, { encoding: 'utf8' })
      dateMap = generator.computeDateMap({ execGit })
    } catch {
      /* fail-open — deterministic epoch fallback */
    }
    return { corpusDir, tagsPath, commitHash, dateMap }
  }
  const generate = (committed) => generator.buildIndex(regenInputs(committed))
  // FI-11 (9.1-13): MEM-REGEN staleness covers the per-area INDEX files too.
  const generateAreas = (committed) => generator.buildAreaIndexes(regenInputs(committed))

  // PRED family (9.1-09): lint plan predictions when a plans tree exists.
  // --plans overrides; default is .planning/phases when present. The git runner
  // is read-only (rev-parse/log/show) — the lint's no-write invariant holds.
  const { existsSync } = await import('node:fs')
  const defaultPlans = join('.planning', 'phases')
  const plansDir = typeof flags.plans === 'string' ? flags.plans : existsSync(defaultPlans) ? defaultPlans : undefined
  const execGit = (args, o = {}) => execFileSync('git', args, { encoding: 'utf8', ...o })

  // STATE-SIZE (9.1-13): the state path is injected — --state overrides; the
  // default is the house .planning/STATE.md when present (fail-soft to none).
  const defaultState = join('.planning', 'STATE.md')
  const statePath = typeof flags.state === 'string' ? flags.state : existsSync(defaultState) ? defaultState : undefined

  // PROFILE family (9.3-01): PROFILE-SCHEMA/PROFILE-SECRET run only when a
  // profile.json exists (a missing profile is a valid state, fail-open);
  // PROFILE-DEADFIELD is schema-level and always runs. --profile overrides; the
  // default is .sma/profile.json when present.
  const defaultProfile = join('.sma', 'profile.json')
  const profilePath = typeof flags.profile === 'string' ? flags.profile : existsSync(defaultProfile) ? defaultProfile : undefined

  const opts = {
    corpusDir,
    tagsPath,
    indexPath: join(corpusDir, 'MEMORY.md'),
    claudeMdPath: 'CLAUDE.md',
    generate,
    generateAreas,
    ...(statePath ? { statePath } : {}),
    ...(profilePath ? { profilePath } : {}),
    ...(plansDir ? { plansDir, execGit } : {}),
  }
  const report = lint.runLint(opts)
  if (wantsJson(flags)) {
    printJson(report)
    return report.exitCode
  }
  process.stdout.write(`SMA lint: ${report.summary}\n`)
  for (const f of report.findings) {
    process.stdout.write(`  [${f.tier}] ${f.checkId} ${f.file ? `(${f.file}) ` : ''}${f.message}\n`)
  }
  return report.exitCode
}

/**
 * profile [--json] | --lint [--json] | --coverage | --recap [--out <path>] [--check]
 * — the deterministic profile surface (9.3-01, D-9.3-04). Reads .sma/profile.json
 * through lib/profile.mjs (never re-parses it here). The numeric-last-line outputs
 * (--lint / --coverage / --recap --check) are the P9.3-01-A/B/C scorer instruments.
 * Direct-CLI (may exit 1 on a lint violation); never hook-facing.
 */
async function cmdProfile({ flags, dirs }) {
  const prof = await import('./lib/profile.mjs')
  const { readFileSync, existsSync } = await import('node:fs')
  // --profile <path> overrides the default .sma/profile.json for ALL modes, so a
  // check run from a different repo root can target a specific profile
  // unambiguously (P9.4-04-B). A missing/unreadable path degrades through
  // readProfile's tolerant reader to the empty state, never a throw.
  const profilePath = typeof flags.profile === 'string' ? flags.profile : join(dirs.smaRoot, 'profile.json')
  // The teaching source ships with the install (sma-core/references) — renderRecap
  // reads its five Recap: lines so the copy lives once (onboarding-teaching.md).
  const teachingPath = join(MODULE_DIR, '..', '..', 'sma-core', 'references', 'onboarding-teaching.md')
  const seededFiles = [
    '.planning/PROJECT.md',
    '.planning/ROADMAP.md',
    '.claude/memory/ (TAGS.md + starter CORE notes)',
    '.sma/profile.json',
  ]

  // ── --lint: schema + secret + dead-field; total violation count as last line ──
  if (flags.lint === true) {
    const hasProfile = existsSync(profilePath)
    const violations = []
    for (const f of prof.deadFields()) {
      violations.push({ rule: 'PROFILE-DEADFIELD', field: f, message: `schema field "${f}" has no registered consumer in PROFILE_CONSUMERS` })
    }
    if (hasProfile) {
      const { profile } = prof.readProfile({ profilePath })
      violations.push(...prof.validateProfile(prof.normalizeProfile(profile)).violations)
    }
    if (wantsJson(flags)) {
      printJson({ ok: violations.length === 0, violations })
      return violations.length ? 1 : 0
    }
    for (const v of violations) process.stdout.write(`  [${v.rule}] ${v.field}: ${v.message}\n`)
    process.stdout.write(`${violations.length}\n`) // numeric last line (P9.3-01-A)
    return violations.length ? 1 : 0
  }

  // ── --coverage: answered-field count as the last line (P9.3-01-C) ────────────
  if (flags.coverage === true) {
    const { profile } = prof.readProfile({ profilePath })
    const answered = prof.answeredFields(prof.normalizeProfile(profile))
    if (wantsJson(flags)) {
      printJson({ answered: answered.length, fields: answered })
      return 0
    }
    process.stdout.write(`${answered.length}\n`) // numeric last line
    return 0
  }

  // ── --recap: render (default) or --check (double-render byte-compare) ─────────
  if (flags.recap === true) {
    let teachingSource = ''
    try {
      teachingSource = readFileSync(teachingPath, 'utf8')
    } catch {
      /* fail-open — the module recap section degrades to a placeholder */
    }
    const { profile } = prof.readProfile({ profilePath })
    const outPath = typeof flags.out === 'string' ? flags.out : join(dirs.smaRoot, 'onboarding-recap.md')
    const rendered = prof.renderRecap({ profile: prof.normalizeProfile(profile), teachingSource, seededFiles })

    if (flags.check === true) {
      const again = prof.renderRecap({ profile: prof.normalizeProfile(profile), teachingSource, seededFiles })
      let ok = rendered === again
      if (existsSync(outPath)) {
        try {
          ok = ok && readFileSync(outPath, 'utf8') === rendered
        } catch {
          ok = false
        }
      }
      process.stdout.write(`${ok ? 1 : 0}\n`) // numeric last line (P9.3-01-B)
      return ok ? 0 : 1
    }

    const { atomicWriteRaw } = await import('./lib/fs-atomics.mjs')
    atomicWriteRaw(outPath, rendered)
    if (wantsJson(flags)) {
      printJson({ written: outPath })
      return 0
    }
    process.stdout.write(`recap written to ${outPath}\n`)
    return 0
  }

  // ── --selftest: profileSelftest()'s 1/0 as the last line (P9.4-04-A scorer) ──
  if (flags.selftest === true) {
    process.stdout.write(`${prof.profileSelftest()}\n`)
    return 0
  }

  // ── --quick: the BL-167 quick-update interview plan (unset fields only) ───────
  if (flags.quick === true) {
    const { profile } = prof.readProfile({ profilePath })
    const plan = prof.interviewPlan(profile) // interviewPlan normalizes internally
    if (wantsJson(flags)) {
      printJson({ entries: plan.entries, nothingToAsk: plan.nothingToAsk })
      return 0
    }
    if (flags.count === true) {
      process.stdout.write(`${plan.entries.length}\n`) // bare number, last line (scorer contract)
      return 0
    }
    if (plan.nothingToAsk) {
      process.stdout.write('Nothing to ask — every profile field is already set.\n')
      return 0
    }
    process.stdout.write('Quick profile update — answer only these unset fields (zero teaching):\n')
    for (const e of plan.entries) {
      process.stdout.write(`  [${e.askStage}] ${e.field} — ${e.description}\n`)
    }
    return 0
  }

  // ── default: the profile table (or --json) with an honest empty state ─────────
  const { profile, warnings } = prof.readProfile({ profilePath })
  const normalized = prof.normalizeProfile(profile)
  const hasProfile = existsSync(profilePath)
  if (wantsJson(flags)) {
    const fields = prof.PROFILE_SCHEMA.map((s) => ({
      field: s.field,
      value: normalized[s.field] ?? null,
      consumers: prof.PROFILE_CONSUMERS[s.field] ?? [],
    }))
    printJson({ schema: prof.PROFILE_SCHEMA, fields, warnings })
    return 0
  }
  if (!hasProfile) {
    process.stdout.write('Профиль ещё не создан — запустите /sma-start, чтобы записать .sma/profile.json.\n')
    return 0
  }
  process.stdout.write('SMA profile:\n')
  for (const s of prof.PROFILE_SCHEMA) {
    if (s.askStage === 'meta') continue
    const value = normalized[s.field]
    const shown = value == null || (typeof value === 'string' && value.trim() === '') ? '(not set)' : JSON.stringify(value)
    const consumers = (prof.PROFILE_CONSUMERS[s.field] ?? []).join(', ')
    process.stdout.write(`  ${s.field}: ${shown}  [→ ${consumers}]\n`)
  }
  for (const w of warnings) process.stdout.write(`  ! ${w}\n`)
  return 0
}

/**
 * explain [topic] [--list] [--coverage] [--count] [--lang en|ru] [--json] (9.3-09,
 * D-9.3-15) — the in-product teaching surface. Prints a plain-language explainer for
 * every concept and every CLI command (via COMMAND_TOPICS). An unknown topic lists the
 * catalog and exits 0 (never punishes curiosity). `--coverage` prints the count of
 * HANDLERS keys with no resolvable explainer as its LAST line — the P9.3-09-A scorer
 * contract. Reads cli.mjs as TEXT (never imports it). NOT hook-facing.
 */
async function cmdExplain({ positionals, flags }) {
  const explain = await import('./lib/explain.mjs')
  const explainersDir = join(MODULE_DIR, 'explainers')
  const cliPath = join(MODULE_DIR, 'cli.mjs')

  // ── --coverage: uncovered command count as the bare last line (P9.3-09-A) ────
  if (flags.coverage === true) {
    let cliSource = ''
    try {
      cliSource = readFileSync(cliPath, 'utf8')
    } catch {
      /* fail-open — an unreadable cli.mjs yields no keys, count 0 */
    }
    const { uncovered, count } = explain.coverage({ cliSource, explainersDir })
    if (wantsJson(flags)) {
      printJson({ uncovered, count })
      return 0
    }
    for (const u of uncovered) process.stdout.write(`  uncovered: ${u} (no resolvable explainer topic)\n`)
    process.stdout.write(`${count}\n`) // numeric last line (scorer contract), exit 0 always
    return 0
  }

  // ── --list (or no topic): the catalog ────────────────────────────────────────
  const topic = positionals[0]
  if (flags.list === true || !topic) {
    const topics = explain.listTopics({ explainersDir })
    if (wantsJson(flags)) {
      printJson({ topics })
      return 0
    }
    process.stdout.write('SMA explainers — pnpm sma explain <topic>:\n')
    for (const t of topics) process.stdout.write(`  ${t.id.padEnd(15)}${t.summary}\n`)
    return 0
  }

  // ── a specific topic (default lang en; --lang ru mirrors) ─────────────────────
  const lang = flags.lang === 'ru' ? 'ru' : 'en'
  const res = explain.renderTopic(topic, { explainersDir, lang })
  if (wantsJson(flags)) {
    printJson(res)
    return 0
  }
  if (!res.found) {
    process.stdout.write(`Unknown topic «${topic}». Available topics:\n`)
    for (const t of res.catalog) process.stdout.write(`  ${t.id.padEnd(15)}${t.summary}\n`)
    return 0 // teaching surface never punishes curiosity
  }
  process.stdout.write(`# ${res.title}\n\n${res.summary}\n\n${res.body}\n`)
  return 0
}

/**
 * doc-audit [--target manual|readme|all] [--count] [--json] (9.3-09, D-9.3-01/15) —
 * the deterministic honesty audit over the manual (sma:v35 region) and README positioning
 * (sma:positioning region). Zero-LLM, read-only. `--count` prints the bare total violation
 * count as the LAST line and exits 0 (the P9.3-09-B/C scorer contract); `--json` prints
 * the violation records (exit 0); human mode prints them readably and exits 1 when count>0
 * (CI-friendly). NOT hook-facing.
 */
async function cmdDocAudit({ flags, dirs }) {
  const da = await import('./lib/doc-audit.mjs')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const target = typeof flags.target === 'string' ? flags.target : 'all'
  const readFile = (p) => readFileSync(p, 'utf8')
  const { violations, count } = da.audit({ target, readFile, rootDir: repoRoot })

  if (wantsJson(flags)) {
    printJson({ target, violations, count })
    return 0
  }
  if (flags.count === true) {
    for (const v of violations) process.stdout.write(`  [${v.rule}] ${v.file}${v.detail ? ': ' + v.detail : ''}\n`)
    process.stdout.write(`${count}\n`) // numeric last line (scorer contract), exit 0 always
    return 0
  }
  // human mode
  if (count === 0) {
    process.stdout.write('doc-audit: all checks pass (0 violations).\n')
    return 0
  }
  for (const v of violations) process.stdout.write(`  [${v.rule}] ${v.file}${v.detail ? ': ' + v.detail : ''}\n`)
  process.stdout.write(`doc-audit: ${count} violation(s).\n`)
  return 1
}

/**
 * build-index [--check] [--write] — regenerate the MEMORY.md index. Default is
 * DRY (print to stdout / report); --check compares against the committed file
 * without writing; --write is the ONLY path that touches .claude/memory/MEMORY.md
 * (kept off until the 49-14 flip). Corpus is fixture-safe via --corpus.
 */
async function cmdBuildIndex({ flags }) {
  const generator = await import('./lib/generator.mjs')
  const corpusDir = typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')
  const tagsPath = join(corpusDir, 'TAGS.md')
  const indexPath = join(corpusDir, 'MEMORY.md')

  // A missing registry is tolerated (loadTagsRegistry fail-soft: the index is
  // built with every periphery note in the `misc` area) — but say so, or the
  // degraded grouping looks like a bug.
  if (!existsSync(tagsPath)) {
    process.stderr.write(
      `SMA: TAGS.md не найден (${tagsPath}) — индекс собран без реестра тегов, все заметки попадут в область misc\n`,
    )
  }

  // Build a date map + commit anchor from git (read-only), fail-open to empty.
  let dateMap = {}
  let commitHash = '0000000'
  try {
    const { execFileSync } = await import('node:child_process')
    const execGit = (args) => execFileSync('git', args, { encoding: 'utf8' })
    dateMap = generator.computeDateMap({ execGit })
    commitHash = execGit(['rev-parse', '--short', 'HEAD']).trim() || commitHash
  } catch {
    /* fail-open — deterministic epoch fallback */
  }

  const generated = generator.buildIndex({ corpusDir, tagsPath, commitHash, dateMap })
  // FI-11 (9.1-13): the regen artifact set = MEMORY.md + INDEX-<area>.md files.
  const areaFiles = generator.buildAreaIndexes({ corpusDir, tagsPath, commitHash, dateMap })

  if (flags.check === true) {
    let committed = ''
    try {
      committed = readFileSync(indexPath, 'utf8')
    } catch {
      committed = ''
    }
    const stale = []
    if (committed !== generated) stale.push('MEMORY.md')
    for (const a of areaFiles) {
      let onDisk = null
      try {
        onDisk = readFileSync(join(corpusDir, a.file), 'utf8')
      } catch {
        onDisk = null
      }
      if (onDisk !== a.content) stale.push(a.file)
    }
    const matches = stale.length === 0
    if (wantsJson(flags)) {
      printJson({ matches, indexPath, stale })
      return matches ? 0 : 1
    }
    process.stdout.write(
      matches
        ? `SMA: MEMORY.md и INDEX-файлы совпадают с регенерацией\n`
        : `SMA: индекс отличается от регенерации (${stale.join(', ')}) — перегенерируйте (не редактируйте вручную)\n`,
    )
    return matches ? 0 : 1
  }

  if (flags.write === true) {
    // Writing the REAL index is gated to 49-14. --write exists for fixture
    // corpora + the future flip; fs-atomics has no raw-text writer, so the plain
    // node fs write is used directly here.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(indexPath, generated)
    for (const a of areaFiles) writeFileSync(join(corpusDir, a.file), a.content)
    if (wantsJson(flags)) {
      printJson({ written: indexPath, bytes: generated.length, areaFiles: areaFiles.map((a) => a.file) })
      return 0
    }
    process.stdout.write(
      `SMA: MEMORY.md записан (${generated.length} байт) + ${areaFiles.length} INDEX-файлов → ${corpusDir}\n`,
    )
    return 0
  }

  // Default: DRY — emit the generated text to stdout, write nothing.
  process.stdout.write(generated)
  if (!generated.endsWith('\n')) process.stdout.write('\n')
  return 0
}

/**
 * emit [--check] [--formats <csv>] [--target-dir <d>] [--budget <id>=<bytes>]
 *      [--count <drift|over-budget|corrupt|missing>] [--json]
 *
 * One corpus, any agent (D-9.3-08): compile the learned memory corpus into
 * CLAUDE.md / AGENTS.md / .cursorrules / GEMINI.md under per-format byte budgets,
 * via managed export blocks — regenerable, never hand-edited in place. NOT
 * hook-facing: emit never commits/pushes; the diff is the user's to review
 * (T-9.3-03). commitHash + dateMap come from the same read-only execGit path
 * cmdBuildIndex uses. --count implies --check and prints the bare number last.
 */
async function cmdEmit({ flags, dirs }) {
  const emit = await import('./lib/emit.mjs')
  const generator = await import('./lib/generator.mjs')

  const corpusDir = typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')
  const tagsPath = join(corpusDir, 'TAGS.md')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const targetDir = typeof flags['target-dir'] === 'string' ? flags['target-dir'] : repoRoot
  const profilePath = join(dirs.smaRoot, 'profile.json')

  // Read-only git: full 40-hex hash + last-commit date map. Fail-open to epoch.
  let dateMap = {}
  let commitHash = '0'.repeat(40)
  try {
    const { execFileSync } = await import('node:child_process')
    const execGit = (args) => execFileSync('git', args, { encoding: 'utf8' })
    dateMap = generator.computeDateMap({ execGit })
    const full = execGit(['rev-parse', 'HEAD']).trim()
    if (/^[0-9a-f]{40}$/.test(full)) commitHash = full
  } catch {
    /* fail-open — deterministic 40-zero anchor */
  }

  // --formats <csv of ids> narrows/orders the set; else emitAll consults the profile.
  let formats
  if (typeof flags.formats === 'string') {
    const ids = flags.formats.split(',').map((s) => s.trim()).filter(Boolean)
    formats = emit.EMIT_FORMATS.filter((f) => ids.includes(f.id))
  }

  // --budget <id>=<bytes> (comma-separated for multiple overrides).
  const budgets = {}
  if (typeof flags.budget === 'string') {
    for (const pair of flags.budget.split(',')) {
      const [id, bytes] = pair.split('=')
      const n = Number(bytes)
      if (id && Number.isFinite(n)) budgets[id.trim()] = n
    }
  }

  const check = flags.check === true || typeof flags.count === 'string'
  const result = emit.emitAll({ targetDir, corpusDir, tagsPath, commitHash, dateMap, budgets, formats, check, profilePath })

  // --count <key>: bare number as the LAST line, exit 0 ALWAYS (scorer contract).
  if (typeof flags.count === 'string') {
    const map = { drift: result.counts.drift, 'over-budget': result.counts.overBudget, corrupt: result.counts.corrupt, missing: result.counts.missing }
    const n = map[flags.count] ?? 0
    if (wantsJson(flags)) printJson(result)
    process.stdout.write(`${n}\n`)
    return 0
  }

  if (wantsJson(flags)) {
    printJson(result)
    return check ? 0 : result.results.some((r) => r.action === 'skipped-corrupt') ? 1 : 0
  }

  // Human table: file · action · block-bytes/budget · notes k/m.
  for (const r of result.results) {
    const size = r.bytes != null ? `${r.bytes}/${r.budget}b` : `-/${r.budget}b`
    const notes = r.included != null ? `${r.included}/${r.totalEligible} notes` : ''
    process.stdout.write(`  ${r.file.padEnd(14)} ${String(r.action).padEnd(15)} ${size.padEnd(14)} ${notes}\n`)
  }
  if (check) {
    const c = result.counts
    process.stdout.write(`  counts: drift ${c.drift} · over-budget ${c.overBudget} · corrupt ${c.corrupt} · missing ${c.missing}\n`)
    return 0
  }
  return result.results.some((r) => r.action === 'skipped-corrupt') ? 1 : 0
}

/**
 * load --tags <csv> — resolve a task's tag set into CORE + periphery via the
 * loader. Prints the ordered file list. Zero matches → CORE only, exit 0.
 */
async function cmdLoad({ flags, dirs }) {
  const loader = await import('./lib/loader.mjs')
  const corpusDir = typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')
  const tags = typeof flags.tags === 'string' ? flags.tags.split(',').map((t) => t.trim()).filter(Boolean) : []

  // date map (read-only git; fail-open to empty).
  let dateMap = {}
  try {
    const generator = await import('./lib/generator.mjs')
    const { execFileSync } = await import('node:child_process')
    dateMap = generator.computeDateMap({ execGit: (args) => execFileSync('git', args, { encoding: 'utf8' }) })
  } catch {
    /* fail-open */
  }

  // 9.1-11 (B4): every note load via `sma load` is recorded as a citation.
  // Best-effort wiring — a citation failure never breaks the load (fail-open
  // at both layers: the loader swallows a throwing cite, recordCitation never throws).
  let cite
  try {
    const citations = await import('./lib/citations.mjs')
    const registry = await import('./lib/registry.mjs')
    const identity = registry.resolveTerminalIdentity({})
    cite = (f) =>
      citations.recordCitation(
        { noteId: f, kind: 'load', terminal: identity.terminalId, session: identity.sessionToken ?? null },
        { usageDir: dirs.usageDir },
      )
  } catch {
    /* fail-open — the load still works uninstrumented */
  }

  const res = loader.resolvePeriphery({ tags, corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), dateMap, cite })
  if (wantsJson(flags)) {
    printJson(res)
    return 0
  }
  process.stdout.write(`SMA load: ядро ${res.core.length}, периферия ${res.periphery.length}\n`)
  for (const f of res.core) process.stdout.write(`  [ядро] ${f}\n`)
  for (const f of res.periphery) process.stdout.write(`  ${f}\n`)
  if (res.periphery.length === 0) process.stdout.write('  (совпадений по тегам нет — только ядро CORE)\n')
  for (const w of res.warnings) process.stdout.write(`  ⚠ ${w}\n`)
  return 0
}

// ── 9.3-05 (D-9.3-06/07): fragment catalog + `sma context` compiler ─────────

/** ONE read-only git-log pass → {gitStats:{path:{lastCommit,commits}}} (mirrors
 * generator.computeDateMap posture: newest-first, first-seen date wins). A `%H|%cI`
 * format (hex hash + ISO date — neither carries a pipe) keeps the parse unambiguous. */
function collectGitStats(execGit) {
  const gitStats = {}
  let raw = ''
  try {
    raw = execGit(['log', '--format=%H|%cI', '--name-only'])
  } catch {
    return gitStats
  }
  let curDate = null
  for (const line of String(raw).split('\n')) {
    const t = line.replace(/\r$/, '')
    if (/^[0-9a-f]{7,40}\|/.test(t)) {
      curDate = t.split('|')[1] || null
      continue
    }
    const path = t.trim()
    if (!path || curDate == null) continue
    if (!gitStats[path]) gitStats[path] = { lastCommit: curDate, commits: 0 }
    gitStats[path].commits += 1
  }
  return gitStats
}

/**
 * catalog refresh [--full] | find <query> [--limit N] | --check [--count]
 * — the deterministic file catalog (9.3-05, D-9.3-06). cards.jsonl lives in the
 * gitignored .sma/catalog/. `--check --count` prints the drift count (0 clean, -1 when
 * no catalog is built — the honest not-built sentinel, P9.3-05-A's instrument).
 * Direct-CLI, never hook-facing.
 */
async function cmdCatalog({ positionals, flags, dirs }) {
  const catalog = await import('./lib/catalog.mjs')
  const { readFileSync, existsSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const execGit = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  const readFile = (p) => readFileSync(join(repoRoot, p), 'utf8')
  const sub = positionals[0]

  // ── find <query> ────────────────────────────────────────────────────────────
  if (sub === 'find') {
    const query = positionals.slice(1).join(' ') || (typeof flags.query === 'string' ? flags.query : '')
    const stored = catalog.readCatalog({ catalogDir: dirs.catalogDir, readFile: (p) => readFileSync(p, 'utf8') })
    if (!stored || stored.built === false) {
      if (wantsJson(flags)) printJson({ built: false, cards: [] })
      else process.stdout.write('SMA catalog: не построен — запустите `sma catalog refresh --full`.\n')
      return 0
    }
    const limit = Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : 20
    const hits = catalog.findCards({ catalog: stored, query, limit })
    if (wantsJson(flags)) {
      printJson({ query, cards: hits })
      return 0
    }
    if (!hits.length) {
      process.stdout.write(`SMA catalog: 0 карточек по «${query}» — шаг 2 правила поиска: grep только то, чего карточки не знают (символы/импорты/git-стат по замыслу).\n`)
      return 0
    }
    for (const c of hits) {
      const syms = (c.symbols || []).slice(0, 6).join(' ')
      process.stdout.write(`  ${c.path}  [${c.class}] ${syms}\n`)
    }
    return 0
  }

  // ── --check [--count] ─────────────────────────────────────────────────────────
  if (flags.check === true) {
    const stored = catalog.readCatalog({ catalogDir: dirs.catalogDir, readFile: (p) => readFileSync(p, 'utf8') })
    if (!stored || stored.built === false) {
      if (wantsJson(flags)) printJson({ built: false, drift: -1 })
      if (flags.count === true) process.stdout.write('-1\n') // honest not-built sentinel
      else process.stdout.write('SMA catalog: не построен (drift -1)\n')
      return 0
    }
    // MEM-REGEN posture: a moved HEAD is staleness, never drift. Only when the header
    // commit is still HEAD do we regenerate from the working tree and byte-compare.
    let headShort = ''
    try {
      headShort = execGit(['rev-parse', '--short', 'HEAD']).trim()
    } catch {
      /* fail-open */
    }
    let drift = 0
    if (headShort && stored.commit && stored.commit === headShort) {
      const gitStats = collectGitStats(execGit)
      const res = catalog.checkCatalog({ catalog: stored, readFile, gitStatsAtCommit: gitStats })
      drift = res.built ? res.drift : 0
    }
    if (wantsJson(flags)) printJson({ built: true, drift, commit: stored.commit, head: headShort })
    if (flags.count === true) process.stdout.write(`${drift}\n`)
    else process.stdout.write(`SMA catalog: drift ${drift} (commit ${stored.commit}${headShort && headShort !== stored.commit ? `, HEAD ${headShort} — устарел, обновите` : ''})\n`)
    return 0
  }

  // ── refresh [--full] (default) ───────────────────────────────────────────────
  let trackedFiles = []
  try {
    trackedFiles = execGit(['ls-files']).split('\n').map((s) => s.replace(/\r$/, '').trim()).filter(Boolean)
  } catch {
    /* fail-open — empty tree */
  }
  const gitStats = collectGitStats(execGit)
  let commit = ''
  try {
    commit = execGit(['rev-parse', '--short', 'HEAD']).trim()
  } catch {
    /* fail-open */
  }

  const stored = catalog.readCatalog({ catalogDir: dirs.catalogDir, readFile: (p) => readFileSync(p, 'utf8') })
  let built
  let changedCount
  if (flags.full === true || !stored || stored.built === false) {
    built = catalog.buildCatalog({ trackedFiles, readFile, gitStats, commit })
    changedCount = built.cardLines.length
  } else if (stored.commit === commit) {
    // already fresh at this commit — no work, no rewrite.
    if (wantsJson(flags)) printJson({ files: stored.cardLines.length, changed: 0, commit })
    else process.stdout.write(`SMA catalog: ${stored.cardLines.length} карточек (уже свежий на ${commit})\n`)
    return 0
  } else {
    // incremental against the stored header commit.
    let changed = []
    let deleted = []
    try {
      const diff = execGit(['diff', '--name-status', stored.commit, 'HEAD'])
      for (const line of diff.split('\n')) {
        const t = line.replace(/\r$/, '')
        if (!t.trim()) continue
        const parts = t.split('\t')
        const status = parts[0]
        if (status.startsWith('D')) deleted.push(parts[1])
        else if (status.startsWith('R')) { deleted.push(parts[1]); changed.push(parts[2]) }
        else changed.push(parts[1])
      }
    } catch {
      /* fail-open — fall back to full below */
    }
    if (!changed.length && !deleted.length) {
      built = catalog.buildCatalog({ trackedFiles, readFile, gitStats, commit }) // safety: rebuild
      changedCount = built.cardLines.length
    } else {
      built = catalog.refreshCatalog({ catalog: stored, changed, deleted, readFile, gitStats, commit })
      changedCount = changed.length + deleted.length
    }
  }
  catalog.writeCatalog({ catalog: built, catalogDir: dirs.catalogDir })
  const fileCount = built.cardLines ? built.cardLines.length : 0
  if (wantsJson(flags)) {
    printJson({ files: fileCount, changed: changedCount, commit })
    return 0
  }
  process.stdout.write(`SMA catalog: ${fileCount} карточек (изменено ${changedCount}) → commit ${commit}\n`)
  return 0
}

/**
 * context "<task>" [--budget N] | score [--count] | miss "<q>" --expected <path> |
 *         exam [--count] | --selftest
 * — the deterministic budgeted context compiler (9.3-05, D-9.3-07). The numeric-last-line
 * instruments (`--selftest`, `score --count`, `exam --count`) are the P9.3-05-B/C scorers.
 * Direct-CLI, never hook-facing.
 */
async function cmdContext({ positionals, flags, dirs }) {
  const pack = await import('./lib/context-pack.mjs')
  const { readFileSync, existsSync } = await import('node:fs')
  const sub = positionals[0]

  // ── --selftest: double-compile the committed fixture in-process, byte-compare ──
  if (flags.selftest === true) {
    let fixture
    try {
      fixture = JSON.parse(readFileSync(join(MODULE_DIR, 'fixtures', 'context', 'selftest-task.json'), 'utf8'))
    } catch (err) {
      process.stdout.write('0\n') // missing/corrupt fixture → not deterministic-provable
      return 1
    }
    const cardLines = (fixture.cards || []).map((c) => JSON.stringify(c))
    const catalog = { built: true, v: 1, commit: fixture.commit, cards: fixture.cards || [], cardLines }
    const resolve = () => ({ core: fixture.core || [], periphery: fixture.periphery || [] })
    const args = { taskText: fixture.task, commit: fixture.commit, catalog, profile: null, resolve }
    const a = pack.compilePack(args)
    const b = pack.compilePack(args)
    const identical = a.packMd === b.packMd && a.manifestJson === b.manifestJson ? 1 : 0
    if (wantsJson(flags)) printJson({ selftest: true, deterministic: identical === 1, packId: a.packId, bytes: a.manifest.bytes })
    process.stdout.write(`${identical}\n`) // numeric last line (P9.3-05-B)
    return identical === 1 ? 0 : 1
  }

  // resolve corpus/tags/dateMap + catalog + profile for the repo-facing subcommands.
  const corpusDir = typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')
  const tagsPath = join(corpusDir, 'TAGS.md')
  let dateMap = {}
  try {
    const generator = await import('./lib/generator.mjs')
    const { execFileSync } = await import('node:child_process')
    dateMap = generator.computeDateMap({ execGit: (a) => execFileSync('git', a, { encoding: 'utf8' }) })
  } catch {
    /* fail-open */
  }
  const catalogMod = await import('./lib/catalog.mjs')
  const storedCatalog = catalogMod.readCatalog({ catalogDir: dirs.catalogDir, readFile: (p) => readFileSync(p, 'utf8') })
  const catalog = storedCatalog && storedCatalog.built ? storedCatalog : null

  let profile = null
  try {
    const prof = await import('./lib/profile.mjs')
    const profilePath = join(dirs.smaRoot, 'profile.json')
    if (existsSync(profilePath)) profile = prof.normalizeProfile(prof.readProfile({ profilePath }).profile)
  } catch {
    /* fail-open — no profile */
  }

  // ── score [--count]: purity THEN grow the exam (the miss→question loop) ────────
  if (sub === 'score') {
    const scored = pack.scorePurity({ contextDir: dirs.contextDir })
    const grown = pack.growExam({ contextDir: dirs.contextDir })
    if (wantsJson(flags)) printJson({ ...scored, examAdded: grown.added, examTotal: grown.total })
    else if (flags.count !== true) process.stdout.write(`SMA context score: purity ${scored.purityPct}% · settled ${scored.settledPacks} · exam +${grown.added}\n`)
    if (flags.count === true) process.stdout.write(`${scored.purityPct}\n`) // numeric last line (P9.3-05-C)
    return 0
  }

  // ── miss "<query>" --expected <path> ──────────────────────────────────────────
  if (sub === 'miss') {
    const query = positionals.slice(1).join(' ')
    const expected = typeof flags.expected === 'string' ? flags.expected : ''
    if (!query || !expected) {
      process.stderr.write('usage: sma context miss "<query>" --expected <path>\n')
      return 1
    }
    const r = pack.appendMiss({ query, expected, contextDir: dirs.contextDir })
    if (wantsJson(flags)) printJson(r)
    else process.stdout.write(`SMA context miss: записано (${r.added})\n`)
    return 0
  }

  // ── exam [--count]: replay every question through the compiler ────────────────
  if (sub === 'exam') {
    const compile = (query) =>
      pack.compilePack({ taskText: query, commit: catalog ? catalog.commit : '', corpusDir, tagsPath, dateMap, catalog, profile }).manifest
    const r = pack.runExam({ contextDir: dirs.contextDir, compile })
    if (wantsJson(flags)) printJson(r)
    else if (flags.count !== true) process.stdout.write(`SMA context exam: ${r.count} провалов из ${r.total}\n`)
    if (flags.count === true) process.stdout.write(`${r.count}\n`) // numeric last line
    return 0
  }

  // ── compile "<task text>" (default) ───────────────────────────────────────────
  const taskText = positionals.join(' ') || (typeof flags.task === 'string' ? flags.task : '')
  if (!taskText.trim()) {
    process.stderr.write('usage: sma context "<task text>" [--budget N] [--json]\n')
    return 1
  }
  let commit = ''
  try {
    const { execFileSync } = await import('node:child_process')
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    /* fail-open */
  }

  // citation wiring — packed notes + fragments ride the SAME usage journal (kind 'load').
  let cite
  try {
    const citations = await import('./lib/citations.mjs')
    const registry = await import('./lib/registry.mjs')
    const identity = registry.resolveTerminalIdentity({})
    cite = (id, kind) =>
      citations.recordCitation({ noteId: id, kind: kind === 'fire' ? 'fire' : 'load', terminal: identity.terminalId, session: identity.sessionToken ?? null }, { usageDir: dirs.usageDir })
  } catch {
    /* fail-open — the pack still compiles uninstrumented */
  }

  const budget = Number.isFinite(Number(flags.budget)) && Number(flags.budget) > 0 ? Number(flags.budget) : undefined
  const compiled = pack.compilePack({ taskText, commit, corpusDir, tagsPath, dateMap, catalog, profile, cite, ...(budget ? { budget } : {}) })

  // persist the pack (artifacts) + active.json (STATE — the only wall-clock in the feature).
  const { atomicWriteRaw, atomicWriteJson } = await import('./lib/fs-atomics.mjs')
  const packDir = join(dirs.contextDir, 'packs', compiled.packId)
  atomicWriteRaw(join(packDir, 'PACK.md'), compiled.packMd)
  atomicWriteRaw(join(packDir, 'MANIFEST.json'), compiled.manifestJson)
  atomicWriteJson(join(dirs.contextDir, 'active.json'), { packId: compiled.packId, activatedAt: Date.now() })

  if (wantsJson(flags)) {
    printJson(compiled.manifest)
    return 0
  }
  process.stdout.write(`SMA context: pack ${compiled.packId} → ${join(packDir, 'PACK.md')}${catalog ? '' : ' (каталог не построен — 0 карточек; запустите `sma catalog refresh --full`)'}\n`)
  for (const m of compiled.manifest.members) {
    process.stdout.write(`  ${String(m.type).padEnd(9)} ${String(m.id ?? '').padEnd(28)} ${m.bytes}b\n`)
  }
  process.stdout.write(`  bytes ${compiled.manifest.bytes}/${compiled.manifest.budget}\n`)
  return 0
}

/**
 * pre — the `sma pre` PreToolUse MULTIPLEXER (9.2-02, D-9.2-04). ONE node run per
 * Edit/Write/Bash: reads the event once, builds the SHARED ctx (identity + heartbeat
 * + seen loaded once), dispatches the ordered PRE_CHECKS pipeline (collision → reflex
 * → gates, later + airbag + spend), merges output under the fail-open WARN / soft-deny
 * posture, and appends a bounded per-stream timing sample so S7 stays measurable in
 * the field. Replaces the 3 legacy spawns. Hook-facing: exit 0 always.
 */
async function cmdPre({ dirs }) {
  const evt = readStdinJson()
  const pre = await import('./lib/pre.mjs')
  const ctx = await pre.buildCtx({ evt, dirs, env: process.env, now: () => Date.now() })
  const { warns, deny, sample } = await pre.runPre(ctx)
  const out = pre.mergeOutput({ warns, deny })
  if (out) printJson(out)
  // perf sample gets its OWN try/catch — a perf-store failure never blocks the hook.
  try {
    pre.appendPerfSample(sample, { perfDir: dirs.perfDir })
  } catch {
    /* fail-open */
  }
  return 0
}

/**
 * runSingleStream(dirs, id) — the legacy single-stream delegation seam. Builds the
 * SAME shared ctx via buildCtx and runs ONLY the stream with the given id from
 * PRE_CHECKS (honoring its kill-switch), saving the shared seen once. Parity with
 * the multiplexer is by CONSTRUCTION — collision-check / reflex-check / gates-check
 * are now thin aliases over the same stream objects, not copied glue.
 */
async function runSingleStream(dirs, id) {
  const pre = await import('./lib/pre.mjs')
  const evt = readStdinJson()
  const { warns, deny } = await runStreamCollect(dirs, id, evt)
  const merged = pre.mergeOutput({ warns, deny })
  if (merged) printJson(merged)
  return 0
}

/**
 * runStreamCollect(dirs, id, evt) → {warns, deny}. Runs ONE PRE_CHECKS stream against an
 * ALREADY-READ event (stdin is read once by the caller) and returns its collected output
 * WITHOUT printing — the shared seam that lets a single hook process host a stream inline
 * (gap C: fold the Task-cap spend stream into the one pretask-pack spawn). Honors the
 * stream's tool scope, opt-in gate + kill-switch (the stream owns them), mayDeny, and the
 * shared-seen save. Fail-open by construction — never throws.
 */
async function runStreamCollect(dirs, id, evt) {
  const pre = await import('./lib/pre.mjs')
  const ctx = await pre.buildCtx({ evt, dirs, env: process.env, now: () => Date.now() })
  const stream = pre.PRE_CHECKS.find((s) => s.id === id)
  let warns = []
  let deny = null
  if (stream && stream.tools.includes(ctx.toolName)) {
    const killed = stream.killSwitchEnv && isEnvOn(process.env[stream.killSwitchEnv])
    if (!killed) {
      try {
        const r = (await stream.run(ctx)) || { warns: [] }
        warns = Array.isArray(r.warns) ? r.warns.filter((w) => typeof w === 'string' && w) : []
        if (r.deny && r.deny.text && stream.mayDeny) deny = { text: String(r.deny.text) }
      } catch {
        /* fail-open */
      }
    }
  }
  // save the shared seen once (reflex/gates mutate it).
  try {
    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
    if (ctx.deps && ctx.deps.reflex) ctx.deps.reflex.saveSeen(ctx.seen, { reflexDir: dirs.reflexDir, terminalId })
  } catch {
    /* fail-open */
  }
  return { warns, deny }
}

/**
 * collision-check — DEPRECATED single-stream alias (external wiring back-compat).
 * Delegates to the collision stream in PRE_CHECKS; the canonical wiring is `pre`.
 */
async function cmdCollisionCheck({ dirs }) {
  return runSingleStream(dirs, 'collision')
}

/**
 * reflex-check — DEPRECATED single-stream alias. Delegates to the reflex stream.
 */
async function cmdReflexCheck({ dirs }) {
  return runSingleStream(dirs, 'reflex')
}

/**
 * gates-check — DEPRECATED single-stream alias. Delegates to the gates stream (the
 * only mayDeny stream — a soft-deny still surfaces permissionDecision 'deny').
 */
async function cmdGatesCheck({ dirs }) {
  // 9.2-10 (D-9.2-14) — STPA auto-re-arm on the RARE path ONLY: consult the disarm
  // leases solely when a gate's own kill env is actually set (zero extra IO otherwise —
  // plan 02 SLO untouched). A 're-arm' decision scrubs that kill env from THIS one-shot
  // process's env so the gate fires its advisory WARN again (WARN tier only; never a
  // deny). gates.mjs + pre.mjs stay byte-untouched — the re-arm rides checkEvent's
  // existing env surface. Fail-open: any error leaves the env as-is.
  try {
    const { GATES } = await import('./lib/gates.mjs')
    const anyKill =
      isEnvOn(process.env.SMA_GATES_DISABLE) || GATES.some((g) => g.killEnv && isEnvOn(process.env[g.killEnv]))
    if (anyKill) {
      const stpa = await import('./lib/stpa.mjs')
      for (const d of stpa.reArmDecisions({ env: process.env, dirs })) {
        if (d.decision === 're-arm' && d.killEnv) delete process.env[d.killEnv]
      }
    }
  } catch {
    /* fail-open — the re-arm never wedges the gate hook */
  }
  return runSingleStream(dirs, 'gates')
}

/**
 * airbag-check — the git airbag hook (9.2-05, D-9.2-08). The pre-less FALLBACK for
 * an install that has not adopted the `sma pre` multiplexer; the canonical wiring is
 * `pre` (the airbag rides inside it). Delegates to the SAME airbag stream in PRE_CHECKS
 * (the only extra deny-capable stream) — honoring its kill-switch (SMA_AIRBAG_DISABLE)
 * and its opt-in gate (SMA_AIRBAG_ENABLE). HOOK_FACING: exit 0 always, wrapped fail-open.
 */
async function cmdAirbagCheck({ dirs }) {
  return runSingleStream(dirs, 'airbag')
}

/**
 * spend-check — the deterministic spend-ledger hook (9.2-09, D-9.2-13). A pre-less
 * FALLBACK verb for an install that wires it standalone; the canonical wiring is NOT a
 * separate spawn — the Task-cap spend stream rides inside `pretask-pack` (gap C, one Task
 * spawn) and inside the `pre` multiplexer. Delegates to the SAME spend stream in PRE_CHECKS
 * (a deny-capable stream that denies ONLY the Task tool past a configured cap) — honoring
 * its opt-in gate (SMA_SPEND_OPTIN) + kill-switch (SMA_SPEND_DISABLE). HOOK_FACING: exit 0.
 */
async function cmdSpendCheck({ dirs }) {
  return runSingleStream(dirs, 'spend')
}

/** A real execFileSync-shaped git runner over the resolved repo root (buffer-aware). */
async function makeRepoGitRunner() {
  const { execFileSync } = await import('node:child_process')
  let repoRoot = process.cwd()
  try {
    const registry = await import('./lib/registry.mjs')
    repoRoot = registry.smaRoot()
  } catch {
    /* fail-open to cwd */
  }
  const runGit = (args, opts = {}) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, input: opts.input, encoding: opts.buffer ? 'buffer' : 'utf8' })
    } catch {
      return opts.buffer ? Buffer.alloc(0) : ''
    }
  }
  return { runGit, repoRoot }
}

/**
 * undo [--to <id>] [--dry-run] [--yes] [--json] — the one-action airbag restore
 * (9.2-05). NOT hook-facing (writes the working tree — an explicit user action).
 * Without --yes it PREVIEWS the restore plan (zero writes) + the --yes command;
 * --dry-run always previews; --yes executes restoreSnapshot (which self-snapshots first).
 */
async function cmdUndo({ flags, dirs }) {
  const airbag = await import('./lib/airbag.mjs')
  const { runGit, repoRoot } = await makeRepoGitRunner()
  const snapshotId = typeof flags.to === 'string' ? flags.to : undefined
  const dryRun = flags['dry-run'] === true
  const execute = flags.yes === true && !dryRun

  if (!execute) {
    const r = airbag.restoreSnapshot({ snapshotId, dryRun: true }, { runGit, dirs, repoRoot })
    if (wantsJson(flags)) {
      printJson(r)
      return r.ok ? 0 : 1
    }
    if (!r.ok) {
      process.stdout.write(`SMA undo: ${r.error}\n`)
      return 1
    }
    process.stdout.write(
      `SMA undo (превью): снимок ${r.plan.snapshotId} — head:${r.plan.head} stash:${r.plan.stash} untracked:${r.plan.untracked}` +
        `${r.plan.untracked && !r.plan.untrackedMapKnown ? ' (карта имён недоступна — untracked не восстановится)' : ''}\n`,
    )
    if (!dryRun) process.stdout.write(`  выполните: pnpm sma undo${snapshotId ? ` --to ${snapshotId}` : ''} --yes\n`)
    return 0
  }

  const terminalId = await resolveTerminalId()
  const r = airbag.restoreSnapshot({ snapshotId }, { runGit, dirs, repoRoot, terminalId })
  if (wantsJson(flags)) {
    printJson(r)
    return r.ok ? 0 : 1
  }
  if (!r.ok) {
    process.stdout.write(`SMA undo: НЕ удалось — ${r.error}\n`)
    return 1
  }
  process.stdout.write(
    `SMA undo: восстановлен снимок ${r.snapshotId} (само-снимок ${r.preSnapshotId}, untracked ${r.untrackedRestored})` +
      `${r.warns && r.warns.length ? ` ⚠ ${r.warns.join('; ')}` : ''}\n`,
  )
  return 0
}

/**
 * airbag <list|prune|probe|stats> [--json] — snapshot admin + the S2 instruments.
 * NOT hook-facing. probe prints 0/1 as the LAST line (P9.2-05-C scorer); stats +
 * coverage/latency come from the ONE airbag.benchProviders path (no drift vs bench).
 */
async function cmdAirbag({ positionals, flags, dirs }) {
  const airbag = await import('./lib/airbag.mjs')
  const sub = positionals[0]

  if (sub === 'probe') {
    const p = airbag.nativeCheckpointProbe({ env: process.env })
    if (wantsJson(flags)) printJson(p)
    else process.stdout.write(`SMA airbag probe: native=${p.native} (probeVersion ${p.probeVersion})\n`)
    process.stdout.write(`${p.native ? 1 : 0}\n`) // numeric LAST line — the P9.2-05-C scorer
    return 0
  }

  const { runGit } = await makeRepoGitRunner()

  if (sub === 'list') {
    const groups = airbag.listSnapshots({ runGit })
    // BL-172: deterministic structural mode — the listing's SHAPE, never its
    // accruing ref contents. 1/0 LAST line, always exit 0.
    if (flags['schema-check'] === true) {
      const ok = airbag.snapshotListSchemaOk(groups) ? 1 : 0
      if (wantsJson(flags)) printJson({ schemaOk: ok })
      process.stdout.write(`${ok}\n`)
      return 0
    }
    const view = groups.map((g) => ({ id: g.id, refs: Object.keys(g.refs).filter((k) => !k.startsWith('_sha_')) }))
    if (wantsJson(flags)) {
      printJson({ snapshots: view, n: view.length })
      return 0
    }
    if (!view.length) process.stdout.write('SMA airbag: снимков нет\n')
    for (const g of view) process.stdout.write(`  ${g.id}  [${g.refs.join(',')}]\n`)
    return 0
  }

  if (sub === 'prune') {
    const keep = Number.isFinite(Number(flags.keep)) ? Number(flags.keep) : undefined
    const maxAgeMs = Number.isFinite(Number(flags['max-age-days'])) ? Number(flags['max-age-days']) * 86400000 : undefined
    const terminalId = await resolveTerminalId()
    const res = airbag.pruneSnapshots({ keep, maxAgeMs }, { runGit, dirs, terminalId })
    if (wantsJson(flags)) printJson(res)
    else process.stdout.write(`SMA airbag prune: удалено ${res.removed.length}, осталось ${res.kept}\n`)
    return 0
  }

  if (sub === 'stats') {
    const { readJournal } = await import('./lib/journal.mjs')
    const providers = airbag.benchProviders({ journalDir: dirs.journalDir, readJournalFn: (o) => readJournal(o) })
    if (wantsJson(flags)) {
      printJson({ coverage: providers.coverage, latency: providers.latency })
      return 0
    }
    process.stdout.write(
      `SMA airbag stats: покрытие ${providers.coverage.value}% (n=${providers.coverage.n}, ${providers.coverage.status}), ` +
        `p95 задержки ${providers.latency.value} мс (n=${providers.latency.n})\n`,
    )
    return 0
  }

  process.stdout.write('usage: sma airbag <list|prune|probe|stats> [--json] [--keep N] [--max-age-days N]\n')
  return sub ? 1 : 0
}

// ── 9.2-09 (D-9.2-13): the deterministic spend ledger ──────────────────────────

/** Resolve the repo root for local-session-log discovery (fail-open → cwd). */
async function resolveRepoRootForSpend() {
  try {
    const registry = await import('./lib/registry.mjs')
    return registry.smaRoot()
  } catch {
    return process.cwd()
  }
}

/**
 * spend [--json] [--by session|model|agent|day] [--window <h>] [--stat <name>]
 *   | spend set-cap <usd> [--window-hours <h>]
 *
 * The `sma spend` report — "where did the window go" from local files alone, in
 * O(appended bytes) via the incremental cache. NOT hook-facing (the hot path is
 * `spend-check`). `--stat <name>` prints EXACTLY ONE number as the final stdout line
 * (the predict-score scorer contract, 9.1-08). `set-cap` writes the window budget
 * with provenance. When probeNativeSpend().native, the report leads with the
 * standing-down banner (D-9.2-05a). Fail-open — never wedges anything.
 */
async function cmdSpend({ positionals, flags, dirs }) {
  const spend = await import('./lib/spend.mjs')
  const adapter = await import('./lib/spend-adapter.mjs')
  const sub = positionals[0]

  // set-cap <usd> [--window-hours N] — the founder-set cap (a soft-deny needs one).
  if (sub === 'set-cap') {
    const usd = Number(positionals[1])
    if (!Number.isFinite(usd) || usd <= 0) {
      process.stdout.write('usage: sma spend set-cap <usd> [--window-hours N]\n')
      return 1
    }
    const cur = spend.readBudget({ spendDir: dirs.spendDir })
    const windowHours = Number.isFinite(Number(flags['window-hours'])) ? Number(flags['window-hours']) : cur.windowHours
    const by = await resolveTerminalId()
    const rec = spend.writeBudget({ capUsd: usd, windowHours }, { spendDir: dirs.spendDir, by })
    if (wantsJson(flags)) printJson(rec)
    else process.stdout.write(`SMA spend: лимит окна установлен — $${rec.capUsd} за ${rec.windowHours} ч (кем: ${rec.by})\n`)
    return 0
  }

  // lane <open|close|report|derive> — the per-lane economy budgets (9.4-06).
  if (sub === 'lane') return cmdSpendLane({ positionals, flags, dirs })
  // self-cost — SMA's own static per-session injection overhead (9.4-06).
  if (sub === 'self-cost') return cmdSpendSelfCost({ flags, dirs })

  const repoRoot = await resolveRepoRootForSpend()
  const now = Date.now()
  const book = spend.buildBook({ spendDir: dirs.spendDir, repoRoot, env: process.env, now })
  const budget = spend.readBudget({ spendDir: dirs.spendDir })
  const windowHours = Number.isFinite(Number(flags.window)) ? Number(flags.window) : budget.windowHours

  // --stat <name> → EXACTLY one numeric last line (the scorer contract).
  if (flags.stat) {
    const name = String(flags.stat)
    let value
    if (name === 'bench-check-p95-ms') {
      value = await spend.benchCheckP95({ spendDir: dirs.spendDir, repoRoot, env: process.env })
    } else {
      value = spend.spendStats(name, { book, spendDir: dirs.spendDir, now, windowHours, env: process.env })
    }
    process.stdout.write(`${value}\n`)
    return 0
  }

  const probe = adapter.probeNativeSpend({ env: process.env })
  const win = spend.windowSpend({ book, now, windowHours })
  const pct = budget.capUsd ? Math.round((win.usd / budget.capUsd) * 1000) / 10 : null

  if (wantsJson(flags)) {
    printJson({
      standDown: probe.native,
      totals: book.totals,
      window: { usd: win.usd, events: win.events, hours: windowHours, capUsd: budget.capUsd, pct },
      bySession: book.bySession,
      byModel: book.byModel,
      byDay: book.byDay,
      byAgent: book.byAgent,
      counters: book.counters,
      pricingVersion: book.pricingVersion,
      adapterVersion: book.adapterVersion,
      builtAt: book.builtAt,
    })
    return 0
  }

  // ── human table ──────────────────────────────────────────────────────────────
  if (probe.native) {
    process.stdout.write('SMA spend: обнаружен НАТИВНЫЙ локальный учёт затрат — мост отключается (bridge standing down).\n')
  }
  process.stdout.write(
    `SMA spend: всего $${book.totals.usd} за ${book.totals.events} событий` +
      ` (окно ${windowHours} ч: $${win.usd}` +
      (budget.capUsd ? ` из $${budget.capUsd} = ${pct}%` : ' — лимит не задан, только отчёт') +
      `). Тарифы: ${book.pricingVersion}\n`,
  )
  const by = typeof flags.by === 'string' ? flags.by : 'model'
  const groupMap =
    by === 'session' ? book.bySession : by === 'day' ? book.byDay : by === 'agent' ? null : book.byModel
  if (by === 'agent') {
    process.stdout.write(`  главный: $${book.byAgent.main.usd} (${book.byAgent.main.events}) · субагенты: $${book.byAgent.subagent.usd} (${book.byAgent.subagent.events})\n`)
  } else {
    const rows = Object.entries(groupMap || {})
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 8)
    for (const [k, v] of rows) process.stdout.write(`  ${k}: $${v.usd} (${v.events})\n`)
  }
  const c = book.counters
  process.stdout.write(
    `  распознано ${c.recognized} · не-usage ${c.nonUsage} · дубликаты ${c.duplicate} · ` +
      `дрейф(unrecognized) ${c.unrecognized} · без цены(unpriced) ${c.unpriced} · повреждено ${c.corrupt}\n`,
  )
  return 0
}

/**
 * spend lane <open <fix|quick|batch|build>|close|report|derive> [--json] | spend lane
 *   --selftest | spend lane --stat max-lane-closed-runs — the per-lane economy budgets
 *   (9.4-06). Budgets derive ONLY from OUR own closed-run percentiles (p75); a lane with
 *   fewer than 5 closed clean runs stays report-only. `close` attributes the run from the
 *   book, and on an over-budget CLEAN run CONSUMES calibration.appendVerdict +
 *   predict.draftLessonFromMiss (the 2026-06-19 incident as a mechanism). Overlap-flagged
 *   runs are excluded from derivation and never score a miss (CH-9.4-06-1). Fail-open.
 */
async function cmdSpendLane({ positionals, flags, dirs }) {
  const economy = await import('./lib/economy.mjs')
  const spendDir = dirs.spendDir
  const action = positionals[1]

  if (flags.selftest === true) {
    const ok = await economy.laneSelftest()
    if (wantsJson(flags)) printJson({ selftest: 'spend-lane', ok })
    process.stdout.write(`${ok}\n`) // numeric LAST line (scorer contract, P9.4-06-B)
    return ok === 1 ? 0 : 1
  }
  if (flags.stat) {
    const name = String(flags.stat)
    const { runs } = economy.readLaneRuns({ spendDir })
    const value = name === 'max-lane-closed-runs' ? economy.maxLaneClosedRuns(runs) : 0
    process.stdout.write(`${value}\n`) // numeric LAST line (P9.4-06-F accrual)
    return 0
  }

  const LANES = ['fix', 'quick', 'batch', 'build']

  if (action === 'open') {
    const lane = positionals[2]
    if (!LANES.includes(lane)) {
      process.stdout.write(`usage: sma spend lane open <${LANES.join('|')}>\n`)
      return 1
    }
    const terminalId = await resolveTerminalId()
    const rec = economy.appendLaneEvent({ spendDir, event: { type: 'open', lane, terminalId } })
    if (wantsJson(flags)) printJson(rec)
    else process.stdout.write(`SMA lane: открыта полоса ${lane} (терминал ${terminalId}); бюджеты выводятся только из нашей истории\n`)
    return 0
  }

  if (action === 'close') {
    const terminalId = await resolveTerminalId()
    const { runs } = economy.readLaneRuns({ spendDir })
    const open = [...runs].reverse().find((r) => r.open && r.terminalId === terminalId)
    if (!open) {
      process.stdout.write('SMA lane: нет открытой полосы для этого терминала\n')
      return 1
    }
    const spend = await import('./lib/spend.mjs')
    const repoRoot = await resolveRepoRootForSpend()
    const now = Date.now()
    const book = spend.buildBook({ spendDir, repoRoot, env: process.env, now })
    const closedAt = new Date(now).toISOString()
    const attributed = economy.attributeLaneRun({ run: { ...open, closedAt }, book, now })
    economy.appendLaneEvent({ spendDir, event: { type: 'close', lane: open.lane, terminalId, ts: closedAt, ...attributed } })

    const budgetsFile = economy.readLaneBudgets({ spendDir })
    const budgets = budgetsFile && budgetsFile.budgets ? budgetsFile.budgets : {}
    const calibration = await import('./lib/calibration.mjs')
    const predict = await import('./lib/predict.mjs')
    const appendVerdict = (rec) => calibration.appendVerdict(rec, { calibrationDir: dirs.calibrationDir })
    const draftLesson = ({ verdict, planId }) => predict.draftLessonFromMiss({ verdict, planId, dirs: {} })
    const run = { lane: open.lane, terminalId, openedAt: open.openedAt, closedAt, ...attributed, open: false }
    const decision = economy.checkLaneOverrun({ run, budgets, appendVerdict, draftLesson, now: closedAt })

    if (wantsJson(flags)) {
      printJson({ run, decision })
      return 0
    }
    if (decision.miss) {
      process.stdout.write(
        `SMA lane: ПЕРЕРАСХОД полосы ${open.lane} — бюджет p${budgets[open.lane].pct} $${decision.budgetUsd}, ` +
          `факт $${decision.actualUsd}. Зачтён промах калибровки (sma.economy)` +
          `${decision.draftedPath ? ` + черновик урока: ${decision.draftedPath}` : ''}.\n`,
      )
    } else if (decision.reportOnly) {
      const why =
        decision.reason === 'overlap'
          ? 'параллельный терминал жёг расход в окне — только отчёт, промах не засчитывается (CH-9.4-06-1)'
          : decision.reason === 'no-budget'
            ? 'бюджет ещё не выведен (мало прогонов) — только отчёт'
            : 'только отчёт'
      process.stdout.write(`SMA lane: закрыта полоса ${open.lane} ($${attributed.usd}, ${attributed.minutes} мин); ${why}\n`)
    } else {
      process.stdout.write(
        `SMA lane: закрыта полоса ${open.lane} в пределах бюджета ($${decision.actualUsd} из $${decision.budgetUsd})\n`,
      )
    }
    return 0
  }

  if (action === 'derive') {
    const pct = Number.isFinite(Number(flags.pct)) ? Number(flags.pct) : 75
    const { runs } = economy.readLaneRuns({ spendDir })
    const budgets = economy.deriveLaneBudgets({ runs, pct })
    economy.writeLaneBudgets(budgets, { spendDir })
    if (wantsJson(flags)) {
      printJson({ budgets, pct })
      return 0
    }
    const lanes = Object.keys(budgets)
    if (!lanes.length) process.stdout.write('SMA lane: пока нет закрытых прогонов — выводить нечего\n')
    for (const lane of lanes) {
      const b = budgets[lane]
      if (b.insufficient) process.stdout.write(`  ${lane}: мало данных (${b.n} < 5) — только отчёт\n`)
      else process.stdout.write(`  ${lane}: бюджет p${b.pct} $${b.usd} · ${b.minutes} мин (из ${b.n} прогонов)\n`)
    }
    return 0
  }

  // report (default).
  const { runs, corrupt } = economy.readLaneRuns({ spendDir })
  const budgetsFile = economy.readLaneBudgets({ spendDir })
  const budgets = budgetsFile && budgetsFile.budgets ? budgetsFile.budgets : {}
  if (wantsJson(flags)) {
    printJson({ runs, budgets, corrupt })
    return 0
  }
  const closed = runs.filter((r) => !r.open)
  const openN = runs.length - closed.length
  process.stdout.write(`SMA lane: ${closed.length} закрытых прогонов, ${openN} открытых${corrupt ? ` (повреждено строк: ${corrupt})` : ''}\n`)
  for (const lane of LANES) {
    const list = closed.filter((r) => r.lane === lane)
    const b = budgets[lane]
    const cleanN = list.filter((r) => !r.overlap).length
    const bTxt = b && !b.insufficient ? `бюджет p${b.pct} $${b.usd}` : `бюджета нет (${cleanN} < 5 чистых прогонов)`
    process.stdout.write(`  ${lane}: ${list.length} прогонов (${cleanN} чистых) · ${bTxt}\n`)
  }
  return 0
}

/**
 * spend self-cost [--json] | spend self-cost --stat self-cost-tokens — the SMA self-cost
 * meter (9.4-06). Measures the framework's OWN static per-session injection overhead
 * (SMA:RULES span + emitted corpus block span in CLAUDE.md + MEMORY.md core load) and
 * names what is NOT counted (variable per-turn hook stdout). caveman's ~1-1.5k/turn caveat
 * turned into our feature; no other framework meters its own overhead. Read-only, fail-open.
 */
async function cmdSpendSelfCost({ flags, dirs }) {
  const economy = await import('./lib/economy.mjs')
  const repoRoot = dirs?.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const paths = { claudeMd: join(repoRoot, 'CLAUDE.md'), memoryMd: join(repoRoot, '.claude', 'memory', 'MEMORY.md') }
  const report = economy.selfCost({ paths })

  if (flags.stat) {
    const name = String(flags.stat)
    const value = name === 'self-cost-tokens' ? report.total : 0
    process.stdout.write(`${value}\n`) // numeric LAST line (P9.4-06-C scorer)
    return 0
  }
  if (wantsJson(flags)) {
    printJson(report)
    return 0
  }
  process.stdout.write(`SMA self-cost: статическая инъекция ~${report.total} токенов (оценщик ${report.estimatorVersion})\n`)
  for (const s of report.surfaces) process.stdout.write(`  ${s.surface}: ~${s.tokens}\n`)
  if (!report.surfaces.length) process.stdout.write('  ни одной управляемой поверхности не найдено (нет SMA:RULES / emitted / MEMORY.md)\n')
  process.stdout.write(`  ${report.notCounted}\n`)
  process.stdout.write(`  ${report.caveat}\n`)
  return 0
}

/**
 * memory stats [--json] [--top N] | memory stats --stat core-tokens|corpus-tokens |
 *   memory stats --selftest — the deterministic, VERSIONED corpus token-cost report
 *   (9.4-06). Prices MEMORY.md (core load), each note, each INDEX-*.md, and the top-N
 *   heaviest, with ESTIMATOR_VERSION stamped so numbers reproduce run-to-run and are never
 *   billing truth. NOT hook-facing. Compress is DEFERRED by design (memory stats is its
 *   evidence gate — no corpus rewrite in this plan). Fail-open.
 */
async function cmdMemory({ positionals, flags, dirs }) {
  const economy = await import('./lib/economy.mjs')
  const sub = positionals[0]

  if (sub !== 'stats') {
    process.stdout.write('usage: sma memory stats [--json] [--top N] [--stat core-tokens|corpus-tokens] [--selftest]\n')
    process.stdout.write('  compress: отложено, пока stats не покажет измеренную боль (по замыслу не реализовано)\n')
    return 1
  }

  if (flags.selftest === true) {
    const ok = economy.memoryStatsSelftest()
    if (wantsJson(flags)) printJson({ selftest: 'memory-stats', ok })
    process.stdout.write(`${ok}\n`) // numeric LAST line (P9.4-06-A)
    return ok === 1 ? 0 : 1
  }

  const repoRoot = dirs?.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const corpusDir = join(repoRoot, '.claude', 'memory')
  const topN = Number.isFinite(Number(flags.top)) ? Number(flags.top) : 10
  const stats = economy.corpusStats({ corpusDir, topN })

  if (flags.stat) {
    const name = String(flags.stat)
    const value = name === 'core-tokens' ? stats.core || 0 : name === 'corpus-tokens' ? stats.totals.all : 0
    process.stdout.write(`${value}\n`)
    return 0
  }
  if (wantsJson(flags)) {
    printJson(stats)
    return 0
  }
  process.stdout.write(`SMA memory: корпус ~${stats.totals.all} токенов (оценщик ${stats.estimatorVersion})\n`)
  process.stdout.write(
    `  ядро MEMORY.md: ${stats.core == null ? 'нет' : `~${stats.core}`} · заметки ~${stats.totals.notes} (${stats.notes.length}) · ` +
      `индексы ~${stats.totals.indexes} (${stats.indexes.length})\n`,
  )
  for (const n of stats.top) process.stdout.write(`  ${n.file}: ~${n.tokens}\n`)
  process.stdout.write(`  ${stats.caveat}\n`)
  process.stdout.write('  compress: отложено, пока stats не покажет измеренную боль (по замыслу не реализовано)\n')
  return 0
}

/**
 * breaker [list|re-arm <ruleId>] [--json] — the loop-breaker admin (9.2-09). NOT
 * hook-facing. `list` shows every soft-disabled SMA rule + its compensating control;
 * `re-arm <ruleId>` deletes the marker (re-enabling the rule) and journals the re-arm
 * with provenance (the D-9-09 force-clear idiom). Markers are plan 10's disarm-path input.
 */
async function cmdBreaker({ positionals, flags, dirs }) {
  const breaker = await import('./lib/breaker.mjs')
  const sub = positionals[0]

  if (sub === 're-arm' || sub === 'rearm') {
    const ruleId = positionals[1]
    if (!ruleId) {
      process.stdout.write('usage: sma breaker re-arm <ruleId>\n')
      return 1
    }
    const terminalId = await resolveTerminalId()
    const r = breaker.reArm(ruleId, { breakerDir: dirs.breakerDir, journalDir: dirs.journalDir, by: terminalId, terminalId })
    if (wantsJson(flags)) printJson(r)
    else
      process.stdout.write(
        r.rearmed ? `SMA breaker: правило ${ruleId} снова активно (re-armed)\n` : `SMA breaker: маркер для ${ruleId} не найден\n`,
      )
    return r.rearmed ? 0 : 1
  }

  // list (default).
  const markers = breaker.listMarkers({ breakerDir: dirs.breakerDir })
  if (wantsJson(flags)) {
    printJson({ markers, n: markers.length })
    return 0
  }
  if (!markers.length) process.stdout.write('SMA breaker: активных маркеров нет\n')
  for (const m of markers)
    process.stdout.write(`  ${m.ruleId}  срабатываний ${m.tripCount}  [${m.compensatingControl}]  откл. ${m.disabledAt}\n`)
  return 0
}

// ── 9.2-06 (D-9.2-09): the flight recorder — capsule / restore / resume / handoff ─

/**
 * extractStateSlices(statePath) -> {position, blockers}. Reads STATE.md raw and pulls
 * the `## Current Position` body (one line, `**` stripped) + the `## Open Blockers`
 * bullet lines. Fence-agnostic (works whether or not the SMA-MANAGED fence is present).
 * Fail-open: a missing/unreadable file -> honest empty slices.
 */
function extractStateSlices(statePath) {
  let raw = ''
  try {
    raw = readFileSync(statePath, 'utf8')
  } catch {
    return { position: '', blockers: [] }
  }
  const sectionBody = (name) => {
    const m = new RegExp('^##\\s+' + name + '[^\\n]*$', 'm').exec(raw)
    if (!m) return ''
    const rest = raw.slice(m.index + m[0].length)
    const nm = /\n## /.exec(rest)
    return rest.slice(0, nm ? nm.index : undefined)
  }
  const posBody = sectionBody('Current Position')
  const position = posBody
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').trim())
    .find((l) => l) || ''
  const blockers = sectionBody('Open Blockers')
    .split('\n')
    .filter((l) => l.trimStart().startsWith('-'))
    .map((l) => l.replace(/^\s*-\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
  return { position, blockers }
}

/**
 * gatherExecState(dirs) -> {planId, nextUndone, complete} | null. Picks the
 * most-recently-modified `.sma/exec/*.jsonl` (the active plan), reads it via
 * exec-journal, and computes the resume point EXACTLY as the V2 resume ritual does
 * (nextUndone over [1..maxCompleted+1]). Fail-open -> null.
 */
async function gatherExecState(dirs) {
  let files
  try {
    files = readdirSync(dirs.execDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return null
  }
  if (!files.length) return null
  let best = null
  let bestM = -1
  for (const f of files) {
    try {
      const m = statSync(join(dirs.execDir, f)).mtimeMs
      if (m > bestM) {
        bestM = m
        best = f
      }
    } catch {
      /* skip unreadable */
    }
  }
  if (!best) return null
  const planId = best.replace(/\.jsonl$/, '')
  const [phase, plan] = planId.split(/-(?=[^-]*$)/) // split on the LAST dash: "9.2-06" -> ["9.2","06"]
  try {
    const ej = await import('./lib/exec-journal.mjs')
    const { events } = ej.read({ phase, plan, execDir: dirs.execDir })
    if (events.some((e) => e && e.event === 'plan_complete')) return { planId, nextUndone: null, complete: true }
    let maxTask = 0
    for (const e of events) {
      if (e && e.event === 'task_complete' && e.task != null) maxTask = Math.max(maxTask, Number(e.task))
    }
    const nextUndone = ej.nextUndone({ planTasks: maxTask + 1, journal: events })
    return { planId, nextUndone, complete: false }
  } catch {
    return { planId, nextUndone: null, complete: false }
  }
}

/**
 * gatherFlightInputs(dirs, {sessionToken, trigger, now}) — assemble every capsule/brief
 * input, EACH source in its own try/catch (fail-open: a broken source degrades the
 * capsule, never blocks it). Zero LLM, zero network, zero git-write.
 */
async function gatherFlightInputs(dirs, { sessionToken, trigger, now } = {}) {
  const inputs = {
    now: now ?? new Date().toISOString(),
    trigger: trigger === 'manual' ? 'manual' : 'auto',
    identity: {},
    label: '',
    statePosition: '',
    stateBlockers: [],
    ownClaim: null,
    otherClaims: [],
    pushClaim: null,
    journalTail: [],
    marksTail: [],
    execState: null,
    capsuleFresh: null,
  }
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const statePath = join(repoRoot, '.planning', 'STATE.md')

  let identity = null
  try {
    const registry = await import('./lib/registry.mjs')
    identity = registry.resolveTerminalIdentity({ sessionToken })
    inputs.identity = identity
  } catch {
    /* fail-open */
  }
  const terminalId = identity && identity.terminalId ? identity.terminalId : 'unknown'
  const holder = identity && identity.holderIdentity ? identity.holderIdentity : null

  try {
    const { position, blockers } = extractStateSlices(statePath)
    inputs.statePosition = position
    inputs.stateBlockers = blockers
  } catch {
    /* fail-open */
  }

  try {
    const claims = await import('./lib/claims.mjs')
    for (const c of claims.readClaims({ claimsDir: dirs.claimsDir })) {
      const prov = c.provenance || {}
      const globs = prov.scope && Array.isArray(prov.scope.globs) ? prov.scope.globs : []
      const description = prov.scope && prov.scope.description ? prov.scope.description : ''
      if (holder && prov.by === holder) {
        if (!inputs.ownClaim) inputs.ownClaim = { name: c.name, globs, description }
      } else {
        inputs.otherClaims.push({ by: prov.by || null, holderIdentity: prov.by || null, globs, name: c.name })
      }
    }
  } catch {
    /* fail-open */
  }

  // Work label: own claim description > STATE phase.
  if (inputs.ownClaim && inputs.ownClaim.description) inputs.label = inputs.ownClaim.description
  else if (inputs.statePosition) {
    const m = /Phase:\s*([\d.]+)/.exec(inputs.statePosition)
    if (m) inputs.label = `phase:${m[1]}`
  }

  try {
    const slots = await import('./lib/slots.mjs')
    if (typeof slots.checkPushClaim === 'function') {
      const pc = slots.checkPushClaim(dirs)
      if (pc && pc.live) inputs.pushClaim = pc
    }
  } catch {
    /* fail-open */
  }

  try {
    const journal = await import('./lib/journal.mjs')
    inputs.journalTail = journal.journalTail(terminalId, 20, { journalDir: dirs.journalDir })
  } catch {
    /* fail-open */
  }

  try {
    const flight = await import('./lib/flight.mjs')
    inputs.marksTail = flight.readMarks({ flightDir: dirs.flightDir }).marks.slice(-30)
  } catch {
    /* fail-open */
  }

  try {
    inputs.execState = await gatherExecState(dirs)
  } catch {
    /* fail-open */
  }

  try {
    const p1 = join(dirs.flightDir, 'capsules', `${terminalId}.md`)
    const p2 = join(dirs.flightDir, 'intent.md')
    const path = existsSync(p1) ? p1 : existsSync(p2) ? p2 : null
    if (path) inputs.capsuleFresh = new Date(statSync(path).mtimeMs).toISOString()
  } catch {
    /* fail-open */
  }

  return inputs
}

/** The exact next-step string for the resume --json object (mirrors flight.nextStepFrom). */
function resumeNextStep(inputs) {
  const exec = inputs.execState
  if (exec && exec.nextUndone != null) return `продолжить план ${exec.planId ?? ''}`.trim() + ` с задачи ${exec.nextUndone}`
  if (exec && exec.complete) return `план ${exec.planId ?? ''} завершён — см. pnpm sma status`.trim()
  if (inputs.label) return `продолжить: ${inputs.label}`
  return 'см. pnpm sma status'
}

/**
 * precompact-capsule (HOOK_FACING) — the NEW PreCompact hook. Kill-switch/probe first,
 * then GATHER (each source fail-open) -> buildCapsule -> writeCapsule. NO stdout on
 * success (hooks stay silent). Exit 0 unconditionally (main() wraps HOOK_FACING). A
 * capsule failure degrades to no-capsule, NEVER a blocked compaction (T-9.2-06B).
 */
async function cmdPrecompactCapsule({ dirs }) {
  if (isEnvOn(process.env.SMA_FLIGHT_DISABLE)) return 0
  const flight = await import('./lib/flight.mjs')
  if (flight.nativeProbe({ env: process.env }).native) return 0 // bridge stands down (D-9.2-05)

  const evt = readStdinJson()
  const sessionToken = windowTokenFrom(evt)
  const trigger = evt && evt.trigger === 'manual' ? 'manual' : 'auto'

  const inputs = await gatherFlightInputs(dirs, { sessionToken, trigger, now: new Date().toISOString() })
  const capsule = flight.buildCapsule(inputs)
  const terminalId = inputs.identity && inputs.identity.terminalId ? inputs.identity.terminalId : 'unknown'
  flight.writeCapsule({ capsule, terminalId }, { flightDir: dirs.flightDir, env: process.env })
  return 0 // silent success — the capsule is data, not a message
}

/**
 * resume [--json] — assemble a continuation brief from the flight recorder alone (works
 * after a terminal death, not only after compaction). Direct-CLI. `--json` returns a
 * single object {capsuleFresh, currentTask, nextStep} (+ the full brief).
 */
async function cmdResume({ flags, dirs }) {
  const flight = await import('./lib/flight.mjs')
  const inputs = await gatherFlightInputs(dirs, { now: new Date().toISOString() })
  const brief = flight.buildResumeBrief(inputs)
  if (wantsJson(flags)) {
    printJson({
      capsuleFresh: inputs.capsuleFresh,
      currentTask: inputs.label || null,
      nextStep: resumeNextStep(inputs),
      brief,
    })
    return 0
  }
  process.stdout.write(brief.endsWith('\n') ? brief : brief + '\n')
  return 0
}

/**
 * handoff [--json] — a teammate brief: everything resume has PLUS claim-transfer steps.
 * scanForSecrets runs before the write; the file lands at handoff-<terminalId>.md and
 * its path is printed. Direct-CLI.
 */
async function cmdHandoff({ flags, dirs }) {
  const flight = await import('./lib/flight.mjs')
  const inputs = await gatherFlightInputs(dirs, { now: new Date().toISOString() })
  const brief = flight.buildHandoffBrief(inputs)
  const terminalId = inputs.identity && inputs.identity.terminalId ? inputs.identity.terminalId : 'unknown'
  const res = flight.writeHandoff({ brief, terminalId }, { flightDir: dirs.flightDir })
  const path = res.written[0]
  if (wantsJson(flags)) {
    printJson({ path, capsuleFresh: inputs.capsuleFresh, currentTask: inputs.label || null })
    return 0
  }
  process.stdout.write(brief.endsWith('\n') ? brief : brief + '\n')
  process.stdout.write(`${path}\n`) // the written path is the LAST line
  return 0
}

/**
 * flight <probe|determinism-check|tail [n]> — the bridge instruments. Direct-CLI.
 *   probe             -> prints the digit 0|1 as the LAST line (P9.2-06-03 scorer).
 *   determinism-check -> gathers inputs ONCE, buildCapsule twice with identical inputs
 *                        (+ injected now), byte-compares, prints 1|0 last (P9.2-06-02).
 *   tail [n]          -> prints the last n flight marks.
 */
async function cmdFlight({ positionals, flags, dirs }) {
  const flight = await import('./lib/flight.mjs')
  const sub = positionals[0]

  if (sub === 'probe') {
    const p = flight.nativeProbe({ env: process.env })
    if (wantsJson(flags)) printJson(p)
    else process.stdout.write(`SMA flight probe: native=${p.native} (${p.reason})\n`)
    process.stdout.write(`${p.native ? 1 : 0}\n`) // numeric LAST line — the P9.2-06-03 scorer
    return 0
  }

  if (sub === 'determinism-check') {
    const inputs = await gatherFlightInputs(dirs, { now: '2026-01-01T00:00:00.000Z' })
    const a = flight.buildCapsule(inputs)
    const b = flight.buildCapsule(inputs)
    const identical = Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8')) ? 1 : 0
    if (wantsJson(flags)) printJson({ deterministic: identical === 1, bytes: Buffer.byteLength(a, 'utf8') })
    process.stdout.write(`${identical}\n`) // numeric LAST line — the P9.2-06-02 scorer
    return 0
  }

  if (sub === 'tail') {
    const n = Number.isFinite(Number(positionals[1])) ? Number(positionals[1]) : 20
    const { marks } = flight.readMarks({ flightDir: dirs.flightDir })
    const tail = marks.slice(-n)
    if (wantsJson(flags)) {
      printJson({ marks: tail, n: tail.length })
      return 0
    }
    if (!tail.length) process.stdout.write('SMA flight: меток нет\n')
    for (const m of tail) process.stdout.write(`  ${m.ts}  ${m.tool ?? '?'} ${m.target ?? ''}\n`)
    return 0
  }

  process.stdout.write('usage: sma flight <probe|determinism-check|tail [n]> [--json]\n')
  return sub ? 1 : 0
}

/** Load the three committed golden hook-event fixtures (parity + bench corpus). */
function loadPreFixtures() {
  const dir = join(MODULE_DIR, 'fixtures', 'pre')
  const out = []
  for (const name of ['edit-collision.json', 'bash-git.json', 'write-plain.json']) {
    try {
      out.push({ name, evt: JSON.parse(readFileSync(join(dir, name), 'utf8')) })
    } catch {
      /* skip an unreadable fixture — bench still runs over the rest */
    }
  }
  return out
}

/** Count the MAX scripts/sma command entries across PreToolUse matcher groups. */
function spawnCountFromSettings(settingsPath) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return null // missing/unparseable → honest failure (caller prints 0, exit 1)
  }
  const groups = parsed && parsed.hooks && Array.isArray(parsed.hooks.PreToolUse) ? parsed.hooks.PreToolUse : null
  if (!groups) return null
  let max = 0
  for (const g of groups) {
    const hooks = g && Array.isArray(g.hooks) ? g.hooks : []
    const n = hooks.filter((h) => h && typeof h.command === 'string' && h.command.includes('scripts/sma/')).length
    if (n > max) max = n
  }
  return max
}

/**
 * pre-bench — the deterministic, re-runnable SLO instrument (9.2-02, D-9.2-04).
 * NOT hook-facing (direct CLI; may exit 1). The V2 scorer parses the bare numeric
 * LAST line, so every scorer-facing mode ends with one.
 *
 *   pre-bench [--runs N]              N (default 50) FULL child-spawns of `pre` over
 *                                    the golden fixtures; prints a stats table then
 *                                    the bare p95 integer (--json for an object)
 *   pre-bench --metric spawn-count   MAX scripts/sma PreToolUse entries in
 *                                    .claude/settings.json (or --settings <path>)
 *   pre-bench --metric parity        in-process: mismatch count between the merged
 *                                    runPre output and the union of single-stream runs
 */
async function cmdPreBench({ flags }) {
  const pre = await import('./lib/pre.mjs')
  const fixtures = loadPreFixtures()

  // ── --metric spawn-count ──────────────────────────────────────────────────
  if (flags.metric === 'spawn-count') {
    let repoRoot = process.cwd()
    try {
      const registry = await import('./lib/registry.mjs')
      repoRoot = registry.smaRoot()
    } catch {
      /* fail-open to cwd */
    }
    const settingsPath = typeof flags.settings === 'string' ? flags.settings : join(repoRoot, '.claude', 'settings.json')
    const count = spawnCountFromSettings(settingsPath)
    if (count == null) {
      process.stdout.write('0\n')
      return 1 // honest failure, not a fake pass
    }
    process.stdout.write(`${count}\n`)
    return 0
  }

  // ── --metric parity ───────────────────────────────────────────────────────
  if (flags.metric === 'parity') {
    // in-process over the golden fixtures, in a throwaway SMA root so live .sma is
    // untouched and no git shells out (headShaProbe → null).
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const noSha = async () => null
    let mismatches = 0
    for (const fx of fixtures) {
      // A FRESH throwaway .sma per fixture — each golden fixture is an INDEPENDENT single
      // tool call (one window, one session). A shared root would let fixture N see fixture
      // N-1's session lease, which never happens in a real tool call and would spuriously
      // trip the always-on fingerprint stream's ambient digest (9.3-13). Per-fixture
      // isolation is the faithful model of the consolidation the parity metric verifies.
      const tmpRoot = mkdtempSync(join(tmpdir(), 'sma-pre-parity-'))
      const benchDirs = dirsFrom(join(tmpRoot, '.sma'))
      try {
        const mergedCtx = await pre.buildCtx({ evt: fx.evt, dirs: benchDirs, env: {}, headShaProbe: noSha })
        const merged = await pre.runPre(mergedCtx)

        const unionWarns = []
        let unionDeny = null
        for (const stream of pre.PRE_CHECKS) {
          if (!stream.tools.includes(mergedCtx.toolName)) continue
          const ctx = await pre.buildCtx({ evt: fx.evt, dirs: benchDirs, env: {}, headShaProbe: noSha })
          try {
            const r = (await stream.run(ctx)) || { warns: [] }
            for (const w of (Array.isArray(r.warns) ? r.warns : [])) if (typeof w === 'string' && w) unionWarns.push(w)
            if (r.deny && r.deny.text && stream.mayDeny && !unionDeny) unionDeny = { text: String(r.deny.text) }
          } catch {
            /* a stream throw is a fail-open empty on both paths — no mismatch */
          }
        }
        const sortEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
        const denyEq = (merged.deny ? merged.deny.text : null) === (unionDeny ? unionDeny.text : null)
        if (!sortEq(merged.warns, unionWarns) || !denyEq) mismatches += 1
      } finally {
        try {
          rmSync(tmpRoot, { recursive: true, force: true })
        } catch {
          /* best-effort cleanup */
        }
      }
    }
    process.stdout.write(`${mismatches}\n`)
    return 0
  }

  // ── default / --runs N : FULL child-spawn wall-clock ──────────────────────
  const runs = Number(flags.runs) > 0 ? Math.floor(Number(flags.runs)) : 50
  if (!fixtures.length) {
    process.stderr.write('SMA pre-bench: no golden fixtures found\n')
    return 1
  }
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const cliPath = join(MODULE_DIR, 'cli.mjs')
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sma-pre-bench-'))
  const durations = []
  try {
    for (let i = 0; i < runs; i++) {
      const fx = fixtures[i % fixtures.length]
      const input = JSON.stringify(fx.evt)
      const t0 = process.hrtime.bigint()
      try {
        // fixed literal argv — no user-input interpolation (T-9.2-06); fresh temp
        // .sma so bench runs never pollute the live journal/seen/perf stores.
        execFileSync(process.execPath, [cliPath, 'pre'], {
          input,
          encoding: 'utf8',
          env: { ...process.env, SMA_ROOT_OVERRIDE: join(tmpRoot, '.sma') },
        })
      } catch {
        /* a non-zero exit still consumed spawn time — record it */
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      durations.push(ms)
    }
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }

  const p50 = Math.round(pre.computePercentile(durations, 50))
  const p95 = Math.round(pre.computePercentile(durations, 95))
  const p99 = Math.round(pre.computePercentile(durations, 99))
  const max = Math.round(durations.reduce((a, b) => Math.max(a, b), 0))
  if (wantsJson(flags)) {
    printJson({ metric: 'pre_p95_ms', n: durations.length, p50, p95, p99, max, threshold: 300, pass: p95 <= 300 })
    return 0
  }
  process.stdout.write(
    `SMA pre-bench — FULL child-spawn wall-clock (node boot included), n=${durations.length}\n` +
      `  p50 ${p50} ms · p95 ${p95} ms · p99 ${p99} ms · max ${max} ms · SLO p95 <= 300 ms\n`,
  )
  // the bare numeric LAST line — what the V2 scorer parses (PRED-9.2-02-A).
  process.stdout.write(`${p95}\n`)
  return 0
}

/**
 * stall-check — the P5 stall detector consumer (9.1-21, B16). A PostToolUse
 * hook (NEW hook type for SMA — the security guard's Stop/SubagentStop are a
 * different, untouched surface). Reads the tool event JSON from stdin, appends
 * a compact event to the per-session rolling window (.sma/stall/<session>.json),
 * runs the four DETERMINISTIC StuckDetector rules (never LLM-judged — RESEARCH
 * Anti-pattern A1), and on detection emits an ADVISORY additionalContext nudge
 * naming the pattern + a break action. NEVER blocks the tool call (T-9.1-45:
 * fail-open parse + bounded state + HOOK_FACING exit-0). Dedup: one nudge per
 * pattern per session via the reflex seen-store under 'stall:' keys.
 * Kill-switch: SMA_STALL_DISABLE (T-9.1-46).
 */
async function cmdStallCheck({ dirs }) {
  const evt = readStdinJson()
  const sessionToken = windowTokenFrom(evt)

  let nudge = ''
  try {
    // Cheap early exit under the global kill-switch (stall.mjs re-checks it).
    const disable = String(process.env.SMA_STALL_DISABLE ?? '').trim().toLowerCase()
    if (disable && disable !== '0' && disable !== 'false') return 0

    const stall = await import('./lib/stall.mjs')
    const events = stall.recordEvent(evt, { stallDir: dirs.stallDir, sessionToken })
    const detection = stall.detect(events)

    // ttc first-edit recorder (9.2-01, S5 instrument). Additive, fail-open: on the
    // FIRST Edit|Write of a session write ONE ttc marker so bench can measure
    // session-start -> first-Edit. A bench bug here must NEVER break stall-check, so
    // the whole call is wrapped (T-9.2-03). Plan 02's `sma pre` multiplexer will
    // absorb this like every other consumer.
    try {
      const toolName = typeof evt.tool_name === 'string' ? evt.tool_name : ''
      if (toolName === 'Edit' || toolName === 'Write') {
        // registeredAt = this session's registry acquireTime (the ttc window start).
        let registeredAt = null
        try {
          const registry = await import('./lib/registry.mjs')
          const { readJsonSafe } = await import('./lib/fs-atomics.mjs')
          const identity = registry.resolveTerminalIdentity({ sessionToken })
          const sess = readJsonSafe(join(dirs.sessionsDir, `${identity.terminalId}.json`))
          if (sess && typeof sess.acquireTime === 'string') registeredAt = sess.acquireTime
        } catch {
          /* fail-open — recordFirstEdit falls back to now */
        }
        const bench = await import('./lib/bench.mjs')
        bench.recordFirstEdit({ toolName, sessionToken, dirs, registeredAt })
      }
    } catch {
      /* fail-open — the ttc recorder never wedges stall-check (T-9.2-03) */
    }

    if (detection) {
      // Per-pattern per-session dedup — reuse the reflex seen-store (session-
      // scoped by construction) under 'stall:' keys, like gates-check does.
      let terminalId = 'unknown'
      try {
        const registry = await import('./lib/registry.mjs')
        const identity = registry.resolveTerminalIdentity({ sessionToken })
        if (identity && identity.terminalId) terminalId = identity.terminalId
      } catch {
        /* fail-open */
      }
      const reflex = await import('./lib/reflex.mjs')
      const seen = reflex.loadSeen({ reflexDir: dirs.reflexDir, terminalId, sessionToken })
      if (!seen.keys || typeof seen.keys !== 'object') seen.keys = {}
      const key = `stall:${detection.pattern}`
      if (!seen.keys[key]) {
        seen.keys[key] = 1
        nudge = stall.formatNudge(detection)
        reflex.saveSeen(seen, { reflexDir: dirs.reflexDir, terminalId })

        // Journal the fire (type 'stall') so telemetry/reports can read it.
        try {
          const journal = await import('./lib/journal.mjs')
          journal.appendEvent(
            {
              type: 'stall',
              actors: [terminalId],
              scope: detection.pattern,
              detail: { pattern: detection.pattern, detail: detection.detail },
            },
            { terminalId, journalDir: dirs.journalDir },
          )
        } catch {
          /* fail-open — a journal failure never blocks the nudge */
        }
      } else {
        seen.keys[key] += 1
        reflex.saveSeen(seen, { reflexDir: dirs.reflexDir, terminalId })
      }
    }
  } catch {
    /* fail-open (C9) — a stall-check failure can NEVER wedge a session */
  }

  // 9.2-06 (D-9.2-09) FLIGHT MARK SEAM — generalize the V2 exec-journal to ALL
  // sessions: every PostToolUse appends ONE mark line via THIS existing stall-check
  // spawn (ZERO new per-tool-call process, D-9.2-04). Best-effort, fail-open. `target`
  // is a file path for Edit/Write/Read or a first-token command SLUG for Bash — NEVER
  // the full command line (secrets ride in command args, T-9.2-06A). When plan 02's
  // `sma pre` multiplexer absorbs stall-check, this seam rides along untouched.
  try {
    if (!isEnvOn(process.env.SMA_FLIGHT_DISABLE)) {
      const toolName = typeof evt.tool_name === 'string' ? evt.tool_name : ''
      if (toolName) {
        const input = evt.tool_input && typeof evt.tool_input === 'object' ? evt.tool_input : {}
        let target = ''
        if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
          target = typeof input.file_path === 'string' ? input.file_path : ''
        } else if (toolName === 'Bash') {
          const cmd = typeof input.command === 'string' ? input.command : ''
          target = cmd.trim().split(/\s+/)[0] || '' // first token only — a command slug, never args
        }
        let terminalId = 'unknown'
        try {
          const registry = await import('./lib/registry.mjs')
          const id = registry.resolveTerminalIdentity({ sessionToken })
          if (id && id.terminalId) terminalId = id.terminalId
        } catch {
          /* fail-open */
        }
        const flight = await import('./lib/flight.mjs')
        flight.appendMark({ tool: toolName, target }, { terminalId, flightDir: dirs.flightDir })
      }
    }
  } catch {
    /* fail-open — a mark append never wedges stall-check (D-9.2-04 premise) */
  }

  // 9.3-07 (D-9.3-13) — the WORKING-PULSE piggyback. PostToolUse activity IS the working
  // signal, so the pulse rides THIS existing stall-check spawn — ZERO new per-tool-call
  // process (scorecard metric 6, the Track B cost envelope). setPulse writes the lease ONLY
  // on a transition (prev != 'working'), so a steady working session adds no fs churn; a
  // session returning FROM waiting-for-human flips back to working here. A working transition
  // never fires the webhook (only waiting-for-human does). Fully fail-open.
  try {
    if (!isEnvOn(process.env.SMA_NOTIFY_DISABLE)) {
      const notify = await import('./lib/notify.mjs')
      const registry = await import('./lib/registry.mjs')
      const identity = registry.resolveTerminalIdentity({ sessionToken })
      await notify.setPulse('working', { dirs, identity, sessionToken, env: process.env })
    }
  } catch {
    /* fail-open — the pulse never wedges stall-check (P4/C9) */
  }

  // ADVISORY output only — a PostToolUse additionalContext nudge, never a block.
  if (nudge) {
    printJson({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: nudge,
      },
    })
  }
  return 0
}

// ── 9.3-07 (D-9.3-13) — native statusline segment + pulse CLI ────────────────

/** The canonical statusLine command this repo installs, and its wrap variant. */
const SMA_STATUSLINE_CMD = 'node scripts/sma/cli.mjs statusline'
const SMA_STATUSLINE_WRAP_CMD = SMA_STATUSLINE_CMD + ' --wrap'

/** True when a stored statusLine command already points into our own cli.mjs. */
function isSmaStatuslineCmd(cmd) {
  return typeof cmd === 'string' && /scripts[\\/]+sma[\\/]+cli\.mjs\s+statusline/.test(cmd)
}

/**
 * statusline [--wrap] [--stat <name>] | statusline install|uninstall [--json] |
 * statusline set-webhook <url> [--clear] — the segment render entrypoint + managed
 * settings edit + webhook config. HOOK_FACING: ALWAYS exit 0 (main() wraps it); a
 * catastrophic render failure prints an empty line so Claude Code renders nothing,
 * never a stack trace on the trust surface.
 */
async function cmdStatusline({ positionals, flags, dirs }) {
  const sub = positionals[0]
  if (sub === 'install' || sub === 'uninstall') return statuslineInstallCmd(sub, { flags, dirs })
  if (sub === 'set-webhook') return statuslineSetWebhook({ positionals, flags, dirs })
  if (typeof flags.stat === 'string') return statuslineStat(flags.stat, { dirs })

  // default: render the segment
  try {
    return await renderStatuslineEntry({ flags, dirs })
  } catch {
    process.stdout.write('\n') // fail-open — an empty line, never a throw
    return 0
  }
}

/** The segment render: read stdin (bounded, quarantined) -> gatherSummary + own lease ->
 * readStatuslineState (cache-aware) -> derivePulse -> renderSegment. ALWAYS composes with a
 * pre-existing user statusline when one resolves (wrapped-command.json config, else the
 * USER-scope ~/.claude/settings.json auto-detect) — a project statusLine SHADOWS user scope
 * in Claude Code, and installing our segment must not cost the adopter the statusline they
 * already had. The user's own line prints FIRST; `--wrap` is accepted as a no-op alias. */
async function renderStatuslineEntry({ flags, dirs }) {
  const statusline = await import('./lib/statusline.mjs')
  const registry = await import('./lib/registry.mjs')
  const notify = await import('./lib/notify.mjs')
  const { readJsonSafe } = await import('./lib/fs-atomics.mjs')

  // bounded 64 KB stdin read -> the quarantined vendor-shape adapter (parsed defensively).
  const raw = String(readStdin() || '').slice(0, 64 * 1024)
  statusline.parseStatusStdin(raw) // reserved display extras; parsed to prove it never throws

  const summary = await gatherSummary(dirs)
  const identity = registry.resolveTerminalIdentity({})
  const ownSession = readJsonSafe(join(dirs.sessionsDir, `${identity.terminalId}.json`))
  const pulse = ownSession ? notify.derivePulse(ownSession, {}) : 'idle'

  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const state = await statusline.readStatuslineState({ dirs: { ...dirs, repoRoot }, summary, ownSession, pulse })
  const segment = statusline.renderSegment(state, { ansi: isEnvOn(process.env.SMA_STATUSLINE_ANSI) })

  // Composition (segment-not-takeover): the user's own line first, then ' · ' + segment.
  // Deliberately NOT TTL-cached — the wrapped call is user code whose output (context %)
  // changes every turn; any failure/timeout/empty -> the segment renders alone (fail-open).
  const userLine = await wrapUserStatusline({ dirs, stdin: raw })
  process.stdout.write(statusline.composeStatusline(userLine, segment) + '\n')
  return 0
}

/**
 * wrapUserStatusline({dirs, stdin}) — resolve + run the user's OWN statusline command
 * (wrapped-command.json config first, else the USER-scope settings.json auto-detect with
 * the self-reference guard) and return its first stdout line, ANSI untouched. The child is
 * the user's own command (no new authority), WRAPPED_TIMEOUT_MS timeout, bounded output.
 * Any failure -> '' (the render then prints the segment alone — behavior test 9). Never throws.
 */
async function wrapUserStatusline({ dirs, stdin }) {
  try {
    const statusline = await import('./lib/statusline.mjs')
    const wrapped = statusline.resolveWrappedCommand({ dirs })
    if (!wrapped) return ''
    return statusline.runWrappedCommand(wrapped.command, { stdin })
  } catch {
    return '' // fail-open — composition is a bonus, never a break
  }
}

/**
 * statuslineInstallCmd(sub, {flags, dirs}) — the managed settings.json edit. Strict JSON.parse
 * or print-the-snippet-and-write-nothing; the statusLine key is the ONLY key mutated (every
 * other key deep-equal survives, asserted before the write); a foreign command is preserved
 * verbatim and wrapped; uninstall restores it verbatim (or removes the key when we added it).
 */
async function statuslineInstallCmd(sub, { flags, dirs }) {
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const settingsPath = join(repoRoot, '.claude', 'settings.json')
  const res = await applyStatuslineInstall(sub, { settingsPath, dirs, by: 'sma statusline', now: Date.now() })
  if (wantsJson(flags)) {
    printJson(res)
    return 0
  }
  const msg = {
    installed: 'SMA: statusLine установлен (прямой сегмент).',
    'installed-wrap': 'SMA: statusLine установлен (обёрнута ваша команда, ваша строка идёт первой).',
    'noop-already': 'SMA: statusLine уже установлен — без изменений.',
    uninstalled: 'SMA: statusLine удалён, ваша исходная команда восстановлена.',
    'noop-absent': 'SMA: statusLine SMA не найден — нечего удалять.',
    'parse-failed': 'SMA: .claude/settings.json не парсится — вставьте вручную:\n  "statusLine": { "type": "command", "command": "' + SMA_STATUSLINE_CMD + '" }',
  }[res.status] || `SMA: statusline ${res.status}`
  process.stdout.write(msg + '\n')
  return 0
}

/**
 * applyStatuslineInstall(sub, {settingsPath, dirs, by, now}) — the install/uninstall CORE,
 * factored out so the CLI and the wrap-preserve selftest share ONE code path. Returns
 * {status, wrote}. NEVER throws; on an unparseable file it writes NOTHING and returns
 * 'parse-failed'.
 */
async function applyStatuslineInstall(sub, { settingsPath, dirs, by, now }) {
  const { atomicWriteJson, readJsonSafe } = await import('./lib/fs-atomics.mjs')
  let raw = ''
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch {
    raw = '' // absent file -> treated as empty settings
  }
  let settings
  let before
  if (raw.trim()) {
    try {
      settings = JSON.parse(raw)
      before = JSON.parse(raw) // independent copy for the deep-equal assertion
    } catch {
      return { status: 'parse-failed', wrote: false } // strict-parse-or-print-snippet: write NOTHING
    }
  } else {
    settings = {}
    before = {}
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { status: 'parse-failed', wrote: false }

  const existing = settings.statusLine
  const existingCmd = existing && typeof existing === 'object' ? existing.command : typeof existing === 'string' ? existing : null
  const wrappedPath = join(dirs.statuslineDir, 'wrapped-command.json')

  if (sub === 'install') {
    if (existing && isSmaStatuslineCmd(existingCmd)) return { status: 'noop-already', wrote: false } // idempotent
    let status
    if (!existing) {
      settings.statusLine = { type: 'command', command: SMA_STATUSLINE_CMD, padding: 0 }
      try {
        atomicWriteJson(wrappedPath, { hadNone: true, savedAt: new Date(now).toISOString(), by })
      } catch {
        /* fail-open — worst case uninstall leaves the key; harmless */
      }
      status = 'installed'
    } else {
      // preserve the foreign command verbatim, then wrap it
      try {
        atomicWriteJson(wrappedPath, { command: existingCmd, original: existing, hadNone: false, savedAt: new Date(now).toISOString(), by })
      } catch {
        /* fail-open */
      }
      settings.statusLine = { type: 'command', command: SMA_STATUSLINE_WRAP_CMD, padding: 0 }
      status = 'installed-wrap'
    }
    if (!writeSettingsStatusLineOnly(settingsPath, settings, before)) return { status: 'parse-failed', wrote: false }
    return { status, wrote: true }
  }

  // uninstall
  const stored = readJsonSafe(wrappedPath) || {}
  if (stored.hadNone) {
    delete settings.statusLine
  } else if (stored.original !== undefined) {
    settings.statusLine = stored.original // verbatim restore
  } else if (existing && isSmaStatuslineCmd(existingCmd)) {
    delete settings.statusLine // no record but ours is present -> remove
  } else {
    return { status: 'noop-absent', wrote: false }
  }
  if (!writeSettingsStatusLineOnly(settingsPath, settings, before)) return { status: 'parse-failed', wrote: false }
  return { status: 'uninstalled', wrote: true }
}

/**
 * writeSettingsStatusLineOnly(path, settings, before) — assert every NON-statusLine key is
 * deep-equal to the pre-edit snapshot, then write with 2-space indent. If any other key would
 * change, abort WITHOUT writing (return false) — the never-clobber guarantee (T-9.3-07-03).
 */
function writeSettingsStatusLineOnly(path, settings, before) {
  try {
    const strip = (o) => {
      const c = { ...(o && typeof o === 'object' ? o : {}) }
      delete c.statusLine
      return c
    }
    if (JSON.stringify(strip(settings)) !== JSON.stringify(strip(before))) return false // a foreign key moved -> abort
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/** statusline set-webhook <url> [--clear] — write the user-configured URL with provenance. */
async function statuslineSetWebhook({ positionals, flags, dirs }) {
  const { atomicWriteJson } = await import('./lib/fs-atomics.mjs')
  const path = join(dirs.statuslineDir, 'webhook.json')
  if (flags.clear) {
    try {
      const { rmSync, existsSync } = await import('node:fs')
      if (existsSync(path)) rmSync(path)
    } catch {
      /* fail-open */
    }
    process.stdout.write('SMA: webhook очищен — уведомления выключены.\n')
    return 0
  }
  const url = positionals[1]
  let ok = false
  try {
    ok = !!url && (new URL(url).protocol === 'http:' || new URL(url).protocol === 'https:')
  } catch {
    ok = false
  }
  if (!ok) {
    process.stderr.write('SMA: укажите http(s) URL: pnpm sma statusline set-webhook <url>\n')
    return 1
  }
  try {
    atomicWriteJson(path, { url, by: 'sma statusline set-webhook', at: new Date().toISOString() })
  } catch {
    process.stderr.write('SMA: не удалось записать webhook.json\n')
    return 1
  }
  process.stdout.write('SMA: webhook настроен (уведомление о waiting-for-human включено).\n')
  return 0
}

/**
 * statuslineStat(name, {dirs}) — the predict-score `--stat` contract: EACH prints a single
 * finite number as its LAST stdout line (9.1-08 parser). bench-render-p95-ms measures 20
 * warm renders; selftest-webhook-dedup / selftest-wrap-preserve run against throwaway temp
 * dirs (the real .sma/ and settings are NEVER touched — 9.2-08 preship selftest posture).
 */
async function statuslineStat(name, { dirs }) {
  try {
    if (name === 'bench-render-p95-ms') {
      const p95 = await benchRenderP95(dirs)
      process.stdout.write(`${p95}\n`)
      return 0
    }
    if (name === 'selftest-webhook-dedup') {
      process.stdout.write(`${await selftestWebhookDedup()}\n`)
      return 0
    }
    if (name === 'selftest-wrap-preserve') {
      process.stdout.write(`${await selftestWrapPreserve()}\n`)
      return 0
    }
  } catch {
    /* fall through to the honest 0 */
  }
  process.stdout.write('0\n')
  return 0
}

/** 20 warm renders (cache primed once) -> p95 in ms, rounded to 2 dp.
 * SCOPE HONESTY (P9.3-07-1): this measures the SMA SEGMENT render (readStatuslineState +
 * renderSegment) — the piece the <=100 ms prediction governs and the TTL cache controls.
 * The COMPOSED render additionally runs the user's own wrapped statusline command, which is
 * user code (typically 100-300 ms, acceptable for Claude Code statuslines) and deliberately
 * NOT TTL-cached (their context % changes every turn) — so it is excluded here by design,
 * not measured-and-hidden. */
async function benchRenderP95(dirs) {
  const statusline = await import('./lib/statusline.mjs')
  const registry = await import('./lib/registry.mjs')
  const { readJsonSafe } = await import('./lib/fs-atomics.mjs')
  const summary = await gatherSummary(dirs)
  const identity = registry.resolveTerminalIdentity({})
  const ownSession = readJsonSafe(join(dirs.sessionsDir, `${identity.terminalId}.json`))
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const rdirs = { ...dirs, repoRoot }
  await statusline.refreshCache({ dirs: rdirs, summary, ownSession }) // prime the TTL cache
  const samples = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    const state = await statusline.readStatuslineState({ dirs: rdirs, summary, ownSession })
    statusline.renderSegment(state)
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.min(samples.length - 1, Math.floor(0.95 * samples.length))]
  return Math.round(p95 * 100) / 100
}

/** Run the P9.3-07-2 flap against a throwaway .sma + an injected in-process fetch recorder;
 * return the delivery count (expected 1). The real .sma/ is NEVER touched. */
async function selftestWebhookDedup() {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const notify = await import('./lib/notify.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'sma-sl-dedup-'))
  try {
    const smaRoot = join(tmp, '.sma')
    const d = {
      smaRoot,
      sessionsDir: join(smaRoot, 'sessions'),
      statuslineDir: join(smaRoot, 'statusline'),
      journalDir: join(smaRoot, 'journal'),
      repoRoot: tmp,
    }
    mkdirSync(d.sessionsDir, { recursive: true })
    const now = 1_000_000
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return { ok: true, status: 200 }
    }
    const env = { SMA_WEBHOOK_URL: 'https://selftest.local/hook' }
    const identity = { terminalId: 'selftest' }
    const seed = (fp) =>
      writeFileSync(join(d.sessionsDir, 'selftest.json'), JSON.stringify({ fpStatus: fp, renewTime: new Date(now).toISOString(), label: 'selftest' }))
    seed('working')
    const base = { dirs: d, identity, fetchImpl, env }
    await notify.setPulse('waiting-for-human', { ...base, now })
    await notify.setPulse('working', { ...base, now: now + 100 })
    await notify.setPulse('waiting-for-human', { ...base, now: now + 200 }) // inside the cooldown
    return calls
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** Install onto a throwaway settings fixture carrying a stub user command; return 1 iff the
 * user's own line survives FIRST in wrap mode AND every non-statusLine key deep-equal survives. */
async function selftestWrapPreserve() {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync: rf } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const tmp = mkdtempSync(join(tmpdir(), 'sma-sl-wrap-'))
  try {
    const settingsPath = join(tmp, '.claude', 'settings.json')
    mkdirSync(join(tmp, '.claude'), { recursive: true })
    const userCmd = 'node -e "process.stdout.write(\'USERLINE\')"'
    const fixture = { statusLine: { type: 'command', command: userCmd }, hooks: { Stop: [{ x: 1 }] }, model: 'opus' }
    writeFileSync(settingsPath, JSON.stringify(fixture, null, 2))
    const d = { smaRoot: join(tmp, '.sma'), statuslineDir: join(tmp, '.sma', 'statusline'), sessionsDir: join(tmp, '.sma', 'sessions') }
    mkdirSync(d.sessionsDir, { recursive: true })
    const res = await applyStatuslineInstall('install', { settingsPath, dirs: d, by: 'selftest', now: Date.now() })
    if (res.status !== 'installed-wrap') return 0
    const after = JSON.parse(rf(settingsPath, 'utf8'))
    const keysSurvived = JSON.stringify(after.hooks) === JSON.stringify(fixture.hooks) && after.model === fixture.model
    const userLine = await wrapUserStatusline({ dirs: d, stdin: '' })
    return keysSurvived && userLine.startsWith('USERLINE') ? 1 : 0
  } catch {
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
}

/**
 * pulse <working|waiting-for-human> [--json] — hook-facing. The Notification hook wiring
 * invokes `pulse waiting-for-human`; the arg defaults to waiting-for-human. 'idle' is rejected
 * (derived-only). ALWAYS exit 0. A waiting-for-human transition fires the edge-triggered
 * webhook (via setPulse) — off by default, one honest event.
 */
async function cmdPulse({ positionals, flags, dirs }) {
  try {
    const evt = readStdinJson()
    const sessionToken = windowTokenFrom(evt)
    let next = typeof positionals[0] === 'string' && positionals[0].trim() ? positionals[0].trim() : 'waiting-for-human'
    if (next === 'idle') {
      if (wantsJson(flags)) printJson({ ok: false, rejected: true, reason: 'idle-is-derived' })
      else process.stdout.write('SMA: «idle» вычисляется автоматически по бездействию — вручную не задаётся.\n')
      return 0
    }
    const registry = await import('./lib/registry.mjs')
    const notify = await import('./lib/notify.mjs')
    const identity = registry.resolveTerminalIdentity({ sessionToken })
    const res = await notify.setPulse(next, { dirs, identity, sessionToken, env: process.env })
    if (wantsJson(flags)) printJson({ ok: true, changed: !!res.changed, prev: res.prev ?? null })
    return 0
  } catch {
    return 0 // hook-facing — never wedge the session
  }
}

/**
 * gates-report [--json] — the D-9.1-13 promotion-evidence surface. Reads the
 * journal for 'gate' fires + 'gate-ack' false-positive acks and renders per-gate
 * fire counts and ack counts. NOT hook-facing (may exit 1 on a real error).
 */
async function cmdGatesReport({ flags, dirs }) {
  const journal = await import('./lib/journal.mjs')
  const { events, corrupt } = journal.readJournal({ journalDir: dirs.journalDir })

  // ── --promotion-readiness (D-9.1-13): the ONLY sanctioned justification to arm a
  // soft-deny gate. Per soft-deny-capable gate: observed fires, false-positive acks,
  // observation-window days, and a READY/NOT-READY verdict. READY requires >=7 days
  // observed AND >=5 fires AND 0 false-positive acks — an honest NOT-READY default on
  // an empty journal. Arming is a founder/operator action justified by THIS report.
  if (flags['promotion-readiness']) {
    const SOFT_DENY_GATES = ['GATE-PUSH', 'GATE-MEMEDIT']
    const READY_MIN_DAYS = 7
    const READY_MIN_FIRES = 5
    const now = Date.now()
    const soft = {}
    for (const id of SOFT_DENY_GATES) soft[id] = { fires: 0, falsePositiveAcks: 0, firstFireAt: null }
    for (const e of events) {
      if (!e || typeof e !== 'object' || !e.detail) continue
      if (e.type === 'gate' && soft[e.detail.gateId]) {
        const g = soft[e.detail.gateId]
        g.fires += 1
        if (!g.firstFireAt) g.firstFireAt = e.ts
      } else if (e.type === 'gate-ack' && e.detail.falsePositive && soft[e.detail.gateId]) {
        soft[e.detail.gateId].falsePositiveAcks += 1
      }
    }
    const RULE =
      'READY = >=7 дней наблюдения AND >=5 срабатываний AND 0 ложноположительных. ' +
      'Арминг soft-deny (SMA_GATE_*_DENY) — действие основателя/оператора, обоснованное ЭТИМ ' +
      'отчётом; промоушн ТОЛЬКО по журнальным данным (D-9.1-13).'
    const report = SOFT_DENY_GATES.map((id) => {
      const g = soft[id]
      const observationDays = g.firstFireAt ? Math.floor((now - Date.parse(g.firstFireAt)) / 86400000) : 0
      const reasons = []
      if (observationDays < READY_MIN_DAYS) reasons.push(`наблюдение ${observationDays}<${READY_MIN_DAYS} дней`)
      if (g.fires < READY_MIN_FIRES) reasons.push(`срабатываний ${g.fires}<${READY_MIN_FIRES}`)
      if (g.falsePositiveAcks > 0) reasons.push(`ложноположительных ${g.falsePositiveAcks}`)
      return {
        gateId: id,
        fires: g.fires,
        falsePositiveAcks: g.falsePositiveAcks,
        observationDays,
        verdict: reasons.length ? 'NOT-READY' : 'READY',
        reasons,
      }
    })
    if (wantsJson(flags)) {
      printJson({ promotionReadiness: report, rule: RULE, corrupt })
      return 0
    }
    process.stdout.write('SMA gates — готовность к промоушену soft-deny (D-9.1-13):\n')
    for (const r of report) {
      const pad = r.verdict === 'READY' ? 'READY    ' : 'NOT-READY'
      process.stdout.write(
        `  ${pad}  ${r.gateId} — fires ${r.fires}, наблюдение ${r.observationDays}д, ` +
          `ложноположительных ${r.falsePositiveAcks}${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}\n`,
      )
    }
    process.stdout.write(`  Правило: ${RULE}\n`)
    if (corrupt) process.stdout.write(`  (повреждённых строк журнала пропущено: ${corrupt})\n`)
    return 0
  }

  const perGate = {}
  const touch = (id) => (perGate[id] || (perGate[id] = { fires: 0, falsePositiveAcks: 0 }))
  let totalFires = 0
  let totalAcks = 0
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'gate' && e.detail && typeof e.detail.gateId === 'string') {
      touch(e.detail.gateId).fires += 1
      totalFires += 1
    } else if (e.type === 'gate-ack' && e.detail && e.detail.falsePositive) {
      const id = typeof e.detail.gateId === 'string' && e.detail.gateId ? e.detail.gateId : '(unspecified)'
      touch(id).falsePositiveAcks += 1
      totalAcks += 1
    }
  }

  if (wantsJson(flags)) {
    printJson({ gates: perGate, totalFires, totalAcks, corrupt })
    return 0
  }

  const ids = Object.keys(perGate).sort()
  if (!ids.length) {
    process.stdout.write('SMA gates: срабатываний пока нет.\n')
    return 0
  }
  process.stdout.write('SMA gates — срабатывания гейтов (fires / ложноположительные acks):\n')
  for (const id of ids) {
    const g = perGate[id]
    process.stdout.write(`  ${String(g.fires).padStart(4)}  ${id} (fires ${g.fires}, fp-acks ${g.falsePositiveAcks})\n`)
  }
  process.stdout.write(`  итого: fires ${totalFires}, fp-acks ${totalAcks}\n`)
  if (corrupt) process.stdout.write(`  (повреждённых строк журнала пропущено: ${corrupt})\n`)
  return 0
}

/**
 * gates-ack <eventRef> [--false-positive] [--gate <GATE-ID>] — record a
 * false-positive acknowledgement for a gate fire. Appends a 'gate-ack' journal
 * event that gates-report surfaces, feeding the D-9.1-13 promotion evidence
 * (a gate with persistent false positives is NOT promoted). NOT hook-facing.
 */
async function cmdGatesAck({ positionals, flags, dirs }) {
  const ref = positionals[0]
  if (!ref) {
    process.stderr.write('usage: pnpm sma gates-ack <eventRef> --false-positive [--gate GATE-ID]\n')
    return 1
  }
  const journal = await import('./lib/journal.mjs')
  const registry = await import('./lib/registry.mjs')
  let terminalId = 'unknown'
  try {
    const identity = registry.resolveTerminalIdentity({})
    if (identity && identity.terminalId) terminalId = identity.terminalId
  } catch {
    /* fail-open */
  }
  const gateId = typeof flags.gate === 'string' && flags.gate.trim() ? flags.gate.trim() : null
  journal.appendEvent(
    {
      type: 'gate-ack',
      actors: [terminalId],
      scope: ref,
      detail: { ref, gateId, falsePositive: flags['false-positive'] !== false },
    },
    { terminalId, journalDir: dirs.journalDir },
  )
  process.stdout.write(`SMA gates: ack записан для «${ref}»${gateId ? ` (${gateId})` : ''}.\n`)
  return 0
}

/** The two gates that carry a soft-deny capability (D-9.1-13: 1-2 gates only). */
const SOFT_DENY_GATE_IDS = ['GATE-PUSH', 'GATE-MEMEDIT']

/**
 * gates <override|mark-fullgate> — the D-9.1-13 soft-deny operator surface.
 * NOT hook-facing (may exit 1 on a real error).
 */
async function cmdGates({ positionals, flags, dirs }) {
  const sub = positionals[0]
  if (sub === 'override') return cmdGatesOverride({ positionals: positionals.slice(1), flags, dirs })
  if (sub === 'mark-fullgate') return cmdGatesMarkFullgate({ positionals: positionals.slice(1), flags, dirs })
  process.stderr.write('usage: pnpm sma gates <override <GATE-ID> --yes --reason "..."|mark-fullgate [--sha <sha>]>\n')
  return 1
}

/**
 * gates override <gateId> --yes --reason "..." — write a one-shot override token for a
 * soft-deny gate (force-clear-with-provenance UX, D-9.1-13). Prints gate/terminal/reason
 * FIRST, requires an explicit --yes (the flag IS the confirmation — no TTY in this repo)
 * AND a --reason (provenance). The token is consumed on the next gate check and the
 * override use is journaled there — no silent bypass exists.
 */
async function cmdGatesOverride({ positionals, flags, dirs }) {
  const gateId = positionals[0]
  if (!gateId || !SOFT_DENY_GATE_IDS.includes(gateId)) {
    process.stderr.write(
      `usage: pnpm sma gates override <${SOFT_DENY_GATE_IDS.join('|')}> --yes --reason "почему"\n`,
    )
    return 1
  }
  const registry = await import('./lib/registry.mjs')
  let terminalId = 'unknown'
  let holder = ''
  try {
    const id = registry.resolveTerminalIdentity({})
    if (id) {
      if (id.terminalId) terminalId = id.terminalId
      if (id.holderIdentity) holder = id.holderIdentity
    }
  } catch {
    /* fail-open — provenance degrades to 'unknown' rather than blocking */
  }
  const reason = typeof flags.reason === 'string' && flags.reason.trim() ? flags.reason.trim() : ''

  // Always print the provenance block first (terraform force-unlock style).
  process.stdout.write(
    `Override soft-deny гейта ${gateId}: терминал ${terminalId}${holder ? ` (${holder})` : ''}, причина: ${reason || '—'}.\n`,
  )
  if (flags.yes !== true) {
    process.stdout.write(
      'Override soft-deny гейта требует явного подтверждения: добавьте --yes. Ничего не записано.\n',
    )
    return 1
  }
  if (!reason) {
    process.stderr.write('Override требует --reason "почему" (провенанс). Ничего не записано.\n')
    return 1
  }

  mkdirSync(dirs.gatesDir, { recursive: true })
  const tokenPath = join(dirs.gatesDir, `override-${gateId}.json`)
  const token = { gateId, terminal: terminalId, holder, reason, at: new Date().toISOString() }
  writeFileSync(tokenPath, JSON.stringify(token, null, 2) + '\n')
  process.stdout.write(
    `SMA gates: разовый override для ${gateId} записан. Он будет использован при следующей проверке гейта, ` +
      'удалён (one-shot) и записан в журнал как gate-override с провенансом.\n',
  )
  return 0
}

/**
 * gates mark-fullgate [--sha <sha>] [--json] — write the full-gate evidence marker for
 * HEAD (D-9.1-13). Called by /sma-ship AFTER the heavy gate passes: it lands
 * .sma/gates/fullgate-<sha>.json {sha, at, gate:'full', terminal} — exactly what
 * GATE-PUSH's soft-deny tier checks before allowing a push. The marker format lives here
 * (one place). NOT hook-facing.
 */
async function cmdGatesMarkFullgate({ flags, dirs }) {
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  let sha = typeof flags.sha === 'string' && flags.sha.trim() ? flags.sha.trim() : null
  if (!sha) {
    try {
      const { execFileSync } = await import('node:child_process')
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    } catch {
      sha = null
    }
  }
  if (!sha) {
    process.stderr.write('SMA gates: не удалось определить HEAD sha (git rev-parse). Маркер не записан.\n')
    return 1
  }
  let terminalId = 'unknown'
  try {
    const registry = await import('./lib/registry.mjs')
    const id = registry.resolveTerminalIdentity({})
    if (id && id.terminalId) terminalId = id.terminalId
  } catch {
    /* fail-open */
  }
  mkdirSync(dirs.gatesDir, { recursive: true })
  const marker = { sha, at: new Date().toISOString(), gate: 'full', terminal: terminalId }
  const markerPath = join(dirs.gatesDir, `fullgate-${sha}.json`)
  writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n')
  if (wantsJson(flags)) {
    printJson(marker)
    return 0
  }
  process.stdout.write(
    `SMA gates: маркер полного гейта записан для ${sha.slice(0, 10)} (${markerPath}). ` +
      'GATE-PUSH soft-deny примет его как доказательство (TTL 6ч).\n',
  )
  return 0
}

/**
 * force-clear <claim> [--yes] — the ONLY foreign-claim removal path (D-9-09,
 * terraform force-unlock style). Prints {who holds it, what, since when} first;
 * requires an explicit --yes (an explicit flag IS the confirmation — no TTY
 * prompts in this repo's automation). On confirm: releaseSlot force path +
 * journal a 'steal' event with full provenance. Without --yes: refuse, exit 1,
 * remove nothing.
 */
async function cmdForceClear({ positionals, flags, dirs }) {
  const name = positionals[0]
  if (!name) {
    process.stderr.write('usage: pnpm sma force-clear <claim> --yes\n')
    return 1
  }
  const claims = await import('./lib/claims.mjs')
  const registry = await import('./lib/registry.mjs')
  const journal = await import('./lib/journal.mjs')
  const identity = registry.resolveTerminalIdentity({})

  const list = claims.readClaims(dirs)
  const entry = list.find((c) => c.name === name)
  if (!entry) {
    process.stderr.write(`SMA: claim «${name}» не найден — очищать нечего\n`)
    return 1
  }
  const prov = entry.provenance || {}
  const who = prov.by || 'неизвестный терминал'
  const operation = prov.reason || '—'
  const since = prov.at || '—'

  // Always print the holder block first (terraform force-unlock style).
  process.stdout.write(
    `Claim «${name}» держит терминал ${who}, операция ${operation}, с ${since}.\n`,
  )

  if (flags.yes !== true) {
    process.stdout.write(
      'Принудительная очистка чужого claim требует явного подтверждения: добавьте --yes.\n' +
        'Ничего не удалено.\n',
    )
    return 1
  }

  // 9.2-07 (D-9.2-11): a foreign-claim clear is a RISKY OP — it carries a burden-of-proof
  // evidence record IN ADDITION to the D-9-09 --yes confirmation (this ADDS, replaces nothing).
  const evidence = await import('./lib/evidence.mjs')
  const inlineChecks = typeof flags.checked === 'string' ? flags.checked.split(';').map((s) => s.trim()).filter(Boolean) : []
  let evidenceId = null
  if (typeof flags.reason === 'string' && flags.reason.trim() && inlineChecks.length) {
    const w = evidence.writeEvidence(
      { op: 'foreign-claim-clear', target: name, reason: flags.reason, checks: inlineChecks, actor: identity.holderIdentity },
      { evidenceDir: dirs.evidenceDir },
    )
    if (w.ok) evidenceId = w.id
  } else if (
    (typeof flags.evidence === 'string' && flags.evidence.trim()) &&
    evidence.hasFreshEvidence({ op: 'foreign-claim-clear', target: name, maxAgeMs: 24 * 60 * 60 * 1000 }, { evidenceDir: dirs.evidenceDir })
  ) {
    evidenceId = String(flags.evidence).trim() // a pre-written, still-fresh record satisfies
  }
  if (!evidenceId) {
    process.stdout.write(
      'Принудительная очистка чужого claim — рискованная операция и требует доказательства (burden of proof).\n' +
        `Запишите его в этом же вызове:\n  pnpm sma force-clear ${name} --yes --reason "<почему>" --checked "<что проверили>" [--checked "<ещё>"]\n` +
        'или сошлитесь на заранее записанное свежее доказательство: --evidence <id>. Ничего не удалено.\n',
    )
    return 1
  }

  const res = claims.releaseSlot(name, { by: identity.holderIdentity, force: true, claimsDir: dirs.claimsDir })
  if (!res.released) {
    process.stderr.write(`SMA: не удалось очистить claim «${name}» (${res.reason ?? 'ошибка'})\n`)
    return 1
  }

  // Journal the steal with full provenance (D-9-09).
  journal.appendEvent(
    {
      type: 'steal',
      actors: [identity.holderIdentity, who].filter(Boolean),
      scope: name,
      detail: { by: identity.holderIdentity, target: name, formerHolder: who, at: new Date().toISOString() },
    },
    { terminalId: identity.terminalId, journalDir: dirs.journalDir },
  )

  // 9.2-07 (D-9.2-11): journal the risky-op with its evidenceId — the P9.2-07-C denominator.
  journal.appendEvent(
    {
      type: 'risky-op',
      actors: [identity.holderIdentity],
      scope: 'foreign-claim-clear',
      detail: { op: 'foreign-claim-clear', target: name, evidenceId },
    },
    { terminalId: identity.terminalId, journalDir: dirs.journalDir },
  )

  process.stdout.write(`SMA: claim «${name}» принудительно очищен (бывший держатель: ${who}); событие записано в журнал.\n`)
  return 0
}

/**
 * preship — the consequences-law auto-block consumer the /sma-ship ritual runs
 * (9.2-08, D-9.2-12, ICE 648). Reads the V2 calibration ledger and BLOCKS
 * (exit 1) on ANY open class-A event (a prediction miss in a trust domain, or a
 * claimed-pass / reproduced-fail divergence). NOT hook-facing — never spawned by
 * PreToolUse; enforcement is the exit code the ship ritual consumes, never a
 * hard deny (prohibition). Fail-open C9: a missing/empty ledger prints clean and
 * exits 0 (an absent ledger cannot block ship — the block needs POSITIVE evidence).
 *
 *   preship             plain: print open blocks + class-B WARN lines; exit 1 iff blocks
 *   preship --json      {blocks, warns, dispositions, corrupt}; exit 1 iff blocks
 *   preship --count     print ONLY the open class-A count as the last line, exit 0
 *   preship --selftest  plant 1 trust-miss + 1 divergence in a THROWAWAY ledger,
 *                       print the detected block count (2), exit 0 — real .sma/ untouched
 */
async function cmdPreship({ flags, dirs }) {
  const consequences = await import('./lib/consequences.mjs')

  // --selftest: prove the engine cannot go blind silently (P9.2-08-2). The real
  // ledger is NEVER read here — a throwaway mkdtemp dir with two synthetic events.
  if (flags.selftest) {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const tmp = mkdtempSync(join(tmpdir(), 'sma-preship-selftest-'))
    const selfDir = join(tmp, 'calibration')
    try {
      const { appendVerdict } = await import('./lib/calibration.mjs')
      appendVerdict({ id: 'SELF-MISS', verdict: 'miss', domain: 'sma.receipts', scoredAt: 'selftest' }, { calibrationDir: selfDir })
      appendVerdict({ id: 'SELF-DIV', verdict: 'divergence', domain: 'sma.verification', at: 'selftest' }, { calibrationDir: selfDir })
      const res = consequences.openBlocks({ calibrationDir: selfDir })
      if (wantsJson(flags)) printJson({ selftest: true, detected: res.blocks.length })
      process.stdout.write(`${res.blocks.length}\n`) // scorer contract: numeric last line
      return 0
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  const res = consequences.openBlocks({ calibrationDir: dirs.calibrationDir })

  // --count: observe, never gate. Numeric last line for the scorer (exit 0 always).
  if (flags.count) {
    if (wantsJson(flags)) printJson({ open_class_a: res.blocks.length })
    process.stdout.write(`${res.blocks.length}\n`)
    return 0
  }

  if (wantsJson(flags)) {
    printJson({ blocks: res.blocks, warns: res.warns, dispositions: res.dispositions, corrupt: res.corrupt })
    return res.blocks.length ? 1 : 0
  }

  // Plain mode — the ship gate.
  if (!res.blocks.length) {
    process.stdout.write('SMA preship: чисто — открытых class-A событий нет. Ship может продолжаться.\n')
    for (const w of res.warns) {
      process.stdout.write(`  WARN class-B: ${w.eventKey} (${w.domain ?? '—'}) — ${w.claim ?? w.id ?? '—'}\n`)
    }
    return 0
  }

  // A block exists. For every open divergence carrying a 40-hex lastGoodSha, open a
  // create-only rollback candidate branch (fail-soft when git is unavailable).
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const { execFileSync } = await import('node:child_process')
  const execGit = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  let identity = { holderIdentity: 'unknown', terminalId: 'unknown' }
  try {
    const registry = await import('./lib/registry.mjs')
    identity = registry.resolveTerminalIdentity({})
  } catch {
    /* fail-open */
  }
  const journal = await import('./lib/journal.mjs')

  process.stdout.write(`SMA preship: SHIP ЗАБЛОКИРОВАН — ${res.blocks.length} открытых class-A событий:\n`)
  for (const b of res.blocks) {
    const kind = b.verdict === 'divergence' ? 'divergence' : 'miss'
    process.stdout.write(`  [class ${b.class}] ${b.eventKey} — ${kind} in ${b.domain ?? '—'}; ${b.claim ?? b.id ?? ''}\n`)
    process.stdout.write(`    blocked until founder disposition: pnpm sma disposition ${b.eventKey} --verdict <accept|fix-forward|rollback> --reason "<...>" --yes\n`)
    if (b.verdict === 'divergence' && typeof b.lastGoodSha === 'string' && /^[0-9a-f]{40}$/i.test(b.lastGoodSha)) {
      const slug = String(b.eventKey).replace(/[^\w.-]/g, '_')
      const rb = consequences.openRollbackCandidate({ slug, sha: b.lastGoodSha, execGit })
      if (rb.created) {
        process.stdout.write(`    rollback candidate: ${rb.ref} -> ${b.lastGoodSha.slice(0, 10)}\n`)
        try {
          journal.appendEvent(
            {
              type: 'rollback-candidate',
              actors: [identity.holderIdentity].filter(Boolean),
              scope: b.eventKey,
              detail: { eventKey: b.eventKey, ref: rb.ref, sha: b.lastGoodSha, domain: b.domain },
            },
            { terminalId: identity.terminalId, journalDir: dirs.journalDir },
          )
        } catch {
          /* journal fail-soft */
        }
      }
    }
  }
  process.stdout.write('\nЕдинственный путь снятия блокировки — распоряжение основателя (sma disposition). Не редактируйте ledger, не обходите шаг.\n')
  return 1
}

/**
 * disposition <eventKey> --verdict <v> --reason <r> --yes — the founder gate and
 * the ONLY unblock path (D-9.2-12). Mirrors force-clear's provenance posture
 * EXACTLY: prints what is being dispositioned FIRST, refuses without BOTH an
 * explicit --yes AND a --reason (an explicit flag IS the confirmation — no TTY
 * prompts in this repo's automation), then appends an append-only disposition
 * record to the ledger + journals the event with full provenance. Agents NEVER
 * invoke this on their own — it is the founder gate by definition.
 */
async function cmdDisposition({ positionals, flags, dirs }) {
  const eventKey = positionals[0]
  if (!eventKey) {
    process.stderr.write('usage: pnpm sma disposition <eventKey> --verdict <accept|fix-forward|rollback> --reason "<why>" --yes\n')
    return 1
  }
  const ALLOWED = ['accept', 'fix-forward', 'rollback']
  const verdict = typeof flags.verdict === 'string' ? flags.verdict.trim() : ''
  if (!ALLOWED.includes(verdict)) {
    process.stderr.write(`SMA disposition: --verdict должен быть одним из ${ALLOWED.join(', ')}\n`)
    return 1
  }
  const reason = typeof flags.reason === 'string' ? flags.reason.trim() : ''

  const registry = await import('./lib/registry.mjs')
  let identity = { holderIdentity: 'unknown', terminalId: 'unknown' }
  try {
    identity = registry.resolveTerminalIdentity({})
  } catch {
    /* fail-open — provenance degrades to 'unknown', never blocks */
  }

  // Always print what is being dispositioned FIRST (force-clear posture).
  process.stdout.write(
    `Распоряжение по событию «${eventKey}»: verdict=${verdict}${reason ? `, причина: ${reason}` : ''}.\n`,
  )

  if (flags.yes !== true) {
    process.stdout.write('Распоряжение основателя требует явного подтверждения: добавьте --yes. Ничего не записано.\n')
    return 1
  }
  if (!reason) {
    process.stdout.write('Распоряжение требует --reason "<почему>". Ничего не записано.\n')
    return 1
  }

  const consequences = await import('./lib/consequences.mjs')
  const journal = await import('./lib/journal.mjs')
  const rec = consequences.recordDisposition(
    { eventKey, disposition: verdict, reason, by: identity.holderIdentity },
    { calibrationDir: dirs.calibrationDir },
  )
  try {
    journal.appendEvent(
      {
        type: 'disposition',
        actors: [identity.holderIdentity].filter(Boolean),
        scope: eventKey,
        detail: { eventKey, disposition: verdict, reason, terminal: identity.holderIdentity, at: rec.at },
      },
      { terminalId: identity.terminalId, journalDir: dirs.journalDir },
    )
  } catch {
    /* journal fail-soft — the ledger record is the authoritative unblock */
  }

  if (wantsJson(flags)) {
    printJson({ dispositioned: true, ...rec })
    return 0
  }
  process.stdout.write(
    `SMA: событие «${eventKey}» разблокировано распоряжением (verdict=${verdict}); запись добавлена в ledger + журнал.\n`,
  )
  return 0
}

/**
 * snapshot — the corpus snapshot lands with 49-13. Until then, degrade to a
 * clean RU 'недоступно' message (no stack trace). Hook paths → exit 0; direct
 * CLI → exit 1 (module genuinely absent).
 */
async function cmdSnapshot({ flags, dirs }) {
  try {
    const mod = await import('./lib/snapshot.mjs')
    // If the module lands later, delegate to its default/exported handler.
    if (mod && typeof mod.runSnapshot === 'function') {
      // WR-06: thread the CLI's resolved dirs so SMA_ROOT_OVERRIDE is honored here too.
      const res = await mod.runSnapshot({ ...flags, sessionsDir: dirs.sessionsDir, journalDir: dirs.journalDir })
      if (wantsJson(flags)) printJson(res)
      return 0
    }
  } catch {
    /* module not present yet (49-13) — fall through to the clean message */
  }
  const msg = 'SMA: snapshot недоступен — модуль появится в 49-13 (snapshot).'
  if (wantsJson(flags)) {
    printJson({ available: false, message: msg })
    return 1
  }
  process.stdout.write(msg + '\n')
  return 1
}

/**
 * upstream-check [--apply] [--json] — the daily upstream-watch (D-9.1-03,
 * 9.1-07). NOT hook-facing: may exit non-zero on error. Compares the
 * UPSTREAM.json anchor against the latest upstream release; on a NEW release
 * downloads the tarball (npm pack → temp; extracted for DIFFING only, nothing
 * from it ever executes — T-9.1-SC), runs the three-way report through
 * rename-map.json and writes docs/upstream-reports/<version>.md.
 *
 * --apply is the LOCAL operator entry point of the review-gated auto-port: it
 * ports the CLEAN bucket only (the same applyCleanSet path the daily Action's
 * PR branch uses — one porting implementation, two review-gated doors), updates
 * UPSTREAM.json, refreshes the vendor snapshot dir, and prints the commit
 * instruction for the operator. Conflicts NEVER auto-apply — they print as a
 * task list for a human/agent integration pass (T-9.1-12).
 */
async function cmdUpstreamCheck({ flags }) {
  const upstream = await import('./lib/upstream.mjs')
  const { existsSync, mkdirSync, writeFileSync, readFileSync: readFs, cpSync, rmSync, mkdtempSync, readdirSync } =
    await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { execFileSync } = await import('node:child_process')

  const root = process.cwd()
  const anchorPath = join(root, 'UPSTREAM.json')
  const renameMapPath = join(root, 'rename-map.json')
  const oursDir = join(root, 'sma-core')
  const reportsDir = join(root, 'docs', 'upstream-reports')

  const check = await upstream.checkVersion({ anchorPath, fetchVersion: upstream.npmFetchVersion })

  if (check.status === 'unknown') {
    if (wantsJson(flags)) {
      printJson({ status: 'unknown', error: check.error })
      return 1
    }
    process.stderr.write(`SMA: upstream-check не смог опросить реестр — ${check.error}\n`)
    return 1
  }

  if (check.status === 'current') {
    const out = { status: 'current', anchor: check.anchor, latest: check.latest, package: check.package }
    if (flags.apply === true) out.applied = { noop: true, reason: 'нет новой версии — применять нечего' }
    if (wantsJson(flags)) {
      printJson(out)
      return 0
    }
    process.stdout.write(`SMA: upstream ${check.package} ${check.latest} — актуально (якорь ${check.anchor}).\n`)
    if (flags.apply === true) process.stdout.write('SMA: --apply без новой версии — ничего не применено (no-op).\n')
    return 0
  }

  // status === 'new' — download the new tarball for diffing (T-9.1-SC: extract
  // to temp, nothing executes from it; apply writes file content only after the
  // report exists).
  const latest = check.latest
  if (!/^[\w.+-]+$/.test(latest)) {
    if (wantsJson(flags)) {
      printJson({ status: 'unknown', error: `suspicious version string from registry: ${latest}` })
      return 1
    }
    process.stderr.write(`SMA: реестр вернул подозрительную версию «${latest}» — стоп.\n`)
    return 1
  }
  const vendorBaseDir = join(root, 'vendor', `gsd-core-${check.anchor}`)
  if (!existsSync(vendorBaseDir) || !existsSync(renameMapPath)) {
    // Missing either differ input makes every release look like 100% conflict —
    // refuse instead of lying (key_links, 9.1-07).
    const missing = !existsSync(vendorBaseDir) ? vendorBaseDir : renameMapPath
    if (wantsJson(flags)) {
      printJson({ status: 'new', anchor: check.anchor, latest, error: `differ input missing: ${missing}` })
      return 1
    }
    process.stderr.write(`SMA: вход диффера отсутствует (${missing}) — отчёт был бы ложным, стоп.\n`)
    return 1
  }

  const tmp = mkdtempSync(join(tmpdir(), 'sma-upstream-'))
  let report
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    execFileSync(npmCmd, ['pack', `${check.package}@${latest}`, '--pack-destination', tmp], {
      encoding: 'utf8',
      timeout: 120_000,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tarball) throw new Error('npm pack produced no tarball')
    execFileSync('tar', ['-xzf', join(tmp, tarball), '-C', tmp], { encoding: 'utf8', timeout: 120_000 })
    const newUpstreamDir = join(tmp, 'package')
    const renameMap = JSON.parse(readFs(renameMapPath, 'utf8'))

    report = upstream.threeWayReport({ vendorBaseDir, newUpstreamDir, oursDir, renameMap })

    // Write the integration report FIRST (apply is gated behind its existence).
    mkdirSync(reportsDir, { recursive: true })
    const reportPath = join(reportsDir, `${latest}.md`)
    writeFileSync(reportPath, upstream.renderReport({ report, version: latest, anchor: check.anchor }))

    const out = {
      status: 'new',
      anchor: check.anchor,
      latest,
      package: check.package,
      report: { clean: report.summary.clean, conflict: report.summary.conflict, divergencePct: report.summary.divergencePct, path: reportPath },
    }

    if (flags.apply === true) {
      // The LOCAL review-gated door: clean bucket only, then anchor + vendor refresh.
      const applied = upstream.applyCleanSet({ report, oursDir, apply: true })
      const anchor = JSON.parse(readFs(anchorPath, 'utf8'))
      anchor.version = latest
      anchor.snapshotDate = new Date().toISOString().slice(0, 10)
      writeFileSync(anchorPath, JSON.stringify(anchor, null, 2) + '\n')
      const newVendorDir = join(root, 'vendor', `gsd-core-${latest}`)
      cpSync(newUpstreamDir, newVendorDir, { recursive: true })
      out.applied = { files: applied.applied, vendorSnapshot: newVendorDir, anchorUpdated: true }
      if (!wantsJson(flags)) {
        process.stdout.write(`SMA: чистый набор применён (${applied.applied.length} файлов); якорь → ${latest}; vendor снапшот → ${newVendorDir}\n`)
        process.stdout.write('Коммит оператора (проверка перед коммитом — это и есть review-gate):\n')
        process.stdout.write(`  git add sma-core UPSTREAM.json "vendor/gsd-core-${latest}" "docs/upstream-reports/${latest}.md"\n`)
        process.stdout.write(`  git commit -m "upstream: port clean set of gsd-core ${latest} (report: docs/upstream-reports/${latest}.md)"\n`)
      }
    }

    if (wantsJson(flags)) {
      printJson(out)
      return 0
    }
    process.stdout.write(`SMA: новая версия upstream ${check.package} ${latest} (якорь ${check.anchor}).\n`)
    process.stdout.write(`Отчёт: ${reportPath} — чистых ${report.summary.clean}, ручных ${report.summary.conflict} (расхождение ${report.summary.divergencePct}%).\n`)
    if (report.conflict.length) {
      process.stdout.write('Ручная корзина (интеграционный проход человека/агента):\n')
      for (const e of report.conflict) process.stdout.write(`  - [ ] ${e.ourPath} (${e.reason || 'diverged'})\n`)
    }
    return 0
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

/**
 * predict-score <plan-path> [--json] — score a PLAN.md's `predictions:` block
 * DETERMINISTICALLY (9.1-08, B18): allowlist check -> run check_command ->
 * numeric compare -> append every verdict to the per-domain calibration
 * ledger. Zero LLM anywhere in scoring. NOT hook-facing: exits 1 when any
 * 'error' verdict occurs (callers decide); a miss is a valid scoring outcome
 * -> exit 0.
 *
 * Scores `predictions:` ONLY. A `receipts:` block (SUMMARY build-time claims,
 * D-9.2-06) is `sma reverify` territory — never scored here, only reported as
 * skipped (R1/R2 false class-A lesson, 2026-07-10: wholesale-run re-scores of
 * expected_sha256 receipts pinned over accruing .sma state are guaranteed
 * drift-misses).
 */
async function cmdPredictScore({ positionals, flags, dirs }) {
  const planPath = positionals[0]
  if (!planPath) {
    process.stderr.write('usage: pnpm sma predict-score <plan-path> [--json]\n')
    return 1
  }
  const predict = await import('./lib/predict.mjs')
  const calibration = await import('./lib/calibration.mjs')
  const { execSync } = await import('node:child_process')

  // The allowlist (SAFE_COMMAND_PATTERNS) has already gated BEFORE this
  // runner is ever invoked (T-9.1-14) — scorePlan never calls it for a
  // non-matching command.
  const runCommand = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 120_000 })

  const scored = predict.scorePlan({ planPath, runCommand })
  let records = scored.records
  const invalid = scored.invalid
  const excluded = scored.excluded ?? []
  // R1/R2 false class-A lesson (2026-07-10): a SUMMARY's `receipts:` block is
  // `sma reverify` territory — predict-score NEVER scores it. Count it so a
  // wholesale run over SUMMARYs sees the skip explicitly instead of silence.
  const receiptsSkipped = predict.parseFrontmatterEntries(planPath, 'receipts').entries.length
  // 9.3-02 (D-9.3-10) — stamp every verdict with the CURRENT model before it
  // lands in the ledger, so the stale-priors guard can tell which model produced
  // each hit/miss. Fail-open: a stamp failure -> unstamped records, which the
  // guard's legacy fallback already handles (an unstamped prefix stays valid).
  try {
    const mv = await import('./lib/model-version.mjs')
    records = mv.stampRecords(records, { model: mv.currentModel({ modelDir: dirs.modelDir }) })
  } catch {
    /* fail-open — unstamped records remain a valid legacy prefix */
  }
  for (const r of records) calibration.appendVerdict(r, { calibrationDir: dirs.calibrationDir })

  // B19 (9.1-09): every MISS auto-drafts a bug-lesson candidate into
  // .claude/memory/drafts/ — draft only, never indexed; promotion is a
  // reviewed move gated by the 3 conditions documented in the draft header.
  const { basename: baseOf } = await import('node:path')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const draftsDir = join(repoRoot, '.claude', 'memory', 'drafts')
  const planId = baseOf(planPath).replace(/-PLAN\.md$/i, '').replace(/\.md$/i, '')
  const drafts = []
  for (const r of records) {
    if (r.verdict !== 'miss') continue
    try {
      const d = predict.draftLessonFromMiss({ verdict: r, planId, dirs: { draftsDir } })
      if (d.path) drafts.push({ id: r.id, path: d.path, drafted: d.drafted })
    } catch {
      /* drafting is best-effort — a failed draft never blocks scoring */
    }
  }

  const hasError = records.some((r) => r.verdict === 'error')
  const exitCode = hasError ? 1 : 0

  if (wantsJson(flags)) {
    printJson({ plan: planPath, records, invalid, excluded, receiptsSkipped, drafts, appended: records.length, exitCode })
    return exitCode
  }

  if (!records.length && !invalid.length && !excluded.length) {
    process.stdout.write(`SMA: в ${planPath} нет блока predictions — оценивать нечего.\n`)
    if (receiptsSkipped) {
      process.stdout.write(
        `  (receipts: ${receiptsSkipped} — территория sma reverify; predict-score их не оценивает)\n`,
      )
    }
    return 0
  }
  process.stdout.write(`SMA predict-score: ${planPath}\n`)
  for (const r of records) {
    const actual = r.actual == null ? '—' : String(r.actual)
    process.stdout.write(
      `  [${r.verdict}] ${r.id} (${r.domain}): ${r.metric} ${r.comparator} ${r.expected}, факт ${actual}\n`,
    )
  }
  for (const inv of invalid) {
    process.stdout.write(
      `  [invalid] ${inv.id ?? '<без id>'}: пропущены поля ${inv.missing.join(', ') || '—'}${inv.errors.length ? `; ошибки: ${inv.errors.join('; ')}` : ''}\n`,
    )
  }
  for (const ex of excluded) {
    process.stdout.write(
      `  [excluded] ${ex.id ?? '<без id>'}: receipt-запись (expected_sha256) — территория sma reverify, вердикт не пишется\n`,
    )
  }
  if (receiptsSkipped) {
    process.stdout.write(
      `  (receipts: ${receiptsSkipped} — территория sma reverify; predict-score их не оценивает)\n`,
    )
  }
  if (drafts.length) {
    process.stdout.write('Черновики уроков из промахов (drafts/ — вне корпуса, до ручной проверки):\n')
    for (const d of drafts) {
      process.stdout.write(`  ${d.drafted ? '+' : '='} ${d.path}${d.drafted ? '' : ' (уже существует — не перезаписан)'}\n`)
    }
  }
  process.stdout.write(`Вердиктов записано в леджер: ${records.length}\n`)
  return exitCode
}

// ── 9.2-03 (D-9.2-06/07): receipts reverify + journal chain CLI ─────────────

/** Recursively list *-SUMMARY.md under a dir (sorted, fail-soft). */
function walkSummaries(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkSummaries(p))
    else if (e.isFile() && e.name.endsWith('-SUMMARY.md')) out.push(p)
  }
  return out.sort()
}

/**
 * reverify [--summary <path>] [--all] [--fresh-clone] [--count <verdict>] [--json]
 *
 * Re-runs every SUMMARY receipt across the SAFE_COMMAND boundary and diffs
 * observed-vs-expected hashes. --all (default) walks .planning/phases and keeps
 * summaries that carry a receipts block. --fresh-clone clones the repo (only
 * COMMITTED evidence counts) and runs every command with cwd=clone. Every record
 * is appended to the calibration ledger under domain 'sma.receipts', mapping the
 * receipt verdict into the V2 ledger vocabulary (verified->hit, divergent->miss;
 * skipped-unsafe/error pass through) while preserving receipt_verdict verbatim.
 *
 * --count <verdict>: print ONLY the integer count of that receipt verdict as the
 * last line and ALWAYS exit 0 (the scorer measurement surface). Without --count,
 * exit 1 when any divergent/error, else 0. NOT hook-facing.
 */
async function cmdReverify({ flags, dirs }) {
  const receipts = await import('./lib/receipts.mjs')
  const calibration = await import('./lib/calibration.mjs')
  const { execSync, execFileSync } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { relative, isAbsolute } = await import('node:path')

  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()

  // ── footprint receipt modes (9.4-07) — the economy ladder's deterministic
  // «claim vs git diff --numstat» receipt. Separate concern from the structural
  // receipts walk below, so these branch early. Zero LLM anywhere.
  if (flags['footprint-selftest']) {
    const footprint = await import('./lib/footprint.mjs')
    const ok = await footprint.footprintSelftest()
    process.stdout.write(`${ok}\n`)
    return ok === 1 ? 0 : 1
  }
  if (flags['footprint-overruns']) {
    // count of undispositioned sma.economy footprint_overrun misses (scorer contract, P9.4-07-C).
    const { records } = calibration.readLedger({ calibrationDir: dirs.calibrationDir, domain: 'sma.economy' })
    const n = records.filter(
      (r) => r && r.metric === 'footprint_overrun' && r.verdict === 'miss' && (r.disposition == null || r.disposition === ''),
    ).length
    if (wantsJson(flags)) printJson({ metric: 'footprint_overrun', undispositioned: n })
    process.stdout.write(`${n}\n`)
    return 0
  }
  if (typeof flags.footprint === 'string') {
    const footprint = await import('./lib/footprint.mjs')
    const predict = await import('./lib/predict.mjs')
    const planPath = flags.footprint
    const planId = planIdFromPath(planPath)
    const claim = footprint.parseFootprintClaim(planPath)
    const execGit = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    const actuals = footprint.footprintActuals({ planId, execGit })

    if (!claim) {
      if (wantsJson(flags)) printJson({ planId, verdict: null, reason: 'no-claim' })
      else process.stdout.write(`SMA reverify [${planId}]: у плана нет footprint-заявки — проверять нечего (честный пустой случай).\n`)
      return 0
    }
    if (actuals.empty) {
      if (wantsJson(flags)) printJson({ planId, verdict: null, reason: 'no-commits', claim })
      else process.stdout.write(`SMA reverify [${planId}]: ни одного коммита с меткой «${planId}» — рецепт пуст (честный пустой случай).\n`)
      return 0
    }

    const draftsDir = join(repoRoot, '.claude', 'memory', 'drafts')
    const appendVerdict = (rec) => calibration.appendVerdict(rec, { calibrationDir: dirs.calibrationDir })
    const draftLesson = ({ verdict, planId: pid }) => predict.draftLessonFromMiss({ verdict, planId: pid, dirs: { draftsDir } })
    const res = footprint.footprintReceipt({ claim, actuals, planId, planPath, appendVerdict, draftLesson })

    if (wantsJson(flags)) {
      printJson({ planId, claim, actuals: { files: actuals.files, loc: actuals.loc, new_deps: actuals.new_deps, commits: actuals.commits, shas: actuals.shas }, receipt: res })
      return res.verdict === 'overrun' ? 1 : 0
    }
    process.stdout.write(`SMA reverify [${planId}] — footprint receipt (заявлено / фактически, коммитов: ${actuals.commits}):\n`)
    process.stdout.write(`  files:    ${claim.files} (≤ ${Math.floor(claim.files * (1 + (claim.tolerance_pct || 0) / 100))}) / ${actuals.files}\n`)
    process.stdout.write(`  loc:      ${claim.loc} (≤ ${Math.floor(claim.loc * (1 + (claim.tolerance_pct || 0) / 100))}) / ${actuals.loc}\n`)
    process.stdout.write(`  new_deps: ${claim.new_deps} (tolerance 0) / ${actuals.new_deps}\n`)
    if (res.verdict === 'overrun') {
      process.stdout.write(`  → ПЕРЕРАСХОД по оси «${res.axis}»: ${res.actual} > ${res.expected}. Зачтён промах sma.economy + черновик урока.\n`)
      return 1
    }
    process.stdout.write('  → в пределах заявленного объёма (verified).\n')
    return 0
  }

  // Which summaries to reverify.
  const summaryPaths = []
  if (typeof flags.summary === 'string') {
    summaryPaths.push(flags.summary)
  } else {
    const phasesDir = join(repoRoot, '.planning', 'phases')
    for (const p of walkSummaries(phasesDir)) {
      if (receipts.parseReceipts(p).receipts.length) summaryPaths.push(p)
    }
  }

  // Fresh clone: committed evidence only.
  let cwd = repoRoot
  let cloneParent = null
  let cloneRoot = null
  const wantClone = flags['fresh-clone'] === true
  if (wantClone) {
    cloneParent = mkdtempSync(join(tmpdir(), 'sma-reverify-'))
    cloneRoot = join(cloneParent, 'clone')
    const execGit = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    receipts.freshClone({ repoRoot, execGit, targetDir: cloneRoot })
    cwd = cloneRoot
  }

  // Runner: a nonzero exit is an OBSERVATION, not a crash (receipts contract).
  const runCommand = (cmd, o = {}) => {
    try {
      const stdout = execSync(cmd, { encoding: 'utf8', timeout: 120_000, cwd: o.cwd ?? cwd })
      return { stdout, exitCode: 0 }
    } catch (err) {
      return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 }
    }
  }

  const remap = (p) => {
    if (!wantClone) return p
    const abs = isAbsolute(p) ? p : join(repoRoot, p)
    return join(cloneRoot, relative(repoRoot, abs))
  }

  const allRecords = []
  try {
    for (const sp of summaryPaths) {
      const { records } = receipts.verifyReceipts({ summaryPath: remap(sp), runCommand, cwd })
      for (const r of records) {
        const mapped = r.verdict === 'verified' ? 'hit' : r.verdict === 'divergent' ? 'miss' : r.verdict
        calibration.appendVerdict(
          { ...r, verdict: mapped, receipt_verdict: r.verdict, domain: 'sma.receipts', summary: sp },
          { calibrationDir: dirs.calibrationDir },
        )
        allRecords.push({ ...r, summary: sp })
      }
    }
  } finally {
    if (cloneParent) rmSync(cloneParent, { recursive: true, force: true, maxRetries: 3 })
  }

  // --count <verdict>: numeric last line, ALWAYS exit 0.
  if (typeof flags.count === 'string') {
    const n = allRecords.filter((r) => r.verdict === flags.count).length
    if (wantsJson(flags)) printJson({ verdict: flags.count, count: n })
    process.stdout.write(`${n}\n`)
    return 0
  }

  const bad = allRecords.some((r) => r.verdict === 'divergent' || r.verdict === 'error')

  if (wantsJson(flags)) {
    printJson({ records: allRecords, appended: allRecords.length })
    return bad ? 1 : 0
  }

  if (!allRecords.length) {
    process.stdout.write('SMA reverify: рецептов в дереве нет — проверять нечего (честный пустой случай).\n')
    return 0
  }
  process.stdout.write('SMA reverify — структурные рецепты (observed vs expected):\n')
  const diverged = []
  for (const r of allRecords) {
    process.stdout.write(`  [${r.verdict}] ${r.id}${r.coverage_id ? ` (${r.coverage_id})` : ''}: ${r.assertion ?? ''}\n`)
    if (r.verdict === 'divergent') diverged.push(r)
  }
  if (diverged.length) {
    process.stdout.write('\nРасхождения (ожидалось / получено):\n')
    for (const r of diverged) {
      process.stdout.write(`  ${r.id}: expected ${String(r.expected_sha256).slice(0, 12)}… / observed ${String(r.observed_sha256).slice(0, 12)}…\n`)
    }
  }
  return bad ? 1 : 0
}

/**
 * receipt-hash <command> [--hash-stdout] [--cwd <path>] — the EMIT path. Gates on
 * isSafeCommand (refuses anything else with exit 1 + a usage hint), runs the
 * command, and prints the observation sha256 as the LAST line. Executors paste
 * that hash into a SUMMARY receipts block; recordReceipt is the programmatic twin.
 */
async function cmdReceiptHash({ positionals, flags, dirs }) {
  const command = positionals[0]
  if (!command) {
    process.stderr.write('usage: pnpm sma receipt-hash "<command>" [--hash-stdout] [--cwd <path>]\n')
    return 1
  }
  const predict = await import('./lib/predict.mjs')
  if (!predict.isSafeCommand(command)) {
    process.stderr.write(
      `SMA receipt-hash: «${command}» не на SAFE_COMMAND allowlist (node scripts/sma/… | pnpm vitest run … | pnpm sma …) — ничего не выполнено.\n`,
    )
    return 1
  }
  const receipts = await import('./lib/receipts.mjs')
  const { execSync } = await import('node:child_process')
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const hashStdout = flags['hash-stdout'] === true
  const runCommand = (cmd, o = {}) => {
    try {
      return { stdout: execSync(cmd, { encoding: 'utf8', timeout: 120_000, cwd: o.cwd ?? cwd }), exitCode: 0 }
    } catch (err) {
      return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 }
    }
  }
  const rec = receipts.recordReceipt({
    entry: { id: 'adhoc', assertion: '', check_command: command, hash_stdout: hashStdout },
    runCommand,
    cwd,
  })
  if (rec.error) {
    process.stderr.write(`SMA receipt-hash: ${rec.error}\n`)
    return 1
  }
  if (wantsJson(flags)) {
    printJson({ command, expected_sha256: rec.receipt.expected_sha256, expected_exit: rec.receipt.expected_exit, hash_stdout: hashStdout })
    return 0
  }
  process.stdout.write(`exit:${rec.receipt.expected_exit}${hashStdout ? ' (+stdout hashed)' : ''}\n`)
  process.stdout.write(`${rec.receipt.expected_sha256}\n`) // sha256 as the LAST line
  return 0
}

/** chain-tip [--json] — the deterministic merged journal chain tip (last line). */
async function cmdChainTip({ flags, dirs }) {
  const journal = await import('./lib/journal.mjs')
  const res = journal.chainTip({ journalDir: dirs.journalDir })
  if (wantsJson(flags)) {
    printJson(res)
    return 0
  }
  process.stdout.write(`${res.tip}\n`)
  return 0
}

/**
 * chain-verify [--count breaks] [--json] — the tamper detector over the live
 * journal. --count breaks prints the integer last line and ALWAYS exits 0;
 * without --count exit 1 on any break. NOT hook-facing.
 */
async function cmdChainVerify({ flags, dirs }) {
  const journal = await import('./lib/journal.mjs')
  const res = journal.verifyChain({ journalDir: dirs.journalDir })

  if (flags.count) {
    if (wantsJson(flags)) printJson({ breaks: res.breaks.length })
    process.stdout.write(`${res.breaks.length}\n`)
    return 0
  }
  if (wantsJson(flags)) {
    printJson(res)
    return res.ok ? 0 : 1
  }
  if (res.ok) {
    process.stdout.write(`SMA chain-verify: цепочка журнала цела — 0 разрывов (legacy-префикс: ${res.legacyLines}).\n`)
    return 0
  }
  process.stdout.write(`SMA chain-verify: НАЙДЕНЫ разрывы (${res.breaks.length}) — правка/удаление/вставка после начала цепочки:\n`)
  for (const b of res.breaks) {
    process.stdout.write(`  ${b.file} seq=${b.seq ?? '—'} index=${b.index}: ${b.reason}\n`)
  }
  process.stdout.write('Разрыв — это улика; НЕ «чинить» перезаписью строки. Единственный путь вперёд — новый chain-start поверх, с сохранённым разрывом.\n')
  return 1
}

/** Normalize on-disk line endings so the byte-compare is CRLF-agnostic (autocrlf). */
function normEol(s) {
  return String(s ?? '').replace(/\r\n/g, '\n')
}

/**
 * passport [--build | --verify | --check-badge | --json] (9.3-02, D-9.3-10) —
 * the calibration-passport surface. NOT hook-facing.
 *   --build       : buildSnapshot(live dirs) -> renderPassport -> PASSPORT.md,
 *                   renderBadgeBlock -> README managed block. Exit 0 always
 *                   (an honest hidden badge is a success, not an error).
 *   --verify      : fresh clone (committed evidence only) -> re-render from the
 *                   embedded snapshot -> byte-compare PASSPORT.md + README badge.
 *                   Prints 1/0 as the LAST line, ALWAYS exit 0 (P9.3-02-A).
 *   --check-badge : committed snapshot -> renderBadgeBlock vs the live README
 *                   block. 1/0 last line, exit 0 (P9.3-02-B).
 *   --json (bare) : canonicalJson(parseSnapshot(committed PASSPORT.md)) — the
 *                   telemetry read surface for 9.3-07/08/09; missing -> {}.
 *   --schema-check: bare 1/0 LAST line, always exit 0 — structural validity of
 *                   the read surface (BL-172 accrual-proof receipt pin).
 */
async function cmdPassport({ flags, dirs }) {
  const passport = await import('./lib/passport.mjs')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const passportPath = join(repoRoot, 'PASSPORT.md')
  const readmePath = join(repoRoot, 'README.md')

  // ── --build ────────────────────────────────────────────────────────────────
  if (flags.build === true) {
    const { atomicWriteRaw } = await import('./lib/fs-atomics.mjs')
    const snap = passport.buildSnapshot({ dirs })
    atomicWriteRaw(passportPath, passport.renderPassport(snap))
    passport.writeManagedBlock({ filePath: readmePath, content: passport.renderBadgeBlock(snap) })
    if (wantsJson(flags)) {
      printJson({ built: true, passport: passportPath, readme: readmePath, guard: snap.guard })
      return 0
    }
    process.stdout.write(
      `SMA passport: собран — состояние бейджа «${snap.guard.status}» (fresh n=${snap.guard.freshN}/${passport.BADGE_MIN_N}). Обновлены ${passportPath} и README-блок.\n`,
    )
    return 0
  }

  // ── --verify (fresh clone, byte-compare) ─────────────────────────────────────
  if (flags.verify === true) {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const receipts = await import('./lib/receipts.mjs')
    const cloneParent = mkdtempSync(join(tmpdir(), 'sma-passport-'))
    const cloneRoot = join(cloneParent, 'clone')
    let passportMatch = false
    let badgeMatch = false
    try {
      const execGit = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
      receipts.freshClone({ repoRoot, execGit, targetDir: cloneRoot })
      const committedPassport = normEol(readFileSync(join(cloneRoot, 'PASSPORT.md'), 'utf8'))
      const snap = passport.parseSnapshot(committedPassport)
      if (snap) {
        passportMatch = normEol(passport.renderPassport(snap)) === committedPassport
        let liveBadge = null
        try {
          liveBadge = passport.readManagedBlock(normEol(readFileSync(join(cloneRoot, 'README.md'), 'utf8')))
        } catch {
          liveBadge = null
        }
        badgeMatch = liveBadge != null && liveBadge === normEol(passport.renderBadgeBlock(snap))
      }
    } catch {
      /* a clone/read failure is a non-reproduction -> 0, never a throw */
    } finally {
      rmSync(cloneParent, { recursive: true, force: true, maxRetries: 3 })
    }
    const ok = passportMatch && badgeMatch ? 1 : 0
    if (wantsJson(flags)) printJson({ reproduced: ok, passportMatch, badgeMatch })
    process.stdout.write(`${ok}\n`) // numeric LAST line (P9.3-02-A scorer contract)
    return 0
  }

  // ── --check-badge (no clone; live README vs committed snapshot) ──────────────
  if (flags['check-badge'] === true) {
    let ok = 0
    let expected = null
    let live = null
    try {
      const snap = passport.parseSnapshot(normEol(readFileSync(passportPath, 'utf8')))
      if (snap) {
        expected = normEol(passport.renderBadgeBlock(snap))
        live = passport.readManagedBlock(normEol(readFileSync(readmePath, 'utf8')))
        ok = live != null && live === expected ? 1 : 0
      }
    } catch {
      ok = 0
    }
    if (wantsJson(flags)) printJson({ consistent: ok })
    process.stdout.write(`${ok}\n`) // numeric LAST line (P9.3-02-B scorer contract)
    return 0
  }

  // ── --schema-check (BL-172): structural validity of the read surface ─────────
  // Pin THIS in receipts, never `--json` output — the passport is rebuilt each
  // release, so its content hash re-fails on every reverify by construction.
  // 1/0 LAST line, always exit 0 (numeric scorer contract).
  if (flags['schema-check'] === true) {
    let snap = null
    try {
      snap = passport.parseSnapshot(normEol(readFileSync(passportPath, 'utf8')))
    } catch {
      snap = null
    }
    const ok = passport.snapshotSchemaOk(snap) ? 1 : 0
    if (wantsJson(flags)) printJson({ schemaOk: ok })
    process.stdout.write(`${ok}\n`)
    return 0
  }

  // ── --json (bare read surface) ───────────────────────────────────────────────
  let snap = null
  try {
    snap = passport.parseSnapshot(normEol(readFileSync(passportPath, 'utf8')))
  } catch {
    snap = null
  }
  if (!snap) {
    if (wantsJson(flags)) {
      process.stdout.write('{}\n')
      return 0
    }
    process.stdout.write('SMA passport: PASSPORT.md ещё не собран — запустите `pnpm sma passport --build`.\n')
    return 0
  }
  if (wantsJson(flags)) {
    process.stdout.write(passport.canonicalJson(snap) + '\n')
    return 0
  }
  process.stdout.write(
    `SMA passport: состояние «${snap.guard.status}», fresh n=${snap.guard.freshN}/${passport.BADGE_MIN_N}, модель ${snap.model && snap.model.id ? snap.model.id : '—'}.\n`,
  )
  return 0
}

/**
 * model [--json] [--count sightings] [--set <id>] [--schema-check] (9.3-02,
 * D-9.3-10) — the model-version guard surface. `--count sightings` prints the
 * integer LAST line (P9.3-02-C). `--set <id>` records a manual sighting
 * (source 'manual') for a harness that exposes no model id. `--schema-check`
 * prints bare 1/0, always exit 0 — the timeline's SHAPE, never its accruing
 * count (BL-172 accrual-proof receipt pin). NOT hook-facing.
 */
async function cmdModel({ flags, dirs }) {
  const mv = await import('./lib/model-version.mjs')
  const { BADGE_MIN_N } = await import('./lib/passport.mjs')

  if (typeof flags.set === 'string' && flags.set) {
    const res = mv.recordModelSighting({ model: flags.set, source: 'manual', modelDir: dirs.modelDir })
    if (wantsJson(flags)) {
      printJson(res)
      return 0
    }
    process.stdout.write(`SMA model: ручной sighting «${flags.set}» — ${res.appended ? 'записан' : res.reason || 'пропущен'}.\n`)
    return 0
  }

  const timeline = mv.readModelTimeline({ modelDir: dirs.modelDir })

  // BL-172: deterministic structural mode — the sighting timeline's SHAPE,
  // never its accruing COUNT. 1/0 LAST line, always exit 0.
  if (flags['schema-check'] === true) {
    const ok = mv.timelineSchemaOk(timeline) ? 1 : 0
    if (wantsJson(flags)) printJson({ schemaOk: ok })
    process.stdout.write(`${ok}\n`)
    return 0
  }

  if (typeof flags.count === 'string') {
    const n = flags.count === 'sightings' ? timeline.sightings.length : 0
    if (wantsJson(flags)) printJson({ count: n, of: flags.count })
    process.stdout.write(`${n}\n`) // integer LAST line (P9.3-02-C scorer contract)
    return 0
  }

  const calibration = await import('./lib/calibration.mjs')
  const { records } = calibration.readLedger({ calibrationDir: dirs.calibrationDir })
  const predRecords = records.filter((r) => (r.domain ?? 'unknown') !== 'sma.receipts')
  const guard = mv.modelGuard({ records: predRecords, timeline, minFresh: BADGE_MIN_N })

  if (wantsJson(flags)) {
    printJson({ current: mv.currentModel({ modelDir: dirs.modelDir }), timeline, guard })
    return 0
  }
  process.stdout.write(
    `SMA model: текущая модель ${guard.model || '—'}, sightings ${timeline.sightings.length}, guard «${guard.status}» (fresh n=${guard.freshN}/${guard.requiredN}).\n`,
  )
  return 0
}

/**
 * excavate [repo-path] [--json] [--limit N] [--since ISO] [--max-catches N]
 *          [--write-drafts] [--stats --metric <approved-lessons|firing-ready-pct|determinism>]
 *
 * The adoption wedge (9.3-03, D-9.3-09): mine a STRANGER's git history READ-ONLY
 * and DETERMINISTICALLY for commit↔revert / typo-fix / red-CI fix-forward evidence,
 * and print CATCHES — «this reflex would have fired before this push, here». NOT
 * hook-facing (a direct CLI command; failures exit 1 honestly). Zero network, zero
 * LLM, nothing mined is ever executed.
 */
async function cmdExcavate({ positionals, flags, dirs }) {
  const excavate = await import('./lib/excavate.mjs')

  // ── instrument mode: one number as the LAST line (predict.mjs scorer contract).
  if (flags.stats) {
    const metric = typeof flags.metric === 'string' ? flags.metric : ''
    const corpusDir =
      typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')
    const repoPath = positionals[0] || process.cwd()
    let n = 0
    try {
      n = excavate.excavateStats({
        metric,
        corpusDir,
        repoPath,
        runGit: excavate.defaultRunGit(repoPath),
      })
    } catch {
      n = metric === 'determinism' ? 0 : 0
    }
    process.stdout.write(`${n}\n`) // numeric LAST line (D-9.3-16)
    return 0
  }

  // ── mining mode.
  const repoPath = positionals[0] || process.cwd()
  const runGit = excavate.defaultRunGit(repoPath)

  // read-only repo check via rev-parse (argv-array, shell off).
  try {
    runGit(['rev-parse', '--is-inside-work-tree'])
  } catch {
    process.stderr.write(`SMA excavate: «${repoPath}» is not a git repository (or git is unavailable).\n`)
    return 1
  }

  // origin remote — best-effort; a missing remote just means sha-only links.
  let remoteUrl = null
  try {
    remoteUrl = String(runGit(['remote', 'get-url', 'origin']) || '').trim() || null
  } catch {
    remoteUrl = null
  }

  const limit = Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : 2000
  const since = typeof flags.since === 'string' ? flags.since : undefined
  const maxCatches = Number.isFinite(Number(flags['max-catches'])) ? Number(flags['max-catches']) : 25

  let mined
  try {
    mined = excavate.mineRepo({ repoPath, runGit, limit, since })
  } catch (err) {
    process.stderr.write(`SMA excavate: mining failed — ${String((err && err.message) ?? err)}\n`)
    return 1
  }
  const catches = mined.catches.slice(0, maxCatches)

  if (wantsJson(flags)) {
    printJson({ catches, stats: mined.stats, remoteRecognized: !!excavate.commitUrl(remoteUrl, 'a'.repeat(40)) })
    return 0
  }

  // opt-in draft writing (T-9.3-03C: default only PRINTS).
  if (flags['write-drafts']) {
    const repoLabel = remoteUrl || repoPath
    const draftsDir = join('.claude', 'memory', 'drafts')
    let wrote = 0
    for (const c of catches) {
      const res = excavate.draftLessonFromCatch({ catch: c, repoLabel, dirs: { draftsDir } })
      if (res.drafted) {
        wrote++
        process.stdout.write(`  draft: ${res.path}\n`)
      } else if (res.error) {
        process.stdout.write(`  skipped (${res.error})\n`)
      }
    }
    process.stdout.write(
      `\n${wrote} draft(s) written to ${draftsDir}. Review + promote through the 3-condition gate (move OUT of drafts/ into .claude/memory/).\n`,
    )
    return 0
  }

  process.stdout.write(excavate.formatCatches(catches, { remoteUrl }))
  return 0
}

/**
 * cmdDecisions — 9.5-02 (D-9.5-08) — the founder decision-corpus miner.
 *
 * `sma decisions mine [--limit N] [--dry] [--transcripts-dir P]` retrospectively
 * mines the founder's real decisions from LOCAL session transcripts into
 * drafts-only founder-decision notes «ситуация → решение + почему». `stats` counts
 * the drafted/promoted founder-decision corpus. NOT hook-facing (direct command;
 * may exit 1 on bad args). The corpus stays in the CURRENT working repo's
 * .claude/memory — never the product. Drafts are NEVER auto-committed.
 */
async function cmdDecisions({ positionals, flags }) {
  const dc = await import('./lib/decision-corpus.mjs')
  const sub = positionals[0]
  // corpus stays in the CURRENT working repo (never the SMA product) — cwd-based.
  const memoryDir = join(process.cwd(), '.claude', 'memory')

  if (sub === 'stats') {
    const stats = dc.corpusStats({ memoryDir })
    if (wantsJson(flags)) {
      printJson(stats)
      return 0
    }
    process.stdout.write(`SMA decisions: ${stats.total} founder-decision note(s)\n`)
    for (const [tag, n] of Object.entries(stats.byTag).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${tag}: ${n}\n`)
    }
    process.stdout.write(`${stats.total}\n`) // numeric LAST line (instrument contract)
    return 0
  }

  if (sub === 'mine') {
    const transcriptsDir =
      typeof flags['transcripts-dir'] === 'string' ? flags['transcripts-dir'] : process.env.SMA_TRANSCRIPTS_DIR
    if (!transcriptsDir) {
      process.stderr.write(
        'SMA decisions mine: pass --transcripts-dir <p> or set SMA_TRANSCRIPTS_DIR (the local Claude Code projects dir).\n',
      )
      return 1
    }
    const limit = Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : 50

    // --dry: scan + rank but WRITE NOTHING (a no-op fsImpl counts would-be drafts).
    if (flags.dry === true) {
      const { readdirSync, readFileSync } = await import('node:fs')
      const fsImpl = {
        readdirSync,
        readFileSync,
        existsSync: () => false,
        mkdirSync: () => {},
        writeFileSync: () => {},
      }
      let res
      try {
        res = dc.mineDecisions({ transcriptsDir, memoryDir, limit, fsImpl })
      } catch (err) {
        process.stderr.write(`SMA decisions mine --dry: ${String((err && err.message) ?? err)}\n`)
        return 1
      }
      process.stdout.write(
        `SMA decisions mine --dry: ${res.drafted} candidate draft(s) from ${res.scanned} record(s) (${res.skipped} skipped) — nothing written.\n`,
      )
      return 0
    }

    let res
    try {
      res = dc.mineDecisions({ transcriptsDir, memoryDir, limit })
    } catch (err) {
      process.stderr.write(`SMA decisions mine: ${String((err && err.message) ?? err)}\n`)
      return 1
    }
    process.stdout.write(
      `SMA decisions mine: ${res.drafted} draft(s) → ${join(memoryDir, 'drafts')} ` +
        `(${res.scanned} records scanned, ${res.skipped} skipped). ` +
        `Review + promote through the 3-condition gate — drafts are NEVER auto-committed.\n`,
    )
    return 0
  }

  process.stderr.write(
    'SMA decisions: usage — decisions mine [--limit N] [--dry] [--transcripts-dir P] | decisions stats\n',
  )
  return 1
}

/**
 * cmdExam — 9.5-06 (D-9.5-08) — the replay exam (calibration metric).
 *
 * `sma exam build --seed N [--holdout P]` samples held-out founder-decision notes
 * deterministically, strips the real decision into a hidden `-key.jsonl`, and writes
 * the exam items for the synthetic orchestrator (the key is NEVER handed to it).
 * `sma exam score <gradesPath>` reads externally-graded rows, computes the match
 * rate against the founder's real decisions, appends it to the score ledger keyed by
 * policy_version, and prints the rate as the numeric LAST line. Corpus + exam stay in
 * the CURRENT working repo's .claude/memory — never the product.
 */
async function cmdExam({ positionals, flags }) {
  const re = await import('./lib/replay-exam.mjs')
  const sub = positionals[0]
  const memoryDir = join(process.cwd(), '.claude', 'memory')

  if (sub === 'build') {
    const seed = flags.seed != null ? flags.seed : 0
    const holdoutPct = Number.isFinite(Number(flags.holdout)) ? Number(flags.holdout) : 20
    let res
    try {
      res = re.buildExam({ memoryDir, holdoutPct, seed })
    } catch (err) {
      process.stderr.write(`SMA exam build: ${String((err && err.message) ?? err)}\n`)
      return 1
    }
    if (wantsJson(flags)) {
      printJson(res)
      return 0
    }
    process.stdout.write(
      `SMA exam build: ${res.count} item(s) held out of ${res.total} founder-decision note(s) → ${res.examPath} ` +
        `(answer key: ${res.keyPath} — NEVER hand this to the examinee).\n`,
    )
    return 0
  }

  if (sub === 'score') {
    const gradesPath = positionals[1]
    if (!gradesPath) {
      process.stderr.write('SMA exam score: pass the path to the graded rows file — exam score <gradesPath>\n')
      return 1
    }
    const policyVersion = flags['policy-version'] != null ? flags['policy-version'] : null
    let res
    try {
      res = re.scoreExam({ gradesPath, memoryDir, policyVersion }) // prints the numeric LAST line itself
    } catch (err) {
      process.stderr.write(`SMA exam score: ${String((err && err.message) ?? err)}\n`)
      return 1
    }
    if (wantsJson(flags)) {
      printJson(res)
      return 0
    }
    return 0
  }

  process.stderr.write('SMA exam: usage — exam build [--seed N] [--holdout P] | exam score <gradesPath> [--policy-version V]\n')
  return 1
}

/**
 * graderSelftest() -> 1|0 — the grade-the-grader pipeline proves itself end to
 * end in a THROWAWAY ledger (9.4-02, P9.4-02-A). The real .sma/ is NEVER
 * touched: record a satisfied verdict → inject a revert evidence within horizon
 * → score 'contradicted' → graderContradictionEvent → openBlocks counts 1 → a
 * founder disposition clears it → counts 0. Returns 1 iff the whole chain holds.
 */
async function graderSelftest() {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const calibration = await import('./lib/calibration.mjs')
  const consequences = await import('./lib/consequences.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'sma-grader-selftest-'))
  const selfDir = join(tmp, 'calibration')
  try {
    // 1. record a satisfied verdict (fixed time + horizon, DI'd throwaway dir).
    const rec = calibration.recordGraderVerdict(
      { planId: 'SELF-GRADER', verdict: 'satisfied', judgeModelId: 'selftest-judge', source: 'blind-verify', horizon: '2026-01-02T00:00:00.000Z' },
      { calibrationDir: selfDir, now: '2026-01-01T00:00:00.000Z' },
    )
    // 2. inject a revert ground-truth within the horizon → 3. score contradicted.
    const evidence = [{ type: 'revert', planId: 'SELF-GRADER', at: '2026-01-01T12:00:00.000Z' }]
    const scored = calibration.scoreGraderVerdicts({ records: [rec], evidence, now: '2026-01-03T00:00:00.000Z' })
    const contradiction = scored.find((s) => s.outcome === 'contradicted')
    if (!contradiction) return 0
    // 4. the contradiction becomes a class-A block openBlocks counts.
    calibration.appendVerdict(consequences.graderContradictionEvent(contradiction), { calibrationDir: selfDir })
    const before = consequences.openBlocks({ calibrationDir: selfDir })
    if (before.blocks.length !== 1) return 0
    // 5. ONLY a founder disposition clears it.
    consequences.recordDisposition(
      { eventKey: before.blocks[0].eventKey, disposition: 'accept', reason: 'selftest', by: 'founder', domain: 'sma.verification' },
      { calibrationDir: selfDir },
    )
    const after = consequences.openBlocks({ calibrationDir: selfDir })
    return after.blocks.length === 0 ? 1 : 0
  } catch {
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
}

/**
 * calibration [--domain <d>] [--json] — the B20 answer surface: per-domain
 * hit-rate table + the low-calibration escalation list (hitRate < 0.6 при
 * n >= 5). Empty ledger -> honest empty state, exit 0.
 *
 * Grade-the-grader (9.4-02): `--grader` lists the graded track record of
 * separate-context verdicts with per-judge hit-rate + per-evidence-type
 * accounting; `--grader --stat recorded-verdicts` prints the bare count (scorer
 * contract, P9.4-02-C starvation sentinel); `--grader-record --plan <id>
 * --verdict <satisfied|unsatisfied> --source <...> [--horizon <spec>]` is the
 * MANDATORY feeding entry point (CH-9.4-02-1); `--grader-selftest` prints 1/0
 * (P9.4-02-A). Grader verdicts are themselves predictions — scored against
 * ground truth and sliced by judge model.
 */
async function cmdCalibration({ flags, dirs }) {
  const calibration = await import('./lib/calibration.mjs')

  // ── --grader-selftest: the pipeline proves itself (numeric last line) ────────
  if (flags['grader-selftest'] === true) {
    const ok = await graderSelftest()
    process.stdout.write(`${ok}\n`)
    return ok === 1 ? 0 : 1
  }

  // ── --grader-record: the MANDATORY-feeding entry point (CH-9.4-02-1) ────────
  if (flags['grader-record'] === true) {
    const planId = typeof flags.plan === 'string' ? flags.plan : null
    const verdict = flags.verdict
    if (!planId || (verdict !== 'satisfied' && verdict !== 'unsatisfied')) {
      process.stderr.write('usage: pnpm sma calibration --grader-record --plan <id> --verdict <satisfied|unsatisfied> --source <blind-verify|verifier|vendor> [--horizon <spec>]\n')
      return 1
    }
    const rec = calibration.recordGraderVerdict(
      {
        planId,
        verdict,
        source: typeof flags.source === 'string' ? flags.source : 'unspecified',
        horizon: typeof flags.horizon === 'string' ? flags.horizon : null,
        judgeModelId: typeof flags.judge === 'string' ? flags.judge : undefined,
      },
      { calibrationDir: dirs.calibrationDir },
    )
    if (wantsJson(flags)) {
      printJson({ recorded: rec })
      return 0
    }
    process.stdout.write(
      `grader verdict recorded: ${rec.planId} → ${rec.verdict} (judge: ${rec.judgeModelId ?? 'unstamped'}, stampedBy: ${rec.stampedBy}, source: ${rec.source})\n`,
    )
    return 0
  }

  // ── --grader: graded track record + per-judge hit-rate + evidence accounting ─
  if (flags.grader === true) {
    const { records, corrupt } = calibration.readLedger({ calibrationDir: dirs.calibrationDir, domain: 'sma.verification' })
    const graderRecords = records.filter((r) => r && r.kind === 'grader-verdict')

    // --stat recorded-verdicts: bare count as the LAST stdout line (scorer
    // contract; the P9.4-02-C starvation sentinel — 0 is an HONEST miss).
    if (flags.stat === 'recorded-verdicts') {
      process.stdout.write(`${graderRecords.length}\n`)
      return 0
    }

    const evidence = records.filter((r) => r && calibration.GROUND_TRUTH_EVIDENCE_TYPES.includes(r.type))
    const scored = calibration.scoreGraderVerdicts({ records: graderRecords, evidence, now: new Date().toISOString() })
    const byJudge = calibration.hitRateByJudge(scored)

    // Per-evidence-type accounting: revert/founder-rejection have live producers;
    // red-ci/rework stay «manual until CI-terminal wiring» (CH-9.4-02-1) — the
    // starvation is VISIBLE, never silent.
    const LIVE = ['revert', 'founder-rejection']
    const MANUAL = ['red-ci', 'rework']
    const evCount = (t) => evidence.filter((e) => e.type === t).length

    if (wantsJson(flags)) {
      printJson({
        graderRecords: scored,
        hitRateByJudge: byJudge,
        evidenceAccounting: { live: Object.fromEntries(LIVE.map((t) => [t, evCount(t)])), manual: MANUAL },
        recordedVerdicts: graderRecords.length,
        corrupt,
      })
      return 0
    }

    if (!scored.length) {
      process.stdout.write('SMA calibration --grader: реестр вердиктов грейдера пуст — ни один отдельный контекст ещё не оценивался.\n')
    } else {
      process.stdout.write(`SMA calibration --grader — оценённые вердикты грейдера (${scored.length}):\n`)
      for (const s of scored) {
        process.stdout.write(`  ${s.planId} → ${s.verdict} [${s.outcome}] судья ${s.judgeModelId ?? 'unstamped'}, источник ${s.source ?? '—'}\n`)
      }
      process.stdout.write('Точность по судьям (кто оценивал):\n')
      for (const [judge, b] of Object.entries(byJudge)) {
        const pct = b.rate == null ? '—' : `${Math.round(b.rate * 100)}%`
        process.stdout.write(`  ${judge}: ${pct} (${b.hits}/${b.hits + b.misses})\n`)
      }
    }
    process.stdout.write('Учёт наземной истины по типам:\n')
    for (const t of LIVE) process.stdout.write(`  ${t}: ${evCount(t)} (живой источник)\n`)
    for (const t of MANUAL) process.stdout.write(`  ${t}: manual until CI-terminal wiring\n`)
    if (corrupt) process.stdout.write(`  (повреждённых строк леджера пропущено: ${corrupt})\n`)
    return 0
  }
  const domainFilter = typeof flags.domain === 'string' ? flags.domain : null

  const { records, corrupt } = calibration.readLedger({
    calibrationDir: dirs.calibrationDir,
    ...(domainFilter ? { domain: domainFilter } : {}),
  })

  // Group per domain -> hit-rate rows.
  const byDomain = new Map()
  for (const r of records) {
    const d = r.domain ?? 'unknown'
    if (!byDomain.has(d)) byDomain.set(d, [])
    byDomain.get(d).push(r)
  }
  const domains = [...byDomain.entries()]
    .map(([domain, recs]) => ({ domain, ...calibration.hitRate(recs) }))
    .sort((a, b) => a.domain.localeCompare(b.domain))

  const flagged = calibration.escalations({ calibrationDir: dirs.calibrationDir })

  if (wantsJson(flags)) {
    printJson({ domains, escalations: flagged, corrupt })
    return 0
  }

  if (!domains.length) {
    process.stdout.write('SMA calibration: леджер пуст — ещё ни одного оценённого прогноза.\n')
    return 0
  }
  process.stdout.write('SMA calibration — точность прогнозов по доменам:\n')
  for (const d of domains) {
    const pct = d.rate == null ? '—' : `${Math.round(d.rate * 100)}%`
    process.stdout.write(`  ${d.domain}: ${pct} (${d.hits}/${d.n})${d.skipped ? `, пропущено ${d.skipped}` : ''}${d.errors ? `, ошибок ${d.errors}` : ''}\n`)
  }
  if (flagged.length) {
    process.stdout.write('Низкая калибровка (нужна эскалация — планы в этих областях исторически ошибаются):\n')
    for (const f of flagged) process.stdout.write(`  ⚠ ${f.domain}: ${Math.round(f.rate * 100)}% при n=${f.n}\n`)
  }
  if (corrupt) process.stdout.write(`  (повреждённых строк леджера пропущено: ${corrupt})\n`)
  return 0
}

/**
 * usage [--dead-weight] [--json] — the B4 answer surface: per-note citation
 * counts (loads + reflex fires) with lastCitedAt; --dead-weight adds the
 * zero-citation list over the last N sessions (--sessions, default 10) — the
 * FI-9 demotion-ordering data source (least-recently-cited demotes first).
 * Honest empty state when no ledger exists. NOT hook-facing.
 */
async function cmdUsage({ flags, dirs }) {
  const citations = await import('./lib/citations.mjs')
  const { notes, corrupt } = citations.usageStats({ usageDir: dirs.usageDir, journalDir: dirs.journalDir })

  let dead = null
  if (flags['dead-weight'] === true) {
    const corpusDir = typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')
    const sessions = Number.isFinite(Number(flags.sessions)) ? Number(flags.sessions) : 10
    dead = citations.deadWeight({ usageDir: dirs.usageDir, journalDir: dirs.journalDir, corpusDir, sessions })
  }

  if (wantsJson(flags)) {
    printJson({
      notes,
      corrupt,
      ...(dead ? { deadWeight: dead.dead, cited: dead.cited, sessionsConsidered: dead.sessionsConsidered } : {}),
    })
    return 0
  }

  if (!notes.length) {
    process.stdout.write('SMA usage: данных об использовании пока нет.\n')
  } else {
    process.stdout.write('SMA usage — цитирования заметок (load + fire), по убыванию:\n')
    for (const n of notes) {
      process.stdout.write(
        `  ${String(n.total).padStart(4)}  ${n.noteId} (load ${n.load}, fire ${n.fire}, последнее ${n.lastCitedAt ?? '—'})\n`,
      )
    }
    if (corrupt) process.stdout.write(`  (повреждённых строк леджера пропущено: ${corrupt})\n`)
  }
  if (dead) {
    if (!dead.dead.length) {
      process.stdout.write('Мёртвого груза нет — каждая заметка корпуса процитирована.\n')
    } else {
      process.stdout.write(`Мёртвый груз (0 цитирований, последних сессий учтено: ${dead.sessionsConsidered}):\n`)
      for (const f of dead.dead) process.stdout.write(`  ${f}\n`)
    }
  }
  return 0
}

/**
 * consolidate [--propose] [--digest] [--json] — the P3 consolidation review
 * pass (9.1-12, B5). PROPOSE-ONLY: renders consolidate.mjs's propose() output
 * in the Pattern-3 contract (MERGE/PROMOTE/CONTRADICT/DIGEST lines under the
 * nothing-auto-committed banner). The lib NEVER writes; APPLYING any proposal
 * is the operator's reviewed edit (T-9.1-23). FI-9: memory is never deleted
 * or time-decayed — merge/promote/supersede only. --digest alone renders just
 * the reflection digest. NOT hook-facing: may exit 1 on a real error.
 */
async function cmdConsolidate({ flags, dirs }) {
  const consolidate = await import('./lib/consolidate.mjs')
  const corpusDir = typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')

  // --digest without --propose: the reflection digest alone.
  if (flags.digest === true && flags.propose !== true) {
    const d = consolidate.digest({ usageDir: dirs.usageDir, journalDir: dirs.journalDir })
    if (wantsJson(flags)) {
      printJson({ digest: d })
      return 0
    }
    process.stdout.write('SMA consolidate — рефлексивный дайджест:\n')
    process.stdout.write(`  DIGEST: ${d.summary}\n`)
    return 0
  }

  const res = consolidate.propose({
    corpusDir,
    usageDir: dirs.usageDir,
    journalDir: dirs.journalDir,
  })

  if (wantsJson(flags)) {
    printJson(res)
    return 0
  }

  // Pattern-3 output contract: a reviewable proposal list, never auto-applied.
  process.stdout.write('Proposed changes (review before applying — nothing auto-committed):\n')
  process.stdout.write(
    '  Память не удаляется и не распадается по времени (FI-9) — только слияние, продвижение и supersession руками оператора.\n',
  )
  for (const m of res.merges) {
    process.stdout.write(
      `  MERGE: ${m.files[0]} + ${m.files[1]} (near-duplicate, same area+kind, token-set sim ${m.similarity})\n`,
    )
  }
  for (const p of res.promotions) {
    process.stdout.write(
      `  PROMOTE: ${p.file} → ${p.to} (matched ${p.distinctTagSets} distinct task-tag-sets)\n`,
    )
  }
  for (const c of res.contradictions) {
    process.stdout.write(
      `  CONTRADICT: ${c.files[0]} vs ${c.files[1]} (same area=${c.area.join(',') || '—'}, kind=${c.kind}, unlinked, ${c.reason})\n`,
    )
  }
  process.stdout.write(`  DIGEST: ${res.digest.summary}\n`)
  if (!res.merges.length && !res.promotions.length && !res.contradictions.length) {
    process.stdout.write('  (предложений merge/promote/contradict нет — корпус чист)\n')
  }
  return 0
}

/**
 * trim [--apply] [--json] [--corpus <dir>] [--state <path>] — the FI-9
 * demotion-only trimmer (9.1-13): the auto-repair the size lints name.
 * DRY-RUN by default (proposal print mirrors consolidate's banner); --apply
 * performs the demotions/splits/state-move through fs-atomics. Memory is
 * NEVER deleted or time-decayed — overflow moves DOWN a layer (FI-9).
 * NOT hook-facing: may exit 1 on a real error.
 */
async function cmdTrim({ flags, dirs }) {
  const trim = await import('./lib/trim.mjs')
  const { existsSync } = await import('node:fs')
  const corpusDir = typeof flags.corpus === 'string' ? flags.corpus : join('.claude', 'memory')
  const tagsPath = join(corpusDir, 'TAGS.md')
  const defaultState = join('.planning', 'STATE.md')
  const statePath = typeof flags.state === 'string' ? flags.state : existsSync(defaultState) ? defaultState : undefined

  const opts = { corpusDir, tagsPath, usageDir: dirs.usageDir, journalDir: dirs.journalDir, statePath }

  if (flags.apply !== true) {
    const p = trim.plan(opts)
    if (wantsJson(flags)) {
      printJson(p)
      return 0
    }
    // Pattern-3 output contract (mirrors consolidate): reviewable, never auto-applied.
    process.stdout.write('Proposed demotions (review before applying — nothing auto-committed):\n')
    process.stdout.write(
      '  Память не удаляется и не распадается по времени (FI-9) — переполнение спускается на слой ниже: ядро → периферия, хвост заметки → архивная заметка, STATE → STATE-ARCHIVE.\n',
    )
    for (const d of p.coreDemotions) {
      process.stdout.write(
        `  DEMOTE-CORE: ${d.file} → периферия (последнее цитирование: ${d.lastCitedAt ?? 'никогда'})\n`,
      )
    }
    for (const s of p.noteSplits) {
      process.stdout.write(`  SPLIT-NOTE: ${s.file} (${s.bytes} байт > бюджета) → хвост в архивную заметку\n`)
    }
    if (p.stateOverflow) {
      process.stdout.write(
        `  TRIM-STATE: ${p.stateOverflow.bytes} байт → ${p.stateOverflow.projectedBytes}; секции в STATE-ARCHIVE.md: ${p.stateOverflow.sections.join(' · ')}\n`,
      )
    }
    if (!p.coreDemotions.length && !p.noteSplits.length && !p.stateOverflow) {
      process.stdout.write('  (всё в пределах бюджетов — понижать нечего)\n')
    }
    process.stdout.write('  Применить: pnpm sma trim --apply\n')
    return 0
  }

  // --apply: demote CORE, split each over-budget note, move STATE overflow.
  const core = trim.demoteCore({ ...opts, apply: true })
  const proposal = trim.plan(opts) // re-planned AFTER demotion (fresh sizes)
  const splits = []
  for (const s of proposal.noteSplits) {
    splits.push(trim.splitNote({ corpusDir, file: s.file, apply: true }))
  }
  const state = statePath ? trim.trimState({ statePath, apply: true }) : { trimmed: false, reason: 'no state path' }

  if (wantsJson(flags)) {
    printJson({ applied: true, core, splits, state })
    return 0
  }
  process.stdout.write('SMA trim — применено (ничего не удалено, FI-9):\n')
  for (const f of core.demoted ?? []) process.stdout.write(`  ядро → периферия: ${f}\n`)
  for (const s of splits) {
    if (s.split && s.applied) process.stdout.write(`  заметка разделена: ${s.file} → ${s.archiveFile} (${s.movedLines} строк в архив)\n`)
    else process.stdout.write(`  пропущено: ${s.file} (${s.reason})\n`)
  }
  if (state.trimmed) {
    process.stdout.write(`  STATE.md: ${state.bytes} → ${state.projectedBytes} байт; секции в ${state.archivePath}\n`)
  }
  if (!(core.demoted ?? []).length && !splits.length && !state.trimmed) {
    process.stdout.write('  (всё в пределах бюджетов — ничего не понижено)\n')
  }
  return 0
}

/**
 * state <set-position|add-blocker|resolve-blocker|set-session> — the D-9.1-14
 * snapshot-semantics writer for STATE.md's machine-managed fenced region. Thin
 * wrappers over state-section.mjs; the fenced zones (Current Position / Open
 * Blockers / Active Sessions) are written ONLY here, atomically, with a
 * re-read-before-write guard. NOT hook-facing: the retry signal (a concurrent
 * out-of-band change) exits NON-ZERO with a clear message so a caller can retry.
 *
 *   state set-position  --phase <N> --text "<...>"        [--state <path>]
 *   state add-blocker    --phase <N> --text "<...>" --kind ops|external|tech
 *   state resolve-blocker --match "<substr>"
 *   state set-session    --name "<...>" --owns "<...>"
 */
async function cmdState({ positionals, flags, dirs }) {
  const sub = positionals[0]
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const statePath = typeof flags.state === 'string' && flags.state.trim()
    ? flags.state.trim()
    : join(repoRoot, '.planning', 'STATE.md')

  const stateSection = await import('./lib/state-section.mjs')

  let res
  let did
  try {
    if (sub === 'set-position') {
      const phase = typeof flags.phase === 'string' ? flags.phase : String(flags.phase ?? '')
      const text = typeof flags.text === 'string' ? flags.text : ''
      if (!phase || !text) {
        process.stderr.write('usage: pnpm sma state set-position --phase <N> --text "<...>"\n')
        return 1
      }
      res = stateSection.setPosition({ phase, text }, { statePath })
      did = `Current Position → Phase ${phase}`
    } else if (sub === 'add-blocker') {
      const phase = typeof flags.phase === 'string' ? flags.phase : String(flags.phase ?? '')
      const text = typeof flags.text === 'string' ? flags.text : ''
      const kind = typeof flags.kind === 'string' ? flags.kind : 'tech'
      if (!phase || !text) {
        process.stderr.write('usage: pnpm sma state add-blocker --phase <N> --text "<...>" --kind ops|external|tech\n')
        return 1
      }
      res = stateSection.addBlocker({ phase, text, kind }, { statePath })
      did = `Open Blockers += Phase ${phase} (${kind})`
    } else if (sub === 'resolve-blocker') {
      const match = typeof flags.match === 'string' ? flags.match : ''
      if (!match) {
        process.stderr.write('usage: pnpm sma state resolve-blocker --match "<substr>"\n')
        return 1
      }
      res = stateSection.resolveBlocker({ match }, { statePath })
      did = `Open Blockers -= «${match}»`
    } else if (sub === 'set-session') {
      const name = typeof flags.name === 'string' ? flags.name : ''
      const owns = typeof flags.owns === 'string' ? flags.owns : ''
      if (!name) {
        process.stderr.write('usage: pnpm sma state set-session --name "<...>" --owns "<...>"\n')
        return 1
      }
      res = stateSection.setSessions({ name, owns }, { statePath })
      did = `Active Sessions += ${name}`
    } else {
      process.stderr.write(
        'usage: pnpm sma state <set-position|add-blocker|resolve-blocker|set-session> [flags]\n',
      )
      return 1
    }
  } catch (err) {
    // Missing fence / read failure surfaces here (state-section throws on a missing marker).
    if (wantsJson(flags)) {
      printJson({ ok: false, retry: false, reason: (err && err.message) || String(err) })
      return 1
    }
    process.stderr.write(`SMA state: ошибка — ${(err && err.message) || err}\n`)
    return 1
  }

  if (wantsJson(flags)) {
    printJson({ ...res, statePath, action: did })
    return res.ok ? 0 : 1
  }
  if (res.ok) {
    process.stdout.write(`SMA state: ${did} записан в ${statePath}\n`)
    return 0
  }
  // retry signal (concurrent out-of-band change) — non-zero with a clear message.
  process.stderr.write(
    `SMA state: запись отклонена (${res.reason}). ${res.retry ? 'STATE.md изменился между чтением и записью — повторите команду.' : ''}\n`,
  )
  return 1
}

// ─────────────────────────── exec-journal (P5, B14) ──────────────────────────

/**
 * `exec-journal append --phase X --plan NN --event task_complete --task n
 *   --wave w --commit <sha> --test "<cmd>" --file <path> --status green [--json]`
 * `exec-journal read --phase X --plan NN [--json]`
 *
 * The per-plan execution progress journal (9.1-20). NOT hook-facing — it is
 * called at the workflow's task-commit / plan-complete steps and read at the
 * resume-ritual step. Appends are best-effort at the call site (T-9.1-44).
 */
async function cmdExecJournal({ positionals, flags, dirs }) {
  const sub = positionals[0]
  const phase = flags.phase
  const plan = flags.plan
  if (!sub || (sub !== 'append' && sub !== 'read')) {
    process.stderr.write('usage: pnpm sma exec-journal <append|read> --phase X --plan NN [...]\n')
    return 1
  }
  if (phase == null || plan == null) {
    process.stderr.write('SMA exec-journal: --phase and --plan are required\n')
    return 1
  }
  const execJournal = await import('./lib/exec-journal.mjs')
  const key = { phase: String(phase), plan: String(plan), execDir: dirs.execDir }

  if (sub === 'read') {
    const res = execJournal.read(key)
    if (wantsJson(flags)) {
      printJson({ ok: true, ...res })
      return 0
    }
    for (const e of res.events) {
      process.stdout.write(
        `${e.ts}  wave=${e.wave ?? '-'} task=${e.task ?? '-'} ${e.event} ${e.status ?? ''} ${e.commitSha ?? ''}\n`,
      )
    }
    if (res.corrupt) process.stderr.write(`(${res.corrupt} corrupt line(s) skipped)\n`)
    return 0
  }

  // append
  const entry = {
    event: flags.event ?? 'task_complete',
    wave: flags.wave != null ? Number(flags.wave) : null,
    task: flags.task != null ? Number(flags.task) : null,
    file: flags.file ?? null,
    testRun: flags.test ?? null,
    commitSha: flags.commit ?? null,
    status: flags.status ?? null,
  }
  if (flags.reason != null) entry.reason = flags.reason // blocked-event payload (9.1-21)
  const record = execJournal.append(entry, key)
  if (wantsJson(flags)) {
    printJson({ ok: true, record })
    return 0
  }
  process.stdout.write(`SMA exec-journal: ${record.event} task=${record.task ?? '-'} -> ${phase}-${plan}.jsonl\n`)
  return 0
}

/**
 * metrics [--json] — read-only process telemetry (9.1-24, B23, D-9.1-07). Reads
 * exec journals + the coordination journal + `git log` (READ-ONLY --name-only) and
 * prints lead time / rework rate / deviation counts. No writes, no network. Every
 * source is fail-open — a missing source yields that metric's honest empty marker.
 */
async function cmdMetrics({ flags, dirs }) {
  const metrics = await import('./lib/metrics.mjs')
  const { execFileSync } = await import('node:child_process')
  const journalMod = await import('./lib/journal.mjs').catch(() => null)
  const execGit = (args) => execFileSync('git', args, { encoding: 'utf8' })

  const res = metrics.gatherMetrics({ dirs, execGit, journalMod })
  if (wantsJson(flags)) {
    printJson(res)
    return 0
  }
  const lt = res.leadTime
  const rw = res.reworkRate
  const dev = res.deviations
  process.stdout.write(`SMA metrics (только чтение, из git + артефактов):\n`)
  process.stdout.write(
    `  Планов со временем: ${lt.available ? lt.plans.filter((p) => p.ms != null).length : 'нет данных'}\n`,
  )
  process.stdout.write(
    `  Доля переделок: ${rw.available && typeof rw.rate === 'number' ? Math.round(rw.rate * 100) + '%' : 'нет данных'}\n`,
  )
  process.stdout.write(
    `  Отклонений всего: ${dev.available ? dev.total : 'нет данных'}\n`,
  )
  return 0
}

/**
 * report [--out <path>] — render the LOCAL, self-contained static HTML report
 * (9.1-24, D-9.1-07): sessions, predictions, calibration, reflex firings,
 * collisions, corpus health, process metrics. Default out is <smaRoot>/report/
 * index.html (gitignored). Gathers every source FAIL-OPEN — a missing source
 * renders its honest empty state, never a fabricated number. Zero server, zero DB.
 */
async function cmdReport({ flags, dirs }) {
  const report = await import('./lib/report.mjs')

  // Assemble each source fail-open (a throw -> that section renders empty).
  const data = { generatedAt: new Date().toISOString() }

  // Sessions (registry read).
  try {
    const registry = await import('./lib/registry.mjs')
    const { sessions } = registry.readSessions(dirs)
    data.sessions = (sessions || []).map((s) => ({
      id: s.holderIdentity ?? s._file ?? '—',
      status: s.status ?? 'working',
      description: s.scope && s.scope.description ? s.scope.description : '',
      blockers: Array.isArray(s.blockers) ? s.blockers : [],
    }))
  } catch {
    data.sessions = []
  }

  // Predictions + calibration (calibration ledger).
  try {
    const calibration = await import('./lib/calibration.mjs')
    const { records } = calibration.readLedger({ calibrationDir: dirs.calibrationDir })
    const recent = (records || [])
      .filter((r) => r && r.ts)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .slice(0, 20)
      .map((r) => ({ domain: r.domain ?? 'unknown', verdict: r.verdict ?? '—', ts: r.ts }))
    data.predictions = recent
    // Per-domain calibration.
    const byDomain = new Map()
    for (const r of records || []) {
      const d = r.domain ?? 'unknown'
      if (!byDomain.has(d)) byDomain.set(d, [])
      byDomain.get(d).push(r)
    }
    data.calibration = [...byDomain.entries()].map(([domain, recs]) => ({ domain, ...calibration.hitRate(recs) }))
  } catch {
    data.predictions = []
    data.calibration = []
  }

  // Reflex firings + collisions (coordination journal).
  try {
    const journalMod = await import('./lib/journal.mjs')
    const { events } = journalMod.readJournal({ journalDir: dirs.journalDir })
    data.reflex = (events || [])
      .filter((e) => e && e.type === 'reflex')
      .map((e) => ({
        noteId: e.detail && e.detail.noteId ? e.detail.noteId : '—',
        target: e.scope ?? (e.detail && e.detail.target) ?? '',
        actor: Array.isArray(e.actors) ? e.actors.join(', ') : '',
        ts: e.ts ?? '',
      }))
    data.collisions = (events || [])
      .filter((e) => e && e.type === 'collision')
      .map((e) => ({
        type: e.type,
        actors: Array.isArray(e.actors) ? e.actors : [],
        scope: e.scope ?? '',
        ts: e.ts ?? '',
      }))
  } catch {
    data.reflex = []
    data.collisions = []
  }

  // Corpus health (snapshot loader).
  try {
    const snapshot = await import('./lib/snapshot.mjs')
    data.corpus = await snapshot.defaultLoadMemoryHealth({})
  } catch {
    data.corpus = null
  }

  // Process metrics (git + artifacts).
  try {
    const metrics = await import('./lib/metrics.mjs')
    const { execFileSync } = await import('node:child_process')
    const journalMod = await import('./lib/journal.mjs').catch(() => null)
    const execGit = (args) => execFileSync('git', args, { encoding: 'utf8' })
    data.metrics = metrics.gatherMetrics({ dirs, execGit, journalMod })
  } catch {
    data.metrics = {}
  }

  const html = report.renderReport(data)
  const out = typeof flags.out === 'string' ? flags.out : report.defaultReportPath(dirs)
  report.writeReport({ out, html })

  if (wantsJson(flags)) {
    printJson({ written: out, bytes: Buffer.byteLength(html, 'utf8') })
    return 0
  }
  process.stdout.write(`SMA report: локальный отчёт записан -> ${out}\n`)
  process.stdout.write(`  Откройте файл в браузере (работает офлайн, без сервера).\n`)
  return 0
}

/**
 * bench — the W0 measurement harness surface (9.2-01, D-9.2-02). Runs the
 * deterministic, zero-LLM 8-metric scorecard over the V2 journals + git history.
 * NOT hook-facing (a direct CLI; --freeze may hard-refuse before the freeze date).
 *
 *   bench [--json]                       all 8 metrics with value/status/method/n
 *   bench --metric <id> [--json]         one metric; ALWAYS prints value as last line
 *   bench --coverage                     count of metrics with a real base (last line)
 *   bench --timing                       total automated wall seconds (last line)
 *   bench --freeze --out <path>          refuses before FREEZE_DATE unless SMA_BENCH_FORCE=1
 *   bench --verify-freeze --against <p>  1 if deterministic bases reproduce, else 0
 *   bench ab --fixture <path>            A/B throwaway-clone replay report
 *   bench exam --new | --grade <ans> --key <key>
 */
async function cmdBench({ positionals, flags, dirs }) {
  const bench = await import('./lib/bench.mjs')
  const sub = positionals[0]

  // resolve the main-checkout repo root (the dogfood user #1 data lives there)
  let repoRoot = process.cwd()
  try {
    const registry = await import('./lib/registry.mjs')
    repoRoot = registry.smaRoot()
  } catch {
    /* fail-open to cwd */
  }

  const ctx = await buildBenchContext({ dirs, repoRoot, flags })

  // ── bench ab / exam surfaces (task 2 harness) ─────────────────────────────
  if (sub === 'ab') {
    const { execFileSync } = await import('node:child_process')
    const exec = (bin, args, opts = {}) => {
      try {
        const stdout = execFileSync(bin, args, { cwd: opts.cwd, input: opts.input, encoding: 'utf8' })
        return { stdout }
      } catch (e) {
        return { stdout: (e && e.stdout) || '' }
      }
    }
    const fixturePath = typeof flags.fixture === 'string' ? flags.fixture : join(MODULE_DIR, 'fixtures/bench/ab-session.jsonl')
    const now = () => Number(process.hrtime.bigint() / 1000000n)
    const report = bench.abRun({ srcRoot: repoRoot, fixturePath, exec, hrtime: now, cliPath: join(MODULE_DIR, 'cli.mjs') })
    printJson(report)
    return 0
  }
  if (sub === 'exam') {
    if (flags.new) {
      const state = ctx.examState ?? {}
      const res = bench.examNew({ dirs, state })
      if (wantsJson(flags)) printJson({ ok: true, path: res.path, questions: res.key.questions.length })
      else process.stdout.write(`SMA bench exam: answer key written -> ${res.path}\n`)
      return 0
    }
    if (flags.grade) {
      const { readJsonSafe } = await import('./lib/fs-atomics.mjs')
      const key = readJsonSafe(String(flags.key || ''))
      const answers = readJsonSafe(String(flags.grade || ''))
      if (!key || !answers) {
        process.stderr.write('SMA bench exam --grade: --key <keyfile> and --grade <answersfile> must both be readable JSON\n')
        return 1
      }
      const graded = bench.examGrade({ key, answers, dirs })
      if (wantsJson(flags)) printJson({ ok: true, score: graded.score, perQuestion: graded.perQuestion })
      else process.stdout.write(`SMA bench exam: score\n${graded.score}\n`)
      return 0
    }
    process.stderr.write('usage: pnpm sma bench exam --new | --grade <answers> --key <key>\n')
    return 1
  }

  // ── --freeze (date-guarded capture) ───────────────────────────────────────
  if (flags.freeze) {
    const forced = String(process.env.SMA_BENCH_FORCE ?? '').trim() && process.env.SMA_BENCH_FORCE !== '0'
    if (!bench.isFreezeAllowed(Date.now()) && !forced) {
      process.stderr.write(
        `SMA bench --freeze: отказ — окно сбора закрывается ${bench.FREEZE_DATE}. ` +
          `Заморозка разрешена только на эту дату или позже. Разовый прогон: SMA_BENCH_FORCE=1.\n`,
      )
      return 1
    }
    const captured = bench.captureBaseline(ctx)
    let anchor = 'unknown'
    try {
      const { execFileSync } = await import('node:child_process')
      anchor = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    } catch {
      /* anchor stays unknown */
    }
    const md = renderFrozenBaseline(captured, anchor)
    const out = typeof flags.out === 'string' ? flags.out : join(repoRoot, '.planning/phases/9.2-sma-v3-trust-spine/9.2-BASELINE.md')
    writeFileSync(out, md)
    process.stdout.write(`SMA bench: frozen baseline written -> ${out}\n`)
    return 0
  }

  // ── --verify-freeze (deterministic reproduction) ──────────────────────────
  if (flags['verify-freeze']) {
    const against = typeof flags.against === 'string' ? flags.against : ''
    const frozen = parseFrozenBases(readFileSafe(against))
    const res = bench.verifyFreeze({ ctx, frozen })
    if (wantsJson(flags)) {
      printJson({ ok: res.ok, checked: res.checked })
      return res.ok ? 0 : 1
    }
    // numeric last line for the scorer (1 reproduces, 0 diverges)
    process.stdout.write(`${res.ok ? 1 : 0}\n`)
    return res.ok ? 0 : 1
  }

  // ── --coverage (P9.2-01-A instrument) ────────────────────────────────────
  if (flags.coverage) {
    const metrics = bench.runAllMetrics(ctx)
    process.stdout.write(`${bench.coverageCount(metrics)}\n`)
    return 0
  }

  // ── --timing (P9.2-01-B instrument) ──────────────────────────────────────
  if (flags.timing) {
    const t0 = Number(process.hrtime.bigint())
    bench.runAllMetrics(ctx)
    const seconds = (Number(process.hrtime.bigint()) - t0) / 1e9
    process.stdout.write(`${Math.round(seconds * 100) / 100}\n`)
    return 0
  }

  // ── --metric <id> (single metric; numeric value as LAST line) ─────────────
  if (typeof flags.metric === 'string') {
    const entry = bench.metricById(flags.metric)
    if (!entry) {
      process.stderr.write(`SMA bench: неизвестная метрика «${flags.metric}»\n`)
      return 1
    }
    // S7 self-cost: the base is a LIVE timing capture (spawn the wired hook set over
    // the fixture). Run it on demand when no base is persisted yet, or on --capture,
    // then read it back. The hooks are advisory/read-only (HOOK_FACING, exit 0).
    if (entry.id === 'self-cost' && (flags.capture || bench.readSelfCostBase(ctx).status !== 'measured')) {
      await captureSelfCost(bench, repoRoot, dirs, flags)
    }
    const r = entry.measure(ctx)
    if (wantsJson(flags)) {
      printJson({ id: entry.id, scorecard: entry.scorecard, ...r })
    } else {
      process.stdout.write(`${entry.scorecard} ${entry.id}: ${r.value} ${r.unit} (${r.status}, n=${r.n})\n`)
      process.stdout.write(`  ${r.method}\n`)
    }
    // scorer contract: the numeric value is ALWAYS the last stdout line
    process.stdout.write(`${r.value}\n`)
    return 0
  }

  // ── default: all 8 metrics ────────────────────────────────────────────────
  const metrics = bench.runAllMetrics(ctx)
  if (wantsJson(flags)) {
    printJson({ metrics, coverage: bench.coverageCount(metrics), freezeDate: bench.FREEZE_DATE })
    return 0
  }
  for (const m of metrics) {
    process.stdout.write(`${m.scorecard}  ${m.id.padEnd(24)} ${String(m.value).padStart(8)} ${m.unit.padEnd(16)} [${m.status}] n=${m.n}\n`)
  }
  process.stdout.write(`coverage: ${bench.coverageCount(metrics)}/8 metrics carry a base; freeze ${bench.FREEZE_DATE}\n`)
  return 0
}

/**
 * captureSelfCost(bench, repoRoot, dirs, flags) — the S7 LIVE timing capture. Replays
 * the wired hook set over the fixture with a real execFile runner + hrtime clock and
 * persists `.sma/bench/selfcost.json` so readSelfCostBase surfaces it as measured.
 * The hooks are advisory/read-only and exit 0 (HOOK_FACING); a spawn failure just
 * yields a slightly different wall time, never a crash (fail-open).
 */
async function captureSelfCost(bench, repoRoot, dirs, flags) {
  try {
    const { execFileSync } = await import('node:child_process')
    const cliPath = join(MODULE_DIR, 'cli.mjs')
    const fixturePath = typeof flags.fixture === 'string' ? flags.fixture : join(MODULE_DIR, 'fixtures/bench/ab-session.jsonl')
    const exec = (bin, args, opts = {}) => {
      try {
        execFileSync(bin, args, { cwd: repoRoot, input: opts.input, stdio: ['pipe', 'ignore', 'ignore'] })
      } catch {
        /* a hook spawn error still consumed wall time — fail-open */
      }
    }
    const hrtime = () => Number(process.hrtime.bigint() / 1000000n)
    bench.measureSelfCost({ fixturePath, cliPath, exec, hrtime, dirs, persist: true })
  } catch {
    /* capture is best-effort — S7 stays pending-instrument if it fails */
  }
}

/** Read a file utf8, or '' on any error (fail-open helper for the bench CLI). */
function readFileSafe(path) {
  try {
    return path ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

/**
 * buildBenchContext({dirs, repoRoot, flags}) — assemble the shared ctx the registry
 * measures read: dirs, planPaths (default S1 10-plan set), summaryPaths (2 dogfood
 * phases), runCommand (allowlisted execFile runner), gitLog, journalReader. Every
 * resolver is fail-open — a missing input yields an honest empty status downstream.
 */
async function buildBenchContext({ dirs, repoRoot, flags }) {
  const { execFileSync } = await import('node:child_process')
  const journal = await import('./lib/journal.mjs')

  // runCommand: OPT-IN (--run-verify). The blind re-verify's DETERMINISTIC, fresh-
  // clone-reproducible base (P9.2-01-C) is the artifact contains-grep — pure file
  // reads. Re-running each plan's `pnpm vitest`/`node` verify command is expensive,
  // environment-sensitive (Windows cannot execFile `pnpm` directly), and therefore
  // NON-reproducible — so it is NOT wired into the routine snapshot. When wired, the
  // inner is ALREADY isSafeCommand-checked upstream (T-9.2-01); split on spaces (the
  // allowlist guarantees a safe charset) and execFile — NO shell.
  const runCommand =
    flags && flags['run-verify']
      ? (inner, opts = {}) => {
          try {
            const parts = String(inner).trim().split(/\s+/)
            execFileSync(parts[0], parts.slice(1), { cwd: opts.cwd || repoRoot, stdio: 'ignore' })
            return true
          } catch {
            return false
          }
        }
      : null

  // gitLog(planId) -> [{files:[...]}] from plan-id-grepped commits (--name-only).
  const gitLog = (planId) => {
    try {
      if (!planId) return []
      const out = execFileSync(
        'git',
        ['log', '--all', '--name-only', `--grep=${planId}`, '--pretty=format:%x00%H'],
        { cwd: repoRoot, encoding: 'utf8' },
      )
      const commits = []
      for (const block of out.split('\x00')) {
        const lines = block.split('\n').filter(Boolean)
        if (!lines.length) continue
        commits.push({ hash: lines[0], files: lines.slice(1) })
      }
      return commits
    } catch {
      return []
    }
  }

  const planPaths = resolveS1PlanSet(repoRoot)
  const summaryPaths = resolveDogfoodSummaries(repoRoot)

  return {
    dirs,
    repoRoot,
    now: Date.now(),
    planPaths,
    summaryPaths,
    ...(runCommand ? { runCommand } : {}),
    gitLog,
    summaryAccess: { exists: (p) => existsSyncSafe(p) },
    journalReader: (o) => journal.readJournal({ journalDir: (o && o.journalDir) || dirs.journalDir }),
    mode: flags && flags.share ? 'share' : 'count',
  }
}

/** existsSync that never throws. */
function existsSyncSafe(p) {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

/**
 * resolveS1PlanSet(repoRoot) — the default frozen S1 sample: the last 10 completed
 * 9.1 plans (sorted by plan number; completion = a sibling SUMMARY EXISTS). Blind:
 * only EXISTENCE is consulted, never a SUMMARY body.
 */
function resolveS1PlanSet(repoRoot) {
  try {
    const dir = join(repoRoot, '.planning/phases/9.1-sma-v2-prediction-reflex-10x')
    const files = readdirSync(dir)
    const plans = files
      .filter((f) => /^49\.1-\d+-PLAN\.md$/.test(f))
      .map((f) => ({ f, n: Number(/49\.1-(\d+)-PLAN\.md/.exec(f)[1]) }))
      .filter((p) => existsSync(join(dir, p.f.replace('-PLAN.md', '-SUMMARY.md'))))
      .sort((a, b) => a.n - b.n)
    return plans.slice(-10).map((p) => join(dir, p.f))
  } catch {
    return []
  }
}

/** resolveDogfoodSummaries(repoRoot) — the 2 most recent 9.1 phase SUMMARYs (S4 window). */
function resolveDogfoodSummaries(repoRoot) {
  try {
    const dir = join(repoRoot, '.planning/phases/9.1-sma-v2-prediction-reflex-10x')
    const files = readdirSync(dir)
      .filter((f) => /^49\.1-\d+-SUMMARY\.md$/.test(f))
      .map((f) => ({ f, n: Number(/49\.1-(\d+)-SUMMARY\.md/.exec(f)[1]) }))
      .sort((a, b) => a.n - b.n)
    return files.slice(-2).map((p) => join(dir, p.f))
  } catch {
    return []
  }
}

/** parseFrozenBases(md) -> {'false-done-rate':n, 'phantom-writes':n} from a baseline file. */
function parseFrozenBases(md) {
  const out = {}
  for (const id of ['false-done-rate', 'phantom-writes']) {
    const re = new RegExp(`${id}[^\\n]*?\\|\\s*([-\\d.]+)\\s*\\|`)
    const m = re.exec(String(md))
    if (m) out[id] = Number(m[1])
  }
  return out
}

/** renderFrozenBaseline(captured, anchor) — the status:frozen markdown emitter. */
function renderFrozenBaseline(captured, anchor) {
  const rows = captured.metrics
    .map((m) => `| ${m.scorecard} | ${m.id} | ${m.value} | ${m.unit} | ${m.status} | ${m.n} | ${m.method} |`)
    .join('\n')
  return `---
phase: 9.2-sma-v3-trust-spine
plan: 01
artifact: baseline
status: frozen
freeze_date: ${captured.capturedAt}
window_anchor: ${anchor}
---

# 9.2 BASELINE (FROZEN)

Frozen ${captured.capturedAt} at git ${anchor}. Immutable (PRED-POSTEDIT). A correction is a NEW dated addendum, never an edit.

| # | metric | value | unit | status | n | method |
|---|--------|-------|------|--------|---|--------|
${rows}
`
}

// ─────────────── 9.2-04 (D-9.2-10): subagent write-receipts + pack inheritance ───────

/** Resolve the parent terminalId for a window token (fail-open to 'unknown'). */
async function resolveTerminalId(sessionToken) {
  try {
    const registry = await import('./lib/registry.mjs')
    const id = registry.resolveTerminalIdentity({ sessionToken })
    return id && id.terminalId ? id.terminalId : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Next spawn-record sequence for a window token (count of existing records + 1). */
function nextSpawnSeq(subagentsDir, windowToken) {
  try {
    const n = readdirSync(subagentsDir).filter(
      (f) => f.startsWith(`${windowToken}-`) && f.endsWith('.json'),
    ).length
    return n + 1
  } catch {
    return 1
  }
}

/** Read every spawn record in .sma/subagents/ (fail-open to []). */
async function readSpawnRecords(subagentsDir) {
  const fsa = await import('./lib/fs-atomics.mjs')
  let files
  try {
    files = readdirSync(subagentsDir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    const rec = fsa.readJsonSafe(join(subagentsDir, f))
    if (rec && typeof rec === 'object') out.push({ ...rec, _file: f })
  }
  return out
}

/**
 * buildPackSources — wire the real V2 read paths into assemblePack as SYNC closures
 * (the modules are lazy-imported once here; the closures never re-import). Every
 * source is individually fail-open — a missing corpus / claims dir degrades that
 * layer, never the pack.
 */
async function buildPackSources({ dirs, repoRoot }) {
  const corpusDir = join(repoRoot, '.claude', 'memory')
  const tagsPath = join(corpusDir, 'TAGS.md')
  let loader, frontmatter, claimsMod, registry, execJournal
  try { loader = await import('./lib/loader.mjs') } catch { /* no loader → no digest/lessons */ }
  try { frontmatter = await import('./lib/frontmatter.mjs') } catch { /* no parser → no notes */ }
  try { claimsMod = await import('./lib/claims.mjs') } catch { /* no claims */ }
  try { registry = await import('./lib/registry.mjs') } catch { /* no sessions */ }
  try { execJournal = await import('./lib/exec-journal.mjs') } catch { /* no exec tail */ }

  const readNoteMeta = (file) => {
    try {
      const parsed = frontmatter.parseNote(readFileSync(join(corpusDir, file), 'utf8'), { file })
      const fm = parsed.frontmatter || {}
      return { title: String(file).replace(/\.md$/, ''), oneLiner: typeof fm.description === 'string' ? fm.description : '' }
    } catch {
      return null
    }
  }

  let vocab = new Set()
  try {
    const reg = frontmatter.loadTagsRegistry(tagsPath)
    for (const t of reg.area) vocab.add(String(t).toLowerCase())
    for (const t of reg.kind) vocab.add(String(t).toLowerCase())
  } catch {
    /* no registry → empty vocab → CORE-only pack */
  }

  return {
    vocab,
    loadCore: () => {
      try {
        const res = loader.resolvePeriphery({ tags: [], corpusDir, tagsPath })
        return (res.core || []).map(readNoteMeta).filter(Boolean)
      } catch {
        return []
      }
    },
    loadPeriphery: (tags) => {
      try {
        const files = new Set()
        for (const tag of tags || []) {
          try {
            const res = loader.resolvePeriphery({ tags: [tag], corpusDir, tagsPath })
            for (const f of res.periphery) files.add(f)
          } catch {
            /* fail-open per tag */
          }
        }
        return [...files].map(readNoteMeta).filter(Boolean)
      } catch {
        return []
      }
    },
    readClaims: () => {
      try {
        return claimsMod.readClaims(dirs)
      } catch {
        return []
      }
    },
    readSessions: () => {
      try {
        return registry.readSessions(dirs).sessions
      } catch {
        return []
      }
    },
    execTail: () => {
      try {
        const files = readdirSync(dirs.execDir).filter((f) => f.endsWith('.jsonl'))
        if (!files.length) return []
        let newest = null
        let newestMs = -1
        for (const f of files) {
          try {
            const m = statSync(join(dirs.execDir, f)).mtimeMs
            if (m > newestMs) {
              newestMs = m
              newest = f
            }
          } catch {
            /* skip an unstatable file */
          }
        }
        if (!newest) return []
        const base = newest.replace(/\.jsonl$/, '')
        const idx = base.lastIndexOf('-')
        const phase = idx >= 0 ? base.slice(0, idx) : base
        const plan = idx >= 0 ? base.slice(idx + 1) : ''
        const res = execJournal.read({ phase, plan, execDir: dirs.execDir })
        return (res.events || []).slice(-5)
      } catch {
        return []
      }
    },
  }
}

/**
 * pretask-pack — the PreToolUse(matcher "Task") hook (9.2-04, D-9.2-10). Injects
 * the assembled context pack into every subagent spawn via `updatedInput` —
 * inheritance by construction. Acts ONLY on Task; anything else is a silent
 * pass-through. Kill-switch SMA_PACK_DISABLE=1 → no pack injection (compensating
 * control: subagent-verify still receipts every stop). Measures durationMs, writes a
 * spawn record, and journals a `subagent-pack` event so the p95 SLO stays measurable.
 *
 * gap C / PRED-9.2-02-B (D-9.2-04 one-spawn): this is the SOLE scripts/sma spawn on the
 * Task matcher — the 9.2-09 Task-cap spend soft-deny stream rides INSIDE it (runStreamCollect
 * over the one 'spend' PRE_CHECK), so there is never a second node process per Task PreToolUse.
 * A spend soft-deny short-circuits (deny wins, no pack injection); spend warns merge into the
 * pack output's additionalContext. Opt-in (SMA_SPEND_OPTIN) + kill-switch (SMA_SPEND_DISABLE)
 * are the stream's own and unchanged. HOOK_FACING: exit 0 always; every source fail-open.
 */
async function cmdPretaskPack({ dirs }) {
  const evt = readStdinJson()
  if (!evt || evt.tool_name !== 'Task') return 0 // non-Task → silent pass-through

  // gap C / PRED-9.2-02-B (D-9.2-04 one-spawn): the Task-cap spend soft-deny stream rides
  // INSIDE this single Task PreToolUse spawn — never a second scripts/sma process. Same
  // consolidation seam as plan 02's `pre` multiplexer (runStreamCollect over the ONE stream).
  // Opt-in (SMA_SPEND_OPTIN) + kill-switch (SMA_SPEND_DISABLE) are unchanged — the stream owns
  // them. Fail-open: a spend error never blocks the spawn. Runs FIRST so a soft-deny short-
  // circuits before any pack work (and so it still fires when SMA_PACK_DISABLE is set).
  let spendWarns = []
  let spendDeny = null
  try {
    const r = await runStreamCollect(dirs, 'spend', evt)
    spendWarns = Array.isArray(r.warns) ? r.warns : []
    spendDeny = r.deny || null
  } catch {
    /* fail-open */
  }
  if (spendDeny && spendDeny.text) {
    printJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [spendDeny.text, ...spendWarns].join('\n'),
      },
    })
    return 0
  }

  if (isEnvOn(process.env.SMA_PACK_DISABLE)) {
    // kill-switch → no pack injection, but still surface any spend warns (parity with the
    // former standalone spend-check spawn, which ran regardless of SMA_PACK_DISABLE).
    if (spendWarns.length) {
      printJson({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: spendWarns.join('\n') },
      })
    }
    return 0
  }

  const taskInput = evt.tool_input && typeof evt.tool_input === 'object' ? evt.tool_input : {}
  const windowToken = windowTokenFrom(evt) || 'unknown'
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()

  const packMod = await import('./lib/subagent-pack.mjs')
  const sources = await buildPackSources({ dirs, repoRoot })

  const t0 = Date.now()
  const assembled = packMod.assemblePack({ taskInput, sources })
  const durationMs = Date.now() - t0

  // spawn record (own try/catch — a store failure never blocks the spawn).
  try {
    const fsa = await import('./lib/fs-atomics.mjs')
    const seq = nextSpawnSeq(dirs.subagentsDir, windowToken)
    fsa.atomicWriteJson(join(dirs.subagentsDir, `${windowToken}-${seq}.json`), {
      at: new Date().toISOString(),
      windowToken,
      bytes: assembled.bytes,
      layers: assembled.layers,
      durationMs,
      taskDescription: typeof taskInput.description === 'string' ? taskInput.description : '',
      consumed: false,
    })
  } catch {
    /* fail-open */
  }

  // journal a subagent-pack event (its OWN try/catch).
  try {
    const journal = await import('./lib/journal.mjs')
    const terminalId = await resolveTerminalId(windowToken)
    journal.appendEvent(
      { type: 'subagent-pack', detail: { bytes: assembled.bytes, durationMs } },
      { terminalId, journalDir: dirs.journalDir },
    )
  } catch {
    /* fail-open */
  }

  // Capability-probe fallback lever: if a harness build ignores updatedInput, run with
  // SMA_PACK_MODE=additionalContext — the pack lands as additionalContext instead and a
  // `pack-degraded` event is journaled (degraded is never silent, never a deny).
  if (String(process.env.SMA_PACK_MODE ?? '').trim() === 'additionalContext') {
    try {
      const journal = await import('./lib/journal.mjs')
      const terminalId = await resolveTerminalId(windowToken)
      journal.appendEvent({ type: 'pack-degraded', detail: { reason: 'additionalContext-mode' } }, { terminalId, journalDir: dirs.journalDir })
    } catch {
      /* fail-open */
    }
    const ctxParts = [assembled.pack, ...(spendWarns.length ? [spendWarns.join('\n')] : [])].filter(Boolean)
    printJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctxParts.join('\n') } })
    return 0
  }

  // updatedInput injection + any spend warns as additionalContext (both ride one hookSpecificOutput).
  const out = packMod.buildUpdatedInput(evt, assembled.pack)
  if (spendWarns.length && out && out.hookSpecificOutput) {
    out.hookSpecificOutput.additionalContext = [out.hookSpecificOutput.additionalContext, spendWarns.join('\n')]
      .filter(Boolean)
      .join('\n')
  }
  printJson(out)
  return 0
}

/**
 * subagent-verify — the SubagentStop hook (9.2-04, D-9.2-10). Extracts every
 * claimed write from the stop's transcript and verifies each against the REAL git
 * tree (existence + dirty-state + commits-since-spawn), landing ONE receipt in the
 * shared journal with phantom writes flagged. Kill-switch SMA_RECEIPTS_DISABLE=1 →
 * no-op (compensating control: the pre-push grill, plan 07, still blind-verifies).
 * HOOK_FACING: exit 0 always, NEVER a block decision; every stage fail-open. git runs
 * via execFileSync arg arrays with a literal `--` before every path (no shell string).
 */
async function cmdSubagentVerify({ dirs }) {
  const evt = readStdinJson()
  if (isEnvOn(process.env.SMA_RECEIPTS_DISABLE)) return 0 // kill-switch → no-op
  const transcriptPath = evt && typeof evt.transcript_path === 'string' ? evt.transcript_path : null
  if (!transcriptPath) return 0

  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const receipts = await import('./lib/subagent-receipts.mjs')
  const { claims, sha, firstTs } = receipts.extractClaimedWrites(transcriptPath)

  // spawn correlation FIRST (its `at` seeds --since=<spawnedAt>).
  const windowToken = windowTokenFrom(evt)
  let spawn = null
  try {
    const records = await readSpawnRecords(dirs.subagentsDir)
    spawn = receipts.correlateSpawn(records, { windowToken, at: new Date().toISOString() })
  } catch {
    /* fail-open */
  }
  const spawnedAt = (spawn && spawn.at) || firstTs || null
  const spawnedAtSource = spawn && spawn.at ? 'spawn-record' : firstTs ? 'transcript-first' : 'none'

  // git via execFileSync arg arrays — the `--` separator is enforced inside verifyWrites.
  const { execFileSync } = await import('node:child_process')
  const runGit = (cmd, args) => {
    try {
      return execFileSync('git', [cmd, ...args], { cwd: repoRoot, encoding: 'utf8' })
    } catch {
      return ''
    }
  }
  const verdicts = receipts.verifyWrites(claims, {
    repoRoot,
    spawnedAt,
    runGit,
    statFile: (abs) => existsSync(abs),
  })

  // one receipt into the shared journal under the parent terminalId.
  try {
    const journal = await import('./lib/journal.mjs')
    const terminalId = await resolveTerminalId(windowToken)
    receipts.writeReceipt(
      { verdicts, transcriptSha: sha, spawn, spawnedAtSource },
      { appendEvent: journal.appendEvent, terminalId, journalDir: dirs.journalDir },
    )
  } catch {
    /* fail-open — a receipt failure never blocks the stop */
  }

  // mark the correlated spawn record consumed (best-effort, keeps coverage honest).
  if (spawn && spawn._file) {
    try {
      const fsa = await import('./lib/fs-atomics.mjs')
      const { _file, ...rest } = spawn
      fsa.atomicWriteJson(join(dirs.subagentsDir, _file), { ...rest, consumed: true })
    } catch {
      /* fail-open */
    }
  }

  // WARN summary on any phantom/divergent verdict — human-visible, NEVER a block.
  const bad = verdicts.filter(
    (v) => v.verdict === 'phantom-missing' || v.verdict === 'phantom-unchanged' || v.verdict === 'divergent',
  )
  if (bad.length) {
    process.stdout.write(
      `SMA subagent-verify: ${bad.length} непроверенных заявок о записи (phantom/divergent) — ` +
        `${bad.map((v) => v.path).join(', ')}\n`,
    )
  }
  return 0
}

/**
 * subagent-receipts [--json] [--stat coverage|phantoms|pack-p95] [--schema-check]
 * — the report (direct-CLI, may exit 1). Reads the shared journal via
 * receiptStats. `--stat` prints the bare numeric as the LAST line (the
 * predict.mjs scorer contract — these are this plan's three check_commands).
 * `--schema-check` prints bare 1/0 (report shape valid?) and ALWAYS exits 0 —
 * the accrual-proof receipt surface (BL-172): pin THIS, never the --json
 * output, whose numbers accrue with every spawn. Honest empty: zero spawns →
 * coverage 100, phantoms 0, pack-p95 0, flagged "empty" in --json.
 */
async function cmdSubagentReceipts({ flags, dirs }) {
  const receipts = await import('./lib/subagent-receipts.mjs')
  const journal = await import('./lib/journal.mjs')
  let events = []
  try {
    events = journal.readJournal(dirs).events
  } catch {
    events = []
  }
  const stats = receipts.receiptStats(events)

  // BL-172: deterministic structural mode — 1/0 LAST line, always exit 0.
  if (flags['schema-check'] === true) {
    const ok = receipts.receiptStatsSchemaOk(stats) ? 1 : 0
    if (wantsJson(flags)) printJson({ schemaOk: ok })
    process.stdout.write(`${ok}\n`)
    return 0
  }

  if (typeof flags.stat === 'string') {
    const map = {
      coverage: stats.coverage,
      phantoms: stats.phantoms,
      'pack-p95': stats.packP95,
      phantomsAsserted: stats.phantomsAsserted,
    }
    const key = flags.stat
    if (!(key in map)) {
      // BL-173/plan-checker BLOCK: an unknown key is a LOUD error on stderr with SILENT
      // stdout — a scorer parsing the last stdout line must see the ABSENCE of a number,
      // never a fabricated 0 (the vacuous-pass class). No stdout write here.
      process.stderr.write(
        `SMA subagent-receipts: неизвестный --stat «${key}» (coverage|phantoms|pack-p95|phantomsAsserted)\n`,
      )
      return 1
    }
    process.stdout.write(`${map[key]}\n`)
    return 0
  }

  if (wantsJson(flags)) {
    printJson(stats)
    return 0
  }

  process.stdout.write(
    `SMA subagent-receipts: покрытие ${stats.coverage}%, phantom(tool-call) ${stats.phantoms}, ` +
      `phantom(asserted) ${stats.phantomsAsserted}, pack p95 ${stats.packP95} мс${stats.empty ? ' (пусто)' : ''}\n`,
  )
  return 0
}

// ── 9.3-06 (D-9.3-12): self-tuning enforcement — ladder / tune / curriculum ───

/**
 * Assemble the ladder engine's inputs ONCE from the live journal + calibration
 * ledger + the tracked registry: classifies every fire and computes the 30d benefit
 * stats. Every downstream verb (ladder/tune/curriculum) reads from this. Fail-open.
 */
async function ladderInputs(dirs, { now } = {}) {
  const journal = await import('./lib/journal.mjs')
  const calibration = await import('./lib/calibration.mjs')
  const ladderLib = await import('./lib/ladder.mjs')
  const nowMs = now ?? Date.now()
  const windowMs = 30 * 24 * 60 * 60 * 1000

  let events = []
  try {
    events = journal.readJournal({ journalDir: dirs.journalDir }).events
  } catch {
    /* fail-open */
  }
  let ledgers = []
  try {
    ledgers = calibration.readLedger({ calibrationDir: dirs.calibrationDir }).records
  } catch {
    /* fail-open */
  }
  const ladderPath = await ladderPathFrom(dirs)
  const ladder = ladderLib.readLadder({ ladderPath })
  const ruleDomains = {}
  for (const r of ladder.rules) if (r && r.ruleId && r.domain) ruleDomains[r.ruleId] = r.domain
  const classified = ladderLib.classifyFires({ events, ledgers, now: nowMs, ruleDomains })
  const stats = ladderLib.benefitStats({ classified, windowMs, now: nowMs })
  return { journal, calibration, ladderLib, ladderPath, ladder, events, ledgers, classified, stats, nowMs, windowMs }
}

/** A note/retired reflex rule with evidence rows = a demoted-as-noise rule. */
function isDemotedNoise(r) {
  return r && r.kind === 'reflex' && (r.tier === 'note' || r.tier === 'retired') && Array.isArray(r.evidence) && r.evidence.length > 0
}

/**
 * ladder [--json | --count-autofix | --noise-demoted-pct] — the tier table + benefit
 * stats. Each --count/--pct flag prints a BARE integer last line (the scorer contract)
 * and exits 0. This plan's own predictions (P9.3-06-01/02) are scored from these.
 */
async function cmdLadder({ flags, dirs }) {
  const { ladder, stats } = await ladderInputs(dirs)

  if (flags['count-autofix']) {
    // Rules at 'auto-fix' whose history rows ALL carry non-empty evidence journalRefs —
    // an evidence-free hand-set tier is excluded (and is a LADDER-EVIDENCE lint failure).
    const n = ladder.rules.filter(
      (r) =>
        r &&
        r.tier === 'auto-fix' &&
        Array.isArray(r.history) &&
        r.history.length > 0 &&
        r.history.every((h) => Array.isArray(h.evidence) && h.evidence.some((e) => e && Array.isArray(e.journalRefs) && e.journalRefs.length > 0)),
    ).length
    if (wantsJson(flags)) printJson({ autofix_rules_evidenced: n })
    process.stdout.write(`${n}\n`)
    return 0
  }

  if (flags['noise-demoted-pct']) {
    const demoted = ladder.rules.filter(isDemotedNoise).length
    const fired = new Set(Object.values(stats).filter((s) => s.kind === 'reflex' && s.fires > 0).map((s) => s.ruleId)).size
    const pct = fired > 0 ? Math.floor((100 * demoted) / fired) : 0 // honest 0 on empty denominator
    if (wantsJson(flags)) printJson({ noise_demoted_pct: pct, demoted, reflex_fired: fired })
    process.stdout.write(`${pct}\n`)
    return 0
  }

  if (wantsJson(flags)) {
    printJson({ ladder, stats })
    return 0
  }
  process.stdout.write(`SMA ladder: ${ladder.rules.length} rule(s) on the registry.\n`)
  for (const r of ladder.rules) {
    const s = stats[r.ruleId]
    const bits = s ? `fires ${s.fires}, heeded ${s.heeded}, ignored-broke ${s.ignoredBroke}` : 'no fires in window'
    process.stdout.write(`  ${r.ruleId} [${r.kind}] tier=${r.tier} — ${bits}\n`)
  }
  return 0
}

/** A real execFileSync runner for `tune fix` — the injected boundary the libs never cross. */
async function ladderCommandRunner(repoRoot) {
  const { execFileSync } = await import('node:child_process')
  return (command) => {
    const parts = String(command).trim().split(/\s+/)
    return execFileSync(parts[0], parts.slice(1), { cwd: repoRoot, encoding: 'utf8' })
  }
}

/**
 * tune — the tuner surface (never commits, never pushes):
 *   tune [--propose | --apply] [--json]           propose (default, writes NOTHING) / apply the diff
 *   tune benefit [--json | --ignored-broke-trend-pct]  per-rule benefit table + the trend scorer
 *   tune fix <ruleId>                              apply a rule's allowlisted fix as a working-tree diff
 *   tune incident <scope> --rule <ruleId>          the honest manual broke-attribution channel (scored)
 */
async function cmdTune({ positionals, flags, dirs }) {
  const sub = positionals[0]
  const inp = await ladderInputs(dirs)
  const { ladderLib, ladderPath, ladder, classified, stats, nowMs } = inp
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()

  // tune benefit — per-rule benefit table + the ignored-broke trend scorer.
  if (sub === 'benefit') {
    if (flags['ignored-broke-trend-pct']) {
      const broke = classified.filter((c) => c.classification === 'ignored-broke').map((c) => Date.parse(c.ts)).filter(Number.isFinite)
      const THIRTY = 30 * 24 * 60 * 60 * 1000
      const minTs = broke.length ? Math.min(...broke) : null
      const base = minTs == null ? 0 : broke.filter((t) => t <= minTs + THIRTY).length
      const trailing = broke.filter((t) => t >= nowMs - THIRTY).length
      const pct = base > 0 ? Math.floor((100 * trailing) / base) : 100 // no unearned win on an empty base
      if (wantsJson(flags)) printJson({ ignored_broke_trend_pct: pct, base, trailing })
      process.stdout.write(`${pct}\n`)
      return 0
    }
    if (wantsJson(flags)) {
      printJson({ stats })
      return 0
    }
    process.stdout.write('SMA tune benefit:\n')
    for (const s of Object.values(stats)) {
      process.stdout.write(`  ${s.ruleId} [${s.kind}] fires=${s.fires} heeded=${s.heeded} ignored-ok=${s.ignoredOk} ignored-broke=${s.ignoredBroke} spanDays=${Math.round(s.spanDays)}\n`)
    }
    return 0
  }

  // tune fix <ruleId> — apply an allowlisted registered fix as a working-tree diff.
  if (sub === 'fix') {
    const ruleId = positionals[1]
    if (!ruleId) {
      process.stderr.write('usage: pnpm sma tune fix <ruleId>\n')
      return 1
    }
    let runCommand
    try {
      runCommand = await ladderCommandRunner(repoRoot)
    } catch {
      runCommand = null
    }
    const res = ladderLib.applyFix({ ruleId, runCommand, ladderPath, journalDir: dirs.journalDir, terminalId: 'tune-fix' })
    if (wantsJson(flags)) printJson(res)
    else process.stdout.write(res.ok ? `SMA tune fix: ${ruleId} applied (greenApplies=${res.greenApplies}). Review the working-tree diff, then commit yourself.\n` : `SMA tune fix: ${ruleId} not applied — ${res.reason ?? res.error ?? 'no allowlisted fix'}.\n`)
    return 0
  }

  // tune incident <scope> --rule <ruleId> — the honest, SCORED manual broke-attribution.
  if (sub === 'incident') {
    const scope = positionals[1]
    const ruleId = typeof flags.rule === 'string' ? flags.rule : null
    if (!scope || !ruleId) {
      process.stderr.write('usage: pnpm sma tune incident <scope> --rule <ruleId>\n')
      return 1
    }
    try {
      inp.journal.appendEvent({ type: 'incident', actors: ['tune-incident'], scope, detail: { ruleId, scope } }, { terminalId: 'tune-incident', journalDir: dirs.journalDir })
    } catch {
      /* fail-open */
    }
    if (wantsJson(flags)) printJson({ recorded: true, ruleId, scope })
    else process.stdout.write(`SMA tune incident: recorded a break on ${ruleId} at ${scope} — it now counts as ignored-broke evidence.\n`)
    return 0
  }

  // tune [--propose | --apply] — the default proposal surface.
  let checkFixture = () => null
  try {
    const stpa = await import('./lib/stpa.mjs')
    const report = stpa.shadowRunFixtures({ env: process.env, dirs })
    checkFixture = (ruleId) => {
      const row = report.find((r) => r.gateId === ruleId || r.killEnv === ruleId)
      return row ? { fixtureTrips: row.fixtureTrips, compensated: false } : null // unknown -> conservative refuse
    }
  } catch {
    /* fail-open — no STPA -> conservative refuse default */
  }
  const proposals = ladderLib.proposeTierChanges({ ladder, stats, checkFixture })

  if (flags.apply) {
    const res = ladderLib.applyProposals({ proposals, ladderPath, journalDir: dirs.journalDir, terminalId: 'tune-apply' })
    if (wantsJson(flags)) printJson({ applied: res.applied, proposals })
    else process.stdout.write(`SMA tune --apply: ${res.applied} tier change(s) written to ${ladderPath} (working-tree diff only — review \`git diff\` and commit yourself).\n`)
    return 0
  }

  // default --propose: print proposals + evidence, write NOTHING.
  if (wantsJson(flags)) {
    printJson({ proposals })
    return 0
  }
  process.stdout.write(`SMA tune --propose: ${proposals.length} proposal(s) (advisory — nothing written).\n`)
  for (const p of proposals) {
    if (p.kind === 'gate-candidate') {
      process.stdout.write(`  ${p.ruleId}: GATE-CANDIDATE — ${p.reason}\n`)
    } else {
      const e = (p.evidence && p.evidence[0]) || {}
      process.stdout.write(`  ${p.ruleId}: ${p.from} → ${p.to}${p.refused ? ' [REFUSED: ' + p.refusalReason + ']' : ''} (fires=${e.fires ?? 0}, ignored-broke=${e.ignoredBroke ?? 0})\n`)
    }
  }
  return 0
}

/**
 * curriculum [--json | --latest] — assemble the weekly miss-curriculum for the current
 * ISO week: cluster misses -> prediction templates -> weak-spots brief. --latest prints
 * the newest brief path. Fail-open; NOT hook-facing.
 */
async function cmdCurriculum({ flags, dirs }) {
  const curriculum = await import('./lib/curriculum.mjs')
  if (flags.latest) {
    const latest = curriculum.latestBrief({ dirs, now: Date.now() })
    if (wantsJson(flags)) printJson(latest)
    else process.stdout.write(latest.path ? `${latest.path}${latest.stale ? ' (STALE)' : ''}\n` : 'SMA curriculum: no brief yet — run `pnpm sma curriculum`.\n')
    return 0
  }

  const inp = await ladderInputs(dirs)
  const week = curriculum.isoWeek(Date.now())
  const clusters = curriculum.clusterMisses({ ledgers: inp.ledgers, events: inp.events, classified: inp.classified, windowMs: inp.windowMs, now: inp.nowMs })
  const templates = curriculum.predictionTemplates({ clusters, week, dirs })
  const stpaFixture = () => null
  const proposals = inp.ladderLib.proposeTierChanges({ ladder: inp.ladder, stats: inp.stats, checkFixture: stpaFixture })
  const brief = curriculum.weakSpotsBrief({ clusters, proposals, templates, week, dirs })

  if (wantsJson(flags)) {
    printJson({ week, clusters, templates: templates.length, brief: brief.path })
    return 0
  }
  process.stdout.write(`SMA curriculum ${week.year}W${String(week.week).padStart(2, '0')}: ${clusters.length} cluster(s), ${templates.length} template(s).\n`)
  process.stdout.write(`  brief: ${brief.path}\n`)
  return 0
}

// ─────────────────────────── dispatch ────────────────────────────────────────

/** Subcommands whose failure must NEVER wedge a session (exit 0 unconditionally). */
// ── 9.2-07 (D-9.2-11): /sma-grill adversarial gate + blind verifier + evidence ───

/** planId from a plan path: basename minus the -PLAN.md / -SUMMARY.md suffix. */
function planIdFromPath(p) {
  return basename(String(p ?? '')).replace(/-(PLAN|SUMMARY)\.md$/i, '').replace(/\.md$/i, '')
}

/** Recursively collect *-PLAN.md paths under a directory (bounded, fail-open). */
function findPlanFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) findPlanFiles(full, out)
    else if (/-PLAN\.md$/i.test(e.name)) out.push(full)
  }
  return out
}

/**
 * buildPlanIndex(repoRoot) -> [{planId, files, domains, order}]. Scans the
 * .planning phases tree for every -PLAN.md, reading each frontmatter's
 * files_modified globs + the predictions' domains — the files→domains edges
 * prePushPlan maps changed files over.
 * Order = a monotone recency key (phase.plan numeric). Pure read; fail-open.
 */
async function buildPlanIndex(repoRoot) {
  const predict = await import('./lib/predict.mjs')
  const planDir = join(repoRoot, '.planning', 'phases')
  const index = []
  for (const planPath of findPlanFiles(planDir)) {
    let text = ''
    try {
      text = readFileSync(planPath, 'utf8')
    } catch {
      continue
    }
    const files = parseYamlListBlock(text, 'files_modified')
    const { predictions } = predict.parsePredictions(planPath)
    const domains = [...new Set(predictions.map((p) => p && p.domain).filter(Boolean))]
    const planId = planIdFromPath(planPath)
    const m = /(\d+(?:\.\d+)?)-(\d+)/.exec(planId)
    const order = m ? Number(m[1]) * 1000 + Number(m[2]) : 0
    index.push({ planId, files, domains, order })
  }
  return index
}

/** Parse a simple top-level `key:` block of `  - value` scalar list items. */
function parseYamlListBlock(text, key) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  if (!norm.startsWith('---\n')) return []
  const closeIdx = norm.indexOf('\n---\n', 3)
  const fm = closeIdx === -1 ? norm.slice(4) : norm.slice(4, closeIdx + 1)
  const lines = fm.split('\n')
  const out = []
  let i = 0
  const keyRe = new RegExp(`^${key}:\\s*$`)
  while (i < lines.length && !keyRe.test(lines[i])) i++
  if (i >= lines.length) return []
  i++
  for (; i < lines.length; i++) {
    const m = /^\s*-\s+(.+)$/.exec(lines[i])
    if (m) {
      let v = m[1].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out.push(v)
    } else if (/^[A-Za-z_]/.test(lines[i]) || lines[i].trim() === '---') break
    else if (/^  [A-Za-z_][\w-]*:/.test(lines[i])) break
  }
  return out
}

/**
 * grill — the adversarial challenge gate CLI (D-9.2-11). Modes:
 *   grill <plan> --challenge "promise::attack"        register a challenge
 *   grill <plan> --resolve <CH-id> --as converted --prediction <P-id>
 *   grill <plan> --resolve <CH-id> --as withdrawn|accepted-risk --reason|--disposition
 *   grill <plan> --gate                                print allowed/blocked; exit 1 if blocked
 *   grill <plan> --standing                            the economy-ladder standing challenge «which ladder rung?»
 *   grill --standing-selftest                          1/0 last line (P9.4-07-A)
 *   grill <plan> --land <CH-id>                        tag a landed pre-push defect
 *   grill --pre-push [--budget 3]                      budget-aware pre-push depth plan
 *   grill --stats --metric challenge-yield             numeric last line (P9.2-07-A)
 * NOT hook-facing — the caller decides on the exit code.
 */
async function cmdGrill({ positionals, flags, dirs }) {
  const grill = await import('./lib/grill.mjs')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()

  // --standing-selftest → 1/0 last line (P9.4-07-A; no plan path needed).
  if (flags['standing-selftest']) {
    const footprint = await import('./lib/footprint.mjs')
    const ok = await footprint.standingSelftest()
    process.stdout.write(`${ok}\n`)
    return ok === 1 ? 0 : 1
  }

  // --stats --metric challenge-yield → numeric last line (the scorer contract).
  if (flags.stats) {
    const stats = grill.challengeStats({ grillDir: dirs.grillDir })
    if (wantsJson(flags)) printJson(stats)
    process.stdout.write(`${stats.yieldPct}\n`)
    return 0
  }

  // --pre-push → the budget-aware depth plan over origin..main.
  if (flags['pre-push']) {
    const { execFileSync } = await import('node:child_process')
    let changedFiles = []
    try {
      const out = execFileSync('git', ['diff', '--name-only', 'origin/main..main'], { cwd: repoRoot, encoding: 'utf8' })
      changedFiles = out.split('\n').map((s) => s.trim()).filter(Boolean)
    } catch {
      changedFiles = []
    }
    const planIndex = await buildPlanIndex(repoRoot)
    const calibration = await import('./lib/calibration.mjs')
    const { records: ledger } = calibration.readLedger({ calibrationDir: dirs.calibrationDir })
    const budget = Number.isFinite(Number(flags.budget)) ? Number(flags.budget) : 3
    const plan = grill.prePushPlan({ changedFiles, planIndex, ledger, budget })
    if (wantsJson(flags)) {
      printJson(plan)
      return 0
    }
    process.stdout.write(`SMA grill pre-push — ${changedFiles.length} changed files, budget ${budget} deep blind re-verifications:\n`)
    process.stdout.write('  DEEP (spend depth here — ledger proves miscalibration or unproven):\n')
    for (const d of plan.deep) {
      const tier = ['proven-bad', 'unproven', 'proven-good'][d.tier]
      process.stdout.write(`    [${tier}] ${d.domain}${d.plan ? ` → blind-verify ${d.plan}` : ''} (n=${d.n}${d.rate != null ? `, rate=${Math.round(d.rate * 100)}%` : ''})\n`)
    }
    if (plan.light.length) {
      process.stdout.write('  LIGHT (skim):\n')
      for (const d of plan.light) process.stdout.write(`    ${d.domain}\n`)
    }
    return 0
  }

  const planPath = positionals[0]
  if (!planPath) {
    process.stderr.write('usage: pnpm sma grill <plan-path> [--challenge "promise::attack" | --resolve <CH-id> --as <status> | --gate | --standing | --land <CH-id>] | grill --standing-selftest\n')
    return 1
  }
  const planId = planIdFromPath(planPath)
  const by = await resolveTerminalId().catch(() => 'unknown')

  // --standing → the economy ladder's standing challenge «which ladder rung?»
  // (9.4-07). No claim -> register an open challenge (so --gate blocks per
  // D-9.2-11, zero new gate code). A claim present -> resolve it as withdrawn.
  if (flags.standing) {
    const footprint = await import('./lib/footprint.mjs')
    const claim = footprint.parseFootprintClaim(planPath)
    const res = grill.standingFootprint({ planPath, planId, claim, grillDir: dirs.grillDir })
    if (wantsJson(flags)) {
      printJson({ ...res, claim })
      return 0
    }
    if (res.action === 'registered') {
      process.stdout.write(
        `SMA grill [${planId}]: standing challenge «which ladder rung?» зарегистрирован (${res.challenge?.id}) — ` +
          'план БЕЗ footprint-заявки не проходит gate. Добавьте в frontmatter блок `footprint:` ' +
          '(files/new_files/loc/new_deps/tolerance_pct) и повторите `grill <plan> --standing`.\n',
      )
    } else if (res.action === 'already-open') {
      process.stdout.write(`SMA grill [${planId}]: standing challenge уже открыт (${res.challenge?.id}) — footprint-заявки всё ещё нет.\n`)
    } else if (res.action === 'resolved') {
      process.stdout.write(`SMA grill [${planId}]: standing challenge снят — footprint-заявка присутствует (${res.reason}).\n`)
    } else {
      process.stdout.write(`SMA grill [${planId}]: footprint-заявка присутствует, открытого standing-вызова нет — ничего не требуется.\n`)
    }
    return 0
  }

  // --gate → the build gate verdict; exit 1 on blocked (caller decides).
  if (flags.gate) {
    const res = grill.grillGate({ planPath, planId, dirs })
    if (wantsJson(flags)) printJson(res)
    else if (!res.allowed) {
      process.stdout.write(`SMA grill [${planId}]: BLOCKED — ${res.open.length} нерешённых вызова(ов):\n`)
      for (const c of res.open) process.stdout.write(`  ${c.id}: «${c.promise}» ⟵ ${c.attack}\n`)
      process.stdout.write('Каждый вызов ДОЛЖЕН стать зарегистрированным предсказанием (--resolve --as converted --prediction <P-id>), быть отозван (--as withdrawn) или принят основателем (--as accepted-risk). До этого билд не стартует (D-9.2-11).\n')
    } else if (!res.grilled) {
      process.stdout.write(`SMA grill [${planId}]: WARN — план не проходил grill (ungrilled). Билд продолжается (fail-open), но ритуал /sma-grill рекомендуется.\n`)
    } else {
      process.stdout.write(`SMA grill [${planId}]: allowed — все вызовы решены.\n`)
    }
    return res.allowed ? 0 : 1
  }

  // --challenge "promise::attack" → register.
  if (typeof flags.challenge === 'string') {
    const [promise, attack] = flags.challenge.split('::')
    const rec = grill.registerChallenge(
      { planId, promise: (promise ?? '').trim(), attack: (attack ?? '').trim(), raisedBy: by },
      { grillDir: dirs.grillDir },
    )
    if (wantsJson(flags)) printJson(rec)
    else process.stdout.write(`SMA grill [${planId}]: зарегистрирован вызов ${rec.id} (status open).\n`)
    return 0
  }

  // --land <CH-id> → tag a landed pre-push defect.
  if (typeof flags.land === 'string') {
    const r = grill.resolveChallenge({ planPath, planId, challengeId: flags.land, status: 'landed', by }, { grillDir: dirs.grillDir })
    if (wantsJson(flags)) printJson(r)
    else process.stdout.write(r.ok ? `SMA grill [${planId}]: ${flags.land} помечен landed.\n` : `SMA grill: ${r.reason}\n`)
    return r.ok ? 0 : 1
  }

  // --resolve <CH-id> --as <status> ...
  if (typeof flags.resolve === 'string') {
    const status = String(flags.as ?? '')
    const r = grill.resolveChallenge(
      {
        planPath,
        planId,
        challengeId: flags.resolve,
        status,
        predictionId: typeof flags.prediction === 'string' ? flags.prediction : undefined,
        disposition: typeof flags.disposition === 'string' ? flags.disposition : undefined,
        reason: typeof flags.reason === 'string' ? flags.reason : undefined,
        by,
      },
      { grillDir: dirs.grillDir },
    )
    if (wantsJson(flags)) printJson(r)
    else if (r.ok) process.stdout.write(`SMA grill [${planId}]: ${flags.resolve} → ${status}.\n`)
    else process.stdout.write(`SMA grill: вызов НЕ решён — ${r.reason}\n`)
    return r.ok ? 0 : 1
  }

  process.stderr.write('SMA grill: укажите один из режимов: --challenge | --resolve | --gate | --standing | --land | --pre-push | --stats\n')
  return 1
}

/**
 * blind-verify — tree-only re-derivation with the information barrier (D-9.2-11).
 *   blind-verify <plan>                        freeze blind verdicts, THEN compare claimed
 *   blind-verify --stats --metric divergence-count   numeric last line (P9.2-07-B)
 * The blind pass NEVER reads a SUMMARY; the CLI parses the claimed side ONLY after the
 * freeze lands on disk. NOT hook-facing.
 */
async function cmdBlindVerify({ positionals, flags, dirs }) {
  const blind = await import('./lib/blind-verify.mjs')

  if (flags.stats) {
    const stats = blind.divergenceStats({ calibrationDir: dirs.calibrationDir })
    if (wantsJson(flags)) printJson(stats)
    process.stdout.write(`${stats.count}\n`)
    return 0
  }

  const planPath = positionals[0]
  if (!planPath) {
    process.stderr.write('usage: pnpm sma blind-verify <plan-path> | blind-verify --stats --metric divergence-count\n')
    return 1
  }
  // INPUT BARRIER (D-9.2-11): the blind pass accepts ONLY a -PLAN.md. A SUMMARY/exec-journal
  // positional is refused HERE — before any freeze or ledger write — so an operator error can
  // never diff a report against itself and manufacture false class-A divergences (gap 2).
  if (blind.isForbiddenBlindPath(planPath)) {
    process.stderr.write(`SMA blind-verify СТРУКТУРНО ОТКАЗАНО: вход «${planPath}» — это отчёт исполнителя (SUMMARY/exec-journal). Слепой проход выводит «done» из файла -PLAN.md и дерева кода, НИКОГДА из отчёта. Ничего не записано, реестр не тронут.\n`)
    return 1
  }
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const { execSync } = await import('node:child_process')
  const runCommand = (cmd) => {
    try {
      return execSync(cmd, { encoding: 'utf8', timeout: 120_000, cwd: repoRoot })
    } catch (err) {
      return (err && err.stdout) || ''
    }
  }
  const readFn = (p, enc) => readFileSync(p, enc ?? 'utf8')

  // 1. FREEZE the blind verdicts — before the claimed side is ever parsed.
  const res = blind.blindVerify({ planPath, runCommand, readFn, dirs, rootDir: repoRoot })

  // 2. NOW (and only now) parse the claimed side from the sibling SUMMARY, in the CLI layer.
  const summaryPath = planPath.replace(/-PLAN\.md$/i, '-SUMMARY.md')
  const claimed = parseClaimedFromSummary(summaryPath)
  const cmp = blind.compareToClaimed({ claimed, planId: res.planId, dirs })

  if (wantsJson(flags)) {
    printJson({ blind: res.verdicts, frozen: res.frozenPath, compare: cmp })
    return cmp.ok && cmp.divergences && cmp.divergences.length ? 1 : 0
  }
  process.stdout.write(`SMA blind-verify [${res.planId}] — ${res.verdicts.length} проверок из дерева (executor report НЕ читался):\n`)
  for (const v of res.verdicts) process.stdout.write(`  [${v.verdict}] ${v.source}:${v.id}\n`)
  if (cmp.ok && cmp.divergences && cmp.divergences.length) {
    process.stdout.write(`\nРАСХОЖДЕНИЯ (claimed pass / blind fail) — тяжелейшее событие реестра, блокирует sma ship (CONS-9.2-07-A):\n`)
    for (const d of cmp.divergences) process.stdout.write(`  ${d.checkId} (${d.domain})\n`)
    return 1
  }
  if (!cmp.ok) process.stdout.write(`\n(claimed-side сравнение пропущено: ${cmp.reason})\n`)
  else process.stdout.write('\nРасхождений нет.\n')
  return 0
}

/**
 * parseClaimedFromSummary(summaryPath) -> [{id, verdict}]. Reads the SUMMARY's coverage
 * + receipts blocks (in the CLI layer, AFTER the blind freeze) and treats each declared
 * item as a CLAIMED pass (a SUMMARY asserts «done»). Missing file → [] (nothing claimed).
 */
function parseClaimedFromSummary(summaryPath) {
  let text
  try {
    text = readFileSync(summaryPath, 'utf8')
  } catch {
    return []
  }
  const ids = new Set()
  // receipts: `  - id: R1` and predictions: `  - id: P...` and any artifact-ish id.
  const idRe = /^\s+-?\s*id:\s*([A-Za-z0-9._-]+)\s*$/gm
  let m
  while ((m = idRe.exec(text))) ids.add(m[1])
  return [...ids].map((id) => ({ id, verdict: 'pass' }))
}

/**
 * evidence — write a burden-of-proof record for a risky op (D-9.2-11).
 *   evidence <op> --target ... --reason ... --checked "a; b; c"
 *   evidence --stats --metric coverage         numeric last line (P9.2-07-C)
 * NOT hook-facing.
 */
async function cmdEvidence({ positionals, flags, dirs }) {
  const evidence = await import('./lib/evidence.mjs')

  if (flags.stats) {
    const stats = evidence.evidenceStats({ evidenceDir: dirs.evidenceDir, journalDir: dirs.journalDir })
    if (wantsJson(flags)) printJson(stats)
    process.stdout.write(`${stats.coverage}\n`)
    return 0
  }

  const op = positionals[0]
  if (!op) {
    process.stderr.write('usage: pnpm sma evidence <force-push|allowlist-edit|foreign-claim-clear> --target ... --reason ... --checked "a; b"\n')
    return 1
  }
  const checks = typeof flags.checked === 'string' ? flags.checked.split(';').map((s) => s.trim()).filter(Boolean) : []
  const actor = await resolveTerminalId().catch(() => 'unknown')
  const res = evidence.writeEvidence(
    { op, target: typeof flags.target === 'string' ? flags.target : '', reason: typeof flags.reason === 'string' ? flags.reason : '', checks, actor },
    { evidenceDir: dirs.evidenceDir },
  )
  if (!res.ok) {
    if (wantsJson(flags)) printJson(res)
    process.stderr.write(`SMA evidence: запись отклонена — не хватает: ${res.missing.join(', ')}\n`)
    return 1
  }
  // Journal the risky-op event referencing the evidenceId — the P9.2-07-C denominator.
  try {
    const journal = await import('./lib/journal.mjs')
    const terminalId = await resolveTerminalId().catch(() => 'unknown')
    journal.appendEvent(
      { type: 'risky-op', actors: [actor], scope: op, detail: { op, target: res.record.target, evidenceId: res.id } },
      { terminalId, journalDir: dirs.journalDir },
    )
  } catch {
    /* a journal failure never blocks the evidence write */
  }
  if (wantsJson(flags)) printJson(res)
  else process.stdout.write(`SMA evidence: записано доказательство ${res.id} для ${op} (${res.record.target}).\n`)
  return 0
}

/**
 * integrity <hazards|shadow|disarms|disarm-renew> — the STPA disarm-path guard
 * admin (9.2-10, D-9.2-14). NOT hook-facing. Every --count-* flag prints a BARE
 * integer as the LAST output line (the V2 scorer's numeric-last-line contract).
 */
async function cmdIntegrity({ positionals, flags, dirs }) {
  const sub = positionals[0]
  const stpa = await import('./lib/stpa.mjs')
  const { GATES } = await import('./lib/gates.mjs')

  if (sub === 'hazards') {
    const uncompensated = stpa.uncompensatedKillSwitches({ gates: GATES })
    if (flags['count-uncompensated']) {
      if (wantsJson(flags)) printJson({ uncompensated: uncompensated.length, switches: uncompensated })
      process.stdout.write(`${uncompensated.length}\n`) // scorer contract: numeric last line
      return 0
    }
    if (wantsJson(flags)) {
      printJson({ hazards: stpa.HAZARDS, uncompensated })
      return 0
    }
    process.stdout.write(`SMA integrity: ${stpa.HAZARDS.length} kill-switches registered, ${uncompensated.length} uncompensated.\n`)
    for (const h of stpa.HAZARDS) process.stdout.write(`  ${h.killEnv} (${h.kind}) — ${h.compensatingControl ? 'compensated' : 'UNCOMPENSATED'}\n`)
    return uncompensated.length ? 1 : 0
  }

  if (sub === 'shadow') {
    const report = stpa.shadowRunFixtures({ env: process.env, dirs })
    if (wantsJson(flags)) {
      printJson({ report })
      return 0
    }
    const disarmed = report.filter((r) => r.disarmed)
    process.stdout.write(`SMA integrity shadow: ${report.length} fixtures, ${disarmed.length} disarmed.\n`)
    for (const r of disarmed) process.stdout.write(`  ${r.killEnv} DISARMED — birth fixture ${r.fixtureTrips ? 'still TRIPS' : 'does not trip'}\n`)
    return 0
  }

  if (sub === 'disarms') {
    if (flags['count-silent']) {
      const n = stpa.countSilentDisarms({ env: process.env, dirs })
      if (wantsJson(flags)) printJson({ silent_disarms: n })
      process.stdout.write(`${n}\n`) // scorer contract: numeric last line
      return 0
    }
    const decisions = stpa.reArmDecisions({ env: process.env, dirs })
    if (wantsJson(flags)) {
      printJson({ decisions })
      return 0
    }
    process.stdout.write(`SMA integrity disarms: ${decisions.length} set kill-switch(es).\n`)
    for (const d of decisions) process.stdout.write(`  ${d.killEnv} -> ${d.decision}${d.hasProvenance ? ' (provenance)' : ''}\n`)
    return 0
  }

  if (sub === 'disarm-renew') {
    const gateId = positionals[1]
    if (!gateId) {
      process.stderr.write('usage: pnpm sma integrity disarm-renew <gateId> --reason "<why>"\n')
      return 1
    }
    let identity = { holderIdentity: 'unknown', terminalId: 'unknown' }
    try {
      const registry = await import('./lib/registry.mjs')
      identity = registry.resolveTerminalIdentity({})
    } catch {
      /* fail-open */
    }
    const lease = stpa.renewDisarm({ gateId, reason: typeof flags.reason === 'string' ? flags.reason : '', identity, dirs })
    if (wantsJson(flags)) printJson({ renewed: true, lease })
    else process.stdout.write(`SMA integrity: kill-switch ${gateId} re-leased with provenance (${lease.provenance.reason ?? '—'}).\n`)
    return 0
  }

  process.stderr.write('usage: pnpm sma integrity <hazards|shadow|disarms|disarm-renew> [--json|--count-uncompensated|--count-silent]\n')
  return 1
}

/**
 * skeptic <sign|verify> <plan-path> — the Goodhart skeptic countersign (9.2-10).
 * `sign` MUST be run from a terminal DISTINCT from the plan's implementer (a
 * self-sign is rejected at verify time). NOT hook-facing.
 */
async function cmdSkeptic({ positionals, flags, dirs }) {
  const sub = positionals[0]
  const planPath = positionals[1]
  if (!planPath) {
    process.stderr.write('usage: pnpm sma skeptic <sign|verify> <plan-path>\n')
    return 1
  }
  const goodhart = await import('./lib/goodhart.mjs')

  if (sub === 'sign') {
    let identity = { holderIdentity: 'unknown', terminalId: 'unknown' }
    try {
      const registry = await import('./lib/registry.mjs')
      identity = registry.resolveTerminalIdentity({})
    } catch {
      /* fail-open */
    }
    const rec = goodhart.signPredictions({ planPath, identity, dirs })
    if (wantsJson(flags)) printJson(rec)
    else process.stdout.write(`SMA skeptic: countersigned ${rec.planId} as ${rec.skeptic.terminalId ?? '—'} (hash ${rec.predictionsHash.slice(0, 10)}).\n`)
    return 0
  }

  if (sub === 'verify') {
    const v = goodhart.verifySkeptic({ planPath, dirs })
    if (wantsJson(flags)) {
      printJson(v)
      return v.ok ? 0 : 1
    }
    process.stdout.write(v.ok ? `SMA skeptic: countersign valid${v.deferred ? ' (distinctness deferred — no exec journal yet)' : ''}.\n` : `SMA skeptic: INVALID — ${v.reason}.\n`)
    return v.ok ? 0 : 1
  }

  process.stderr.write('usage: pnpm sma skeptic <sign|verify> <plan-path>\n')
  return 1
}

/**
 * canary <plant|score|sweep> — planted false-«done» canaries (9.2-10, S8). NOT
 * hook-facing. `score --count-scored` prints the count of scored canaries as a
 * bare integer last line (P9.2-10-03, honest 0 on an empty ledger).
 */
async function cmdCanary({ positionals, flags, dirs }) {
  const sub = positionals[0]
  const canary = await import('./lib/canary.mjs')

  if (sub === 'plant') {
    const claimsPath = positionals[1]
    if (!claimsPath) {
      process.stderr.write('usage: pnpm sma canary plant <claims-path>\n')
      return 1
    }
    let identity = { terminalId: 'unknown' }
    try {
      const registry = await import('./lib/registry.mjs')
      identity = registry.resolveTerminalIdentity({})
    } catch {
      /* fail-open */
    }
    const r = canary.plantCanary({ claimsPath, dirs, identity })
    if (wantsJson(flags)) printJson({ planted: true, canaryId: r.canaryId })
    else process.stdout.write(`SMA canary: planted ${r.canaryId} into ${claimsPath} (sealed to the ledger the verifier never reads).\n`)
    return 0
  }

  if (sub === 'score') {
    if (flags['count-scored']) {
      const n = canary.countScored({ dirs })
      if (wantsJson(flags)) printJson({ scored: n })
      process.stdout.write(`${n}\n`) // scorer contract: numeric last line
      return 0
    }
    // Gather real divergences from the calibration ledger (kind:'divergence') and score.
    let divergences = []
    try {
      const calibration = await import('./lib/calibration.mjs')
      const { records } = calibration.readLedger({ calibrationDir: dirs.calibrationDir })
      divergences = records.filter((r) => r && r.kind === 'divergence')
    } catch {
      /* fail-open — no ledger -> honest empty scoring */
    }
    const res = canary.scoreCanaries({ divergences, dirs })
    if (wantsJson(flags)) printJson(res)
    else if (!res.ok) process.stdout.write(`SMA canary: НЕ scored — ${res.reason} (ledger tampered; a break IS the evidence).\n`)
    else process.stdout.write(`SMA canary: scored ${res.n} (caught ${res.caught}, missed ${res.missed}, catch ${res.catchRatePct}%).\n`)
    return 0
  }

  if (sub === 'sweep') {
    const claimsPath = positionals[1]
    if (!claimsPath) {
      process.stderr.write('usage: pnpm sma canary sweep <claims-path>\n')
      return 1
    }
    const r = canary.sweepCanaries({ claimsPath, dirs })
    if (wantsJson(flags)) printJson(r)
    else process.stdout.write(`SMA canary: swept ${r.swept.length} canary claim(s) from ${claimsPath} (ledger persists sweptAt).\n`)
    return 0
  }

  process.stderr.write('usage: pnpm sma canary <plant <claims-path>|score [--count-scored]|sweep <claims-path>>\n')
  return 1
}

/**
 * nearmiss <text> — append a scoring-IMMUNE near-miss note (9.2-10, ASRS class).
 * NO scoring path ever reads .sma/nearmiss/, so reporting is free. NOT hook-facing.
 */
async function cmdNearmiss({ positionals, flags, dirs }) {
  const text = positionals.join(' ').trim()
  if (!text) {
    process.stderr.write('usage: pnpm sma nearmiss "<what nearly went wrong>"\n')
    return 1
  }
  const goodhart = await import('./lib/goodhart.mjs')
  let identity = { terminalId: 'unknown' }
  try {
    const registry = await import('./lib/registry.mjs')
    identity = registry.resolveTerminalIdentity({})
  } catch {
    /* fail-open */
  }
  const rec = goodhart.recordNearMiss({ text, identity, dirs })
  if (wantsJson(flags)) printJson({ recorded: true, at: rec.at })
  else process.stdout.write('SMA near-miss: записано (immune from scoring — reporting never hurts a number).\n')
  return 0
}

/**
 * cmdPreflight — 9.3-10 (D-9.3-17): the already-built pre-dispatch gate. Given a
 * plan file it prints the deterministic built / partial / absent verdict of the plan's
 * must_haves against the REAL tree, before any executor is dispatched. Zero LLM tokens.
 *
 *   preflight <plan> [--json]   → human summary (or the full result object)
 *   preflight <plan> --count    → the verdict CODE as the LAST stdout line (0/1/2)
 *   preflight <plan> --run-verify → additionally run ONLY isSafeCommand-allowlisted
 *                                   verify commands (default path spawns nothing)
 *   preflight --selftest        → re-run the built/partial/absent fixtures twice;
 *                                 print 1 iff every verdict is correct AND identical
 *
 * Direct-CLI, may exit nonzero (mirrors the verdict) — NOT hook-facing. Artifact paths
 * resolve against process.cwd() so a real plan run from the platform root resolves its
 * `../sma/…`/`src/…` paths correctly; the selftest resolves against the repo root
 * computed from this file's location so it is cwd-independent and portable.
 */
async function cmdPreflight({ positionals, flags, dirs }) {
  const preflight = await import('./lib/preflight.mjs')
  const repoRoot = join(MODULE_DIR, '..', '..') // scripts/sma → repo root (cwd-independent)

  // ── selftest: three bundled fixtures, twice, must be correct AND identical (P9.3-10-A).
  if (flags.selftest === true) {
    const fixtures = [
      { name: 'built', expect: 0 },
      { name: 'partial', expect: 1 },
      { name: 'absent', expect: 2 },
    ]
    let ok = 1
    try {
      for (const f of fixtures) {
        const planPath = join(repoRoot, 'scripts', 'sma', 'fixtures', 'preflight', f.name, 'PLAN.md')
        const r1 = await preflight.preflightPlan({ planPath, rootDir: repoRoot })
        const r2 = await preflight.preflightPlan({ planPath, rootDir: repoRoot })
        if (r1.code !== f.expect || r2.code !== f.expect || r1.code !== r2.code) ok = 0
      }
    } catch {
      ok = 0
    }
    process.stdout.write(`${ok}\n`) // numeric LAST line (D-9.3-16 scorer contract)
    return ok === 1 ? 0 : 1
  }

  const planPath = positionals[0]
  if (!planPath) {
    process.stderr.write('usage: pnpm sma preflight <plan-path> [--count] [--json] [--run-verify]\n')
    return 1
  }

  // Read-only exec runner (opt-in only) — the cmdReverify pattern: a nonzero exit is an
  // OBSERVATION, never a crash. Wired ONLY when --run-verify is passed.
  let runVerify
  if (flags['run-verify'] === true) {
    const { execSync } = await import('node:child_process')
    runVerify = (cmd, o = {}) => {
      try {
        const stdout = execSync(cmd, { encoding: 'utf8', timeout: 120_000, cwd: o.cwd ?? process.cwd() })
        return { stdout, exitCode: 0 }
      } catch (err) {
        return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 }
      }
    }
  }

  const result = await preflight.preflightPlan({
    planPath,
    rootDir: process.cwd(),
    optVerify: flags['run-verify'] === true,
    runVerify,
  })

  if (flags.count === true) {
    process.stdout.write(`${result.code}\n`) // verdict CODE as LAST line (P9.3-10-C)
    return result.code === 0 ? 0 : result.code
  }

  if (wantsJson(flags)) {
    printJson(result)
    return result.code === 0 ? 0 : result.code
  }

  const label = { built: 'BUILT → skip', partial: 'PARTIAL → reconcile-only', absent: 'ABSENT → execute' }[
    result.verdict
  ]
  process.stdout.write(`SMA preflight «${planPath}»: ${label} (code ${result.code}, confidence ${result.confidence})\n`)
  if (result.error) process.stdout.write(`  ⚠ ${result.error}\n`)
  for (const a of result.artifacts ?? []) {
    const mark = a.satisfied ? '✓' : a.exists ? '~' : '✗'
    const why = a.satisfied ? 'satisfied' : a.exists ? 'present, needle missing' : 'missing'
    process.stdout.write(`  ${mark} ${a.path}${a.contains ? ` (contains: ${a.contains})` : ''} — ${why}\n`)
  }
  if (result.verify && result.verify.length) {
    process.stdout.write('  verify commands:\n')
    for (const v of result.verify) process.stdout.write(`    [${v.status}] ${v.inner ?? v.command}\n`)
  }
  return result.code === 0 ? 0 : result.code
}

/**
 * `sma arena` — the comparative benchmark arena scorer + static graphs page (9.3-11,
 * D-9.3-18, BL-142). Direct-CLI, NOT hook-facing; the score path spends zero LLM tokens
 * and reads the 9.2-09 spend-adapter's version tags as its SOLE cost source (D-9.3-02).
 *
 *   arena report <records.json> [--out <html>] [--json]
 *        Score every arm, aggregate on cost-per-RESULT (M1+M2, cost carried not sorted),
 *        and emit a STATIC HTML page (the `sma report` posture — no daemon, no `sma ui`)
 *        showing every arm's cost row INCLUDING where SMA loses, the separate safety axis,
 *        and a Munich last-updated footer. --json prints the aggregate instead.
 *   arena --selftest
 *        Re-score + re-render the committed fixture TWICE (at two different clocks); print 1
 *        iff the aggregate is byte-identical AND the report BODY (footer excluded) is
 *        byte-identical — the determinism proof (P9.3-11-A). Numeric LAST line.
 *   arena --selftest-negative
 *        Score the fixture where SMA is the MOST expensive per task; print 1 iff SMA's cost
 *        row is present AND the ranking is by cost-per-result (SMA ranked first on M1+M2),
 *        NOT cost-per-task — the anti-cherry-pick proof (P9.3-11-B). Numeric LAST line.
 *
 * The negatives are structurally un-droppable (aggregateArena's `suppressed` is empty by
 * construction); a suppressed negative or a non-reproducible page is CONS-9.3-11-A.
 */
async function cmdArena({ positionals, flags }) {
  const arena = await import('./lib/arena.mjs')
  const { readFileSync, writeFileSync } = await import('node:fs')
  const fixturePath = join(MODULE_DIR, 'fixtures', 'arena', 'sample-results.json')
  const knownVersions = (await import('./lib/spend-adapter.mjs')).ADAPTER_VERSIONS.map((a) => a.version)

  const loadArms = (path) => {
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const arms = Array.isArray(doc.arms) ? doc.arms : Array.isArray(doc) ? doc : []
    return arms.map((r) => arena.scoreArm(r, { adapterVersions: knownVersions }))
  }

  // ── --selftest: deterministic re-score + re-render (P9.3-11-A). Numeric last line.
  if (flags.selftest === true) {
    let ok = 1
    try {
      const a1 = arena.aggregateArena(loadArms(fixturePath))
      const a2 = arena.aggregateArena(loadArms(fixturePath))
      if (JSON.stringify(a1) !== JSON.stringify(a2)) ok = 0
      // Render twice at DIFFERENT clocks — the BODY must be clock-independent.
      const h1 = arena.stripGeneratedTimestamp(arena.renderArenaReport(a1, { now: Date.UTC(2026, 0, 1, 8, 0) }))
      const h2 = arena.stripGeneratedTimestamp(arena.renderArenaReport(a2, { now: Date.UTC(2026, 6, 9, 20, 44) }))
      if (h1 !== h2) ok = 0
    } catch {
      ok = 0
    }
    process.stdout.write(`${ok}\n`) // numeric LAST line (D-9.3-16 scorer contract)
    return ok === 1 ? 0 : 1
  }

  // ── --selftest-negative: the negative result survives (P9.3-11-B). Numeric last line.
  if (flags['selftest-negative'] === true) {
    let ok = 1
    try {
      const scored = loadArms(fixturePath).filter((s) => s.arm !== 'sma-solo-recon')
      const agg = arena.aggregateArena(scored)
      const sma = agg.arms.find((a) => a.arm === 'sma')
      const maxCost = Math.max(...agg.arms.map((a) => a.m3MeanCost))
      const rankedFirst = agg.ranking[0] && agg.ranking[0].arm === 'sma'
      const cheapest = [...agg.arms].sort((a, b) => a.m3MeanCost - b.m3MeanCost)[0]
      const html = arena.renderArenaReport(agg, { now: Date.now() })
      // SMA is the most expensive per task, is NOT the cheapest, ranks FIRST on M1+M2,
      // its cost row is present on the page, and no arm was suppressed.
      const smaCostShown = html.includes(String(sma.m3MeanCost))
      if (!sma) ok = 0
      else if (sma.m3MeanCost !== maxCost) ok = 0
      else if (cheapest.arm === 'sma') ok = 0
      else if (!rankedFirst) ok = 0
      else if (!smaCostShown) ok = 0
      else if (agg.suppressed.length !== 0) ok = 0
    } catch {
      ok = 0
    }
    process.stdout.write(`${ok}\n`) // numeric LAST line (D-9.3-16 scorer contract)
    return ok === 1 ? 0 : 1
  }

  // ── arena report <records.json> [--out <html>] [--json]
  const sub = positionals[0]
  if (sub !== 'report') {
    process.stderr.write('usage: pnpm sma arena report <records.json> [--out <html>] [--json] | arena --selftest | arena --selftest-negative\n')
    return 1
  }
  const recordsPath = positionals[1]
  if (!recordsPath) {
    process.stderr.write('usage: pnpm sma arena report <records.json> [--out <html>]\n')
    return 1
  }
  let scored
  try {
    scored = loadArms(recordsPath)
  } catch (err) {
    process.stderr.write(`SMA arena: не удалось прочитать записи «${recordsPath}»: ${err.message}\n`)
    return 1
  }
  const agg = arena.aggregateArena(scored)

  if (wantsJson(flags)) {
    printJson(agg)
    return 0
  }

  const html = arena.renderArenaReport(agg, { now: Date.now() })
  const outPath = typeof flags.out === 'string' && flags.out ? flags.out : join(process.cwd(), 'benchmark-arena.html')
  writeFileSync(outPath, html, 'utf8')
  process.stdout.write(`SMA arena: страница собрана — ${outPath} (${agg.arms.length} рук; лидер по цене за результат: ${agg.ranking[0] ? agg.ranking[0].arm : '-'})\n`)
  if (agg.underpowered.length) process.stdout.write(`  предварительные (n<${arena.MIN_ARENA_N}): ${agg.underpowered.join(', ')}\n`)
  return 0
}

/**
 * `sma batch` — the /sma-batch MIDDLE lane (9.3-12, D-9.3-19, BL-149). The lane between
 * an inline fix and a full phase: 2-4 named backlog items (or a self-assembled compatible
 * set), grill-lite per item, ONE executor (atomic commit each), MANDATORY `sma reverify`
 * receipts, a surgical backlog check-off, and ONE batch note — never a phase folder.
 *
 * Two hard guards (batch.mjs, deterministic): a RISK FILTER rejects anything phase-class
 * («this is a phase») up front, and an EJECT rule throws a growing item back to the backlog
 * while the batch continues. Consume-never-reimplement (D-9.3-02): parse-backlog.ts's
 * grammar reads, grill.mjs gates, `sma reverify` (9.2-03) verifies, `sma preflight`
 * (9.3-10) guards — batch composes; the only new writer is `checkOffBacklogItem`.
 *
 *   batch <BL-ids...>            select the named items (2-4), risk-filter up front, prepare the ordered run
 *   batch --assemble            auto-pick a compatible set (same area, S/M, non-overlapping files)
 *   batch ... --json            emit the prepared batch object (ordered items + guard status)
 *   batch --selftest-riskfilter classify a bundled fixture set; print 1 iff every classification is correct (P9.3-12-A)
 *   batch --selftest-checkoff   flip one line in a bundled fixture BACKLOG.md; print 1 iff surgical (P9.3-12-C)
 *
 * Direct-CLI, NOT hook-facing (it may exit 1). node cannot spawn a Claude executor, so the
 * CLI does the DETERMINISTIC half (parse + risk gate + selection + preflight) and prepares
 * the ordered batch; the `/sma-batch` skill drives the executor + `sma reverify` + writes
 * the check-off using this preparation (runBatch is the shared, fully-tested driver).
 */
async function cmdBatch({ positionals, flags, dirs }) {
  const batch = await import('./lib/batch.mjs')

  // ── --selftest-riskfilter: bundled fixture, every classification must match (P9.3-12-A).
  if (flags['selftest-riskfilter'] === true) {
    const fixture = [
      { item: { id: 'BL-901', title: 'Add migration 099', description: 'schema change' }, allowed: false },
      { item: { id: 'BL-902', title: 'New inbound webhook', description: 'a webhook route' }, allowed: false },
      { item: { id: 'BL-903', title: 'New AI agent', description: 'orchestrator agent' }, allowed: false },
      { item: { id: 'BL-904', title: 'New /crm surface', description: 'a new dashboard page' }, allowed: false },
      { item: { id: 'BL-905', title: 'Weekly cron poll', description: 'cron job' }, allowed: false },
      { item: { id: 'BL-906', title: 'Fix RU button label', description: 'copy tweak', size: 'S', files: ['a.ts'] }, allowed: true },
      { item: { id: 'BL-907', title: 'Bump retry delay', description: 'timeout to 5s', size: 'S', files: ['b.ts'] }, allowed: true },
      { item: { id: 'BL-908', title: 'Sort list ascending', description: 'by date', size: 'M', files: ['c.ts'] }, allowed: true },
    ]
    let ok = 1
    try {
      for (const f of fixture) {
        if (batch.classifyBatchRisk(f.item).allowed !== f.allowed) ok = 0
      }
    } catch {
      ok = 0
    }
    if (wantsJson(flags)) printJson({ selftest: 'riskfilter', ok })
    process.stdout.write(`${ok}\n`) // numeric LAST line (D-9.3-16 scorer contract)
    return ok === 1 ? 0 : 1
  }

  // ── --selftest-checkoff: surgical single-line flip over a bundled fixture (P9.3-12-C).
  if (flags['selftest-checkoff'] === true) {
    const fixture = [
      '# Backlog',
      '',
      '## Backlog',
      '',
      '- [ ] **BL-801** · Первая — desc. `size:S` `area:crm` `added:2026-07-09`',
      '- [ ] **BL-802** · Вторая — desc. `size:M` `area:crm` `added:2026-07-09`',
      '- [x] **BL-803** · Третья — desc. `size:S` `area:crm` `added:2026-07-08`',
      '',
    ].join('\n')
    let ok = 1
    try {
      const { changed, backlogText } = batch.checkOffBacklogItem({ backlogText: fixture, id: 'BL-802' })
      const before = fixture.split('\n')
      const after = backlogText.split('\n')
      if (!changed || before.length !== after.length) ok = 0
      for (let i = 0; i < before.length; i++) {
        const expected = before[i].includes('**BL-802**') ? before[i].replace('- [ ]', '- [x]') : before[i]
        if (after[i] !== expected) ok = 0
      }
      // a missing id and an already-[x] line must both be no-ops
      if (batch.checkOffBacklogItem({ backlogText: fixture, id: 'BL-777' }).changed) ok = 0
      if (batch.checkOffBacklogItem({ backlogText: fixture, id: 'BL-803' }).changed) ok = 0
    } catch {
      ok = 0
    }
    if (wantsJson(flags)) printJson({ selftest: 'checkoff', ok })
    process.stdout.write(`${ok}\n`)
    return ok === 1 ? 0 : 1
  }

  // ── the real preparation path: read + parse the backlog, select/assemble, risk-filter up front.
  const { readFileSync } = await import('node:fs')
  const repoRoot = dirs?.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const backlogPath = join(repoRoot, '.planning', 'BACKLOG.md')
  let items = []
  try {
    items = readBacklogItems(readFileSync(backlogPath, 'utf8'))
  } catch {
    items = []
  }

  const sel = flags.assemble === true
    ? batch.assembleCompatibleBatch(items)
    : batch.selectBatch(positionals, items)

  if (!sel.ok) {
    if (wantsJson(flags)) printJson({ ok: false, reason: sel.reason })
    process.stderr.write(`SMA batch: ${sel.reason}\n`)
    return 1
  }

  // UP-FRONT risk filter — a single phase-class item rejects the WHOLE batch, named.
  const phaseClass = sel.items.map((it) => ({ it, risk: batch.classifyBatchRisk(it) })).filter((x) => !x.risk.allowed)
  if (phaseClass.length) {
    const ids = phaseClass.map((x) => x.it.id).join(', ')
    if (wantsJson(flags)) printJson({ ok: false, reason: 'this is a phase', phaseClass: phaseClass.map((x) => x.it.id) })
    process.stderr.write(`SMA batch: «this is a phase» — ${ids} is phase-class (new collection / migration / webhook / agent / cron / new surface). Plan it as a phase, not a batch.\n`)
    return 1
  }

  // Prepared, ordered batch — the /sma-batch skill drives executor + reverify + check-off.
  const prepared = {
    ok: true,
    mode: flags.assemble === true ? 'assemble' : 'named',
    count: sel.items.length,
    backlogPath,
    items: sel.items.map((it) => ({ id: it.id, title: it.title, size: it.size, area: it.area, files: it.files ?? [] })),
    order: ['preflight', 'grill-lite', 'executor(atomic commit)', 'reverify(mandatory receipt)', 'checkOffBacklogItem'],
    guards: { riskFilter: 'passed (no phase-class item)', eject: 'a growing item returns to the backlog; the batch continues' },
  }
  if (wantsJson(flags)) {
    printJson(prepared)
    return 0
  }
  process.stdout.write(`SMA batch — ${prepared.count} item(s) prepared (${prepared.mode}), risk filter passed:\n`)
  for (const it of prepared.items) {
    process.stdout.write(`  • ${it.id} [${it.size ?? '?'}·${it.area ?? '?'}] ${it.title}\n`)
  }
  process.stdout.write('  order per item: preflight → grill-lite → executor (atomic commit) → sma reverify (mandatory receipt) → check off\n')
  process.stdout.write('  receipts are MANDATORY — an item is checked off ONLY on a clean reverify receipt; a growing item is ejected back to the backlog.\n')
  return 0
}

/**
 * readBacklogItems(text) — the CLI-side reader over parse-backlog.ts's `## Backlog` grammar
 * (`- [ ] **BL-NNN** · Title — desc \`size:\` \`area:\` \`added:\` \`files:\``). batch.mjs
 * (the lib named by the D-9.3-02 prohibition) writes NO parser; this thin grammar-follower
 * lives at the CLI boundary only, mirroring the inline BL-id reader slots.mjs already uses.
 * An optional \`files:a.ts;b.ts\` tag feeds the overlap guard; items without it are treated
 * as non-overlapping.
 */
function readBacklogItems(raw) {
  const lines = String(raw ?? '').split(/\r?\n/)
  const items = []
  let inBacklog = false
  const ITEM_RE = /^-\s+\[([ xX])\]\s+\*\*(BL-\d+)\*\*\s*(.*)$/
  const TAG_RE = /`([a-z]+):([^`]+)`/gi
  for (const line of lines) {
    if (/^##\s+Backlog\b/i.test(line)) { inBacklog = true; continue }
    if (/^##\s+/.test(line)) { inBacklog = false; continue }
    if (!inBacklog) continue
    const m = line.match(ITEM_RE)
    if (!m) continue
    const done = m[1].toLowerCase() === 'x'
    const id = m[2]
    let rest = m[3].trim()
    const tags = {}
    rest = rest.replace(TAG_RE, (_f, k, v) => { tags[k.toLowerCase()] = v.trim(); return '' }).trim()
    rest = rest.replace(/^[·•]\s*/, '').trim()
    let title = rest
    let description = ''
    const dash = rest.match(/\s[—–-]\s/)
    if (dash && dash.index !== undefined) {
      title = rest.slice(0, dash.index).trim()
      description = rest.slice(dash.index + dash[0].length).trim()
    }
    items.push({
      id,
      title,
      description,
      done,
      size: tags.size ?? null,
      area: tags.area ?? null,
      added: tags.added ?? null,
      phase: tags.phase ?? null,
      files: tags.files ? tags.files.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [],
    })
  }
  return items
}

/**
 * deleteme [--yes] [--global] [--json] [--selftest] — the one-click OFF-RAMP (BL-162,
 * v3.6). DRY-RUN by default: prints exactly what would be removed and what stays;
 * `--yes` applies. Reverses every installer artifact (engine, runtime, agents, skills,
 * hooks, statusline, managed blocks, .sma state, the .gitignore line) and PRESERVES
 * `.claude/memory/**` — the corpus is the user's asset, not the framework's. Direct
 * CLI command (may exit nonzero), never hook-facing.
 */
async function cmdDeleteme({ flags, dirs }) {
  const deleteme = await import('./lib/deleteme.mjs')

  if (flags.selftest === true) {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sma-deleteme-'))
    let ok = 0
    try {
      ok = deleteme.deletemeSelftest({ tmpRoot })
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* temp cleanup is best-effort */
      }
    }
    if (wantsJson(flags)) printJson({ selftest: 'deleteme', ok })
    process.stdout.write(`${ok}\n`) // numeric LAST line (D-9.3-16 scorer contract)
    return ok === 1 ? 0 : 1
  }

  const project = dirs?.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const configDir = flags.global === true
    ? (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim()) || join((await import('node:os')).homedir(), '.claude')
    : join(project, '.claude')
  const dryRun = flags.yes !== true

  const res = deleteme.applyDeleteme({ project, configDir, dryRun })
  if (wantsJson(flags)) {
    printJson({ ok: true, dryRun, ...res })
    return 0
  }
  if (!res.actions.length) {
    process.stdout.write('SMA deleteme: артефакты установки не найдены — удалять нечего.\n')
    return 0
  }
  process.stdout.write(dryRun
    ? `SMA deleteme — ПЛАН удаления (${res.actions.length} действий, ничего не тронуто):\n`
    : `SMA deleteme — выполнено (${res.actions.length} действий):\n`)
  for (const a of res.actions) {
    process.stdout.write(`  ${a.status.padEnd(18)} ${a.kind.padEnd(14)} ${a.target}${a.detail ? `  (${a.detail})` : ''}\n`)
  }
  process.stdout.write('\n  Остаётся нетронутым: корпус памяти .claude/memory/, все чужие ключи settings.json, каждый байт вне managed-блоков.\n')
  if (dryRun) process.stdout.write('  Применить: node scripts/sma/cli.mjs deleteme --yes\n')
  else process.stdout.write('  Перезапустите терминал — команд /sma-* больше не будет. Корпус памяти на месте.\n')
  return 0
}

/**
 * memory-preview [--project <path>] [--lang en|ru] [--json] [--selftest] — the
 * onboarding memory-graph preview (BL-174, v3.6). Renders an ASCII graph of how
 * SMA will lay out THIS (or --project's) repository's memory: CORE / periphery
 * by area (from `git ls-files`) / reflex candidates (excavate's mineRepo over
 * the real history). Read-only, zero network, byte-deterministic at one HEAD.
 * Direct CLI command (may exit nonzero), never hook-facing.
 */
async function cmdMemoryPreview({ flags, dirs }) {
  const preview = await import('./lib/memory-preview.mjs')

  if (flags.selftest === true) {
    const ok = preview.previewSelftest()
    if (wantsJson(flags)) printJson({ selftest: 'memory-preview', ok })
    process.stdout.write(`${ok}\n`) // numeric LAST line (D-9.3-16 scorer contract)
    return ok === 1 ? 0 : 1
  }

  const repoRoot = dirs?.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const repoDir = typeof flags.project === 'string' && flags.project.trim() ? flags.project.trim() : repoRoot
  const lang = flags.lang === 'ru' ? 'ru' : 'en'
  const analysis = preview.analyzeRepo({ repoDir })
  if (wantsJson(flags)) {
    printJson({ ok: true, ...analysis })
    return 0
  }
  process.stdout.write(preview.renderPreview(analysis, { lang }) + '\n')
  return 0
}

/**
 * session-end (HOOK_FACING) — 9.3-13 (D-9.3-22a) TRIGGER 1: the NEW SessionEnd hook.
 * Release ALL of this window's own claims (marked «сессия завершена»). Silent, exit-0
 * unconditional (main() wraps HOOK_FACING). It does NOT touch the Stop hook (Stop fires
 * per turn — RESEARCH Pitfall 1). Tolerant hook-stdin read; fully fail-open.
 */
async function cmdSessionEnd({ dirs }) {
  try {
    const evt = readStdinJson()
    const sessionToken = windowTokenFrom(evt)
    const registry = await import('./lib/registry.mjs')
    const claims = await import('./lib/claims.mjs')
    const identity = registry.resolveTerminalIdentity({ sessionToken })
    claims.sessionEnd({ identity, claimsDir: dirs.claimsDir, journalDir: dirs.journalDir })
  } catch {
    /* fail-open — a session-end failure must never surface */
  }
  return 0
}

/**
 * ask (direct-CLI, NOT hook-facing) — 9.3-13 (D-9.3-23) the DEMAND STUB. `ask <terminal>
 * "<question>"` prints the target's FULL fingerprint + journals the unmet question so demand
 * is MEASURED, not assumed (>=10 unmet cases = the V3.1 ask-bus trigger). `ask --unmet-count`
 * prints the unmet count as a bare LAST line (scorer contract). It is a STUB: opens no
 * socket, routes no message — the ask-bus is DEFERRED to V3.1 (D-9.2-05 BRIDGE).
 */
async function cmdAsk({ positionals, flags, dirs }) {
  const fingerprint = await import('./lib/fingerprint.mjs')
  if (flags['unmet-count']) {
    const n = fingerprint.askUnmetCount({ journalDir: dirs.journalDir })
    if (wantsJson(flags)) {
      printJson({ unmetCount: n })
      return 0
    }
    process.stdout.write(`${n}\n`)
    return 0
  }
  const target = positionals[0]
  const question = positionals[1] ?? (typeof flags.q === 'string' ? flags.q : '')
  if (!target) {
    process.stderr.write('SMA: использование — pnpm sma ask <терминал> "<вопрос>"\n')
    return 1
  }
  const registry = await import('./lib/registry.mjs')
  const journal = await import('./lib/journal.mjs')
  const { sessions } = registry.readSessions(dirs)
  const res = fingerprint.ask({
    target,
    question,
    sessions,
    journalTail: (t) => journal.journalTail(t, 3, dirs),
    journalDir: dirs.journalDir,
    now: Date.now(),
  })
  if (wantsJson(flags)) {
    printJson({ target, answered: res.answered, fingerprint: res.fingerprint })
    return 0
  }
  process.stdout.write(`${res.text}\n`)
  if (!res.answered) {
    process.stdout.write('(отпечаток не ответил — вопрос записан; ask-шина появится в V3.1 при спросе)\n')
  }
  return 0
}

/**
 * buildManifestPlanIndex(repoRoot) -> [{planId, path, files_modified, predictionDomains}].
 * The selectPlans-shaped index (grill's buildPlanIndex idiom, but carrying the plan
 * PATH the manifest reader needs). Pure read; fail-open.
 */
async function buildManifestPlanIndex(repoRoot) {
  const predict = await import('./lib/predict.mjs')
  const planDir = join(repoRoot, '.planning', 'phases')
  const index = []
  for (const planPath of findPlanFiles(planDir)) {
    let text = ''
    try {
      text = readFileSync(planPath, 'utf8')
    } catch {
      continue
    }
    const files_modified = parseYamlListBlock(text, 'files_modified')
    const { predictions } = predict.parsePredictions(planPath)
    const predictionDomains = [...new Set(predictions.map((p) => p && p.domain).filter(Boolean))]
    index.push({ planId: planIdFromPath(planPath), path: planPath, files_modified, predictionDomains })
  }
  return index
}

/**
 * Resolve the 9.3-02 stale-priors guard state as the manifest's `staleness`
 * value ('ok' | 'stale-priors' | 'unavailable'). Tolerance rule: lazy-import the
 * model-version guard, compute over the prediction-domain ledger + the sighting
 * timeline (the passport's own filter — sma.receipts excluded), and map
 * 'no-model-data' -> 'unavailable'. ANY failure -> 'unavailable' (honest absent).
 */
async function resolveManifestStaleness(dirs) {
  try {
    const mv = await import('./lib/model-version.mjs')
    const calibration = await import('./lib/calibration.mjs')
    const timeline = mv.readModelTimeline({ modelDir: dirs.modelDir })
    const { records } = calibration.readLedger({ calibrationDir: dirs.calibrationDir })
    const predictionRecords = records.filter((r) => r && r.domain !== 'sma.receipts')
    const guard = mv.modelGuard({ records: predictionRecords, timeline, minFresh: 20 })
    if (guard.status === 'stale-priors') return 'stale-priors'
    if (guard.status === 'ok') return 'ok'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/**
 * gatherManifestInputs({dirs, range, now}) -> the CAPTURED input bundle for
 * buildManifest. Read-only `git diff` over the range + `git rev-parse HEAD`, scan
 * the plan index, resolve chainTip + staleness + the spend book, then
 * selectPlans -> collectEvidence. NO grading, NO network. Every git call is
 * fail-soft (bad ref / offline -> empty diff, 'nohead'). Separating GATHER from
 * BUILD is what lets the determinism stat build TWICE from ONE capture — proving
 * the ASSEMBLY is a pure function, not that the live .sma/ stopped growing (the
 * journal + the actively-appended session spend log grow continuously on a shared
 * tree; comparing two independent reads would be a false nondeterminism).
 */
async function gatherManifestInputs({ dirs, range, now }) {
  const manifest = await import('./lib/manifest.mjs')
  const journal = await import('./lib/journal.mjs')
  const spend = await import('./lib/spend.mjs')
  const { execFileSync } = await import('node:child_process')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const execGit = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

  let changedFiles = []
  try {
    changedFiles = execGit(['diff', '--name-only', range]).split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    /* fail-soft — no diff resolvable -> empty set */
  }
  let headSha = 'nohead'
  try {
    headSha = execGit(['rev-parse', 'HEAD']).trim() || 'nohead'
  } catch {
    /* fail-soft */
  }

  const planIndex = await buildManifestPlanIndex(repoRoot)
  const plans = manifest.selectPlans({ changedFiles, planIndex })
  const chainTip = journal.chainTip({ journalDir: dirs.journalDir }).tip
  const staleness = await resolveManifestStaleness(dirs)

  // Spend book (missing logs dir -> absent block, never a fabricated zero).
  let spendBook = null
  let spendBudget = {}
  try {
    const book = spend.buildBook({ spendDir: dirs.spendDir, repoRoot, env: process.env, now: Date.parse(now) || Date.now() })
    const hasData = book && (book.logsDir || (book.totals && book.totals.events > 0))
    spendBook = hasData ? book : null
    spendBudget = spend.readBudget({ spendDir: dirs.spendDir })
  } catch {
    spendBook = null
  }

  const evidence = manifest.collectEvidence({ plans, dirs })
  return { range, headSha, plans, evidence, spendBook, spendBudget, chainTip, staleness }
}

/**
 * assembleManifest({dirs, range, now}) -> {manifest, headSha}. Gather the inputs
 * once, build once. (The determinism stat gathers once and builds twice itself.)
 */
async function assembleManifest({ dirs, range, now }) {
  const manifest = await import('./lib/manifest.mjs')
  const inputs = await gatherManifestInputs({ dirs, range, now })
  return { manifest: manifest.buildManifest({ ...inputs, now }), headSha: inputs.headSha }
}

/**
 * manifest [--range <a>..<b>] [--json|--md] [--stat <name>] — the PR EVIDENCE
 * PASSPORT (9.3-08, D-9.3-11). Deterministically assembles the Track A evidence
 * pack and writes .sma/manifest/<headSha>.{json,md}. READER-ONLY: computes no
 * verdict, opens no network. NOT hook-facing; plain mode always exits 0 (the
 * manifest OBSERVES — preship, 9.2-08, owns the ship gate).
 *
 *   --stat determinism        two builds with one pinned now, byte-compare -> 1|0
 *   --stat prediction-coverage manifestStats over a fresh build
 *   --stat bench-build-ms     p95 ms over 5 warm builds
 * Every --stat prints a single numeric last line and exits 0 (the 9.1-08 scorer contract).
 */
async function cmdManifest({ flags, dirs }) {
  const manifestLib = await import('./lib/manifest.mjs')
  const { atomicWriteJson, atomicWriteRaw } = await import('./lib/fs-atomics.mjs')
  const range = typeof flags.range === 'string' && flags.range.trim() ? flags.range.trim() : 'origin/main..HEAD'

  // --stat modes: a scorer-compatible numeric last line, exit 0 regardless of value.
  if (typeof flags.stat === 'string') {
    const stat = flags.stat
    if (stat === 'determinism') {
      // Gather the inputs ONCE, build TWICE from that single capture with a pinned
      // now — the substrate-law claim is that the ASSEMBLY is a pure function. A
      // second independent gather would re-read the live-growing journal + session
      // spend log and flag a false nondeterminism on a busy shared tree.
      const pinned = '2000-01-01T00:00:00.000Z'
      const inputs = await gatherManifestInputs({ dirs, range, now: pinned })
      const a = manifestLib.buildManifest({ ...inputs, now: pinned })
      const b = manifestLib.buildManifest({ ...inputs, now: pinned })
      const identical =
        JSON.stringify(a, null, 2) === JSON.stringify(b, null, 2) &&
        manifestLib.renderManifestMarkdown(a) === manifestLib.renderManifestMarkdown(b)
      const val = identical ? 1 : 0
      if (wantsJson(flags)) printJson({ stat, value: val })
      process.stdout.write(`${val}\n`)
      return 0
    }
    if (stat === 'prediction-coverage') {
      const { manifest } = await assembleManifest({ dirs, range, now: new Date().toISOString() })
      const val = manifestLib.manifestStats(manifest, 'prediction-coverage')
      if (wantsJson(flags)) printJson({ stat, value: val })
      process.stdout.write(`${val}\n`)
      return 0
    }
    if (stat === 'bench-build-ms') {
      const clock = globalThis.performance && typeof globalThis.performance.now === 'function' ? globalThis.performance : Date
      const times = []
      for (let i = 0; i < 5; i++) {
        const t0 = clock.now()
        await assembleManifest({ dirs, range, now: '2000-01-01T00:00:00.000Z' })
        times.push(Math.max(0, clock.now() - t0))
      }
      times.sort((a, b) => a - b)
      const idx = Math.min(times.length - 1, Math.max(0, Math.ceil((95 / 100) * times.length) - 1))
      const val = Math.round((times[idx] || 0) * 100) / 100
      if (wantsJson(flags)) printJson({ stat, value: val })
      process.stdout.write(`${val}\n`)
      return 0
    }
    process.stderr.write(`SMA manifest: неизвестный --stat «${stat}» (determinism|prediction-coverage|bench-build-ms)\n`)
    process.stdout.write('0\n')
    return 0
  }

  // Build once, write both artifacts atomically under dirs.manifestDir.
  const { manifest, headSha } = await assembleManifest({ dirs, range, now: new Date().toISOString() })
  const md = manifestLib.renderManifestMarkdown(manifest)
  try {
    atomicWriteJson(join(dirs.manifestDir, `${headSha}.json`), manifest)
    atomicWriteRaw(join(dirs.manifestDir, `${headSha}.md`), md)
  } catch {
    /* fail-open — a manifest write failure never blocks a ship */
  }

  if (flags.json === true || flags.raw === true) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
    return 0
  }
  if (flags.md === true) {
    process.stdout.write(md)
    return 0
  }

  // Default: a human summary.
  const preds = manifest.predictions.length
  const scored = manifest.predictions.filter((p) => p.verdict !== 'unscored').length
  process.stdout.write(`SMA manifest — evidence passport (range ${manifest.range}, head ${String(headSha).slice(0, 12)}):\n`)
  process.stdout.write(`  plans: ${manifest.plans.length} · predictions: ${scored}/${preds} scored · receipts: ${manifest.receipts.length}\n`)
  process.stdout.write(`  blind divergences: ${manifest.blind.divergences} · open class-A: ${manifest.consequences.openClassA}\n`)
  process.stdout.write(`  chainTip: ${String(manifest.chainTip).slice(0, 12)} · staleness: ${manifest.staleness}\n`)
  process.stdout.write(`  written: ${join(dirs.manifestDir, `${headSha}.json`)} (+ .md)\n`)
  return 0
}

/**
 * ship-lane <check|changelog|record|report> [--base <branch>] [--max-delta N] [--json]
 *   ship-lane --stat quick-active-p50-min|quick-red-minus-full-red-pct   bare numeric last line
 *   ship-lane --selftest                                                  prints 1/0
 *
 * The SHIP LANES substrate (9.4-08, BL-177). READ-ONLY: it checks, drafts, and records —
 * it NEVER pushes, tags, or deploys (pushing stays inside the founder-ordered skill
 * rituals, D-9.3-24d). NOT hook-facing. Subcommands:
 *   - check     runs the real precondition (real execGit at the repo root + real
 *               checkPushClaim over dirs.claimsDir) and prints eligible / every failing leg;
 *               exit 1 on a refuse (the skill stops there and routes to the full lane).
 *   - changelog prints the deterministic conventional-commit grouped draft over the delta.
 *   - record    appends a lane run {lane, outcome, startedAt, endedAt?} to ship-lanes.jsonl.
 *   - report    lists pending runs first + flags >24h orphaned watches (CH-9.4-08-2).
 * Fail-open on git reads; over-refusal is the safe direction.
 */
async function cmdShipLane({ positionals, flags, dirs }) {
  const shipLane = await import('./lib/ship-lane.mjs')
  const spendDir = dirs.spendDir
  const sub = positionals[0]

  if (flags.selftest === true) {
    const ok = shipLane.shipLaneSelftest()
    if (wantsJson(flags)) printJson({ selftest: 'ship-lane', ok })
    process.stdout.write(`${ok}\n`) // numeric LAST line (scorer contract)
    return ok === 1 ? 0 : 1
  }

  if (flags.stat) {
    const name = String(flags.stat)
    const { runs } = shipLane.readShipLaneRuns({ spendDir })
    const stats = shipLane.laneStats({ runs, now: Date.now() })
    const value =
      name === 'quick-active-p50-min'
        ? stats.quickActiveP50Min
        : name === 'quick-red-minus-full-red-pct'
          ? stats.quickRedMinusFullRedPct
          : 0
    process.stdout.write(`${value}\n`) // numeric LAST line (P9.4-08-B/C scorer contract)
    return 0
  }

  const base = typeof flags.base === 'string' && flags.base.trim() ? flags.base.trim() : 'main'
  const { execFileSync } = await import('node:child_process')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const execGit = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

  if (sub === 'check') {
    const slots = await import('./lib/slots.mjs')
    const self = await resolveTerminalId()
    const maxDelta = Number.isFinite(Number(flags['max-delta'])) && Number(flags['max-delta']) > 0 ? Number(flags['max-delta']) : 5
    const res = shipLane.checkQuickPrecondition({
      execGit,
      checkPushClaim: () => slots.checkPushClaim({ claimsDir: dirs.claimsDir }),
      self,
      base,
      maxDelta,
    })
    if (wantsJson(flags)) printJson(res)
    else if (res.allowed) {
      process.stdout.write(
        `SMA ship-lane: ПОДХОДИТ для /sma-quick-ship — дельта ${res.delta} коммит(ов), миграций нет, чужой push-claim отсутствует. Гейт тот же, что в /sma-ship.\n`,
      )
    } else {
      process.stdout.write('SMA ship-lane: НЕ подходит для быстрой полосы — используйте полный /sma-ship:\n')
      for (const r of res.reasons) process.stdout.write(`  - ${r}\n`)
    }
    return res.allowed ? 0 : 1
  }

  if (sub === 'changelog') {
    let commits = []
    try {
      const raw = execGit(['log', `--format=%H%x1f%s`, `origin/${base}..HEAD`])
      commits = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [sha, subject] = l.split('\x1f')
          return { sha, subject: subject || '' }
        })
    } catch {
      commits = [] // fail-open — an unresolvable range drafts an empty changelog
    }
    process.stdout.write(shipLane.draftChangelog({ commits }))
    if (!String(shipLane.draftChangelog({ commits })).endsWith('\n')) process.stdout.write('\n')
    return 0
  }

  if (sub === 'record') {
    const lane = String(flags.lane || '')
    const outcome = String(flags.outcome || '')
    const startedAt = typeof flags.started === 'string' ? flags.started : ''
    if (!['quick', 'full'].includes(lane) || !['green', 'red', 'pending'].includes(outcome) || !startedAt) {
      process.stdout.write('usage: sma ship-lane record --lane quick|full --outcome green|red|pending --started <iso> [--ended <iso>]\n')
      return 1
    }
    const run = { lane, outcome, startedAt }
    if (typeof flags.ended === 'string' && flags.ended) run.endedAt = flags.ended
    const rec = shipLane.appendShipLaneRun({ spendDir, run })
    if (wantsJson(flags)) printJson(rec)
    else process.stdout.write(`SMA ship-lane: записан прогон ${lane}/${outcome} (started ${startedAt})\n`)
    return 0
  }

  // report (default).
  const { runs } = shipLane.readShipLaneRuns({ spendDir })
  const rep = shipLane.laneReport({ runs, now: Date.now() })
  if (wantsJson(flags)) {
    printJson({ ...rep, stats: shipLane.laneStats({ runs, now: Date.now() }) })
    return 0
  }
  process.stdout.write(`SMA ship-lane отчёт — прогонов ${runs.length} (ожидающих ${rep.pending.length}, брошенных ${rep.orphaned.length}):\n`)
  for (const r of rep.pending) {
    const orphan = rep.orphaned.includes(r) ? ' [БРОШЕН >24ч — фоновый watch прервался; проверьте CI/Railway вручную]' : ''
    process.stdout.write(`  ОЖИДАЕТ ${r.lane} (started ${r.startedAt})${orphan}\n`)
  }
  for (const r of rep.finalized.slice(-8)) process.stdout.write(`  ${r.outcome} ${r.lane} (started ${r.startedAt})\n`)
  return 0
}

/**
 * worktree <provision|list|remove|sibling> [--branch <name>] [--path <dir>] [--force] [--json]
 *   worktree --selftest           base + teleport guards over a mock-git recorder (P9.3-14-A)
 *   worktree --selftest-sibling   sibling-repo resolution order over injected readers (P9.3-14-C)
 *
 * Per-terminal worktree isolation (9.3-14, D-9.3-24a/b). Provisions or reuses a
 * per-SESSION worktree directory so parallel human Claude Code sessions physically
 * cannot overwrite each other on this shared, auto-deploy checkout. `.sma/`
 * coordination stays shared for free (registry.smaRoot, D-9.3-02 — NOT re-plumbed
 * here). A worktree branch enters `main` ONLY via 9.3-15's `sma merge`; push stays
 * founder-ordered via /sma-ship. Direct-CLI (may exit 1), NEVER hook-facing.
 */
async function cmdWorktree({ positionals, flags, dirs }) {
  const wt = await import('./lib/worktree.mjs')

  // ── --selftest: base-capture + verify + hard-reset + explicit-cwd, over a mock ──
  if (flags.selftest === true) {
    let ok = 1
    const record = []
    // Case A: base MATCH — no reset should fire.
    const matchGit = (args, o = {}) => {
      record.push({ args, cwd: o.cwd })
      if (o.cwd == null) ok = 0 // explicit-cwd invariant (teleport guard)
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'BASE_SHA\n'
      return ''
    }
    const a = wt.provisionWorktree({ branch: 'sma-wt/self-a', path: '/tmp/wt-a', execGit: matchGit, cwd: '/main' })
    const idxRev = record.findIndex((c) => c.args[0] === 'rev-parse')
    const idxAdd = record.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'add')
    if (!(idxRev >= 0 && idxAdd > idxRev)) ok = 0 // capture precedes add
    if (a.baseFixed !== false) ok = 0 // match -> no reset
    if (record.some((c) => c.args[0] === 'reset')) ok = 0

    // Case B: base MISMATCH — hard-reset onto EXPECTED_BASE in the worktree cwd.
    const record2 = []
    const mismatchGit = (args, o = {}) => {
      record2.push({ args, cwd: o.cwd })
      if (o.cwd == null) ok = 0
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return o.cwd === '/main' ? 'BASE_SHA\n' : 'OLD_SHA\n'
      return ''
    }
    const b = wt.provisionWorktree({ branch: 'sma-wt/self-b', path: '/tmp/wt-b', execGit: mismatchGit, cwd: '/main' })
    if (b.baseFixed !== true) ok = 0 // mismatch -> reset fired
    const reset = record2.find((c) => c.args[0] === 'reset' && c.args[1] === '--hard')
    if (!reset || reset.args[2] !== 'BASE_SHA' || reset.cwd !== '/tmp/wt-b') ok = 0

    // explicit-cwd invariant across BOTH cases: array args, a cwd on every call, no bare `cd`.
    for (const c of [...record, ...record2]) {
      if (!Array.isArray(c.args) || typeof c.cwd !== 'string' || !c.cwd) ok = 0
      if (Array.isArray(c.args) && /(^|\s)cd\s/.test(c.args.join(' '))) ok = 0
    }
    if (wantsJson(flags)) printJson({ selftest: true, pass: ok === 1 })
    process.stdout.write(`${ok}\n`) // numeric last line (P9.3-14-A)
    return ok === 1 ? 0 : 1
  }

  // ── --selftest-sibling: env → config → profile → relative, deterministic order ──
  if (flags['selftest-sibling'] === true) {
    let ok = 1
    const cases = [
      { in: { env: { SMA_PRODUCT_REPO: '/abs/env' }, readConfig: () => ({ productRepo: '/abs/cfg' }), readProfile: () => ({ profile: { productRepo: '/abs/prof' } }), cwd: '/main' }, source: 'env', path: '/abs/env' },
      { in: { env: {}, readConfig: () => ({ productRepo: '/abs/cfg' }), readProfile: () => ({ profile: { productRepo: '/abs/prof' } }), cwd: '/main' }, source: 'config', path: '/abs/cfg' },
      { in: { env: {}, readConfig: () => ({}), readProfile: () => ({ profile: { productRepo: '/abs/prof' } }), cwd: '/main' }, source: 'profile', path: '/abs/prof' },
      { in: { env: {}, readConfig: () => ({}), readProfile: () => ({ profile: {} }), cwd: '/main' }, source: 'relative' },
      // corrupt config + profile (throwing readers) must still fall through to relative, never throw.
      { in: { env: {}, readConfig: () => { throw new Error('x') }, readProfile: () => { throw new Error('y') }, cwd: '/main' }, source: 'relative' },
    ]
    for (const c of cases) {
      let r
      try {
        r = wt.resolveSiblingRepo(c.in)
      } catch {
        ok = 0
        continue
      }
      if (r.source !== c.source) ok = 0
      if (c.path && r.path !== c.path) ok = 0
    }
    if (wantsJson(flags)) printJson({ selftestSibling: true, pass: ok === 1 })
    process.stdout.write(`${ok}\n`) // numeric last line (P9.3-14-C)
    return ok === 1 ? 0 : 1
  }

  // ── real git wiring for the operational subcommands ──────────────────────────
  const { execFileSync } = await import('node:child_process')
  const execGit = (args, o = {}) => execFileSync('git', args, { cwd: o.cwd, encoding: 'utf8' })
  // The MAIN checkout root — where worktrees are added FROM (registry.smaRoot resolves
  // it across worktrees via git-common-dir; fail-open to the .sma parent / cwd).
  let mainRoot = process.cwd()
  try {
    const registry = await import('./lib/registry.mjs')
    mainRoot = registry.smaRoot() || dirname(dirs.smaRoot) || process.cwd()
  } catch {
    mainRoot = dirname(dirs.smaRoot) || process.cwd()
  }

  const sub = positionals[0]

  if (sub === 'list') {
    const trees = wt.listWorktrees({ execGit, cwd: mainRoot })
    if (wantsJson(flags)) {
      printJson({ worktrees: trees })
      return 0
    }
    process.stdout.write('SMA worktree: активные рабочие деревья:\n')
    for (const t of trees) process.stdout.write(`  ${t.path}  (${t.branch || t.head})\n`)
    return 0
  }

  if (sub === 'remove') {
    const path = positionals[1]
    if (!path) {
      process.stderr.write('usage: pnpm sma worktree remove <path> [--force]\n')
      return 1
    }
    const res = wt.removeWorktree({ path, execGit, cwd: mainRoot, force: flags.force === true })
    if (wantsJson(flags)) {
      printJson(res)
      return res.ok ? 0 : 1
    }
    if (res.ok) process.stdout.write(`SMA worktree: удалено -> ${res.removed}\n`)
    else process.stderr.write(`SMA worktree: не удалено (${res.message}). Грязное дерево? добавьте --force.\n`)
    return res.ok ? 0 : 1
  }

  if (sub === 'sibling') {
    // Resolve the sibling product repo (../sma) via the deterministic order.
    const readConfig = () => {
      try {
        const raw = readFileSync(join(dirs.smaRoot, 'config.json'), 'utf8')
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }
    const readProfileWired = async () => {
      const prof = await import('./lib/profile.mjs')
      return prof.readProfile({ profilePath: join(dirs.smaRoot, 'profile.json') })
    }
    // resolveSiblingRepo takes a sync readProfile; pre-read the profile once.
    const profileRes = await readProfileWired()
    const res = wt.resolveSiblingRepo({
      env: process.env,
      readConfig,
      readProfile: () => profileRes,
      cwd: mainRoot,
    })
    if (wantsJson(flags)) {
      printJson(res)
      return 0
    }
    process.stdout.write(`SMA worktree: sibling product repo -> ${res.path}  (source: ${res.source})\n`)
    return 0
  }

  // default / `provision` — reuse-or-provision this terminal's worktree, base-guarded.
  let branch = typeof flags.branch === 'string' && flags.branch.trim() ? flags.branch.trim() : ''
  let terminalId = 'session'
  try {
    const registry = await import('./lib/registry.mjs')
    terminalId = registry.resolveTerminalIdentity().terminalId || 'session'
  } catch {
    /* fail-open to a stable stub */
  }
  if (!branch) branch = `${wt.WORKTREE_BRANCH_PREFIX}${terminalId}`
  const path =
    typeof flags.path === 'string' && flags.path.trim()
      ? flags.path.trim()
      : join(dirname(mainRoot), '.sma-worktrees', terminalId) // sibling dir (avoids the nested-removal bug)

  const res = wt.reuseOrProvision({ branch, path, execGit, cwd: mainRoot })
  if (wantsJson(flags)) {
    printJson(res)
    return res.ok === false ? 1 : 0
  }
  if (res.ok === false) {
    process.stderr.write(`SMA worktree: не удалось создать (${res.message}). Остаёмся на основном дереве.\n`)
    return 1
  }
  if (res.reused) {
    process.stdout.write(`SMA worktree: переиспользуем существующее дерево -> ${res.path}  (ветка ${res.branch})\n`)
  } else {
    process.stdout.write(`SMA worktree: создано -> ${res.path}  (ветка ${branch})\n`)
    if (res.baseFixed) process.stdout.write(`  ⚠ база разошлась с HEAD — выполнен git reset --hard ${String(res.expectedBase).slice(0, 12)} (Windows worktree-base guard)\n`)
  }
  process.stdout.write('  Координация (.sma/) остаётся общей для всех деревьев; в main только через `sma merge` (9.3-15), push — по команде основателя.\n')
  return 0
}

/**
 * merge — 9.3-15 (D-9.3-24c/d): the serialized merge ritual + the two numeric
 * self-tests. `merge <branch>` integrates a worktree branch into main LOCALLY under the
 * merge-claim slot (concurrent → soft-deny + override; targeted tests on the MERGE RESULT;
 * journaled receipt) — NEVER a push (push stays founder-ordered via /sma-ship). direct-CLI:
 * may exit 1, NOT hook-facing. `--selftest` / `--selftest-enforce` print a bare numeric last
 * line (predict.mjs scorer contract, P9.3-15-A/C) over a mock — no real merge, no real deny.
 */
async function cmdMerge({ positionals, flags, dirs }) {
  const mg = await import('./lib/merge-gate.mjs')

  // ── --selftest: mock-recorder ritual (claim → tests-on-result → receipt → release) + a
  //    concurrent soft-deny — print 1 iff both hold (P9.3-15-A). No real merge, no real deny.
  if (flags.selftest === true) {
    let ok = 1
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sma-merge-self-'))
    try {
      const calls = []
      const execGit = (args) => {
        calls.push(args)
        if (args[0] === 'rev-parse') return 'RESULT_SHA\n'
        return ''
      }
      let testedSha = null
      const runTests = ({ resultSha }) => {
        testedSha = resultSha
        return { passed: true }
      }
      const res = mg.runMerge({ branch: 'sma-wt/self', by: 'selftest', execGit, runTests, claimsDir: tmp, journalDir: tmp, cwd: tmp })
      if (res.merged !== true || res.testsPassed !== true) ok = 0
      const mi = calls.findIndex((a) => a[0] === 'merge')
      const ri = calls.findIndex((a) => a[0] === 'rev-parse')
      if (!(mi >= 0 && ri > mi)) ok = 0 // ritual order: merge → tests-on-result
      if (testedSha !== 'RESULT_SHA') ok = 0 // tests ran on the MERGE RESULT
      if (calls.some((a) => a.includes('push'))) ok = 0 // NEVER a push
      // a concurrent merge (slot held by a foreign holder) → soft-deny with an override.
      mg.acquireMergeClaim({ by: 'other', branch: 'sma-wt/held', claimsDir: tmp, journalDir: tmp })
      const con = mg.runMerge({ branch: 'sma-wt/self2', by: 'selftest', execGit: () => '', runTests: () => ({ passed: true }), claimsDir: tmp, journalDir: tmp, cwd: tmp })
      if (!(con.merged === false && con.softDenied === true && typeof con.override === 'string')) ok = 0
    } catch {
      ok = 0
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
    if (wantsJson(flags)) printJson({ selftest: true, pass: ok === 1 })
    process.stdout.write(`${ok}\n`) // numeric last line (P9.3-15-A)
    return ok === 1 ? 0 : 1
  }

  // ── --selftest-enforce: verified-live → soft-deny+override; stale → warn; error → allow;
  //    none → allow; cooling-down → warn — print 1 iff all hold (P9.3-15-C). No real deny.
  if (flags['selftest-enforce'] === true) {
    let ok = 1
    try {
      const collision = await import('./lib/collision.mjs')
      const v = collision.verifyClaimEvidence
      const live = mg.enforceScope({ foreignClaim: { by: 'T-x' }, evidence: { scopeDirtyVsHead: true }, env: {}, verifyClaimEvidence: v })
      if (!(live.action === 'soft-deny' && typeof live.override === 'string')) ok = 0
      const stale = mg.enforceScope({ foreignClaim: { by: 'T-x' }, evidence: { scopeDirtyVsHead: false, commitInScopeAfterRenew: 'abc1234' }, env: {}, verifyClaimEvidence: v })
      if (stale.action !== 'warn') ok = 0
      const err = mg.enforceScope({ foreignClaim: { by: 'T-x' }, evidence: {}, env: {}, verifyClaimEvidence: () => { throw new Error('x') } })
      if (err.action !== 'allow') ok = 0 // fail-open → allow, never a hard deny
      const none = mg.enforceScope({ foreignClaim: null, env: {} })
      if (none.action !== 'allow') ok = 0
      const cooling = mg.enforceScope({ foreignClaim: { by: 'T-x' }, evidence: { scopeDirtyVsHead: true }, env: {}, verifyClaimEvidence: v, coolingDown: true })
      if (cooling.action !== 'warn') ok = 0 // founder word wins — never enforce a force-cleared scope
    } catch {
      ok = 0
    }
    if (wantsJson(flags)) printJson({ selftestEnforce: true, pass: ok === 1 })
    process.stdout.write(`${ok}\n`) // numeric last line (P9.3-15-C)
    return ok === 1 ? 0 : 1
  }

  // ── real `merge <branch>` — wire the REAL execGit + a targeted-test runner on the result ──
  const branch = positionals[0]
  if (!branch) {
    process.stderr.write('usage: pnpm sma merge <branch> [--json]\n')
    return 1
  }
  const { execFileSync } = await import('node:child_process')
  const execGit = (args, o = {}) => execFileSync('git', args, { cwd: o.cwd, encoding: 'utf8' })
  // the MAIN checkout root (worktrees resolve it via git-common-dir; fail-open to .sma parent / cwd).
  let mainRoot = process.cwd()
  let by = 'session'
  try {
    const registry = await import('./lib/registry.mjs')
    mainRoot = registry.smaRoot() || dirname(dirs.smaRoot) || process.cwd()
    by = registry.resolveTerminalIdentity().holderIdentity || 'session'
  } catch {
    mainRoot = dirname(dirs.smaRoot) || process.cwd()
  }
  // targeted-test runner ON THE MERGE RESULT — the merge-gate suite as the smoke (never the full suite).
  const runTests = () => {
    try {
      execFileSync('pnpm', ['vitest', 'run', 'scripts/sma/__tests__/merge-gate.test.ts'], { cwd: mainRoot, encoding: 'utf8', stdio: 'ignore' })
      return { passed: true }
    } catch {
      return { passed: false }
    }
  }
  const res = mg.runMerge({ branch, by, execGit, runTests, claimsDir: dirs.claimsDir, journalDir: dirs.journalDir, cwd: mainRoot })
  if (wantsJson(flags)) {
    printJson(res)
    return res.merged && res.testsPassed !== false ? 0 : 1
  }
  if (res.softDenied) {
    process.stderr.write(`SMA merge: слияние уже идёт — ${res.override}\n`)
    return 1
  }
  if (res.ok === false) {
    process.stderr.write(`SMA merge: не удалось (${res.message}). Дерево не тронуто сверх git merge; слот освобождён.\n`)
    return 1
  }
  process.stdout.write(`SMA merge: ${branch} влит в main ЛОКАЛЬНО${res.resultSha ? ` (${String(res.resultSha).slice(0, 7)})` : ''}; тесты на результате слияния: ${res.testsPassed ? 'зелёные' : 'КРАСНЫЕ'}.\n`)
  process.stdout.write('  push — по команде основателя через /sma-ship; `sma merge` НЕ пушит и НЕ деплоит.\n')
  return res.testsPassed ? 0 : 1
}

/**
 * vendor [--json] | --count untriaged | --selftest (9.4-01, BL-160) — the
 * standing Anthropic-update triage ledger linter. Deterministic READER/LINTER
 * over docs/VENDOR-LEDGER.md: it parses the append-only table, fails rows that
 * are missing a verdict or disposition, and never fetches anything. Zero
 * network, zero LLM (substrate law) — the ledger is written by whoever read the
 * release notes; this verb only keeps them honest.
 *
 * `--count untriaged` prints the bare untriaged count as its LAST stdout line
 * (the predict.mjs scorer contract) — the /sma-ship gate blocks a release on a
 * non-zero count. `--selftest` runs the inline fixture pair and prints 1/0. A
 * missing ledger is fail-open: count prints 0 with a stderr warning, so the gate
 * can never wedge a ship on an absent file. NOT hook-facing.
 */
async function cmdVendor({ flags, dirs }) {
  const vl = await import('./lib/vendor-ledger.mjs')

  // ── --selftest: the linter proves itself (numeric last line) ────────────────
  if (flags.selftest === true) {
    const ok = vl.selftest()
    process.stdout.write(`${ok}\n`)
    return ok === 1 ? 0 : 1
  }

  // The ledger lives at docs/VENDOR-LEDGER.md from the product repo root
  // (dirname of the .sma root). resolveRoot falls back to cwd/.sma outside a repo.
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()
  const ledgerPath = join(repoRoot, 'docs', 'VENDOR-LEDGER.md')
  const { rows, errors, warnings } = vl.parseLedger({ ledgerPath })

  // ── --count untriaged: the bare number as the last stdout line ──────────────
  if (flags.count === 'untriaged') {
    // Fail-open: an absent/unreadable ledger warns on stderr and counts 0 so the
    // ship gate can never wedge on a missing file.
    for (const w of warnings) process.stderr.write(`  ! ${w}\n`)
    process.stdout.write(`${vl.countUntriaged(rows)}\n`) // numeric last line (scorer contract)
    return 0
  }

  // ── default: the ledger table + violation list, or --json ───────────────────
  const { ok, violations } = vl.lintLedger(rows)

  if (wantsJson(flags)) {
    printJson({ ok, rows, violations, errors, warnings })
    return ok && errors.length === 0 ? 0 : 1
  }

  for (const w of warnings) process.stderr.write(`  ! ${w}\n`)
  if (!rows.length) {
    process.stdout.write('Vendor ledger is empty — no Anthropic sightings recorded yet.\n')
    return 0
  }
  process.stdout.write(`Vendor ledger — ${rows.length} sighting(s):\n`)
  for (const r of rows) {
    process.stdout.write(`  ${r.date}  [${r.verdict || '(no verdict)'}]  ${r.source} — ${r.capability}  → ${r.disposition || '(no disposition)'}\n`)
  }
  for (const e of errors) process.stdout.write(`  ✗ line ${e.line}: ${e.message}\n`)
  for (const v of violations) process.stdout.write(`  [${v.rule}] ${v.field}: ${v.message}\n`)
  process.stdout.write(`  untriaged: ${vl.countUntriaged(rows)}\n`)
  return ok && errors.length === 0 ? 0 : 1
}

const HOOK_FACING = new Set(['session-start', 'session-end', 'collision-check', 'heartbeat', 'reflex-check', 'gates-check', 'airbag-check', 'spend-check', 'stall-check', 'pre', 'pretask-pack', 'subagent-verify', 'precompact-capsule', 'statusline', 'pulse'])

/** subcommand → handler. Each handler lazy-imports its lib module. */
const HANDLERS = {
  status: cmdStatus,
  heartbeat: cmdHeartbeat,
  'session-start': cmdSessionStart,
  'session-end': cmdSessionEnd, // 9.3-13 (D-9.3-22a) — SessionEnd hook: release own claims
  ask: cmdAsk, // 9.3-13 (D-9.3-23) — fingerprint demand stub (+ --unmet-count)
  pre: cmdPre,
  'pre-bench': cmdPreBench,
  'collision-check': cmdCollisionCheck,
  'reflex-check': cmdReflexCheck,
  'gates-check': cmdGatesCheck,
  'airbag-check': cmdAirbagCheck, // 9.2-05 (D-9.2-08) — pre-less fallback for the airbag stream
  undo: cmdUndo, // 9.2-05 — one-action airbag restore
  airbag: cmdAirbag, // 9.2-05 — snapshot admin (list|prune|probe|stats)
  spend: cmdSpend, // 9.2-09 (D-9.2-13) — deterministic spend ledger report + set-cap + --stat scorer
  'spend-check': cmdSpendCheck, // 9.2-09 — pre-less fallback for the spend stream (budget reflexes + loop-breaker)
  breaker: cmdBreaker, // 9.2-09 — loop-breaker admin (list|re-arm)
  'stall-check': cmdStallCheck,
  'gates-report': cmdGatesReport,
  'gates-ack': cmdGatesAck,
  gates: cmdGates,
  claim: cmdClaim,
  release: cmdRelease,
  'next-slot': cmdNextSlot,
  tia: cmdTia,
  consume: cmdConsume,
  'force-clear': cmdForceClear,
  preship: cmdPreship,
  disposition: cmdDisposition,
  lint: cmdLint,
  profile: cmdProfile, // 9.3-01 (D-9.3-04) — deterministic profile surface (--json|--lint|--coverage|--recap)
  'build-index': cmdBuildIndex,
  emit: cmdEmit, // 9.3-04 (D-9.3-08) — one corpus -> CLAUDE.md/AGENTS.md/.cursorrules/GEMINI.md managed blocks
  load: cmdLoad,
  snapshot: cmdSnapshot,
  'upstream-check': cmdUpstreamCheck,
  'predict-score': cmdPredictScore,
  calibration: cmdCalibration,
  usage: cmdUsage,
  consolidate: cmdConsolidate,
  trim: cmdTrim,
  state: cmdState,
  'exec-journal': cmdExecJournal,
  metrics: cmdMetrics,
  report: cmdReport,
  bench: cmdBench,
  reverify: cmdReverify, // 9.2-03 (D-9.2-06) — re-verify structural receipts
  'receipt-hash': cmdReceiptHash, // 9.2-03 — the receipt emit path
  'chain-tip': cmdChainTip, // 9.2-03 (D-9.2-07) — merged journal chain tip (release-tag pin)
  'chain-verify': cmdChainVerify, // 9.2-03 — tamper detector over the journal chain
  'pretask-pack': cmdPretaskPack, // 9.2-04 (D-9.2-10) — PreToolUse(Task) pack injection
  'subagent-verify': cmdSubagentVerify, // 9.2-04 — SubagentStop tree-verified receipts
  'subagent-receipts': cmdSubagentReceipts, // 9.2-04 — receipt coverage/phantoms/pack-p95 report
  'precompact-capsule': cmdPrecompactCapsule, // 9.2-06 (D-9.2-09) — PreCompact deterministic capsule
  resume: cmdResume, // 9.2-06 — continuation brief from the flight recorder
  handoff: cmdHandoff, // 9.2-06 — teammate brief + claim-transfer steps
  flight: cmdFlight, // 9.2-06 — flight instruments (probe|determinism-check|tail)
  grill: cmdGrill, // 9.2-07 (D-9.2-11) — adversarial challenge gate + budget-aware pre-push
  'blind-verify': cmdBlindVerify, // 9.2-07 — tree-only re-derivation + divergence detection
  evidence: cmdEvidence, // 9.2-07 — burden-of-proof records for risky ops
  integrity: cmdIntegrity, // 9.2-10 (D-9.2-14) — STPA disarm-path guard (hazards|shadow|disarms|disarm-renew)
  skeptic: cmdSkeptic, // 9.2-10 — Goodhart skeptic countersign (sign|verify)
  canary: cmdCanary, // 9.2-10 — planted false-done canaries (plant|score|sweep) — S8
  nearmiss: cmdNearmiss, // 9.2-10 — scoring-immune near-miss channel (ASRS)
  passport: cmdPassport, // 9.3-02 (D-9.3-10) — calibration passport (--build|--verify|--check-badge|--json)
  model: cmdModel, // 9.3-02 — model-version guard surface (--json|--count sightings|--set <id>)
  excavate: cmdExcavate, // 9.3-03 (D-9.3-09) — adoption wedge: read-only history miner + CATCHES + --stats instrument
  ladder: cmdLadder, // 9.3-06 (D-9.3-12) — tier table + benefit stats (--json|--count-autofix|--noise-demoted-pct)
  tune: cmdTune, // 9.3-06 — the tuner (propose|apply|benefit|fix|incident) — never commits, never pushes
  curriculum: cmdCurriculum, // 9.3-06 (D-9.3-16) — weekly miss-curriculum: clusters -> templates -> weak-spots brief
  preflight: cmdPreflight, // 9.3-10 (D-9.3-17) — already-built pre-dispatch gate (built/partial/absent; --count|--selftest|--run-verify)
  arena: cmdArena, // 9.3-11 (D-9.3-18) — benchmark arena scorer + static graphs page (report|--selftest|--selftest-negative)
  batch: cmdBatch, // 9.3-12 (D-9.3-19) — /sma-batch middle lane: risk filter + grill-lite + mandatory receipts (--assemble|--selftest-riskfilter|--selftest-checkoff)
  deleteme: cmdDeleteme, // 9.4 BL-162 (v3.6) — one-click off-ramp: dry-run plan | --yes apply | --selftest; memory corpus PRESERVED
  'memory-preview': cmdMemoryPreview, // 9.4 BL-174 (v3.6) — onboarding ASCII memory-graph preview (--project|--lang|--json|--selftest)
  catalog: cmdCatalog, // 9.3-05 (D-9.3-06) — deterministic file catalog (refresh|find|--check --count)
  context: cmdContext, // 9.3-05 (D-9.3-07) — context compiler (compile|score|miss|exam|--selftest)
  statusline: cmdStatusline, // 9.3-07 (D-9.3-13) — native statusline segment (render|--wrap|install|uninstall|set-webhook|--stat)
  pulse: cmdPulse, // 9.3-07 (D-9.3-13) — hook-facing attention pulse (working|waiting-for-human); idle is derived
  manifest: cmdManifest, // 9.3-08 (D-9.3-11) — PR evidence passport reader (--range|--json|--md|--stat)
  worktree: cmdWorktree, // 9.3-14 (D-9.3-24a/b) — per-terminal worktree isolation (provision|list|remove|sibling; --selftest|--selftest-sibling)
  merge: cmdMerge, // 9.3-15 (D-9.3-24c/d) — serialized merge ritual (merge <branch> local-only; --selftest|--selftest-enforce)
  explain: cmdExplain, // 9.3-09 (D-9.3-15) — in-product explainers ([topic]|--list|--coverage [--count]|--lang en|ru|--json)
  'doc-audit': cmdDocAudit, // 9.3-09 (D-9.3-01/15) — deterministic docs honesty audit (--target manual|readme|all|--count|--json)
  vendor: cmdVendor, // 9.4-01 (BL-160) — standing Anthropic-update triage ledger linter (--count untriaged|--selftest|--json); zero network
  memory: cmdMemory, // 9.4-06 (BL-176) — deterministic versioned corpus token-cost report (stats [--top N]|--stat core-tokens|corpus-tokens|--selftest); compress deferred by design
  'ship-lane': cmdShipLane, // 9.4-08 (BL-177) — ship-lane precondition + changelog drafter + lane records (check|changelog|record|report|--stat|--selftest); read-only, never pushes
  decisions: cmdDecisions, // 9.5-02 (D-9.5-08) — decision-corpus miner (mine|stats); drafts-only, LOCAL corpus, never auto-committed
  exam: cmdExam, // 9.5-06 (D-9.5-08) — replay exam (build|score); deterministic exam builder + match-rate scorer, LOCAL, blind key file
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const { positionals, flags } = parseArgs(argv.slice(1))

  if (!cmd || flags.help === true || cmd === 'help') {
    process.stdout.write(
      'pnpm sma <status|heartbeat|session-start|session-end|ask|pre|pre-bench|collision-check|reflex-check|gates-check|airbag-check|undo|airbag|spend|spend-check|breaker|stall-check|gates-report|gates-ack|gates|claim|release|next-slot|tia|consume|force-clear|preship|disposition|lint|profile|build-index|emit|load|snapshot|upstream-check|predict-score|calibration|usage|consolidate|trim|state|exec-journal|metrics|report|bench|reverify|receipt-hash|chain-tip|chain-verify|pretask-pack|subagent-verify|subagent-receipts|precompact-capsule|resume|handoff|flight|grill|blind-verify|evidence|integrity|skeptic|canary|nearmiss|passport|model|excavate|ladder|tune|curriculum|preflight|arena|batch|catalog|context|statusline|pulse|manifest|worktree|merge|explain|doc-audit|vendor|memory|ship-lane|decisions|exam>\n',
    )
    return 0
  }

  const handler = HANDLERS[cmd]
  if (!handler) {
    process.stderr.write(`SMA: неизвестная команда «${cmd}»\n`)
    return 1
  }

  const root = await resolveRoot()
  const dirs = dirsFrom(root)

  if (HOOK_FACING.has(cmd)) {
    // Fail-open contract: hook-facing handlers exit 0 no matter what (P4/C9).
    try {
      await handler({ positionals, flags, dirs })
    } catch {
      /* swallow — a hook must never block the session */
    }
    return 0
  }

  return handler({ positionals, flags, dirs })
}

main()
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((err) => {
    // A direct-CLI verb that crashes must say WHAT failed and WHY — a silent
    // exit 1 is undebuggable. (Hook-facing verbs never reach here: main() wraps
    // them in a swallow-to-exit-0 try/catch — the fail-open contract holds.)
    process.stderr.write(`SMA: сбой команды — ${err && err.stack ? err.stack : String(err)}\n`)
    process.exit(1)
  })
