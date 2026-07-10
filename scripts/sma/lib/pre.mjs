/**
 * pre.mjs — the `sma pre` PreToolUse multiplexer dispatch core (49.2-02, D-49.2-04).
 *
 * ONE node run per Edit/Write/Bash tool call. Reads the hook event once, builds a
 * SHARED context (identity + heartbeat + seen-store loaded once), dispatches an
 * ordered internal stream pipeline (collision → reflex → gates, later + airbag +
 * spend), merges output under the carried-forward fail-open WARN / soft-deny
 * posture, and emits the single hookSpecificOutput object the harness consumes.
 *
 * ═══════════════════════════════ THE DISPATCH CONTRACT ═══════════════════════════
 *
 * This module is the CANONICAL SPEC downstream stream authors read before
 * registering. Plans 49.2-05 (git airbag) and 49.2-09 (spend ledger) each append
 * ONE stream object literal to the exported `PRE_CHECKS` array below — there is NO
 * dynamic registration API; consolidation is structural, one reviewable array in
 * one file, and the one-spawn guarantee never renegotiates.
 *
 * A stream is a plain object:
 *   {
 *     id:            string,                 // unique, stable — journal + sample key
 *     tools:         string[],               // subset of ['Edit','Write','Bash']
 *     killSwitchEnv: string | null,          // env var that skips ONLY this stream
 *     mayDeny:       boolean,                 // ONLY a mayDeny:true stream can deny
 *     run(ctx):      { warns: string[], deny?: { text } }   // never throws (wrapped)
 *   }
 *
 * POSTURE LOCKS (carried forward from V1/V2, D-49.1-12 / D-49-02):
 *   - Enforcement is fail-open WARN / soft-deny; hard-deny stays the security
 *     guard's alone. Only the gates stream carries mayDeny:true (soft-deny tier
 *     D-49.1-13). A `deny` returned by ANY other stream is DOWNGRADED to a warn
 *     line — a merge bug can never escalate WARN posture to a real deny.
 *   - Four independent fail-open layers protect every tool call: the HOOK_FACING
 *     exit-0 wrapper in cli.mjs, per-stream try/catch here, the SMA_PRE_DISABLE
 *     global kill-switch, and the soft time-budget that skips late streams rather
 *     than overrunning the harness timeout. A pre failure can NEVER wedge a session.
 *
 * Node built-ins only; every dependency is injectable so tests never touch the
 * real .sma or shell out. Zero npm deps, zero network, zero LLM (substrate law).
 */

import { join, dirname } from 'node:path'
import { appendFileSync, statSync, readFileSync, mkdirSync } from 'node:fs'

import { atomicWriteRaw, atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { CATALOG_REFRESH_CAP, PACK_ACTIVE_TTL_MS } from './constants.mjs'

/** Default soft time-budget: once cumulative stream time crosses this, remaining
 * streams are skipped (well inside the 5 s harness timeout). Env-overridable. */
export const DEFAULT_PRE_BUDGET_MS = 1500

/** Perf store rewrite trigger + retained tail — bounded telemetry (never unbounded). */
const PERF_MAX_BYTES = 256 * 1024
const PERF_KEEP_LINES = 500

// ── 49.3-06 (D-49.3-12): the maturation-ladder OVERLAY ───────────────────────
// A bounded, fail-open read of the TRACKED sma-ladder.json (repo root) — ONE
// readJsonSafe per tool call, memoized on ctx, inside the hook p95 <= 300 ms
// envelope. The overlay resolves each reflex/gate to its effective tier so a
// note/retired rule journals silently (quieter output, behavior still observable)
// and a soft-deny gate arms via checkEvent's INJECTABLE env (gates.mjs untouched).
// SMA_LADDER_OFF (its own STPA-compensated kill env) restores pure V2 behavior.

/** Load + memoize the ladder overlay on ctx (null when off/empty/missing). */
function loadLadderOverlay(ctx) {
  if (ctx._ladderOverlay !== undefined) return ctx._ladderOverlay
  let overlay = null
  try {
    if (!envOn(ctx.env.SMA_LADDER_OFF)) {
      const raw = readJsonSafe(join(ctx.repoRoot, 'sma-ladder.json'))
      if (raw && Array.isArray(raw.rules) && raw.rules.length) overlay = raw
    }
  } catch {
    overlay = null
  }
  ctx._ladderOverlay = overlay
  return overlay
}

/** The stored effective tier of a rule in the overlay (shipped default 'warn'). */
function overlayTierOf(overlay, ruleId) {
  if (!overlay || !Array.isArray(overlay.rules)) return 'warn'
  const row = overlay.rules.find((r) => r && r.ruleId === ruleId)
  return row && typeof row.tier === 'string' ? row.tier : 'warn'
}

// ─────────────────────────── the stream bodies ──────────────────────────────
// Each EXTRACTS the exact glue the legacy cmdCollisionCheck / cmdReflexCheck /
// cmdGatesCheck carried — same lib calls, same journal event kinds, same warn
// text — but reads/mutates the SHARED ctx.seen instead of loading its own copy.

/**
 * collision stream — scope-collision (Edit/Write touched path) + push-claim
 * (Bash git deploy) channels. WARN-only (D-49-02): mayDeny:false, no kill-switch.
 * Identity + the throttled heartbeat are resolved ONCE in buildCtx (moved out of
 * this stream so the heartbeat cadence survives even when collision is silent).
 */
async function runCollision(ctx) {
  const warns = []
  const { collision, registry, slots } = ctx.deps
  const identity = ctx.identity

  // (1) scope-collision channel (Edit/Write touched path).
  try {
    const candidatePaths = []
    if ((ctx.toolName === 'Edit' || ctx.toolName === 'Write') && typeof ctx.toolInput.file_path === 'string') {
      candidatePaths.push(ctx.toolInput.file_path)
    }
    if (candidatePaths.length && collision && registry) {
      const sessions = ctx.sessions
      // CR-01: pass the repo root so ABSOLUTE hook paths are relativized to
      // repo-relative BEFORE matching the repo-relative globs + HOT_FILES.
      const warnObjs = collision.checkScopeCollision(candidatePaths, {
        sessions,
        selfTerminalId: identity ? identity.terminalId : null,
        root: ctx.repoRoot,
      })
      for (const w of warnObjs) warns.push(collision.buildWarnText(w))
      // journal the collisions (tier:'warn' only; fail-open). FI-10: enrich the
      // who column with NAMED identities from the live leases.
      if (identity) {
        const own = sessions.find((sess) => sess._file === `${identity.terminalId}.json`)
        const selfDisplay = registry.displayIdentity({ holderIdentity: identity.holderIdentity, label: own && own.label })
        const ownerLabel = new Map((sessions || []).map((sess) => [sess.holderIdentity, sess.label]))
        for (const w of warnObjs) {
          w.whoDisplay = registry.displayIdentity({ holderIdentity: w.who, label: ownerLabel.get(w.who) })
        }
        collision.recordCollisions(warnObjs, { terminalId: identity.terminalId, selfDisplay, journalDir: ctx.dirs.journalDir })
      }
    }
  } catch {
    /* fail-open */
  }

  // (2) push-claim channel (Bash git deploy invocation) — D-49-02 second channel.
  // The two-word deploy invocation is detected with an ESCAPED regex so this
  // source file never carries the adjacent literal (SMA-3 discipline).
  try {
    if (ctx.toolName === 'Bash' && typeof ctx.toolInput.command === 'string' && slots) {
      const pushWord = ['push'].join('') // the deploy verb, isolated
      const deployRe = new RegExp('git\\s+' + pushWord)
      if (deployRe.test(ctx.toolInput.command)) {
        const pc = slots.checkPushClaim(ctx.dirs)
        if (pc && pc.live && pc.warn) warns.push(pc.warn)
      }
    }
  } catch {
    /* fail-open */
  }

  return { warns }
}

/**
 * reflex stream — the P2 reflex consumer (49.1-10). Derives tags → matches promoted
 * bug-lessons → applies the launch-blocking fatigue battery → journals each fire.
 * Mutates the SHARED ctx.seen (loaded/saved once by runPre, not here). WARN-only.
 * Kill-switch SMA_REFLEX_DISABLE (also honored by runPre before this runs).
 */
async function runReflex(ctx) {
  const warns = []
  const { reflex, loader, registry, journal } = ctx.deps
  try {
    if (!reflex || !loader) return { warns }
    const { tags, target, targetClass } = reflex.deriveTags(ctx.toolInput, ctx.repoRoot)
    if (!tags.length) return { warns }

    const corpusDir = join(ctx.repoRoot, '.claude', 'memory')
    const candidates = reflex.matchReflexes({
      tags,
      target,
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      loader,
    })
    if (!candidates.length) return { warns }

    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
    let whoDisplay = null
    try {
      if (ctx.identity && registry) whoDisplay = registry.displayIdentity({ holderIdentity: ctx.identity.holderIdentity })
    } catch {
      /* fail-open */
    }

    // Shared seen-store (loaded once in buildCtx) — applyFatigue mutates it in place.
    const res = reflex.applyFatigue({ candidates, targetClass, sessionSeen: ctx.seen, env: ctx.env })

    // 49.3-06 overlay: a rule demoted to 'note'/'retired' is journaled SILENTLY
    // (evidence keeps accruing — behavior stays observable) but EXCLUDED from the
    // additionalContext output. A rule at 'warn' (or absent from the overlay) is
    // unchanged. One bounded overlay read; fail-open leaves V2 behavior intact.
    const overlay = loadLadderOverlay(ctx)
    for (const w of res.warns) {
      const tier = overlay ? overlayTierOf(overlay, w.noteId) : 'warn'
      const silenced = tier === 'note' || tier === 'retired'
      if (!silenced) warns.push(w.text)
      // Journal each fire (event kind 'reflex') — stamped with the EFFECTIVE tier so a
      // later post-retire incident has re-arm evidence. Fail-open.
      if (journal) {
        try {
          journal.appendEvent(
            { type: 'reflex', actors: [whoDisplay ?? terminalId], scope: target, detail: { noteId: w.noteId, target, tier: silenced ? tier : w.tier } },
            { terminalId, journalDir: ctx.dirs.journalDir },
          )
        } catch {
          /* a journal failure never blocks the reflex */
        }
      }
    }
  } catch {
    /* fail-open (C9) */
  }
  return { warns }
}

/**
 * gates stream — the P4 enforcement consumer (49.1-16, D-49.1-12/13). Evaluates the
 * checkable HARD-RULE inventory (gates.checkEvent — which journals internally and
 * mutates the SHARED ctx.seen under 'gate:' keys). The ONLY mayDeny:true stream: an
 * armed soft-deny gate returns {deny:{text}}; dormant gates never set deny, so the
 * default posture stays WARN. Kill-switch SMA_GATES_DISABLE.
 */
async function runGates(ctx) {
  const warns = []
  const { gates } = ctx.deps
  try {
    if (!gates) return { warns }
    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'

    // 49.3-06 overlay: for each ladder gate rule at tier 'soft-deny', ARM the gate by
    // injecting its dormant softDeny.armEnv into checkEvent's env — the exact injectable
    // surface 49.2-10's shadow-run uses, run in reverse. gates.mjs stays byte-untouched;
    // the module's kill envs + SMA_GATES_DISABLE still win (they ride the same env).
    const overlay = loadLadderOverlay(ctx)
    let env = ctx.env
    const GATES = gates && Array.isArray(gates.GATES) ? gates.GATES : []
    if (overlay && GATES.length) {
      const armed = {}
      for (const row of overlay.rules) {
        if (row && row.kind === 'gate' && row.tier === 'soft-deny') {
          const g = GATES.find((x) => x.id === row.ruleId)
          if (g && g.softDeny && g.softDeny.armEnv) armed[g.softDeny.armEnv] = '1'
        }
      }
      if (Object.keys(armed).length) env = { ...ctx.env, ...armed }
    }

    const res = gates.checkEvent({
      evt: ctx.evt,
      root: ctx.repoRoot,
      env,
      seen: ctx.seen, // shared — checkEvent returns opts.seen, mutations land on ctx.seen
      journalDir: ctx.dirs.journalDir,
      terminalId,
      gatesDir: ctx.dirs.gatesDir,
      headSha: ctx.headSha,
      now: ctx.now(),
    })
    for (const w of res.warns) {
      // At tier 'auto-fix', NAME the deterministic fix verb (the hook never RUNS it —
      // execution is the explicit `tune fix` CLI verb, D-49.3-12 prohibition).
      if (overlay && overlayTierOf(overlay, w.gateId) === 'auto-fix') {
        warns.push(`${w.text}\nSMA ladder: детерминированный фикс — pnpm sma tune fix ${w.gateId}`)
      } else {
        warns.push(w.text)
      }
    }
    if (res.deny) return { warns, deny: { text: res.deny.text } }
  } catch {
    /* fail-open (C9) — a gate failure can NEVER wedge a session */
  }
  return { warns }
}

/**
 * airbag stream — the git airbag GATE (49.2-05, D-49.2-08). Bash-only: matches a
 * destructive git command and writes a ms-level recovery point (update-ref + stash
 * create + batched hash-object/mktree) BEFORE it runs, journaling an 'airbag' receipt.
 * mayDeny:true — an armed (SMA_AIRBAG_DENY) soft-deny on a dirty tree / foreign claim
 * surfaces permissionDecision 'deny' unless a GATE-AIRBAG override token is present.
 *
 * OPT-IN (CONS-49.2-B): the stream is a NO-OP unless SMA_AIRBAG_ENABLE is set —
 * plan 02's hook p95 MISSED the 300 ms SLO, so V3 streams stay opt-in until the
 * multiplexer re-measures under SLO. Protection stays UNCONDITIONAL once enabled
 * (the snapshot is not posture-gated; only the deny tier is). Kill: SMA_AIRBAG_DISABLE.
 */
async function runAirbag(ctx) {
  const warns = []
  try {
    // opt-in default-off until the multiplexer meets its SLO (CONS-49.2-B).
    if (!envOn(ctx.env.SMA_AIRBAG_ENABLE)) return { warns }
    if (ctx.toolName !== 'Bash') return { warns }
    const { airbag, slots } = ctx.deps
    if (!airbag) return { warns }
    const { execFileSync } = await import('node:child_process')
    // execFileSync-shaped runner over the repo root; buffer mode for blob bytes.
    // A FIXED argv array only — no fragment of the tool command ever enters it.
    const runGit = (args, opts = {}) =>
      execFileSync('git', args, { cwd: ctx.repoRoot, input: opts.input, encoding: opts.buffer ? 'buffer' : 'utf8' })
    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
    const res = airbag.checkAirbag(ctx.evt, {
      dirs: ctx.dirs,
      runGit,
      env: ctx.env,
      seen: ctx.seen, // shared — the stand-down note dedups under 'airbag:' keys
      now: () => ctx.now(),
      sessions: ctx.sessions,
      selfTerminalId: terminalId,
      slots,
      terminalId,
      repoRoot: ctx.repoRoot,
    })
    for (const w of res.warns) warns.push(w)
    if (res.deny && res.deny.text) return { warns, deny: { text: res.deny.text } }
  } catch {
    /* fail-open (C9) — an airbag bug can NEVER wedge a session */
  }
  return { warns }
}

/**
 * spend stream — the deterministic spend ledger reflexes (49.2-09, D-49.2-13). Applies
 * the locked 70/90 window-budget WARNs and the Task-ONLY soft-deny past a configured
 * cap (checkSpend), and detects+trips a repeatedly-firing SMA rule in the journal
 * (detectAndTrip). mayDeny:true — but checkSpend only ever denies the Task tool at
 * >=100% of a FOUNDER-CONFIGURED cap; every other tool is WARN-only forever.
 *
 * OPT-IN (CONS-49.2-09-B / CONS-49.2-B): the stream is a NO-OP unless SMA_SPEND_OPTIN
 * is set — plan 02's hook p95 MISSED the 300 ms SLO, so V3 streams stay opt-in until the
 * multiplexer re-measures under SLO (and P49.2-09-2 scores the warm spend-check <=50ms).
 * The mechanism ships complete + inert. Kill-switch: SMA_SPEND_DISABLE. Native probe true
 * → silent (bridge stood down). Fully fail-open — a spend/breaker bug never wedges a session.
 */
async function runSpend(ctx) {
  const warns = []
  try {
    // opt-in default-off until the multiplexer meets its SLO (CONS-49.2-09-B).
    if (!envOn(ctx.env.SMA_SPEND_OPTIN)) return { warns }
    const { spend, breaker } = ctx.deps
    if (!spend) return { warns }
    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'

    // Budget reflexes (70/90 WARN + Task-only soft-deny). Shares ctx.seen ('spend:' keys).
    const res = spend.checkSpend(
      { toolName: ctx.toolName, sessionId: ctx.sessionToken },
      { spendDir: ctx.dirs.spendDir, repoRoot: ctx.repoRoot, env: ctx.env, seen: ctx.seen, now: ctx.now() },
    )
    for (const w of res.warnings) warns.push(w)

    // Loop-breaker: soft-disable a repeatedly-firing SMA rule (writes a reviewable marker
    // consumed by plan 10's disarm-path guard). Best-effort — never blocks the tool call.
    try {
      if (breaker) {
        breaker.detectAndTrip({
          breakerDir: ctx.dirs.breakerDir,
          journalDir: ctx.dirs.journalDir,
          by: terminalId,
          terminalId,
          now: ctx.now(),
        })
      }
    } catch {
      /* fail-open */
    }

    if (res.deny && res.deny.reason) return { warns, deny: { text: res.deny.reason } }
  } catch {
    /* fail-open (C9) — a spend/breaker bug can NEVER wedge a session or falsely deny */
  }
  return { warns }
}

/**
 * fingerprint stream — the live work fingerprint's INJECTION side (49.3-13, D-49.3-21c).
 * WARN-only (mayDeny:false), kill-switch SMA_FINGERPRINT_DISABLE. Two channels, never
 * per-tool-call spam: (1) an IMMEDIATE full-fingerprint injection of any OTHER terminal
 * whose fingerprint overlaps the file A just touched; (2) an AMBIENT digest of all live
 * terminals, throttled to ~AMBIENT_DIGEST_MS via the shared seen-store (a renewTime-age
 * compare — NEVER a timer, ZERO extra write: the throttle stamp rides ctx.seen which runPre
 * already saves once). Strict NO-OP when no other live terminal exists (Test 7). The
 * self-capture side (recordTouch onto the OWN lease) happens in buildCtx, riding the
 * existing once-per-tool-call heartbeat (zero new spawns). Fully fail-open (C9).
 */
async function runFingerprint(ctx) {
  const warns = []
  try {
    const { fingerprint } = ctx.deps
    if (!fingerprint) return { warns }
    const selfTerm = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : null
    const others = (ctx.sessions || []).filter((s) => s && s._file !== `${selfTerm}.json`)
    if (!others.length) return { warns } // strict no-op when alone (Test 7)

    // (1) overlap injection — immediate, the FULL fingerprint of any overlapping terminal.
    try {
      if ((ctx.toolName === 'Edit' || ctx.toolName === 'Write') && typeof ctx.toolInput.file_path === 'string') {
        const fps = fingerprint.overlapInjection({
          ownTouch: ctx.toolInput.file_path,
          sessions: ctx.sessions,
          selfTerminalId: selfTerm,
          now: ctx.now(),
          root: ctx.repoRoot,
        })
        for (const fp of fps) warns.push(fingerprint.renderFingerprint(fp))
      }
    } catch {
      /* fail-open */
    }

    // (2) ambient digest — throttled ~10 min via the shared seen-store (zero extra write).
    try {
      const key = 'fingerprint:lastDigest'
      const notes = ctx.seen && ctx.seen.notes ? ctx.seen.notes : null
      const lastDigestAt = notes && Number.isFinite(notes[key]) ? notes[key] : 0
      const dg = fingerprint.ambientDigest({
        sessions: ctx.sessions,
        lastDigestAt,
        now: ctx.now(),
        selfTerminalId: selfTerm,
      })
      if (!dg.skipped && Array.isArray(dg.lines) && dg.lines.length) {
        for (const line of dg.lines) warns.push(line)
        if (notes) notes[key] = ctx.now() // stamp the throttle; runPre persists ctx.seen once
      }
    } catch {
      /* fail-open */
    }
  } catch {
    /* fail-open (C9) — a fingerprint bug can NEVER wedge a session */
  }
  return { warns }
}

/**
 * context stream — knowledge delivery AT the act (49.3-05, D-49.3-06/07). WARN-only
 * (mayDeny:false), kill-switch SMA_CONTEXT_DISABLE, registered LAST so 49.2-02's soft
 * time-budget sacrifices delivery/refresh before any enforcement stream — knowledge is
 * never bought with enforcement latency. STRICT NO-OP when no catalog, no fragments, and
 * no active pack exist, so installing SMA changes nothing until the user opts in by
 * building a catalog (this is what keeps the pre-bench parity metric at 0). Four parts,
 * each individually try/caught (fail-open at every layer — substrate law):
 *   (a) opt-in guard first;
 *   (b) fragment delivery at the act (trigger-matched, capped, session-fatigued, cited 'fire');
 *   (c) refresh on commit (HEAD moved past the catalog commit → incrementally re-card the
 *       changed files if <= CATALOG_REFRESH_CAP, else defer to an explicit `catalog refresh`);
 *   (d) touch journaling (Edit/Write path → the active pack's touched.jsonl — the raw
 *       material scorePurity + growExam consume).
 */
async function runContext(ctx) {
  const warns = []
  try {
    const { catalog, fragments, citations, reflex } = ctx.deps
    if (!catalog || !fragments) return { warns }
    const corpusDir = join(ctx.repoRoot, '.claude', 'memory')

    // (a) OPT-IN GUARD — a strict no-op until the user builds a catalog / adds fragments /
    // compiles a pack. This is what keeps installation behavior-neutral (pre-bench parity 0).
    let stored = null
    try {
      stored = catalog.readCatalog({ catalogDir: ctx.dirs.catalogDir, readFile: (p) => readFileSync(p, 'utf8') })
    } catch {
      stored = null
    }
    const catalogBuilt = !!(stored && stored.built)
    let fragList = []
    try {
      fragList = fragments.listFragments({ corpusDir })
    } catch {
      fragList = []
    }
    let active = null
    try {
      active = readJsonSafe(join(ctx.dirs.contextDir, 'active.json'))
    } catch {
      active = null
    }
    if (!catalogBuilt && fragList.length === 0 && !active) return { warns } // the documented no-op

    const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
    const derived = reflex ? safeDeriveTags(reflex, ctx.toolInput, ctx.repoRoot) : { tags: [], target: '' }

    // (b) FRAGMENT DELIVERY AT THE ACT — trigger-matched, capped, session-fatigued, cited 'fire'.
    try {
      if (fragList.length) {
        const cite = (fragId) => {
          try {
            if (citations) {
              citations.recordCitation(
                { noteId: 'frag:' + fragId, kind: 'fire', terminal: terminalId, session: ctx.sessionToken ?? null },
                { usageDir: ctx.dirs.usageDir },
              )
            }
          } catch {
            /* fail-open — a citation never breaks delivery */
          }
        }
        const res = fragments.deliverFragments({
          toolName: ctx.toolName,
          toolInput: ctx.toolInput,
          tags: derived.tags,
          fragments: fragList,
          seen: ctx.seen, // shared 'frag:' namespace — runPre persists it once
          cite,
        })
        for (const frag of res.delivered) warns.push(`[frag ${frag.id}] ${frag.body}`)
      }
    } catch {
      /* fail-open */
    }

    // (c) REFRESH ON COMMIT — bounded, silent. Only fires when HEAD has moved past the catalog.
    try {
      if (catalogBuilt) {
        const { execFileSync } = await import('node:child_process')
        const execGit = (args) => execFileSync('git', args, { cwd: ctx.repoRoot, encoding: 'utf8' })
        let head = ''
        try {
          head = execGit(['rev-parse', '--short', 'HEAD']).trim()
        } catch {
          head = ''
        }
        if (head && stored.commit && stored.commit !== head) {
          const changed = []
          const deleted = []
          try {
            const diff = execGit(['diff', '--name-status', stored.commit, 'HEAD'])
            for (const line of String(diff).split('\n')) {
              const t = line.replace(/\r$/, '')
              if (!t.trim()) continue
              const parts = t.split('\t')
              if (parts[0].startsWith('D')) deleted.push(parts[1])
              else if (parts[0].startsWith('R')) { deleted.push(parts[1]); changed.push(parts[2]) }
              else changed.push(parts[1])
            }
          } catch {
            /* fail-open */
          }
          const touched = changed.length + deleted.length
          if (touched > 0 && touched <= CATALOG_REFRESH_CAP) {
            // ONE scoped git-log pass gives full history stats for just the changed files.
            const gitStats = {}
            try {
              if (changed.length) {
                const raw = execGit(['log', '--format=%H|%cI', '--name-only', '--', ...changed])
                let curDate = null
                for (const line of String(raw).split('\n')) {
                  const t = line.replace(/\r$/, '')
                  if (/^[0-9a-f]{7,40}\|/.test(t)) { curDate = t.split('|')[1] || null; continue }
                  const p = t.trim()
                  if (!p || curDate == null) continue
                  if (!gitStats[p]) gitStats[p] = { lastCommit: curDate, commits: 0 }
                  gitStats[p].commits += 1
                }
              }
            } catch {
              /* fail-open */
            }
            const readFile = (p) => readFileSync(join(ctx.repoRoot, p), 'utf8')
            const refreshed = catalog.refreshCatalog({ catalog: stored, changed, deleted, readFile, gitStats, commit: head })
            catalog.writeCatalog({ catalog: refreshed, catalogDir: ctx.dirs.catalogDir })
          }
          // touched > CATALOG_REFRESH_CAP → skip silently (an explicit `catalog refresh` handles it).
        }
      }
    } catch {
      /* fail-open — a refresh bug never wedges the tool call */
    }

    // (d) TOUCH JOURNALING — Edit/Write path → the active pack's touched.jsonl (v1 read proxy).
    try {
      if (active && active.packId && (ctx.toolName === 'Edit' || ctx.toolName === 'Write')) {
        const age = ctx.now() - (Number(active.activatedAt) || 0)
        if (age >= 0 && age < PACK_ACTIVE_TTL_MS && derived.target) {
          const touchedFile = join(ctx.dirs.contextDir, 'packs', active.packId, 'touched.jsonl')
          try {
            mkdirSync(dirname(touchedFile), { recursive: true })
            appendFileSync(touchedFile, JSON.stringify({ ts: new Date().toISOString(), path: derived.target, windowToken: ctx.sessionToken ?? null }) + '\n')
          } catch {
            /* fail-open — a journal failure never blocks the tool call */
          }
        }
      }
    } catch {
      /* fail-open */
    }
  } catch {
    /* fail-open (C9) — a context-stream bug can NEVER wedge a session */
  }
  return { warns }
}

/**
 * enforce stream — enforcing scopes (49.3-15, D-49.3-24c/f). SOFT-deny-with-override
 * (mayDeny:true), OPT-IN default-off behind SMA_ENFORCE_SCOPES (strict no-op until the
 * operator opts in — installation changes nothing), kill-switch SMA_ENFORCE_SCOPES_DISABLE.
 * It soft-denies an Edit/Write ONLY when it overlaps a VERIFIED-LIVE foreign claim (fresh
 * touches via plan 13's fingerprint overlap = the live signal; the evidence decision is
 * mergeGate.enforceScope over collision.verifyClaimEvidence — ONE evidence source). A
 * stale/unverified overlap stays WARN; a soft-deny always carries an override token.
 * Fully fail-open (C9): any error -> {warns:[]}, NEVER a hard block, NEVER a wedge; hard
 * deny stays the security guard's alone and the founder word (D-49-09) always wins.
 */
async function runEnforce(ctx) {
  const warns = []
  try {
    // OPT-IN default-off — strict no-op until the operator sets SMA_ENFORCE_SCOPES (Test 8).
    if (!envOn(ctx.env.SMA_ENFORCE_SCOPES)) return { warns }
    if (!(ctx.toolName === 'Edit' || ctx.toolName === 'Write')) return { warns }
    if (typeof ctx.toolInput.file_path !== 'string' || !ctx.toolInput.file_path.trim()) return { warns }

    const { mergeGate, collision, fingerprint } = ctx.deps
    if (!mergeGate) return { warns }
    const selfTerm = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : null

    // The overlapping LIVE foreign terminal(s) via plan 13's fingerprint overlap — the
    // "fresh touches + live heartbeat" signal, reused (NOT re-derived). No overlap -> no-op.
    let overlaps = []
    try {
      if (fingerprint) {
        overlaps =
          fingerprint.overlapInjection({
            ownTouch: ctx.toolInput.file_path,
            sessions: ctx.sessions,
            selfTerminalId: selfTerm,
            now: ctx.now(),
            root: ctx.repoRoot,
          }) || []
      }
    } catch {
      overlaps = []
    }
    if (!overlaps.length) return { warns } // no verified-live overlap -> nothing to enforce

    // Build the foreign claim + its evidence from the freshest overlap. A live fingerprint
    // overlap is a busy scope (dirty vs HEAD, no post-renew in-scope commit) -> verifyClaimEvidence
    // marks it LIVE -> enforceScope soft-denies. The one evidence source decides, not this stream.
    const fp = overlaps[0] || {}
    const foreignClaim = { by: fp.who || fp.terminalId || fp.holderIdentity || 'T-?', intent: fp.intent }
    const evidence = { claim: foreignClaim, scopeDirtyVsHead: true, mtimeAgeMin: fp.mtimeAgeMin }

    const decision = mergeGate.enforceScope({
      ownTouch: ctx.toolInput.file_path,
      foreignClaim,
      evidence,
      env: ctx.env,
      verifyClaimEvidence: collision ? collision.verifyClaimEvidence : undefined,
    })

    if (decision && decision.action === 'soft-deny') {
      // SOFT-deny — the deny text carries the override token so it can NEVER block real work.
      return { warns, deny: { text: [decision.text, decision.override].filter(Boolean).join('\n') } }
    }
    if (decision && decision.action === 'warn' && decision.text) warns.push(decision.text)
  } catch {
    /* fail-open (C9) — an enforce bug can NEVER wedge a session or falsely hard-deny */
  }
  return { warns }
}

/** deriveTags wrapper that never throws (returns {tags:[], target:''} on any error). */
function safeDeriveTags(reflex, toolInput, repoRoot) {
  try {
    const d = reflex.deriveTags(toolInput, repoRoot)
    return { tags: Array.isArray(d.tags) ? d.tags : [], target: typeof d.target === 'string' ? d.target : '' }
  } catch {
    return { tags: [], target: '' }
  }
}

/**
 * PRE_CHECKS — the ordered internal dispatch pipeline (D-49.2-04). THE registration
 * point plans 05 (airbag), 09 (spend), 13 (fingerprint) and 49.3-05 (context) extend:
 * each appends one stream object literal here. Order is emit order for warns. collision +
 * fingerprint + context are WARN-only; gates + airbag + spend are the deny-capable streams
 * (airbag + spend are opt-in until the SLO is met). `context` sits LAST so the soft
 * time-budget sacrifices delivery/refresh before any enforcement stream.
 */
export const PRE_CHECKS = [
  { id: 'collision', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: null, mayDeny: false, run: runCollision },
  { id: 'reflex', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: 'SMA_REFLEX_DISABLE', mayDeny: false, run: runReflex },
  { id: 'gates', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: 'SMA_GATES_DISABLE', mayDeny: true, run: runGates },
  { id: 'airbag', tools: ['Bash'], killSwitchEnv: 'SMA_AIRBAG_DISABLE', mayDeny: true, run: runAirbag },
  { id: 'spend', tools: ['Edit', 'Write', 'Bash', 'Task'], killSwitchEnv: 'SMA_SPEND_DISABLE', mayDeny: true, run: runSpend },
  { id: 'fingerprint', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: 'SMA_FINGERPRINT_DISABLE', mayDeny: false, run: runFingerprint },
  // 49.3-15 (D-49.3-24c/f) — enforcing scopes: SOFT-deny-with-override, opt-in default-off
  // (SMA_ENFORCE_SCOPES), verified-live-only, fail-open. mayDeny:true = soft-deny tier ONLY,
  // never a hard block. Positioned after fingerprint (whose overlap it consumes), before context.
  { id: 'enforce', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: 'SMA_ENFORCE_SCOPES_DISABLE', mayDeny: true, run: runEnforce },
  { id: 'context', tools: ['Edit', 'Write', 'Bash'], killSwitchEnv: 'SMA_CONTEXT_DISABLE', mayDeny: false, run: runContext },
]

// ─────────────────────────── shared context ─────────────────────────────────

/** windowToken from the hook event's session_id (constant across one window). */
function windowTokenFrom(evt) {
  const t = evt && typeof evt.session_id === 'string' ? evt.session_id.trim() : ''
  return t || null
}

/** Truthy env-flag test (matches the reflex/gates kill-switch convention). */
function envOn(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

/** Real git HEAD sha probe (read-only, fail-open → null). Injectable for tests. */
async function realGitHeadSha(repoRoot) {
  try {
    const { execFileSync } = await import('node:child_process')
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** Lazy-load the real lib modules the streams depend on (overridable in tests). */
async function loadDefaultDeps() {
  const [collision, reflex, gates, loader, slots, journal, registry, airbag, spend, breaker, fingerprint, catalog, fragments, citations, mergeGate] =
    await Promise.all([
      import('./collision.mjs'),
      import('./reflex.mjs'),
      import('./gates.mjs'),
      import('./loader.mjs'),
      import('./slots.mjs'),
      import('./journal.mjs'),
      import('./registry.mjs'),
      import('./airbag.mjs'),
      import('./spend.mjs'),
      import('./breaker.mjs'),
      import('./fingerprint.mjs'),
      import('./catalog.mjs'), // 49.3-05 (D-49.3-06) — context stream: catalog read/refresh
      import('./fragments.mjs'), // 49.3-05 (D-49.3-07) — context stream: fragment delivery
      import('./citations.mjs'), // 49.3-05 — fragment fires ride the SAME usage journal
      import('./merge-gate.mjs'), // 49.3-15 (D-49.3-24c/f) — enforce stream: verified-live-only soft-deny predicate
    ])
  return { collision, reflex, gates, loader, slots, journal, registry, airbag, spend, breaker, fingerprint, catalog, fragments, citations, mergeGate }
}

/**
 * buildCtx({ evt, dirs, env, now, deps, headShaProbe }) — the shared context, built
 * ONCE per tool call. Parses the event; resolves terminal identity ONCE and fires
 * the throttled heartbeat ONCE (moved here so cadence survives a silent collision);
 * reads the sessions snapshot ONCE; loads the per-session seen-store ONCE into
 * ctx.seen (fixes the V2 last-write-wins race: reflex + gates each load+save it
 * today across two processes). Every fallible step is individually try/caught —
 * identity may be null and streams tolerate it, exactly as today.
 */
export async function buildCtx(opts = {}) {
  const evt = opts.evt || {}
  const dirs = opts.dirs || {}
  const env = opts.env || {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const deps = opts.deps || (await loadDefaultDeps())
  const headShaProbe = typeof opts.headShaProbe === 'function' ? opts.headShaProbe : realGitHeadSha

  const toolName = evt && typeof evt.tool_name === 'string' ? evt.tool_name : ''
  const toolInput = (evt && evt.tool_input) || {}
  const sessionToken = windowTokenFrom(evt)
  const repoRoot = dirs.smaRoot ? dirname(dirs.smaRoot) : process.cwd()

  const ctx = {
    evt,
    dirs,
    env,
    now,
    deps,
    toolName,
    toolInput,
    sessionToken,
    repoRoot,
    identity: null,
    sessions: [],
    seen: sessionToken ? { session: sessionToken, keys: {}, notes: {} } : { keys: {}, notes: {} },
    headSha: null,
  }

  // Terminal identity ONCE + throttled heartbeat ONCE (OQ2 cadence).
  try {
    if (deps.registry) {
      ctx.identity = deps.registry.resolveTerminalIdentity({ sessionToken })
      deps.registry.heartbeat(
        { scope: { globs: [], description: '' }, status: 'working' },
        { ...dirs, identity: ctx.identity },
      )
    }
  } catch {
    /* fail-open — identity stays null, streams tolerate it */
  }

  // Sessions snapshot ONCE (collision stream reads it).
  try {
    if (deps.registry) {
      const read = deps.registry.readSessions(dirs)
      ctx.sessions = (read && Array.isArray(read.sessions)) ? read.sessions : []
    }
  } catch {
    /* fail-open — no session read */
  }

  // 49.3-13 (D-49.3-21a): fingerprint SELF-CAPTURE. Append THIS tool's own file_path to the
  // terminal's OWN lease filesRecent[] — riding the once-per-tool-call buildCtx (ZERO new
  // spawn; a targeted atomicWriteJson, NOT a heartbeat, so it never fires the detached
  // snapshot child). Attribution is SELF-CAPTURE only (never a git-status read — on a shared
  // tree git status is the UNION of all terminals). Fail-open: any error is a no-op.
  try {
    if (
      deps.fingerprint &&
      ctx.identity &&
      (toolName === 'Edit' || toolName === 'Write') &&
      typeof toolInput.file_path === 'string' &&
      toolInput.file_path.trim()
    ) {
      const sessionsDir = dirs.sessionsDir || join(dirs.smaRoot || join(repoRoot, '.sma'), 'sessions')
      const leaseFile = join(sessionsDir, `${ctx.identity.terminalId}.json`)
      const own = ctx.sessions.find((s) => s._file === `${ctx.identity.terminalId}.json`) || readJsonSafe(leaseFile)
      if (own) {
        const filesRecent = deps.fingerprint.recordTouch({ lease: own, filePath: toolInput.file_path, now: now() })
        const updated = { ...own, filesRecent }
        delete updated._file // never persist the reader-only file marker
        atomicWriteJson(leaseFile, updated)
      }
    }
  } catch {
    /* fail-open — a self-capture failure never wedges the tool call */
  }

  // Seen-store ONCE — the shared store reflex + gates both mutate (race fix).
  try {
    if (deps.reflex) {
      const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
      ctx.seen = deps.reflex.loadSeen({ reflexDir: dirs.reflexDir, terminalId, sessionToken })
    }
  } catch {
    /* fail-open — fresh seen already set */
  }

  // HEAD sha ONCE (gates soft-deny evidence) — skip the git probe when gates is
  // killed (parity: the legacy gates-check early-exited before probing).
  try {
    if (!envOn(env.SMA_GATES_DISABLE)) ctx.headSha = await headShaProbe(repoRoot)
  } catch {
    ctx.headSha = null
  }

  return ctx
}

// ─────────────────────────── the dispatch loop ──────────────────────────────

/**
 * runPre(ctx) → { warns, deny, sample }. Iterates PRE_CHECKS in order:
 *   - SMA_PRE_DISABLE global early-exit (instant no-op, no stream invoked);
 *   - filters by ctx.toolName ∈ stream.tools and the stream's kill-switch;
 *   - per-stream try/catch + elapsed timing via ctx.now;
 *   - soft budget (SMA_PRE_BUDGET_MS, default 1500): once cumulative time is
 *     exceeded, remaining applicable streams are SKIPPED and recorded — late is
 *     skipped, never blocking;
 *   - collects warns IN ORDER; accepts a deny ONLY from a mayDeny stream (first
 *     wins); downgrades any other stream's deny to a warn line (posture protection);
 *   - saves ctx.seen ONCE at the end.
 * Never throws.
 */
export async function runPre(ctx) {
  const warns = []
  let deny = null
  const checks = []
  const t0 = ctx.now()

  if (envOn(ctx.env.SMA_PRE_DISABLE)) {
    return { warns, deny, sample: { ts: new Date().toISOString(), toolName: ctx.toolName, totalMs: 0, checks, disabled: true } }
  }

  const budget = Number(ctx.env.SMA_PRE_BUDGET_MS) > 0 ? Number(ctx.env.SMA_PRE_BUDGET_MS) : DEFAULT_PRE_BUDGET_MS
  let budgetBlown = false

  for (const stream of PRE_CHECKS) {
    // tool-applicability filter.
    if (!Array.isArray(stream.tools) || !stream.tools.includes(ctx.toolName)) continue
    // per-stream kill-switch.
    if (stream.killSwitchEnv && envOn(ctx.env[stream.killSwitchEnv])) continue

    // soft time-budget: once blown, remaining applicable streams are skipped.
    if (budgetBlown) {
      checks.push({ id: stream.id, ms: 0, warns: 0, skipped: true })
      continue
    }

    const s0 = ctx.now()
    let result = { warns: [] }
    let errored = false
    try {
      result = (await stream.run(ctx)) || { warns: [] }
    } catch {
      errored = true // per-stream fail-open (test 3) — remaining streams still run
      result = { warns: [] }
    }
    const ms = Math.max(0, ctx.now() - s0)

    const streamWarns = Array.isArray(result.warns) ? result.warns.filter((w) => typeof w === 'string' && w) : []
    for (const w of streamWarns) warns.push(w)

    // deny handling — posture protection: only a mayDeny stream can surface a deny.
    if (result.deny && result.deny.text) {
      if (stream.mayDeny) {
        if (!deny) deny = { text: String(result.deny.text) }
      } else {
        // DOWNGRADE a non-gates deny to a warn line — never a real deny (test 2).
        warns.push(String(result.deny.text))
      }
    }

    const sample = { id: stream.id, ms, warns: streamWarns.length }
    if (errored) sample.error = true
    checks.push(sample)

    if (ctx.now() - t0 > budget) budgetBlown = true
  }

  // Save the shared seen-store ONCE (both reflex + gates mutations persisted).
  try {
    if (ctx.deps && ctx.deps.reflex) {
      const terminalId = ctx.identity && ctx.identity.terminalId ? ctx.identity.terminalId : 'unknown'
      ctx.deps.reflex.saveSeen(ctx.seen, { reflexDir: ctx.dirs.reflexDir, terminalId })
    }
  } catch {
    /* fail-open — a save failure only costs dedup on the NEXT invocation */
  }

  const totalMs = Math.max(0, ctx.now() - t0)
  return { warns, deny, sample: { ts: new Date().toISOString(), toolName: ctx.toolName, totalMs, checks } }
}

// ─────────────────────────── output merge ───────────────────────────────────

/**
 * mergeOutput({ warns, deny }) → the SINGLE hookSpecificOutput object (or null).
 * deny → permissionDecision 'deny' with the deny text + any collected warns as the
 * reason; warns-only → 'allow' + additionalContext; empty → null (silent success,
 * today's behavior — the harness gets nothing).
 */
export function mergeOutput({ warns = [], deny = null } = {}) {
  const lines = Array.isArray(warns) ? warns.filter((w) => typeof w === 'string' && w) : []
  if (deny && deny.text) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [deny.text, ...lines].join('\n'),
      },
    }
  }
  if (lines.length) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: lines.join('\n'),
      },
    }
  }
  return null
}

// ─────────────────────────── perf telemetry ─────────────────────────────────

/**
 * appendPerfSample(sample, { perfDir, appendFn, statFn, readFn, writeRawFn }) —
 * append one JSONL line to perfDir/pre.jsonl (bounded: when the file exceeds
 * ~256 KB it is atomically rewritten keeping the last 500 lines). Every fs call is
 * injectable so tests never write to disk. Fail-open — a perf-store failure never
 * blocks the hook.
 */
export function appendPerfSample(sample, opts = {}) {
  const perfDir = opts.perfDir
  if (!perfDir) return
  const appendFn = opts.appendFn ?? appendFileSync
  const statFn = opts.statFn ?? statSync
  const readFn = opts.readFn ?? readFileSync
  const writeRawFn = opts.writeRawFn ?? atomicWriteRaw
  const mkdirFn = opts.mkdirFn ?? mkdirSync
  const file = join(perfDir, 'pre.jsonl')
  try {
    mkdirFn(perfDir, { recursive: true })
    appendFn(file, JSON.stringify(sample) + '\n')
    // bound the file: rewrite to the last PERF_KEEP_LINES once it grows past cap.
    let size = 0
    try {
      size = statFn(file).size
    } catch {
      size = 0
    }
    if (size > PERF_MAX_BYTES) {
      const lines = String(readFn(file, 'utf8')).split('\n').filter((l) => l.trim())
      const tail = lines.slice(-PERF_KEEP_LINES).join('\n') + '\n'
      writeRawFn(file, tail)
    }
  } catch {
    /* fail-open — perf telemetry is best-effort */
  }
}

/**
 * computePercentile(values, p) → the nearest-rank percentile (pins pre-bench's
 * arithmetic; identical method to bench.mjs's percentile). Empty → 0.
 */
export function computePercentile(values, p) {
  const nums = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v))
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}
