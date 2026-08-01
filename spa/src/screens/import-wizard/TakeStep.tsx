import type { ImportCandidate } from '../../api/types'
import { candidateKey, KIND_WORD } from './shared'

/**
 * TakeStep — «Что взять»: the chosen ones, and the ONE thing that can still go wrong.
 *
 * ═════════════════════ A TAKEN NAME IS DECIDED HERE, IN THE OPEN ════════════════════
 *
 * The daemon never overwrites a name that already answers to somebody: a candidate whose
 * slug is taken arrives with a suggestion, and it can be written ONLY under a name a person
 * confirmed. So this step shows the collision as a thing to decide — the occupied name in
 * words, the suggested free one in a box that can be edited — and refuses to move on while
 * one of them is empty.
 *
 * The confirmation is not a guarantee, and this screen does not pretend it is: the daemon
 * checks the name AGAIN at the moment of writing, because a scan is a photograph and a file
 * can appear between the photograph and the write. A name that turns out to be taken then
 * is that item's refusal, in the answer, on the next step. Nothing about the founder's own
 * file changes either way.
 */

/** A rename must fit the forge's own shape, or the daemon will refuse it anyway. */
const SLUG_RE = /^[a-z0-9-]{3,48}$/

export function nameProblem(candidate: ImportCandidate, value: string): string | null {
  if (!candidate.collision) return null
  const wanted = value.trim().toLowerCase()
  if (!wanted) return 'Впишите имя, под которым это жить здесь: старое занято.'
  if (!SLUG_RE.test(wanted)) return 'Нужны 3–48 символов: маленькие латинские буквы, цифры и дефис.'
  if (wanted === candidate.slug) return 'Это и есть занятое имя. Нужно другое.'
  return null
}

function Collision({
  candidate,
  value,
  onChange,
}: {
  candidate: ImportCandidate
  value: string
  onChange: (v: string) => void
}) {
  const collision = candidate.collision
  if (!collision) return null
  const problem = nameProblem(candidate, value)

  return (
    <div className="mt-3 rounded-[10px] border border-bd bg-warn-s px-3.5 py-3">
      <div className="text-[12px] leading-[1.55] text-tx">
        Имя «{candidate.slug}» здесь уже занято ({collision.existingKind}). Тихой перезаписи не
        будет: возьмём под другим именем или не возьмём вовсе.
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Новое имя"
          className="h-8 w-[260px] rounded-[8px] border border-bd2 bg-input px-3 font-mono text-[12px] text-tx outline-none placeholder:text-tx3"
          placeholder={collision.suggestion ?? 'новое-имя'}
        />
        {collision.suggestion ? (
          <button
            type="button"
            onClick={() => onChange(collision.suggestion as string)}
            className="rounded-[8px] border border-bd2 px-3 py-1.5 text-[11.5px] text-tx2 hover:text-tx"
          >
            Взять предложенное: {collision.suggestion}
          </button>
        ) : (
          <span className="text-[11.5px] text-tx2">
            Свободного имени с суффиксом не нашлось — впишите своё.
          </span>
        )}
      </div>
      {problem ? <div className="mt-2 text-[11.5px] text-err-tx">{problem}</div> : null}
    </div>
  )
}

export function TakeStep({
  chosenCandidates,
  restCount,
  renames,
  onRename,
  onDrop,
}: {
  chosenCandidates: ImportCandidate[]
  /** How much of the estate stays exactly where it is. */
  restCount: number
  renames: Record<string, string>
  onRename: (key: string, value: string) => void
  onDrop: (key: string) => void
}) {
  if (chosenCandidates.length === 0) {
    return (
      <p className="m-0 text-[13px] text-tx2">
        Ничего не отмечено. Вернитесь на шаг «Что нашлось».
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="m-0 text-[17px] font-semibold text-tx">Всё это станет черновиками</h2>
        <p className="m-0 mt-1.5 max-w-[620px] text-[12.5px] leading-[1.6] text-tx2">
          Границы «Можно / Нельзя» переносим как есть, ничего не дописываем. Ничего не
          включится, пока Вы не решите это отдельно.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 text-[11.5px] text-tx3">
        <span>
          Станет черновиками{' '}
          <span className="font-semibold text-tx">{chosenCandidates.length}</span>
        </span>
        <span>·</span>
        <span>
          Останется на месте <span className="font-semibold text-tx">{restCount}</span>
        </span>
        <span>·</span>
        <span>
          Включится сразу <span className="font-semibold text-tx">ничего</span>
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {chosenCandidates.map((c) => {
          const key = candidateKey(c)
          return (
            <article key={key} className="rounded-[12px] border border-bd bg-card p-4 shadow-panel">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[13.5px] font-semibold text-tx">{c.name}</span>
                    <span className="rounded-full bg-idle-s px-2.5 py-[3px] text-[10.5px] text-idle-tx">
                      {KIND_WORD[c.kind] ?? c.kind}
                    </span>
                  </div>
                  <div className="mt-1 text-[12px] leading-[1.5] text-tx2">{c.summary}</div>
                  <div className="mt-[3px] text-[11px] text-tx3">{c.source}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onDrop(key)}
                  className="flex-none rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
                >
                  Убрать
                </button>
              </div>
              <Collision candidate={c} value={renames[key] ?? ''} onChange={(v) => onRename(key, v)} />
            </article>
          )
        })}
      </div>
    </div>
  )
}
