import { useState } from 'react'
import { isNotReady, isRaceLost } from '../../api/client'
import { useCreateSkill } from '../../api/queries'

/**
 * «Написать навык» — a person writes an ability here and it becomes a file.
 *
 * ═══════════════ IT WRITES, AND IT SHOWS WHAT IT WROTE ═══════════════
 *
 * This is not the forge. The forge is for «придумай мне навык»: a worker drafts something and
 * a person approves it later. This dialog is for the other half — the person already knows what
 * the skill says, and wants it to exist now. So the door writes the file and answers with its
 * PATH, and the path is what this dialog shows: «создан» on a status code alone is a claim,
 * a path is a fact somebody can go and look at.
 *
 * IT LANDS IN THE MACHINE STORE, and the dialog says so before the press rather than after.
 * That is the whole reason to write one here: a skill in this machine's store is available
 * under EVERY project, so it can be given to any worker on any tree — which is what «люди
 * ставят его своим агентам» needs to be true.
 *
 * WHY THE NAME IS ASKED IN LATIN. The name becomes a DIRECTORY, and it is the same string the
 * CLI's own skill loader reads out of the file's `name:` field. The daemon refuses anything
 * else, so the field says the rule instead of letting a person discover it through a refusal.
 */

/** The same shape the daemon's applier enforces — said here so a person reads it before pressing. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The daemon's own ceiling on a skill body. */
const BODY_CAP = 20000

export function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const create = useCreateSkill()
  const [id, setId] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [madePath, setMadePath] = useState<string | null>(null)

  const submit = () => {
    if (!ID_RE.test(id)) {
      setProblem('Имя — латиницей, строчными буквами, цифрами и дефисами. Например: release-notes.')
      return
    }
    if (!description.trim()) {
      setProblem('Одна строка о том, что навык умеет, — это подпись на карточке.')
      return
    }
    if (!body.trim()) {
      setProblem('Навык без текста ничему не учит.')
      return
    }
    if (body.length > BODY_CAP) {
      setProblem(`Текст длиннее ${BODY_CAP} символов — сократите.`)
      return
    }
    setProblem(null)
    create.mutate(
      { id, description, body },
      {
        onSuccess: (res) => {
          if (!res.ok || !res.skill) {
            setProblem('Дверь ответила без файла — навык не создан.')
            return
          }
          setMadePath(res.skill.path)
          onCreated()
        },
        onError: (err) =>
          setProblem(
            isNotReady(err)
              ? 'Создание навыков пока не работает — дверь не отвечает.'
              : isRaceLost(err)
                ? 'Навык с таким именем уже есть. Возьмите другое имя — здесь ничего не перезаписывается.'
                : 'Не удалось создать. Ничего не записано.',
          ),
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Написать навык"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex max-h-[82vh] w-[520px] flex-col gap-3.5 rounded-[13px] border border-bd2 bg-card p-[18px] shadow-menu"
      >
        <div>
          <div className="text-[13.5px] font-semibold text-tx">Написать навык</div>
          <div className="mt-1 text-[11.5px] text-tx3">
            Ляжет в хранилище машины — он будет виден в любом проекте, и его можно дать любому работнику.
          </div>
        </div>

        {madePath ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-[12.5px] text-ok-tx">Навык записан на диск.</p>
            <code className="rounded-[8px] border border-bd bg-head px-2.5 py-2 text-[11px] break-all text-tx2">
              {madePath}
            </code>
            <p className="m-0 text-[11.5px] text-tx2">
              Он уже в списке выше — там же кнопка «Кому дать».
            </p>
          </div>
        ) : (
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5" htmlFor="skill-id">
                <span className="text-[11.5px] text-tx2">Имя (латиницей, станет именем папки)</span>
                <input
                  id="skill-id"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="release-notes"
                  className="rounded-[8px] border border-bd2 bg-head px-2.5 py-2 text-[12.5px] text-tx outline-none focus:border-blue"
                />
              </label>
              <label className="flex flex-col gap-1.5" htmlFor="skill-description">
                <span className="text-[11.5px] text-tx2">Одной строкой — что навык умеет</span>
                <input
                  id="skill-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Как собрать заметки к релизу из журнала задач."
                  className="rounded-[8px] border border-bd2 bg-head px-2.5 py-2 text-[12.5px] text-tx outline-none focus:border-blue"
                />
              </label>
              <label className="flex flex-col gap-1.5" htmlFor="skill-body">
                <span className="text-[11.5px] text-tx2">Текст навыка</span>
                <textarea
                  id="skill-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={10}
                  placeholder="Опишите, что и как делать — это прочитает работник, которому навык дадут."
                  className="resize-y rounded-[8px] border border-bd2 bg-head px-2.5 py-2 text-[12.5px] leading-[1.5] text-tx outline-none focus:border-blue"
                />
              </label>
            </div>
          </div>
        )}

        {problem ? <p className="m-0 text-[11.5px] text-err-tx">{problem}</p> : null}

        <div className="flex items-center justify-end gap-2 border-t border-bd pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[8px] border border-bd2 px-[13px] py-1.5 text-[11.5px] text-tx2 hover:text-tx"
          >
            {madePath ? 'Закрыть' : 'Отмена'}
          </button>
          {madePath ? null : (
            <button
              type="button"
              onClick={submit}
              disabled={create.isPending}
              className="rounded-[8px] bg-blue px-[15px] py-1.5 text-[11.5px] font-semibold text-white hover:bg-blue-d disabled:opacity-60"
            >
              {create.isPending ? 'Записываем…' : 'Создать навык'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
