import { useState } from 'react'
import { openScreen } from '../../shell/navigation'
import type { BatchRow, DoneRow, FailureAction, QueueRow, ReceiptSummary } from '../../api/types'
import { elapsedLabel } from '../../shell/stats'
import {
  acceptanceList,
  accentFor,
  attemptsLabel,
  clockLabel,
  hoursLabel,
  initialOf,
  plural,
  receiptChecks,
} from '../../shell/format'
import { actOf, actableActions, spentLine, spentOf } from './offer'
import type { OfferAct } from './offer'

/**
 * DayFeed — what happened while nobody was watching, in the order a person needs it.
 *
 * First what waits for a decision, because that is the only thing that cannot move without
 * the person. Then what did not work out, because that is the thing to know before making
 * plans. Then what was finished — each one saying what was promised and what the checks
 * said, so «готово» is never a word taken on trust. The queue comes last: it is the only
 * part of the screen that is about the future rather than the night.
 *
 * Every row on this screen came out of the one reading. Nothing here asks the daemon
 * anything of its own, and nothing here is rendered as anything but text.
 */

function LaneBadge({ lane, title }: { lane: string | null; title: string | null }) {
  const accent = accentFor(lane ?? title)
  return (
    <span
      title={lane ?? 'без направления'}
      className={`flex h-6 w-6 flex-none items-center justify-center rounded-[7px] text-[11px] font-bold ${accent}`}
    >
      {initialOf(lane ?? title)}
    </span>
  )
}

/**
 * СКОЛЬКО СТРОКА УЖЕ ЖДЁТ — и ЖДУТ ЗДЕСЬ ДВА РАЗНЫХ ОЖИДАНИЯ, поэтому слово у них разное.
 *
 * Строка очереди ждёт РАБОТНИКА, и возраст ей ставится только за порогом терпения — там
 * «застряла» и есть весь смысл сообщения. Строка, которая ждёт ЧЕЛОВЕКА, называет свой
 * возраст всегда, с первой минуты: «застряла» про сорок минут ожидания — упрёк работе,
 * которая как раз сделана и честно остановилась.
 */
function AgedPill({ hours, stuck = true }: { hours: number; stuck?: boolean }) {
  return (
    <span className="flex-none rounded-full bg-warn-s px-2.5 py-0.5 text-[10.5px] whitespace-nowrap text-warn-tx">
      {stuck ? 'застряла · ' : ''}ждёт {hoursLabel(hours)}
    </span>
  )
}

function SectionTitle({ children }: { children: string }) {
  return <div className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">{children}</div>
}

function CheckPills({ receipt }: { receipt: ReceiptSummary }) {
  // The wording of a check belongs to the whole window, not to this feed: the card says
  // «Проверки 34 из 34» in exactly the same words.
  const pills = receiptChecks(receipt)
  if (pills.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {pills.map((p) => (
        <span
          key={p.text}
          className={
            p.ok
              ? 'rounded-full bg-ok-s px-2.5 py-[3px] text-[11px] whitespace-nowrap text-ok-tx'
              : 'rounded-full bg-err-s px-2.5 py-[3px] text-[11px] whitespace-nowrap text-err-tx'
          }
        >
          {p.text} {p.ok ? '✓' : '✗'}
        </span>
      ))}
    </div>
  )
}

function cardClass(selected: boolean): string {
  return `w-full rounded-[13px] border bg-card px-[18px] py-4 text-left shadow-panel hover:bg-card-hov ${
    selected ? 'border-blue' : 'border-bd'
  }`
}

function DecisionCard({
  row,
  selected,
  onOpen,
}: {
  row: QueueRow
  selected: boolean
  onOpen: (id: string) => void
}) {
  return (
    <button type="button" onClick={() => onOpen(row.id)} className={cardClass(selected)}>
      <div className="flex items-center gap-2.5">
        <LaneBadge lane={row.lane} title={row.title} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-tx">
          {row.title ?? 'Без названия'}
        </span>
        {row.agedForHours ? <AgedPill hours={row.agedForHours} stuck={false} /> : null}
      </div>
      <div className="mt-2 text-[11.5px] text-tx3">
        {row.lane ?? 'без направления'} · проверено, ждёт вашего решения
      </div>
    </button>
  )
}

/**
 * ВСТАВШАЯ СБОРКА — В ТОЙ ЖЕ СТОПКЕ, ЧТО И ВСЁ ОСТАЛЬНОЕ, ЧТО НЕ ДВИНЕТСЯ БЕЗ ЧЕЛОВЕКА.
 *
 * Раньше этой карточки здесь не было, и это была не забывчивость вёрстки, а разница в
 * устройстве: работа на приёмке названа СТАТУСОМ очереди, а вставшая сборка — нет. Её элемент
 * лежит просто «сорвался», и ждущей её делает постановка над ним. Экран, который показывал
 * только статусы, честно показывал ноль ждущих над батчем, простоявшим пятнадцать часов.
 *
 * КАРТОЧКА НЕ РЕШАЕТ, А ВЕДЁТ. Три ответа — «пропустить / повторить / отменить» — нажимаются
 * там, где видно, на чём именно кусок сломался; здесь стоит имя элемента, срок простоя и
 * дорога к развилке. Кнопка «решить» прямо тут была бы решением вслепую — тем же самым, что
 * запрещено кнопке одобрения в телеграме.
 */
function StalledBatchCard({ batch, now }: { batch: BatchRow; now: number }) {
  const item = batch.question?.itemTitle ?? batch.question?.itemId ?? null
  const stalled = elapsedLabel(typeof batch.stalledSince === 'number' ? batch.stalledSince : null, now)
  return (
    <button
      type="button"
      onClick={() => openScreen({ screen: 'tasks', taskId: batch.id })}
      className="w-full rounded-[13px] border border-warn-s bg-warn-s px-[18px] py-4 text-left hover:bg-card-hov"
    >
      <div className="flex items-center gap-2.5">
        <LaneBadge lane={null} title={batch.title} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-tx">
          {batch.title ?? 'Без названия'}
        </span>
        {/* Срок простоя стоит на самой карточке: «сборка встала» без числа не отличает минуту
            от суток, а решение человек принимает как раз по этой разнице. */}
        {stalled ? (
          <span className="flex-none rounded-full bg-card px-2.5 py-0.5 text-[10.5px] whitespace-nowrap text-warn-tx">
            стоит {stalled}
          </span>
        ) : null}
      </div>
      <div className="mt-2 text-[11.5px] leading-[1.5] text-tx2">
        {item
          ? `Сборка стоит на элементе «${item}» — нужен ваш выбор: пропустить, повторить или отменить.`
          : 'Сборка стоит на сорвавшемся элементе — нужен ваш выбор.'}{' '}
        Пока вы не ответите, ни один её элемент работнику не выдаётся.
      </div>
    </button>
  )
}

/**
 * ТРИ ДЕЙСТВИЯ ЧЕЛОВЕКА — КНОПКАМИ, А НЕ ПЕРЕЧИСЛЕНИЕМ В ТЕКСТЕ.
 *
 * Работа, за которой повтора нет, стоит до его решения, и красная карточка без единого слова о
 * том, что делать, отправляет человека разбирать журнал попытки руками — по такой карточке
 * решение и принималось: шесть работ за сутки, каждая через терминал. Названия и подписи
 * приходят от двери целиком; экран знает только, чем каждое имя ДЕЛАЕТСЯ, и не рисует того,
 * чего не умеет (см. `offer.ts`).
 *
 * ОТМЕНА СПРАШИВАЕТ ЕЩЁ РАЗ. Она терминальна — после неё на эту работу не будет потрачено ни
 * одной попытки, — а стоит в одном ряду с двумя обратимыми соседями и ровно там, где палец
 * идёт мимо. Два других нажатия вопроса не задают: обе поправимы следующим движением.
 */
function OfferActions({
  actions,
  onAct,
}: {
  actions: FailureAction[]
  onAct: (act: OfferAct) => void
}) {
  const [confirming, setConfirming] = useState(false)
  if (actions.length === 0) return null
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="text-[11px] font-semibold text-tx">Ваш ход:</div>
      {actions.map((a) => {
        const act = actOf(a.id)
        if (act === null) return null
        return (
          <div key={a.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {act === 'cancel' && confirming ? (
              <>
                <span className="text-[11.5px] font-semibold text-tx">Отменить насовсем?</span>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false)
                    onAct(act)
                  }}
                  className="rounded-[9px] border border-err-bd bg-err-s px-3 py-1.5 text-[11.5px] font-semibold text-err-tx"
                >
                  Да, отменить
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-[9px] border border-bd2 px-3 py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                >
                  Нет
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => (act === 'cancel' ? setConfirming(true) : onAct(act))}
                  className="flex-none rounded-[9px] border border-bd2 bg-card px-3 py-1.5 text-[11.5px] font-semibold text-tx hover:bg-card-hov"
                >
                  {a.label}
                </button>
                {/* Подпись двери — рядом со СВОЕЙ кнопкой: по ней и выбирают, а название кнопки
                    без неё говорит только половину. */}
                <span className="min-w-0 text-[11px] text-tx3">{a.detail}</span>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

function FailedCard({
  row,
  selected,
  onOpen,
  onAct,
}: {
  row: DoneRow
  selected: boolean
  onOpen: (id: string) => void
  onAct: (taskId: string, act: OfferAct) => void
}) {
  const failed = row.failed
  const offer = failed?.offer ?? null
  // НА ЧТО УШЛИ ХОДЫ — одной строкой, потому что от неё зависит выбор человека. «Сожжено сто
  // ходов» само по себе не говорит, поднимать потолок или резать работу; разбивка по роду
  // говорит. Считает её не разметка — `offer.ts`, и там же она и проверяется прогоном.
  const line = spentLine(spentOf(offer, failed?.spent))
  const actions = actableActions(offer?.actions)
  return (
    <div
      className={`w-full rounded-[13px] border bg-err-s px-[18px] py-4 text-left ${
        selected ? 'border-blue' : 'border-err-bd'
      }`}
    >
      {/*
        Карточка перестала быть ОДНОЙ кнопкой: кнопка внутри кнопки разметкой не разрешена, а
        три действия обязаны нажиматься. Открывает карточку та её часть, которая о прошлом, —
        заголовок с причиной и числами; предложение о будущем стоит рядом и жмётся само.
      */}
      <button type="button" onClick={() => onOpen(row.id)} className="w-full text-left">
        <div className="flex items-center gap-2.5">
          <LaneBadge lane={row.workerId} title={row.title} />
          <span className="min-w-0 flex-1 text-[13px] leading-[1.5] text-tx">
            <span className="font-semibold">{row.title ?? 'Без названия'}</span>
            {failed?.reasonLabel ? ` — ${failed.reasonLabel}` : ' — причина не записана'}
          </span>
        </div>
        {/* ПОЧЕМУ ИМЕННО ЭТА ПОПЫТКА. Подпись над строкой называет класс отказа и одинакова у
            всех отказов такого рода — три подряд сгоревшие попытки читались одной фразой. Здесь
            стоят слова из стенограммы: чем отказал гейт и на чём работа споткнулась в последний
            раз. Нет слов — нет и строки: пустая читалась бы как молчание о причине. */}
        {failed?.detail ? <div className="mt-2 text-[11.5px] text-tx2">{failed.detail}</div> : null}
        <div className="mt-2 text-[11.5px] text-tx2">
          {attemptsLabel(failed?.attemptsCount ?? row.attempts)}, дальше не пробую, чтобы не жечь ресурс.
        </div>
        {line ? <div className="mt-2 text-[11.5px] text-tx2 tabular-nums">{line}</div> : null}
      </button>
      <OfferActions actions={actions} onAct={(act) => onAct(row.id, act)} />
    </div>
  )
}

/**
 * ЧТО БЫЛО ОБЕЩАНО — по одному пункту на строку, потому что пунктов может быть несколько.
 *
 * Обещанное подставлялось в текст как есть, а приходит оно списком, — и список, подставленный
 * в текст, склеивается вплотную: «…файл существуетВ нём названа дата…». Три отдельных условия
 * приёмки читались одним предложением без единого пробела на границах, то есть не читались
 * вовсе. Один пункт — одна строка с точкой перед ней; когда пункт ровно один, точка не
 * ставится: маркер списка из одного элемента обещает список, которого нет.
 */
function Promised({ acceptance }: { acceptance: string | string[] | null | undefined }) {
  const items = acceptanceList(acceptance)
  if (items.length === 0) return null
  if (items.length === 1) {
    return (
      <div className="mt-2.5 text-[12.5px] leading-[1.55] text-tx2">
        <span className="font-semibold text-tx">Обещано: </span>
        {items[0]}
      </div>
    )
  }
  return (
    <div className="mt-2.5 text-[12.5px] leading-[1.55] text-tx2">
      <div className="font-semibold text-tx">Обещано:</div>
      {/*
        Строками, а не тегом списка: карточка целиком — это КНОПКА, и список внутри кнопки не
        разрешён разметкой. Границу пункта здесь держит перенос строки и точка перед ним.
      */}
      <div className="mt-1 flex flex-col gap-1">
        {items.map((text, i) => (
          <div key={`${i}-${text.slice(0, 16)}`} className="flex gap-2">
            <span aria-hidden className="flex-none text-tx3">
              ·
            </span>
            <span className="min-w-0">{text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DoneCard({ row, selected, onOpen }: { row: DoneRow; selected: boolean; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(row.id)} className={cardClass(selected)}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex-none text-[12px] text-ok-tx">
          ✓
        </span>
        <LaneBadge lane={row.workerId} title={row.title} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-tx">
          {row.title ?? 'Без названия'}
        </span>
        <span className="flex-none text-[11.5px] text-tx3 tabular-nums">{clockLabel(row.finishedAt)}</span>
      </div>
      <Promised acceptance={row.acceptance} />
      <div className="mt-2.5">
        <CheckPills receipt={row.receipt} />
      </div>
      <div className="mt-2.5 text-[11.5px] text-tx3">
        {attemptsLabel(row.attempts)}
        {row.diffStat ? ` · ${row.diffStat}` : ''}
      </div>
    </button>
  )
}

function QueueLine({ row, selected, onOpen }: { row: QueueRow; selected: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      className={`flex w-full items-center gap-2.5 border-t border-bd px-5 py-2.5 text-left hover:bg-row-hover ${
        selected ? 'bg-row-hover' : ''
      }`}
    >
      <span className="w-5 flex-none text-[11.5px] text-tx3 tabular-nums">{row.position}</span>
      <LaneBadge lane={row.lane} title={row.title} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx">{row.title ?? 'Без названия'}</span>
      {row.agedForHours ? (
        <AgedPill hours={row.agedForHours} />
      ) : (
        <span className="flex-none text-[11.5px] whitespace-nowrap text-tx3">по очереди</span>
      )}
    </button>
  )
}

export function DayFeed({
  decisions,
  stalled,
  failed,
  finished,
  waiting,
  selectedId,
  onOpen,
  onAct,
}: {
  decisions: QueueRow[]
  /** Сборки, вставшие на сорвавшемся элементе: они ждут человека ровно так же, как приёмка. */
  stalled: BatchRow[]
  failed: DoneRow[]
  finished: DoneRow[]
  waiting: QueueRow[]
  selectedId: string | null
  onOpen: (id: string) => void
  /**
   * ДЕЛО ПО ПРЕДЛОЖЕНИЮ КРАСНОЙ КАРТОЧКИ — экрану, а не ленте. Лента остаётся показом: она
   * называет человеку выбор и говорит, какое из трёх он сделал, а двери зовёт тот, кто на
   * этом экране за них отвечает. Иначе «ничего своего у демона не спрашивает» перестало бы
   * быть правдой ровно на одной карточке.
   */
  onAct: (taskId: string, act: OfferAct) => void
}) {
  const [doneOpen, setDoneOpen] = useState(true)

  const nothingAtAll =
    decisions.length === 0 &&
    stalled.length === 0 &&
    failed.length === 0 &&
    finished.length === 0 &&
    waiting.length === 0

  /**
   * AN EMPTY DAY MUST OFFER THE WAY IN.
   *
   * This is the screen the window opens on. It said «Пока тихо — команда ждёт задач» and gave
   * the reader nothing to press: to begin a day of work a person had to already know that the
   * door is on another screen. The owner said it plainly — «я вообще не понимаю, как там мне
   * работать». An empty state that only reports emptiness is a dead end; the one that offers
   * the next act is the whole difference between a dashboard and a workplace.
   */
  if (nothingAtAll) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[14px] border border-bd bg-card py-16 shadow-panel">
        <p className="m-0 text-[13px] text-tx2">Пока тихо — команда ждёт задач.</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => openScreen({ screen: 'tasks' })}
            className="rounded-[9px] border border-bd bg-accent-s px-3.5 py-1.5 text-[12px] font-semibold text-accent-tx"
          >
            Поставить задачу
          </button>
          <button
            type="button"
            onClick={() => openScreen({ screen: 'chat' })}
            className="rounded-[9px] border border-bd px-3.5 py-1.5 text-[12px] text-tx2"
          >
            Обсудить в разговоре
          </button>
        </div>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {decisions.length > 0 || stalled.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionTitle>Ждут вашего решения</SectionTitle>
          {/* Сборки идут ПЕРВЫМИ: за работой на приёмке не стоит ничего, кроме неё самой, а за
              вставшей сборкой стоят её незапущенные элементы — всё это время они не выдаются. */}
          {stalled.map((batch) => (
            <StalledBatchCard key={batch.id} batch={batch} now={Date.now()} />
          ))}
          {decisions.map((row) => (
            <DecisionCard key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} />
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionTitle>Не получилось</SectionTitle>
        {failed.length === 0 ? (
          <p className="m-0 px-0.5 text-[12px] text-tx3">Ничего не сломалось.</p>
        ) : (
          failed.map((row) => (
            <FailedCard key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} onAct={onAct} />
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setDoneOpen((v) => !v)}
          aria-expanded={doneOpen}
          className="flex w-full items-center gap-2.5 text-left"
        >
          <SectionTitle>{`Готово (${finished.length})`}</SectionTitle>
          <span aria-hidden className="text-[11px] text-tx3">
            {doneOpen ? '▾' : '▸'}
          </span>
        </button>
        {doneOpen ? (
          finished.length === 0 ? (
            <p className="m-0 px-0.5 text-[12px] text-tx3">Пока ничего не закрыто.</p>
          ) : (
            finished.map((row) => (
              <DoneCard key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} />
            ))
          )
        ) : null}
      </section>

      {waiting.length > 0 ? (
        <section className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
          <div className="px-5 py-3.5 text-[13px] font-semibold text-tx">
            {`В очереди: ${waiting.length} ${plural(waiting.length, 'задача', 'задачи', 'задач')}`}
          </div>
          {waiting.map((row) => (
            <QueueLine key={row.id} row={row} selected={row.id === selectedId} onOpen={onOpen} />
          ))}
        </section>
      ) : null}
    </div>
  )
}
