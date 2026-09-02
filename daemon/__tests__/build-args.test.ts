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

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { createBuildArgs, NoWorkerForRouteError, UnknownStageError, CLAUDE_BIN, CODEX_BIN } from '../src/runner/build-args.mjs'
import {
  ProfileParityError,
  assertProfileParity,
  buildClaudeArgs,
  codexHomeFor,
  CODEX_WINDOWS_SANDBOX_MARKER,
} from '../src/runner/args.mjs'
import { DEFAULT_PIPELINE_MAX_TURNS } from '../src/config.mjs'
import { CHAT_MAX_TURNS } from '../src/front/chat.mjs'

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

// THE ACCOUNT MIRROR, AS A FAKE FILE. Before it spawns, the executor reads the settings the
// personal-layer mirror wrote into the account's own config dir — that file is where the
// plugin list and the hosted-connectors switch live, and neither is visible in an argument
// array. The suite injects it: no case here touches a real home directory.
const MIRRORED_SETTINGS = JSON.stringify({ disableClaudeAiConnectors: true })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsFs = (content: string = MIRRORED_SETTINGS): any => ({
  readFileSync: (p: string) => {
    if (String(p).replace(/\\/g, '/').endsWith('settings.json')) return content
    throw new Error(`ENOENT ${p}`)
  },
})

// The product is plain JS with JSDoc types; the spec it returns is a bag of strings. `any`
// here keeps the suite about behaviour rather than about the editor's view of an untyped module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (cfg: any = CONFIG, env: any = ENV, fsImpl: any = settingsFs(), platform?: string): any =>
  createBuildArgs({ config: cfg, env, fsImpl, ...(platform ? { platform } : {}) })

/**
 * A REAL account directory with a REAL login in it. The Codex cases below are wire cases —
 * they assert what is on the disk and in the argv of the spec — so this fixture builds an
 * account under the OS temp directory rather than describing one. `HOME`/`USERPROFILE` are
 * pointed at an empty directory on purpose: the login fallbacks must never reach the personal
 * `~/.codex` of whoever is running the suite.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const codexFixture = (opts: { login?: boolean } = {}): any => {
  const root = mkdtempSync(join(tmpdir(), 'sma-buildargs-codex-'))
  const accountDir = join(root, 'pro-1')
  mkdirSync(accountDir, { recursive: true })
  if (opts.login !== false) writeFileSync(join(accountDir, 'auth.json'), '{"tokens":{"id_token":"subscription"}}')
  return {
    root,
    accountDir,
    cfg: { workers: [{ ...codexWorker, account: { ...codexWorker.account, configDir: accountDir } }] },
    env: { HOME: join(root, 'empty-home'), USERPROFILE: join(root, 'empty-home') },
    // ONE `fsImpl` SERVES EVERY DISK THIS COMPOSER TOUCHES — the account mirror, the Codex home
    // and the binary resolution — so a fake that answers only one of them silently disables the
    // others. These cases are about real files, so the reader answers the mirror from the fake
    // and delegates everything else to the disk the fixture actually built.
    fsImpl: {
      readFileSync: (p: string, enc: string) =>
        String(p).replace(/\\/g, '/').endsWith('settings.json') ? MIRRORED_SETTINGS : readFileSync(p, enc as never),
    },
  }
}

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

  /**
   * ═══════ ПРОВОД ПОТОЛКА ХОДОВ: ЧИСЛО ИЗ НАСТРОЕК ДОЕХАЛО ДО КОМАНДНОЙ СТРОКИ ═══════
   *
   * Утверждается ИМЕННО провод, а не вычисление. Работник без потолка способен ходить кругами,
   * пока не кончатся деньги, — и ровно поэтому потолок обязан оказаться в массиве аргументов
   * запускаемого процесса, а не в каком-нибудь поле, которое кто-то потом прочитает. Половина
   * дня однажды ушла на конверт разрешений, который считался, хэшировался и писался в журнал —
   * и не доезжал до запуска; проверялось вычисление, а сломан был провод.
   *
   * Соседство флага и числа проверяется подряд, а не по вхождению: аргумент, отставший от
   * своего флага на один шаг, — это уже другая командная строка.
   */
  const capAt = (args: string[]) => {
    const at = args.indexOf('--max-turns')
    return at < 0 ? null : args[at + 1]
  }

  it('конфиг назвал число — оно стоит в аргументах запуска сразу за своим флагом', () => {
    const spec = build({ workers: [claudeWorker], pipeline: { enabled: true, maxTurns: 25 } })(task(), route())
    expect(capAt(spec.args)).toBe('25')
  })

  it('ключа в конфиге нет — едет умолчание, названное константой, и задача без потолка не остаётся', () => {
    const spec = build()(task(), route())
    expect(capAt(spec.args)).toBe(String(DEFAULT_PIPELINE_MAX_TURNS))
  })

  it('мусорное значение отбрасывается в пользу умолчания, а не едет в командную строку', () => {
    for (const junk of ['восемьдесят', 0, -5, null, {}, Number.NaN, 12.5]) {
      const spec = build({ workers: [claudeWorker], pipeline: { maxTurns: junk } })(task(), route())
      expect(capAt(spec.args), String(junk)).toBe(String(DEFAULT_PIPELINE_MAX_TURNS))
      expect(spec.args.join(' ')).not.toContain('восемьдесят')
    }
  })

  /**
   * У РАЗГОВОРА СВОЙ ПОТОЛОК, И ОН НАШ НЕ НАСЛЕДУЕТ. Ход разговора — четыре хода, задача —
   * рабочий день работника; одно число на двоих означало бы, что поднятый ради задачи потолок
   * молча удлиняет и каждую реплику в окне. Собственное значение разговора утверждается его
   * же сьютом; здесь утверждается, что путь задачи не берёт его константу.
   */
  it('путь задачи не наследует потолок разговора', () => {
    const spec = build()(task(), route())
    expect(capAt(spec.args)).not.toBe(String(CHAT_MAX_TURNS))
    expect(DEFAULT_PIPELINE_MAX_TURNS).toBeGreaterThan(CHAT_MAX_TURNS)
  })

  it('другой CLI своего потолка не получает — флаг принадлежит одному строителю', () => {
    const spec = build()(task({ lane: 'research' }), route({ workerId: 'pro-1', provider: 'codex' }))
    expect(spec.args).not.toContain('--max-turns')
  })

  /**
   * ═══════ ЧИСЛО ИЗ НАСТРОЕК — БАЗА, А НЕ ОДИН ПОТОЛОК НА ВСЯКУЮ РАБОТУ ═══════════════════
   *
   * Работа, трогающая несколько файлов и обязанная доказать себя живым прогоном, физически не
   * помещается туда же, куда правка одной строки: код пишется за десяток ходов, а
   * доказательство — это запуски оболочки, чтение их вывода и починка того, что вывод показал.
   * Арифметика размера разобрана в `turn-budget.test.ts`; здесь утверждается ПРОВОД — что
   * посчитанное число доезжает до командной строки, и что мелочь по-прежнему идёт под тем
   * числом, которое человек поставил сам.
   */
  const bigTask = () =>
    task({
      acceptance: [
        'живой прогон окна со снимком карточки'.padEnd(500, ' .'),
        'сьют продукта зелёный одним прогоном'.padEnd(500, ' .'),
        'документация обновлена в том же изменении'.padEnd(500, ' .'),
      ],
    })

  it('крупная работа уезжает с бóльшим потолком, чем правка одной строки', () => {
    const cfg = { workers: [claudeWorker], pipeline: { enabled: true, maxTurns: 40 } }
    const small = build(cfg)(task(), route())
    const large = build(cfg)(bigTask(), route())

    expect(capAt(small.args)).toBe('40')
    expect(Number(capAt(large.args))).toBeGreaterThan(40)
  })

  /**
   * ═══════ ВТОРАЯ ПОПЫТКА С ТЕМ ЖЕ ПОТОЛКОМ — ОПЛАЧЕННЫЙ ПОВТОР ИЗВЕСТНОГО ИСХОДА ═════════
   *
   * Если попытка упёрлась в потолок N, следующая попытка ТОЙ ЖЕ работы под потолком N упрётся
   * в ту же стену на том же шаге. Сгоревшие потолки приносит тик из реестра попыток; здесь
   * утверждается, что строитель ими действительно пользуется — и что при исчерпании подъёмов
   * он ОТКАЗЫВАЕТСЯ собирать запуск, а не выдаёт молча то же число.
   */
  it('после сгоревшего потолка на командную строку едет строго больший', () => {
    const cfg = { workers: [claudeWorker], pipeline: { enabled: true, maxTurns: 40 } }
    const again = build(cfg)(task(), route(), { burnedTurnCaps: [40] })
    expect(Number(capAt(again.args))).toBeGreaterThan(40)
  })

  it('когда поднимать больше не от чего — отказ по имени, а не тот же потолок', () => {
    const cfg = { workers: [claudeWorker], pipeline: { enabled: true, maxTurns: 40 } }
    expect(() => build(cfg)(task(), route(), { burnedTurnCaps: [40 * 6] })).toThrow(/TurnCap|ceiling|потолок/i)
  })

  /**
   * ═══════ ВОЗВРАТ ПРОДОЛЖАЕТ СЕССИЮ, ТАЙМЕР ПОЛУЧАЕТ СВЕЖУЮ ═══════
   *
   * Человек вернул работу с замечанием — работник обязан помнить, что делал: контекст за эту
   * сессию уже оплачен, и начинать с нуля значит платить второй раз за то же чтение. Таймер
   * будит задачу спустя время — и старая сессия несёт старую картину мира, которая к моменту
   * пробуждения уже неверна.
   *
   * И ПРОХОДИТ ЭТО ЧЕРЕЗ СТРОИТЕЛЬ, А НЕ МИМО НЕГО. Замок «свежая сессия» стоит на входе
   * строителя аргументов, написан, покрыт делом и зелёный — а решение о продолжении дописывалось
   * в хвост уже собранного массива, то есть замок не накрывал единственный путь задачи вообще.
   * Классический случай «вычислено — не значит подключено»: второго замка здесь не заводится,
   * этот путь просто наконец идёт через первый.
   */
  const RESUME_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

  it('возврат человека несёт продолжение прошлой сессии в аргументы запуска', () => {
    const spec = build()(task(), route(), { wakeKind: 'return', resumeId: RESUME_UUID })
    const at = spec.args.indexOf('--resume')
    expect(at).toBeGreaterThan(-1)
    expect(spec.args[at + 1]).toBe(RESUME_UUID)
  })

  it('таймерное пробуждение продолжения не несёт', () => {
    const spec = build()(task(), route(), { wakeKind: 'timer' })
    expect(spec.args).not.toContain('--resume')
  })

  it('вид пробуждения ДОЕЗЖАЕТ до строителя: подсунутое таймеру продолжение ловит уже написанный замок', () => {
    expect(() => build()(task(), route(), { wakeKind: 'timer', resumeId: RESUME_UUID })).toThrow(/fresh session/i)
    // и это тот же самый замок, а не его копия: строитель бросает ту же ошибку напрямую
    expect(() => buildClaudeArgs({ wakeKind: 'timer', resumeId: RESUME_UUID })).toThrow(/fresh session/i)
  })

  /**
   * THE WIRE ITSELF, asserted where it actually matters: not «the prompt builder can render
   * criteria» but «the criteria of THIS task are in the spec the tick is about to spawn with,
   * and they are above the closing condition». The two are different claims, and the product
   * has already paid once for confusing them — the capability envelope was computed, hashed
   * and journalled for a whole fleet's life without ever reaching the arguments of a spawn.
   */
  it('what the task promises reaches the SPAWN SPEC, ahead of the closing condition', () => {
    const spec = build()(
      task({
        description: 'Импорт падает на втором файле.',
        acceptance: ['импорт проходит на всех файлах', 'кейс на второй файл зелёный'],
      }),
      route(),
    )
    const closing = spec.prompt.indexOf('Условие сдачи')
    expect(closing).toBeGreaterThan(-1)
    expect(spec.prompt).toContain('Импорт падает на втором файле.')
    for (const criterion of ['импорт проходит на всех файлах', 'кейс на второй файл зелёный']) {
      expect(spec.prompt.indexOf(criterion), criterion).toBeGreaterThan(-1)
      expect(spec.prompt.indexOf(criterion), criterion).toBeLessThan(closing)
    }
    // and they travel as DATA on stdin, exactly like the title — never as an argument
    expect(spec.args.join(' ')).not.toContain('импорт проходит')
  })

  /**
   * ТОТ ЖЕ ПРОВОД, ЧТО ВЫШЕ, — ДЛЯ СНИМКА КОНТЕКСТА. Строитель промпта уже держит задачу
   * ЦЕЛИКОМ, и снимок берётся из неё; но «строитель умеет нарисовать блок» и «снимок ЭТОЙ
   * задачи оказался в спеке, с которым тик сейчас спавнит» — разные утверждения, и продукт
   * за их смешение уже платил. Утверждается второе, и утверждается ЗДЕСЬ, на шве спавна.
   */
  it('снимок контекста задачи ДОЕЗЖАЕТ до спека спавна — данными на stdin, а не аргументом', () => {
    const spec = build()(task({ taskContext: 'СНИМОК-СПАВНА: ключи лежат в менеджере паролей' }), route())
    expect(spec.prompt).toContain('СНИМОК-СПАВНА: ключи лежат в менеджере паролей')
    expect(spec.prompt).toMatch(/`{3,}task-context\n/)
    expect(spec.args.join(' ')).not.toContain('СНИМОК-СПАВНА')
  })

  it('a task with no words spawns the brief it always spawned', () => {
    const spec = build()(task(), route())
    expect(spec.prompt).not.toContain('признаки успеха')
    expect(spec.prompt).toContain('Условие сдачи')
  })

  it('routes a Codex worker to the other CLI, with a per-task CODEX_HOME', () => {
    const { cfg, env, fsImpl } = codexFixture()
    const spec = build(cfg, env, fsImpl)(task({ lane: 'research' }), route({ workerId: 'pro-1', provider: 'codex' }))

    expect(spec.bin).toBe(CODEX_BIN)
    expect(spec.args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(spec.args[spec.args.length - 1]).toBe('-') // prompt on stdin, same law as the other lane
    expect(String(spec.env.CODEX_HOME)).toContain('codex-tasks')
    expect(String(spec.env.CODEX_HOME)).toContain('T-0001')
    expect(spec.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})

/**
 * ═══════ ПОЛОСА КОДЕКСА: ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ ═══════
 *
 * Всё, что здесь утверждается, — про диск и про argv настоящего спека, а не про то, что
 * функция была позвана. Причина ровно та же, по которой в этом файле утверждается потолок
 * ходов: `codexConfigSeed()` был написан, покрыт делом и НЕ ИМЕЛ НИ ОДНОГО ВЫЗЫВАЮЩЕГО —
 * среда называла ребёнку свежий дом, никто его не создавал, и «родная память выключена»
 * было правдой про исходник и неправдой про любой запуск. Второй файл в том доме важнее
 * первого: свежий CODEX_HOME ЗАМЕНЯЕТ личный `~/.codex` вместе с логином, и пустой дом
 * отвечает 401, уходя на публичную точку API, — то есть сессия не знает, что она на подписке.
 */
describe('buildArgs — the Codex home is created, seeded and authenticated', () => {
  const codexRoute = () => route({ workerId: 'pro-1', provider: 'codex' })
  const codexTask = () => task({ lane: 'research' })

  it('the directory named in the environment EXISTS on disk afterwards, and carries the memories-off config', () => {
    const { cfg, env, fsImpl } = codexFixture()
    const spec = build(cfg, env, fsImpl)(codexTask(), codexRoute())

    const home = String(spec.env.CODEX_HOME)
    expect(existsSync(home)).toBe(true)
    const toml = readFileSync(join(home, 'config.toml'), 'utf8')
    expect(toml).toContain('memories = false')
    expect(toml).toContain('approval_policy = "never"')
  })

  it('the login lands in THAT home — the one the spawn environment names, not a neighbour', () => {
    const { cfg, env, fsImpl, accountDir } = codexFixture()
    const spec = build(cfg, env, fsImpl)(codexTask(), codexRoute())

    const home = String(spec.env.CODEX_HOME)
    expect(existsSync(join(home, 'auth.json'))).toBe(true)
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(readFileSync(join(accountDir, 'auth.json'), 'utf8'))
  })

  it('two tasks of one account get two homes, each with its own seeded pair', () => {
    const { cfg, env, fsImpl } = codexFixture()
    const a = build(cfg, env, fsImpl)(task({ id: 'T-A', lane: 'research' }), codexRoute())
    const b = build(cfg, env, fsImpl)(task({ id: 'T-B', lane: 'research' }), codexRoute())

    expect(a.env.CODEX_HOME).not.toBe(b.env.CODEX_HOME)
    for (const home of [String(a.env.CODEX_HOME), String(b.env.CODEX_HOME)]) {
      expect(existsSync(join(home, 'config.toml'))).toBe(true)
      expect(existsSync(join(home, 'auth.json'))).toBe(true)
    }
  })

  it('no login anywhere and no key in the environment → a NAMED refusal, never a 401 inside the child', () => {
    const { cfg, env, fsImpl } = codexFixture({ login: false })
    expect(() => build(cfg, env, fsImpl)(codexTask(), codexRoute())).toThrow(/401|auth\.json/i)
  })

  it('an API key in the environment is the one honest reason a home with no login may still spawn', () => {
    const { cfg, env, fsImpl } = codexFixture({ login: false })
    const spec = build(cfg, { ...env, OPENAI_API_KEY: 'sk-live' }, fsImpl)(codexTask(), codexRoute())
    expect(existsSync(join(String(spec.env.CODEX_HOME), 'config.toml'))).toBe(true)
  })

  /**
   * ПЕСОЧНИЦА ВИДНА В argv НАСТОЯЩЕГО СПЕКА, а не выводится читателем постфактум: у
   * `codex exec` нет флага одобрений вовсе, и это единственное место, где границу запуска
   * можно прочитать. Грант конверта приезжает сюда тем же путём, что и в соседнюю полосу.
   */
  it('the sandbox the envelope amounts to is IN THE ARGUMENT ARRAY of the spawn', () => {
    const { cfg, env, fsImpl } = codexFixture()
    // ПЛАТФОРМА НАЗВАНА, А НЕ УНАСЛЕДОВАНА ОТ МАШИНЫ СЬЮТА: `workspace-write` на Windows
    // требует проведённой установки песочницы (см. случаи ниже), и случай про argv не должен
    // отвечать по-разному на двух ноутбуках. Здесь спрашивается ядерная платформа — там
    // готовить нечего, и грант доезжает до флага ровно так, как он и задуман.
    const editor = build(cfg, env, fsImpl, 'linux')(codexTask(), codexRoute(), {
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Skill'],
    })
    const reader = build(cfg, env, fsImpl)(codexTask(), codexRoute(), { allowedTools: ['Read', 'Grep', 'Glob'] })
    const nobody = build(cfg, env, fsImpl)(codexTask(), codexRoute())

    const modeOf = (args: string[]) => args[args.indexOf('--sandbox') + 1]
    expect(modeOf(editor.args)).toBe('workspace-write')
    expect(modeOf(reader.args)).toBe('read-only')
    expect(modeOf(nobody.args)).toBe('read-only')

    // and the tool flags of the OTHER lane never appear here — this CLI has none
    expect(editor.args).not.toContain('--allowedTools')
    expect(editor.args).toContain('--strict-config')
  })

  /**
   * ═══════ ПЕСОЧНИЦА, КОТОРУЮ МАШИНА НЕ ИСПОЛНИТ, — ОТКАЗ, А НЕ ФЛАГ ═════════════════════
   *
   * Флаг на командной строке — это ПРОСЬБА. На Windows границу держит отдельно заведённый
   * ограниченный пользователь, и в свежем доме задачи следа элевированной установки нет:
   * `codex exec --sandbox workspace-write` там не отказывается, а молча остаётся читающим.
   * Замерено живьём 01.09.2026 — работник десять минут объяснял, что писать ему не дают,
   * попытка ушла как «нет квитанции», и назвать причину было нечем.
   *
   * ДВЕ ПОЛОВИНЫ ОДНОГО ТРЕБОВАНИЯ, И ОБЕ ОБЯЗАТЕЛЬНЫ: задача с правом писать либо ПИШЕТ,
   * либо ОТКАЗАНА ДО СПАВНА. Без второго случая отказ был бы просто выключенной полосой.
   */
  describe('workspace-write: либо машина его исполнит, либо спавна не будет', () => {
    it('непровизированная Windows: НАЗВАННЫЙ отказ вместо спека — и в словах есть, что делать', () => {
      const { cfg, env, fsImpl } = codexFixture()
      const writing = { allowedTools: ['Read', 'Edit', 'Write', 'Bash'] }
      let err: Error | null = null
      try {
        build(cfg, env, fsImpl, 'win32')(codexTask(), codexRoute(), writing)
      } catch (e) {
        err = e as Error
      }
      expect(err, 'спек собрался — значит сессия ушла бы в стену молча').toBeTruthy()
      expect(err!.name).toBe('CodexSandboxUnsupportedError')
      expect(err!.message).toContain('workspace-write')
      expect(err!.message).toContain('codex sandbox setup')
    })

    it('провизированная Windows: тот же конверт даёт workspace-write и обычный спек', () => {
      const { cfg, env, fsImpl } = codexFixture()
      // След элевированной установки — В ТОМ ДОМЕ, который спавн и создаст: путь собран тем
      // же выражением, каким его найдёт демон, а не строкой, написанной здесь руками.
      const home = codexHomeFor({ account: cfg.workers[0].account, taskId: 'T-0001' })
      mkdirSync(join(home, '.sandbox'), { recursive: true })
      writeFileSync(join(home, CODEX_WINDOWS_SANDBOX_MARKER), '{"version":5}')

      const spec = build(cfg, env, fsImpl, 'win32')(codexTask(), codexRoute(), {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
      })
      expect(spec.args[spec.args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    })

    /**
     * ПРАВО ПИСАТЬ БЕЗ КАТАЛОГА, В КОТОРЫЙ СДАЮТ, — ЭТО ПОЛОВИНА ПРАВА. `workspace-write`
     * открывает РАБОЧИЙ КАТАЛОГ и ничего больше, а копия попытки — рабочее дерево git: индекс,
     * ссылки и объекты лежат в основном репозитории, снаружи копии. Замерено 01.09.2026:
     * сессия правила файлы и не смогла их закоммитить, попытка ушла как «нет квитанции».
     * Утверждение — про ДИСК того дома, который названа среда ребёнка, а не про вызов.
     */
    it('git-каталог копии лежит в конфиге ТОГО дома, который назван среде ребёнка', () => {
      const { cfg, env, fsImpl } = codexFixture()
      const gitDir = join(tmpdir(), 'sma-main-tree', '.git')

      const spec = build(cfg, env, fsImpl, 'linux')(codexTask(), codexRoute(), {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
        writableRoots: [gitDir],
      })

      const toml = readFileSync(join(String(spec.env.CODEX_HOME), 'config.toml'), 'utf8')
      expect(toml).toContain('[sandbox_workspace_write]')
      expect(toml).toContain(gitDir.replace(/\\/g, '\\\\'))
    })

    it('тик корней не назвал → дом выходит ровно прежним, без пустой секции', () => {
      const { cfg, env, fsImpl } = codexFixture()
      const spec = build(cfg, env, fsImpl, 'linux')(codexTask(), codexRoute(), { allowedTools: ['Read', 'Edit'] })
      expect(readFileSync(join(String(spec.env.CODEX_HOME), 'config.toml'), 'utf8')).not.toContain(
        'sandbox_workspace_write',
      )
    })

    it('читающий конверт на той же машине проходит: отказ про право писать, а не про полосу', () => {
      const { cfg, env, fsImpl } = codexFixture()
      const spec = build(cfg, env, fsImpl, 'win32')(codexTask(), codexRoute(), { allowedTools: ['Read', 'Grep'] })
      expect(spec.args[spec.args.indexOf('--sandbox') + 1]).toBe('read-only')
    })
  })

  /**
   * ═══════ И ПОСЛЕДНЕЕ: МОЖЕТ ЛИ ЭТА МАШИНА ВООБЩЕ ЗАПУСТИТЬ НАЗВАННУЮ ПРОГРАММУ ═══════
   *
   * Полоса была исправна во всех остальных частях — дом создан, засеян, с логином, песочница в
   * argv, CLI принимает каждый аргумент, — и не запускала НИ ОДНОЙ задачи: `spawn codex`
   * отвечал ENOENT. На Windows CLI, поставленный через npm, — это `.cmd` ШИМ, а не программа:
   * пакетный файл не запускается без оболочки, а оболочку запрещает договор безопасного
   * ребёнка. Соседняя полоса работала всё это время по одной случайной причине — её CLI
   * поставляется настоящим `.exe`.
   *
   * Утверждается СПЕК, а не резолвер: у резолвера свой сьют, а здесь вопрос другой — доехал ли
   * его ответ до того, чем тик сейчас будет спавнить.
   */
  it('an npm shim on PATH reaches the SPEC as node plus the script, with the CLI arguments behind it', () => {
    const { cfg, env, fsImpl } = codexFixture()
    const binDir = mkdtempSync(join(tmpdir(), 'sma-buildargs-shim-'))
    const scriptDir = join(binDir, 'node_modules', 'codex', 'bin')
    mkdirSync(scriptDir, { recursive: true })
    writeFileSync(join(scriptDir, 'codex.js'), '// entry point')
    // npm's own shim shape, including the line that names the interpreter as a PROGRAM: a file
    // that merely quotes a `node_modules` path names no interpreter and is left alone.
    writeFileSync(
      join(binDir, 'codex.cmd'),
      '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\node_modules\\codex\\bin\\codex.js" %*\r\n',
    )

    const spec = build(cfg, { ...env, PATH: binDir }, fsImpl)(codexTask(), codexRoute())

    expect(spec.bin).toBe(process.execPath)
    expect(spec.args[0]).toBe(join(scriptDir, 'codex.js'))
    // the CLI's own command line is untouched, and still ends on stdin
    expect(spec.args.slice(1, 3)).toEqual(['exec', '--json'])
    expect(spec.args[spec.args.length - 1]).toBe('-')
  })

  it('with nothing resolvable on PATH the spec names the CLI plainly, exactly as before', () => {
    const { cfg, env, fsImpl } = codexFixture()
    const spec = build(cfg, env, fsImpl)(codexTask(), codexRoute())

    expect(spec.bin).toBe(CODEX_BIN)
    expect(spec.args.slice(0, 2)).toEqual(['exec', '--json'])
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
    expect(spec.prompt).toBe('/sma-plan-phase 12 --text --skip-research')
    expect(spec.prompt).not.toContain('```')
    expect(spec.prompt).not.toContain('ДАННЫЕ')
  })

  it('rebuilds the command from the dictionary — an edited title cannot become an instruction', () => {
    // the row says one thing; the frozen four say another; the worker gets the frozen four
    const spec = build()(stageTask({ title: '/sma-plan-phase 12 --text && rm -rf /' }), route())
    expect(spec.prompt).toBe('/sma-plan-phase 12 --text --skip-research')
  })

  it('every stage of the cycle gets its own command, and the phase is the only hole', () => {
    const of = (stage: string, phase: string) =>
      build()(stageTask({ data: { kind: 'document', stage, phase } }), route()).prompt
    expect(of('discuss', '12')).toBe('/sma-discuss-phase 12 --batch --text')
    // Ступень плана несёт ОТВЕТ на свой единственный вопрос: в сессии без человека список
    // вариантов и ожидание цифры — это сгоревшее окно. Ответ, не автоответ: см. phase-cycle.mjs.
    expect(of('plan', '7')).toBe('/sma-plan-phase 7 --text --skip-research')
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
    expect(spec.args.slice(i + 1, i + 1 + tools.length)).toEqual(tools)
  })

  it('no grant is passed when the envelope names no tools — absence stays absence', () => {
    expect(build()(task(), route(), {}).args).not.toContain('--allowedTools')
    expect(build()(task(), route(), { allowedTools: [] }).args).not.toContain('--allowedTools')
  })

  // THE OTHER HALF OF THE SAME WIRE. The envelope also names what a worker may NOT do —
  // the actions a person keeps for himself. Those four names were computed, hashed and
  // journalled for every attempt this fleet ran, and read by nobody: «the worker cannot
  // push» was true of the prompt and of nothing else. This asserts the last stretch of road.
  it('the envelope refusal reaches the spawned process', () => {
    const denials = ['Bash(git config:*)', 'Bash(git push:*)', 'Bash(git remote:*)']
    const spec = build()(task(), route(), { allowedTools: ['Read', 'Bash'], disallowedTools: denials })
    const i = spec.args.indexOf('--disallowedTools')
    expect(i, 'the spawn carries no refusal — the boundary would exist only in the journal').toBeGreaterThan(-1)
    // ONE ARGUMENT PER PATTERN, and every one of these has a space inside it: glued into a
    // single value they would arrive as fragments that forbid nothing at all
    expect(spec.args.slice(i + 1, i + 1 + denials.length)).toEqual(denials)
    // and the grant is not narrowed to compensate: a denial was ADDED, nothing was taken away
    const g = spec.args.indexOf('--allowedTools')
    expect(spec.args.slice(g + 1, g + 3)).toEqual(['Read', 'Bash'])
  })

  it('an old caller that names no refusal gets a byte-identical argument array', () => {
    const before = build()(task(), route(), { allowedTools: ['Read', 'Bash'] }).args
    expect(build()(task(), route(), { allowedTools: ['Read', 'Bash'], disallowedTools: [] }).args).toEqual(before)
    expect(before).not.toContain('--disallowedTools')
  })

  it('no stage prompt carries an automation flag — the guard travels with the dictionary', () => {
    for (const stage of ['discuss', 'plan', 'execute', 'verify']) {
      const prompt = build()(stageTask({ data: { kind: 'document', stage, phase: '12' } }), route()).prompt
      expect(prompt, stage).not.toMatch(/--(auto|bare|dangerously-skip-permissions|permission-mode)(\s|=|$)/)
    }
  })
})

// ════════ the account mirror is read before the spawn, and the guard sees it ════════
//
// The personal layer is not an argument: it is a settings file in the account's own config
// dir. So the executor reads that file and hands it to the parity guard, and the guard is the
// one that refuses. Reading it here rather than inside the guard keeps the guard pure — it
// stays a function over data, and the one place that touches a disk is the one that already
// composes the spawn.

describe('buildArgs — the personal layer the account actually holds', () => {
  it('a mirrored account spawns: connectors off, and the profile names no plugin', () => {
    const spec = build()(task(), route())
    expect(spec.workerId).toBe('max-1')
    expect(spec.bin).toBe(CLAUDE_BIN)
  })

  it('reads settings.json from THIS account config dir, and nothing else', () => {
    const seen: string[] = []
    const spy = {
      readFileSync: (p: string) => {
        seen.push(String(p).replace(/\\/g, '/'))
        return MIRRORED_SETTINGS
      },
    }
    build(CONFIG, ENV, spy)(task(), route())
    expect(seen).toEqual(['/accounts/max-1/settings.json'])
  })

  it('an account with no mirrored switch is REFUSED — no mirror, no parity', () => {
    // fail-open on the read, fail-closed on the guard: an unreadable or empty settings file
    // becomes an empty object, and an empty object does not say connectors are off.
    const cases = [
      { readFileSync: () => '{}' },
      { readFileSync: () => '{ not json at all' },
      {
        readFileSync: () => {
          throw new Error('ENOENT')
        },
      },
    ]
    for (const fsImpl of cases) {
      expect(() => build(CONFIG, ENV, fsImpl)(task(), route())).toThrow(ProfileParityError)
      expect(() => build(CONFIG, ENV, fsImpl)(task(), route())).toThrow(/connectors/)
    }
  })

  it('the plugins the profile assigns must be the ones the account enabled', () => {
    const cfg = { workers: [{ ...claudeWorker, plugins: ['reviewer@house'] }, codexWorker] }
    expect(() => build(cfg, ENV)(task(), route())).toThrow(/plugins/)

    const matched = settingsFs(
      JSON.stringify({ disableClaudeAiConnectors: true, enabledPlugins: { 'reviewer@house': true } }),
    )
    expect(build(cfg, ENV, matched)(task(), route()).workerId).toBe('max-1')
  })

  it('a per-spawn MCP config travels into the argument array only when the tick names one', () => {
    const spec = build()(task(), route(), { mcpConfigPath: '/wt/T-0001/mcp-config.json' })
    expect(spec.args).toContain('--mcp-config')
    expect(spec.args[spec.args.indexOf('--mcp-config') + 1]).toBe('/wt/T-0001/mcp-config.json')
    // absence stays absence: no option, no flag
    expect(build()(task(), route()).args).not.toContain('--mcp-config')
  })
})
