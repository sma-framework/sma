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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { atomicWriteJson, atomicWriteRaw } from '../../../scripts/sma/lib/fs-atomics.mjs'
import { notMirroredDeclaration } from '../../../scripts/sma/lib/rules-parity.mjs'
import { TICKET_HOOK_TIMEOUT_S } from '../../../scripts/sma/lib/tool-gate.mjs'
import shellProjection from '../../../sma-core/bin/lib/shell-command-projection.cjs'

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

/**
 * PERSONAL_LAYER_DECLARATION — the refusal this module states OUT LOUD about the widening
 * half of a permission file, in the vocabulary the parity check reads.
 *
 * Written as a shared constant rather than two string literals on purpose: the words in the
 * attempt record and the words the checker demands are then the same words by construction.
 * A future edit that started carrying `allow` across would have to delete this declaration
 * to keep its own tests green, and deleting it turns the check red — which is the only way a
 * rule about RIGHTS can be a rule rather than a habit.
 */
export const PERSONAL_LAYER_DECLARATION = Object.freeze(notMirroredDeclaration())

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

/**
 * TOOL_GATE_MARKER — how our own hook entry recognises itself in a file it does not own.
 * Written into the entry rather than inferred from the command text: the command carries an
 * absolute path that differs on every machine, and matching on a path is how a second copy
 * of the same hook gets appended on every mirror until the file is a list of duplicates.
 */
export const TOOL_GATE_MARKER = 'sma-tool-gate'

/** The event the parking gate rides on. Named once, read by the writer and the remover. */
export const TOOL_GATE_EVENT = 'PreToolUse'

/** This module's own directory — the anchor for the path of the verb the hook runs. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * toolGateHookEntry({platform}) → the hook entry that parks a worker's dangerous call.
 *
 * THE DECLARED TIMEOUT IS NOT A NUMBER WRITTEN HERE. It is imported from the ticket module,
 * which declares it beside the SMALLER deadline the gate answers by. Spelled twice, the two
 * would drift, and the drift has exactly one shape: a hook that outlives the timeout it
 * declared is cancelled by the harness and the dangerous call goes through.
 *
 * The command string is projected by the SAME module every managed hook installation uses —
 * quoting and path normalisation on Windows are not re-invented here.
 */
export function toolGateHookEntry({ platform = process.platform } = {}) {
  const cliPath = resolve(MODULE_DIR, '..', '..', '..', 'scripts', 'sma', 'cli.mjs')
  const command = shellProjection.projectShellCommandText({
    runnerToken: 'node',
    argTokens: [JSON.stringify(platform === 'win32' ? cliPath.replace(/\\/g, '/') : cliPath), 'tool-gate'],
    runtime: 'claude',
    platform,
  })
  return {
    matcher: '*',
    smaHook: TOOL_GATE_MARKER,
    hooks: [{ type: 'command', command, timeout: TICKET_HOOK_TIMEOUT_S }],
  }
}

/** Всё, что не наше, — чужое и остаётся нетронутым. Один предикат на записывающего и снимающего. */
function isToolGateEntry(entry) {
  return !!entry && typeof entry === 'object' && entry.smaHook === TOOL_GATE_MARKER
}

/**
 * withToolGateHook(hooks, {platform}) → the same hooks plus ours, APPENDED.
 *
 * THE HUMAN'S HOOKS SURVIVE WHOLE. The per-event merge above REPLACES an event's list, which
 * is right for an override that means «this event is now that» and catastrophically wrong
 * here: the founder's own hook on the same event would vanish from the worker's file, and
 * nothing would ever say so. So this one appends, and it removes only its own previous copy
 * — the mirror runs before every spawn, and a writer that cannot recognise itself turns an
 * idempotent operation into a growing list.
 */
export function withToolGateHook(hooks, { platform = process.platform } = {}) {
  const out = hooks && typeof hooks === 'object' ? deepCopy(hooks) : {}
  const existing = Array.isArray(out[TOOL_GATE_EVENT]) ? out[TOOL_GATE_EVENT] : []
  out[TOOL_GATE_EVENT] = [...existing.filter((e) => !isToolGateEntry(e)), toolGateHookEntry({ platform })]
  return out
}

/**
 * withoutToolGateHook(hooks) → the same hooks minus ours, and nothing else changed.
 *
 * The teardown half, exported because a run that installs a hook into a file shared by the
 * whole machine owes the machine its removal — and a removal done by hand is a removal that
 * eventually takes a neighbour's line with it. An event left empty by the removal is deleted
 * rather than left as an empty list: an empty list is a statement, and this one would be a
 * false one.
 */
export function withoutToolGateHook(hooks) {
  if (!hooks || typeof hooks !== 'object') return hooks
  const out = deepCopy(hooks)
  const existing = Array.isArray(out[TOOL_GATE_EVENT]) ? out[TOOL_GATE_EVENT] : null
  if (!existing) return out
  const kept = existing.filter((e) => !isToolGateEntry(e))
  if (kept.length) out[TOOL_GATE_EVENT] = kept
  else delete out[TOOL_GATE_EVENT]
  return out
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
export function mergeWorkerSettings({ current, founder, plugins = [], overrides = {}, platform = process.platform } = {}) {
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

  // ── THE PARKING GATE, WRITTEN ON EVERY MIRROR, BESIDE THE SWITCHES ABOVE ──
  //
  // Independent of any project: the gate arrives with the ACCOUNT, so a worker started on a
  // project nobody prepared is gated the same as one started on ours. Appended, never
  // substituted — whatever hooks came from the person keep their place, and our own previous
  // copy is the only entry this replaces.
  //
  // Harmless where it does not belong: with no attempt directory in the environment the gate
  // answers «allow» and says the gate is not configured, so the same account file can be
  // shared with sessions this daemon knows nothing about.
  out.hooks = withToolGateHook(out.hooks, { platform })

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
      ...PERSONAL_LAYER_DECLARATION,
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
