import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import { usePairMachine } from '../../api/queries'
import type { MachineRow as Machine, PairingInvitation } from '../../api/types'

/**
 * AddMachineWizard — «Подключить машину»: three steps, and not one of them acts.
 *
 * ═════════════════════ THE WIZARD PREPARES, IT DOES NOT EXECUTE ═════════════════════
 *
 * Introducing two machines is the founder's own deliberate act, and it stays that way. All
 * this window does is mint ONE invitation and show the words that go with it; the daemon
 * opens no socket to the other machine and configures no network, and this component makes
 * exactly one request in its whole life — the mint. The joining is done by a person, on the
 * other machine, with their hands.
 *
 * That is why step three has nothing to poll and nothing to press: it simply WATCHES the
 * household list the window is already reading, and says «на связи» when a machine that
 * was not there before appears in it.
 *
 * ═════════════════════════ THE INVITATION IS SHOWN ON PURPOSE ═════════════════════════
 *
 * A pairing code is a secret being handed to a person deliberately — showing it is the
 * whole point of the step. It works exactly once and expires on its own, which is what
 * keeps the window it is visible in a small one. The instruction beside it is the daemon's
 * own text, rendered verbatim and never rewritten here: everything secret in it is a
 * placeholder, and a wizard that edited it would be a wizard a person cannot trust.
 */

const STEPS = ['Имя', 'Код', 'Проверка'] as const

/** The invitation's own clock, counted down where a person can see it. */
function ttlLabel(sec: number): string {
  if (sec <= 0) return 'срок истёк'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function StepBar({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10.5px] font-semibold ${
              i <= step ? 'bg-blue-s text-blue' : 'bg-idle-s text-idle-tx'
            }`}
          >
            {i + 1}
          </span>
          <span className={`text-[12px] ${i === step ? 'font-semibold text-tx' : 'text-tx3'}`}>{label}</span>
          {i < STEPS.length - 1 ? (
            <span aria-hidden className="mx-1 h-px w-5 bg-bd" />
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function AddMachineWizard({
  machines,
  onClose,
}: {
  /** The household as the window is already reading it — the wizard asks nothing of its own. */
  machines: Machine[]
  onClose: () => void
}) {
  const pair = usePairMachine()

  const [step, setStep] = useState(0)
  const [title, setTitle] = useState('')
  const [invitation, setInvitation] = useState<PairingInvitation | null>(null)
  const [left, setLeft] = useState(0)
  const [copied, setCopied] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  /** Who was in the household when the wizard opened — anyone new is the machine we await. */
  const knownIds = useRef<Set<string>>(new Set(machines.map((m) => m.id)))

  const arrived = useMemo(() => machines.find((m) => !knownIds.current.has(m.id)) ?? null, [machines])

  // The invitation's life is short by design, so it is counted down out loud.
  useEffect(() => {
    if (!invitation) return
    setLeft(invitation.expiresSec)
    const tick = setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000)
    return () => clearInterval(tick)
  }, [invitation])

  const mint = () => {
    setProblem(null)
    pair.mutate(undefined, {
      onSuccess: (result) => {
        setInvitation(result)
        setStep(1)
      },
      onError: (err) => {
        const hubOnly = err instanceof ApiError && err.status === 400
        setProblem(
          hubOnly
            ? 'Знакомство машин начинается на главной машине. Откройте это окно там.'
            : 'Не получилось выпустить приглашение. Попробуйте ещё раз.',
        )
      },
    })
  }

  const copy = () => {
    if (!invitation) return
    void navigator.clipboard?.writeText(invitation.pairingToken).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  return (
    <div className="fixed inset-0 z-70 flex items-center justify-center bg-scrim p-8">
      <div className="flex max-h-full w-[620px] flex-col overflow-hidden rounded-[14px] border border-bd bg-card shadow-menu">
        <div className="flex flex-none items-center gap-4 border-b border-bd px-[18px] py-3.5">
          <h2 className="m-0 flex-none text-[14px] font-semibold text-tx">Подключить машину</h2>
          <div className="flex-1" />
          <StepBar step={step} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="flex-none px-1 text-[13px] text-tx3 hover:text-tx"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
          {problem ? <p className="m-0 mb-3 text-[12.5px] text-err-tx">{problem}</p> : null}

          {step === 0 ? (
            <div className="flex flex-col gap-2.5">
              <label className="text-[13px] font-semibold text-tx" htmlFor="machine-title">
                Как назовём машину?
              </label>
              <input
                id="machine-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Например: Малый сервер, Ноутбук, Компьютер в офисе"
                className="h-9 rounded-[9px] border border-bd2 bg-input px-3 text-[13px] text-tx outline-none placeholder:text-tx3"
              />
              <p className="m-0 text-[11.5px] leading-[1.6] text-tx3">
                Имя понадобится Вам на следующем шаге: машина называет себя сама, когда представляется этому
                узлу. Здесь оно ничего не отправляет и никуда не уходит.
              </p>
            </div>
          ) : null}

          {step === 1 && invitation ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="flex-1 rounded-[9px] border border-bd2 bg-surf px-3 py-2.5 font-mono text-[13px] break-all text-tx">
                  {invitation.pairingToken}
                </span>
                <button
                  type="button"
                  onClick={copy}
                  className="h-9 flex-none rounded-[8px] border border-bd2 px-3.5 text-[12.5px] font-medium text-tx hover:bg-row-hover"
                >
                  {copied ? 'Скопировано' : 'Скопировать'}
                </button>
              </div>

              <div className="flex items-baseline gap-2.5">
                <span className="text-[12.5px] text-tx2">
                  Приглашение срабатывает один раз и живёт ограниченное время.
                </span>
                <span className={`text-[12.5px] font-semibold tabular-nums ${left > 0 ? 'text-tx' : 'text-err-tx'}`}>
                  {ttlLabel(left)}
                </span>
              </div>

              {title.trim() ? (
                <p className="m-0 text-[12.5px] text-tx2">
                  Имя, которое Вы выбрали, впишите в поле <span className="font-semibold text-tx">name</span>:{' '}
                  <span className="font-semibold text-tx">{title.trim()}</span>
                </p>
              ) : null}

              {/* The daemon's own words, verbatim. A wizard that edited them would be a wizard
                  a person cannot trust — and nothing here is executed, by anything, ever. */}
              <pre className="m-0 max-h-[260px] overflow-auto rounded-[10px] border border-bd bg-surf p-3 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-tx2">
                {invitation.instruction}
              </pre>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-2.5">
              {arrived ? (
                <p className="m-0 flex items-center gap-2 text-[13px] font-semibold text-ok-tx">
                  <span aria-hidden>✓</span>
                  {arrived.title} на связи
                </p>
              ) : (
                <p className="m-0 text-[13px] text-tx2">Ждём машину… она появится здесь сама.</p>
              )}
              <p className="m-0 text-[11.5px] leading-[1.6] text-tx3">
                На той машине: установите SMA и выполните команду из предыдущего шага. Это окно ничего не
                опрашивает — оно просто смотрит на список машин, который читает и всё остальное.
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-none items-center gap-2 border-t border-bd px-[18px] py-3">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="rounded-[8px] border border-bd2 px-3 py-[7px] text-[12.5px] text-tx2 hover:text-tx"
            >
              Назад
            </button>
          ) : null}
          <div className="flex-1" />
          {step === 0 ? (
            <button
              type="button"
              onClick={mint}
              disabled={pair.isPending}
              className="rounded-[8px] bg-blue-d px-3.5 py-[7px] text-[12.5px] font-semibold text-white disabled:opacity-60"
            >
              {pair.isPending ? 'Выпускаю…' : 'Далее'}
            </button>
          ) : null}
          {step === 1 ? (
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-[8px] bg-blue-d px-3.5 py-[7px] text-[12.5px] font-semibold text-white"
            >
              Далее
            </button>
          ) : null}
          {step === 2 ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-[8px] bg-blue-d px-3.5 py-[7px] text-[12.5px] font-semibold text-white"
            >
              Готово
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
