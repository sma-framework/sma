/**
 * Tests for daemon/src/runner/personal-layer.mjs — the worker account's personal layer.
 *
 * The invariant under test: a headless worker session is the SAME session the founder's
 * own terminal gives him — his global CLAUDE.md, his hooks and his narrowing permission
 * rules reach the worker — while nothing PRIVATE and nothing WIDENING travels with them.
 *
 *   Case A — merge: theme (and everything already in the account) survives; hooks are the
 *     founder's; permissions carry `deny` + `ask` ONLY (`allow` widens the envelope and
 *     `defaultMode: auto` would flip a headless session into the classifier mode, so
 *     neither is mirrored); claude.ai connectors are switched off; no secret-shaped key,
 *     no model/statusLine/plugins of the founder, ever lands in the worker's file.
 *   Case B — plugins come from the worker profile, settings overrides pass an allow-list
 *     (hooks merge per event; env/model are dropped and the drop is reported).
 *   Case C — a backup precedes the FIRST overwrite of an existing file; an unchanged
 *     second call rewrites nothing; backups are trimmed to the last five.
 *   Case D — the neighbouring files of the account directory (the OAuth state above all)
 *     are byte-identical afterwards, and no staging file is left behind.
 *   Case E — the write is atomic: a temp sibling, then a rename; never a direct write
 *     over the live settings file.
 *   Case F — an empty source is legal: the connectors switch still lands.
 *   Case G — with both directories passed in, the module never reaches for a home dir.
 *   Case H — the fake filesystem is not richer than the library: every fs method the
 *     module calls exists on node:fs (a fake that could do more would prove nothing).
 *
 * Every case runs on freshly minted temporary directories. The real configuration
 * directories of this machine are never read and never written by this file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readFounderLayer,
  mergeWorkerSettings,
  mirrorPersonalLayer,
  PersonalLayerError,
  SECRET_KEY_RE,
  NEVER_MIRROR_KEYS,
  OVERRIDE_ALLOWLIST,
  BACKUP_KEEP,
  TOOL_GATE_MARKER,
  TOOL_GATE_EVENT,
  toolGateHookEntry,
  withToolGateHook,
  withoutToolGateHook,
  PERSONAL_LAYER_DECLARATION,
} from '../src/runner/personal-layer.mjs'
import {
  compareRules,
  notMirroredDeclaration,
  NOT_MIRRORED,
  WIDENING_KEYS,
} from '../../scripts/sma/lib/rules-parity.mjs'

import { TICKET_HOOK_TIMEOUT_S } from '../../scripts/sma/lib/tool-gate.mjs'

/** Наш парковочный хук в списке события — тот, что помечен маркером модуля. */
const gateEntries = (hooks: Record<string, unknown[]> | undefined) =>
  ((hooks && (hooks[TOOL_GATE_EVENT] as Array<Record<string, unknown>>)) || []).filter(
    (e) => e && e.smaHook === TOOL_GATE_MARKER,
  )
/** Всё, что в этом событии НЕ наше — то, что приехало от человека. */
const foreignEntries = (hooks: Record<string, unknown[]> | undefined) =>
  ((hooks && (hooks[TOOL_GATE_EVENT] as Array<Record<string, unknown>>)) || []).filter(
    (e) => !e || e.smaHook !== TOOL_GATE_MARKER,
  )

// ── fixtures ──────────────────────────────────────────────────────────────────
// Shaped after a real founder home: hooks with absolute commands, a wide allow list,
// a narrow deny list, an api-key helper and two innocently named secret carriers.

const FOUNDER_CLAUDE_MD = '# global rules\nanswer briefly and never invent a receipt\n'

const FOUNDER_HOOKS = {
  SessionStart: [
    { hooks: [{ type: 'command', command: 'node C:/abs/path/terminal-journal.mjs log', timeout: 10 }] },
  ],
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:/abs/path/guard.mjs' }] }],
}

const FOUNDER_DENY = ['Read(.env)', 'Read(.secrets)']
const FOUNDER_ASK = ['Bash(rm:*)']

/** The private keys that must never appear in a worker file — asserted one by one. */
const PRIVATE_KEYS = [
  'env',
  'apiKeyHelper',
  'model',
  'statusLine',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'myToken',
  'githubKey',
]

function founderSettings(extra: Record<string, unknown> = {}) {
  return {
    env: { MCP_TIMEOUT: '30000' },
    apiKeyHelper: 'node /abs/path/helper.mjs',
    permissions: {
      allow: ['Bash(ls:*)', 'WebFetch(domain:example.com)', 'Read(/abs/notes)'],
      deny: [...FOUNDER_DENY],
      ask: [...FOUNDER_ASK],
      defaultMode: 'auto',
    },
    model: 'opus',
    hooks: FOUNDER_HOOKS,
    statusLine: { type: 'command', command: 'node C:/abs/path/statusline.js' },
    enabledPlugins: { 'founder-plugin@market': true },
    extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'someone/plugins' } } },
    myToken: 'not-a-real-value',
    githubKey: 'not-a-real-value',
    ...extra,
  }
}

/** A temporary stand-in for the founder's configuration directory. */
function mkFounder(dir: string, settings: unknown = founderSettings()) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), FOUNDER_CLAUDE_MD)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
}

/** A temporary stand-in for the worker account directory, neighbours included. */
function mkAccount(dir: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{"theme":"dark"}')
  writeFileSync(join(dir, '.credentials.json'), '{"oauth":"state-that-must-survive"}')
  writeFileSync(join(dir, '.claude.json'), '{"projects":{"one":{"allowedTools":[]}}}')
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** A clock that never repeats itself, so backup names cannot collide. */
function steppingClock(startMs = Date.UTC(2026, 7, 19, 10, 0, 0)) {
  let n = 0
  return () => new Date(startMs + n++ * 1000)
}

let sourceDir: string
let accountDir: string
beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'sma-founder-'))
  accountDir = mkdtempSync(join(tmpdir(), 'sma-account-'))
})
afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true })
  rmSync(accountDir, { recursive: true, force: true })
})

// ── Case A ────────────────────────────────────────────────────────────────────
describe('Case A — the merge keeps the account whole and the founder narrow', () => {
  it('mirrors CLAUDE.md, hooks and deny/ask; drops allow, defaultMode and every private key', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)

    const res = mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {} })
    const s = readJson(join(accountDir, 'settings.json'))

    expect(s.theme).toBe('dark')
    // Хуки человека доезжают целиком; наш парковочный хук ДОПИСАН к событию, а не заменяет его.
    expect(s.hooks.SessionStart).toEqual(FOUNDER_HOOKS.SessionStart)
    expect(foreignEntries(s.hooks)).toEqual(FOUNDER_HOOKS.PreToolUse)
    expect(gateEntries(s.hooks)).toHaveLength(1)
    expect(s.permissions).toEqual({ deny: FOUNDER_DENY, ask: FOUNDER_ASK })
    expect(s.permissions.allow).toBeUndefined()
    expect(s.permissions.defaultMode).toBeUndefined()
    expect(s.disableClaudeAiConnectors).toBe(true)

    expect(readFileSync(join(accountDir, 'CLAUDE.md'), 'utf8')).toBe(FOUNDER_CLAUDE_MD)

    expect(res.claudeMd).toMatch(/^[0-9a-f]{8}$/)
    expect(res.hooks).toBe(2)
    expect(res.permissions).toEqual({ deny: 2, ask: 1, allow: 'not mirrored', defaultMode: 'not mirrored' })
    expect(res.plugins).toEqual([])
    expect(res.connectors).toBe('disabled')
    expect(typeof res.backup).toBe('string')
    expect(res.backup).not.toBe('none')
    expect(res.changed).toBe(true)
    expect(res.sourceDir).toBe(sourceDir)
    expect(typeof res.writtenAt).toBe('string')
  })

  it('leaves not one private key of the founder in the worker file', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)
    mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {} })

    const s = readJson(join(accountDir, 'settings.json'))
    for (const key of PRIVATE_KEYS) expect(s[key]).toBeUndefined()

    // …and no value of theirs leaks under a different name either.
    const serialized = JSON.stringify(s)
    expect(serialized).not.toContain('not-a-real-value')
    expect(serialized).not.toContain('MCP_TIMEOUT')
    expect(serialized).not.toContain('statusline.js')
  })

  it('names the private class by shape, not by today content', () => {
    for (const name of ['myToken', 'apiKey', 'clientSecret', 'dbPassword']) {
      expect(SECRET_KEY_RE.test(name)).toBe(true)
    }
    expect(SECRET_KEY_RE.test('theme')).toBe(false)
    expect([...NEVER_MIRROR_KEYS]).toContain('apiKeyHelper')
    expect([...NEVER_MIRROR_KEYS]).toContain('statusLine')
    expect(BACKUP_KEEP).toBe(5)
  })

  it('reads the founder layer as a shape a caller can reason about', () => {
    mkFounder(sourceDir)
    const layer = readFounderLayer({ sourceDir })
    expect(layer.claudeMd).toBe(FOUNDER_CLAUDE_MD)
    expect(layer.claudeMdSha).toMatch(/^[0-9a-f]{8}$/)
    expect(layer.hooks).toEqual(FOUNDER_HOOKS)
    expect(layer.permissions).toEqual({ deny: FOUNDER_DENY, ask: FOUNDER_ASK })
  })

  it('refuses a broken source file by name, with the path in the message', () => {
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'settings.json'), '{ this is not json')
    expect(() => readFounderLayer({ sourceDir })).toThrow(PersonalLayerError)
    try {
      readFounderLayer({ sourceDir })
    } catch (err: any) {
      expect(String(err.message)).toContain('settings.json')
    }
  })
})

// ── Case B ────────────────────────────────────────────────────────────────────
describe('Case B — plugins come from the profile, overrides pass an allow-list', () => {
  it('writes the worker plugin list and merges only allow-listed overrides', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)

    const stopHook = { Stop: [{ hooks: [{ type: 'command', command: 'node /abs/path/stop.mjs' }] }] }
    const res = mirrorPersonalLayer({
      sourceDir,
      accountDir,
      plugins: ['x@market', 'y@market'],
      overrides: {
        autoMemoryDirectory: '/abs/memory',
        hooks: stopHook,
        env: { A: '1' },
        model: 'a-different-model',
      },
    })

    const s = readJson(join(accountDir, 'settings.json'))
    expect(s.enabledPlugins).toEqual({ 'x@market': true, 'y@market': true })
    expect(s.autoMemoryDirectory).toBe('/abs/memory')
    // the override merges per event ON TOP of the founder's hooks, it does not replace them
    expect(Object.keys(s.hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop'])
    expect(s.hooks.Stop).toEqual(stopHook.Stop)
    expect(s.env).toBeUndefined()
    expect(s.model).toBeUndefined()

    expect(res.overridesApplied.sort()).toEqual(['autoMemoryDirectory', 'hooks'])
    expect(res.overridesDropped.sort()).toEqual(['env', 'model'])
    expect(res.plugins).toEqual(['x@market', 'y@market'])
    expect(OVERRIDE_ALLOWLIST).toContain('autoMemoryEnabled')
  })

  it('merges as a pure function, without touching any directory', () => {
    const merged = mergeWorkerSettings({
      current: { theme: 'dark' },
      founder: { hooks: FOUNDER_HOOKS, permissions: { deny: FOUNDER_DENY, ask: FOUNDER_ASK } },
      plugins: [],
      overrides: {},
    })
    expect(merged.settings.theme).toBe('dark')
    expect(merged.settings.disableClaudeAiConnectors).toBe(true)
    expect(merged.settings.enabledPlugins).toBeUndefined() // empty list writes no key at all
    expect(merged.overridesDropped).toEqual([])
  })
})

// ── Case C ────────────────────────────────────────────────────────────────────
describe('Case C — a backup before the first overwrite, and no needless rewrite', () => {
  it('keeps what it is about to overwrite, then stays quiet when nothing changed', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)
    const clock = steppingClock()

    const first = mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {}, clock })
    expect(first.changed).toBe(true)

    const backups = readdirSync(join(accountDir, 'backups'))
    expect(backups.length).toBe(1)
    expect(backups[0]).toMatch(/^settings\.json\.bak-/)
    expect(backups[0]).not.toContain(':')
    expect(readFileSync(join(accountDir, 'backups', backups[0]), 'utf8')).toContain('"theme"')

    const before = statSync(join(accountDir, 'settings.json')).mtimeMs
    const second = mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {}, clock })
    expect(second.changed).toBe(false)
    expect(second.backup).toBe('none')
    expect(statSync(join(accountDir, 'settings.json')).mtimeMs).toBe(before)
    expect(readdirSync(join(accountDir, 'backups')).length).toBe(1)
  })

  it('keeps at most the last five backups when the source keeps moving', () => {
    mkAccount(accountDir)
    const clock = steppingClock()
    for (let i = 0; i < 6; i++) {
      mkFounder(sourceDir, founderSettings({ hooks: { ...FOUNDER_HOOKS, [`Event${i}`]: [] } }))
      mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {}, clock })
    }
    const backups = readdirSync(join(accountDir, 'backups')).sort()
    expect(backups.length).toBe(BACKUP_KEEP)
    // the oldest stamp was dropped, the newest survived
    expect(backups.every((b) => b.startsWith('settings.json.bak-'))).toBe(true)
  })
})

// ── Case D ────────────────────────────────────────────────────────────────────
describe('Case D — the neighbours of the account directory are untouched', () => {
  it('leaves the OAuth state byte-identical and leaves no staging file behind', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)
    const credsBefore = readFileSync(join(accountDir, '.credentials.json'))
    const claudeBefore = readFileSync(join(accountDir, '.claude.json'))

    mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {} })

    expect(readFileSync(join(accountDir, '.credentials.json')).equals(credsBefore)).toBe(true)
    expect(readFileSync(join(accountDir, '.claude.json')).equals(claudeBefore)).toBe(true)
    const left = readdirSync(accountDir).filter((n) => n.includes('.tmp'))
    expect(left).toEqual([])
  })
})

// ── Case E ────────────────────────────────────────────────────────────────────
describe('Case E — the write is a temp sibling and a rename, never a direct overwrite', () => {
  it('stages the settings file under a temporary name and renames it into place', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)

    const calls: Array<{ method: string; args: string[] }> = []
    const record = (method: string, fn: Function) => (...args: any[]) => {
      calls.push({ method, args: args.map((a) => String(a)) })
      return fn(...args)
    }
    const fsImpl: Record<string, unknown> = {}
    for (const m of ['existsSync', 'readFileSync', 'writeFileSync', 'renameSync', 'mkdirSync', 'readdirSync', 'unlinkSync', 'statSync']) {
      fsImpl[m] = record(m, (nodeFs as any)[m])
    }

    mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {}, fsImpl })

    const settingsPath = join(accountDir, 'settings.json')
    const writes = calls.filter((c) => c.method === 'writeFileSync')
    const renames = calls.filter((c) => c.method === 'renameSync')

    expect(writes.some((c) => c.args[0] === settingsPath)).toBe(false)
    expect(writes.some((c) => c.args[0].includes('.tmp'))).toBe(true)
    expect(renames.some((c) => c.args[1] === settingsPath)).toBe(true)

    const tmpWrite = writes.findIndex((c) => c.args[0].includes('.tmp'))
    expect(tmpWrite).toBeGreaterThanOrEqual(0)
    expect(readJson(settingsPath).disableClaudeAiConnectors).toBe(true)
  })
})

// ── Case F ────────────────────────────────────────────────────────────────────
describe('Case F — an empty source is legal', () => {
  it('still switches the connectors off when the founder has neither file', () => {
    mkdirSync(sourceDir, { recursive: true })
    mkAccount(accountDir)

    const res = mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {} })
    expect(res.claudeMd).toBe('absent')
    expect(res.hooks).toBe(0)
    expect(existsSync(join(accountDir, 'CLAUDE.md'))).toBe(false)

    const s = readJson(join(accountDir, 'settings.json'))
    expect(s.disableClaudeAiConnectors).toBe(true)
    expect(s.theme).toBe('dark')
  })
})

// ── Case G ────────────────────────────────────────────────────────────────────
describe('Case G — with both paths given, no home directory is consulted', () => {
  it('never calls the injected home resolver', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)
    const throwingHome = () => {
      throw new Error('the module reached for a real home directory')
    }
    expect(() =>
      mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {}, homedir: throwingHome }),
    ).not.toThrow()
  })
})

// ── Case H ────────────────────────────────────────────────────────────────────
describe('Case H — the fake is not richer than the library', () => {
  it('every filesystem method the module names exists on node:fs', () => {
    const src = readFileSync(new URL('../src/runner/personal-layer.mjs', import.meta.url), 'utf8')
    const found = new Set<string>()
    for (const m of src.matchAll(/fsImpl\s*(?:\?\.|\.)\s*([A-Za-z][A-Za-z0-9]*)/g)) found.add(m[1])
    expect(found.size).toBeGreaterThanOrEqual(5)
    for (const name of found) {
      expect(typeof (nodeFs as any)[name]).toBe('function')
    }
  })
})

// ── Case I ────────────────────────────────────────────────────────────────────
describe('Case I — провод: парковочный хук едет с АККАУНТОМ, а хуки человека остаются целыми', () => {
  it('провод: хук того же события у человека → в результате ДВА, а не один', () => {
    const merged = mergeWorkerSettings({
      current: {},
      founder: { hooks: FOUNDER_HOOKS, permissions: { deny: FOUNDER_DENY, ask: FOUNDER_ASK } },
      platform: 'win32',
    })
    const list = merged.settings.hooks[TOOL_GATE_EVENT]
    expect(list).toHaveLength(2)
    expect(foreignEntries(merged.settings.hooks)).toEqual(FOUNDER_HOOKS.PreToolUse)
    expect(gateEntries(merged.settings.hooks)).toHaveLength(1)
  })

  it('провод: хук доезжает даже в аккаунт, у которого хуков не было вовсе', () => {
    const merged = mergeWorkerSettings({ current: { theme: 'dark' }, founder: {}, platform: 'win32' })
    expect(gateEntries(merged.settings.hooks)).toHaveLength(1)
  })

  it('провод: объявленный срок ожидания взят из КОНСТАНТЫ модуля билета, а не написан числом', () => {
    const entry = toolGateHookEntry({ platform: 'win32' })
    expect(entry.hooks[0].timeout).toBe(TICKET_HOOK_TIMEOUT_S)
    expect(entry.hooks[0].command).toMatch(/cli\.mjs" tool-gate$/)
    expect(entry.hooks[0].command.startsWith('node ')).toBe(true)
  })

  it('зеркалирование идемпотентно: второй проход НЕ множит наш хук', () => {
    const once = mergeWorkerSettings({ current: {}, founder: { hooks: FOUNDER_HOOKS }, platform: 'win32' })
    const twice = mergeWorkerSettings({ current: once.settings, founder: { hooks: FOUNDER_HOOKS }, platform: 'win32' })
    expect(gateEntries(twice.settings.hooks)).toHaveLength(1)
    expect(twice.settings.hooks[TOOL_GATE_EVENT]).toHaveLength(2)
  })

  it('снятие убирает ТОЛЬКО наш хук; чужой остаётся, а пустое событие исчезает', () => {
    const withGate = withToolGateHook(FOUNDER_HOOKS as never, { platform: 'win32' })
    const cleaned = withoutToolGateHook(withGate)
    expect(cleaned[TOOL_GATE_EVENT]).toEqual(FOUNDER_HOOKS.PreToolUse)
    expect(cleaned.SessionStart).toEqual(FOUNDER_HOOKS.SessionStart)

    const bare = withoutToolGateHook(withToolGateHook({}, { platform: 'win32' }))
    expect(bare[TOOL_GATE_EVENT]).toBeUndefined()
  })
})

// ── Case J ────────────────────────────────────────────────────────────────────
/**
 * THE LOCK. Case A already reads the worker's file and finds no `allow` there; this case
 * exists because that reading is an ASSERTION ABOUT A FILE, and the rule it protects is a
 * rule about RIGHTS. Measured on this machine: with the author's own settings a worker's
 * `git push` GOES THROUGH, and without them the same call is refused. So mirroring the
 * widening half is not untidy — it is the act of handing a headless session the rights of
 * the person at the keyboard. The case below fails the moment anyone starts doing it, and
 * it fails in the vocabulary the parity checker reads, so the refusal and the report can
 * never drift into disagreeing about which keys are the widening ones.
 */
describe('Case J — расширяющие правила человека не зеркалируются, и это замок', () => {
  it('allow и defaultMode человека НЕ попадают к работнику, а отказ объявлен теми же словами, что читает проверка', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)

    const res = mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {} })
    const s = readJson(join(accountDir, 'settings.json'))

    // (1) НА ДИСКЕ: ни одного расширяющего ключа у работника — по списку, а не по памяти.
    for (const key of WIDENING_KEYS) expect(s.permissions[key]).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain('Bash(ls:*)')

    // (2) В ОБЪЯВЛЕНИИ: отказ назван словами, и слова — общая константа обеих сторон.
    for (const key of WIDENING_KEYS) expect(res.permissions[key]).toBe(NOT_MIRRORED)
    expect(PERSONAL_LAYER_DECLARATION).toEqual(notMirroredDeclaration())

    // (3) Сужающее при этом доехало полностью — замок не превращён в «ничего не везём».
    expect(s.permissions.deny).toEqual(FOUNDER_DENY)
    expect(s.permissions.ask).toEqual(FOUNDER_ASK)
  })

  it('провод: то, что зеркало написало работнику, проходит проверку паритета целиком', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)
    const res = mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {} })

    const verdict = compareRules({
      terminal: readJson(join(sourceDir, 'settings.json')),
      worker: readJson(join(accountDir, 'settings.json')),
      declaration: res.permissions,
    })
    expect(verdict.denyEqual).toBe(true)
    expect(verdict.askEqual).toBe(true)
    expect(verdict.widened).toEqual([])
    expect(verdict.verdict).toBe('ok')
  })

  it('замок держит: зеркало, начавшее переносить расширяющий список, краснеет на проверке', () => {
    mkFounder(sourceDir)
    mkAccount(accountDir)
    const res = mirrorPersonalLayer({ sourceDir, accountDir, plugins: [], overrides: {} })
    const terminal = readJson(join(sourceDir, 'settings.json'))
    const worker = readJson(join(accountDir, 'settings.json'))

    // Ровно та правка, которую этот замок обязан не пропустить: расширяющая половина
    // человека появляется у работника, а объявление «не зеркалируем» перестаёт быть правдой.
    const widened = { ...worker, permissions: { ...worker.permissions, allow: terminal.permissions.allow } }
    const out = compareRules({ terminal, worker: widened, declaration: { ...res.permissions, allow: terminal.permissions.allow } })
    expect(out.verdict).toBe('fail')
    expect(out.widened).toEqual(['allow'])
    expect(out.allowDeclared).toBe(false)
  })
})
