/**
 * Tests for the memory workbench — the drafts waiting for a yes, the one-at-a-time apply, the
 * index rebuild and the corpus lint.
 *
 * WHAT THESE FOUR DOORS ARE FOR: the write pipeline already refuses to put a lesson into the
 * corpus without a person's word — it stages the record and stops. Until now that word could
 * only be said in a terminal. These doors are the other way of saying it, and they add no
 * second path to the corpus: every one of them stands in front of a mechanism that exists.
 *
 * GREP-VISIBLE INVARIANTS (each one is a case below, named in the same words):
 *   1.  ONE DOOR IS ONE DRAFT — the applier is called exactly once, with exactly the name that
 *       was sent. There is no field on this surface that could ask for two.
 *   2.  ACCEPT IS THE LITERAL TRUE — a body that merely reached the door is not a person
 *       agreeing to a lesson, so `false`, `"true"`, `1` and a missing field are all a 400 and
 *       the applier is never called.
 *   3.  THE REFUSAL IS THE PIPELINE'S — a staged record the conveyor stops (the secret screen,
 *       a taken identity, the wrong kind) comes back as an error carrying ITS words, and
 *       nothing is written.
 *   4.  AN UNKNOWN KEY IS A 400 BEFORE ANYTHING RUNS — on every one of the four.
 *   5.  THE DRAFTS LIST IS DERIVED, NEVER STORED — read off the disk on every call, empty when
 *       there is nothing and empty when there is no project, never a fault.
 *   6.  A CONSUMED DRAFT IS NOT A DRAFT — the `.applied` marker the apply path leaves behind is
 *       not a row a person can be asked about again.
 *   7.  NO PATH LEAVES THE LINT DOOR — a finding names a NOTE, and the directory it sits in
 *       stays on this side.
 *   8.  THE SLOTS ARE FILLED — the four keys are gone from PENDING_ROUTES, and the doors answer.
 *
 * Every filesystem call and every verb is injected: the derive runs against an in-memory tree
 * and the three acting doors against recording fakes. No temp directory, no child process, no
 * socket — and no corpus on this machine is read or written by this file.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer, PENDING_ROUTES, MEMORY_APPLY_RECEIPT_FORMAT } from '../src/front/server.mjs'
import { deriveMemoryDrafts } from '../src/front/state.mjs'

const TOKEN = 'm'.repeat(64)
const PROJECT = '/proj'
const DRAFTS = `${PROJECT}/.claude/memory/drafts`

// ── an in-memory tree (the shape front-phase.test.ts drives its derives with) ──

type Tree = Record<string, { text: string; mtimeMs?: number } | string>

function norm(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

function fakeFs(initial: Tree) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  for (const [k, v] of Object.entries(initial)) {
    files.set(norm(k), typeof v === 'string' ? { text: v, mtimeMs: 0 } : { text: v.text, mtimeMs: v.mtimeMs ?? 0 })
  }
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
  return {
    files,
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
      return (files.get(k) as { text: string }).text
    },
    statSync(p: string) {
      const k = norm(p)
      const entry = files.get(k)
      if (!entry && !dirSet().has(k)) throw new Error(`ENOENT: ${k}`)
      return { isDirectory: () => !entry, isFile: () => !!entry, mtimeMs: entry ? entry.mtimeMs : 0 }
    },
  }
}

/** A staged record in the shape the write pipeline leaves in `drafts/`. */
function draft(id: string, claim: string) {
  return [
    '---',
    `id: ${id}`,
    'schema_version: 2',
    'status: draft',
    'memory_type: semantic',
    'truth_mode: observed',
    `claim: "${claim}"`,
    'draft_kind: pipeline-write',
    '---',
    '',
    claim,
    '',
  ].join('\n')
}

const NOW = 1770000000000

/** The connected project — a registry entry that NAMES A FOLDER is what «connected» means. */
const CONNECTED = { projects: [{ id: 'p1', name: 'мастерская', path: PROJECT }], activeProject: 'p1' }

// ── fake req/res ──

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.9' } = o
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

/** A front wired with exactly the collaborators the memory doors use, and recording fakes. */
function mkFront(over: any = {}) {
  const applied: any[] = []
  const indexRuns: any[] = []
  const emitted: any[] = []
  const io =
    over.fsImpl ??
    fakeFs({
      [`${DRAFTS}/lesson_one.md`]: { text: draft('lesson_one', 'первый урок'), mtimeMs: NOW - 3600000 },
      [`${DRAFTS}/lesson_two.md`]: { text: draft('lesson_two', 'второй урок'), mtimeMs: NOW - 86400000 * 3 },
      // the consumed marker the apply path leaves behind — a spent draft, never a row
      [`${DRAFTS}/lesson_old.applied.md`]: { text: draft('lesson_old', 'уже принят'), mtimeMs: NOW },
    })

  const front = createFrontServer({
    config: { token: TOKEN, ...(over.config ?? CONNECTED) },
    deps: {
      fsImpl: io,
      clock: () => NOW,
      hub: { emit: (e: any) => emitted.push(e) },
      deriveMemoryDrafts,
      applyMemoryDraft: async (a: any) => {
        applied.push(a)
        return over.applyResult ?? { applied: true, targetFile: `${a.draftId}.md` }
      },
      rebuildMemoryIndex: async () => {
        indexRuns.push(true)
        return over.indexResult ?? { ok: true, bytes: 4096, areaFiles: ['INDEX-os.md', 'INDEX-memory.md'] }
      },
      readMemoryLint: async () => over.lintResult ?? { ok: true, report: { critical: 0, warn: 0, info: 0, findings: [] } },
      ...over.deps,
      fsImpl: io,
    },
  })
  return { front, applied, indexRuns, emitted, io }
}

// ═════════════════════ THE DRAFTS LIST IS DERIVED, NEVER STORED ═════════════════════

describe('GET /api/memory/drafts — THE DRAFTS LIST IS DERIVED, NEVER STORED', () => {
  it('lists what is on the disk, with the change itself as the preview', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/memory/drafts' })

    expect(res.statusCode).toBe(200)
    const { drafts } = JSON.parse(res.body)
    expect(drafts.map((d: any) => d.id)).toEqual(['lesson_one', 'lesson_two'])
    // a person agrees to WHAT IT SAYS, so the preview is the record and not its title
    expect(drafts[0].preview).toContain('первый урок')
    expect(drafts[0].targetFile).toBe('lesson_one.md')
    expect(drafts[0].age).toBe('1 ч')
    expect(drafts[1].age).toBe('3 дн')
  })

  it('A CONSUMED DRAFT IS NOT A DRAFT — the `.applied` marker is never a row', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/memory/drafts' })
    const body = JSON.parse(res.body)
    expect(body.drafts.some((d: any) => d.id.includes('lesson_old'))).toBe(false)
    expect(res.body).not.toContain('уже принят')
  })

  it('no drafts, no drafts directory and no project connected are all the SAME empty list', () => {
    expect(deriveMemoryDrafts({ config: CONNECTED, fsImpl: fakeFs({}) })).toEqual({ drafts: [] })
    // a registry entry with no folder is a label for grouping tasks, not a connection
    expect(deriveMemoryDrafts({ config: { projects: [{ id: 'p1', name: 'p1' }], activeProject: 'p1' } })).toEqual({
      drafts: [],
    })
    expect(deriveMemoryDrafts({})).toEqual({ drafts: [] })
  })

  it('a draft nobody can parse still travels — a row that needs a person is not hidden', () => {
    const io = fakeFs({ [`${DRAFTS}/broken.md`]: 'это не заметка и не frontmatter' })
    const { drafts } = deriveMemoryDrafts({ config: CONNECTED, fsImpl: io, clock: () => NOW }) as any
    expect(drafts).toHaveLength(1)
    expect(drafts[0].id).toBe('broken')
    // its own name is the honest answer to «what would this become»
    expect(drafts[0].targetFile).toBe('broken.md')
  })

  it('A ROW SAYS WHICH DOOR OWNS IT — a draft this apply path does not take is marked, not hidden', () => {
    // a corpus keeps drafts of more than one kind, and the door in front of this list owns one
    const io = fakeFs({
      [`${DRAFTS}/lesson_one.md`]: draft('lesson_one', 'первый урок'),
      [`${DRAFTS}/migration--old_note.md`]: [
        '---',
        'id: old_note',
        'schema_version: 2',
        'status: draft',
        'draft_kind: v2-migration',
        'draft_source: old_note.md',
        '---',
        '',
        'перенос старой заметки',
      ].join('\n'),
    })
    const { drafts } = deriveMemoryDrafts({ config: CONNECTED, fsImpl: io, clock: () => NOW }) as any

    expect(drafts.map((d: any) => [d.id, d.kind, d.applicable])).toEqual([
      ['lesson_one', 'pipeline-write', true],
      ['migration--old_note', 'v2-migration', false],
    ])
    // it is SHOWN, not filtered away: a draft nobody can act on from here is still a fact
    expect(drafts).toHaveLength(2)
  })

  it('no path of this machine rides out on the list', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/memory/drafts' })
    expect(res.body).not.toContain(PROJECT)
    expect(res.body).not.toContain('.claude')
  })
})

// ═══════════════════════════ ONE DOOR IS ONE DRAFT ═══════════════════════════

describe('POST /api/memory/apply — ONE DOOR IS ONE DRAFT', () => {
  it('calls the applier ONCE, with exactly the name that was sent', async () => {
    const { front, applied, emitted } = mkFront()
    const res = await call(front, {
      method: 'POST',
      url: '/api/memory/apply',
      body: { draftId: 'lesson_one', accept: true },
    })

    expect(res.statusCode).toBe(200)
    expect(applied).toEqual([{ draftId: 'lesson_one' }])
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, draftId: 'lesson_one', receipt: 'memory-apply:lesson_one->lesson_one.md' })
    // the doorbell says something moved and nothing about what it was
    expect(emitted).toContainEqual({ event: 'memory.drafts' })
  })

  it('THERE IS NO FIELD THAT COULD ASK FOR TWO — an array, a glob and an «all» are all a 400', async () => {
    for (const body of [
      { draftId: ['lesson_one', 'lesson_two'], accept: true },
      { draftId: '*', accept: true },
      { draftId: 'all', accept: true, all: true },
      { draftIds: ['lesson_one'], accept: true },
    ]) {
      const { front, applied } = mkFront()
      const res = await call(front, { method: 'POST', url: '/api/memory/apply', body })
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(applied, JSON.stringify(body)).toHaveLength(0)
    }
  })

  it('ACCEPT IS THE LITERAL TRUE — everything else is a 400 and the applier never runs', async () => {
    for (const accept of [undefined, false, 'true', 1, null]) {
      const { front, applied } = mkFront()
      const body: any = { draftId: 'lesson_one' }
      if (accept !== undefined) body.accept = accept
      const res = await call(front, { method: 'POST', url: '/api/memory/apply', body })
      expect(res.statusCode, String(accept)).toBe(400)
      expect(res.body).toContain('accept must be true')
      expect(applied, String(accept)).toHaveLength(0)
    }
  })

  it('AN UNKNOWN KEY IS A 400 BEFORE ANYTHING RUNS', async () => {
    const { front, applied } = mkFront()
    const res = await call(front, {
      method: 'POST',
      url: '/api/memory/apply',
      body: { draftId: 'lesson_one', accept: true, corpus: '/somewhere/else' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('corpus')
    expect(applied).toHaveLength(0)
  })

  it('a draft name that could leave the drafts directory never reaches the applier', async () => {
    for (const draftId of ['../../etc/passwd', 'a/b', '.hidden', '', 'x'.repeat(200)]) {
      const { front, applied } = mkFront()
      const res = await call(front, { method: 'POST', url: '/api/memory/apply', body: { draftId, accept: true } })
      expect(res.statusCode, draftId).toBe(400)
      expect(applied, draftId).toHaveLength(0)
    }
  })

  it('THE REFUSAL IS THE PIPELINE’S: a secret-class stop comes back in its words, nothing written', async () => {
    const refusal = 'redact: запись отклонена — обнаружен секрет; ничего не записано ни в корпус, ни в drafts'
    const { front, emitted } = mkFront({ applyResult: { applied: false, reason: refusal } })
    const res = await call(front, {
      method: 'POST',
      url: '/api/memory/apply',
      body: { draftId: 'lesson_one', accept: true },
    })

    expect(res.statusCode).toBe(409)
    expect(res.body).toBe(refusal)
    // nothing moved, so nothing is announced as having moved
    expect(emitted).toHaveLength(0)
  })

  it('a draft that is not there is a 404, not a refusal about a file', async () => {
    const { front } = mkFront({ applyResult: { applied: false, missing: true } })
    const res = await call(front, { method: 'POST', url: '/api/memory/apply', body: { draftId: 'gone', accept: true } })
    expect(res.statusCode).toBe(404)
  })

  it('the receipt format is a WORD, not only an example of itself', () => {
    expect(MEMORY_APPLY_RECEIPT_FORMAT).toBe('memory-apply:<draft>-><target>')
  })
})

// ═══════════════════════════ THE INDEX AND THE LINT ═══════════════════════════

describe('POST /api/memory/index — the generated index is rebuilt, never hand-edited', () => {
  it('runs the rebuild and answers with a receipt', async () => {
    const { front, indexRuns, emitted } = mkFront()
    const res = await call(front, { method: 'POST', url: '/api/memory/index', body: {} })
    expect(res.statusCode).toBe(200)
    expect(indexRuns).toHaveLength(1)
    expect(JSON.parse(res.body)).toEqual({ ok: true, receipt: 'memory-index:4096b+2' })
    expect(emitted).toContainEqual({ event: 'memory.drafts' })
  })

  it('AN UNKNOWN KEY IS A 400 BEFORE ANYTHING RUNS — the body is empty by contract', async () => {
    const { front, indexRuns } = mkFront()
    const res = await call(front, { method: 'POST', url: '/api/memory/index', body: { corpus: '/elsewhere' } })
    expect(res.statusCode).toBe(400)
    expect(indexRuns).toHaveLength(0)
  })

  it('a project that is not connected refuses, and says which fact is missing', async () => {
    const { front } = mkFront({ indexResult: { ok: false, reason: 'no project is connected' } })
    const res = await call(front, { method: 'POST', url: '/api/memory/index', body: {} })
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('no project is connected')
  })
})

describe('GET /api/memory/lint — NO PATH LEAVES THE LINT DOOR', () => {
  const report = {
    critical: 1,
    warn: 2,
    info: 5,
    findings: [
      { checkId: 'MEM-VOCAB', tier: 'critical', file: '/proj/.claude/memory/feedback_x.md', message: 'unknown memory_type' },
      { checkId: 'RECEIPT-PROSE', tier: 'warn', file: 'bug_y.md', message: 'a claim without a receipt' },
      { checkId: 'MEM-SIZE', tier: 'warn', file: '', message: 'the index is over budget' },
      { checkId: 'MEM-HINT', tier: 'info', file: 'note_z.md', message: 'an advisory nobody has to act on' },
    ],
  }

  it('a finding names a NOTE — the directory it sits in stays on this side', async () => {
    const { front } = mkFront({ lintResult: { ok: true, report } })
    const res = await call(front, { url: '/api/memory/lint' })
    const body = JSON.parse(res.body)
    expect(res.statusCode).toBe(200)
    expect(body.findings[0]).toEqual({
      rule: 'MEM-VOCAB',
      severity: 'critical',
      note: 'unknown memory_type',
      file: 'feedback_x.md',
    })
    expect(res.body).not.toContain('/proj')
    expect(res.body).not.toContain('.claude')
  })

  it('the third tier has no field in the contract and is NOT folded into the warnings', async () => {
    const { front } = mkFront({ lintResult: { ok: true, report } })
    const body = JSON.parse((await call(front, { url: '/api/memory/lint' })).body)
    expect(body.critical).toBe(1)
    expect(body.warnings).toBe(2)
    expect(body.findings).toHaveLength(3) // 1 critical + 2 warn, and no advisory
    expect(body.ok).toBe(false) // a corpus with a critical finding is not ok, whatever the count of the rest
  })

  it('a corpus that cannot be linted says so instead of answering an empty green report', async () => {
    const { front } = mkFront({ lintResult: { ok: false, reason: 'the connected project carries no SMA runtime' } })
    const res = await call(front, { url: '/api/memory/lint' })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('no SMA runtime')
  })
})

// ═══════════════════════════ THE SLOTS ARE FILLED ═══════════════════════════

describe('THE SLOTS ARE FILLED — four keys gone, and the doors answer', () => {
  it('none of the four is named in PENDING_ROUTES any more', () => {
    for (const key of [
      'GET /api/memory/drafts',
      'POST /api/memory/apply',
      'POST /api/memory/index',
      'GET /api/memory/lint',
    ]) {
      expect(PENDING_ROUTES.has(key), key).toBe(false)
    }
  })

  it('a daemon wired with NO workbench collaborator answers «not available here», not a guess', async () => {
    const front = createFrontServer({ config: { token: TOKEN, ...CONNECTED }, deps: {} })
    for (const [method, url] of [
      ['GET', '/api/memory/drafts'],
      ['POST', '/api/memory/apply'],
      ['POST', '/api/memory/index'],
      ['GET', '/api/memory/lint'],
    ]) {
      const res = await call(front, { method, url, body: method === 'POST' ? {} : undefined })
      expect(res.statusCode, url).toBe(501)
    }
  })
})
