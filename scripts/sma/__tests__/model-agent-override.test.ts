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
 *   - Tests 10-12: LEGACY DATA. Configs written before the clear fix already hold
 *     the string "null" on disk. Every model-valued read treats it as ABSENT and
 *     falls through to the next priority, so an old config heals itself on the
 *     next run instead of dispatching a model named "null".
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
const { MODEL_PROFILES } = require_('../../../sma-core/bin/lib/model-profiles.cjs')

const SMA_TOOLS = fileURLToPath(new URL('../../../sma-core/bin/sma-tools.cjs', import.meta.url))

const { resolveModelInternal, resolveTierEntry, resolveAgentModelOverride, resolveModelPolicy } = modelResolver

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
    // The pin is DOWN from the profile answer on purpose: the executor's balanced
    // tier is itself the strong model, so a pin that named the same model would
    // assert nothing — it would pass whether or not the pin was read at all.
    writeConfig({
      model_profile: 'balanced',
      model_profile_overrides: { agents: { 'sma-executor': 'haiku' } },
    })

    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('haiku')
    // The verifier shares the balanced profile and is NOT pinned — it must not move.
    expect(resolveModelInternal(cwd, 'sma-verifier')).toBe('sonnet')
  })

  it('Test 2: without a pin the profile answer is unchanged', () => {
    writeConfig({ model_profile: 'balanced' })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')

    writeConfig({ model_profile: 'budget' })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('sonnet')

    writeConfig({ model_profile: 'quality' })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')
  })

  it('Test 3: an unknown agent name is a no-op — resolution falls through to the profile', () => {
    // Same reason as Test 1 for the pin being the weak model: falling through to
    // the profile has to produce a DIFFERENT answer than applying the pin would,
    // or the no-op is indistinguishable from the pin being honoured.
    writeConfig({
      model_profile: 'balanced',
      model_profile_overrides: { agents: { 'sma-exicutor': 'haiku', 'not-an-agent': 'haiku' } },
    })

    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')
    expect(resolveModelInternal(cwd, 'sma-verifier')).toBe('sonnet')
    // The pure reader agrees: no entry for this agent -> null, never a throw.
    expect(resolveAgentModelOverride({ agents: { 'sma-exicutor': 'haiku' } }, 'sma-executor')).toBeNull()
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
    const overrides = { agents: { 'sma-executor': 'haiku' } }
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
      expect(resolveModelInternal(cwd, 'sma-executor')).toBe('haiku')
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

    // Pinned DOWN from the profile answer so that "the pin was lifted" and "the
    // pin is still in force" cannot produce the same model.
    configSet('model_profile_overrides.agents.sma-executor', 'haiku')
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('haiku')

    // The documented way to lift a pin (scripts/sma/README.md, settings-advanced.md).
    configSet('model_profile_overrides.agents.sma-executor', 'null')

    // The key is gone — not present with a bogus string value.
    expect(readConfig().model_profile_overrides?.agents ?? {}).not.toHaveProperty('sma-executor')
    // ...so the agent is back on the profile, not pinned to a model named "null".
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')
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

  it('Test 10: a legacy "null" pin is treated as absent, not as a model named "null"', () => {
    // Exactly what config-set wrote before the clear fix.
    writeConfig({
      model_profile: 'balanced',
      model_profile_overrides: { agents: { 'sma-executor': 'null' } },
    })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')

    // The object spelling of the same rot.
    writeConfig({
      model_profile: 'balanced',
      model_profile_overrides: { agents: { 'sma-executor': { model: 'null' } } },
    })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')

    // The pure reader agrees, including a padded variant.
    expect(resolveAgentModelOverride({ agents: { 'sma-executor': 'null' } }, 'sma-executor')).toBeNull()
    expect(resolveAgentModelOverride({ agents: { 'sma-executor': '  null  ' } }, 'sma-executor')).toBeNull()
    // A real model whose NAME merely starts with those letters is untouched.
    expect(resolveAgentModelOverride({ agents: { 'sma-executor': 'nullable-1' } }, 'sma-executor')).toBe('nullable-1')
  })

  it('Test 11: legacy "null" in the higher-priority model_overrides also falls through', () => {
    // model_overrides outranks the pin, so a rotted entry here shadowed everything.
    // The surviving pin names the weak model so that "the pin answered" is
    // distinguishable from "the profile answered".
    writeConfig({
      model_profile: 'balanced',
      model_overrides: { 'sma-executor': 'null' },
      model_profile_overrides: { agents: { 'sma-executor': 'haiku' } },
    })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('haiku')

    writeConfig({ model_profile: 'balanced', model_overrides: { 'sma-executor': 'null' } })
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')
  })

  it('Test 12: legacy "null" in the runtime tier map falls back to the built-in', () => {
    const overrides = { gemini: { opus: 'null' } }
    expect(resolveTierEntry({ runtime: 'gemini', tier: 'opus', overrides })?.model).toBe('gemini-3.1-pro-preview')

    writeConfig({
      model_profile: 'quality',
      runtime: 'gemini',
      model_profile_overrides: overrides,
    })
    // sma-executor is `opus` under the quality profile -> the gemini opus built-in.
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('gemini-3.1-pro-preview')
  })

  it('Test 13: routing every model slot through one reader left the healthy paths intact', () => {
    // model_policy — both spellings of a runtime tier, and the generic provider.
    expect(resolveModelPolicy({ runtime: 'gemini', runtime_tiers: { gemini: { opus: 'gemini-3-ultra' } } }, 'opus'))
      .toBe('gemini-3-ultra')
    expect(resolveModelPolicy({ runtime: 'gemini', runtime_tiers: { gemini: { opus: { model: 'g-obj' } } } }, 'opus'))
      .toBe('g-obj')
    expect(resolveModelPolicy({ provider: 'generic', high: 'my-big-model' }, 'opus')).toBe('my-big-model')
    // ...and the built-in provider presets are still reached.
    expect(resolveModelPolicy({ provider: 'openai', budget: 'medium' }, 'opus')).toBe('gpt-5.5')
    // The same slots, rotted, decline to answer so the caller falls through.
    expect(resolveModelPolicy({ runtime: 'gemini', runtime_tiers: { gemini: { opus: 'null' } } }, 'opus')).toBeNull()
    expect(resolveModelPolicy({ provider: 'generic', high: 'null' }, 'opus')).toBeNull()

    // A user tier override still wins outright...
    expect(resolveTierEntry({ runtime: 'gemini', tier: 'opus', overrides: { gemini: { opus: 'custom-x' } } })?.model)
      .toBe('custom-x')
    // ...and dropping a rotted `model` keeps the user's sibling fields.
    expect(resolveTierEntry({
      runtime: 'gemini',
      tier: 'opus',
      overrides: { gemini: { opus: { model: 'null', note: 'keep' } } },
    })).toEqual({ model: 'gemini-3.1-pro-preview', note: 'keep' })
  })
})

/**
 * The default the spawn path actually travels.
 *
 * `model_profile` is optional, so most projects never set one: the resolver
 * falls through to the `balanced` tier and reads the agent's row out of the
 * SHIPPED catalog. That row — not anybody's config file — is where the model an
 * orchestrator spawns an agent with is born. It is also where a stale tier can
 * hide indefinitely: the executor was handed the weakest model at every single
 * spawn across two milestones of work here, and each time a human noticed and
 * patched the model by hand at the call site. Nothing in the suite objected,
 * because nothing in the suite asked the catalog what it hands out by default.
 *
 * So this lock stands on the REAL catalog through the REAL resolver: no
 * `SMA_MODEL_CATALOG`, no substituted catalog file, no mocked loader. Feeding
 * this test a catalog of its own would make it pass forever while the shipped
 * default rotted — a stand-in cannot testify about the thing it stands in for.
 * (The temp configs the tests above write are a different matter: the project
 * config IS the variable half, and substituting it is the point of those tests.)
 *
 * The directory handed to the resolver below is deliberately EMPTY — no
 * `.planning/config.json` at all. That is the state the defect lived in.
 */
describe('shipped catalog defaults', () => {
  it('default balanced tier hands the strong model to the executor and the plan checker', () => {
    // No config written in this test: `model_profile` is absent, the resolver
    // takes its `balanced` branch, and the answer comes straight off the row in
    // sma-core/bin/shared/model-catalog.json — the spawn-time path, end to end.
    expect(resolveModelInternal(cwd, 'sma-executor')).toBe('opus')
    expect(resolveModelInternal(cwd, 'sma-plan-checker')).toBe('opus')

    // And the quality profile may never hand a role a WEAKER model than balanced
    // does. The plan checker sat on the weakest tier under both profiles at once;
    // that inversion — "pay for quality, get less than average" — is the second
    // half of the same defect and is locked here rather than left to the eye.
    expect(MODEL_PROFILES['sma-plan-checker'].quality).toBe('opus')
    expect(MODEL_PROFILES['sma-plan-checker'].balanced).toBe('opus')
  })
})
