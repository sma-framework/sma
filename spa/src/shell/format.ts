/**
 * format.ts — the words and the numbers the window puts on the glass.
 *
 * It began beside «Сегодня», the first screen that needed it. Six screens borrow it now,
 * so it lives in the shell — where the registry says anything two screens both need
 * belongs. The move is that decision made out loud; not a word of the wording changed, so
 * every screen still says a count, a clock face and a colour exactly as before.
 *
 * Nothing here invents a fact. Every helper takes what the reading already said and puts
 * it into Russian a person reads without translating: hours, attempts, a clock time. A
 * value that is not there stays a dash — an empty place is never dressed up as a zero.
 */

import { ApiError, isDeadline, isNotReady, isRaceLost } from '../api/client'
import type { PhaseStage, ReceiptProof, ReceiptSummary, TaskStatus, WindowFact } from '../api/types'

/**
 * What each stage of a phase is called on the glass.
 *
 * It began beside «Конвейер фаз», the first screen with stages on it, and moved here the day
 * the conversation grew a stage draft of its own — the registry's rule for a thing two
 * screens both need, applied rather than quietly copied. Two spellings of «Приёмка» would be
 * two screens naming one stage differently, which is exactly how a person learns to check
 * which screen they are on before believing it.
 */
export const STAGE_LABEL: Record<PhaseStage, string> = {
  discuss: 'Обсуждение',
  plan: 'План',
  design: 'Дизайн',
  execute: 'Исполнение',
  verify: 'Приёмка',
}

/**
 * ПОРЯДОК СТАДИЙ — дорога фазы, названная один раз.
 *
 * Он жил у экрана фаз, пока его не спросил ВТОРОЙ читатель: окошко показателей считает по нему
 * «стадия N из N», и это тот же вопрос, что рисует дорога. Поэтому порядок переехал сюда, к
 * названиям стадий, — по тому же правилу, по которому здесь оказались они сами, — а прежнее
 * место его перепубликует. Два написания одной дороги однажды разошлись бы, и «стадия 3 из 5»
 * указывала бы не на ту стадию, которую человек видит открытой.
 *
 * ДЛИНА ДОРОГИ НИГДЕ НЕ ЗАПИСАНА ЧИСЛОМ — она считается по этому списку. Ровно поэтому дизайн,
 * вставший между планом и исполнением, не потребовал править ни одного счётчика: место, где
 * длина стояла бы цифрой, — это и есть место, где счёт разошёлся бы с дорогой молча.
 */
export const STAGE_ORDER: readonly PhaseStage[] = [
  'discuss',
  'plan',
  'design',
  'execute',
  'verify',
] as const

/** Russian counts three ways. This is that rule, written once. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m100 >= 11 && m100 <= 14) return many
  if (m10 === 1) return one
  if (m10 >= 2 && m10 <= 4) return few
  return many
}

/** How long something has been waiting. Past a day the minutes stop meaning anything. */
export function hoursLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return 'меньше часа'
  if (hours >= 24) {
    const whole = Math.round(hours)
    return `${whole} ${plural(whole, 'час', 'часа', 'часов')}`
  }
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m} м`
  return m > 0 ? `${h} ч ${m} м` : `${h} ч`
}

/** How many runs at it were taken. */
export function attemptsLabel(n: number): string {
  return `${n} ${plural(n, 'подход', 'подхода', 'подходов')}`
}

/** Разметка пункта в начале строки — та же, что читает очередь (`PROMISE_BULLET` в adapter.mjs). */
const PROMISE_BULLET = /^[ \t]*(?:[-–—*•]|\d{1,2}[.)])[ \t]+(\S.*)$/

/**
 * ОБЕЩАННОЕ — СПИСКОМ, и ОДИН путь чтения на всё окно.
 *
 * Поле `acceptance` живёт в двух видах: одной строкой (так написана всякая запись, сделанная до
 * появления списка) и списком признаков. Три экрана читали его тремя способами — и только один
 * из трёх читал правильно. Карточка задачи звала вот эту функцию и рисовала пункты по одному;
 * «Сегодня» и панель задачи подставляли значение в текст КАК ЕСТЬ, а массив, подставленный в
 * текст, склеивается вплотную: «…файл существуетВ нём названа дата…». Три предложения читались
 * одним, границы пунктов исчезали, и пункт приёмки было физически не прочитать.
 *
 * Поэтому запись переехала сюда, где живёт всё, что нужно двум экранам сразу, и осталась ОДНА.
 * Строку режет ЕЁ СОБСТВЕННАЯ разметка — тире, звёздочка, номер в начале строки, — и ничего
 * кроме: резать сплошной текст по точкам и запятым значило бы расставить границы, которых
 * автор не ставил, и отчитаться потом по выдуманному пункту.
 *
 * ЭТО ЗЕРКАЛО `acceptanceItems` ИЗ ОЧЕРЕДИ, И ОНО СВЕРЯЕТСЯ ПРОГОНОМ (promise-shape.test.ts).
 * Читающих троп две, потому что окно не ходит в код демона; разъехавшись, они показали бы
 * человеку не тот список признаков, по которому судят работника, — а по пунктам обещания
 * считается ещё и потолок ходов, так что расхождение стоило бы работе цены.
 */
export function acceptanceList(acceptance: string | string[] | null | undefined): string[] {
  if (Array.isArray(acceptance)) return acceptance.map((s) => s.trim()).filter((s) => s.length > 0)
  const one = (acceptance ?? '').trim()
  if (one.length === 0) return []
  const lines = one.split(/\r?\n/)
  if (!lines.some((l) => PROMISE_BULLET.test(l))) return [one]

  const items: string[] = []
  let cur: string | null = null
  const close = () => {
    if (cur === null) return
    const s = cur.trim()
    if (s.length > 0) items.push(s)
    cur = null
  }
  for (const line of lines) {
    const marked = PROMISE_BULLET.exec(line)
    if (marked) {
      close()
      cur = marked[1].trim()
      continue
    }
    if (line.trim().length === 0) {
      close()
      continue
    }
    cur = cur === null ? line.trim() : `${cur} ${line.trim()}`
  }
  close()
  return items.length > 0 ? items : [one]
}

/** The clock face of a moment, in the reader's own time. A missing moment stays a dash. */
export function clockLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * WHAT A SUBSCRIPTION WINDOW IS DOING, IN ONE SENTENCE — the whole window's vocabulary for it.
 *
 * Five screens show these windows, and until now four of them drew a percentage bar. There is
 * no percentage: the provider tells us which window, whether it is still letting work through,
 * and when it resets — and nothing else. The figure the bars drew was this daemon's own token
 * count against an invented capacity, and on a machine where a person also works in his own
 * terminal it read near zero on a subscription that was nearly spent. A zero bar is read as
 * «the quota is free», so the bars are gone from every one of the five.
 *
 * A window nobody has heard from says «нет данных», never «0%». That distinction is the entire
 * point: an empty place is honest, a zero is a claim.
 */
export function windowWords(fact: WindowFact | null | undefined): { text: string; dot: string; muted: boolean } {
  const status = fact?.status ?? 'unknown'
  const at = fact?.resetsAt ? clockLabel(fact.resetsAt) : null
  if (status === 'exhausted') {
    return { text: at ? `исчерпано · откроется в ${at}` : 'исчерпано', dot: 'bg-warn', muted: false }
  }
  if (status === 'open') {
    return { text: at ? `принимает работу · сбросится в ${at}` : 'принимает работу', dot: 'bg-green', muted: false }
  }
  return { text: 'нет данных', dot: 'bg-tx3', muted: true }
}

/** Why a window can read «нет данных» — the same explanation wherever that phrase appears. */
export const WINDOW_UNKNOWN_HINT =
  'Об этом окне ещё ничего не приходило. Поставщик сообщает о нём в потоке работы — первая же задача на этом аккаунте заполнит строку.'

/**
 * Откуда взялось число, которого поток работы не приносил. Поток сообщает о том окне, которое
 * ближе к пределу, поэтому второе окно молчит часами; строка состояния сессии, вошедшей в ТОТ ЖЕ
 * каталог учётной записи, сообщает оба и с процентом. Это та же подписка — но сказанная другими
 * устами, и экран говорит об этом вслух вместо того, чтобы выдать чужое чтение за своё.
 */
export const WINDOW_TERMINAL_HINT =
  'Чтение строки состояния сессии на этой же учётной записи — та же подписка, тот же каталог входа. Поток работы об этом окне пока не сообщал.'

/** The one letter that stands for a worker's line of work in a small square. */
export function initialOf(text: string | null | undefined, fallback = '·'): string {
  const s = (text ?? '').trim()
  return s.length > 0 ? s[0].toUpperCase() : fallback
}

/**
 * A colour for a square, decided by the name on it. The palette is the accepted one, so a
 * new line of work gets a colour that already belongs to the screen instead of a new hex.
 * The same name always draws the same colour — the eye learns it in a day.
 */
const ACCENTS = [
  'bg-blue-s text-blue',
  'bg-ok-s text-ok-tx',
  'bg-warn-s text-warn-tx',
  'bg-idle-s text-idle-tx',
] as const

export function accentFor(name: string | null | undefined): string {
  const s = (name ?? '').trim()
  let hash = 0
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) % 9973
  return ACCENTS[hash % ACCENTS.length]
}

/**
 * What a status is CALLED, and what colour it wears. One vocabulary for the whole window:
 * the panel and the card must never call the same state two different things, or a person
 * learns two words for one fact.
 */
const STATUS_WORDS: Record<TaskStatus, string> = {
  queued: 'в очереди',
  claimed: 'взята в работу',
  running: 'в работе',
  awaiting_approval: 'ждёт решения',
  approving: 'принимается',
  approved: 'принято',
  returned: 'возвращена',
  completed: 'готово',
  failed: 'не получилось',
}

const STATUS_TONE: Record<TaskStatus, string> = {
  queued: 'bg-idle-s text-idle-tx',
  claimed: 'bg-blue-s text-blue',
  running: 'bg-blue-s text-blue',
  awaiting_approval: 'bg-blue-s text-blue',
  approving: 'bg-blue-s text-blue',
  approved: 'bg-ok-s text-ok-tx',
  returned: 'bg-warn-s text-warn-tx',
  completed: 'bg-ok-s text-ok-tx',
  failed: 'bg-err-s text-err-tx',
}

export function statusWord(status: TaskStatus | null | undefined, unknown = 'открываю'): string {
  return status ? STATUS_WORDS[status] : unknown
}

export function statusTone(status: TaskStatus | null | undefined): string {
  return status ? STATUS_TONE[status] : 'bg-idle-s text-idle-tx'
}

/**
 * What the checks said, in the words of the person who has to trust them. A check that was
 * never read is not listed — an unread receipt is never dressed up as a pass.
 */
export function receiptChecks(receipt: ReceiptSummary | null | undefined): { text: string; ok: boolean }[] {
  if (!receipt) return []
  const checks: { text: string; ok: boolean }[] = []
  if (receipt.testsTotal !== null && receipt.testsPassed !== null) {
    checks.push({
      text: `Проверки ${receipt.testsPassed} из ${receipt.testsTotal}`,
      ok: receipt.testsPassed === receipt.testsTotal,
    })
  }
  if (receipt.tscClean !== null) checks.push({ text: 'Сборка без ошибок', ok: receipt.tscClean })
  if (receipt.guardClean !== null) checks.push({ text: 'Правила соблюдены', ok: receipt.guardClean })
  return checks
}

/**
 * receiptProofLabel(proof) — the ONE sentence a finished attempt earned, from the reference
 * the daemon really wrote.
 *
 * Why this exists beside `receiptChecks`: those four checks wait for numbers nothing in the
 * system produces, so they render nothing on every real task. This says what actually
 * happened — the gate that opened and the evidence it opened on. An unknown kind is shown as
 * its raw reference rather than as a guess: a proof nobody can read is still a proof, and
 * inventing a friendly word for it would be the only dishonest line on the card.
 */
export function receiptProofLabel(proof: ReceiptProof | null | undefined): string | null {
  if (!proof || !proof.kind) return null
  switch (proof.kind) {
    case 'reverify':
      return proof.sha ? `Перепроверено на ветке · ${proof.sha.slice(0, 7)}` : 'Перепроверено на ветке'
    case 'artifact': {
      const where = proof.path ? proof.path : 'документ'
      return proof.sha ? `Документ записан: ${where} · ${proof.sha.slice(0, 7)}` : `Документ записан: ${where}`
    }
    case 'answer':
      return 'Ответ без правки кода'
    case 'preflight':
      return 'Уже было сделано — работник не запускался'
    case 'forge':
      return 'Черновик агента принят'
    case 'gate':
      // «Готово» и «готово, но никто не перепроверял» — РАЗНЫЕ слова, и здесь они наконец
      // разные. Без этой ветки объектная форма доказательства падала в `default` и колонка
      // показывала человеку код причины как есть — единственную нечитаемую строку карточки.
      return proof.unverified ? 'Не перепроверено — квитанции нет' : 'Гейт открылся: нового красного не появилось'
    default:
      return proof.ref || null
  }
}

/**
 * saidInWords(err) — то, что дверь сказала ПО-РУССКИ, или null.
 *
 * ═════════ ПОЧЕМУ ОТВЕТ ДВЕРИ ВООБЩЕ ДОХОДИТ ДО ГЛАЗ ═════════
 * Отказ по потолку называет поле, фактическую длину и потолок («описание: 2103 знака при
 * потолке 2000») — и до этой ветки всё это окно выбрасывало, показывая человеку своё
 * «попробуйте ещё раз». Замерено 31.08: причину промаха пришлось искать чтением исходников
 * очереди, потому что в окне её не было ни одним знаком.
 *
 * ═════════ ПОЧЕМУ ИМЕННО «ПО-РУССКИ», А НЕ «ЛЮБОЙ ОТВЕТ» ═════════
 * Двери отвечают двумя разными родами строк: словами, написанными ДЛЯ человека, и служебными
 * («invalid taskId», «unauthorized», «not found») — потрохами, которые человеку ничего не
 * объясняют и читаются как поломка окна. Кириллица здесь и есть та граница: она отделяет
 * фразу, которую кто-то написал человеку, от строки, которую машина сказала машине. Служебное
 * остаётся за общими словами ниже — окно не пересказывает потроха и не сочиняет за дверь.
 */
const SAID_IN_WORDS = /[а-яё]/i

export function saidInWords(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  const said = (err.detail ?? '').trim()
  if (said === '' || !SAID_IN_WORDS.test(said)) return null
  // Длинная простыня в красной строке формы нечитаема; дверь и так отвечает одной фразой.
  return said.length > 300 ? `${said.slice(0, 300)}…` : said
}

/** A refusal, said in the words of the person it happened to. */
export function refusalWords(err: unknown): string {
  if (isNotReady(err)) return 'Это действие пока недоступно.'
  if (isRaceLost(err)) return 'За эту задачу уже ответили с другой стороны.'
  // ПРОСРОЧКА — НЕ ОТКАЗ, и «попробуйте ещё раз» здесь — ловушка: демон мог уже держать
  // нажатие в своей очереди, и повтор станет вторым решением (живая приёмка 26.08 ровно
  // так и сломалась). Сначала — посмотреть, что стало с карточкой.
  if (isDeadline(err))
    return 'Демон не ответил вовремя. Нажатие могло дойти — обновите карточку и проверьте, прежде чем решать снова.'
  const said = saidInWords(err)
  if (said) return said
  return 'Не получилось отправить. Попробуйте ещё раз.'
}

/**
 * approvalRefusal(out) — что показать человеку, когда дверь приёмки ОТВЕТИЛА, но работа не
 * принята. null означает, что показывать нечего: приём прошёл.
 *
 * ЭТО НЕ ОШИБКА ЗАПРОСА, и в этом была вся ловушка. Дверь отвечает 200 с `ok:false` — запрос
 * дошёл, обещание не нарушено, — поэтому обработчик ошибки не срабатывал вовсе, и кнопка
 * выглядела нажавшейся впустую. Живая приёмка так это и записала: «нажалась и ничего не
 * сделала». Слова у двери теперь есть всегда; здесь они только доводятся до глаз. Своей
 * фразы этот помощник не сочиняет: запасная нужна ровно на случай демона постарше, который
 * слов ещё не говорит, и она честно признаёт, что причина не названа.
 */
export function approvalRefusal(out: { ok?: boolean; reason?: string } | null | undefined): string | null {
  if (out && out.ok) return null
  const said = out && typeof out.reason === 'string' ? out.reason.trim() : ''
  return said || 'Работа не принята, а причина не названа — посмотрите журнал демона.'
}
