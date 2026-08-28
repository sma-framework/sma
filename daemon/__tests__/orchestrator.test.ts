/**
 * orchestrator.test.ts — ОРКЕСТРАТОР: постоянная фигура машины, а не работник в очереди.
 *
 * Пять вопросов, по одному describe на каждый, и все пять — про устройство, а не про намерение:
 *
 *   1. ОН НЕ РАЗБИРАЕТ ИНЛАЙН-ЗАДАЧИ, НИ ПРИ КАКОМ ПОРЯДКЕ. Его профиль вставляется в пул на
 *      КАЖДОЕ место по очереди, и маршрутизатор ни разу его не выбирает — в том числе когда он
 *      единственный, у кого открыто окно. Порядок строк в конфиге не должен решать ничего.
 *   2. ПРОВОД: он появляется САМ при подключении. Настоящий файл конфига во временном доме,
 *      написанный рукой ровно так, как учит инструкция для одной машины (один работник
 *      «local-1»), — и после загрузки роль есть И В ПАМЯТИ, И В ФАЙЛЕ, без единой ручной правки.
 *   3. РАЗГОВОР ВЕДЁТ ОН. Ход разговора поднимается с подставным спавном, и в промпт, который
 *      уехал в сессию, он назван по имени и назван НЕ исполнителем.
 *   4. ТВЁРДЫХ РЕШЕНИЙ ОН НЕ ПРИНИМАЕТ, и они перечислены ПОИМЁННО — четыре, названные
 *      владельцем: выкат наружу, границы фазы, деньги, чужой захват. Список закрыт (сам список
 *      сверяется целиком), и каждое из четырёх обязано доехать до промпта разговора.
 *   5. В ОКНЕ ОН ОТДЕЛЬНО ОТ ИСПОЛНИТЕЛЕЙ. Дерайв состояния кладёт его СВОИМ ключом, и в
 *      `workers[]` — том самом списке, который экран рисует карточками работников, — его нет.
 *
 * Ни один случай не поднимает процесс, не ходит в сеть и не трогает настоящий ~/.sma-daemon:
 * дом инжектится, спавн подставной, часы свои.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HARD_CALLS,
  ORCHESTRATOR_ID,
  ORCHESTRATOR_NAME,
  ensureOrchestrator,
  isOrchestrator,
  orchestratorView,
  voiceAccount,
} from '../src/policy/orchestrator.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { loadConfig, resolveConfigPath, secretsView } from '../src/config.mjs'
import { buildChatPrompt, dispatchFreeTurn, resolvePolicyVoice } from '../src/front/chat.mjs'
import { deriveState } from '../src/front/state.mjs'

// Ночные часы: дневная защита аккаунта владельца выключена, поэтому единственная причина, по
// которой кто-то не выбран, — это он сам. `new Date(y,m,d,h)` и `getHours()` — обе местные.
const nightClock = () => new Date(2026, 7, 28, 2, 0, 0).getTime()
const allOpen = () => true

/** Три обычных исполнителя — те, кто пишет код и берёт инлайн-задачи. */
function executors() {
  return [
    { id: 'max-1', lane: 'prod', provider: 'claude', account: { name: 'max-1' }, enabled: true },
    { id: 'max-2', lane: 'prod', provider: 'claude', account: { name: 'max-2' }, enabled: true },
    { id: 'pro-1', lane: 'research', provider: 'codex', account: { name: 'pro-1' }, enabled: true },
  ]
}

/** Профиль верхушки — такой, каким его вписала бы рука в список работников. */
function topFigure() {
  return { id: ORCHESTRATOR_ID, role: 'orchestrator', provider: 'claude', account: { name: 'max-1' }, enabled: true }
}

describe('оркестратор не разбирает инлайн-задачи — ни при каком порядке', () => {
  it('вставленный на КАЖДОЕ место пула, он не выбран ни разу', () => {
    const base = executors()
    for (let at = 0; at <= base.length; at += 1) {
      const workers = [...base.slice(0, at), topFigure(), ...base.slice(at)]
      for (const lane of ['prod', 'research']) {
        const r = resolveRoute({ id: `T-${at}-${lane}`, lane }, { workers, windows: allOpen, clock: nightClock })
        expect(r.workerId).not.toBe(ORCHESTRATOR_ID)
        expect(r.workerId).not.toBeNull() // исполнители на месте, работа уходит к ним
      }
    }
  })

  it('он не берёт задачу даже когда он единственный, у кого открыто окно', () => {
    const workers = [topFigure(), ...executors()]
    const onlyTheTop = (w: any) => w.id === ORCHESTRATOR_ID
    const r = resolveRoute({ id: 'T-alone', lane: 'prod' }, { workers, windows: onlyTheTop, clock: nightClock })
    // Задача ЖДЁТ — и ждёт по причине про окна, а не потому, что верхушка «занята»: её
    // отсутствие в пуле никогда не становится ни поводом подождать, ни поводом заплатить.
    expect(r.workerId).toBeNull()
    expect(r.reasonCode).toBe('window_exhausted')
    expect(r.useApiFallback).toBe(false)
  })

  it('он не кандидат и без поля role — занятый идентификатор называет его так же', () => {
    const workers = [{ id: ORCHESTRATOR_ID, lane: 'prod', provider: 'claude', account: { name: 'max-1' }, enabled: true }]
    expect(isOrchestrator(workers[0])).toBe(true)
    const r = resolveRoute({ id: 'T-bare', lane: 'prod' }, { workers, windows: allOpen, clock: nightClock })
    expect(r.workerId).toBeNull()
  })

  it('мята ВЫНИМАЕТ вписанную рукой строку из списка исполнителей и делает из неё роль', () => {
    const config = { workers: [...executors(), topFigure()] }
    const out = ensureOrchestrator(config)
    expect(out.workers.map((w: any) => w.id)).toEqual(['max-1', 'max-2', 'pro-1'])
    expect(out.orchestrator.id).toBe(ORCHESTRATOR_ID)
    expect(out.orchestrator.lane).toBeUndefined() // полосы у того, кто задач не берёт, не бывает
    expect(out.orchestrator.account).toEqual({ name: 'max-1' }) // указанное рукой не потеряно
  })

  it('мята идемпотентна: конфиг с готовым блоком возвращается ТЕМ ЖЕ объектом', () => {
    const once = ensureOrchestrator({ workers: executors() })
    expect(ensureOrchestrator(once)).toBe(once)
  })
})

describe('провод: на машине без ручной правки настроек оркестратор есть после подключения', () => {
  let home: string
  let repo: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sma-orch-home-'))
    repo = mkdtempSync(join(tmpdir(), 'sma-orch-repo-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })
  const homedir = () => home

  /** Конфиг одной машины, написанный ровно так, как учит инструкция: один работник. */
  function writeHandConfig() {
    const path = resolveConfigPath({ env: {}, homedir })
    mkdirSync(join(home, '.sma-daemon'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        token: 'a'.repeat(64),
        workers: [
          {
            id: 'local-1',
            lane: 'prod',
            provider: 'claude',
            account: {
              name: 'local-1',
              configDir: join(home, '.sma-accounts', 'local-1'),
              oauthTokenEnv: 'SMA_LOCAL_1_TOKEN',
            },
            enabled: true,
          },
        ],
      }),
      'utf8',
    )
    return path
  }

  it('рукописный конфиг с одним «local-1» после загрузки несёт роль — и в памяти, и в файле', () => {
    const path = writeHandConfig()
    const cfg: any = loadConfig({ env: {}, homedir, repoDir: repo })

    expect(cfg.orchestrator).toBeTruthy()
    expect(cfg.orchestrator.id).toBe(ORCHESTRATOR_ID)
    // Он НЕ стал ещё одним работником: список исполнителей тот же, что был написан рукой.
    expect(cfg.workers.map((w: any) => w.id)).toEqual(['local-1'])

    // И это не только в памяти процесса: роль, существующая до перезапуска, — не «появилась».
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.orchestrator.id).toBe(ORCHESTRATOR_ID)
    expect(onDisk.workers.map((w: any) => w.id)).toEqual(['local-1'])
  })

  it('вторая загрузка ничего не мятит — файл побайтово тот же', () => {
    const path = writeHandConfig()
    loadConfig({ env: {}, homedir, repoDir: repo })
    const first = readFileSync(path, 'utf8')
    loadConfig({ env: {}, homedir, repoDir: repo })
    expect(readFileSync(path, 'utf8')).toBe(first)
  })

  it('чистая машина (файла нет вовсе) получает роль тем же ходом', () => {
    const cfg: any = loadConfig({ env: {}, homedir, repoDir: repo })
    expect(cfg.orchestrator.id).toBe(ORCHESTRATOR_ID)
    expect(cfg.workers.some((w: any) => w.id === ORCHESTRATOR_ID)).toBe(false)
    // Своей подписки у роли нет: он говорит через дневной аккаунт машины.
    expect(voiceAccount(cfg).name).toBe('max-1')
  })

  it('свой аккаунт роли схлопывается в secretsView так же, как аккаунт работника', () => {
    const view: any = secretsView(
      {
        token: 'x',
        workers: [],
        orchestrator: { id: ORCHESTRATOR_ID, account: { name: 'top', configDir: '/tmp/top', oauthTokenEnv: 'SMA_TOP_TOKEN' } },
      },
      { env: { SMA_TOP_TOKEN: 'sk-ant-oat01-secret' } },
    )
    expect(view.orchestrator.account.oauthTokenEnv).toBe('[set]')
    expect(JSON.stringify(view)).not.toContain('SMA_TOP_TOKEN')
    expect(JSON.stringify(view)).not.toContain('sk-ant-oat01-secret')
  })
})

describe('разговор ведёт он', () => {
  it('промпт хода называет его по имени и называет НЕ исполнителем', () => {
    const prompt = buildChatPrompt({
      voice: { text: 'голос' },
      text: 'а это кто такой?',
      workers: executors(),
    })
    expect(prompt).toContain(ORCHESTRATOR_NAME)
    expect(prompt).toContain('Вы не исполнитель')
    expect(prompt).toContain('оркестратор этой машины')
  })

  it('ход поднимается на аккаунте машины, и в сессию уезжает промпт верхушки', async () => {
    let seen: any = null
    const spawnWorker = (o: any) => {
      seen = o
      o.onLine?.(JSON.stringify({ type: 'result', result: 'Смотрю за всем этим я, оркестратор.' }))
      o.onExit?.({ code: 0 })
      return { pid: 1, kill: () => {} }
    }
    const config = ensureOrchestrator({
      workers: [{ id: 'local-1', lane: 'prod', provider: 'claude', account: { name: 'local-1' }, enabled: true }],
    })
    const res: any = await dispatchFreeTurn({
      text: 'а это кто такой?',
      deps: { config, spawnWorker, timeoutMs: 5000, policyDir: null },
    })
    expect(res.kind).toBe('text')
    expect(seen).toBeTruthy()
    expect(seen.prompt).toContain(ORCHESTRATOR_NAME)
    // Своей подписки у роли нет — говорит через единственный аккаунт этой машины.
    expect(voiceAccount(config).name).toBe('local-1')
  })

  it('базовый голос продукта остаётся под именем — рамка не подменяет голос', () => {
    const voice = resolvePolicyVoice({})
    const prompt = buildChatPrompt({ voice, text: 'привет', workers: executors() })
    expect(prompt.indexOf(voice.text)).toBe(0)
    expect(prompt.indexOf(ORCHESTRATOR_NAME)).toBeGreaterThan(0)
  })
})

describe('твёрдые решения он не принимает — четыре, поимённо', () => {
  it('список закрыт и назван ровно теми четырьмя, что назвал владелец', () => {
    expect(HARD_CALLS.map((c) => c.id)).toEqual(['release', 'phase-boundary', 'money', 'seizure'])
    expect(HARD_CALLS.map((c) => c.label)).toEqual(['Выкат наружу', 'Границы фазы', 'Деньги', 'Чужой захват'])
  })

  it('каждое из четырёх доезжает до промпта разговора вместе со словом «решает человек»', () => {
    const prompt = buildChatPrompt({ voice: { text: 'голос' }, text: 'выкатывай', workers: executors() })
    expect(prompt).toContain('ТВЁРДЫЕ РЕШЕНИЯ ПРИНИМАЕТ ЧЕЛОВЕК')
    for (const call of HARD_CALLS) {
      expect(prompt).toContain(call.label)
      expect(prompt).toContain(call.words)
    }
    expect(prompt).toContain('Вы зовёте человека')
  })

  it('те же четыре — и на экране: вид роли отдаёт их поимённо', () => {
    const view: any = orchestratorView(ensureOrchestrator({ workers: executors() }))
    expect(view.hardCalls.map((c: any) => c.label)).toEqual(HARD_CALLS.map((c) => c.label))
  })
})

describe('в окне он назван отдельно от исполнителей', () => {
  const NOW = Date.UTC(2026, 7, 28, 12, 0, 0)
  const openWindows = () => ({ fiveHour: { status: 'open' }, week: { status: 'open' } })

  it('дерайв состояния кладёт его СВОИМ ключом, и в списке работников его нет', async () => {
    const config: any = ensureOrchestrator({
      token: 't',
      workers: [{ id: 'local-1', lane: 'prod', provider: 'claude', account: { name: 'local-1' }, enabled: true }],
    })
    const payload: any = await deriveState({
      adapter: { list: async () => [] },
      windows: openWindows,
      config,
      clock: () => NOW,
    })
    expect(payload.orchestrator.id).toBe(ORCHESTRATOR_ID)
    expect(payload.orchestrator.name).toBe(ORCHESTRATOR_NAME)
    expect(payload.orchestrator.account).toBe('local-1')
    expect(payload.workers.map((w: any) => w.id)).toEqual(['local-1'])
    // Счётчики шапки «Команды» считают исполнителей, и верхушка их не сдвигает.
    expect(payload.kpis.workersTotal).toBe(1)
  })

  it('машина, на которой роли не заведено, отвечает null — а не пустой карточкой', async () => {
    const payload: any = await deriveState({
      adapter: { list: async () => [] },
      windows: openWindows,
      config: { token: 't', workers: [] },
      clock: () => NOW,
    })
    expect(payload).toHaveProperty('orchestrator')
    expect(payload.orchestrator).toBeNull()
  })
})
