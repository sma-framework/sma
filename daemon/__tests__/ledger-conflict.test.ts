/**
 * Tests for the contradiction lock on the attempt ledger:
 * daemon/src/queue/attempt-ledger.mjs — recordAttempt's mark and foldAttemptRows' flag.
 *
 * WHY THIS FILE EXISTS. A real record on the founder's machine holds three rows for one task:
 * attempt one recorded `failed`, attempt two recorded `completed`, and attempt one recorded
 * `completed` again. One physical try, two numbers, and one number carrying both outcomes —
 * because the two writers took the attempt number from two different counts. The number is now
 * taken from one source (pgboss-backend.mjs), and this file pins the second half: a
 * contradiction can no longer be written silently, and one that is already on disk is READ as
 * a contradiction instead of having a winner picked for it in silence.
 *
 * THE LOCK MARKS, IT NEVER REFUSES. A ledger is an audit log: a row that was refused
 * disappears without trace, and the investigation of the next such failure becomes impossible.
 * So the contradicting row is written — with a mark naming what it contradicts — and the case
 * «не отказывает» asserts the file grows by exactly one line.
 *
 * THE FIXTURE IS THE REAL RECORD, byte for byte, digest-checked against the original at the
 * moment the copy was taken. Its contents are queue data — a queue id, digests, a worktree
 * branch and a base commit — and nothing about a person or a project path.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  recordAttempt,
  readAttempts,
  foldAttemptRows,
  nextAttemptNumber,
  ALLOWED_ATTEMPT_KEYS,
} from '../src/queue/attempt-ledger.mjs'

const tmpDirs: string[] = []
function mkLedgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-ledger-conflict-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

const FIXTURE = join(__dirname, 'fixtures', 'ledger-one-attempt-two-outcomes.jsonl')
/** The task id the real record belongs to — queue DATA, and the name its file must carry. */
const REAL_TASK = 'R-1786727800082'

function lines(file: string): number {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '').length
}

describe('the write door marks a contradiction — and never refuses one', () => {
  it('не отказывает: the contradicting row is WRITTEN, marked, and the file grows by exactly one line', () => {
    const dir = mkLedgerDir()
    const file = join(dir, 'BL-196.jsonl')
    recordAttempt(dir, { taskId: 'BL-196', attempt: 1, outcome: 'failed', failureReason: 'runtime_offline' })
    const before = lines(file)

    const written = recordAttempt(dir, { taskId: 'BL-196', attempt: 1, outcome: 'completed', receiptRef: 'r1' })

    // the row exists, it is the row that was written, and it says what it contradicts
    expect(written.outcome).toBe('completed')
    expect(written.conflictsWith).toBe('failed')
    // ONE line more. Not zero (a refusal), not two.
    expect(lines(file)).toBe(before + 1)
    // and it is on disk, not merely returned
    const rows = readAttempts(dir, 'BL-196')
    expect(rows).toHaveLength(2)
    expect(rows.some((r: any) => r.conflictsWith === 'failed')).toBe(true)
  })

  it('the mark is a member of the closed key list, so nothing else can ride in beside it', () => {
    expect(ALLOWED_ATTEMPT_KEYS).toContain('conflictsWith')
    const dir = mkLedgerDir()
    const written: any = recordAttempt(dir, { taskId: 'BL-196', attempt: 1, outcome: 'failed', notAKey: 'x' } as any)
    expect(written.notAKey).toBeUndefined()
  })

  it('строка тика: an ordinary pair — one number, one outcome — gets NO mark, and the tick row keeps every field it alone knows', () => {
    const dir = mkLedgerDir()
    // the transition row the backend writes
    recordAttempt(dir, {
      taskId: 'BL-196',
      attempt: 1,
      outcome: 'completed',
      receiptRef: 'r1',
      stateMachineVersion: 'fleet-sm-1',
      idempotencyKey: 'k1',
    })
    // the tick's own row: the ONLY place these live
    recordAttempt(dir, {
      taskId: 'BL-196',
      attempt: 1,
      outcome: 'completed',
      startedAt: '2026-08-20T05:00:00.000Z',
      endedAt: '2026-08-20T05:10:00.000Z',
      sessionId: '70ed8949-2c26-4065-843f-109bd21f9707',
      memorySnapshotHash: '7754e052980d345d63eca49a11e2df511b6f9add024aa24c4c8ed40de668d762',
      runDir: '/tmp/project/.sma/runs/BL-196#1',
      parity: { ok: true, checks: 5 },
    })

    const rows = readAttempts(dir, 'BL-196')
    expect(rows).toHaveLength(2)
    // agreeing writers are the NORMAL case and are never marked
    expect(rows.some((r: any) => r.conflictsWith !== undefined)).toBe(false)
    // and the rich half of the pair is on disk, whole
    const tick: any = rows.find((r: any) => r.sessionId)
    expect(tick.startedAt).toBe('2026-08-20T05:00:00.000Z')
    expect(tick.sessionId).toBe('70ed8949-2c26-4065-843f-109bd21f9707')
    expect(tick.memorySnapshotHash).toBe('7754e052980d345d63eca49a11e2df511b6f9add024aa24c4c8ed40de668d762')
    expect(tick.runDir).toBe('/tmp/project/.sma/runs/BL-196#1')
    expect(tick.parity).toEqual({ ok: true, checks: 5 })
    // and folding the pair keeps them
    const [folded]: any = foldAttemptRows(rows)
    expect(folded.conflict).toBeUndefined()
    expect(folded.sessionId).toBe('70ed8949-2c26-4065-843f-109bd21f9707')
    expect(folded.runDir).toBe('/tmp/project/.sma/runs/BL-196#1')
  })

  it('a ledger file that cannot be parsed costs the row no mark — and never the write itself', () => {
    const dir = mkLedgerDir()
    const file = join(dir, 'BL-196.jsonl')
    writeFileSync(file, 'not json at all\n{"broken"\n')
    const written: any = recordAttempt(dir, { taskId: 'BL-196', attempt: 1, outcome: 'completed', receiptRef: 'r' })
    expect(written.outcome).toBe('completed')
    expect(written.conflictsWith).toBeUndefined()
    expect(lines(file)).toBe(3)
  })

  it('a non-terminal outcome is not a contradiction: running beside completed is one try reporting twice', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-196', attempt: 1, outcome: 'running' })
    const written: any = recordAttempt(dir, { taskId: 'BL-196', attempt: 1, outcome: 'completed', receiptRef: 'r' })
    expect(written.conflictsWith).toBeUndefined()
  })

  it('a contradiction at a DIFFERENT attempt number is not a contradiction — that is two tries, which is ordinary', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-196', attempt: 1, outcome: 'failed', failureReason: 'runtime_offline' })
    const written: any = recordAttempt(dir, { taskId: 'BL-196', attempt: 2, outcome: 'completed', receiptRef: 'r' })
    expect(written.conflictsWith).toBeUndefined()
  })
})

describe('the reader shows the contradiction instead of picking a winner in silence', () => {
  it('настоящая запись: the record from the live machine reads as an anomaly and loses NOT ONE row', () => {
    const dir = mkLedgerDir()
    copyFileSync(FIXTURE, join(dir, `${REAL_TASK}.jsonl`))

    const rows: any[] = readAttempts(dir, REAL_TASK)
    // THREE rows in, three rows out. The lock must never cost this record a line.
    expect(rows).toHaveLength(3)

    const folded: any[] = foldAttemptRows(rows)
    expect(folded).toHaveLength(2) // two attempt numbers: 1 and 2

    const one: any = folded.find((r) => r.attempt === 1)
    const two: any = folded.find((r) => r.attempt === 2)

    // ── the anomaly is NAMED, and it names both outcomes and how many rows it saw ──
    expect(one.conflict).toBeDefined()
    expect(one.conflict.outcomes).toEqual(['failed', 'completed'])
    expect(one.conflict.rows).toBe(2)
    // attempt two is an ordinary single-row try and stays silent
    expect(two.conflict).toBeUndefined()

    // ── and the rich half survived the fold, field by field ──
    // (these three are what the tick's row alone knows; this record predates runDir and
    //  parity and therefore carries neither — asserting them here would be a lie about it)
    expect(one.startedAt).toBe('2026-08-14T17:18:42.817Z')
    expect(one.sessionId).toBe('70ed8949-2c26-4065-843f-109bd21f9707')
    expect(one.memorySnapshotHash).toBe('7754e052980d345d63eca49a11e2df511b6f9add024aa24c4c8ed40de668d762')

    // the failure reason it inherited from the backend row no longer passes itself off as a
    // property of a clean success: the record says outright that the two outcomes disagree
    expect(one.failureReason).toBe('runtime_offline')
    expect(one.conflict.outcomes).toContain('failed')
  })

  it('the flag fires on OLD rows that carry no writer mark at all — which is exactly what lies on disk today', () => {
    const dir = mkLedgerDir()
    copyFileSync(FIXTURE, join(dir, `${REAL_TASK}.jsonl`))
    const rows: any[] = readAttempts(dir, REAL_TASK)
    // not one row in the real record carries the writer's mark: it was written before the mark
    // existed, and the ledger is never rewritten to make it look otherwise
    expect(rows.some((r) => r.conflictsWith !== undefined)).toBe(false)
    const one: any = foldAttemptRows(rows).find((r: any) => r.attempt === 1)
    expect(one.conflict).toBeDefined()
  })
})

/**
 * ═══ СХЕМА СТРОКИ: ВТОРОЙ ЕДИНИЦЫ НЕ БЫВАЕТ, А ОТМЕТКА — ВСЕГДА МОМЕНТ ═══════════════════
 *
 * ТА ЖЕ БЕДА, ЧТО У ДЕЛ ВЫШЕ, ВЗЯТАЯ ЗА ДРУГОЙ КОНЕЦ. Там одна физическая попытка легла в реестр
 * двумя номерами; здесь — две физические попытки под ОДНИМ номером 1, потому что счёт ведёт
 * очередь, а очередь его забывает: строку законченной работы уносит в архив по сроку хранения, и
 * карточка, поставленная заново, начинает считать с единицы. Замерено 31.08.2026 на живой доске.
 * Каталогом прогона служит `<taskId>#<attempt>`, ключ идемпотентности минтится из того же номера,
 * а сверка находит «попытку 1» уже записанной — одно повторённое число молча накрывает запись
 * предыдущего подхода.
 *
 * И ВТОРАЯ ПОЛОВИНА ТОЙ ЖЕ УЛИКИ: у той же строки `startedAt` оказался сырым числом эпохи вместо
 * ISO — единственный видимый признак того, что писал её не штатный путь захвата. Признак,
 * который читатель отличить не может: на карточке оба вида рисуются временем.
 */
describe('схема строки реестра: счёт подходов монотонен, отметки времени — только ISO', () => {
  const EPOCH = 1_756_640_580_000 // сырое число эпохи, ровно тем видом, каким оно легло на строку

  it('сырое число эпохи в startedAt на долговечную строку не попадает — оно становится моментом', () => {
    const dir = mkLedgerDir()
    const written: any = recordAttempt(dir, {
      taskId: 'R-176',
      attempt: 1,
      outcome: 'completed',
      receiptRef: 'reverify:abc',
      startedAt: EPOCH,
      endedAt: EPOCH + 60_000,
    })
    expect(written.startedAt).toBe(new Date(EPOCH).toISOString())
    // …и на ДИСКЕ то же самое, а не только в возвращённой форме: читателя строки интересует файл
    const [stored]: any = readAttempts(dir, 'R-176')
    expect(typeof stored.startedAt).toBe('string')
    expect(stored.startedAt).toBe(new Date(EPOCH).toISOString())
    expect(stored.endedAt).toBe(new Date(EPOCH + 60_000).toISOString())
  })

  it('уже правильный ISO дверь не трогает — приведение это лечение вида, а не вторая запись', () => {
    const dir = mkLedgerDir()
    const iso = '2026-08-31T11:03:00.000Z'
    const written: any = recordAttempt(dir, { taskId: 'R-176', attempt: 1, outcome: 'failed', startedAt: iso })
    expect(written.startedAt).toBe(iso)
  })

  it('отметка, которая моментом не читается, ключа не получает — отсутствие честнее мусора', () => {
    const dir = mkLedgerDir()
    const written: any = recordAttempt(dir, {
      taskId: 'R-177',
      attempt: 1,
      outcome: 'failed',
      failureReason: 'provider_error',
      startedAt: 'позавчера вечером',
    })
    expect('startedAt' in written).toBe(false)
    // строка при этом ЗАПИСАНА: аудит не теряется из-за формы одной своей отметки
    const [stored]: any = readAttempts(dir, 'R-177')
    expect(stored.outcome).toBe('failed')
    expect(stored.recordedAt).toBeDefined()
  })

  it('номер подхода строго больше всякого ЗАКОНЧЕННОГО — вторая попытка не пишется единицей', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'R-178', attempt: 1, outcome: 'failed', failureReason: 'provider_error' })
    recordAttempt(dir, { taskId: 'R-178', attempt: 2, outcome: 'completed', receiptRef: 'reverify:abc' })
    // очередь забыла прожитое и называет подход первым — реестр помнит два законченных
    expect(nextAttemptNumber(readAttempts(dir, 'R-178'), 1)).toBe(3)
  })

  it('идущий подход остаётся собой: второй писатель ТОЙ ЖЕ попытки её номер не двигает', () => {
    const dir = mkLedgerDir()
    // переход пишет свою строку без исхода — попытка идёт прямо сейчас
    recordAttempt(dir, { taskId: 'R-179', attempt: 3, startedAt: '2026-09-01T10:00:00.000Z' })
    expect(nextAttemptNumber(readAttempts(dir, 'R-179'), 3)).toBe(3)
  })

  it('больший номер очереди принимается как есть — реестр поднимает счёт, но не опускает', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'R-181', attempt: 1, outcome: 'failed', failureReason: 'timeout' })
    expect(nextAttemptNumber(readAttempts(dir, 'R-181'), 7)).toBe(7)
  })

  it('молчащий реестр не выдумывает прожитого: первый подход остаётся первым', () => {
    expect(nextAttemptNumber([], 1)).toBe(1)
    expect(nextAttemptNumber(null as any, undefined as any)).toBe(1)
  })
})
