/**
 * Tests for the capability envelope — what a task may touch, declared and validated.
 * This is the fleet's second invariant made executable.
 *
 * The law under test: a task's reach is bounded by a DECLARATION, not by convention.
 * Every task carries an envelope naming what it may read, write, run, reach, spend and
 * how long it may run — and no construction of those inputs can produce push or merge.
 *
 * The posture is `schema-v2.mjs`'s: a frozen closed vocabulary plus a pure, fail-closed
 * resolver. Missing key, unknown key, a declared human-only action — all refusals, each
 * naming its reason. An envelope that cannot be read grants nothing.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  CAPABILITY_KEYS,
  HUMAN_ONLY_ACTIONS,
  HUMAN_ONLY_DENIALS,
  humanOnlyDenials,
  envelopeSpawnOptions,
  ENVELOPE_LANES,
  defaultEnvelope,
  validateEnvelope,
  envelopeAllows,
  envelopeHash,
  DANGER_CLASS_HUMAN_ACTIONS,
  approvalWall,
} from '../src/queue/capability-envelope.mjs'
import { TASK_LANES } from '../src/queue/adapter.mjs'
// НАСТОЯЩИЙ классификатор, а не список его имён, переписанный в тест: карта ниже обязана
// быть отношением между ДВУМЯ существующими таблицами, а не третьей копией их содержимого.
import { WORKER_DANGER_CLASSES } from '../../scripts/sma/lib/worker-danger.mjs'

const src = readFileSync(new URL('../src/queue/capability-envelope.mjs', import.meta.url), 'utf8')

describe('CAPABILITY_KEYS — the fleet’s eight dimensions, frozen', () => {
  it('holds exactly eight dimensions and is frozen', () => {
    expect(CAPABILITY_KEYS).toHaveLength(8)
    expect(Object.isFrozen(CAPABILITY_KEYS)).toBe(true)
  })

  it('names the fleet’s dimensions: read/write paths, tools, network, secrets, budget, runtime, human-only', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual(
      [
        'allowedTools',
        'budget',
        'humanOnlyActions',
        'maxRuntime',
        'networkDestinations',
        'readPaths',
        'secretScopes',
        'writePaths',
      ].sort(),
    )
  })

  it('the lane vocabulary is the task shape’s, not a second one (adapter.mjs TASK_LANES)', () => {
    expect([...ENVELOPE_LANES]).toEqual([...TASK_LANES])
    expect(Object.isFrozen(ENVELOPE_LANES)).toBe(true)
  })

  it('push and merge are permanently in the human-only set', () => {
    expect(HUMAN_ONLY_ACTIONS).toContain('push')
    expect(HUMAN_ONLY_ACTIONS).toContain('merge')
    expect(Object.isFrozen(HUMAN_ONLY_ACTIONS)).toBe(true)
  })
})

describe('defaultEnvelope — a complete envelope for every lane', () => {
  it('every lane gets an envelope with every key present, and it validates', () => {
    for (const lane of ENVELOPE_LANES) {
      const env = defaultEnvelope(lane)
      for (const key of CAPABILITY_KEYS) {
        expect(Object.hasOwn(env, key), `${lane} is missing ${key}`).toBe(true)
      }
      expect(Object.keys(env).sort()).toEqual([...CAPABILITY_KEYS].sort())
      expect(validateEnvelope(env).valid, `${lane} envelope must validate`).toBe(true)
    }
  })

  it('EVERY lane denies push and denies merge (fleet invariant 2)', () => {
    for (const lane of ENVELOPE_LANES) {
      const env = defaultEnvelope(lane)
      expect(env.humanOnlyActions, `${lane}`).toContain('push')
      expect(env.humanOnlyActions, `${lane}`).toContain('merge')
      expect(envelopeAllows(env, { action: 'push' }), `${lane}`).toBe(false)
      expect(envelopeAllows(env, { action: 'merge' }), `${lane}`).toBe(false)
      // and no granting dimension names either capability
      const granting = [...env.readPaths, ...env.writePaths, ...env.allowedTools, ...env.networkDestinations, ...env.secretScopes]
      for (const entry of granting) {
        expect(String(entry).toLowerCase()).not.toContain('push')
        expect(String(entry).toLowerCase()).not.toContain('merge')
      }
    }
  })

  it('the lanes differ where they really differ — the write scope', () => {
    const write = (lane: string) => defaultEnvelope(lane).writePaths.join('|')
    expect(write('forge')).not.toBe(write('prod'))
    expect(write('research')).not.toBe(write('prod'))
    // the forge drafts into the three draft dirs the forge module already contracts
    expect(defaultEnvelope('forge').writePaths).toEqual([
      '.claude/agents',
      '.claude/skills',
      '.claude/harness/mcp-requests',
    ])
  })

  it('an unknown lane gets the LOCKED envelope, not a permissive default (fail-closed)', () => {
    const env = defaultEnvelope('whatever-the-prompt-said')
    expect(validateEnvelope(env).valid).toBe(true)
    expect(env.writePaths).toEqual([])
    expect(env.allowedTools).toEqual([])
    expect(envelopeAllows(env, { action: 'write', path: 'src/x.mjs' })).toBe(false)
    expect(defaultEnvelope(undefined).writePaths).toEqual([])
  })

  it('the returned envelope is frozen — a caller cannot widen its own permit in place', () => {
    const env = defaultEnvelope('prod')
    expect(Object.isFrozen(env)).toBe(true)
    expect(Object.isFrozen(env.writePaths)).toBe(true)
  })
})

describe('validateEnvelope — fail-closed, and it names the reason', () => {
  it('accepts a complete envelope', () => {
    const res = validateEnvelope(defaultEnvelope('prod'))
    expect(res.valid).toBe(true)
    expect(res.refusal).toBeNull()
  })

  it('refuses a missing key and NAMES the missing key', () => {
    for (const key of CAPABILITY_KEYS) {
      const env: any = { ...defaultEnvelope('prod') }
      delete env[key]
      const res = validateEnvelope(env)
      expect(res.valid, `${key} must be required`).toBe(false)
      expect(res.refusal).toContain(key)
      expect(res.key).toBe(key)
    }
  })

  it('refuses an UNKNOWN key rather than ignoring it — an unrecognised permission is not a permit', () => {
    const env: any = { ...defaultEnvelope('prod'), canDoAnything: ['everything'] }
    const res = validateEnvelope(env)
    expect(res.valid).toBe(false)
    expect(res.refusal).toContain('canDoAnything')
    expect(res.key).toBe('canDoAnything')
  })

  it('refuses an envelope that declares a push capability, naming the human-only boundary', () => {
    const env: any = { ...defaultEnvelope('prod'), allowedTools: ['Read', 'GitPush'] }
    const res = validateEnvelope(env)
    expect(res.valid).toBe(false)
    expect(res.refusal).toMatch(/human-only/i)
    expect(res.refusal).toMatch(/push/i)
  })

  it('refuses a declared merge capability the same way, whatever else the envelope says', () => {
    const env: any = { ...defaultEnvelope('research'), networkDestinations: ['merge.internal'] }
    const res = validateEnvelope(env)
    expect(res.valid).toBe(false)
    expect(res.refusal).toMatch(/human-only/i)
  })

  it('the human-only check runs FIRST — a malformed envelope still cannot smuggle push through', () => {
    const res = validateEnvelope({ allowedTools: ['push-to-origin'] } as any)
    expect(res.valid).toBe(false)
    expect(res.refusal).toMatch(/human-only/i)
  })

  it('refuses an envelope whose humanOnlyActions dropped push or merge — no input moves them out', () => {
    for (const dropped of ['push', 'merge']) {
      const base = defaultEnvelope('prod')
      const env: any = { ...base, humanOnlyActions: base.humanOnlyActions.filter((a: string) => a !== dropped) }
      const res = validateEnvelope(env)
      expect(res.valid, `dropping ${dropped} must be refused`).toBe(false)
      expect(res.refusal).toMatch(/human-only/i)
      expect(res.refusal).toContain(dropped)
    }
  })

  it('refuses a non-object, a null and an array', () => {
    for (const bad of [null, undefined, 'prod', 42, ['readPaths']]) {
      expect(validateEnvelope(bad as any).valid).toBe(false)
    }
  })

  it('refuses a dimension of the wrong shape — a string where a list belongs', () => {
    const env: any = { ...defaultEnvelope('prod'), readPaths: 'everything' }
    const res = validateEnvelope(env)
    expect(res.valid).toBe(false)
    expect(res.key).toBe('readPaths')
  })

  it('refuses a maxRuntime that is not a duration, and a negative budget', () => {
    expect(validateEnvelope({ ...defaultEnvelope('prod'), maxRuntime: 'forever' } as any).valid).toBe(false)
    expect(validateEnvelope({ ...defaultEnvelope('prod'), budget: -1 } as any).valid).toBe(false)
    expect(validateEnvelope({ ...defaultEnvelope('prod'), budget: 12.5 } as any).valid).toBe(true)
  })
})

describe('envelopeAllows — a permit is checked, never assumed', () => {
  const prod = defaultEnvelope('prod')
  const forge = defaultEnvelope('forge')

  it('returns false for a write OUTSIDE the declared write paths', () => {
    expect(envelopeAllows(forge, { action: 'write', path: '.claude/agents/x.md' })).toBe(true)
    expect(envelopeAllows(forge, { action: 'write', path: 'daemon/src/loop.mjs' })).toBe(false)
    expect(envelopeAllows(forge, { action: 'write', path: '.claude/agentsX/x.md' })).toBe(false) // boundary, not prefix
  })

  it('returns false for a network destination that is not declared', () => {
    expect(envelopeAllows(prod, { action: 'network', destination: 'api.example.com' })).toBe(false)
    const wired = { ...prod, networkDestinations: ['api.example.com'] }
    expect(envelopeAllows(wired, { action: 'network', destination: 'api.example.com' })).toBe(true)
    expect(envelopeAllows(wired, { action: 'network', destination: 'evil.example.com' })).toBe(false)
  })

  it('refuses a path escaping the declared root, however it is spelled', () => {
    expect(envelopeAllows(forge, { action: 'write', path: '.claude/agents/../../etc/passwd' })).toBe(false)
    expect(envelopeAllows(forge, { action: 'write', path: 'C:/Windows/system32' })).toBe(false)
    expect(envelopeAllows(forge, { action: 'write', path: '/etc/passwd' })).toBe(false)
    // Windows drive-RELATIVE — no slash after the colon. It resolves against the
    // drive's own cwd, outside any declared root; a slash-only test waves it
    // through as "relative", and prod declares writePaths: ['.'].
    expect(envelopeAllows(prod, { action: 'write', path: 'C:evil.txt' })).toBe(false)
    expect(envelopeAllows(forge, { action: 'write', path: 'c:.claude/agents/x.md' })).toBe(false)
  })

  it('returns false when the envelope itself is invalid — a malformed envelope grants nothing', () => {
    const broken: any = { ...prod }
    delete broken.writePaths
    expect(envelopeAllows(broken, { action: 'write', path: 'daemon/src/loop.mjs' })).toBe(false)
    expect(envelopeAllows(null as any, { action: 'read', path: 'README.md' })).toBe(false)
    expect(envelopeAllows({ allowedTools: ['Read'] } as any, { action: 'tool', tool: 'Read' })).toBe(false)
  })

  it('returns false for an unknown action — fail-closed on the verb too', () => {
    expect(envelopeAllows(prod, { action: 'exfiltrate', path: 'README.md' } as any)).toBe(false)
    expect(envelopeAllows(prod, {} as any)).toBe(false)
  })

  it('a declared human-only action is refused even when a dimension would allow it', () => {
    const smuggled: any = { ...prod, allowedTools: ['Read'] }
    expect(envelopeAllows(smuggled, { action: 'push' })).toBe(false)
    expect(envelopeAllows(smuggled, { action: 'merge' })).toBe(false)
  })

  it('a spend is refused when the envelope declares no budget of its own', () => {
    expect(prod.budget).toBeNull()
    expect(envelopeAllows(prod, { action: 'spend', amount: 1 })).toBe(false)
    const metered = { ...prod, budget: 5 }
    expect(envelopeAllows(metered, { action: 'spend', amount: 5 })).toBe(true)
    expect(envelopeAllows(metered, { action: 'spend', amount: 5.01 })).toBe(false)
  })

  it('a tool outside allowedTools is refused, one inside is allowed', () => {
    expect(envelopeAllows(prod, { action: 'tool', tool: 'Read' })).toBe(true)
    expect(envelopeAllows(prod, { action: 'tool', tool: 'WebFetch' })).toBe(false)
  })
})

describe('envelopeHash — a digest a receipt can be checked against', () => {
  it('is stable under key reordering', () => {
    const env: any = defaultEnvelope('prod')
    const reordered: any = {}
    for (const key of [...CAPABILITY_KEYS].reverse()) reordered[key] = env[key]
    expect(envelopeHash(reordered)).toBe(envelopeHash(env))
  })

  it('changes under ANY value change', () => {
    const base = defaultEnvelope('prod')
    const h = envelopeHash(base)
    expect(envelopeHash({ ...base, maxRuntime: '46m' })).not.toBe(h)
    expect(envelopeHash({ ...base, budget: 1 })).not.toBe(h)
    expect(envelopeHash({ ...base, writePaths: [...base.writePaths, 'extra'] })).not.toBe(h)
  })

  it('differs between lanes and is a fixed-length hex digest with no path separators', () => {
    const seen = new Set(ENVELOPE_LANES.map((l: string) => envelopeHash(defaultEnvelope(l))))
    expect(seen.size).toBeGreaterThan(1)
    for (const h of seen) {
      expect(h).toMatch(/^[0-9a-f]{64}$/)
      expect(h).not.toContain('/')
      expect(h).not.toContain('\\')
    }
  })

  it('is deterministic across calls and refuses to hash a non-object', () => {
    expect(envelopeHash(defaultEnvelope('research'))).toBe(envelopeHash(defaultEnvelope('research')))
    expect(() => envelopeHash(null as any)).toThrow()
  })
})

describe('the module keeps its stated disciplines', () => {
  it('imports NO backend — no pg, no pg-boss (BACKEND-FREE BY LAW)', () => {
    expect(src).not.toMatch(/from 'pg-boss'/)
    expect(src).not.toMatch(/from 'pg'/)
    expect(src).not.toMatch(/require\('pg/)
  })

  it('touches no filesystem and no network — node:crypto is the only import', () => {
    const imports = [...src.matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['node:crypto'])
  })

  it('never writes the reserved push literal (SMA-3 comment discipline is not the point — the code is)', () => {
    expect(src).not.toMatch(/execSync|spawnSync|child_process/)
  })
})

// ═══ the denial half of the envelope: four action names → tool patterns a session obeys ═══
//
// `humanOnlyActions` was computed for every attempt the fleet ever ran, hashed into the row
// and written to the journal — and read by nobody, because nothing downstream knew how to
// turn the word «push» into something a running process obeys. These cases pin the
// translation, and the wire that carries it is pinned in the runner and loop suites.

describe('the human-only actions become tool patterns, and none of them is silently dropped', () => {
  it('EVERY human-only action has at least one pattern — an action mapped to nothing reads exactly like one that was denied', () => {
    for (const action of HUMAN_ONLY_ACTIONS) {
      const patterns = (HUMAN_ONLY_DENIALS as Record<string, readonly string[]>)[action]
      expect(patterns, `the action "${action}" has no denial pattern at all`).toBeInstanceOf(Array)
      expect(patterns.length, `the action "${action}" maps to an empty list`).toBeGreaterThan(0)
    }
    expect(Object.isFrozen(HUMAN_ONLY_DENIALS)).toBe(true)
  })

  it('push closes the command AND the two one-line ways around it — the remote and the configuration', () => {
    const patterns = HUMAN_ONLY_DENIALS.push.join(' ')
    expect(patterns).toContain('git push')
    expect(patterns, 're-pointing the remote walks around a push denial in one line').toContain('git remote')
    expect(patterns, 'editing the configuration walks around a push denial in one line').toContain('git config')
  })

  it('deploy closes both doors onto the same street — publishing a package and cutting a release', () => {
    const patterns = HUMAN_ONLY_DENIALS.deploy.join(' ')
    expect(patterns).toContain('publish')
    expect(patterns).toContain('release')
  })

  it('a full lane envelope yields a flat, sorted, duplicate-free list and nothing unmapped', () => {
    const { patterns, unmapped } = humanOnlyDenials(defaultEnvelope('prod'))

    expect(unmapped).toEqual([])
    expect(patterns.length).toBeGreaterThan(0)
    expect([...patterns]).toEqual([...patterns].sort())
    expect(new Set(patterns).size).toBe(patterns.length)
    expect(patterns).toContain('Bash(git push:*)')
    expect(Object.isFrozen(patterns)).toBe(true)
  })

  it('an envelope that declares no human-only actions yields an empty list, not a throw', () => {
    for (const envelope of [null, undefined, {}, { humanOnlyActions: [] }] as any[]) {
      const res = humanOnlyDenials(envelope)
      expect(res.patterns).toEqual([])
      expect(res.unmapped).toEqual([])
    }
  })

  it('an action this table has no pattern for is RETURNED as unmapped — a skipped denial and a missing one are the same fact on the wire', () => {
    const { patterns, unmapped } = humanOnlyDenials({ humanOnlyActions: ['push', 'sign-the-release'] } as any)

    expect(unmapped).toEqual(['sign-the-release'])
    expect(patterns).toEqual([...HUMAN_ONLY_DENIALS.push].sort())
  })

  it('the same pattern named by two actions appears once', () => {
    const { patterns } = humanOnlyDenials({ humanOnlyActions: ['push', 'push', 'merge'] } as any)
    expect(new Set(patterns).size).toBe(patterns.length)
    expect(patterns).toContain('Bash(git merge:*)')
  })
})

describe('envelopeSpawnOptions — the ONE place a spawn learns what the envelope said', () => {
  it('carries both halves of a lane envelope: the grant and the refusal', () => {
    const opts = envelopeSpawnOptions(defaultEnvelope('prod'))

    expect(opts.allowedTools).toEqual([...defaultEnvelope('prod').allowedTools])
    expect(opts.disallowedTools).toEqual([...humanOnlyDenials(defaultEnvelope('prod')).patterns])
  })

  it('absence stays absence — a dimension the envelope does not carry emits no key at all', () => {
    expect(envelopeSpawnOptions(null)).toEqual({})
    expect(envelopeSpawnOptions({ allowedTools: [], humanOnlyActions: [] } as any)).toEqual({})
    expect(envelopeSpawnOptions({ allowedTools: ['Read'] } as any)).toEqual({ allowedTools: ['Read'] })
  })

  it('the returned lists are copies — a caller cannot widen its own permit in place', () => {
    const opts = envelopeSpawnOptions(defaultEnvelope('prod')) as any
    opts.allowedTools.push('WebFetch')
    expect(defaultEnvelope('prod').allowedTools).not.toContain('WebFetch')
  })
})

/**
 * ═══════ УПРЁТСЯ ЛИ ОДОБРЕНИЕ В СТЕНУ ═══════
 *
 * Человек видит билет, нажимает «Одобрить» — и получает отказ, потому что вызов упирается
 * в ЖЁСТКИЙ запрет, уехавший в аргументы запуска. Мягкая граница отпустила, жёсткая не
 * пустила. Поведение правильное; несказанным оно быть не должно.
 *
 * Ответ на этот вопрос — сопоставление КЛАССА билета с объявленными в конверте человеческими
 * действиями, и ничего больше: ни разбора текста команды, ни второй копии чужого матчера
 * разрешений. Поэтому здесь проверяются ДВА конца провода на настоящих модулях — список
 * классов берётся у классификатора работника, список действий у конверта, — а не две копии
 * имён, живущие в тесте.
 */
describe('DANGER_CLASS_HUMAN_ACTIONS — карта «класс билета → человеческое действие»', () => {
  it('карта покрывает все классы, которые вообще могут упереться в стену', () => {
    expect(Object.keys(DANGER_CLASS_HUMAN_ACTIONS).sort()).toEqual(
      ['force-push', 'merge', 'publish', 'push', 'remote-config', 'tag'].sort(),
    )
    expect(Object.isFrozen(DANGER_CLASS_HUMAN_ACTIONS)).toBe(true)
  })

  it('карта покрывает ТОЛЬКО имена, которые классификатор работника действительно выдаёт', () => {
    for (const cls of Object.keys(DANGER_CLASS_HUMAN_ACTIONS)) {
      expect(WORKER_DANGER_CLASSES, `класса «${cls}» у классификатора нет`).toContain(cls)
    }
  })

  it('карта ведёт ТОЛЬКО в человеческие действия конверта — одна таблица отказов, не вторая копия', () => {
    for (const action of Object.values(DANGER_CLASS_HUMAN_ACTIONS)) {
      expect(HUMAN_ONLY_ACTIONS, `действия «${action}» у конверта нет`).toContain(action)
      expect(Object.keys(HUMAN_ONLY_DENIALS)).toContain(action)
    }
  })

  it('замок на счёт классов: новый класс классификатора обязан быть отображён ОСОЗНАННО', () => {
    // Пятнадцать — то, что классификатор объявляет сегодня. Число закреплено НАРОЧНО: класс,
    // добавленный к классификатору и забытый здесь, — это стена, о которой человека не
    // предупредили. Красный тест заставляет человека решить, отображается новый класс или
    // сознательно остаётся вне карты; молча он не проедет.
    expect(WORKER_DANGER_CLASSES).toHaveLength(15)
  })
})

describe('approvalWall — три состояния ответа, а не два', () => {
  const deniedArgs = (patterns: string[]) => ['--model', 'x', '--disallowedTools', patterns.join(' ')]
  const allPush = ['Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)']

  it('билет класса отправки при запрещённой отправке → упрётся, и действие названо', () => {
    const wall = approvalWall({ ticketClass: 'push', spawnArgs: deniedArgs(allPush) })
    expect(wall.state).toBe('blocked')
    expect(wall.action).toBe('push')
    expect(wall.source).toBe('spawn-args')
  })

  it('перенастройка удалённого репозитория ведёт к тому же действию — три класса, одна стена', () => {
    for (const cls of ['force-push', 'remote-config']) {
      expect(approvalWall({ ticketClass: cls, spawnArgs: deniedArgs(allPush) }).state).toBe('blocked')
    }
  })

  it('отображённый класс, чьё действие НЕ запрещено этой попытке → не упрётся', () => {
    const wall = approvalWall({ ticketClass: 'tag', spawnArgs: deniedArgs(allPush) })
    expect(wall.state).toBe('clear')
    expect(wall.action).toBe('tag')
  })

  it('запуск вообще без списка отказов → не упрётся: процесс получил пустую стену', () => {
    expect(approvalWall({ ticketClass: 'merge', spawnArgs: ['--model', 'x'] }).state).toBe('clear')
  })

  it('класс, которого нет в карте, → НЕИЗВЕСТНО, а не «не упрётся»', () => {
    const wall = approvalWall({ ticketClass: 'reset-hard', spawnArgs: deniedArgs(allPush) })
    expect(wall.state).toBe('unknown')
    expect(wall.action).toBe(null)
  })

  it('ни аргументов, ни конверта → неизвестно: молчание честнее догадки', () => {
    expect(approvalWall({ ticketClass: 'push' }).state).toBe('unknown')
    expect(approvalWall({ ticketClass: 'push', spawnArgs: [] }).state).toBe('unknown')
  })

  it('часть шаблонов действия запрещена, часть нет → неизвестно, а не выдуманный вердикт', () => {
    const wall = approvalWall({ ticketClass: 'push', spawnArgs: deniedArgs(['Bash(git push:*)']) })
    expect(wall.state).toBe('unknown')
  })

  it('аргументов нет — отвечает конверт полосы, и он называет себя источником', () => {
    const wall = approvalWall({ ticketClass: 'push', laneEnvelope: defaultEnvelope('prod') })
    expect(wall.state).toBe('blocked')
    expect(wall.source).toBe('lane-envelope')
  })

  it('аргументы и конверт РАСХОДЯТСЯ → выигрывают аргументы: они и есть то, что уехало', () => {
    // Конверт полосы объявляет все четыре человеческих действия; аргументы этой попытки не
    // запретили ни одного. Правда — у аргументов: конверт говорит о намерении, аргументы о
    // том, что процесс на самом деле получил.
    const wall = approvalWall({
      ticketClass: 'push',
      spawnArgs: ['--model', 'x'],
      laneEnvelope: defaultEnvelope('prod'),
    })
    expect(wall.state).toBe('clear')
    expect(wall.source).toBe('spawn-args')
  })

  it('ответ заморожен — читатель не переписывает его под себя', () => {
    expect(Object.isFrozen(approvalWall({ ticketClass: 'push', spawnArgs: deniedArgs(allPush) }))).toBe(true)
  })

  it('текст команды не читается ВООБЩЕ: сопоставляются только наши собственные имена', () => {
    // Мера смыслом, а не вкусом: модуль конверта не имеет права научиться разбирать команду.
    // Появится здесь чтение `tool_input`, `.command` или разбор строки команды — это второй
    // матчер разрешений, и план пошёл не туда.
    expect(src).not.toMatch(/tool_input/)
    expect(src).not.toMatch(/\btool_name\b/)
    expect(approvalWall({ ticketClass: 'push', spawnArgs: deniedArgs(allPush), command: 'git push --force' } as any).state).toBe('blocked')
  })
})
