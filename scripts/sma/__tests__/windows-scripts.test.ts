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
