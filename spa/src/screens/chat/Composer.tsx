import { useEffect, useRef } from 'react'

/**
 * Composer — the one place a person speaks to the team, and the line that says what
 * speaking to it does.
 *
 * The caption is not decoration and is not paraphrased anywhere: «Читает и предлагает. Ставит
 * задачу по Вашему слову — приёмку решаете Вы сами.» It is the boundary of the whole lane,
 * written where the hand is, at the moment of typing — not in a help page nobody opens.
 *
 * ГРАНИЦА ПЕРЕЕХАЛА ОДИН РАЗ, И ЧЕСТНО. Строка обещала «запускает работу только по Вашей
 * кнопке»; теперь разговор доводит дело до постановки СЛОВАМИ — человек говорит «да», и
 * задача заводится. Причина в дверях: у бота кнопок нет вовсе, и если бы слово работало
 * только там, окно и телефон стали бы разными продуктами. Что НЕ переехало — приёмка: её
 * по-прежнему нажимает рука, и вторая половина строки говорит именно об этом.
 *
 * What is deliberately NOT here: prompt chips, «умные подсказки», a microphone. A person
 * says what they want in their own words; a row of suggested sentences teaches them to say
 * what the machine finds easy instead.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
}: {
  value: string
  onChange: (next: string) => void
  onSend: () => void
  /** Стоп для живого хода. While busy the ONE button is Стоп — the recon lesson
   *  (Multica, 11.08): interruption belongs a pixel from the hand, not on another screen. */
  onStop?: () => void
  busy: boolean
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  // «Поправить» puts the draft's words back in here — the cursor belongs with them.
  useEffect(() => {
    if (value) inputRef.current?.focus()
  }, [value])

  const send = () => {
    if (busy || value.trim() === '') return
    onSend()
  }

  return (
    /*
      ПОЛЕ ВВОДА ПРИЛИПАЕТ К НИЗУ ВИДИМОГО ОКНА, а не стоит в конце страницы.
      Рама окна растёт по содержимому (`min-h-full` в Shell — осознанно, ради узкой работы),
      поэтому длинная лента разговора делает страницу выше экрана и уносит композер за нижний
      край: чтобы ответить, приходилось прокручивать вниз ПОСЛЕ каждого ответа (жалоба
      владельца 27.08 — «чат немного смещается и мне нужно проскроллить вниз, чтобы написать
      сообщение»). `sticky bottom-0` держит его на месте при любой высоте ленты и при любой
      раме — чинит причину там, где она видна, не переписывая высоту всего окна.
    */
    <div className="sticky bottom-0 z-20 flex-none border-t border-bd bg-card">
      <div className="mx-auto w-full max-w-[800px] px-7 pt-3.5 pb-4">
        <div className="flex items-center gap-2.5 rounded-[12px] border border-bd2 bg-surf py-[7px] pr-2 pl-3">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="Напишите сообщение"
            aria-label="Сообщение руководителю команды"
            className="min-w-0 flex-1 border-none bg-transparent py-[5px] text-[13px] text-tx outline-none placeholder:text-tx3"
          />
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Остановить ход"
              className="flex-none rounded-[9px] bg-warn-tx px-3.5 py-2 text-[12.5px] font-semibold text-white"
            >
              ■ Стоп
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={busy || value.trim() === ''}
              className="flex-none rounded-[9px] bg-blue-d px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
            >
              Отправить
            </button>
          )}
        </div>
        <div className="mt-[7px] text-[11px] text-tx3">
          Читает и предлагает. Ставит задачу по Вашему слову — приёмку решаете Вы сами.
        </div>
      </div>
    </div>
  )
}
