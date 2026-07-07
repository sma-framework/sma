/**
 * fs-atomics.mjs — Windows-aware atomic-write helpers (RESEARCH Pattern 4).
 *
 * The one novel primitive in the SMA layer with no repo analog. Every SMA write
 * path (heartbeats, claim provenance, MEMORY.md regen, journal) routes through
 * these so the temp->rename / Windows-retry semantics are written once.
 *
 * Key rules (RESEARCH Pattern 4, B18):
 *   - Temp files are staged as SAME-DIR siblings of the final target — never
 *     the OS temp dir: on Windows that can resolve to a different drive, and a
 *     cross-volume rename is NOT atomic (Node falls back to copy+delete).
 *   - renameWithRetry retries transient Windows locks (EPERM/EACCES/EBUSY) with
 *     exponential backoff (Windows Defender real-time scanning holds a just-written
 *     file for a few ms; graceful-fs gives up when the destination already exists).
 *
 * Node built-ins only; every fs call is dependency-injectable for tests.
 */

import {
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
  readFileSync as fsReadFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Transient Windows lock codes worth retrying (RESEARCH Pattern 4). */
const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Synchronous sleep for a short, bounded backoff in a one-shot CLI context.
 * Uses Atomics.wait on a throwaway buffer so we do not busy-spin the CPU.
 */
function sleepSync(ms) {
  if (ms <= 0) return
  const sab = new SharedArrayBuffer(4)
  const view = new Int32Array(sab)
  Atomics.wait(view, 0, 0, ms)
}

/**
 * renameWithRetry(from, to, opts) — rename with exponential backoff on transient
 * Windows locks. Retries ONLY EPERM/EACCES/EBUSY; any other error rethrows at once.
 *
 * @param {string} from
 * @param {string} to
 * @param {{attempts?:number, baseDelayMs?:number, renameFn?:Function, sleepFn?:Function}} [opts]
 */
export function renameWithRetry(from, to, opts = {}) {
  const attempts = opts.attempts ?? 5
  const baseDelayMs = opts.baseDelayMs ?? 50
  const renameFn = opts.renameFn ?? fsRenameSync
  const sleepFn = opts.sleepFn ?? sleepSync

  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      renameFn(from, to)
      return
    } catch (err) {
      if (!RETRYABLE_CODES.has(err && err.code)) throw err // non-retryable -> immediate
      lastErr = err
      if (i < attempts - 1) {
        // 50 -> 100 -> 200 -> 400 -> 800ms (capped)
        const delay = Math.min(baseDelayMs * 2 ** i, 800)
        sleepFn(delay)
      }
    }
  }
  throw lastErr
}

/**
 * atomicWriteJson(targetPath, obj, opts) — write JSON atomically:
 * mkdir the parent, write a `.tmp-<pid>-<random>` sibling in the SAME dir, then
 * renameWithRetry over the target (RESEARCH Pattern 4 verbatim — never the OS temp dir).
 *
 * @param {string} targetPath
 * @param {*} obj
 * @param {{mkdirFn?:Function, writeFn?:Function, renameFn?:Function}} [opts]
 */
export function atomicWriteJson(targetPath, obj, opts = {}) {
  const mkdirFn = opts.mkdirFn ?? fsMkdirSync
  const writeFn = opts.writeFn ?? fsWriteFileSync

  const dir = dirname(targetPath)
  mkdirFn(dir, { recursive: true })

  const tmpName = `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  const tmpPath = join(dir, tmpName) // SAME-DIR sibling — never the OS temp dir
  writeFn(tmpPath, JSON.stringify(obj, null, 2))
  renameWithRetry(tmpPath, targetPath, { renameFn: opts.renameFn })
}

/**
 * atomicWriteRaw(targetPath, text, opts) — write a raw string atomically (same
 * temp-sibling + renameWithRetry contract as atomicWriteJson, but no JSON.stringify).
 * The report generator (49.1-24) uses this so a half-written HTML file is never
 * observed — a reader either sees the previous report or the new one, never a torn one.
 *
 * @param {string} targetPath
 * @param {string} text
 * @param {{mkdirFn?:Function, writeFn?:Function, renameFn?:Function}} [opts]
 */
export function atomicWriteRaw(targetPath, text, opts = {}) {
  const mkdirFn = opts.mkdirFn ?? fsMkdirSync
  const writeFn = opts.writeFn ?? fsWriteFileSync

  const dir = dirname(targetPath)
  mkdirFn(dir, { recursive: true })

  const tmpName = `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  const tmpPath = join(dir, tmpName) // SAME-DIR sibling — never the OS temp dir
  writeFn(tmpPath, typeof text === 'string' ? text : String(text ?? ''))
  renameWithRetry(tmpPath, targetPath, { renameFn: opts.renameFn })
}

/**
 * readJsonSafe(path, opts) -> object | null. Never throws — the fail-open building
 * block for corrupted/absent .sma state (C9). Missing file or invalid JSON -> null.
 *
 * @param {string} path
 * @param {{readFn?:Function}} [opts]
 * @returns {object|null}
 */
export function readJsonSafe(path, opts = {}) {
  const readFn = opts.readFn ?? fsReadFileSync
  try {
    return JSON.parse(readFn(path, 'utf8'))
  } catch {
    return null
  }
}
