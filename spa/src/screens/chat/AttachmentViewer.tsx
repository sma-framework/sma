import { useEffect } from 'react'
import { useArtifactQuery } from '../../api/queries'

/**
 * AttachmentViewer — a document the conversation mentioned, read without leaving it.
 *
 * ═══════════════════════ TEXT IS SHOWN AS TEXT. ALWAYS. ═══════════════════════
 *
 * What comes back through the artefact door is somebody else's file — a plan, a summary, an
 * acceptance record — and it contains whatever its author wrote, including angle brackets and
 * anything that would like to be markup. It is rendered as a TEXT CHILD inside a `pre`, in a
 * monospaced face, with the line breaks the file itself has. React's escape hatch for raw
 * markup is not used anywhere in this folder — grep it and the only hit is the sentence in
 * `TurnList` saying there is none — and a markdown renderer would be the same hole under a
 * nicer name, because the document being read here is precisely the kind nobody has vetted.
 *
 * ═══════════════ THE PATH IS THE DAEMON'S, HANDED OVER UNTOUCHED ═══════════════
 *
 * The path comes from the reply's `attachments`, which the chat engine extracted
 * conservatively and the door will check properly. It is handed on exactly as it arrived:
 * building it out of pieces here would be a second spelling of the one path that door
 * accepts, and the door answers every wrong spelling with the same refusal on purpose.
 *
 * ══════════════════════ WHY THIS IS NOT ONE IMPORT AWAY ═══════════════════════
 *
 * «Конвейер фаз» has a viewer of its own, and it is nearly this file. It stays there and this
 * one stays here for the reason the registry gives: a screen is built inside its own folder
 * and reaches into no neighbour. The day a third screen needs one, the answer is not a third
 * copy — it is a move into the shell, made out loud, the way `DecisionCard` and `isOpen` were
 * moved. Two is where that conversation starts, not where it is settled.
 */
export function AttachmentViewer({ rel, onClose }: { rel: string; onClose: () => void }) {
  const doc = useArtifactQuery(rel)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  /** The file's own name — the last segment, which is what a person recognises. */
  const name = rel.split('/').filter(Boolean).pop() ?? rel

  return (
    <>
      <div className="fixed inset-0 z-40 bg-scrim" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={name}
        className="fixed top-[6vh] left-1/2 z-50 flex h-[88vh] w-[min(940px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-[14px] border border-bd bg-card shadow-menu"
      >
        <div className="flex flex-none items-center gap-3 border-b border-bd px-5 py-3.5">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold text-tx">{name}</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-tx3">{rel}</div>
          </div>
          <span className="flex-1" />
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
          {doc.data !== undefined ? (
            <pre className="m-0 font-mono text-[12px] leading-[1.65] whitespace-pre-wrap text-tx">
              {doc.data}
            </pre>
          ) : null}
        </div>
      </div>
    </>
  )
}
