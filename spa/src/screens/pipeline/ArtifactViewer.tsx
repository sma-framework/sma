import { useEffect, useState } from 'react'
import { useArtifactQuery } from '../../api/queries'
import type { PhaseArtifact } from '../../api/types'
import { SANDBOX_ALLOWANCES, artifactSrcDoc, initialView, otherView, renderableAs } from './sandbox'

/**
 * ArtifactViewer — one document of the phase, read where the person already is.
 *
 * ═════════════ «TEXT IS SHOWN AS TEXT. ALWAYS» — СНЯТ. ЧЕМ ЗАМЕНЁН — НИЖЕ ═════════════
 *
 * Прежний закон этого файла звучал так: что бы ни лежало в артефакте, оно показывается ТЕКСТОМ
 * внутри `pre`, потому что документ здесь чужой и никем не проверенный, а markdown-рендер —
 * «та же дыра под именем поприличнее». Закон держался честно и своё дело сделал: дыры в этой
 * папке не появилось ни разу.
 *
 * СНЯТ ОСОЗНАННО — решением владельца 25.08 (бриф внедрения Задачника, «главный спор пожелания
 * 7», выбран вариант ПЕСОЧНИЦА). Причина снятия — не удобство ради удобства: план на сорок
 * экранов, читаемый простынёй моноширинных решёток и звёздочек, читают по диагонали, а запись
 * приёмки, прочитанная по диагонали, — это приёмка, которой не было.
 *
 * ЧЕМ ЗАМЕНЁН — не «теперь можно markdown», а ровно одно послабление с двумя замками:
 *
 *   ЗАМОК ПЕРВЫЙ — ГЛУХАЯ РАМКА. Отрисованное живёт ТОЛЬКО внутри `iframe` с ПУСТЫМ `sandbox`:
 *   ни `allow-scripts`, ни `allow-same-origin`, ни чего-либо ещё. Содержимое кладётся через
 *   `srcdoc`, то есть документ не грузится ниоткуда, а политика внутри рамки (`default-src
 *   'none'`) закрывает и пассивную сеть — картинка по чужому адресу тоже никуда не сходит.
 *   Скрипт в чужом файле в такой рамке не выполняется; выполнись он — ему всё равно нечего
 *   взять: своего происхождения у рамки нет, до приложения она не дотягивается.
 *
 *   ЗАМОК ВТОРОЙ — СВОЙ КОНВЕРТЕР, БЕЗ ЗАВИСИМОСТЕЙ. markdown превращается в html в
 *   `./sandbox.ts` — сто строк, ноль пакетов, экранирование ПЕРВЫМ ходом. Внешней библиотеки
 *   здесь нет намеренно: она приносит свою поверхность и свои обновления в дерево, которое
 *   отдаёт человеку чужие файлы.
 *
 * ЧТО НЕ ИЗМЕНИЛОСЬ. Вне рамки по-прежнему НИЧЕГО не рендерится как разметка: React-лазейка для
 * впрыска html в этой папке не используется — grep даёт ноль, комментарии включая. И сырой вид
 * никуда не делся: кнопка «текст» рядом с именем файла всегда на месте, а для файла, который не
 * markdown и не html, он единственный. Запасной вид — не режим отладки, а нормальный способ
 * прочитать документ ровно таким, каким его написал автор.
 *
 * The path is taken FROM THE CARD and handed to the door untouched. Building it out of pieces
 * on the screen would be a second spelling of the one path the door accepts, and the door
 * answers every wrong spelling with the same refusal on purpose.
 */
export function ArtifactViewer({
  artifact,
  onClose,
}: {
  artifact: PhaseArtifact
  onClose: () => void
}) {
  const doc = useArtifactQuery(artifact.path)
  const [view, setView] = useState(() => initialView(artifact.path))

  useEffect(() => {
    setView(initialView(artifact.path))
  }, [artifact.path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const canRender = renderableAs(artifact.path) !== null
  const srcDoc = view === 'rendered' && doc.data !== undefined ? artifactSrcDoc(artifact.path, doc.data) : null

  return (
    <>
      <div className="fixed inset-0 z-40 bg-scrim" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={artifact.name}
        className="fixed top-[6vh] left-1/2 z-50 flex h-[88vh] w-[min(940px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-[14px] border border-bd bg-card shadow-menu"
      >
        <div className="flex flex-none items-center gap-3 border-b border-bd px-5 py-3.5">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold text-tx">{artifact.name}</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-tx3">{artifact.path}</div>
          </div>
          <span className="flex-1" />
          {canRender ? (
            <button
              type="button"
              onClick={() => setView(otherView(view))}
              className="flex-none rounded-[7px] border border-bd px-2.5 py-1 text-[11.5px] text-tx2 hover:text-tx"
            >
              {view === 'rendered' ? 'текст' : 'вид'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="flex-none px-1.5 text-[15px] leading-none text-tx3 hover:text-tx"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-surf px-5 py-4">
          {doc.isLoading ? <p className="m-0 text-[12.5px] text-tx2">Открываю документ…</p> : null}
          {doc.isError ? (
            <p className="m-0 text-[12.5px] text-err-tx">
              Документ не открылся. Он остался на месте — ничего с ним не случилось.
            </p>
          ) : null}
          {srcDoc !== null ? (
            <iframe
              title={artifact.name}
              sandbox={SANDBOX_ALLOWANCES}
              referrerPolicy="no-referrer"
              srcDoc={srcDoc}
              className="h-full w-full border-0 bg-transparent"
            />
          ) : null}
          {srcDoc === null && doc.data !== undefined ? (
            <pre className="m-0 font-mono text-[12px] leading-[1.65] whitespace-pre-wrap text-tx">
              {doc.data}
            </pre>
          ) : null}
        </div>
      </div>
    </>
  )
}
