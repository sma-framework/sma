/**
 * Tests for daemon/src/config.mjs (Phase 9.5 Plan 01, Task 2).
 *
 * Worker-profile + secrets config loader (D-9.5-03/03a/05a, D-9.5-09/11):
 *   - Test 1: resolveConfigPath honors the SMA_DAEMON_CONFIG env override.
 *   - Test 2: resolveConfigPath falls back to ~/.sma-daemon/config.json via the
 *     injected homedir (no override).
 *   - Test 3: loadConfig with NO file present writes a default config, generates a
 *     64-hex token (randomBytes(32)), and (POSIX only) stamps mode 0600.
 *   - Test 4: the default pool encodes D-9.5-03 — 5 profiles (3 Claude Max + 1
 *     Codex/Pro + the `creator` forge role, enabled) and exactly one dayPriorityOwner
 *     (D-9.5-03a). The creator RIDES an existing Max account (D-9.5-09).
 *   - Test 5: loadConfig with an existing file parses and returns it unchanged
 *     (token round-trips — the default is persisted, not regenerated per call).
 *   - Test 6: validation rejects a worker profile missing id / lane / account.configDir
 *     with a named InvalidWorkerProfileError.
 *   - Test 7: validation normalizes the D-9.5-09 harness trio — enabled defaults to
 *     true; roleFile / skills are accepted.
 *   - Test 8: secretsView is the ONLY loggable shape — token and every
 *     account.oauthTokenEnv collapse to '[set]'/'[unset]' (T-9.5-01); no secret,
 *     no env-var NAME, ever leaves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfigPath, loadConfig, secretsView, InvalidWorkerProfileError } from '../src/config.mjs'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sma-daemon-cfg-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const homedir = () => home

describe('resolveConfigPath (D-9.5-05a)', () => {
  it('honors the SMA_DAEMON_CONFIG env override', () => {
    const p = resolveConfigPath({ env: { SMA_DAEMON_CONFIG: 'C:/custom/daemon.json' }, homedir })
    expect(p).toBe('C:/custom/daemon.json')
  })

  it('falls back to ~/.sma-daemon/config.json via the injected homedir', () => {
    const p = resolveConfigPath({ env: {}, homedir })
    expect(p).toBe(join(home, '.sma-daemon', 'config.json'))
  })
})

describe('loadConfig — bootstrap (default write)', () => {
  it('writes a default config with a 64-hex token when no file is present', () => {
    const cfg = loadConfig({ env: {}, homedir })
    const path = resolveConfigPath({ env: {}, homedir })
    expect(existsSync(path)).toBe(true)
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/)
    // POSIX-only: chmod is a no-op on win32 (do not fail there).
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('encodes the D-9.5-03 pool: 5 profiles (3 claude + 1 codex + creator forge) and one dayPriorityOwner', () => {
    const cfg = loadConfig({ env: {}, homedir })
    expect(cfg.workers).toHaveLength(5)
    const claude = cfg.workers.filter((w: any) => w.provider === 'claude')
    const codex = cfg.workers.filter((w: any) => w.provider === 'codex')
    const creator = cfg.workers.find((w: any) => w.id === 'creator')
    expect(codex).toHaveLength(1)
    expect(claude.length).toBeGreaterThanOrEqual(3)
    expect(creator).toBeTruthy()
    expect(creator.lane).toBe('forge')
    expect(creator.enabled).toBe(true)
    expect(cfg.workers.filter((w: any) => w.dayPriorityOwner === true)).toHaveLength(1)
  })

  it('the creator role rides an EXISTING account (not a fifth subscription)', () => {
    const cfg = loadConfig({ env: {}, homedir })
    const creator = cfg.workers.find((w: any) => w.id === 'creator')
    const maxAccounts = cfg.workers
      .filter((w: any) => w.id !== 'creator')
      .map((w: any) => w.account.name)
    expect(maxAccounts).toContain(creator.account.name)
  })

  it('defaults: bind 127.0.0.1, port 7777, backlogScanMinutes 60, agingHours 24, report-back off', () => {
    const cfg = loadConfig({ env: {}, homedir })
    expect(cfg.bind).toBe('127.0.0.1')
    expect(cfg.port).toBe(7777)
    expect(cfg.backlogScanMinutes).toBe(60)
    expect(cfg.agingHours).toBe(24)
    expect(cfg.webhookUrl).toBe('')
    expect(cfg.budget.warnPct).toEqual([70, 90])
  })
})

describe('loadConfig — existing file', () => {
  it('parses and returns an existing config; the token round-trips (persisted, not regenerated)', () => {
    const first = loadConfig({ env: {}, homedir })
    const second = loadConfig({ env: {}, homedir })
    expect(second.token).toBe(first.token)
  })

  it('rejects a worker profile missing id / lane / account.configDir with a named error', () => {
    // Seed a config with a broken worker, then load it.
    const path = resolveConfigPath({ env: {}, homedir })
    loadConfig({ env: {}, homedir }) // create a valid default first
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.workers.push({ id: 'broken', lane: 'prod', account: { name: 'x' } }) // no configDir
    // write it back through plain fs (test seam)
    const fs = require('node:fs')
    fs.writeFileSync(path, JSON.stringify(raw, null, 2))
    expect(() => loadConfig({ env: {}, homedir })).toThrow(InvalidWorkerProfileError)
  })

  it('normalizes the D-9.5-09 harness trio: enabled defaults true; roleFile/skills accepted', () => {
    const path = resolveConfigPath({ env: {}, homedir })
    loadConfig({ env: {}, homedir })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.workers.push({
      id: 'w-extra',
      lane: 'research',
      provider: 'claude',
      account: { name: 'max-1', configDir: '~/.sma-accounts/max-1' },
      roleFile: '.claude/agents/w-extra.md',
      skills: ['sma-fix'],
    })
    const fs = require('node:fs')
    fs.writeFileSync(path, JSON.stringify(raw, null, 2))
    const cfg = loadConfig({ env: {}, homedir })
    const extra = cfg.workers.find((w: any) => w.id === 'w-extra')
    expect(extra.enabled).toBe(true)
    expect(extra.roleFile).toBe('.claude/agents/w-extra.md')
    expect(extra.skills).toEqual(['sma-fix'])
  })
})

describe('secretsView (T-9.5-01 — the only loggable shape)', () => {
  it('collapses token and every account.oauthTokenEnv to [set]/[unset]; no secret leaks', () => {
    const cfg = loadConfig({ env: {}, homedir })
    const firstEnvName = cfg.workers[0].account.oauthTokenEnv
    const view = secretsView(cfg, { env: { [firstEnvName]: 'super-secret-token' } })

    expect(view.token).toBe('[set]')
    // the account whose env var is populated shows [set]; others [unset]
    const first = view.workers.find((w: any) => w.account.oauthTokenEnv === '[set]')
    expect(first).toBeTruthy()
    const unsetOnes = view.workers.filter((w: any) => w.account.oauthTokenEnv === '[unset]')
    expect(unsetOnes.length).toBeGreaterThan(0)

    // the raw secret + the raw env-var NAME never appear anywhere in the loggable shape
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('super-secret-token')
    expect(serialized).not.toContain(cfg.token)
    expect(serialized).not.toContain(firstEnvName)
  })

  it('token [unset] when absent', () => {
    const cfg = loadConfig({ env: {}, homedir })
    const view = secretsView({ ...cfg, token: '' }, { env: {} })
    expect(view.token).toBe('[unset]')
  })
})
