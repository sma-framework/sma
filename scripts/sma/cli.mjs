#!/usr/bin/env node
/**
 * cli.mjs — the single `pnpm sma <cmd>` entrypoint (D-49-10), built on the
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
 * D-49-02 / P4 / C9: collision-check + session-start are WARN-only — they NEVER
 * emit permissionDecision 'deny'; they carry Terraform-style advisories in
 * additionalContext and always allow the operation.
 * D-49-09 / P3: force-clear is the ONLY foreign-claim removal path — it prints
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
    calibrationDir: join(root, 'calibration'), // 49.1-08 (B20) — prediction-calibration ledger
    reflexDir: join(root, 'reflex'), // 49.1-10 (B2) — per-session reflex seen-store
    usageDir: join(root, 'usage'), // 49.1-11 (B4) — usage-citation ledger
    gatesDir: join(root, 'gates'), // 49.1-17 (D-49.1-13) — soft-deny evidence markers + override tokens
    execDir: join(root, 'exec'), // 49.1-20 (B14) — per-plan execution progress journal
    stallDir: join(root, 'stall'), // 49.1-21 (B16) — per-session rolling PostToolUse window
    benchDir: join(root, 'bench'), // 49.2-01 (D-49.2-02) — bench markers: ttc/, exam/, selfcost.json
    perfDir: join(root, 'perf'), // 49.2-02 (D-49.2-04) — `sma pre` per-stream timing samples (pre.jsonl)
    subagentsDir: join(root, 'subagents'), // 49.2-04 (D-49.2-10) — spawn records + receipt stats
    flightDir: join(root, 'flight'), // 49.2-06 (D-49.2-09) — pre-compaction capsule + session flight marks
    spendDir: join(root, 'spend'), // 49.2-09 (D-49.2-13) — spend book incremental cache + window budget
    breakerDir: join(root, 'breaker'), // 49.2-09 (D-49.2-13) — loop-breaker markers (per-ruleId)
    grillDir: join(root, 'grill'), // 49.2-07 (D-49.2-11) — per-plan adversarial challenge ledger
    blindDir: join(root, 'blind'), // 49.2-07 (D-49.2-11) — frozen blind-verify verdicts (info barrier)
    evidenceDir: join(root, 'evidence'), // 49.2-07 (D-49.2-11) — burden-of-proof records for risky ops
  }
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
 * renewal-safe disambiguator resolveTerminalIdentity wants (R7/D-49-01). Env overrides
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
 * replacement char), never a torn sequence. 49.2-06 restore reflex.
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
    registry.reapStale({
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
 * session-start — compose the D-49-02 start summary (active sessions, live
 * collisions, open push-claim, needs-human entries) and emit it as SessionStart
 * hook JSON per RESEARCH Pattern 1 (hookSpecificOutput.additionalContext).
 * ALWAYS exit 0. Also piggybacks a heartbeat so a fresh terminal registers.
 */
async function cmdSessionStart({ dirs }) {
  // The SessionStart hook receives the same stdin JSON as every PreToolUse — read the
  // stable window token (session_id) so THIS terminal registers under the window-stable
  // terminalId that later collision-check invocations will renew (R7/D-49-01). Keep the
  // whole event: 49.2-06's restore reflex reads its `source` field (compact vs startup).
  const evt = readStdinJson()
  const sessionToken = windowTokenFrom(evt)

  // register/refresh this terminal (best-effort; never fatal). The own claimed
  // scope is captured BEFORE the registering beat (49.1-11: the beat writes an
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

  const s = await gatherSummary(dirs)
  const lines = []
  lines.push(`SMA: активных сессий ${s.activeSessions}, открытых коллизий ${s.collisions}.`)
  if (s.pushClaim && s.pushClaim.live) lines.push(`отправка в origin уже идёт: ${s.pushClaim.who}`)
  for (const nh of s.needsHuman) {
    lines.push(`устаревшая сессия ${nh.who} со свежими правками в scope — требуется решение человека`)
  }
  lines.push('Подробнее: `pnpm sma status`.')

  // 49.1-11 (B1): budgeted pre-act periphery injection — relevant memory arrives
  // BEFORE the first act, matched to the session's live context (claimed scope /
  // current phase). CORE already auto-loads via MEMORY.md; ONLY trigger-matched
  // periphery lands here, under a hard 2048-byte budget (T-49.1-22). Fail-open:
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

  // 49.1-18 (B12): the cross-terminal digest «Что изменилось с вашего последнего
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
    // Low-calibration escalations (49.1-08) -> digest lines.
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

  // FI-10 — prompt ONCE for a human window name when this window is still anonymous, so
  // the journal + digest stop showing t-<hash> and become «P<phase> <Name>».
  let namePrompt = ''
  if (identity && typeof identity.holderIdentity === 'string' && /^T-/i.test(identity.holderIdentity)) {
    namePrompt = 'Задайте имя окна: переменная SMA_TERMINAL_NAME (например «Tom»), чтобы журналы были читаемы.'
  }

  // 49.2-06 (D-49.2-09) — the post-compact RESTORE REFLEX. Claude Code re-fires
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
    namePrompt
  ) {
    const parts = [lines.join(' ')]
    if (preAct) parts.push(preAct)
    if (digest) parts.push(digest)
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

// ── 49.1-11 (B1): pre-act injection helpers ──────────────────────────────────

/** Hard byte budget of the injected periphery section (T-49.1-22, acceptance-checked). */
const PRE_ACT_BUDGET_BYTES = 2048

/** Truncation caps — descriptions + extracts only, never whole bodies (T-49.1-21). */
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
 * tia [--against <ref>] [--json] — regex-based test-impact analysis (49.1-23, B17).
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
 * (49.1-23, B17). Writes the `consumed` marker inside the claim dir so the next-slot
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
  // FI-11 (49.1-13): MEM-REGEN staleness covers the per-area INDEX files too.
  const generateAreas = (committed) => generator.buildAreaIndexes(regenInputs(committed))

  // PRED family (49.1-09): lint plan predictions when a plans tree exists.
  // --plans overrides; default is .planning/phases when present. The git runner
  // is read-only (rev-parse/log/show) — the lint's no-write invariant holds.
  const { existsSync } = await import('node:fs')
  const defaultPlans = join('.planning', 'phases')
  const plansDir = typeof flags.plans === 'string' ? flags.plans : existsSync(defaultPlans) ? defaultPlans : undefined
  const execGit = (args, o = {}) => execFileSync('git', args, { encoding: 'utf8', ...o })

  // STATE-SIZE (49.1-13): the state path is injected — --state overrides; the
  // default is the house .planning/STATE.md when present (fail-soft to none).
  const defaultState = join('.planning', 'STATE.md')
  const statePath = typeof flags.state === 'string' ? flags.state : existsSync(defaultState) ? defaultState : undefined

  const opts = {
    corpusDir,
    tagsPath,
    indexPath: join(corpusDir, 'MEMORY.md'),
    claudeMdPath: 'CLAUDE.md',
    generate,
    generateAreas,
    ...(statePath ? { statePath } : {}),
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
  // FI-11 (49.1-13): the regen artifact set = MEMORY.md + INDEX-<area>.md files.
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

  // 49.1-11 (B4): every note load via `sma load` is recorded as a citation.
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

/**
 * pre — the `sma pre` PreToolUse MULTIPLEXER (49.2-02, D-49.2-04). ONE node run per
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
  const ctx = await pre.buildCtx({ evt, dirs, env: process.env, now: () => Date.now() })
  const stream = pre.PRE_CHECKS.find((s) => s.id === id)
  let warns = []
  let deny = null
  if (stream && stream.tools.includes(ctx.toolName)) {
    const killed = stream.killSwitchEnv && (() => { const v = String(process.env[stream.killSwitchEnv] ?? '').trim().toLowerCase(); return !!v && v !== '0' && v !== 'false' })()
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
  const merged = pre.mergeOutput({ warns, deny })
  if (merged) printJson(merged)
  return 0
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
  return runSingleStream(dirs, 'gates')
}

/**
 * airbag-check — the git airbag hook (49.2-05, D-49.2-08). The pre-less FALLBACK for
 * an install that has not adopted the `sma pre` multiplexer; the canonical wiring is
 * `pre` (the airbag rides inside it). Delegates to the SAME airbag stream in PRE_CHECKS
 * (the only extra deny-capable stream) — honoring its kill-switch (SMA_AIRBAG_DISABLE)
 * and its opt-in gate (SMA_AIRBAG_ENABLE). HOOK_FACING: exit 0 always, wrapped fail-open.
 */
async function cmdAirbagCheck({ dirs }) {
  return runSingleStream(dirs, 'airbag')
}

/**
 * spend-check — the deterministic spend-ledger hook (49.2-09, D-49.2-13). The pre-less
 * FALLBACK for an install that has not adopted the `sma pre` multiplexer; the canonical
 * wiring is `pre` (the spend stream rides inside it). Delegates to the SAME spend stream
 * in PRE_CHECKS (a deny-capable stream that denies ONLY the Task tool past a configured
 * cap) — honoring its opt-in gate (SMA_SPEND_OPTIN) + kill-switch (SMA_SPEND_DISABLE).
 * HOOK_FACING: exit 0 always, wrapped fail-open.
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
 * (49.2-05). NOT hook-facing (writes the working tree — an explicit user action).
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
 * NOT hook-facing. probe prints 0/1 as the LAST line (P49.2-05-C scorer); stats +
 * coverage/latency come from the ONE airbag.benchProviders path (no drift vs bench).
 */
async function cmdAirbag({ positionals, flags, dirs }) {
  const airbag = await import('./lib/airbag.mjs')
  const sub = positionals[0]

  if (sub === 'probe') {
    const p = airbag.nativeCheckpointProbe({ env: process.env })
    if (wantsJson(flags)) printJson(p)
    else process.stdout.write(`SMA airbag probe: native=${p.native} (probeVersion ${p.probeVersion})\n`)
    process.stdout.write(`${p.native ? 1 : 0}\n`) // numeric LAST line — the P49.2-05-C scorer
    return 0
  }

  const { runGit } = await makeRepoGitRunner()

  if (sub === 'list') {
    const groups = airbag.listSnapshots({ runGit })
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

// ── 49.2-09 (D-49.2-13): the deterministic spend ledger ──────────────────────────

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
 * (the predict-score scorer contract, 49.1-08). `set-cap` writes the window budget
 * with provenance. When probeNativeSpend().native, the report leads with the
 * standing-down banner (D-49.2-05a). Fail-open — never wedges anything.
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
 * breaker [list|re-arm <ruleId>] [--json] — the loop-breaker admin (49.2-09). NOT
 * hook-facing. `list` shows every soft-disabled SMA rule + its compensating control;
 * `re-arm <ruleId>` deletes the marker (re-enabling the rule) and journals the re-arm
 * with provenance (the D-49-09 force-clear idiom). Markers are plan 10's disarm-path input.
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

// ── 49.2-06 (D-49.2-09): the flight recorder — capsule / restore / resume / handoff ─

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
  const [phase, plan] = planId.split(/-(?=[^-]*$)/) // split on the LAST dash: "49.2-06" -> ["49.2","06"]
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
 * capsule failure degrades to no-capsule, NEVER a blocked compaction (T-49.2-06B).
 */
async function cmdPrecompactCapsule({ dirs }) {
  if (isEnvOn(process.env.SMA_FLIGHT_DISABLE)) return 0
  const flight = await import('./lib/flight.mjs')
  if (flight.nativeProbe({ env: process.env }).native) return 0 // bridge stands down (D-49.2-05)

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
 *   probe             -> prints the digit 0|1 as the LAST line (P49.2-06-03 scorer).
 *   determinism-check -> gathers inputs ONCE, buildCapsule twice with identical inputs
 *                        (+ injected now), byte-compares, prints 1|0 last (P49.2-06-02).
 *   tail [n]          -> prints the last n flight marks.
 */
async function cmdFlight({ positionals, flags, dirs }) {
  const flight = await import('./lib/flight.mjs')
  const sub = positionals[0]

  if (sub === 'probe') {
    const p = flight.nativeProbe({ env: process.env })
    if (wantsJson(flags)) printJson(p)
    else process.stdout.write(`SMA flight probe: native=${p.native} (${p.reason})\n`)
    process.stdout.write(`${p.native ? 1 : 0}\n`) // numeric LAST line — the P49.2-06-03 scorer
    return 0
  }

  if (sub === 'determinism-check') {
    const inputs = await gatherFlightInputs(dirs, { now: '2026-01-01T00:00:00.000Z' })
    const a = flight.buildCapsule(inputs)
    const b = flight.buildCapsule(inputs)
    const identical = Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8')) ? 1 : 0
    if (wantsJson(flags)) printJson({ deterministic: identical === 1, bytes: Buffer.byteLength(a, 'utf8') })
    process.stdout.write(`${identical}\n`) // numeric LAST line — the P49.2-06-02 scorer
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
 * pre-bench — the deterministic, re-runnable SLO instrument (49.2-02, D-49.2-04).
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
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sma-pre-parity-'))
    const benchDirs = dirsFrom(join(tmpRoot, '.sma'))
    const noSha = async () => null
    let mismatches = 0
    try {
      for (const fx of fixtures) {
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
      }
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
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
        // fixed literal argv — no user-input interpolation (T-49.2-06); fresh temp
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
  // the bare numeric LAST line — what the V2 scorer parses (PRED-49.2-02-A).
  process.stdout.write(`${p95}\n`)
  return 0
}

/**
 * stall-check — the P5 stall detector consumer (49.1-21, B16). A PostToolUse
 * hook (NEW hook type for SMA — the security guard's Stop/SubagentStop are a
 * different, untouched surface). Reads the tool event JSON from stdin, appends
 * a compact event to the per-session rolling window (.sma/stall/<session>.json),
 * runs the four DETERMINISTIC StuckDetector rules (never LLM-judged — RESEARCH
 * Anti-pattern A1), and on detection emits an ADVISORY additionalContext nudge
 * naming the pattern + a break action. NEVER blocks the tool call (T-49.1-45:
 * fail-open parse + bounded state + HOOK_FACING exit-0). Dedup: one nudge per
 * pattern per session via the reflex seen-store under 'stall:' keys.
 * Kill-switch: SMA_STALL_DISABLE (T-49.1-46).
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

    // ttc first-edit recorder (49.2-01, S5 instrument). Additive, fail-open: on the
    // FIRST Edit|Write of a session write ONE ttc marker so bench can measure
    // session-start -> first-Edit. A bench bug here must NEVER break stall-check, so
    // the whole call is wrapped (T-49.2-03). Plan 02's `sma pre` multiplexer will
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
      /* fail-open — the ttc recorder never wedges stall-check (T-49.2-03) */
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

  // 49.2-06 (D-49.2-09) FLIGHT MARK SEAM — generalize the V2 exec-journal to ALL
  // sessions: every PostToolUse appends ONE mark line via THIS existing stall-check
  // spawn (ZERO new per-tool-call process, D-49.2-04). Best-effort, fail-open. `target`
  // is a file path for Edit/Write/Read or a first-token command SLUG for Bash — NEVER
  // the full command line (secrets ride in command args, T-49.2-06A). When plan 02's
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
    /* fail-open — a mark append never wedges stall-check (D-49.2-04 premise) */
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

/**
 * gates-report [--json] — the D-49.1-13 promotion-evidence surface. Reads the
 * journal for 'gate' fires + 'gate-ack' false-positive acks and renders per-gate
 * fire counts and ack counts. NOT hook-facing (may exit 1 on a real error).
 */
async function cmdGatesReport({ flags, dirs }) {
  const journal = await import('./lib/journal.mjs')
  const { events, corrupt } = journal.readJournal({ journalDir: dirs.journalDir })

  // ── --promotion-readiness (D-49.1-13): the ONLY sanctioned justification to arm a
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
      'отчётом; промоушн ТОЛЬКО по журнальным данным (D-49.1-13).'
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
    process.stdout.write('SMA gates — готовность к промоушену soft-deny (D-49.1-13):\n')
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
 * event that gates-report surfaces, feeding the D-49.1-13 promotion evidence
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

/** The two gates that carry a soft-deny capability (D-49.1-13: 1-2 gates only). */
const SOFT_DENY_GATE_IDS = ['GATE-PUSH', 'GATE-MEMEDIT']

/**
 * gates <override|mark-fullgate> — the D-49.1-13 soft-deny operator surface.
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
 * soft-deny gate (force-clear-with-provenance UX, D-49.1-13). Prints gate/terminal/reason
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
 * HEAD (D-49.1-13). Called by /sma-ship AFTER the heavy gate passes: it lands
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
 * force-clear <claim> [--yes] — the ONLY foreign-claim removal path (D-49-09,
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

  // 49.2-07 (D-49.2-11): a foreign-claim clear is a RISKY OP — it carries a burden-of-proof
  // evidence record IN ADDITION to the D-49-09 --yes confirmation (this ADDS, replaces nothing).
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

  // Journal the steal with full provenance (D-49-09).
  journal.appendEvent(
    {
      type: 'steal',
      actors: [identity.holderIdentity, who].filter(Boolean),
      scope: name,
      detail: { by: identity.holderIdentity, target: name, formerHolder: who, at: new Date().toISOString() },
    },
    { terminalId: identity.terminalId, journalDir: dirs.journalDir },
  )

  // 49.2-07 (D-49.2-11): journal the risky-op with its evidenceId — the P49.2-07-C denominator.
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
 * (49.2-08, D-49.2-12, ICE 648). Reads the V2 calibration ledger and BLOCKS
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

  // --selftest: prove the engine cannot go blind silently (P49.2-08-2). The real
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
 * the ONLY unblock path (D-49.2-12). Mirrors force-clear's provenance posture
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
 * upstream-check [--apply] [--json] — the daily upstream-watch (D-49.1-03,
 * 49.1-07). NOT hook-facing: may exit non-zero on error. Compares the
 * UPSTREAM.json anchor against the latest upstream release; on a NEW release
 * downloads the tarball (npm pack → temp; extracted for DIFFING only, nothing
 * from it ever executes — T-49.1-SC), runs the three-way report through
 * rename-map.json and writes docs/upstream-reports/<version>.md.
 *
 * --apply is the LOCAL operator entry point of the review-gated auto-port: it
 * ports the CLEAN bucket only (the same applyCleanSet path the daily Action's
 * PR branch uses — one porting implementation, two review-gated doors), updates
 * UPSTREAM.json, refreshes the vendor snapshot dir, and prints the commit
 * instruction for the operator. Conflicts NEVER auto-apply — they print as a
 * task list for a human/agent integration pass (T-49.1-12).
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

  // status === 'new' — download the new tarball for diffing (T-49.1-SC: extract
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
    // refuse instead of lying (key_links, 49.1-07).
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
 * DETERMINISTICALLY (49.1-08, B18): allowlist check -> run check_command ->
 * numeric compare -> append every verdict to the per-domain calibration
 * ledger. Zero LLM anywhere in scoring. NOT hook-facing: exits 1 when any
 * 'error' verdict occurs (callers decide); a miss is a valid scoring outcome
 * -> exit 0.
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
  // runner is ever invoked (T-49.1-14) — scorePlan never calls it for a
  // non-matching command.
  const runCommand = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 120_000 })

  const { records, invalid } = predict.scorePlan({ planPath, runCommand })
  for (const r of records) calibration.appendVerdict(r, { calibrationDir: dirs.calibrationDir })

  // B19 (49.1-09): every MISS auto-drafts a bug-lesson candidate into
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
    printJson({ plan: planPath, records, invalid, drafts, appended: records.length, exitCode })
    return exitCode
  }

  if (!records.length && !invalid.length) {
    process.stdout.write(`SMA: в ${planPath} нет блока predictions — оценивать нечего.\n`)
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
  if (drafts.length) {
    process.stdout.write('Черновики уроков из промахов (drafts/ — вне корпуса, до ручной проверки):\n')
    for (const d of drafts) {
      process.stdout.write(`  ${d.drafted ? '+' : '='} ${d.path}${d.drafted ? '' : ' (уже существует — не перезаписан)'}\n`)
    }
  }
  process.stdout.write(`Вердиктов записано в леджер: ${records.length}\n`)
  return exitCode
}

// ── 49.2-03 (D-49.2-06/07): receipts reverify + journal chain CLI ─────────────

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

/**
 * calibration [--domain <d>] [--json] — the B20 answer surface: per-domain
 * hit-rate table + the low-calibration escalation list (hitRate < 0.6 при
 * n >= 5). Empty ledger -> honest empty state, exit 0.
 */
async function cmdCalibration({ flags, dirs }) {
  const calibration = await import('./lib/calibration.mjs')
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
 * pass (49.1-12, B5). PROPOSE-ONLY: renders consolidate.mjs's propose() output
 * in the Pattern-3 contract (MERGE/PROMOTE/CONTRADICT/DIGEST lines under the
 * nothing-auto-committed banner). The lib NEVER writes; APPLYING any proposal
 * is the operator's reviewed edit (T-49.1-23). FI-9: memory is never deleted
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
 * demotion-only trimmer (49.1-13): the auto-repair the size lints name.
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
 * state <set-position|add-blocker|resolve-blocker|set-session> — the D-49.1-14
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
 * The per-plan execution progress journal (49.1-20). NOT hook-facing — it is
 * called at the workflow's task-commit / plan-complete steps and read at the
 * resume-ritual step. Appends are best-effort at the call site (T-49.1-44).
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
  if (flags.reason != null) entry.reason = flags.reason // blocked-event payload (49.1-21)
  const record = execJournal.append(entry, key)
  if (wantsJson(flags)) {
    printJson({ ok: true, record })
    return 0
  }
  process.stdout.write(`SMA exec-journal: ${record.event} task=${record.task ?? '-'} -> ${phase}-${plan}.jsonl\n`)
  return 0
}

/**
 * metrics [--json] — read-only process telemetry (49.1-24, B23, D-49.1-07). Reads
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
 * (49.1-24, D-49.1-07): sessions, predictions, calibration, reflex firings,
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
 * bench — the W0 measurement harness surface (49.2-01, D-49.2-02). Runs the
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
    const out = typeof flags.out === 'string' ? flags.out : join(repoRoot, '.planning/phases/49.2-sma-v3-trust-spine/49.2-BASELINE.md')
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

  // ── --coverage (P49.2-01-A instrument) ────────────────────────────────────
  if (flags.coverage) {
    const metrics = bench.runAllMetrics(ctx)
    process.stdout.write(`${bench.coverageCount(metrics)}\n`)
    return 0
  }

  // ── --timing (P49.2-01-B instrument) ──────────────────────────────────────
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
  // clone-reproducible base (P49.2-01-C) is the artifact contains-grep — pure file
  // reads. Re-running each plan's `pnpm vitest`/`node` verify command is expensive,
  // environment-sensitive (Windows cannot execFile `pnpm` directly), and therefore
  // NON-reproducible — so it is NOT wired into the routine snapshot. When wired, the
  // inner is ALREADY isSafeCommand-checked upstream (T-49.2-01); split on spaces (the
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
 * 49.1 plans (sorted by plan number; completion = a sibling SUMMARY EXISTS). Blind:
 * only EXISTENCE is consulted, never a SUMMARY body.
 */
function resolveS1PlanSet(repoRoot) {
  try {
    const dir = join(repoRoot, '.planning/phases/49.1-sma-v2-prediction-reflex-10x')
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

/** resolveDogfoodSummaries(repoRoot) — the 2 most recent 49.1 phase SUMMARYs (S4 window). */
function resolveDogfoodSummaries(repoRoot) {
  try {
    const dir = join(repoRoot, '.planning/phases/49.1-sma-v2-prediction-reflex-10x')
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
phase: 49.2-sma-v3-trust-spine
plan: 01
artifact: baseline
status: frozen
freeze_date: ${captured.capturedAt}
window_anchor: ${anchor}
---

# 49.2 BASELINE (FROZEN)

Frozen ${captured.capturedAt} at git ${anchor}. Immutable (PRED-POSTEDIT). A correction is a NEW dated addendum, never an edit.

| # | metric | value | unit | status | n | method |
|---|--------|-------|------|--------|---|--------|
${rows}
`
}

// ─────────────── 49.2-04 (D-49.2-10): subagent write-receipts + pack inheritance ───────

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
 * pretask-pack — the PreToolUse(matcher "Task") hook (49.2-04, D-49.2-10). Injects
 * the assembled context pack into every subagent spawn via `updatedInput` —
 * inheritance by construction. Acts ONLY on Task; anything else is a silent
 * pass-through. Kill-switch SMA_PACK_DISABLE=1 → no-op (compensating control:
 * subagent-verify still receipts every stop). HOOK_FACING: exit 0 always, never a
 * deny; every source fail-open. Measures durationMs, writes a spawn record, and
 * journals a `subagent-pack` event so the p95 SLO stays measurable in the field.
 */
async function cmdPretaskPack({ dirs }) {
  const evt = readStdinJson()
  if (!evt || evt.tool_name !== 'Task') return 0 // non-Task → silent pass-through
  if (isEnvOn(process.env.SMA_PACK_DISABLE)) return 0 // kill-switch → no-op

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
    printJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: assembled.pack } })
    return 0
  }

  printJson(packMod.buildUpdatedInput(evt, assembled.pack))
  return 0
}

/**
 * subagent-verify — the SubagentStop hook (49.2-04, D-49.2-10). Extracts every
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
 * subagent-receipts [--json] [--stat coverage|phantoms|pack-p95] — the report
 * (direct-CLI, may exit 1). Reads the shared journal via receiptStats. `--stat`
 * prints the bare numeric as the LAST line (the predict.mjs scorer contract — these
 * are this plan's three check_commands). Honest empty: zero spawns → coverage 100,
 * phantoms 0, pack-p95 0, flagged "empty" in --json.
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

  if (typeof flags.stat === 'string') {
    const map = { coverage: stats.coverage, phantoms: stats.phantoms, 'pack-p95': stats.packP95 }
    const key = flags.stat
    if (!(key in map)) {
      process.stderr.write(`SMA subagent-receipts: неизвестный --stat «${key}» (coverage|phantoms|pack-p95)\n`)
      process.stdout.write('0\n')
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

// ─────────────────────────── dispatch ────────────────────────────────────────

/** Subcommands whose failure must NEVER wedge a session (exit 0 unconditionally). */
// ── 49.2-07 (D-49.2-11): /sma-grill adversarial gate + blind verifier + evidence ───

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
 * grill — the adversarial challenge gate CLI (D-49.2-11). Modes:
 *   grill <plan> --challenge "promise::attack"        register a challenge
 *   grill <plan> --resolve <CH-id> --as converted --prediction <P-id>
 *   grill <plan> --resolve <CH-id> --as withdrawn|accepted-risk --reason|--disposition
 *   grill <plan> --gate                                print allowed/blocked; exit 1 if blocked
 *   grill <plan> --land <CH-id>                        tag a landed pre-push defect
 *   grill --pre-push [--budget 3]                      budget-aware pre-push depth plan
 *   grill --stats --metric challenge-yield             numeric last line (P49.2-07-A)
 * NOT hook-facing — the caller decides on the exit code.
 */
async function cmdGrill({ positionals, flags, dirs }) {
  const grill = await import('./lib/grill.mjs')
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()

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
    process.stderr.write('usage: pnpm sma grill <plan-path> [--challenge "promise::attack" | --resolve <CH-id> --as <status> | --gate | --land <CH-id>]\n')
    return 1
  }
  const planId = planIdFromPath(planPath)
  const by = await resolveTerminalId().catch(() => 'unknown')

  // --gate → the build gate verdict; exit 1 on blocked (caller decides).
  if (flags.gate) {
    const res = grill.grillGate({ planPath, planId, dirs })
    if (wantsJson(flags)) printJson(res)
    else if (!res.allowed) {
      process.stdout.write(`SMA grill [${planId}]: BLOCKED — ${res.open.length} нерешённых вызова(ов):\n`)
      for (const c of res.open) process.stdout.write(`  ${c.id}: «${c.promise}» ⟵ ${c.attack}\n`)
      process.stdout.write('Каждый вызов ДОЛЖЕН стать зарегистрированным предсказанием (--resolve --as converted --prediction <P-id>), быть отозван (--as withdrawn) или принят основателем (--as accepted-risk). До этого билд не стартует (D-49.2-11).\n')
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

  process.stderr.write('SMA grill: укажите один из режимов: --challenge | --resolve | --gate | --land | --pre-push | --stats\n')
  return 1
}

/**
 * blind-verify — tree-only re-derivation with the information barrier (D-49.2-11).
 *   blind-verify <plan>                        freeze blind verdicts, THEN compare claimed
 *   blind-verify --stats --metric divergence-count   numeric last line (P49.2-07-B)
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
    process.stdout.write(`\nРАСХОЖДЕНИЯ (claimed pass / blind fail) — тяжелейшее событие реестра, блокирует sma ship (CONS-49.2-07-A):\n`)
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
 * evidence — write a burden-of-proof record for a risky op (D-49.2-11).
 *   evidence <op> --target ... --reason ... --checked "a; b; c"
 *   evidence --stats --metric coverage         numeric last line (P49.2-07-C)
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
  // Journal the risky-op event referencing the evidenceId — the P49.2-07-C denominator.
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

const HOOK_FACING = new Set(['session-start', 'collision-check', 'heartbeat', 'reflex-check', 'gates-check', 'airbag-check', 'spend-check', 'stall-check', 'pre', 'pretask-pack', 'subagent-verify', 'precompact-capsule'])

/** subcommand → handler. Each handler lazy-imports its lib module. */
const HANDLERS = {
  status: cmdStatus,
  heartbeat: cmdHeartbeat,
  'session-start': cmdSessionStart,
  pre: cmdPre,
  'pre-bench': cmdPreBench,
  'collision-check': cmdCollisionCheck,
  'reflex-check': cmdReflexCheck,
  'gates-check': cmdGatesCheck,
  'airbag-check': cmdAirbagCheck, // 49.2-05 (D-49.2-08) — pre-less fallback for the airbag stream
  undo: cmdUndo, // 49.2-05 — one-action airbag restore
  airbag: cmdAirbag, // 49.2-05 — snapshot admin (list|prune|probe|stats)
  spend: cmdSpend, // 49.2-09 (D-49.2-13) — deterministic spend ledger report + set-cap + --stat scorer
  'spend-check': cmdSpendCheck, // 49.2-09 — pre-less fallback for the spend stream (budget reflexes + loop-breaker)
  breaker: cmdBreaker, // 49.2-09 — loop-breaker admin (list|re-arm)
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
  'build-index': cmdBuildIndex,
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
  reverify: cmdReverify, // 49.2-03 (D-49.2-06) — re-verify structural receipts
  'receipt-hash': cmdReceiptHash, // 49.2-03 — the receipt emit path
  'chain-tip': cmdChainTip, // 49.2-03 (D-49.2-07) — merged journal chain tip (release-tag pin)
  'chain-verify': cmdChainVerify, // 49.2-03 — tamper detector over the journal chain
  'pretask-pack': cmdPretaskPack, // 49.2-04 (D-49.2-10) — PreToolUse(Task) pack injection
  'subagent-verify': cmdSubagentVerify, // 49.2-04 — SubagentStop tree-verified receipts
  'subagent-receipts': cmdSubagentReceipts, // 49.2-04 — receipt coverage/phantoms/pack-p95 report
  'precompact-capsule': cmdPrecompactCapsule, // 49.2-06 (D-49.2-09) — PreCompact deterministic capsule
  resume: cmdResume, // 49.2-06 — continuation brief from the flight recorder
  handoff: cmdHandoff, // 49.2-06 — teammate brief + claim-transfer steps
  flight: cmdFlight, // 49.2-06 — flight instruments (probe|determinism-check|tail)
  grill: cmdGrill, // 49.2-07 (D-49.2-11) — adversarial challenge gate + budget-aware pre-push
  'blind-verify': cmdBlindVerify, // 49.2-07 — tree-only re-derivation + divergence detection
  evidence: cmdEvidence, // 49.2-07 — burden-of-proof records for risky ops
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const { positionals, flags } = parseArgs(argv.slice(1))

  if (!cmd || flags.help === true || cmd === 'help') {
    process.stdout.write(
      'pnpm sma <status|heartbeat|session-start|pre|pre-bench|collision-check|reflex-check|gates-check|airbag-check|undo|airbag|spend|spend-check|breaker|stall-check|gates-report|gates-ack|gates|claim|release|next-slot|tia|consume|force-clear|preship|disposition|lint|build-index|load|snapshot|upstream-check|predict-score|calibration|usage|consolidate|trim|state|exec-journal|metrics|report|bench|reverify|receipt-hash|chain-tip|chain-verify|pretask-pack|subagent-verify|subagent-receipts|precompact-capsule|resume|handoff|flight|grill|blind-verify|evidence>\n',
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
  .catch(() => process.exit(1))
