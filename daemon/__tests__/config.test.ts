/**
 * Tests for daemon/src/config.mjs.
 *
 * Worker-profile + secrets config loader:
 *   - Test 1: resolveConfigPath honors the SMA_DAEMON_CONFIG env override.
 *   - Test 2: resolveConfigPath falls back to ~/.sma-daemon/config.json via the
 *     injected homedir (no override).
 *   - Test 3: loadConfig with NO file present writes a default config, generates a
 *     64-hex token (randomBytes(32)), and (POSIX only) stamps mode 0600.
 *   - Test 4: the default pool is 5 profiles (3 Claude Max + 1
 *     Codex/Pro + the `creator` forge role, enabled) and exactly one dayPriorityOwner.
 *     The creator RIDES an existing Max account.
 *   - Test 5: loadConfig with an existing file parses and returns it unchanged
 *     (token round-trips — the default is persisted, not regenerated per call).
 *   - Test 6: validation rejects a worker profile missing id / lane / account.configDir
 *     with a named InvalidWorkerProfileError.
 *   - Test 7: validation normalizes the harness trio — enabled defaults to
 *     true; roleFile / skills are accepted.
 *   - Test 8: secretsView is the ONLY loggable shape — token and every
 *     account.oauthTokenEnv collapse to '[set]'/'[unset]'; no secret,
 *     no env-var NAME, ever leaves.
 *
 * V5.1 additions (project registry, quiet migration,
 * federation shape):
 *   - Test 9: REGRESSION — a config carrying NEITHER projects NOR federation still
 *     loads and validates (the additive-field law: no existing install breaks).
 *   - Test 10: ensureDefaultProject is the quiet migration — the first load mints
 *     exactly ONE project (name from the install profile when present, else the
 *     repo directory name) and a second load mints nothing (idempotence).
 *   - Test 11: validateProject truth table (missing id, bad slug, duplicate, empty name).
 *   - Test 12: validateFederation truth table (three roles, broken url, empty token).
 *   - Test 13: peer tokens collapse in secretsView from the day the field exists
 * — the token value appears in NO serialization of the view.
 *   - Test 14: renaming a project changes the name only — the id is the key tasks
 *     reference and never moves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

import {
  resolveConfigPath,
  loadConfig,
  secretsView,
  ensureDefaultProject,
  validateProject,
  validateFederation,
  addProject,
  renameProject,
  selectProject,
  stripDerivedDirs,
  FEDERATION_ROLES,
  InvalidWorkerProfileError,
  InvalidProjectError,
  InvalidFederationError,
  UnknownProjectError,
} from '../src/config.mjs'

let home: string
let repo: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sma-daemon-cfg-'))
  repo = mkdtempSync(join(tmpdir(), 'sma-repo-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const homedir = () => home

describe('resolveConfigPath', () => {
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

  it('encodes the pool: 5 profiles (3 claude + 1 codex + creator forge) and one dayPriorityOwner', () => {
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

describe('loadConfig — the working directories are self-sufficient', () => {
  it('derives dataDir/ledgerDir from the config root and repoDir from the caller', () => {
    // The shipped default names none of the three, and an undefined ledgerDir is how a
    // failed attempt lost its reason: the ledger write threw and the card came back empty.
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    const root = join(home, '.sma-daemon')
    expect(cfg.dataDir).toBe(join(root, 'data'))
    expect(cfg.ledgerDir).toBe(join(root, 'ledger'))
    expect(cfg.repoDir).toBe(repo)
  })

  it('honours explicit directories and does not persist the derived ones', () => {
    loadConfig({ env: {}, homedir, repoDir: repo }) // bootstrap the file
    const path = resolveConfigPath({ env: {}, homedir })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.dataDir).toBeUndefined() // derived at read time — the file stays portable
    raw.dataDir = join(repo, 'my-data')
    writeFileSync(path, JSON.stringify(raw), 'utf8')
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(cfg.dataDir).toBe(join(repo, 'my-data'))
    expect(cfg.ledgerDir).toBe(join(home, '.sma-daemon', 'ledger')) // still derived
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

  it('normalizes the harness trio: enabled defaults true; roleFile/skills accepted', () => {
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

describe('secretsView (the only loggable shape)', () => {
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

// ─────────────────── V5.1: projects + federation ───────────────────

/** Seed a PRE-V5.1 config on disk: workers, token — no projects, no federation. */
function seedLegacyConfig(): string {
  const path = resolveConfigPath({ env: {}, homedir })
  loadConfig({ env: {}, homedir, repoDir: repo })
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  delete raw.projects
  delete raw.activeProject
  delete raw.federation
  writeFileSync(path, JSON.stringify(raw, null, 2))
  return path
}

describe('REGRESSION — a pre-V5.1 config still loads (additive-field law)', () => {
  it('a config with NEITHER projects NOR federation validates and keeps its workers and token', () => {
    const path = seedLegacyConfig()
    const before = JSON.parse(readFileSync(path, 'utf8'))
    expect(before.projects).toBeUndefined()
    expect(before.federation).toBeUndefined()

    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(cfg.workers).toHaveLength(5)
    expect(cfg.token).toBe(before.token)
    expect(cfg.workers.find((w: any) => w.id === 'creator').lane).toBe('forge')
  })
})

describe('ensureDefaultProject — the quiet migration', () => {
  it('the first load mints exactly ONE project and points activeProject at it', () => {
    seedLegacyConfig()
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(cfg.projects).toHaveLength(1)
    expect(cfg.activeProject).toBe(cfg.projects[0].id)
    expect(cfg.projects[0].id).toMatch(/^[a-z0-9-]{1,64}$/)
  })

  it('the project name comes from the install profile when there is one', () => {
    mkdirSync(join(repo, '.sma'), { recursive: true })
    writeFileSync(join(repo, '.sma', 'profile.json'), JSON.stringify({ projectName: 'Acme Clinic' }))
    seedLegacyConfig()
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(cfg.projects[0].name).toBe('Acme Clinic')
    expect(cfg.projects[0].id).toBe('acme-clinic')
  })

  it('with no profile the name falls back to the repository directory name', () => {
    seedLegacyConfig()
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(cfg.projects[0].name).toBe(basename(repo))
  })

  it('a name with no latin characters still yields a VALID slug id, name preserved', () => {
    const out = ensureDefaultProject({ workers: [] }, { projectName: 'Клиника' })
    expect(out.projects[0].name).toBe('Клиника')
    expect(out.projects[0].id).toMatch(/^[a-z0-9-]{1,64}$/)
  })

  it('IDEMPOTENT — a second load does not mint a second project', () => {
    seedLegacyConfig()
    const first = loadConfig({ env: {}, homedir, repoDir: repo })
    const second = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(second.projects).toHaveLength(1)
    expect(second.projects[0].id).toBe(first.projects[0].id)
    expect(second.activeProject).toBe(first.activeProject)
  })

  it('is a no-op (same object reference) once a registry exists', () => {
    const cfg = { workers: [], projects: [{ id: 'acme', name: 'Acme' }], activeProject: 'acme' }
    expect(ensureDefaultProject(cfg, { projectName: 'Other' })).toBe(cfg)
  })
})

describe('validateProject — truth table', () => {
  it('accepts a well-formed entry', () => {
    expect(validateProject({ id: 'acme-clinic', name: 'Acme Clinic' })).toMatchObject({
      id: 'acme-clinic',
      name: 'Acme Clinic',
    })
  })

  it('rejects a missing id, an id outside the slug pattern, an empty name and a duplicate id', () => {
    expect(() => validateProject({ name: 'no id' })).toThrow(InvalidProjectError)
    expect(() => validateProject({ id: 'Acme Clinic', name: 'bad slug' })).toThrow(InvalidProjectError)
    expect(() => validateProject({ id: 'a'.repeat(65), name: 'too long' })).toThrow(InvalidProjectError)
    expect(() => validateProject({ id: 'acme', name: '   ' })).toThrow(InvalidProjectError)
    const seen = new Set<string>()
    validateProject({ id: 'acme', name: 'Acme' }, { seen })
    expect(() => validateProject({ id: 'acme', name: 'Acme again' }, { seen })).toThrow(InvalidProjectError)
  })

  it('workers[].project is optional, and when present must reference an existing project', () => {
    const path = resolveConfigPath({ env: {}, homedir })
    loadConfig({ env: {}, homedir, repoDir: repo })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.workers.push({
      id: 'w-ghost',
      lane: 'prod',
      provider: 'claude',
      account: { name: 'max-1', configDir: '~/.sma-accounts/max-1' },
      project: 'no-such-project',
    })
    writeFileSync(path, JSON.stringify(raw, null, 2))
    expect(() => loadConfig({ env: {}, homedir, repoDir: repo })).toThrow(InvalidWorkerProfileError)
  })
})

describe('validateFederation — truth table', () => {
  it('an absent block means role standalone with no peers', () => {
    expect(validateFederation(undefined)).toMatchObject({ role: 'standalone', peers: [] })
    expect(FEDERATION_ROLES).toEqual(['standalone', 'hub', 'peer'])
  })

  it('accepts exactly the three roles', () => {
    for (const role of FEDERATION_ROLES) {
      expect(validateFederation({ role, peers: [] }).role).toBe(role)
    }
    expect(() => validateFederation({ role: 'leader', peers: [] })).toThrow(InvalidFederationError)
  })

  it('accepts a well-formed peer and rejects a broken url or an empty token', () => {
    const ok = validateFederation({ role: 'hub', peers: [{ id: 'mac-mini', url: 'https://10.0.0.4:7777', token: 'tk' }] })
    expect(ok.peers[0].id).toBe('mac-mini')
    expect(() => validateFederation({ role: 'hub', peers: [{ id: 'p', url: 'not a url', token: 'tk' }] })).toThrow(
      InvalidFederationError,
    )
    expect(() => validateFederation({ role: 'hub', peers: [{ id: 'p', url: 'ftp://host/x', token: 'tk' }] })).toThrow(
      InvalidFederationError,
    )
    expect(() => validateFederation({ role: 'hub', peers: [{ id: 'p', url: 'http://h:7777', token: '' }] })).toThrow(
      InvalidFederationError,
    )
    expect(() => validateFederation({ role: 'hub', peers: [{ id: 'BAD ID', url: 'http://h:7777', token: 'tk' }] })).toThrow(
      InvalidFederationError,
    )
  })

  it('a broken peer entry refuses the whole load — the daemon never starts half-alive', () => {
    const path = resolveConfigPath({ env: {}, homedir })
    loadConfig({ env: {}, homedir, repoDir: repo })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.federation = { role: 'hub', peers: [{ id: 'p1', url: 'nonsense', token: 'tk' }] }
    writeFileSync(path, JSON.stringify(raw, null, 2))
    expect(() => loadConfig({ env: {}, homedir, repoDir: repo })).toThrow(InvalidFederationError)
  })
})

describe('secretsView — peer tokens collapse the day the field exists', () => {
  it('every federation.peers[].token becomes [set]/[unset]; the value is in NO serialization', () => {
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    const withPeers = {
      ...cfg,
      federation: {
        role: 'hub',
        peers: [
          { id: 'mac-mini', url: 'http://10.0.0.4:7777', token: 'peer-secret-value' },
          { id: 'laptop', url: 'http://10.0.0.5:7777', token: '' },
        ],
      },
    }
    const view = secretsView(withPeers, { env: {} })
    expect(view.federation.peers[0].token).toBe('[set]')
    expect(view.federation.peers[1].token).toBe('[unset]')
    expect(JSON.stringify(view)).not.toContain('peer-secret-value')
  })

  it('a config with no federation block passes through secretsView untouched', () => {
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    const view = secretsView(cfg, { env: {} })
    expect(view.federation).toBeUndefined()
    expect(view.token).toBe('[set]')
  })
})

describe('project registry mutations — add / rename / select', () => {
  it('renaming a project changes the NAME only; the id is the key tasks reference', () => {
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    const id = cfg.projects[0].id
    const next = renameProject(cfg, { id, name: 'Совсем другое имя' }, { env: {}, homedir })
    expect(next.projects[0].id).toBe(id)
    expect(next.projects[0].name).toBe('Совсем другое имя')
    expect(loadConfig({ env: {}, homedir, repoDir: repo }).projects[0].name).toBe('Совсем другое имя')
  })

  it('addProject appends a validated entry and refuses a duplicate id', () => {
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    const next = addProject(cfg, { id: 'second', name: 'Second' }, { env: {}, homedir })
    expect(next.projects).toHaveLength(2)
    expect(() => addProject(next, { id: 'second', name: 'Dup' }, { env: {}, homedir })).toThrow(InvalidProjectError)
  })

  it('selectProject moves activeProject and refuses an unknown id with a named error', () => {
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    const two = addProject(cfg, { id: 'second', name: 'Second' }, { env: {}, homedir })
    const next = selectProject(two, { id: 'second' }, { env: {}, homedir })
    expect(next.activeProject).toBe('second')
    expect(() => selectProject(next, { id: 'ghost' }, { env: {}, homedir })).toThrow(UnknownProjectError)
    expect(() => renameProject(next, { id: 'ghost', name: 'x' }, { env: {}, homedir })).toThrow(UnknownProjectError)
  })
})

/**
 * A registry write must persist only the PERSISTED shape.
 *
 * `loadConfig` returns the config WITH the three read-time working directories attached, and
 * every registry door writes that same object back. One project add was enough to land
 * `repoDir`, `dataDir` and `ledgerDir` in `~/.sma-daemon/config.json` as literal keys — and a
 * persisted `repoDir` then decides, on every later boot, whether the first-run interview takes
 * the window and where the agent roster is read from, whatever directory the daemon was
 * started in. `withDerivedDirs` documented itself as «DERIVED AT READ TIME, NEVER PERSISTED»;
 * these two cases are what makes the second half of that sentence true.
 *
 * The second case is the safety half and it matters as much as the first: the rule is «a value
 * the derive would produce again is not written down», never a blanket delete. An operator who
 * pointed `dataDir` somewhere on purpose keeps it across a project add.
 *
 * THE BASELINE THE DOORS TAKE IS `launchDir` — the directory the daemon PROCESS was started
 * in, which is what these cases always meant by `repo`. It used to be called `repoDir`, and
 * that name is what let the effective repoDir be handed in instead; see the pinned-repoDir cases below.
 */
describe('the derived working directories never reach the file', () => {
  const readFile = () => JSON.parse(readFileSync(resolveConfigPath({ env: {}, homedir }), 'utf8'))

  it('a round trip through every registry door leaves no derived key in the file', () => {
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    // the read model carries all three — that is what makes the daemon runnable at all
    expect(cfg.dataDir).toBe(join(home, '.sma-daemon', 'data'))
    expect(cfg.ledgerDir).toBe(join(home, '.sma-daemon', 'ledger'))
    expect(cfg.repoDir).toBe(repo)

    const io = { env: {}, homedir, launchDir: repo }
    const added = addProject(cfg, { id: 'second', name: 'Second', path: repo }, io)
    const selected = selectProject(added, { id: 'second' }, io)
    renameProject(selected, { id: 'second', name: 'Второй' }, io)

    const onDisk = readFile()
    expect(onDisk.dataDir).toBeUndefined()
    expect(onDisk.ledgerDir).toBeUndefined()
    expect(onDisk.repoDir).toBeUndefined()
    // the write itself still happened — the registry is on disk, only the derive is not
    expect(onDisk.activeProject).toBe('second')
    expect(onDisk.projects.find((p: any) => p.id === 'second').name).toBe('Второй')
  })

  it('an EXPLICIT working directory survives the same round trip', () => {
    const path = resolveConfigPath({ env: {}, homedir })
    mkdirSync(join(home, '.sma-daemon'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ token: 'x'.repeat(64), workers: [], dataDir: 'D:/sma-data', projects: [{ id: 'one', name: 'One' }], activeProject: 'one' }),
      'utf8',
    )
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(cfg.dataDir).toBe('D:/sma-data')

    addProject(cfg, { id: 'second', name: 'Second' }, { env: {}, homedir, launchDir: repo })
    const onDisk = readFile()
    expect(onDisk.dataDir).toBe('D:/sma-data') // an operator's own choice is not a derive
    expect(onDisk.ledgerDir).toBeUndefined()
    expect(onDisk.repoDir).toBeUndefined()
  })
})

/**
 * The strip baseline is the LAUNCH directory, and only the launch directory
 * (the live incident of 05.08.2026).
 *
 * The founder's config carried a `repoDir` pin, because the daemon is started from a temp
 * worktree and the pin is the only thing that says which tree the roster and the interview
 * belong to. One press in the window and the pin was gone from the file: the daemon derived
 * `repoDir` = its launch directory and GET /api/onboarding answered `needed: true`, because a
 * worktree has no `.sma/profile.json`.
 *
 * Nothing was wrong with the RULE. `stripDerivedDirs` drops a key when storing it would
 * change nothing — but «nothing» is measured against what a file with NO value would derive,
 * and the derive's repoDir is whatever baseline the caller passes. The composition root
 * passes the doors the EFFECTIVE repoDir (`o.repoDir ?? config.repoDir`), so for a pinned
 * config the test read «pin === pin» and deleted it. The two facts are now told apart by
 * name: `repoDir` is the tree being served, `launchDir` is where the process started.
 *
 * The dataDir/ledgerDir halves are derived from the CONFIG PATH and are untouched by any of
 * this — asserted here so a future change to the repoDir rule cannot quietly move them.
 */
describe('a pinned repoDir is not a derive, and survives every door', () => {
  const readFile = () => JSON.parse(readFileSync(resolveConfigPath({ env: {}, homedir }), 'utf8'))
  const PIN = 'D:/pinned-tree'

  /** A config file that pins a tree ≠ the directory the daemon is launched from. */
  function seedPinnedConfig(extra: object = {}) {
    const path = resolveConfigPath({ env: {}, homedir })
    mkdirSync(join(home, '.sma-daemon'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ token: 'x'.repeat(64), workers: [], repoDir: PIN, projects: [{ id: 'one', name: 'One' }], activeProject: 'one', ...extra }),
      'utf8',
    )
    return path
  }

  it('the pin survives a registry write — the baseline is the launch dir, not the pin', () => {
    seedPinnedConfig()
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(cfg.repoDir).toBe(PIN) // an explicit value always wins over the derive

    addProject(cfg, { id: 'second', name: 'Second' }, { env: {}, homedir, launchDir: repo })
    expect(readFile().repoDir).toBe(PIN)
  })

  it('a repoDir the derive WOULD produce again is still dropped (the DEFER-19 half holds)', () => {
    const path = resolveConfigPath({ env: {}, homedir })
    mkdirSync(join(home, '.sma-daemon'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ token: 'x'.repeat(64), workers: [], repoDir: repo, projects: [{ id: 'one', name: 'One' }], activeProject: 'one' }),
      'utf8',
    )
    const cfg = loadConfig({ env: {}, homedir, repoDir: repo })
    addProject(cfg, { id: 'second', name: 'Second' }, { env: {}, homedir, launchDir: repo })
    expect(readFile().repoDir).toBeUndefined() // storing it would change nothing
  })

  it('dataDir keeps its own rule: hand-set survives, derive-equal is dropped, pin or no pin', () => {
    seedPinnedConfig({ dataDir: 'D:/sma-data' })
    const pinnedCfg = loadConfig({ env: {}, homedir, repoDir: repo })
    addProject(pinnedCfg, { id: 'second', name: 'Second' }, { env: {}, homedir, launchDir: repo })
    let onDisk = readFile()
    expect(onDisk.dataDir).toBe('D:/sma-data') // derived from the config PATH — never from repoDir
    expect(onDisk.repoDir).toBe(PIN)

    // and the same file with the value the derive itself would give: dropped
    seedPinnedConfig({ dataDir: join(home, '.sma-daemon', 'data') })
    const derivedCfg = loadConfig({ env: {}, homedir, repoDir: repo })
    addProject(derivedCfg, { id: 'second', name: 'Second' }, { env: {}, homedir, launchDir: repo })
    onDisk = readFile()
    expect(onDisk.dataDir).toBeUndefined()
    expect(onDisk.repoDir).toBe(PIN)
  })

  it('stripDerivedDirs refuses the old parameter name instead of silently mis-comparing', () => {
    // The one way this defect comes back is a caller that still believes the baseline is
    // «the repo directory». There is no safe guess, so the seam says so out loud.
    expect(() => stripDerivedDirs({ repoDir: PIN }, { configPath: '/c/config.json', repoDir: PIN } as any)).toThrow(TypeError)
    expect(stripDerivedDirs({ repoDir: PIN }, { configPath: '/c/config.json', launchDir: repo })).toEqual({ repoDir: PIN })
    expect(stripDerivedDirs({ repoDir: repo }, { configPath: '/c/config.json', launchDir: repo })).toEqual({})
  })
})
