/**
 * harness.test.ts — the harness read model + two-step activation appliers + the MCP seam.
 *
 * Proves the SPA data contract and the RCE-closed activation path with fakes only — no real
 * ~/.sma-daemon, no real repo tree, no token ever on disk:
 *   - loadMcpRegistry: load / SMA_DAEMON_MCP override / absent → {servers:[]} / malformed → error;
 *   - readHarness shape: env VALUES absent, '[set]'/'[unset]' present, agent can/cannot joined
 *     from the roleFile, skills assignedTo, drafts (kind + draftPath) from the adapter;
 *   - the appliers: existing flip / file-derived create (request contributes only the id) /
 *     missing definition file → error / unknown worker → error / skill assign replace + unassign;
 *   - applyMcpToggle boolean-only: the rewritten registry deep-equals the original except `enabled`;
 *   - buildClaudeArgs mcpConfigPath order + buildMcpConfigFile enabled-only filtering + per-task path.
 *
 * Later work appends the STOCK TEAM cases:
 *   - readStockTeam: the whole installed roster (including definitions the roster config never
 *     heard of), fork state by CONTENT DIGEST against the pristine engine copy, the user's own
 *     agents, a named problem instead of a drop or a throw, an absent directory → [], both
 *     install layouts (project-local and the global config dir), and no body / no absolute path;
 *   - applyStockTeamToggle: one act enables the shipped roster through the EXISTING toggle door,
 *     recording each activated definition's pristine digest as the baseline readStockTeam reads
 *     back — with the route table still frozen.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
// The wire case at the bottom of this file is the ONE that may touch a disk: a create door is
// judged by the file it left, not by its status code, so that case uses a real temp directory.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadMcpRegistry,
  readHarness,
  readStockTeam,
  applyAgentToggle,
  applySkillAssign,
  applyMcpToggle,
  applyStockTeamToggle,
  createMachineSkill,
  resolveMachineSkillsDir,
  resolveMachineAgentsDir,
  resolveWorkerContext,
  STOCK_TEAM_TARGET,
  MissingDefinitionFileError,
  UnknownProfileError,
  UnknownSkillError,
  SkillExistsError,
  InvalidSkillError,
  InvalidMcpRegistryError,
  UnknownMcpServerError,
} from '../src/front/harness.mjs'
import { buildClaudeArgs, buildMcpConfigFile } from '../src/runner/args.mjs'
import { createFrontServer, ROUTES, STOCK_TEAM_TARGET as SERVER_STOCK_TEAM_TARGET } from '../src/front/server.mjs'

// ── a fake fs (files for reads, dirs for readdir, records writes) ──

function fakeFs({ files = {}, dirs = {} }: { files?: Record<string, string>; dirs?: Record<string, string[]> } = {}) {
  const writes: Array<{ path: string; content: string }> = []
  const norm = (p: string) => String(p).replace(/\\/g, '/')
  const lookup = (p: string) => {
    const key = norm(p)
    for (const [suffix, content] of Object.entries(files)) if (key.endsWith(suffix)) return content
    return undefined
  }
  const fs = {
    existsSync: (p: string) => lookup(p) !== undefined,
    readFileSync: (p: string) => {
      const c = lookup(p)
      if (c === undefined) throw new Error(`ENOENT ${p}`)
      return c
    },
    readdirSync: (p: string) => {
      const key = norm(p)
      for (const [suffix, names] of Object.entries(dirs)) if (key.endsWith(suffix)) return names
      throw new Error(`ENOENT ${p}`)
    },
    mkdirSync: () => {},
    writeFileSync: (p: string, c: string) => writes.push({ path: norm(p), content: c }),
    renameSync: () => {},
  }
  return { fs, writes, lastWritten: () => JSON.parse(writes[writes.length - 1].content) }
}

const ROLE_CREATOR = `---
name: Создатель
description: Роль-кузнец, собирает черновики по описанию.
lane: forge
can:
  - собирать черновики определений
  - читать репозиторий и память
cannot:
  - активировать что-либо
  - пушить в main
---
# Создатель
Собирает черновик и коммитит его на задачной ветке.
`

const DEF_NEW_AGENT = `---
name: twitter-parser
description: Читает публичные твиты и пишет сводку.
lane: research
provider: claude
---
body
`

const SKILL_DIGEST = `---
name: twitter-digest
description: Короткая сводка из постов.
use-when: когда нужно свести посты в абзац
---
body
`

// ── loadMcpRegistry ──

describe('loadMcpRegistry — the human-edited allowlist', () => {
  it('loads a well-formed registry from the SMA_DAEMON_MCP override path', () => {
    const reg = { servers: [{ id: 'twitter', title: 'Twitter', purposeRu: 'чтение твитов', command: 'npx', args: ['twitter-mcp'], envNames: ['TWITTER_TOKEN'], enabled: true }] }
    const { fs } = fakeFs({ files: { '/custom/mcp.json': JSON.stringify(reg) } })
    const out = loadMcpRegistry({ env: { SMA_DAEMON_MCP: '/custom/mcp.json' }, fsImpl: fs })
    expect(out.servers).toHaveLength(1)
    expect(out.servers[0].id).toBe('twitter')
  })

  it('an absent file → {servers: []} (not an error)', () => {
    const { fs } = fakeFs({})
    const out = loadMcpRegistry({ env: { SMA_DAEMON_MCP: '/nope/mcp.json' }, fsImpl: fs })
    expect(out.servers).toEqual([])
  })

  it('a malformed file → InvalidMcpRegistryError (never a silent empty)', () => {
    const { fs } = fakeFs({ files: { '/custom/mcp.json': '{ not json' } })
    expect(() => loadMcpRegistry({ env: { SMA_DAEMON_MCP: '/custom/mcp.json' }, fsImpl: fs })).toThrow(InvalidMcpRegistryError)
    const { fs: fs2 } = fakeFs({ files: { '/custom/mcp.json': JSON.stringify({ notServers: 1 }) } })
    expect(() => loadMcpRegistry({ env: { SMA_DAEMON_MCP: '/custom/mcp.json' }, fsImpl: fs2 })).toThrow(InvalidMcpRegistryError)
  })
})

// ── readHarness ──

describe('readHarness — the explicit-pick SPA payload', () => {
  const config = {
    workers: [
      { id: 'creator', lane: 'forge', provider: 'claude', account: { configDir: '/c' }, roleFile: '.claude/agents/creator.md', skills: ['twitter-digest'], enabled: true },
      { id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: false },
    ],
  }
  const registry = {
    servers: [{ id: 'twitter', title: 'Twitter', purposeRu: 'чтение твитов', command: 'npx', args: ['twitter-mcp'], envNames: ['TWITTER_TOKEN', 'MISSING_TOKEN'], enabled: true }],
  }
  const adapter = {
    list: async () => [
      { id: 'F-1', lane: 'forge', status: 'completed', title: 'агент-парсер', forge: { kind: 'agent' }, draftPath: '.claude/agents/twitter-parser.md' },
      { id: 'BL-9', lane: 'prod', status: 'completed', title: 'код' },
    ],
  }

  // EVERY read below names the machine store explicitly. Without it the store resolves out of
  // the real home directory, and the fake fs matches paths by SUFFIX — so `~/.claude/skills`
  // answered the project store's fixture and the walk depended on the machine running the suite.
  const NO_MACHINE = { SMA_DAEMON_SKILLS: '/machine/skills' }

  it('joins agent profile + roleFile can/cannot; exposes enabled per profile', async () => {
    const { fs } = fakeFs({ files: { '.claude/agents/creator.md': ROLE_CREATOR }, dirs: { '.claude/skills': [] } })
    const out = await readHarness({ config, registry, adapter, repoDir: '/repo', fsImpl: fs, env: NO_MACHINE })
    const creator = out.agents.find((a: any) => a.id === 'creator')
    expect(creator.title).toBe('Создатель')
    expect(creator.can).toContain('собирать черновики определений')
    expect(creator.cannot).toContain('пушить в main')
    expect(out.agents.find((a: any) => a.id === 'max-2').enabled).toBe(false)
  })

  it('MCP cards carry env-var NAMES with [set]/[unset] — never the value', async () => {
    const { fs } = fakeFs({ dirs: { '.claude/skills': [] } })
    const out = await readHarness({ config, registry, adapter, repoDir: '/repo', fsImpl: fs, env: { ...NO_MACHINE, TWITTER_TOKEN: 'secret-value' } })
    const card = out.mcp[0]
    expect(card.envStatus).toEqual({ TWITTER_TOKEN: '[set]', MISSING_TOKEN: '[unset]' })
    // the secret value never appears anywhere in the payload
    expect(JSON.stringify(out)).not.toContain('secret-value')
  })

  it('skills scan the tree + per-profile assignment; drafts come from the awaiting-approval forge tasks', async () => {
    const { fs } = fakeFs({
      files: { '.claude/agents/creator.md': ROLE_CREATOR, '/repo/.claude/skills/twitter-digest/SKILL.md': SKILL_DIGEST },
      dirs: { '/repo/.claude/skills': ['twitter-digest'] },
    })
    const out = await readHarness({ config, registry, adapter, repoDir: '/repo', fsImpl: fs, env: NO_MACHINE })
    const skill = out.skills.find((s: any) => s.id === 'twitter-digest')
    expect(skill.title).toBe('twitter-digest')
    expect(skill.source).toBe('project')
    expect(skill.assignedTo).toEqual(['creator'])
    // only the forge task surfaces as a draft, with its kind + path
    expect(out.drafts).toHaveLength(1)
    expect(out.drafts[0]).toMatchObject({ id: 'F-1', kind: 'agent', draftPath: '.claude/agents/twitter-parser.md' })
  })
})

/**
 * THE TWO STORES.
 *
 * The defect these cover is not «the screen is missing». The screen existed, walked skills,
 * drew a card for each and knew who held it — and looked empty, because it read ONE directory
 * (the served tree) while the person's skills were in the other (this machine's own library).
 * A feature that is present and reads the wrong place is indistinguishable, from the outside,
 * from a feature that was never built, and that is exactly the conclusion the person reached.
 */
describe('readHarness — the skills of the PROJECT and the skills of the MACHINE', () => {
  const config = { workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true }] }

  const MACHINE_SKILL = `---
name: release-notes
description: Как собрать заметки к релизу.
---
тело машинного навыка
`

  it('a MACHINE-store skill is visible under ANY active project — including one with no skills directory at all', async () => {
    const { fs } = fakeFs({
      files: { '/machine/skills/release-notes/SKILL.md': MACHINE_SKILL },
      dirs: { '/machine/skills': ['release-notes'] },
    })
    // TWO different trees, neither of which carries a `.claude/skills` — the readdir throws for
    // both, exactly as it does in a project that never had one.
    for (const repoDir of ['/product', '/some/other/project']) {
      const out = await readHarness({ config, repoDir, fsImpl: fs, env: { SMA_DAEMON_SKILLS: '/machine/skills' } })
      expect(out.skills.map((s: any) => s.id)).toEqual(['release-notes'])
      expect(out.skills[0].source).toBe('machine')
      expect(out.skills[0].description).toBe('Как собрать заметки к релизу.')
    }
  })

  it('the payload says WHERE it looked — both stores, their paths, and whether each exists', async () => {
    const { fs } = fakeFs({ dirs: { '/machine/skills': [] } })
    const out = await readHarness({ config, repoDir: '/product', fsImpl: fs, env: { SMA_DAEMON_SKILLS: '/machine/skills' } })
    expect(out.skills).toEqual([])
    expect(out.skillStores).toHaveLength(2)
    const project = out.skillStores.find((s: any) => s.source === 'project')
    const machine = out.skillStores.find((s: any) => s.source === 'machine')
    // the served tree has no such directory at all — said as `present: false`, not as an empty count
    expect(project).toMatchObject({ present: false, count: 0 })
    expect(String(project.path).replace(/\\/g, '/')).toBe('/product/.claude/skills')
    expect(machine).toMatchObject({ path: '/machine/skills', present: true, count: 0 })
  })

  it('an id in BOTH stores is ONE card — the project copy wins and the shadowed twin is named', async () => {
    const { fs } = fakeFs({
      files: {
        '/product/.claude/skills/release-notes/SKILL.md': `---\nname: release-notes\ndescription: проектная версия\n---\nтело\n`,
        '/machine/skills/release-notes/SKILL.md': MACHINE_SKILL,
      },
      dirs: { '/product/.claude/skills': ['release-notes'], '/machine/skills': ['release-notes'] },
    })
    const out = await readHarness({ config, repoDir: '/product', fsImpl: fs, env: { SMA_DAEMON_SKILLS: '/machine/skills' } })
    expect(out.skills).toHaveLength(1)
    expect(out.skills[0].source).toBe('project')
    expect(out.skills[0].description).toBe('проектная версия')
    // the copy that was passed over is SAID, never silently dropped
    expect(out.skills[0].problem).toMatch(/machine/)
  })

  it('a folder with no SKILL.md is not a skill and not a problem — it is simply not one', async () => {
    const { fs } = fakeFs({ dirs: { '/machine/skills': ['README', 'notes'] } })
    const out = await readHarness({ config, repoDir: '/product', fsImpl: fs, env: { SMA_DAEMON_SKILLS: '/machine/skills' } })
    expect(out.skills).toEqual([])
    expect(out.skillStores.find((s: any) => s.source === 'machine')).toMatchObject({ present: true, count: 0 })
  })

  it('resolveMachineSkillsDir: the override wins, then CLAUDE_CONFIG_DIR, then the home', () => {
    expect(resolveMachineSkillsDir({ env: { SMA_DAEMON_SKILLS: '/x/skills', CLAUDE_CONFIG_DIR: '/y' } })).toBe('/x/skills')
    expect(resolveMachineSkillsDir({ env: { CLAUDE_CONFIG_DIR: '/y' } }).replace(/\\/g, '/')).toBe('/y/skills')
    expect(resolveMachineSkillsDir({ env: {}, homedir: () => '/home/me' }).replace(/\\/g, '/')).toBe('/home/me/.claude/skills')
  })
})

// ── the appliers ──

describe('applyAgentToggle — flip existing / create from the FILE only', () => {
  const baseConfig = () => ({
    workers: [
      { id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2', oauthTokenEnv: 'T' }, enabled: true },
    ],
  })

  it('flips an existing profile enabled boolean and writes atomically', () => {
    const { fs, lastWritten } = fakeFs({})
    const next = applyAgentToggle({ config: baseConfig(), id: 'max-2', enabled: false, repoDir: '/repo', fsImpl: fs, env: { SMA_DAEMON_CONFIG: '/cfg.json' } })
    expect(next.workers.find((w: any) => w.id === 'max-2').enabled).toBe(false)
    expect(lastWritten().workers[0].enabled).toBe(false)
  })

  it('creates a new profile from the merged definition file; the request contributes only the id', () => {
    const { fs } = fakeFs({ files: { '.claude/agents/twitter-parser.md': DEF_NEW_AGENT } })
    const next = applyAgentToggle({ config: baseConfig(), id: 'twitter-parser', enabled: true, repoDir: '/repo', fsImpl: fs, env: { SMA_DAEMON_CONFIG: '/cfg.json' } })
    const created = next.workers.find((w: any) => w.id === 'twitter-parser')
    expect(created).toBeTruthy()
    expect(created.lane).toBe('research') // from the FILE
    expect(created.roleFile).toBe('.claude/agents/twitter-parser.md')
    expect(created.account).toEqual({ configDir: '/m2', oauthTokenEnv: 'T' }) // inherited pool default
    expect(created.enabled).toBe(true)
    // the request's free text NEVER became config — no description/title from the request
    expect('description' in created).toBe(false)
  })

  it('a new id with NO definition file → MissingDefinitionFileError (two-step activation)', () => {
    const { fs } = fakeFs({})
    expect(() =>
      applyAgentToggle({ config: baseConfig(), id: 'ghost', enabled: true, repoDir: '/repo', fsImpl: fs, env: { SMA_DAEMON_CONFIG: '/cfg.json' } }),
    ).toThrow(MissingDefinitionFileError)
  })
})

describe('applySkillAssign — replace + unassign, existing workers only', () => {
  const baseConfig = () => ({
    workers: [
      { id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true },
      { id: 'max-3', lane: 'prod', provider: 'claude', account: { configDir: '/m3' }, skills: ['twitter-digest'], enabled: true },
    ],
  })
  const files = { '.claude/skills/twitter-digest/SKILL.md': SKILL_DIGEST }

  it('replaces the assignment: listed workers get it, others lose it', () => {
    const { fs } = fakeFs({ files })
    const next = applySkillAssign({ config: baseConfig(), skillId: 'twitter-digest', workerIds: ['max-2'], repoDir: '/repo', fsImpl: fs, env: { SMA_DAEMON_CONFIG: '/cfg.json' } })
    expect(next.workers.find((w: any) => w.id === 'max-2').skills).toContain('twitter-digest')
    expect(next.workers.find((w: any) => w.id === 'max-3').skills).not.toContain('twitter-digest')
  })

  it('empty workerIds unassigns everywhere', () => {
    const { fs } = fakeFs({ files })
    const next = applySkillAssign({ config: baseConfig(), skillId: 'twitter-digest', workerIds: [], repoDir: '/repo', fsImpl: fs, env: { SMA_DAEMON_CONFIG: '/cfg.json' } })
    for (const w of next.workers) expect((w.skills || [])).not.toContain('twitter-digest')
  })

  it('an unknown worker id → UnknownProfileError; a missing skill file → UnknownSkillError', () => {
    const { fs } = fakeFs({ files })
    expect(() =>
      applySkillAssign({ config: baseConfig(), skillId: 'twitter-digest', workerIds: ['ghost'], repoDir: '/repo', fsImpl: fs, env: { SMA_DAEMON_CONFIG: '/cfg.json' } }),
    ).toThrow(UnknownProfileError)
    const { fs: fs2 } = fakeFs({})
    expect(() =>
      applySkillAssign({ config: baseConfig(), skillId: 'no-skill', workerIds: [], repoDir: '/repo', fsImpl: fs2, env: { SMA_DAEMON_CONFIG: '/cfg.json' } }),
    ).toThrow(UnknownSkillError)
  })

  /**
   * A CARD THE WINDOW SHOWS MUST BE A CARD THE WINDOW CAN ACT ON. While this applier looked
   * only in the served tree, every machine-store skill on the screen answered 404 to the one
   * button it had — the card was real and its «Кому дать» was not.
   */
  it('a skill that lives in the MACHINE store can be assigned too', () => {
    const { fs } = fakeFs({ files: { '/machine/skills/release-notes/SKILL.md': '---\nname: release-notes\ndescription: d\n---\nтело\n' } })
    const next = applySkillAssign({
      config: baseConfig(),
      skillId: 'release-notes',
      workerIds: ['max-2'],
      repoDir: '/repo',
      fsImpl: fs,
      env: { SMA_DAEMON_CONFIG: '/cfg.json', SMA_DAEMON_SKILLS: '/machine/skills' },
    })
    expect(next.workers.find((w: any) => w.id === 'max-2').skills).toContain('release-notes')
  })

  it('a skill in NEITHER store is refused, and the refusal names both places it looked', () => {
    const { fs } = fakeFs({})
    let message = ''
    try {
      applySkillAssign({
        config: baseConfig(),
        skillId: 'nowhere',
        workerIds: [],
        repoDir: '/repo',
        fsImpl: fs,
        env: { SMA_DAEMON_CONFIG: '/cfg.json', SMA_DAEMON_SKILLS: '/machine/skills' },
      })
    } catch (err: any) {
      message = String(err.message).replace(/\\/g, '/')
    }
    expect(message).toContain('/repo/.claude/skills/nowhere/SKILL.md')
    expect(message).toContain('/machine/skills/nowhere/SKILL.md')
  })
})

/**
 * createMachineSkill — the ONE writer, and the promises it keeps.
 *
 * The owner's order was «если мы через этот фронт создаём скилл, то люди могут его ставить
 * своим агентам». Two halves: the file has to be REAL (so the proof of this act is a path on a
 * disk, not a 200), and it has to be in the store that every project can see.
 */
describe('createMachineSkill — a skill written from the window', () => {
  const env = { SMA_DAEMON_SKILLS: '/machine/skills' }

  it('writes SKILL.md into the MACHINE store and answers with the path it wrote', () => {
    const { fs, writes } = fakeFs({})
    const made = createMachineSkill({ id: 'release-notes', description: 'Как собрать заметки.', body: 'Шаг один.', env, fsImpl: fs })
    expect(made).toMatchObject({ id: 'release-notes', source: 'machine' })
    expect(made.path.replace(/\\/g, '/')).toBe('/machine/skills/release-notes/SKILL.md')
    // and the bytes are a skill the SAME reader recognises — frontmatter fence, name, description
    const written = writes[writes.length - 1].content
    expect(written.startsWith('---\nname: release-notes\ndescription: Как собрать заметки.\n---\n')).toBe(true)
    expect(written).toContain('Шаг один.')
  })

  it('an id that already exists in EITHER store is refused — a create never overwrites', () => {
    const { fs, writes } = fakeFs({ files: { '/machine/skills/taken/SKILL.md': '---\nname: taken\ndescription: d\n---\nx\n' } })
    expect(() => createMachineSkill({ id: 'taken', description: 'd', body: 'b', env, fsImpl: fs })).toThrow(SkillExistsError)
    expect(writes).toHaveLength(0) // nothing was written on the way to the refusal
  })

  it('an id that could name a path segment is refused before anything is joined', () => {
    const { fs, writes } = fakeFs({})
    for (const bad of ['../escape', 'a/b', 'Upper', '-leading', '', 'имя']) {
      expect(() => createMachineSkill({ id: bad, description: 'd', body: 'b', env, fsImpl: fs })).toThrow(InvalidSkillError)
    }
    expect(writes).toHaveLength(0)
  })

  it('an empty body or an empty description is refused — a card with nothing to say is not a skill', () => {
    const { fs } = fakeFs({})
    expect(() => createMachineSkill({ id: 'ok', description: 'd', body: '   ', env, fsImpl: fs })).toThrow(InvalidSkillError)
    expect(() => createMachineSkill({ id: 'ok', description: '  ', body: 'b', env, fsImpl: fs })).toThrow(InvalidSkillError)
  })

  it('a description carrying newlines cannot grow a second frontmatter key', () => {
    const { fs, writes } = fakeFs({})
    createMachineSkill({ id: 'ok', description: 'первая\nlane: forge\nвторая', body: 'тело', env, fsImpl: fs })
    const written = writes[writes.length - 1].content
    const fence = written.slice(4, written.indexOf('\n---', 3))
    expect(fence.split('\n').filter((l: string) => l.trim() !== '')).toHaveLength(2) // name + description, and nothing else
    expect(fence).toContain('description: первая lane: forge вторая')
  })
})

/**
 * An applier READS from the served repoDir and WRITES against the launch directory.
 *
 * The live incident of 05.08.2026: the founder's config pinned a `repoDir` (the daemon runs
 * from a temp worktree), a toggle was pressed, and the pin was gone from the file — the next
 * boot derived the launch directory instead and the first-run interview took the window. The
 * appliers were handed ONE directory for both jobs, and the front hands them the EFFECTIVE
 * repoDir, which for a pinned config is the pin itself: `stripDerivedDirs` then compared the
 * pin against the pin and dropped it as «a value the derive would produce again».
 *
 * Both cases below call the applier exactly as server.mjs does — `repoDir` = the tree being
 * served, taken from the config — because that call is the defect.
 */
describe('the appliers keep an operator\'s repoDir pin out of the strip', () => {
  const PIN = '/pinned/tree'
  const pinnedConfig = () => ({
    repoDir: PIN,
    workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true }],
  })
  const env = { SMA_DAEMON_CONFIG: '/cfg.json' }

  it('a toggle rewrites the roster and leaves the pin in the file', () => {
    const { fs, lastWritten } = fakeFs({})
    applyAgentToggle({ config: pinnedConfig(), id: 'max-2', enabled: false, repoDir: PIN, launchDir: '/tmp/worktree-91', fsImpl: fs, env })
    expect(lastWritten().workers[0].enabled).toBe(false)
    expect(lastWritten().repoDir).toBe(PIN)
  })

  it('a skill assignment does the same — one seam, all three appliers', () => {
    const { fs, lastWritten } = fakeFs({ files: { '.claude/skills/twitter-digest/SKILL.md': SKILL_DIGEST } })
    applySkillAssign({
      config: pinnedConfig(),
      skillId: 'twitter-digest',
      workerIds: ['max-2'],
      repoDir: PIN,
      launchDir: '/tmp/worktree-91',
      fsImpl: fs,
      env,
    })
    expect(lastWritten().repoDir).toBe(PIN)
  })

  it('and a repoDir equal to the LAUNCH directory is still dropped (holds)', () => {
    const { fs, lastWritten } = fakeFs({})
    const config = { ...pinnedConfig(), repoDir: '/tmp/worktree-91' } // what the derive would give
    applyAgentToggle({ config, id: 'max-2', enabled: false, repoDir: '/tmp/worktree-91', launchDir: '/tmp/worktree-91', fsImpl: fs, env })
    expect(lastWritten().repoDir).toBeUndefined()
  })
})

describe('applyMcpToggle — ONLY the enabled boolean can change (RCE-closed)', () => {
  const registry = () => ({
    servers: [{ id: 'twitter', title: 'Twitter', purposeRu: 'чтение', command: 'npx', args: ['twitter-mcp'], envNames: ['TWITTER_TOKEN'], enabled: false }],
  })

  it('the rewritten registry deep-equals the original except `enabled`', () => {
    const before = registry()
    const { fs, lastWritten } = fakeFs({})
    const after = applyMcpToggle({ registry: before, serverId: 'twitter', enabled: true, env: { SMA_DAEMON_MCP: '/mcp.json' }, fsImpl: fs })
    // every field but enabled is byte-identical to the original entry
    expect(after.servers[0]).toEqual({ ...before.servers[0], enabled: true })
    expect(lastWritten()).toEqual({ servers: [{ ...before.servers[0], enabled: true }] })
  })

  it('an unknown server id → UnknownMcpServerError; a bad id shape → InvalidMcpRegistryError', () => {
    const { fs } = fakeFs({})
    expect(() => applyMcpToggle({ registry: registry(), serverId: 'nope', enabled: true, env: { SMA_DAEMON_MCP: '/mcp.json' }, fsImpl: fs })).toThrow(UnknownMcpServerError)
    expect(() => applyMcpToggle({ registry: registry(), serverId: 'bad id!', enabled: true, env: { SMA_DAEMON_MCP: '/mcp.json' }, fsImpl: fs })).toThrow(InvalidMcpRegistryError)
  })
})

// ── resolveWorkerContext ──

describe('resolveWorkerContext — the role/skills preamble that makes «включён» real', () => {
  it('returns the roleFile body (capped) + the assigned skill names', () => {
    const { fs } = fakeFs({ files: { '.claude/agents/creator.md': ROLE_CREATOR } })
    const ctx = resolveWorkerContext({ worker: { id: 'creator', roleFile: '.claude/agents/creator.md', skills: ['twitter-digest'] }, repoDir: '/repo', fsImpl: fs })
    expect(ctx.rolePreamble).toContain('Собирает черновик')
    expect(ctx.skillsList).toEqual(['twitter-digest'])
  })

  it('no roleFile → no preamble, still returns the skills list', () => {
    const { fs } = fakeFs({})
    const ctx = resolveWorkerContext({ worker: { id: 'max-2', skills: [] }, repoDir: '/repo', fsImpl: fs })
    expect(ctx.rolePreamble).toBeUndefined()
    expect(ctx.skillsList).toEqual([])
    expect(ctx.skillsPreamble).toBeUndefined()
  })

  /**
   * THE ASSIGNMENT HAS TO REACH THE SESSION, or «дать навык работнику» is a row in a config
   * file. It used to be exactly that: the skill names went into the journal and nowhere else,
   * and the worker they were given to never learned it had them.
   */
  it('an assigned skill travels WITH ITS TEXT, from either store, naming the store it came from', () => {
    const { fs } = fakeFs({
      files: {
        '/repo/.claude/skills/twitter-digest/SKILL.md': SKILL_DIGEST,
        '/machine/skills/release-notes/SKILL.md': '---\nname: release-notes\ndescription: d\n---\nтело машинного навыка\n',
      },
    })
    const ctx = resolveWorkerContext({
      worker: { id: 'max-2', skills: ['twitter-digest', 'release-notes'] },
      repoDir: '/repo',
      fsImpl: fs,
      env: { SMA_DAEMON_SKILLS: '/machine/skills' },
    })
    expect(ctx.skillsPreamble).toContain('twitter-digest (источник: дерево проекта)')
    expect(ctx.skillsPreamble).toContain('release-notes (источник: хранилище машины)')
    expect(ctx.skillsPreamble).toContain('тело машинного навыка')
  })

  it('an assigned skill whose file is gone is NAMED as missing, never silently dropped', () => {
    const { fs } = fakeFs({})
    const ctx = resolveWorkerContext({
      worker: { id: 'max-2', skills: ['vanished'] },
      repoDir: '/repo',
      fsImpl: fs,
      env: { SMA_DAEMON_SKILLS: '/machine/skills' },
    })
    expect(ctx.skillsPreamble).toContain('vanished')
    expect(ctx.skillsPreamble).toContain('не найден')
  })
})

// ── the MCP → spawn seam (args.mjs) ──

// ── the stock team ──

const STOCK_PLANNER = `---
name: sma-planner
description: Собирает планы фаз.
tools: Read, Write, Edit
color: purple
---
Тело определения планировщика.
`

/** The same definition after the user edited one line of it — a fork by content. */
const STOCK_PLANNER_EDITED = STOCK_PLANNER.replace('Собирает планы фаз.', 'Собирает планы фаз по-моему.')

const STOCK_VERIFIER = `---
name: sma-verifier
description: Проверяет сделанное.
tools: Read, Bash
---
Тело проверяющего.
`

const OWN_HELPER = `---
name: мой-помощник
description: Личный агент, которого привёл пользователь.
tools: Read
---
Тело личного агента.
`

/** A shipped definition that lives in the MACHINE store — the swarm of the person, not of the tree. */
const STOCK_SCOUT = `---
name: sma-scout
description: Ищет по дереву и не правит.
lane: research
provider: claude
tools: Read, Grep
---
Тело определения разведчика.
`

/** No frontmatter fence at all — must be reported, never dropped and never thrown on. */
const BROKEN_DEF = 'просто текст без рамки\nвторая строка\n'

/**
 * A project-local install: <repo>/.claude/agents (editable) + <repo>/.claude/sma-core/agents
 * (pristine), and NOTHING in the machine store — these cases are about the project's own tree.
 *
 * The `/repo` prefix on every key is load-bearing rather than decorative: fakeFs matches paths
 * by SUFFIX, and the machine store's default is `<home>/.claude/agents`, which ends with the
 * same characters. Unprefixed, the fake would serve the project's files to the machine walk as
 * well and every id would come back shadowed by its own self.
 */
function localInstall({
  planner = STOCK_PLANNER,
  extraFiles = {},
  extraAgents = [],
}: { planner?: string; extraFiles?: Record<string, string>; extraAgents?: string[] } = {}) {
  return fakeFs({
    files: {
      '/repo/.claude/agents/sma-planner.md': planner,
      '/repo/.claude/agents/sma-verifier.md': STOCK_VERIFIER,
      '/repo/.claude/sma-core/agents/sma-planner.md': STOCK_PLANNER,
      '/repo/.claude/sma-core/agents/sma-verifier.md': STOCK_VERIFIER,
      ...extraFiles,
    },
    dirs: {
      '/repo/.claude/agents': ['sma-planner.md', 'sma-verifier.md', ...extraAgents],
      '/repo/.claude/sma-core/agents': ['sma-planner.md', 'sma-verifier.md'],
      '/repo/.claude/skills': [],
    },
  })
}

const NO_HOME = () => '/home/nobody'

describe('readStockTeam — the roster that actually arrived with the install', () => {
  it('reports every definition file in the agents directory, including ids the roster config never heard of', () => {
    const { fs } = localInstall()
    const team = readStockTeam({
      config: { workers: [] },
      repoDir: '/repo',
      fsImpl: fs,
      env: {},
      homedir: NO_HOME,
    })
    expect(team.map((e: any) => e.id).sort()).toEqual(['sma-planner', 'sma-verifier'])
    expect(team.find((e: any) => e.id === 'sma-planner')).toMatchObject({
      title: 'sma-planner',
      description: 'Собирает планы фаз.',
      tools: ['Read', 'Write', 'Edit'],
      enabled: false,
      origin: 'sma',
      forked: false,
    })
  })

  it('an editable copy byte-identical to the pristine engine copy is NOT forked; an edited one IS', () => {
    const clean = readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: localInstall().fs, env: {}, homedir: NO_HOME })
    expect(clean.find((e: any) => e.id === 'sma-planner').forked).toBe(false)

    const edited = readStockTeam({
      config: { workers: [] },
      repoDir: '/repo',
      fsImpl: localInstall({ planner: STOCK_PLANNER_EDITED }).fs,
      env: {},
      homedir: NO_HOME,
    })
    expect(edited.find((e: any) => e.id === 'sma-planner').forked).toBe(true)
    // the untouched sibling is not dragged along by its neighbour's fork
    expect(edited.find((e: any) => e.id === 'sma-verifier').forked).toBe(false)
  })

  it('a definition with no pristine counterpart is the USER’S OWN, never a fork', () => {
    const { fs } = localInstall({
      extraFiles: { '.claude/agents/my-helper.md': OWN_HELPER },
      extraAgents: ['my-helper.md'],
    })
    const team = readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: {}, homedir: NO_HOME })
    const mine = team.find((e: any) => e.id === 'my-helper')
    expect(mine.origin).toBe('yours')
    expect(mine.forked).toBe(false)
    expect(mine.stockUpdate).toBe('not-shipped')
  })

  it('an unparseable definition is reported with a named problem — not dropped, not thrown on', () => {
    const { fs } = localInstall({
      extraFiles: { '.claude/agents/broken.md': BROKEN_DEF },
      extraAgents: ['broken.md'],
    })
    const team = readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: {}, homedir: NO_HOME })
    const broken = team.find((e: any) => e.id === 'broken')
    expect(broken).toBeTruthy()
    expect(typeof broken.problem).toBe('string')
    expect(broken.problem.length).toBeGreaterThan(0)
    // the readable siblings still came back
    expect(team).toHaveLength(3)
  })

  it('a missing agents directory yields an empty list, not a throw', () => {
    const { fs } = fakeFs({})
    expect(() => readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: {}, homedir: NO_HOME })).not.toThrow()
    expect(readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: {}, homedir: NO_HOME })).toEqual([])
  })

  it('the GLOBAL install layout resolves through CLAUDE_CONFIG_DIR when the project has no .claude/agents', () => {
    const { fs } = fakeFs({
      files: {
        '/opt/cfg/agents/sma-planner.md': STOCK_PLANNER,
        '/opt/cfg/sma-core/agents/sma-planner.md': STOCK_PLANNER,
      },
      dirs: {
        '/opt/cfg/agents': ['sma-planner.md'],
        '/opt/cfg/sma-core/agents': ['sma-planner.md'],
      },
    })
    const team = readStockTeam({
      config: { workers: [] },
      repoDir: '/repo',
      fsImpl: fs,
      env: { CLAUDE_CONFIG_DIR: '/opt/cfg' },
      homedir: NO_HOME,
    })
    expect(team.map((e: any) => e.id)).toEqual(['sma-planner'])
    expect(team[0].origin).toBe('sma')
  })

  it('the enabled flag comes from the roster config, and a newer stock version is unknown until a baseline exists', () => {
    const { fs } = localInstall()
    const config = {
      workers: [
        { id: 'sma-planner', lane: 'prod', provider: 'claude', account: { configDir: '/c' }, enabled: true },
        { id: 'sma-verifier', lane: 'prod', provider: 'claude', account: { configDir: '/c' }, enabled: false, stockDigest: 'deadbeef' },
      ],
    }
    const team = readStockTeam({ config, repoDir: '/repo', fsImpl: fs, env: {}, homedir: NO_HOME })
    const planner = team.find((e: any) => e.id === 'sma-planner')
    const verifier = team.find((e: any) => e.id === 'sma-verifier')
    expect(planner.enabled).toBe(true)
    // never toggled through the stock door → no recorded baseline → honestly unknown, not «up to date»
    expect(planner.stockUpdate).toBe('unknown')
    expect(verifier.enabled).toBe(false)
    // a recorded baseline that no longer matches today's shipped copy → a newer version is available
    expect(verifier.stockUpdate).toBe('available')
  })

  it('a definition checked out with CRLF line endings parses like any other — it is the same file', () => {
    // Found by running the read model against the real install: 3 of 34 shipped definitions
    // were CRLF in the workspace clone and came back as «unparseable». They are not.
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const { fs } = fakeFs({
      files: {
        '/repo/.claude/agents/sma-planner.md': crlf(STOCK_PLANNER),
        '/repo/.claude/sma-core/agents/sma-planner.md': STOCK_PLANNER,
      },
      dirs: { '/repo/.claude/agents': ['sma-planner.md'], '/repo/.claude/sma-core/agents': ['sma-planner.md'] },
    })
    const entry = readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: {}, homedir: NO_HOME })[0]
    expect(entry.problem).toBe(null)
    expect(entry.title).toBe('sma-planner')
    expect(entry.tools).toEqual(['Read', 'Write', 'Edit'])
    // and the CRLF checkout is NOT reported as somebody's edit
    expect(entry.forked).toBe(false)
  })

  it('no entry carries a file body, a token or an absolute path', () => {
    const { fs } = localInstall({
      extraFiles: { '.claude/agents/my-helper.md': OWN_HELPER },
      extraAgents: ['my-helper.md'],
    })
    const team = readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: { SOME_TOKEN: 'secret-value' }, homedir: NO_HOME })
    const wire = JSON.stringify(team)
    expect(wire).not.toContain('Тело определения планировщика')
    expect(wire).not.toContain('secret-value')
    expect(wire).not.toContain('/repo')
    expect(wire).not.toContain('.claude')
    for (const entry of team) {
      expect(Object.keys(entry).sort()).toEqual(
        ['description', 'enabled', 'forked', 'id', 'origin', 'problem', 'source', 'stockUpdate', 'title', 'tools'].sort(),
      )
    }
  })
})

/**
 * ═══════ ТОТ ЖЕ ЗАЗОР, ЧТО У НАВЫКОВ, ТОЛЬКО ЭКРАНОМ ЛЕВЕЕ ═══════
 *
 * Каталог агентов выбирался гонкой: первый существующий из трёх и побеждал. Значит проект,
 * у которого есть хоть какой-нибудь `.claude/agents/`, прятал ВЕСЬ рой машины, а проект без
 * него — показывал рой машины и терял связь с деревом. Владелец 27.08: «нужно посадить рой на
 * машину, а не на проект». Ниже — форма, уже сделанная для навыков: два хранилища, названный
 * источник, объяснённая пустота, и провод, а не наличие файла.
 */
describe('the agents of the PROJECT and the agents of the MACHINE', () => {
  const bothStores = ({ project = ['sma-planner.md'], machine = ['sma-scout.md'] } = {}) =>
    fakeFs({
      files: {
        '/repo/.claude/agents/sma-planner.md': STOCK_PLANNER,
        '/repo/.claude/sma-core/agents/sma-planner.md': STOCK_PLANNER,
        '/machine/agents/sma-scout.md': STOCK_SCOUT,
        '/machine/sma-core/agents/sma-scout.md': STOCK_SCOUT,
        '/machine/agents/sma-planner.md': STOCK_PLANNER_EDITED,
      },
      dirs: {
        '/repo/.claude/agents': project,
        '/repo/.claude/sma-core/agents': ['sma-planner.md'],
        '/machine/agents': machine,
        '/machine/sma-core/agents': ['sma-scout.md'],
        '/repo/.claude/skills': [],
      },
    })

  const machineEnv = { SMA_DAEMON_AGENTS: '/machine/agents' }

  it('a MACHINE-store agent is on the roster under ANY active project — including one that already has its own agents directory', () => {
    const { fs } = bothStores()
    const team = readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: machineEnv, homedir: NO_HOME })
    // BOTH, not «whichever directory existed first» — that race is the whole defect.
    expect(team.map((e: any) => e.id)).toEqual(['sma-planner', 'sma-scout'])
    expect(team.find((e: any) => e.id === 'sma-planner').source).toBe('project')
    expect(team.find((e: any) => e.id === 'sma-scout').source).toBe('machine')
    // and the machine agent is a full card, not a stub: shipped, unforked, with its tools read
    expect(team.find((e: any) => e.id === 'sma-scout')).toMatchObject({
      origin: 'sma',
      forked: false,
      tools: ['Read', 'Grep'],
    })
  })

  it('a project with NO agents directory of its own still sees the whole machine swarm', () => {
    const { fs } = fakeFs({
      files: { '/machine/agents/sma-scout.md': STOCK_SCOUT },
      dirs: { '/machine/agents': ['sma-scout.md'] },
    })
    const team = readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: machineEnv, homedir: NO_HOME })
    expect(team.map((e: any) => e.id)).toEqual(['sma-scout'])
    expect(team[0].source).toBe('machine')
  })

  it('an id in BOTH stores is ONE card — the project copy wins and the shadowed twin is NAMED', () => {
    const { fs } = bothStores({ machine: ['sma-scout.md', 'sma-planner.md'] })
    const team = readStockTeam({ config: { workers: [] }, repoDir: '/repo', fsImpl: fs, env: machineEnv, homedir: NO_HOME })
    expect(team.map((e: any) => e.id)).toEqual(['sma-planner', 'sma-scout'])
    const planner = team.find((e: any) => e.id === 'sma-planner')
    expect(planner.source).toBe('project')
    // the project copy is the pristine one, so the machine's edited twin must not make it forked
    expect(planner.forked).toBe(false)
    // the wording is the skills screen's, word for word — one shadowing sentence, not two
    expect(planner.problem).toContain('machine')
    expect(planner.problem).toContain('project')
  })

  it('the payload says WHERE it looked — both stores, their paths, and whether each exists', async () => {
    const { fs } = bothStores()
    const out = await readHarness({
      config: { workers: [] },
      registry: { servers: [] },
      adapter: { list: async () => [] },
      repoDir: '/repo',
      fsImpl: fs,
      env: machineEnv,
      homedir: NO_HOME,
    })
    expect(out.agentStores).toEqual([
      { source: 'project', path: join('/repo', '.claude', 'agents'), present: true, count: 1 },
      { source: 'machine', path: '/machine/agents', present: true, count: 1 },
    ])
  })

  it('an absent store is reported as absent rather than passed over in silence', async () => {
    const { fs } = fakeFs({
      files: { '/machine/agents/sma-scout.md': STOCK_SCOUT },
      dirs: { '/machine/agents': ['sma-scout.md'] },
    })
    const out = await readHarness({
      config: { workers: [] },
      registry: { servers: [] },
      adapter: { list: async () => [] },
      repoDir: '/repo',
      fsImpl: fs,
      env: machineEnv,
      homedir: NO_HOME,
    })
    expect(out.agentStores.map((s: any) => [s.source, s.present, s.count])).toEqual([
      ['project', false, 0],
      ['machine', true, 1],
    ])
  })

  it('resolveMachineAgentsDir: the override wins, then CLAUDE_CONFIG_DIR, then the home — the skills order exactly', () => {
    expect(resolveMachineAgentsDir({ env: { SMA_DAEMON_AGENTS: '/tmp/swarm' }, homedir: NO_HOME })).toBe('/tmp/swarm')
    expect(resolveMachineAgentsDir({ env: { CLAUDE_CONFIG_DIR: '/opt/cfg' }, homedir: NO_HOME })).toBe(
      join('/opt/cfg', 'agents'),
    )
    expect(resolveMachineAgentsDir({ env: {}, homedir: NO_HOME })).toBe(join('/home/nobody', '.claude', 'agents'))
    // and the override still wins when both are set
    expect(
      resolveMachineAgentsDir({ env: { SMA_DAEMON_AGENTS: '/tmp/swarm', CLAUDE_CONFIG_DIR: '/opt/cfg' }, homedir: NO_HOME }),
    ).toBe('/tmp/swarm')
  })

  it('the toggle builds a profile from a MACHINE definition, and records NO repo-relative roleFile for it', () => {
    const { fs, lastWritten } = bothStores()
    const config = {
      workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true }],
    }
    const next = applyAgentToggle({
      config,
      id: 'sma-scout',
      enabled: true,
      repoDir: '/repo',
      launchDir: '/repo',
      fsImpl: fs,
      env: { ...machineEnv, SMA_DAEMON_CONFIG: '/cfg.json' },
      homedir: NO_HOME,
    })
    const scout = next.workers.find((w: any) => w.id === 'sma-scout')
    expect(scout).toMatchObject({ lane: 'research', provider: 'claude', enabled: true })
    // an out-of-tree path in this field would be a broken join downstream, so there is none
    expect(scout.roleFile).toBeUndefined()
    expect(lastWritten().workers.map((w: any) => w.id)).toEqual(['max-2', 'sma-scout'])
  })

  it('an id in NEITHER store is refused, and the refusal names both places it looked', () => {
    const { fs } = bothStores()
    expect(() =>
      applyAgentToggle({
        config: { workers: [{ id: 'max-2', provider: 'claude', account: { configDir: '/m2' } }] },
        id: 'nobody',
        enabled: true,
        repoDir: '/repo',
        launchDir: '/repo',
        fsImpl: fs,
        env: { ...machineEnv, SMA_DAEMON_CONFIG: '/cfg.json' },
        homedir: NO_HOME,
      }),
    ).toThrow(MissingDefinitionFileError)
    try {
      applyAgentToggle({
        config: { workers: [{ id: 'max-2', provider: 'claude', account: { configDir: '/m2' } }] },
        id: 'nobody',
        enabled: true,
        repoDir: '/repo',
        launchDir: '/repo',
        fsImpl: fs,
        env: { ...machineEnv, SMA_DAEMON_CONFIG: '/cfg.json' },
        homedir: NO_HOME,
      })
    } catch (err: any) {
      expect(err.message).toContain(join('/repo', '.claude', 'agents', 'nobody.md'))
      expect(err.message).toContain(join('/machine/agents', 'nobody.md'))
    }
  })

  it('the team switch activates SHIPPED definitions from BOTH stores, and never the machine twin of a project id', () => {
    // the project's `sma-planner` is the user's OWN here (no pristine beside it), so the switch
    // must leave that id alone entirely — not reach past it for the machine's shipped copy.
    const { fs } = fakeFs({
      files: {
        '/repo/.claude/agents/sma-planner.md': OWN_HELPER,
        '/machine/agents/sma-planner.md': STOCK_PLANNER,
        '/machine/sma-core/agents/sma-planner.md': STOCK_PLANNER,
        '/machine/agents/sma-scout.md': STOCK_SCOUT,
        '/machine/sma-core/agents/sma-scout.md': STOCK_SCOUT,
      },
      dirs: {
        '/repo/.claude/agents': ['sma-planner.md'],
        '/machine/agents': ['sma-planner.md', 'sma-scout.md'],
        '/machine/sma-core/agents': ['sma-planner.md', 'sma-scout.md'],
      },
    })
    const config = {
      workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true }],
    }
    const next = applyStockTeamToggle({
      config,
      enabled: true,
      repoDir: '/repo',
      launchDir: '/repo',
      fsImpl: fs,
      env: { ...machineEnv, SMA_DAEMON_CONFIG: '/cfg.json' },
      homedir: NO_HOME,
    })
    expect(next.workers.map((w: any) => w.id).sort()).toEqual(['max-2', 'sma-scout'])
    const scout = next.workers.find((w: any) => w.id === 'sma-scout')
    expect(scout.enabled).toBe(true)
    expect(typeof scout.stockDigest).toBe('string')
  })
})

/**
 * ПРОВОД, А НЕ НАЛИЧИЕ ФАЙЛА. Карточка, которая только показывает агента, ничего не доказывает:
 * до 27.08 работник из хранилища машины не имел поля `roleFile` (его и негде взять — путь
 * раскрывается относительно репозитория), а роль выдавалась ТОЛЬКО по этому полю. Значит экран
 * говорил «включён», а сессия не получала ни строки роли. Здесь проверяется именно стык.
 */
describe('resolveWorkerContext — роль агента МАШИНЫ доезжает до работника', () => {
  const machineFs = () =>
    fakeFs({
      files: { '/machine/agents/sma-scout.md': STOCK_SCOUT },
      dirs: { '/machine/agents': ['sma-scout.md'] },
    }).fs

  it('a worker with NO roleFile gets its role looked up BY ID in the machine store', () => {
    const ctx = resolveWorkerContext({
      worker: { id: 'sma-scout', skills: [] },
      repoDir: '/repo',
      fsImpl: machineFs(),
      env: { SMA_DAEMON_AGENTS: '/machine/agents' },
      homedir: NO_HOME,
    })
    expect(ctx.rolePreamble).toContain('Тело определения разведчика')
    // the store is NAMED, so the caller can say where the role came from instead of assuming
    expect(ctx.roleSource).toBe('machine')
    expect(ctx.roleRef).toBe(join('/machine/agents', 'sma-scout.md'))
  })

  it('a PIN that does not resolve stays unresolved — no other file is quietly loaded for it', () => {
    // roleFile names a file that is not there; the id `sma-scout` IS there in the machine store.
    // Substituting it would hand the worker a role nobody pinned.
    const ctx = resolveWorkerContext({
      worker: { id: 'sma-scout', roleFile: '.claude/agents/gone.md', skills: [] },
      repoDir: '/repo',
      fsImpl: machineFs(),
      env: { SMA_DAEMON_AGENTS: '/machine/agents' },
      homedir: NO_HOME,
    })
    expect(ctx.rolePreamble).toBeUndefined()
    expect(ctx.roleSource).toBeUndefined()
  })

  it('a project definition still wins over a machine twin of the same id', () => {
    const { fs } = fakeFs({
      files: {
        '/repo/.claude/agents/sma-scout.md': STOCK_PLANNER,
        '/machine/agents/sma-scout.md': STOCK_SCOUT,
      },
      dirs: { '/repo/.claude/agents': ['sma-scout.md'], '/machine/agents': ['sma-scout.md'] },
    })
    const ctx = resolveWorkerContext({
      worker: { id: 'sma-scout', skills: [] },
      repoDir: '/repo',
      fsImpl: fs,
      env: { SMA_DAEMON_AGENTS: '/machine/agents' },
      homedir: NO_HOME,
    })
    expect(ctx.roleSource).toBe('project')
    expect(ctx.rolePreamble).toContain('Тело определения планировщика')
  })
})

describe('readHarness — the stockTeam key is ADDITIVE (modules 8/9/12 keep their shape)', () => {
  it('adds stockTeam as an array and leaves agents / skills / mcp / drafts unchanged in shape', async () => {
    const { fs } = localInstall()
    const config = {
      workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: false }],
    }
    const out = await readHarness({
      config,
      registry: { servers: [] },
      adapter: { list: async () => [] },
      repoDir: '/repo',
      fsImpl: fs,
      env: {},
      homedir: NO_HOME,
    })
    // `telegram` joined the payload the same way `stockTeam` did — ADDITIVELY: the keys above
    // keep their shape byte for byte, and the new one is the state of the owner's own bot.
    // A daemon nobody connected one to still gets the key, reading 'off'.
    // `skillStores` joined by the SAME rule: the two directories the skills walk actually
    // looked in, so an empty skills list can name them instead of saying nothing.
    // `agentStores` is that key one screen over — the agents walk had the identical hole.
    expect(Object.keys(out).sort()).toEqual(
      ['agentStores', 'agents', 'drafts', 'mcp', 'skillStores', 'skills', 'stockTeam', 'telegram'].sort(),
    )
    expect(out.telegram).toMatchObject({ status: 'off', tokenTail: null, code: null, chat: null })
    expect(Array.isArray(out.stockTeam)).toBe(true)
    expect(out.stockTeam.map((e: any) => e.id).sort()).toEqual(['sma-planner', 'sma-verifier'])
    // the four existing keys keep their shape exactly
    expect(out.agents).toHaveLength(1)
    expect(out.agents[0]).toMatchObject({ id: 'max-2', lane: 'prod', provider: 'claude', enabled: false, can: [], cannot: [] })
    expect(out.skills).toEqual([])
    expect(out.mcp).toEqual([])
    expect(out.drafts).toEqual([])
  })
})

describe('applyStockTeamToggle — one act, through the door that already exists', () => {
  const baseConfig = () => ({
    workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2', oauthTokenEnv: 'T' }, enabled: true }],
  })
  const toggleEnv = { SMA_DAEMON_CONFIG: '/cfg.json' }

  it('switching on activates the SHIPPED roster from the files, records a stock baseline per agent, and leaves the user’s own agents alone', () => {
    const { fs, lastWritten } = localInstall({
      extraFiles: { '.claude/agents/my-helper.md': OWN_HELPER },
      extraAgents: ['my-helper.md'],
    })
    const next = applyStockTeamToggle({ config: baseConfig(), enabled: true, repoDir: '/repo', fsImpl: fs, env: toggleEnv, homedir: NO_HOME })

    const planner = next.workers.find((w: any) => w.id === 'sma-planner')
    expect(planner).toBeTruthy()
    expect(planner.enabled).toBe(true)
    expect(planner.roleFile).toBe('.claude/agents/sma-planner.md')
    expect(planner.account).toEqual({ configDir: '/m2', oauthTokenEnv: 'T' }) // inherited pool default
    expect(typeof planner.stockDigest).toBe('string')
    expect(planner.stockDigest.length).toBe(64) // sha256 hex
    // a switch labelled «the SMA team» never sweeps up the user's own agent
    expect(next.workers.find((w: any) => w.id === 'my-helper')).toBeUndefined()
    // and it was written atomically, not just returned
    expect(lastWritten().workers.map((w: any) => w.id).sort()).toEqual(['max-2', 'sma-planner', 'sma-verifier'])

    // the baseline is readable back by readStockTeam: today's shipped copy IS what was accepted
    const team = readStockTeam({ config: next, repoDir: '/repo', fsImpl: fs, env: {}, homedir: NO_HOME })
    expect(team.find((e: any) => e.id === 'sma-planner')).toMatchObject({ enabled: true, stockUpdate: 'current', forked: false })
    expect(team.find((e: any) => e.id === 'my-helper')).toMatchObject({ enabled: false, origin: 'yours' })
  })

  it('switching off flips enabled and keeps the recorded baseline — what was last accepted does not change because a switch moved', () => {
    const { fs } = localInstall()
    const on = applyStockTeamToggle({ config: baseConfig(), enabled: true, repoDir: '/repo', fsImpl: fs, env: toggleEnv, homedir: NO_HOME })
    const digest = on.workers.find((w: any) => w.id === 'sma-planner').stockDigest
    const off = applyStockTeamToggle({ config: on, enabled: false, repoDir: '/repo', fsImpl: fs, env: toggleEnv, homedir: NO_HOME })
    const planner = off.workers.find((w: any) => w.id === 'sma-planner')
    expect(planner.enabled).toBe(false)
    expect(planner.stockDigest).toBe(digest)
    // switching off adds nobody
    expect(off.workers).toHaveLength(on.workers.length)
  })

  it('with no definition files on disk it returns the EXISTING refusal and writes no config (two-step activation)', () => {
    const { fs, writes } = fakeFs({})
    expect(() =>
      applyStockTeamToggle({ config: baseConfig(), enabled: true, repoDir: '/repo', fsImpl: fs, env: toggleEnv, homedir: NO_HOME }),
    ).toThrow(MissingDefinitionFileError)
    expect(writes).toHaveLength(0)
  })

  it('a forked definition still activates, and readStockTeam keeps saying it is forked', () => {
    const { fs } = localInstall({ planner: STOCK_PLANNER_EDITED })
    const next = applyStockTeamToggle({ config: baseConfig(), enabled: true, repoDir: '/repo', fsImpl: fs, env: toggleEnv, homedir: NO_HOME })
    const team = readStockTeam({ config: next, repoDir: '/repo', fsImpl: fs, env: {}, homedir: NO_HOME })
    expect(team.find((e: any) => e.id === 'sma-planner')).toMatchObject({ enabled: true, forked: true, stockUpdate: 'current' })
  })
})

// ── the door: the reserved target rides POST /api/agent/toggle, the table does not grow ──

const TOKEN = 'a'.repeat(64)

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body } = o
  const req: any = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code: number) { res.statusCode = code; res.headersSent = true; return res },
    setHeader() {},
    getHeader() { return undefined },
    write(c: any) { res.body += String(c); return true },
    end(c?: any) { if (c != null) res.body += String(c); return res },
  }
  return res
}

async function call(front: any, opts: any) {
  const res = mkRes()
  await front.handle(mkReq(opts), res)
  return res
}

describe('POST /api/agent/toggle — the stock team rides the EXISTING door (no route added)', () => {
  it('the route table carries no stock-team route (the reserved target rides the agent door)', () => {
    // V5.4 freeze (53) + chat/stop + redirect + the batch request + the word answering a stopped
    // batch + the two doors of a task's words (proposed by the system, corrected by its owner)
    // + the composition a phrase could have (proposed too — and putting it in is another door)
    // + the order that stops ONE echelon of ONE phase and starts it again
    // + the door a person cancels a task through
    // + the door that reads the folder of one phase (its tree, and one file of it as text)
    // + the door that WRITES a skill into this machine's store.
    // The size itself is pinned once, in front-auth.test.ts — repeating the number here made
    // an unrelated door's arrival look like a stock-team regression. What this case is about
    // is the ABSENCE of a stock-team route, and that is what it now says.
    expect(Object.keys(ROUTES).filter((k) => /stock/i.test(k))).toEqual([])
  })

  it('the reserved target is the same literal on both sides of the seam', () => {
    expect(SERVER_STOCK_TEAM_TARGET).toBe(STOCK_TEAM_TARGET)
  })

  it('the reserved target dispatches to the stock applier and emits the harness.updated hint', async () => {
    const seen: any[] = []
    const calls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN, workers: [] },
      deps: {
        applyAgentToggle: () => { throw new Error('the single-agent applier must not be reached for the team target') },
        applyStockTeamToggle: (args: any) => { calls.push(args); return { workers: [{ id: 'sma-planner', enabled: true, stockDigest: 'x' }] } },
        hub: { emit: (e: any) => seen.push(e) },
      },
    })
    const res = await call(front, { method: 'POST', url: '/api/agent/toggle', body: { id: STOCK_TEAM_TARGET, enabled: true } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, stockTeam: { enabled: true, agents: 1 } })
    expect(calls[0]).toMatchObject({ enabled: true })
    expect(seen).toContainEqual({ event: 'harness.updated' })
  })

  it('a single agent id still reaches the single-agent applier — the door did not change meaning', async () => {
    const calls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN, workers: [] },
      deps: {
        applyAgentToggle: (args: any) => { calls.push(args); return { workers: [{ id: 'max-2', enabled: false }] } },
        applyStockTeamToggle: () => { throw new Error('the team applier must not be reached for a single id') },
      },
    })
    const res = await call(front, { method: 'POST', url: '/api/agent/toggle', body: { id: 'max-2', enabled: false } })
    expect(res.statusCode).toBe(200)
    expect(calls[0]).toMatchObject({ id: 'max-2', enabled: false })
  })

  it('the refusal maps the same way it always did: nothing installed → 404, not a silent success', async () => {
    const front = createFrontServer({
      config: { token: TOKEN, workers: [] },
      deps: {
        applyAgentToggle: () => ({ workers: [] }),
        applyStockTeamToggle: () => { throw new MissingDefinitionFileError('no installed SMA definitions') },
      },
    })
    const res = await call(front, { method: 'POST', url: '/api/agent/toggle', body: { id: STOCK_TEAM_TARGET, enabled: true } })
    expect(res.statusCode).toBe(404)
  })
})

describe('buildClaudeArgs mcpConfigPath + buildMcpConfigFile — enabled entries only reach a spawn', () => {
  it('mcpConfigPath appends --mcp-config BEFORE --add-dir (addDir stays last)', () => {
    const args = buildClaudeArgs({ mcpConfigPath: '/wt/task-1/mcp-config.json', addDir: '/wt/task-1' })
    expect(args).toContain('--mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/wt/task-1/mcp-config.json')
    expect(args.slice(-2)).toEqual(['--add-dir', '/wt/task-1']) // addDir still last
  })

  it('buildMcpConfigFile writes ONLY enabled entries into the task dir and returns the path', () => {
    const { fs, lastWritten } = fakeFs({})
    const servers = [
      { id: 'twitter', command: 'npx', args: ['twitter-mcp'], envNames: ['TWITTER_TOKEN'], enabled: true },
      { id: 'disabled-one', command: 'npx', args: ['x'], enabled: false },
    ]
    const path = buildMcpConfigFile({ servers, taskDir: '/wt/task-1', fsImpl: fs })
    expect(path.replace(/\\/g, '/')).toBe('/wt/task-1/mcp-config.json')
    const written = lastWritten()
    expect(Object.keys(written.mcpServers)).toEqual(['twitter']) // the disabled entry never reaches a spawn
    // the registry's env NAMES stay with the daemon: the file carries what to run, nothing else
    expect(written.mcpServers.twitter).toEqual({ type: 'stdio', command: 'npx', args: ['twitter-mcp'] })
    expect(JSON.stringify(written)).not.toContain('TWITTER_TOKEN')
  })
})

/**
 * THE WIRE, ON A REAL DISK.
 *
 * Every case above runs against a fake fs, which is right for the rules and useless for the
 * one question this feature is judged by: does pressing the button leave a FILE. So this one
 * uses the real door, the real applier and a real temporary directory, and it does not believe
 * the 201 — it opens the disk, reads the bytes back, and then asks the read model whether the
 * new skill is on the screen. A door that answers ok and writes nothing is exactly the failure
 * this suite is here to make impossible.
 */
describe('POST /api/skill/create → a file on the disk → a card in the window (the wire)', () => {
  it('writes SKILL.md, and the harness read model then shows it as a machine-store skill', async () => {
    const store = mkdtempSync(join(tmpdir(), 'sma-skills-'))
    try {
      const env = { SMA_DAEMON_SKILLS: store }
      const front = createFrontServer({
        config: { token: TOKEN, workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true }] },
        deps: { createMachineSkill, readHarness, env, repoDir: join(store, 'no-such-project') },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/skill/create',
        body: { id: 'release-notes', description: 'Как собрать заметки к релизу.', body: 'Шаг один: прочитать журнал.' },
      })
      expect(res.statusCode).toBe(201)
      const answered = JSON.parse(res.body).skill

      // (1) THE DISK — not the status code.
      const onDisk = readFileSync(join(store, 'release-notes', 'SKILL.md'), 'utf8')
      expect(onDisk).toContain('name: release-notes')
      expect(onDisk).toContain('Шаг один: прочитать журнал.')
      expect(answered.path.replace(/\\/g, '/')).toBe(join(store, 'release-notes', 'SKILL.md').replace(/\\/g, '/'))

      // (2) AND THE WINDOW — under a project whose tree has no skills directory at all.
      const harness = await call(front, { method: 'GET', url: '/api/harness' })
      expect(harness.statusCode).toBe(200)
      const payload = JSON.parse(harness.body)
      const card = payload.skills.find((s: any) => s.id === 'release-notes')
      expect(card).toMatchObject({ source: 'machine', description: 'Как собрать заметки к релизу.' })

      // (3) AND IT CAN BE GIVEN AWAY — the card's one button reaches a real applier.
      const cfg = { workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true }] }
      const writes: Array<{ path: string; content: string }> = []
      const recorder = {
        existsSync: () => false,
        readFileSync: (p: string) => readFileSync(p, 'utf8'),
        readdirSync: (p: string) => readdirSync(p).map(String),
        mkdirSync: () => {},
        writeFileSync: (p: string, c: string) => writes.push({ path: String(p), content: String(c) }),
        renameSync: () => {},
      }
      const next = applySkillAssign({
        config: cfg,
        skillId: 'release-notes',
        workerIds: ['max-2'],
        repoDir: join(store, 'no-such-project'),
        fsImpl: recorder,
        env: { ...env, SMA_DAEMON_CONFIG: join(store, 'cfg.json') },
      })
      expect(next.workers[0].skills).toEqual(['release-notes'])

      // (4) AND THE ASSIGNMENT REACHES THE LAUNCH: the skill's own text is in what the worker
      //     is started with, not merely in a config field somebody could read later.
      const ctx = resolveWorkerContext({ worker: next.workers[0], repoDir: join(store, 'no-such-project'), fsImpl: recorder, env })
      expect(ctx.skillsPreamble).toContain('Шаг один: прочитать журнал.')
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('the same id twice is a 409 and the file on disk is untouched', async () => {
    const store = mkdtempSync(join(tmpdir(), 'sma-skills-'))
    try {
      const front = createFrontServer({
        config: { token: TOKEN, workers: [] },
        deps: { createMachineSkill, env: { SMA_DAEMON_SKILLS: store } },
      })
      const body = { id: 'once', description: 'первый', body: 'первое тело' }
      expect((await call(front, { method: 'POST', url: '/api/skill/create', body })).statusCode).toBe(201)
      const again = await call(front, {
        method: 'POST',
        url: '/api/skill/create',
        body: { id: 'once', description: 'второй', body: 'второе тело' },
      })
      expect(again.statusCode).toBe(409)
      expect(readFileSync(join(store, 'once', 'SKILL.md'), 'utf8')).toContain('первое тело')
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('a key nobody declared is refused before the applier is reached', async () => {
    let reached = false
    const front = createFrontServer({
      config: { token: TOKEN, workers: [] },
      deps: { createMachineSkill: () => { reached = true; return { id: 'x', source: 'machine', path: '/x' } } },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/skill/create',
      body: { id: 'x', description: 'd', body: 'b', path: '/etc/passwd' },
    })
    expect(res.statusCode).toBe(400)
    expect(reached).toBe(false)
  })
})
