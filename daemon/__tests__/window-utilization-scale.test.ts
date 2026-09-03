/**
 * В КАКОЙ ШКАЛЕ ПРИХОДИТ ДОЛЯ ИЗРАСХОДОВАННОГО ОКНА — и что будет, если она сменится.
 *
 * ═══════════════ ЧЕМ ЭТО ОПАСНО ═══════════════
 *
 * Модель окон читает долю как ЧАСТЬ ЕДИНИЦЫ: 0.67 — «две трети израсходовано», а единица
 * означает, что поставщик больше не пропускает работу. Пришли бы те же числа процентами — 18,
 * 47, 67, — и каждое из них больше единицы: с первого кадра оба окна прочитались бы
 * «исчерпано», счёт перестал бы получать работу, и вернуть его было бы нечем до сброса окна —
 * для недельного это семь суток. Ошибка тихая: никто ничего не объявлял, конвейер просто встал.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. НАСТОЯЩИЕ КАДРЫ ЧИТАЮТСЯ ВЕРНО. Три кадра, снятые с живого потока этой машины
 *      (29.08–30.08.2026) и лежащие рядом фикстурой, проходят весь путь — разбор строки,
 *      запись в хранилище окон, чтение моделью — и дают ровно те проценты, что стоят в них
 *      долями. Отказ, у которого доля равна единице, приходит «исчерпано».
 *   2. ШКАЛА В ЭТИХ КАДРАХ — ДОЛЯ. Ни одно значение в захваченных кадрах не выходит за
 *      единицу; на этом и стоит вся арифметика ниже по течению.
 *   3. СТРАХОВКА РАБОТАЕТ В ОБЕ СТОРОНЫ. Значение больше единицы и до сотни читается
 *      процентами, а не полным окном; значение, которое не ложится ни в одну шкалу,
 *      отбрасывается — окно говорит «нет данных» вместо числа, которое никто не смог прочесть.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: журнальной строки о перетолкованной шкале — её пишет тик, и проверяется она
 * там же, на живом тике (loop.test.ts).
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect, afterEach } from 'vitest'

import { markWindowObserved, windowState, utilizationFraction, readingSaysExhausted } from '../src/policy/windows.mjs'
import { parseClaudeEvent } from '../src/runner/stream.mjs'

/** Кадры, снятые дословно с потока этой машины — не пересказ документации поставщика. */
const FIXTURE = fileURLToPath(new URL('./fixtures/claude-stream-rate-limit-unified.ndjson', import.meta.url))

const LINES = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)

/** Раньше любого сброса, названного в этих кадрах: иначе чтение справедливо считается протухшим. */
const NOW = Date.parse('2026-08-29T10:41:00.000Z')

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** Тот же путь, которым идёт тик: разобрать строку, записать каждое окно, прочитать моделью. */
function readThrough(line: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'sma-window-scale-'))
  dirs.push(dataDir)
  const event: any = parseClaudeEvent(line)
  const readings = Array.isArray(event.windows) && event.windows.length > 0 ? event.windows : [event]
  for (const observation of readings) {
    markWindowObserved({ dataDir, accountName: 'local-1', observation, clock: () => NOW })
  }
  return { event, state: windowState({ account: { name: 'local-1' }, clock: () => NOW, dataDir }) }
}

describe('the scale a spent share arrives in', () => {
  it('reads the captured frames as fractions — 0.18 is 18 %, and a full window is a refusal', () => {
    const [allowed, warning, refused] = LINES

    const first = readThrough(allowed)
    expect(first.state.fiveHour.status).toBe('open')
    expect(first.state.fiveHour.pct).toBe(18)
    // И НЕНАЗВАННОЕ ОКНО ТОЖЕ — доля недели ехала в том же кадре
    expect(first.state.week.status).toBe('open')
    expect(first.state.week.pct).toBe(3)

    const second = readThrough(warning)
    expect(second.state.fiveHour.pct).toBe(47)
    expect(second.state.week.pct).toBe(50)
    expect(second.state.week.status).toBe('open') // «allowed_warning» — это предупреждение, не отказ

    const third = readThrough(refused)
    // Полное окно — единица, и поставщик в том же кадре сказал «rejected»
    expect(third.state.fiveHour.status).toBe('exhausted')
    expect(third.state.fiveHour.pct).toBe(100)
    expect(third.state.week.pct).toBe(59)
  })

  it('never saw a share above one on the wire — which is what the whole arithmetic downstream rests on', () => {
    const shares = LINES.flatMap((line) => {
      const event: any = parseClaudeEvent(line)
      return (event.windows ?? []).map((w: any) => w.utilization)
    }).filter((v) => typeof v === 'number')

    expect(shares.length).toBeGreaterThan(0)
    for (const share of shares) {
      expect(share).toBeGreaterThanOrEqual(0)
      expect(share).toBeLessThanOrEqual(1)
    }
  })

  it('reads a share above one as PERCENTS — the day the wire changes, the account keeps working', () => {
    expect(utilizationFraction(0.67)).toEqual({ fraction: 0.67, scale: 'fraction' })
    expect(utilizationFraction(67)).toEqual({ fraction: 0.67, scale: 'percent' })
    // Единица остаётся полным окном: настоящее «исчерпано» обязано пережить эту страховку
    expect(utilizationFraction(1)).toEqual({ fraction: 1, scale: 'fraction' })
    expect(readingSaysExhausted({ utilization: 1 })).toBe(true)
    expect(readingSaysExhausted({ utilization: 67 })).toBe(false)
    expect(readingSaysExhausted({ utilization: 100 })).toBe(true) // сто процентов — это тоже полное окно
  })

  it('drops a share that fits neither scale — «нет данных» beats a number nobody could read', () => {
    expect(utilizationFraction(150).fraction).toBeNull()
    expect(utilizationFraction(150).scale).toBe('out-of-range')
    expect(utilizationFraction(-1).scale).toBe('out-of-range')
    expect(readingSaysExhausted({ utilization: 150 })).toBe(false)

    // И на экран такое число не попадает вовсе — ни как процент, ни как ноль
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-window-scale-bad-'))
    dirs.push(dataDir)
    markWindowObserved({
      dataDir,
      accountName: 'local-1',
      observation: { limitType: 'five_hour', status: 'allowed', utilization: 150, resetsAt: NOW + 3 * 60 * 60 * 1000 },
      clock: () => NOW,
    })
    const state = windowState({ account: { name: 'local-1' }, clock: () => NOW, dataDir })
    expect(state.fiveHour.status).toBe('open')
    expect(state.fiveHour.pct).toBeNull()
  })

  it('leaves an absent share absent — the zero that read as «квота свободна» never comes back', () => {
    expect(utilizationFraction(null)).toEqual({ fraction: null, scale: 'absent' })
    expect(utilizationFraction(undefined).scale).toBe('absent')
    expect(utilizationFraction('').scale).toBe('absent')
    expect(readingSaysExhausted({ status: 'allowed' })).toBe(false)
  })
})
