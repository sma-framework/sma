import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import { watchTask } from '../../api/task-live'
import { LiveTimer } from '../../shell/LiveTimer'
import type { TimerState } from '../../shell/live-timer'
import {
  useApprove,
  useAttemptQuery,
  useDecideToolTicket,
  useDiffQuery,
  useCancelTask,
  useRedirectTask,
  useReturnTask,
  useStateQuery,
  useTaskQuery,
  useTaskWords,
} from '../../api/queries'
import type {
  ApprovalWall,
  AttemptDigest,
  AttemptLog as AttemptLogPayload,
  AttemptRole,
  TaskAttempt,
  TaskStatus,
  WaitingTicket,
} from '../../api/types'
import {
  acceptanceList,
  accentFor,
  approvalOutcome,
  attemptsLabel,
  clockLabel,
  hoursLabel,
  initialOf,
  plural,
  receiptChecks,
  receiptProofLabel,
  refusalWords,
  statusTone,
  statusWord,
} from '../../shell/format'
import { CAP_ACCEPTANCE_ITEMS, CAP_TEXT } from '../../shell/caps'
import { openSystemConsole, useTellConsoleContext } from '../../shell/console-context'
import { openScreen, useOpenedWith } from '../../shell/navigation'
import { useComposerDraft } from '../../shell/useComposerDraft'
import { AttemptTimeline } from './AttemptTimeline'
import { DiffSummary, DiffText } from './DiffView'
import { JournalSection } from './JournalSection'
import { LiveFlow } from './LiveFlow'
import { SpendPanel } from './SpendPanel'
import { taskProjectOf } from './task-project'
import { turnPlanLine, turnPlanWhy } from './turn-plan'

/**
 * Три судьбы, которые может иметь поправка, набранная поверх живой работы. Названы типом, а не
 * написаны на месте: путь БИЛЕТА обязан ходить только в режиме `queue`, и проверка «нигде на
 * этом экране нет режима прерывания» должна означать ровно это, а не спотыкаться о подпись
 * функции, которая ни в какой режим ничего не посылает. Судеб стало три, а разрешённых
 * билету не прибавилось ни одной: у того пути по-прежнему ровно один законный режим.
 */
type SteeringMode = 'interrupt' | 'queue' | 'steer'

/**
 * Steering — the composer that exists WHILE a worker holds the task (phase «Двигатель»,
 * the Hermes trio brought to the card). Text typed against live work has a DECLARED fate:
 * «Сказать сейчас» hands the word to the turn that is running and kills NOTHING;
 * «Перебить сейчас» kills the run and the SAME session resumes with the correction —
 * done work stays in context; «После хода» lets the run finish and the correction rides
 * the continuation. No fourth, silent fate exists — that was the whole finding.
 *
 * ══ THE THIRD BUTTON PROMISES EXACTLY WHAT THE CHANNEL DELIVERS, AND NOT A WORD MORE ══
 *
 * A running turn takes an outside word at ONE moment: the boundary of its next tool call.
 * So «Сказать сейчас» is honest in two directions at once, and says both out loud — the
 * word enters the running turn at that boundary, and a turn that makes no further tool call
 * finishes without it and the word stands as a continuation after the turn instead. Same
 * session either way; nothing killed either way; the word lost in neither.
 *
 * Rounding that into a plain «доедет» was the cheaper sentence to write, and it would have
 * made this button a quieter «Перебить сейчас» — the exact substitution the third fate
 * exists to remove. A boundary named out loud is the whole difference between the two.
 */
function Steering({ taskId, onStopped }: { taskId: string; onStopped: (word: string) => void }) {
  const redirect = useRedirectTask()
  const cancel = useCancelTask(taskId)
  // Черновик набора привязан К ЭТОЙ задаче: поправка, написанная одной работе и всплывшая в
  // поле другой, — способ отправить не туда, и руль тем и живёт, что в него пишут отвлекаясь.
  const [text, setText] = useComposerDraft(`steer.${taskId}`)
  const [fate, setFate] = useState<string | null>(null)
  /**
   * Отмена спрашивает ещё раз, и это единственная кнопка блока, которая спрашивает. Обе
   * соседки ОБРАТИМЫ: перебитый ход продолжится той же сессией, поправка «после хода» просто
   * встанет в очередь. Отмена — терминал: после неё работы не будет вовсе. Кнопка без вопроса
   * рядом с двумя обратимыми — ловушка формы, а не экономия одного клика.
   */
  const [askCancel, setAskCancel] = useState(false)

  const stopIt = () => {
    if (cancel.isPending) return
    setAskCancel(false)
    cancel.mutate(
      { taskId },
      {
        onSuccess: (r) => {
          // ФРАЗА ОТВЕТА ЖИВЁТ СНАРУЖИ ЭТОГО БЛОКА, и это не украшение. Удавшаяся отмена
          // ПЕРЕСТАЁТ быть «работник держит задачу» — руль исчезает с экрана тем же кадром,
          // в котором приходит правда. Оставь фразу внутри, и человек прочтёт её только если
          // успеет: живым прогоном видно, что через секунду её на экране уже нет. А фраза
          // здесь ровно та, ради которой дверь отвечает честным признаком: убили ли процесс.
          const word = !r.cancelled
            ? 'Останавливать было нечего: задача уже закрыта или её больше нет.'
            : r.killed
              ? r.attemptClosed === false
                ? 'Остановил работника и закрыл задачу — попытка закрывалась дольше отведённого срока, задача закрыта всё равно.'
                : 'Остановил работника и закрыл задачу.'
              : 'Процесса под рукой не было — задача закрыта как отменённая.'
          setFate(word)
          onStopped(word)
        },
        onError: (err) => {
          const word = refusalWords(err)
          setFate(word)
          onStopped(word)
        },
      },
    )
  }

  const send = (mode: SteeringMode) => {
    const said = text.trim()
    if (!said || redirect.isPending) return
    redirect.mutate(
      { taskId, text: said, mode },
      {
        onSuccess: (r) => {
          setText('')
          setFate(
            mode === 'steer'
              ? 'Слово ушло в идущий ход — войдёт на ближайшем вызове инструмента. Если вызовов больше не будет, встанет продолжением после хода. Сессия та же, никого не убили.'
              : mode === 'interrupt'
                ? r.live
                  ? 'Перебиваю ход — сессия продолжится с вашей поправкой.'
                  : 'Поправка записана — ход уже не бежал, она встанет в ближайшее продолжение.'
                : 'Поправка встанет сразу после текущего хода, той же сессией.',
          )
        },
        /**
         * СЛОВА ОТКАЗА — ДВЕРИ, А НЕ ОКНА, и это не украшение.
         *
         * У «Сказать сейчас» есть законный отказ, который несёт ЕДИНСТВЕННОЕ объяснение
         * происходящего: исполнитель этой задачи бежит без той калитки, на которой слово
         * входит в живой ход, — и дверь называет обе формы, которые до него ДОЕДУТ. Показать
         * вместо этого «Не получилось отправить. Попробуйте ещё раз.» значит предложить
         * человеку бить в ту же стену второй раз, спрятав от него ровно то, ради честности
         * чего третья судьба и заводилась.
         *
         * ПОЧЕМУ ТЕЛО ОТВЕТА ПОКАЗЫВАЕТСЯ ЗДЕСЬ, ХОТЯ `refusalWords` ЕГО ПРЯЧЕТ. Тот помощник
         * прав для всего окна: почти всякий отказ 400 — это проверка ФОРМЫ запроса, писанная
         * тому, кто запрос собирал, то есть самому окну, и вываливать её человеку нечестно.
         * Но на ЭТОМ пути форму запроса собирает не человек, а этот файл, и его отказы 400
         * перечислимы: идентификатор задачи взят с самой карточки, режим — литерал из типа
         * выше, пустой текст отсечён строкой раньше, лишних полей не посылается. Остаётся
         * отказ по существу — про канал, — и предел длины, который дверь тоже называет сама.
         * Своей фразы окно не сочиняет ни для того, ни для другого: второй автор одного и
         * того же предложения — это и есть способ, которым слова двери и слова окна однажды
         * разойдутся, а человек прочтёт то, что неправда.
         */
        onError: (err) =>
          setFate(err instanceof ApiError && err.status === 400 && err.detail ? err.detail : refusalWords(err)),
      },
    )
  }

  return (
    <div className="rounded-[14px] border border-bd bg-card px-6 py-[18px] shadow-panel">
      <div className="mb-2.5 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">
        Руль — работник сейчас в деле
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (fate) setFate(null)
        }}
        placeholder="Поправка к текущей работе: «нет, не так — сделай…»"
        rows={2}
        className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => send('steer')}
          disabled={redirect.isPending || text.trim() === ''}
          className="rounded-[9px] bg-blue px-3.5 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          Сказать сейчас
        </button>
        <button
          type="button"
          onClick={() => send('interrupt')}
          disabled={redirect.isPending || text.trim() === ''}
          className="rounded-[9px] bg-warn-tx px-3.5 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          ■ Перебить сейчас
        </button>
        <button
          type="button"
          onClick={() => send('queue')}
          disabled={redirect.isPending || text.trim() === ''}
          className="rounded-[9px] border border-bd2 px-3.5 py-2 text-[12px] text-tx2 hover:text-tx disabled:opacity-50"
        >
          После хода
        </button>
        <button
          type="button"
          onClick={() => setAskCancel((was) => !was)}
          disabled={cancel.isPending}
          className="rounded-[9px] border border-err-bd px-3.5 py-2 text-[12px] text-err-tx hover:bg-err-s disabled:opacity-50"
        >
          Отменить задачу
        </button>
        {fate ? <span className="min-w-0 text-[11.5px] leading-[1.4] text-tx2">{fate}</span> : null}
      </div>
      {askCancel ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[9px] border border-err-bd bg-err-s px-3 py-2.5">
          <span className="text-[11.5px] leading-[1.4] text-tx">
            Точно остановить? Это насовсем: работа встанет и сама не вернётся.
          </span>
          <button
            type="button"
            onClick={stopIt}
            disabled={cancel.isPending}
            className="rounded-[9px] bg-err-tx px-3.5 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
          >
            Да, отменить
          </button>
          <button
            type="button"
            onClick={() => setAskCancel(false)}
            className="rounded-[9px] border border-bd2 px-3.5 py-2 text-[12px] text-tx2 hover:text-tx"
          >
            Нет
          </button>
        </div>
      ) : null}
      {/* Граница канала названа ДО нажатия, а не только в ответе на него: человек выбирает
          между тремя кнопками до того, как что-то произошло, и выбирать он должен зная, чем
          они отличаются. Строка ниже — единственное место, где это можно прочесть заранее. */}
      <div className="mt-[7px] text-[11px] leading-[1.45] text-tx3">
        Сделанное не пропадёт: та же сессия продолжится с учётом поправки, без перезапуска с нуля.
        «Сказать сейчас» входит в идущий ход на ближайшем вызове инструмента и никого не убивает;
        если вызовов больше не будет — слово встанет продолжением после хода.
      </div>
    </div>
  )
}

/**
 * ParkedCall — «ждут вас»: опасный вызов СТОИТ, и продолжить его может только человек.
 *
 * ЧТО ЗДЕСЬ ПРОИСХОДИТ НА САМОМ ДЕЛЕ. Работник попросил что-то, что классификатор назвал
 * опасным, и сессия физически остановилась НА ЭТОМ ВЫЗОВЕ — не упала, не пошла дальше, не
 * перезапустилась. После «Одобрить вызов» продолжается ТА ЖЕ сессия тем же вызовом, со всем
 * контекстом, который уже оплачен.
 *
 * ПОЧЕМУ ЭТО НЕ БЕСКОНЕЧНОЕ ОЖИДАНИЕ. Срок объявлен и виден: по его истечении вызов будет
 * ОТКАЗАН, а не пропущен. Обещать человеку, что «оно подождёт», а потом молча выполнить —
 * ровно та сделка, ради отказа от которой всё это написано.
 *
 * ПОЧЕМУ ОДОБРЕНИЕ НЕ ОТКРЫВАЕТ СЛЕДУЮЩИЙ ВЫЗОВ. Идентификатор билета несёт отпечаток
 * аргументов: та же команда с другими аргументами придёт новым билетом и снова остановится.
 */
/**
 * Человеческие действия конверта — СЛОВАМИ ДЛЯ ЭКРАНА, и только для экрана. Это не второй
 * источник правды о стене: правду говорит дверь, присылая имя действия; здесь оно лишь
 * переводится на язык человека. Имя, которого тут нет, показывается как есть — молчать о
 * стене из-за отсутствующего перевода было бы хуже, чем показать её сырым словом.
 */
const WALL_ACTION_WORDS: Record<string, string> = {
  push: 'отправка в удалённый репозиторий',
  merge: 'слияние',
  tag: 'метка',
  deploy: 'публикация пакета или выпуск релиза',
}

/**
 * СТЕНА ЗА КНОПКОЙ — сказанная ДО нажатия, а не после.
 *
 * Что здесь произошло на живом прогоне: человек видел билет, нажимал «Одобрить» — и получал
 * отказ, потому что вызов упирался в ЖЁСТКИЙ запрет, уехавший в аргументы запуска работника.
 * Мягкая граница отпустила, жёсткая не пустила. Поведение правильное; несказанным оно быть
 * не должно.
 *
 * КНОПКА НЕ БЛОКИРУЕТСЯ, И ЭТО РЕШЕНИЕ, А НЕ НЕДОДЕЛКА. Мы предупреждаем, а не решаем за
 * человека: он вправе нажать и увидеть отказ своими глазами. Экран, который сам отнимает
 * кнопку на основании своей догадки, — это уже граница, а граница здесь не он.
 *
 * РИСУЕТСЯ ТОЛЬКО «УПРЁТСЯ». «Не упрётся» и «не знаем» не рисуются вовсе: сообщение «всё в
 * порядке» на основании неполного знания — это ложное успокоение, а оно опаснее молчания.
 */
function ApprovalWallNote({ wall }: { wall: ApprovalWall }) {
  if (wall.state !== 'blocked') return null
  const words = WALL_ACTION_WORDS[wall.action] ?? wall.action
  return (
    <div
      data-testid="approval-wall"
      className="mt-2.5 rounded-[9px] border border-bd2 bg-input px-[11px] py-2.5 text-[11.5px] leading-[1.5] text-tx"
    >
      <span className="font-semibold">Одобрение НЕ откроет этот вызов.</span> Работнику
      запрещено само это действие — {words} — аргументами его запуска: до запрета он не
      дотягивается, и одобрение запрет не снимает. Нажать «Одобрить» можно, но вызов всё
      равно получит отказ. Сделать это может только человек своими руками.
    </div>
  )
}

function ParkedCall({
  taskId,
  ticket,
  wall,
}: {
  taskId: string
  ticket: WaitingTicket
  wall?: ApprovalWall | null
}) {
  const decide = useDecideToolTicket()
  const [said, setSaid] = useState<string | null>(null)

  const answer = (decision: 'approve' | 'deny') => {
    if (decide.isPending) return
    decide.mutate(
      { taskId, ticketId: ticket.id, decision },
      {
        onSuccess: () =>
          setSaid(
            decision === 'approve'
              ? 'Отпускаю вызов — та же сессия продолжит с этого же места.'
              : 'Отказано — работник получит отказ вашими словами и пойдёт другим путём.',
          ),
        onError: (err) => setSaid(refusalWords(err)),
      },
    )
  }

  return (
    <div className="rounded-[14px] border border-warn bg-warn-s px-6 py-[18px] shadow-panel">
      <div className="mb-2.5 text-[10px] font-semibold tracking-[0.09em] text-warn-tx uppercase">
        Ждут вас — вызов стоит на месте
      </div>
      <div className="text-[12.5px] leading-[1.5] text-tx">
        Работник просит выполнить то, что мы считаем опасным. Пока вы не решите, сессия стоит на
        этом вызове.
      </div>
      <pre className="mt-2.5 overflow-x-auto rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12px] text-tx">
        {ticket.command ?? '(команда не записана)'}
      </pre>
      <div className="mt-2 text-[11.5px] leading-[1.45] text-tx2">
        {ticket.reason ? `${ticket.reason}. ` : ''}
        Билет <span className="font-semibold text-tx">{ticket.id}</span>
        {ticket.deadlineAt ? ` · без ответа до ${clockLabel(ticket.deadlineAt)} вызов будет ОТКАЗАН` : null}
      </div>
      {wall ? <ApprovalWallNote wall={wall} /> : null}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => answer('approve')}
          disabled={decide.isPending}
          className="rounded-[9px] bg-green px-3.5 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          ✓ Одобрить вызов
        </button>
        <button
          type="button"
          onClick={() => answer('deny')}
          disabled={decide.isPending}
          className="rounded-[9px] border border-bd2 px-3.5 py-2 text-[12px] text-tx2 hover:text-tx disabled:opacity-50"
        >
          Отказать
        </button>
        {said ? <span className="min-w-0 text-[11.5px] leading-[1.4] text-tx2">{said}</span> : null}
      </div>
      <div className="mt-[7px] text-[11px] text-tx3">
        Одобрение действует на ЭТОТ вызов: та же команда с другими аргументами придёт новым билетом.
      </div>
    </div>
  )
}

/**
 * «Карточка задачи» — one task in full: what was promised, what was checked, every run at
 * it, what changed, and the two decisions only a person can make.
 *
 * ═════════════════════ THE WHOLE STORY, ON ONE SCREEN ═════════════════════
 *
 * The panel that opens beside «Сегодня» is the short read; this is the long one. It is the
 * only place that shows the changes themselves and the journal — a person who wants to know
 * not just WHAT was done but WHY it went that way comes here and finds it, rather than
 * taking «готово» on trust.
 *
 * The card is opened FROM a task — from the feed, the board or the team — never from the
 * sidebar. The shell hands it the task it was opened with; opened with nothing, it says so
 * and points back at the board instead of inventing a task to show.
 *
 * Two readings feed it and no more: the task itself (which already carries the journal) and
 * its diff as plain text. The machine a task lives on is read from the picture the window
 * already holds and travels back with the decision, so approving a task that runs on another
 * machine works exactly like approving one that runs here.
 *
 * Everything on this screen is a text node. The diff and the worker's own notes are content
 * that came out of a model; they are read, never interpreted.
 */

/** When the work started and when it stopped moving — the ends of the whole story. */
function span(attempts: TaskAttempt[]): { from: string | null; to: string | null; ms: number | null } {
  const starts = attempts.map((a) => a.startedAt).filter((v): v is string => !!v)
  const ends = attempts.map((a) => a.endedAt).filter((v): v is string => !!v)
  const from = starts.length > 0 ? starts.reduce((a, b) => (a < b ? a : b)) : null
  const to = ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null
  if (!from || !to) return { from, to, ms: null }
  const ms = new Date(to).getTime() - new Date(from).getTime()
  return { from, to, ms: Number.isFinite(ms) && ms > 0 ? ms : null }
}

/**
 * ═══════════ ТРИ КОЛОНКИ: ЧТО ОБЕЩАНО · ЧТО СДЕЛАНО · ЧЕМ ДОКАЗАНО ═══════════
 *
 * По этим трём колонкам работу ПРИНИМАЮТ, не открывая терминал. Поэтому здесь действует
 * один запрет, который дороже любой красоты: отметка ставится ТОЛЬКО там, где состояние
 * известно из ответа двери. «✓» — подтверждено измеренным, «?» — ждёт человека, «×» — не
 * получилось, пусто — состояние никто не называл (в том числе «не начиналось»).
 *
 * Отметка, поставленная по прочтению кода, — это подпись, которой потом никто не признаёт:
 * человек принял работу, потому что увидел галочку, а галочку нарисовал экран. Поэтому там,
 * где данных нет, стоят слова о том, что их нет, — и никогда ноль и никогда галочка.
 */
type Mark = 'ok' | 'ask' | 'fail' | null

interface ColumnItem {
  text: string
  mark: Mark
  /** Пункт, о котором пока нечего сказать, — тише остальных. */
  muted?: boolean
}

const MARK_FACE: Record<'ok' | 'ask' | 'fail', { glyph: string; cls: string; title: string }> = {
  ok: { glyph: '✓', cls: 'border-ok-tx bg-ok-tx text-white', title: 'подтверждено измеренным' },
  ask: { glyph: '?', cls: 'border-warn-tx bg-card text-warn-tx', title: 'ждёт человека' },
  fail: { glyph: '×', cls: 'border-err-tx bg-card text-err-tx', title: 'не получилось' },
}

function MarkBox({ mark }: { mark: Mark }) {
  if (mark === null) {
    return (
      <span
        aria-hidden
        title="состояние не названо"
        className="mt-px flex h-[15px] w-[15px] flex-none rounded-[4px] border border-bd2 bg-card"
      />
    )
  }
  const face = MARK_FACE[mark]
  return (
    <span
      title={face.title}
      className={`mt-px flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[4px] border text-[9.5px] font-bold ${face.cls}`}
    >
      {face.glyph}
    </span>
  )
}

function Column({
  title,
  meta,
  metaTone,
  items,
  empty,
  footnote,
}: {
  title: string
  meta: string
  metaTone?: string
  items: ColumnItem[]
  /** Что сказать словами, когда пунктов нет. Ноль вместо этой строки — вранье. */
  empty: string
  footnote?: string | null
}) {
  return (
    <section className="min-w-0 flex-1 rounded-[12px] border border-bd bg-card px-[15px] py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-tx">{title}</span>
        <span className={`flex-none font-mono text-[10.5px] ${metaTone ?? 'text-tx3'}`}>{meta}</span>
      </div>
      {items.length === 0 ? (
        <p className="m-0 mt-2.5 text-[11.5px] leading-[1.45] text-tx3">{empty}</p>
      ) : (
        <div className="mt-2.5 flex flex-col gap-2">
          {items.map((i) => (
            <div key={i.text} className="flex items-start gap-2">
              <MarkBox mark={i.mark} />
              <span className={`min-w-0 flex-1 text-[11.5px] leading-[1.45] ${i.muted ? 'text-tx3' : 'text-tx2'}`}>
                {i.text}
              </span>
            </div>
          ))}
        </div>
      )}
      {footnote ? <p className="m-0 mt-2.5 text-[10.5px] leading-[1.4] text-tx3">{footnote}</p> : null}
    </section>
  )
}

/**
 * Что известно об обещанном — и известно РОВНО про задачу целиком.
 *
 * По каждому признаку отдельно никто сегодня не отчитывается, поэтому отметка либо приходит из
 * состояния задачи (человек принял, задача не получилась, задача ждёт человека), либо не
 * ставится вовсе. Строка-сноска под колонкой говорит это вслух — иначе галочка у одного пункта
 * читается как отчёт по этому пункту.
 */
function promiseMark(status: TaskStatus | null): Mark {
  if (status === 'awaiting_approval') return 'ask'
  if (status === 'failed') return 'fail'
  if (status === 'approved' || status === 'completed') return 'ok'
  return null
}

/** Чем кончился подход — теми же словами, что и на хронологии ниже. */
function attemptWords(a: TaskAttempt): string {
  if (a.outcome === 'returned') return 'возвращён на доработку'
  if (a.outcome === 'completed' || a.outcome === 'approved') return 'готово'
  if (a.outcome === 'failed') return a.reasonLabel ?? 'не получилось, причина не записана'
  if (a.reasonLabel) return a.reasonLabel
  return a.endedAt ? 'завершён' : 'идёт сейчас'
}

function attemptMark(a: TaskAttempt): Mark {
  if (a.outcome === 'completed' || a.outcome === 'approved') return 'ok'
  if (a.outcome === 'failed') return 'fail'
  return null
}

/** Что сделано: шаги попытки и коммиты — из того, что дверь задачи уже приносит. */
function doneItems(attempts: TaskAttempt[], commits: string[]): ColumnItem[] {
  const items: ColumnItem[] = attempts.map((a) => ({
    text: `Подход ${a.attempt ?? '—'} · ${attemptWords(a)}`,
    mark: attemptMark(a),
    muted: !a.endedAt && a.outcome === null,
  }))
  if (commits.length > 0) {
    items.push({
      text: `${commits.length} ${plural(commits.length, 'коммит', 'коммита', 'коммитов')} записано`,
      mark: 'ok',
    })
  }
  return items
}

/**
 * Чем доказано — сводка проверок и та ссылка, которую тик действительно записал.
 *
 * Числа здесь ТОЛЬКО из ответа двери. Четырёх чисел сводки сегодня не производит никто (это
 * замерено и записано отдельно), поэтому на живой задаче колонка чаще всего показывает ссылку
 * или честную пустоту — но никогда «0 из 0».
 */
function proofItems(attempt: TaskAttempt | null): { items: ColumnItem[]; meta: string; metaTone: string } {
  const checks = receiptChecks(attempt?.receipt)
  const proof = receiptProofLabel(attempt?.proof)
  const items: ColumnItem[] = checks.map((c) => ({ text: c.text, mark: c.ok ? 'ok' : 'fail' }))
  // «Не перепроверено» — НЕ галочка. Гейт, открывшийся без квитанции, оставляет доказательство
  // с оговоркой, и рисовать его тем же знаком, что и перепроверенную ветку, значило бы вернуть
  // ровно ту ложь, ради которой оговорка и доезжает до экрана: это ждёт человека.
  if (proof) items.push({ text: proof, mark: attempt?.proof?.unverified ? 'ask' : 'ok' })
  if (checks.length > 0) {
    const passed = checks.filter((c) => c.ok).length
    return { items, meta: `${passed} из ${checks.length}`, metaTone: passed === checks.length ? 'text-ok-tx' : 'text-warn-tx' }
  }
  return { items, meta: proof ? 'ссылка' : 'нет', metaTone: 'text-tx3' }
}

/**
 * ПРАВИЛО ЗАКРЫТИЯ СВОЕГО ВИДА — словами, на карточке.
 *
 * Инлайн закрывается закрытием сессии, и приёмка для него НЕ требуется; батч закрывается своей
 * сборкой, фаза — только пройденной приёмкой. Человеку, который открыл закрытую задачу и не
 * увидел кнопки «Одобрить», должно быть сказано, почему её нет, — иначе отсутствие кнопки
 * читается как «что-то сломалось».
 */
function closingWords(status: TaskStatus | null): string | null {
  if (status === 'completed' || status === 'approved') {
    return 'Сессия закрыта, приёмка для инлайна не требуется.'
  }
  return null
}

/**
 * Подход, о котором карточка спрашивает журнал: самый свежий по номеру. Список приезжает в
 * порядке леджера, и этот выбор не зависит от того, каким его кто-то считает.
 */
function newestAttempt(attempts: TaskAttempt[]): TaskAttempt | null {
  let newest: TaskAttempt | null = null
  for (const a of attempts) {
    if (a.attempt === null) continue
    if (newest === null || (newest.attempt ?? -1) < a.attempt) newest = a
  }
  return newest
}

/** Сколько длился голос: секунды у короткого, часы у длинного, «—» у неизмеренного. */
function lengthWords(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} с`
  return hoursLabel(ms / 3600000)
}

/**
 * ═══════════════════ КТО БЫЛ В СЕССИИ ИСПОЛНИТЕЛЯ ═══════════════════
 *
 * Исполнитель один и он виден первым; подагенты — деревом под ним, потому что это его сессия,
 * а не отдельные работники. Каждый голос называет модель, длительность и одну строку о деле.
 *
 * Всё это приезжает готовым из двери попытки: там роли считаются по ВСЕМУ журналу, а не по
 * хвосту, который поместился на экран. Карточка не пересчитывает ничего — и там, где дверь
 * ролей не отдала (демон старого кода), говорит это словами, а не собирает дерево из
 * подручного: пустое дерево читалось бы как «исполнитель работал один».
 */
function RolesBlock({
  data,
  loading,
  failed,
  attemptId,
  open,
  onToggle,
}: {
  data: AttemptLogPayload | undefined
  loading: boolean
  failed: boolean
  attemptId: string | null
  open: boolean
  onToggle: () => void
}) {
  const roles: AttemptRole[] | null = data && Array.isArray(data.roles) ? data.roles : null
  const shown = roles ? (open ? roles : roles.slice(0, 1)) : []
  const more = data?.rolesMore ?? 0

  const words = (): string | null => {
    if (!attemptId) return 'Подходов ещё не было — в сессии пока некому быть.'
    if (failed) return 'Журнал попытки не открылся — кто был в сессии, сказать нечем.'
    if (!data) return loading ? 'Открываю журнал попытки…' : 'Журнал попытки ещё не прочитан.'
    if (roles === null) {
      return 'Ролей в ответе нет: их не отдаёт процесс демона, который сейчас работает. Дерево из подручного здесь не собирается — до перезапуска демона со свежим кодом блок честно пуст.'
    }
    if (roles.length === 0) return 'Попытка ещё ничего не напечатала — голосов в сессии не видно.'
    return null
  }
  const empty = words()

  const meta =
    roles && roles.length > 0
      ? `${roles.length} ${plural(roles.length, 'роль', 'роли', 'ролей')}${more > 0 ? ` · ещё ${more} не поместилось` : ''}`
      : ''

  return (
    <section className="min-w-0 flex-1 overflow-hidden rounded-[12px] border border-bd bg-card">
      <div className="flex items-baseline gap-2.5 border-b border-bd px-3.5 py-2.5">
        <span className="text-[12px] font-semibold text-tx">Роли в сессии исполнителя</span>
        <span className="text-[11px] text-tx3">{meta}</span>
        {roles && roles.length > 1 ? (
          <button type="button" onClick={onToggle} className="ml-auto flex-none text-[11px] font-semibold text-blue">
            {open ? 'Свернуть' : 'Показать все'}
          </button>
        ) : null}
      </div>
      {empty ? (
        <p className="m-0 px-3.5 py-3 text-[11.5px] leading-[1.5] text-tx3">{empty}</p>
      ) : (
        <div className="flex flex-col">
          {shown.map((r, i) => {
            const sub = r.role === 'subagent'
            return (
              <div
                key={`${r.role}-${r.name ?? 'без имени'}-${i}`}
                className={`flex items-start gap-2.5 border-t border-bd py-2.5 pr-3.5 first:border-t-0 ${
                  sub ? 'pl-[34px]' : 'bg-surf pl-3.5'
                }`}
              >
                {sub ? <span aria-hidden className="mt-2 h-px w-3.5 flex-none bg-bd2" /> : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[12.5px] font-semibold text-tx">
                      {r.role === 'executor' ? 'Исполнитель' : (r.name ?? 'Делегация без имени')}
                    </span>
                    <span className="font-mono text-[10.5px] text-tx3">
                      {sub ? 'подагент · ' : ''}
                      {r.model ?? 'модель не названа'}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] leading-[1.45] text-tx2">
                    {r.detail ?? 'строки о деле нет'}
                    <span className="text-tx3"> · {r.steps} {plural(r.steps, 'строка', 'строки', 'строк')} прочитано</span>
                  </div>
                </div>
                <span className="flex-none font-mono text-[11.5px] text-tx2 tabular-nums">
                  {lengthWords(r.durationMs)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/**
 * ЗАДАЧА СТОИТ И ЖДЁТ ЧЕЛОВЕКА — третье из трёх мест, где это видно (полоса «ждут вас» и
 * строка списка — два первых).
 *
 * Здесь называется ВОЗРАСТ ожидания: «ждёт» без возраста — это не факт, а настроение, и
 * именно возраст отличает «остановился минуту назад» от «стоит с утра». Вопрос работника
 * показывается его словами; там, где дверь слов не принесла, так и сказано — карточка не
 * сочиняет вопрос за того, кто его задал.
 */
function BlockedBanner({
  ageHours,
  said,
  onDiscuss,
}: {
  ageHours: number | undefined
  said: string | null
  onDiscuss: () => void
}) {
  return (
    <div className="flex items-start gap-3.5 rounded-[10px] border border-warn-s bg-warn-s px-4 py-3">
      <span className="flex-none pt-px font-mono text-[10.5px] font-semibold tracking-[0.04em] text-warn-tx uppercase">
        {ageHours !== undefined ? `ждёт ${hoursLabel(ageHours)}` : 'сколько ждёт — нет данных'}
      </span>
      <div className="min-w-0 flex-1 text-[12.5px] leading-[1.45] text-tx">
        <p className="m-0">Исполнитель остановился и ждёт вашего решения. Он не додумывает за вас.</p>
        <p className="m-0 mt-1 text-[11.5px] text-tx2">
          {said
            ? `Его последние слова: ${said}`
            : 'Вопрос словами дверь задачи не отдаёт — карточка не придумывает его за работника. Что он делал, видно в ролях и в хронологии ниже.'}
        </p>
      </div>
      <button
        type="button"
        onClick={onDiscuss}
        className="flex-none rounded-[7px] border border-warn-tx px-3 py-1.5 text-[11.5px] font-semibold text-warn-tx"
      >
        Обсудить с системой
      </button>
    </div>
  )
}

/**
 * ПРАВАЯ ПАНЕЛЬ: последнее событие и внешние подключения — ЯВНЫМ блоком.
 *
 * Пустой блок подключений здесь не прячется: «ни одного» — это ответ, а отсутствие строки
 * читается как «подключения где-то есть, просто не показаны».
 *
 * РАСХОД УЕХАЛ В СВОЮ ПАНЕЛЬ (`SpendPanel`), и это не перестановка ради вида: он перестал
 * быть одной строкой итога сессии и стал шестью строками, из которых четыре — измеренные
 * поставщиком токены и кэш. Строке в углу чужого блока такое не по размеру.
 */
function SessionPanel({
  attempt,
  digest,
}: {
  attempt: TaskAttempt | null
  digest: AttemptDigest | null | undefined
}) {
  const when = attempt?.endedAt ?? attempt?.startedAt ?? null
  const text = !attempt
    ? 'Работа ещё не начиналась.'
    : !attempt.endedAt
      ? `Подход ${attempt.attempt ?? '—'} идёт с ${clockLabel(attempt.startedAt)}.`
      : `Подход ${attempt.attempt ?? '—'} · ${attemptWords(attempt)}.`
  const conns = digest?.connections

  return (
    <section className="rounded-[12px] border border-bd bg-card px-[15px] py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-tx">Последнее событие</span>
        <span className="flex-none font-mono text-[10.5px] text-tx3">{when ? clockLabel(when) : 'нет данных'}</span>
      </div>
      <p className="m-0 mt-1.5 text-[11.5px] leading-[1.5] text-tx2">{text}</p>

      <div className="mt-3 flex flex-col gap-1.5 border-t border-bd pt-3 text-[11.5px]">
        <div className="flex justify-between gap-3">
          <span className="text-tx2">Внешние подключения</span>
          <span className="min-w-0 flex-none text-right text-tx3">
            {conns === undefined ? 'нет данных' : conns.length === 0 ? 'ни одного' : conns.join(', ')}
          </span>
        </div>
      </div>
    </section>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
      <div className="mb-3 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">{title}</div>
      {children}
    </section>
  )
}

function NoTask() {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Карточка задачи</h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="m-0 text-[13px] text-tx2">Карточка открывается из задачи — выберите её на доске.</p>
        <button
          type="button"
          onClick={() => openScreen({ screen: 'tasks' })}
          className="rounded-[9px] bg-blue px-[15px] py-2 text-[12px] font-semibold text-white hover:bg-blue-d"
        >
          К задачам
        </button>
      </div>
    </section>
  )
}

export function Screen() {
  const opened = useOpenedWith()
  const taskId = opened?.taskId ?? null

  const queryClient = useQueryClient()
  const detail = useTaskQuery(taskId)
  const diff = useDiffQuery(taskId)
  const state = useStateQuery()
  const approve = useApprove()
  const returnTask = useReturnTask()
  const setWords = useTaskWords(taskId)

  const [returning, setReturning] = useState(false)
  /** Слово об остановке — на уровне КАРТОЧКИ: руль исчезает вместе с состоянием «в работе». */
  const [stopWord, setStopWord] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  /**
   * ЧЕМ КОНЧИЛАСЬ ПОСАДКА, когда она кончилась ХОРОШО. Отдельно от `problem`, потому что тон
   * — часть содержания: «принято, main зелёный» и «слияние не прошло» не могут стоять на
   * экране одной краской. Молчание успеха годилось, пока за кнопкой было одно слияние; теперь
   * за ней ещё и прогон со штампом, и человек обязан УЗНАТЬ, что руками доделывать нечего.
   */
  const [landed, setLanded] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [rolesOpen, setRolesOpen] = useState(true)
  const [editingWords, setEditingWords] = useState(false)
  const [draftDescription, setDraftDescription] = useState('')
  const [draftCriteria, setDraftCriteria] = useState('')

  /**
   * КАРТОЧКА СЛУШАЕТ КОЛОКОЛА СВОЕЙ ЗАДАЧИ И ПЕРЕЧИТЫВАЕТ СЕБЯ САМА.
   *
   * Дефект живого клика 25.08: после «Одобрить» состояние было видно только после F5. Канал у
   * окна один и он уже открыт (`subscribeHints`), поэтому здесь не открывается ничего нового —
   * подписка на уже идущий поток, сужённая до колоколов ЭТОЙ задачи, и отписка при закрытии
   * карточки. Почему по колоколу здесь ПЕРЕЧИТЫВАЮТ, хотя общей картине это запрещено, —
   * сказано в `task-live.ts`.
   */
  useEffect(() => watchTask(queryClient, taskId), [queryClient, taskId])

  // РОЛИ И РАСХОД — из журнала САМОГО СВЕЖЕГО подхода. Тот же ключ запроса, что у ленты
  // подхода ниже, поэтому вторым обращением к двери это не становится.
  const newest = newestAttempt(detail.data?.attempts ?? [])
  const attemptId = taskId && newest && newest.attempt !== null ? `${taskId}#${newest.attempt}` : null
  const log = useAttemptQuery(attemptId)

  // The machine the task lives on comes from the reading the window already has. It is
  // passed straight back with the decision — the card never decides where a task runs.
  // Ждущие человека строки лежат в СВОЁМ списке, а не в очереди: без него машина не находилась
  // ровно у тех задач, ради которых карточку и открывают, — у ждущих одобрения.
  const machine = useMemo(() => {
    if (!taskId) return undefined
    const rows = [...(state.data?.queue ?? []), ...(state.data?.awaiting ?? []), ...(state.data?.done ?? [])]
    return rows.find((r) => r.id === taskId)?.machine
  }, [state.data, taskId])

  // ЧЕЙ ЭТО ПРОЕКТ — спрошено у САМОЙ ЗАДАЧИ, а не разыскано по спискам картины: занятой
  // строки нет ни в очереди, ни у ждущих, ни в сделанном, и карточка идущей работы печатала
  // «проект не назван» о задаче со штампом — ровно в тот момент, когда промах и замечают.
  // Правило одно и живёт в `taskProjectOf`, вместе с причиной каждого его шага.
  const taskProject = useMemo(
    () => taskProjectOf({ detail: detail.data, state: state.data, taskId }),
    [detail.data, state.data, taskId],
  )

  // СВОЯ МАШИНА НЕ ПОСЫЛАЕТСЯ. Чтение помечает КАЖДУЮ здешнюю задачу собственным именем машины
  // — «self», если имя не задано, — и карточка честно возвращала его с решением. Дверь читала
  // любое непустое имя как «другая машина», федерации не находила и отвечала 501: живой прогон
  // показал, что кнопка приёмки не срабатывала ни на одной задаче. Ключ опускается — и старый
  // демон, который правила про собственное имя ещё не знает, такое нажатие принимает.
  const selfMachineId = state.data?.machines?.find((m) => m.role === 'self')?.id ?? 'self'
  const machineToSend = machine && machine !== 'self' && machine !== selfMachineId ? machine : undefined

  // Сколько задача уже ждёт человека — из того же ряда, которым живёт полоса «ждут вас».
  const waitingHours = useMemo(() => {
    if (!taskId) return undefined
    return (state.data?.awaiting ?? []).find((r) => r.id === taskId)?.agedForHours
  }, [state.data, taskId])

  // ЧТО ОТКРЫТО — рассказано оболочке, чтобы окно разговора отвечало про ЭТУ задачу. Признак
  // «держит работник» едет вместе с именем: только у живой сессии есть куда доехать поправке.
  useTellConsoleContext(
    taskId
      ? {
          kind: 'task',
          line: detail.data?.task?.title ?? `задача ${taskId}`,
          taskId,
          live: detail.data?.task?.status === 'claimed',
        }
      : null,
  )

  if (!taskId) return <NoTask />

  const task = detail.data?.task
  const attempts = detail.data?.attempts ?? []
  const status = task?.status ?? null
  const busy = approve.isPending || returnTask.isPending
  const canApprove = status === 'awaiting_approval'
  const canReturn = status === 'awaiting_approval' || status === 'failed' || status === 'completed'

  /**
   * ЖИВОЕ ВРЕМЯ ЗАДАЧИ — от разных моментов, потому что это разные вопросы.
   *
   * Пока задачу держит работник, считается от НАЧАЛА свежего подхода: «идёт столько-то». Как
   * только подход кончился и задача встала перед человеком (или не получилась), отсчёт идёт от
   * его КОНЦА — это и есть момент, с которого она ждёт решения, и растущее число здесь и есть
   * цена простоя. Считать ожидание от начала работы значило бы приписать к нему саму работу.
   *
   * Очередь и закрытая задача не тикают: у первой работа не начиналась, у второй — кончилась.
   */
  const timerState: TimerState =
    status === 'claimed'
      ? 'running'
      : status === 'awaiting_approval'
        ? 'waiting'
        : status === 'failed'
          ? 'failed'
          : 'idle'
  const timerSince = timerState === 'running' ? newest?.startedAt : (newest?.endedAt ?? newest?.startedAt)

  // «Чем доказано» читает ПОСЛЕДНИЙ подход, который хоть что-то оставил: разобранную квитанцию
  // или ссылку-доказательство. Раньше искалась только квитанция, и подход, закрывшийся на
  // перепроверенной ветке, читался как «проверять нечего».
  const lastWithProof = [...attempts].reverse().find((a) => a.receipt || a.proof) ?? null
  const promised: ColumnItem[] = acceptanceList(task?.acceptance).map((text) => ({
    text,
    mark: promiseMark(status),
  }))
  // СКОЛЬКО ХОДОВ ЭТОЙ РАБОТЕ ДАДУТ — рядом с обещанием, потому что считается оно ПО НЕМУ:
  // по числу признаков и по их длине. Человек, видящий «мелкая» над списком из шести пунктов,
  // видит ошибку формы обещания до того, как она будет стоить попытки.
  const planLine = turnPlanLine(task?.turnPlan)
  const planWhy = turnPlanWhy(task?.turnPlan)
  const done = doneItems(attempts, detail.data?.commits ?? [])
  const proof = proofItems(lastWithProof)
  const closing = closingWords(status)
  const worked = span(attempts)

  // ПРАВИТЬ СЛОВА МОЖНО, ПОКА РАБОТА НЕ ЗАКОНЧИЛАСЬ. Обещание правят ДО того, как по нему
  // судили: на задаче, которая уже произвела, провалилась или ждёт человека, дверь отвечает
  // отказом — и кнопки здесь тоже нет, чтобы человек не бился в заведомо закрытую дверь.
  const wordsEditable = status === 'queued' || status === 'claimed'

  const openWordsEditor = () => {
    setProblem(null)
    setDraftDescription(task?.description ?? '')
    setDraftCriteria(acceptanceList(task?.acceptance).join('\n'))
    setEditingWords(true)
  }

  /**
   * СТЕНА ВИДНА ДО НАЖАТИЯ. Редактор слов повторяет форму постановки: обрезка браузером снята
   * (молча урезанное описание уезжало бы правкой, которой человек не писал), счётчики стоят
   * под обоими полями, а судит по-прежнему дверь — её отказ теперь называет поле, длину и
   * потолок, и `refusalWords` доносит эти слова целиком.
   */
  const draftPromised = draftCriteria
    .split('\n')
    .map((s) => s.replace(/^[-•·]\s*/, '').trim())
    .filter((s) => s.length > 0)
  const draftOverText = draftDescription.length > CAP_TEXT
  const draftOverItems = draftPromised.length > CAP_ACCEPTANCE_ITEMS

  const saveWords = () => {
    if (!taskId) return
    setProblem(null)
    setWords.mutate(
      { taskId, description: draftDescription.trim(), acceptance: draftPromised },
      {
        onSuccess: () => setEditingWords(false),
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  /**
   * ПЕРЕСТАВИТЬ ЗАДАЧУ В ДРУГОЙ ПРОЕКТ — вместо «отменить и написать заново».
   *
   * Штамп проекта ставится при СОЗДАНИИ задачи и переключением активного проекта задним
   * числом не чинится. Пока переставить было нечем, промах стоил полного круга: замерено —
   * шесть работ, поставленных при не том активном проекте, пришлось отменить и пересоздать по
   * одной. Окно у перестановки то же, что у слов, и по той же причине: дерево, в котором
   * работа уже шла, переписывать нечем.
   *
   * Отправляется ТОЛЬКО проект: правка, которая заодно перезаписала бы слова значениями из
   * полей редактора, стёрла бы то, чего человек не трогал.
   */
  const moveToProject = (project: string) => {
    if (!taskId || project === '' || project === taskProject) return
    setProblem(null)
    setWords.mutate({ taskId, project }, { onError: (err) => setProblem(refusalWords(err)) })
  }

  const doApprove = () => {
    setProblem(null)
    setLanded(null)
    approve.mutate(
      { taskId, machine: machineToSend },
      {
        // ОТВЕТИЛА — НЕ ЗНАЧИТ ПРИНЯЛА. Дверь отвечает 200 с `ok:false`, поэтому обработчик
        // ошибки ниже на отказе не срабатывает вовсе: молчание после нажатия шло отсюда.
        //
        // …И «ПРИНЯЛА» ТЕПЕРЬ ТОЖЕ ГОВОРИТСЯ. За дверью стоит посадка целиком: свод, при
        // необходимости полный прогон и штамп чисел вершины. Итог обеих половин приезжает в
        // ответе, и обе стороны итога — успех и отказ — становятся словами на экране.
        onSuccess: (out) => {
          const said = approvalOutcome(out)
          setProblem(said.ok ? null : said.text)
          setLanded(said.ok ? said.text : null)
        },
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  const doReturn = () => {
    const text = note.trim()
    if (text.length === 0) {
      setProblem('Напишите, что поправить — работник вернётся именно к этому.')
      return
    }
    setProblem(null)
    returnTask.mutate(
      { taskId, note: text, machine: machineToSend },
      {
        onSuccess: () => {
          setReturning(false)
          setNote('')
        },
        onError: (err) => setProblem(refusalWords(err)),
      },
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <button
          type="button"
          onClick={() => openScreen({ screen: 'tasks' })}
          className="flex-none text-[12px] text-tx3 hover:text-tx2"
        >
          ← Задачи
        </button>
        <span className="flex-1" />
        <LiveTimer state={timerState} since={timerSince} />
        {problem ? <span className="flex-none text-[11.5px] text-err-tx">{problem}</span> : null}
        {landed ? <span className="flex-none text-[11.5px] text-ok-tx">{landed}</span> : null}
        {canApprove ? (
          <button
            type="button"
            onClick={doApprove}
            disabled={busy}
            className="flex-none rounded-[9px] bg-blue px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
          >
            {/* НАЖАТО — ЗНАЧИТ СКАЗАНО ВСЛУХ. За дверью приёмки живёт слияние с прогоном
                тестов — минуты, и всё это время молчащая кнопка неотличима от зависшего
                окна (узкий экран говорил «Принимаю…» с самого начала, широкий — молчал). */}
            {approve.isPending ? 'Принимаю…' : 'Одобрить'}
          </button>
        ) : null}
        {canReturn ? (
          <button
            type="button"
            onClick={() => {
              setReturning(true)
              setProblem(null)
            }}
            disabled={busy}
            className="flex-none rounded-[9px] border border-bd2 px-4 py-2 text-[12px] text-tx2 hover:text-tx disabled:opacity-60"
          >
            Вернуть
          </button>
        ) : null}
      </header>

      {detail.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">Не удалось открыть задачу. Она осталась на месте.</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-9 py-7">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-7">
          <div className="min-w-0">
            <span className={`rounded-full px-2.5 py-[3px] text-[11px] ${statusTone(status)}`}>
              {statusWord(status)}
            </span>
            <h1 className="m-0 mt-3 text-[21px] leading-[1.3] font-semibold text-tx">
              {task?.title ?? (detail.isLoading ? 'Открываю…' : 'Без названия')}
            </h1>
            <div className="mt-3 flex items-center gap-2">
              <span
                className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] text-[9.5px] font-bold ${accentFor(
                  task?.lane ?? task?.title,
                )}`}
              >
                {initialOf(task?.lane ?? task?.title)}
              </span>
              <span className="text-[12.5px] text-tx2">
                {[
                  task?.lane ?? 'без направления',
                  attempts.length > 0 ? attemptsLabel(attempts.length) : 'подходов ещё не было',
                  worked.ms !== null ? hoursLabel(worked.ms / 3600000) : null,
                  worked.to ? clockLabel(worked.to) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          </div>

          {status === 'awaiting_approval' ? (
            <BlockedBanner
              ageHours={waitingHours}
              said={log.data?.note ?? newest?.approachNote ?? null}
              onDiscuss={() => {
                setProblem(null)
                // Разговор, а не форма возврата: окно уже знает, что открыта ЭТА задача, и
                // отвечает про неё. Возврат с комментарием остался своей кнопкой ниже — это
                // другое действие, и путать их значило бы отвечать за человека.
                openSystemConsole()
              }}
            />
          ) : null}

          <div className="flex flex-col gap-2.5">
            {task?.description && !editingWords ? (
              <p className="m-0 px-1 text-[12px] leading-[1.45] text-tx2">{task.description}</p>
            ) : null}

            {editingWords ? (
              <div className="flex flex-col gap-2 rounded-[11px] border border-bd2 bg-card p-3">
                <div className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Слова задачи</div>
                <textarea
                  value={draftDescription}
                  onChange={(e) => setDraftDescription(e.target.value)}
                  rows={2}
                  placeholder="Что это за работа"
                  aria-label="Описание задачи"
                  className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2 text-[12px] text-tx outline-none focus:border-blue"
                />
                <div
                  className={`-mt-1 text-right text-[10.5px] tabular-nums ${draftOverText ? 'text-err-tx' : 'text-tx3'}`}
                >
                  {draftDescription.length} / {CAP_TEXT}
                </div>
                <textarea
                  value={draftCriteria}
                  onChange={(e) => setDraftCriteria(e.target.value)}
                  rows={5}
                  placeholder="Признаки успеха — по одному в строке"
                  aria-label="Признаки успеха"
                  className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2 text-[12px] text-tx outline-none focus:border-blue"
                />
                <div
                  className={`-mt-1 text-right text-[10.5px] tabular-nums ${draftOverItems ? 'text-err-tx' : 'text-tx3'}`}
                >
                  признаков: {draftPromised.length} / {CAP_ACCEPTANCE_ITEMS}
                </div>
                {draftOverText || draftOverItems ? (
                  <p className="m-0 rounded-[8px] bg-warn-s px-2.5 py-2 text-[11.5px] leading-[1.4] text-warn-tx">
                    {draftOverText
                      ? `Описание: ${draftDescription.length} ${plural(draftDescription.length, 'знак', 'знака', 'знаков')} при потолке ${CAP_TEXT}. `
                      : ''}
                    {draftOverItems ? `Признаков успеха: ${draftPromised.length} при потолке ${CAP_ACCEPTANCE_ITEMS}. ` : ''}
                    Дверь столько не примет — сократите, иначе правка не сохранится.
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingWords(false)}
                    className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={saveWords}
                    disabled={setWords.isPending}
                    className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
                  >
                    Сохранить
                  </button>
                </div>
              </div>
            ) : wordsEditable ? (
              <div className="flex justify-start px-1">
                <button
                  type="button"
                  onClick={openWordsEditor}
                  className="rounded-[7px] border border-bd2 px-2 py-1 text-[10.5px] text-tx2 hover:text-tx"
                >
                  Поправить слова
                </button>
              </div>
            ) : null}

            {wordsEditable ? (
              <div className="flex flex-wrap items-center gap-2 px-1">
                <span className="text-[10px] font-semibold tracking-[0.08em] text-tx3 uppercase">Проект</span>
                <select
                  value={taskProject ?? ''}
                  onChange={(e) => moveToProject(e.target.value)}
                  disabled={setWords.isPending}
                  aria-label="Проект задачи"
                  className="rounded-[7px] border border-bd2 bg-input px-2 py-1 text-[11.5px] text-tx outline-none focus:border-blue disabled:opacity-60"
                >
                  {/* Строка, не назвавшая проекта, так и стоит: подставить сюда текущий выбор
                      значило бы записать за неё факт, которого никто не измерял. */}
                  {taskProject === null ? <option value="">проект не назван</option> : null}
                  {(state.data?.projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <span className="text-[10.5px] text-tx3">
                  Работник получит копию из дерева этого проекта — переставьте, если задача уехала не туда.
                  {/* КОПИЯ УЖЕ ОТРЕЗАНА, И ПЕРЕСТАВИТЬ ЕЁ НЕЧЕМ. Идущий подход работает в дереве,
                      которое ему отвели при выдаче; перестановка меняет то, откуда отведут
                      СЛЕДУЮЩУЮ копию. Умолчать об этом значило бы дать человеку нажать и ждать
                      от работника того, чего он сделать не может. */}
                  {status === 'claimed'
                    ? ' Работа уже идёт в прежнем дереве — перестановка подействует со следующего подхода.'
                    : ''}
                </span>
              </div>
            ) : null}

            <div className="flex items-stretch gap-3.5">
              <Column
                title="Что обещано"
                meta="критерии"
                items={promised}
                empty="Ничего не обещано — задача поставлена без условий приёмки."
                footnote={
                  promised.length > 0 && promiseMark(status) !== null
                    ? 'Отметка — по состоянию задачи целиком: по каждому признаку отдельно система не отчитывается.'
                    : null
                }
              />
              <Column
                title="Что сделано"
                meta="по шагам"
                items={done}
                empty="Работа ещё не начиналась — задача ждёт своей очереди."
              />
              <Column
                title="Чем доказано"
                meta={proof.meta}
                metaTone={proof.metaTone}
                items={proof.items}
                empty="Квитанции пока нет — проверять ещё нечего."
              />
            </div>
            {planLine ? (
              <p className="m-0 px-1 text-[11.5px] text-tx3">
                Размер работы: <span className="text-tx">{planLine}</span>
                {planWhy ? <span> · {planWhy}</span> : null}
              </p>
            ) : null}
            {closing ? <p className="m-0 px-1 text-[11.5px] text-tx3">{closing}</p> : null}
          </div>

          <div className="flex items-start gap-3.5">
            <RolesBlock
              data={log.data}
              loading={log.isLoading}
              failed={log.isError}
              attemptId={attemptId}
              open={rolesOpen}
              onToggle={() => setRolesOpen((v) => !v)}
            />
            {/* ПРАВЫЙ СТОЛБИК КАРТОЧКИ, в порядке принятого макета: что происходит сейчас,
                что происходило только что, и во что это обошлось. */}
            <div className="flex w-[320px] flex-none flex-col gap-3.5">
              <LiveFlow
                attempts={attempts}
                status={status}
                ticket={newest?.ticket ?? null}
                redirects={detail.data?.journal?.redirects ?? null}
              />
              <SessionPanel attempt={newest} digest={log.data?.digest} />
              <SpendPanel
                tokens={detail.data?.task?.tokens}
                session={log.data?.digest?.session}
                spendSwitch={state.data?.rules?.subApiSwitch}
              />
            </div>
          </div>

          {/* ЖДУТ ВАС — выше руля, потому что стоящий вызов срочнее любой поправки. */}
          {status === 'claimed' && taskId && newest?.ticket ? (
            <ParkedCall taskId={taskId} ticket={newest.ticket} wall={newest.approvalWall} />
          ) : null}

          {status === 'claimed' && taskId ? <Steering taskId={taskId} onStopped={setStopWord} /> : null}

          {stopWord ? (
            <div className="rounded-[14px] border border-err-bd bg-err-s px-6 py-[14px] text-[12.5px] leading-[1.45] text-tx shadow-panel">
              {stopWord}
            </div>
          ) : null}

          <div className="flex items-start gap-7">
            <div className="min-w-0 flex-1 rounded-[14px] border border-bd bg-card px-6 pt-[22px] pb-2 shadow-panel">
              <div className="mb-4 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Хронология</div>
              <AttemptTimeline
                attempts={attempts}
                returnedNotes={detail.data?.returnedNotes ?? []}
                taskId={taskId}
                memoryTrace={detail.data?.journal?.memoryTrace ?? null}
                /* Коммит слияния приёмки — то, чем ПРИНЯТАЯ работа отменяется одной
                   командой. Дверь проверила его по форме перед выдачей; здесь он только
                   передаётся дальше и ни во что не собирается. */
                merge={{ sha: task?.mergeSha ?? null, repo: task?.mergeRepo ?? null }}
              />

              {returning ? (
                <div className="mb-5 flex flex-col gap-2.5 rounded-[11px] border border-bd2 bg-surf p-3.5">
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Комментарий: что поправить"
                    rows={3}
                    className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2.5 text-[12.5px] text-tx outline-none focus:border-blue"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setReturning(false)
                        setProblem(null)
                      }}
                      className="rounded-lg border border-bd2 px-3.5 py-2 text-[11.5px] text-tx2 hover:text-tx"
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      onClick={doReturn}
                      disabled={busy}
                      className="rounded-lg bg-blue px-4 py-2 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
                    >
                      {returnTask.isPending ? 'Возвращаю…' : 'Вернуть с комментарием'}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex w-[336px] flex-none flex-col gap-4">
              <DiffSummary
                text={diff.data ?? null}
                loading={diff.isLoading}
                failed={diff.isError}
                expanded={diffOpen}
                onToggle={() => setDiffOpen((v) => !v)}
              />

              <Panel title="Сколько заняло">
                <div className="text-[15px] font-semibold text-tx tabular-nums">
                  {worked.ms !== null ? hoursLabel(worked.ms / 3600000) : '—'}
                </div>
                <p className="m-0 mt-1.5 text-[11.5px] leading-[1.5] text-tx3">
                  {worked.from
                    ? `${attemptsLabel(attempts.length)} · с ${clockLabel(worked.from)} до ${clockLabel(worked.to)}`
                    : 'Работа ещё не начиналась.'}
                </p>
              </Panel>

              <Panel title="Ветка и коммиты">
                <div className="font-mono text-[11.5px] break-all text-tx2">{detail.data?.branch ?? '—'}</div>
                {(detail.data?.commits ?? []).length === 0 ? (
                  <p className="m-0 mt-2 text-[12px] text-tx3">Коммитов пока нет.</p>
                ) : (
                  <div className="mt-2.5 flex flex-col gap-1.5">
                    {(detail.data?.commits ?? []).map((c) => (
                      <div key={c} className="truncate font-mono text-[11.5px] text-tx2" title={c}>
                        {c}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>
          </div>

          <JournalSection journal={detail.data?.journal} attempts={attempts} />

          {diffOpen && diff.data ? <DiffText text={diff.data} /> : null}
        </div>
      </div>
    </section>
  )
}
