import { useState } from 'react'
import { isNotReady } from '../../api/client'
import { useToggleAgent } from '../../api/queries'
import type { ImportCandidate, ImportDraftResult } from '../../api/types'
import { candidateKey, KIND_WORD, resultKey } from './shared'

/**
 * DraftsStep — «Черновики»: what landed, what the checks said, and the act that is a
 * person's alone.
 *
 * ═════════════════ WHY «ВКЛЮЧИТЬ» IS ONE ACT HERE AND TWO ON «АГЕНТАХ» ═══════════════
 *
 * A FORGED draft is two acts, because the definition file does not exist yet: «одобрить»
 * merges it into the tree, and only then can «включить» read the worker's lane and provider
 * OUT OF THAT FILE. An IMPORTED draft has already had its first act — the person pressed
 * «Сделать черновики», and the definition is on disk, at the path shown on the card. There
 * is nothing left to approve: the same second act, and only it, remains.
 *
 * So the button here does exactly one thing — /api/agent/toggle — and the card says so out
 * loud. It is pressed per card, never for a batch, and never by an effect: no code path in
 * this screen enables anything without a person's click (T-9-56). The daemon holds the door
 * regardless: its toggle refuses an id with no definition file, and it is the forge's own
 * lint — not this screen — that decided whether the definition passed at all.
 *
 * A draft whose lint FAILED gets no button. The finding is shown in words and the file is
 * named, because the honest next step is a person opening that file — not this screen
 * offering to switch on a definition the forge has just objected to.
 *
 * A SKILL needs no switch of its own: a skill is an instruction, and it is already visible
 * on «Навыки», where a person says which workers know it. The card says that and offers the
 * way there rather than inventing an act.
 *
 * Every name and every phrase below came out of somebody else's file and is rendered as a
 * TEXT CHILD. No raw-HTML escape hatch is used anywhere on this screen (T-9-55).
 */

/** What the import door says happened to one chosen item. */
const STATUS_WORD: Record<string, string> = {
  awaiting_approval: 'ждёт Вашего решения',
  refused: 'не взяли',
  manual: 'переносится вручную',
}

/** The fence the import door writes into EVERY imported worker, whatever the file said. */
const IMPORTED_CANNOT = [
  'включать себя — это отдельное решение человека',
  'менять настройки парка и реестр инструментов',
  'работать за пределами этого проекта',
]

function Bounds({ kind }: { kind: string | null }) {
  if (kind === 'skill') {
    return (
      <div className="text-[11.5px] leading-[1.55] text-tx3">
        Навык — это инструкция, а не работник: границы задаёт тот, кому Вы его назначите.
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1 text-[11.5px] leading-[1.55] text-tx3">
      <div>
        <span className="font-semibold text-tx2">Можно: </span>
        то, что заявлено в привезённом описании — оно перенесено дословно, слово в слово.
      </div>
      <div>
        <span className="font-semibold text-tx2">Нельзя: </span>
        {IMPORTED_CANNOT.join(' · ')}
      </div>
    </div>
  )
}

/** The forge's own objections to a foreign definition, in its own words. */
function Findings({ draft }: { draft: ImportDraftResult }) {
  if (!draft.lint || draft.lint.ok) return null
  return (
    <div className="rounded-[10px] border border-err-bd bg-err-s px-3.5 py-2.5">
      <div className="text-[12px] font-semibold text-err-tx">Проверки кузницы не прошли</div>
      <div className="mt-1.5 flex flex-col gap-1">
        {draft.lint.findings.length === 0 ? (
          <div className="text-[11.5px] text-tx2">Кузница не назвала, что именно не сошлось.</div>
        ) : (
          draft.lint.findings.map((f) => (
            <div key={f.name} className="text-[11.5px] leading-[1.5] text-tx2">
              {f.name}: {f.detail}
            </div>
          ))
        )}
      </div>
      <div className="mt-2 text-[11px] leading-[1.5] text-tx3">
        Включать нечего, пока это не поправлено: определение лежит файлом в проекте — откройте
        его, поправьте текст и вернитесь.
      </div>
    </div>
  )
}

/** One landed draft: what it is, what the checks said, and the one act that is a person's. */
function LandedCard({
  draft,
  candidate,
  onOpenSkills,
}: {
  draft: ImportDraftResult
  candidate?: ImportCandidate
  onOpenSkills: () => void
}) {
  const toggle = useToggleAgent()
  const [enabled, setEnabled] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [showFix, setShowFix] = useState(false)

  const lintOk = !draft.lint || draft.lint.ok
  const isAgent = draft.kind === 'agent'
  const title = candidate?.name ?? draft.slug ?? 'Черновик'

  const enable = () => {
    if (!draft.slug) return
    setProblem(null)
    toggle.mutate(
      { id: draft.slug, enabled: true },
      {
        onSuccess: (res) => {
          if (res.agent && res.agent.enabled === false) {
            setProblem('Остался выключенным — попробуйте ещё раз.')
            return
          }
          setEnabled(true)
        },
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Включение пока не работает — дверь не отвечает. Черновик остался на месте.'
              : 'Включить не удалось. Черновик остался черновиком, ничего не изменилось.',
          ),
      },
    )
  }

  return (
    <article className="flex flex-col gap-3 rounded-[12px] border border-bd border-l-[3px] border-l-teal bg-card p-4 shadow-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] leading-[1.55] text-tx">
            <span className="font-semibold text-teal">Черновик: </span>
            {title}
          </div>
          <div className="mt-1 text-[11px] text-tx3">
            {KIND_WORD[draft.kind ?? ''] ?? 'Черновик'} · {STATUS_WORD[draft.status] ?? draft.status}
            {candidate ? ` · ${candidate.source}` : ''}
          </div>
          {draft.renamedFrom ? (
            <div className="mt-1 text-[11px] text-warn-tx">
              Имя «{draft.renamedFrom}» было занято — взяли под именем «{draft.slug}». Чужой файл не
              тронут.
            </div>
          ) : null}
        </div>
        <span className="flex-none rounded-full bg-idle-s px-2.5 py-1 text-[10.5px] whitespace-nowrap text-idle-tx">
          решение за Вами
        </span>
      </div>

      {candidate?.summary ? (
        <div className="text-[12px] leading-[1.55] text-tx2">{candidate.summary}</div>
      ) : null}

      <Bounds kind={draft.kind} />
      <Findings draft={draft} />

      <div className="flex flex-wrap items-center gap-2">
        {isAgent && lintOk ? (
          enabled ? (
            <span className="rounded-[8px] bg-ok-s px-[13px] py-1.5 text-[11.5px] font-semibold text-ok-tx">
              Включён
            </span>
          ) : (
            <button
              type="button"
              onClick={enable}
              disabled={toggle.isPending || !draft.slug}
              className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
            >
              {toggle.isPending ? 'Включаю…' : 'Включить'}
            </button>
          )
        ) : null}

        {draft.kind === 'skill' ? (
          <button
            type="button"
            onClick={onOpenSkills}
            className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
          >
            Открыть Навыки
          </button>
        ) : null}

        <button
          type="button"
          aria-expanded={showFix}
          onClick={() => setShowFix((v) => !v)}
          className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
        >
          Поправить
        </button>
      </div>

      {showFix ? (
        <p className="m-0 text-[11.5px] leading-[1.55] text-tx2">
          Черновик лежит в Вашем проекте:{' '}
          <span className="font-mono text-[11px] text-tx">{draft.path ?? 'путь не назван'}</span>.
          Откройте его в своём редакторе, поправьте текст — и вернитесь сюда.
        </p>
      ) : null}

      {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}

      {isAgent && lintOk ? (
        <p className="m-0 text-[11px] leading-[1.5] text-tx3">
          Определение уже лежит файлом — его положил Ваш выбор на прошлом шаге. Осталось одно
          действие: завести работника в ростер. Это и делает кнопка, по одному черновику за раз.
        </p>
      ) : null}
      {draft.kind === 'skill' ? (
        <p className="m-0 text-[11px] leading-[1.5] text-tx3">
          Навык уже виден на экране «Навыки» — там Вы решаете, кто им пользуется.
        </p>
      ) : null}
    </article>
  )
}

/** One item that did NOT land — and the reason, in the daemon's own words. */
function RefusedCard({ draft, candidate }: { draft: ImportDraftResult; candidate?: ImportCandidate }) {
  return (
    <article className="rounded-[12px] border border-bd bg-surf p-4">
      <div className="text-[12.5px] text-tx">{candidate?.name ?? draft.slug ?? 'Находка'}</div>
      <div className="mt-1 text-[11px] text-tx3">
        {KIND_WORD[draft.kind ?? ''] ?? 'Находка'} · {STATUS_WORD[draft.status] ?? draft.status}
      </div>
      <div className="mt-1.5 text-[12px] leading-[1.55] text-tx2">
        {draft.reason ?? 'Причина не названа.'}
      </div>
      <div className="mt-1.5 text-[11px] leading-[1.5] text-tx3">
        Ваш файл остался байт в байт таким же. Остальные находки это не остановило.
      </div>
    </article>
  )
}

export function DraftsStep({
  drafts,
  candidates,
  onOpenSkills,
}: {
  drafts: ImportDraftResult[]
  candidates: ImportCandidate[]
  onOpenSkills: () => void
}) {
  const byKey = new Map(candidates.map((c) => [candidateKey(c), c]))
  const landed = drafts.filter((d) => d.status === 'awaiting_approval')
  const rest = drafts.filter((d) => d.status !== 'awaiting_approval')

  const candidateOf = (d: ImportDraftResult) => byKey.get(resultKey(d.kind, d.renamedFrom ?? d.slug))

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-[10px] border border-bd bg-warn-s px-4 py-3 text-[12.5px] leading-[1.6] text-tx">
        Привезённые описания проверены и ждут Вашего решения. Ничего не включается само.
      </div>

      {drafts.length === 0 ? (
        <p className="m-0 text-[13px] text-tx2">Ничего не приехало — брать было нечего.</p>
      ) : null}

      {landed.length > 0 ? (
        <div className="flex max-w-[720px] flex-col gap-3">
          {landed.map((d) => (
            <LandedCard
              key={`${d.kind}:${d.slug}`}
              draft={d}
              candidate={candidateOf(d)}
              onOpenSkills={onOpenSkills}
            />
          ))}
        </div>
      ) : null}

      {rest.length > 0 ? (
        <div>
          <div className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">
            Не приехало
          </div>
          <div className="flex max-w-[720px] flex-col gap-2.5">
            {rest.map((d, i) => (
              <RefusedCard key={`${d.kind}:${d.slug}:${i}`} draft={d} candidate={candidateOf(d)} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
