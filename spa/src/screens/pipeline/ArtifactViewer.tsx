import { useEffect } from 'react'
import { useArtifactQuery } from '../../api/queries'
import type { PhaseArtifact } from '../../api/types'

/**
 * ArtifactViewer — one document of the phase, read where the person already is.
 *
 * ═══════════════════════ TEXT IS SHOWN AS TEXT. ALWAYS. ═══════════════════════
 *
 * What comes back through the artefact door is somebody else's file — a plan, a summary, an
 * acceptance record — and it contains whatever its author wrote, including angle brackets and
 * anything that would like to be markup. It is rendered as a TEXT CHILD inside a `pre`, in a
 * monospaced face, with the line breaks the file itself has. Nothing on this screen renders
 * raw HTML: React's escape hatch for injecting markup is not used anywhere in this folder —
 * grep it and the answer is zero, comments included — and a markdown renderer would be the
 * same hole under a nicer name, because the document being read here is precisely the kind
 * nobody has vetted.
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

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
