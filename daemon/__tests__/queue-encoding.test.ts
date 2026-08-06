/**
 * Tests for daemon/src/queue/encoding.mjs — the queue database's character encoding:
 * detected at boot, named when it is wrong, and migrated by a command.
 *
 * WHY THIS FILE EXISTS. A PostgreSQL cluster initialised by the Windows `initdb` defaults
 * to the ANSI code page (WIN1252 on a Western install), and a database created on that
 * cluster inherits it. Such a database CANNOT store a task title written in Cyrillic — or
 * Greek, or Japanese, or an emoji: the server refuses the INSERT with `22P05`. People name
 * their work in their own language, so this is not an exotic edge; it is the first task the
 * founder of a non-English team types. Before this module the product answered that with a
 * driver stack trace and no way out.
 *
 * NO LIVE POSTGRES. Every seam here is a function — `execSql(sql, params) -> {rows}`, the
 * admin executor, and the factory that opens the target database — exactly as the rest of
 * the queue suite tests the backend against a fake pg-boss. The migration's SQL is asserted
 * as text because the text IS the behaviour: which statement is sent, in which order, and
 * what is done when the second rename fails.
 */

import { describe, it, expect } from 'vitest'

import {
  UTF8,
  UNTRANSLATABLE_CHARACTER,
  QueueEncodingError,
  readQueueEncoding,
  describeEncoding,
  describeUntranslatable,
  createDatabaseStatement,
  migrateQueueEncoding,
  MIGRATE_COMMAND,
} from '../src/queue/encoding.mjs'
import { createPgBossQueue } from '../src/queue/pgboss-backend.mjs'

// ── detection ─────────────────────────────────────────────────────────────────────────

const encodingRow = (server: string, client = 'WIN1252', database = 'sma_queue') => ({
  rows: [{ database, server_encoding: server, client_encoding: client }],
})

describe('readQueueEncoding — one read-only question, answered or honestly absent', () => {
  it('reads the database name, the server encoding and the client encoding', async () => {
    const seen: string[] = []
    const execSql = async (sql: string) => {
      seen.push(sql)
      return encodingRow('WIN1252')
    }
    const info = await readQueueEncoding(execSql)
    expect(info).toEqual({ database: 'sma_queue', serverEncoding: 'WIN1252', clientEncoding: 'WIN1252' })
    expect(seen[0]).toContain('pg_encoding_to_char')
    expect(seen[0]).toContain('current_database()')
  })

  it('answers null rather than throwing when the seam cannot answer', async () => {
    expect(await readQueueEncoding(async () => ({ rows: [] }))).toBeNull()
    expect(
      await readQueueEncoding(async () => {
        throw new Error('permission denied for table pg_database')
      }),
    ).toBeNull()
    expect(await readQueueEncoding(undefined as any)).toBeNull()
  })
})

describe('describeEncoding — a UTF-8 database says nothing, anything else says what and how', () => {
  it('is silent on UTF8 (the diagnosis is not noise on a healthy install)', () => {
    expect(describeEncoding({ database: 'sma_queue', serverEncoding: UTF8, clientEncoding: UTF8 })).toBeNull()
    expect(describeEncoding(null)).toBeNull()
  })

  it('names the database, what will happen to a non-ASCII title, and the command that fixes it', () => {
    const lines = describeEncoding({ database: 'sma_queue', serverEncoding: 'WIN1252', clientEncoding: UTF8 })
    expect(lines).not.toBeNull()
    const text = (lines as string[]).join('\n')
    expect(text).toContain('sma_queue')
    expect(text).toContain('WIN1252')
    expect(text).toContain(UTF8)
    // the CONSEQUENCE, in words a person can act on — not just the fact of the encoding
    expect(text.toLowerCase()).toMatch(/refus|cannot be stored|will not be stored/)
    // the ACTION
    expect(text).toContain(MIGRATE_COMMAND)
  })
})

describe('describeUntranslatable — the refusal a person can read', () => {
  it('turns the driver error for an unstorable character into an instruction', () => {
    const err: any = new Error(
      'character with byte sequence 0xd0 0x97 in encoding "UTF8" has no equivalent in encoding "WIN1252"',
    )
    err.code = UNTRANSLATABLE_CHARACTER
    const said = describeUntranslatable(err, { database: 'sma_queue', serverEncoding: 'WIN1252' })
    expect(said).toBeTruthy()
    expect(said).toContain('sma_queue')
    expect(said).toContain(MIGRATE_COMMAND)
  })

  it('is null for any other error — it never dresses up a failure it does not understand', () => {
    const other: any = new Error('duplicate key value violates unique constraint')
    other.code = '23505'
    expect(describeUntranslatable(other, { database: 'sma_queue' })).toBeNull()
    expect(describeUntranslatable(null, { database: 'sma_queue' })).toBeNull()
  })
})

// ── the backend wires both of them ────────────────────────────────────────────────────

/** A boss fake narrow enough to see exactly what the two encoding paths do. */
function mkBoss(overrides: any = {}) {
  return {
    async start() {
      return true
    },
    async stop() {
      return true
    },
    on() {
      /* no-op */
    },
    async createQueue() {
      return true
    },
    async send() {
      return 'job-1'
    },
    ...overrides,
  }
}

const roster = (over: any = {}) => ({ id: 'R-1', source: 'roster', title: 'сделать задачу', lane: 'prod', ...over })

describe('the durable queue tells the founder its database cannot hold their language', () => {
  it('start() on a WIN1252 database logs the diagnosis with its action, and boots anyway', async () => {
    const lines: string[] = []
    const execSql = async (sql: string) => (sql.includes('pg_encoding_to_char') ? encodingRow('WIN1252') : { rows: [] })
    const adapter = createPgBossQueue({ boss: mkBoss(), execSql, log: (m: string) => lines.push(m) })
    await expect(adapter.start()).resolves.toBe(true) // a wrong encoding is not a boot failure
    const text = lines.join('\n')
    expect(text).toContain('WIN1252')
    expect(text).toContain(MIGRATE_COMMAND)
    expect(adapter.encoding()).toEqual({ database: 'sma_queue', serverEncoding: 'WIN1252', clientEncoding: 'WIN1252' })
  })

  it('start() on a UTF8 database says nothing about encoding at all', async () => {
    const lines: string[] = []
    const execSql = async (sql: string) =>
      sql.includes('pg_encoding_to_char') ? encodingRow(UTF8, UTF8) : { rows: [] }
    const adapter = createPgBossQueue({ boss: mkBoss(), execSql, log: (m: string) => lines.push(m) })
    await adapter.start()
    expect(lines.join('\n')).not.toMatch(/encoding/i)
  })

  it('an enqueue the database refuses for its encoding raises a named, readable error', async () => {
    const execSql = async (sql: string) => (sql.includes('pg_encoding_to_char') ? encodingRow('WIN1252') : { rows: [] })
    const boss = mkBoss({
      async send() {
        const err: any = new Error('character with byte sequence 0xd0 0xa1 in encoding "UTF8" has no equivalent in encoding "WIN1252"')
        err.code = UNTRANSLATABLE_CHARACTER
        throw err
      },
    })
    const adapter = createPgBossQueue({ boss, execSql, log: () => {} })
    await adapter.start()
    await expect(adapter.enqueue(roster())).rejects.toThrow(QueueEncodingError)
    await expect(adapter.enqueue(roster())).rejects.toThrow(MIGRATE_COMMAND)
  })
})

// ── the migration ─────────────────────────────────────────────────────────────────────

describe('createDatabaseStatement — UTF8 over template0, and never an injected name', () => {
  it('creates over template0 with an explicit UTF8 encoding', () => {
    const sql = createDatabaseStatement('sma_queue_utf8')
    expect(sql).toContain('CREATE DATABASE "sma_queue_utf8"')
    expect(sql).toContain("ENCODING 'UTF8'")
    expect(sql).toContain('TEMPLATE template0')
  })

  it('refuses a name that is not a plain identifier (a database name cannot be a parameter)', () => {
    for (const bad of ['sma"; DROP DATABASE postgres; --', 'has space', '1abc', '', 'a'.repeat(64)]) {
      expect(() => createDatabaseStatement(bad), bad).toThrow()
    }
  })
})

/** A source database: two pending tasks, one finished job, two approval rows. */
function mkSource(serverEncoding = 'WIN1252') {
  const calls: Array<{ sql: string; params: any[] }> = []
  const sourceSql = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('pg_encoding_to_char')) return encodingRow(serverEncoding)
    if (sql.includes('pg_stat_activity')) return { rows: [{ others: 0 }] }
    if (sql.includes('pgboss.job')) {
      return {
        rows: [
          { id: 'job-1', name: 'sma.task.prod', data: { id: 'R-1', source: 'roster', title: 'first', lane: 'prod', attempt: 1 }, state: 'created', retry_count: 0 },
          { id: 'job-2', name: 'sma.task.research', data: { id: 'R-2', source: 'roster', title: 'second', lane: 'research', attempt: 1 }, state: 'active', retry_count: 2 },
        ],
      }
    }
    if (sql.includes('sma_task_attempts')) {
      return {
        rows: [
          { id: 'R-9', status: 'awaiting_approval', dispatched_at: 7, returned_note: null, merge_receipt: 'reverify:abc' },
          { id: 'R-8', status: 'awaiting_approval', dispatched_at: null, returned_note: 'вернул', merge_receipt: null },
        ],
      }
    }
    return { rows: [] }
  }
  return { sourceSql, calls }
}

function mkTarget() {
  const enqueued: any[] = []
  const written: Array<{ sql: string; params: any[] }> = []
  let stopped = false
  const openTarget = async () => ({
    async enqueue(task: any) {
      enqueued.push(task)
      return { id: task.id }
    },
    async execSql(sql: string, params: any[] = []) {
      written.push({ sql, params })
      return { rows: [] }
    },
    async stop() {
      stopped = true
      return true
    },
  })
  return { openTarget, enqueued, written, stopped: () => stopped }
}

function mkAdmin(failures: Record<string, Error> = {}) {
  const statements: string[] = []
  const adminSql = async (sql: string) => {
    statements.push(sql)
    for (const [needle, err] of Object.entries(failures)) if (sql.includes(needle)) throw err
    return { rows: [] }
  }
  return { adminSql, statements }
}

describe('migrateQueueEncoding — the door out of a database that cannot hold the language', () => {
  it('a UTF8 database is a no-op that says so', async () => {
    const { sourceSql } = mkSource(UTF8)
    const { adminSql, statements } = mkAdmin()
    const report = await migrateQueueEncoding({
      database: 'sma_queue',
      sourceSql,
      adminSql,
      openTarget: mkTarget().openTarget,
      apply: true,
    })
    expect(report.applied).toBe(false)
    expect(report.reason).toBe('already_utf8')
    expect(statements).toEqual([]) // nothing was created, nothing was renamed
  })

  it('refuses while anything else is connected, and names the reason', async () => {
    const busy = async (sql: string) => {
      if (sql.includes('pg_encoding_to_char')) return encodingRow('WIN1252')
      if (sql.includes('pg_stat_activity')) return { rows: [{ others: 2 }] }
      return { rows: [] }
    }
    const { adminSql, statements } = mkAdmin()
    const report = await migrateQueueEncoding({
      database: 'sma_queue',
      sourceSql: busy,
      adminSql,
      openTarget: mkTarget().openTarget,
      apply: true,
    })
    expect(report.applied).toBe(false)
    expect(report.reason).toBe('in_use')
    expect(report.otherConnections).toBe(2)
    expect(statements).toEqual([])
  })

  it('without --apply it inventories and changes nothing', async () => {
    const { sourceSql } = mkSource()
    const { adminSql, statements } = mkAdmin()
    const target = mkTarget()
    const report = await migrateQueueEncoding({
      database: 'sma_queue',
      sourceSql,
      adminSql,
      openTarget: target.openTarget,
    })
    expect(report.applied).toBe(false)
    expect(report.reason).toBe('dry_run')
    expect(report.pending).toBe(2)
    expect(report.approvals).toBe(2)
    expect(statements).toEqual([])
    expect(target.enqueued).toEqual([])
    expect(report.notCarried.length).toBeGreaterThan(0)
  })

  it('carries the pending tasks and the attempt rows, keeps the old database, and says what it left', async () => {
    const { sourceSql } = mkSource()
    const { adminSql, statements } = mkAdmin()
    const target = mkTarget()
    const snapshots: any[] = []
    const report = await migrateQueueEncoding({
      database: 'sma_queue',
      sourceSql,
      adminSql,
      openTarget: target.openTarget,
      snapshot: async (payload: any) => {
        snapshots.push(payload)
        return 'C:/tmp/queue-migration.json'
      },
      apply: true,
      clock: () => Date.parse('2026-08-06T10:00:00Z'),
    })

    expect(report.applied).toBe(true)
    expect(report.carried).toEqual({ tasks: 2, approvals: 2 })

    // the two pending tasks came over, and the one a worker held is queued again
    expect(target.enqueued.map((t) => t.id).sort()).toEqual(['R-1', 'R-2'])
    // its attempt NUMBER survives — the queue's retry counter does not travel, the number does
    expect(target.enqueued.find((t) => t.id === 'R-2').attempt).toBe(3)

    // the approval rows were written into the new database
    expect(target.written).toHaveLength(2)
    expect(target.written[0].sql).toContain('sma_task_attempts')
    expect(target.written[0].params).toContain('R-9')
    expect(target.stopped()).toBe(true)

    // the DDL: create UTF8, archive the old under a new name, put the new one in its place
    expect(statements[0]).toContain("ENCODING 'UTF8'")
    expect(statements[1]).toContain('ALTER DATABASE "sma_queue" RENAME TO')
    expect(statements[2]).toContain('RENAME TO "sma_queue"')
    expect(statements.join('\n')).not.toContain('DROP DATABASE') // nothing is ever deleted
    expect(report.archivedAs).toBeTruthy()
    expect(report.archivedAs).not.toBe('sma_queue')

    // the export was written BEFORE any DDL ran
    expect(snapshots).toHaveLength(1)
    expect(report.snapshotPath).toBe('C:/tmp/queue-migration.json')

    // honesty: what does NOT come over is printed, not swallowed
    const left = report.notCarried.join('\n').toLowerCase()
    expect(left).toMatch(/history|finished|completed/)
    expect(left).toMatch(/worker|claimed|held/)
  })

  /**
   * A task that cannot be re-enqueued must stop the migration BEFORE the names move: at that
   * point the new database is an extra database and nothing has been lost, while a swap done
   * around a dropped task would leave the queue looking healthy and one task simply gone.
   */
  it('stops before any rename when a task will not go into the new database, and names it', async () => {
    const { sourceSql } = mkSource()
    const { adminSql, statements } = mkAdmin()
    const openTarget = async () => ({
      async enqueue(task: any) {
        if (task.id === 'R-2') throw new Error('title exceeds 200 characters')
        return { id: task.id }
      },
      async execSql() {
        return { rows: [] }
      },
      async stop() {
        return true
      },
    })
    await expect(
      migrateQueueEncoding({ database: 'sma_queue', sourceSql, adminSql, openTarget, apply: true }),
    ).rejects.toThrow(/R-2/)
    expect(statements.filter((s) => s.includes('RENAME'))).toEqual([])
    expect(statements.join('\n')).toContain("ENCODING 'UTF8'") // the half-built database is named in the error
  })

  it('puts the old database back under its own name when the second rename fails', async () => {
    const { sourceSql } = mkSource()
    const boom = new Error('database "sma_queue" already exists')
    // fails ONLY the rename of the freshly built database into place
    const { adminSql, statements } = mkAdmin({ 'ALTER DATABASE "sma_queue_utf8_': boom })
    await expect(
      migrateQueueEncoding({
        database: 'sma_queue',
        sourceSql,
        adminSql,
        openTarget: mkTarget().openTarget,
        apply: true,
        clock: () => Date.parse('2026-08-06T10:00:00Z'),
      }),
    ).rejects.toThrow(QueueEncodingError)
    // the last statement puts the archived database back where the daemon expects it
    expect(statements[statements.length - 1]).toContain('RENAME TO "sma_queue"')
    expect(statements[statements.length - 1]).toContain('ALTER DATABASE "sma_queue_pre_utf8_')
  })
})
