import { useEffect, useMemo, useRef, useState } from 'react'
import { isNotReady } from '../../api/client'
import { useEnrollImport, useScanImport } from '../../api/queries'
import type { ImportCandidate, ImportDraftResult, ImportScanResult, ImportSelection } from '../../api/types'
import { openScreen } from '../../shell/navigation'
import { DraftsStep } from './DraftsStep'
import { FoundStep } from './FoundStep'
import { nameProblem, TakeStep } from './TakeStep'
import { candidateKey, isEnrollable } from './shared'

/**
 * «Привести своих» — the move that takes minutes instead of a rewrite.
 *
 * ══════════════════════ THREE STEPS, AND A DOOR BEHIND EACH ONE ══════════════════════
 *
 * A person's own project already has helpers and skills in it, written for another tool.
 * This wizard READS them (/api/import/scan), shows what was found, and — only when a
 * person presses the button on the third step — asks the daemon to take the chosen ones in
 * as drafts (/api/import/enroll). That is the entire surface: two doors, both knocked on
 * deliberately, neither of them by an effect that fires while somebody is reading.
 *
 * ═══════════════════════════ NOTHING HAPPENS WITHOUT A PRESS ═════════════════════════
 *
 *   scan   — on entry, because looking changes nothing: the scanner writes no byte, so
 *            calling it twice is calling it once. «Посмотреть снова» is the same look.
 *   enroll — ONLY from «Сделать черновики». There is no code path in this screen that
 *            enrols anything from an effect, a timer, or a re-render (T-9-56).
 *   enable — one card at a time, on the third step, by hand. See DraftsStep for why the
 *            imported draft's remaining act is one and not two.
 *
 * ════════════════════════════ SOMEBODY ELSE'S TEXT IS DATA ═══════════════════════════
 *
 * Names and descriptions come out of foreign files. They are rendered as text children,
 * everywhere, and no raw-HTML escape hatch is used on any of the three steps (T-9-55). The
 * daemon has already stripped the paths: a person sees «из файлов проекта», never a folder.
 */

const STEP_LABELS = ['Что нашлось', 'Что взять', 'Черновики'] as const

/** The daemon takes a party of choices, never a bulk channel — the same bound, said here. */
const SELECTIONS_CAP = 50

function StepBar({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2.5">
      {STEP_LABELS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10.5px] font-semibold ${
              i <= step ? 'bg-blue-s text-blue' : 'bg-idle-s text-idle-tx'
            }`}
          >
            {i + 1}
          </span>
          <span className={`text-[12px] ${i === step ? 'font-semibold text-tx' : 'text-tx3'}`}>{label}</span>
          {i < STEP_LABELS.length - 1 ? <span aria-hidden className="mx-1.5 h-px w-6 bg-bd" /> : null}
        </div>
      ))}
    </div>
  )
}

export function Screen() {
  const scan = useScanImport()
  const enroll = useEnrollImport()

  const [found, setFound] = useState<ImportScanResult | null>(null)
  const [step, setStep] = useState(0)
  /** The chosen ones, in the order they were ticked. */
  const [chosen, setChosen] = useState<string[]>([])
  /** The name a person confirmed for a candidate whose own name is taken. */
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<ImportDraftResult[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  /** The look happens once on entry; a re-render is not a reason to read the estate again. */
  const looked = useRef(false)

  const look = () => {
    setProblem(null)
    scan.mutate(undefined, {
      onSuccess: (result) => {
        setFound(result)
        setChosen([])
        // A collision arrives with a free name the scanner checked. It is filled in for
        // convenience and stays EDITABLE — the daemon checks whatever is confirmed, again.
        const filled: Record<string, string> = {}
        for (const c of result.candidates) {
          if (c.collision?.suggestion) filled[candidateKey(c)] = c.collision.suggestion
        }
        setRenames(filled)
      },
      onError: (err) =>
        setProblem(
          isNotReady(err)
            ? 'Дверь импорта пока не отвечает. Ничего не изменено.'
            : 'Не получилось прочитать файлы проекта. Ничего не изменено.',
        ),
    })
  }

  useEffect(() => {
    if (looked.current) return
    looked.current = true
    look()
    // The look is a one-time act of entering the screen — not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const candidates = found?.candidates ?? []

  const byKey = useMemo(() => {
    const map = new Map<string, ImportCandidate>()
    for (const c of candidates) if (isEnrollable(c)) map.set(candidateKey(c), c)
    return map
  }, [candidates])

  const chosenCandidates = useMemo(
    () => chosen.map((k) => byKey.get(k)).filter((c): c is ImportCandidate => !!c),
    [chosen, byKey],
  )

  const takeableCount = useMemo(() => candidates.filter(isEnrollable).length, [candidates])

  /** «Сделать черновики» stays shut while a taken name has no confirmed replacement. */
  const nameTrouble = chosenCandidates.some((c) => !!nameProblem(c, renames[candidateKey(c)] ?? ''))
  const tooMany = chosen.length > SELECTIONS_CAP

  const toggleOne = (key: string) =>
    setChosen((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))

  const makeDrafts = () => {
    setProblem(null)
    const selections: ImportSelection[] = chosenCandidates.map((c) => {
      const key = candidateKey(c)
      const override = (renames[key] ?? '').trim().toLowerCase()
      return {
        slug: c.slug as string,
        kind: c.kind,
        // A rename travels ONLY for a candidate the scan marked: the daemon refuses one on
        // anything else, and rightly — a rename with no collision is a request to rewrite.
        ...(c.collision && override ? { overrideSlug: override } : {}),
      }
    })

    enroll.mutate(
      { selections },
      {
        onSuccess: (result) => {
          setDrafts(result.drafts)
          setStep(2)
        },
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Дверь импорта пока не отвечает. Ничего не записано.'
              : 'Черновики не сделаны — дверь отказала. В проекте ничего не изменилось.',
          ),
      },
    )
  }

  const busy = scan.isPending
  const landed = (drafts ?? []).filter((d) => d.status === 'awaiting_approval').length

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-3 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <button
          type="button"
          onClick={() => openScreen({ screen: 'agents' })}
          className="flex-none text-[12.5px] text-tx3 hover:text-tx"
        >
          Агенты
        </button>
        <span aria-hidden className="flex-none text-[12.5px] text-tx3">
          ›
        </span>
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">
          Привести своих
        </h1>
        <StepBar step={step} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => openScreen({ screen: 'agents' })}
          className="flex-none rounded-[9px] border border-bd2 px-[15px] py-2 text-[12px] whitespace-nowrap text-tx2 hover:text-tx"
        >
          Закрыть
        </button>
      </header>

      {problem ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">{problem}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="max-w-[980px]">
          {step === 0 ? (
            found ? (
              <FoundStep
                found={found}
                chosen={chosen}
                busy={busy}
                onToggle={toggleOne}
                onAll={(keys) => setChosen(keys)}
                onNone={() => setChosen([])}
                onAgain={look}
                onOpenAgents={() => openScreen({ screen: 'agents' })}
              />
            ) : (
              <p className="m-0 text-[13px] text-tx2">
                {busy ? 'Смотрю, что уже живёт в Вашем проекте…' : 'Пока смотреть нечего.'}
              </p>
            )
          ) : null}

          {step === 1 ? (
            <TakeStep
              chosenCandidates={chosenCandidates}
              restCount={Math.max(0, takeableCount - chosenCandidates.length)}
              renames={renames}
              onRename={(key, value) => setRenames((prev) => ({ ...prev, [key]: value }))}
              onDrop={(key) => toggleOne(key)}
            />
          ) : null}

          {step === 2 && drafts ? (
            <DraftsStep
              drafts={drafts}
              candidates={candidates}
              onOpenSkills={() => openScreen({ screen: 'skills' })}
            />
          ) : null}
        </div>
      </div>

      <div className="flex flex-none items-center gap-3 border-t border-bd bg-card px-7 py-3.5">
        {step === 1 ? (
          <button
            type="button"
            onClick={() => setStep(0)}
            className="rounded-[8px] border border-bd2 px-[15px] py-2 text-[12.5px] text-tx2 hover:text-tx"
          >
            Назад
          </button>
        ) : null}

        <span className="text-[11.5px] text-tx3">
          {step === 0 ? `Отмечено ${chosen.length}` : null}
          {step === 1
            ? tooMany
              ? `За один раз можно взять не больше ${SELECTIONS_CAP}. Снимите лишние.`
              : `Станет черновиками ${chosenCandidates.length} · включится сразу ничего`
            : null}
          {step === 2 ? `Черновиков ждёт решения: ${landed}` : null}
        </span>

        <div className="flex-1" />

        {step === 0 ? (
          <button
            type="button"
            onClick={() => setStep(1)}
            disabled={chosen.length === 0}
            className="rounded-[8px] bg-blue-d px-[17px] py-2 text-[12.5px] font-semibold text-white hover:bg-blue disabled:opacity-60"
          >
            Дальше
          </button>
        ) : null}

        {step === 1 ? (
          <button
            type="button"
            onClick={makeDrafts}
            disabled={chosenCandidates.length === 0 || nameTrouble || tooMany || enroll.isPending}
            className="rounded-[8px] bg-blue-d px-[17px] py-2 text-[12.5px] font-semibold text-white hover:bg-blue disabled:opacity-60"
          >
            {enroll.isPending ? 'Делаю черновики…' : 'Сделать черновики'}
          </button>
        ) : null}

        {step === 2 ? (
          <button
            type="button"
            onClick={() => openScreen({ screen: 'agents' })}
            className="rounded-[8px] bg-blue-d px-[17px] py-2 text-[12.5px] font-semibold text-white hover:bg-blue"
          >
            Готово
          </button>
        ) : null}
      </div>
    </section>
  )
}
