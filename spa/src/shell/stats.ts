/**
 * stats.ts — ОКОШКО ПОКАЗАТЕЛЕЙ: во что обошлась сущность, собранное из полей дверей и ни из
 * чего больше.
 *
 * ═════════════════ ПОЧЕМУ ЭТО ФУНКЦИЯ, А НЕ РАЗМЕТКА ВНУТРИ ЭКРАНА ═════════════════
 *
 * Показатель, посчитанный прямо в вёрстке, проверяется ровно одним способом — человеческим
 * глазом на живом экране, — и поэтому расходится с правдой молча: никто не заметит, что «6/9
 * задач» на самом деле считает строки очереди вместе с повторами, а «токены в/из» показывают
 * кэш. Раскладка по столбикам уехала в `units.ts` по этой же причине и по той же причине
 * утверждается прогоном; здесь то же самое для чисел фазы и батча.
 *
 * ═════════════════════ ПРОЧЕРК — ЭТО УТВЕРЖДЕНИЕ, А НЕ ПУСТОЕ МЕСТО ═════════════════════
 *
 * Числа приезжают с двух разных этажей честности, и окно обязано их различать:
 *
 *   · ИЗМЕРЕННЫЙ НОЛЬ — «ходов ноль» у фазы, за задачи которой ещё никто не брался. Строки
 *     известны поимённо, спрашивать было у кого, ответ — ноль.
 *   · НЕИЗМЕРЕННОЕ — попытки старше поля токенов, каталога прогонов нет вовсе, поле не отдаёт
 *     демон постарше. Ноль на этом месте назвал бы бесплатной работу, которую никто не мерил.
 *
 * Второе показывается прочерком и НЕСЁТ ПРИЧИНУ СЛОВАМИ (`why`), потому что «—» без объяснения
 * человек читает как поломку экрана. Ни один показатель здесь не выдумывается: чего дверь не
 * сказала, того окно не знает.
 *
 * ═══════════════════════ ДЕНЬГИ НЕ ВЫДУМЫВАЮТСЯ ТЕМ БОЛЕЕ ═══════════════════════
 *
 * «Подписка» и «платный API» стоят в окошке потому, что владелец спрашивает о них у каждой
 * сущности, — и стоят прочерком, потому что расход по фазе и по сборке в деньгах никто не
 * считает: у квитанции попытки есть четыре числа поставщика и нет ни цены, ни канала.
 * Посчитать «$8.12» из токенов по своему курсу — это и есть выдумка, самая правдоподобная из
 * возможных.
 */

import type { BatchRow, PhaseCard, PhaseStage, PhaseStageStatus, TokenSums } from '../api/types'
import { STAGE_ORDER } from './format'

/** Число, которого никто не измерял. Одно написание на всё окно. */
export const NOT_MEASURED = '—'

/**
 * Один показатель окошка.
 *
 * `key` — устойчивое имя, а не место в списке: прогон находит показатель по нему, и порядок
 * можно менять, не переписывая утверждений о числах.
 */
export interface Stat {
  key: string
  /** Число, как его читают глазами; у неизмеренного — прочерк. */
  value: string
  label: string
  /** `false` — числа нет по-честному; тогда `why` говорит, почему. */
  known: boolean
  why?: string
}

/** Причины, по которым числа нет. Названы один раз — экран их только показывает. */
const WHY_NO_MONEY = 'деньги по этой сущности никто не считает — расход виден в токенах'
const WHY_NO_TOKENS = 'квитанций с числами нет: попытки старше этого поля или прогонов не было'
const WHY_NO_ROWS = 'строк работы окно не получило — считать не по чему'
const WHY_NO_START = 'работу ещё никто не брал — мерить не от чего'
const WHY_NO_REQUEST = 'сборка старше отметки о просьбе — момент не записан'

function stat(key: string, value: string, label: string): Stat {
  return { key, value, label, known: true }
}

function missing(key: string, label: string, why: string): Stat {
  return { key, value: NOT_MEASURED, label, known: false, why }
}

/**
 * Крупное число человеческим глазом: 1 900 000 → «1,9М», 214 000 → «214К».
 *
 * Округление здесь — про ЧТЕНИЕ, а не про экономию: точные семь цифр в строке из десяти
 * показателей не читаются вовсе. Полная точность живёт на экране расхода, где число — предмет
 * разговора, а не подпись.
 */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return NOT_MEASURED
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}М`
  if (abs >= 1000) return `${(n / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}К`
  return String(Math.round(n))
}

/** «вход/выход» одной парой — так их и спрашивают. */
function pairOf(a: number, b: number): string {
  return `${compactNumber(a)}/${compactNumber(b)}`
}

/** Циферблат момента, в часовом поясе читателя. Момента нет — прочерк. */
export function clockOfMs(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const at = new Date(ms)
  if (Number.isNaN(at.getTime())) return null
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * Сколько времени прошло с момента до «сейчас»: «2 ч 40 м», «49 м», «меньше минуты».
 *
 * «Сейчас» ПРИХОДИТ СНАРУЖИ — часы дёргает тот, кто рисует, а не тот, кто считает: проекция,
 * читающая часы сама, недоказуема прогоном, и именно такую разницу никто потом не замечает.
 */
export function elapsedLabel(from: number | null | undefined, now: number): string | null {
  if (typeof from !== 'number' || !Number.isFinite(from)) return null
  const ms = now - from
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'меньше минуты'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} м`
  return m > 0 ? `${h} ч ${m} м` : `${h} ч`
}

/**
 * СТАДИЯ, НА КОТОРОЙ ФАЗА СЕЙЧАС СТОИТ — одно правило на всю карточку.
 *
 * Идущая; если ни одна не идёт — первая незакрытая; если закрыты все — последняя. Это же
 * правило открывает стадию человеку, когда он ещё ничего не выбирал, и оно же считает «стадия
 * N из 4»: два написания разошлись бы, и число указывало бы не на ту стадию, которая раскрыта.
 */
export function currentStage(stages: Record<PhaseStage, PhaseStageStatus>): PhaseStage {
  return (
    STAGE_ORDER.find((s) => stages[s] === 'in-progress') ??
    STAGE_ORDER.find((s) => stages[s] !== 'done') ??
    STAGE_ORDER[STAGE_ORDER.length - 1]
  )
}

/** Четыре числа поставщика двумя показателями — или два прочерка с одной причиной. */
function tokenStats(tokens: TokenSums | null | undefined): Stat[] {
  if (!tokens) {
    return [
      missing('tokens', 'токены в/из', WHY_NO_TOKENS),
      missing('cache', 'кэш чт/зп', WHY_NO_TOKENS),
    ]
  }
  return [
    stat('tokens', pairOf(tokens.input, tokens.output), 'токены в/из'),
    stat('cache', pairOf(tokens.cacheRead, tokens.cacheWrite), 'кэш чт/зп'),
  ]
}

/**
 * phaseStats(phase, now) → окошко показателей фазы, в порядке принятого макета.
 *
 * Стадия и планы известны всегда — это чтение каталога, и оно либо есть, либо карточки нет
 * вовсе. Задачи, ходы и старт приезжают из строк очереди и отсутствуют вместе с ними, одной
 * причиной на три: спрашивать было не у кого.
 */
export function phaseStats(phase: PhaseCard, now: number): Stat[] {
  const stage = currentStage(phase.stages)
  const work = phase.work ?? null
  const startedAt = work ? work.startedAt : null
  const clock = clockOfMs(startedAt)
  const running = elapsedLabel(startedAt, now)

  return [
    stat('stage', `${STAGE_ORDER.indexOf(stage) + 1} из ${STAGE_ORDER.length}`, 'стадия'),
    stat('plans', String(phase.plans.length), plansLabel(phase.plans.length)),
    work
      ? stat('tasks', `${work.done}/${work.tasks}`, 'задач закрыто')
      : missing('tasks', 'задач закрыто', WHY_NO_ROWS),
    work ? stat('attempts', String(work.attempts), 'ходов') : missing('attempts', 'ходов', WHY_NO_ROWS),
    missing('subscription', 'подписка', WHY_NO_MONEY),
    ...tokenStats(phase.tokens),
    missing('paidApi', 'платный API', WHY_NO_MONEY),
    clock ? stat('startedAt', clock, 'старт') : missing('startedAt', 'старт', WHY_NO_START),
    running ? stat('running', running, 'идёт') : missing('running', 'идёт', WHY_NO_START),
  ]
}

/** «планов» / «план» — подпись читается вслух вместе со своим числом. */
function plansLabel(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m100 >= 11 && m100 <= 14) return 'планов'
  if (m10 === 1) return 'план'
  if (m10 >= 2 && m10 <= 4) return 'плана'
  return 'планов'
}

/**
 * batchStats(batch, now) → окошко показателей сборки.
 *
 * Элементы считаются по самим элементам — они и есть сборка, — а «ходы» приезжают полем двери:
 * подход записан на строке очереди, и другого источника у этого числа нет. Момент просьбы и
 * длительность считаются от ОДНОЙ отметки: «идёт 49 м» и «запрос 14:02» обязаны говорить об
 * одном и том же событии, иначе они противоречат друг другу на глазах у человека.
 */
export function batchStats(batch: BatchRow, now: number): Stat[] {
  const items = batch.items ?? []
  const done = items.filter((i) => i.state === 'done').length
  const requestedAt = typeof batch.requestedAt === 'number' ? batch.requestedAt : null
  const clock = clockOfMs(requestedAt)
  const running = elapsedLabel(requestedAt, now)

  return [
    stat('items', `${done}/${items.length}`, 'элементов готово'),
    typeof batch.attempts === 'number'
      ? stat('attempts', String(batch.attempts), 'ходов')
      : missing('attempts', 'ходов', WHY_NO_ROWS),
    missing('subscription', 'подписка', WHY_NO_MONEY),
    ...tokenStats(batch.tokens),
    missing('paidApi', 'платный API', WHY_NO_MONEY),
    clock ? stat('requestedAt', clock, 'запрос') : missing('requestedAt', 'запрос', WHY_NO_REQUEST),
    running ? stat('running', running, 'идёт') : missing('running', 'идёт', WHY_NO_REQUEST),
  ]
}

/**
 * Одной строкой под окошком: что означают прочерки, которые в нём стоят.
 *
 * Причины собираются из САМИХ показателей и не повторяются: прочерк без объяснения читается
 * как сломанный экран, а объяснение, написанное отдельно от чисел, устареет первым же новым
 * показателем. `null` — прочерков нет, и говорить нечего.
 */
export function missingWords(stats: Stat[]): string | null {
  const whys: string[] = []
  for (const s of stats) {
    if (s.known || !s.why || whys.includes(s.why)) continue
    whys.push(s.why)
  }
  if (whys.length === 0) return null
  return `«${NOT_MEASURED}» значит «не измеряли»: ${whys.join('; ')}.`
}
