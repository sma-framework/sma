/**
 * history-search.mjs — one search across the four books a working session leaves
 * behind: the coordination journal, the plan-execution journal, the vendor's
 * session transcripts and the lesson corpus.
 *
 * NO SECOND INDEX, DELIBERATELY. The transcripts on a working machine run to
 * hundreds of megabytes, and a native grep over all of them takes well under a
 * second — measured, not assumed. A derived full-text index over that pile would be
 * a second large artifact with its own staleness and its own repair, bought with
 * nothing: the scan is already fast enough. So this module streams. It never reads
 * a transcript file into memory, it walks the files newest-first, and it stops
 * opening them the moment the limit is met.
 *
 * NO SECOND READER EITHER. Every corpus here already had a reader before this file
 * existed, and each one is used: `readJournal` (tolerant parsing + merge order),
 * `exec-journal.read` (the same, per plan), `discoverLogsDir` (the env/DI/default
 * precedence for the vendor's log directory, fail-open on a missing one) and
 * `listNoteFiles` (the corpus enumeration the generator writes with). The one place
 * this file departs is the lesson BODY: `readNotes` projects a note onto its axis
 * and drops the prose, because the memory layer indexes the axis on purpose. History
 * is a different question — a word that lives only in a lesson's prose has to be
 * findable — so the note text is scanned whole, and `parseNote` is still the parser
 * that reads its fields.
 *
 * SECRETS. A transcript holds everything that was ever printed in a session, and a
 * search output would be a brand-new way to spill it. Every fragment this module
 * returns — from ALL FOUR books, not just the transcripts — passes through
 * `secretShaped`, the screen the product already carries, and a run that trips it is
 * replaced rather than printed. What that screen does NOT catch is stated in the
 * verb's own usage: short secrets and word-shaped passwords have no shape to
 * recognise. The honest promise is "credential-shaped runs are masked", not
 * "nothing sensitive can get through".
 *
 * THE LIMIT IS PER BOOK. A single total would let the fattest corpus — the
 * transcripts, by three orders of magnitude — crowd out every other source, and a
 * search that answers only from transcripts is the exact defect the caller cannot
 * see. So `limit` caps EACH source, and the printed report says so.
 *
 * НЕСКОЛЬКО ЗАПРОСОВ — ОДИН ПРОХОД. Спрашивающий часто задаёт не один вопрос, а
 * вопрос и его запасной вариант: не нашлось по трём словам — поискать по одному.
 * Двумя вызовами это стоит двух чтений всех четырёх книг за один ход человека, и
 * второе из них перечитывает ровно то же самое. Поэтому `query` принимает и СПИСОК
 * запросов: книги открываются ОДИН раз, каждая строка проверяется каждым зондом, и
 * выборки уезжают порознь (`perQuery`). Один запрос отвечается ровно как прежде,
 * буква в букву, — списочная форма ничего не добавляет к его ответу.
 *
 * Node built-ins only; every directory is dependency-injectable.
 */

import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

import { readJournal } from './journal.mjs'
import { read as readExecJournal } from './exec-journal.mjs'
import { discoverLogsDir } from './spend-adapter.mjs'
import { listNoteFiles } from './generator.mjs'
import { parseNote } from './frontmatter.mjs'
import { lexicalTokens } from './fts-index.mjs'
import { secretShaped } from './profile.mjs'
import { JOURNAL_DIR, EXEC_DIR } from './constants.mjs'

/** The four books, in the order the report groups them. */
export const HISTORY_SOURCES = Object.freeze(['journal', 'exec', 'lesson', 'transcript'])

/** Hits per book when the caller names no limit. */
export const DEFAULT_HISTORY_LIMIT = 20

/** Characters of context around the match in a printed fragment. */
const FRAGMENT_CHARS = 200

/**
 * The window that gets screened for secrets before the fragment is cut out of it.
 * Wide enough that a masked run can never be half-visible at the fragment's edge:
 * the fragment sits in the middle of this window, so an opaque run clipped by the
 * WINDOW's edge is a thousand characters away from anything that gets printed.
 */
const SCREEN_WINDOW = 1000

/** What a credential-shaped run is replaced by. Says a thing was hidden. */
export const SECRET_MASK = '▓▓▓скрыто▓▓▓'

/**
 * A matcher per query token. The tokenizer is the corpus's own (`lexicalTokens`),
 * so Cyrillic is a word here and `\w+` never gets a vote; the matcher asserts the
 * token stands on its own — «пели» must not find «пеликан», or the search would be
 * a substring grep wearing a tokenizer's name. Tokens are letters and digits only,
 * which is why they need no escaping.
 *
 * @param {string} query
 * @returns {{tokens: string[], matchers: RegExp[]}}
 */
export function historyMatchers(query) {
  const tokens = lexicalTokens(query)
  const matchers = tokens.map(
    (t) => new RegExp(`(?<![\\p{L}\\p{N}])${t}(?![\\p{L}\\p{N}])`, 'iu'),
  )
  return { tokens, matchers }
}

/**
 * The index of the earliest token match when EVERY token is present, else -1.
 * Running the regexes over the raw line (rather than tokenizing it) is what keeps a
 * multi-megabyte transcript line from becoming a multi-megabyte array.
 */
function matchIndex(line, matchers) {
  if (matchers.length === 0) return -1
  let first = -1
  for (const re of matchers) {
    const m = re.exec(line)
    if (!m) return -1
    if (first === -1 || m.index < first) first = m.index
  }
  return first
}

/**
 * maskSecrets(text) — replace every credential-shaped whitespace-free run.
 *
 * The unit is the run rather than the line: masking a whole line would delete the
 * history the caller asked to see, and masking nothing would spill it. A run that
 * trips the screen is replaced ENTIRELY, not partially revealed — half a token is
 * still a leak, and the four characters a prefix would save nobody.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskSecrets(text) {
  return String(text ?? '').replace(/\S+/g, (run) => (secretShaped(run) ? SECRET_MASK : run))
}

/**
 * ЗОНД — один запрос, идущий по книгам вместе с остальными.
 *
 * Проход по книге принадлежит книге, а не запросу: строка прочитана один раз и
 * предъявлена каждому зонду. Собственные находки у каждого свои — ими зонд и отличается
 * от соседа, — и хранятся они ПО КНИГАМ, потому что лимит тоже по книгам: общий счётчик
 * дал бы самой толстой книге вытеснить остальные, а её читают последней.
 *
 * @param {string[]} queries
 * @returns {Array<{query:string, tokens:string[], matchers:RegExp[], bySource:object}>}
 */
function makeProbes(queries) {
  return queries.map((q) => {
    const { tokens, matchers } = historyMatchers(q)
    return { query: q, tokens, matchers, bySource: { journal: [], exec: [], lesson: [], transcript: [] } }
  })
}

/**
 * Зонды, которым находки в ЭТОЙ книге ещё нужны: есть чем искать и лимит книги не добран.
 * Пустой список — повод закрыть книгу: ранняя остановка теперь общая, и она наступает
 * тогда, когда добрали ВСЕ, а не первый же.
 */
function hungry(probes, source, limit) {
  return probes.filter((p) => p.matchers.length > 0 && p.bySource[source].length < limit)
}

/**
 * One hit, built in ONE place — which is what makes the secret screen impossible to
 * route around. Every source calls this and no source formats its own fragment.
 */
function makeHit(source, file, ts, line, matchers) {
  const at = matchIndex(line, matchers)
  const centre = at < 0 ? 0 : at
  const windowStart = Math.max(0, centre - SCREEN_WINDOW)
  const screened = maskSecrets(line.slice(windowStart, centre + SCREEN_WINDOW))

  const inWindow = matchIndex(screened, matchers)
  const anchor = inWindow < 0 ? Math.min(centre - windowStart, screened.length) : inWindow
  const start = Math.max(0, anchor - Math.floor(FRAGMENT_CHARS / 2))
  let fragment = screened.slice(start, start + FRAGMENT_CHARS)
  if (windowStart + start > 0) fragment = `…${fragment}`
  if (windowStart + start + FRAGMENT_CHARS < line.length) fragment = `${fragment}…`
  return { source, file, ts, fragment: fragment.replace(/\s+/g, ' ').trim() }
}

/** Files of a directory, newest first — the order a person reads history in. */
function filesNewestFirst(dir, suffix) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return [] // a missing directory is an empty book, never an error
  }
  return names
    .filter((n) => typeof n === 'string' && n.endsWith(suffix))
    .map((n) => {
      const path = join(dir, n)
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        /* unreadable — sorts last, still listed */
      }
      return { name: n, path, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1))
}

/** An ISO moment from a file's own mtime — the honest fallback when a line has none. */
function mtimeIso(path) {
  try {
    return new Date(statSync(path).mtimeMs).toISOString()
  } catch {
    return null
  }
}

// ─────────────────────────── the four books ──────────────────────────────────

/**
 * The coordination journal. Read whole by its own reader — 189 small files on this
 * machine, against 654 MB of transcripts — and walked newest-first. The file a hit
 * came from is the terminal's own file: the module writes one file per terminal by
 * construction, which is why no second attribution is invented here.
 */
function scanJournal({ journalDir, probes, limit, onOpen }) {
  let events
  try {
    events = readJournal({ journalDir }).events
  } catch {
    return // fail-open: an unreadable journal is an empty book
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const want = hungry(probes, 'journal', limit)
    if (want.length === 0) break
    const evt = events[i]
    let line
    try {
      line = JSON.stringify(evt)
    } catch {
      continue
    }
    const file = evt && evt.terminal ? `${evt.terminal}.jsonl` : '(journal)'
    for (const p of want) {
      if (matchIndex(line, p.matchers) < 0) continue
      if (onOpen) onOpen(join(journalDir, file), 'journal')
      p.bySource.journal.push(makeHit('journal', join(journalDir, file), evt?.ts ?? null, line, p.matchers))
    }
  }
}

/** The plan-execution journal: one file per plan, read by the plan reader. */
function scanExec({ execDir, probes, limit, onOpen }) {
  for (const f of filesNewestFirst(execDir, '.jsonl')) {
    if (hungry(probes, 'exec', limit).length === 0) break
    const base = f.name.slice(0, -'.jsonl'.length)
    const cut = base.lastIndexOf('-')
    if (cut <= 0) continue
    if (onOpen) onOpen(f.path, 'exec')
    let events
    try {
      events = readExecJournal({ phase: base.slice(0, cut), plan: base.slice(cut + 1), execDir }).events
    } catch {
      continue
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const want = hungry(probes, 'exec', limit)
      if (want.length === 0) break
      const evt = events[i]
      let line
      try {
        line = JSON.stringify(evt)
      } catch {
        continue
      }
      for (const p of want) {
        if (matchIndex(line, p.matchers) < 0) continue
        p.bySource.exec.push(makeHit('exec', f.path, evt?.ts ?? null, line, p.matchers))
      }
    }
  }
}

/**
 * The lesson corpus, read WHOLE — fields and prose alike. Notes are kilobytes, so
 * a file read is right here and wrong on the transcript path; the difference is the
 * point, not an oversight. The moment is the note's own recorded date when it
 * carries one, and the file's mtime when it does not.
 */
function scanLessons({ corpusDir, probes, limit, onOpen }) {
  for (const name of listNoteFiles(corpusDir)) {
    if (hungry(probes, 'lesson', limit).length === 0) break
    const path = join(corpusDir, name)
    if (onOpen) onOpen(path, 'lesson')
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    let ts = null
    try {
      const fm = parseNote(text, { file: name }).frontmatter
      ts = fm?.recorded_at ?? fm?.observed_at ?? fm?.valid_from ?? null
    } catch {
      /* a note whose fields will not parse still has prose worth searching */
    }
    if (ts == null) ts = mtimeIso(path)
    for (const line of text.split('\n')) {
      const want = hungry(probes, 'lesson', limit)
      if (want.length === 0) break
      for (const p of want) {
        if (matchIndex(line, p.matchers) < 0) continue
        p.bySource.lesson.push(makeHit('lesson', path, ts, line, p.matchers))
      }
    }
  }
}

/** A line's own moment, cheaply — without parsing a megabyte of JSON to get it. */
const TRANSCRIPT_TS_RE = /"timestamp"\s*:\s*"([^"]{4,40})"/

/**
 * The session transcripts — the streaming one. Files are opened newest-first and
 * read LINE BY LINE; a single record here can be megabytes, and a whole-file read
 * over this book is the memory spike this module exists to avoid. The scan stops
 * OPENING files once the limit is met, so a narrow question never pays for the
 * whole pile.
 */
async function scanTranscripts({ logsDir, env, homedir, repoRoot, probes, limit, onOpen }) {
  const { dir, files } = discoverLogsDir({ env, logsDir, homedir, repoRoot })
  const ordered = files.length > 0 ? filesNewestFirst(dir, '.jsonl') : []

  for (const f of ordered) {
    if (hungry(probes, 'transcript', limit).length === 0) break
    if (onOpen) onOpen(f.path, 'transcript')
    const fallbackTs = mtimeIso(f.path)
    let stream
    try {
      stream = createReadStream(f.path, { encoding: 'utf8' })
    } catch {
      continue
    }
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const want = hungry(probes, 'transcript', limit)
        if (want.length === 0) break
        for (const p of want) {
          if (matchIndex(line, p.matchers) < 0) continue
          const m = TRANSCRIPT_TS_RE.exec(line)
          p.bySource.transcript.push(makeHit('transcript', f.path, m ? m[1] : fallbackTs, line, p.matchers))
        }
      }
    } catch {
      /* fail-open: an unreadable transcript is a shorter book, never an error */
    } finally {
      rl.close()
      stream.destroy()
    }
  }
  return { dir, filesTotal: ordered.length }
}

// ─────────────────────────── the search ──────────────────────────────────────

/**
 * searchHistory(opts) — the whole search, one call, four books.
 *
 * `query` — слово (или список слов-запросов, если спрашивающему нужен и запасной
 * вариант: тогда книги всё равно читаются один раз, а выборки едут в `perQuery`).
 *
 * `repoRoot` ВОЗВРАЩАЕТСЯ ВМЕСТЕ С НАХОДКАМИ. Пути в `hits` абсолютны, а показывать их
 * человеку нужно относительно дерева, книги которого открыли, — и это дерево знает
 * ЗДЕСЬ только вызывающий. Пока корень оставался входом и не выходил обратно, каждый
 * показывающий отмерял путь от того каталога, который знал сам; каталог демона и
 * подключённый проект — разные каталоги в обычном случае, и «относительный путь»
 * схлопывался в голое имя файла. Одна переменная у сборщика, один корень в ответе.
 *
 * @param {{
 *   query: string|string[],
 *   limit?: number,
 *   sources?: string[],
 *   journalDir?: string,
 *   execDir?: string,
 *   corpusDir?: string,
 *   logsDir?: string,
 *   env?: object,
 *   homedir?: string,
 *   repoRoot?: string,
 *   onOpen?: (path: string, source: string) => void,
 * }} opts
 * @returns {Promise<{query:string, tokens:string[], limit:number, sources:string[],
 *   hits:Array<{source:string,file:string,ts:string|null,fragment:string}>,
 *   perSource:object, transcriptsDir:string, transcriptFiles:number, repoRoot:string,
 *   perQuery?:object[]}>}
 */
export async function searchHistory(opts = {}) {
  const listed = Array.isArray(opts.query) ? opts.query : [opts.query]
  const queries = (listed.length > 0 ? listed : ['']).map((q) => String(q ?? ''))
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_HISTORY_LIMIT
  const asked = Array.isArray(opts.sources) && opts.sources.length > 0 ? opts.sources : HISTORY_SOURCES
  const sources = HISTORY_SOURCES.filter((s) => asked.includes(s))
  const probes = makeProbes(queries)

  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const execDir = opts.execDir ?? EXEC_DIR
  const corpusDir = opts.corpusDir ?? join('.claude', 'memory')
  const repoRoot = opts.repoRoot ?? process.cwd()
  const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null

  let transcriptsDir = ''
  let transcriptFiles = 0

  if (probes.some((p) => p.matchers.length > 0)) {
    if (sources.includes('journal')) scanJournal({ journalDir, probes, limit, onOpen })
    if (sources.includes('exec')) scanExec({ execDir, probes, limit, onOpen })
    if (sources.includes('lesson')) scanLessons({ corpusDir, probes, limit, onOpen })
    if (sources.includes('transcript')) {
      const t = await scanTranscripts({
        logsDir: opts.logsDir,
        env: opts.env ?? process.env,
        homedir: opts.homedir,
        repoRoot,
        probes,
        limit,
        onOpen,
      })
      transcriptsDir = t.dir
      transcriptFiles = t.filesTotal
    }
  }

  const answers = probes.map((p) => ({
    query: p.query,
    tokens: p.tokens,
    limit,
    sources,
    hits: HISTORY_SOURCES.flatMap((s) => p.bySource[s]),
    perSource: {
      journal: p.bySource.journal.length,
      exec: p.bySource.exec.length,
      lesson: p.bySource.lesson.length,
      transcript: p.bySource.transcript.length,
    },
    transcriptsDir,
    transcriptFiles,
    repoRoot,
  }))

  // Один запрос отвечается прежней формой, БЕЗ лишнего поля: `--json` этого верба —
  // печатаемая наружу поверхность, и удваивать её ради формы, которой не пользовались,
  // значило бы платить за список там, где списка не спрашивали.
  return answers.length > 1 ? { ...answers[0], perQuery: answers } : answers[0]
}
