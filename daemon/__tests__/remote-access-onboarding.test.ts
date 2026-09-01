/**
 * «РАБОТАТЬ УДАЛЁННО» ОБЪЯСНЯЕТ И ПРОВЕРЯЕТ. ОНА НИЧЕГО НЕ СТАВИТ И НИЧЕГО НЕ МЕНЯЕТ.
 *
 * ═══════════════ ПОЧЕМУ У ЭТОГО ЭКРАНА ЕСТЬ СВОЙ ГЕЙТ ═══════════════
 * Экран онбординга приватной сети — единственное место продукта, которое разговаривает с
 * человеком про его границу доверия: где стоит демон, кому он виден, каким проводом до него
 * дотягиваются со второй машины. У такого экрана два способа солгать, и оба тихие.
 *
 * ПЕРВЫЙ — СДЕЛАТЬ БОЛЬШЕ, ЧЕМ ОБЕЩАНО. Кнопка «поставить приватную сеть» привела бы в дом
 * чужую программу, чужую лицензию и чужую границу доверия из НАШЕГО установщика; тумблер
 * «открыть доступ» переписал бы `bind` в чужом файле настроек. Продукт local-first, и
 * решение принято словами: экран объясняет и проверяет, установку и правку настроек делает
 * человек своими руками. Проверяется это не обещанием в комментарии, а формой: разметка
 * экрана не зовёт ни одного пишущего хука и не открывает ни одной двери сама.
 *
 * ВТОРОЙ — ПРОДАТЬ СЛОМАННОЕ ОБЕЩАНИЕ. «Удалённая работа» без четырёх оговорок читается как
 * «включил и забыл», а это неправда на каждой сегодняшней установке: машина-хозяйка должна
 * не спать; после перезагрузки само не поднимается ничего; токен в ту же секунду становится
 * настоящим паролем; смена `bind` — решение с последствиями, а не тумблер. Оговорки поэтому
 * перечислены ДАННЫМИ (`CAVEAT_KEYS`), а не абзацем прозы: список, который можно пересчитать,
 * переживает переписывание текста, а абзац — нет.
 *
 * ═══════════════ ПОЧЕМУ ФАКТЫ СЧИТАЮТСЯ ДЕМОНОМ, А НЕ ЭКРАНОМ ═══════════════
 * «На что демон привязан сейчас» и «виден ли он кому-то кроме этой машины» — это одно
 * знание, и второе мнение о нём было бы вторым ответом на вопрос безопасности. Поэтому дверь
 * не заводится вовсе: `remoteAccess` едет полем ТОГО ЖЕ `/api/state`, ровно как «Правила» и
 * «Аккаунты», — замороженная таблица здесь таблица дверей, а не форма полезной нагрузки.
 *
 * ОБНАРУЖЕНИЕ СЕТИ ВЕНДОР-НЕЙТРАЛЬНО ПО ПОСТРОЕНИЮ: derive не спрашивает, установлен ли
 * Tailscale, — он смотрит на диапазоны адресов, которые раздают шифрованные меши (CGNAT
 * 100.64/10 и IPv6 ULA fd00::/8). Любая приватная сеть, раздающая такой адрес, обнаружится;
 * ни одна не названа по имени в коде.
 *
 * ═══════════════ ЧЕГО ЭТОТ ФАЙЛ НЕ УТВЕРЖДАЕТ ═══════════════
 * Он не заменяет живой прогон: помещается ли экран в телефон и читается ли он глазами —
 * вопрос к браузеру, и отвечает на него ui-drive на трёх ширинах. Здесь закрыто ровно то,
 * что дешевле всего проглядеть при следующей правке текста.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { deriveRemoteAccess, deriveState } from '../src/front/state.mjs'
import { CAVEAT_KEYS, COPY, LANGS, OS_KEYS } from '../../spa/src/screens/remote-access/copy'

const SCREEN = readFileSync(
  fileURLToPath(new URL('../../spa/src/screens/remote-access/index.tsx', import.meta.url)),
  'utf8',
)
const REGISTRY = readFileSync(
  fileURLToPath(new URL('../../spa/src/screens/registry.ts', import.meta.url)),
  'utf8',
)
const TYPES = readFileSync(fileURLToPath(new URL('../../spa/src/api/types.ts', import.meta.url)), 'utf8')

const docText = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../docs/${name}`, import.meta.url)), 'utf8')

/** Один сетевой интерфейс, как его отдаёт `os.networkInterfaces()`. */
const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false) => ({
  address,
  family,
  internal,
  netmask: '',
  mac: '00:00:00:00:00:00',
})

/** Машина с шифрованным мешем (CGNAT-адрес), обычной локалкой и петлёй. */
const MESHED = () => ({
  lo0: [iface('127.0.0.1', 'IPv4', true)],
  utun4: [iface('100.101.102.103', 'IPv4')],
  en0: [iface('192.168.1.20', 'IPv4')],
})

/** Та же машина без приватной сети: только локалка и петля. */
const LAN_ONLY = () => ({
  lo0: [iface('127.0.0.1', 'IPv4', true)],
  en0: [iface('192.168.1.20', 'IPv4')],
})

const remote = (config: any, interfaces: () => any) =>
  deriveRemoteAccess(config, { networkInterfaces: interfaces })

describe('deriveRemoteAccess — ФАКТ о двери, а не совет по ней', () => {
  it('петля: демон виден только этой машине, и открыть его со второй машины нечем', () => {
    const r = remote({ bind: '127.0.0.1', port: 7777 }, MESHED)
    expect(r.bind).toBe('127.0.0.1')
    expect(r.port).toBe(7777)
    expect(r.reach).toBe('this_machine_only')
    expect(r.visibleBeyondThisMachine).toBe(false)
    // Приватная сеть ЕСТЬ — и это ровно тот случай, ради которого экран написан: сеть
    // поднята, а демон в неё не смотрит. Адреса для второй машины поэтому нет.
    expect(r.privateNetwork.detected).toBe(true)
    expect(r.openFrom).toBe(null)
  })

  it('дикая карта: слушают все интерфейсы, адрес для второй машины — адрес приватной сети', () => {
    const r = remote({ bind: '0.0.0.0', port: 7777 }, MESHED)
    expect(r.reach).toBe('every_interface')
    expect(r.visibleBeyondThisMachine).toBe(true)
    expect(r.openFrom).toBe('http://100.101.102.103:7777')
  })

  it('именованный адрес приватной сети: виден в мешe и больше нигде', () => {
    const r = remote({ bind: '100.101.102.103', port: 7777 }, MESHED)
    expect(r.reach).toBe('named_address')
    expect(r.visibleBeyondThisMachine).toBe(true)
    expect(r.openFrom).toBe('http://100.101.102.103:7777')
  })

  it('локалка — НЕ приватная сеть: её адрес виден отдельным видом и сети не объявляет', () => {
    const r = remote({ bind: '0.0.0.0', port: 7777 }, LAN_ONLY)
    expect(r.privateNetwork.detected).toBe(false)
    expect(r.openFrom).toBe(null)
    expect(r.privateNetwork.interfaces.map((i: any) => i.kind)).toEqual(['lan'])
  })

  it('IPv6 ULA считается приватной сетью, и её адрес едет в скобках — как того требует url', () => {
    const r = remote({ bind: '::', port: 7777 }, () => ({
      lo0: [iface('::1', 'IPv6', true)],
      utun4: [iface('fd7a:115c:a1e0::1', 'IPv6')],
    }))
    expect(r.reach).toBe('every_interface')
    expect(r.privateNetwork.detected).toBe(true)
    expect(r.openFrom).toBe('http://[fd7a:115c:a1e0::1]:7777')
  })

  it('умолчания названы, а не угаданы: настройки без двери читаются как петля на 7777', () => {
    const r = remote({}, LAN_ONLY)
    expect(r.bind).toBe('127.0.0.1')
    expect(r.port).toBe(7777)
    expect(r.reach).toBe('this_machine_only')
  })

  it('нечитаемые интерфейсы — честное «не знаю», а не отказ двери', () => {
    const r = remote({ bind: '127.0.0.1', port: 7777 }, () => {
      throw new Error('нет доступа к интерфейсам')
    })
    expect(r.privateNetwork.detected).toBe(false)
    expect(r.privateNetwork.interfaces).toEqual([])
    expect(r.privateNetwork.readable).toBe(false)
  })

  it('токен не едет с этим полем ни в каком виде', () => {
    const token = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const r = remote({ bind: '0.0.0.0', port: 7777, token }, MESHED)
    expect(JSON.stringify(r)).not.toContain(token)
  })
})

describe('remoteAccess едет полем СУЩЕСТВУЮЩЕЙ двери', () => {
  it('появляется в полезной нагрузке /api/state и новой двери под себя не заводит', async () => {
    const payload = await deriveState({
      adapter: { list: async () => [] },
      windows: () => ({ fiveHour: { status: 'open', resetsAt: null, pct: null, observedAt: null }, week: { status: 'open', resetsAt: null, pct: null, observedAt: null } }),
      config: { bind: '127.0.0.1', port: 7777, workers: [] },
      networkInterfaces: MESHED,
      clock: () => Date.parse('2026-09-01T09:00:00Z'),
    })
    expect(payload.remoteAccess).toMatchObject({ bind: '127.0.0.1', reach: 'this_machine_only' })
    // Форма объявлена окну — иначе экран читал бы поле, которого в контракте нет.
    expect(TYPES).toContain('remoteAccess: RemoteAccess')
  })
})

describe('текст экрана — EN и RU, слово в слово по составу', () => {
  it('оба языка на месте и несут ОДИН И ТОТ ЖЕ состав ключей', () => {
    expect(LANGS).toEqual(['ru', 'en'])
    expect(shape(COPY.ru)).toEqual(shape(COPY.en))
  })

  it('ни одной пустой строки ни в одном языке', () => {
    for (const lang of LANGS) for (const [path, value] of leaves(COPY[lang])) expect(value.trim(), `${lang}.${path}`).not.toBe('')
  })

  it('английский текст — английский: кириллица едет только там, где значение и есть команда', () => {
    for (const [path, value] of leaves(COPY.en)) {
      // Значение, совпадающее с русским байт в байт, — это команда или путь, а не проза.
      if (value === at(COPY.ru, path)) continue
      expect(value, `en.${path}`).not.toMatch(/[Ѐ-ӿ]/)
    }
  })

  it('четыре обязательные оговорки названы данными и написаны на обоих языках', () => {
    expect([...CAVEAT_KEYS].sort()).toEqual(
      ['bindIsAGate', 'hostAwake', 'noAutostart', 'tokenBecomesPassword'].sort(),
    )
    for (const lang of LANGS) {
      for (const key of CAVEAT_KEYS) {
        expect(COPY[lang].caveats[key].title.trim(), `${lang}.${key}`).not.toBe('')
        expect(COPY[lang].caveats[key].body.trim(), `${lang}.${key}`).not.toBe('')
      }
    }
  })

  it('готовые команды есть под каждую из трёх систем, и каждый шаг несёт слова', () => {
    expect([...OS_KEYS].sort()).toEqual(['linux', 'macos', 'windows'])
    for (const lang of LANGS) {
      for (const os of OS_KEYS) {
        const steps = COPY[lang].setup.steps[os]
        expect(steps.length, `${lang}.${os}`).toBeGreaterThan(0)
        for (const step of steps) expect(step.text.trim()).not.toBe('')
      }
    }
  })

  it('отказ открывать порт наружу назван прямо, вместе с причиной', () => {
    // Причина — не вкус: демон говорит по http, и токен в открытом интернете уедет открытым текстом.
    expect(COPY.ru.refusal.body).toMatch(/http/i)
    expect(COPY.en.refusal.body).toMatch(/http/i)
    expect(COPY.ru.refusal.body).toMatch(/токен/i)
    expect(COPY.en.refusal.body).toMatch(/token/i)
  })

  it('ротация токена предлагается ШАГАМИ ЧЕЛОВЕКА, а не кнопкой экрана', () => {
    for (const lang of LANGS) expect(COPY[lang].rotate.steps.length).toBeGreaterThan(0)
  })

  it('экран называет свою опору — рунбук, который он и есть в продуктовой форме', () => {
    expect(COPY.ru.runbook.path).toBe('docs/REMOTE-ACCESS-RUNBOOK.md')
    expect(COPY.en.runbook.path).toBe('docs/REMOTE-ACCESS-RUNBOOK.md')
  })
})

describe('разметка экрана НИЧЕГО не ставит и ничего не пишет', () => {
  it('не зовёт ни одного пишущего хука и не открывает дверь сама', () => {
    // Список пишущих хуков продукта — те, что несут mutate. Экрану-объяснению не нужен ни один.
    expect(SCREEN).not.toMatch(/\.mutate\s*\(/)
    expect(SCREEN).not.toMatch(/\bfetch\s*\(/)
    expect(SCREEN).not.toMatch(/apiPost|apiPatch|apiPut|apiDelete/)
  })

  it('читает ФАКТ у общей двери состояния — и только его', () => {
    expect(SCREEN).toContain('useStateQuery')
    expect(SCREEN).toContain('remoteAccess')
  })

  it('говорит вслух, что сам ничего не устанавливает', () => {
    for (const lang of LANGS) expect(COPY[lang].installsNothing.trim()).not.toBe('')
  })
})

describe('экран объявлен в реестре окна', () => {
  it('у него есть свой id, своя папка и своя строка', () => {
    expect(REGISTRY).toContain("'remote-access'")
    expect(REGISTRY).toContain("from '../screens/remote-access'")
    expect(REGISTRY).toMatch(/id: 'remote-access', title: 'Работать удалённо'/)
  })
})

describe('рунбук — опора экрана — лежит в дереве на обоих языках', () => {
  const REFUSAL = [/http/i]

  it('оба файла есть и оба несут четыре оговорки и отказ', () => {
    for (const name of ['REMOTE-ACCESS-RUNBOOK.md', 'REMOTE-ACCESS-RUNBOOK.ru.md']) {
      const text = docText(name)
      expect(text.length, name).toBeGreaterThan(500)
      for (const re of REFUSAL) expect(text, name).toMatch(re)
      // Каждая оговорка названа своим ключом — так её видно и в тексте, и в поиске.
      for (const key of CAVEAT_KEYS) expect(text, `${name} ← ${key}`).toContain(key)
    }
  })
})

describe('README назвал новый экран на обоих языках', () => {
  it('и по-русски, и по-английски', () => {
    const en = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
    const ru = readFileSync(fileURLToPath(new URL('../../README.ru.md', import.meta.url)), 'utf8')
    expect(en).toMatch(/REMOTE-ACCESS-RUNBOOK/)
    expect(ru).toMatch(/Работать удалённо/)
  })
})

// ── помощники: состав объекта и его листья, без знания о самих текстах ──

/** Форма объекта — ключи со вложенностью, без значений: ею и сверяются два языка. */
function shape(value: any): any {
  if (Array.isArray(value)) return value.map(shape)
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const key of Object.keys(value).sort()) out[key] = shape(value[key])
    return out
  }
  return typeof value
}

/** Каждый лист-строка объекта вместе со своим путём. */
function leaves(value: any, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]]
  if (value === null || typeof value !== 'object') return []
  const out: [string, string][] = []
  for (const [key, child] of Object.entries(value)) {
    out.push(...leaves(child, prefix ? `${prefix}.${key}` : key))
  }
  return out
}

/** Значение по пути, собранному `leaves`. */
function at(value: any, path: string): unknown {
  return path.split('.').reduce<any>((acc, key) => (acc == null ? acc : acc[key]), value)
}
