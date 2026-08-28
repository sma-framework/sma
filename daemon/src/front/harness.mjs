/**
 * harness.mjs — THE HARNESS READ MODEL + THE TWO-STEP ACTIVATION APPLIERS. The data
 * contract the SPA renders the агенты / навыки / MCP-подключения screens against —
 * engine only.
 *
 * ═══════════════════════ THE TWO-STEP ACTIVATION LAW ═════════════════════════════
 * «Включить» is TWO human acts, and this module owns the second one only:
 *   (1) APPROVE — the EXISTING serialized merge verb (server.mjs handleApprove) lands the
 *       forged definition FILE in the host clone's tree. Not here.
 *   (2) TOGGLE / ASSIGN — an applier here writes the roster config FROM THE FILE'S FIELDS
 *       (lane/provider/model/effort read out of the merged `.claude/agents/<id>.md`) + pool
 *       defaults. The request contributes ONLY an id and a boolean — the founder's free-text
 *       description NEVER crosses into a config file or a spawn command.
 * So a new profile can only be built from a definition file that a human already approved
 * into the tree; an unknown id with no file is refused. Request text → data, never config.
 *
 * ═══════════════════════ THE MCP REGISTRY LAW (RCE-closed) ═══════════════════════
 * The live registry `~/.sma-daemon/mcp.json` (SMA_DAEMON_MCP override) maps id →
 * {command, args, envNames, enabled}. Entries — command, args, env-var NAMES — are created
 * and edited ONLY by a human on the host; NO daemon code path here writes them. The front
 * can flip the `enabled` BOOLEAN of an EXISTING id and nothing else: applyMcpToggle reads the
 * entry, flips one boolean, rewrites — it has no input by which a command could be injected,
 * so remote-code-execution through the toggle is structurally impossible. A free-form
 * «+ Подключить инструмент» is a forge PROPOSAL draft (kind 'mcp'), which a human copies into
 * the registry by hand — never an automatic launch command.
 *
 * ═══════════════════════ SECRETS-VIEW POSTURE ════════════════════════════════════
 * The read model is EXPLICIT-PICK. It exposes env-var NAMES with a '[set]'/'[unset]' status
 * (whether the NAMED var is populated in the process env) — never a token, never a command,
 * never a file body. Env VALUES never appear in a harness payload.
 *
 * ═══════════════════════ THE TWO SKILL STORES ════════════════════════════════════
 * A skill is a folder with a SKILL.md, and there are TWO places one can live:
 *   - THE PROJECT STORE, `<repo>/.claude/skills/` — the skills of the tree being served.
 *   - THE MACHINE STORE, `<CLAUDE_CONFIG_DIR|~/.claude>/skills/` (SMA_DAEMON_SKILLS wins) —
 *     the skills of the person at this keyboard, available under EVERY project.
 * Until both were read, a person whose skills live in the machine store opened the screen,
 * saw nothing, and concluded the product has no such feature — while the daemon had simply
 * looked in one directory out of two. So both are walked, EVERY card names the store it came
 * from, and the read model also returns the stores themselves — path, presence, count — so an
 * empty list can say WHERE it looked instead of saying nothing.
 *
 * NOTHING IS TAKEN FROM A THIRD TREE. These two are the whole of it: a skill from anywhere
 * else would arrive unattributable, and «где я это взял» is exactly what a card must answer.
 * A machine skill whose id is also a project skill is NOT shown twice and NOT silently
 * dropped — the project's own copy wins (it is nearer to the work) and says so on its card.
 *
 * WRITING ONE. `createMachineSkill` is the only writer, it writes ONLY into the machine store,
 * and it REFUSES an id that already exists in either store — a create door that silently
 * overwrote somebody's skill would be a delete nobody asked for. The request contributes an
 * id (a strict slug, so no path segment of it can ever leave that directory), a one-line
 * description and a body: TEXT into a markdown file, never a config value and never a command.
 *
 * ═══════════════════════ THE STOCK TEAM ══════════════════════════════════════════
 * `readStockTeam` is the SECOND read model in this module and it answers a different
 * question than `agents` does. `agents` is the PIPELINE: the worker profiles the roster
 * config declares. The stock team is what ARRIVED — every definition file the installer
 * wrote into `<config>/agents/`, whether or not the roster config has ever heard of it,
 * beside the user's own definitions in the same directory.
 *
 * Fork state is a CONTENT DIGEST comparison, never a modification time: the installer also
 * leaves a pristine copy of every shipped definition at `<config>/sma-core/agents/<id>.md`,
 * so «edited» is «the editable copy no longer digests to the pristine one». A reinstall
 * rewrites mtimes and would otherwise report the whole roster as edited.
 *
 * «A newer shipped version is available» needs a recorded baseline, and there is exactly one
 * honest place to keep it: the worker profile, written at the moment of activation by
 * `applyStockTeamToggle` (`stockDigest`, beside `enabled`). An agent that was never toggled
 * through that door has no baseline and is reported `unknown` — never a fabricated 'current'.
 *
 * Node built-ins only; every fs call + env + homedir is injectable so tests never touch the
 * real ~/.sma-daemon or repo tree. Every config/registry write goes through atomicWriteJson
 * (plan-01 posture). Zero deps.
 */

import { createHash } from 'node:crypto'
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
} from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

import { atomicWriteJson, atomicWriteRaw } from '../../../scripts/sma/lib/fs-atomics.mjs'
// The config writer is IMPORTED, never re-implemented: this file used to carry its own
// private twin of it, and a twin is how a rule ends up living in only one of the two places
// that write the same file. See config.mjs `writeConfig` — it is read-modify-write, so a key
// a person put in the file by hand survives a toggle pressed in the window. `stripDerivedDirs`
// left with the twin: the writer applies that rule itself, and calling it here again would be
// the same second opinion in a smaller disguise.
import { resolveConfigPath, writeConfig } from '../config.mjs'
import { telegramLinkView } from '../telegram/pairing.mjs'

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
/** A create that would land on top of a skill somebody already has — refused, never merged. */
export class SkillExistsError extends Error {
  constructor(message) { super(message); this.name = 'SkillExistsError' }
}
/** A create whose id, description or body is not something that may become a file. */
export class InvalidSkillError extends Error {
  constructor(message) { super(message); this.name = 'InvalidSkillError' }
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
 *
 * Line endings are normalized FIRST. A definition file checked out on Windows opens with
 * `---\r\n`, and matching the fence on `---\n` alone silently returned {frontmatter:null}
 * for it — which does not look like a failure anywhere downstream: an agent card lost its
 * can/cannot, and profileFromDefinition quietly built a DEFAULT profile instead of the
 * file's declared lane/provider/model, breaking the two-step activation law's promise that
 * a profile comes out of the file. A CRLF checkout is the same file.
 */
function readFrontmatter(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n')
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

// ── the two skill stores ──

/** Where a skill was found: the served tree, or this machine's own library. */
export const SKILL_SOURCES = Object.freeze(['project', 'machine'])

/** The frontmatter description a skill card carries as its subtitle, capped. */
const SKILL_DESCRIPTION_CAP = 300

/** The file a skill folder is recognised by — one spelling, shared by reader and writer. */
const SKILL_FILE = 'SKILL.md'

/**
 * resolveMachineSkillsDir({env, homedir}) — the MACHINE store: the skills of the person at
 * this keyboard, reachable under every project. SMA_DAEMON_SKILLS wins (the SMA_DAEMON_MCP
 * precedent, and what a test or a drive points somewhere harmless with); else
 * $CLAUDE_CONFIG_DIR/skills; else ~/.claude/skills. The same env-then-homedir order
 * resolveStockTeamDirs already walks — one machine, one idea of where its own things live.
 *
 * @param {{env?:object, homedir?:Function}} [opts]
 * @returns {string}
 */
export function resolveMachineSkillsDir({ env = process.env, homedir = osHomedir } = {}) {
  const override = env.SMA_DAEMON_SKILLS
  if (override && String(override).trim()) return String(override).trim()
  const configDir = env.CLAUDE_CONFIG_DIR
  if (configDir && String(configDir).trim()) return join(String(configDir).trim(), 'skills')
  return join(homedir(), '.claude', 'skills')
}

/**
 * skillStorePaths({repoDir, env, homedir}) → the two directories a skill may live in, in the
 * order they are searched. Exported because the WINDOW shows them: an empty list has to name
 * where it looked, and a path invented a second time on the front would name somewhere else.
 *
 * @param {{repoDir?:string, env?:object, homedir?:Function}} [opts]
 * @returns {Array<{source:string, path:string}>}
 */
export function skillStorePaths({ repoDir, env = process.env, homedir = osHomedir } = {}) {
  return [
    { source: 'project', path: join(repoDir ?? '.', '.claude', 'skills') },
    { source: 'machine', path: resolveMachineSkillsDir({ env, homedir }) },
  ]
}

/**
 * Read one skill folder → a card, or null when the folder holds no SKILL.md (an ordinary
 * directory that happens to sit beside skills is not a skill, and never a `problem`).
 */
function skillEntry({ id, dir, source, fsImpl }) {
  const content = readFileSafe(join(dir, String(id), SKILL_FILE), fsImpl)
  if (!content) return null
  const fm = readFrontmatter(content).frontmatter
  return {
    id: String(id),
    title: (fm && (fm.name || fm.title)) || String(id),
    description: fm ? String(fm.description ?? '').trim().slice(0, SKILL_DESCRIPTION_CAP) : '',
    source,
    assignedTo: [],
    problem: null,
  }
}

/**
 * scanSkills(config, repoDir, fsImpl, env, homedir) → {skills, stores}.
 *
 * BOTH stores are walked, project first, and every card says which one it came from. An id
 * present in both is ONE card — the project's, because the tree being worked in is nearer
 * than the machine's library — and it carries a `problem` naming the copy that was passed
 * over: a shadowing that nobody is told about is indistinguishable from a skill that vanished.
 *
 * `stores` is the walk itself, reported: each store's path, whether that directory exists at
 * all, and how many skills came out of it. That is what an empty screen says out loud.
 */
function scanSkills(config, repoDir, fsImpl, env, homedir) {
  const readdirSync = (fsImpl && fsImpl.readdirSync) || fsReaddirSync
  const out = []
  const byId = new Map()
  const stores = []
  for (const { source, path } of skillStorePaths({ repoDir, env, homedir })) {
    let names = null
    try {
      names = readdirSync(path).map(String)
    } catch {
      names = null // an absent (or unreadable) store is an answer, and it is reported as one
    }
    let count = 0
    for (const id of names ?? []) {
      const card = skillEntry({ id, dir: path, source, fsImpl })
      if (!card) continue
      count += 1
      const already = byId.get(card.id)
      if (already) {
        already.problem =
          `такой же навык лежит и в хранилище «${source}» — здесь действует тот, что найден в «${already.source}»`
        continue
      }
      byId.set(card.id, card)
      out.push(card)
    }
    stores.push({ source, path, present: names !== null, count })
  }
  const workers = config.workers ?? []
  for (const card of out) {
    card.assignedTo = workers.filter((w) => Array.isArray(w.skills) && w.skills.includes(card.id)).map((w) => w.id)
  }
  return { skills: out, stores }
}

/**
 * findSkillFile({skillId, repoDir, fsImpl, env, homedir}) → {source, path, content} for the
 * store the skill is ACTUALLY in, or null. THE ONE LOOKUP: the assign applier, the create
 * door's collision check and the worker's context preamble all ask it, so «which file is this
 * skill» has a single answer and an assignment can never point at a file the reader disagrees
 * about.
 *
 * @param {{skillId:string, repoDir?:string, fsImpl?:object, env?:object, homedir?:Function}} args
 * @returns {{source:string, path:string, content:string}|null}
 */
export function findSkillFile({ skillId, repoDir, fsImpl, env = process.env, homedir = osHomedir } = {}) {
  if (typeof skillId !== 'string' || !skillId) return null
  for (const { source, path } of skillStorePaths({ repoDir, env, homedir })) {
    const file = join(path, skillId, SKILL_FILE)
    const content = readFileSafe(file, fsImpl)
    if (content != null) return { source, path: file, content }
  }
  return null
}

// ── the stock team read model ──

/**
 * The reserved toggle target meaning «the whole shipped team», not one agent id. It is
 * shaped to pass server.mjs's ID_RE unchanged, so the EXISTING POST /api/agent/toggle door
 * carries it and no route is added; and it cannot collide with an installed definition,
 * because the installer only ever writes `sma-*.md` and a user's own file would have to be
 * named literally `__stock-team__.md`.
 */
export const STOCK_TEAM_TARGET = '__stock-team__'

/** Where a definition came from: shipped with SMA, or the user's own. */
export const STOCK_ORIGINS = Object.freeze(['sma', 'yours'])

/**
 * What is known about a newer shipped version. 'unknown' is the honest answer for a
 * definition with no recorded baseline — it is never collapsed into 'current'.
 */
export const STOCK_UPDATE_STATES = Object.freeze(['current', 'available', 'unknown', 'not-shipped'])

/** The frontmatter description is a card subtitle, capped — a file body never travels. */
const STOCK_DESCRIPTION_CAP = 400

/** readdir that answers `null` instead of throwing (an absent directory is an answer). */
function listDirSafe(path, fsImpl) {
  const readdirSync = (fsImpl && fsImpl.readdirSync) || fsReaddirSync
  try {
    return readdirSync(path).map(String)
  } catch {
    return null
  }
}

/**
 * The digest fork state is decided by. Newline-normalized on purpose: a CRLF checkout of
 * the same bytes is not somebody's edit, and reporting it as one would make the whole
 * roster look forked on Windows.
 */
function definitionDigest(text) {
  return createHash('sha256').update(String(text ?? '').replace(/\r\n/g, '\n')).digest('hex')
}

/**
 * resolveStockTeamDirs({repoDir, env, homedir, fsImpl}) → {configDir, agentsDir,
 * pristineDir, names, projectLocal} for the install that actually exists, or null when no
 * agents directory does. Both installer layouts are covered, in the env-then-homedir order
 * resolveMcpRegistryPath already uses: the project-local `<repo>/.claude` first (the
 * installer's default), then $CLAUDE_CONFIG_DIR, then ~/.claude. The probe is a readdir,
 * because that is the call whose success actually means «the roster is here».
 *
 * @param {{repoDir?:string, env?:object, homedir?:Function, fsImpl?:object}} [opts]
 * @returns {{configDir:string, agentsDir:string, pristineDir:string, names:string[], projectLocal:boolean}|null}
 */
export function resolveStockTeamDirs({ repoDir, env = process.env, homedir = osHomedir, fsImpl } = {}) {
  const projectDir = join(repoDir ?? '.', '.claude')
  const candidates = [projectDir]
  const override = env.CLAUDE_CONFIG_DIR
  if (override && String(override).trim()) candidates.push(String(override).trim())
  candidates.push(join(homedir(), '.claude'))
  for (const configDir of candidates) {
    const agentsDir = join(configDir, 'agents')
    const names = listDirSafe(agentsDir, fsImpl)
    if (names) {
      return {
        configDir,
        agentsDir,
        pristineDir: join(configDir, 'sma-core', 'agents'),
        names,
        projectLocal: configDir === projectDir,
      }
    }
  }
  return null
}

/** `tools:` is written as a comma line in the shipped definitions and as a list in some — both become an array. */
function toolsOf(fm) {
  const raw = fm && fm.tools
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((t) => t.trim()).filter(Boolean)
  }
  return []
}

/** One stock-team card. Explicit-pick: no body, no path, no env value — ever. */
function stockEntry({ id, content, pristine, worker }) {
  const { frontmatter: fm } = readFrontmatter(content)
  const shipped = pristine != null
  const forked = shipped ? definitionDigest(content) !== definitionDigest(pristine) : false
  let stockUpdate = 'not-shipped'
  if (shipped) {
    const baseline = worker && typeof worker.stockDigest === 'string' ? worker.stockDigest : null
    if (baseline == null) stockUpdate = 'unknown'
    else stockUpdate = baseline === definitionDigest(pristine) ? 'current' : 'available'
  }
  return {
    id,
    title: (fm && String(fm.name ?? '').trim()) || id,
    description: fm ? String(fm.description ?? '').slice(0, STOCK_DESCRIPTION_CAP) : '',
    tools: toolsOf(fm),
    enabled: !!(worker && worker.enabled !== false),
    origin: shipped ? 'sma' : 'yours',
    forked,
    stockUpdate,
    problem: fm
      ? null
      : 'файл определения не разобран: нет рамки frontmatter в начале файла — карточка показана по имени файла',
  }
}

/**
 * readStockTeam({config, repoDir, fsImpl, env, homedir}) → the whole roster that arrived
 * with the install, one entry per definition file, INCLUDING ids the roster config has
 * never heard of. Each card carries id, title, a short description, the declared tools,
 * whether the roster config enables it, whether it is a shipped SMA definition or the
 * user's own, whether it is forked, and whether a newer shipped version is available.
 *
 * A definition that fails to parse comes back with a named `problem` — the scan is never
 * broken by one bad file, and a missing agents directory is an empty list, not a throw.
 *
 * @param {{config?:object, repoDir?:string, fsImpl?:object, env?:object, homedir?:Function}} [args]
 * @returns {Array<{id:string, title:string, description:string, tools:string[], enabled:boolean, origin:string, forked:boolean, stockUpdate:string, problem:(string|null)}>}
 */
export function readStockTeam({ config, repoDir, fsImpl, env = process.env, homedir = osHomedir } = {}) {
  const roots = resolveStockTeamDirs({ repoDir, env, homedir, fsImpl })
  if (!roots) return []
  const workers = config && Array.isArray(config.workers) ? config.workers : []
  const byId = new Map(workers.filter((w) => w && w.id).map((w) => [String(w.id), w]))

  const out = []
  for (const name of roots.names) {
    if (!name.endsWith('.md')) continue
    const content = readFileSafe(join(roots.agentsDir, name), fsImpl)
    if (content == null) continue // a directory or an unreadable entry — not a definition
    const id = name.slice(0, -3)
    const pristine = readFileSafe(join(roots.pristineDir, name), fsImpl)
    out.push(stockEntry({ id, content, pristine, worker: byId.get(id) }))
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
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
 * readHarness({config, registry, adapter, repoDir, fsImpl, env, homedir, clock}) → ONE
 * explicit-pick payload {agents, skills, skillStores, mcp, drafts, stockTeam, telegram}. Agents
 * join profile + roleFile frontmatter; skills walk BOTH stores (project + machine) with the
 * store named on every card and per-profile assignment joined in; mcp exposes env-var
 * NAMES with '[set]'/'[unset]' only (values NEVER appear); drafts are the forge tasks awaiting
 * approval (kind + draftPath); stockTeam is the installed roster (readStockTeam). No field
 * carries tokens, commands, or file bodies.
 *
 * `stockTeam` is ADDITIVE: the four keys the existing screens already read keep
 * their shape exactly, the way the queue side's `project` field was added. `telegram` is
 * additive in the SAME way and is the state of the owner's own bot — not connected, waiting
 * for its pairing code, or linked to a named chat. It carries FOUR CHARACTERS of the token
 * and nothing else of it: the read model that the «Подключения» screen renders may never be
 * a way to read a credential back out (telegramLinkView owns that promise).
 *
 * `skillStores` is additive by the same rule, and it exists for the ONE thing an empty list
 * could not do before: say where it looked. A directory path is not a secret — the assign
 * door already names one in its refusals — and without it «навыков нет» reads as «этого в
 * продукте нет», which is what actually happened to a person whose skills were in the other
 * store.
 *
 * @param {{config:object, registry?:object, adapter?:object, repoDir?:string, fsImpl?:object, env?:object, homedir?:Function, clock?:Function}} args
 * @returns {Promise<{agents:Array, skills:Array, skillStores:Array, mcp:Array, drafts:Array, stockTeam:Array, telegram:object}>}
 */
export async function readHarness({ config, registry, adapter, repoDir, fsImpl, env = process.env, homedir = osHomedir, clock } = {}) {
  const cfg = config ?? {}
  const agents = (cfg.workers ?? []).map((w) => agentEntry(w, repoDir, fsImpl))
  const { skills, stores: skillStores } = scanSkills(cfg, repoDir, fsImpl, env, homedir)
  const mcp = ((registry && registry.servers) || []).map((s) => mcpEntry(s, env))
  const stockTeam = readStockTeam({ config: cfg, repoDir, fsImpl, env, homedir })

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

  return { agents, skills, skillStores, mcp, drafts, stockTeam, telegram: telegramLinkView(cfg, { now: (clock ?? Date.now)() }) }
}

// ── the two-step activation appliers (config/registry writes, atomic) ──

/**
 * THE APPLIERS BELOW WRITE THROUGH `writeConfig` IMPORTED FROM config.mjs — the one seam,
 * shared with the registry doors. They receive the object `loadConfig` returned, which carries
 * the three read-time working directories; the shared writer is what keeps a toggle from
 * pinning them into the file, and what keeps a toggle from deleting a key the write model
 * never heard of.
 *
 * THE BASELINE IS `launchDir`, NOT `repoDir`. Every applier in this file needs BOTH: the
 * repoDir to READ from (role files, the skills tree, the installed roster) and the launch
 * directory to decide what counts as derived when it WRITES. Handing the repoDir to the
 * writer is the defect that deleted a pin once already — a toggle then removes the
 * operator's pin from the file. The default is this process's own cwd, so a caller that omits
 * it still compares against a launch directory rather than against a served tree.
 */

/**
 * Build a new profile from an APPROVED definition file + pool defaults (never request text).
 *
 * `source` lets a caller that has ALREADY located the definition hand over its content and
 * the repo-relative roleFile to record (applyStockTeamToggle, which reads the installed
 * roster out of a config directory that is not always the project's). Absent, the project's
 * own `.claude/agents/<id>.md` is read — the path applyAgentToggle has always used.
 * A profile whose definition lives outside the repo carries NO roleFile: that field is
 * resolved as repo-relative by resolveWorkerContext, so an out-of-tree path there would be
 * a broken join rather than a preamble.
 */
function profileFromDefinition(id, enabled, config, repoDir, fsImpl, source) {
  const src = source ?? {
    content: readFileSafe(join(repoDir ?? '.', '.claude', 'agents', `${id}.md`), fsImpl),
    roleFile: `.claude/agents/${id}.md`,
  }
  const content = src.content
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
    ...(src.roleFile ? { roleFile: src.roleFile } : {}),
    skills: [],
    enabled: !!enabled,
  }
}

/**
 * The grammar of a model name and of an effort level, as they may be SET on a profile.
 *
 * Bounded, no whitespace, no quote, and — the load-bearing part — it may not START with a
 * dash. Both values end their lives as one element of a spawn's argument ARRAY
 * (`--model <value>`), so there is no shell to escape for; the only way such a value could
 * mean anything other than itself is by looking like the NEXT flag, and that is the shape
 * refused here. The set of legal models is deliberately NOT enumerated: the vendor renames
 * them, and a list in this file would refuse the founder's newest model on the day it ships.
 */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/

/**
 * applyAgentModel({config, id, model, effort, launchDir, fsImpl, env, homedir}) → the
 * updated config, with THIS agent's model and/or effort moved and persisted atomically.
 *
 * It sits beside the toggle because it is the same act on the same card. The profile is the
 * one part of a worker's session that does NOT come from the project checkout (args.mjs's
 * parity chain, step 5) — which is why it is worth an explicit door, and why
 * `assertProfileParity` screams if a spawn ever disagrees with what is written here.
 *
 * Unlike the toggle, an unknown id is NEVER created from a definition file: assigning a model
 * to an agent that does not exist is a typo, not an intention (UnknownProfileError → 404).
 * A field that is not passed is left ALONE — this door cannot clear one back to the lane
 * default, which is a different act and would need its own word.
 */
export function applyAgentModel({ config, id, model, effort, launchDir, fsImpl, env = process.env, homedir = osHomedir }) {
  if (!config || !Array.isArray(config.workers)) throw new UnknownProfileError('applyAgentModel: config.workers required')
  if (typeof id !== 'string' || !id) throw new UnknownProfileError('applyAgentModel: id required')
  if (model === undefined && effort === undefined) {
    throw new UnknownProfileError('applyAgentModel: nothing to set — pass "model", "effort" or both')
  }
  for (const [field, value] of [
    ['model', model],
    ['effort', effort],
  ]) {
    if (value === undefined) continue
    if (typeof value !== 'string' || !MODEL_RE.test(value)) {
      throw new UnknownProfileError(`applyAgentModel: "${field}" must match ${MODEL_RE.source}`)
    }
  }
  const idx = config.workers.findIndex((w) => w && w.id === id)
  if (idx === -1) throw new UnknownProfileError(`applyAgentModel: unknown agent "${id}"`)
  const nextConfig = {
    ...config,
    workers: config.workers.map((w, i) =>
      i === idx ? { ...w, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) } : w,
    ),
  }
  writeConfig(nextConfig, { env, homedir, fsImpl, launchDir })
  return nextConfig
}

/**
 * applyAgentToggle({config, id, enabled, repoDir, launchDir, fsImpl, env, homedir}) → the
 * updated config. An EXISTING profile: flip its `enabled`. A NEW id: the definition file
 * `.claude/agents/<id>.md` MUST exist (already approve-merged) — the profile is built from
 * the FILE's fields + pool defaults, the request contributing only id + enabled. Written
 * atomically. Unknown id with no file → MissingDefinitionFileError.
 *
 * `repoDir` is READ from (the definition file); `launchDir` is the write-time derive
 * baseline — see writeConfig above. They are different facts and may not be swapped.
 */
export function applyAgentToggle({ config, id, enabled, repoDir, launchDir, fsImpl, env = process.env, homedir = osHomedir }) {
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
  writeConfig(nextConfig, { env, homedir, fsImpl, launchDir })
  return nextConfig
}

/**
 * applyStockTeamToggle({config, enabled, repoDir, launchDir, fsImpl, env, homedir}) → the
 * updated config.
 * THE single «switch the pipeline on» act, reached through the EXISTING
 * POST /api/agent/toggle door under the reserved target STOCK_TEAM_TARGET — no route added.
 *
 * It obeys the two-step activation law exactly as applyAgentToggle does: it only ever acts on
 * definitions that ALREADY exist on disk, and every profile it creates is built from that
 * file's own fields plus pool defaults — the request contributes one boolean and nothing else.
 * Nothing installs, nothing is fetched: the roster it switches on is the one the installer
 * already wrote. With no installed definitions at all it refuses by name and writes nothing.
 *
 * Only SHIPPED definitions are touched — the ones with a pristine counterpart under
 * `<config>/sma-core/agents/`. The user's own agents in the same directory are not swept up
 * by a switch labelled «the SMA team», in either direction.
 *
 * On activation each profile records `stockDigest`: the digest of TODAY's pristine copy,
 * beside `enabled`. That is the baseline readStockTeam reads back to answer «is a newer
 * shipped version available» after the next install. Switching OFF flips `enabled` and leaves
 * the recorded baseline alone — the answer to «what did I last accept» does not change
 * because a switch moved.
 *
 * @param {{config:object, enabled:boolean, repoDir?:string, launchDir?:string, fsImpl?:object, env?:object, homedir?:Function}} args
 * @returns {object} the updated config
 */
export function applyStockTeamToggle({ config, enabled, repoDir, launchDir, fsImpl, env = process.env, homedir = osHomedir }) {
  if (!config || !Array.isArray(config.workers)) {
    throw new UnknownProfileError('applyStockTeamToggle: config.workers required')
  }
  const roots = resolveStockTeamDirs({ repoDir, env, homedir, fsImpl })
  const shipped = []
  for (const name of roots ? roots.names : []) {
    if (!name.endsWith('.md')) continue
    const pristine = readFileSafe(join(roots.pristineDir, name), fsImpl)
    if (pristine == null) continue // the user's own agent — not part of the shipped team
    const content = readFileSafe(join(roots.agentsDir, name), fsImpl)
    if (content == null) continue
    shipped.push({
      id: name.slice(0, -3),
      content,
      stockDigest: definitionDigest(pristine),
      roleFile: roots.projectLocal ? `.claude/agents/${name}` : null,
    })
  }
  if (shipped.length === 0) {
    throw new MissingDefinitionFileError(
      'no installed SMA definitions under <config>/agents — nothing to switch on until the install put them there (two-step activation)',
    )
  }

  const byId = new Map(shipped.map((s) => [s.id, s]))
  const nextWorkers = config.workers.map((w) => {
    const s = w && w.id ? byId.get(String(w.id)) : undefined
    if (!s) return w
    return { ...w, enabled: !!enabled, ...(enabled ? { stockDigest: s.stockDigest } : {}) }
  })
  const known = new Set(config.workers.filter((w) => w && w.id).map((w) => String(w.id)))
  if (enabled) {
    // A worker is only CREATED when switching on: switching off has nothing to add.
    for (const s of shipped) {
      if (known.has(s.id)) continue
      const profile = profileFromDefinition(s.id, true, config, repoDir, fsImpl, {
        content: s.content,
        roleFile: s.roleFile,
      })
      nextWorkers.push({ ...profile, stockDigest: s.stockDigest })
    }
  }
  const nextConfig = { ...config, workers: nextWorkers }
  writeConfig(nextConfig, { env, homedir, fsImpl, launchDir })
  return nextConfig
}

/**
 * applySkillAssign({config, skillId, workerIds, repoDir, launchDir, fsImpl, env, homedir}) →
 * the updated config. The skill's `SKILL.md` MUST exist in ONE OF THE TWO STORES — the served
 * tree or this machine's library (findSkillFile) — and every workerId must be an existing
 * profile. REPLACES the skill's assignment: the listed workers get skillId in their `skills`,
 * every other worker has it removed. Empty workerIds = unassign everywhere. Written atomically.
 *
 * It looks in both stores for the same reason the read model walks both: a card the window
 * shows must be a card the window can act on. While this checked only the project tree, every
 * machine skill on the screen answered 404 to the one button it had.
 */
export function applySkillAssign({ config, skillId, workerIds, repoDir, launchDir, fsImpl, env = process.env, homedir = osHomedir }) {
  if (!config || !Array.isArray(config.workers)) throw new UnknownProfileError('applySkillAssign: config.workers required')
  if (typeof skillId !== 'string' || !skillId) throw new UnknownSkillError('applySkillAssign: skillId required')
  if (!findSkillFile({ skillId, repoDir, fsImpl, env, homedir })) {
    const looked = skillStorePaths({ repoDir, env, homedir }).map((s) => join(s.path, skillId, SKILL_FILE))
    throw new UnknownSkillError(`no ${SKILL_FILE} for skill "${skillId}" — looked in ${looked.join(' and ')}`)
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
  writeConfig(nextConfig, { env, homedir, fsImpl, launchDir })
  return nextConfig
}

// ── writing a skill (the machine store, and only it) ──

/**
 * The shape of an id that may become a DIRECTORY NAME. Lower-case latin, digits and dashes,
 * bounded, and it must start with a letter or a digit — so there is no spelling of it that
 * contains a separator, a dot or a leading dash, and therefore no spelling that leaves the
 * store it is joined onto. This is the whole of the path safety: the value is checked before
 * it is joined, not sanitised after.
 */
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A one-line description is one line — a newline in it would open a second frontmatter key. */
const SKILL_CREATE_DESCRIPTION_CAP = 300

/** How long a skill a person writes in the window may be. Bounded, like every other body. */
export const SKILL_BODY_CAP = 20000

/**
 * createMachineSkill({id, description, body, env, homedir, fsImpl}) → {id, source, path}.
 *
 * THE ONE WRITER OF A SKILL FILE, and it writes into the MACHINE store only. That is the
 * owner's own instruction: a skill written here must be usable from every project, and a file
 * put in the served tree would belong to that tree alone (and would land in somebody's
 * repository as an uncommitted stranger).
 *
 * IT REFUSES AN EXISTING ID, in either store. Overwriting is a different act from creating and
 * would be a deletion nobody asked for; a person who wants the text changed edits the file
 * whose path this function returned.
 *
 * WHAT THE REQUEST CONTRIBUTES IS TEXT, AND ONLY TEXT. The id is validated against a shape
 * that cannot contain a path separator; the description is one line, capped, with its own
 * newlines removed so it cannot grow a second frontmatter key; the body is capped and lands
 * BELOW the closing fence, where nothing it contains is read as a header. Nothing here becomes
 * a config value, a command or an argument — the same posture the MCP registry keeps.
 *
 * The frontmatter is `name: <id>` deliberately: that is the spelling the CLI's own skill
 * loader reads, so a skill written here is the same kind of object as one written by hand.
 *
 * @param {{id:string, description?:string, body:string, env?:object, homedir?:Function, fsImpl?:object}} args
 * @returns {{id:string, source:string, path:string}}
 */
export function createMachineSkill({ id, description, body, env = process.env, homedir = osHomedir, fsImpl } = {}) {
  if (typeof id !== 'string' || !SKILL_ID_RE.test(id)) {
    throw new InvalidSkillError(`createMachineSkill: id must match ${SKILL_ID_RE.source} (latin, digits, dashes)`)
  }
  if (typeof body !== 'string' || body.trim() === '') {
    throw new InvalidSkillError('createMachineSkill: body required — a skill with no text teaches nothing')
  }
  if (body.length > SKILL_BODY_CAP) {
    throw new InvalidSkillError(`createMachineSkill: body exceeds ${SKILL_BODY_CAP} characters`)
  }
  const oneLine = String(description ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, SKILL_CREATE_DESCRIPTION_CAP)
  if (!oneLine) {
    throw new InvalidSkillError('createMachineSkill: description required — the card has nothing to say otherwise')
  }

  const found = findSkillFile({ skillId: id, fsImpl, env, homedir })
  if (found) {
    throw new SkillExistsError(`skill "${id}" already exists in the "${found.source}" store (${found.path}) — a create never overwrites`)
  }

  const path = join(resolveMachineSkillsDir({ env, homedir }), id, SKILL_FILE)
  const text = `---\nname: ${id}\ndescription: ${oneLine}\n---\n\n${body.replace(/\r\n/g, '\n').trimEnd()}\n`
  atomicWriteRaw(path, text, {
    mkdirFn: fsImpl && fsImpl.mkdirSync,
    writeFn: fsImpl && fsImpl.writeFileSync,
    renameFn: fsImpl && fsImpl.renameSync,
  })
  return { id, source: 'machine', path }
}

/**
 * applyMcpToggle({registry, serverId, enabled, homedir, env, fsImpl}) → the updated registry.
 * serverId must match an EXISTING entry (MCP_ID_RE); ONLY the `enabled` boolean changes — the
 * applier reads the entry, flips one boolean, rewrites via atomicWriteJson. There is NO input
 * by which command/args/envNames could be altered, so the post-toggle registry deep-equals the
 * original except `enabled` (RCE-closed). Unknown id → UnknownMcpServerError.
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

/** Everything the assigned skills together may add to one prompt. Bounded like the role body. */
const SKILLS_PREAMBLE_CAP = 16 * 1024

/**
 * resolveWorkerContext({worker, repoDir, fsImpl, env, homedir}) → {rolePreamble?,
 * skillsPreamble?, skillsList}. The merged roleFile body (capped 8 KB) becomes the
 * rolePreamble the loop prepends to an ENABLED agent's task prompt — this is what makes
 * «включён» real in a session.
 *
 * AND THE ASSIGNED SKILLS TRAVEL THE SAME ROAD, WITH THEIR TEXT. Until this they travelled as
 * names into the journal and nowhere else: a person gave a worker a skill through «Кому дать»,
 * the config recorded it, and the session it was given to never learned that it had one. So
 * each assigned skill is LOOKED UP IN BOTH STORES (findSkillFile) and its body is carried into
 * the preamble under a heading that names the store it came from — a machine skill works in a
 * project whose tree has no skills directory at all, which is the point of having the second
 * store, and the worker's copy is never asked to contain it.
 *
 * A skill that is assigned and cannot be found is named in the preamble as missing rather than
 * dropped: an instruction the person believes was given must not disappear in silence.
 *
 * @param {{worker:object, repoDir?:string, fsImpl?:object, env?:object, homedir?:Function}} args
 * @returns {{rolePreamble?:string, skillsPreamble?:string, skillsList:string[]}}
 */
export function resolveWorkerContext({ worker, repoDir, fsImpl, env = process.env, homedir = osHomedir } = {}) {
  const skillsList = worker && Array.isArray(worker.skills) ? worker.skills.slice() : []
  let rolePreamble
  if (worker && worker.roleFile) {
    const content = readFileSafe(join(repoDir ?? '.', worker.roleFile), fsImpl)
    if (content) {
      const { body } = readFrontmatter(content)
      rolePreamble = String(body || content).slice(0, ROLE_PREAMBLE_CAP)
    }
  }

  let skillsPreamble
  if (skillsList.length > 0) {
    const parts = ['# Навыки, выданные вам', '']
    for (const id of skillsList) {
      const found = findSkillFile({ skillId: id, repoDir, fsImpl, env, homedir })
      if (!found) {
        parts.push(`## ${id}`, '', 'Файл этого навыка не найден ни в дереве проекта, ни в хранилище машины.', '')
        continue
      }
      const { body } = readFrontmatter(found.content)
      const store = found.source === 'project' ? 'дерево проекта' : 'хранилище машины'
      parts.push(`## ${id} (источник: ${store})`, '', String(body || found.content).trim(), '')
    }
    skillsPreamble = parts.join('\n').slice(0, SKILLS_PREAMBLE_CAP)
  }

  return {
    ...(rolePreamble ? { rolePreamble } : {}),
    ...(skillsPreamble ? { skillsPreamble } : {}),
    skillsList,
  }
}
