/**
 * canary.mjs — planted false-«done» canaries with a sealed ledger (49.2-10, D-49.2-14).
 *
 * S8 (blind-verifier quality) has no teeth without a control group: «zero
 * divergence» from a verifier that never actually re-derives anything is
 * indistinguishable from clean work. So we plant deliberately-FALSE claims (a
 * receipt whose expected hash is one nibble off the truth) into the claims the
 * blind verifier re-derives, and measure how many it catches.
 *
 * BLINDNESS is the whole game:
 *   - The plant list lives ONLY in a sealed ledger under dirs.canaryDir, which
 *     plan 07's blind-verifier pack-assembly MUST exclude (key_link contract). A
 *     verifier that can read the plant list scores itself — S8 destroyed.
 *   - The planted CLAIM body carries NO marker distinguishing it from a real
 *     claim (no `canary:true`, no tag, no sequence mark). A canary spottable from
 *     the body is a broken canary. The perturbation is invisible: a plausible
 *     64-hex hash that just happens to be wrong.
 *
 * SEPARATION OF SCORING (prohibitions):
 *   - A canary divergence scores the VERIFIER (S8, domain sma.verification), is
 *     EXCLUDED from S1 false-done-rate, and NEVER trips the plan-08 ship block.
 *     classifyDivergence is the ONE function plan 08's consumer calls before
 *     blocking — a divergence on a planted id routes 's8-score', never 'ship-block'.
 *
 * TAMPER-EVIDENCE: the sealed ledger is append-only JSONL, each line carrying
 * `prev` = lineHash(previous raw line) — the SAME hash-chain posture as plan 03's
 * journal (D-49.2-07), reusing journal.mjs's lineHash (never re-derived). A local
 * edit breaks the chain, and scoreCanaries then REFUSES to score ({chain-broken})
 * rather than silently trusting a doctored plant list.
 *
 * Node built-ins only; DI dirs; fail-open (C9).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { CANARY_DIR } from './constants.mjs'
import { lineHash } from './journal.mjs'
import { appendVerdict } from './calibration.mjs'

function resolveCanaryDir(dirs = {}) {
  return dirs.canaryDir ?? CANARY_DIR
}

/** The one sealed-ledger file. */
function ledgerFile(dirs) {
  return join(resolveCanaryDir(dirs), 'ledger.jsonl')
}

/** The non-blank raw lines of a file, in order ([] on a missing/unreadable file). */
function rawLines(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter((l) => l.trim() !== '')
}

/**
 * Append ONE hash-chained line to the sealed ledger: prev = lineHash of the last
 * non-blank raw line ('genesis' first), written LAST so JSON order is stable.
 */
function appendLedgerLine(obj, dirs) {
  const dir = resolveCanaryDir(dirs)
  mkdirSync(dir, { recursive: true })
  const file = ledgerFile(dirs)
  const nb = rawLines(file)
  const prev = nb.length ? lineHash(nb[nb.length - 1]) : 'genesis'
  const record = { ...obj, prev }
  appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}

/**
 * Read + verify the sealed ledger. Returns {ok, entries, breakIndex}. The chain
 * check mirrors journal.verifyChain: from the first line every line MUST parse
 * AND carry prev === lineHash(previous raw line), 'genesis' for line 0. A break
 * anywhere -> {ok:false} (scoreCanaries then refuses).
 */
function readLedger(dirs) {
  const nb = rawLines(ledgerFile(dirs))
  const entries = []
  for (let i = 0; i < nb.length; i++) {
    let obj
    try {
      obj = JSON.parse(nb[i])
    } catch {
      return { ok: false, entries, breakIndex: i }
    }
    const expected = i === 0 ? 'genesis' : lineHash(nb[i - 1])
    if (obj.prev !== expected) return { ok: false, entries, breakIndex: i }
    entries.push(obj)
  }
  return { ok: true, entries, breakIndex: -1 }
}

/** Flip the last hex nibble (XOR 1 — always changes it) so the hash is plausibly-wrong. */
function perturbLastNibble(hash) {
  const h = String(hash)
  if (!/^[0-9a-f]{2,}$/i.test(h)) {
    // No real hash to perturb — synthesize a plausible-but-wrong 64-hex.
    return randomBytes(32).toString('hex')
  }
  const last = h[h.length - 1]
  const flipped = (parseInt(last, 16) ^ 1).toString(16)
  return h.slice(0, -1) + flipped
}

/** A canary claim body — EXACTLY the template's key set, no extra marker key. */
function canaryClaimBody(template, canaryId) {
  const t = template ?? {}
  const body = {}
  // Mirror the real-claim schema keys in the same order a real claim carries them.
  if ('id' in t || canaryId) body.id = canaryId
  if ('assertion' in t) body.assertion = t.assertion
  if ('check_command' in t) body.check_command = t.check_command
  if ('expected_sha256' in t) body.expected_sha256 = perturbLastNibble(t.expected_sha256)
  if ('hash_stdout' in t) body.hash_stdout = t.hash_stdout
  if ('coverage_id' in t) body.coverage_id = t.coverage_id
  return body
}

/**
 * plantCanary({claimsPath, dirs, identity, template, now}) -> {canaryId, claim,
 * ledgerRecord}. Appends ONE canary claim to the claims file (JSONL) whose
 * expected hash is deterministically perturbed from the template's real value
 * (false by construction), AND appends a sealed, hash-chained ledger line. The
 * claim body carries NO field distinguishing it from a real claim.
 *
 * @param {{claimsPath:string, dirs?:object, identity?:{terminalId?:string}, template?:object, now?:string}} args
 */
export function plantCanary({ claimsPath, dirs = {}, identity = {}, template = {}, now } = {}) {
  const canaryId = template.id ?? `C-${randomBytes(4).toString('hex')}`
  const claim = canaryClaimBody(template, canaryId)

  // Append the (blind-indistinguishable) claim to the claims file.
  try {
    appendFileSync(claimsPath, JSON.stringify(claim) + '\n')
  } catch {
    /* fail-open — a claims-file write failure never throws (canary just not planted) */
  }

  const ledgerRecord = appendLedgerLine(
    {
      kind: 'plant',
      canaryId,
      claimsPath,
      plantedAt: now ?? new Date().toISOString(),
      by: identity.terminalId ?? null,
    },
    dirs,
  )
  return { canaryId, claim, ledgerRecord }
}

/** The set of planted canary ids (from 'plant' ledger lines). Never throws. */
function plantedIds(dirs) {
  const { entries } = readLedger(dirs)
  const ids = new Set()
  for (const e of entries) if (e.kind === 'plant' && e.canaryId != null) ids.add(String(e.canaryId))
  return ids
}

/** The set of already-scored canary ids (from 'score' ledger lines). */
function scoredIds(dirs) {
  const { entries } = readLedger(dirs)
  const ids = new Set()
  for (const e of entries) if (e.kind === 'score' && e.canaryId != null) ids.add(String(e.canaryId))
  return ids
}

/**
 * isCanaryClaim(claimId, {dirs}) -> boolean. True ONLY for ids planted in the
 * sealed ledger. Never throws.
 */
export function isCanaryClaim(claimId, { dirs = {} } = {}) {
  return plantedIds(dirs).has(String(claimId))
}

/**
 * filterCanaries(claimIds, {dirs}) -> the input ids with EXACTLY the planted
 * canary ids stripped. Plan 08's ship-block consumer calls this before
 * classifying a divergence, so a canary never blocks a ship.
 */
export function filterCanaries(claimIds, { dirs = {} } = {}) {
  const planted = plantedIds(dirs)
  return (Array.isArray(claimIds) ? claimIds : []).filter((id) => !planted.has(String(id)))
}

/**
 * classifyDivergence(divergence, {dirs}) -> 's8-score' | 'ship-block'. The ONE
 * routing function plan 08's consumer calls before blocking ship: a divergence
 * whose claim id is a planted canary routes to S8 scoring (grades the verifier);
 * everything else is a real divergence that may block ship.
 */
export function classifyDivergence(divergence, { dirs = {} } = {}) {
  const id = divergence && (divergence.id ?? divergence.checkId ?? divergence.claimId)
  return isCanaryClaim(id, { dirs }) ? 's8-score' : 'ship-block'
}

/**
 * scoreCanaries({divergences, dirs, now}) -> {ok, n, caught, missed, catchRatePct,
 * records} | {ok:false, reason:'chain-broken'}. Over every UNSCORED planted
 * canary: caught = its id appears among the verifier's divergences. Appends one
 * calibration verdict per canary under domain 'sma.verification' (kind 'canary',
 * caught->hit / missed->miss) AND a 'score' ledger line (scoredAt) so
 * --count-scored is monotonic + idempotent. A broken ledger chain REFUSES to
 * score. Never throws.
 *
 * @param {{divergences:(object[]), dirs?:object, now?:string}} args
 */
export function scoreCanaries({ divergences = [], dirs = {}, now } = {}) {
  const led = readLedger(dirs)
  if (!led.ok) return { ok: false, reason: 'chain-broken' }

  const divIds = new Set(
    (Array.isArray(divergences) ? divergences : [])
      .map((d) => d && (d.id ?? d.checkId ?? d.claimId))
      .filter((x) => x != null)
      .map(String),
  )
  const alreadyScored = scoredIds(dirs)
  const toScore = [...plantedIds(dirs)].filter((id) => !alreadyScored.has(id))

  let caught = 0
  let missed = 0
  const records = []
  const at = now ?? new Date().toISOString()
  for (const canaryId of toScore) {
    const wasCaught = divIds.has(canaryId)
    if (wasCaught) caught += 1
    else missed += 1
    const record = {
      domain: 'sma.verification',
      kind: 'canary', // NOT 'divergence' — this grades the verifier, it is not a real miss
      canary: true,
      id: canaryId,
      metric: 'canary_catch',
      verdict: wasCaught ? 'hit' : 'miss',
      caught: wasCaught,
      scoredAt: at,
    }
    try {
      appendVerdict(record, { calibrationDir: dirs.calibrationDir })
    } catch {
      /* fail-open */
    }
    appendLedgerLine({ kind: 'score', canaryId, caught: wasCaught, scoredAt: at }, dirs)
    records.push(record)
  }

  const n = toScore.length
  const catchRatePct = n ? Math.round((caught / n) * 1000) / 10 : 0
  return { ok: true, n, caught, missed, catchRatePct, records }
}

/**
 * countScored({dirs}) -> integer count of distinct canary ids that have a 'score'
 * ledger line. The data source for `canary score --count-scored` (P49.2-10-03).
 * Monotonic + idempotent by construction.
 */
export function countScored({ dirs = {} } = {}) {
  return scoredIds(dirs).size
}

/**
 * sweepCanaries({claimsPath, dirs}) -> {ok, swept, remaining}. Removes planted
 * canary claims from the claims file (so a canary never ships inside a real
 * receipt) and appends a 'sweep' ledger line per swept canary — the ledger
 * entries PERSIST (sweptAt) so scoring history survives the sweep. Never throws.
 *
 * @param {{claimsPath:string, dirs?:object, now?:string}} args
 */
export function sweepCanaries({ claimsPath, dirs = {}, now } = {}) {
  const planted = plantedIds(dirs)
  let kept = []
  let swept = []
  try {
    const nb = rawLines(claimsPath)
    for (const line of nb) {
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        kept.push(line) // a non-JSON line is not a canary — leave it untouched
        continue
      }
      if (obj && obj.id != null && planted.has(String(obj.id))) {
        swept.push(String(obj.id))
      } else {
        kept.push(line)
      }
    }
    if (swept.length) {
      writeFileSync(claimsPath, kept.length ? kept.join('\n') + '\n' : '')
    }
  } catch {
    return { ok: false, swept: [], remaining: null }
  }

  const at = now ?? new Date().toISOString()
  for (const canaryId of swept) appendLedgerLine({ kind: 'sweep', canaryId, sweptAt: at }, dirs)
  return { ok: true, swept, remaining: kept.length }
}
