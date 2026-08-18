import { useEffect, useMemo, useRef, useState } from 'react'
import { useAttemptQuery } from '../api/queries'
import type { AttemptDigest, AttemptLogLine, AttemptLogSummaryPart, TaskAttempt } from '../api/types'
import { clockLabel } from './format'

/**
 * The three READINGS of one transcript (recon 11.08, the Paperclip lesson Nice/Raw/Live):
 *   nice — the human feed: tool crumbs, handoffs, what was said (the default);
 *   raw  — every stored line exactly as written, for the person debugging the machine;
 *   live — the nice feed pinned to the tail: the eye follows the worker, always.
 * One transcript, one reader, three ways to hold it — never three sources.
 */
export type TranscriptView = 'nice' | 'raw' | 'live'

/**
 * AttemptLog — what the worker is saying, while it is saying it.
 *
 * ═════════════════════ A LINE OF THIS LOG IS TEXT. FULL STOP. ═══════════════════════
 *
 * Every line here is output of a program that was told to do something by a person and then
 * left alone with a project. It is untrusted in the strictest sense — the daemon says so in
 * four places on the way out — and it arrives at a screen where the temptation to render it
 * «nicely» would be a way for a worker to write markup into the window of the person watching
 * it. So a line is a TEXT CHILD of `<pre>` and nothing else: no markup is parsed, no link is
 * made, nothing is highlighted. Monospaced, wrapped, exactly as written.
 *
 * ═════════════════════ THE NOTE IS READ OFF THE WHOLE LOG ═══════════════════════════
 *
 * What the worker said about its approach is stated in the first minutes and would fall off
 * the tail of any long attempt. The reader on the other side takes it off the whole file, not
 * off the tail it returns — so it is shown here as a block ABOVE the log rather than as
 * whichever line happens to be in view.
 *
 * ═════════════════════ THE EYE KEEPS ITS PLACE ══════════════════════════════════════
 *
 * New lines scroll into view only while the reader is already at the bottom. A person who has
 * scrolled up is READING something, and yanking them back down every three seconds is how a
 * live log becomes a thing people close.
 */

/** How close to the bottom still counts as «watching the end». */
const AT_BOTTOM_SLACK_PX = 24

/**
 * ═════════════ A HUMAN FEED NEVER FALLS BACK TO A MACHINE FRAME ═════════════════════
 *
 * This screen used to show the raw stored line whenever the daemon had no summary for it, on
 * the theory that something is better than nothing. It is not. A frame with nothing a person
 * needs is a frame whose raw form is WORSE than nothing: the run whose card was opened showed
 * a wall of base64 — assistant frames carrying an empty reasoning block and its several-
 * kilobyte signature — and the answer to «what is my worker doing» became unreadable.
 *
 * So the human readings render SUMMARIES ONLY. A row the daemon could not translate is not
 * shown here at all; it is counted, said out loud under the log («скрыто N служебных строк»)
 * and it is all still there, byte for byte, in «Сырьё». The one exception is a line that was
 * never a machine frame — the daemon writes its own plain sentences into this same log, and
 * hiding «lease renewal failed» would hide the most important line an attempt can carry.
 */

/** Whether a stored line is a machine frame — cheap prefix test, no parse, no allocation. */
function looksLikeFrame(line: string): boolean {
  const head = line.slice(0, 2).trimStart()
  return head.startsWith('{') || head.startsWith('[')
}

/**
 * WHAT THE WORKER DID, AS A VERB. The daemon stores the vendor's tool name; a person reads
 * «прочитал файл». The table is here rather than in the daemon because it is a matter of
 * wording, not of fact — the fact (which tool, pointed at what) is what travels — and because
 * a tool this build has never heard of must still produce an honest row: it keeps its own
 * name and is announced as «вызвал инструмент», never as a guessed verb.
 */
const TOOL_VERB: Record<string, string> = {
  Read: 'прочитал файл',
  NotebookRead: 'прочитал блокнот',
  Write: 'создал файл',
  Edit: 'изменил файл',
  MultiEdit: 'изменил файл',
  NotebookEdit: 'изменил блокнот',
  Bash: 'запустил команду',
  PowerShell: 'запустил команду',
  Glob: 'искал файлы',
  Grep: 'искал в тексте',
  ToolSearch: 'искал инструмент',
  WebFetch: 'открыл страницу',
  WebSearch: 'искал в интернете',
  TodoWrite: 'обновил план',
}

/** Which tools point at a FILE — those details are shortened as paths, everything else is not. */
const FILE_TOOLS = new Set(['Read', 'NotebookRead', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** What a row of each kind is called, when the kind alone decides it. */
const KIND_LABEL: Record<string, string> = {
  handoff: 'передал агенту',
  mcp: 'обратился к подключению',
  skill: 'включил навык',
  tool_result: 'ответ',
  text: 'сказал',
  thinking: 'думал',
  session: 'сессия',
  apikey: 'ключ API',
  denied: 'отказано',
  progress: 'ещё идёт',
  result: 'итог сессии',
  limit: 'окно подписки',
}

/**
 * A PATH, SHORT ENOUGH TO READ, WITHOUT LOSING THE NAME.
 *
 * Every path in this log starts with the same forty characters of workspace prefix and ends
 * with the only part anybody is looking for. Truncating from the right — which is what a
 * one-line box does by itself — throws away the file name and keeps the prefix, so the two
 * rows «изменил файл …\projects\sma-worktrees\t-4496\dae…» say nothing and look identical.
 * The last two segments are kept instead, and the whole path stays in the row's tooltip.
 */
function shortPath(text: string): string {
  const parts = text.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 2 || !/[\\/]/.test(text)) return text
  return `…/${parts.slice(-2).join('/')}`
}

/** The tone of a row: a failure is red, an ordinary step is quiet. */
function partTone(part: AttemptLogSummaryPart): string {
  if (part.ok === false || part.kind === 'denied') return 'bg-err-s text-err-tx'
  if (part.kind === 'handoff' || part.kind === 'mcp' || part.kind === 'skill') return 'bg-blue-s text-blue'
  return 'bg-idle-s text-idle-tx'
}

/** One part of a frame, as a person reads it. Every value is a TEXT CHILD — see the header. */
function SummaryPart({ part }: { part: AttemptLogSummaryPart }) {
  const isTool = part.kind === 'tool'
  const label = isTool ? (TOOL_VERB[part.tool ?? ''] ?? 'вызвал инструмент') : KIND_LABEL[part.kind]
  // The tool's own name still rides along on a tool row — but only when the verb did not
  // already say it, so «запустил команду · Bash» is not printed as «Bash Bash».
  const name = isTool ? (TOOL_VERB[part.tool ?? ''] ? '' : part.tool) : part.tool
  const detail = part.detail && isTool && FILE_TOOLS.has(part.tool ?? '') ? shortPath(part.detail) : part.detail
  return (
    <div className="flex items-baseline gap-1.5">
      {label ? <span className={`flex-none rounded px-1 py-[1px] text-[10px] ${partTone(part)}`}>{label}</span> : null}
      {name ? <span className="flex-none text-[11px] font-medium text-tx2">{name}</span> : null}
      {part.subagent ? <span className="flex-none text-[11px] text-tx3">→ {part.subagent}</span> : null}
      {detail ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-tx3" title={part.detail}>
          {detail}
        </span>
      ) : null}
    </div>
  )
}

/**
 * ONE ROW. In the human readings the row IS the summary — «Ход попытки» says which tool ran,
 * on which file, and what came back. In «Сырьё» it is the stored line exactly as written, and
 * that is the view for the person debugging the machine.
 */
function LogLine({ line, raw = false }: { line: AttemptLogLine; raw?: boolean }) {
  const parts = raw ? [] : (line.summary ?? [])
  return (
    <div className={`flex items-start gap-2 px-2.5 py-[3px] ${line.subagent ? 'border-l-2 border-idle-s pl-3' : ''}`}>
      <span className="flex-none pt-[1px] font-mono text-[10.5px] text-tx3 tabular-nums">{clockLabel(line.ts)}</span>
      {line.subagent ? (
        <span className="flex-none rounded-full bg-idle-s px-1.5 py-[1px] text-[10px] text-idle-tx">
          {line.group ? `субагент ${line.group}` : 'субагент'}
        </span>
      ) : null}
      {parts.length ? (
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          {parts.map((part, i) => (
            <SummaryPart key={i} part={part} />
          ))}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <pre className="m-0 min-w-0 font-mono text-[11px] leading-[1.5] break-words whitespace-pre-wrap text-tx2">
            {line.line}
          </pre>
          <TruncationMark line={line} />
        </div>
      )}
    </div>
  )
}

/**
 * ОБРЕЗКА, СКАЗАННАЯ ВСЛУХ. Ряд, который не поместился в потолок, до этой правки выглядел как
 * ряд, который просто там кончился, — и человек читал часть, думая, что читает целое. Пометка
 * состоит из чисел и постоянных слов: ничего из данных ряда в неё не попадает, поэтому она не
 * может стать каналом разметки; сама строка рисуется текстом ровно как раньше.
 */
function TruncationMark({ line }: { line: AttemptLogLine }) {
  if (!line.truncated) return null
  const shown = line.line.length
  const total = typeof line.originalLength === 'number' ? line.originalLength : null
  return (
    <span className="text-[10.5px] text-tx3">
      {total === null ? 'обрезано' : `обрезано: показано ${shown} из ${total} знаков`}
    </span>
  )
}

/** One line of the roll-up: a label and its answer, both plain text. */
function DigestRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[11px] leading-[1.6]">
      <span className="w-[92px] flex-none text-tx3">{label}</span>
      <span className="min-w-0 flex-1 text-tx2">{children}</span>
    </div>
  )
}

/**
 * ЧТО В ИТОГЕ — the four questions a person arrives with, answered under the transcript.
 *
 * WHICH TOOLS, WHICH FILES, WHICH CONNECTIONS AND SKILLS, AND WHAT IT COST. The daemon counts
 * all of it over the WHOLE log, so these figures do not change when the window above shows a
 * tail. Nothing here is inferred beyond what the stream said:
 *   - the money line is the vendor's own counter, printed as the vendor's own sentence;
 *   - the channel line says WHICH FACT WAS OBSERVED — a named API credential, or a
 *     subscription window the vendor reported — and when the stream named neither it says so
 *     instead of picking one. «Не назван» is an honest answer; a guessed «подписка» is not.
 */
function Digest({ digest }: { digest: AttemptDigest }) {
  const files = (list: string[], more: number) =>
    `${list.map(shortPath).join(', ')}${more ? ` … и ещё ${more}` : ''}`
  const channel = digest.apiKey
    ? `вендор назвал ключ API: ${digest.apiKey} — это платный канал`
    : digest.subscriptionWindow
      ? 'следов платного ключа в потоке нет; вендор отчитывался об окне подписки'
      : 'в потоке не назван — ни ключа API, ни окна подписки'

  return (
    <div className="mt-2 rounded-[10px] border border-bd bg-surf px-2.5 py-2">
      <div className="mb-1.5 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Что в итоге</div>
      <div className="flex flex-col gap-[3px]">
        <DigestRow label="шагов">
          {digest.steps} · вызовов инструментов {digest.calls}
          {digest.commands ? ` · команд ${digest.commands}` : ''}
          {digest.failures ? ` · сбоев ${digest.failures}` : ''}
          {digest.denied ? ` · отказов ${digest.denied}` : ''}
        </DigestRow>
        {digest.tools.length ? (
          <DigestRow label="инструменты">
            {digest.tools.map((t) => `${t.name} ×${t.count}`).join(' · ')}
            {digest.toolsMore ? ` … и ещё ${digest.toolsMore}` : ''}
          </DigestRow>
        ) : null}
        {digest.filesChanged.length ? (
          <DigestRow label="изменил">
            <span title={digest.filesChanged.join('\n')}>{files(digest.filesChanged, digest.filesChangedMore)}</span>
          </DigestRow>
        ) : null}
        {digest.filesRead.length ? (
          <DigestRow label="прочитал">
            <span title={digest.filesRead.join('\n')}>{files(digest.filesRead, digest.filesReadMore)}</span>
          </DigestRow>
        ) : null}
        <DigestRow label="подключения">{digest.connections.length ? digest.connections.join(', ') : 'не было'}</DigestRow>
        <DigestRow label="навыки">{digest.skills.length ? digest.skills.join(', ') : 'не включались'}</DigestRow>
        {digest.handoffs ? (
          <DigestRow label="агентам">
            {digest.handoffs}
            {digest.agents.length ? ` · ${digest.agents.join(', ')}` : ''}
          </DigestRow>
        ) : null}
        <DigestRow label="платный API">{channel}</DigestRow>
        {digest.session ? <DigestRow label="счётчик">{digest.session}</DigestRow> : null}
      </div>
    </div>
  )
}

/**
 * The tail of one attempt's log, kept fresh while the panel showing it is open.
 *
 * The rhythm is the api layer's: the read that this window already uses for a running attempt.
 * It stops when this component goes away, which is when the panel closes — a log nobody has
 * open costs nothing.
 */
export function AttemptLog({ taskId, attempt }: { taskId: string; attempt: TaskAttempt }) {
  // The identity of an attempt as the ledger mints it: the task, a «#», the run's number. The
  // client encodes it; a bare «#» would never reach the door.
  const attemptId = attempt.attempt === null ? null : `${taskId}#${attempt.attempt}`
  const log = useAttemptQuery(attemptId)

  const [view, setView] = useState<TranscriptView>('nice')
  const boxRef = useRef<HTMLDivElement | null>(null)
  const watchingEnd = useRef(true)

  const lines = log.data?.lines ?? []
  const digest = log.data?.digest ?? null

  // The rows a PERSON is shown: everything the daemon could translate, plus the plain
  // sentences the daemon itself writes into this log. Machine frames it had nothing to say
  // about are counted, not printed — see the note above LogLine.
  const shown = useMemo(
    () => (view === 'raw' ? lines : lines.filter((l) => (l.summary?.length ?? 0) > 0 || !looksLikeFrame(l.line))),
    [lines, view],
  )
  const hidden = lines.length - shown.length

  useEffect(() => {
    const box = boxRef.current
    // «live» pins the eye to the tail unconditionally; «nice»/«raw» keep the reader's place.
    if (!box || (view !== 'live' && !watchingEnd.current)) return
    box.scrollTop = box.scrollHeight
  }, [shown.length, view])

  const onScroll = () => {
    const box = boxRef.current
    if (!box) return
    watchingEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight <= AT_BOTTOM_SLACK_PX
  }

  // The note also rides each attempt's own row above; showing the same sentence twice in one
  // panel reads as two different facts that happen to match.
  const note = log.data?.note && log.data.note !== attempt.approachNote ? log.data.note : null

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2.5">
        <span className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Ход попытки</span>
        <span className="text-[11px] text-tx3">подход {attempt.attempt ?? '—'}</span>
        <span className="flex-1" />
        {/* Три чтения одной стенограммы — переключатель, не три источника. */}
        <div className="flex gap-1" role="group" aria-label="Вид стенограммы">
          {(
            [
              ['nice', 'Лента'],
              ['raw', 'Сырьё'],
              ['live', 'Вживую'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`rounded-[6px] px-2 py-[2px] text-[10px] ${
                view === v ? 'bg-blue-s font-semibold text-blue' : 'text-tx3 hover:text-tx2'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {note ? (
        <p className="mt-0 mb-2 rounded-[9px] border border-bd bg-surf px-2.5 py-2 text-[11.5px] leading-[1.55] text-tx2">
          {note}
        </p>
      ) : null}

      {log.isError ? (
        <p className="m-0 text-[12px] leading-[1.55] text-tx3">
          Стенограмма сейчас не читается. На саму работу это не влияет — она пишется на диск.
        </p>
      ) : null}

      {!log.isError && lines.length === 0 ? (
        <p className="m-0 text-[12px] text-tx3">
          {log.isLoading ? 'Открываю стенограмму…' : 'Работник пока ничего не сказал.'}
        </p>
      ) : null}

      {lines.length > 0 ? (
        <>
          {log.data?.truncated ? (
            <p className="mt-0 mb-1.5 text-[11px] text-tx3">Начало обрезано — показан хвост.</p>
          ) : null}
          <div
            ref={boxRef}
            onScroll={onScroll}
            className="max-h-[220px] overflow-y-auto rounded-[10px] border border-bd bg-surf py-1.5"
          >
            {shown.map((line, i) => (
              <LogLine key={`${line.ts}-${i}`} line={line} raw={view === 'raw'} />
            ))}
          </div>
          {/* Что не показано — сказано вслух, а не тихо выброшено. */}
          {view !== 'raw' && hidden > 0 ? (
            <p className="mt-1 mb-0 text-[11px] text-tx3">
              Скрыто служебных строк потока: {hidden}. Все они целиком — во вкладке «Сырьё».
            </p>
          ) : null}
          {digest ? <Digest digest={digest} /> : null}
        </>
      ) : null}
    </div>
  )
}
