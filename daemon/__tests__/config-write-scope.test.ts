/**
 * ДВЕРЬ МЕНЯЕТ В ФАЙЛЕ ТОЛЬКО ТО, ЧТО НАЗВАЛА, — И ЭТО СПРАШИВАЕТСЯ С КАЖДОЙ ДВЕРИ.
 *
 * ЧТО БЫЛО ЗАМЕРЕНО (28.08.2026). В `~/.sma-daemon/config.json` руками поставлено
 * `maxConcurrentAttempts: 4`. Демон при этом отказывает в месте словами «идущих попыток 6 при
 * потолке 6», в файле СНОВА 6, а время последней записи совпадает с нажатием паузы конвейера в
 * окне. Дверь, которая двигала ОДИН выключатель, вернула на диск весь свой снимок настроек.
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ УЖЕ ПОЧИНЕННОГО. Ночью 27.08 запись переделали в чтение-правку-запись,
 * и с тех пор переживает правку ключ, О КОТОРОМ МОДЕЛЬ ЗАПИСИ НЕ ЗНАЕТ (`config.test.ts`,
 * «a config key the write model never heard of survives the doors»). Дыра осталась ровно в
 * противоположном месте: ЗНАКОМЫЙ ключ был в файле на загрузке, значит он есть и в копии в
 * памяти, значит он приезжает в объекте двери и ложится поверх файла УСТАРЕВШИМ значением.
 * Слияние здесь бессильно — оно не отличает «дверь это значение принесла нарочно» от «дверь
 * протащила его за компанию». Поэтому дверь теперь НАЗЫВАЕТ свои поля (`writeConfig` →
 * `fields`), а всё остальное приходит с диска нетронутым.
 *
 * КАК ЭТО ПРОВЕРЯЕТСЯ — ПО ФАЙЛУ, А НЕ ПО ВОЗВРАЩЁННОМУ ОБЪЕКТУ. Каждый случай поднимает
 * настоящий файл, загружает его настоящим `loadConfig` (копия демона запоминает потолок 6),
 * правит файл РУКАМИ за спиной работающего демона (потолок 4) и жмёт настоящую дверь — а
 * потом ЧИТАЕТ ФАЙЛ. Возвращённый дверью объект здесь ничего не доказывает: в инциденте он
 * как раз был правильным, а на диске лежало старое.
 *
 * И ПОЧЕМУ ТАБЛИЦА ДВЕРЕЙ ЖИВЁТ ВНУТРИ ТЕСТА. Дефект классовый: он не про конвейер и не про
 * потолок, а про то, что дверей много, а закон один. Список ниже сверяется с ИСХОДНИКОМ —
 * каждая функция, зовущая `writeConfig`, обязана быть в таблице, — так что новая дверь,
 * написанная через год, краснеет на этом файле в тот же день, а не ночью у человека.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadConfig,
  resolveConfigPath,
  writeConfig,
  addProject,
  renameProject,
  selectProject,
  applyPipelineToggle,
  applyBudgetStop,
  addAccount,
  addPeer,
  removePeer,
  applyTelegramConnect,
  applyTelegramPair,
  applyTelegramDisconnect,
} from '../src/config.mjs'
import {
  applyAgentModel,
  applyAgentToggle,
  applySkillAssign,
  applyStockTeamToggle,
} from '../src/front/harness.mjs'
import { createFrontServer } from '../src/front/server.mjs'

let home: string
let repo: string

const DEFINITION = '---\nname: max-2\nlane: prod\n---\nроль\n'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sma-write-scope-home-'))
  repo = mkdtempSync(join(tmpdir(), 'sma-write-scope-repo-'))
  // то, что двери ЧИТАЮТ из обслуживаемого дерева: файл навыка и пара «поставленное /
  // эталонное» определение для тумблера штатной команды
  mkdirSync(join(repo, '.claude', 'skills', 'twitter-digest'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'skills', 'twitter-digest', 'SKILL.md'), '---\nname: twitter-digest\n---\n', 'utf8')
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(repo, '.claude', 'sma-core', 'agents'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'agents', 'max-2.md'), DEFINITION, 'utf8')
  writeFileSync(join(repo, '.claude', 'sma-core', 'agents', 'max-2.md'), DEFINITION, 'utf8')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const homedir = () => home
const io = () => ({ env: {}, homedir, launchDir: repo })
const configPath = () => resolveConfigPath({ env: {}, homedir })
const readFile = () => JSON.parse(readFileSync(configPath(), 'utf8'))

/** Файл, каким демон его ПРОЧИТАЛ на старте: все знакомые ключи уже на месте. */
const AT_BOOT = {
  maxConcurrentAttempts: 6,
  projects: [
    { id: 'alpha', name: 'Alpha' },
    { id: 'beta', name: 'Beta' },
  ],
  activeProject: 'alpha',
  pipeline: { enabled: false, maxTurns: 40 },
  budget: { monthlyApiCapUsd: 0, warnPct: [70, 90] },
  federation: {
    role: 'standalone',
    peers: [{ id: 'peer-1', url: 'https://one.example', token: 'peer-1-token' }],
  },
  telegram: { botToken: '7712345678:AAHbootTokenShapedLikeBotFather', pairing: { code: 'BOOT01', expiresAt: 4102444800000 } },
}

/** И то же место ЧАСОМ ПОЗЖЕ, поправленное человеком в редакторе при работающем демоне. */
const BY_HAND = {
  maxConcurrentAttempts: 4,
  activeProject: 'beta',
  pipeline: { enabled: false, maxTurns: 200 },
  budget: { monthlyApiCapUsd: 0, warnPct: [55, 95] },
  federation: {
    role: 'hub',
    peers: [{ id: 'peer-1', url: 'https://one.example', token: 'peer-1-token' }],
  },
}

/**
 * Поднять файл, загрузить его демоном, а потом развести файл и копию в памяти — руками, как
 * это и было. Возвращается УСТАРЕВШАЯ копия: именно её двери и получают от фронта.
 */
function boot() {
  loadConfig({ env: {}, homedir, repoDir: repo }) // первый запуск создаёт файл и токен
  writeFileSync(configPath(), JSON.stringify({ ...readFile(), ...AT_BOOT }, null, 2), 'utf8')
  const stale = loadConfig({ env: {}, homedir, repoDir: repo }) // копия демона: потолок 6
  writeFileSync(configPath(), JSON.stringify({ ...readFile(), ...BY_HAND }, null, 2), 'utf8')
  return stale
}

type Door = {
  /** имя функции — оно же сверяется с исходником */
  name: string
  press: (stale: any) => void
  /** своё поле дверь всё-таки меняет: сохранность не должна означать отказ писать */
  landed: (onDisk: any) => void
}

/**
 * ВСЕ ДВЕРИ, ПИШУЩИЕ КОНФИГ. Порядок — как в исходниках: сперва реестровые двери
 * `config.mjs`, затем аппликаторы харнесса. `loadConfig` в списке нет намеренно: она не дверь
 * человека, а загрузка, и её две записи (первичная и тихая миграция) разобраны в `config.test.ts`.
 */
const DOORS: Door[] = [
  {
    name: 'addProject',
    press: (stale) => addProject(stale, { id: 'gamma', name: 'Gamma' }, io()),
    landed: (d) => expect(d.projects.map((p: any) => p.id)).toContain('gamma'),
  },
  {
    name: 'renameProject',
    press: (stale) => renameProject(stale, { id: 'alpha', name: 'Альфа' }, io()),
    landed: (d) => expect(d.projects.find((p: any) => p.id === 'alpha').name).toBe('Альфа'),
  },
  {
    name: 'selectProject',
    press: (stale) => selectProject(stale, { id: 'beta' }, io()),
    landed: (d) => expect(d.activeProject).toBe('beta'),
  },
  {
    name: 'applyPipelineToggle',
    press: (stale) => applyPipelineToggle(stale, { enabled: true }, io()),
    landed: (d) => expect(d.pipeline.enabled).toBe(true),
  },
  {
    name: 'applyBudgetStop',
    press: (stale) => applyBudgetStop(stale, { limit: 42 }, io()),
    landed: (d) => expect(d.budget.monthlyApiCapUsd).toBe(42),
  },
  {
    name: 'addAccount',
    press: (stale) =>
      addAccount(
        stale,
        { id: 'max-9', lane: 'prod', configDir: '~/.sma-accounts/max-9', oauthTokenEnv: 'SMA_MAX_9_TOKEN' },
        io(),
      ),
    landed: (d) => expect(d.workers.map((w: any) => w.id)).toContain('max-9'),
  },
  {
    name: 'addPeer',
    press: (stale) => addPeer(stale, { id: 'peer-2', name: 'Вторая', url: 'https://two.example', token: 'peer-2-token' }, io()),
    landed: (d) => expect(d.federation.peers.map((p: any) => p.id)).toContain('peer-2'),
  },
  {
    name: 'removePeer',
    press: (stale) => removePeer(stale, { id: 'peer-1' }, io()),
    landed: (d) => expect(d.federation.peers).toEqual([]),
  },
  {
    name: 'applyTelegramConnect',
    press: (stale) =>
      applyTelegramConnect(
        stale,
        { botToken: '7799999999:AAHfreshTokenShapedLikeBotFather', pairing: { code: 'NEW777', expiresAt: 4102444800000 } },
        io(),
      ),
    landed: (d) => expect(d.telegram.pairing.code).toBe('NEW777'),
  },
  {
    name: 'applyTelegramPair',
    press: (stale) => applyTelegramPair(stale, { chatId: -1001234567890, chatTitle: 'Штаб' }, io()),
    landed: (d) => expect(d.telegram.chatId).toBe('-1001234567890'),
  },
  {
    name: 'applyTelegramDisconnect',
    press: (stale) => applyTelegramDisconnect(stale, io()),
    landed: (d) => expect(d.telegram).toBeUndefined(),
  },
  {
    name: 'applyAgentModel',
    press: (stale) => applyAgentModel({ config: stale, id: 'max-2', model: 'claude-opus-5', ...io() }),
    landed: (d) => expect(d.workers.find((w: any) => w.id === 'max-2').model).toBe('claude-opus-5'),
  },
  {
    name: 'applyAgentToggle',
    press: (stale) => applyAgentToggle({ config: stale, id: 'max-2', enabled: false, repoDir: repo, ...io() }),
    landed: (d) => expect(d.workers.find((w: any) => w.id === 'max-2').enabled).toBe(false),
  },
  {
    name: 'applyStockTeamToggle',
    press: (stale) => applyStockTeamToggle({ config: stale, enabled: false, repoDir: repo, ...io() }),
    landed: (d) => expect(d.workers.find((w: any) => w.id === 'max-2').enabled).toBe(false),
  },
  {
    name: 'applySkillAssign',
    press: (stale) => applySkillAssign({ config: stale, skillId: 'twitter-digest', workerIds: ['max-2'], repoDir: repo, ...io() }),
    landed: (d) => expect(d.workers.find((w: any) => w.id === 'max-2').skills).toContain('twitter-digest'),
  },
]

describe('ЗНАКОМОЕ поле, поправленное в файле, переживает нажатие на любую дверь', () => {
  it('исходное положение: демон ЗНАЕТ этот ключ — он был в файле на загрузке', () => {
    const stale = boot()
    expect(stale.maxConcurrentAttempts).toBe(6) // копия в памяти — устаревшая, и это норма
    expect(readFile().maxConcurrentAttempts).toBe(4) // а в файле уже правка человека
  })

  for (const door of DOORS) {
    it(`${door.name}: потолок остаётся 4, и своё поле дверь всё-таки меняет`, () => {
      const stale = boot()
      door.press(stale)
      const onDisk = readFile()
      expect(onDisk.maxConcurrentAttempts).toBe(4)
      door.landed(onDisk)
    })
  }

  it('дверей в таблице ровно столько, сколько их в исходниках', () => {
    const found = new Set<string>()
    for (const rel of ['../src/config.mjs', '../src/front/harness.mjs']) {
      for (const name of writersIn(readFileSync(new URL(rel, import.meta.url), 'utf8'))) found.add(name)
    }
    // загрузка пишет файл, которого ещё нет, и тихую миграцию — у неё свой разбор
    found.delete('loadConfig')
    expect([...found].sort()).toEqual(DOORS.map((d) => d.name).sort())
  })
})

/**
 * Имена функций, внутри которых зовётся `writeConfig` — прочитанные из ИСХОДНИКА, а не из
 * списка импортов: список можно забыть дополнить, а вызов забыть нельзя.
 */
function writersIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '') // комментарии файлов не пишут
  const out = new Set<string>()
  let current = '(модуль)'
  for (const raw of code.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//')) continue
    const declared = /^(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line)
    if (declared) current = declared[1]
    if (/(?<![A-Za-z0-9_$.])writeConfig\s*\(/.test(line) && current !== 'writeConfig') out.add(current)
  }
  return [...out]
}

/**
 * Второй этаж того же закона: у двери, которая владеет ОДНИМ листом внутри общего блока,
 * сосед по блоку берётся из ФАЙЛА. Иначе «починка» свелась бы к тому, что дефект переехал на
 * уровень глубже — а именно там и живут потолок ходов и порог предупреждения о деньгах.
 */
describe('сосед по блоку — из файла, а не из памяти', () => {
  it('тумблер конвейера не трогает потолок ходов рядом с собой', () => {
    const stale = boot()
    expect(stale.pipeline.maxTurns).toBe(40) // в памяти — старое число
    applyPipelineToggle(stale, { enabled: true }, io())
    const onDisk = readFile()
    expect(onDisk.pipeline.enabled).toBe(true)
    expect(onDisk.pipeline.maxTurns).toBe(200) // правка человека на месте
  })

  it('денежный стоп не трогает пороги предупреждения рядом с собой', () => {
    const stale = boot()
    applyBudgetStop(stale, { limit: 42 }, io())
    const onDisk = readFile()
    expect(onDisk.budget.monthlyApiCapUsd).toBe(42)
    expect(onDisk.budget.warnPct).toEqual([55, 95])
  })

  it('приход машины не трогает роль этого демона — «чем он является» объявляет человек', () => {
    const stale = boot()
    expect(stale.federation.role).toBe('standalone')
    addPeer(stale, { id: 'peer-2', url: 'https://two.example', token: 'peer-2-token' }, io())
    const onDisk = readFile()
    expect(onDisk.federation.peers.map((p: any) => p.id)).toEqual(['peer-1', 'peer-2'])
    expect(onDisk.federation.role).toBe('hub')
  })

  it('добавление проекта не возвращает выбранный проект к тому, что демон помнит', () => {
    const stale = boot()
    expect(stale.activeProject).toBe('alpha')
    addProject(stale, { id: 'gamma', name: 'Gamma' }, io())
    expect(readFile().activeProject).toBe('beta')
  })
})

describe('сам сторож', () => {
  it('запись, не назвавшая своих полей, — громкий отказ, а не «весь конфиг»', () => {
    const stale = boot()
    expect(() => writeConfig(stale, { env: {}, homedir, launchDir: repo } as any)).toThrow(TypeError)
    expect(readFile().maxConcurrentAttempts).toBe(4) // и на диск при этом ничего не легло
  })

  it('файла нет — пишется вся копия целиком: осколок конфига хуже потерянной правки', () => {
    const stale = loadConfig({ env: {}, homedir, repoDir: repo })
    rmSync(configPath(), { force: true })
    applyPipelineToggle(stale, { enabled: true }, io())
    const onDisk = readFile()
    expect(onDisk.pipeline.enabled).toBe(true)
    expect(onDisk.token).toBe(stale.token) // токен на месте: окну есть чем аутентифицироваться
    expect(onDisk.workers.length).toBe(stale.workers.length)
  })
})

/**
 * И тот же провод так, как его жмёт ОКНО: дефект приехал через HTTP-дверь, а между дверью и
 * записью стоят разбор тела, `configIo` и устаревший объект конфига, который фронт держит у
 * себя. Внутрипроцессный вызов этого участка не проверяет.
 */
describe('через дверь, как её жмёт окно', () => {
  it('POST /api/pipeline/toggle оставляет правку человека в файле', async () => {
    const stale = boot()
    const front = createFrontServer({
      config: stale,
      deps: { applyPipelineToggle, env: {}, homedir, repoDir: repo, launchDir: repo },
    })

    const req: any = Readable.from([Buffer.from(JSON.stringify({ enabled: true }), 'utf8')])
    req.method = 'POST'
    req.url = '/api/pipeline/toggle'
    req.headers = { authorization: 'Bearer ' + stale.token, 'content-type': 'application/json' }
    req.socket = { remoteAddress: '127.0.0.1' }
    const res: any = {
      statusCode: 0,
      body: '',
      headersSent: false,
      writeHead(code: number) {
        res.statusCode = code
        res.headersSent = true
        return res
      },
      end(chunk?: any) {
        if (chunk != null) res.body += String(chunk)
        return res
      },
    }
    await front.handle(req, res)
    expect(res.statusCode).toBe(200)

    const onDisk = readFile()
    expect(onDisk.pipeline.enabled).toBe(true)
    expect(onDisk.pipeline.maxTurns).toBe(200)
    expect(onDisk.maxConcurrentAttempts).toBe(4)
  })
})
