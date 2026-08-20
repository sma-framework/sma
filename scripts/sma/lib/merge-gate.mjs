/**
 * merge-gate.mjs — the serialized merge gate + the verified-live-only
 * enforcing-scope predicate.
 *
 * ═══════════════════════════ THE MERGE RITUAL ═══════════════════════════════════
 *
 * A worktree branch enters `main` ONLY through `runMerge`, under a
 * merge-claim slot, IN ORDER:
 *   1. acquire the `merge-in-progress` slot  (a concurrent merge -> SOFT-deny + override)
 *   2. merge the branch into main LOCALLY    (mock/real execGit — NEVER a push, NEVER a deploy)
 *   3. run targeted tests on the MERGE RESULT (the injected runTests, not either branch alone)
 *   4. journal a receipt                      (branch, result-sha, tests pass OR fail — honestly)
 *   5. release the slot
 * This kills «your push carried my half-built work»: integration is serialized, tested
 * on the merged tree, receipted, and LOCAL. `git push` is explicitly OUT of scope — push
 * stays founder-ordered via /sma-ship (slots.mjs header law, unchanged).
 *
 * ═══════════════════════════ CONSUME-NEVER-REIMPLEMENT ══════════════════════════
 *
 * The merge-claim triplet (acquire/release/check) mirrors slots.mjs's push-claim triplet
 * near line-for-line, built on claims.mjs's claimSlot/releaseSlot mkdir-EEXIST primitive
 * (`claimSlot('merge-in-progress', …)`, NO new directory, NO bespoke lockfile). The
 * enforcing check reuses verifyClaimEvidence (collision.mjs) for the
 * verified-LIVE-vs-stale decision — ONE evidence source, never a second logic.
 *
 * ═══════════════════════════ POSTURE LOCKS (carried) ════════════════════════════
 *
 *   - The C9 fail-open wrapper is absolute: any error in runMerge or enforceScope
 *     degrades to an honest failure / allow, releasing any held slot — a gate bug can
 *     NEVER wedge a session and NEVER leave a slot stuck.
 *   - enforceScope is SOFT-deny-with-override ONLY (mayDeny tier). Hard deny remains the
 *     security guard's alone. The founder word always wins: releaseSlot's
 *     foreign-claim refusal + force-clear provenance are inherited unchanged, and a
 *     cooling-down / force-cleared scope is NEVER enforced.
 *
 * Node built-ins only; everything DI (execGit + runTests + claimsDir + journalDir +
 * verifyClaimEvidence injected) so tests never run a real merge, never touch the real
 * `.sma/`, never spend a token. Zero npm deps.
 */

import { execFileSync } from 'node:child_process'

import { claimSlot, releaseSlot, readClaims } from './claims.mjs'
import { appendEvent } from './journal.mjs'
import { MERGE_CLAIM_TTL_MS, MERGE_SLOT_NAME } from './constants.mjs'

// Re-export the slot name so consumers import the merge contract from one place.
export { MERGE_SLOT_NAME } from './constants.mjs'

/**
 * The override instruction a SOFT-deny carries — the legitimate escape hatch so an
 * enforcing soft-deny can NEVER block real work. Plain RU (shareholder-facing).
 */
export const ENFORCE_OVERRIDE_HINT =
  'переопределить (если правка действительно нужна): SMA_ENFORCE_SCOPES_DISABLE=1 для этого вызова, ' +
  'либо согласуйте со владельцем скоупа; если claim завис — node scripts/sma/cli.mjs force-clear <scope>'

/** Default real git runner: execFileSync with an args ARRAY (no shell interpolation). */
export function defaultExecGit(args, opts = {}) {
  return execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' })
}

/**
 * journalOpt(o) — the appendEvent dir opt for merge-slot events. Prefer an explicit
 * journalDir; fall back to claimsDir for callers that only pass that (legacy parity with
 * slots.mjs); default to {} (the constants-derived JOURNAL_DIR) when neither is supplied.
 */
function journalOpt(o) {
  if (o && o.journalDir) return { journalDir: o.journalDir }
  if (o && o.claimsDir) return { journalDir: o.claimsDir }
  return {}
}

/** Truthy env-flag test (matches the reflex/gates kill-switch convention). */
function envOn(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

// ── the merge-claim triplet — mirrors slots.mjs's push-claim triplet ────────────────

/**
 * acquireMergeClaim({by, session, branch, claimsDir}) — win the single
 * `merge-in-progress` advisory slot via claimSlot (mkdir-EEXIST). This serializes
 * integration: a second concurrent acquire returns {acquired:false, holder} (never a
 * throw). The branch rides in `reason` as a suffix so checkMergeClaim can read it back
 * without changing the claim's provenance stamp. Returns {acquired, holder?}.
 */
export function acquireMergeClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const terminalId = o.by ?? 'unknown'
  const branch = o.branch ?? null
  const res = claimSlot(
    MERGE_SLOT_NAME,
    {
      by: o.by,
      session: o.session ?? null,
      expectedPrev: null,
      reason: branch ? `merge-in-progress:${branch}` : 'merge-in-progress',
    },
    claimOpts,
  )
  if (res.won) {
    appendEvent(
      { type: 'claim', scope: MERGE_SLOT_NAME, detail: { branch } },
      { terminalId, ...journalOpt(o) },
    )
    return { acquired: true }
  }
  return { acquired: false, holder: res.holder ?? null }
}

/**
 * releaseMergeClaim({by, claimsDir}) — release the caller's OWN merge claim. A foreign
 * claim is refused by releaseSlot (P3) — force-clear lives in the interactive
 * CLI, never here.
 */
export function releaseMergeClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const terminalId = o.by ?? 'unknown'
  const res = releaseSlot(MERGE_SLOT_NAME, { by: o.by, ...claimOpts })
  if (res.released) {
    appendEvent(
      { type: 'release', scope: MERGE_SLOT_NAME },
      { terminalId, ...journalOpt(o) },
    )
  }
  return res
}

/**
 * checkMergeClaim({claimsDir, now}) — inspect the merge slot WITHOUT mutating it.
 *   - live claim within TTL -> {live:true, who, since, branch, warn, howToClear}
 *   - claim older than TTL  -> {live:false, stale:true, needsHuman:true, who, since, branch}
 *   - no claim              -> {live:false}
 * A foreign live claim is NEVER removed here; a stale one is flagged for a human, never
 * auto-deleted (P3). Mirrors slots.mjs checkPushClaim.
 */
export function checkMergeClaim(o = {}) {
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const claims = readClaims(claimOpts)
  const entry = claims.find((c) => c.name === MERGE_SLOT_NAME)
  if (!entry) return { live: false }

  const prov = entry.provenance
  const who = prov && prov.by ? prov.by : 'неизвестный терминал'
  const since = prov && prov.at ? prov.at : null
  const reason = (prov && prov.reason) || ''
  const branchMatch = /merge-in-progress:(.+)$/.exec(reason)
  const branch = branchMatch ? branchMatch[1] : null

  const now = o.now ?? Date.now()
  const startedMs = since ? Date.parse(since) : NaN
  const ageMs = Number.isFinite(startedMs) ? now - startedMs : entry.ageMs

  if (ageMs > MERGE_CLAIM_TTL_MS) {
    // Stale — flag for a human; DO NOT auto-delete a foreign claim (P3).
    return { live: false, stale: true, needsHuman: true, who, since, branch }
  }

  return {
    live: true,
    who,
    since,
    branch,
    warn: `слияние уже идёт: ${who}${since ? ` (с ${since})` : ''} — дождитесь завершения`,
    howToClear: 'дождитесь / node scripts/sma/cli.mjs force-clear merge-in-progress',
  }
}

// ── the `sma merge` ritual — claim -> tests-on-result -> receipt -> release (local) ──

/**
 * runMerge({branch, execGit, runTests, claimsDir, journalDir, cwd, by, now}) — the
 * serialized merge ritual. IN ORDER: acquire the merge slot (a concurrent
 * hold -> SOFT-deny + override) -> merge the branch into main LOCALLY (no push) -> run
 * the injected tests on the MERGE RESULT -> journal a receipt (pass OR fail honestly) ->
 * release the slot. Wrapped fail-open (C9): any error releases the held slot and returns
 * an honest failure — NEVER a throw, NEVER a wedged slot, NEVER a false green.
 *
 * `testsPassed` is `true`/`false` ONLY when a runner was injected and actually ran; it is
 * `null` when no run happened, because «тесты не запускались» is a different fact from «тесты
 * прошли» and a receipt may state only what took place. Readers deciding an outcome must treat
 * null as «нечего утверждать» — a red run (false) blocks, an absent one does not.
 *
 * @returns
 *   - concurrent hold: {merged:false, softDenied:true, override, holder}
 *   - success/tests:   {merged:true, testsPassed:boolean|null, branch, resultSha, receipt}
 *   - error:           {ok:false, message}
 */
export function runMerge(o = {}) {
  const branch = o.branch
  const execGit = o.execGit ?? defaultExecGit
  const runTests = o.runTests
  const claimOpts = o.claimsDir ? { claimsDir: o.claimsDir } : {}
  const journalDir = o.journalDir
  const terminalId = o.by ?? 'unknown'
  const cwd = o.cwd ?? process.cwd()

  let claimed = false
  try {
    if (!branch || typeof branch !== 'string') return { ok: false, message: 'no-branch' }

    // (1) acquire the merge slot — a concurrent hold is a SOFT-deny with an override path.
    const acq = acquireMergeClaim({ by: o.by, session: o.session, branch, journalDir, ...claimOpts })
    if (!acq.acquired) {
      const holder = acq.holder && acq.holder.by ? acq.holder.by : 'другой терминал'
      return {
        merged: false,
        softDenied: true,
        override: `слияние уже идёт (${holder}) — дождитесь завершения, либо, если оно зависло: node scripts/sma/cli.mjs force-clear ${MERGE_SLOT_NAME}`,
        holder: acq.holder ?? null,
      }
    }
    claimed = true

    // (2) merge the branch into main LOCALLY. NO push, NO deploy (slots.mjs header law).
    execGit(['merge', '--no-ff', branch], { cwd })

    // the MERGE RESULT sha (read-only).
    let resultSha = ''
    try {
      resultSha = String(execGit(['rev-parse', 'HEAD'], { cwd })).trim()
    } catch {
      resultSha = ''
    }

    // (3) run targeted tests on the MERGE RESULT (not on either branch alone).
    //
    // NULL UNTIL SOMETHING ACTUALLY RUNS. This started as `true` and stayed `true` whenever no
    // runner was injected, so a receipt asserted that tests had passed on a merge where not one
    // test was executed — the one claim a receipt exists to prevent. Three answers, not two:
    // true and false state an OUTCOME, null states that there was no run to have an outcome.
    let testsPassed = null
    if (runTests) {
      const tr = runTests({ branch, resultSha, cwd })
      testsPassed = !!(tr && tr.passed)
    }

    // (4) journal a receipt — records the outcome HONESTLY (pass OR fail; never a false green).
    //
    // THE FULL COMMIT NAME, AND THE TREE IT NAMES SOMETHING IN.
    //
    // This receipt is where one sentence comes from: the single command that undoes an
    // acceptance — `git -C <repo> revert -m 1 <sha>`. The merge above is deliberately made
    // with no fast-forward, so the merge commit always has exactly two parents and the first
    // is the trunk; that is why the side number is always 1 and why this one commit name is
    // enough to undo the whole acceptance.
    //
    // The name used to be cut to seven characters HERE, at the moment of writing. Seven is
    // usually enough, but git requires an UNAMBIGUOUS prefix and a tree large enough will one
    // day make seven ambiguous — while the full name is right there in the variable being
    // truncated. A short form, where eyes want one, is made when the value is DISPLAYED; it
    // is never the thing that gets stored. `repo` travels beside it because a person reading
    // a card is not necessarily standing in the directory the project lives in, and a command
    // that assumes they are is a command that runs somewhere else.
    const receipt = { branch, resultSha: resultSha || null, repo: cwd, testsPassed }
    try {
      appendEvent(
        { type: 'merge', scope: MERGE_SLOT_NAME, detail: receipt },
        { terminalId, ...journalOpt(o) },
      )
    } catch {
      /* fail-open — a journal failure never blocks the ritual */
    }

    // (5) release the slot.
    releaseMergeClaim({ by: o.by, journalDir, ...claimOpts })
    claimed = false

    return { merged: true, testsPassed, branch, resultSha: resultSha || null, receipt }
  } catch (err) {
    // C9 fail-open: release any held slot, return an honest failure, never throw.
    if (claimed) {
      try {
        releaseMergeClaim({ by: o.by, journalDir, ...claimOpts })
      } catch {
        /* best-effort */
      }
    }
    return { ok: false, message: err && err.message ? String(err.message) : 'merge-failed' }
  }
}

// ── enforcing scopes — the verified-LIVE-only soft-deny predicate ───────────────────
//
// enforceScope is the SOFT-deny-with-override predicate. It fires (soft-deny + override)
// ONLY on a VERIFIED-LIVE foreign claim — the SAME evidence logic as the
// self-verifying collision banner (verifyClaimEvidence): a claim is STALE (safe to take) when the
// scope is CLEAN vs HEAD AND a commit landed in scope after the claim's renewTime; only
// otherwise is it LIVE (real busy). A stale/unverified claim stays WARN-only. Posture:
//   - SOFT-deny-with-override ONLY — NEVER a hard block (hard deny stays the security
//     guard's alone, carried posture lock).
//   - Any error degrades to ALLOW (C9 fail-open) — a gate bug can NEVER wedge a session.
//   - A cooling-down / force-cleared scope is NEVER enforced — the founder word
//     always wins.
// The OPT-IN gate (SMA_ENFORCE_SCOPES, default off) lives in the pre.mjs `enforce` stream,
// NOT here — so this predicate stays a pure evidence->action function.

/**
 * enforceScope({ownTouch, foreignClaim, evidence, env, verifyClaimEvidence, coolingDown})
 * — decide the enforcing action for an Edit/Write that overlaps a foreign claim.
 *   - no foreign claim                       -> {action:'allow'}
 *   - SMA_ENFORCE_SCOPES_DISABLE set          -> {action:'allow'} (kill-switch, before any evidence read)
 *   - cooling-down / force-cleared scope      -> {action:'warn'}  (founder word wins)
 *   - foreign claim STALE/unverified          -> {action:'warn', text}
 *   - foreign claim VERIFIED-LIVE             -> {action:'soft-deny', text, override}
 * Deterministic over the injected evidence + verifyClaimEvidence (the ONE evidence
 * source). Any error -> {action:'allow'} (fail-open). NEVER a hard block.
 * @returns {{action:'allow'|'warn'|'soft-deny', text?:string, override?:string}}
 */
export function enforceScope(o = {}) {
  try {
    const env = o.env || {}
    // Kill-switch short-circuits BEFORE any evidence read (fail-open ceiling).
    if (envOn(env.SMA_ENFORCE_SCOPES_DISABLE)) return { action: 'allow' }

    const foreignClaim = o.foreignClaim
    if (!foreignClaim) return { action: 'allow' } // no overlap -> nothing to enforce

    // NEVER enforce a cooling-down / force-cleared scope — the founder word wins.
    if (o.coolingDown) {
      return { action: 'warn', text: 'скоуп недавно освобождён — можно занимать (не блокируем)' }
    }

    // The verified-LIVE-vs-stale decision — verifyClaimEvidence, ONE source.
    const verify = typeof o.verifyClaimEvidence === 'function' ? o.verifyClaimEvidence : null
    const ev = verify ? verify(o.evidence || {}) : { live: true, text: '' }

    if (ev && ev.live === false) {
      // STALE / unverified foreign claim -> WARN-only (never a soft-deny).
      return { action: 'warn', text: ev.text || 'claim устарел — можно работать' }
    }

    // VERIFIED-LIVE foreign claim -> SOFT-deny with an override token (never a hard block).
    return {
      action: 'soft-deny',
      text: ev && ev.text ? ev.text : `занято ${foreignClaim.by || foreignClaim.holderIdentity || 'другим терминалом'}`,
      override: ENFORCE_OVERRIDE_HINT,
    }
  } catch {
    return { action: 'allow' } // C9 fail-open — never deny on error, never a wedge.
  }
}

export { envOn as _envOn }
