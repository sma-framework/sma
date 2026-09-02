/**
 * backlog-scan.mjs — the BACKLOG.md intake edge.
 *
 * WHAT IT IS: the SECONDARY intake path. `parseBacklogContent` is a faithful JS port
 * of the origin project's backlog parser — SAME line
 * format, SAME structural ` — ` delimiter, SAME CRLF split, SAME «only under ##
 * Backlog» rule, and it NEVER throws. `scanBacklog` wraps it with a `git fetch` (so the
 * mini reads the founder's latest pushed BACKLOG, not a stale clone) + the DoR split +
 * a data-age label; `toTask` maps a ready line to the canonical task shape.
 *
 * INTAKE PRECEDENCE: the roster button is the PRIMARY
 * intake (expedite, founder-explicit); the BACKLOG scan is SECONDARY, run per cadence
 * (config.backlogScanMinutes, default 60) after a `git fetch`. The BACKLOG.md on the
 * mini is routinely stale (unpushed founder edits): the scan is age-labeled (dataAgeMs
 * from the last commit that touched BACKLOG.md) so the roster can show its freshness
 * rather than trusting a stale clone silently.
 *
 * THE DoR GATE: «без оценки задачу нельзя выдавать в
 * работу». An open, non-promoted line is only enqueued when it carries a valid `sp:N`
 * estimate ≤ 13 and nothing it declares a dependency on is still open. Three notReady classes
 * are SURFACED — in the log AND on the window's board (never silently dropped, never
 * enqueued):
 *   - no `sp:N` tag           → reason «нет оценки»
 *   - `sp:N` > 13             → reason «>13 SP, нужна декомпозиция» (the E-lite gate;
 *                               full decomposition via «Создатель» forge kind
 *                               'decompose' is deferred)
 *   - an open `deps:` card    → reason «ждёт зависимости: …»
 *
 * EXTERNAL INTAKE: the external intake bridge is DEFERRED post-pilot. Intake today is the
 * BACKLOG scan + the roster button only.
 *
 * ═══════ THE TRIAGE THE LINE ITSELF CARRIES ═══════
 *
 * A registry line says more than «how big»: it can name HOW URGENT it is (`priority:`), WHAT
 * IT WAITS FOR (`deps:`), and it usually spells its subject out in a sentence far longer than
 * a queue title holds. All three used to be read by nobody — measured on a live registry: the
 * urgency tags were invisible, so a critical line queued behind a trivial one; the dependency
 * tags were invisible, so a line was minted while what it waits for was still open; and 15 of
 * 17 estimated lines never reached the queue at all, refused by the gate with «название: N
 * знаков при потолке 200» and dropped in a log nobody reads. Triage lived on paper.
 *
 * So the reading of a line lives HERE, in ONE place, and both intake paths use it: the hourly
 * scan below, and the promote door of the window (through `deriveBacklog`, which asks the same
 * `readLineTags` / `headlineOf` / `queuePriority` / `intakeVerdict`). Two readers of one file
 * are two triages, and the quieter one wins by accident.
 *
 * AND A LONG SENTENCE IS NOT A REFUSAL. A title over the ceiling is CUT at its first phrase —
 * the rest becomes the description, the promise is split along the author's own `(а)(б)(в)`
 * markers rather than thrown away. Nothing a person wrote is lost; it just stops pretending to
 * be a one-line title.
 *
 * Node built-ins only where used at all; execGit / clock / fsImpl are dependency-
 * injected so the whole suite runs against fakes and never shells out or touches a repo.
 */

import { CAP_ACCEPTANCE_ITEMS, CAP_TEXT, CAP_TITLE } from '../queue/adapter.mjs'

/** `- [ ] **BL-007** · Title — desc …` (open) / `- [x] …` (closed). The id prefix is
 * the house's own registry name — an installed project mints its own series
 * (uppercase letters and digits, a dash, a number), and a scanner that only
 * knew one house's prefix read every other house's backlog as empty. The rest
 * of the line grammar is ported verbatim. */
const ITEM_RE = /^-\s+\[([ xX])\]\s+\*\*([A-Z][A-Z0-9]*-\d+)\*\*\s*(.*)$/

/** A `key:value` tag in backticks, e.g. `size:M` / `sp:3`. Ported verbatim. */
const TAG_RE = /`([a-z]+):([^`]+)`/gi

/** Size → priority: S is smallest+fastest, fetch it first. */
const SIZE_PRIORITY = Object.freeze({ S: 2, M: 1, L: 0 })

/**
 * `priority:critical|urgent|high` → the BAND a line rides in.
 *
 * Урочность старше размера, и это не вкус: маленькая приятная работа, обогнавшая критическую
 * потому что она маленькая, — ровно то, что реестр называл словом и чего машина не делала.
 * Слово, которого здесь нет (`priority:потом`), — это обычная работа, а не отказ: словарь
 * реестра ведёт человек, и незнакомая пометка не повод не брать строку вовсе.
 */
export const PRIORITY_BANDS = Object.freeze({ critical: 3, urgent: 2, high: 1 })

/**
 * Расстояние между полосами. Больше любого приоритета размера (S=2), поэтому размер остаётся
 * ВТОРЫМ ключом внутри полосы и не может перебросить строку через её границу.
 */
const BAND_STEP = 10

/** A dependency id — the SAME shape a registry line's own identifier has, and no vocabulary. */
const DEP_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/

/** The Fibonacci decomposition ceiling: anything above waits. */
const SP_CEILING = 13

/**
 * readLineTags(rest) → {text, tags}: the backtick tags pulled out, the words left behind.
 *
 * ONE tag reader for the whole product. The board of the window parses a line by its own
 * shape (a heading and prose are not rows), but WHAT THE TAGS SAY must be one answer, or the
 * board shows a line as ready that the scan refuses — and neither side would be wrong.
 *
 * @param {string} rest the line after its identifier
 * @returns {{text:string, tags:Record<string,string>}}
 */
export function readLineTags(rest) {
  const tags = {}
  const text = String(rest ?? '')
    .replace(TAG_RE, (_full, key, value) => {
      tags[String(key).toLowerCase()] = String(value).trim()
      return ''
    })
    .trim()
    // Drop a leading "· " / "• " decoration.
    .replace(/^[·•]\s*/, '')
    .trim()
  return { text, tags }
}

/**
 * depsOf(tags) → the ids a `deps:BL-007,BL-008` tag names, by SHAPE and with no vocabulary.
 * Anything that is not shaped like a registry identifier is not a dependency — a typo must
 * not become an invisible hold nobody can ever satisfy.
 */
export function depsOf(tags) {
  const raw = tags && typeof tags.deps === 'string' ? tags.deps : ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => DEP_ID_RE.test(s))
}

/**
 * queuePriority(item) → the ONE number a queue row rides at: urgency band first, size second.
 *
 * `claimNext` orders by a single number, so both facts are folded into one: the band times the
 * step, plus the size priority inside it. critical (30-32) > urgent (20-22) > high (10-12) >
 * ordinary (0-2), and a line with no urgency tag keeps EXACTLY the number it always had.
 */
export function queuePriority(item) {
  const band = PRIORITY_BANDS[String((item && item.priority) ?? '').toLowerCase()] ?? 0
  return band * BAND_STEP + (SIZE_PRIORITY[item && item.size] ?? 0)
}

/** Any text a task field takes is bounded — a cut says so out loud rather than reading whole. */
function capText(text, cap = CAP_TEXT) {
  const s = String(text ?? '')
  return s.length <= cap ? s : `${s.slice(0, cap - 1).trimEnd()}…`
}

/**
 * A leading parenthetical is a STATUS NOTE, not the subject. Registry lines are annotated in
 * front («(ЗАКРЫТ 02.09 …) · НАЗВАНИЕ …»), and cutting the title at the first bracket would
 * leave an empty headline. Balanced, so a note containing brackets survives.
 */
function afterLeadingNote(text) {
  if (!text.startsWith('(')) return { note: '', body: text }
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) {
        const body = text.slice(i + 1).replace(/^[\s·•]+/, '')
        return body === '' ? { note: '', body: text } : { note: text.slice(0, i + 1), body }
      }
    }
  }
  return { note: '', body: text }
}

/**
 * Где кончается ПЕРВАЯ ФРАЗА: точка (или «!»/«?»), закрывающая слово; открывающая скобка,
 * стоящая отдельным словом; либо секционное слово реестра «ЗАМЕРЕНО». Индекс нуля не
 * возвращается никогда — заголовок обязан остаться непустым.
 */
function phraseEnd(text) {
  const marks = []
  const dot = text.search(/[.!?](?=\s|$)/)
  if (dot > 0) marks.push(dot)
  const paren = text.indexOf(' (')
  if (paren > 0) marks.push(paren)
  const measured = text.indexOf('ЗАМЕРЕНО')
  if (measured > 0) marks.push(measured)
  return marks.length > 0 ? Math.min(...marks) : -1
}

/**
 * headlineOf(text, cap) → {title, tail}: заголовок в пределах потолка и всё, что за ним.
 *
 * ДЛИННОЕ НАЗВАНИЕ — НЕ ПОВОД ОТКАЗАТЬ. Строка реестра пишется абзацем: название заглавными,
 * скобка с обстоятельствами, «ЗАМЕРЕНО: …», «ЧТО ПОСТРОИТЬ: (а)…». Ворота очереди меряют
 * ЗАГОЛОВОК — это строка, а не документ, — и на живом реестре отказывали 15 карточкам из 17.
 * Здесь абзац разбирается на то, чем он и является: первая фраза — заголовок, остальное —
 * описание. Ни одного слова не теряется.
 *
 * Текст, который в потолок ВЛЕЗАЕТ, не трогается вовсе: разбор — это лечение длины, а не
 * второе правило грамматики строки.
 *
 * @param {string} text
 * @param {number} [cap]
 * @returns {{title:string, tail:string}}
 */
export function headlineOf(text, cap = CAP_TITLE) {
  const whole = String(text ?? '').trim()
  if (whole.length <= cap) return { title: whole, tail: '' }

  const { note, body } = afterLeadingNote(whole)
  const at = phraseEnd(body)
  let title = at > 0 ? body.slice(0, at).trim() : body
  const parts = at > 0 ? [body.slice(at).trim()] : []

  // Первая фраза сама длиннее потолка — режется по слову, и многоточие говорит об этом вслух.
  if (title.length > cap) {
    let kept = title.slice(0, cap - 1).replace(/\s+\S*$/, '')
    if (kept === '') kept = title.slice(0, cap - 1)
    parts.unshift(title.slice(kept.length).trim())
    title = `${kept.trimEnd()}…`
  }
  // Приписка из головы строки едет В КОНЕЦ описания: она про состояние работы, а не про суть.
  if (note !== '') parts.push(note)

  return { title, tail: parts.filter((s) => s !== '').join(' ').trim() }
}

/**
 * Маркер пункта обещания, поставленный АВТОРОМ: «(а)», «(б)», «(1)». Только отдельным словом —
 * скобка внутри фразы границей не становится.
 */
const PROMISE_MARK = /(?:^|\s)\((?:[а-яёa-z]|\d{1,2})\)\s/gi

/**
 * promiseOf(text) → признаки успеха: строкой, пока они в потолок влезают, и СПИСКОМ, когда
 * нет.
 *
 * ЗАМЕРЕНО на живом реестре: одна карточка отказана словами «признаки успеха: 3111 знаков при
 * потолке 2000» и не попала в очередь вовсе. Обещание при этом было написано по пунктам —
 * «(а)… (б)… (в)…» — то есть автор границы уже расставил, и резать по ним не значит выдумывать
 * за него. Пунктов больше дюжины — хвост сворачивается в последний, а не выбрасывается.
 *
 * Текст без единого маркера подрезается по потолку с многоточием: обещание, укороченное вслух,
 * честнее задачи, которой нет в очереди.
 *
 * @param {string} text
 * @returns {string|string[]}
 */
export function promiseOf(text) {
  const whole = String(text ?? '').trim()
  if (whole.length <= CAP_TEXT) return whole

  const cuts = []
  PROMISE_MARK.lastIndex = 0
  for (let m = PROMISE_MARK.exec(whole); m; m = PROMISE_MARK.exec(whole)) {
    const at = m[0].startsWith('(') ? m.index : m.index + 1
    if (at > 0) cuts.push(at)
    PROMISE_MARK.lastIndex = m.index + m[0].length - 1
  }
  if (cuts.length === 0) return capText(whole)

  const items = []
  let from = 0
  for (const cut of cuts) {
    if (cut > from) items.push(whole.slice(from, cut).trim())
    from = cut
  }
  items.push(whole.slice(from).trim())

  const kept = items.filter((s) => s !== '')
  if (kept.length <= CAP_ACCEPTANCE_ITEMS) return kept.map((s) => capText(s))
  const head = kept.slice(0, CAP_ACCEPTANCE_ITEMS - 1).map((s) => capText(s))
  return [...head, capText(kept.slice(CAP_ACCEPTANCE_ITEMS - 1).join(' '))]
}

/**
 * intakeVerdict(item, openIds) → {ready, reason}: берётся ли строка в очередь, и если нет —
 * ПОЧЕМУ, словами человека.
 *
 * ОДНИ ВОРОТА НА ОБА ЧИТАТЕЛЯ. Скан решает этим, что минтить; доска окна показывает этим же,
 * почему строка стоит. Пустая причина означает «это вообще не про выдачу» — закрытая карточка
 * и карточка, увезённая в фазу, не отказ, и говорить о них на доске нечего.
 *
 * `openIds` — идентификаторы ОТКРЫТЫХ строк реестра. Зависимость, которой в реестре нет,
 * не держит: «названа и открыта» и «названа неизвестно кем» — разные факты, и придуманное
 * ожидание остановило бы работу навсегда и молча.
 *
 * @param {object} item a parseBacklogContent item
 * @param {Set<string>|null} [openIds]
 * @returns {{ready:boolean, reason:string}}
 */
export function intakeVerdict(item, openIds = null) {
  if (!item || typeof item !== 'object') return { ready: false, reason: '' }
  if (!item.open) return { ready: false, reason: '' } // closed → out of intake
  if (item.phase) return { ready: false, reason: '' } // promoted to a real phase → a phase card
  if (item.storyPoints == null) return { ready: false, reason: 'не готово к выдаче: нет оценки' }
  if (item.storyPoints > SP_CEILING) return { ready: false, reason: '>13 SP, нужна декомпозиция' }
  const waiting = (Array.isArray(item.deps) ? item.deps : []).filter(
    (id) => id !== item.id && openIds instanceof Set && openIds.has(id),
  )
  if (waiting.length > 0) {
    return { ready: false, reason: `ждёт зависимости: ${waiting.join(', ')} — ещё открыта в реестре` }
  }
  return { ready: true, reason: '' }
}

/**
 * structuralDash(text) → тот самый ` — `, который делит строку на название и пояснение, —
 * взятый ВНЕ скобок и кавычек.
 *
 * ГРАММАТИКА ПОРТИРОВАНА, НО ТИРЕ БЫВАЕТ И ВНУТРИ ФРАЗЫ. Замерено на живом реестре: у карточки
 * с приписной скобкой в голове строки («(ЧАСТЬ СЕЛА …, работа флота … — слито …) · НАЗВАНИЕ»)
 * первое тире попадало ВНУТРЬ этой скобки, и заголовком строки очереди становился обрывок
 * приписки — открытая скобка, дата и хеш коммита. Название карточки при этом лежало дальше по
 * строке и до очереди не доезжало вовсе.
 *
 * Поэтому делит только тире на нулевой глубине: скобки и «ёлочки» считаются, и тире внутри них
 * остаётся частью фразы, которой оно и является. Ничего не найдено — строка целиком название,
 * ровно как и раньше.
 */
function structuralDash(text) {
  let depth = 0
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === '«') quoted = true
    else if (ch === '»') quoted = false
    else if (depth === 0 && !quoted && (ch === '—' || ch === '–' || ch === '-')) {
      if (i > 0 && /\s/.test(text[i - 1]) && i + 1 < text.length && /\s/.test(text[i + 1])) {
        return { index: i - 1, length: 3 }
      }
    }
  }
  return null
}

/**
 * parseBacklogContent(raw) → BacklogItem[]. A faithful port of the origin project's parser:
 * only lines under `## Backlog` are read; the trailing backtick tags are pulled out
 * first; title/description split on the first space-delimited dash. Adds `open`
 * (checkbox), `storyPoints` (the `sp:N` tag as a number, else null), `priority` (the urgency
 * word the line names, else null) and `deps` (the ids it waits for). Never throws.
 *
 * @param {string} raw
 * @returns {Array<{id:string,title:string,description:string,open:boolean,size:(string|null),area:(string|null),added:(string|null),phase:(string|null),storyPoints:(number|null),priority:(string|null),deps:string[]}>}
 */
export function parseBacklogContent(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return []
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
  const items = []
  let inBacklog = false

  for (const line of lines) {
    if (/^##\s+Backlog\b/i.test(line)) {
      inBacklog = true
      continue
    }
    if (/^##\s+/.test(line) && !/^##\s+Backlog\b/i.test(line)) {
      inBacklog = false
      continue
    }
    if (!inBacklog) continue

    const m = line.match(ITEM_RE)
    if (!m) continue

    const open = m[1].toLowerCase() !== 'x'
    const id = m[2]

    // Pull the trailing backtick tags out first so they don't pollute title/desc — through the
    // ONE tag reader, the same one the window's board asks.
    const { text: rest, tags } = readLineTags(m[3])

    // Split title — description on the first dash surrounded by spaces (structural ` — `),
    // taken OUTSIDE brackets: см. structuralDash.
    let title = rest
    let description = ''
    const dash = structuralDash(rest)
    if (dash) {
      title = rest.slice(0, dash.index).trim()
      description = rest.slice(dash.index + dash.length).trim()
    }

    const spNum = tags.sp !== undefined ? Number.parseInt(tags.sp, 10) : NaN

    items.push({
      id,
      title,
      description,
      open,
      size: tags.size ?? null,
      area: tags.area ?? null,
      added: tags.added ?? null,
      phase: tags.phase ?? null,
      storyPoints: Number.isFinite(spNum) ? spNum : null,
      priority: tags.priority ?? null,
      deps: depsOf(tags),
    })
  }

  return items
}

/**
 * laneForItem(item) → the execution lane heuristic (documented, deterministic —
 * The `— why` sentence + area drive it:
 *   - research  — a research-flavoured line (title/desc signals исследование/research)
 *   - paperwork — governance/os area or a .planning/docs-only line (no prod code)
 *   - prod      — everything else (the default; incl. size:S + area:tech)
 * Roster/return tasks bypass this — they carry their own lane.
 */
function laneForItem(item) {
  const text = `${item.title} ${item.description}`.toLowerCase()
  if (/ресёрч|ресерч|research|исслед|изуч/.test(text)) return 'research'
  const area = (item.area ?? '').toLowerCase()
  if (area === 'governance' || area === 'os' || /\.planning|документ|docs-only/.test(text)) return 'paperwork'
  return 'prod'
}

/**
 * toTask(item, {project}) → the canonical task shape (adapter.mjs TASK SHAPE) for a READY
 * backlog line. lane from the size/area heuristic; source 'backlog'; priority from the
 * urgency band and the size inside it (`queuePriority`); storyPoints from the `sp:N` tag;
 * acceptance from the post-delimiter detail sentence (the ` — what & why` part) — the DoD
 * contract the worker reads. Falls back to the title when a line carries no detail so
 * acceptance is never empty (validateTask requires it for backlog).
 *
 * A LONG LINE IS SPLIT, NOT REFUSED: `headlineOf` keeps the first phrase as the title and
 * hands the rest to the description, and `promiseOf` cuts an over-long promise along the
 * author's own `(а)(б)(в)` markers instead of letting the gate throw the whole line away.
 *
 * THE PROJECT IS STAMPED HERE because this is the only moment it is knowable: the scan reads
 * ONE project's `.planning/BACKLOG.md`, so a line out of that file is that project's work.
 * Unstamped rows are what made finished fleet work invisible to the day's screen — a filter
 * of one project cannot show a row that names none.
 *
 * @param {object} item  a parseBacklogContent item
 * @param {{project?:string}} [stamp]
 * @returns {object} a canonical task
 */
export function toTask(item, { project } = {}) {
  if (!item || typeof item !== 'object') throw new Error('toTask: item is required')
  const cut = headlineOf(String(item.title ?? ''), CAP_TITLE)
  const detail = item.description && String(item.description).trim() ? String(item.description).trim() : ''
  const rest = [cut.tail, detail].filter((s) => s !== '').join(' ').trim()
  return {
    id: item.id,
    source: 'backlog',
    title: cut.title,
    lane: laneForItem(item),
    priority: queuePriority(item),
    storyPoints: item.storyPoints ?? undefined,
    acceptance: promiseOf(rest !== '' ? rest : cut.title),
    ...(cut.tail !== '' ? { description: capText(cut.tail) } : {}),
    ...(typeof project === 'string' && project !== '' ? { project } : {}),
  }
}

/**
 * scanBacklog({repoDir, execGit, clock, fsImpl, project}) → {items, notReady, dataAgeMs}.
 *
 * (1) `git fetch` via the injected execGit (freshness on the mini); a fetch
 *     failure (offline) is swallowed, the LOCAL BACKLOG is still read.
 * (2) read `<repoDir>/.planning/BACKLOG.md` via the injected fsImpl.
 * (3) parse; keep open, non-phase-promoted lines as intake candidates.
 * (4) the intake gate (`intakeVerdict`, shared with the window's board): a valid `sp:N` ≤ 13
 *     with no OPEN dependency → a ready task (toTask); no tag → notReady «нет оценки»;
 *     `sp:N` > 13 → notReady «>13 SP, нужна декомпозиция»; a named card still open in the
 *     registry → notReady «ждёт зависимости: …». No notReady class is EVER placed in `items`.
 * (5) dataAgeMs from the last commit that touched BACKLOG.md (the roster's age label).
 *
 * @param {{repoDir:string, execGit:(args:string[])=>string, clock?:()=>number, fsImpl?:{readFileSync:Function}, project?:string}} deps
 * @returns {Promise<{items:object[], notReady:Array<{id:string,title:string,reason:string}>, dataAgeMs:(number|null)}>}
 */
export async function scanBacklog({ repoDir, execGit, clock = Date.now, fsImpl, project } = {}) {
  if (typeof execGit !== 'function') throw new Error('scanBacklog requires an execGit function')
  const read = fsImpl && typeof fsImpl.readFileSync === 'function' ? fsImpl.readFileSync : null
  if (!read) throw new Error('scanBacklog requires fsImpl.readFileSync')

  // (1) freshness — best-effort fetch; never fatal (offline mini still scans local).
  try {
    execGit(['fetch', '--quiet'])
  } catch {
    /* offline — fall through to the local BACKLOG (labeled with its age) */
  }

  // (2) read the local BACKLOG.md (fail-open to an empty scan).
  const backlogPath = `${repoDir}/.planning/BACKLOG.md`
  let raw = ''
  try {
    raw = read(backlogPath, 'utf8')
  } catch {
    return { items: [], notReady: [], dataAgeMs: null }
  }

  // (3)+(4) parse + the intake gate.
  const parsed = parseBacklogContent(raw)
  // ЧТО В РЕЕСТРЕ ЕЩЁ ОТКРЫТО — собирается ОДИН раз, до ворот: зависимость читается против
  // всего файла, а не против того куска, до которого дошёл цикл.
  const openIds = new Set(parsed.filter((i) => i.open).map((i) => i.id))
  const items = []
  const notReady = []
  for (const item of parsed) {
    const verdict = intakeVerdict(item, openIds)
    if (verdict.ready) {
      items.push(toTask(item, { project }))
      continue
    }
    // Причина едет ЗАГОЛОВКОМ, а не абзацем: её читают человек на доске и строка журнала.
    if (verdict.reason !== '') {
      notReady.push({ id: item.id, title: headlineOf(item.title, CAP_TITLE).title, reason: verdict.reason })
    }
  }

  // (5) data-age label from the last commit touching BACKLOG.md.
  let dataAgeMs = null
  try {
    const out = String(execGit(['log', '-1', '--format=%ct', '--', '.planning/BACKLOG.md'])).trim()
    const ts = Number.parseInt(out, 10)
    if (Number.isFinite(ts)) dataAgeMs = clock() - ts * 1000
  } catch {
    /* no git history for the file — leave the age unknown (null) */
  }

  return { items, notReady, dataAgeMs }
}
