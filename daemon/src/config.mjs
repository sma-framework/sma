/**
 * config.mjs — the SMA V5 daemon config loader: worker profiles, the 0600 secrets
 * file, and the front-auth token (Phase 9.5 Plan 01; D-9.5-03/03a/05a, 09, 11).
 *
 * WHAT IT IS: the single source of truth for the worker pool the daemon runs and
 * the secrets it must never leak. The file lives at ~/.sma-daemon/config.json
 * (override: SMA_DAEMON_CONFIG) and is created on first boot with a random front
 * token. Everything downstream (runner routing, front auth, roster toggle applier)
 * reads THIS shape.
 *
 * SECURITY POSTURE (T-9.5-01, the whole reason this module is careful):
 *   - 0600 FILE. The config carries the front token; it is written mode 0600 so only
 *     the daemon user can read it. On win32 chmod is a documented no-op — we attempt
 *     it and swallow the failure (never crash the boot on a platform that ignores it).
 *   - TOKENS BY ENV-VAR NAME, NEVER VALUE. An account's OAuth token is referenced by
 *     the NAME of the env var that holds it (`account.oauthTokenEnv`), never by its
 *     value. The token value lives only in the process environment, never on disk.
 *   - secretsView IS THE ONLY LOGGABLE SHAPE. Anything printed / journaled / sent to
 *     the roster goes through secretsView, which collapses the token AND every
 *     account.oauthTokenEnv to '[set]'/'[unset]' — no secret and no env-var name
 *     ever leaves the process.
 *
 * D-9.5-09 HARNESS TRIO: each worker carries `enabled` (roster on/off switch flipped
 * by plan 11's toggle applier — defaults true), `roleFile` (a merged
 * .claude/agents/<slug>.md definition), and `skills` (assigned skill slugs). The
 * `creator` role (lane 'forge') is shipped enabled-but-inert: the forge lane does
 * nothing without a task, and everything it produces is drafts-only behind plan 11's
 * lint gate + two-step human activation.
 *
 * D-9.5-03a DAYTIME PRIORITY: exactly one Max account carries `dayPriorityOwner:true`
 * — the founder's daytime account the scheduler must not drain while the founder works
 * (consumed by plan 9.5-05).
 *
 * Node built-ins only. randomBytes for the token; atomicWriteJson (scripts/sma/lib,
 * zero-dep law intact) for the write. env / homedir / fsImpl are all
 * dependency-injectable so tests never touch the real ~/.sma-daemon.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, chmodSync as fsChmodSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { atomicWriteJson } from '../../scripts/sma/lib/fs-atomics.mjs'

/** Named error for a structurally-invalid worker profile (missing id/lane/account.configDir). */
export class InvalidWorkerProfileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidWorkerProfileError'
  }
}

/**
 * resolveConfigPath({env, homedir}) — the config file path.
 * SMA_DAEMON_CONFIG wins; otherwise ~/.sma-daemon/config.json (homedir injectable).
 *
 * @param {{env?:object, homedir?:Function}} [opts]
 * @returns {string}
 */
export function resolveConfigPath({ env = process.env, homedir = osHomedir } = {}) {
  const override = env.SMA_DAEMON_CONFIG
  if (override && String(override).trim()) return override
  return join(homedir(), '.sma-daemon', 'config.json')
}

/**
 * defaultConfig(token) — the D-9.5-03 default pool with placeholder account dirs.
 * 3 × Claude Max (one dayPriorityOwner) + 1 × Codex/Pro + the `creator` forge role
 * riding max-1's account (a ROLE, not a fifth subscription — D-9.5-09).
 */
function defaultConfig(token) {
  const maxAccount = (n) => ({
    name: `max-${n}`,
    configDir: `~/.sma-accounts/max-${n}`,
    oauthTokenEnv: `SMA_MAX_${n}_TOKEN`,
    spendLogsDir: `~/.sma-accounts/max-${n}/spend`,
  })
  const proAccount = {
    name: 'pro-1',
    configDir: '~/.sma-accounts/pro-1',
    oauthTokenEnv: 'SMA_PRO_1_TOKEN',
    spendLogsDir: '~/.sma-accounts/pro-1/spend',
  }
  return {
    queueUrl: 'postgres://localhost:5432/sma_daemon',
    bind: '127.0.0.1', // D-9.5-05: 0.0.0.0 is explicit opt-in only
    port: 7777,
    token,
    backlogScanMinutes: 60,
    agingHours: 24, // D-9.5-11: queued tasks older than this raise the «застряла» flow signal
    webhookUrl: '', // empty = report-back off (notify.mjs off-by-default posture)
    budget: {
      monthlyApiCapEur: 0, // 0 = no API fallback budget until the founder sets one (D-9.5-03b)
      warnPct: [70, 90],
    },
    workers: [
      // D-9.5-03a: max-1 is the founder's daytime-priority account.
      { id: 'max-1', lane: 'prod', provider: 'claude', account: maxAccount(1), dayPriorityOwner: true, enabled: true },
      { id: 'max-2', lane: 'prod', provider: 'claude', account: maxAccount(2), enabled: true },
      { id: 'max-3', lane: 'prod', provider: 'claude', account: maxAccount(3), enabled: true },
      // Codex/Pro rides the research/paperwork lane (D-9.5-04 default routing).
      { id: 'pro-1', lane: 'research', provider: 'codex', account: proAccount, enabled: true },
      // D-9.5-09: the «Создатель» forge role — rides max-1's account, enabled but inert.
      { id: 'creator', lane: 'forge', provider: 'claude', account: maxAccount(1), enabled: true },
    ],
  }
}

/**
 * validateWorker(w) — structural gate: id, lane, and account.configDir are required.
 * Normalizes the D-9.5-09 harness trio (enabled defaults true; roleFile/skills accepted).
 * Throws InvalidWorkerProfileError on a missing required field.
 */
function validateWorker(w) {
  if (!w || typeof w !== 'object') throw new InvalidWorkerProfileError('worker profile is not an object')
  if (!w.id) throw new InvalidWorkerProfileError('worker profile missing "id"')
  if (!w.lane) throw new InvalidWorkerProfileError(`worker "${w.id}" missing "lane"`)
  if (!w.account || !w.account.configDir) {
    throw new InvalidWorkerProfileError(`worker "${w.id}" missing "account.configDir"`)
  }
  return {
    ...w,
    enabled: w.enabled === undefined ? true : Boolean(w.enabled),
    ...(w.roleFile !== undefined ? { roleFile: w.roleFile } : {}),
    ...(w.skills !== undefined ? { skills: w.skills } : {}),
  }
}

/**
 * validateConfig(config) — returns a normalized copy; throws on any invalid worker.
 */
function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new InvalidWorkerProfileError('config is not an object')
  const workers = Array.isArray(config.workers) ? config.workers.map(validateWorker) : []
  return { ...config, workers }
}

/**
 * loadConfig({env, homedir, fsImpl}) — read the daemon config, creating a 0600 default
 * (with a fresh 64-hex token) on first boot. Existing files are parsed and validated.
 *
 * @param {{env?:object, homedir?:Function, fsImpl?:object}} [opts]
 * @returns {object} the normalized config
 */
export function loadConfig({ env = process.env, homedir = osHomedir, fsImpl } = {}) {
  const io = fsImpl ?? {}
  const existsSync = io.existsSync ?? fsExistsSync
  const readFileSync = io.readFileSync ?? fsReadFileSync
  const chmodSync = io.chmodSync ?? fsChmodSync

  const path = resolveConfigPath({ env, homedir })

  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return validateConfig(raw)
  }

  // Bootstrap: fresh token, atomic write, best-effort 0600.
  const token = randomBytes(32).toString('hex')
  const config = validateConfig(defaultConfig(token))
  atomicWriteJson(path, config, {
    mkdirFn: io.mkdirSync,
    writeFn: io.writeFileSync,
    renameFn: io.renameSync,
  })
  try {
    chmodSync(path, 0o600) // win32: documented no-op — never fail the boot on it
  } catch {
    /* platform ignores chmod (win32) — the file is still owner-scoped by ACL default */
  }
  return config
}

/**
 * secretsView(config, {env}) — THE ONLY loggable shape. Deep-copies the config with
 * `token` and every `account.oauthTokenEnv` collapsed to '[set]'/'[unset]'. The raw
 * token and the env-var NAMES never appear in the returned object (T-9.5-01).
 *
 * `[set]`/`[unset]` for an account reflects whether the NAMED env var is populated in
 * `env` (default process.env) — operational insight with zero leakage.
 *
 * @param {object} config
 * @param {{env?:object}} [opts]
 * @returns {object}
 */
export function secretsView(config, { env = process.env } = {}) {
  const workers = (config.workers ?? []).map((w) => ({
    ...w,
    account: {
      ...w.account,
      oauthTokenEnv: env[w.account?.oauthTokenEnv] ? '[set]' : '[unset]',
    },
  }))
  return {
    ...config,
    token: config.token ? '[set]' : '[unset]',
    workers,
  }
}
