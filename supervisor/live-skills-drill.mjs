/**
 * live-skills-drill.mjs — НАВЫКИ, ПРОГНАННЫЕ ПО-НАСТОЯЩЕМУ: окно, дверь, диск.
 *
 * Что здесь доказывается и чего не доказывает сьют. Сьют проверяет разбор решений на поддельной
 * файловой системе — это правильно и этого мало для функции, которую судят по одному вопросу:
 * ОСТАЁТСЯ ЛИ ПОСЛЕ НАЖАТИЯ ФАЙЛ. Поэтому здесь поднимается настоящая дверь с настоящими
 * применителями, отдаётся настоящее собранное окно, браузер открывает его руками ui-drive и
 * читает СЛОВА с экрана, а прогон после этого открывает диск и читает байты.
 *
 *   node supervisor/live-skills-drill.mjs
 *
 * Три акта, и каждый закрывает свой пункт:
 *   (а) ПУСТОТА ОБЪЯСНЯЕТСЯ. Проект нарочно выбран такой, в дереве которого каталога навыков
 *       нет вовсе — ровно тот случай, из-за которого экран считали несуществующей функцией.
 *       Экран обязан назвать ОБА хранилища, в которых искал.
 *   (б) НАВЫК ПИШЕТСЯ ИЗ ОКНА. Человек заполняет три поля и жмёт кнопку; окно показывает путь,
 *       а прогон читает по этому пути файл. Ответ двери здесь не доказательство — доказательство
 *       байты на диске.
 *   (в) НАВЫК ВЫДАЁТСЯ РАБОТНИКУ. Карточка, «Кому дать», галочка, «Сохранить» — и назначение
 *       читается из конфигурации, которую применитель записал на диск.
 *
 * ЧЕГО ЭТОТ ПРОГОН НЕ ТРОГАЕТ. Хранилище навыков и конфигурация — во временных каталогах
 * (`SMA_DAEMON_SKILLS`, `SMA_DAEMON_CONFIG`), порт берётся свободным (занять — единственный
 * надёжный способ узнать, что он свободен), очередь не поднимается вовсе. Ни один файл боевого
 * демона и ни один навык этой машины не читается на запись.
 *
 * БРАУЗЕР — ВНЕШНИЙ. Продукт возит ноль зависимостей, поэтому драйвер разрешается в момент
 * запуска: `SMA_UI_DRIVER=/путь/к/node_modules/playwright`. Его отсутствие — СВОЙ исход
 * (код 3 у ui-drive), а не тихий зелёный: прогон, который не смотрел, не имеет права
 * отчитаться так же, как прогон, который смотрел.
 *
 * Node built-ins. Ноль зависимостей.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as netCreateServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Свободный порт берётся занятием, а не вопросом (см. live-outage-drill.mjs). */
function freePort() {
  return new Promise((res, rej) => {
    const srv = netCreateServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

let failCount = 0
const pass = (m) => console.log(`PASS  ${m}`)
const fail = (m) => {
  failCount += 1
  console.log(`FAIL  ${m}`)
}
const info = (m) => console.log(`  ..  ${m}`)

/** Токен прогона — не секрет и не боевой: дверь этого прогона живёт секунды и на loopback. */
const TOKEN = 'd'.repeat(64)

/** Что человек пишет в окне. Имя латиницей — оно станет именем каталога. */
const SKILL = {
  id: 'release-notes',
  description: 'Как собрать заметки к релизу из журнала задач.',
  body: 'Прочитать журнал попыток, выбрать сделанное, сложить в один абзац.',
}

async function main() {
  const appDir = join(ROOT, 'daemon', 'static', 'app')
  if (!existsSync(join(appDir, 'index.html'))) {
    fail(`собранного окна нет (${appDir}) — сначала: npm run build:spa`)
    process.exit(1)
  }

  const { createFrontServer } = await import(`file:///${ROOT.replace(/\\/g, '/')}/daemon/src/front/server.mjs`)
  const { readHarness, createMachineSkill, applySkillAssign } = await import(
    `file:///${ROOT.replace(/\\/g, '/')}/daemon/src/front/harness.mjs`
  )
  const { deriveState, derivePhaseIndex } = await import(`file:///${ROOT.replace(/\\/g, '/')}/daemon/src/front/state.mjs`)
  const { createEventHub } = await import(`file:///${ROOT.replace(/\\/g, '/')}/daemon/src/front/events.mjs`)

  const store = mkdtempSync(join(tmpdir(), 'sma-skills-drill-store-'))
  const launchDir = mkdtempSync(join(tmpdir(), 'sma-skills-drill-cfg-'))
  const configPath = join(launchDir, 'config.json')

  // ДЕРЕВО «ПРОЕКТА» ЭТОГО ПРОГОНА: с профилем и БЕЗ каталога навыков.
  //
  // Профиль ставится ради того, чтобы окно открылось доской, а не «Первым запуском»: этот
  // прогон судит навыки, и интервью первого запуска на его пути — чужая проверка, которая
  // съест все шаги. Каталог навыков НЕ создаётся намеренно — это и есть то состояние, из-за
  // которого экран выглядел пустым, и именно оно должно объясниться словами.
  const projectDir = join(store, 'no-such-project')
  mkdirSync(join(projectDir, '.sma'), { recursive: true })
  writeFileSync(join(projectDir, '.sma', 'profile.json'), JSON.stringify({ drill: 'skills' }, null, 2), 'utf8')
  const port = await freePort()
  const env = { ...process.env, SMA_DAEMON_SKILLS: store, SMA_DAEMON_CONFIG: configPath }
  info(`хранилище машины: ${store}`)
  info(`конфигурация прогона: ${configPath}`)

  const config = {
    token: TOKEN,
    port,
    bind: '127.0.0.1',
    workers: [
      { id: 'max-2', title: 'Макс', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true },
      { id: 'creator', title: 'Создатель', lane: 'forge', provider: 'claude', account: { configDir: '/c' }, enabled: true },
    ],
  }

  const front = createFrontServer({
    config,
    deps: {
      env,
      // Дерево «проекта» нарочно без каталога навыков — ровно то состояние, при котором экран
      // выглядел пустым и человек решал, что функции нет.
      repoDir: projectDir,
      launchDir,
      readHarness,
      createMachineSkill,
      applySkillAssign,
      adapter: { list: async () => [] },
      deriveState,
      // Оболочка окна спрашивает список фаз на каждом экране. Дверь без применителя отвечает
      // 501, а ui-drive считает 501 у собственного API блокирующей находкой — и будет прав:
      // прогон не имеет права молча вычёркивать красное. Поэтому читатель фаз подключён
      // по-настоящему и отвечает пустым списком с дерева, где фаз нет.
      derivePhaseIndex,
      hub: createEventHub({}),
      clock: () => Date.now(),
    },
  })
  const server = await new Promise((r) => front.listen(() => r(front.server)))
  const url = `http://127.0.0.1:${port}/?token=${TOKEN}`
  info(`окно прогона: http://127.0.0.1:${port}`)

  try {
    const steps = [
      url,
      'wait:3000',
      'click:Навыки',
      'wait:1500',
      // (а) пустота, объяснённая словами: оба хранилища названы
      'expect:Навыков не найдено',
      'expect:Искали в двух местах',
      'expect:такого каталога нет',
      'shot:навыки-пусто-названы-оба-хранилища',
      // (б) навык, написанный из окна
      'click:Написать навык',
      'wait:800',
      `type:#skill-id=${SKILL.id}`,
      `type:#skill-description=${SKILL.description}`,
      `type:#skill-body=${SKILL.body}`,
      'click:Создать навык',
      'wait:2000',
      'expect:Навык записан на диск.',
      'shot:навык-написан-из-окна',
      'click:Закрыть',
      'wait:1500',
      `expect:${SKILL.id}`,
      'expect:машина',
      'shot:карточка-навыка-с-источником',
      // (в) выдача работнику
      'click:Кому дать',
      'wait:800',
      'click:Макс',
      'click:Сохранить',
      'wait:1500',
      'expect:у Макс',
      'shot:навык-выдан-работнику',
      '--no-sweep',
    ]

    let out = ''
    const code = await new Promise((r) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'sma', 'ui-drive.mjs'), ...steps], {
        cwd: ROOT,
        env: process.env,
      })
      child.stdout.on('data', (c) => {
        out += c
        process.stdout.write(c)
      })
      child.stderr.on('data', (c) => process.stderr.write(c))
      child.on('exit', (c) => r(c ?? 1))
    })

    if (code === 3) {
      fail('ui-drive НЕ ЗАПУСКАЛСЯ: браузерного драйвера нет (SMA_UI_DRIVER=/путь/к/playwright)')
      return
    }
    if (code === 2) {
      fail('ui-drive не понял шаги прогона')
      return
    }
    const receipt = out.match(/Receipt: (.+)/)
    if (!receipt) {
      fail('ui-drive не назвал свою квитанцию — судить не по чему')
    } else if (code === 0) {
      pass(`ui-drive: окно прошло путь «пусто со словами → навык написан → навык выдан» (квитанция: ${receipt[1].trim()})`)
    } else {
      fail(`ui-drive: путь не пройден целиком (квитанция: ${receipt[1].trim()})`)
    }

    // ── ДИСК. Ответ двери — не доказательство; доказательство лежит файлом. ──
    const skillFile = join(store, SKILL.id, 'SKILL.md')
    if (!existsSync(skillFile)) {
      fail(`навык, созданный из окна, НЕ лёг на диск (${skillFile})`)
    } else {
      const text = readFileSync(skillFile, 'utf8')
      const named = text.includes(`name: ${SKILL.id}`) && text.includes(SKILL.description) && text.includes(SKILL.body)
      if (named) pass(`навык лежит на диске и несёт слова человека: ${skillFile}`)
      else fail(`файл навыка есть, но его содержимое не то, что человек написал: ${skillFile}`)
    }

    // ── КОНФИГУРАЦИЯ. Выдача работнику — тоже запись, и её тоже читают с диска. ──
    if (!existsSync(configPath)) {
      fail(`выдача навыка не записалась (${configPath} не создан)`)
    } else {
      let assigned = []
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
        assigned = (cfg.workers || []).filter((w) => Array.isArray(w.skills) && w.skills.includes(SKILL.id)).map((w) => w.id)
      } catch (err) {
        fail(`конфигурация прогона не читается: ${String((err && err.message) || err)}`)
      }
      if (assigned.length > 0) pass(`навык выдан работникам: ${assigned.join(', ')} — прочитано из ${configPath}`)
      else fail(`навык не выдан никому — в ${configPath} нет ни одного работника с «${SKILL.id}»`)
    }
  } finally {
    server.close()
  }
}

await main()
process.exit(failCount === 0 ? 0 : 1)
