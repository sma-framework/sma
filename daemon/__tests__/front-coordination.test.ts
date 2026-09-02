/**
 * Tests for the coordination panel and the backlog board — who else has this checkout open,
 * what they reserved, where two reservations met, and the line a person puts into the queue.
 *
 * WHY THESE DOORS EXIST AT ALL: a shared checkout has always been the product's assumption, and
 * the leases, the reservations and the collisions have always been on disk. What was missing was
 * a reader that is not a status line, and a way to take a dead reservation away without opening
 * a terminal. Neither is a new mechanism.
 *
 * GREP-VISIBLE INVARIANTS (each one is a case below, named in the same words):
 *   1.  THE SNAPSHOT IS READ, NEVER REMEMBERED — sessions, reservations and today's collisions
 *       come off the ledger on every call, through the runtime's OWN readers.
 *   2.  A COLLISION IS VISIBLE, OR THE PANEL IS DECORATION — a journalled collision reaches the
 *       answer with both actors and the ground they met on.
 *   3.  NO RESERVATION IS CLEARED WITHOUT A REASON — an empty one is a 400 and the verb is
 *       never reached, because a foreign clear is a risky operation with a written record.
 *   4.  A NAME THAT COULD READ AS A FLAG NEVER REACHES THE COMMAND — the reservation's name is
 *       held to a grammar before anything is assembled from it.
 *   5.  THE BACKLOG IS PARSED BY SHAPE, NEVER BY DICTIONARY — the identifier is data out of the
 *       project's own file and this daemon holds no list of what the letters may be.
 *   6.  PROMOTING A LINE DOES NOT TOUCH THE FILE — the queue gains a task, the backlog keeps
 *       every byte it had. That file is a hand, not a store.
 *   7.  NO NUMBER IS MINTED HERE — the door allocates nothing and reads no «last one», so the
 *       counter law has nothing to break.
 *   8.  THE SLOTS ARE FILLED — the four keys are gone from PENDING_ROUTES, and the doors answer.
 *
 * Every ledger read and every verb is injected. No temp directory, no child process, no socket,
 * and no `.sma/` on this machine is opened by this file.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer, PENDING_ROUTES, CLAIM_CLEAR_RECEIPT_FORMAT } from '../src/front/server.mjs'
import { deriveCoordination, deriveBacklog, BACKLOG_ID_RE } from '../src/front/state.mjs'

const TOKEN = 'k'.repeat(64)
const PROJECT = '/proj'
const NOW = 1770000000000

/** The connected project — a registry entry that NAMES A FOLDER is what «connected» means. */
const CONNECTED = { projects: [{ id: 'p1', name: 'мастерская', path: PROJECT }], activeProject: 'p1' }

/** The ledger as the runtime's own readers hand it over: raw facts, no formatting. */
const LEDGER = {
  sessions: [
    { id: 'P12 Оля', title: 'правит фронт', since: new Date(NOW - 2 * 3600000).toISOString() },
    { id: 'P11 Ким', title: 'считает память', ageMs: 45 * 60000 },
  ],
  claims: [
    { name: 'front-doors', globs: ['daemon/src/front/**'], desc: 'двери фронта', ageMs: 3 * 3600000 },
    { name: 'push', globs: [], desc: 'scope-claim:push', ageMs: 5 * 86400000 },
  ],
  collisions: [{ a: 'P12 Оля', b: 'P11 Ким', overlap: ['daemon/src/front/state.mjs'] }],
}

const BACKLOG_FILE = [
  '# Backlog проекта',
  '',
  '> Свободный текст, который не является строкой доски и не должен на неё попасть.',
  '',
  '## Backlog',
  '',
  '- [ ] **AB-205** · Вторая волна методологий очереди — по данным пилота решить, что докручиваем. `size:M` `area:os` `added:2026-07-17`',
  '- [ ] **QQQ-7** · Работник «вайрфреймер» на базе внешнего инструмента. `size:M` `added:2026-07-16`',
  '- [x] **AB-100** · Уже сделано, и доска не история. `added:2026-05-01`',
  '- **ZZ-1** — Строка без чекбокса тоже строка. `added:2026-08-01`',
  '- просто пункт списка без идентификатора',
  '',
].join('\n')

function fakeFs(files: Record<string, string>) {
  const map = new Map(Object.entries(files).map(([k, v]) => [k.replace(/\\/g, '/'), v]))
  return {
    readdirSync() {
      throw new Error('ENOENT')
    },
    readFileSync(p: string) {
      const k = String(p).replace(/\\/g, '/')
      if (!map.has(k)) throw new Error(`ENOENT: ${k}`)
      return map.get(k) as string
    },
    statSync() {
      throw new Error('ENOENT')
    },
    files: map,
  }
}

// ── fake req/res ──

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

/** A front wired with the coordination + backlog collaborators, all of them recording fakes. */
function mkFront(over: any = {}) {
  const cleared: any[] = []
  const enqueued: any[] = []
  const emitted: any[] = []
  const io = over.fsImpl ?? fakeFs({ [`${PROJECT}/.planning/BACKLOG.md`]: BACKLOG_FILE })
  const ledger = over.ledger === undefined ? LEDGER : over.ledger

  const front = createFrontServer({
    config: { token: TOKEN, ...(over.config ?? CONNECTED) },
    deps: {
      fsImpl: io,
      clock: () => NOW,
      hub: { emit: (e: any) => emitted.push(e) },
      adapter: {
        enqueue: async (t: any) => {
          enqueued.push(t)
          return { id: t.id, coalesced: false }
        },
      },
      deriveCoordination: (args: any) => deriveCoordination({ ...args, readLedger: () => ledger }),
      deriveBacklog,
      clearClaim: async (a: any) => {
        cleared.push(a)
        return over.clearResult ?? { cleared: true, by: 'P12 Оля' }
      },
      ...over.deps,
      fsImpl: io,
    },
  })
  return { front, cleared, enqueued, emitted, io }
}

// ═══════════════ THE SNAPSHOT IS READ, NEVER REMEMBERED ═══════════════

describe('GET /api/coordination — THE SNAPSHOT IS READ, NEVER REMEMBERED', () => {
  it('A COLLISION IS VISIBLE, OR THE PANEL IS DECORATION', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/coordination' })

    expect(res.statusCode).toBe(200)
    const snap = JSON.parse(res.body)
    expect(snap.collisions).toEqual([
      { a: 'P12 Оля', b: 'P11 Ким', overlap: ['daemon/src/front/state.mjs'] },
    ])
  })

  it('the reservations carry the ground they cover and how long they have held it', async () => {
    const { front } = mkFront()
    const snap = JSON.parse((await call(front, { url: '/api/coordination' })).body)
    expect(snap.claims).toEqual([
      { name: 'front-doors', globs: ['daemon/src/front/**'], desc: 'двери фронта', age: '3 ч' },
      { name: 'push', globs: [], desc: 'scope-claim:push', age: '5 дн' },
    ])
    // the two age sources — a duration the reader measured and a moment it reported — read the same
    expect(snap.sessions.map((s: any) => s.age)).toEqual(['2 ч', '45 мин'])
  })

  it('a quiet checkout and no project connected are the same empty panel', async () => {
    const empty = { sessions: [], claims: [], collisions: [] }
    expect(await deriveCoordination({ config: CONNECTED, readLedger: () => empty })).toEqual(empty)
    expect(await deriveCoordination({ config: CONNECTED })).toEqual(empty) // nothing wired to read with
    expect(await deriveCoordination({ config: {}, readLedger: () => LEDGER })).toEqual(empty)
  })

  it('an ASYNC reader — the production shape — is awaited, not consumed as a Promise (QA D3)', async () => {
    // For one release the derive read `.sessions` off the un-awaited Promise: undefined →
    // empty panel while a live session was editing files in the checkout.
    const snap = await deriveCoordination({ config: CONNECTED, readLedger: async () => LEDGER, clock: () => NOW })
    expect(snap.sessions.length).toBeGreaterThan(0)
    expect(snap.collisions.length).toBeGreaterThan(0)
  })

  it('an unreadable ledger is REPORTED, never passed off as an empty checkout (QA D3)', async () => {
    const snap = await deriveCoordination({
      config: CONNECTED,
      readLedger: () => {
        throw new Error('EACCES')
      },
    })
    expect(snap.unreadable).toBe(true)
    // …and the door turns the marker into 503, which the screen's error branch shows.
    const { front } = mkFront({
      deps: { deriveCoordination: async () => ({ sessions: [], claims: [], collisions: [], unreadable: true }) },
    })
    const res = await call(front, { url: '/api/coordination' })
    expect(res.statusCode).toBe(503)
  })

  it('nothing of this machine rides out — no path, no pid, no session file name', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/coordination' })
    expect(res.body).not.toContain(PROJECT)
    expect(res.body).not.toContain('.sma')
    expect(res.body).not.toContain('pid')
  })
})

// ═══════════════ NO RESERVATION IS CLEARED WITHOUT A REASON ═══════════════

describe('POST /api/claim/clear — NO RESERVATION IS CLEARED WITHOUT A REASON', () => {
  it('clears the named reservation and answers with a receipt naming the former holder', async () => {
    const { front, cleared, emitted } = mkFront()
    const res = await call(front, {
      method: 'POST',
      url: '/api/claim/clear',
      body: { claim: 'push', reason: 'терминал закрыт неделю назад, правок в диапазоне нет' },
    })

    expect(res.statusCode).toBe(200)
    expect(cleared).toEqual([{ claim: 'push', reason: 'терминал закрыт неделю назад, правок в диапазоне нет' }])
    expect(JSON.parse(res.body)).toEqual({ ok: true, claim: 'push', receipt: 'claim-clear:push@P12 Оля' })
    expect(emitted).toContainEqual({ event: 'coordination.updated' })
  })

  it('an empty, blank or missing reason is a 400 and the verb is NEVER reached', async () => {
    for (const reason of [undefined, '', '   ', null]) {
      const { front, cleared, emitted } = mkFront()
      const body: any = { claim: 'push' }
      if (reason !== undefined) body.reason = reason
      const res = await call(front, { method: 'POST', url: '/api/claim/clear', body })
      expect(res.statusCode, String(reason)).toBe(400)
      expect(res.body).toContain('reason is required')
      expect(cleared, String(reason)).toHaveLength(0)
      expect(emitted, String(reason)).toHaveLength(0)
    }
  })

  it('A NAME THAT COULD READ AS A FLAG NEVER REACHES THE COMMAND', async () => {
    for (const claim of ['--yes', '-rf', '../../other', 'a/b', '', 'x'.repeat(80), 'a b']) {
      const { front, cleared } = mkFront()
      const res = await call(front, { method: 'POST', url: '/api/claim/clear', body: { claim, reason: 'потому что' } })
      expect(res.statusCode, claim).toBe(400)
      expect(cleared, claim).toHaveLength(0)
    }
  })

  it('an unknown key is a 400 before anything runs — no evidence field is smuggled past the verb', async () => {
    const { front, cleared } = mkFront()
    const res = await call(front, {
      method: 'POST',
      url: '/api/claim/clear',
      body: { claim: 'push', reason: 'потому что', evidence: 'ev-1', checked: 'ничего' },
    })
    expect(res.statusCode).toBe(400)
    expect(cleared).toHaveLength(0)
  })

  it('a reason past the cap is refused rather than truncated into a shorter promise', async () => {
    const { front, cleared } = mkFront()
    const res = await call(front, {
      method: 'POST',
      url: '/api/claim/clear',
      body: { claim: 'push', reason: 'д'.repeat(2001) },
    })
    expect(res.statusCode).toBe(400)
    expect(cleared).toHaveLength(0)
  })

  it("the runtime's own refusal travels back, and nothing is announced as having moved", async () => {
    const refusal = 'Принудительная очистка чужого claim — рискованная операция и требует доказательства'
    const { front, emitted } = mkFront({ clearResult: { cleared: false, reason: refusal } })
    const res = await call(front, { method: 'POST', url: '/api/claim/clear', body: { claim: 'push', reason: 'надо' } })
    expect(res.statusCode).toBe(409)
    expect(res.body).toBe(refusal)
    expect(emitted).toHaveLength(0)
  })

  it('the receipt format is a WORD, not only an example of itself', () => {
    expect(CLAIM_CLEAR_RECEIPT_FORMAT).toBe('claim-clear:<claim>@<by>')
  })
})

// ═══════════════ THE BACKLOG IS PARSED BY SHAPE, NEVER BY DICTIONARY ═══════════════

describe('GET /api/backlog — THE BACKLOG IS PARSED BY SHAPE, NEVER BY DICTIONARY', () => {
  it('three open entries become three cards, whatever the letters in front of the number mean', async () => {
    const { front } = mkFront()
    const res = await call(front, { url: '/api/backlog' })

    expect(res.statusCode).toBe(200)
    const { rows } = JSON.parse(res.body)
    expect(rows).toHaveLength(3)
    expect(rows.map((r: any) => r.id)).toEqual(['AB-205', 'QQQ-7', 'ZZ-1'])
    expect(rows[0].title).toBe('Вторая волна методологий очереди — по данным пилота решить, что докручиваем. `size:M` `area:os` `added:2026-07-17`')
    expect(rows[0].ageLine).toBe('added:2026-07-17')
    // a line with no date tag says nothing rather than guessing one
    expect(rows[2].ageLine).toBe('added:2026-08-01')
  })

  it('a finished line is not work waiting, and prose is not a row', async () => {
    const { front } = mkFront()
    const { rows } = JSON.parse((await call(front, { url: '/api/backlog' })).body)
    expect(rows.some((r: any) => r.id === 'AB-100')).toBe(false)
    expect(rows.some((r: any) => r.title.includes('Свободный текст'))).toBe(false)
    expect(rows.some((r: any) => r.title.includes('просто пункт'))).toBe(false)
  })

  it('this daemon holds NO list of known prefixes — the shape is the whole rule', () => {
    // an identifier nobody in this product has ever seen is a row like any other
    const io = fakeFs({ [`${PROJECT}/.planning/BACKLOG.md`]: '- [ ] **XYZW-42** · Чужой реестр, чужие буквы.' })
    const { rows } = deriveBacklog({ config: CONNECTED, fsImpl: io }) as any
    expect(rows).toEqual([
      {
        id: 'XYZW-42',
        title: 'Чужой реестр, чужие буквы.',
        ageLine: '',
        // …и триаж строки считается тем же чтением, что у скана: заголовок будущей строки
        // очереди, её приоритет и причина, по которой скан её не берёт.
        headline: 'Чужой реестр, чужие буквы.',
        priority: 0,
        notReady: 'не готово к выдаче: нет оценки',
      },
    ])
    // and the door's own guard is the SAME shape, not a second one
    expect(BACKLOG_ID_RE.test('XYZW-42')).toBe(true)
    expect(BACKLOG_ID_RE.test('не-идентификатор')).toBe(false)
  })

  it('no backlog file is an empty board, honestly — never a 404 that reads as a fault', async () => {
    const { front } = mkFront({ fsImpl: fakeFs({}) })
    const res = await call(front, { url: '/api/backlog' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ rows: [] })
    expect(deriveBacklog({ config: {}, fsImpl: fakeFs({}) })).toEqual({ rows: [] })
  })
})

// ═══════════════ PROMOTING A LINE DOES NOT TOUCH THE FILE ═══════════════

describe('POST /api/backlog/promote — PROMOTING A LINE DOES NOT TOUCH THE FILE', () => {
  it('the queue gains a task, and the backlog keeps every byte it had', async () => {
    const { front, enqueued, emitted, io } = mkFront()
    const before = io.files.get(`${PROJECT}/.planning/BACKLOG.md`)

    const res = await call(front, {
      method: 'POST',
      url: '/api/backlog/promote',
      body: { id: 'AB-205', lane: 'research' },
    })

    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].lane).toBe('research')
    expect(enqueued[0].source).toBe('roster')
    expect(enqueued[0].title).toContain('AB-205')
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, id: 'AB-205', taskId: enqueued[0].id })
    expect(emitted).toContainEqual({ event: 'task.queued', taskId: enqueued[0].id })
    // THE FILE IS A HAND, NOT A STORE — byte for byte what it was
    expect(io.files.get(`${PROJECT}/.planning/BACKLOG.md`)).toBe(before)
  })

  it('a title the person typed wins over the line, and the id still names the row', async () => {
    const { front, enqueued } = mkFront()
    await call(front, {
      method: 'POST',
      url: '/api/backlog/promote',
      body: { id: 'QQQ-7', lane: 'prod', title: 'сузить до одного работника' },
    })
    expect(enqueued[0].title).toBe('QQQ-7 · сузить до одного работника')
  })

  it('a line that is not in the file is a 404 — the queue never gains a phantom', async () => {
    const { front, enqueued } = mkFront()
    const res = await call(front, { method: 'POST', url: '/api/backlog/promote', body: { id: 'AB-999', lane: 'prod' } })
    expect(res.statusCode).toBe(404)
    expect(enqueued).toHaveLength(0)
  })

  it('a finished line cannot be promoted — the board and the door read the file the same way', async () => {
    const { front, enqueued } = mkFront()
    const res = await call(front, { method: 'POST', url: '/api/backlog/promote', body: { id: 'AB-100', lane: 'prod' } })
    expect(res.statusCode).toBe(404)
    expect(enqueued).toHaveLength(0)
  })

  it('an id outside the shape, an unknown lane and an unknown key are all a 400', async () => {
    for (const body of [
      { id: '../../etc', lane: 'prod' },
      { id: 'AB-205', lane: 'whatever' },
      { id: 'AB-205', lane: 'prod', corpus: '/elsewhere' },
      { lane: 'prod' },
    ]) {
      const { front, enqueued } = mkFront()
      const res = await call(front, { method: 'POST', url: '/api/backlog/promote', body })
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(enqueued, JSON.stringify(body)).toHaveLength(0)
    }
  })

  it('NO NUMBER IS MINTED HERE — the door allocates nothing and reads no «last one»', async () => {
    const slots: any[] = []
    const { front, enqueued } = mkFront({ deps: { nextSlot: (...a: any[]) => slots.push(a) } })
    await call(front, { method: 'POST', url: '/api/backlog/promote', body: { id: 'AB-205', lane: 'prod' } })
    // the identifier on the queue row is the one the FILE already carries — nothing was allocated
    expect(slots).toHaveLength(0)
    expect(enqueued[0].title.startsWith('AB-205')).toBe(true)
    expect(JSON.parse(String(JSON.stringify(enqueued[0])))).not.toHaveProperty('slot')
  })
})

// ═══════════════ ТРИАЖ СТРОКИ — ОДИН НА ДОСКУ, ДВЕРЬ И ЧАСОВОЙ СКАН ═══════════════
//
// Номера фикстур ВЫДУМАНЫ и живут только здесь: проверяется формат строки реестра, не чей-то
// список задач.

describe('доска реестра говорит, ПОЧЕМУ строка не взята, и чем она поедет в очередь', () => {
  /** Строка в форме карточки 02.09: абзац, в котором название — только первая фраза. */
  const HEAD = 'СКАН РЕЕСТРА МОЛЧА ОТБРАСЫВАЕТ КАРТОЧКИ С ДЛИННЫМ НАЗВАНИЕМ'
  const TRIAGE_FILE = [
    '## Backlog',
    `- [ ] **BL-070** · ${HEAD} (вскрыто 02.09 проверкой триажа). ЗАМЕРЕНО: 15 карточек из 17 ` +
      'пропущены воротами, слова отказа остались в журнале демона, на доске причины нет. ЧТО ПОСТРОИТЬ: ' +
      '(а) пометка срочности становится приоритетом строки; (б) отказ виден словами. ' +
      '`size:M` `added:2026-09-02` `sp:3` `priority:critical`',
    '- [ ] **BL-071** · Работа без оценки — её никто не мерил. `size:S` `added:2026-09-02`',
    '- [ ] **BL-072** · Ждущая работа — после первой половины. `size:S` `added:2026-09-02` `sp:2` `deps:BL-071`',
  ].join('\n')

  const triageFront = () =>
    mkFront({ fsImpl: fakeFs({ [`${PROJECT}/.planning/BACKLOG.md`]: TRIAGE_FILE }) })

  it('каждая строка несёт причину отказа словами — раньше она была только в журнале', async () => {
    const { front } = triageFront()
    const { rows } = JSON.parse((await call(front, { url: '/api/backlog' })).body)
    const by = Object.fromEntries(rows.map((r: any) => [r.id, r]))
    expect(by['BL-070'].notReady).toBe('') // готова — скан её возьмёт
    expect(by['BL-071'].notReady).toMatch(/нет оценки/)
    expect(by['BL-072'].notReady).toContain('BL-071')
  })

  it('строка несёт заголовок будущей строки очереди и число, на котором она в ней встанет', async () => {
    const { front } = triageFront()
    const { rows } = JSON.parse((await call(front, { url: '/api/backlog' })).body)
    const row = rows.find((r: any) => r.id === 'BL-070')
    expect(row.headline).toBe(HEAD)
    // критическая крупнее обычной — то самое число, которым очередь и упорядочивает
    expect(row.priority).toBeGreaterThan(rows.find((r: any) => r.id === 'BL-071').priority)
  })

  it('ДВЕРЬ «В РАБОТУ» И СКАН — ОДИН ПУТЬ: первая фраза заголовком, срочность строки на строке', async () => {
    const { front, enqueued } = triageFront()
    const res = await call(front, { method: 'POST', url: '/api/backlog/promote', body: { id: 'BL-070', lane: 'prod' } })

    expect(res.statusCode).toBe(200)
    // абзац целиком в заголовок не влезал, и ворота отвечали отказом на всю постановку
    expect(enqueued[0].title).toBe(`BL-070 · ${HEAD}`)
    expect(enqueued[0].title.endsWith('…')).toBe(false)
    // …и то же число, что посчитала бы доска и посчитал бы скан
    const { rows } = JSON.parse((await call(front, { url: '/api/backlog' })).body)
    expect(enqueued[0].priority).toBe(rows.find((r: any) => r.id === 'BL-070').priority)
    expect(enqueued[0].priority).toBeGreaterThan(0)
  })

  it('строка без пометки срочности едет размером — той же полосой, что и у скана', async () => {
    const { front, enqueued } = triageFront()
    await call(front, { method: 'POST', url: '/api/backlog/promote', body: { id: 'BL-071', lane: 'prod' } })
    // `size:S` без пометки — обычная полоса, размер вторым ключом: то же число, что у скана
    expect(enqueued[0].priority).toBe(2)
    // …и оно МЕНЬШЕ числа критической строки: полоса срочности через размер не перепрыгивается
    const { rows } = JSON.parse((await call(front, { url: '/api/backlog' })).body)
    expect(enqueued[0].priority).toBeLessThan(rows.find((r: any) => r.id === 'BL-070').priority)
  })
})

// ═══════════════════════════ THE SLOTS ARE FILLED ═══════════════════════════

describe('THE SLOTS ARE FILLED — four keys gone, and the doors answer', () => {
  it('none of the four is named in PENDING_ROUTES any more', () => {
    for (const key of [
      'GET /api/coordination',
      'POST /api/claim/clear',
      'GET /api/backlog',
      'POST /api/backlog/promote',
    ]) {
      expect(PENDING_ROUTES.has(key), key).toBe(false)
    }
  })

  it('a daemon wired with NO collaborator answers «not available here», not a guess', async () => {
    const front = createFrontServer({ config: { token: TOKEN, ...CONNECTED }, deps: {} })
    for (const [method, url] of [
      ['GET', '/api/coordination'],
      ['POST', '/api/claim/clear'],
      ['GET', '/api/backlog'],
      ['POST', '/api/backlog/promote'],
    ]) {
      const res = await call(front, { method, url, body: method === 'POST' ? {} : undefined })
      expect(res.statusCode, url).toBe(501)
    }
  })
})
