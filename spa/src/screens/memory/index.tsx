import { useState } from 'react'

import { useApprove, useStateQuery } from '../../api/queries'
import type { MemoryNotePointer, ProjectMemorySurface, ProjectMigrationFile } from '../../api/types'
import { plural } from '../../shell/format'
import { IndexPanel, LintPanel } from './CorpusPanel'
import { DraftsPanel } from './DraftsPanel'
import { CardHead, useMemoryBells } from './shared'
import { TagCloud } from './TagCloud'

/**
 * «Память» — the project's notebook, seen as a surface: how much there is, what it is
 * about, and what was written down recently.
 *
 * ═══════════════════ A SURFACE, NOT A FILE MANAGER, AND NOT A WINDOW ═══════════════════
 *
 * The reading carries a note's NAME and never its body, and this screen is built around
 * that on purpose. A row here is a pointer: it says a lesson exists and what it is called,
 * and it stops there. Clicking it opens nothing, because there is nothing to open — the
 * full text lives in the project's notebook, where a terminal reads it with the whole
 * loader behind it. The alternative would have been a payload that copies the memory tree
 * off the machine every few seconds so that one screen could show a paragraph nobody asked
 * for. The honest boundary is drawn in words under the list, not hidden behind a dead link.
 *
 * ═════════════════════════ WHAT THE CORPUS COSTS TO CARRY ═════════════════════════
 *
 * Two figures are worth a person's attention and both are here: how many lessons the team
 * has accumulated, and how big the always-loaded index is — the part every worker reads
 * before it starts. The second is the one that grows quietly and eventually has to be
 * pruned, so it is shown as a size, in the same place, every day.
 *
 * ══════════════════════════ NOTHING LEAVES THE HOUSEHOLD ══════════════════════════
 *
 * The corpus lives inside the project and travels with it to the owner's own machines. No
 * third-party service holds a copy, and the line at the bottom of the screen says so.
 *
 * ═════════════ THE CONNECTED PROJECT — SHOWN, NEVER EDITED ═════════════
 *
 * Below the local notebook the screen shows the notebook of the project that is currently
 * CONNECTED. It obeys the same laws — a row is a pointer, no body travels — plus one more
 * that is a founder decision and not a technical limit: this project's memory is READ-ONLY
 * from here. It is edited in the project itself, by the people working in it.
 *
 * Two sentences on the glass exist because leaving them out would make the screen dishonest:
 *   - «Показываем, не редактируем» — so nobody looks for an edit button that will not exist;
 *   - and, when the connection has degraded, that the view refreshes on a schedule rather
 *     than instantly. A window that claims to be live and quietly shows yesterday is worse
 *     than one that never claimed it, which is the whole reason the daemon reports the
 *     degraded mode instead of hiding it.
 *
 * The ONE thing that can be written into a connected project is a migration of a note still
 * written in the older format, and it is deliberately slow: the daemon previews what would
 * change per file, the screen shows that, and each file needs its own «да» before anything
 * is applied. There is no «применить всё» and there must never be one.
 *
 * ═════════════════════════ AND, SINCE V5.4, A WORKBENCH ═════════════════════════
 *
 * Three more acts over the CONNECTED project's corpus live at the bottom of this screen, each
 * in its own file in this folder: the lessons the write pipeline staged and stopped on, the
 * corpus's own check, and the button that regenerates the index. They obey the same law the
 * migration list has obeyed since V5.1 — a change is SHOWN before it is offered, and it is
 * agreed to one file at a time.
 *
 * They are shown only while a project is connected, and they ask nothing while it is not. That
 * is not caution about an empty answer: the workbench reads THE CONNECTED PROJECT's corpus, the
 * same one the panel above it reads, and a workbench that quietly worked on a different tree
 * than the notebook beside it would be one screen whose two halves disagree without saying so.
 */

/** A byte count in the words a person reads without translating. */
function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} Б`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} КБ`
  return `${(kb / 1024).toFixed(1)} МБ`
}

function Pill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-none items-baseline gap-2 rounded-[9px] border border-bd bg-card px-3.5 py-1.5 shadow-panel">
      <span className="text-[16px] font-bold text-tx tabular-nums">{value}</span>
      <span className="text-[11.5px] text-tx2">{label}</span>
    </div>
  )
}

/** One kind of thing the notebook holds: a figure, and what that figure means. */
function StoreRow({
  letter,
  tone,
  title,
  value,
  desc,
  first,
}: {
  letter: string
  tone: string
  title: string
  value: string
  desc: string
  first: boolean
}) {
  return (
    <div className={`flex flex-col gap-2 px-[18px] py-[15px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[13px] font-bold ${tone}`}
        >
          {letter}
        </span>
        <span className="flex-none text-[13.5px] font-semibold whitespace-nowrap text-tx">{title}</span>
        <div className="flex-1" />
        <span className="flex-none text-[15px] font-bold whitespace-nowrap text-tx tabular-nums">{value}</span>
      </div>
      <div className="ml-[46px] max-w-[720px] text-[11.5px] leading-[1.5] text-tx2">{desc}</div>
    </div>
  )
}

/**
 * A recent lesson, as a POINTER. There is no `onClick` here and that is the design: the row
 * carries a name and a quiet identifier, and the caption under the list says where the full
 * text lives.
 */
function NoteRow({ note, first }: { note: MemoryNotePointer; first: boolean }) {
  return (
    <div className={`flex min-w-0 items-baseline gap-3 px-[18px] py-[11px] ${first ? '' : 'border-t border-bd'}`}>
      <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-blue" />
      <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-tx">{note.title || note.id}</span>
      <span className="max-w-[220px] flex-none truncate text-[11px] text-tx3" title={note.id}>
        {note.id}
      </span>
    </div>
  )
}

/**
 * The reserved POST /api/approve target prefix that means «apply the migration proposal for
 * this one note» instead of «approve a task». DECLARED HERE, beside the call it belongs to,
 * exactly as the stock-team target is declared beside its own call: the daemon (server.mjs
 * PROJECT_MIGRATION_TARGET_PREFIX) owns the literal and this is the other side of that seam.
 */
const MIGRATION_TARGET_PREFIX = '__migrate__'

/** What a note would BECOME, in the founder's language rather than the engine's. */
const DISPOSITION_LABEL: Record<string, string> = {
  'v2-markup': 'станет записью нового образца',
  'episode-archive': 'уедет в архив событий',
  skip: 'менять нечего',
}

/** WHY, from the daemon's closed vocabulary. An unknown code shows itself rather than lying. */
const REASON_LABEL: Record<string, string> = {
  'doctrine-record': 'это правило — переносится как запись',
  'history-episode': 'это история — переносится в архив событий',
  'already-v2': 'уже нового образца',
  structural: 'служебный файл, не заметка',
  unreadable: 'файл не читается',
  skipped: 'пропущена',
}

/** One note of the connected project's notebook. A pointer, like every row on this screen. */
function ProjectNoteRow({ note, first }: { note: { id: string; title: string }; first: boolean }) {
  return (
    <div className={`flex min-w-0 items-baseline gap-3 px-[18px] py-[11px] ${first ? '' : 'border-t border-bd'}`}>
      <span aria-hidden className="h-1.5 w-1.5 flex-none rounded-full bg-ok-tx" />
      <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-tx">{note.title || note.id}</span>
      <span className="max-w-[220px] flex-none truncate text-[11px] text-tx3" title={note.id}>
        {note.id}
      </span>
    </div>
  )
}

/**
 * One proposed migration, and the «да» that belongs to it.
 *
 * The row shows what would change BEFORE it offers to change it, and the offer is two steps:
 * the button asks, and a second, explicit «Да, применить» does it. One file, one question,
 * one answer — which is the whole shape of the promise this screen makes.
 */
function MigrationRow({ file, first }: { file: ProjectMigrationFile; first: boolean }) {
  const approve = useApprove()
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const stem = file.file.replace(/\.md$/, '')
  const applied = file.draftStatus === 'already-applied'

  const confirm = () => {
    setProblem(null)
    approve.mutate(
      { taskId: `${MIGRATION_TARGET_PREFIX}${stem}` },
      {
        onSuccess: (result) => {
          setAsking(false)
          if (!result || result.ok !== true) setProblem('Не применилось. Файл остался как был.')
        },
        onError: () => {
          setAsking(false)
          setProblem('Не применилось. Файл остался как был.')
        },
      },
    )
  }

  return (
    <div className={`flex flex-col gap-2 px-[18px] py-[13px] ${first ? '' : 'border-t border-bd'}`}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-tx" title={file.file}>
          {file.file}
        </span>
        <span className="flex-none text-[11px] text-tx2">
          {DISPOSITION_LABEL[file.disposition] ?? file.disposition}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-tx3">
        <span>{REASON_LABEL[file.reasonCode] ?? file.reasonCode}</span>
        {file.changedLines > 0 ? (
          <span className="tabular-nums">
            строк изменится: {file.changedLines}
          </span>
        ) : null}
        {file.droppedKeys.length > 0 ? (
          <span title={file.droppedKeys.join(', ')}>
            полей не перенесётся: {file.droppedKeys.length}
          </span>
        ) : null}
        {file.errors > 0 ? <span className="text-warn-tx">не проходит проверку: {file.errors}</span> : null}
        {file.hasStub ? <span>потребуется дописать формулировку</span> : null}
        {file.sensitive ? <span className="text-warn-tx">помечена как чувствительная</span> : null}
      </div>

      {applied ? (
        <span className="text-[11.5px] text-ok-tx">Применено.</span>
      ) : !file.applicable ? (
        <span className="text-[11.5px] text-tx3">Применять нечего.</span>
      ) : asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-tx">Применить именно этот файл?</span>
          <button
            type="button"
            onClick={confirm}
            disabled={approve.isPending}
            className="rounded-[8px] border border-bd bg-ok-s px-3 py-1 text-[11.5px] font-semibold text-ok-tx disabled:opacity-60"
          >
            {approve.isPending ? 'Применяю…' : 'Да, применить'}
          </button>
          <button
            type="button"
            onClick={() => setAsking(false)}
            className="rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] text-tx2"
          >
            Отмена
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="w-fit rounded-[8px] border border-bd bg-card px-3 py-1 text-[11.5px] font-semibold text-tx"
        >
          Применить
        </button>
      )}
      {problem ? <span className="text-[11.5px] text-warn-tx">{problem}</span> : null}
    </div>
  )
}

/** The connected project's notebook: shown, not edited, and honest about how fresh it is. */
function ConnectedProject({ project }: { project: ProjectMemorySurface }) {
  const migration = project.migration
  return (
    <>
      <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
        <CardHead
          title={`Подключённый проект — ${project.project.name}`}
          note={`${project.noteCount} ${plural(project.noteCount, 'запись', 'записи', 'записей')}`}
        />
        <div className="flex flex-col gap-1.5 px-[18px] py-[13px]">
          <span className="text-[12.5px] leading-[1.5] text-tx">
            Показываем записную книжку этого проекта. Отсюда она не редактируется — её ведут в
            самом проекте.
          </span>
          <span className="text-[11.5px] leading-[1.5] text-tx2">
            {project.liveness === 'live'
              ? 'Связь живая: изменения в проекте попадают сюда сразу.'
              : 'Живая связь недоступна — вид обновляется по расписанию, а не мгновенно.'}
          </span>
        </div>
        {project.tags.length > 0 ? <TagCloud tags={project.tags} /> : null}
        {project.recent.length === 0 ? (
          <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
            Свежих записей в этом проекте нет.
          </p>
        ) : (
          project.recent.map((note, i) => <ProjectNoteRow key={note.id} note={note} first={i === 0} />)
        )}
      </div>

      {project.migratable ? (
        <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
          <CardHead
            title="Записи старого образца"
            note={migration ? `${migration.applicable} из ${migration.total}` : String(project.v1Count)}
          />
          <div className="flex flex-col gap-1.5 px-[18px] py-[13px]">
            <span className="text-[12.5px] leading-[1.5] text-tx">
              Часть записей этого проекта написана по старому образцу. Ниже — что именно
              изменится в каждой из них.
            </span>
            <span className="text-[11.5px] leading-[1.5] text-tx2">
              Ничего не применяется, пока Вы не скажете «да» по каждому файлу отдельно. Кнопки
              «применить всё» здесь нет намеренно.
            </span>
          </div>
          {migration && migration.files.length > 0 ? (
            migration.files.map((file, i) => <MigrationRow key={file.file} file={file} first={i === 0} />)
          ) : migration && migration.truncated ? (
            /* An empty list can mean two opposite things. This one means the daemon refused to
               build the preview on a poll, not that there is nothing to change. */
            <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
              В записной книжке этого проекта {migration.corpusNotes} записей — это больше, чем окно
              разбирает на лету ({migration.previewCap}). Разбор по файлам здесь не строится; перенос
              делается в самом проекте.
            </p>
          ) : (
            <p className="m-0 border-t border-bd px-[18px] py-4 text-[12.5px] text-tx2">
              Разбор ещё не готов — он появится при следующем чтении проекта.
            </p>
          )}
        </div>
      ) : null}
    </>
  )
}

export function Screen() {
  const state = useStateQuery()
  // The corpus does not move under the eye, so its two reads are not on the steady rhythm and
  // this one bell is how the screen learns that a terminal changed something.
  useMemoryBells()
  const memory = state.data?.memory
  const filled = memory && !memory.absent ? memory : null
  const projectMemory = state.data?.projectMemory
  const connected = projectMemory && !projectMemory.absent ? projectMemory : null
  /** The selected register entry when it names no folder — a project in the list, unreadable. */
  const active = (state.data?.projects ?? []).find((p) => p.id === state.data?.activeProject) ?? null
  const notConnected = !connected && active && active.connected === false ? active : null

  const noteCount = filled?.noteCount ?? 0
  const tags = filled?.tags ?? []
  const recent = filled?.recent ?? []

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-[58px] flex-none items-center gap-2.5 border-b border-bd bg-head px-7 backdrop-blur-[10px]">
        <h1 className="m-0 mr-2 flex-none text-[15px] font-semibold tracking-[-0.01em] text-tx">Память</h1>
        {filled ? (
          <>
            <Pill value={String(noteCount)} label={plural(noteCount, 'запись', 'записи', 'записей')} />
            <Pill value={String(tags.length)} label={plural(tags.length, 'тема', 'темы', 'тем')} />
            <Pill value={sizeLabel(filled.coreSize)} label="всегда под рукой" />
          </>
        ) : null}
      </header>

      <div className="flex flex-none items-center border-b border-bd px-7 py-3">
        <span className="text-[12.5px] text-tx2">
          Записная книжка проекта: сколько уроков накоплено, о чём они и что записано недавно.
        </span>
      </div>

      {state.isError ? (
        <div className="flex flex-none items-center gap-2.5 border-b border-warn-s bg-warn-s px-7 py-2.5">
          <span aria-hidden className="flex-none text-warn-tx">
            ●
          </span>
          <span className="text-[12.5px] text-tx">
            Связь потеряна. Показана записная книжка на момент последнего чтения.
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-6 pb-8">
        <div className="flex max-w-[900px] flex-col gap-[22px]">
          {filled ? (
            <>
              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="Что хранится" />
                <StoreRow
                  first
                  letter="З"
                  tone="bg-blue-s text-blue"
                  title="Записи проекта"
                  value={String(noteCount)}
                  desc="уроки, решения и устройство проекта: лежат внутри проекта и едут с ним на каждую Вашу машину"
                />
                <StoreRow
                  first={false}
                  letter="О"
                  tone="bg-ok-s text-ok-tx"
                  title="Оглавление"
                  value={sizeLabel(filled.coreSize)}
                  desc="то, что команда читает перед каждой работой: короткая выжимка, а не весь корпус"
                />
              </div>

              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="О чём записи" note={String(tags.length)} />
                <TagCloud tags={tags} />
              </div>

              <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
                <CardHead title="Записано недавно" note={String(recent.length)} />
                {recent.length === 0 ? (
                  <p className="m-0 px-[18px] py-4 text-[12.5px] text-tx2">
                    Свежих записей нет — за последнее время команда ничего нового не заносила.
                  </p>
                ) : (
                  recent.map((note, i) => <NoteRow key={note.id} note={note} first={i === 0} />)
                )}
                <div className="border-t border-bd bg-surf px-[18px] py-2.5 text-[11.5px] leading-[1.5] text-tx3">
                  Полный текст — в записной книжке проекта: окно показывает, что записано, и не
                  вычитывает содержимое.
                </div>
              </div>
            </>
          ) : (
            <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
              <CardHead title="Записная книжка" />
              <div className="flex flex-col gap-2 px-[18px] py-5">
                <span className="text-[13px] text-tx">
                  Записная книжка пока пустая — она будет наполняться Вашими уроками.
                </span>
                <span className="max-w-[640px] text-[11.5px] leading-[1.6] text-tx2">
                  Каждый разобранный случай команда записывает сама: ошибка превращается в урок,
                  урок видят все работники, и та же ошибка не повторяется.
                </span>
              </div>
            </div>
          )}

          {connected ? (
            <>
              <ConnectedProject project={connected} />
              {/* Whether «Записи старого образца» is on the glass is decided one line above; a
                  draft belonging to that panel is told where to go only when there is a there. */}
              <DraftsPanel migrationShown={connected.migratable === true} />
              <LintPanel />
              <IndexPanel />
            </>
          ) : notConnected ? (
            /* The register names a project; nothing on this machine says WHERE it is. Saying
               that plainly is the whole of this branch — the alternative was
               a screen naming a project it could not read one line of. */
            <div className="overflow-hidden rounded-[14px] border border-bd bg-card shadow-panel">
              <CardHead title={`Подключённый проект — ${notConnected.name}`} />
              <div className="flex flex-col gap-2 px-[18px] py-5">
                <span className="text-[13px] text-tx">У этого проекта не указана папка — читать нечего.</span>
                <span className="max-w-[640px] text-[11.5px] leading-[1.6] text-tx2">
                  Откройте «Машины и проекты» и подключите папку проекта на этой машине — записная
                  книжка появится здесь сама.
                </span>
              </div>
            </div>
          ) : null}

          <p className="m-0 max-w-[720px] text-[11.5px] leading-[1.6] text-tx3">
            Ничего не хранится у чужих сервисов. Всё у Вас: корпус лежит внутри проекта и едет с
            ним на Ваши машины.
          </p>
        </div>
      </div>
    </section>
  )
}
