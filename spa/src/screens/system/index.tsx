import { useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, isNotReady } from '../../api/client'
import { useDiagnosticsQuery, usePipelineToggle, useStateQuery, useUpdateRun } from '../../api/queries'
import type { Diagnostics, UpdateReport } from '../../api/types'

/**
 * «Дом системы» — what this install is, whether there is a newer one, the switch that decides
 * whether the machine works at all, and the window through which a person reports a fault.
 *
 * ══════════════════ NOTHING ON THIS SCREEN HAPPENS WITHOUT A SECOND WORD ══════════════════
 *
 * Two of the four blocks change the world, and both of them are the kind of change a person
 * should never make by brushing past a control: an update rewrites the install, and the
 * conveyor switch decides whether workers start on their own tonight. So each one is two
 * acts — press, then say yes in a dialog that states what is about to happen. Asking for the
 * version report is NOT one of them: it writes nothing, and a confirmation in front of a
 * question teaches a person to click through confirmations.
 *
 * ═══════════ THE FEEDBACK WINDOW: THE READER IS THE OPEN INTERNET ═══════════
 *
 * The channel is a public issue on GitHub. That single fact decides every rule of the last
 * block:
 *
 *   · The daemon does not go to the network. Nothing here is sent — a draft is OPENED in the
 *     browser and the person presses «Submit» themselves, or closes the tab.
 *   · The body is composed HERE, from the two fields a person typed and the four facts the
 *     diagnostics door returns. Nothing else may be added to it: not the project's name, not
 *     the screen we are on, not a task title. The window knows plenty that has no business
 *     travelling to a public issue.
 *   · The whole body is shown before the draft opens, with the diagnostics block marked as
 *     something the person may edit or delete. A block a person cannot see is a block a
 *     person cannot refuse.
 *   · The body is capped. A URL too long comes back as 414 with no warning, GitHub does not
 *     publish the limit, and a person watching a draft fail to open learns nothing from it.
 */

/**
 * Where a fault is reported. Taken verbatim from `bugs.url` of the product's own package —
 * this is the single place the window writes it down, and it is written as a constant rather
 * than assembled from a repository name so that moving the repository is one edit.
 */
const BUGS_URL = 'https://github.com/sma-framework/sma/issues'

/**
 * The hard cap on the issue body, in characters.
 *
 * A prefilled draft rides in the query string, and a query string that is too long is refused
 * by GitHub with 414 URI Too Long — silently, from the browser's point of view. The exact
 * limit is not documented, so the cap is deliberately well under any plausible one and the
 * degradation is honest: what did not fit is still on the screen, to be copied by hand.
 */
const MAX_BODY = 4000

/** The label the draft carries, so reports of this kind can be found later. */
const FEEDBACK_LABEL = 'feedback'

/** The daemon's own words for a refusal, behind a lead that says whose words they are. */
function doorWords(err: unknown, fallback: string): string {
  if (isNotReady(err)) return 'Эта дверь пока не отвечает. Ничего не запускалось и ничего не изменено.'
  if (err instanceof ApiError && err.detail) return `Отказано: ${err.detail}`
  return fallback
}

function CardHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2.5 border-b border-bd px-[18px] py-[13px]">
      <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{title}</span>
      {note ? <span className="text-[11px] text-tx3">{note}</span> : null}
    </div>
  )
}

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
      <CardHead title={title} note={note} />
      {children}
    </div>
  )
}

/**
 * The question in front of an act that changes the machine.
 *
 * It says what is about to happen in the words of the thing itself, not «Вы уверены?» — a
 * dialog that carries no new information is a keystroke, and a person learns to spend it
 * without reading.
 */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  problem,
  onConfirm,
  onClose,
}: {
  title: string
  body: ReactNode
  confirmLabel: string
  pending: boolean
  problem: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex w-[460px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
      >
        <div className="text-[13.5px] font-semibold text-tx">{title}</div>
        <div className="text-[12px] leading-[1.6] text-tx2">{body}</div>

        {problem ? <p className="m-0 text-[11.5px] leading-[1.5] text-err-tx">{problem}</p> : null}

        <div className="flex justify-end gap-2 border-t border-bd pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
          >
            {pending ? 'Минуту…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The four facts, as a person reads them — and the same four the feedback block quotes. */
function VersionCard({ diagnostics }: { diagnostics: Diagnostics | null }) {
  return (
    <Card title="Версия">
      {diagnostics ? (
        <dl className="m-0 grid grid-cols-[130px_1fr] gap-x-4 gap-y-2 px-[18px] py-[15px] text-[12.5px]">
          <dt className="text-tx3">SMA</dt>
          <dd className="m-0 font-mono text-tx">{diagnostics.version ?? 'не прочиталась'}</dd>
          <dt className="text-tx3">Операционная система</dt>
          <dd className="m-0 font-mono text-tx">
            {diagnostics.platform} {diagnostics.release}
          </dd>
          <dt className="text-tx3">Node</dt>
          <dd className="m-0 font-mono text-tx">{diagnostics.node}</dd>
        </dl>
      ) : (
        <p className="m-0 px-[18px] py-[15px] text-[12.5px] text-tx2">
          Демон пока не назвал версию. Это те же четыре факта, которые уезжают в сообщение об
          ошибке, — без них окно обратной связи откроется, но диагностику в черновик не положит.
        </p>
      )}
      <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11.5px] leading-[1.6] text-tx3">
        Версия берётся из пакета, который несёт демона, — не из проекта, который он обслуживает.
      </p>
    </Card>
  )
}

/** How the updater's own verdict about one source reads to a person. */
const VERDICT_WORD: Record<string, string> = {
  'update-available': 'есть новее',
  'up-to-date': 'у Вас свежая',
  'installed-newer': 'у Вас новее',
  unreachable: 'не отвечает',
  'unknown-installed': 'своя версия не прочиталась',
}

/**
 * «Обновление» — a report by default, and the installer only on an explicit word.
 *
 * The check writes nothing, so it asks nothing. The apply asks, and the dialog says what the
 * update will and will not touch, because that is the fact a person actually weighs.
 */
function UpdateCard() {
  const run = useUpdateRun()
  const [report, setReport] = useState<UpdateReport | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [applyProblem, setApplyProblem] = useState<string | null>(null)

  /** Only an «update-available» from a source we could reach is an offer. Newer is never a downgrade offer. */
  const offer = (report?.sources ?? []).find((s) => s.verdict === 'update-available') ?? null
  const applied = report && report.dryRun === false ? report : null

  const check = () => {
    setProblem(null)
    setReport(null)
    run.mutate(
      { confirm: false },
      {
        onSuccess: (result) => setReport(result),
        onError: (err) => setProblem(doorWords(err, 'Проверить не удалось. Ничего не изменено.')),
      },
    )
  }

  const apply = () => {
    setApplyProblem(null)
    run.mutate(
      { confirm: true },
      {
        onSuccess: (result) => {
          setReport(result)
          setAsking(false)
        },
        onError: (err) => setApplyProblem(doorWords(err, 'Обновить не удалось. Установка осталась прежней.')),
      },
    )
  }

  return (
    <Card title="Обновление">
      <div className="flex items-center justify-between gap-4 px-[18px] py-[15px]">
        <span className="text-[12px] leading-[1.55] text-tx2">
          Проверка только сравнивает версии и ничего не пишет. Само по себе обновление не
          начинается никогда: ни по расписанию, ни при запуске.
        </span>
        <button
          type="button"
          onClick={check}
          disabled={run.isPending}
          className="flex-none rounded-[9px] border border-bd2 px-4 py-2 text-[12px] font-semibold text-tx hover:border-blue hover:text-blue disabled:opacity-60"
        >
          {run.isPending ? 'Смотрю…' : 'Проверить'}
        </button>
      </div>

      {problem ? (
        <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11.5px] leading-[1.5] text-err-tx">{problem}</p>
      ) : null}

      {report ? (
        <>
          <div className="border-t border-bd px-[18px] py-2.5 text-[12.5px] text-tx">
            Установлена: <span className="font-mono">{report.installed ?? 'не прочиталась'}</span>
          </div>
          {report.sources.map((s) => (
            <div key={s.id} className="flex items-baseline gap-2.5 border-t border-bd px-[18px] py-2.5">
              <span className="flex-none text-[12px] text-tx2">{s.id === 'npm' ? 'В реестре' : 'Рядом на диске'}</span>
              <span className="flex-none font-mono text-[12px] text-tx">{s.version ?? '—'}</span>
              <span className="flex-1" />
              <span
                className={`flex-none text-[11.5px] ${
                  s.verdict === 'update-available' ? 'text-blue' : 'text-tx3'
                }`}
              >
                {VERDICT_WORD[s.verdict] ?? s.verdict}
              </span>
            </div>
          ))}
        </>
      ) : null}

      {applied ? (
        <div className="border-t border-bd px-[18px] py-2.5">
          {applied.ok ? (
            <>
              <p className="m-0 text-[12.5px] text-ok-tx">Обновление применено.</p>
              {applied.receipt ? (
                <p className="m-0 font-mono text-[11px] break-all text-ok-tx">{applied.receipt}</p>
              ) : null}
            </>
          ) : (
            <p className="m-0 text-[12.5px] text-err-tx">
              Установщик отработал, но зелёного результата не дал
              {applied.applied && applied.applied.exitCode !== null
                ? ` (код выхода ${applied.applied.exitCode})`
                : ''}
              . Установка могла остаться прежней — проверьте версию заново.
            </p>
          )}
        </div>
      ) : null}

      {offer && !applied ? (
        <div className="flex items-center justify-between gap-4 border-t border-bd px-[18px] py-[15px]">
          <span className="text-[12px] leading-[1.55] text-tx2">
            Доступна версия <span className="font-mono text-tx">{offer.version}</span>. Обновление
            запустит обычный установщик — тот же, что ставил SMA.
          </span>
          <button
            type="button"
            onClick={() => {
              setApplyProblem(null)
              setAsking(true)
            }}
            className="flex-none rounded-[9px] bg-blue px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-d"
          >
            Обновить
          </button>
        </div>
      ) : null}

      {asking && offer ? (
        <ConfirmDialog
          title="Обновить установку"
          body={
            <>
              <p className="m-0 mb-2">
                Сейчас запустится обычный установщик и поставит{' '}
                <span className="font-mono text-tx">{offer.version}</span> поверх{' '}
                <span className="font-mono text-tx">{report?.installed ?? 'текущей'}</span>.
              </p>
              <p className="m-0">
                Он не трогает Вашу память, состояние и человеческие строки в файлах проекта —
                это его собственные гарантии, а не новые. Работающего демона обновление не
                перезапускает: новый код он подхватит при следующем запуске.
              </p>
            </>
          }
          confirmLabel="Обновить"
          pending={run.isPending}
          problem={applyProblem}
          onConfirm={apply}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </Card>
  )
}

/**
 * «Конвейер» — the switch the whole machine is gated on.
 *
 * Off is the state this product ships in, and off has to LOOK like off: a stopped machine
 * rendered as a running one is the worst lie this window could tell, because the person would
 * be waiting all night for work that nobody was going to start.
 *
 * A daemon built before the switch existed does not report it at all. That is NOT off and it
 * is NOT on — it is an older process, and the screen says exactly that instead of choosing a
 * state on its behalf.
 */
function PipelineCard({ enabled }: { enabled: boolean | undefined }) {
  const toggle = usePipelineToggle()
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  /** With the state unknown the offer is «включить»: it is the act that starts anything at all. */
  const turningOn = enabled !== true

  const flip = () => {
    setProblem(null)
    toggle.mutate(
      { enabled: turningOn },
      {
        onSuccess: () => setAsking(false),
        onError: (err) =>
          setProblem(
            doorWords(
              err,
              turningOn
                ? 'Включить не удалось. Конвейер остался выключенным.'
                : 'Выключить не удалось. Конвейер остался включённым.',
            ),
          ),
      },
    )
  }

  return (
    <Card title="Конвейер">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-[18px] py-[15px]">
        <div className="min-w-[260px] flex-1">
          <div className="text-[15px] font-semibold text-tx">
            {enabled === undefined
              ? 'Состояние неизвестно'
              : enabled
                ? 'Конвейер включён'
                : 'Конвейер выключен'}
          </div>
          <div className="mt-1 max-w-[620px] text-[12px] leading-[1.6] text-tx2">
            {enabled === undefined
              ? 'Работающий демон не сообщает состояние конвейера — значит он собран до появления этого тумблера. Перезапустите демона, и строка станет честной. Гадать здесь нельзя: «не сообщает» — это не «работает».'
              : enabled
                ? 'Работники берут задачи по расписанию. Выключение остановит машину целиком: ни разбора, ни новых задач, ни отчётов.'
                : 'Конвейер выключен; включение запустит работников по расписанию — они начнут брать задачи и тратить окна сами, без Вашего участия.'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setProblem(null)
            setAsking(true)
          }}
          disabled={toggle.isPending}
          className={`h-[42px] flex-none rounded-[10px] px-6 text-[14px] font-semibold whitespace-nowrap disabled:opacity-60 ${
            turningOn ? 'bg-blue-d text-white hover:bg-blue' : 'border border-bd2 bg-card text-tx hover:bg-row-hover'
          }`}
        >
          {turningOn ? 'Включить конвейер' : 'Выключить конвейер'}
        </button>
      </div>

      {problem ? (
        <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11.5px] leading-[1.5] text-err-tx">{problem}</p>
      ) : null}

      {asking ? (
        <ConfirmDialog
          title={turningOn ? 'Включить конвейер' : 'Выключить конвейер'}
          body={
            turningOn ? (
              <p className="m-0">
                После включения работники начнут брать задачи по расписанию — сами, в том числе
                ночью, и тратя окна подписок. Выключить можно этой же кнопкой.
              </p>
            ) : (
              <p className="m-0">
                Машина остановится целиком: новые задачи браться не будут, отчёты приходить
                перестанут. Задача, застрявшая в полёте, вернётся в очередь на первом тике после
                включения.
              </p>
            )
          }
          confirmLabel={turningOn ? 'Включить' : 'Выключить'}
          pending={toggle.isPending}
          problem={problem}
          onConfirm={flip}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </Card>
  )
}

/**
 * The body of the draft, assembled from the two fields and the four facts — and from NOTHING
 * else. The list of what may appear here is this function; a fact that is not named in it
 * cannot travel to a public issue by accident.
 */
function composeBody(happened: string, expected: string, diagnostics: Diagnostics | null): string {
  const lines = ['## Что произошло', '', happened.trim(), '', '## Что ожидалось', '', expected.trim(), '']
  if (diagnostics) {
    lines.push(
      '---',
      '<!-- диагностика собрана автоматически, вы можете её отредактировать или удалить -->',
      `SMA: ${diagnostics.version ?? 'не прочиталась'}`,
      `ОС: ${diagnostics.platform} ${diagnostics.release}`,
      `Node: ${diagnostics.node}`,
    )
  }
  return lines.join('\n')
}

/** The first line of what happened, as the draft's heading. */
function composeTitle(happened: string): string {
  const first = happened.trim().split('\n')[0]?.trim() ?? ''
  if (first === '') return 'Обратная связь'
  return first.slice(0, 120)
}

function FeedbackCard({ diagnostics }: { diagnostics: Diagnostics | null }) {
  const [happened, setHappened] = useState('')
  const [expected, setExpected] = useState('')
  const [copied, setCopied] = useState(false)

  const title = composeTitle(happened)
  const full = composeBody(happened, expected, diagnostics)
  // The hard cap, applied to the finished body — the last line of defence against a draft
  // that fails to open with nothing on the screen to explain why.
  const body = full.slice(0, MAX_BODY)
  const truncated = body.length < full.length
  const ready = happened.trim() !== ''

  const url = `${BUGS_URL}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(
    body,
  )}&labels=${encodeURIComponent(FEEDBACK_LABEL)}`

  const openDraft = () => {
    if (!ready) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const copy = () => {
    void navigator.clipboard?.writeText(full).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  return (
    <Card title="Обратная связь" note="черновик открывается на GitHub — отправляете Вы">
      <div className="flex flex-col gap-3.5 px-[18px] py-[15px]">
        <p className="m-0 text-[12px] leading-[1.6] text-tx2">
          Демон в сеть не ходит и ничего не отправляет. Кнопка открывает в браузере ЧЕРНОВИК
          сообщения в публичном списке проблем — там его можно дописать, исправить или закрыть
          вкладку. Всё, что уедет, видно ниже целиком.
        </p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="fb-happened" className="text-[11.5px] text-tx2">
            Что произошло
          </label>
          <textarea
            id="fb-happened"
            value={happened}
            onChange={(e) => setHappened(e.target.value)}
            rows={3}
            placeholder="Нажал «Включить», ничего не изменилось…"
            className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2 text-[12.5px] text-tx outline-none focus:border-blue"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="fb-expected" className="text-[11.5px] text-tx2">
            Что ожидалось
          </label>
          <textarea
            id="fb-expected"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            rows={3}
            placeholder="Ожидал, что работник включится и появится в списке…"
            className="w-full resize-y rounded-[9px] border border-bd bg-input px-[11px] py-2 text-[12.5px] text-tx outline-none focus:border-blue"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[11.5px] text-tx2">Что уедет в черновик</span>
            <span className="text-[11px] text-tx3 tabular-nums">{full.length} символов</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={copy}
              className="text-[11.5px] text-blue hover:text-teal"
            >
              {copied ? 'скопировано' : 'скопировать'}
            </button>
          </div>
          <div className="rounded-[9px] border border-bd bg-surf px-3 py-2.5">
            <div className="mb-1.5 text-[11px] text-tx3">
              Заголовок: <span className="font-mono text-tx2">{title}</span>
            </div>
            <pre className="m-0 max-h-[260px] overflow-auto font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap text-tx2">
              {full}
            </pre>
          </div>
          {truncated ? (
            <p className="m-0 text-[11.5px] leading-[1.55] text-warn-tx">
              Текст длиннее {MAX_BODY} символов — в черновик уедет только начало, конец вместе с
              диагностикой не влезет. Скопируйте полный текст кнопкой выше и вставьте руками.
            </p>
          ) : null}
          {diagnostics ? null : (
            <p className="m-0 text-[11.5px] leading-[1.55] text-tx3">
              Демон не назвал версию, поэтому блока диагностики в черновике нет. Допишите руками,
              что у Вас за версия и система, — без этого разобраться будет труднее.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-tx3">
            {ready ? 'Черновик откроется в новой вкладке' : 'Напишите хотя бы, что произошло'}
          </span>
          <button
            type="button"
            onClick={openDraft}
            disabled={!ready}
            className="flex-none rounded-[9px] bg-blue px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
          >
            Открыть черновик на GitHub
          </button>
        </div>
      </div>
    </Card>
  )
}

export function Screen() {
  const state = useStateQuery()
  const diagnostics = useDiagnosticsQuery()

  const diag = diagnostics.data ?? null
  const pipeline = state.data?.rules.pipeline?.enabled

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Дом системы</h1>
        {diag?.version ? (
          <span className="flex-none rounded-[9px] border border-bd bg-card px-3 py-1.5 font-mono text-[11.5px] text-tx2 shadow-panel">
            {diag.version}
          </span>
        ) : null}
        <span className="flex-1" />
        {pipeline === undefined ? null : (
          <span
            className={`flex-none rounded-[9px] px-3 py-1.5 text-[11.5px] ${
              pipeline ? 'bg-ok-s text-ok-tx' : 'bg-idle-s text-idle-tx'
            }`}
          >
            {pipeline ? 'конвейер включён' : 'конвейер выключен'}
          </span>
        )}
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">
          Что у Вас установлено, есть ли новее, работает ли машина — и как рассказать о поломке.
        </span>
      </div>

      {diagnostics.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            {isNotReady(diagnostics.error)
              ? 'Дверь диагностики пока не отвечает — версия и блок для сообщения о поломке появятся, когда она заработает.'
              : 'Версию прочитать не удалось. Обратная связь работает и без неё.'}
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[820px] flex-col gap-[22px]">
          <VersionCard diagnostics={diag} />
          <UpdateCard />
          <PipelineCard enabled={pipeline} />
          <FeedbackCard diagnostics={diag} />

          <p className="m-0 max-w-[720px] text-[11.5px] leading-[1.6] text-tx3">
            Сообщение о поломке уходит в публичный список проблем, и читать его будет кто угодно.
            Поэтому в него кладутся ровно четыре факта об установке — версия, система, её выпуск и
            Node — и ни строчки из Вашей памяти, очереди или путей на диске.
          </p>
        </div>
      </div>
    </section>
  )
}
