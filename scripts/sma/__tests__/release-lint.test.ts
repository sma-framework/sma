/**
 * Tests for scripts/sma/lib/release-lint.mjs — the predictions-lint leg of the
 * release ritual. The leg is spawned exactly as prepublishOnly runs it; the
 * three postures under test: a SAID skip when no tree is configured, a hard
 * refusal when a configured tree is missing (a broken promise, not a consumer
 * state), and the verb's own verdict when a tree is there — a red plan stops
 * the publish.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LEG = join(__dirname, '..', 'lib', 'release-lint.mjs')

function runLeg(env: Record<string, string>) {
  const e: Record<string, string | undefined> = { ...process.env }
  // The runner's own environment must not leak a configured tree into the cases.
  delete e.SMA_LINT_PLANS_DIR
  delete e.SMA_RELEASE_LINT_CONFIG
  Object.assign(e, env)
  return spawnSync(process.execPath, [LEG], { encoding: 'utf8', env: e as NodeJS.ProcessEnv })
}

const SELFTEST_PLAN =
  '---\n' +
  'phase: test\n' +
  'plan: 01\n' +
  'predictions:\n' +
  '  - id: P1\n' +
  '    claim: "x"\n' +
  '    metric: exit_code\n' +
  '    check_command: "node scripts/sma/cli.mjs batch --selftest-riskfilter"\n' +
  '    comparator: "=="\n' +
  '    threshold: 1\n' +
  '    horizon: "plan close"\n' +
  '    domain: tech.memory\n' +
  '---\n' +
  '\n' +
  '<objective>x</objective>\n'

describe('release-lint — нога предсказаний в ритуале выпуска', () => {
  it('без настроенного дерева планов: СКАЗАННЫЙ пропуск, код 0', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-relint-skip-'))
    try {
      const res = runLeg({ SMA_RELEASE_LINT_CONFIG: join(tmp, 'no-such-config.json') })
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('skipped')
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('настроенное дерево отсутствует: отказ, код 1 — обещание сломано, а не пропущено', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-relint-ghost-'))
    try {
      const res = runLeg({ SMA_LINT_PLANS_DIR: join(tmp, 'ghost') })
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('does not exist')
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('дерево с открытым планом-самопроверкой: вердикт глагола, код не 0 — публикация стоит', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sma-relint-red-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmp })
      writeFileSync(join(tmp, 'beta-01-PLAN.md'), SELFTEST_PLAN)
      execFileSync('git', ['add', '.'], { cwd: tmp })
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'open plan'], { cwd: tmp })
      const res = runLeg({ SMA_LINT_PLANS_DIR: tmp })
      expect(res.status).not.toBe(0)
      expect(res.stdout + res.stderr).toContain('PRED-SELFTEST')
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
