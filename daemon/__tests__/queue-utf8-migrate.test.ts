/**
 * Tests for supervisor/queue-utf8-migrate.mjs — the argument surface and the address
 * arithmetic of the migration command.
 *
 * The migration ENGINE lives in daemon/src/queue/encoding.mjs and is covered by
 * queue-encoding.test.ts against injected seams. What is left in the command itself is
 * exactly what a person types and what it resolves to: an unknown flag must be refused
 * rather than ignored, and the two derived connection strings (the admin database, the new
 * database) must point at the same server with only the database changed — a mistake there
 * would run DDL against the wrong server.
 *
 * Importing the script is side-effect-free: its `isMain` guard is false under the runner,
 * and the `pg` client is loaded lazily inside the run path that no test enters.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseArgs, urlForDatabase, databaseOf, daemonQueueUrl } from '../../supervisor/queue-utf8-migrate.mjs'

describe('queue-utf8-migrate — the argument surface', () => {
  it('reports by default: --apply is the only way to change anything', () => {
    expect(parseArgs([]).apply).toBe(false)
    expect(parseArgs(['--apply']).apply).toBe(true)
  })

  it('refuses an unknown flag instead of ignoring it', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown option/)
    expect(() => parseArgs(['--url'])).toThrow(/needs a value/)
  })

  it('carries the connection string, the admin database and the export path', () => {
    const o = parseArgs(['--url', 'postgres://u:p@127.0.0.1:5433/sma_queue', '--admin-db', 'template1', '--out', 'C:/tmp/x.json'])
    expect(o.url).toBe('postgres://u:p@127.0.0.1:5433/sma_queue')
    expect(o.adminDb).toBe('template1')
    expect(o.out).toBe('C:/tmp/x.json')
  })
})

describe('queue-utf8-migrate — the addresses it derives', () => {
  it('changes the database and nothing else about the server', () => {
    const from = 'postgres://postgres:postgres@127.0.0.1:5433/sma_queue'
    const admin = new URL(urlForDatabase(from, 'postgres'))
    expect(admin.pathname).toBe('/postgres')
    expect(admin.host).toBe('127.0.0.1:5433')
    expect(admin.username).toBe('postgres')
    expect(databaseOf(urlForDatabase(from, 'sma_queue_utf8_20260806T100000'))).toBe('sma_queue_utf8_20260806T100000')
  })

  it('refuses a connection string that names no database', () => {
    expect(() => databaseOf('postgres://127.0.0.1:5433')).toThrow(/names no database/)
  })

  it('reads the daemon config without creating one, and answers null when there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sma-migrate-'))
    try {
      const absent = join(dir, 'absent.json')
      expect(daemonQueueUrl(absent)).toBeNull()
      const half = join(dir, 'half.json')
      writeFileSync(half, '{ "queueUrl": ', 'utf8')
      expect(daemonQueueUrl(half)).toBeNull()
      const real = join(dir, 'config.json')
      writeFileSync(real, JSON.stringify({ queueUrl: 'postgres://127.0.0.1:5433/sma_queue' }), 'utf8')
      expect(daemonQueueUrl(real)).toBe('postgres://127.0.0.1:5433/sma_queue')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
