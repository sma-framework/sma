import { useEffect, useState } from 'react'
import { ApiError, isNotReady } from '../../api/client'
import { onFrame } from '../../api/hints'
import { useDiagnosticsQuery, useShipGate, useShipPublish } from '../../api/queries'
import type { ShipGateReport, ShipPublishResult } from '../../api/types'

/**
 * «Выкат» — the gate as a button, and the one act behind it that a machine may prepare but
 * only a person may perform.
 *
 * ═══════════════════ WHAT «ОПУБЛИКОВАТЬ» IS IN THIS PRODUCT ═══════════════════════
 *
 * It is not a push, and this screen says so in as many words rather than letting a person
 * assume otherwise. Nothing in this product pushes: what it has is a gate in front of a push,
 * which lets one through only once the full run has left its evidence for the current state of
 * the tree. So publishing here is «put the run on the record and write that evidence» — the
 * machine does every part it can be trusted with AND GRANTS THE PERMISSION; the person then
 * performs the act. A button in a browser that pushed would be this product disagreeing with
 * its own law in the one place the law was written for.
 *
 * ═══════════════════ TWO LOCKS, AND THE SECOND ONE IS A PERSON ════════════════════
 *
 * The publication door asks for the receipt of a gate run THIS daemon watched go green, and
 * for the version string typed out in full. This screen never fills that field in. Showing the
 * version beside it and letting a person copy it with their eyes is the entire point: a
 * prefilled field would turn the second lock into a formality, and the door's whole reason to
 * exist is that the second lock cannot be satisfied by merely ARRIVING at it.
 *
 * A receipt exists only for a green run, so when there is none the publication block is not a
 * disabled button — there is nothing to press, and the screen says what is missing instead.
 *
 * ═══════════════════ THE PROGRESS IS BELLS, THE VERDICT IS THE ANSWER ═════════════
 *
 * The door holds the request while the gate runs and rings a bell after each step, carrying
 * the run and the step's NAME — never what the step printed. So the steps appear as they
 * finish, and the verdicts arrive together at the end, in the answer. A spinner would have
 * been the same picture with less in it.
 */

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

/** A step that has reported, while the run is still going. The bell carries no verdict. */
function StepPending({ step }: { step: string }) {
  return (
    <div className="flex items-baseline gap-2.5 border-t border-bd px-[18px] py-2.5">
      <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-blue" />
      <span className="flex-1 text-[12.5px] text-tx">{step}</span>
      <span className="flex-none text-[11px] text-tx3">отчитался</span>
    </div>
  )
}

/** A step as the report describes it: the verdict, and the sentence behind the verdict. */
function StepCheck({ step, ok, detail }: { step: string; ok: boolean; detail: string | null }) {
  return (
    <div className="flex flex-col gap-1 border-t border-bd px-[18px] py-2.5">
      <div className="flex items-baseline gap-2.5">
        <span className={`flex-none text-[12px] ${ok ? 'text-ok-tx' : 'text-err-tx'}`}>{ok ? '✓' : '✕'}</span>
        <span className="flex-1 text-[12.5px] text-tx">{step}</span>
      </div>
      {detail ? <span className="pl-[22px] text-[11.5px] leading-[1.5] text-tx2">{detail}</span> : null}
    </div>
  )
}

/**
 * The question in front of publishing.
 *
 * Two things are asked for, and neither is a checkbox pretending to be a decision: the version
 * typed out by hand, and an acknowledgement of what the act actually does. The field is empty
 * when the dialog opens and stays empty until somebody types — nothing here fills it in.
 */
function PublishDialog({
  receipt,
  version,
  onClose,
}: {
  receipt: string
  version: string | null
  onClose: () => void
}) {
  const publish = useShipPublish()
  const [typed, setTyped] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<ShipPublishResult | null>(null)

  const written = typed.trim()
  const ready = written.length > 0 && understood

  const submit = () => {
    if (!ready) return
    setProblem(null)
    publish.mutate(
      { gateReceipt: receipt, confirm: written },
      {
        onSuccess: (result) => setDone(result),
        onError: (err) => setProblem(doorWords(err, 'Опубликовать не удалось. Ничего не выпущено.')),
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Публикация выпуска"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex w-[470px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
      >
        <div className="text-[13.5px] font-semibold text-tx">Публикация выпуска</div>

        {done ? (
          <>
            <p className="m-0 text-[12.5px] leading-[1.6] text-tx">
              Готово. Прогон {done.version} поставлен на учёт, и отметка полных ворот записана —
              это и есть разрешение на выкат.
            </p>
            <p className="m-0 text-[12px] leading-[1.6] text-tx2">
              Сам пуш в публичный мир остаётся за Вами: ни один верб этого продукта не пушит.
            </p>
            <p className="m-0 font-mono text-[11px] break-all text-ok-tx">{done.receipt}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
              >
                Закрыть
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-[12px] leading-[1.6] text-tx2">
              Это самое дорогое действие в продукте. Оно ставит прогон на учёт и пишет отметку
              полных ворот для текущего состояния дерева — после неё пуш разрешён. Пуш делаете
              Вы, руками.
            </p>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="ship-version" className="text-[11.5px] text-tx2">
                Наберите версию целиком
                {version ? (
                  <>
                    {' — '}
                    <span className="font-mono text-tx">{version}</span>
                  </>
                ) : (
                  ' (машина сейчас не называет версию — публикация будет отклонена)'
                )}
              </label>
              {/*
                No defaultValue, no value pushed in from the reading above: the field starts
                empty and is filled by a person. That IS the second lock.
              */}
              <input
                id="ship-version"
                value={typed}
                autoFocus
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Версия"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-[9px] border border-bd bg-input px-[11px] py-2 font-mono text-[12.5px] text-tx outline-none focus:border-blue"
              />
            </div>

            <label className="flex items-start gap-2.5 text-[12px] leading-[1.5] text-tx2">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                className="mt-[3px] flex-none"
              />
              <span>Понимаю: это разрешение на выкат в публичный мир, и дальше пуш делаю руками.</span>
            </label>

            {problem ? <p className="m-0 text-[11.5px] leading-[1.5] text-err-tx">{problem}</p> : null}

            <div className="flex items-center justify-between gap-3 border-t border-bd pt-3">
              <span className="text-[11px] text-tx3">
                {ready ? 'Версию сверит демон' : 'Нужны точная версия и согласие'}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!ready || publish.isPending}
                  className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
                >
                  {publish.isPending ? 'Публикую…' : 'Опубликовать'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function Screen() {
  const gate = useShipGate()
  const diagnostics = useDiagnosticsQuery()

  const [steps, setSteps] = useState<string[]>([])
  const [report, setReport] = useState<ShipGateReport | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)

  // The bells only mean anything while a run is in flight; outside one there is nothing to
  // draw, so nothing is listened to. The channel is the live layer's own.
  useEffect(() => {
    if (!gate.isPending) return
    return onFrame((evt) => {
      if (evt.event !== 'ship.gate') return
      const step = evt.step
      if (!step) return
      setSteps((was) => (was.includes(step) ? was : [...was, step]))
    })
  }, [gate.isPending])

  const runGate = () => {
    setSteps([])
    setReport(null)
    setProblem(null)
    gate.mutate(undefined, {
      onSuccess: (result) => setReport(result),
      onError: (err) => setProblem(doorWords(err, 'Ворота не прогнались. Ничего не выпущено.')),
    })
  }

  const green = report?.ok === true
  const receipt = green ? (report?.receipt ?? null) : null
  const version = diagnostics.data?.version ?? null

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-tx">Выкат</h1>
        <span className="flex-1" />
        {report ? (
          <span
            className={`flex-none rounded-[9px] px-3 py-1.5 text-[11.5px] ${
              green ? 'bg-ok-s text-ok-tx' : 'bg-err-s text-err-tx'
            }`}
          >
            {green ? 'ворота зелёные' : 'ворота красные'}
          </span>
        ) : null}
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">
          Ворота проверяют то, что можно проверить машинно, и выдают разрешение. Выпуск в
          публичный мир делает человек.
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[820px] flex-col gap-[22px]">
          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <CardHead title="Ворота" note={report ? `прогон ${report.taskId}` : undefined} />

            <div className="flex items-center justify-between gap-4 px-[18px] py-[15px]">
              <span className="text-[12px] leading-[1.55] text-tx2">
                Прогон занимает до нескольких минут: шаги отчитываются по одному, вердикты
                приходят вместе с ответом.
              </span>
              <button
                type="button"
                onClick={runGate}
                disabled={gate.isPending}
                className="flex-none rounded-[9px] bg-blue px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
              >
                {gate.isPending ? 'Иду по шагам…' : 'Прогнать ворота'}
              </button>
            </div>

            {problem ? (
              <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11.5px] leading-[1.5] text-err-tx">
                {problem}
              </p>
            ) : null}

            {gate.isPending
              ? steps.map((step) => <StepPending key={step} step={step} />)
              : (report?.checks ?? []).map((check) => (
                  <StepCheck key={check.step} step={check.step} ok={check.ok} detail={check.detail} />
                ))}

            {gate.isPending && steps.length === 0 ? (
              <p className="m-0 border-t border-bd px-[18px] py-2.5 text-[11.5px] text-tx3">
                Первый шаг ещё идёт.
              </p>
            ) : null}

            {receipt ? (
              <div className="border-t border-bd px-[18px] py-2.5">
                <span className="text-[11px] text-tx3">квитанция прогона</span>
                <p className="m-0 font-mono text-[11px] break-all text-ok-tx">{receipt}</p>
              </div>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
            <CardHead title="Публикация" />

            {receipt ? (
              <div className="flex flex-col gap-3 px-[18px] py-[15px]">
                <p className="m-0 text-[12px] leading-[1.6] text-tx2">
                  Ворота зелёные. Публикация поставит прогон на учёт и запишет отметку полных
                  ворот — разрешение на выкат. Спросит версию целиком.
                </p>
                <button
                  type="button"
                  onClick={() => setPublishing(true)}
                  className="self-start rounded-[9px] border border-bd2 px-4 py-2 text-[12px] font-semibold text-tx hover:border-blue hover:text-blue"
                >
                  Опубликовать выпуск
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 px-[18px] py-[15px]">
                <p className="m-0 text-[12.5px] leading-[1.6] text-tx2">
                  {report
                    ? 'Прогон был красным. Квитанции у него нет — публиковать нечем: сначала закройте то, на чём ворота встали, и прогоните заново.'
                    : 'Ворота ещё не прогонялись. Публикация открывается только после зелёного прогона, и не кнопкой, которую нельзя нажать, — её просто нечем нажать.'}
                </p>
                <p className="m-0 text-[11.5px] leading-[1.6] text-tx3">
                  Квитанция живёт в работающем демоне: после его перезапуска ворота нужно
                  прогнать заново. Это не рассинхрон — квитанция говорит о дереве в тот момент,
                  когда за ним кто-то смотрел.
                </p>
              </div>
            )}
          </div>

          <p className="m-0 max-w-[720px] text-[11.5px] leading-[1.6] text-tx3">
            Сьют проекта в ворота не входит и не может: дверь, принимающая команду, —
            единственное, чего этот фронт обещает никогда не отрастить. Тесты гоняете Вы или
            сборка; ворота докладывают по машинно-читаемым свидетельствам.
          </p>
        </div>
      </div>

      {publishing && receipt ? (
        <PublishDialog receipt={receipt} version={version} onClose={() => setPublishing(false)} />
      ) : null}
    </section>
  )
}
