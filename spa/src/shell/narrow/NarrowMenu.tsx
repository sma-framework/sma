import { useEffect, useRef } from 'react'

import { navScreens } from '../../screens/registry'
import type { ScreenId } from '../../screens/registry'
import { isNarrowCapable } from './narrow'

/**
 * NarrowMenu — ШТОРКА ЗА КНОПКОЙ «Меню»: одна названная форма замены боковой колонки.
 *
 * ═══════════════ ПОЧЕМУ ИМЕННО ШТОРКА, И ПОЧЕМУ ОНА ОДНА ═══════════════
 *
 * Боковая колонка стола — 248 px. На экране в 375 px это две трети ширины, отданные меню:
 * на работу остаётся полоска, в которой не читается ни заголовок, ни строка задачи. Сжать
 * колонку нельзя (получится столбик обрубленных слов), спрятать молча — тоже: список
 * экранов и есть карта окна, и человек, у которого её отняли, не знает, что окно умеет.
 *
 * Значит колонка не сжимается, а УСТУПАЕТ МЕСТО: экраны уезжают за кнопку и приходят
 * полноэкранным слоем, когда их позвали. Форма выбрана ОДНА и названа: не нижняя полоса,
 * не выпадающий список, не то и другое вперемешку. Две формы навигации на одном окне — это
 * два места, где можно разойтись, и два ответа на вопрос «где я».
 *
 * ═══════════════ РЕЕСТР ОДИН — ВТОРОГО СПИСКА ЭКРАНОВ НЕТ ═══════════════
 *
 * Строки берутся из того же реестра окна и в том же порядке, что у боковой колонки, теми же
 * заголовками групп. Свой список означал бы, что новый экран появляется на столе и не
 * появляется на телефоне — и никто не узнает об этом, пока не хватится.
 *
 * ═══════════════ СЛОЙ ВЕДЁТ СЕБЯ КАК ДИАЛОГ ═══════════════
 *
 * Шторка накрывает экран целиком, поэтому она объявляет себя диалогом и говорит, что за ней
 * ничего не осталось: иначе читающий с экрана продолжит читать спрятанное под ней. Фокус
 * входит в слой при открытии и возвращается кнопке «Меню» при закрытии — руке, пришедшей с
 * клавиатуры, некуда деться из слоя, который её не принял. Закрытие — кнопкой «Закрыть» и
 * клавишей Escape: привычка нажать Escape старше этого окна.
 */
export function NarrowMenu({
  active,
  onOpen,
  onClose,
}: {
  active: ScreenId | null
  onOpen: (id: ScreenId) => void
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  /** Фокус входит в слой сразу: кнопка закрытия — первое, что находит и палец, и клавиатура. */
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  /** Escape закрывает. Слушатель снимается — иначе он переживёт саму шторку. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const row = (id: ScreenId, title: string) => (
    <button
      key={id}
      type="button"
      onClick={() => onOpen(id)}
      aria-current={id === active ? 'page' : undefined}
      className={`flex min-h-[44px] w-full items-center justify-between gap-3 rounded-[10px] px-3.5 text-left focus-visible:outline-2 focus-visible:outline-blue ${
        id === active ? 'bg-side-act text-white' : 'text-side-tx2'
      }`}
    >
      <span className="text-[14px] leading-[1.35] font-medium">{title}</span>
      {/*
        Пометка стоит РЯДОМ С ИМЕНЕМ, а не только на самом экране: человек должен узнать,
        что строка ведёт к работе стола, ДО того как нажмёт, — иначе каждый такой экран
        читается как обещание, которого телефон не выполнит.
      */}
      {isNarrowCapable(id) ? null : (
        <span className="text-[13px] leading-[1.3] text-side-tx3">с компьютера</span>
      )}
    </button>
  )

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Экраны"
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-side"
    >
      <div className="flex items-center justify-between gap-3 border-b border-side-bd px-4 py-3">
        <span className="text-[15px] font-semibold text-side-tx">Экраны</span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="flex min-h-[44px] items-center rounded-[10px] border border-side-bd px-3.5 text-[14px] font-semibold text-side-tx2 focus-visible:outline-2 focus-visible:outline-blue"
        >
          Закрыть
        </button>
      </div>

      <nav className="flex flex-col gap-1 px-3 py-3">
        {navScreens('main').map((s) => row(s.id, s.title))}

        <div className="mt-4 mb-1 px-3.5 text-[13px] font-semibold tracking-[0.10em] text-side-tx3 uppercase">
          Настройки
        </div>

        {navScreens('settings').map((s) => row(s.id, s.title))}
      </nav>
    </div>
  )
}
