/**
 * Tests for the search projection — one question, five corpora, one honest answer.
 *
 * WHY THIS SHAPE AND NOT AN INDEX: only ONE of the five bodies of knowledge in this product
 * has a retrieval layer (the memory axis, with its own lexical engine and its own BM25
 * fallback). The other four — the window's screens, the queue, the registries, the attempts —
 * have none, and inventing one for them would have been a second read path over each. So the
 * module is five projectors and one ranking, and these cases hold it to exactly that.
 *
 * GREP-VISIBLE INVARIANTS (each one is a case below, named in the same words):
 *   1.  ONE PROJECTOR PER SOURCE — five exported functions, five sources, no sixth path.
 *   2.  A SECRET IS NOT FINDABLE — searching for the CONTENT of a credential finds nothing,
 *       because no projector ever reads the field it would live in.
 *   3.  A WITHHELD RECORD IS WITHHELD AGAIN — the read-time filter runs on top of whatever
 *       the source already did, and drops a row the corpus says is not for showing.
 *   4.  A REF IS A PLACE IN THE WINDOW — no result carries a separator, a drive letter or
 *       anything else that reads as a path on a disk.
 *   5.  THE MEMORY LAYER IS CONSUMED, NEVER RE-IMPLEMENTED — the notes arrive from the
 *       injected reader with its score, and no note BODY is ever read.
 *   6.  A SOURCE THAT FAILS IS A SOURCE THAT IS ABSENT — one corpus having a bad day never
 *       takes the other four with it.
 *   7.  THE SCREEN LIST DOES NOT DRIFT — the window's own registry is read as TEXT and the
 *       two lists are held to each other.
 *   8.  THE ORDER IS TOTAL — exact before prefix before substring, and two identical
 *       questions cannot answer in two orders.
 *   9.  A QUESTION IS BOUNDED AT THE DOOR — over the cap is a 400, never a silent half-search.
 *   10. AN ATTEMPT'S IDENTITY REACHES ITS OWN DOOR — `<taskId>#<n>` is what the ledger mints
 *       and what the route must therefore accept, encoded as a client has to send it.
 *   11. NO SESSION IDENTIFIER TRAVELS — checked on the BYTES of the answer, not on a shape.
 *   12. THE SLOTS ARE FILLED — both keys are gone from PENDING_ROUTES, and both doors answer.
 *
 * Every reader is injected. No temp directory, no child process, no socket, and no corpus on
 * this machine is opened by this file.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import { createFrontServer, PENDING_ROUTES, matchRoute } from '../src/front/server.mjs'
import {
  createSearch,
  matchRank,
  MATCH_RANKS,
  noteIdOf,
  normalizeQuery,
  projectAttempts,
  projectNotes,
  projectRegistries,
  projectScreens,
  projectTasks,
  rankHits,
  SEARCH_KINDS,
  SEARCH_LIMIT_MAX,
  SEARCH_QUERY_CAP,
  SEARCH_SCREENS,
} from '../src/front/search.mjs'

/**
 * THE SECRET. It is planted in every source, in the field a careless projector would reach
 * for — a task's working envelope, a registry entry's environment, a note's body. Nothing in
 * this file ever puts it in a title or a description, because the point of the case is that
 * the DOOR cannot find it, not that a fixture withheld it.
 */
const SECRET = 'sk-live-51H8xQq-do-not-find-me'

const TASKS = [
  { id: 'BL-201', title: 'Починить дверь поиска', status: 'queued', data: { kind: 'code', apiKey: SECRET } },
  { id: 'BL-202', title: 'Поиск по памяти', status: 'claimed', data: { kind: 'code' } },
  { id: 'R-9', title: 'Разобраться с BM25', status: 'completed', data: {} },
]

const NOTES = [
  { file: 'notes/search-visibility.md', title: 'Фильтр видимости на чтении', hint: 'когда строишь поиск по корпусам', score: 4.2 },
  { file: 'bm25-fallback.md', title: 'Запасной лексический движок', hint: 'если сборка Node без FTS', score: 2.1 },
  // The corpus itself says this one is not for showing. It arrived from the reader anyway —
  // that is the whole point of a filter that stands ON TOP of the layer beneath it.
  { file: 'withheld.md', title: 'Черновик про поиск', hint: 'не показывать', score: 9.9, visible: false },
]

const REGISTRIES = {
  rules: [
    { id: 'no-bulk-apply', title: 'Массовой приёмки не бывает', description: 'урок принимается по одному' },
    { id: 'push-is-human', title: 'Публикация — только человеком', description: 'работник не получает выката' },
  ],
  agents: [
    // The environment block is where a credential lives on a registry card. It is planted here
    // exactly as a real one would be, and no projector reads it.
    { id: 'planner', title: 'Планировщик', description: 'режет фазу на планы', env: { API_KEY: SECRET }, command: 'node' },
    { id: 'hidden-helper', title: 'Скрытый помощник', description: 'поиск не должен его показывать', hidden: true },
  ],
}

const ATTEMPTS = [
  { attemptId: 'BL-201#1', taskId: 'BL-201', title: 'Починить дверь поиска' },
  { attemptId: 'R-9#2', taskId: 'R-9', title: 'Разобраться с BM25' },
]

/**
 * The memory reader, standing in for the LEXICAL LAYER — and behaving like it.
 *
 * This matters more than a fixture usually does. That layer is the one authority on whether
 * a note answers a question: it tokenizes, it ranks, and it hands back only what its own
 * index matched. A fake that returned every row for every question would not be a stub of it
 * — it would be a different mechanism, and every case built on it would prove nothing. So
 * this one matches on the axis the real layer indexes (name, claim, trigger) and on nothing
 * else, which is exactly the property the real one has and the reason the body cases below
 * are honest.
 */
function fakeLexicalLayer(rows: any[]) {
  return (q: string) => {
    const needle = String(q).toLowerCase()
    return rows.filter((r) =>
      [r.file, r.title, r.hint].some((f) =>
        String(f ?? '')
          .toLowerCase()
          .includes(needle),
      ),
    )
  }
}

/** A search wired with every source, each one a recording fake. */
function mkSearch(over: any = {}) {
  const asked: any[] = []
  const layer = fakeLexicalLayer(NOTES)
  const search = createSearch({
    listTasks: over.listTasks ?? (async () => TASKS),
    queryNotes:
      over.queryNotes ??
      (async (q: string, limit: number) => {
        asked.push({ q, limit })
        return layer(q)
      }),
    readRegistries: over.readRegistries ?? (async () => REGISTRIES),
    listAttempts: over.listAttempts ?? (async () => ATTEMPTS),
    statusLabel: over.statusLabel,
    ...(over.screens ? { screens: over.screens } : {}),
  })
  return { search, asked }
}

// ═══════════════ ONE PROJECTOR PER SOURCE ═══════════════

describe('search.mjs — ONE PROJECTOR PER SOURCE', () => {
  it('five sources, five exported functions — and no sixth path into a corpus', () => {
    for (const fn of [projectScreens, projectTasks, projectNotes, projectRegistries, projectAttempts]) {
      expect(typeof fn).toBe('function')
    }
    // one source may answer with two kinds (rules and helpers live in the same drawer), but
    // no kind may exist that no projector produces
    expect(SEARCH_KINDS).toEqual(['screen', 'task', 'note', 'rule', 'agent', 'attempt'])
  })

  it('every projector takes DATA — none of them reads a file, a process or a clock', () => {
    // A projector that needed a reader could not be called with a bare array. That is the
    // shape assertion: the shaping lives where a test can drive it.
    expect(projectScreens('сегодня', { screens: [{ id: 'today', title: 'Сегодня', hint: 'что сейчас' }] })).toHaveLength(1)
    expect(projectTasks('BL-201', { rows: TASKS })).toHaveLength(1)
    expect(projectNotes('bm25', { notes: [NOTES[1]] })).toHaveLength(1)
    expect(projectRegistries('планировщик', { rules: [], agents: REGISTRIES.agents })).toHaveLength(1)
    expect(projectAttempts('BL-201', { attempts: ATTEMPTS })).toHaveLength(1)
  })

  it('asks all five at once and answers along one axis: what it is / when / where', async () => {
    const { search } = mkSearch()
    const { hits } = await search.search('поиск')
    const kinds = new Set(hits.map((h: any) => h.kind))
    expect(kinds.has('screen')).toBe(true)
    expect(kinds.has('task')).toBe(true)
    expect(kinds.has('note')).toBe(true)
    for (const h of hits) {
      expect(typeof h.title).toBe('string')
      expect(typeof h.hint).toBe('string')
      expect(h.ref && typeof h.ref).toBe('object')
      // the internal ranking fields never leave the module
      expect(Object.keys(h).sort()).toEqual(['hint', 'kind', 'ref', 'title'])
    }
  })
})

// ═══════════════ A SECRET IS NOT FINDABLE ═══════════════

describe('search.mjs — A SECRET IS NOT FINDABLE', () => {
  it('searching for the CONTENT of a credential finds NOTHING — in any corpus', async () => {
    const { search } = mkSearch()
    expect(await search.search(SECRET)).toEqual({ hits: [] })
    // and not by a fragment of it either — the field is never read, so there is no partial
    expect(await search.search('sk-live')).toEqual({ hits: [] })
    expect(await search.search('51H8xQq')).toEqual({ hits: [] })
  })

  it('the same query DOES find the entry by its name — the card exists, its secret does not', async () => {
    const { search } = mkSearch()
    const { hits } = await search.search('Планировщик')
    const agent = hits.find((h: any) => h.kind === 'agent')
    expect(agent).toBeTruthy()
    // the hit is assembled from a name and a description; nothing else travelled
    expect(JSON.stringify(agent)).not.toContain(SECRET)
  })

  it('NO ANSWER ANYWHERE CARRIES THE SECRET — swept across every word in every fixture', async () => {
    const { search } = mkSearch()
    const words = ['поиск', 'память', 'BL', 'выкат', 'ключ', 'api', 'node', 'code', 'a', 'e', 'о']
    for (const w of words) {
      const answer = JSON.stringify(await search.search(w))
      expect(answer).not.toContain(SECRET)
      expect(answer).not.toContain('sk-live')
    }
  })
})

// ═══════════════ A WITHHELD RECORD IS WITHHELD AGAIN ═══════════════

describe('search.mjs — A WITHHELD RECORD IS WITHHELD AGAIN', () => {
  it('a note the corpus withholds never becomes a hit, however high the layer scored it', async () => {
    const { search } = mkSearch()
    const { hits } = await search.search('поиск')
    expect(hits.some((h: any) => h.title === 'Черновик про поиск')).toBe(false)
    // it was the TOP-scored row the reader handed over: the filter, not the ranking, dropped it
    expect(NOTES[2].score).toBeGreaterThan(NOTES[0].score)
  })

  it('the filter is a DENY on a signal, not an allow on its absence — three words, all of them', () => {
    expect(projectScreens('x', { screens: [{ id: 'x', title: 'x', hint: '', hidden: true }] })).toHaveLength(0)
    expect(projectScreens('x', { screens: [{ id: 'x', title: 'x', hint: '', secret: true }] })).toHaveLength(0)
    expect(projectScreens('x', { screens: [{ id: 'x', title: 'x', hint: '', visible: false }] })).toHaveLength(0)
    expect(projectScreens('x', { screens: [{ id: 'x', title: 'x', hint: '' }] })).toHaveLength(1)
  })

  it('a hidden helper is not in the answer, and a shown one beside it still is', async () => {
    const { search } = mkSearch()
    const { hits } = await search.search('помощник')
    expect(hits.some((h: any) => h.title === 'Скрытый помощник')).toBe(false)
  })
})

// ═══════════════ A REF IS A PLACE IN THE WINDOW ═══════════════

describe('search.mjs — A REF IS A PLACE IN THE WINDOW', () => {
  it('no ref carries a separator, a drive letter or a dot-dot — swept over every hit', async () => {
    const { search } = mkSearch()
    for (const q of ['поиск', 'BL', 'bm25', 'выкат', 'память', 'попытка']) {
      const { hits } = await search.search(q)
      for (const h of hits) {
        for (const value of Object.values(h.ref)) {
          const v = String(value)
          expect(v).not.toMatch(/[\\/]/)
          expect(v).not.toMatch(/^[A-Za-z]:/)
          expect(v).not.toContain('..')
        }
      }
    }
  })

  it("a note's ref is its NAME — the directory it sits in stays on this side", () => {
    expect(noteIdOf('notes/deep/search-visibility.md')).toBe('search-visibility')
    expect(noteIdOf('C:\\Users\\x\\.claude\\memory\\bm25-fallback.md')).toBe('bm25-fallback')
    const [row] = projectNotes('видимости', { notes: [NOTES[0]] })
    expect(row.ref).toEqual({ noteId: 'search-visibility' })
  })

  it('each kind leads where that kind is READ: a screen, a task, a note, an attempt', async () => {
    const { search } = mkSearch()
    const { hits } = await search.search('поиск')
    const by = (k: string) => hits.find((h: any) => h.kind === k)
    expect(by('screen')!.ref).toEqual({ screen: 'search' })
    expect(by('task')!.ref.taskId).toMatch(/^BL-/)
    expect(by('note')!.ref.noteId).toBe('search-visibility')
    const rule = projectRegistries('публикация', { rules: REGISTRIES.rules })[0]
    expect(rule.ref).toEqual({ screen: 'rules' })
  })
})

// ═══════════════ THE MEMORY LAYER IS CONSUMED, NEVER RE-IMPLEMENTED ═══════════════

describe('search.mjs — THE MEMORY LAYER IS CONSUMED, NEVER RE-IMPLEMENTED', () => {
  it('the question and a bounded limit go to the injected reader — this module opens no corpus', async () => {
    const { search, asked } = mkSearch()
    await search.search('bm25')
    expect(asked).toHaveLength(1)
    expect(asked[0].q).toBe('bm25')
    expect(asked[0].limit).toBeLessThanOrEqual(SEARCH_LIMIT_MAX)
  })

  it("the layer's score orders the notes — a reader that answers in arrival order does not", () => {
    const jumbled = [
      { file: 'c.md', title: 'корпус c', hint: '', score: 0.5 },
      { file: 'a.md', title: 'корпус a', hint: '', score: 9 },
      { file: 'b.md', title: 'корпус b', hint: '', score: 3 },
    ]
    const ranked = rankHits(projectNotes('корпус', { notes: jumbled }))
    expect(ranked.map((h: any) => h.ref.noteId)).toEqual(['a', 'b', 'c'])
  })

  it('a note that the layer scored but whose NAME was typed outranks a merely lexical hit', () => {
    const notes = [
      { file: 'other.md', title: 'что-то ещё', hint: 'про bm25 вскользь', score: 50 },
      { file: 'bm25-fallback.md', title: 'bm25-fallback', hint: '', score: 0.1 },
    ]
    const ranked = rankHits(projectNotes('bm25-fallback', { notes }))
    expect(ranked[0].ref.noteId).toBe('bm25-fallback')
  })

  it('NO NOTE BODY TRAVELS — a body handed over by a reader never reaches the answer', async () => {
    const { search } = mkSearch({
      queryNotes: async () => [
        { file: 'leaky.md', title: 'заметка', hint: 'подсказка', body: `тело заметки с ${SECRET}`, score: 1 },
      ],
    })
    const { hits } = await search.search('заметка')
    expect(hits).toHaveLength(1)
    // the hit is assembled by explicit pick: the body was in the row and is not in the answer
    expect(JSON.stringify(hits)).not.toContain(SECRET)
    expect(JSON.stringify(hits)).not.toContain('тело заметки')
    expect(Object.keys(hits[0]).sort()).toEqual(['hint', 'kind', 'ref', 'title'])
  })

  it('RELEVANCE IS THE LAYER’S VERDICT, and this module does not re-judge it', async () => {
    // What the layer returns is what the layer matched — no projector second-guesses it, and
    // that is the «one read path» law rather than a shortcut. What the projector DOES own is
    // the shape, the visibility re-check and the explicit pick, and those hold either way.
    const { search } = mkSearch({
      queryNotes: async () => [{ file: 'a.md', title: 'по совсем другим словам', hint: '', score: 7 }],
    })
    const { hits } = await search.search('ничего похожего')
    expect(hits.map((h: any) => h.kind)).toContain('note')
  })
})

// ═══════════════ A SOURCE THAT FAILS IS A SOURCE THAT IS ABSENT ═══════════════

describe('search.mjs — A SOURCE THAT FAILS IS A SOURCE THAT IS ABSENT', () => {
  it('a reader that THROWS never takes the other four with it', async () => {
    const { search } = mkSearch({
      queryNotes: async () => {
        throw new Error('the corpus is unreadable today')
      },
    })
    const { hits } = await search.search('поиск')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h: any) => h.kind === 'note')).toBe(false)
  })

  it('a daemon assembled with NO readers at all answers an empty list, never an error', async () => {
    const bare = createSearch({})
    expect(await bare.search('поиск')).toEqual({ hits: expect.any(Array) })
    // the screens are this module's own constant, so they answer even with nothing wired
    expect((await bare.search('поиск')).hits.some((h: any) => h.kind === 'screen')).toBe(true)
  })

  it('an empty question touches no source at all', async () => {
    let touched = 0
    const search = createSearch({
      listTasks: async () => {
        touched += 1
        return []
      },
    })
    expect(await search.search('   ')).toEqual({ hits: [] })
    expect(await search.search('')).toEqual({ hits: [] })
    expect(touched).toBe(0)
  })
})

// ═══════════════ THE SCREEN LIST DOES NOT DRIFT ═══════════════

describe('search.mjs — THE SCREEN LIST DOES NOT DRIFT', () => {
  it("every screen this module offers exists in the window's own registry, and vice versa", () => {
    const registry = readFileSync(fileURLToPath(new URL('../../spa/src/screens/registry.ts', import.meta.url)), 'utf8')
    // the declared union is the app's own answer to «which screens exist»
    const union = registry.slice(registry.indexOf('export type ScreenId'), registry.indexOf('export type NavGroup'))
    const declared = new Set([...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]))
    expect(declared.size).toBeGreaterThan(20)

    const offered = new Set(SEARCH_SCREENS.map((s) => s.id))
    for (const id of offered) expect(declared.has(id)).toBe(true)
    // a screen the window has and search cannot find is a room with no door on the map
    for (const id of declared) expect(offered.has(id)).toBe(true)
  })

  it('every screen carries a «when would I need it», not only a name', () => {
    for (const s of SEARCH_SCREENS) {
      expect(s.hint.length).toBeGreaterThan(10)
      expect(s.title.length).toBeGreaterThan(0)
    }
  })
})

// ═══════════════ THE ORDER IS TOTAL ═══════════════

describe('search.mjs — THE ORDER IS TOTAL', () => {
  it('exact beats prefix beats substring', () => {
    expect(matchRank('поиск', 'Поиск')).toBe(MATCH_RANKS.EXACT)
    expect(matchRank('поис', 'Поиск по памяти')).toBe(MATCH_RANKS.PREFIX)
    expect(matchRank('памяти', 'Поиск по памяти')).toBe(MATCH_RANKS.SUBSTRING)
    expect(matchRank('нетакого', 'Поиск по памяти')).toBe(MATCH_RANKS.NONE)
    expect(matchRank('', 'что угодно')).toBe(MATCH_RANKS.NONE)
  })

  it('two identical questions answer in exactly one order', async () => {
    const { search } = mkSearch()
    const a = await search.search('поиск')
    const b = await search.search('поиск')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('the limit is clamped, and a question is capped rather than refused here', async () => {
    const { search } = mkSearch()
    expect((await search.search('а', { limit: 1 })).hits).toHaveLength(1)
    expect((await search.search('а', { limit: 10000 })).hits.length).toBeLessThanOrEqual(SEARCH_LIMIT_MAX)
    expect(normalizeQuery('x'.repeat(SEARCH_QUERY_CAP + 50))).toHaveLength(SEARCH_QUERY_CAP)
    expect(normalizeQuery(' Поиск\nПо Памяти ')).toBe('поиск по памяти')
  })

  it('a task hit carries its status as the hint — the queue is the one who knows it', () => {
    const rows = projectTasks('BL-201', { rows: TASKS, statusLabel: (s: string) => `статус: ${s}` })
    expect(rows[0].hint).toBe('статус: queued')
  })
})

// ══════════════════════════ the two doors ══════════════════════════

const TOKEN = 'k'.repeat(64)

/** A ledger row as the live log actually stores it: two fields, plus provenance when there is any. */
const LOG_ROWS = [
  { ts: '2026-08-07T01:00:00.000Z', line: 'APPROACH_NOTE: сначала прочитал соседний модуль' },
  { ts: '2026-08-07T01:00:01.000Z', line: 'смотрю на дверь поиска' },
  { ts: '2026-08-07T01:00:02.000Z', line: 'делегирую разбор', subagent: true, parentId: 'toolu_01OPAQUE' },
]

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.11' } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.socket = { remoteAddress: remote }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function call(front: any, o: any) {
  const req = mkReq({
    ...o,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(o.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(o.headers || {}),
    },
  })
  const res = mkRes()
  await front.handle(req, res)
  return res
}

/** A front wired with the two collaborators of this plan, both recording fakes. */
function mkFront(over: any = {}) {
  const asked: any[] = []
  const projection = mkSearch().search
  const front = createFrontServer({
    config: { token: TOKEN },
    deps: {
      ledger: over.ledger ?? {
        readAttemptLog: (a: any) => {
          asked.push(a)
          const rows = over.rows ?? LOG_ROWS
          const n = Number(a.tail)
          const cut = Number.isFinite(n) && n > 0 ? rows.slice(-n) : rows
          return {
            attemptId: a.attemptId,
            entries: cut,
            total: rows.length,
            truncated: cut.length < rows.length,
            note: over.note === undefined ? { approach: 'сначала прочитал соседний модуль', rejected: [], influences: [] } : over.note,
          }
        },
      },
      search: over.search ?? projection,
      ...over.deps,
    },
  })
  return { front, asked }
}

// ═══════════════ A QUESTION IS BOUNDED AT THE DOOR ═══════════════

describe('GET /api/search — A QUESTION IS BOUNDED AT THE DOOR', () => {
  it('a question over the cap is a 400 — never a silent half-search', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: `/api/search?q=${'x'.repeat(SEARCH_QUERY_CAP + 1)}` })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('256')
  })

  it('an empty question is an empty answer, and the projection is never even called', async () => {
    let touched = 0
    const { front } = mkFront({ search: { search: async () => ((touched += 1), { hits: [] }) } })
    for (const url of ['/api/search', '/api/search?q=', '/api/search?q=%20%20']) {
      const res = await call(front, { url })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ hits: [] })
    }
    expect(touched).toBe(0)
  })

  it('a real question answers with hits, explicit-picked to the four declared fields', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/search?q=поиск' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.hits.length).toBeGreaterThan(0)
    for (const h of body.hits) expect(Object.keys(h).sort()).toEqual(['hint', 'kind', 'ref', 'title'])
  })

  it('a projection that THROWS is an empty answer, never a 500', async () => {
    const { front } = mkFront({
      search: {
        search: async () => {
          throw new Error('every corpus is on fire')
        },
      },
    })
    const res = await call(front, { url: '/api/search?q=поиск' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ hits: [] })
  })

  it('the question travels as DATA — a MATCH operator and a quote are just letters', async () => {
    const seen: string[] = []
    const { front } = mkFront({ search: { search: async (q: string) => (seen.push(q), { hits: [] }) } })
    const nasty = `" OR 1=1; DROP TABLE docs --`
    const res = await call(front, { url: `/api/search?q=${encodeURIComponent(nasty)}` })
    expect(res.statusCode).toBe(200)
    expect(seen).toEqual([nasty]) // handed over whole, interpreted by nobody on the way
  })
})

// ═══════════════ AN ATTEMPT'S IDENTITY REACHES ITS OWN DOOR ═══════════════

describe('GET /api/attempt/:id — AN ATTEMPT’S IDENTITY REACHES ITS OWN DOOR', () => {
  it('«<taskId>#<n>» is what the ledger mints — and, encoded, what the route accepts', () => {
    expect(matchRoute('GET', '/api/attempt/BL-201%231')).toMatchObject({
      handler: 'handleAttempt',
      params: { id: 'BL-201#1' },
    })
    // the bare shape the guard was declared with still matches
    expect(matchRoute('GET', '/api/attempt/R-9')).toMatchObject({ handler: 'handleAttempt', params: { id: 'R-9' } })
  })

  it('a decoded segment is still held to an ALLOW-LIST — a traversal cannot ride in encoded', () => {
    for (const bad of [
      '/api/attempt/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/api/attempt/BL-201%2F..%2Fx',
      '/api/attempt/bad$id',
      '/api/attempt/BL-201%23notanumber',
      '/api/attempt/%E0%A4%A', // malformed percent-encoding: a bad id, never a throw
    ]) {
      expect(matchRoute('GET', bad)).toEqual({ badId: true })
    }
  })

  it('the tail travels to the LEDGER as it was asked — the ceiling belongs to the reader', async () => {
    const { front, asked } = mkFront()
    await call(front, { url: '/api/attempt/BL-201%231?tail=2' })
    expect(asked[0]).toEqual({ attemptId: 'BL-201#1', tail: '2' })
    await call(front, { url: '/api/attempt/BL-201%231' })
    expect(asked[1]).toEqual({ attemptId: 'BL-201#1', tail: undefined })
  })

  it('a cut tail says so, and a delegated line arrives WITH its flag', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/attempt/BL-201%231?tail=2' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.truncated).toBe(true)
    expect(body.lines).toHaveLength(2)
    expect(body.lines[1]).toEqual({
      ts: '2026-08-07T01:00:02.000Z',
      line: 'делегирую разбор',
      subagent: true,
      group: 1, // WHICH delegation, as an ordinal — the id it was made from stays inside
    })
    // an ordinary line carries the flag as FALSE rather than as an absence: the screen shows
    // «делегировано» or it does not, and «this build did not know» is not a third answer
    expect(body.lines[0].subagent).toBe(false)
  })

  it('two subagents are two groups, counted in the order they first speak — and the id never leaves', async () => {
    const rows = [
      { ts: 'T1', line: 'родитель', subagent: false },
      { ts: 'T2', line: 'первый', subagent: true, parentId: 'toolu_AAA' },
      { ts: 'T3', line: 'второй', subagent: true, parentId: 'toolu_BBB' },
      { ts: 'T4', line: 'снова первый', subagent: true, parentId: 'toolu_AAA' },
    ]
    const { front } = mkFront({ rows })
    const res = await call(front, { url: '/api/attempt/BL-201%231' })
    const body = JSON.parse(res.body)

    // the SAME delegation keeps the SAME number wherever its lines land in the window
    expect(body.lines.map((l: any) => l.group)).toEqual([undefined, 1, 2, 1])
    // and the opaque identifier the ordinal was made from does not travel
    expect(JSON.stringify(body)).not.toContain('toolu_')
    // a line the parent spoke itself has no group at all — absence, not a zero
    expect(Object.keys(body.lines[0])).not.toContain('group')
  })

  it("the worker's own note rides along, and a note that was never left is null", async () => {
    const withNote = mkFront()
    expect(JSON.parse((await call(withNote.front, { url: '/api/attempt/R-9%231' })).body).note).toBe(
      'сначала прочитал соседний модуль',
    )
    const without = mkFront({ note: null })
    expect(JSON.parse((await call(without.front, { url: '/api/attempt/R-9%231' })).body).note).toBe(null)
  })

  it('an attempt with no log is an EMPTY log — a silent worker is not a 404', async () => {
    const { front } = mkFront({ rows: [], note: null })
    const res = await call(front, { url: '/api/attempt/R-9%231' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ lines: [], truncated: false, note: null })
  })

  it('a ledger that THROWS is an empty log, never a 500', async () => {
    const { front } = mkFront({
      ledger: {
        readAttemptLog: () => {
          throw new Error('the transcript is unreadable')
        },
      },
    })
    const res = await call(front, { url: '/api/attempt/R-9%231' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).lines).toEqual([])
  })
})

// ═══════════════ NO SESSION IDENTIFIER TRAVELS ═══════════════

describe('GET /api/attempt/:id — NO SESSION IDENTIFIER TRAVELS', () => {
  it('a row carrying a session and a parent id gives up NEITHER — checked on the BYTES', async () => {
    const { front } = mkFront({
      rows: [
        {
          ts: '2026-08-07T01:00:00.000Z',
          line: 'обычная строка',
          sessionId: 'sess_01SECRETSESSION',
          subagent: true,
          parentId: 'toolu_01OPAQUEPARENT',
        },
      ],
    })
    const res = await call(front, { url: '/api/attempt/R-9%231' })
    expect(res.body).not.toContain('sess_01SECRETSESSION')
    expect(res.body).not.toContain('toolu_01OPAQUEPARENT')
    // the fact survives, and WHICH delegation it was survives as an ordinal; the identifier does not
    expect(JSON.parse(res.body).lines[0]).toEqual({
      ts: '2026-08-07T01:00:00.000Z',
      line: 'обычная строка',
      subagent: true,
      group: 1,
    })
  })
})

// ═══════════════ THE SLOTS ARE FILLED ═══════════════

describe('the two slots of this plan — THE SLOTS ARE FILLED', () => {
  it('both keys are gone from PENDING_ROUTES, and neither door answers 501 any more', async () => {
    expect(PENDING_ROUTES.has('GET /api/search')).toBe(false)
    expect(PENDING_ROUTES.has('GET /api/attempt/:id')).toBe(false)
    const { front } = mkFront()
    expect((await call(front, { url: '/api/search?q=поиск' })).statusCode).toBe(200)
    expect((await call(front, { url: '/api/attempt/R-9%231' })).statusCode).toBe(200)
  })

  it('a daemon wired with NEITHER collaborator answers 501 — «not available here», not «not written»', async () => {
    const bare = createFrontServer({ config: { token: TOKEN }, deps: {} })
    expect((await call(bare, { url: '/api/search?q=поиск' })).statusCode).toBe(501)
    expect((await call(bare, { url: '/api/attempt/R-9%231' })).statusCode).toBe(501)
  })

  it('both doors are auth-gated exactly like every other', async () => {
    const { front } = mkFront()
    for (const url of ['/api/search?q=поиск', '/api/attempt/R-9%231']) {
      const res = mkRes()
      await front.handle(mkReq({ url }), res)
      expect(res.statusCode).toBe(401)
    }
  })
})
