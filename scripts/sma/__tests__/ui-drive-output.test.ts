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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

let receipts: string

beforeEach(() => {
  receipts = mkdtempSync(join(tmpdir(), 'sma-ui-drive-out-'))
})
afterEach(() => {
  rmSync(receipts, { recursive: true, force: true })
})

function drive(mode: string) {
  const run = spawnSync(process.execPath, [DRIVE, TARGET, '--no-sweep'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SMA_UI_DRIVER: FAILING_DRIVER,
      SMA_UI_RECEIPTS: receipts,
      SMA_FAKE_DRIVER_THROW: mode,
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
