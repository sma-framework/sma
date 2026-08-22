/**
 * Tests for scripts/sma/lib/statusline-install.mjs — the managed statusLine edit, called
 * IN-PROCESS (no child processes, so this file stays in the parallel project).
 *
 * What is worth asserting here, as opposed to in the CLI round-trip suite next door: the
 * core is now the ONE implementation shared by the verb, the selftest and the installer, so
 * every branch of it has to be pinned where it lives rather than through whichever caller
 * happens to exercise it. The branches:
 *   - the exact entry an install writes (a retyped literal is how two copies drift apart);
 *   - healing an entry that is ours but written in an older shape — including the promise
 *     that healing does NOT rewrite the file holding the adopter's own saved command;
 *   - the idempotent no-op, decided by the whole entry rather than by the command alone;
 *   - the wrap round trip: a foreign command preserved verbatim and given back verbatim;
 *   - the never-clobber guard: any other key moving aborts the write entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyStatuslineInstall,
  writeSettingsStatusLineOnly,
  canonicalStatuslineEntry,
  SMA_STATUSLINE_CMD,
  SMA_STATUSLINE_WRAP_CMD,
  STATUSLINE_REFRESH_SECONDS,
} from '../lib/statusline-install.mjs'

/** The entry this suite expects, spelled out literally — the module's own helper is used
 * only where the test needs to talk about "whatever the core considers canonical". */
const CANONICAL_DIRECT = {
  type: 'command',
  command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" statusline',
  padding: 0,
  refreshInterval: 60,
}
const CANONICAL_WRAP = { ...CANONICAL_DIRECT, command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" statusline --wrap' }

/** The spelling the segment carried before it was anchored to the project root. Kept here
 * as a LITERAL on purpose: this is a string that left our hands and now sits in adopters'
 * settings files, so it can never be derived from whatever the current one happens to be. */
const PRE_ANCHOR_CMD = 'node scripts/sma/cli.mjs statusline'
const PRE_ANCHOR_WRAP_CMD = 'node scripts/sma/cli.mjs statusline --wrap'

let repo: string
let settingsPath: string
let wrappedPath: string
let dirs: { smaRoot: string; statuslineDir: string }

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sma-slcore-'))
  mkdirSync(join(repo, '.claude'), { recursive: true })
  settingsPath = join(repo, '.claude', 'settings.json')
  dirs = { smaRoot: join(repo, '.sma'), statuslineDir: join(repo, '.sma', 'statusline') }
  wrappedPath = join(dirs.statuslineDir, 'wrapped-command.json')
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
})

const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8'))
const install = () => applyStatuslineInstall('install', { settingsPath, dirs, by: 'test', now: 1_700_000_000_000 })
const uninstall = () => applyStatuslineInstall('uninstall', { settingsPath, dirs, by: 'test', now: 1_700_000_000_000 })

describe('statusline install core — the entry it writes', () => {
  it('an install onto settings without a statusLine writes the canonical entry and records that there was none', async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ id: 1 }] }, model: 'opus' }, null, 2))

    const res = await install()

    expect(res).toEqual({ status: 'installed', wrote: true })
    expect(readSettings().statusLine).toEqual(CANONICAL_DIRECT)
    // the constants and the helper agree with the literal above — one definition, not two
    expect(canonicalStatuslineEntry(SMA_STATUSLINE_CMD)).toEqual(CANONICAL_DIRECT)
    expect(STATUSLINE_REFRESH_SECONDS).toBe(60)
    // the timer is the point: without it a window only ever repaints for its own events
    expect(readSettings().statusLine.refreshInterval).toBe(60)
    // uninstall has to know the key was ours to add
    expect(JSON.parse(readFileSync(wrappedPath, 'utf8')).hadNone).toBe(true)
    // every other key survived untouched
    expect(readSettings().hooks).toEqual({ Stop: [{ id: 1 }] })
    expect(readSettings().model).toBe('opus')
  })

  it('an entry that is ours but written in an older shape is healed, and the saved foreign command is NOT overwritten', async () => {
    // the shape an install wrote before the refresh timer existed
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: SMA_STATUSLINE_CMD, padding: 0 }, model: 'opus' }, null, 2),
    )
    // ...and a record from an even earlier install that wrapped somebody's own line
    mkdirSync(dirs.statuslineDir, { recursive: true })
    const saved = JSON.stringify({ command: 'their-line.sh', original: { type: 'command', command: 'their-line.sh' }, hadNone: false })
    writeFileSync(wrappedPath, saved)

    const res = await install()

    expect(res).toEqual({ status: 'installed', wrote: true })
    expect(readSettings().statusLine).toEqual(CANONICAL_DIRECT) // healed, not left stale
    // the only verbatim copy of their command is still there, byte for byte
    expect(readFileSync(wrappedPath, 'utf8')).toBe(saved)
    expect(readSettings().model).toBe('opus')
  })

  it('the pre-anchor command is recognised as OURS and healed — never wrapped as a stranger', async () => {
    // The install that ships the anchor runs over files that still hold yesterday's
    // spelling. Read as foreign, our own line would be PRESERVED and WRAPPED: this CLI
    // would then be spawned twice on every repaint, once by us and once as "the adopter's
    // own status line" — and the uninstall would hand that copy back as if it were theirs.
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: PRE_ANCHOR_CMD, padding: 0, refreshInterval: 60 }, model: 'opus' }, null, 2),
    )

    const res = await install()

    expect(res).toEqual({ status: 'installed', wrote: true })
    expect(readSettings().statusLine).toEqual(CANONICAL_DIRECT)
    // nothing was "saved" — there was no foreign line here to give back
    expect(existsSync(wrappedPath)).toBe(false)
    expect(readSettings().model).toBe('opus')
  })

  it('the pre-anchor WRAP spelling heals to the anchored wrap entry and leaves the saved foreign line alone', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: PRE_ANCHOR_WRAP_CMD, padding: 0, refreshInterval: 60 } }, null, 2),
    )
    mkdirSync(dirs.statuslineDir, { recursive: true })
    const saved = JSON.stringify({ command: 'their-line.sh', original: { type: 'command', command: 'their-line.sh' }, hadNone: false })
    writeFileSync(wrappedPath, saved)

    const res = await install()

    expect(res).toEqual({ status: 'installed-wrap', wrote: true })
    expect(readSettings().statusLine).toEqual(CANONICAL_WRAP)
    // the only verbatim copy of their command is still there, byte for byte
    expect(readFileSync(wrappedPath, 'utf8')).toBe(saved)
  })

  it('an entry already equal to the canonical one is left alone — the file is not rewritten', async () => {
    writeFileSync(settingsPath, JSON.stringify({ statusLine: CANONICAL_DIRECT, hooks: { Stop: [{ id: 2 }] } }, null, 2))
    const raw = readFileSync(settingsPath, 'utf8')

    const res = await install()

    expect(res).toEqual({ status: 'noop-already', wrote: false })
    expect(readFileSync(settingsPath, 'utf8')).toBe(raw) // byte-identical: nothing was written
    expect(existsSync(wrappedPath)).toBe(false) // and no record was invented
  })

  it('a foreign command is wrapped with the canonical wrap entry and given back verbatim on uninstall', async () => {
    const theirs = { type: 'command', command: 'my-own-statusline.sh', padding: 3 }
    writeFileSync(settingsPath, JSON.stringify({ statusLine: theirs, hooks: { Stop: [{ id: 3 }] } }, null, 2))

    const res = await install()

    expect(res).toEqual({ status: 'installed-wrap', wrote: true })
    expect(readSettings().statusLine).toEqual(CANONICAL_WRAP)
    expect(canonicalStatuslineEntry(SMA_STATUSLINE_WRAP_CMD)).toEqual(CANONICAL_WRAP)
    expect(JSON.parse(readFileSync(wrappedPath, 'utf8')).original).toEqual(theirs)

    const off = await uninstall()

    expect(off).toEqual({ status: 'uninstalled', wrote: true })
    expect(readSettings().statusLine).toEqual(theirs) // verbatim, padding and all
    expect(readSettings().hooks).toEqual({ Stop: [{ id: 3 }] })
  })
})

describe('statusline install core — the never-clobber guard', () => {
  it('a write is aborted outright when any key other than statusLine would change', () => {
    const before = { hooks: { Stop: [{ id: 4 }] }, model: 'opus' }
    writeFileSync(settingsPath, JSON.stringify(before, null, 2))
    const raw = readFileSync(settingsPath, 'utf8')
    // a caller that also touched a foreign key: the statusLine edit must not carry it through
    const tampered = { hooks: { Stop: [{ id: 999 }] }, model: 'opus', statusLine: CANONICAL_DIRECT }

    const ok = writeSettingsStatusLineOnly(settingsPath, tampered, before)

    expect(ok).toBe(false)
    expect(readFileSync(settingsPath, 'utf8')).toBe(raw) // untouched
  })

  it('the statusLine key alone may change, and the write then goes through', () => {
    const before = { hooks: { Stop: [{ id: 5 }] } }
    writeFileSync(settingsPath, JSON.stringify(before, null, 2))

    const ok = writeSettingsStatusLineOnly(settingsPath, { ...before, statusLine: CANONICAL_DIRECT }, before)

    expect(ok).toBe(true)
    expect(readSettings()).toEqual({ hooks: { Stop: [{ id: 5 }] }, statusLine: CANONICAL_DIRECT })
  })

  it('a settings file that fails strict parse is never written to', async () => {
    const broken = '{ "hooks": [ this is not json'
    writeFileSync(settingsPath, broken)

    const res = await install()

    expect(res).toEqual({ status: 'parse-failed', wrote: false })
    expect(readFileSync(settingsPath, 'utf8')).toBe(broken)
  })
})
