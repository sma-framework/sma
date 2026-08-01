/**
 * DiffView — what the work actually changed, shown as what it is: text.
 *
 * ═════════════════════════ TEXT, AND NOTHING BUT TEXT ═════════════════════════
 *
 * The daemon answers /api/diff with the plain output of git. It is content that came out of
 * a branch a model wrote, so it reaches the glass through TEXT NODES only — never as markup,
 * never through a highlighting library that would have to parse it first. A diff is read for
 * what changed, not for its colours, and a screen that renders foreign content as markup is
 * one line away from rendering foreign markup.
 *
 * The summary beside it is DERIVED from that same text, never asked for separately: the file
 * names and the counts are read out of the diff's own headers, so the summary and the body
 * can never disagree.
 */

export interface DiffFileStat {
  name: string
  added: number
  removed: number
}

/**
 * The files a diff touched, with how many lines came and went. Read from the diff's own
 * `diff --git` headers and its `+`/`-` lines; a diff that says nothing yields nothing.
 */
export function diffFileStats(text: string): DiffFileStat[] {
  const files: DiffFileStat[] = []
  let current: DiffFileStat | null = null
  for (const line of text.split(/\r?\n/)) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line)
    if (header) {
      current = { name: header[2] ?? header[1], added: 0, removed: 0 }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) current.added += 1
    else if (line.startsWith('-')) current.removed += 1
  }
  return files
}

function FileLine({ file }: { file: DiffFileStat }) {
  return (
    <div className="flex items-baseline justify-between gap-2.5">
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-tx" title={file.name}>
        {file.name}
      </span>
      <span className="flex-none text-[11.5px] whitespace-nowrap tabular-nums">
        <span className="text-ok-tx">+{file.added}</span> <span className="text-err-tx">−{file.removed}</span>
      </span>
    </div>
  )
}

/** The right-hand summary: which files, and how much of each. */
export function DiffSummary({
  text,
  loading,
  failed,
  expanded,
  onToggle,
}: {
  text: string | null
  loading: boolean
  failed: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const files = text ? diffFileStats(text) : []
  const added = files.reduce((sum, f) => sum + f.added, 0)
  const removed = files.reduce((sum, f) => sum + f.removed, 0)

  return (
    <section className="rounded-[14px] border border-bd bg-card px-5 py-[18px] shadow-panel">
      <div className="mb-3.5 flex items-baseline justify-between gap-2.5">
        <span className="text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">Изменения</span>
        {files.length > 0 ? (
          <span className="text-[12px] tabular-nums">
            <span className="text-ok-tx">+{added}</span> <span className="text-err-tx">−{removed}</span>
          </span>
        ) : null}
      </div>

      {loading ? <p className="m-0 text-[12px] text-tx3">Читаю изменения…</p> : null}

      {!loading && failed ? (
        <p className="m-0 text-[12px] text-tx3">Изменений не видно: ветка задачи ещё не создана или уже убрана.</p>
      ) : null}

      {!loading && !failed && files.length === 0 ? (
        <p className="m-0 text-[12px] text-tx3">Файлы не изменены — подход остановился раньше.</p>
      ) : null}

      {files.length > 0 ? (
        <>
          <div className="flex flex-col gap-2.5">
            {files.map((f) => (
              <FileLine key={f.name} file={f} />
            ))}
          </div>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="mt-3.5 text-[12px] font-medium text-blue hover:text-blue-d"
          >
            {expanded ? 'Свернуть изменения' : 'Показать изменения целиком'}
          </button>
        </>
      ) : null}
    </section>
  )
}

/** The diff itself. One `pre`, one text node, no interpretation of any kind. */
export function DiffText({ text }: { text: string }) {
  return (
    <section className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
      <div className="border-b border-bd px-6 py-3.5 text-[10px] font-semibold tracking-[0.09em] text-tx3 uppercase">
        Что изменилось, строка за строкой
      </div>
      <pre className="m-0 max-h-[520px] overflow-auto bg-surf px-6 py-4 font-mono text-[11.5px] leading-[1.55] whitespace-pre text-tx2">
        {text}
      </pre>
    </section>
  )
}
