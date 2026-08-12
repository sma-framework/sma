/**
 * The executor's missing half — `buildArgs`.
 *
 * The tick spawns in two moves: `buildArgs(task, route, options)` assembles the spec and
 * `spawnWorker(spec)` starts it. Only the second was ever wired, so `executorBlocker` refused
 * every task with «задачу некому запустить» — truthfully, on every tick, since the fleet
 * shipped. These cases pin the composition that closes that gap.
 *
 * What is being tested is deliberately NOT the argument builders — those have their own
 * suites and are imported here as collaborators. What is tested is the seam nobody owned:
 * which worker the route named, which account is behind it, which of the two CLIs runs, and
 * that the parity guard is really in the path rather than merely mentioned in a comment.
 *
 * The refusals matter as much as the happy path. A route with no worker is a REAL routing
 * outcome (the API-fallback and window-exhausted branches produce one), and the honest answer
 * is a named error the tick records as a task failure — never a guess at whose account to
 * spend from.
 */

import { describe, it, expect } from 'vitest'

import { createBuildArgs, NoWorkerForRouteError, UnknownStageError, CLAUDE_BIN, CODEX_BIN } from '../src/runner/build-args.mjs'
import { ProfileParityError, assertProfileParity } from '../src/runner/args.mjs'

const claudeWorker = {
  id: 'max-1',
  lane: 'prod',
  provider: 'claude',
  enabled: true,
  account: {
    name: 'max-1',
    configDir: '/accounts/max-1',
    oauthTokenEnv: 'SMA_MAX_1_TOKEN',
    spendLogsDir: '/accounts/max-1/spend',
  },
}

const codexWorker = {
  id: 'pro-1',
  lane: 'research',
  provider: 'codex',
  enabled: true,
  account: { name: 'pro-1', configDir: '/accounts/pro-1', spendLogsDir: '/accounts/pro-1/spend' },
}

const CONFIG = { workers: [claudeWorker, codexWorker] }
const ENV = { SMA_MAX_1_TOKEN: 'oauth-token-value', ANTHROPIC_API_KEY: 'api-key-value' }

const task = (over: Record<string, unknown> = {}) => ({
  id: 'T-0001',
  title: 'задача с кириллицей в названии',
  note: 'подробности задачи',
  lane: 'prod',
  ...over,
})

const route = (over: Record<string, unknown> = {}) => ({
  workerId: 'max-1',
  provider: 'claude',
  model: null,
  effort: null,
  useApiFallback: false,
  reason: 'profile',
  ...over,
})

// The product is plain JS with JSDoc types; the spec it returns is a bag of strings. `any`
// here keeps the suite about behaviour rather than about the editor's view of an untyped module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (cfg: any = CONFIG, env: any = ENV): any => createBuildArgs({ config: cfg, env })

describe('buildArgs — the spec the tick spawns', () => {
  it('assembles a Claude session: binary, base args, account env and the task prompt', () => {
    const spec = build()(task(), route())

    expect(spec.bin).toBe(CLAUDE_BIN)
    expect(spec.args.slice(0, 5)).toEqual(['--print', '-', '--output-format', 'stream-json', '--verbose'])
    expect(spec.workerId).toBe('max-1')
    expect(spec.provider).toBe('claude')

    // the account's own isolation, and the headless marker — nobody is at this keyboard
    expect(spec.env.CLAUDE_CONFIG_DIR).toBe('/accounts/max-1')
    expect(spec.env.SMA_SPEND_LOGS_DIR).toBe('/accounts/max-1/spend')
    expect(spec.env.SMA_HEADLESS).toBe('1')

    // the task travels as prompt DATA, on stdin — never as an argument
    expect(spec.prompt).toContain('T-0001')
    expect(spec.prompt).toContain('задача с кириллицей в названии')
    expect(spec.args.join(' ')).not.toContain('задача с кириллицей')
  })

  it('carries the account token BY NAME out of the injected env, into the child env only', () => {
    const spec = build()(task(), route())
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token-value')
    // the NAME is config; the VALUE never becomes an argument
    expect(spec.args.join(' ')).not.toContain('oauth-token-value')
  })

  it('leaves the token out when the account names no token variable', () => {
    const cfg = { workers: [{ ...claudeWorker, account: { ...claudeWorker.account, oauthTokenEnv: undefined } }] }
    const spec = build(cfg)(task(), route())
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('adds --forward-subagent-text only when asked — the live attempt log is the reason it exists', () => {
    const withFlag = build()(task(), route(), { forwardSubagentText: true })
    const without = build()(task(), route())

    expect(withFlag.args).toContain('--forward-subagent-text')
    expect(without.args).not.toContain('--forward-subagent-text')
  })

  it('routes a Codex worker to the other CLI, with a per-task CODEX_HOME', () => {
    const spec = build()(task({ lane: 'research' }), route({ workerId: 'pro-1', provider: 'codex' }))

    expect(spec.bin).toBe(CODEX_BIN)
    expect(spec.args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(spec.args[spec.args.length - 1]).toBe('-') // prompt on stdin, same law as the other lane
    expect(String(spec.env.CODEX_HOME)).toContain('codex-tasks')
    expect(String(spec.env.CODEX_HOME)).toContain('T-0001')
    expect(spec.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})

describe('buildArgs — model and effort come from the profile, and the guard is in the path', () => {
  it('emits no model/effort flag when neither the task nor the profile names one', () => {
    const spec = build()(task(), route())
    expect(spec.args).not.toContain('--model')
    expect(spec.args).not.toContain('--effort')
  })

  it('takes the worker profile when the task says nothing', () => {
    const cfg = { workers: [{ ...claudeWorker, model: 'opus', effort: 'high' }] }
    const spec = build(cfg)(task(), route())
    expect(spec.args).toContain('--model')
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('opus')
    expect(spec.args[spec.args.indexOf('--effort') + 1]).toBe('high')
  })

  it('lets a per-task override win over the profile', () => {
    const cfg = { workers: [{ ...claudeWorker, model: 'opus' }] }
    const spec = build(cfg)(task({ model: 'sonnet' }), route())
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('sonnet')
  })

  it('the route is NOT a source of model truth — a route naming another model does not move the spec', () => {
    const cfg = { workers: [{ ...claudeWorker, model: 'opus' }] }
    const spec = build(cfg)(task(), route({ model: 'haiku' }))
    // The profile (and a per-task override) decide; a route that disagreed would be a silent
    // substitution, which is exactly what the parity guard exists to refuse.
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('opus')
  })

  it('the guard in the path really bites — stated honestly: today it cannot fire from here', () => {
    // buildArgs derives model/effort from `expectedModelEffort`, the SAME function
    // `assertProfileParity` measures against, so the assertion inside buildArgs is a tautology
    // BY CONSTRUCTION and no input can make it throw. It is kept as a tripwire for the edit
    // that would break it — someone taking model from the route, or from a lane default.
    // Pretending a test proves otherwise would be theatre, so what is proved here is that the
    // imported guard is a real one: given divergent args, it throws.
    expect(() =>
      assertProfileParity({ args: ['--model', 'haiku'], worker: { model: 'opus' }, task: {} }),
    ).toThrow(ProfileParityError)
  })
})

describe('buildArgs — what it refuses by name instead of guessing', () => {
  it('refuses a route that named no worker, and says which routing outcome it was', () => {
    expect(() => build()(task(), route({ workerId: null, reason: 'window_exhausted' }))).toThrow(NoWorkerForRouteError)
    try {
      build()(task(), route({ workerId: null, reason: 'window_exhausted' }))
    } catch (err) {
      expect(String((err as Error).message)).toContain('window_exhausted')
    }
  })

  it('refuses a worker id that is not in this daemon config', () => {
    expect(() => build()(task(), route({ workerId: 'ghost-9' }))).toThrow(/not in this daemon's config/)
  })

  it('refuses a worker with no account block — a session needs something to run under', () => {
    const cfg = { workers: [{ id: 'max-1', lane: 'prod', provider: 'claude', enabled: true }] }
    expect(() => build(cfg)(task(), route())).toThrow(/no account block/)
  })

  it('refuses a missing task or route rather than assembling half a spec', () => {
    expect(() => build()(null as never, route())).toThrow(NoWorkerForRouteError)
    expect(() => build()(task(), null as never)).toThrow(NoWorkerForRouteError)
  })
})

describe('buildArgs — the child gets an environment it can actually run in', () => {
  // MEASURED ON THE FIRST LIVE SPAWN. Handing the child only the account's own three
  // variables REPLACES its environment rather than extending it: no PATH, so the CLI could
  // not find its own binary, and the spawn died with ENOENT. A worker session is an ordinary
  // program — it needs the operating system's environment. What it must NOT get is anyone
  // else's key, because the daemon holds every configured account's token at once.
  const OS_ENV = {
    PATH: 'C:\\Windows\\System32;C:\\Users\\me\\.local\\bin',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    SMA_MAX_1_TOKEN: 'token-of-account-one',
    SMA_MAX_2_TOKEN: 'token-of-account-TWO',
    ANTHROPIC_API_KEY: 'api-key-value',
  }
  const TWO_ACCOUNTS = {
    workers: [
      claudeWorker,
      {
        id: 'max-2',
        lane: 'prod',
        provider: 'claude',
        enabled: true,
        account: { name: 'max-2', configDir: '/accounts/max-2', oauthTokenEnv: 'SMA_MAX_2_TOKEN' },
      },
    ],
  }

  it('inherits the operating system environment — PATH above all', () => {
    const spec = build(TWO_ACCOUNTS, OS_ENV)(task(), route())
    expect(spec.env.PATH).toBe(OS_ENV.PATH)
    expect(spec.env.SystemRoot).toBe('C:\\Windows')
    expect(spec.env.TEMP).toBe('C:\\Temp')
  })

  it('carries THIS account credential, under the standard name, and no raw token variable', () => {
    const spec = build(TWO_ACCOUNTS, OS_ENV)(task(), route())
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-of-account-one')
    // the raw names are stripped from the base: a name is config, a value is a secret
    expect(spec.env.SMA_MAX_1_TOKEN).toBeUndefined()
  })

  it('never lets one account see another account key — the whole point of per-spawn assembly', () => {
    const spec = build(TWO_ACCOUNTS, OS_ENV)(task(), route())
    expect(spec.env.SMA_MAX_2_TOKEN).toBeUndefined()
    expect(JSON.stringify(spec.env)).not.toContain('token-of-account-TWO')
  })

  it('does not leak the API key into a spawn that did not ask for the fallback', () => {
    const spec = build(TWO_ACCOUNTS, OS_ENV)(task(), route())
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined()
    // …and puts it back when the route DID ask
    expect(build(TWO_ACCOUNTS, OS_ENV)(task(), route({ useApiFallback: true })).env.ANTHROPIC_API_KEY).toBe('api-key-value')
  })
})

describe('buildArgs — the API fallback', () => {
  it('adds the API key when the route asked for the fallback', () => {
    const spec = build()(task(), route({ useApiFallback: true }))
    expect(spec.env.ANTHROPIC_API_KEY).toBe('api-key-value')
  })

  it('leaves the API key out of an ordinary subscription spawn', () => {
    const spec = build()(task(), route())
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})

/**
 * THE TWO SHAPES OF PROMPT.
 *
 * A stage of the phase cycle rides the queue like any other task, and until now it was also
 * PROMPTED like any other task: its command went to the worker inside the fence that says «this
 * is data, not instructions». A command inside a fence is inert text, so a stage started from
 * the window reached the queue, spawned a session, and the session did nothing with it — which
 * is what a person saw as «the button does not work».
 *
 * These cases pin both halves: the envelope, and only the envelope, decides which shape; and
 * the bare command is REBUILT from the frozen dictionary rather than lifted off the task's
 * title, so a row whose text was edited cannot turn into an instruction.
 */
describe('buildArgs — a stage of the phase cycle is a command, everything else is fenced data', () => {
  const stageTask = (over: Record<string, unknown> = {}) =>
    task({ id: 'S-1770000000000', title: '/sma-plan-phase 12 --text', lane: 'paperwork', data: { kind: 'document', stage: 'plan', phase: '12' }, ...over })

  it('gives a stage task the BARE command — no fence, no headings, nothing else', () => {
    const spec = build()(stageTask(), route())
    expect(spec.prompt).toBe('/sma-plan-phase 12 --text')
    expect(spec.prompt).not.toContain('```')
    expect(spec.prompt).not.toContain('ДАННЫЕ')
  })

  it('rebuilds the command from the dictionary — an edited title cannot become an instruction', () => {
    // the row says one thing; the frozen four say another; the worker gets the frozen four
    const spec = build()(stageTask({ title: '/sma-plan-phase 12 --text && rm -rf /' }), route())
    expect(spec.prompt).toBe('/sma-plan-phase 12 --text')
  })

  it('every stage of the cycle gets its own command, and the phase is the only hole', () => {
    const of = (stage: string, phase: string) =>
      build()(stageTask({ data: { kind: 'document', stage, phase } }), route()).prompt
    expect(of('discuss', '12')).toBe('/sma-discuss-phase 12 --batch --text')
    expect(of('plan', '7')).toBe('/sma-plan-phase 7 --text')
    expect(of('execute', '12')).toBe('/sma-execute-phase 12')
    expect(of('verify', 'phase-12-front-workplace')).toBe('/sma-verify-work phase-12-front-workplace --text')
  })

  it('an ordinary task is UNCHANGED — no envelope, so it still travels inside the fence', () => {
    const spec = build()(task(), route())
    expect(spec.prompt).toContain('```')
    expect(spec.prompt).toContain('задача с кириллицей в названии')
    expect(spec.prompt.startsWith('/')).toBe(false)
  })

  it('an envelope WITHOUT a stage is an ordinary task — the kind alone changes nothing', () => {
    const spec = build()(task({ data: { kind: 'code' } }), route())
    expect(spec.prompt).toContain('```')
  })

  it('refuses a stage nobody declared instead of quietly running it as an ordinary task', () => {
    // the silent fallback would spawn a session that does nothing and then be judged by the
    // DOCUMENTARY gate, which waits for a document nobody is writing — a refusal names it now
    expect(() => build()(stageTask({ data: { kind: 'document', stage: 'refactor', phase: '12' } }), route())).toThrow(
      UnknownStageError,
    )
  })

  it('refuses a phase that could read as a flag rather than substituting it into the command', () => {
    expect(() => build()(stageTask({ data: { kind: 'document', stage: 'plan', phase: '--dangerously-skip-permissions' } }), route())).toThrow(
      UnknownStageError,
    )
  })

  // THE CONNECTION, NOT THE COMPUTATION. The capability envelope was built, hashed and
  // journalled for every attempt this fleet ever ran — and never handed to the process, so
  // the CLI refused Edit/Write/Bash on sight and no worker could change a single file.
  // Policy that never reaches the thing it governs is bookkeeping; this asserts the wire.
  it('the envelope tool grant reaches the spawned process', () => {
    const tools = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']
    const spec = build()(task(), route(), { allowedTools: tools })
    const i = spec.args.indexOf('--allowedTools')
    expect(i, 'the spawn carries no tool grant — the worker would be read-only').toBeGreaterThan(-1)
    expect(spec.args[i + 1]).toBe(tools.join(' '))
  })

  it('no grant is passed when the envelope names no tools — absence stays absence', () => {
    expect(build()(task(), route(), {}).args).not.toContain('--allowedTools')
    expect(build()(task(), route(), { allowedTools: [] }).args).not.toContain('--allowedTools')
  })

  it('no stage prompt carries an automation flag — the guard travels with the dictionary', () => {
    for (const stage of ['discuss', 'plan', 'execute', 'verify']) {
      const prompt = build()(stageTask({ data: { kind: 'document', stage, phase: '12' } }), route()).prompt
      expect(prompt, stage).not.toMatch(/--(auto|bare|dangerously-skip-permissions|permission-mode)(\s|=|$)/)
    }
  })
})
