/**
 * The daemon's log rotates AT MIDNIGHT — proved by a run across the boundary, not by reading
 * the wrapper.
 *
 * THE DEFECT THIS EXISTS FOR, measured on 26.08.2026: `start-daemon-windows.ps1` worked out the
 * name of the log file ONCE, before it launched the daemon, and then piped the daemon's output
 * into that name for as long as the daemon lived — which is days. So "daemon-20260826.log"
 * never existed: 1134 lines of the 26th, and the crash dump that ended the process, all sat in
 * daemon-20260825.log where nobody looked for them. The file the operator opens after a bad
 * night was empty of the night.
 *
 * The fix — resolve the day PER LINE — is one line of PowerShell, and that is exactly why it
 * needs this file. A claim about what a process does on its second day cannot be checked by
 * reading it: the pipeline that carries the daemon's lines only runs after Postgres is up and
 * the daemon is launched, so nothing could drive it, and the next honest confirmation was a
 * real midnight a night away. `supervisor/daemon-log-day.ps1` is the seam that removes that
 * excuse — the writer reads its clock from $env:SMA_LOG_CLOCK_FILE when a drill sets one — and
 * `supervisor/log-rotation-drill.ps1` is the run: real child process, real pipeline, the clock
 * moved from 23:59:58 to 00:00:03 halfway through the stream.
 *
 * Two classes of case below. The SOURCE gates run everywhere and hold the wiring in place: the
 * wrapper must keep writing through the one function that decides the day, because a drill that
 * exercises a function the wrapper has stopped calling proves nothing. The LIVE drill runs on
 * Windows, where the shell under test is, and asserts the three things the operator actually
 * cares about: a file for the new day appeared, each line is in its own day's file, and the
 * transition neither lost a line nor wrote one twice.
 *
 * Reproduce the run by hand:
 *   powershell -NoProfile -ExecutionPolicy Bypass -File supervisor/log-rotation-drill.ps1
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DRILL = join(REPO_ROOT, 'supervisor', 'log-rotation-drill.ps1')

/** Strip the BOM the encoding rule insists on, so offsets are offsets into the script text. */
function readScript(...parts: string[]): string {
  const raw = readFileSync(join(REPO_ROOT, ...parts), 'utf8')
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

describe('the wrapper keeps writing through the one place that decides the day', () => {
  const wrapper = readScript('supervisor', 'start-daemon-windows.ps1')
  const writer = readScript('supervisor', 'daemon-log-day.ps1')

  it('sources the writer instead of carrying its own copy of the rule', () => {
    expect(wrapper).toMatch(/\.\s*\(Join-Path \$PSScriptRoot 'daemon-log-day\.ps1'\)/)
  })

  it('sends the daemon output through that writer, one call per line', () => {
    const pipeline = wrapper.slice(wrapper.indexOf('& node $mainMjs'))
    expect(pipeline).toContain('Write-SmaDaemonLogLine')
  })

  it('no longer pins a file name before the stream starts', () => {
    // The shape of the defect: a Join-Path over a formatted Get-Date, bound to a variable that
    // the per-line block then reuses. The wrapper may format a date for a line's TIMESTAMP, but
    // never for a file name outside the writer.
    const pipeline = wrapper.slice(wrapper.indexOf('& node $mainMjs'))
    expect(pipeline).not.toMatch(/daemon-\{0\}\.log/)
    expect(wrapper).not.toMatch(/\$logFile\s*=/)
  })

  it('reads the drill clock on every line rather than remembering it', () => {
    const fn = writer.slice(writer.indexOf('function Get-SmaDaemonLogDay'), writer.indexOf('function Get-SmaDaemonLogFile'))
    expect(fn).toContain('SMA_LOG_CLOCK_FILE')
    // A clock a drill cannot move is not a seam; a fallback the drill can break is not safe.
    expect(fn).toContain("Get-Date -Format 'yyyyMMdd'")
  })
})

/**
 * The live half. PowerShell 5.1 is the shell the Scheduled Task uses and the one the defect
 * lived in, so the drill is run where that shell is; elsewhere the source gates above still
 * hold the wiring.
 */
describe.skipIf(process.platform !== 'win32')('a run across midnight puts each line in its own day', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  /** Run the drill into a throwaway directory and hand back its verdict plus what it wrote. */
  function runDrill(extra: string[] = []) {
    const logDir = mkdtempSync(join(tmpdir(), 'sma-log-rotation-'))
    dirs.push(logDir)
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRILL, '-LogDir', logDir, ...extra],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    const stdout = res.stdout ?? ''
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('DRILL '))
    expect(
      line,
      `the drill printed no verdict.\nstatus=${res.status} signal=${res.signal}\nstdout:\n${stdout}\nstderr:\n${res.stderr ?? ''}`,
    ).toBeTruthy()
    return { logDir, status: res.status, verdict: JSON.parse(line!.slice('DRILL '.length)) }
  }

  it('creates a separate file for the new day', () => {
    const { logDir, status, verdict } = runDrill()
    expect(status, `drill verdict: ${JSON.stringify(verdict)}`).toBe(0)
    expect(verdict.ok).toBe(true)
    expect(verdict.beforeDay).toBe('20260827')
    expect(verdict.afterDay).toBe('20260828')
    expect(verdict.beforeFile).not.toBe(verdict.afterFile)
    // Two files on disk and nothing else: a third name would mean the day was resolved from
    // something other than the clock.
    expect(readdirSync(logDir).filter((n) => n.endsWith('.log')).sort()).toEqual([
      'daemon-20260827.log',
      'daemon-20260828.log',
    ])
  })

  it('leaves the lines before the boundary in the old day and the rest in the new one', () => {
    const { logDir, verdict } = runDrill(['-Lines', '6'])
    const before = readFileSync(join(logDir, 'daemon-20260827.log'), 'utf8').trim().split(/\r?\n/)
    const after = readFileSync(join(logDir, 'daemon-20260828.log'), 'utf8').trim().split(/\r?\n/)
    expect(before).toEqual(['drill line 1 of 6', 'drill line 2 of 6', 'drill line 3 of 6'])
    expect(after).toEqual(['drill line 4 of 6', 'drill line 5 of 6', 'drill line 6 of 6'])
    expect(verdict.misfiled).toEqual([])
  })

  it('loses no line and writes none of them twice on the transition', () => {
    const { verdict } = runDrill(['-Lines', '8'])
    expect(verdict.lost).toEqual([])
    expect(verdict.duplicated).toEqual([])
    expect(verdict.emitted).toBe(8)
    expect(verdict.totalWritten).toBe(8)
    expect(verdict.oldDayCount + verdict.newDayCount).toBe(8)
  })

  it('goes red when the clock never crosses a boundary, so a green run means something', () => {
    // The teeth check. Hold the clock still and the same drill must refuse to call it a
    // rotation — otherwise every case above would pass against a writer that never rotated.
    const { status, verdict } = runDrill(['-After', '2026-08-27T23:59:59'])
    expect(status).toBe(1)
    expect(verdict.ok).toBe(false)
    expect(verdict.rotated).toBe(false)
  })
})
