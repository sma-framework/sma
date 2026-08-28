import { useState } from 'react'
import { usePhaseFileQuery, usePhaseFilesQuery } from '../../api/queries'
import type { PhaseFileNode } from '../../api/types'

/**
 * PhaseFolderView — папка фазы: слева её каталог деревом, справа предпросмотр выбранного файла.
 *
 * ═══════════════════ ЗАЧЕМ ЭТО ЗДЕСЬ, КОГДА РЯДОМ ЕСТЬ СПИСКИ ДОКУМЕНТОВ ═══════════════════
 *
 * Карточка показывает то, что проекция УМЕЕТ УЗНАТЬ: планы, итоги, приёмку. Всё остальное, что
 * фаза оставила в своём каталоге — черновик, выписка, картинка, чей-то временный файл, — для
 * окна не существовало, и человек шёл смотреть это в терминал. Дерево отвечает на другой
 * вопрос: «что вообще лежит в папке», — и отвечает содержимым каталога, а не догадкой о том,
 * какой файл важен.
 *
 * ═══════════════════════ ТЕКСТ ПОКАЗЫВАЕТСЯ ТЕКСТОМ. ВСЕГДА. ═══════════════════════
 *
 * Предпросмотр — это `pre` с текстовым ребёнком, и ничем другим он быть не может: файл рабочего
 * каталога никто не вычитывал, и разметки в нём может оказаться сколько угодно. Отрисовщика
 * разметки здесь нет и в этой папке нет вовсе — площадка для такого рендера, если она
 * понадобится, будет отдельной работой с отдельным замком, а не тихой правкой этого файла.
 *
 * ═══════════════════════ ПУТЬ НЕ СОБИРАЕТСЯ НА ЭКРАНЕ ═══════════════════════
 *
 * Путь берётся из ответа двери и уезжает обратно нетронутым. Дверь принимает ровно одно
 * написание пути и на всякое другое отвечает одним и тем же отказом — экран, который склеивал
 * бы путь сам, был бы вторым мнением о том, как этот путь пишется.
 */

/** Одна строка дерева: отступ по глубине, значок и имя. Каталог раскрывается кликом. */
function Row({
  node,
  depth,
  picked,
  open,
  onPick,
}: {
  node: PhaseFileNode
  depth: number
  picked: string | null
  open: Set<string>
  onPick: (node: PhaseFileNode) => void
}) {
  const isDir = node.kind === 'dir'
  const expanded = isDir && open.has(node.path)
  const isPicked = !isDir && picked === node.path

  return (
    <>
      <button
        type="button"
        onClick={() => onPick(node)}
        aria-expanded={isDir ? expanded : undefined}
        aria-current={isPicked ? 'true' : undefined}
        className={`flex w-full items-center gap-1.5 py-[3px] pr-2.5 text-left hover:bg-surf ${
          isPicked ? 'bg-blue-s' : ''
        }`}
        style={{ paddingLeft: `${10 + depth * 12}px` }}
      >
        <span aria-hidden className="flex-none font-mono text-[9px] text-tx3">
          {isDir ? (expanded ? '▾' : '▸') : '·'}
        </span>
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
            isDir ? 'font-semibold text-tx2' : isPicked ? 'text-blue-d' : 'text-tx2'
          }`}
        >
          {node.name}
        </span>
      </button>
      {expanded
        ? (node.children ?? []).map((child) => (
            <Row key={child.path} node={child} depth={depth + 1} picked={picked} open={open} onPick={onPick} />
          ))
        : null}
    </>
  )
}

export function PhaseFolderView({ id }: { id: string }) {
  const folder = usePhaseFilesQuery(id)
  const [picked, setPicked] = useState<PhaseFileNode | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const file = usePhaseFileQuery(id, picked ? picked.path : null)

  const pick = (node: PhaseFileNode) => {
    if (node.kind === 'dir') {
      setOpen((was) => {
        const next = new Set(was)
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
      return
    }
    setPicked(node)
  }

  const entries = folder.data?.entries ?? []

  return (
    <section className="overflow-hidden rounded-[12px] border border-bd bg-card shadow-panel">
      <div className="flex items-baseline gap-3 border-b border-bd px-4 py-2.5">
        <h2 className="m-0 text-[11px] font-semibold tracking-[0.09em] text-tx3 uppercase">Папка фазы</h2>
        <span className="min-w-0 truncate font-mono text-[11px] text-tx3">
          {folder.data ? `${folder.data.root}/ · живьём с диска · только чтение` : 'живьём с диска · только чтение'}
        </span>
        <span className="flex-1" />
        <span className="flex-none text-[11px] text-tx3">клик по файлу — предпросмотр справа</span>
      </div>

      {folder.isLoading ? <p className="m-0 px-4 py-3 text-[12.5px] text-tx2">Читаю папку фазы…</p> : null}
      {folder.isError ? (
        <p className="m-0 px-4 py-3 text-[12.5px] text-err-tx">
          Папка не открылась. С каталогом фазы ничего не случилось — попробуйте ещё раз.
        </p>
      ) : null}

      {folder.data ? (
        <div className="flex items-stretch">
          <div className="w-[250px] flex-none border-r border-bd bg-surf py-2">
            {entries.length === 0 ? (
              <p className="m-0 px-3 py-1 text-[11.5px] text-tx3">Каталог пуст.</p>
            ) : (
              entries.map((node) => (
                <Row key={node.path} node={node} depth={0} picked={picked?.path ?? null} open={open} onPick={pick} />
              ))
            )}
            {/* «ПОКАЗАНО НЕ ВСЁ» СКАЗАНО СЛОВАМИ: молча оборванное дерево читается как «больше
                ничего нет», и человек ищет файл, который на самом деле есть. */}
            {folder.data.truncated ? (
              <p className="m-0 px-3 pt-1.5 text-[11px] text-warn-tx">
                Показано не всё: в каталоге больше записей, чем окно показывает разом.
              </p>
            ) : null}
          </div>

          <div className="min-w-0 flex-1 px-4 py-3">
            {picked === null ? (
              <p className="m-0 text-[12px] text-tx3">Выберите файл слева — он покажется здесь текстом.</p>
            ) : (
              <>
                <div className="truncate font-mono text-[11px] font-semibold text-tx2">{picked.path}</div>
                {file.isLoading ? <p className="m-0 mt-2 text-[12px] text-tx2">Открываю файл…</p> : null}
                {file.isError ? (
                  <p className="m-0 mt-2 text-[12px] text-err-tx">
                    Файл не открылся. Так отвечает дверь на файл, который не читается текстом, —
                    например, на картинку или на файл больше показываемого размера.
                  </p>
                ) : null}
                {file.data !== undefined ? (
                  <pre className="m-0 mt-2 max-h-[420px] overflow-auto font-mono text-[11.5px] leading-[1.65] whitespace-pre-wrap text-tx2">
                    {file.data}
                  </pre>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
