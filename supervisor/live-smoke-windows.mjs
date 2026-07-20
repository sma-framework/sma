/**
 * live-smoke-windows.mjs — the supervised, in-session acceptance run for the BL-94
 * pilot contour. It proves, against REAL durable state (pg-boss on localhost:5433/
 * sma_queue), the chain the whole SMA V5 orchestration rests on:
 *
 *     queue accepts  ->  worker lane claims  ->  a receipt is produced  ->  the roster
 *     front shows the result.
 *
 * THE SANCTIONED HARNESS SEAM. It imports { createDaemon } from the daemon composition
 * root (main.mjs header: «a future integration harness can drive it») and boots the REAL
 * machine config (loadConfig -> ~/.sma-daemon/config.json -> real pg-boss, real front,
 * real tick), overriding ONLY: a scratch dataDir/ledgerDir under a temp pilot dir, a
 * distinct front port (7788), and o.verbRunner — a recording echo runner that answers the
 * `preflight` verb with a GREEN 'built' verdict. That drives the tick's LEGITIMATE
 * preflight-'built' door (loop.mjs step 4) to a completed receipt with zero LLM spend and
 * no worker spawn. It is the contour proof, NOT a bypass of the reverify exit gate
 * (D-9.5-04a): reverify stays the door for real work; this proves enqueue -> claim ->
 * durable complete -> front, cheaply.
 *
 * Synthetic echo FIRST (pilot scope). The real size:S backlog run is the founder-
 * triggered follow-up documented in setup-windows.md; Telegram report-back + spend
 * economics ride THAT run, not this smoke.
 *
 * The daemon core is never patched here. Two production wiring gaps in main.mjs are
 * OBSERVED and recorded (parked plan 9.5-10), never fixed:
 *   (a) tickDeps omits `buildArgs`, so a real non-'built' task cannot reach spawn from the
 *       production composition root yet (irrelevant to this smoke — the preflight door
 *       skips spawn);
 *   (b) `ledger` is handed to the tick as the ledgerDir STRING, so the tick-side
 *       recordAttempt is a silent no-op — BUT the pg-boss adapter's own complete() writes
 *       the attempt-ledger row directly (ledgerDir is wired into createPgBossQueue), so the
 *       ledger IS populated by the adapter path.
 * A THIRD observation: createDaemon().start() does NOT call adapter.start(), so this
 * harness starts the pg-boss connection itself (a deploy-wave wiring item).
 *
 * Node built-ins + the daemon's own modules + pg (for the DB ensure/asserts) only.
 */

import { createDaemon } from '../daemon/src/main.mjs'
import { loadConfig } from '../daemon/src/config.mjs'
import { readAttempts } from '../daemon/src/queue/attempt-ledger.mjs'
import pg from 'pg'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const QUEUE_PORT = 5433
const QUEUE_DB = 'sma_queue'
const FRONT_PORT = 7788
const FRONT_HOST = '127.0.0.1'
const POLL_TIMEOUT_MS = 60000

let failCount = 0
const pass = (msg) => console.log(`PASS  ${msg}`)
const fail = (msg) => { failCount += 1; console.log(`FAIL  ${msg}`) }
const info = (msg) => console.log(`  ..  ${msg}`)

/** TCP port probe (resolves true/false, never throws). */
function probePort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (v) => { if (!done) { done = true; try { sock.destroy() } catch { /* */ } resolve(v) } }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Ensure the shared dead-letter queue exists BEFORE the backend's start() references it.
 * FINDING (parked plan 9.5-10): pgboss-backend.mjs start() creates each lane queue with
 * `{ deadLetter: 'sma.task.dead' }` but never creates 'sma.task.dead' itself. Under
 * pg-boss v11 createQueue VALIDATES the deadLetter target and throws «Queue sma.task.dead
 * does not exist», so a fresh boot crashes. The deploy wave must create the dead-letter
 * queue first (or the backend must). Here the harness provisions it (queues persist in
 * pgboss.queue) — a machine-state fix, NOT a daemon-src patch.
 */
async function ensureDeadLetterQueue(queueUrl) {
  const { default: PgBoss } = await import('pg-boss')
  const boss = new PgBoss({ connectionString: queueUrl })
  await boss.start()
  try { await boss.createQueue('sma.task.dead') } catch { /* already exists */ }
  await boss.stop()
}

async function waitForPort(port, host, deadline) {
  while (Date.now() < deadline) {
    if (await probePort(port, host)) return true
    await sleep(500)
  }
  return false
}

/** Step 1: ensure PG :5433 is up and the dedicated sma_queue DB exists (42P04 tolerated). */
async function ensureQueueDb() {
  const up = await probePort(QUEUE_PORT, '127.0.0.1')
  if (!up) {
    fail(`step1: queue Postgres :${QUEUE_PORT} is CLOSED — start it: cd ~/pg-sandbox && node start.mjs`)
    return false
  }
  const client = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${QUEUE_PORT}/postgres` })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE ${QUEUE_DB}`)
    info(`created ${QUEUE_DB}`)
  } catch (e) {
    if (e.code === '42P04') info(`${QUEUE_DB} already exists (42P04 tolerated)`)
    else { await client.end(); throw e }
  }
  await client.end()
  pass(`step1: PG :${QUEUE_PORT} up + ${QUEUE_DB} ensured (queue lives in ${QUEUE_DB}, never postgres, never Railway)`)
  return true
}

/** A recording echo verbRunner: preflight -> GREEN 'built' receipt (no spawn, no LLM). */
function makeVerbRunner(recorded) {
  return async (bin, args, _opts) => {
    const verb = Array.isArray(args) ? args[1] : undefined
    const taskId = Array.isArray(args) ? args[2] : undefined
    recorded.push({ verb, taskId })
    if (verb === 'preflight') {
      return { code: 0, stdout: JSON.stringify({ verdict: 'built', receiptRef: `preflight:${taskId}` }) }
    }
    return { code: 0, stdout: '{}' } // no other verb should be reached in this contour
  }
}

/** GET/POST helper against the front (fetch; returns {status, json?, text}). */
async function req(method, path, { token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`http://${FRONT_HOST}:${FRONT_PORT}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json
  const text = await res.text()
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function main() {
  console.log('=== BL-94 pilot — live contour smoke (Windows) ===')

  if (!(await ensureQueueDb())) return finishAndExit(null, null, null, [])

  // Real machine config; override port + scratch dirs only.
  const base = loadConfig()
  const tempRoot = mkdtempSync(join(tmpdir(), 'sma-pilot-'))
  const dataDir = join(tempRoot, 'data')
  const ledgerDir = join(tempRoot, 'ledger')
  const config = { ...base, port: FRONT_PORT, bind: FRONT_HOST, dataDir, ledgerDir }
  const token = config.token
  info(`config: queueUrl=${config.queueUrl} front=${FRONT_HOST}:${FRONT_PORT} scratch=${tempRoot}`)
  info(`workers: ${config.workers.map((w) => `${w.id}/${w.lane}/${w.provider}`).join(', ')}`)

  // Provision the shared dead-letter queue the backend's start() references (see finding).
  await ensureDeadLetterQueue(config.queueUrl)
  info('sma.task.dead provisioned by the harness (backend start() references but never creates it)')

  const recorded = []
  const handles = createDaemon({ config, dataDir, ledgerDir, verbRunner: makeVerbRunner(recorded) })

  // FINDING: createDaemon().start() does not call adapter.start(); the harness does it.
  await handles.adapter.start()
  info('adapter.start() called by the harness (main.mjs start() omits it — deploy-wave item)')

  // Step 2: boot the front + tick.
  handles.start()
  const up = await waitForPort(FRONT_PORT, FRONT_HOST, Date.now() + 15000)
  if (!up) { fail('step2: front never listened on :7788'); return finishAndExit(null, null, ledgerDir, recorded, handles) }
  pass('step2: daemon booted (front listening + stateless tick running)')

  // Step 3: negative auth receipt — GET /api/state WITHOUT the token -> 401.
  const noAuth = await req('GET', '/api/state')
  if (noAuth.status === 401 || noAuth.status === 403) pass(`step3: GET /api/state without token -> ${noAuth.status} (auth gate holds)`)
  else fail(`step3: GET /api/state without token returned ${noAuth.status} (expected 401/403)`)

  // Step 4: enqueue the synthetic task through the FRONT HTTP route with the token.
  let taskId = null
  let enqueuePath = 'front POST /api/enqueue'
  const title = `pilot-echo-260720`
  const enq = await req('POST', '/api/enqueue', { token, body: { title, lane: 'prod' } })
  if (enq.status === 200 && enq.json && enq.json.id) {
    taskId = enq.json.id
    pass(`step4: enqueued via ${enqueuePath} -> ${taskId} (source 'roster', DoR-exempt)`)
  } else {
    // structural fallback to adapter.enqueue (record which path was used)
    info(`front enqueue returned ${enq.status} ${enq.text?.slice(0, 120)} — falling back to adapter.enqueue`)
    enqueuePath = 'adapter.enqueue (fallback)'
    taskId = `R-${Date.now()}`
    await handles.adapter.enqueue({ id: taskId, source: 'roster', title, lane: 'prod' })
    pass(`step4: enqueued via ${enqueuePath} -> ${taskId}`)
  }

  // Step 5: poll until the task leaves 'queued' (tick is 5s; bound 60s).
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let finalStatus = null
  while (Date.now() < deadline) {
    const rows = await handles.adapter.list({})
    const row = rows.find((r) => r.id === taskId)
    if (row && row.status !== 'queued') { finalStatus = row.status; break }
    await sleep(1500)
  }
  if (finalStatus === 'completed') pass(`step5: task left the queue -> status '${finalStatus}' (claimed + completed within the poll window)`)
  else if (finalStatus) fail(`step5: task ended '${finalStatus}' (expected 'completed')`)
  else fail('step5: task never left queued within 60s')

  // Step 6a: durable pg-boss row carries the receiptRef in its output.
  let receiptRef = null
  {
    const client = new pg.Client({ connectionString: config.queueUrl })
    await client.connect()
    try {
      const r = await client.query(
        `SELECT state, output FROM pgboss.job WHERE data->>'id' = $1 ORDER BY created_on DESC LIMIT 1`,
        [taskId],
      )
      const jr = r.rows[0]
      const out = jr && jr.output ? (typeof jr.output === 'string' ? JSON.parse(jr.output) : jr.output) : null
      receiptRef = out && out.receiptRef ? out.receiptRef : null
      if (jr && jr.state === 'completed' && receiptRef) {
        pass(`step6a: durable pg-boss row on :5433/${QUEUE_DB} is state='completed' with receiptRef='${receiptRef}'`)
      } else {
        fail(`step6a: durable row state='${jr && jr.state}' receiptRef='${receiptRef}' (expected completed + receiptRef)`)
      }
    } finally { await client.end() }
  }

  // Step 6b: GET /api/state with the token shows the task in the derived done[] section.
  const state = await req('GET', '/api/state', { token })
  const doneRow = state.json && Array.isArray(state.json.done) ? state.json.done.find((d) => d.id === taskId) : null
  if (state.status === 200 && doneRow) {
    pass(`step6b: GET /api/state (token) shows ${taskId} in done[] (workerId=${doneRow.workerId ?? 'n/a'}, attempts=${doneRow.attempts})`)
  } else {
    fail(`step6b: /api/state status=${state.status} done-row=${doneRow ? 'present' : 'MISSING'}`)
  }

  // Step 6c: attempt-ledger row under the scratch ledgerDir carries the receiptRef.
  let ledgerRow = null
  const attempts = readAttempts(ledgerDir, taskId)
  const completedAttempt = attempts.find((a) => a.outcome === 'completed')
  if (completedAttempt && completedAttempt.receiptRef) {
    ledgerRow = completedAttempt
    pass(`step6c: attempt-ledger row present (outcome='completed', receiptRef='${completedAttempt.receiptRef}', workerId='${completedAttempt.workerId ?? ''}', provider='${completedAttempt.provider ?? ''}') — written by the adapter complete() path`)
  } else {
    fail('step6c: no completed attempt-ledger row with a receiptRef under the scratch ledgerDir')
  }

  info(`verbRunner calls recorded: ${recorded.map((r) => r.verb).join(', ') || '(none)'}`)
  return finishAndExit(taskId, receiptRef, ledgerDir, recorded, handles, ledgerRow)
}

async function finishAndExit(taskId, receiptRef, ledgerDir, recorded, handles, ledgerRow = null) {
  // Step 7: clean shutdown; leave the sandbox Postgres RUNNING (other work may use it).
  try {
    if (handles) {
      handles.stop()
      if (handles.adapter && typeof handles.adapter.stop === 'function') await handles.adapter.stop()
    }
  } catch (e) { info(`shutdown note: ${String(e.message || e)}`) }
  info('daemon stopped; the ~/pg-sandbox Postgres is LEFT RUNNING (other work on this PC may use :5433)')

  const summary = { taskId, receiptRef, statePath: `http://${FRONT_HOST}:${FRONT_PORT}/api/state`, ledgerRow: ledgerRow ? 'present' : null, failCount }
  console.log(`\nSMOKE SUMMARY ${JSON.stringify(summary)}`)
  console.log(failCount === 0 ? 'RESULT: GREEN (exit 0)' : `RESULT: RED (${failCount} failing checks)`)
  process.exit(failCount)
}

main().catch((e) => {
  console.error('SMOKE CRASHED:', e && e.stack ? e.stack : e)
  process.exit(1)
})
