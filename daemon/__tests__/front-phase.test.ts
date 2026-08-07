/**
 * Tests for the doors of the phase cycle — start a stage, read a card, answer a parked
 * question, record a line of acceptance, open a document.
 *
 * WHAT THESE FIVE DOORS ARE FOR: the whole cycle discuss → plan → execute → verify, run from
 * the window, on the SAME artefacts a terminal writes. The screen is not a second way of
 * recording a decision; it is a second reader of the one file the workflow already keeps.
 *
 * GREP-VISIBLE INVARIANTS (each one is a case below, named in the same words):
 *   1.  A STAGE IS A TASK, NEVER A REQUEST — the door enqueues and returns; nothing about a
 *       phase happens inside an HTTP request.
 *   2.  NO PATH TO AUTO-MODE — no stage command carries an automating flag, in the frozen
 *       dictionary or in the string the door assembles from it.
 *   3.  ONE STAGE AT A TIME — the same stage of the same phase, twice, is a 409, recognised
 *       by the `data` envelope and never by a title.
 *   4.  THE CARD IS DERIVED, NEVER STORED — every number on it is counted off the phase
 *       directory at the moment it is asked for.
 *   5.  ONE MAP FOR THE GATE AND THE CARD — a stage shows as done on exactly the artefact the
 *       daemon's exit gate closes it on (STAGE_ARTIFACTS, imported by both).
 *   6.  THE ANSWER WAKES THE ROUND, NOT THE KEYSTROKE — the round is re-queued only when the
 *       LAST open question is answered.
 *   7.  THE TEXT OF AN ANSWER NEVER REACHES A PROMPT — it lives in the artefact; the re-queued
 *       command is byte-identical to the one that started the stage.
 *   8.  THE POSITION IS THE ARTEFACT'S BUSINESS — the door carries no position and knows none;
 *       an execute round wakes with the same command it started with.
 *   9.  ONE ROUND, ONE WAKE — a race between two last answers is one 200 and one 409.
 *   10. ONE ROOT, AND IT IS `.planning/` — the artefact door refuses `..`, an absolute path, a
 *       drive letter and any resolved path outside that root, all with the same 400.
 *   11. A VERDICT IS WRITTEN IN THE FILE'S OWN VOCABULARY — `fail` on the wire is `issue` in
 *       the document, because the document belongs to the workflow that parses it.
 *
 * Every filesystem call is injected: the derives, the questions engine and the two writing
 * doors all run against an in-memory tree, so there is no temp directory and no real socket.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer, STAGE_COMMANDS, PENDING_ROUTES } from '../src/front/server.mjs'
import { derivePhaseIndex, derivePhaseCard } from '../src/front/state.mjs'
import { STAGE_ARTIFACTS, CHECKPOINT_SUFFIX, EXEC_CHECKPOINT_SUFFIX } from '../src/front/questions.mjs'

const TOKEN = 'd'.repeat(64)
const PROJECT = '/proj'

// ── an in-memory tree, shared by the derives, the engine and the writing doors ──

type Tree = Record<string, string>

function norm(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

function fakeFs(initial: Tree) {
  const files = new Map<string, string>()
  for (const [k, v] of Object.entries(initial)) files.set(norm(k), v)

  const dirSet = () => {
    const dirs = new Set<string>(['/'])
    for (const p of files.keys()) {
      const parts = p.split('/')
      parts.pop()
      let acc = ''
      for (const part of parts) {
        acc = acc === '' ? (part === '' ? '/' : part) : acc === '/' ? `/${part}` : `${acc}/${part}`
        dirs.add(acc)
      }
    }
    return dirs
  }

  const io = {
    files,
    existsSync(p: string) {
      const k = norm(p)
      return files.has(k) || dirSet().has(k)
    },
    readdirSync(p: string) {
      const k = norm(p)
      if (!dirSet().has(k)) throw new Error(`ENOENT: ${k}`)
      const prefix = k === '/' ? '/' : `${k}/`
      const out = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        if (rest === '') continue
        out.add(rest.split('/')[0])
      }
      return [...out].sort()
    },
    readFileSync(p: string) {
      const k = norm(p)
      if (!files.has(k)) throw new Error(`ENOENT: ${k}`)
      return files.get(k) as string
    },
    statSync(p: string) {
      const k = norm(p)
      const isFile = files.has(k)
      if (!isFile && !dirSet().has(k)) throw new Error(`ENOENT: ${k}`)
      return { isDirectory: () => !isFile, isFile: () => isFile }
    },
    mkdirSync() {
      /* directories exist by virtue of their files in this tree */
    },
    writeFileSync(p: string, text: string) {
      files.set(norm(p), String(text))
    },
    renameSync(from: string, to: string) {
      const k = norm(from)
      const text = files.get(k)
      files.delete(k)
      if (text !== undefined) files.set(norm(to), text)
    },
    unlinkSync(p: string) {
      files.delete(norm(p))
    },
  }
  return io
}

/** A checkpoint in the workflow's OWN shape (the template's fields, nothing added). */
function checkpoint(decisions: Record<string, Array<{ question: string; answer?: string | null; options_presented?: string[] }>>, extra: object = {}) {
  return JSON.stringify({
    phase: '12',
    phase_name: 'front-workplace',
    timestamp: '2026-08-07T00:00:00Z',
    areas_completed: ['первая область'],
    areas_remaining: [],
    decisions,
    deferred_ideas: [],
    canonical_refs: [],
    ...extra,
  })
}

const UAT_DOC = [
  '---',
  'status: testing',
  'phase: 12-front',
  '---',
  '',
  '## Tests',
  '',
  '### 1. Экран дня открывается',
  'expected: строка задачи видна',
  'result: pass',
  '',
  '### 2. Карточка фазы считает вопросы',
  'expected: «N открыто / M отвечено»',
  'result: [pending]',
  '',
  '### 3. Ответ будит раунд',
  'expected: задача снова в очереди',
  'result: issue',
  'reported: "ничего не произошло"',
  'severity: major',
  '',
  '## Summary',
  '',
  'total: 3',
  '',
].join('\n')

/** The fixture project: one worked phase, one phase parked on a question. */
function fixture(over: Tree = {}) {
  return fakeFs({
    [`${PROJECT}/.planning/phases/12-front/12-CONTEXT.md`]: '# контекст',
    [`${PROJECT}/.planning/phases/12-front/12-01-PLAN.md`]: '# план 1',
    [`${PROJECT}/.planning/phases/12-front/12-02-PLAN.md`]: '# план 2',
    [`${PROJECT}/.planning/phases/12-front/12-01-SUMMARY.md`]: '# итог 1',
    [`${PROJECT}/.planning/phases/12-front/12-UAT.md`]: UAT_DOC,
    [`${PROJECT}/.planning/phases/13-next${'/'}13${CHECKPOINT_SUFFIX}`]: checkpoint({
      'граница релиза': [
        { question: 'Что входит в релиз?', answer: 'то, что уже построено', options_presented: ['всё', 'то, что уже построено'] },
        { question: 'Кого зовём тестировать?', options_presented: ['никого', 'друга'] },
      ],
    }),
    ...over,
  })
}

// ── fake req/res (the shape front-auth.test.ts drives handlers with) ──

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.7' } = o
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

/**
 * The id of the first question still open in a phase — asked of the ENGINE rather than
 * hand-written here, because the identifier is derived from the area's name and a literal in
 * this file would be a second implementation of that derivation.
 */
function openIdOf(io: any, phase: string): string {
  const card = derivePhaseCard({ projectDir: PROJECT, phaseId: phase, fsImpl: io })
  const open = (card?.questions ?? []).find((q: any) => !q.answer)
  return open ? open.id : ''
}

/** A front wired with exactly the collaborators the phase doors use. */
function mkFront(deps: any = {}) {
  const enqueued: any[] = []
  const emitted: any[] = []
  const io = deps.fsImpl ?? fixture()
  const rows: any[] = deps.rows ?? []
  const front = createFrontServer({
    config: { token: TOKEN },
    deps: {
      repoDir: PROJECT,
      fsImpl: io,
      clock: () => 1770000000000,
      adapter: {
        enqueue: async (t: any) => {
          enqueued.push(t)
          return { id: t.id, coalesced: false }
        },
        list: async () => rows,
      },
      hub: { emit: (e: any) => emitted.push(e) },
      derivePhaseIndex,
      derivePhaseCard,
      ...deps,
      fsImpl: io,
    },
  })
  return { front, enqueued, emitted, io, rows }
}

// ═══════════════════════════════ THE STAGE DOOR ═══════════════════════════════

describe('POST /api/phase/stage — A STAGE IS A TASK, NEVER A REQUEST', () => {
  it('enqueues a paperwork task whose envelope names the stage and whose text is the command', async () => {
    const { front, enqueued, emitted } = mkFront()
    const res = await call(front, { method: 'POST', url: '/api/phase/stage', body: { phase: '12', stage: 'discuss' } })

    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
    const [task] = enqueued
    expect(task.lane).toBe('paperwork')
    expect(task.data).toEqual({ kind: 'document', stage: 'discuss', phase: '12' })
    expect(task.title.startsWith('/sma-discuss-phase')).toBe(true)
    expect(task.title).toContain('12')
    // the hint names the identifiers and nothing about what the stage will do
    expect(emitted).toContainEqual({ event: 'phase.stage', taskId: task.id, phase: '12', stage: 'discuss' })
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, phase: '12', stage: 'discuss' })
  })

  it('an execute stage is CODE work — the same door, the other gate', async () => {
    const { front, enqueued } = mkFront()
    await call(front, { method: 'POST', url: '/api/phase/stage', body: { phase: '12', stage: 'execute' } })
    expect(enqueued[0].data).toEqual({ kind: 'code', stage: 'execute', phase: '12' })
    expect(enqueued[0].title.startsWith('/sma-execute-phase')).toBe(true)
  })

  it('NO PATH TO AUTO-MODE: neither the frozen dictionary nor an assembled command automates', async () => {
    // the declaration itself
    for (const [stage, template] of Object.entries(STAGE_COMMANDS)) {
      expect(String(template).toLowerCase(), stage).not.toContain('auto')
      expect(String(template), stage).not.toMatch(/--(bare|dangerously-skip-permissions|permission-mode)/)
    }
    expect(Object.isFrozen(STAGE_COMMANDS)).toBe(true)
    expect(Object.keys(STAGE_COMMANDS).sort()).toEqual(['discuss', 'execute', 'plan', 'verify'])

    // and every string the door actually hands to the queue
    const { front, enqueued } = mkFront()
    for (const stage of ['discuss', 'plan', 'execute', 'verify']) {
      await call(front, { method: 'POST', url: '/api/phase/stage', body: { phase: '12', stage } })
    }
    expect(enqueued).toHaveLength(4)
    for (const task of enqueued) {
      expect(String(task.title).toLowerCase()).not.toContain('auto')
    }
  })

  it('a stage nobody declared is refused BY NAME — no gate is picked by default', async () => {
    const { front, enqueued } = mkFront()
    const res = await call(front, { method: 'POST', url: '/api/phase/stage', body: { phase: '12', stage: 'ship' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('discuss')
    expect(enqueued).toHaveLength(0)
  })

  it('an unknown body field, and a phase that could read as a flag, are both 400', async () => {
    const { front, enqueued } = mkFront()
    const extra = await call(front, {
      method: 'POST',
      url: '/api/phase/stage',
      body: { phase: '12', stage: 'discuss', prompt: 'сделай красиво' },
    })
    expect(extra.statusCode).toBe(400)
    expect(extra.body).toContain('prompt')

    const flag = await call(front, { method: 'POST', url: '/api/phase/stage', body: { phase: '--auto', stage: 'discuss' } })
    expect(flag.statusCode).toBe(400)
    expect(enqueued).toHaveLength(0)
  })

  it('ONE STAGE AT A TIME: the same stage of the same phase, twice, is a 409', async () => {
    const rows = [
      { id: 'S-1', status: 'claimed', title: 'что угодно', data: { kind: 'document', stage: 'discuss', phase: '12' } },
    ]
    const { front, enqueued } = mkFront({ rows })
    const res = await call(front, { method: 'POST', url: '/api/phase/stage', body: { phase: '12', stage: 'discuss' } })
    expect(res.statusCode).toBe(409)
    expect(enqueued).toHaveLength(0)
  })

  it('the liveness question is asked of the ENVELOPE — a finished row, or another phase, is not in the way', async () => {
    const rows = [
      // same stage, same phase, but already decided
      { id: 'S-0', status: 'completed', data: { kind: 'document', stage: 'discuss', phase: '12' } },
      // same stage, running, but a DIFFERENT phase
      { id: 'S-9', status: 'claimed', data: { kind: 'document', stage: 'discuss', phase: '13' } },
      // ordinary code work carrying no envelope at all
      { id: 'BL-7', status: 'claimed', title: '/sma-discuss-phase 12 --batch --text' },
    ]
    const { front, enqueued } = mkFront({ rows })
    const res = await call(front, { method: 'POST', url: '/api/phase/stage', body: { phase: '12', stage: 'discuss' } })
    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
  })

  it('a daemon with no queue answers «not available here», never a fabricated success', async () => {
    const front = createFrontServer({ config: { token: TOKEN }, deps: { repoDir: PROJECT } })
    const res = await call(front, { method: 'POST', url: '/api/phase/stage', body: { phase: '12', stage: 'discuss' } })
    expect(res.statusCode).toBe(501)
  })
})

// ═══════════════════════════════ THE PHASE CARD ═══════════════════════════════

describe('GET /api/phase/:id — THE CARD IS DERIVED, NEVER STORED', () => {
  it('the index lists every phase directory with its stages and its question counts', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/phase/index' })
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.body)
    expect(payload.phases.map((p: any) => p.id)).toEqual(['12-front', '13-next'])

    const worked = payload.phases[0]
    expect(worked.name).toBe('front')
    expect(worked.stages).toEqual({ discuss: 'done', plan: 'done', execute: 'done', verify: 'none' })
    expect(worked).toMatchObject({ open: 0, answered: 0 })

    const parked = payload.phases[1]
    // ONE answered, ONE still open — counted off the artefact, never stored
    expect(parked).toMatchObject({ open: 1, answered: 1 })
    expect(parked.stages.discuss).toBe('in-progress')
  })

  it('ONE MAP FOR THE GATE AND THE CARD: a stage is done on the artefact the gate closes it on', () => {
    // The card does not own this map — it imports the one the tick's exit gate uses.
    expect(STAGE_ARTIFACTS.discuss.produces).toBe('-CONTEXT.md')
    expect(STAGE_ARTIFACTS.plan.produces).toBe('-PLAN.md')
    expect(STAGE_ARTIFACTS.execute.produces).toBe('-SUMMARY.md')
    expect(STAGE_ARTIFACTS.verify.produces).toBe('-VERIFICATION.md')
    expect(STAGE_ARTIFACTS.discuss.checkpoint).toBe(CHECKPOINT_SUFFIX)
    expect(STAGE_ARTIFACTS.execute.checkpoint).toBe(EXEC_CHECKPOINT_SUFFIX)

    // and it really is READ: a bare directory is four «none», and each artefact of the map —
    // and nothing else — flips exactly its own stage
    const bare = `${PROJECT}/.planning/phases/40-bare`
    const io = fakeFs({ [`${bare}/40-NOTES.md`]: 'ничего из карты' })
    const stagesNow = () => derivePhaseIndex({ projectDir: PROJECT, fsImpl: io }).phases[0].stages
    expect(stagesNow()).toEqual({ discuss: 'none', plan: 'none', execute: 'none', verify: 'none' })

    io.files.set(norm(`${bare}/40${CHECKPOINT_SUFFIX}`), checkpoint({ 'о': [{ question: 'а?' }] }))
    expect(stagesNow().discuss).toBe('in-progress') // parked, not finished
    io.files.set(norm(`${bare}/40-CONTEXT.md`), '# контекст')
    expect(stagesNow().discuss).toBe('done')
    io.files.set(norm(`${bare}/40-01-PLAN.md`), '# план')
    expect(stagesNow().plan).toBe('done')
    io.files.set(norm(`${bare}/40-01-SUMMARY.md`), '# итог')
    expect(stagesNow().execute).toBe('done')
    io.files.set(norm(`${bare}/40-VERIFICATION.md`), '# приёмка')
    expect(stagesNow().verify).toBe('done')
  })

  it('one card carries the plans, the summaries, the questions and the acceptance', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/phase/12-front' })
    expect(res.statusCode).toBe(200)
    const card = JSON.parse(res.body)

    expect(card.plans.map((p: any) => p.name)).toEqual(['12-01-PLAN.md', '12-02-PLAN.md'])
    // the path is the one the artefact door accepts — relative, rooted at the only root it opens
    expect(card.plans[0].path).toBe('.planning/phases/12-front/12-01-PLAN.md')
    expect(card.summaries.map((s: any) => s.name)).toEqual(['12-01-SUMMARY.md'])
    // the acceptance document travels whole as well as parsed: it is the ONE answer to «which
    // file is this phase's acceptance», and the door that writes a verdict reads it from here
    expect(card.uatDocument).toEqual({ name: '12-UAT.md', path: '.planning/phases/12-front/12-UAT.md' })
    expect(card.uat).toEqual([
      { item: '1', name: 'Экран дня открывается', verdict: 'pass' },
      { item: '2', name: 'Карточка фазы считает вопросы', verdict: null },
      { item: '3', name: 'Ответ будит раунд', verdict: 'fail', note: 'ничего не произошло' },
    ])
  })

  it('NO PATH ON THE FOUNDER’S DISK travels: the payload names files, never directories', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/phase/12-front' })
    expect(res.body).not.toContain(PROJECT)
    expect(res.body).not.toMatch(/[A-Za-z]:[\\/]/)
  })

  it('a phase is found by NUMBER as well as by directory name — one rule, the gate’s own', async () => {
    const { front } = mkFront()
    const byNumber = await call(front, { url: '/api/phase/12' })
    expect(byNumber.statusCode).toBe(200)
    expect(JSON.parse(byNumber.body).id).toBe('12-front')
  })

  it('a phase the project does not have is a 404, and a torn checkpoint costs one list, not the poll', async () => {
    const { front } = mkFront()
    expect((await call(front, { url: '/api/phase/99' })).statusCode).toBe(404)

    const io = fixture({ [`${PROJECT}/.planning/phases/13-next/13${CHECKPOINT_SUFFIX}`]: '{ порванный' })
    const index = derivePhaseIndex({ projectDir: PROJECT, fsImpl: io })
    expect(index.phases).toHaveLength(2) // the index still answers
    expect(index.phases[1]).toMatchObject({ open: 0, answered: 0 })
    const card = derivePhaseCard({ projectDir: PROJECT, phaseId: '13', fsImpl: io })
    expect(card.questions).toEqual([])
    expect(card.id).toBe('13-next')
  })

  it('a project with no phases at all is an empty index, not an error', () => {
    expect(derivePhaseIndex({ projectDir: '/nothing', fsImpl: fixture() })).toEqual({ phases: [] })
    expect(derivePhaseIndex({})).toEqual({ phases: [] })
  })
})

/**
 * WHAT A PERSON READS ON THE SCREEN.
 *
 * A phase directory is a file-system identifier and it reads like one — `11-49-9-sma-v5-3`,
 * `49.2-sma-v3-trust-spine`. On the screen that exists so the founder can stop using a
 * terminal, a column of those is noise: he recognises none of his own work in it. The roadmap
 * already holds each phase's name in the words its author chose, so the screen shows those.
 *
 * The rule refuses to guess. A phase the roadmap does not mention keeps its OWN words, only
 * spelled with spaces — because a slug is honest and a mis-mapped title is a lie on a screen.
 */
describe('a phase is named the way its author named it', () => {
  const ROADMAP = [
    '# Roadmap',
    '',
    '### Phase 12: SMA — Рабочее место во фронте (полный переход с терминала)',
    'some prose about the phase',
    '',
    '### Phase 13: (экс-49.9) Управление памятью + укреплённый парк',
    '',
    '### Phase 12: a SECOND mention that must not win',
    '',
  ].join('\n')

  const withRoadmap = (over = {}) => fixture({ [`${PROJECT}/.planning/ROADMAP.md`]: ROADMAP, ...over })

  const nameOf = (io: unknown, id: string) =>
    derivePhaseIndex({ projectDir: PROJECT, fsImpl: io as never }).phases.find((p: never) => (p as { id: string }).id === id)

  it('takes the title out of the roadmap, by phase number', () => {
    const row = nameOf(withRoadmap(), '12-front') as { name: string }
    expect(row.name).toBe('SMA — Рабочее место во фронте (полный переход с терминала)')
  })

  it('drops a LEADING bracketed aside — bookkeeping in front of a name is not the name', () => {
    const row = nameOf(withRoadmap(), '13-next') as { name: string }
    expect(row.name).toBe('Управление памятью + укреплённый парк')
    // …and a bracket INSIDE the sentence stays, because there it is part of the title
    const twelve = nameOf(withRoadmap(), '12-front') as { name: string }
    expect(twelve.name).toContain('(полный переход с терминала)')
  })

  it('the FIRST heading for a number wins — a later mention is a reference, not a rename', () => {
    const row = nameOf(withRoadmap(), '12-front') as { name: string }
    expect(row.name).not.toContain('SECOND mention')
  })

  it('falls back to the directory own words, made readable, when the roadmap says nothing', () => {
    // no ROADMAP.md at all — the ordinary state of a project that never wrote one
    const row = nameOf(fixture(), '12-front') as { name: string }
    expect(row.name).toBe('front')
  })

  it('never invents: a phase the roadmap does not mention is NOT given a neighbour title', () => {
    const row = nameOf(withRoadmap({ [`${PROJECT}/.planning/phases/47.3-legacy-thing/x.md`]: '# x' }), '47.3-legacy-thing') as {
      name: string
    }
    expect(row.name).toBe('legacy thing')
    expect(derivePhaseCard({ projectDir: PROJECT, phaseId: '', fsImpl: fixture() })).toBeNull()
  })
})

// ══════════════════════════════ THE DECISION DOOR ═════════════════════════════

/** A CAS seam that records every transition and can be told to lose the claim. */
function casSeam({ lose = false }: { lose?: boolean } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = []
  const execSql = async (sql: string, params: any[]) => {
    calls.push({ sql, params })
    const isClaim = /status = \$1/.test(sql) && params[0] === 'approving'
    return { rows: isClaim && lose ? [] : [{ id: params[1] }] }
  }
  return { execSql, calls, transitions: () => calls.map((c) => `${c.params[c.params.length - 1]}->${c.params[0]}`) }
}

/** A phase parked mid-round: one question answered, one still open, plus its queue row. */
function parkedDiscussion(over: Tree = {}) {
  return fakeFs({
    [`${PROJECT}/.planning/phases/14-round/14${CHECKPOINT_SUFFIX}`]: checkpoint({
      'граница релиза': [
        { question: 'Что входит?', answer: 'уже построенное', options_presented: [] },
        { question: 'Кого зовём?', options_presented: ['никого', 'друга'] },
      ],
    }),
    ...over,
  })
}

const PARKED_ROW = {
  id: 'S-42',
  status: 'awaiting_approval',
  attempt: 2,
  data: { kind: 'document', stage: 'discuss', phase: '14' },
}

describe('POST /api/decision/answer — THE ANSWER WAKES THE ROUND, NOT THE KEYSTROKE', () => {
  it('the LAST answer re-queues the round: claimed, enqueued, approved, in that order', async () => {
    const io = parkedDiscussion()
    const cas = casSeam()
    const { front, enqueued, emitted } = mkFront({ fsImpl: io, rows: [PARKED_ROW], casExec: cas.execSql })

    const res = await call(front, {
      method: 'POST',
      url: '/api/decision/answer',
      body: { phase: '14', questionId: openIdOf(io, '14'), taskId: 'S-42', optionId: 'o0' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, open: 0, answered: 2, taskId: 'S-42' })
    expect(cas.transitions()).toEqual(['awaiting_approval->approving', 'approving->approved'])
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      id: 'S-42',
      lane: 'paperwork',
      attempt: 3, // the SAME round, one attempt further on — never a new row
      data: { kind: 'document', stage: 'discuss', phase: '14' },
    })
    expect(enqueued[0].title).toBe('/sma-discuss-phase 14 --batch --text')
    expect(emitted).toContainEqual({ event: 'discussion.updated', phase: '14' })
  })

  it('THE TEXT OF AN ANSWER NEVER REACHES A PROMPT — it stays in the artefact', async () => {
    const io = parkedDiscussion()
    const secret = 'зовём Петра, но только после публикации'
    const { front, enqueued } = mkFront({ fsImpl: io, rows: [PARKED_ROW], casExec: casSeam().execSql })

    await call(front, {
      method: 'POST',
      url: '/api/decision/answer',
      body: { phase: '14', questionId: openIdOf(io, '14'), taskId: 'S-42', freeText: secret },
    })

    // it IS in the file the next round reads …
    const parked = JSON.parse(io.readFileSync(`${PROJECT}/.planning/phases/14-round/14${CHECKPOINT_SUFFIX}`))
    expect(parked.decisions['граница релиза'][1].answer).toBe(secret)
    // … and nowhere in what the queue was handed
    expect(JSON.stringify(enqueued)).not.toContain('Петра')
    expect(JSON.stringify(enqueued)).not.toContain(secret)
  })

  it('THE POSITION IS THE ARTEFACT’S BUSINESS: an execute round wakes with its original command', async () => {
    const io = fakeFs({
      [`${PROJECT}/.planning/phases/15-exec/15${EXEC_CHECKPOINT_SUFFIX}`]: checkpoint(
        { 'развилка исполнения': [{ question: 'Ставим таблицу?', options_presented: ['да', 'нет'] }] },
        { position: { plan: '15-03', task: 2, completed: ['15-01', '15-02'] } },
      ),
    })
    const row = { id: 'S-77', status: 'awaiting_approval', attempt: 1, data: { kind: 'code', stage: 'execute', phase: '15' } }
    const { front, enqueued } = mkFront({ fsImpl: io, rows: [row], casExec: casSeam().execSql })

    const res = await call(front, {
      method: 'POST',
      url: '/api/decision/answer',
      body: { phase: '15', questionId: openIdOf(io, '15'), taskId: 'S-77', optionId: 'o1' },
    })

    expect(res.statusCode).toBe(200)
    // byte-identical to the string that STARTS an execute stage — the door carries no position
    expect(enqueued[0].title).toBe('/sma-execute-phase 15')
    expect(enqueued[0].data).toEqual({ kind: 'code', stage: 'execute', phase: '15' })
    expect(JSON.stringify(enqueued)).not.toContain('15-03')
    // and the position block is still in the artefact, untouched by the write
    const parked = JSON.parse(io.readFileSync(`${PROJECT}/.planning/phases/15-exec/15${EXEC_CHECKPOINT_SUFFIX}`))
    expect(parked.position).toEqual({ plan: '15-03', task: 2, completed: ['15-01', '15-02'] })
  })

  it('an answer that is NOT the last one records and wakes nothing', async () => {
    const io = fakeFs({
      [`${PROJECT}/.planning/phases/14-round/14${CHECKPOINT_SUFFIX}`]: checkpoint({
        'область': [{ question: 'первый?' }, { question: 'второй?' }],
      }),
    })
    const cas = casSeam()
    const { front, enqueued } = mkFront({ fsImpl: io, rows: [PARKED_ROW], casExec: cas.execSql })

    const res = await call(front, {
      method: 'POST',
      url: '/api/decision/answer',
      body: { phase: '14', questionId: openIdOf(io, '14'), taskId: 'S-42', freeText: 'первый ответ' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, open: 1, answered: 1 })
    expect(enqueued).toEqual([])
    expect(cas.calls).toEqual([])
  })

  it('ONE ROUND, ONE WAKE: a lost claim is a 409 and enqueues nothing', async () => {
    // The real race this guards: the founder decided the parked row from the «Ждут решения»
    // card in the same second the answer arrived, so the row is no longer awaiting_approval.
    const io = parkedDiscussion()
    const cas = casSeam({ lose: true })
    const { front, enqueued } = mkFront({ fsImpl: io, rows: [PARKED_ROW], casExec: cas.execSql })

    const res = await call(front, {
      method: 'POST',
      url: '/api/decision/answer',
      body: { phase: '14', questionId: openIdOf(io, '14'), taskId: 'S-42', optionId: 'o0' },
    })

    expect(res.statusCode).toBe(409)
    expect(enqueued).toEqual([])
    expect(cas.transitions()).toEqual(['awaiting_approval->approving']) // never reached approved
  })

  it('the answer is recorded even when there is no round to wake — the two acts are separate', async () => {
    const io = parkedDiscussion()
    const { front, enqueued } = mkFront({ fsImpl: io, rows: [], casExec: casSeam().execSql })

    // no taskId at all: a question answered from the phase card rather than from the queue row
    const res = await call(front, {
      method: 'POST',
      url: '/api/decision/answer',
      body: { phase: '14', questionId: openIdOf(io, '14'), optionId: 'o1' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, open: 0, answered: 2 })
    expect(enqueued).toEqual([])
    const parked = JSON.parse(io.readFileSync(`${PROJECT}/.planning/phases/14-round/14${CHECKPOINT_SUFFIX}`))
    expect(parked.decisions['граница релиза'][1].answer).toBe('друга')
  })

  it('every refusal is the ENGINE’s, in its own words: unknown question, second answer, secret, cap', async () => {
    const io = parkedDiscussion()
    const front = mkFront({ fsImpl: io, rows: [PARKED_ROW], casExec: casSeam().execSql }).front
    const post = (body: object) => call(front, { method: 'POST', url: '/api/decision/answer', body })
    const open = openIdOf(io, '14')

    // the shape of the request is judged BEFORE the file is opened: no answer in it at all
    const empty = await post({ phase: '14', questionId: open })
    expect(empty.statusCode).toBe(400)
    expect(empty.body).toContain('optionId')
    // a well-formed answer to a question that does not exist
    expect((await post({ phase: '14', questionId: 'нет-такого', freeText: 'да' })).statusCode).toBe(404)

    const secret = await post({ phase: '14', questionId: open, freeText: 'sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz' })
    expect(secret.statusCode).toBe(400)
    expect(secret.body).toContain('ключ')
    // NOTHING was written: the secret never reached the artefact
    expect(io.readFileSync(`${PROJECT}/.planning/phases/14-round/14${CHECKPOINT_SUFFIX}`)).not.toContain('sk-ant')

    const long = await post({ phase: '14', questionId: open, freeText: 'я'.repeat(2001) })
    expect(long.statusCode).toBe(400)

    const unknownField = await post({ phase: '14', questionId: open, severity: 'major' })
    expect(unknownField.statusCode).toBe(400)
    expect(unknownField.body).toContain('severity')

    // and after all four refusals the question is STILL open
    expect(openIdOf(io, '14')).toBe(open)

    // the first answer stands: answering it twice is refused rather than overwritten
    expect((await post({ phase: '14', questionId: open, optionId: 'o0' })).statusCode).toBe(200)
    expect((await post({ phase: '14', questionId: open, optionId: 'o1' })).statusCode).toBe(400)
  })

  it('a torn checkpoint answers 409 with the offending field, never 400 at the person typing', async () => {
    const io = parkedDiscussion({ [`${PROJECT}/.planning/phases/14-round/14${CHECKPOINT_SUFFIX}`]: '{нет' })
    const { front } = mkFront({ fsImpl: io, rows: [PARKED_ROW], casExec: casSeam().execSql })
    const res = await call(front, {
      method: 'POST',
      url: '/api/decision/answer',
      body: { phase: '14', questionId: 'abc-0', freeText: 'да' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('JSON')
  })
})

// ══════════════════════════════ THE ARTEFACT DOOR ═════════════════════════════

describe('GET /api/artifact — ONE ROOT, AND IT IS `.planning/`', () => {
  it('reads a document of the phase as plain text, not as markup', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/artifact?path=.planning/phases/12-front/12-01-PLAN.md' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('# план 1')
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('the path the CARD hands out is the path this door accepts — one spelling, end to end', async () => {
    const { front } = mkFront()
    const card = JSON.parse((await call(front, { url: '/api/phase/12-front' })).body)
    for (const doc of [...card.plans, ...card.summaries, card.uatDocument]) {
      const res = await call(front, { url: `/api/artifact?path=${encodeURIComponent(doc.path)}` })
      expect(res.statusCode, doc.path).toBe(200)
    }
  })

  it('EVERY refusal is the same 400: `..`, an absolute path, a drive letter, another root', async () => {
    const { front } = mkFront()
    const refused = [
      '../секрет',
      '.planning/../секрет',
      '.planning/phases/../../.env',
      '/etc/passwd',
      'C:/Users/секрет.md',
      'C:\\Users\\секрет.md',
      '.claude/settings.json',
      'daemon/src/front/server.mjs',
      '..\\..\\секрет',
      '.planning/phases/12-front/..\\..\\..\\секрет',
      '',
      `.planning/${'x'.repeat(600)}.md`,
    ]
    for (const path of refused) {
      const res = await call(front, { url: `/api/artifact?path=${encodeURIComponent(path)}` })
      expect(res.statusCode, path).toBe(400)
      expect(res.body, path).toBe('invalid path')
    }
    // a sibling whose name merely STARTS like the root is outside it, and is refused too
    const sibling = await call(front, { url: '/api/artifact?path=.planning-old/leak.md' })
    expect(sibling.statusCode).toBe(400)
  })

  it('a well-formed path to a file that is not there is a 404, and a directory is a 400', async () => {
    const { front } = mkFront()
    expect((await call(front, { url: '/api/artifact?path=.planning/phases/12-front/нет.md' })).statusCode).toBe(404)
    expect((await call(front, { url: '/api/artifact?path=.planning/phases/12-front' })).statusCode).toBe(400)
  })

  it('a document past the cap is refused by SIZE, not truncated into a half-truth', async () => {
    const io = fixture({ [`${PROJECT}/.planning/phases/12-front/12-HUGE.md`]: 'я'.repeat(700000) })
    const { front } = mkFront({ fsImpl: io })
    const res = await call(front, { url: '/api/artifact?path=.planning/phases/12-front/12-HUGE.md' })
    expect(res.statusCode).toBe(413) // 700k Cyrillic characters are 1.4 MB of UTF-8
  })
})

// ═════════════════════════════════ THE UAT DOOR ═══════════════════════════════

describe('POST /api/phase/uat — A VERDICT IS WRITTEN IN THE FILE’S OWN VOCABULARY', () => {
  const uatText = (io: any) => io.readFileSync(`${PROJECT}/.planning/phases/12-front/12-UAT.md`)

  it('a pass lands on the line it was given, and the counters come back in step', async () => {
    const io = fixture()
    const { front } = mkFront({ fsImpl: io })
    const res = await call(front, {
      method: 'POST',
      url: '/api/phase/uat',
      body: { phase: '12', item: '2', verdict: 'pass' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, phase: '12', item: '2', verdict: 'pass' })
    const text = uatText(io)
    expect(text).toContain('### 2. Карточка фазы считает вопросы\nexpected: «N открыто / M отвечено»\nresult: pass')
    // the document's own counters are derived again rather than left saying three-of-nothing
    expect(text).toContain('total: 3')
    // and the card reads back exactly what was written — one file, two readers
    const card = JSON.parse((await call(front, { url: '/api/phase/12-front' })).body)
    expect(card.uat[1]).toEqual({ item: '2', name: 'Карточка фазы считает вопросы', verdict: 'pass' })
  })

  it('`fail` on the wire is `issue` in the document, with the person’s words on the reported line', async () => {
    const io = fixture()
    const { front } = mkFront({ fsImpl: io })
    const res = await call(front, {
      method: 'POST',
      url: '/api/phase/uat',
      body: { phase: '12', item: '1', verdict: 'fail', note: 'экран пустой\nи ничего не грузится' },
    })

    expect(res.statusCode).toBe(200)
    const text = uatText(io)
    expect(text).toContain('result: issue')
    // ONE line: a pasted paragraph would become lines the audit verb reads as something else
    expect(text).toContain('reported: "экран пустой и ничего не грузится"')
    expect(text).toContain('severity: major')
    const card = JSON.parse((await call(front, { url: '/api/phase/12-front' })).body)
    expect(card.uat[0]).toEqual({
      item: '1',
      name: 'Экран дня открывается',
      verdict: 'fail',
      note: 'экран пустой и ничего не грузится',
    })
  })

  it('a verdict REPLACES the old one whole — no `pass` left sitting beside a stale reported line', async () => {
    const io = fixture()
    const { front } = mkFront({ fsImpl: io })
    await call(front, { method: 'POST', url: '/api/phase/uat', body: { phase: '12', item: '3', verdict: 'pass' } })
    const text = uatText(io)
    expect(text).not.toContain('ничего не произошло')
    expect(text).not.toContain('severity: major')
    expect(text).toContain('### 3. Ответ будит раунд\nexpected: задача снова в очереди\nresult: pass')
  })

  it('the write is ATOMIC: the document is never written to directly, only renamed over', async () => {
    const io = fixture()
    const writes: string[] = []
    const renames: Array<[string, string]> = []
    const recording = {
      ...io,
      writeFileSync: (p: string, t: string) => {
        writes.push(norm(p))
        io.writeFileSync(p, t)
      },
      renameSync: (a: string, b: string) => {
        renames.push([norm(a), norm(b)])
        io.renameSync(a, b)
      },
    }
    const { front } = mkFront({ fsImpl: recording })
    await call(front, { method: 'POST', url: '/api/phase/uat', body: { phase: '12', item: '1', verdict: 'pass' } })

    const target = norm(`${PROJECT}/.planning/phases/12-front/12-UAT.md`)
    expect(writes).not.toContain(target) // never written in place
    expect(writes).toHaveLength(1)
    expect(writes[0].split('/').slice(0, -1)).toEqual(target.split('/').slice(0, -1)) // same directory
    expect(renames).toEqual([[writes[0], target]])
  })

  it('a line, a phase or a document that does not exist is a 404 — a door does not invent acceptance', async () => {
    const { front } = mkFront()
    const post = (body: object) => call(front, { method: 'POST', url: '/api/phase/uat', body })
    expect((await post({ phase: '12', item: '99', verdict: 'pass' })).statusCode).toBe(404)
    expect((await post({ phase: '77', item: '1', verdict: 'pass' })).statusCode).toBe(404)
    expect((await post({ phase: '13', item: '1', verdict: 'pass' })).statusCode).toBe(404) // no UAT file
  })

  it('the body is explicit-pick, the verdict is a closed pair, and a pasted file is refused', async () => {
    const io = fixture()
    const { front } = mkFront({ fsImpl: io })
    const before = uatText(io)
    const post = (body: object) => call(front, { method: 'POST', url: '/api/phase/uat', body })

    const unknown = await post({ phase: '12', item: '1', verdict: 'pass', severity: 'blocker' })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.body).toContain('severity')
    expect((await post({ phase: '12', item: '1', verdict: 'issue' })).statusCode).toBe(400)
    expect((await post({ phase: '12', item: 'первый', verdict: 'pass' })).statusCode).toBe(400)
    expect((await post({ phase: '12', item: '1', verdict: 'fail', note: 'я'.repeat(2001) })).statusCode).toBe(400)

    expect(uatText(io)).toBe(before) // not one of the four touched the document
  })
})

// ═════════════════════ the freeze these fills are measured by ═════════════════

describe('the route freeze shrinks by exactly the slots this work filled', () => {
  it('all FIVE doors of the phase cycle are gone from PENDING_ROUTES', () => {
    for (const key of [
      'POST /api/phase/stage',
      'GET /api/phase/:id',
      'POST /api/phase/uat',
      'POST /api/decision/answer',
      'GET /api/artifact',
    ]) {
      expect(PENDING_ROUTES.has(key), `${key} is live and must not be declared pending`).toBe(false)
    }
  })
})
