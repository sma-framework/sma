/**
 * failing-ui-driver.mjs — стенд для ОШИБКИ драйвера, а не для удачного прогона.
 *
 * Рядом лежит fake-ui-driver.mjs: он ходит по настоящим адресам и доказывает, что сцена, дверь
 * и квитанция связаны. Этот стенд про другое — про то, что драйвер ГОВОРИТ, когда у него не
 * получилось. Настоящий браузерный драйвер цитирует в сообщении об ошибке полный адрес, куда он
 * шёл, вместе со строкой запроса; именно так ключ от двери и уезжал в вывод процесса. Стенд
 * никуда не ходит: он воспроизводит ту же форму сообщения, поэтому поведение ui-drive на ошибке
 * проверяется на любой машине, в том числе на той, где браузера нет вовсе.
 *
 * SMA_FAKE_DRIVER_THROW выбирает, ГДЕ рвётся:
 *   goto (по умолчанию) — рвётся навигация. ui-drive это исключение ЛОВИТ и кладёт находкой
 *                         в квитанцию, а квитанцию печатает.
 *   screenshot          — рвётся снимок. Это исключение ui-drive не ловит: оно уходит целиком,
 *                         многострочным, в «NOT RUN» на выходе процесса.
 *   listener            — рвётся в СОБСТВЕННОМ таймере драйвера, мимо всякого await прогона.
 *                         Такой текст печатает сам рантайм, минуя поток процесса, — выход,
 *                         которого маска на потоке не видит вовсе.
 *   shapes              — не рвётся вовсе: печатает один и тот же ключ во ВСЕХ формах, в
 *                         которых его печатают живые библиотеки (заголовок, проза, строка
 *                         запроса без ведущего «?», процентная запись), плюс два значения
 *                         голыми и одно — разрезанным границей двух write.
 *   flood               — заливает поток так, что труба заведомо не проглотит его одним
 *                         куском, и рвётся в своём таймере. Последняя строка процесса —
 *                         «NOT RUN»: на POSIX запись в трубу асинхронна, и всё, что осталось
 *                         в очереди на момент process.exit, пропадает вместе с ней.
 *
 * Куда бы драйвер ни шёл, он ещё и сообщает об этом в stderr — своей строкой, мимо всякой
 * квитанции. Настоящие драйверы так и шумят, и этот шум — третий выход, который маска обязана
 * закрывать наравне с двумя остальными.
 */

import { writeFileSync } from 'node:fs'

/** Подпись PNG и ничего больше: настоящий файл на диске, честный в том, что он заглушка. */
const PNG_STUB = Buffer.from('89504e470d0a1a0a', 'hex')

/** Страница, которая перестала меняться, — форма, которую ищет awaitReady. */
const STILL_PAGE = { nodes: 120, ink: 480 }

const MODE = process.env.SMA_FAKE_DRIVER_THROW || 'goto'

/** Сколько заливает режим flood: заведомо больше буфера трубы на любой системе. */
const FLOOD_BYTES = 2_000_000

/**
 * Ключ, о котором маска НЕ предупреждена (его нет ни в конфиге, ни в окружении, ни в адресе):
 * такой ловится только по форме. И два, которые она знает по значению, — их стенд печатает
 * голыми, без единой подсказки о том, что это ключи.
 */
const UNKNOWN = process.env.SMA_FAKE_DRIVER_UNKNOWN || ''
const BARE = process.env.SMA_FAKE_DRIVER_BARE || ''

/** Все формы, в которых живые библиотеки печатают один и тот же ключ. */
function speakEveryShape(target) {
  const say = (line) => process.stderr.write(line)
  say(`[driver] request headers for ${target}\n`)
  say(`[driver] Authorization: Bearer ${UNKNOWN}\n`)
  say(`[driver] the door was opened with token: ${UNKNOWN}\n`)
  say(`token=${UNKNOWN}&view=queue\n`)
  say(`[driver] recovered from the log: http%3A%2F%2Fh%2F%3Ftoken%3D${UNKNOWN}%26view%3Dq\n`)
  // Ни имени, ни разделителя — просто значение в предложении. По форме такое не поймать вовсе.
  say(`[driver] handshake refused for ${BARE} — retrying\n`)
  say(`[driver] window ${process.env.SMA_WINDOW_TOKEN || ''} is still open\n`)
  // Одно значение, разрезанное границей двух write: ни одна половина не совпадает ни с чем.
  say(`[driver] split ?token=${UNKNOWN.slice(0, 20)}`)
  say(`${UNKNOWN.slice(20)}&view=queue\n`)
  say(`[driver] split bare ${BARE.slice(0, 20)}`)
  say(`${BARE.slice(20)} — done\n`)
}

function makePage() {
  let target = ''
  let armed = false
  return {
    on(event) {
      // Настоящий драйвер зовёт своих слушателей САМ, из собственного таймера. Исключение,
      // поднятое в таком вызове, не проходит ни через один await прогона: его печатает рантайм
      // и печатает мимо потока процесса — единственный выход, который маска на потоке не видит.
      if (MODE === 'listener' && event === 'console' && !armed) {
        armed = true
        setTimeout(() => {
          throw new Error(`page.on: navigation watchdog fired while on ${target}`)
        }, 40)
      }
    },
    async goto(url) {
      target = String(url)
      process.stderr.write(`[driver] navigating to ${target}\n`)
      if (MODE === 'shapes') speakEveryShape(target)
      if (MODE === 'flood' && !armed) {
        armed = true
        process.stdout.write(`${'.'.repeat(FLOOD_BYTES)}\n`)
        setTimeout(() => {
          throw new Error(`page.on: navigation watchdog fired while on ${target}`)
        }, 20)
      }
      if (MODE === 'goto') throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${target}`)
    },
    async evaluate(_fn, arg) {
      // Проверка готовности зовёт без аргумента; обмер выпирания передаёт свои пределы.
      return arg === undefined ? STILL_PAGE : []
    },
    async waitForTimeout(ms) {
      await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 500)))
    },
    async screenshot({ path }) {
      if (MODE === 'screenshot') {
        throw new Error(
          `page.screenshot: Timeout 5000ms exceeded.\nCall log:\n  - taking page screenshot of "${target}"\n`
        )
      }
      writeFileSync(path, PNG_STUB)
    },
    locator() {
      return { all: async () => [] }
    },
    async close() {
      /* ничего не открывалось */
    },
  }
}

export const chromium = {
  async launch() {
    return {
      async newPage() {
        return makePage()
      },
      async close() {
        /* ничего не запускалось */
      },
    }
  },
}

export default { chromium }
