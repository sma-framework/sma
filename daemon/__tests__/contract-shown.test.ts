/**
 * ЗАМОК НА ПОСЛЕДНЕЕ ЗВЕНО — поле, доехавшее до окна, либо показано, либо названо непоказанным.
 *
 * ЧТО ЭТОТ ФАЙЛ ЗАКРЫВАЕТ, И ПОЧЕМУ ЭТОГО НЕ ДЕЛАЛ НИ ОДИН СОСЕД. За один день четыре разные
 * работы вскрыли ОДИН класс — «посчитано и не подключено», — и формы обрыва у них были разные:
 * число считалось внутри демона и до двери не доезжало; значение доезжало и оставалось в типах;
 * полоса была написана, но никто на неё не назначен; провод был цел у читателя и оборван у
 * писателя. Общего механизма нет — значит это не четыре дефекта, а след ПРОБЕЛА В ПРОВЕРКАХ:
 * сьют утверждает вычисление, ворота — зелень и чистоту текстов, и НИКТО не утверждает
 * последнее звено. Вопрос «а человек это видит» задавал только живой прогон окна — по
 * сценарию, который пишет автор работы, и тогда, когда о нём вспомнили.
 *
 * ЗДЕСЬ ЭТОТ ВОПРОС ЗАДАЁТ СЬЮТ. Каждое имя поля из договора окна (`spa/src/api/types.ts`) либо
 * встречается в файлах, которые рисуют (`spa/src/screens/**`, `spa/src/shell/**`), либо стоит в
 * списке `NOT_SHOWN` с причиной словами.
 *
 * ЗАМОК, КОТОРЫЙ НЕ УМЕЕТ КРАСНЕТЬ, — НЕ ЗАМОК. Поэтому правило прогоняется не только по
 * продукту: три случая ведут его по выдуманному договору из нескольких строк — забытое поле
 * (красный), то же поле с причиной (зелёный), то же поле с пустой причиной (снова красный).
 * Проверка на продукте без этих трёх доказывала бы только то, что сегодня всё сошлось, и
 * молчала бы в день, когда сломается сама.
 *
 * И ОТДЕЛЬНО — РАСХОД ЗА СЕГОДНЯ, на файлах ПОКАЗА, а не на типах. Он был первым найденным
 * обрывом этого класса: дверь считала `kpis.spentTodayEur` с самого начала, окно объявляло его
 * в договоре, и ни один экран его не рисовал — при том что про деньги спрашивают регулярно.
 * Утверждение о нём нарочно смотрит в тот файл, который рисует, потому что утверждение,
 * смотрящее в типы, было бы ровно тем, что этот класс и пропустило.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CONTRACT_FILE,
  MIN_REASON_WORDS,
  NOT_SHOWN,
  RENDER_DIRS,
  checkShown,
  contractFields,
  readTree,
  reasonWords,
} from '../../tools/contract-shown-check.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const KPI_STRIP = fileURLToPath(new URL('../../spa/src/screens/today/KpiStrip.tsx', import.meta.url))

/** Выдуманный договор в три поля — на нём проверяется само правило, без участия продукта. */
const TOY_CONTRACT = [
  'export interface Toy {',
  '  shownField: string',
  '  forgottenField: number | null',
  '}',
].join('\n')

/** Выдуманный рисующий файл: называет первое поле и молчит о втором. */
const TOY_RENDER = 'export function Toy({ shownField }: Toy) { return <span>{shownField}</span> }'

describe('договор окна: показано или названо непоказанным', () => {
  it('поле договора, которое никто не рисует и никто не объяснил, красит сьют', () => {
    const out = checkShown({ contract: TOY_CONTRACT, render: TOY_RENDER, notShown: {} })

    expect(out.ok, 'забытое поле обязано быть находкой').toBe(false)
    expect(out.findings.map((f) => f.name)).toEqual(['forgottenField'])
    expect(out.findings[0].kind).toBe('not-shown')
    // Соседнее поле, которое рисуют, находкой быть не должно: замок ловит обрыв, а не всё подряд.
    expect(out.shown).toEqual(['shownField'])
  })

  it('то же поле с причиной словами сьют не красит', () => {
    const out = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: { forgottenField: 'служебный счётчик, решений человека не меняет' },
    })

    expect(out.findings, `находок быть не должно: ${JSON.stringify(out.findings)}`).toEqual([])
    expect(out.ok).toBe(true)
  })

  it('пустая причина в списке не принимается — и причина в одно слово тоже', () => {
    for (const reason of ['', '   ', 'служебное']) {
      const out = checkShown({
        contract: TOY_CONTRACT,
        render: TOY_RENDER,
        notShown: { forgottenField: reason },
      })
      expect(out.ok, `причина «${reason}» не должна закрывать поле`).toBe(false)
      expect(out.findings[0].kind).toBe('reason-empty')
      expect(out.findings[0].name).toBe('forgottenField')
    }
  })

  it('устаревшая запись списка — тоже находка: поле уже рисуют, либо его больше нет в договоре', () => {
    const stale = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: {
        shownField: 'причина словами, но поле уже рисуют',
        forgottenField: 'настоящая причина словами здесь',
        goneField: 'поля с таким именем в договоре нет',
      },
    })

    expect(stale.findings.map((f) => f.kind).sort()).toEqual(['stale-shown', 'stale-unknown'])
  })

  it('имена полей читаются из договора, а строки документации за поля не принимаются', () => {
    const fields = contractFields(
      ['/**', ' * claimedAt: сколько миллисекунд назад — это ТЕКСТ, а не поле.', ' */', 'export interface X {', '  real: string', '}'].join(
        '\n',
      ),
    )
    expect(fields.map((f) => f.name)).toEqual(['real'])
  })

  it('причина меряется словами, а не длиной строки', () => {
    expect(reasonWords('  одно  два   три  ')).toBe(3)
    expect(reasonWords(null)).toBe(0)
    expect(MIN_REASON_WORDS).toBeGreaterThanOrEqual(2)
  })
})

describe('живой договор окна против живых экранов', () => {
  it('каждое поле договора либо названо рисующим файлом, либо стоит в списке с причиной', () => {
    const { contract, render, renderFiles } = readTree(ROOT)
    const out = checkShown({ contract, render })

    expect(renderFiles.length, `рисующие файлы не найдены: ${RENDER_DIRS.join(', ')}`).toBeGreaterThan(50)
    expect(contractFields(contract).length, `договор не разобрался: ${CONTRACT_FILE}`).toBeGreaterThan(100)
    expect(
      out.findings.map((f) => f.what),
      'поле договора без показа и без объяснения',
    ).toEqual([])
  })

  it('список непоказанных объясняет каждую запись словами и не растёт сам', () => {
    for (const [name, reason] of Object.entries(NOT_SHOWN)) {
      expect(reasonWords(reason), `у «${name}» причина короче ${MIN_REASON_WORDS} слов`).toBeGreaterThanOrEqual(
        MIN_REASON_WORDS,
      )
    }
    // Список — предмет решения человека, а не побочный продукт прогона: он заморожен, и код,
    // который захотел бы дописать в него имя на ходу, упадёт здесь, а не тихо разрастит его.
    expect(Object.isFrozen(NOT_SHOWN)).toBe(true)
  })
})

describe('расход за сегодня доехал до человека', () => {
  it('полоса дня рисует kpis.spentTodayEur — утверждение смотрит в файл показа, а не в типы', () => {
    const strip = readFileSync(KPI_STRIP, 'utf8')

    expect(strip, 'полоса дня не читает расход из чтения').toContain('spentTodayEur')
    expect(strip, 'у числа нет подписи, по которой человек узнаёт расход').toContain('Расход за сегодня')
    // Деньги форматируются ОДНИМ форматером на всё окно: вторая функция для евро — это второе
    // мнение о том, как выглядит сумма, и она разойдётся с «Расходами» на первой же правке.
    expect(strip).toContain('formatEur')
  })
})
