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
 */

import { describe, it, expect } from 'vitest'

import {
  loadMcpRegistry,
  readHarness,
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
