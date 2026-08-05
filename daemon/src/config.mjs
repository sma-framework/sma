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
 * ═══════════════ V5.1: A PROJECT IS A FIRST-CLASS FIELD (D-9.7-01) ═══════════════
 * The project registry lives HERE, in the daemon config, and it exists BEFORE the first
 * screen does. `projects[]` is the list, `activeProject` is the one currently selected,
 * `workers[].project` optionally pins a worker to one (absent = the active project). The
 * id is a slug (PROJECT_ID_RE) and it is the KEY that tasks reference — renaming a
 * project moves its `name` and NEVER its `id`.
 *
 * ONE MACHINE OWNS AN ACCOUNT. A subscription account belongs to exactly one machine:
 * federation aggregates VIEWS across machines, never credentials. No peer entry carries
 * an account, and no account is ever addressed across a peer boundary.
 *
 * ═══════════════ V5.1: ZERO-FRICTION MIGRATION (D-9.7-08) ═══════════════════════
 * `ensureDefaultProject` runs at LOAD time, not as a migration script — a script would
 * be the one manual action D-9.7-08 forbids. On a config with no registry it mints
 * exactly one entry (name from the install profile `.sma/profile.json` when present,
 * else the repository directory name) and selects it. It is IDEMPOTENT: once a registry
 * exists it returns the SAME object it was given, so a second load mints nothing
 * (T-9.7-06). Existing tasks are attached by the queue's read-time backfill — nothing
 * rewrites a stored row.
 *
 * A name with no latin characters still yields a valid slug (the id falls back to
 * `project`/`project-2`…): the id is an opaque key, the NAME is what a human reads.
 *
 * ═══════════════ V5.1: FEDERATION IS AN ADDITIVE BLOCK (D-9.7-04) ═══════════════
 * `federation` is optional: `{role: standalone|hub|peer, peers:[{id,url,token}]}`. An
 * ABSENT block means role `standalone` and today's behaviour exactly. A malformed peer
 * (bad url, empty token) refuses the whole load with a named error — the daemon never
 * starts with a half-alive registry it would silently ignore (T-9.7-07).
 *
 * PEER TOKENS COLLAPSE FROM DAY ONE (T-9.7-05). secretsView folds every
 * `federation.peers[].token` into '[set]'/'[unset]' in the SAME change that introduces
 * the field — a secret that lands in the schema a week before its collapse is a week of
 * leaking into every payload.
 *
 * Node built-ins only. randomBytes for the token; atomicWriteJson (scripts/sma/lib,
 * zero-dep law intact) for the write. env / homedir / fsImpl / repoDir are all
 * dependency-injectable so tests never touch the real ~/.sma-daemon.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, chmodSync as fsChmodSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

import { atomicWriteJson } from '../../scripts/sma/lib/fs-atomics.mjs'

/** Named error for a structurally-invalid worker profile (missing id/lane/account.configDir). */
export class InvalidWorkerProfileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidWorkerProfileError'
  }
}

/** Named error for a structurally-invalid project entry (bad id / empty name / duplicate). */
export class InvalidProjectError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidProjectError'
  }
}

/** Named error for a structurally-invalid federation block or peer entry (T-9.7-07). */
export class InvalidFederationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidFederationError'
  }
}

/** Named error for a reference to a project id that is not in the registry (→ 404 at the door). */
export class UnknownProjectError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownProjectError'
  }
}

/**
 * Named error for a reference to a machine id that is not in the peer registry (→ 404 at
 * the door). Federation's own `UnknownPeerError` names the same absence at the OUTBOUND
 * edge; this one names it at the CONFIG edge, so neither module has to import the other.
 */
export class UnknownPeerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnknownPeerError'
  }
}

/** The project id grammar — a slug, because the id is a key tasks and rows carry. */
export const PROJECT_ID_RE = /^[a-z0-9-]{1,64}$/

/** The three federation roles. An absent block means `standalone` (D-9.7-04). */
export const FEDERATION_ROLES = Object.freeze(['standalone', 'hub', 'peer'])

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
 * validateProject(p, {seen}) — structural gate for ONE registry entry (D-9.7-01).
 * Requires a slug `id` (PROJECT_ID_RE) and a non-empty `name`. `seen` is an optional Set
 * carried across a registry pass so a duplicate id is a named error rather than a silent
 * shadow. Throws InvalidProjectError; the handler maps a named error to 400/404.
 *
 * @param {object} p
 * @param {{seen?:Set<string>}} [opts]
 * @returns {object} the normalized entry
 */
export function validateProject(p, { seen } = {}) {
  if (!p || typeof p !== 'object') throw new InvalidProjectError('project entry is not an object')
  if (!p.id || typeof p.id !== 'string') throw new InvalidProjectError('project entry missing "id"')
  if (!PROJECT_ID_RE.test(p.id)) {
    throw new InvalidProjectError(`project id "${p.id}" must match ${PROJECT_ID_RE.source}`)
  }
  if (typeof p.name !== 'string' || p.name.trim() === '') {
    throw new InvalidProjectError(`project "${p.id}" missing a non-empty "name"`)
  }
  if (seen) {
    if (seen.has(p.id)) throw new InvalidProjectError(`duplicate project id "${p.id}"`)
    seen.add(p.id)
  }
  return { ...p, id: p.id, name: p.name }
}

/** validateProjects(list) — the whole registry, duplicate-checked in one pass. */
function validateProjects(list) {
  if (!Array.isArray(list)) throw new InvalidProjectError('config.projects must be an array')
  const seen = new Set()
  return list.map((p) => validateProject(p, { seen }))
}

/** A peer entry: slug id, a syntactically valid http(s) url, a non-empty token (T-9.7-07). */
function validatePeer(peer, seen) {
  if (!peer || typeof peer !== 'object') throw new InvalidFederationError('peer entry is not an object')
  if (!peer.id || typeof peer.id !== 'string' || !PROJECT_ID_RE.test(peer.id)) {
    throw new InvalidFederationError(`peer id "${peer && peer.id}" must match ${PROJECT_ID_RE.source}`)
  }
  if (seen.has(peer.id)) throw new InvalidFederationError(`duplicate peer id "${peer.id}"`)
  seen.add(peer.id)
  let url
  try {
    url = new URL(String(peer.url))
  } catch {
    throw new InvalidFederationError(`peer "${peer.id}" has an invalid url`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidFederationError(`peer "${peer.id}" url must be http(s), got "${url.protocol}"`)
  }
  if (typeof peer.token !== 'string' || peer.token === '') {
    throw new InvalidFederationError(`peer "${peer.id}" requires a non-empty token`)
  }
  return { ...peer, id: peer.id, url: peer.url, token: peer.token }
}

/**
 * validateFederation(f) — the additive federation block (D-9.7-04). An absent/null block
 * normalizes to `{role:'standalone', peers:[]}` — standalone IS today's behaviour, so an
 * install that never heard of federation keeps working untouched. A malformed peer throws
 * InvalidFederationError, refusing the load outright (T-9.7-07): a half-alive peer registry
 * silently ignored is worse than a daemon that will not start.
 *
 * @param {object|undefined|null} f
 * @returns {{role:string, peers:object[]}}
 */
export function validateFederation(f) {
  if (f === undefined || f === null) return { role: 'standalone', peers: [] }
  if (typeof f !== 'object' || Array.isArray(f)) throw new InvalidFederationError('federation block is not an object')
  const role = f.role === undefined ? 'standalone' : f.role
  if (!FEDERATION_ROLES.includes(role)) {
    throw new InvalidFederationError(`federation role "${role}" must be one of ${FEDERATION_ROLES.join('|')}`)
  }
  const raw = f.peers === undefined ? [] : f.peers
  if (!Array.isArray(raw)) throw new InvalidFederationError('federation.peers must be an array')
  const seen = new Set()
  return { ...f, role, peers: raw.map((p) => validatePeer(p, seen)) }
}

/**
 * validateWorker(w, knownProjects) — structural gate: id, lane, and account.configDir are
 * required. Normalizes the D-9.5-09 harness trio (enabled defaults true; roleFile/skills
 * accepted) and the D-9.7-01 optional `project` by the SAME conditional-spread idiom:
 * absent means «the active project», present must reference a registry entry.
 * Throws InvalidWorkerProfileError on a missing required field or a dangling project.
 */
function validateWorker(w, knownProjects) {
  if (!w || typeof w !== 'object') throw new InvalidWorkerProfileError('worker profile is not an object')
  if (!w.id) throw new InvalidWorkerProfileError('worker profile missing "id"')
  if (!w.lane) throw new InvalidWorkerProfileError(`worker "${w.id}" missing "lane"`)
  if (!w.account || !w.account.configDir) {
    throw new InvalidWorkerProfileError(`worker "${w.id}" missing "account.configDir"`)
  }
  if (w.project !== undefined) {
    if (typeof w.project !== 'string' || !PROJECT_ID_RE.test(w.project)) {
      throw new InvalidWorkerProfileError(`worker "${w.id}" has an invalid project id "${w.project}"`)
    }
    if (knownProjects && !knownProjects.has(w.project)) {
      throw new InvalidWorkerProfileError(`worker "${w.id}" references unknown project "${w.project}"`)
    }
  }
  return {
    ...w,
    enabled: w.enabled === undefined ? true : Boolean(w.enabled),
    ...(w.roleFile !== undefined ? { roleFile: w.roleFile } : {}),
    ...(w.skills !== undefined ? { skills: w.skills } : {}),
    ...(w.project !== undefined ? { project: w.project } : {}),
  }
}

/**
 * validateConfig(config) — returns a normalized copy; throws on any invalid worker,
 * project or federation entry. `projects` / `activeProject` / `federation` stay ABSENT
 * when the incoming config never carried them (the additive-field law): the quiet
 * migration, not the validator, is what mints a registry.
 */
function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new InvalidWorkerProfileError('config is not an object')
  const hasProjects = config.projects !== undefined
  const projects = hasProjects ? validateProjects(config.projects) : []
  const knownProjects = new Set(projects.map((p) => p.id))
  if (config.activeProject !== undefined && config.activeProject !== null) {
    if (!knownProjects.has(config.activeProject)) {
      throw new UnknownProjectError(`activeProject "${config.activeProject}" is not in the project registry`)
    }
  }
  const workers = Array.isArray(config.workers) ? config.workers.map((w) => validateWorker(w, knownProjects)) : []
  const hasFederation = config.federation !== undefined
  const federation = hasFederation ? validateFederation(config.federation) : undefined
  return {
    ...config,
    ...(hasProjects ? { projects } : {}),
    workers,
    ...(hasFederation ? { federation } : {}),
  }
}

/** slugify(name) → a PROJECT_ID_RE-safe id; a name with no latin chars falls back to 'project'. */
function slugify(name) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return s || 'project'
}

/** A free id: the slug, or slug-2, slug-3… when the registry already holds it. */
function freeProjectId(base, taken) {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, 60)}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base.slice(0, 55)}-${randomBytes(3).toString('hex')}`
}

/** The install profile name, when `.sma/profile.json` carries one (tolerant reader). */
function profileProjectName(repoDir, fsImpl) {
  const io = fsImpl ?? {}
  const existsSync = io.existsSync ?? fsExistsSync
  const readFileSync = io.readFileSync ?? fsReadFileSync
  try {
    const path = join(repoDir, '.sma', 'profile.json')
    if (!existsSync(path)) return null
    const profile = JSON.parse(readFileSync(path, 'utf8'))
    const name = profile && (profile.projectName ?? profile.project ?? profile.name)
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null
  } catch {
    return null // a missing / corrupt profile is a valid state — fall through to the dir name
  }
}

/**
 * ensureDefaultProject(config, {repoDir, fsImpl, projectName}) — the quiet migration
 * (D-9.7-08). A config that already carries a registry is returned UNCHANGED (the same
 * object reference — that is the idempotence proof, T-9.7-06); a config without one gains
 * exactly ONE entry and has `activeProject` pointed at it. The name comes from the install
 * profile when there is one, otherwise from the repository directory name.
 *
 * Nothing else moves: workers keep no project field (absent = the active project) and no
 * queue row is rewritten — the queue backfills on read.
 *
 * @param {object} config
 * @param {{repoDir?:string, fsImpl?:object, projectName?:string}} [opts]
 * @returns {object} the same config, or a copy carrying the minted registry
 */
export function ensureDefaultProject(config, { repoDir = process.cwd(), fsImpl, projectName } = {}) {
  const existing = Array.isArray(config && config.projects) ? config.projects : null
  if (existing && existing.length > 0) {
    const ids = new Set(existing.map((p) => p && p.id))
    if (config.activeProject && ids.has(config.activeProject)) return config
    return { ...config, activeProject: existing[0].id }
  }
  const name = projectName ?? profileProjectName(repoDir, fsImpl) ?? basename(repoDir) ?? 'project'
  const project = validateProject({ id: slugify(name), name: String(name) })
  return { ...config, projects: [project], activeProject: project.id }
}

/**
 * The three working directories `withDerivedDirs` falls back to. They are DERIVED at read
 * time, so they are not part of the persisted shape — see stripDerivedDirs.
 */
export const DERIVED_DIR_KEYS = Object.freeze(['dataDir', 'ledgerDir', 'repoDir'])

/** What the derive would produce for this config path and this launch directory. */
function derivedDirsFor({ configPath, repoDir }) {
  const root = dirname(configPath)
  return { dataDir: join(root, 'data'), ledgerDir: join(root, 'ledger'), repoDir }
}

/**
 * stripDerivedDirs(config, {configPath, repoDir}) — the PERSISTED shape of a config that has
 * been through `withDerivedDirs` (D-11-DEFER-19).
 *
 * WHY THIS EXISTS. `loadConfig` returns the config WITH the three working directories
 * attached, and every registry door (addProject / selectProject / renameProject) and every
 * harness applier writes that same object back. One project add was enough to land
 * `repoDir`, `dataDir` and `ledgerDir` in the file as literal keys — and a persisted
 * `repoDir` then decides, forever, whether the first-run interview takes the window and
 * where the agent roster is read from, no matter which directory the daemon is started in.
 * The documented portability promise («the same config stays portable between machines whose
 * homes differ») was gone after the first click.
 *
 * A KEY IS DROPPED ONLY WHEN STORING IT WOULD CHANGE NOTHING. The rule is «a value the derive
 * would produce again is not written down», never a blanket delete: an operator who set
 * `dataDir` by hand has pointed the daemon's data somewhere on purpose, and a project add
 * must not quietly move it. So the value is compared against what the derive would give, and
 * only an exact match is removed.
 *
 * @param {object} config
 * @param {{configPath:string, repoDir?:string}} args
 * @returns {object} a copy carrying only the persisted keys
 */
export function stripDerivedDirs(config, { configPath, repoDir } = {}) {
  if (!config || typeof config !== 'object') return config
  const derived = derivedDirsFor({ configPath: configPath ?? '', repoDir })
  const out = { ...config }
  for (const key of DERIVED_DIR_KEYS) {
    if (out[key] !== undefined && out[key] === derived[key]) delete out[key]
  }
  return out
}

/**
 * writeConfig(config, {env, homedir, fsImpl, repoDir}) — the ONE write path: the persisted
 * shape (stripDerivedDirs) through the existing atomic writer, plus a best-effort re-stamp
 * of the 0600 mode (rename installs the temp file's mode, so re-stamping PRESERVES the
 * permissions rather than changing them).
 */
function writeConfig(config, { env = process.env, homedir = osHomedir, fsImpl, repoDir = process.cwd() } = {}) {
  const io = fsImpl ?? {}
  const path = resolveConfigPath({ env, homedir })
  atomicWriteJson(path, stripDerivedDirs(config, { configPath: path, repoDir }), {
    mkdirFn: io.mkdirSync,
    writeFn: io.writeFileSync,
    renameFn: io.renameSync,
  })
  const chmodSync = io.chmodSync ?? fsChmodSync
  try {
    chmodSync(path, 0o600) // win32: documented no-op — never fail on it
  } catch {
    /* platform ignores chmod (win32) — the file is still owner-scoped by ACL default */
  }
  return path
}

/**
 * withDerivedDirs(config, {configPath, repoDir}) — the three working directories the
 * daemon cannot run without, DERIVED rather than demanded.
 *
 * WHY DERIVED, NOT DEFAULTED IN THE FILE: `ledgerDir` and `dataDir` were never part of
 * the shipped default, so a fresh install ran with both undefined — the attempt ledger
 * silently no-op'd, every «почему» a failed task owed a person was thrown away, and the
 * card came back empty. A config file the founder never wrote a line into must still be
 * a WORKING config: the daemon's own directory (the one its config.json lives in) is
 * where its own data belongs, so `~/.sma-daemon/{data,ledger}` fall out of the config
 * path itself, and `repoDir` falls back to the directory the daemon was started in.
 *
 * DERIVED AT READ TIME, NEVER PERSISTED: an explicit value in the file always wins and is
 * returned untouched, and a file that omits them is NOT rewritten — the same config stays
 * portable between machines whose homes differ. The «never persisted» half is enforced by
 * `stripDerivedDirs` at the writer, because this object is what the registry doors and the
 * harness appliers hand back to be written (D-11-DEFER-19).
 */
function withDerivedDirs(config, { configPath, repoDir }) {
  const derived = derivedDirsFor({ configPath, repoDir })
  return {
    ...config,
    dataDir: config.dataDir || derived.dataDir,
    ledgerDir: config.ledgerDir || derived.ledgerDir,
    repoDir: config.repoDir || derived.repoDir,
  }
}

/**
 * loadConfig({env, homedir, fsImpl, repoDir}) — read the daemon config, creating a 0600
 * default (with a fresh 64-hex token) on first boot. Existing files are parsed and
 * validated, then run through the D-9.7-08 quiet migration: a config with no project
 * registry gains one and is persisted, in place, with no manual action. The migration is
 * idempotent, so every later load is a pure read. The returned object always carries the
 * three working directories (withDerivedDirs) whether or not the file names them.
 *
 * @param {{env?:object, homedir?:Function, fsImpl?:object, repoDir?:string}} [opts]
 * @returns {object} the normalized config
 */
export function loadConfig({ env = process.env, homedir = osHomedir, fsImpl, repoDir = process.cwd() } = {}) {
  const io = fsImpl ?? {}
  const existsSync = io.existsSync ?? fsExistsSync
  const readFileSync = io.readFileSync ?? fsReadFileSync

  const path = resolveConfigPath({ env, homedir })

  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const config = validateConfig(raw)
    const migrated = ensureDefaultProject(config, { repoDir, fsImpl })
    if (migrated !== config) writeConfig(migrated, { env, homedir, fsImpl, repoDir })
    return withDerivedDirs(migrated, { configPath: path, repoDir })
  }

  // Bootstrap: fresh token, the default pool, its project registry, atomic write, 0600.
  const token = randomBytes(32).toString('hex')
  const config = ensureDefaultProject(validateConfig(defaultConfig(token)), { repoDir, fsImpl })
  writeConfig(config, { env, homedir, fsImpl, repoDir })
  return withDerivedDirs(config, { configPath: path, repoDir })
}

/**
 * addProject(config, {id, name, path}, io) — append a validated entry to the registry and
 * persist. A duplicate id is an InvalidProjectError; the registry is the key space tasks
 * reference, so it never silently shadows.
 *
 * THE ID GRAMMAR HAS EXACTLY ONE OWNER — this module. An omitted `id` is minted here from
 * the name by the SAME slug+collision path the quiet migration uses, so no caller (least of
 * all a request handler) ever gets to invent a key shape of its own. `path` is the folder a
 * human picked; it is carried as opaque DATA on the entry.
 *
 * @returns {object} the updated config
 */
export function addProject(config, { id, name, path } = {}, { env = process.env, homedir = osHomedir, fsImpl, repoDir } = {}) {
  const projects = Array.isArray(config && config.projects) ? config.projects : []
  const seen = new Set(projects.map((p) => p.id))
  const mintedId = id ?? freeProjectId(slugify(name), seen)
  const entry = validateProject({ id: mintedId, name, ...(path !== undefined ? { path } : {}) }, { seen })
  const next = { ...config, projects: [...projects, entry], activeProject: config.activeProject ?? entry.id }
  writeConfig(next, { env, homedir, fsImpl, ...(repoDir !== undefined ? { repoDir } : {}) })
  return next
}

/**
 * renameProject(config, {id, name}, io) — change the NAME only. The id is the key rows
 * and workers reference; it is immutable by construction here. Unknown id →
 * UnknownProjectError (a named error the door maps to 404).
 *
 * @returns {object} the updated config
 */
export function renameProject(config, { id, name } = {}, { env = process.env, homedir = osHomedir, fsImpl, repoDir } = {}) {
  const projects = Array.isArray(config && config.projects) ? config.projects : []
  const idx = projects.findIndex((p) => p && p.id === id)
  if (idx === -1) throw new UnknownProjectError(`renameProject: unknown project "${id}"`)
  const entry = validateProject({ ...projects[idx], id: projects[idx].id, name })
  const next = { ...config, projects: projects.map((p, i) => (i === idx ? entry : p)) }
  writeConfig(next, { env, homedir, fsImpl, ...(repoDir !== undefined ? { repoDir } : {}) })
  return next
}

/**
 * selectProject(config, {id}, io) — move `activeProject`. Unknown id → UnknownProjectError.
 *
 * @returns {object} the updated config
 */
export function selectProject(config, { id } = {}, { env = process.env, homedir = osHomedir, fsImpl, repoDir } = {}) {
  const projects = Array.isArray(config && config.projects) ? config.projects : []
  if (!projects.some((p) => p && p.id === id)) {
    throw new UnknownProjectError(`selectProject: unknown project "${id}"`)
  }
  const next = { ...config, activeProject: id }
  writeConfig(next, { env, homedir, fsImpl, ...(repoDir !== undefined ? { repoDir } : {}) })
  return next
}

/**
 * addPeer(config, {id, name, url, token}, io) — take a machine into the PEER registry and
 * persist, atomically (D-9.7-06).
 *
 * THE REGISTRY HAS EXACTLY ONE WRITE PATH — this door and its sibling below. The whole
 * candidate goes back through `validateFederation`, so a joining machine is held to the
 * SAME rules a peer written by hand is, and a duplicate id is an InvalidFederationError
 * rather than a silent shadow of a machine that already exists. The role is NOT touched:
 * what this daemon is stays the founder's declaration, never a side effect of a join.
 *
 * `token` here is the PEER'S OWN daemon token, the credential this hub will present when
 * it calls that machine. It is stored, and it is collapsed by secretsView on the way out
 * (T-9.7-05) — it never rides a payload.
 *
 * @returns {object} the updated config
 * @throws {InvalidFederationError}
 */
export function addPeer(config, { id, name, url, token } = {}, { env = process.env, homedir = osHomedir, fsImpl, repoDir } = {}) {
  const current = validateFederation((config && config.federation) ?? undefined)
  const entry = { id, url, token, ...(name !== undefined ? { name } : {}) }
  const federation = validateFederation({ ...current, peers: [...current.peers, entry] })
  const next = { ...config, federation }
  writeConfig(next, { env, homedir, fsImpl, ...(repoDir !== undefined ? { repoDir } : {}) })
  return next
}

/**
 * removePeer(config, {id}, io) — let a machine go. Unknown id → UnknownPeerError (a named
 * error the door maps to 404): removing a machine that is not there is a mistake worth
 * telling the founder about, not a silent success that hides a typo.
 *
 * @returns {object} the updated config
 * @throws {UnknownPeerError}
 */
export function removePeer(config, { id } = {}, { env = process.env, homedir = osHomedir, fsImpl, repoDir } = {}) {
  const current = validateFederation((config && config.federation) ?? undefined)
  if (!current.peers.some((p) => p && p.id === id)) {
    throw new UnknownPeerError(`removePeer: unknown machine "${id}"`)
  }
  const federation = { ...current, peers: current.peers.filter((p) => p.id !== id) }
  const next = { ...config, federation }
  writeConfig(next, { env, homedir, fsImpl, ...(repoDir !== undefined ? { repoDir } : {}) })
  return next
}

/**
 * secretsView(config, {env}) — THE ONLY loggable shape. Deep-copies the config with
 * `token`, every `account.oauthTokenEnv` AND every `federation.peers[].token` collapsed
 * to '[set]'/'[unset]'. The raw token, the env-var NAMES and every peer token never
 * appear in the returned object (T-9.5-01, T-9.7-05).
 *
 * `[set]`/`[unset]` for an account reflects whether the NAMED env var is populated in
 * `env` (default process.env) — operational insight with zero leakage. A peer token, by
 * contrast, IS a value in the config, so its collapse reflects the stored value itself.
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
  const hasFederation = config.federation !== undefined && config.federation !== null
  const federation = hasFederation
    ? {
        ...config.federation,
        peers: (config.federation.peers ?? []).map((p) => ({ ...p, token: p && p.token ? '[set]' : '[unset]' })),
      }
    : undefined
  return {
    ...config,
    token: config.token ? '[set]' : '[unset]',
    workers,
    ...(hasFederation ? { federation } : {}),
  }
}
