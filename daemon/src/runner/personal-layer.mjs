/**
 * personal-layer.mjs — the founder's personal layer, mirrored into a worker account.
 *
 * WHY THIS EXISTS. A worker session is meant to be the same session the author gets in
 * his own terminal. His terminal reads a personal layer his worker never saw: the global
 * CLAUDE.md that carries the house rules, and the hooks that make a session announce
 * itself. Without that layer the worker is a different, quieter machine wearing the same
 * name — and the difference only shows up in the work, hours later. This module carries
 * the layer across, as FILES in the account directory, because the spawn flags that could
 * do it (`--settings`, `--permission-mode`, `--setting-sources`) are refused by the flag
 * guard and are not going to be un-refused.
 *
 * WHAT DOES NOT TRAVEL, and why each one is deliberate:
 *   - `permissions.allow` and `permissions.defaultMode`. The author's allow list is
 *     written for a person sitting at a keyboard and reaches well past the envelope a
 *     headless worker is given; `defaultMode: "auto"` in a user-level settings file
 *     switches a headless session into the automatic mode, which is a change of the
 *     permission REGIME, not a convenience. Only `deny` and `ask` are mirrored: they can
 *     only narrow. The result says `not mirrored` out loud so the attempt row can show it.
 *   - Anything private. Not by today's contents — by the SHAPE of the name: an env block,
 *     a key helper, a credential exporter, and any key whose name reads like a token, key,
 *     secret or password. A blacklist written against what the file happens to hold today
 *     is a blacklist that fails the day the file changes.
 *   - The author's plugins, model, status line and marketplaces. A worker account has no
 *     access to the author's plugin installs; its own list is stated in the worker profile.
 *
 * WHAT IS ADDED: `disableClaudeAiConnectors: true`, always. The connectors of a
 * subscription account are fetched from the server and arrive on their own; a worker is
 * supposed to reach only the tools we hand it.
 *
 * WHAT IS TOUCHED ON DISK: exactly two files — `settings.json` and `CLAUDE.md`. The
 * account directory also holds the OAuth state; a mirror that rewrote a directory instead
 * of two named files would be one bad glob away from logging the account out. The write is
 * atomic (temp sibling + rename), and the first overwrite of an existing settings file
 * keeps a dated copy under `backups/` (last five) — an overwrite nobody can undo is not
 * an overwrite anyone should make.
 *
 * Node built-ins only; every filesystem call and the clock are injectable so the tests run
 * on temporary directories and never look at a real configuration directory.
 */

import { createHash } from 'node:crypto'
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  unlinkSync as fsUnlinkSync,
} from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

import { atomicWriteJson, atomicWriteRaw } from '../../../scripts/sma/lib/fs-atomics.mjs'

/** Named error: the caller decides what an unreadable or unwritable layer means. */
export class PersonalLayerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PersonalLayerError'
  }
}

/**
 * The private CLASS of a settings key, by name shape rather than by value. A key called
 * `myToken` is treated exactly like one called `apiKey`: the point is that we never have
 * to be right about which of them holds something.
 */
export const SECRET_KEY_RE = /token|key|secret|password/i

/**
 * Keys that never cross even though their names look harmless: an env block reaches the
 * session and every child process it starts; a key helper and the credential exporters are
 * the account's own way in; model, status line, plugins and marketplaces belong to the
 * person's terminal, not to a worker.
 */
export const NEVER_MIRROR_KEYS = new Set([
  'env',
  'apiKeyHelper',
  'awsCredentialExport',
  'awsAuthRefresh',
  'model',
  'statusLine',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'pluginConfigs',
])

/**
 * The only keys a worker profile may state for itself. Anything else is refused when the
 * config loads — a silently dropped override is a rule the operator believes is in force.
 */
export const OVERRIDE_ALLOWLIST = ['hooks', 'permissions', 'autoMemoryDirectory', 'autoMemoryEnabled']

/** How many dated copies of the previous settings file are kept. */
export const BACKUP_KEEP = 5

/** The prefix every kept copy carries, so trimming can never look at a foreign file. */
const BACKUP_PREFIX = 'settings.json.bak-'

/** Every filesystem method this module uses, each one injectable, each one on node:fs. */
function resolveIo(fsImpl) {
  return {
    existsSync: (fsImpl && fsImpl.existsSync) || fsExistsSync,
    readFileSync: (fsImpl && fsImpl.readFileSync) || fsReadFileSync,
    writeFileSync: (fsImpl && fsImpl.writeFileSync) || fsWriteFileSync,
    renameSync: (fsImpl && fsImpl.renameSync) || fsRenameSync,
    mkdirSync: (fsImpl && fsImpl.mkdirSync) || fsMkdirSync,
    readdirSync: (fsImpl && fsImpl.readdirSync) || fsReaddirSync,
    unlinkSync: (fsImpl && fsImpl.unlinkSync) || fsUnlinkSync,
  }
}

/** sha8 — short enough for an attempt row, long enough to say «the same file or not». */
function sha8(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 8)
}

/** A copy nobody shares a reference with (hooks travel into a file, not into a closure). */
function deepCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Key-sorted serialization — used ONLY to answer «did anything actually change?». */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

/** Read a JSON file that may be absent; a broken one is named, never silently ignored. */
function readJsonFile(io, path) {
  if (!io.existsSync(path)) return null
  let text
  try {
    text = io.readFileSync(path, 'utf8')
  } catch (err) {
    throw new PersonalLayerError(`не читается ${path}: ${err && err.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new PersonalLayerError(`не разбирается как JSON ${path}: ${err && err.message}`)
  }
}

/** A copy of the source settings with every private-shaped key already gone. */
function withoutPrivateKeys(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (NEVER_MIRROR_KEYS.has(k) || SECRET_KEY_RE.test(k)) continue
    out[k] = v
  }
  return out
}

/**
 * readFounderLayer({sourceDir, fsImpl, homedir}) → what the author's directory offers.
 * Absent files are a legal answer (`claudeMd: null`, no hooks) — a machine where the
 * author keeps no global rules is still a machine a worker can run on.
 *
 * @param {{sourceDir?:string, fsImpl?:object, homedir?:Function}} [io]
 * @returns {{sourceDir:string, claudeMd:string|null, claudeMdSha:string|null,
 *            hooks:object|null, permissions:{deny:string[], ask:string[]}, raw:object|null}}
 */
export function readFounderLayer({ sourceDir, fsImpl, homedir = osHomedir } = {}) {
  const io = resolveIo(fsImpl)
  const dir = sourceDir || join(homedir(), '.claude')

  const mdPath = join(dir, 'CLAUDE.md')
  let claudeMd = null
  if (io.existsSync(mdPath)) {
    try {
      claudeMd = io.readFileSync(mdPath, 'utf8')
    } catch (err) {
      throw new PersonalLayerError(`не читается ${mdPath}: ${err && err.message}`)
    }
  }

  const raw = readJsonFile(io, join(dir, 'settings.json'))
  const perms = (raw && raw.permissions) || {}
  const asList = (v) => (Array.isArray(v) ? v.map(String) : [])

  return {
    sourceDir: dir,
    claudeMd,
    claudeMdSha: claudeMd === null ? null : sha8(claudeMd),
    hooks: raw && raw.hooks && typeof raw.hooks === 'object' ? deepCopy(raw.hooks) : null,
    // deny and ask only: they can only narrow what a worker may do
    permissions: { deny: asList(perms.deny), ask: asList(perms.ask) },
    raw: withoutPrivateKeys(raw),
  }
}

/** Hooks merge per EVENT: an override adds a Stop hook without erasing SessionStart. */
function mergeHooksByEvent(base, extra) {
  if (!extra || typeof extra !== 'object') return base
  return { ...(base || {}), ...deepCopy(extra) }
}

/** deny/ask concatenate without repeats — an override may narrow further, never widen. */
function mergePermissionRules(base, extra) {
  const out = { ...(base || {}) }
  for (const key of ['deny', 'ask']) {
    if (!Array.isArray(extra && extra[key])) continue
    out[key] = [...new Set([...(out[key] || []), ...extra[key].map(String)])]
  }
  return out
}

/** `["x@market"]` → `{"x@market": true}`; an empty list writes no key at all. */
function enabledPluginsFrom(plugins) {
  const list = Array.isArray(plugins) ? plugins.filter((p) => typeof p === 'string' && p) : []
  if (list.length === 0) return null
  const out = {}
  for (const p of list) out[p] = true
  return out
}

/**
 * mergeWorkerSettings({current, founder, plugins, overrides}) — pure: no disk, no clock.
 * Everything the account already carries survives untouched; the author contributes hooks
 * and the two narrowing permission lists; the profile contributes plugins and allow-listed
 * overrides; the connectors switch is ours and unconditional.
 *
 * @param {{current?:object, founder?:object, plugins?:string[], overrides?:object}} [input]
 * @returns {{settings:object, overridesApplied:string[], overridesDropped:string[]}}
 */
export function mergeWorkerSettings({ current, founder, plugins = [], overrides = {} } = {}) {
  const cur = current && typeof current === 'object' ? current : {}
  const out = { ...cur }

  let hooks = founder && founder.hooks ? deepCopy(founder.hooks) : deepCopy(cur.hooks)

  const fp = (founder && founder.permissions) || {}
  let permissions = { ...(cur.permissions || {}) }
  if (Array.isArray(fp.deny) && fp.deny.length) permissions.deny = [...fp.deny]
  if (Array.isArray(fp.ask) && fp.ask.length) permissions.ask = [...fp.ask]

  const overridesApplied = []
  const overridesDropped = []
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!OVERRIDE_ALLOWLIST.includes(key)) {
      overridesDropped.push(key)
      continue
    }
    overridesApplied.push(key)
    if (key === 'hooks') hooks = mergeHooksByEvent(hooks, value)
    else if (key === 'permissions') permissions = mergePermissionRules(permissions, value)
    else out[key] = deepCopy(value)
  }

  if (hooks) out.hooks = hooks
  if (Object.keys(permissions).length > 0) out.permissions = permissions

  // Belt and braces: nothing private may ARRIVE at a worker file. Keys the account already
  // carried are its own and are left alone — this sweep only refuses new arrivals.
  for (const key of Object.keys(out)) {
    if (Object.prototype.hasOwnProperty.call(cur, key)) continue
    if (NEVER_MIRROR_KEYS.has(key) || SECRET_KEY_RE.test(key)) delete out[key]
  }

  // Ours, written after the sweep because they are deliberate, not inherited.
  const enabled = enabledPluginsFrom(plugins)
  if (enabled) out.enabledPlugins = enabled
  out.disableClaudeAiConnectors = true

  return { settings: out, overridesApplied, overridesDropped }
}

/** Keep the file we are about to overwrite, then trim the shelf to the last `keep`. */
function keepPreviousSettings(io, accountDir, settingsPath, clock, keep) {
  const dir = join(accountDir, 'backups')
  io.mkdirSync(dir, { recursive: true })
  const stamp = String(clock().toISOString()).replace(/:/g, '-')
  const target = join(dir, `${BACKUP_PREFIX}${stamp}`)
  io.writeFileSync(target, io.readFileSync(settingsPath, 'utf8'))

  const kept = io
    .readdirSync(dir)
    .filter((name) => String(name).startsWith(BACKUP_PREFIX))
    .sort() // the stamp is an ISO instant, so lexical order IS chronological order
  for (const name of kept.slice(0, Math.max(0, kept.length - keep))) {
    try {
      io.unlinkSync(join(dir, name))
    } catch {
      // a copy we failed to delete is clutter, never a reason to abandon the write
    }
  }
  return target
}

/**
 * mirrorPersonalLayer(…) → the `personalLayer` record for the attempt row.
 * Idempotent: an unchanged layer writes nothing and reports `changed:false`, so calling it
 * before every spawn costs nothing.
 *
 * @param {{sourceDir?:string, accountDir:string, plugins?:string[], overrides?:object,
 *          fsImpl?:object, clock?:Function, homedir?:Function, keepBackups?:number}} input
 * @returns {object} what was mirrored, in the shape the ledger and the card read
 */
export function mirrorPersonalLayer({
  sourceDir,
  accountDir,
  plugins = [],
  overrides = {},
  fsImpl,
  clock = () => new Date(),
  homedir = osHomedir,
  keepBackups = BACKUP_KEEP,
} = {}) {
  if (!accountDir || typeof accountDir !== 'string') {
    throw new PersonalLayerError('нет каталога аккаунта работника (accountDir)')
  }
  const io = resolveIo(fsImpl)
  const founder = readFounderLayer({ sourceDir, fsImpl, homedir })

  const settingsPath = join(accountDir, 'settings.json')
  const current = readJsonFile(io, settingsPath)
  const { settings, overridesApplied, overridesDropped } = mergeWorkerSettings({
    current: current || {},
    founder,
    plugins,
    overrides,
  })

  let changed = false
  let backup = 'none'

  if (canonical(settings) !== canonical(current)) {
    if (io.existsSync(settingsPath)) {
      backup = keepPreviousSettings(io, accountDir, settingsPath, clock, keepBackups)
    }
    try {
      atomicWriteJson(settingsPath, settings, {
        mkdirFn: io.mkdirSync,
        writeFn: io.writeFileSync,
        renameFn: io.renameSync,
      })
    } catch (err) {
      throw new PersonalLayerError(`не записан ${settingsPath}: ${err && err.message}`)
    }
    changed = true
  }

  const mdPath = join(accountDir, 'CLAUDE.md')
  if (founder.claudeMd !== null) {
    const existing = io.existsSync(mdPath) ? io.readFileSync(mdPath, 'utf8') : null
    if (existing !== founder.claudeMd) {
      try {
        atomicWriteRaw(mdPath, founder.claudeMd, {
          mkdirFn: io.mkdirSync,
          writeFn: io.writeFileSync,
          renameFn: io.renameSync,
        })
      } catch (err) {
        throw new PersonalLayerError(`не записан ${mdPath}: ${err && err.message}`)
      }
      changed = true
    }
  }

  return {
    sourceDir: founder.sourceDir,
    claudeMd: founder.claudeMdSha === null ? 'absent' : founder.claudeMdSha,
    hooks: founder.hooks ? Object.keys(founder.hooks).length : 0,
    permissions: {
      deny: founder.permissions.deny.length,
      ask: founder.permissions.ask.length,
      allow: 'not mirrored',
      defaultMode: 'not mirrored',
    },
    plugins: Array.isArray(plugins) ? [...plugins] : [],
    connectors: 'disabled',
    backup,
    changed,
    overridesApplied,
    overridesDropped,
    writtenAt: clock().toISOString(),
  }
}
