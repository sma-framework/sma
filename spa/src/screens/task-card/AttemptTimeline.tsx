import { useState } from 'react'
import type { MaterializedEntry, TaskAttempt } from '../../api/types'
import { AttemptLog } from '../../shell/AttemptLog'
import { clockLabel, receiptChecks, receiptProofLabel } from '../../shell/format'

/**
 * AttemptTimeline — the whole history of one task, in the order it happened.
 *
 * Every run at the task is a row: when it started, how it ended, and — one click away — the
 * receipt it ended with. A retry is not a new story but the next row of the same one, which
 * is why the chain is read top to bottom and never re-sorted.
 *
 * ═══════════════ WHAT THE PERSON SAID SITS WHERE THEY SAID IT ═══════════════
 *
 * A returned task carries the comment that sent it back. The read model builds those
 * comments by walking the attempts that ended in «возвращена», in order — so the n-th
 * comment belongs to the n-th returned run, and this is where it is shown: under that run,
 * not in a pile at the bottom. If the two ever fall out of step, the row simply carries no
 * comment; nothing is guessed.
 *
 * Nothing on this timeline is markup. A failure reason, a receipt figure and a person's own
 * comment all reach the glass as text nodes.
 */

/** How a run ended, in words. A run still going says so; a run that failed says why. */
function outcomeWords(attempt: TaskAttempt): string {
  if (attempt.outcome === 'returned') return 'возвращена на доработку'
  if (attempt.outcome === 'completed' || attempt.outcome === 'approved') return 'готово'
  if (attempt.outcome === 'failed') return attempt.reasonLabel ?? 'не получилось, причина не записана'
  if (attempt.reasonLabel) return attempt.reasonLabel
  return attempt.endedAt ? 'завершён' : 'идёт сейчас'
}

/**
 * Сколько подход длился — вторая половина двухслойной ошибки (разведка 11.08, Multica:
 * «Failed after 1m 20s»). Цена попытки говорится рядом с исходом, не вычисляется в уме.
 */
function durationWords(attempt: TaskAttempt): string | null {
  if (!attempt.startedAt || !attempt.endedAt) return null
  const ms = Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} с`
  const min = Math.floor(sec / 60)
  return `${min} мин ${sec % 60} с`
}

/** Один пункт манифеста, словами: путь плюс то немногое, что о нём стоит сказать. */
function entryWords(entry: MaterializedEntry): string {
  if (entry.mode === 'link') return entry.target ? `${entry.path} → ${entry.target}` : entry.path
  if (entry.mode === 'copy' && (entry.files ?? 0) > 0) return `${entry.path} (${entry.files})`
  if (entry.mode === 'skipped') return entry.reason ? `${entry.path} (${entry.reason})` : entry.path
  return entry.path
}

/**
 * ЧТО КОПИЯ ПОЛУЧИЛА — сгруппировано по судьбе пункта, а не перечислено подряд.
 *
 * Список манифеста в реальном проекте — это десяток строк, из которых человеку важна не
 * каждая, а разница: что принесли файлами, что подключили ссылкой (и значит зависимости
 * никто не ставил заново), что уже лежало в git, и что НЕ пустили. Пункт, которого в
 * проекте не нашлось (`absent`), не говорит ни о чём — про него строки нет.
 */
function materializedWords(list: MaterializedEntry[]): string[] {
  const say = (label: string, test: (e: MaterializedEntry) => boolean): string | null => {
    const hit = list.filter(test).map(entryWords)
    return hit.length > 0 ? `${label}: ${hit.join(', ')}` : null
  }
  return [
    say('скопировано', (e) => e.mode === 'copy' && (e.files ?? 0) > 0),
    say('уже в копии и не устарело', (e) => e.mode === 'copy' && (e.files ?? 0) === 0),
    say('подключено ссылкой', (e) => e.mode === 'link'),
    say('уже в git', (e) => e.mode === 'tracked'),
    say('пропущено', (e) => e.mode === 'skipped'),
  ].filter((line): line is string => line !== null)
}

/** Кто убрал копию. Незнакомое слово показывается как записано — не переводится наугад. */
function cleanupWho(by: string): string {
  if (by === 'approve') return 'приёмка'
  if (by === 'sweep') return 'суточный обход'
  return by
}

/**
 * ГДЕ РАБОТАЛИ И К ЧЕМУ ОТКАТЫВАТЬ — строки о копии этой попытки.
 *
 * Работник пишет только в свою копию на своей ветке, отведённой от известного коммита.
 * Пока это знание жило в строке попытки на диске, откат оставался словами: человеку нечего
 * было назвать команде. Здесь оно становится текстом на карточке — путь, ветка, база,
 * что копия получила и когда её убрали.
 *
 * ЗАКОН ЭТОГО ХЕЛПЕРА: ничего не выдумывать. Нет поля — нет строки; пустой массив — блока
 * на карточке не будет вовсе. Прочерк вместо данных врёт не меньше, чем выдуманное число,
 * и попытки, сделанные до того, как строка научилась нести эти поля, обязаны молчать.
 */
function copyLines(attempt: TaskAttempt): string[] {
  const lines: string[] = []
  if (attempt.worktreePath) lines.push(`копия: ${attempt.worktreePath}`)

  const where = [
    attempt.branch ? `ветка ${attempt.branch}` : null,
    attempt.base ? `база ${attempt.base.slice(0, 7)}` : null,
  ].filter(Boolean)
  if (where.length > 0) lines.push(where.join(' · '))

  const ms = attempt.provisionMs
  if (typeof ms === 'number' && Number.isFinite(ms)) {
    lines.push(ms >= 1000 ? `подготовлена за ${(ms / 1000).toFixed(1)} с` : `подготовлена за ${ms} мс`)
  }

  if (Array.isArray(attempt.materialized)) lines.push(...materializedWords(attempt.materialized))

  const cleanup = attempt.cleanup
  if (cleanup && cleanup.ok) {
    lines.push(`убрана ${clockLabel(cleanup.at)} (${cleanupWho(cleanup.by)})`)
    if (cleanup.branchTip) lines.push(`вершина ветки ${cleanup.branchTip.slice(0, 7)} — с неё работу ещё можно поднять`)
    if (cleanup.dirtyFiles && cleanup.dirtyFiles.length > 0) {
      lines.push(`потеряно при уборке: ${cleanup.dirtyFiles.join(', ')}`)
    }
  } else if (cleanup && !cleanup.ok) {
    lines.push(`уборка не удалась: ${cleanup.error ?? 'причина не записана'}`)
  } else if (attempt.worktreePath && attempt.endedAt) {
    lines.push('копия ещё на диске')
  }

  return lines
}

/** The colour of the mark beside a row — the same three tones the rest of the window uses. */
function dotTone(attempt: TaskAttempt): string {
  if (attempt.outcome === 'failed') return 'bg-err'
  if (attempt.outcome === 'returned') return 'bg-warn'
  if (attempt.outcome === 'completed' || attempt.outcome === 'approved') return 'bg-green'
  return 'bg-blue'
}

/**
 * WHAT THIS ATTEMPT PROVED. Two layers, in order of how much they say:
 *   1. the parsed checks, when a receipt carried them;
 *   2. the proof the tick really wrote — the gate that opened and its evidence.
 *
 * Until today only (1) was shown, and since nothing in the daemon produces those four
 * numbers it meant every real attempt read «квитанции нет» — a sentence that was false on a
 * task whose gate had opened on a re-verified branch. «Нет» is now said only when there is
 * genuinely nothing: no checks AND no reference.
 */
function Checks({ attempt }: { attempt: TaskAttempt }) {
  const checks = receiptChecks(attempt.receipt)
  const proof = receiptProofLabel(attempt.proof)
  if (checks.length === 0 && !proof) {
    return <p className="m-0 text-[12px] text-tx3">Квитанции нет — проверки не дошли до записи.</p>
  }
  return (
    <div className="flex flex-col gap-1.5">
      {proof ? <p className="m-0 text-[12px] text-tx2">{proof}</p> : null}
      {checks.map((c) => (
        <div key={c.text} className="flex justify-between gap-3.5 text-[12px]">
          <span className="text-tx2">{c.text}</span>
          <span className={c.ok ? 'flex-none text-ok-tx' : 'flex-none text-err-tx'}>{c.ok ? '✓' : '✗'}</span>
        </div>
      ))}
    </div>
  )
}

function Row({
  attempt,
  note,
  last,
  taskId,
}: {
  attempt: TaskAttempt
  /** The comment that sent this run back, when this run was sent back. */
  note: string | null
  last: boolean
  /** Whose story this is — the transcript door needs the task to name the attempt. */
  taskId: string | null
}) {
  /**
   * ЧТО В ИТОГЕ — РАСКРЫТО НА ТОМ ПОДХОДЕ, РАДИ КОТОРОГО КАРТОЧКУ И ОТКРЫЛИ.
   *
   * Everything this window knows about «кто что делал» — the tools, the files, the commands,
   * the skills, the connections, the handoffs to sub-agents — lives inside this fold, and the
   * fold used to start shut on every row. So the answer to the one question a task card is
   * opened with sat behind a control nobody had a reason to press, and was never seen at all.
   * The freshest run, and any run still going, now opens by itself; the older ones stay
   * folded, because six attempts unfolded at once is not a card.
   *
   * `null` means «никто не трогал»: the row follows the rule above and re-folds by itself
   * once a NEWER attempt takes its place. A click pins the row either way, and a pin is what
   * the person said — nothing later un-says it.
   */
  const openByDefault = last || !attempt.endedAt
  const [pinned, setPinned] = useState<boolean | null>(null)
  const open = pinned ?? openByDefault
  const who = [attempt.workerId, attempt.provider].filter(Boolean).join(' · ')
  const copy = copyLines(attempt)

  return (
    <div className="flex gap-3.5">
      <div className="w-[76px] flex-none pt-px text-right text-[11px] text-tx3 tabular-nums">
        {clockLabel(attempt.startedAt)}
      </div>
      <div className="relative flex w-4 flex-none justify-center">
        <div className={`absolute top-0 left-1/2 w-px bg-bd2 ${last ? 'h-3' : 'bottom-0'}`} />
        <div className={`relative z-10 mt-1 h-[7px] w-[7px] flex-none rounded-full ${dotTone(attempt)}`} />
      </div>
      <div className="min-w-0 flex-1 pb-6">
        <button
          type="button"
          onClick={() => setPinned(!open)}
          aria-expanded={open}
          className="flex items-baseline gap-2 text-left"
        >
          <span className="text-[12.5px] text-tx">
            Подход {attempt.attempt ?? '—'} · {outcomeWords(attempt)}
            {durationWords(attempt) ? (
              <span className="text-tx3 tabular-nums"> · {durationWords(attempt)}</span>
            ) : null}
          </span>
          <span aria-hidden className="text-[9px] text-tx3">
            {open ? '▾' : '▸'}
          </span>
        </button>

        {who ? <div className="mt-1 text-[11px] text-tx3">{who}</div> : null}

        {open ? (
          <div className="mt-2.5 max-w-[440px] rounded-[9px] border border-bd bg-surf px-3.5 py-3">
            <div className="mb-2 flex justify-between gap-3.5 text-[11px] text-tx3 tabular-nums">
              <span>начат {clockLabel(attempt.startedAt)}</span>
              <span>завершён {clockLabel(attempt.endedAt)}</span>
            </div>
            {/* КОПИЯ: где работали и к чему откатывать. Строки приходят из строки попытки —
                той же, что писал тик; пустой список означает «попытка этого не знает», и
                тогда блока нет вовсе. Всё здесь — текстовые узлы: путь и имя ветки приходят
                из данных и в разметку не превращаются. */}
            {copy.length > 0 ? (
              <div className="mb-2 flex flex-col gap-0.5 text-[11px] leading-[1.45] text-tx3">
                {copy.map((line) => (
                  <span key={line} className="break-words">
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
            {/* Сырой слой двухслойной ошибки: человеческая строка уже в заголовке ряда
                (reasonLabel), здесь — код причины как он записан, для баг-репорта. */}
            {attempt.outcome === 'failed' && attempt.failureReason ? (
              <p className="m-0 mb-2 rounded-[7px] bg-err-s px-2.5 py-1.5 font-mono text-[11px] text-err-tx">
                {attempt.failureReason}
              </p>
            ) : null}
            <Checks attempt={attempt} />
            {/* Свёртка раскрылась — вот и повесть подхода: приказ, ход, результат на одной
                странице (разведка 11.08, Paperclip). Тот же читатель, что «Живой поток». */}
            {taskId ? (
              <div className="mt-3 border-t border-bd pt-3">
                <AttemptLog taskId={taskId} attempt={attempt} />
              </div>
            ) : null}
          </div>
        ) : null}

        {note ? (
          <div className="mt-2.5 max-w-[440px] rounded-[10px] border border-bd bg-surf px-3.5 py-2.5">
            <div className="mb-1 text-[10.5px] text-tx3">Вы вернули с комментарием</div>
            <div className="text-[12.5px] leading-[1.5] text-tx">{note}</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AttemptTimeline({
  attempts,
  returnedNotes,
  taskId = null,
}: {
  attempts: TaskAttempt[]
  returnedNotes: string[]
  /** Present when the timeline lives on a task card — unlocks the per-attempt transcript. */
  taskId?: string | null
}) {
  if (attempts.length === 0) {
    return <p className="m-0 text-[12.5px] text-tx3">Работа ещё не начиналась — задача ждёт своей очереди.</p>
  }

  // The n-th comment belongs to the n-th run that was sent back — the order the read model
  // built them in. A run that is not a return takes no comment.
  let returned = 0

  return (
    <div className="flex flex-col">
      {attempts.map((a, i) => {
        const note = a.outcome === 'returned' ? (returnedNotes[returned++] ?? null) : null
        return (
          <Row
            key={`${a.attempt ?? i}-${a.startedAt ?? i}`}
            attempt={a}
            note={note}
            last={i === attempts.length - 1}
            taskId={taskId}
          />
        )
      })}
    </div>
  )
}
