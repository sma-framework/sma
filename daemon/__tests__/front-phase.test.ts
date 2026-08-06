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
    expect(derivePhaseCard({ projectDir: PROJECT, phaseId: '', fsImpl: fixture() })).toBeNull()
  })
})

// ═════════════════════ the freeze these fills are measured by ═════════════════

describe('the route freeze shrinks by exactly the slots this work filled', () => {
  it('the phase doors are gone from PENDING_ROUTES', () => {
    for (const key of ['POST /api/phase/stage', 'GET /api/phase/:id']) {
      expect(PENDING_ROUTES.has(key), `${key} is live and must not be declared pending`).toBe(false)
    }
  })
})
