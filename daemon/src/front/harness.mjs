/**
 * harness.mjs — THE HARNESS READ MODEL + THE TWO-STEP ACTIVATION APPLIERS (Phase 9.5
 * Plan 11, Task 2; D-9.5-09, wireframe modules 8/9/12). The data contract the Phase 9.6
 * SPA renders modules 8 (агенты), 9 (навыки), 12 (MCP-подключения) against — engine only.
 *
 * ═══════════════════════ THE TWO-STEP ACTIVATION LAW ══════════════════════════════
 * «Включить» is TWO human acts, and this module owns the second one only:
 *   (1) APPROVE — the EXISTING serialized merge verb (server.mjs handleApprove) lands the
 *       forged definition FILE in the host clone's tree. Not here.
 *   (2) TOGGLE / ASSIGN — an applier here writes the roster config FROM THE FILE'S FIELDS
 *       (lane/provider/model/effort read out of the merged `.claude/agents/<id>.md`) + pool
 *       defaults. The request contributes ONLY an id and a boolean — the founder's free-text
 *       description NEVER crosses into a config file or a spawn command (T-9.5-37/39).
 * So a new profile can only be built from a definition file that a human already approved
 * into the tree; an unknown id with no file is refused. Request text → data, never config.
 *
 * ═══════════════════════ THE MCP REGISTRY LAW (T-9.5-38, RCE-closed) ═════════════
 * The live registry `~/.sma-daemon/mcp.json` (SMA_DAEMON_MCP override) maps id →
 * {command, args, envNames, enabled}. Entries — command, args, env-var NAMES — are created
 * and edited ONLY by a human on the host; NO daemon code path here writes them. The front
 * can flip the `enabled` BOOLEAN of an EXISTING id and nothing else: applyMcpToggle reads the
 * entry, flips one boolean, rewrites — it has no input by which a command could be injected,
 * so remote-code-execution through the toggle is structurally impossible. A free-form
 * «+ Подключить инструмент» is a forge PROPOSAL draft (kind 'mcp'), which a human copies into
 * the registry by hand — never an automatic launch command.
 *
 * ═══════════════════════ SECRETS-VIEW POSTURE (T-9.5-41) ═════════════════════════
 * The read model is EXPLICIT-PICK. It exposes env-var NAMES with a '[set]'/'[unset]' status
 * (whether the NAMED var is populated in the process env) — never a token, never a command,
 * never a file body. Env VALUES never appear in a harness payload.
 *
 * Node built-ins only; every fs call + env + homedir is injectable so tests never touch the
 * real ~/.sma-daemon or repo tree. Every config/registry write goes through atomicWriteJson
 * (plan-01 posture). Zero deps.
 */

import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
} from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

import { atomicWriteJson } from '../../../scripts/sma/lib/fs-atomics.mjs'
import { resolveConfigPath } from '../config.mjs'

// ── named errors ──

export class InvalidMcpRegistryError extends Error {
  constructor(message) { super(message); this.name = 'InvalidMcpRegistryError' }
}
export class UnknownMcpServerError extends Error {
  constructor(message) { super(message); this.name = 'UnknownMcpServerError' }
}
export class UnknownProfileError extends Error {
  constructor(message) { super(message); this.name = 'UnknownProfileError' }
}
export class MissingDefinitionFileError extends Error {
  constructor(message) { super(message); this.name = 'MissingDefinitionFileError' }
}
export class UnknownSkillError extends Error {
  constructor(message) { super(message); this.name = 'UnknownSkillError' }
}

/** Registry entry id shape — the id-allowlist the toggle validates against. */
const MCP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

/** roleFile body cap prepended to a session prompt (resolveWorkerContext). */
const ROLE_PREAMBLE_CAP = 8 * 1024

// ── tiny fs helpers (all injectable) ──

function readFileSafe(path, fsImpl) {
  const readFileSync = (fsImpl && fsImpl.readFileSync) || fsReadFileSync
  try {
    return String(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function existsFor(fsImpl) {
  return (fsImpl && fsImpl.existsSync) || fsExistsSync
}

// ── a narrow frontmatter reader (draft/definition schema; zero-dep) ──

/** Strip one layer of surrounding quotes. */
function unquote(v) {
  const t = String(v ?? '').trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * readFrontmatter(text) → {frontmatter, body}. Parses a leading `---` fence: flat scalars,
 * `key: [a, b]` inline arrays, and `key:` + 2-space `- item` dash-lists. This reads MERGED
 * definition files (an approved forge draft), so it mirrors the forge draft schema; no
 * third-party YAML (zero-dep law). Absent/broken fence → {frontmatter:null}.
 */
function readFrontmatter(text) {
  const s = String(text ?? '')
  if (!s.startsWith('---\n')) return { frontmatter: null, body: s }
  const close = s.indexOf('\n---', 3)
  if (close === -1) return { frontmatter: null, body: s }
  const block = s.slice(4, close)
  const body = s.slice(close + 4).replace(/^\r?\n/, '')
  const fm = {}
  const lines = block.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line)
    if (!m) { i += 1; continue }
    const key = m[1].toLowerCase()
    const rest = m[2].trim()
    if (rest === '') {
      const arr = []
      let j = i + 1
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        arr.push(unquote(lines[j].replace(/^\s*-\s+/, '').trim()))
        j += 1
      }
      fm[key] = arr.length ? arr : ''
      i = arr.length ? j : i + 1
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim()
      fm[key] = inner === '' ? [] : inner.split(',').map((x) => unquote(x.trim()))
      i += 1
      continue
    }
    fm[key] = unquote(rest)
    i += 1
  }
  return { frontmatter: fm, body }
}

// ── the MCP registry (the allowlist) ──

/**
 * resolveMcpRegistryPath({env, homedir}) — the registry path. SMA_DAEMON_MCP wins; else
 * ~/.sma-daemon/mcp.json (homedir injectable).
 */
export function resolveMcpRegistryPath({ env = process.env, homedir = osHomedir } = {}) {
  const override = env.SMA_DAEMON_MCP
  if (override && String(override).trim()) return override
  return join(homedir(), '.sma-daemon', 'mcp.json')
}

/**
 * loadMcpRegistry({homedir, env, fsImpl}) → {servers:[{id, title, purposeRu, command, args,
 * envNames, enabled}], path}. An absent file → {servers:[]}; a malformed file → a named
 * error (never a silent empty). The module contract: NO code path here ever WRITES the
 * command/args/envNames of an entry — only a human on the host creates/edits those.
 *
 * @param {{homedir?:Function, env?:object, fsImpl?:object}} [opts]
 * @returns {{servers:Array, path:string}}
 */
export function loadMcpRegistry({ homedir = osHomedir, env = process.env, fsImpl } = {}) {
  const existsSync = existsFor(fsImpl)
  const path = resolveMcpRegistryPath({ env, homedir })
  if (!existsSync(path)) return { servers: [], path }
  const raw = readFileSafe(path, fsImpl)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new InvalidMcpRegistryError(`mcp registry at ${path} is not valid JSON`)
  }
  if (!parsed || !Array.isArray(parsed.servers)) {
    throw new InvalidMcpRegistryError(`mcp registry at ${path} must be an object with a "servers" array`)
  }
  return { servers: parsed.servers, path }
}

// ── the read model (the SPA data contract) ──

/** Build one agent card: profile fields joined with the merged roleFile frontmatter. */
function agentEntry(worker, repoDir, fsImpl) {
  let can = []
  let cannot = []
  let title = worker.title ?? worker.id
  if (worker.roleFile) {
    const content = readFileSafe(join(repoDir ?? '.', worker.roleFile), fsImpl)
    const fm = content ? readFrontmatter(content).frontmatter : null
    if (fm) {
      if (fm.name) title = fm.name
      if (Array.isArray(fm.can)) can = fm.can
      if (Array.isArray(fm.cannot)) cannot = fm.cannot
    }
  }
  return {
    id: worker.id,
    title,
    lane: worker.lane ?? null,
    provider: worker.provider ?? null,
    ...(worker.model !== undefined ? { model: worker.model } : {}),
    ...(worker.effort !== undefined ? { effort: worker.effort } : {}),
    enabled: worker.enabled !== false,
    ...(worker.roleFile !== undefined ? { roleFile: worker.roleFile } : {}),
    can,
    cannot,
  }
}

/** Scan the .claude/skills tree (each SKILL.md) and join per-profile assignment. */
function scanSkills(config, repoDir, fsImpl) {
  const skillsDir = join(repoDir ?? '.', '.claude', 'skills')
  const readdirSync = (fsImpl && fsImpl.readdirSync) || fsReaddirSync
  let names = []
  try {
    names = readdirSync(skillsDir)
  } catch {
    names = []
  }
  const out = []
  for (const id of names) {
    const content = readFileSafe(join(skillsDir, String(id), 'SKILL.md'), fsImpl)
    if (!content) continue // not a skill dir (no SKILL.md)
    const fm = readFrontmatter(content).frontmatter
    const title = (fm && (fm.name || fm.title)) || String(id)
    const assignedTo = (config.workers ?? [])
      .filter((w) => Array.isArray(w.skills) && w.skills.includes(String(id)))
      .map((w) => w.id)
    out.push({ id: String(id), title, assignedTo })
  }
  return out
}

/** MCP card: env-var NAMES with '[set]'/'[unset]' status — NEVER the value (secretsView). */
function mcpEntry(server, env) {
  const names = Array.isArray(server.envNames) ? server.envNames : []
  const envStatus = {}
  for (const name of names) envStatus[String(name)] = env[String(name)] ? '[set]' : '[unset]'
  return {
    id: server.id,
    title: server.title ?? server.id,
    purposeRu: server.purposeRu ?? '',
    enabled: server.enabled === true,
    envStatus,
  }
}

/**
 * readHarness({config, registry, adapter, repoDir, fsImpl, env}) → ONE explicit-pick payload
 * {agents, skills, mcp, drafts} for the 9.6 modules. Agents join profile + roleFile
 * frontmatter; skills scan the tree + per-profile assignment; mcp exposes env-var NAMES with
 * '[set]'/'[unset]' only (values NEVER appear); drafts are the forge tasks awaiting approval
 * (kind + draftPath). No field carries tokens, commands, or file bodies.
 *
 * @param {{config:object, registry?:object, adapter?:object, repoDir?:string, fsImpl?:object, env?:object}} args
 * @returns {Promise<{agents:Array, skills:Array, mcp:Array, drafts:Array}>}
 */
export async function readHarness({ config, registry, adapter, repoDir, fsImpl, env = process.env } = {}) {
  const cfg = config ?? {}
  const agents = (cfg.workers ?? []).map((w) => agentEntry(w, repoDir, fsImpl))
  const skills = scanSkills(cfg, repoDir, fsImpl)
  const mcp = ((registry && registry.servers) || []).map((s) => mcpEntry(s, env))

  let drafts = []
  if (adapter && typeof adapter.list === 'function') {
    let rows = []
    try {
      rows = await adapter.list({})
    } catch {
      rows = []
    }
    drafts = rows
      .filter((r) => r && r.lane === 'forge' && (r.status === 'completed' || r.status === 'awaiting_approval'))
      .map((r) => ({
        id: r.id,
        title: r.title ?? null,
        kind: (r.forge && r.forge.kind) ?? r.kind ?? null,
        draftPath: r.draftPath ?? (r.result && r.result.draftPath) ?? null,
        status: r.status,
      }))
  }

  return { agents, skills, mcp, drafts }
}

// ── the two-step activation appliers (config/registry writes, atomic) ──

/** Write the whole config atomically to its resolved path (fsImpl fs overrides). */
function writeConfig(config, { env, homedir, fsImpl }) {
  const path = resolveConfigPath({ env, homedir })
  atomicWriteJson(path, config, {
    mkdirFn: fsImpl && fsImpl.mkdirSync,
    writeFn: fsImpl && fsImpl.writeFileSync,
    renameFn: fsImpl && fsImpl.renameSync,
  })
  return path
}

/** Build a new profile from an APPROVED definition file + pool defaults (never request text). */
function profileFromDefinition(id, enabled, config, repoDir, fsImpl) {
  const defPath = join(repoDir ?? '.', '.claude', 'agents', `${id}.md`)
  const content = readFileSafe(defPath, fsImpl)
  if (content == null) {
    throw new MissingDefinitionFileError(
      `no definition file .claude/agents/${id}.md — approve-merge the forged draft before toggling (two-step activation)`,
    )
  }
  const fm = readFrontmatter(content).frontmatter || {}
  // pool default: reuse an existing account (provider-matched if possible) — never invent one.
  const workers = config.workers ?? []
  const provider = fm.provider || 'claude'
  const donor = workers.find((w) => w.provider === provider) || workers[0]
  if (!donor || !donor.account) {
    throw new UnknownProfileError(`cannot create profile "${id}": no pool account to inherit (empty roster)`)
  }
  return {
    id,
    lane: fm.lane || 'prod',
    provider,
    ...(fm.model ? { model: fm.model } : {}),
    ...(fm.effort ? { effort: fm.effort } : {}),
    account: donor.account,
    roleFile: `.claude/agents/${id}.md`,
    skills: [],
    enabled: !!enabled,
  }
}

/**
 * applyAgentToggle({config, id, enabled, repoDir, fsImpl, env, homedir}) → the updated config.
 * An EXISTING profile: flip its `enabled`. A NEW id: the definition file
 * `.claude/agents/<id>.md` MUST exist (already approve-merged) — the profile is built from
 * the FILE's fields + pool defaults, the request contributing only id + enabled. Written
 * atomically. Unknown id with no file → MissingDefinitionFileError.
 */
export function applyAgentToggle({ config, id, enabled, repoDir, fsImpl, env = process.env, homedir = osHomedir }) {
  if (!config || !Array.isArray(config.workers)) throw new UnknownProfileError('applyAgentToggle: config.workers required')
  if (typeof id !== 'string' || !id) throw new UnknownProfileError('applyAgentToggle: id required')
  const workers = config.workers
  const idx = workers.findIndex((w) => w && w.id === id)

  let nextWorkers
  if (idx !== -1) {
    nextWorkers = workers.map((w, i) => (i === idx ? { ...w, enabled: !!enabled } : w))
  } else {
    const profile = profileFromDefinition(id, enabled, config, repoDir, fsImpl)
    nextWorkers = [...workers, profile]
  }
  const nextConfig = { ...config, workers: nextWorkers }
  writeConfig(nextConfig, { env, homedir, fsImpl })
  return nextConfig
}

/**
 * applySkillAssign({config, skillId, workerIds, repoDir, fsImpl, env, homedir}) → the updated
 * config. The skill file `.claude/skills/<skillId>/SKILL.md` MUST exist; every workerId must
 * be an existing profile. REPLACES the skill's assignment: the listed workers get skillId in
 * their `skills`, every other worker has it removed. Empty workerIds = unassign everywhere.
 * Written atomically.
 */
export function applySkillAssign({ config, skillId, workerIds, repoDir, fsImpl, env = process.env, homedir = osHomedir }) {
  if (!config || !Array.isArray(config.workers)) throw new UnknownProfileError('applySkillAssign: config.workers required')
  if (typeof skillId !== 'string' || !skillId) throw new UnknownSkillError('applySkillAssign: skillId required')
  const skillFile = join(repoDir ?? '.', '.claude', 'skills', skillId, 'SKILL.md')
  if (!readFileSafe(skillFile, fsImpl)) {
    throw new UnknownSkillError(`no skill file .claude/skills/${skillId}/SKILL.md`)
  }
  const ids = Array.isArray(workerIds) ? workerIds.map(String) : []
  const known = new Set(config.workers.map((w) => w.id))
  for (const wid of ids) {
    if (!known.has(wid)) throw new UnknownProfileError(`applySkillAssign: unknown worker "${wid}"`)
  }
  const assignSet = new Set(ids)
  const nextWorkers = config.workers.map((w) => {
    const cur = Array.isArray(w.skills) ? w.skills.filter((s) => s !== skillId) : []
    const next = assignSet.has(w.id) ? [...cur, skillId] : cur
    return { ...w, skills: next }
  })
  const nextConfig = { ...config, workers: nextWorkers }
  writeConfig(nextConfig, { env, homedir, fsImpl })
  return nextConfig
}

/**
 * applyMcpToggle({registry, serverId, enabled, homedir, env, fsImpl}) → the updated registry.
 * serverId must match an EXISTING entry (MCP_ID_RE); ONLY the `enabled` boolean changes — the
 * applier reads the entry, flips one boolean, rewrites via atomicWriteJson. There is NO input
 * by which command/args/envNames could be altered, so the post-toggle registry deep-equals the
 * original except `enabled` (T-9.5-38, RCE-closed). Unknown id → UnknownMcpServerError.
 */
export function applyMcpToggle({ registry, serverId, enabled, homedir = osHomedir, env = process.env, fsImpl }) {
  if (typeof serverId !== 'string' || !MCP_ID_RE.test(serverId)) {
    throw new InvalidMcpRegistryError(`applyMcpToggle: invalid serverId "${serverId}"`)
  }
  const servers = registry && Array.isArray(registry.servers) ? registry.servers : []
  const idx = servers.findIndex((s) => s && s.id === serverId)
  if (idx === -1) throw new UnknownMcpServerError(`applyMcpToggle: unknown mcp server "${serverId}"`)

  const nextServers = servers.map((s, i) => (i === idx ? { ...s, enabled: !!enabled } : s))
  const path = resolveMcpRegistryPath({ env, homedir })
  atomicWriteJson(path, { servers: nextServers }, {
    mkdirFn: fsImpl && fsImpl.mkdirSync,
    writeFn: fsImpl && fsImpl.writeFileSync,
    renameFn: fsImpl && fsImpl.renameSync,
  })
  return { ...registry, servers: nextServers, path }
}

/**
 * resolveWorkerContext({worker, repoDir, fsImpl}) → {rolePreamble?, skillsList}. The merged
 * roleFile body (capped 8 KB) becomes the rolePreamble the loop prepends to an ENABLED
 * agent's task prompt — this is what makes «включён» real in a session — and the assigned
 * skill names travel alongside. No roleFile → no preamble (skillsList still returned).
 *
 * @param {{worker:object, repoDir?:string, fsImpl?:object}} args
 * @returns {{rolePreamble?:string, skillsList:string[]}}
 */
export function resolveWorkerContext({ worker, repoDir, fsImpl } = {}) {
  const skillsList = worker && Array.isArray(worker.skills) ? worker.skills.slice() : []
  let rolePreamble
  if (worker && worker.roleFile) {
    const content = readFileSafe(join(repoDir ?? '.', worker.roleFile), fsImpl)
    if (content) {
      const { body } = readFrontmatter(content)
      rolePreamble = String(body || content).slice(0, ROLE_PREAMBLE_CAP)
    }
  }
  return { ...(rolePreamble ? { rolePreamble } : {}), skillsList }
}
