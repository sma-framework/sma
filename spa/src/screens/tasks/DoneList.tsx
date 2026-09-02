import { useEffect, useState } from 'react'
import type { DoneRow } from '../../api/types'
import { DoneUnfold } from '../today/DoneUnfold'
import { UnitRow } from './UnitRow'
import { ARCHIVE_AFTER_DAYS, doneUnfoldRow } from './units'
import type { DoneTab, DoneView, WorkUnit } from './units'

/**
 * DoneList — ВСЯ закрытая работа, раскрытая на всю ширину и раскрываемая построчно.
 *
 * ПОЧЕМУ ОТДЕЛЬНОЙ ПОЛОСОЙ, А НЕ ВНУТРИ СТОЛБИКА. Столбик — одна седьмая ширины экрана, и окно
 * готовой работы (обещание, квитанция слияния, коммиты, подходы, стенограммы) в нём не
 * читается ничем. Полоса под доской даёт ту же ширину, что и группа «проект неизвестен», и
 * строка раскрывается НА МЕСТЕ: человек не уезжает с доски и не теряет, откуда пришёл.
 *
 * НИ ОДНОГО РЕШЕНИЯ, ПРИНЯТОГО ЗДЕСЬ. Что показать, в каком порядке и что считать архивом,
 * решила проекция (`doneView`), и её проверяет прогон; этот файл рисует её ответ. Своё сито,
 * живущее в разметке, стало бы вторым мнением о том, что человек видит.
 */

/** Одна вкладка сита. Нажатая называется словом и цветом — цвет здесь никогда не один. */
function Tab({
  on,
  n,
  label,
  onPick,
}: {
  on: boolean
  n: number
  label: string
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className={`rounded-[7px] border px-2.5 py-1 text-[11.5px] font-semibold ${
        on ? 'border-blue text-tx' : 'border-bd text-tx2 hover:text-tx'
      }`}
    >
      {label} <span className="tabular-nums text-tx3">{n}</span>
    </button>
  )
}

/**
 * Одна строка закрытой работы. Есть ряд двери — раскрывается окном готовой работы прямо здесь;
 * нет (фаза, сборка) — открывается своей карточкой, как открывалась всегда.
 */
function DoneLine({
  unit,
  row,
  first,
  open,
  onToggle,
  onOpen,
}: {
  unit: WorkUnit
  row: DoneRow | null
  first: boolean
  open: boolean
  onToggle: () => void
  onOpen: (unit: WorkUnit) => void
}) {
  if (!row) return <UnitRow unit={unit} first={first} onOpen={onOpen} />
  return (
    <div className={first ? '' : 'border-t border-bd'}>
      <UnitRow unit={unit} first expanded={open} onOpen={onToggle} />
      {open ? (
        <div className="px-4 pb-4">
          <DoneUnfold row={row} />
        </div>
      ) : null}
    </div>
  )
}

export function DoneList({
  view,
  index,
  tab,
  onTab,
  query,
  onQuery,
  focus,
  onOpen,
  onClose,
}: {
  view: DoneView
  index: ReadonlyMap<string, DoneRow>
  tab: DoneTab
  onTab: (tab: DoneTab) => void
  query: string
  onQuery: (query: string) => void
  /** Строка, с которой человек пришёл сюда из столбика: она раскрыта сразу. */
  focus: string | null
  onOpen: (unit: WorkUnit) => void
  onClose: () => void
}) {
  /**
   * Раскрыта ОДНА строка за раз, и это не экономия места: раскрытие спрашивает у демона
   * историю работы, и десяток раскрытых строк — десяток чтений ради одного вопроса, на который
   * человек смотрит по очереди.
   */
  const [openId, setOpenId] = useState<string | null>(focus)
  // Приход из столбика — это просьба раскрыть ИМЕННО ЭТУ строку, и приходить можно много раз.
  useEffect(() => {
    if (focus) setOpenId(focus)
  }, [focus])
  const [archiveOpen, setArchiveOpen] = useState(false)

  const line = (unit: WorkUnit, i: number) => (
    <DoneLine
      key={`${unit.kind}:${unit.id}`}
      unit={unit}
      row={doneUnfoldRow(unit, index)}
      first={i === 0}
      open={openId === unit.id}
      onToggle={() => setOpenId(openId === unit.id ? null : unit.id)}
      onOpen={onOpen}
    />
  )

  return (
    <div className="mt-4 overflow-hidden rounded-[10px] border border-bd bg-card">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-bd px-4 py-2.5">
        <span className="text-[13px] font-semibold text-tx">Готово — вся закрытая работа</span>
        <span className="flex-1" />
        <Tab on={tab === 'all'} n={view.ok + view.fail} label="Все" onPick={() => onTab('all')} />
        <Tab on={tab === 'ok'} n={view.ok} label="Принято" onPick={() => onTab('ok')} />
        <Tab on={tab === 'fail'} n={view.fail} label="Не получилось" onPick={() => onTab('fail')} />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Поиск по названию"
          aria-label="Поиск по названию закрытой работы"
          className="w-[220px] rounded-[9px] border border-bd bg-surf px-2.5 py-1.5 text-[12px] text-tx outline-none placeholder:text-tx3"
        />
        <button
          type="button"
          onClick={onClose}
          className="rounded-[9px] border border-bd2 px-2.5 py-1.5 text-[11.5px] text-tx2 hover:text-tx"
        >
          свернуть
        </button>
      </div>

      {view.rows.length === 0 && view.archive.length === 0 ? (
        /* ПУСТО ЗДЕСЬ — ЭТО ОТВЕТ СИТА, А НЕ ЗАЯВЛЕНИЕ О РАБОТЕ. Столбик мог быть полон, а
           слова поиска — не совпасть ни с чем; сказать в этом месте «закрытой работы нет»
           значило бы соврать о работе, которая лежит в двух сантиметрах. И наоборот: пока
           хоть что-то нашлось — пусть даже одно архивное, — говорить «не подошла ни одна»
           нельзя, строка стоит прямо под этими словами. */
        <p className="m-0 px-4 py-6 text-center text-[12px] text-tx2">
          {view.total === 0 && query.trim() === ''
            ? 'Закрытой работы пока нет.'
            : 'Под эти слова не подошла ни одна строка — попробуйте другие или снимите сито.'}
        </p>
      ) : (
        view.rows.map(line)
      )}

      {/*
        АРХИВ — НЕ КОРЗИНА. Здесь лежит то, о чём решение уже принято: снятое рукой и провалы
        старше недели. Они не исчезли и не потеряли ни одного слова — группа стоит со своим
        числом и открывается одним нажатием. Пока архива нет, нет и группы: пустой заголовок
        «Архив — 0» учит не читать заголовки.
      */}
      {view.archive.length > 0 ? (
        <div className="border-t border-bd">
          <button
            type="button"
            onClick={() => setArchiveOpen((v) => !v)}
            aria-expanded={archiveOpen}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-row-hover"
          >
            <span aria-hidden className="flex-none text-[11px] text-tx3">
              {archiveOpen ? '▾' : '▸'}
            </span>
            <span className="text-[12.5px] font-semibold text-tx">Архив — {view.archive.length}</span>
            <span className="flex-1" />
            <span className="text-[11px] text-tx3">
              снятое рукой и провалы старше {ARCHIVE_AFTER_DAYS} дней · {archiveOpen ? 'свернуть' : 'показать'}
            </span>
          </button>
          {archiveOpen ? view.archive.map(line) : null}
        </div>
      ) : null}
    </div>
  )
}
