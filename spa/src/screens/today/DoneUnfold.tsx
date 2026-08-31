import { useState } from 'react'
import type { AcceptanceRecord, DoneRow, TaskAttempt, TaskDetail } from '../../api/types'
import { useTaskQuery } from '../../api/queries'
import { AttemptLog } from '../../shell/AttemptLog'
import { acceptanceList, clockLabel, plural } from '../../shell/format'
import { spanLabel } from '../tasks/units'
import { spendRows } from '../task-card/spend'

/**
 * РАСКРЫТИЕ ГОТОВОЙ РАБОТЫ — история одной сделанной работы, прямо в строке списка.
 *
 * Список готовых показывал строку и ничего больше. Всё содержательное — что обещали, что
 * сделано, чем доказано, какие коммиты, сколько стоило, сколько шло, что сказала квитанция
 * слияния — лежало в леджере попытки и в git, куда из окна хода не было.
 *
 * СЛЕДСТВИЕ ХУЖЕ НЕУДОБСТВА, И ИМЕННО ОНО ЗДЕСЬ ЧИНИТСЯ. Приёмщиком стал терминал,
 * принимающий сам; без раскрытия «принято» — слово, а не доказательство, и основателю нечем
 * проверить приёмщика. Поэтому центр этой панели — не диф и не расход, а две строки: КТО
 * принял и что при этом сказала квитанция слияния.
 *
 * НИ ОДНОГО НОВОГО ВОПРОСА К ДЕМОНУ. Всё читается одной дверью карточки — той, что окно уже
 * умеет спрашивать, — и спрашивается ТОЛЬКО пока панель раскрыта: закрытая строка не стоит
 * ни одного запроса, потому что компонент к тому моменту размонтирован.
 *
 * ГДЕ ЗАПИСИ НЕТ, ТАМ СТОИТ ФРАЗА О ТОМ, ЧТО ЕЁ НЕТ. Прочерк на месте приёмщика читается как
 * «принял никто», молчание — как «панель не дочитала»; ни то, ни другое не является правдой,
 * а правда здесь — «этого не записано», и она пишется словами.
 */

/** Одна строка «подпись → значение». Незаписанное отличается от записанного цветом и словом. */
function Fact({ label, value, known = true }: { label: string; value: string; known?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-[11.5px] leading-[1.5]">
      <span className="min-w-0 flex-none text-tx2">{label}</span>
      <span className={`min-w-0 text-right ${known ? 'text-tx' : 'text-tx3'}`}>{value}</span>
    </div>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[9px] border border-bd bg-surf px-3.5 py-3">
      <div className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">{title}</div>
      <div className="mt-2 flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

/**
 * СУДЬБА ТЕСТОВ ПРИ СЛИЯНИИ — тремя разными фразами, потому что состояния три.
 *
 * `null` — это НЕ «не прошли»: прогонщика не нашлось, и квитанция обычно объясняет почему.
 * Одно слово на два состояния подписало бы зелёным то, чего никто не проверял, — а вся эта
 * панель существует ровно затем, чтобы такое было видно.
 */
export function mergeTestWords(passed: boolean | null, note: string | null): string {
  if (passed === true) return 'тесты гонялись — зелено'
  if (passed === false) return 'тесты гонялись — красно'
  return note ? `тесты не гонялись: ${note}` : 'тесты не гонялись'
}

/**
 * КТО ПРИНЯЛ И КОГДА — одной фразой, названной по имени приёмщика.
 *
 * Человек — это нажатие двери окна, она человеческая по построению. Терминал — окно,
 * проведшее ритуал слияния само; тогда называется и оно, иначе «принял терминал» ничем не
 * отличается от «принял кто-то». Записи нет — так и сказано.
 */
export function acceptedWords(accepted: AcceptanceRecord | null | undefined): { text: string; known: boolean } {
  if (!accepted) return { text: 'кто принял — не записано', known: false }
  const who = accepted.by === 'human' ? 'человек' : accepted.terminal ? `терминал ${accepted.terminal}` : 'терминал'
  const when = accepted.at ? clockLabel(accepted.at) : null
  return { text: when ? `${who}, ${when}` : `${who}; когда — не записано`, known: true }
}

/** Сколько времени работа реально шла: сумма измеренных подходов, а не срок от заказа до сдачи. */
export function workedMs(attempts: TaskAttempt[]): number | null {
  let total = 0
  let measured = false
  for (const a of attempts) {
    const from = a.startedAt ? Date.parse(a.startedAt) : NaN
    const to = a.endedAt ? Date.parse(a.endedAt) : NaN
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue
    total += to - from
    measured = true
  }
  return measured ? total : null
}

/** Обещание списком: то, ради чего работу принимали, — первым, как рамка для всего ниже. */
function Promise_({ acceptance }: { acceptance: string | string[] | null | undefined }) {
  const items = acceptanceList(acceptance)
  if (items.length === 0) return null
  return (
    <Block title="Обещано">
      {items.map((text, i) => (
        <div key={`${i}-${text.slice(0, 16)}`} className="flex gap-2 text-[11.5px] leading-[1.5] text-tx">
          <span aria-hidden className="flex-none text-tx3">
            ·
          </span>
          <span className="min-w-0">{text}</span>
        </div>
      ))}
    </Block>
  )
}

/**
 * ЧТО СДЕЛАНО — коммиты с их собственными сообщениями.
 *
 * Список приходит непустым и у ПРИНЯТОЙ работы, чья ветка снесена вместе с копией: дверь
 * карточки спрашивает сохранённый диапазон. Пусто здесь означает «git об этом молчит», и это
 * сказано словами, а не пустотой.
 */
function Made({ detail }: { detail: TaskDetail }) {
  const commits = detail.commits ?? []
  return (
    <Block title="Что сделано">
      {commits.length === 0 ? (
        <div className="text-[11.5px] leading-[1.5] text-tx3">коммитов не найдено — git об этой работе молчит</div>
      ) : (
        commits.map((line) => (
          <div key={line} className="flex gap-2 text-[11.5px] leading-[1.5]">
            <span className="flex-none font-mono text-tx3">{line.slice(0, 7)}</span>
            <span className="min-w-0 text-tx">{line.slice(7).trim() || '(без сообщения)'}</span>
          </div>
        ))
      )}
    </Block>
  )
}

/** Квитанция слияния словами: ветка → итоговый коммит, и что стало с тестами. */
function MergeReceipt({ detail }: { detail: TaskDetail }) {
  const accepted = detail.accepted ?? null
  const who = acceptedWords(accepted)
  const merge = accepted?.merge ?? null
  return (
    <Block title="Приёмка">
      <Fact label="Принял" value={who.text} known={who.known} />
      {merge ? (
        <>
          <Fact
            label="Слито"
            value={`${merge.branch ?? detail.branch} → ${merge.sha ? merge.sha.slice(0, 12) : 'коммит не записан'}`}
            known={!!merge.sha}
          />
          <Fact label="Тесты" value={mergeTestWords(merge.testsPassed, merge.testsNote)} known={merge.testsPassed !== null} />
        </>
      ) : (
        <Fact label="Слито" value="квитанции слияния нет" known={false} />
      )}
    </Block>
  )
}

/** Круги возврата: сколько раз работу отправляли обратно и какими словами. */
function Returns({ detail }: { detail: TaskDetail }) {
  const returns = detail.returns ?? null
  if (!returns) return null
  if (returns.rounds === 0) {
    return (
      <Block title="Возвраты">
        <div className="text-[11.5px] leading-[1.5] text-tx2">работу не возвращали ни разу</div>
      </Block>
    )
  }
  return (
    <Block title="Возвраты">
      <Fact label="Кругов" value={`${returns.rounds} ${plural(returns.rounds, 'возврат', 'возврата', 'возвратов')}`} />
      {returns.notes.length === 0 ? (
        <div className="text-[11.5px] leading-[1.5] text-tx3">слов возврата не сохранилось</div>
      ) : (
        returns.notes.map((note) => (
          <div key={note} className="text-[11.5px] leading-[1.5] text-tx">
            «{note}»
          </div>
        ))
      )}
      {/* Слов может уцелеть меньше, чем кругов: колонка решения помнит только последнюю
          записку. Сказать об этом честнее, чем молча показать один возврат из трёх. */}
      {returns.notes.length > 0 && returns.rounds > returns.notes.length ? (
        <div className="text-[10.5px] leading-[1.4] text-tx3">
          сохранились слова последнего круга — остальные перезаписаны
        </div>
      ) : null}
    </Block>
  )
}

/** Расход и длительность: четыре числа поставщика по всем подходам и сколько работа шла. */
function Cost({ detail }: { detail: TaskDetail }) {
  // Подписи и слова «почему прочерк» — из той же проекции, по которой их печатает карточка
  // задачи; строки про подписку и оплаченный API здесь не спрашиваются, потому что для них
  // у этой панели нет данных, а строка с прочерком без причины — шум.
  const rows = spendRows({ tokens: detail.task.tokens }).filter(
    (r) => r.key === 'tokensIn' || r.key === 'tokensOut' || r.key === 'cacheRead' || r.key === 'cacheWrite',
  )
  const worked = workedMs(detail.attempts ?? [])
  return (
    <Block title="Расход и длительность">
      <Fact
        label="Работа шла"
        value={worked === null ? 'мерить нечего — отметок нет' : spanLabel(worked)}
        known={worked !== null}
      />
      {rows.map((r) => (
        <Fact key={r.key} label={r.label} value={r.value} known={r.known} />
      ))}
    </Block>
  )
}

/**
 * ПОДХОДЫ И ИХ СТЕНОГРАММЫ. Стенограмма — это не ссылка «куда-то», а сама запись попытки,
 * раскрываемая на месте тем же читателем, каким её показывает карточка задачи; второй
 * показыватель одной записи разошёлся бы с первым молча.
 */
function Attempts({ taskId, attempts }: { taskId: string; attempts: TaskAttempt[] }) {
  const [open, setOpen] = useState<number | null>(null)
  if (attempts.length === 0) return null
  return (
    <Block title="Подходы">
      {attempts.map((a) => {
        const n = a.attempt
        const shown = n !== null && open === n
        return (
          <div key={String(n)} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-[11.5px] text-tx">
                Подход {n ?? '—'}
                {a.outcome ? ` · ${a.outcome === 'completed' ? 'готово' : 'не вышло'}` : ''}
                {a.workerId ? ` · ${a.workerId}` : ''}
              </span>
              <button
                type="button"
                aria-expanded={shown}
                disabled={n === null}
                onClick={() => setOpen(shown ? null : n)}
                className="flex-none rounded-[7px] border border-bd px-2 py-0.5 text-[10.5px] text-tx2 hover:bg-row-hover disabled:text-tx3"
              >
                {shown ? '▾ стенограмма' : '▸ стенограмма'}
              </button>
            </div>
            {shown ? <AttemptLog taskId={taskId} attempt={a} /> : null}
          </div>
        )
      })}
    </Block>
  )
}

export function DoneUnfold({ row }: { row: DoneRow }) {
  // Спрашивается ровно пока панель раскрыта: родитель монтирует этот компонент на раскрытии
  // и снимает на закрытии, поэтому закрытая строка не стоит ни одного запроса.
  const detail = useTaskQuery(row.id)

  if (detail.isLoading) {
    return <div className="mt-2.5 text-[11.5px] text-tx3">Читаю историю работы…</div>
  }
  if (detail.error || !detail.data) {
    return (
      <div className="mt-2.5 text-[11.5px] text-tx3">
        История этой работы сейчас не читается. На саму работу это не влияет — она записана в журнал попытки и в git.
      </div>
    )
  }

  const data = detail.data
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="done-unfold">
      <Promise_ acceptance={data.task.acceptance ?? row.acceptance} />
      <MergeReceipt detail={data} />
      <Made detail={data} />
      <Returns detail={data} />
      <Cost detail={data} />
      <Attempts taskId={row.id} attempts={data.attempts ?? []} />
    </div>
  )
}
