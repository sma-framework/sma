/**
 * Tests for scripts/sma/lib/notify.mjs (Phase 49.3 Plan 07 — D-49.3-13).
 *
 * The claim PULSE (on the EXISTING lease `fpStatus` field — no parallel store) + the
 * edge-triggered outbound waiting-for-human webhook: outbound events only, explicit-pick
 * payload, cooldown-deduped, off-by-default, fail-open, nothing in, nothing leaked.
 *
 *   - Test 1: edge trigger + explicit-pick allowlist (hostile extras proven absent).
 *   - Test 2: dedup + cooldown — no-change fires zero; a flap fires exactly one.
 *   - Test 3: off-by-default + fail-open — no URL / throwing fetch / kill-switch.
 *   - Test 4: no remote control — the response body is never read.
 *   - Test 5: derivePulse — idle is DERIVED from staleness, never stored.
 *   - Test 6: URL resolution order — env > webhook.json > profile; http(s) only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PULSE_VALUES,
  ALLOWED_WEBHOOK_KEYS,
  setPulse,
  firePulseWebhook,
  derivePulse,
  resolveWebhookUrl,
  WEBHOOK_COOLDOWN_MS,
  PULSE_IDLE_AFTER_MS,
} from '../lib/notify.mjs'
import { readJournal } from '../lib/journal.mjs'

let dir: string
let dirs: {
  smaRoot: string
  sessionsDir: string
  statuslineDir: string
  journalDir: string
  reflexDir: string
  repoRoot: string
}
const TERMINAL = 't-1'
const NOW = 5_000_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-notify-'))
  dirs = {
    smaRoot: dir,
    sessionsDir: join(dir, 'sessions'),
    statuslineDir: join(dir, 'statusline'),
    journalDir: join(dir, 'journal'),
    reflexDir: join(dir, 'reflex'),
    repoRoot: join('/home/founder', 'my-app'),
  }
  mkdirSync(dirs.sessionsDir, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

/** Seed the own lease with a given fpStatus + a fresh renewTime. */
function seedLease(fpStatus: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    join(dirs.sessionsDir, `${TERMINAL}.json`),
    JSON.stringify({ holderIdentity: 'Tester', fpStatus, renewTime: new Date(NOW).toISOString(), label: '49.3-07', ...extra }),
  )
}

/** A fetch recorder that captures every POST and returns a 2xx by default. */
function recorder(impl?: (url: string, init: any) => any) {
  const calls: Array<{ url: string; body: any }> = []
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return impl ? impl(url, init) : { ok: true, status: 200 }
  }
  return { calls, fetchImpl }
}

describe('notify.mjs — pulse + edge-triggered webhook (D-49.3-13)', () => {
  it('Test 1: a working -> waiting-for-human transition fires exactly one explicit-pick delivery', async () => {
    seedLease('working')
    const { calls, fetchImpl } = recorder()
    const env = { SMA_WEBHOOK_URL: 'https://example.test/hook' }

    const res = await setPulse('waiting-for-human', { dirs, identity: { terminalId: TERMINAL }, fetchImpl, now: NOW, env })
    expect(res.changed).toBe(true)
    expect(res.prev).toBe('working')
    expect(calls.length).toBe(1)

    // the payload key set deep-equals ALLOWED_WEBHOOK_KEYS EXACTLY (explicit pick)
    expect(Object.keys(calls[0].body).sort()).toEqual([...ALLOWED_WEBHOOK_KEYS].sort())
    expect(calls[0].body.event).toBe('waiting-for-human')
    expect(calls[0].body.repo).toBe('my-app') // basename ONLY, never the full path

    // hostile extras fed to firePulseWebhook directly are NOT picked (proven, not filtered)
    const hostile = recorder()
    await firePulseWebhook(
      { terminalId: TERMINAL, workLabel: 'x', repoRoot: dirs.repoRoot, message: 'PHI secret', diff: '@@ -1 +1 @@', transcriptPath: '/t.jsonl', env: { KEY: 'v' } } as any,
      { dirs: { ...dirs, statuslineDir: join(dir, 'sl2') }, env, fetchImpl: hostile.fetchImpl, now: NOW },
    )
    const body = hostile.calls[0].body
    expect(Object.keys(body).sort()).toEqual([...ALLOWED_WEBHOOK_KEYS].sort())
    for (const leaked of ['message', 'diff', 'transcriptPath', 'env']) expect(leaked in body).toBe(false)
  })

  it('Test 2: no-change fires zero; a flap inside the cooldown fires exactly one', async () => {
    const env = { SMA_WEBHOOK_URL: 'https://example.test/hook' }

    // no-change: already waiting-for-human -> zero
    seedLease('waiting-for-human')
    const a = recorder()
    const r0 = await setPulse('waiting-for-human', { dirs, identity: { terminalId: TERMINAL }, fetchImpl: a.fetchImpl, now: NOW, env })
    expect(r0.changed).toBe(false)
    expect(a.calls.length).toBe(0)

    // flap: working -> waiting (fires 1) -> working (no trigger) -> waiting (cooldown blocks) = ONE total
    seedLease('working')
    const b = recorder()
    const opts = { dirs, identity: { terminalId: TERMINAL }, fetchImpl: b.fetchImpl, env }
    await setPulse('waiting-for-human', { ...opts, now: NOW })
    await setPulse('working', { ...opts, now: NOW + 1000 })
    await setPulse('waiting-for-human', { ...opts, now: NOW + 2000 }) // still inside WEBHOOK_COOLDOWN_MS
    expect(b.calls.length).toBe(1)
    expect(NOW + 2000 - NOW).toBeLessThan(WEBHOOK_COOLDOWN_MS)
  })

  it('Test 3: no URL / throwing fetch / kill-switch all keep setPulse succeeding, journaling one error', async () => {
    // (a) no URL resolvable -> zero fetch, setPulse still changes the pulse
    seedLease('working')
    const noUrl = recorder()
    const rNoUrl = await setPulse('waiting-for-human', { dirs, identity: { terminalId: TERMINAL }, fetchImpl: noUrl.fetchImpl, now: NOW, env: {} })
    expect(rNoUrl.changed).toBe(true)
    expect(noUrl.calls.length).toBe(0)

    // (b) a throwing fetch leaves setPulse {changed:true} and journals ONE webhook-error
    seedLease('working')
    const env = { SMA_WEBHOOK_URL: 'https://example.test/hook' }
    const throwing = async () => {
      throw new Error('network down')
    }
    const rThrow = await setPulse('waiting-for-human', {
      dirs,
      identity: { terminalId: TERMINAL },
      fetchImpl: throwing,
      now: NOW,
      env,
      sessionToken: 'sess-1',
    })
    expect(rThrow.changed).toBe(true)
    const { events } = readJournal({ journalDir: dirs.journalDir })
    expect(events.filter((e) => e.type === 'webhook-error').length).toBe(1)

    // (c) SMA_NOTIFY_DISABLE short-circuits before any URL resolution
    seedLease('working')
    const killed = recorder()
    await setPulse('waiting-for-human', {
      dirs,
      identity: { terminalId: TERMINAL },
      fetchImpl: killed.fetchImpl,
      now: NOW,
      env: { SMA_WEBHOOK_URL: 'https://example.test/hook', SMA_NOTIFY_DISABLE: '1' },
    })
    expect(killed.calls.length).toBe(0)
  })

  it('Test 4: the response body is never read (no remote control)', async () => {
    seedLease('working')
    const env = { SMA_WEBHOOK_URL: 'https://example.test/hook' }
    const bodyTrap = {
      ok: true,
      status: 200,
      get body() {
        throw new Error('body accessed!')
      },
      json() {
        throw new Error('json() called!')
      },
      text() {
        throw new Error('text() called!')
      },
    }
    const fetchImpl = async () => bodyTrap
    const res = await firePulseWebhook(
      { terminalId: TERMINAL, workLabel: '49.3-07', repoRoot: dirs.repoRoot },
      { dirs, env, fetchImpl, now: NOW },
    )
    // return value carries ONLY the delivered boolean — no directive from the response
    expect(res.delivered).toBe(true)
    expect('directive' in res).toBe(false)
  })

  it('Test 5: derivePulse — idle is derived from staleness, never stored', () => {
    const fresh = new Date(NOW).toISOString()
    const stale = new Date(NOW - PULSE_IDLE_AFTER_MS - 1000).toISOString()
    expect(derivePulse({ fpStatus: 'working', renewTime: fresh }, { now: NOW })).toBe('working')
    // stale renew -> idle REGARDLESS of the written pulse
    expect(derivePulse({ fpStatus: 'working', renewTime: stale }, { now: NOW })).toBe('idle')
    expect(derivePulse({ fpStatus: 'waiting-for-human', renewTime: stale }, { now: NOW })).toBe('idle')
    // fresh waiting-for-human stays waiting-for-human
    expect(derivePulse({ fpStatus: 'waiting-for-human', renewTime: fresh }, { now: NOW })).toBe('waiting-for-human')
    expect(PULSE_VALUES).toEqual(['working', 'waiting-for-human', 'idle'])
  })

  it('Test 6: URL resolution order env > webhook.json > profile; http(s) only', () => {
    mkdirSync(dirs.statuslineDir, { recursive: true })
    writeFileSync(join(dirs.statuslineDir, 'webhook.json'), JSON.stringify({ url: 'https://from-file.test/h' }))
    writeFileSync(join(dirs.smaRoot, 'profile.json'), JSON.stringify({ notifications: { webhookUrl: 'https://from-profile.test/h' } }))

    // env wins
    expect(resolveWebhookUrl({ dirs, env: { SMA_WEBHOOK_URL: 'https://from-env.test/h' } })).toBe('https://from-env.test/h')
    // else webhook.json
    expect(resolveWebhookUrl({ dirs, env: {} })).toBe('https://from-file.test/h')
    // else profile
    rmSync(join(dirs.statuslineDir, 'webhook.json'))
    expect(resolveWebhookUrl({ dirs, env: {} })).toBe('https://from-profile.test/h')
    // non-http rejected -> null
    expect(resolveWebhookUrl({ dirs: { ...dirs, smaRoot: join(dir, 'empty') }, env: { SMA_WEBHOOK_URL: 'ftp://x/h' } })).toBe(null)
    expect(resolveWebhookUrl({ dirs: { ...dirs, smaRoot: join(dir, 'empty') }, env: { SMA_WEBHOOK_URL: 'not-a-url' } })).toBe(null)
  })
})
