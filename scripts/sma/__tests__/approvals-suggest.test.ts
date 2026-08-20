/**
 * approvals suggest — предложения стоячих правил приёмки, вычитанные из истории решений.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. Система, которая только СПРАШИВАЕТ, заставляет человека отвечать на один и
 * тот же вопрос в двадцатый раз ровно так же, как он ответил в первый. История его ответов уже
 * лежит на диске: леджер попыток пишет каждый подход, а очередь — что с ним стало дальше. Из
 * этой истории стоячее правило можно ВЫЧИТАТЬ, а не выпрашивать заново.
 *
 * Каждый случай ниже — способ, которым предложение могло бы снова стать выдумкой:
 *   - арифметика на фикстуре, ответ которой известен ДО прогона: девять задач ростера приняты
 *     с первой попытки, пять задач бэклога, из них четыре возвращены; вывод обязан назвать
 *     оба числа СО ЗНАМЕНАТЕЛЕМ и предложить противоположные правила;
 *   - порог честности: класс с тремя решениями не получает правила вовсе, а получает слова
 *     «данных мало, 3 решений» — правило из трёх случаев есть выдуманное число в другой одежде;
 *   - признак решения ЧЕЛОВЕКА: очередь сама повторяет только провалившийся подход, а вернуть
 *     завершённую работу может только человек. Значит цепочка «провал → провал → принято» несёт
 *     ОДНО решение, а не три, и ряд, который никто не видел (reconstructed), не несёт ни одного;
 *   - сложение рядов одной попытки: два писателя пишут про один подход, и считать ряды вместо
 *     попыток значило бы удваивать каждое решение;
 *   - детерминизм: два прогона подряд на одной фикстуре дают байт-в-байт один вывод — ни одного
 *     обращения к модели в этом пути нет и быть не может;
 *   - команда НИЧЕГО НЕ ПИШЕТ: список файлов фикстуры и их времена правки до и после прогона
 *     совпадают. Включение правила — отдельный явный шаг человека, и в этой команде его нет;
 *   - пустая и отсутствующая история — «данных нет» и код выхода 0, а не исключение.
 *
 * Прогоняется НАСТОЯЩИЙ глагол настоящим процессом (execFileSync node cli.mjs), как и соседние
 * тесты CLI: проверяется то, что человек наберёт руками, а не внутренняя функция рядом с ним.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')

const NOW = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const dirs: string[] = []
function ledgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-approvals-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** Один файл леджера: попытки одной задачи, по объекту на строку. */
function seedTask(dir: string, taskId: string, rows: Record<string, unknown>[]) {
  writeFileSync(join(dir, `${taskId}.jsonl`), rows.map((r) => JSON.stringify({ taskId, ...r })).join('\n') + '\n')
}

/** Прогон глагола. Возвращает stdout как есть — вывод и есть предмет проверки. */
function suggest(dir: string, extra: string[] = []): string {
  return execFileSync(process.execPath, [CLI, 'approvals', 'suggest', '--ledger', dir, ...extra], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Снимок каталога: имена, размеры и времена правки — чтобы «ничего не написал» было проверкой. */
function snapshot(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .map((n) => {
      const st = statSync(join(dir, n))
      return `${n}:${st.size}:${st.mtimeMs}`
    })
}

/**
 * ФИКСТУРА С ЗАРАНЕЕ ИЗВЕСТНЫМ ОТВЕТОМ.
 *   ростер: девять задач, каждая принята с первой попытки → 9 принятий, 0 возвратов;
 *   бэклог: пять решений — четыре возврата (завершённый подход, после которого пошёл ещё один)
 *           и одно принятие;
 *   кузница: три принятия — меньше порога, и правила у неё быть не должно.
 */
function seedKnownAnswer(dir: string) {
  for (let i = 1; i <= 9; i++) {
    seedTask(dir, `R-${i}`, [{ attempt: 1, outcome: 'completed', endedAt: iso(NOW) }])
  }
  for (let i = 1; i <= 4; i++) {
    seedTask(dir, `BL-${i}`, [
      { attempt: 1, outcome: 'completed', endedAt: iso(NOW) }, // завершено…
      { attempt: 2 }, // …и после этого пошёл ещё один подход: вернул человек
    ])
  }
  seedTask(dir, 'BL-9', [{ attempt: 1, outcome: 'completed', endedAt: iso(NOW) }])
  for (let i = 1; i <= 3; i++) {
    seedTask(dir, `F-${i}`, [{ attempt: 1, outcome: 'completed', endedAt: iso(NOW) }])
  }
}

describe('approvals suggest — арифметика по леджеру, ответ известен до прогона', () => {
  it('противоположные правила для двух классов, и каждое число со знаменателем', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    const out = suggest(dir)

    expect(out).toContain('ростер — принимать без вопроса')
    expect(out).toContain('одобрено без возврата 9 из 9')
    expect(out).toContain('бэклог — всегда спрашивать')
    expect(out).toContain('возвращено 4 из 5')
    // голого счёта без знаменателя в выводе не бывает
    expect(out).not.toMatch(/одобрено без возврата \d+\n/)
  })

  it('порог честности: класс с тремя решениями получает слова, а не правило', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    const out = suggest(dir)

    expect(out).toContain('кузница — данных мало, 3 решений')
    expect(out).not.toContain('кузница — принимать без вопроса')
    expect(out).not.toContain('кузница — всегда спрашивать')
  })

  it('порог — довод вызывающего: при --min 3 у той же кузницы правило появляется', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    const out = suggest(dir, ['--min', '3'])
    expect(out).toContain('кузница — принимать без вопроса')
    expect(out).toContain('одобрено без возврата 3 из 3')
  })

  it('повтор очереди — не решение человека, а ряд, которого никто не видел, — не решение вовсе', () => {
    const dir = ledgerDir()
    // провал → провал → принято: очередь повторяла сама, человек решил ОДИН раз
    seedTask(dir, 'BL-r', [
      { attempt: 1, outcome: 'failed', failureReason: 'agent_error', endedAt: iso(NOW) },
      { attempt: 2, outcome: 'failed', failureReason: 'agent_error', endedAt: iso(NOW) },
      { attempt: 3, outcome: 'completed', endedAt: iso(NOW) },
    ])
    // ряд, дописанный сверкой ПОСЛЕ факта: подход никто не наблюдал, решения по нему нет
    seedTask(dir, 'BL-x', [{ attempt: 1, outcome: 'completed', reconstructed: true, endedAt: iso(NOW) }])

    const out = suggest(dir)
    // ровно одно решение на весь класс — ни повторы, ни восстановленный ряд его не раздули
    expect(out).toContain('бэклог — данных мало, 1 решений')
  })

  it('два ряда об одной попытке — одно решение: считаются попытки, а не строки', () => {
    const dir = ledgerDir()
    // так это и лежит на диске: переход пишет свой ряд, круг — свой, номер попытки один
    seedTask(dir, 'R-2w', [
      { attempt: 1, outcome: 'completed', endedAt: iso(NOW) },
      { attempt: 1, outcome: 'completed', provider: 'claude', receiptRef: 'reverify:abc', endedAt: iso(NOW) },
    ])
    const out = suggest(dir, ['--json'])
    const parsed = JSON.parse(out)
    expect(parsed.decisions).toBe(1)
  })

  it('машиночитаемая правда — та же самая, и пути леджера в ней нет', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    const parsed = JSON.parse(suggest(dir, ['--json']))
    const byClass = Object.fromEntries(parsed.classes.map((c: any) => [c.class, c]))

    expect(byClass['ростер']).toMatchObject({ decisions: 9, accepted: 9, returned: 0, enough: true, rule: 'принимать без вопроса' })
    expect(byClass['бэклог']).toMatchObject({ decisions: 5, accepted: 1, returned: 4, enough: true, rule: 'всегда спрашивать' })
    expect(byClass['кузница']).toMatchObject({ decisions: 3, enough: false, rule: null })
    // ничего не включено и ничего не написано — это сказано и в машинном ответе
    expect(parsed.enabledAnything).toBe(false)
    expect(parsed.wrote).toBe(false)
    // наружу едут классы и счётчики; ни путей, ни текста записок
    expect(JSON.stringify(parsed)).not.toContain(dir)
  })
})

describe('approvals suggest — детерминизм и отсутствие записи', () => {
  it('два прогона подряд дают байт-в-байт один вывод', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    expect(suggest(dir)).toBe(suggest(dir))
  })

  it('команда не пишет НИ ОДНОГО файла: каталог до и после прогона одинаков', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    const before = snapshot(dir)
    suggest(dir)
    suggest(dir, ['--json'])
    expect(snapshot(dir)).toEqual(before)
  })

  it('вывод заканчивается тем, что включение — отдельный шаг человека', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    const out = suggest(dir)
    expect(out.trimEnd().endsWith('Это предложения, не правила: включение — отдельный шаг человека. Команда ничего не изменила.')).toBe(true)
  })
})

describe('approvals suggest — пустая история говорит «данных нет», а не падает', () => {
  it('пустой каталог: код выхода 0 и слова про отсутствие данных', () => {
    const dir = ledgerDir()
    const out = suggest(dir)
    expect(out).toContain('данных нет')
  })

  it('каталога нет вовсе: то же самое, а не исключение', () => {
    const out = suggest(join(tmpdir(), 'sma-no-such-ledger-approvals'))
    expect(out).toContain('данных нет')
  })

  it('битая строка стоит только себя — остальная история всё равно посчитана', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    writeFileSync(join(dir, 'R-broken.jsonl'), '{ это не json\n{"taskId":"R-broken","attempt":1,"outcome":"completed"}\n')
    const out = suggest(dir)
    expect(out).toContain('одобрено без возврата 10 из 10')
  })
})
