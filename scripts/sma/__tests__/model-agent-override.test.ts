/**
 * Tests for the per-AGENT model override —
 * `model_profile_overrides.agents.<agent-name>` (sma-core/bin/lib/model-resolver.cjs
 * + the config-set key whitelist in sma-core/bin/shared/config-schema.manifest.json).
 *
 * The gap this closes: the model layer could express "how heavy is this KIND of
 * work" (a per-TIER profile) but not "this agent runs on this model". Forcing one
 * agent up meant moving the whole profile, dragging unrelated agents with it.
 *
 *   - Test 1: precedence — an agent pin beats the tier profile for that agent
 *     only; every other agent stays on the profile.
 *   - Test 2: no pin -> the profile answer, unchanged.
 *   - Test 3: an unknown/misspelled agent name is a NO-OP (fail-open to profile),
 *     never an error and never applied to another agent.
 *   - Test 4: the pre-existing `model_overrides.<agent>` still outranks the pin
 *     (no regression in the older mechanism).
 *   - Test 5: shapes — object form `{model: …}`, and empty/blank values ignored.
 *   - Test 6: `agents` is never read as a RUNTIME tier map, and a config that
 *     carries a pin emits no unknown-runtime / unknown-tier warning.
 *   - Test 7: config-set accepts the pin key path; malformed variants and an
 *     unknown key are still rejected.
 *   - Test 8: clearing a pin with the documented `null` spelling REMOVES the key
 *     instead of writing the string "null" (which resolved as a model named
 *     "null" — a pin you could set but not lift).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const modelResolver = require_('../../../sma-core/bin/lib/model-resolver.cjs')
const configSchema = require_('../../../sma-core/bin/lib/config-schema.cjs')

const SMA_TOOLS = fileURLToPath(new URL('../../../sma-core/bin/sma-tools.cjs', import.meta.url))

const { resolveModelInternal, resolveTierEntry, resolveAgentModelOverride } = modelResolver

let cwd: string

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(cwd, '.planning'), { recursive: true })
  writeFileSync(join(cwd, '.planning', 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

function readConfig(): Record<string, any> {
  return JSON.parse(readFileSync(join(cwd, '.planning', 'config.json'), 'utf8'))
}

/** Drive the real `query config-set` verb the docs tell users to run. */
function configSet(key: string, value: string): string {
  return execFileSync(process.execPath, [SMA_TOOLS, 'query', 'config-set', key, value, '--cwd', cwd], {
    encoding: 'utf8',
  })
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sma-agent-model-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('model_profile_overrides.agents.<agent-name>', () => {
  it('Test 1: an agent pin beats the tier profile for that agent only', () => {
    writeConfig({
      model_profile: 'balanced',
      model_profile_overrides: { agents: { 'sma-executor': 'opus' } },
    })

    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')
    // The verifier shares the balanced profile and is NOT pinned — it must not move.
    expect(resolveModelInternal(cwd, 'sma-verifier')).toBe('sonnet')
  })

  it('Test 2: without a pin the profile answer is unchanged', () => {
    writeConfig({ model_profile: 'balanced' })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('sonnet')

    writeConfig({ model_profile: 'budget' })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('sonnet')

    writeConfig({ model_profile: 'quality' })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')
  })

  it('Test 3: an unknown agent name is a no-op — resolution falls through to the profile', () => {
    writeConfig({
      model_profile: 'balanced',
      model_profile_overrides: { agents: { 'sma-exicutor': 'opus', 'not-an-agent': 'haiku' } },
    })

    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('sonnet')
    expect(resolveModelInternal(cwd, 'sma-verifier')).toBe('sonnet')
    // The pure reader agrees: no entry for this agent -> null, never a throw.
    expect(resolveAgentModelOverride({ agents: { 'sma-exicutor': 'opus' } }, 'sma-executor')).toBeNull()
  })

  it('Test 4: model_overrides.<agent> still outranks the pin', () => {
    writeConfig({
      model_profile: 'balanced',
      model_overrides: { 'sma-executor': 'haiku' },
      model_profile_overrides: { agents: { 'sma-executor': 'opus' } },
    })

    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('haiku')
  })

  it('Test 5: object form is accepted; blank and malformed values are ignored', () => {
    expect(resolveAgentModelOverride({ agents: { 'sma-executor': { model: 'opus' } } }, 'sma-executor')).toBe('opus')
    expect(resolveAgentModelOverride({ agents: { 'sma-executor': '  opus  ' } }, 'sma-executor')).toBe('opus')
    expect(resolveAgentModelOverride({ agents: { 'sma-executor': '' } }, 'sma-executor')).toBeNull()
    expect(resolveAgentModelOverride({ agents: { 'sma-executor': {} } }, 'sma-executor')).toBeNull()
    expect(resolveAgentModelOverride({ agents: null }, 'sma-executor')).toBeNull()
    expect(resolveAgentModelOverride(null, 'sma-executor')).toBeNull()
    expect(resolveAgentModelOverride({ agents: { 'sma-executor': 'opus' } }, '')).toBeNull()
  })

  it('Test 6: `agents` is never read as a runtime tier map and raises no warning', () => {
    const overrides = { agents: { 'sma-executor': 'opus' } }
    expect(resolveTierEntry({ runtime: 'agents', tier: 'opus', overrides })).toBeNull()

    const warnings: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = (chunk: string) => {
      warnings.push(String(chunk))
      return true
    }
    try {
      writeConfig({ model_profile: 'balanced', model_profile_overrides: overrides })
      expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stderr as any).write = realWrite
    }
    expect(warnings.join('')).not.toMatch(/unknown runtime|unknown tier/)
  })

  it('Test 7: config-set accepts the pin key path; malformed and unknown keys stay rejected', () => {
    expect(configSchema.isValidConfigKey('model_profile_overrides.agents.sma-executor')).toBe(true)
    expect(configSchema.isValidConfigKey('model_profile_overrides.agents.sma-plan-checker')).toBe(true)
    // The runtime namespace of the same object is untouched.
    expect(configSchema.isValidConfigKey('model_profile_overrides.gemini.opus')).toBe(true)
    // Malformed variants and an unrelated unknown key are still refused.
    expect(configSchema.isValidConfigKey('model_profile_overrides.agents')).toBe(false)
    expect(configSchema.isValidConfigKey('model_profile_overrides.agents.sma executor')).toBe(false)
    expect(configSchema.isValidConfigKey('model_profile_overrides.agents.a.b')).toBe(false)
    expect(configSchema.isValidConfigKey('model_profile_overrides_agents.sma-executor')).toBe(false)
    expect(configSchema.isValidConfigKey('not_a_config_key')).toBe(false)
  })

  it('Test 8: `null` clears a pin — the key is removed, not set to the string "null"', () => {
    writeConfig({ model_profile: 'balanced' })

    configSet('model_profile_overrides.agents.sma-executor', 'opus')
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')

    // The documented way to lift a pin (scripts/sma/README.md, settings-advanced.md).
    configSet('model_profile_overrides.agents.sma-executor', 'null')

    // The key is gone — not present with a bogus string value.
    expect(readConfig().model_profile_overrides?.agents ?? {}).not.toHaveProperty('sma-executor')
    // ...so the agent is back on the profile, not pinned to a model named "null".
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('sonnet')
  })

  it('Test 9: clearing is a no-op on an absent key and works for the runtime tier namespace', () => {
    writeConfig({ model_profile: 'balanced' })

    // Clearing a key that was never set must not error or invent structure.
    expect(() => configSet('model_profile_overrides.agents.sma-planner', 'null')).not.toThrow()
    expect(readConfig()).not.toHaveProperty('model_profile_overrides')
    // Still the plain profile answer for the planner under `balanced`.
    expect(resolveModelInternal(cwd, 'sma-planner')).toBe('opus')

    // The runtime tier half of the same object clears the same documented way.
    configSet('model_profile_overrides.gemini.opus', 'gemini-3-ultra')
    expect(readConfig().model_profile_overrides.gemini.opus).toBe('gemini-3-ultra')
    configSet('model_profile_overrides.gemini.opus', 'null')
    expect(readConfig().model_profile_overrides.gemini ?? {}).not.toHaveProperty('opus')
  })
})
