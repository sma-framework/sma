import { useEffect, useRef } from 'react'

/**
 * Composer — the one place a person speaks to the team, and the line that says what
 * speaking to it does.
 *
 * The caption is not decoration and is not paraphrased anywhere: «Читает и предлагает.
 * Запускает работу только по Вашей кнопке — сам ничего не начинает.» It is the boundary of
 * the whole lane, written where the hand is, at the moment of typing — not in a help page
 * nobody opens.
 *
 * IT SAYS THE SECOND HALF SINCE 10.08.2026. The line used to stop at «Ничего не запускает
 * сам», which is true and was read as «work cannot be started here at all» — by the owner,
 * on his own product. The invariant is unchanged: a typed sentence starts nothing, ever. What
 * changed is that the caption now also names the door that does exist, one button away on the
 * draft. A boundary that hides the path is not a safer boundary, it is a locked room.
 *
 * What is deliberately NOT here: prompt chips, «умные подсказки», a microphone. A person
 * says what they want in their own words; a row of suggested sentences teaches them to say
 * what the machine finds easy instead.
 */
export function Composer({
  value,
  onChange,
  onSend,
  busy,
}: {
  value: string
  onChange: (next: string) => void
  onSend: () => void
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
    <div className="flex-none border-t border-bd bg-card">
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
          <button
            type="button"
            onClick={send}
            disabled={busy || value.trim() === ''}
            className="flex-none rounded-[9px] bg-blue-d px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
          >
            Отправить
          </button>
        </div>
        <div className="mt-[7px] text-[11px] text-tx3">
          Читает и предлагает. Запускает работу только по Вашей кнопке — сам ничего не начинает.
        </div>
      </div>
    </div>
  )
}
