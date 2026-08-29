/**
 * ШИРОКАЯ ТАБЛИЦА ПРОКРУЧИВАЕТСЯ ВНУТРИ СЕБЯ, А НЕ ТОЛКАЕТ СТРАНИЦУ.
 *
 * ═══════════════ ЧТО ЭТО ЗА ПРАВИЛО И ПОЧЕМУ ОНО ОБЩЕЕ ═══════════════
 * Таблица «Куда ушла работа» держит семь колонок, шесть из них фиксированной ширины: четыре
 * счётчика по 96, деньги 110, справочная цена 128 и шесть зазоров — почти семьсот пикселей,
 * которые нельзя сжать. Коробка с такой сеткой и без собственной прокрутки растягивает не
 * себя, а СТРАНИЦУ: вбок уезжает всё окно вместе с шапкой и боковым меню, и человек ищет
 * содержимое, таская страницу целиком. Движок живого прогона ругается ровно на это, и правило
 * это не про одну таблицу — оно про любую широкую коробку в окне.
 *
 * ═══════════════ ПОЧЕМУ ЧИСЛО СЧИТАЕТСЯ, А НЕ НАБИРАЕТСЯ РУКАМИ ═══════════════
 * У прокрутки внутри себя есть вторая половина: внутренняя коробка обязана нести минимальную
 * ширину, иначе сетка просто сожмётся до нечитаемого и «прокручивать» станет нечего. Написать
 * это число рядом руками — значит завести ВТОРОЕ число об одной и той же сетке; на первой же
 * добавленной колонке они разойдутся, и разойдутся молча. Поэтому минимум считается ИЗ САМОЙ
 * строки класса сетки (`gridMinPx`), а сьют проверяет и арифметику, и то, что разметка берёт
 * именно её.
 *
 * ЧТО ЭТОТ ФАЙЛ НЕ УТВЕРЖДАЕТ. Он не заменяет живой прогон окна: ширина коробки на настоящем
 * экране — вопрос к браузеру, а не к строке класса. Он закрывает то, что дешевле всего
 * проглядеть и что живой прогон покажет уже постфактум — сетку, вынесенную из-под прокрутки,
 * и минимум, отставший от числа колонок.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GRID, SPEND_GRID_MIN_PX, SPEND_LABEL_MIN_PX, gridMinPx } from '../../spa/src/screens/costs/grid.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TABLE = readFileSync(join(ROOT, 'spa', 'src', 'screens', 'costs', 'SpendTable.tsx'), 'utf8')

describe('таблица расходов: минимум считается из самой сетки', () => {
  it('складывает фиксированные дорожки, зазоры между ВСЕМИ и пол гибкой колонки', () => {
    // Разложено поимённо, чтобы число не было волшебным: 4×96 + 110 + 128 фиксированных,
    // шесть зазоров по 12 (gap-3), и пол первой колонки — она гибкая и своей ширины не имеет.
    const fixed = 4 * 96 + 110 + 128
    const gaps = 6 * 12
    expect(SPEND_GRID_MIN_PX).toBe(fixed + gaps + SPEND_LABEL_MIN_PX)
    expect(SPEND_GRID_MIN_PX).toBe(914)
  })

  it('добавленная колонка меняет минимум — забыть его молча нельзя', () => {
    const seven = 'grid grid-cols-[minmax(0,1fr)_repeat(4,96px)_110px_128px] gap-3'
    const eight = 'grid grid-cols-[minmax(0,1fr)_repeat(4,96px)_110px_128px_90px] gap-3'
    expect(gridMinPx(eight, 0)).toBe(gridMinPx(seven, 0) + 90 + 12) // колонка И её зазор
    expect(gridMinPx(seven, 0)).toBeLessThan(gridMinPx(eight, 0))
  })

  it('зазор читается из класса, а не подразумевается', () => {
    const tracks = 'grid grid-cols-[100px_100px]'
    expect(gridMinPx(`${tracks} gap-0`, 0)).toBe(200)
    expect(gridMinPx(`${tracks} gap-3`, 0)).toBe(212) // один зазор в 12px
    expect(gridMinPx(`${tracks} gap-6`, 0)).toBe(224) // и в 24px
  })

  it('гибкая дорожка своей ширины не даёт, но зазор после себя оставляет', () => {
    expect(gridMinPx('grid grid-cols-[minmax(0,1fr)_100px] gap-3', 0)).toBe(112)
    expect(gridMinPx('grid grid-cols-[minmax(0,1fr)] gap-3', 0)).toBe(0)
  })
})

describe('таблица расходов: сетка живёт под своей прокруткой', () => {
  it('строки завёрнуты в собственный контейнер прокрутки', () => {
    expect(TABLE).toMatch(/className="overflow-x-auto"/)
  })

  it('внутренняя коробка несёт посчитанный минимум, а не набранное руками число', () => {
    expect(TABLE).toMatch(/minWidth: `\$\{SPEND_GRID_MIN_PX\}px`/)
    // …и «руками» — это именно то, чего быть не должно: пикселей у минимума в разметке нет.
    expect(TABLE).not.toMatch(/min-w-\[\d+px\]/)
  })

  it('каждая строка сетки стоит ПОД прокруткой, ни одна не осталась снаружи', () => {
    const opens = TABLE.indexOf('className="overflow-x-auto"')
    expect(opens).toBeGreaterThan(-1)
    // Все употребления сетки — после открытия прокрутки и до закрывающей пары тегов под ней.
    const uses = [...TABLE.matchAll(/\$\{GRID\}/g)].map((m) => m.index ?? -1)
    expect(uses.length).toBeGreaterThanOrEqual(3) // шапка, строки, итог
    for (const at of uses) expect(at).toBeGreaterThan(opens)
  })

  it('подпись под таблицей остаётся СНАРУЖИ прокрутки — прозу вбок не таскают', () => {
    const lastGrid = TABLE.lastIndexOf('${GRID}')
    const note = TABLE.indexOf('«Как по API» — справочно')
    expect(lastGrid).toBeGreaterThan(-1)
    expect(note).toBeGreaterThan(lastGrid)
    // Между последней строкой сетки и подписью закрываются ТРИ коробки: сама строка,
    // внутренняя коробка с минимумом и контейнер прокрутки. Подпись — уже за ними.
    const between = TABLE.slice(lastGrid, note)
    expect(between.match(/<\/div>/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('сетка в разметке — ТА ЖЕ, из которой посчитан минимум', () => {
    // Разметка берёт сетку импортом, а не своей копией строки: копия разошлась бы с
    // минимумом молча, и прокрутка снова стала бы сжатием.
    expect(TABLE).toMatch(/import \{ GRID, SPEND_GRID_MIN_PX \} from '\.\/grid'/)
    expect(TABLE).not.toContain(GRID) // строки класса в разметке нет — только имя
  })
})
