import { useMemo, useState } from 'react'
import { plural } from '../../shell/format'
import type { ImportCandidate, ImportScanResult } from '../../api/types'
import { candidateKey, isEnrollable, KIND_GROUP } from './shared'

/**
 * FoundStep — «Что нашлось»: what already lives in this project, and what of it to take.
 *
 * ══════════════════════ A LIST, NOT AN INVENTORY OF SOMEBODY'S DISK ══════════════════
 *
 * Every row is a MEANING: a name, one phrase about what it does, and a grey line saying
 * where it came from in words. No paths, no file names, no extensions — the daemon does
 * not put them on the wire, and this step would have nothing to show even if it wanted to.
 *
 * Nothing here is chosen for a person. The checkboxes start empty, «Отметить все» is a
 * button somebody presses, and a candidate whose name is already taken is marked as such
 * ON THIS STEP — so the collision is seen before it is decided about, not after.
 *
 * A name and a description come out of somebody else's file. They are rendered as TEXT
 * CHILDREN and nothing else: a description that looks like markup reads as markup, because
 * React escapes a text child and no escape hatch for raw HTML is used on this screen at
 * all (T-9-55).
 */

/** How many rows of a group are shown before the rest fold into one line. */
const VISIBLE_PER_GROUP = 4

function CollisionPill() {
  return (
    <span className="flex-none rounded-full bg-warn-s px-2.5 py-[3px] text-[10.5px] whitespace-nowrap text-warn-tx">
      имя занято
    </span>
  )
}

/** One found thing: a checkbox, a name, what it does, and where it came from. */
function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ImportCandidate
  checked: boolean
  onToggle: () => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-bd bg-card px-4 py-3 shadow-panel hover:bg-card-hov">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-[3px] h-[15px] w-[15px] flex-none accent-blue"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2.5">
          <span className="text-[13.5px] font-semibold text-tx">{candidate.name}</span>
          {candidate.collision ? <CollisionPill /> : null}
        </span>
        <span className="mt-[3px] block text-[12px] leading-[1.5] text-tx2">
          {candidate.summary || 'Описание не сказало, что это умеет.'}
        </span>
        <span className="mt-[3px] block text-[11px] text-tx3">{candidate.source}</span>
      </span>
    </label>
  )
}

/** One group of found things, folded after the first few. */
function Group({
  title,
  rows,
  chosen,
  onToggle,
}: {
  title: string
  rows: ImportCandidate[]
  chosen: string[]
  onToggle: (key: string) => void
}) {
  const [all, setAll] = useState(false)
  if (rows.length === 0) return null

  const shown = all ? rows : rows.slice(0, VISIBLE_PER_GROUP)
  const rest = rows.length - shown.length

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2.5">
        <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">{title}</span>
        <span className="text-[11.5px] text-tx3">{rows.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {shown.map((c) => {
          const key = candidateKey(c)
          return (
            <CandidateRow
              key={key}
              candidate={c}
              checked={chosen.includes(key)}
              onToggle={() => onToggle(key)}
            />
          )
        })}
      </div>
      {rest > 0 ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-2 text-[12px] text-tx2 hover:text-tx"
        >
          и {rest} {plural(rest, 'другой', 'других', 'других')}
        </button>
      ) : null}
    </div>
  )
}

/** The things that were found but are moved by hand — with the reason, in words. */
function ManualGroup({ rows }: { rows: ImportCandidate[] }) {
  if (rows.length === 0) return null
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2.5">
        <span className="text-[10px] font-semibold tracking-[0.1em] text-tx3 uppercase">
          Требуют Вашего решения
        </span>
        <span className="text-[11.5px] text-tx3">{rows.length}</span>
      </div>
      <div className="mb-2.5 text-[11.5px] text-tx3">
        Эти находки не переносятся сами: форму такого описания мы не угадываем.
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((c, i) => (
          <div
            key={`${c.kind}:${c.slug ?? c.name}:${i}`}
            className="rounded-[10px] border border-bd bg-surf px-4 py-3"
          >
            <div className="text-[13px] text-tx">{c.name}</div>
            {c.summary ? <div className="mt-[3px] text-[12px] text-tx2">{c.summary}</div> : null}
            <div className="mt-[3px] text-[11px] text-tx3">{c.reason ?? 'Причина не названа.'}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function FoundStep({
  found,
  chosen,
  busy,
  onToggle,
  onAll,
  onNone,
  onAgain,
  onOpenAgents,
}: {
  found: ImportScanResult
  chosen: string[]
  busy: boolean
  onToggle: (key: string) => void
  onAll: (keys: string[]) => void
  onNone: () => void
  onAgain: () => void
  onOpenAgents: () => void
}) {
  const [query, setQuery] = useState('')

  const takeable = useMemo(() => found.candidates.filter(isEnrollable), [found.candidates])
  const manual = useMemo(() => found.candidates.filter((c) => !isEnrollable(c)), [found.candidates])

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return takeable
    return takeable.filter((c) => `${c.name} ${c.summary}`.toLowerCase().includes(q))
  }, [takeable, query])

  const agents = matching.filter((c) => c.kind === 'agent')
  const skills = matching.filter((c) => c.kind === 'skill')

  if (takeable.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="m-0 max-w-[560px] text-[14px] leading-[1.6] text-tx">
          Ничего не нашлось. Соберите нового работника по описанию на экране Агенты.
        </p>
        {found.notReady.length > 0 ? (
          <div className="flex max-w-[680px] flex-col gap-1.5">
            {found.notReady.map((n) => (
              <div key={n.id} className="text-[11.5px] leading-[1.5] text-tx3">
                {n.title}: {n.reason}
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenAgents}
            className="rounded-[9px] bg-blue-d px-[15px] py-2 text-[12.5px] font-semibold text-white hover:bg-blue"
          >
            Собрать нового работника
          </button>
          <button
            type="button"
            onClick={onAgain}
            disabled={busy}
            className="rounded-[9px] border border-bd2 px-[15px] py-2 text-[12.5px] text-tx2 hover:text-tx disabled:opacity-60"
          >
            {busy ? 'Смотрю…' : 'Посмотреть снова'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="m-0 text-[17px] font-semibold text-tx">
          В Вашем проекте уже живут помощники и навыки
        </h2>
        <p className="m-0 mt-1.5 max-w-[620px] text-[12.5px] leading-[1.6] text-tx2">
          Мы прочитали файлы проекта и собрали готовые описания. Отметьте, что взять. Ничего не
          изменено — скан только читает.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[11.5px] text-tx3">
          Найдено {takeable.length} · {KIND_GROUP.agent} {takeable.filter((c) => c.kind === 'agent').length} ·{' '}
          {KIND_GROUP.skill} {takeable.filter((c) => c.kind === 'skill').length}
        </span>
        <div className="flex-1" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по имени"
          className="h-8 w-[220px] rounded-[8px] border border-bd2 bg-input px-3 text-[12px] text-tx outline-none placeholder:text-tx3"
        />
        <button
          type="button"
          onClick={() => onAll(matching.map(candidateKey))}
          className="rounded-[8px] border border-bd2 px-3 py-1.5 text-[11.5px] text-tx2 hover:text-tx"
        >
          Отметить все
        </button>
        <button
          type="button"
          onClick={onNone}
          className="rounded-[8px] border border-bd2 px-3 py-1.5 text-[11.5px] text-tx2 hover:text-tx"
        >
          Снять всё
        </button>
        <button
          type="button"
          onClick={onAgain}
          disabled={busy}
          className="rounded-[8px] border border-bd2 px-3 py-1.5 text-[11.5px] text-tx2 hover:text-tx disabled:opacity-60"
        >
          {busy ? 'Смотрю…' : 'Посмотреть снова'}
        </button>
      </div>

      {matching.length === 0 ? (
        <p className="m-0 text-[12.5px] text-tx2">По этому слову ничего не нашлось.</p>
      ) : null}

      <Group title={KIND_GROUP.agent} rows={agents} chosen={chosen} onToggle={onToggle} />
      <Group title={KIND_GROUP.skill} rows={skills} chosen={chosen} onToggle={onToggle} />
      <ManualGroup rows={manual} />

      <p className="m-0 text-[11.5px] leading-[1.5] text-tx3">
        Отмеченное приезжает черновиками и ждёт Вашего решения. Ничего не включается само.
      </p>
    </div>
  )
}
