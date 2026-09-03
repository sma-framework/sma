/**
 * ui-drive-output.test.ts — что процесс ui-drive ГОВОРИТ ВСЛУХ, когда драйвер падает.
 *
 * ДЕФЕКТ, КОТОРЫЙ ЭТО ЗАКРЫВАЕТ. Квитанция прогона маскирует адрес, по которому её водили, —
 * и это была половина двери. Ошибка браузерного драйвера не адрес, а предложение с адресом
 * внутри («net::ERR_CONNECTION_REFUSED at http://…/?token=…»): драйвер цитирует полную цель,
 * к которой шёл. Такое предложение едет не в квитанцию, а в поток самого процесса, и оттуда —
 * в журнал того, кто прогон запустил. Замерено живьём: квитанция была замаскирована ровно как
 * задумано, а строкой ниже стоял тот же ключ голым, в ошибке, которая эту квитанцию породила.
 *
 * ПОЧЕМУ ЭТО ЖИВОЙ ПРОГОН, А НЕ ВЫЗОВ ФУНКЦИИ. Функция маскировки была на месте и до правки —
 * утечка была в том, что до потока она не доходила. Поэтому здесь спавнится сам
 * scripts/sma/ui-drive.mjs и читается то, что он в самом деле сказал: stdout, stderr и файлы,
 * которые он положил на диск. Браузер подменён (fixtures/failing-ui-driver.mjs), всё остальное
 * настоящее — иначе проверялось бы то самое допущение, которое и оказалось неверным.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DRIVE = join(ROOT, 'scripts', 'sma', 'ui-drive.mjs')
const FAILING_DRIVER = join(ROOT, 'scripts', 'sma', '__tests__', 'fixtures', 'failing-ui-driver.mjs')

/** Форма токена, которую чеканит демон: 64 шестнадцатеричных знака из randomBytes(32). */
const TOKEN = 'ab7f'.repeat(16)
/** Обычный параметр рядом с ключом: маска обязана снять ключ, а не адрес. */
const TARGET = `http://127.0.0.1:7777/?token=${TOKEN}&view=queue`
const MASKED = 'http://127.0.0.1:7777/?token=REDACTED&view=queue'

/** Ключ, о котором маску никто не предупреждал: его ловит только правило о ФОРМЕ. */
const UNKNOWN = '5c19'.repeat(16)
/** Ключ из конфига демона: в выводе он появляется голым, и ловится только ПО ЗНАЧЕНИЮ. */
const CONFIG_TOKEN = 'd41f'.repeat(16)
/** Ключ окна из окружения — второй источник, который процесс знает про себя сам. */
const WINDOW_TOKEN = '90ce'.repeat(16)

let receipts: string
let home: string

beforeEach(() => {
  receipts = mkdtempSync(join(tmpdir(), 'sma-ui-drive-out-'))
  home = mkdtempSync(join(tmpdir(), 'sma-ui-drive-cfg-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 7777, token: CONFIG_TOKEN }, null, 2))
})
afterEach(() => {
  rmSync(receipts, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function drive(mode: string) {
  const run = spawnSync(process.execPath, [DRIVE, TARGET, '--no-sweep'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      SMA_UI_DRIVER: FAILING_DRIVER,
      SMA_UI_RECEIPTS: receipts,
      SMA_FAKE_DRIVER_THROW: mode,
      SMA_DAEMON_CONFIG: join(home, 'config.json'),
      SMA_WINDOW_TOKEN: WINDOW_TOKEN,
      SMA_FAKE_DRIVER_UNKNOWN: UNKNOWN,
      SMA_FAKE_DRIVER_BARE: CONFIG_TOKEN,
    },
  })
  return { stdout: run.stdout ?? '', stderr: run.stderr ?? '', status: run.status }
}

/** Единственный каталог прогона, который написала эта попытка. */
function receiptDir() {
  const dirs = readdirSync(receipts).filter((d) => d.startsWith('run-'))
  expect(dirs).toHaveLength(1)
  return join(receipts, dirs[0])
}

describe('the token a driver error quotes never reaches the run output', () => {
  it('a failed navigation is reported with the address intact and the key removed', () => {
    const { stdout, stderr } = drive('goto')

    // Сообщение об ошибке В САМОМ ДЕЛЕ несло полный адрес — вот оно, и ключа в нём нет.
    // Без этой строки тест был бы пустым: «токена нет» верно и тогда, когда нет и адреса.
    expect(stdout).toContain(`net::ERR_CONNECTION_REFUSED at ${MASKED}`)
    // Драйвер шумит в stderr своей строкой, мимо квитанции: третий выход, та же маска.
    expect(stderr).toContain(`[driver] navigating to ${MASKED}`)
    expect(`${stdout}${stderr}`).not.toContain(TOKEN)
  })

  it('the receipt and its journal are written masked, and the journal stays machine-readable', () => {
    drive('goto')
    const dir = receiptDir()
    const run = readFileSync(join(dir, 'RUN.md'), 'utf8')
    const journal = readFileSync(join(dir, 'run.json'), 'utf8')

    expect(run).not.toContain(TOKEN)
    expect(journal).not.toContain(TOKEN)
    // Маска, а не пропуск: читатель квитанции видит, что ключ убрали, и по какому адресу шли.
    expect(run).toContain(`net::ERR_CONNECTION_REFUSED at ${MASKED}`)
    expect(JSON.parse(journal).url).toBe(MASKED)
  })

  it('a throw the run never awaited is printed by the runtime — and still through the mask', () => {
    const { stdout, stderr, status } = drive('listener')

    // Драйвер зовёт своих слушателей из своего таймера: такое исключение не проходит ни через
    // один await прогона, и рантайм печатает его САМ, мимо потока процесса. Замерено: маска,
    // поставленная на поток, этот выход не видит, и адрес с ключом уходит голым.
    expect(status).toBe(3)
    expect(stdout).toContain('NOT RUN')
    expect(stdout).toContain(`navigation watchdog fired while on ${MASKED}`)
    expect(`${stdout}${stderr}`).not.toContain(TOKEN)
  })

  it('an exception nobody caught leaves through the same mask, whole', () => {
    const { stdout, stderr, status } = drive('screenshot')

    // Падение — это NOT RUN с кодом 3, а не тихий зелёный прогон: маска ничего не проглотила.
    expect(status).toBe(3)
    expect(stdout).toContain('NOT RUN')
    // Многострочный текст исключения: адрес внутри него замаскирован так же, как и везде.
    expect(stdout).toContain(`taking page screenshot of "${MASKED}"`)
    expect(`${stdout}${stderr}`).not.toContain(TOKEN)
  })
})

/**
 * ФОРМА — ЭТО ВТОРАЯ СЕТКА, А НЕ ЕДИНСТВЕННАЯ.
 *
 * Правило о форме отвечало на вопрос «похоже ли это на ключ?», и у этого вопроса бесконечный
 * запас неверных ответов: тот же самый токен уезжает и как «Authorization: Bearer …», и как
 * «token: …» в предложении, и строкой запроса, процитированной со второй половины (без ведущего
 * «?»), и в процентной записи внутри закодированного адреса, и — в конце концов — голым, потому
 * что ничто не обязывает драйвер называть то, что он печатает. Здесь спавнится настоящий
 * ui-drive, и проверяется то, что он в самом деле сказал.
 */
describe('the same key, in every shape a library prints it in', () => {
  it('the header, the sentence, the query string with no «?», and the percent-encoded address', () => {
    const { stdout, stderr } = drive('shapes')
    const said = `${stdout}${stderr}`

    // Каждая форма В САМОМ ДЕЛЕ была напечатана — иначе «ключа нет» было бы верно и тогда,
    // когда нет и строки: маска обязана оставить и заголовок, и слова вокруг него.
    expect(said).toContain('Authorization: Bearer REDACTED')
    expect(said).toContain('the door was opened with token: REDACTED')
    expect(said).toContain('token=REDACTED&view=queue')
    expect(said).toContain('%3Ftoken%3DREDACTED%26view%3Dq')
    expect(said, 'ключ уехал в какой-то из форм').not.toContain(UNKNOWN)
  })

  it('a value the process knows to be a key is removed with no name and no separator anywhere', () => {
    const { stdout, stderr } = drive('shapes')
    const said = `${stdout}${stderr}`

    // Ни имени, ни «=», ни «?» — по форме такое не поймать. Ловится по ЗНАЧЕНИЮ: токен демона
    // прочитан из его конфига, ключ окна — из окружения, ещё до первой напечатанной строки.
    expect(said).toContain('handshake refused for REDACTED — retrying')
    expect(said).toContain('window REDACTED is still open')
    expect(said, 'токен из конфига демона напечатан голым').not.toContain(CONFIG_TOKEN)
    expect(said, 'ключ окна напечатан голым').not.toContain(WINDOW_TOKEN)
  })

  it('a key cut in half by a write boundary is still a key', () => {
    const { stdout, stderr } = drive('shapes')
    const said = `${stdout}${stderr}`

    // Драйвер написал значение двумя вызовами write: ни одна половина не совпадает ни с одним
    // правилом и ни с одним известным ключом. Маска держит хвост незакрытой строки до следующего
    // кадра — и обе половины видит вместе.
    expect(said).toContain('split ?token=REDACTED&view=queue')
    expect(said).toContain('split bare REDACTED — done')
    // И удержанное не теряется: строка после разреза дошла целиком.
    expect(said).toContain('— done')
  })
})

/**
 * ПОСЛЕДНЯЯ СТРОКА — ТА, РАДИ КОТОРОЙ ПРИШЛИ, И ТЕРЯЛАСЬ ИМЕННО ОНА.
 *
 * `process.exit()` ничего не дописывает. На POSIX stdout, который есть труба (а он есть труба
 * всегда, когда прогон кто-то читает: сцена, задача CI, перенаправление в файл), пишется
 * АСИНХРОННО — и всё, что осталось в очереди на момент вызова, пропадает. Под ударом ровно те
 * строки, за которыми читатель и пришёл: «NOT RUN — это не зачёт», сама квитанция и абсолютный
 * путь к ней. Прогон, который упал, читался бы как прогон, который ничего не сказал.
 *
 * На Windows труба пишется синхронно, и этот тест там — сторож, а не воспроизведение дефекта;
 * платформенно-независимое доказательство самого ожидания лежит в ui-drive.test.ts (createLeave).
 */
describe('nothing queued is dropped on the way out', () => {
  it('«NOT RUN» survives two megabytes printed just before the exit', () => {
    const { stdout, status } = drive('flood')

    expect(status).toBe(3)
    expect(stdout.length, 'залив вообще не дошёл — тест ничего не проверяет').toBeGreaterThan(2_000_000)
    expect(stdout, 'последняя строка процесса потерялась при выходе').toContain('NOT RUN')
    expect(stdout).toContain('This is not a pass.')
  })
})
