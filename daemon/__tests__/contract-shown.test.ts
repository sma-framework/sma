/**
 * ЗАМОК НА ПОСЛЕДНЕЕ ЗВЕНО — поле, доехавшее до окна, либо показано, либо названо непоказанным,
 * либо названо синонимом того, что показано.
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
 * `NOT_SHOWN` с причиной словами, либо стоит в `SHOWN_AS` с именем поля, под которым то же
 * значение доезжает до экрана.
 *
 * ═══ ПОЧЕМУ ВТОРОГО СПИСКА НЕ БЫЛО, И ПОЧЕМУ ОН ПОЯВИЛСЯ ═══
 * «Имени поля нет в рисующих файлах» — это НЕ «человек этого не видит». Наивный поиск по имени
 * на живой работе дал ложный ответ дважды подряд: расход за сегодня был объявлен непоказанным,
 * хотя человек читает его на «Расходах» — то же число приезжает туда полем `todayEur`. Замок,
 * умеющий только искать имя, повторял бы эту ошибку на каждом новом поле и уже без человека,
 * который потом перепроверит. Поэтому «показано под другим именем» — отдельный ответ, и он НЕ
 * верится на слово: названное поле обязано существовать в договоре и само встречаться в
 * рисующих файлах. Ниже это проверено обоими способами — и на зелёном, и на красном.
 *
 * ЗАМОК, КОТОРЫЙ НЕ УМЕЕТ КРАСНЕТЬ, — НЕ ЗАМОК. Поэтому правило прогоняется не только по
 * продукту: случаи ниже ведут его по выдуманному договору из нескольких строк — забытое поле
 * (красный), то же поле с причиной (зелёный), пустая причина (красный), синоним показанного
 * (зелёный), синоним непоказанного и синоним несуществующего (красный).
 *
 * И ОТДЕЛЬНО — ОДНО ЧИСЛО ОДНИМ ВЫРАЖЕНИЕМ. `kpis.spentTodayEur` и `costs.apiFallback.todayEur`
 * несут ОДИН расход платного канала за сегодня. Это и есть та форма дефекта, что нашлась под
 * этой работой: не «посчитано и не показано», а «посчитано ДВАЖДЫ, показана одна копия».
 * Утверждение о равенстве стоит на настоящем derive — там, где второе выражение и появилось бы.
 */

import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'

import {
  CONTRACT_FILE,
  MIN_REASON_WORDS,
  NOT_SHOWN,
  RENDER_DIRS,
  SHOWN_AS,
  checkShown,
  contractFields,
  readTree,
  reasonWords,
} from '../../tools/contract-shown-check.mjs'
import { deriveState } from '../src/front/state.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Выдуманный договор — на нём проверяется само правило, без участия продукта. */
const TOY_CONTRACT = [
  'export interface Toy {',
  '  shownField: string',
  '  forgottenField: number | null',
  '  hiddenTwin: number',
  '}',
].join('\n')

/** Выдуманный рисующий файл: называет первое поле и молчит об остальных. */
const TOY_RENDER = 'export function Toy({ shownField }: Toy) { return <span>{shownField}</span> }'

const REASON = 'служебный счётчик, решений человека не меняет'

describe('договор окна: показано или названо непоказанным', () => {
  it('поле договора, которое никто не рисует и никто не объяснил, красит сьют', () => {
    const out = checkShown({ contract: TOY_CONTRACT, render: TOY_RENDER, notShown: {}, shownAs: {} })

    expect(out.ok, 'забытое поле обязано быть находкой').toBe(false)
    expect(out.findings.map((f) => f.name).sort()).toEqual(['forgottenField', 'hiddenTwin'])
    expect(new Set(out.findings.map((f) => f.kind))).toEqual(new Set(['not-shown']))
    // Соседнее поле, которое рисуют, находкой быть не должно: замок ловит обрыв, а не всё подряд.
    expect(out.shown).toEqual(['shownField'])
  })

  it('то же поле с причиной словами сьют не красит', () => {
    const out = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: { forgottenField: REASON, hiddenTwin: REASON },
      shownAs: {},
    })

    expect(out.findings, `находок быть не должно: ${JSON.stringify(out.findings)}`).toEqual([])
    expect(out.ok).toBe(true)
  })

  it('пустая причина в списке не принимается — и причина в одно слово тоже', () => {
    for (const reason of ['', '   ', 'служебное']) {
      const out = checkShown({
        contract: TOY_CONTRACT,
        render: TOY_RENDER,
        notShown: { forgottenField: reason, hiddenTwin: REASON },
        shownAs: {},
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
        forgottenField: REASON,
        hiddenTwin: REASON,
        goneField: 'поля с таким именем в договоре нет',
      },
      shownAs: {},
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

describe('«показано под другим именем» — ответ, который проверяется, а не принимается на слово', () => {
  it('синоним ПОКАЗАННОГО поля сьют не красит', () => {
    const out = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: { forgottenField: REASON },
      shownAs: { hiddenTwin: { as: 'shownField', why: 'то же самое значение под именем соседа' } },
    })

    expect(out.findings, `находок быть не должно: ${JSON.stringify(out.findings)}`).toEqual([])
  })

  it('синоним НЕПОКАЗАННОГО поля красит — иначе «оно показано вон там» закрывало бы что угодно', () => {
    const out = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: {},
      shownAs: {
        hiddenTwin: { as: 'forgottenField', why: 'ссылка на такое же непоказанное поле' },
        forgottenField: { as: 'hiddenTwin', why: 'и обратно — круг из двух невидимых полей' },
      },
    })

    expect(out.findings.map((f) => f.kind).sort()).toEqual(['alias-not-shown', 'alias-not-shown'])
  })

  it('синоним несуществующего поля и синоним самого себя — обе находки по имени', () => {
    const unknown = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: { forgottenField: REASON },
      shownAs: { hiddenTwin: { as: 'noSuchField', why: 'такого поля в договоре нет вовсе' } },
    })
    expect(unknown.findings.map((f) => f.kind)).toEqual(['alias-unknown'])

    const self = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: { forgottenField: REASON },
      shownAs: { hiddenTwin: { as: 'hiddenTwin', why: 'сам себе синоним — ответ ни о чём' } },
    })
    expect(self.findings.map((f) => f.kind)).toEqual(['alias-self'])
  })

  it('синоним без причины словами не принимается — как и молчание в первом списке', () => {
    const out = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: { forgottenField: REASON },
      shownAs: { hiddenTwin: { as: 'shownField', why: '' } },
    })
    expect(out.findings.map((f) => f.kind)).toEqual(['reason-empty'])
  })

  it('поле, стоящее в обоих списках, — находка: это два разных ответа на один вопрос', () => {
    const out = checkShown({
      contract: TOY_CONTRACT,
      render: TOY_RENDER,
      notShown: { forgottenField: REASON, hiddenTwin: REASON },
      shownAs: { hiddenTwin: { as: 'shownField', why: 'и одновременно синоним показанного' } },
    })
    expect(out.findings.map((f) => f.kind)).toEqual(['listed-twice'])
  })
})

describe('живой договор окна против живых экранов', () => {
  it('каждое поле договора либо названо рисующим файлом, либо объяснено, либо названо синонимом', () => {
    const { contract, render, renderFiles } = readTree(ROOT)
    const out = checkShown({ contract, render })

    expect(renderFiles.length, `рисующие файлы не найдены: ${RENDER_DIRS.join(', ')}`).toBeGreaterThan(50)
    expect(contractFields(contract).length, `договор не разобрался: ${CONTRACT_FILE}`).toBeGreaterThan(100)
    expect(
      out.findings.map((f) => f.what),
      'поле договора без показа и без объяснения',
    ).toEqual([])
  })

  it('оба списка объясняют каждую запись словами и не растут сами', () => {
    for (const [name, reason] of Object.entries(NOT_SHOWN)) {
      expect(reasonWords(reason), `у «${name}» причина короче ${MIN_REASON_WORDS} слов`).toBeGreaterThanOrEqual(
        MIN_REASON_WORDS,
      )
    }
    for (const [name, entry] of Object.entries(SHOWN_AS)) {
      expect(typeof entry.as, `у «${name}» не названо имя, под которым значение видно`).toBe('string')
      expect(reasonWords(entry.why), `у «${name}» причина короче ${MIN_REASON_WORDS} слов`).toBeGreaterThanOrEqual(
        MIN_REASON_WORDS,
      )
    }
    // Списки — предмет решения человека, а не побочный продукт прогона: они заморожены, и код,
    // который захотел бы дописать в них имя на ходу, упадёт здесь, а не тихо разрастит их.
    expect(Object.isFrozen(NOT_SHOWN)).toBe(true)
    expect(Object.isFrozen(SHOWN_AS)).toBe(true)
  })
})

describe('расход за сегодня: одно число, одно выражение', () => {
  const NOW = Date.UTC(2026, 7, 29, 12, 0, 0)
  const HOUR = 3600_000
  const win = (status: string, resetsAt: number | null = null) => ({ status, resetsAt, pct: null, observedAt: null })

  it('kpis.spentTodayEur и costs.apiFallback.todayEur — одно и то же на настоящем derive', async () => {
    const config = {
      budget: { monthlyApiCapEur: 50 },
      workers: [
        { id: 'max-1', lane: 'prod', account: { name: 'max-1' } },
        { id: 'max-2', lane: 'prod', account: { name: 'max-2' } },
      ],
    }
    const payload: any = await deriveState({
      adapter: { list: async () => [] },
      windows: () => ({ fiveHour: win('open', NOW + HOUR), week: win('open', NOW + 48 * HOUR) }),
      config,
      // Названо по аккаунтам поимённо: дверь обходит не только работников, но и счёт самого
      // платного канала, и «всё, что не max-1» тихо добавило бы к дню третье слагаемое.
      usageReader: ({ accountName }: any) => {
        const paid: Record<string, number> = { 'max-1': 2.4, 'max-2': 1.15 }
        const costUsd = paid[accountName] ?? 0
        return { costUsd, apiCostUsd: costUsd }
      },
      clock: () => NOW,
    })

    // Не «оба около трёх с половиной»: РОВНО одно значение. Разойтись они могут только если
    // кто-то заведёт второе выражение — и тогда этот случай краснеет раньше, чем два экрана
    // начнут спорить между собой.
    expect(payload.kpis.spentTodayEur).toBe(payload.costs.apiFallback.todayEur)
    expect(payload.kpis.spentTodayEur).toBe(3.55)
  })

  it('дубликат объявлен синонимом ИМЕННО того поля, которым человек его читает', () => {
    expect(SHOWN_AS.spentTodayEur.as).toBe('todayEur')

    // И это утверждение не декларация: проверка требует, чтобы «todayEur» действительно
    // называл хоть один рисующий файл. Без этого запись была бы вежливым способом промолчать.
    const { contract, render } = readTree(ROOT)
    const out = checkShown({ contract, render })
    expect(out.findings.filter((f: any) => f.name === 'spentTodayEur')).toEqual([])
  })
})
