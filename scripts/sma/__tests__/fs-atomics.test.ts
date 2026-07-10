/**
 * Tests for scripts/sma/lib/fs-atomics.mjs (Phase 49 Plan 03, Task 1).
 *
 * RESEARCH Pattern 4 — the one novel primitive with no repo analog:
 *   - atomicWriteJson stages the temp file as a SAME-DIR sibling of the target
 *     (never os.tmpdir() — a cross-volume rename is not atomic on Windows, B18).
 *   - renameWithRetry retries transient Windows locks (EPERM/EACCES/EBUSY) with
 *     exponential backoff (Windows Defender transient locks — RESEARCH Pattern 4).
 *   - a non-retryable error (ENOENT) rethrows immediately, no retries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { atomicWriteJson, renameWithRetry, readJsonSafe } from '../lib/fs-atomics.mjs'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sma-fsatomics-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('atomicWriteJson', () => {
  it('stages the temp file in the SAME directory as the target, then the final file parses back', () => {
    const target = join(workDir, 'nested', 'state.json')
    const obj = { a: 1, b: 'two', nested: { c: [3, 4] } }

    let capturedTmp: string | null = null
    // Inject the rename fn to capture the temp path before it moves onto target.
    atomicWriteJson(target, obj, {
      renameFn: (from: string, to: string) => {
        capturedTmp = from
        // delegate to the real rename to actually land the file
        // (importing fs here keeps the injection honest)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('node:fs').renameSync(from, to)
      },
    })

    expect(capturedTmp).not.toBeNull()
    // The temp file must be a SIBLING of the target (same dirname) — never %TEMP%.
    expect(dirname(capturedTmp as unknown as string)).toBe(dirname(target))
    expect(existsSync(target)).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(obj)
  })
})

describe('renameWithRetry', () => {
  it('succeeds after N injected EPERM failures (5 attempts max, backoff starts ~50ms)', () => {
    let calls = 0
    const flaky = (_from: string, _to: string) => {
      calls += 1
      if (calls < 3) {
        const err: NodeJS.ErrnoException = new Error('transient lock')
        err.code = 'EPERM'
        throw err
      }
      // 3rd call succeeds
    }

    expect(() =>
      renameWithRetry('a', 'b', { attempts: 5, baseDelayMs: 1, renameFn: flaky }),
    ).not.toThrow()
    expect(calls).toBe(3)
  })

  it('rethrows a non-retryable error (ENOENT) immediately without retries', () => {
    let calls = 0
    const boom = (_from: string, _to: string) => {
      calls += 1
      const err: NodeJS.ErrnoException = new Error('missing')
      err.code = 'ENOENT'
      throw err
    }

    expect(() =>
      renameWithRetry('a', 'b', { attempts: 5, baseDelayMs: 1, renameFn: boom }),
    ).toThrow(/missing/)
    expect(calls).toBe(1)
  })
})

describe('readJsonSafe', () => {
  it('returns null (never throws) for a missing or malformed file', () => {
    expect(readJsonSafe(join(workDir, 'does-not-exist.json'))).toBeNull()
    const bad = join(workDir, 'bad.json')
    require('node:fs').writeFileSync(bad, '{ not valid json ')
    expect(readJsonSafe(bad)).toBeNull()
  })
})
