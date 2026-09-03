/**
 * The provider on an attempt row must be the provider selected by routing.
 *
 * This drives the real tick, queue, router, command composer, ledger writer and
 * ledger reader. Only the external command/process edges and observation sinks
 * are replaced. The task explicitly asks for codex while the lane default is
 * claude, so a row populated from a default cannot satisfy the assertion.
 */

import { afterAll, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { createAttemptLogWriter, readAttempts, recordAttempt } from '../src/queue/attempt-ledger.mjs'
import { createBuildArgs } from '../src/runner/build-args.mjs'

const roots: string[] = []
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'sma-attempt-provider-codex-'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

const TASK_ID = 'attempt-provider-wire'
const NOTE = 'APPROACH_NOTE: exercise the provider wire end to end'
const LESSON = 'LESSON_NONE: fixture worker has no durable lesson'
const CODEX_FINAL = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 21, output_tokens: 8, cached_input_tokens: 3 },
})

const clock = () => 1_700_000_000_000

const makeVerbRunner = (workDir: string) => async (_bin: string, args: string[]) => {
  const verb = args[1]
  if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
  if (verb === 'worktree') {
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        path: workDir,
        branch: `wt/${TASK_ID}`,
        materialized: [{ path: 'CLAUDE.md', mode: 'copy', files: 1, tracked: 0, current: 0, bytes: 12 }],
      }),
    }
  }
  if (verb === 'reverify') {
    return {
      code: 0,
      stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:provider-wire', diffStat: '+1 -0' }),
    }
  }
  return { code: 0, stdout: '{}' }
}

const runGit = (args: string[]) => {
  if (args[0] === 'rev-parse') return 'base0000'
  if (args[0] === 'rev-list') return '1'
  if (args[0] === 'diff') return 'M\tproduct.txt'
  return ''
}

it('writes codex from the selected route to the attempt row on disk, not the claude lane default', async () => {
  const root = makeRoot()
  const projectDir = join(root, 'project')
  const ledgerDir = join(root, 'ledger')
  const workDir = join(root, 'copy')
  const accountDir = join(root, 'codex-account')
  const emptyHome = join(root, 'empty-home')
  for (const dir of [projectDir, ledgerDir, workDir, accountDir, emptyHome]) mkdirSync(dir, { recursive: true })

  writeFileSync(join(workDir, 'CLAUDE.md'), '# rules\n', 'utf8')
  writeFileSync(join(accountDir, 'settings.json'), JSON.stringify({ disableClaudeAiConnectors: true }), 'utf8')
  writeFileSync(join(accountDir, 'auth.json'), JSON.stringify({ tokens: { id_token: 'subscription' } }), 'utf8')

  const workers = [
    {
      id: 'default-worker',
      lane: 'prod',
      provider: 'claude',
      enabled: true,
      account: { name: 'default-account', configDir: join(root, 'default-account') },
    },
    {
      id: 'codex-worker',
      lane: 'prod',
      provider: 'codex',
      enabled: true,
      account: { name: 'codex-account', configDir: accountDir },
    },
  ]
  const config = {
    workers,
    laneRouting: { prod: { provider: 'claude' } },
    agingHours: 24,
    backlogScanMinutes: 60,
    repoDir: projectDir,
    pipeline: { enabled: true },
  }

  const queue = createMemoryQueue({ clock, expireMs: 300_000 })
  await queue.enqueue({
    id: TASK_ID,
    source: 'backlog',
    title: 'record the provider that actually ran',
    lane: 'prod',
    provider: 'codex',
    priority: 0,
    storyPoints: 1,
    acceptance: 'the on-disk attempt row names the routed provider',
  })

  const routedSpawns: Record<string, unknown>[] = []
  const spawns: Record<string, unknown>[] = []
  const composeSpawn = createBuildArgs({
    config,
    env: { PATH: '/usr/bin', HOME: emptyHome, USERPROFILE: emptyHome },
    platform: 'linux',
  })

  const result = await tick({
    adapter: queue,
    ledger: {
      recordAttempt: (row: Record<string, unknown>) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: { attemptId: string }) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config,
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    platform: 'linux',
    buildArgs: (task: object, route: Record<string, unknown>, options?: object) => {
      routedSpawns.push(route)
      return composeSpawn(task, route, options)
    },
    verbRunner: makeVerbRunner(workDir),
    spawnWorker: (spec: Record<string, unknown> & { onLine?: (line: string) => void; onExit?: (exit: object) => void }) => {
      spawns.push(spec)
      for (const line of [CODEX_FINAL, NOTE, LESSON]) spec.onLine?.(line)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    bookUsage: () => {},
    report: async () => {},
    journal: () => {},
    clock,
    execGit: runGit,
  })

  expect(result.completed).toBe(TASK_ID)
  expect(routedSpawns).toHaveLength(1)
  expect(routedSpawns[0]).toMatchObject({ workerId: 'codex-worker', provider: 'codex', reasonCode: 'per_task_override' })
  expect(spawns).toHaveLength(1)
  expect(spawns[0]).toMatchObject({ bin: 'codex' })

  const rows = readAttempts(ledgerDir, TASK_ID)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ outcome: 'completed', provider: routedSpawns[0].provider })
  expect(rows[0].provider).toBe('codex')
  expect(rows[0].provider).not.toBe(config.laneRouting.prod.provider)
})
