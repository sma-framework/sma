/**
 * search.mjs — ONE QUESTION, EVERY CORPUS: the projection layer behind GET /api/search.
 *
 * ═══════════════════════ THE HONEST FOUNDATION ═══════════════════════════════════
 * There is no index over «everything» in this product and this module does not pretend
 * to build one. What exists is a lexical layer over the MEMORY axis — one corpus, one
 * projection, its own BM25 fallback — and four other bodies of knowledge that have no
 * retrieval layer at all: the screens of the window, the queue, the registries, and the
 * attempts. So the shape here is a PROJECTOR PER SOURCE: five small functions, each one
 * turning what its source already knows into the SAME three-part answer —
 *
 *     what is it (title) · when do you need it (hint) · where does it live (ref)
 *
 * — and one ranking over the union. That axis is not invented here: it is the axis the
 * memory corpus is written on, and using it for screens and tasks too is what makes a
 * single result list readable instead of five lists stacked.
 *
 * ═══════════════════════ WHY THE MEMORY PROJECTOR READS NOTHING ══════════════════
 * The memory source is the ONE source with a real retrieval layer, and this module does
 * not touch it directly: the reading arrives injected. That is the lexical layer's own
 * first law — «one read path» — and a retriever with its own idea of what a note is is a
 * SECOND READ PATH, which is the anti-pattern that layer's header names out loud. It also
 * follows the split every read model in this front already makes: the shaping lives where
 * a test can drive it, the reading lives with whoever owns the files.
 *
 * NOTE BODIES ARE NEVER READ, here or below. The axis carries the claim, the trigger and
 * the areas, and that is what a hit is made of. Reaching past the axis for a body would be
 * that second read path in its most tempting form.
 *
 * ═══════════════════════ THE VISIBILITY FILTER IS A READ-TIME FILTER ═════════════
 * Every projector passes its rows through ONE filter before they can become a hit, and it
 * runs at READ time — not at index time, not at write time. The reason is the reason the
 * lexical layer gives for keeping its own: an index (or a cached projection, or a list
 * somebody assembled last week) that is the only thing standing between a withheld record
 * and a payload is one bug away from disclosing it. So the filter stands on TOP of
 * whatever the source already did, and it is cheap enough to be unconditional.
 *
 * The stronger half of the same guarantee is not a filter at all: every projector
 * EXPLICIT-PICKS the two or three fields it searches and shows. A token, a value, a
 * connection string or an env var's content is not «filtered out» — it is never read, so
 * there is no field for it to leak through and no rule anybody can forget to apply.
 *
 * ═══════════════════════ A REF IS A PLACE IN THE WINDOW ══════════════════════════
 * `ref` says where a hit LEADS, and every leg of it is a navigational identity — a screen
 * id, a task id, a note's name, an attempt's id. It is never a path: this process's
 * directory layout is its own business, and a result list is exactly the surface where a
 * path would travel furthest with the least thought.
 *
 * PURE and injectable throughout: every projector takes data, `createSearch` takes readers,
 * and the clock is not needed at all. Zero imports — this module is a leaf, like the
 * journal beside it, so anything may depend on it without inverting a layer.
 */

/** The kinds a hit can be — the same closed set the declared client contract carries. */
export const SEARCH_KINDS = Object.freeze(['screen', 'task', 'note', 'rule', 'agent', 'attempt'])

/** The longest question this surface will consider. A search box is not an upload channel. */
export const SEARCH_QUERY_CAP = 256

/** How many hits one answer carries when the caller names no number. */
export const SEARCH_LIMIT_DEFAULT = 20

/** The ceiling on one answer — a growing corpus can never become a growing response. */
export const SEARCH_LIMIT_MAX = 50

/** How many rows one projector may contribute before ranking — a bound per source, so one
 *  loud corpus cannot crowd the other four out of the list entirely. */
export const PER_SOURCE_CAP = 25

/** Title / hint caps: a hit is a line a person reads, never a document. */
const TITLE_CAP = 200
const HINT_CAP = 300

/**
 * THE SCREENS OF THE WINDOW — this module's own constant, and the palette's source of truth.
 *
 * WHY IT IS DECLARED HERE AND NOT READ FROM THE APP. The window's registry is TypeScript
 * that imports React components; this process could not read it without building the app,
 * and a daemon that needs a bundler to answer a question would be a worse thing than a
 * second list. So the list is stated here — and kept honest the way every other duplicated
 * declaration in this front is kept honest: by a test that reads the app's registry as TEXT
 * and asserts neither side ever grows a screen the other has not heard of.
 *
 * The `hint` is this file's own contribution and belongs nowhere else: a sidebar shows a
 * NAME, and a name is what you can already find. What a search needs is the answer to «when
 * would I need this» — which is the same «use-when» axis the memory corpus is written on.
 */
export const SEARCH_SCREENS = Object.freeze([
  { id: 'today', title: 'Сегодня', hint: 'что происходит прямо сейчас: работа, вопросы, деньги' },
  { id: 'tasks', title: 'Задачи', hint: 'очередь целиком: что ждёт, что идёт, что просит одобрения' },
  { id: 'team', title: 'Команда', hint: 'кто работает: исполнители, их окна и модели' },
  { id: 'live-stream', title: 'Живой поток', hint: 'что исполнитель говорит прямо сейчас, строка за строкой' },
  { id: 'chat', title: 'Разговор', hint: 'спросить систему словами и поставить работу без формы' },
  { id: 'costs', title: 'Расходы', hint: 'сколько потрачено, на что, и где стоит потолок' },
  { id: 'rules', title: 'Правила', hint: 'чем система себя ограничивает и какие рефлексы сработали' },
  { id: 'style', title: 'Мой стиль', hint: 'чему система научилась о том, как вы принимаете решения' },
  { id: 'pipeline', title: 'Конвейер фаз', hint: 'фаза целиком: обсуждение, план, исполнение, проверка' },
  { id: 'backlog', title: 'Бэклог', hint: 'список «потом» как доска — и одна строка в очередь' },
  { id: 'coordination', title: 'Координация', hint: 'кто ещё в этом чекауте, что забронировано, где столкновения' },
  { id: 'search', title: 'Поиск', hint: 'один вопрос ко всем корпусам сразу' },
  { id: 'ship', title: 'Выкат', hint: 'ворота релиза и публикация — самое опасное действие продукта' },
  { id: 'agents', title: 'Агенты', hint: 'помощники: включить, выключить, привести своих' },
  { id: 'skills', title: 'Навыки', hint: 'умения, которые исполнители могут применить' },
  { id: 'memory', title: 'Память', hint: 'корпус уроков проекта, черновики и индекс' },
  { id: 'accounts', title: 'Аккаунты', hint: 'подписки и ключи, из которых система берёт окна' },
  { id: 'connections', title: 'Подключения', hint: 'какой проект подключён и что о нём видно' },
  { id: 'machines', title: 'Машины и проекты', hint: 'другие машины и проекты, которыми правит это окно' },
  { id: 'system', title: 'Дом системы', hint: 'версия, обновление, диагностика самой системы' },
  { id: 'task-card', title: 'Карточка задачи', hint: 'одна задача целиком: попытки, решения, отличия' },
  { id: 'import-wizard', title: 'Привести своих', hint: 'перенести чужих агентов и навыки в этот дом' },
  { id: 'first-run', title: 'Первый запуск', hint: 'знакомство с системой — один раз, в самом начале' },
])

// ── the shared grammar: what «matches», and how strongly ─────────────────────────

/**
 * normalizeQuery(q) → the question as this module will use it: trimmed, single-line,
 * capped and lowercased. An over-long question is CUT rather than refused here — the door
 * above owns the refusal, and a pure function that threw would make every projector a
 * try/catch site.
 */
export function normalizeQuery(q) {
  const s = String(q ?? '')
    .replace(/\r?\n/g, ' ')
    .trim()
  return (s.length > SEARCH_QUERY_CAP ? s.slice(0, SEARCH_QUERY_CAP) : s).toLowerCase()
}

/** A bounded single-line display string. */
function text(value, cap) {
  const s = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .trim()
  return s.length > cap ? s.slice(0, cap) : s
}

/**
 * RANKS — «точное вхождение > префикс > подстрока», as three named numbers rather than
 * three magic integers scattered through five projectors. Higher is better on every path,
 * including the memory layer's own score, which is normalized into the same direction
 * before it is compared with anything (two opposite conventions in one sorted list is how a
 * ranking silently runs backwards).
 */
export const MATCH_RANKS = Object.freeze({ EXACT: 3, PREFIX: 2, SUBSTRING: 1, NONE: 0 })

/**
 * Russian inflection endings, longest first. «Память» and «памяти» are one word to a
 * person and were two strings to this module (QA finding D7, 11.08.2026): the search
 * matched letters, not words. A real morphology engine is not worth its weight here; what
 * is worth it is the cheap truth that Russian mostly inflects at the TAIL — so the query
 * gets a stemmed VARIANT (ending stripped, stem ≥ 4 chars) that matches as a SUBSTRING.
 * English is untouched: its endings are not in the list, and the exact/prefix/substring
 * ladder above the variant behaves exactly as before.
 */
const RU_ENDINGS = [
  'иями', 'ями', 'ами', 'иях', 'ях', 'ах', 'ией', 'ей', 'ой', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее',
  'ов', 'ев', 'ие', 'ье', 'ия', 'ья', 'ию', 'ью', 'ем', 'ом', 'им', 'ым', 'ах', 'ух', 'ть',
  'а', 'я', 'о', 'е', 'у', 'ю', 'ы', 'и', 'й', 'ь',
]

/** The stem variant of one lowercased word, or null when stripping would maim it. */
function ruStem(word) {
  if (!/[а-яё]$/i.test(word)) return null
  for (const end of RU_ENDINGS) {
    if (word.length - end.length >= 4 && word.endsWith(end)) return word.slice(0, word.length - end.length)
  }
  return null
}

/**
 * matchRank(query, ...fields) → the STRONGEST rank any of the given fields earns.
 *
 * The fields are the ones a projector chose to expose, and that choice is the security
 * boundary — see the header. This function does not know where a string came from and must
 * never be handed a whole record «so it can look everywhere».
 *
 * The exact spelling always outranks the stem: «памяти» typed verbatim still wins as an
 * exact/prefix hit; the stem variant only ADDS substring hits the letters missed.
 */
export function matchRank(query, ...fields) {
  const q = normalizeQuery(query)
  if (!q) return MATCH_RANKS.NONE
  const stem = ruStem(q)
  let best = MATCH_RANKS.NONE
  for (const field of fields) {
    const value = String(field ?? '')
      .trim()
      .toLowerCase()
    if (!value) continue
    if (value === q) return MATCH_RANKS.EXACT // nothing beats it; stop looking
    if (value.startsWith(q)) best = Math.max(best, MATCH_RANKS.PREFIX)
    else if (value.includes(q)) best = Math.max(best, MATCH_RANKS.SUBSTRING)
    else if (stem && value.includes(stem)) best = Math.max(best, MATCH_RANKS.SUBSTRING)
  }
  return best
}

/**
 * THE READ-TIME VISIBILITY FILTER, in one place.
 *
 * A row is withheld when the source that produced it says so, under any of the three words
 * the corpora in this product actually use. It is deliberately a DENY on the mere presence
 * of a signal rather than an allow on its absence: a source that grows a fourth word for
 * «not for showing» should fail closed here until somebody teaches this function the word.
 */
export function isShowable(row) {
  if (!row || typeof row !== 'object') return false
  if (row.hidden === true) return false
  if (row.secret === true) return false
  if (row.visible === false) return false
  return true
}

/** One hit, assembled the only way a hit is ever assembled. */
function hit(kind, { title, hint, ref, rank, score = 0 }) {
  return {
    kind,
    title: text(title, TITLE_CAP),
    hint: text(hint, HINT_CAP),
    ref,
    _rank: rank,
    _score: Number.isFinite(Number(score)) ? Number(score) : 0,
  }
}

/**
 * A note's navigational name: the STEM of its file, with any directory dropped.
 *
 * The lexical layer identifies a record by its file name because that is what the corpus
 * is made of. A window identifies it by the same name minus the extension — which is also
 * the name the corpus screen shows and the apply door already takes. Dropping the directory
 * is not decoration: it is the one line that keeps this process's layout out of a payload.
 */
export function noteIdOf(file) {
  const flat = String(file ?? '')
    .split(/[\\/]/)
    .pop()
  return flat.replace(/\.mdx?$/i, '')
}

// ── the five projectors: one per source, each one a function ─────────────────────

/**
 * (1) SCREENS — the window's own map, out of this module's constant.
 *
 * This is the projector that makes the box usable on day one: a person who does not yet
 * know the product asks it for a word and learns which room the word lives in.
 */
export function projectScreens(query, { screens = SEARCH_SCREENS } = {}) {
  const out = []
  for (const s of screens) {
    if (!isShowable(s)) continue
    const rank = matchRank(query, s.title, s.hint, s.id)
    if (rank === MATCH_RANKS.NONE) continue
    out.push(hit('screen', { title: s.title, hint: s.hint, ref: { screen: s.id }, rank }))
    if (out.length >= PER_SOURCE_CAP) break
  }
  return out
}

/**
 * (2) TASKS — the queue, as the queue already knows it.
 *
 * Three fields and no fourth: the id, the title a person typed, and the status. A task's
 * `data` envelope is NOT read — it is the queue's own working record and can carry a
 * worker's note, a stage's document name or whatever a later revision puts there, and a
 * search box is precisely the wrong place to find out.
 */
export function projectTasks(query, { rows = [], statusLabel } = {}) {
  const label = typeof statusLabel === 'function' ? statusLabel : (s) => String(s ?? '')
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isShowable(row)) continue
    const id = String((row && row.id) || '')
    const title = String((row && row.title) || '')
    if (!id) continue
    const rank = matchRank(query, title, id)
    if (rank === MATCH_RANKS.NONE) continue
    out.push(hit('task', { title: title || id, hint: label(row.status), ref: { taskId: id }, rank }))
    if (out.length >= PER_SOURCE_CAP) break
  }
  return out
}

/**
 * (3) MEMORY — the axis of the corpus, ranked by the layer that owns it.
 *
 * The rows arrive from the injected reader, already ranked and already filtered by that
 * layer's own read-time filters. Both facts are re-checked rather than trusted: the
 * visibility filter runs again here (the header says why), and the ordering is re-derived
 * from `score` so a reader that hands rows back in arrival order cannot quietly become the
 * ranking.
 *
 * A row that carries no score at all (the exact layer answers with a basis, not a number)
 * still ranks: it falls through to the same textual grammar every other source uses.
 *
 * RELEVANCE IS THAT LAYER'S VERDICT AND IS NOT RE-JUDGED HERE. A row it returned is a row it
 * matched, on an axis (the claim, the trigger, the areas, the path facet) that is deliberately
 * wider than the two strings a hit shows — so re-testing the row against the question with
 * this file's own grammar would silently throw away the half of retrieval the corpus is
 * written for. What this projector owns instead is the SHAPE, the visibility re-check and the
 * explicit pick: whatever else a row carries, a hit is a name, a trigger and a place.
 */
export function projectNotes(query, { notes = [] } = {}) {
  const out = []
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!isShowable(note)) continue
    const file = String((note && (note.file ?? note.id)) || '')
    if (!file) continue
    const title = String((note && note.title) || '') || noteIdOf(file)
    const hint = String((note && note.hint) || '')
    const scored = Number.isFinite(Number(note.score)) && Number(note.score) > 0
    const rank = scored ? MATCH_RANKS.SUBSTRING : matchRank(query, title, hint, noteIdOf(file))
    if (rank === MATCH_RANKS.NONE) continue
    out.push(
      hit('note', {
        title,
        hint,
        ref: { noteId: noteIdOf(file) },
        // A textual exact/prefix hit on a note's own name outranks a merely lexical one,
        // because a person who typed the note's name meant that note.
        rank: Math.max(rank, matchRank(query, title, noteIdOf(file))),
        score: note.score,
      }),
    )
    if (out.length >= PER_SOURCE_CAP) break
  }
  return out
}

/**
 * (4) THE REGISTRIES — rules and helpers, by NAME and DESCRIPTION only.
 *
 * ONE SOURCE, TWO KINDS: the registries are read once and answer as `rule` and `agent`,
 * because that is what the declared contract's kinds are and because a person looking for
 * «правило» and a person looking for «агент» are looking in the same drawer.
 *
 * WHAT IS NOT READ IS THE WHOLE SECURITY POSTURE HERE. A registry entry carries a command,
 * an argument list and an environment block; the card that shows it already collapses every
 * environment value to `[set]`/`[unset]` before it leaves that module. This projector reads
 * neither — not the collapsed form and not the raw one. It reads a name and a description,
 * so a search for the CONTENT of a credential has nothing to match on any path, whether or
 * not the card above did its job.
 */
export function projectRegistries(query, { rules = [], agents = [] } = {}) {
  const out = []
  const take = (list, kind, screen) => {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!isShowable(entry)) continue
      const id = String((entry && entry.id) || '')
      const title = String((entry && (entry.title ?? entry.name)) || '') || id
      const hint = String((entry && entry.description) || '')
      if (!title) continue
      const rank = matchRank(query, title, hint, id)
      if (rank === MATCH_RANKS.NONE) continue
      out.push(hit(kind, { title, hint, ref: { screen }, rank }))
      if (out.length >= PER_SOURCE_CAP * 2) break
    }
  }
  take(rules, 'rule', 'rules')
  take(agents, 'agent', 'agents')
  return out
}

/**
 * (5) ATTEMPTS — the META of an attempt, never its transcript.
 *
 * An attempt's log is thousands of lines of a worker's stdout. It is reachable, one attempt
 * at a time, through its own door with a bounded tail — and it is NOT what a search answers
 * from: grepping every transcript on the disk on every keystroke is both the slowest and
 * the leakiest thing this box could do. What is projected is the attempt's identity and the
 * task it belongs to, so the answer to «где я это видел» is «в этой попытке этой задачи».
 */
export function projectAttempts(query, { attempts = [] } = {}) {
  const out = []
  for (const a of Array.isArray(attempts) ? attempts : []) {
    if (!isShowable(a)) continue
    const attemptId = String((a && a.attemptId) || '')
    if (!attemptId) continue
    const taskId = String((a && a.taskId) || '')
    const title = String((a && a.title) || '') || taskId || attemptId
    const rank = matchRank(query, title, taskId, attemptId)
    if (rank === MATCH_RANKS.NONE) continue
    out.push(hit('attempt', { title, hint: `попытка задачи ${taskId || '—'}`, ref: { attemptId }, rank }))
    if (out.length >= PER_SOURCE_CAP) break
  }
  return out
}

// ── the one question ─────────────────────────────────────────────────────────────

/** Kind order inside one rank — a total order, so two runs cannot disagree. */
const KIND_ORDER = new Map(SEARCH_KINDS.map((k, i) => [k, i]))

/**
 * rankHits(hits, limit) → the union, ordered and cut.
 *
 * Rank first (exact before prefix before substring), then the kind order above, then the
 * layer's score where there is one, then the title. Every tie-break is deterministic on
 * purpose: a result list that reshuffles between two identical questions reads as a broken
 * box long before anybody works out that it is only unstable sorting.
 */
export function rankHits(hits, limit = SEARCH_LIMIT_DEFAULT) {
  const asked = Number(limit)
  const n = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT
  return [...(Array.isArray(hits) ? hits : [])]
    .sort(
      (a, b) =>
        b._rank - a._rank ||
        (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) ||
        b._score - a._score ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    )
    .slice(0, n)
    .map(({ kind, title, hint, ref }) => ({ kind, title, hint, ref }))
}

/**
 * createSearch(deps) → { search(q, {limit}) → Promise<{hits}> }
 *
 * The readers are injected and every one of them is OPTIONAL: a daemon assembled without a
 * queue, without a connected corpus or without a ledger answers from the sources it does
 * have. An absent source contributes nothing — it is not an error, and it is certainly not
 * an empty answer for the four sources that were there.
 *
 * A reader that THROWS is treated as an absent source, for the same reason: one corpus
 * having a bad day must not take the other four with it. Nothing is logged from here — this
 * is a leaf, and the composition root that owns the reader owns its complaint.
 *
 * @param {{listTasks?:Function, queryNotes?:Function, readRegistries?:Function,
 *          listAttempts?:Function, statusLabel?:Function, screens?:object[]}} deps
 */
export function createSearch(deps = {}) {
  const d = deps && typeof deps === 'object' ? deps : {}

  const safely = async (fn, fallback) => {
    if (typeof fn !== 'function') return fallback
    try {
      const value = await fn()
      return value ?? fallback
    } catch {
      return fallback
    }
  }

  async function search(q, { limit = SEARCH_LIMIT_DEFAULT } = {}) {
    const query = normalizeQuery(q)
    // An empty question is an EMPTY ANSWER, and it is answered without touching a single
    // source: a box that ran five readers on every cleared keystroke would be a box that
    // spawns work when a person deletes a letter.
    if (!query) return { hits: [] }

    const perSource = Math.min(SEARCH_LIMIT_MAX, PER_SOURCE_CAP)
    const [rows, notes, registries, attempts] = await Promise.all([
      safely(() => d.listTasks(), []),
      safely(() => d.queryNotes(query, perSource), []),
      safely(() => d.readRegistries(), {}),
      safely(() => d.listAttempts(), []),
    ])

    const hits = [
      ...projectScreens(query, { screens: d.screens ?? SEARCH_SCREENS }),
      ...projectTasks(query, { rows, statusLabel: d.statusLabel }),
      ...projectNotes(query, { notes }),
      ...projectRegistries(query, { rules: registries.rules, agents: registries.agents }),
      ...projectAttempts(query, { attempts }),
    ]
    return { hits: rankHits(hits, limit) }
  }

  return { search }
}
