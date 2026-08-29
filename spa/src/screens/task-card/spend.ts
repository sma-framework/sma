import type { SubApiSwitch, TokenSums } from '../../api/types'
import { NOT_MEASURED, compactNumber } from '../../shell/stats'
import { formatCapUsd } from '../costs/money'

/**
 * «РАСХОД» КАРТОЧКИ ЗАДАЧИ — шесть строк, и ни одна не сочинена.
 *
 * ═══════════════ ПОЧЕМУ ШЕСТЬ, А НЕ ОДНА ═══════════════
 *
 * До этой правки карточка называла расход одной строкой — итогом сессии («$… · ходов: …»),
 * который печатает поставщик. Четыре числа, которые он же и измерил, — вход, выход, чтение
 * кэша, запись кэша — доезжали до двери задачи (их провод утверждается отдельным прогоном) и
 * останавливались там: посчитано, записано и никому не отдано. Кэш при этом обычно КРУПНЕЕ
 * всего остального вместе взятого, то есть человек, спрашивающий «во что это обошлось»,
 * видел меньшую часть ответа.
 *
 * ═══════════════ ПРОЧЕРК СО СЛОВОМ, И НИКОГДА НОЛЬ ═══════════════
 *
 * Числа приезжают с двух этажей честности, и панель обязана их различать: измеренный ноль —
 * это ответ («прогоны были, поставщик насчитал ноль»), а неизмеренное — отсутствие ответа
 * (попытки старше поля, каталога прогонов нет, демон постарше поля не отдаёт). Второе
 * показывается прочерком И НЕСЁТ ПРИЧИНУ СЛОВАМИ: «—» без объяснения человек читает как
 * поломку экрана, а ноль на этом месте назвал бы бесплатной работу, которую никто не мерил.
 *
 * Своих чисел панель не считает вовсе: ни цены из токенов по своему курсу, ни суммы по
 * подходам. И то и другое — самая правдоподобная из выдумок.
 *
 * ═══════════════ ПОЧЕМУ СЧЁТ ЖИВЁТ ЗДЕСЬ, А НЕ В ВЁРСТКЕ ═══════════════
 *
 * По тому же правилу, по которому вынесены окошко показателей и узкий вид: показатель,
 * посчитанный внутри разметки, проверяется одним человеческим глазом на живом экране — и
 * расходится с правдой молча. Здесь он проверяется прогоном.
 */

/** Одна строка расхода. `known:false` — числа нет по-честному, и тогда `why` говорит почему. */
export interface SpendRow {
  key: string
  label: string
  value: string
  known: boolean
  why?: string
}

export const WHY_NO_SESSION =
  'итога сессии в журнале подхода нет: работа ещё идёт или поставщик его не напечатал'
export const WHY_NO_TOKENS =
  'квитанций с числами нет: подходы старше этого поля или прогонов не было вовсе'
export const WHY_NO_SWITCH = 'правил окна нет — про платный канал спросить не у кого'

function known(key: string, label: string, value: string): SpendRow {
  return { key, label, value, known: true }
}

function missing(key: string, label: string, why: string): SpendRow {
  return { key, label, value: NOT_MEASURED, known: false, why }
}

/**
 * Потолок платного канала — и ноль, названный тем, что он есть.
 *
 * Ноль это НЕ «без ограничения»: при нулевом потолке правило отказывает в переходе на платный
 * канал навсегда, и работа при закрытых окнах ждёт их открытия. Ноль — поставочное состояние
 * продукта, поэтому эта строка чаще всего и читается.
 */
export function paidApiRow(sw: SubApiSwitch | undefined | null): SpendRow {
  if (!sw) return missing('paidApi', 'Платный API', WHY_NO_SWITCH)
  if (!sw.budgeted || sw.capUsd <= 0) {
    return {
      key: 'paidApi',
      label: 'Платный API · потолок 0',
      value: 'выключен',
      known: true,
      why: 'ноль — это не «без ограничения»: платный канал не используется вовсе',
    }
  }
  return known(
    'paidApi',
    `Платный API · потолок ${formatCapUsd(sw.capUsd)}`,
    sw.mode === 'api' ? 'работа идёт за деньги' : 'молчит',
  )
}

/** Что панель показывает — целиком, в порядке принятого макета. */
export function spendRows(input: {
  tokens?: TokenSums | null
  /** Итог сессии словами поставщика: «$… · ходов: …». `null` — он о ней промолчал. */
  session?: string | null
  spendSwitch?: SubApiSwitch | null
}): SpendRow[] {
  const t = input.tokens ?? null
  const token = (key: string, label: string, value: number | undefined): SpendRow =>
    t ? known(key, label, compactNumber(value ?? 0)) : missing(key, label, WHY_NO_TOKENS)

  return [
    input.session
      ? known('subscription', 'Подписка · $ и ходы', input.session)
      : missing('subscription', 'Подписка · $ и ходы', WHY_NO_SESSION),
    token('tokensIn', 'Токены · вход', t?.input),
    token('tokensOut', 'Токены · выход', t?.output),
    token('cacheRead', 'Кэш · чтение', t?.cacheRead),
    token('cacheWrite', 'Кэш · запись', t?.cacheWrite),
    paidApiRow(input.spendSwitch),
  ]
}

/**
 * Причины, названные ОДИН раз каждая: четыре строки токенов молчат по одной и той же
 * причине, и напечатать её четырежды значило бы сделать честность шумом, который перестают
 * читать.
 */
export function spendReasons(rows: SpendRow[]): string[] {
  return [...new Set(rows.map((r) => r.why).filter((w): w is string => !!w))]
}
