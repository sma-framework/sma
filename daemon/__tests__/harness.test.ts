/**
 * harness.test.ts — the harness read model + two-step activation appliers + the MCP seam
 * (Phase 9.5 Plan 11, Task 2; D-9.5-09).
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
 * Phase 11 Plan 06 (SB-031 part 1) appends the STOCK TEAM cases:
 *   - readStockTeam: the whole installed roster (including definitions the roster config never
 *     heard of), fork state by CONTENT DIGEST against the pristine engine copy, the user's own
 *     agents, a named problem instead of a drop or a throw, an absent directory → [], both
 *     install layouts (project-local and the global config dir), and no body / no absolute path;
 *   - applyStockTeamToggle: one act enables the shipped roster through the EXISTING toggle door,
 *     recording each activated definition's pristine digest as the baseline readStockTeam reads
 *     back — with the route table still frozen at thirty.
 */

import { describe, it, expect } from 'vitest'

import {
  loadMcpRegistry,
  readHarness,
  readStockTeam,
  applyAgentToggle,
  applySkillAssign,
  applyMcpToggle,
  resolveWorkerContext,
  MissingDefinitionFileError,
  UnknownProfileError,
  UnknownSkillError,
  InvalidMcpRegistryError,
  UnknownMcpServerError,
} from '../src/front/harness.mjs'
import { buildClaudeArgs, buildMcpConfigFile } from '../src/runner/args.mjs'

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

  it('joins agent profile + roleFile can/cannot; exposes enabled per profile', async () => {
    const { fs } = fakeFs({ files: { '.claude/agents/creator.md': ROLE_CREATOR }, dirs: { '.claude/skills': [] } })
    const out = await readHarness({ config, registry, adapter, repoDir: '/repo', fsImpl: fs, env: {} })
    const creator = out.agents.find((a: any) => a.id === 'creator')
    expect(creator.title).toBe('Создатель')
    expect(creator.can).toContain('собирать черновики определений')
    expect(creator.cannot).toContain('пушить в main')
    expect(out.agents.find((a: any) => a.id === 'max-2').enabled).toBe(false)
  })

  it('MCP cards carry env-var NAMES with [set]/[unset] — never the value', async () => {
    const { fs } = fakeFs({ dirs: { '.claude/skills': [] } })
    const out = await readHarness({ config, registry, adapter, repoDir: '/repo', fsImpl: fs, env: { TWITTER_TOKEN: 'secret-value' } })
    const card = out.mcp[0]
    expect(card.envStatus).toEqual({ TWITTER_TOKEN: '[set]', MISSING_TOKEN: '[unset]' })
    // the secret value never appears anywhere in the payload
    expect(JSON.stringify(out)).not.toContain('secret-value')
  })

  it('skills scan the tree + per-profile assignment; drafts come from the awaiting-approval forge tasks', async () => {
    const { fs } = fakeFs({
      files: { '.claude/agents/creator.md': ROLE_CREATOR, '.claude/skills/twitter-digest/SKILL.md': SKILL_DIGEST },
      dirs: { '.claude/skills': ['twitter-digest'] },
    })
    const out = await readHarness({ config, registry, adapter, repoDir: '/repo', fsImpl: fs, env: {} })
    const skill = out.skills.find((s: any) => s.id === 'twitter-digest')
    expect(skill.title).toBe('twitter-digest')
    expect(skill.assignedTo).toEqual(['creator'])
    // only the forge task surfaces as a draft, with its kind + path
    expect(out.drafts).toHaveLength(1)
    expect(out.drafts[0]).toMatchObject({ id: 'F-1', kind: 'agent', draftPath: '.claude/agents/twitter-parser.md' })
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
  })
})

// ── the MCP → spawn seam (args.mjs) ──

// ── the stock team (Phase 11 Plan 06) ──

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

/** No frontmatter fence at all — must be reported, never dropped and never thrown on. */
const BROKEN_DEF = 'просто текст без рамки\nвторая строка\n'

/** A project-local install: <repo>/.claude/agents (editable) + <repo>/.claude/sma-core/agents (pristine). */
function localInstall({
  planner = STOCK_PLANNER,
  extraFiles = {},
  extraAgents = [],
}: { planner?: string; extraFiles?: Record<string, string>; extraAgents?: string[] } = {}) {
  return fakeFs({
    files: {
      '.claude/agents/sma-planner.md': planner,
      '.claude/agents/sma-verifier.md': STOCK_VERIFIER,
      '.claude/sma-core/agents/sma-planner.md': STOCK_PLANNER,
      '.claude/sma-core/agents/sma-verifier.md': STOCK_VERIFIER,
      ...extraFiles,
    },
    dirs: {
      '.claude/agents': ['sma-planner.md', 'sma-verifier.md', ...extraAgents],
      '.claude/sma-core/agents': ['sma-planner.md', 'sma-verifier.md'],
      '.claude/skills': [],
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
        ['description', 'enabled', 'forked', 'id', 'origin', 'problem', 'stockUpdate', 'title', 'tools'].sort(),
      )
    }
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
    expect(Object.keys(out).sort()).toEqual(['agents', 'drafts', 'mcp', 'skills', 'stockTeam'].sort())
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
    expect(written.mcpServers.twitter).toEqual({ command: 'npx', args: ['twitter-mcp'], envNames: ['TWITTER_TOKEN'] })
  })
})
