/**
 * Every shipped PowerShell script is either pure ASCII or carries a BOM.
 *
 * THE DEFECT THIS EXISTS FOR, measured on a reference Windows 11 machine:
 * `supervisor/start-daemon-windows.ps1` was saved as UTF-8 with no byte-order mark and
 * contained em dashes in its comments and log lines. Windows PowerShell 5.1 — the shell
 * that ships with the operating system, and the one `sma-daemon-windows.task.xml` invokes —
 * reads a BOM-less file as ANSI. Under cp1252 an em dash (`e2 80 94`) decodes to three
 * characters whose last one is U+201D, a curly closing quote, and PowerShell 5.1 accepts
 * curly quotes as STRING DELIMITERS. So the first log line closed its string in the middle,
 * the remainder became code, and the brace balance collapsed:
 *
 *     line 48 col 34: Missing closing '}' in statement block or type definition.
 *
 * pointing at a block that is perfectly balanced. The script did not merely misbehave — it
 * never executed a single line, created no log to explain itself, and the documented way to
 * start the daemon on Windows was dead. PowerShell 7 reads the same file correctly, which is
 * precisely why this can hide: it breaks only on the shell every Windows user already has.
 *
 * Why a test and not just a fixed file: a BOM is INVISIBLE. Any editor, any script, any
 * well-meaning "normalise the encoding" commit can drop it and nothing looks different in a
 * diff viewer. The file cannot defend itself, so the rule defends the class — including
 * every .ps1 added later, which is the half a one-time fix never covers.
 *
 * The rule is deliberately either/or: pure ASCII needs no BOM (5.1 reads it identically
 * either way), and anything beyond ASCII needs one. Nothing here demands a particular
 * encoding of the text itself — only that Windows can tell.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import { shortcutPlan, shortcutScriptBytes } from '../../../daemon/src/watch-install.mjs'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** The PowerShell files the package actually ships, straight from the index. */
function trackedPowerShellScripts(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ps1', '*.psm1', '*.psd1'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function hasBom(bytes: Buffer): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/** 1-based line number of the first byte above 0x7F, or null when the file is pure ASCII. */
function firstNonAsciiLine(bytes: Buffer): number | null {
  let line = 1
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) line += 1
    else if (bytes[i] > 0x7f) return line
  }
  return null
}

describe('shipped PowerShell scripts survive Windows PowerShell 5.1', () => {
  it('finds the scripts at all — an empty list would make every case below vacuous', () => {
    const scripts = trackedPowerShellScripts()
    expect(scripts.length).toBeGreaterThan(0)
  })

  it('each one is pure ASCII, or declares itself with a BOM', () => {
    const offenders: string[] = []

    for (const rel of trackedPowerShellScripts()) {
      const bytes = readFileSync(join(REPO_ROOT, rel))
      if (hasBom(bytes)) continue
      const line = firstNonAsciiLine(bytes)
      if (line !== null) {
        offenders.push(
          `${rel}: no BOM, and the first non-ASCII byte is on line ${line}. ` +
            'Windows PowerShell 5.1 will read this file as ANSI and can turn that character ' +
            'into a string delimiter — the script then fails to parse entirely. Re-save it ' +
            'as UTF-8 WITH a BOM, or keep it to plain ASCII.',
        )
      }
    }

    expect(offenders).toEqual([])
  })

  it('the daemon start script keeps its BOM — the file the rule was written for', () => {
    const bytes = readFileSync(join(REPO_ROOT, 'supervisor', 'start-daemon-windows.ps1'))
    expect(hasBom(bytes)).toBe(true)
  })
})

/**
 * The rule above reads `git ls-files`, and one PowerShell script this product runs is not in
 * it. The watchdog installer BUILDS a .ps1 on the operator's machine and hands it to
 * `powershell -File`: same shell, same either/or, same invisible BOM — plus one aggravation
 * the tracked files do not have. Its text is assembled at run time and carries a shortcut name
 * the operator chose (`--name`), so "is this one pure ASCII?" is not a question a reviewer can
 * settle by looking at a file. The bytes therefore come from a single place — the decision
 * table's `shortcutScriptBytes` — and the class rule is applied to them here.
 */
describe('the PowerShell the watchdog installer writes at run time obeys the same rule', () => {
  const bytes: Buffer = shortcutScriptBytes(
    shortcutPlan({ smaHome: 'C:\\sma', name: 'Сторож демона', nodeBin: 'node.exe' }),
  )

  it('is not pure ASCII — the case below would be vacuous if it were', () => {
    expect(firstNonAsciiLine(bytes.subarray(3))).not.toBeNull()
  })

  it('is pure ASCII, or declares itself with a BOM — with a Cyrillic shortcut name in it', () => {
    expect(
      hasBom(bytes) || firstNonAsciiLine(bytes) === null,
      'the .ps1 the installer writes carries no BOM and is not pure ASCII. Windows PowerShell ' +
        '5.1 reads it as ANSI and the script fails to parse entirely — leaving no log to say ' +
        'why, because it never runs a line, and no watchdog on the machine.',
    ).toBe(true)
  })
})

/**
 * THE DEFECT THIS EXISTS FOR, measured after a machine reboot on 18.08.2026: `Test-Port` saw
 * :5433 the instant the postmaster bound the socket, so the wrapper ran ensure-db and launched
 * the daemon immediately. Postgres was still finishing recovery and answered both with FATAL
 * 57P03 «the database system is starting up». The daemon died — correctly, an unreachable queue
 * is fatal — but nothing retried, so the window never came up after the reboot.
 *
 * A socket is not a service. The gate below asserts what the fix has to keep true: a REAL query
 * decides readiness, 57P03 is a wait rather than a verdict, the wait is bounded, and neither
 * ensure-db nor the daemon is reached before it.
 */
describe('the Windows start wrapper waits for a queue that actually answers', () => {
  // Strip the BOM the rule above insists on, so offsets below are offsets into the script text.
  const raw = readFileSync(join(REPO_ROOT, 'supervisor', 'start-daemon-windows.ps1'), 'utf8')
  const script = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  /** Index of a marker, with a failure message that names what is missing. */
  function at(marker: string): number {
    const i = script.indexOf(marker)
    expect(i, `start-daemon-windows.ps1 no longer contains ${JSON.stringify(marker)}`).toBeGreaterThan(-1)
    return i
  }

  it('decides readiness with a query, not with an open socket', () => {
    at('SELECT 1')
  })

  it('treats 57P03 as a reason to ask again', () => {
    const probe = script.slice(at('$waitReady = @"'), at('$waitFile ='))
    expect(probe).toContain('57P03')
    // A retry set that 57P03 is merely listed in is not enough — something has to sleep and loop.
    expect(probe).toMatch(/setTimeout/)
  })

  it('bounds the wait at 60-90 seconds rather than hanging the boot', () => {
    const cap = script.match(/\$queueReadySeconds\s*=\s*(\d+)/)
    expect(cap, 'no $queueReadySeconds cap in start-daemon-windows.ps1').not.toBeNull()
    const seconds = Number(cap![1])
    expect(seconds).toBeGreaterThanOrEqual(60)
    expect(seconds).toBeLessThanOrEqual(90)
  })

  it('reaches ensure-db and the daemon only after the wait', () => {
    const waitStarts = at('$waitReady = @"')
    const waitEnds = at('waited {1:N1}s')
    expect(waitStarts).toBeLessThan(at('ensuring database'))
    expect(waitEnds).toBeLessThan(at('ensuring database'))
    expect(waitEnds).toBeLessThan(at('launching daemon'))
  })

  it('says how long it waited, on the good path and the bad one', () => {
    expect(script).toMatch(/queue Postgres ready on[^\r\n]*waited \{1:N1\}s/)
    expect(script).toMatch(/FATAL[^\r\n]*waited \{1:N1\}s/)
  })
})
