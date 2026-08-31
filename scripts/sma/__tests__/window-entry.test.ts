/**
 * Tests for scripts/sma/lib/window.mjs — the ONE assembler of the fleet window's
 * entry link, and the verb that walks a person through the standard cookie exchange.
 *
 * The defect these cover: the window answers 401 to a bare visit BY DESIGN (token on
 * every route, HttpOnly cookie, the query string is a credential exactly once — the
 * `GET /?token=` bootstrap), and the product shipped no command that performs that one
 * exchange. To open their own window a person had to read `~/.sma-daemon/config.json`,
 * lift the token out of it and paste an address together by hand. Everyone repeats that
 * after every daemon restart, and a new user hits it first.
 *
 *  - Test 1 (dialHost): a wildcard bind is DIALLED as loopback. `0.0.0.0` is an address
 *    to listen on, never one to browse to, and the boot line used to print it verbatim.
 *  - Test 2 (bootstrapUrl): the one-shot exchange link is assembled in one place.
 *  - Test 3 (readWindowEntry): a real config file yields the entry; a missing file, an
 *    unparsable file and a token-less file each get their OWN named reason, never a throw.
 *  - Test 4 (entryLines): the boot line printed into a LOG carries no token and names the
 *    verb instead; the line printed to a CONSOLE carries the ready link. A log file is not
 *    mode 0600 the way the config is, so the token staying out of it is the security
 *    posture, not a preference.
 *  - Test 5 (openInBrowser): the launcher argv carries the tokenized link, and a platform
 *    with no known launcher is a NAMED refusal rather than a silent success.
 *  - Test 6 (the daemon's wire): the boot path builds its address through this module, so
 *    the two cannot drift into two different answers.
 *  - Test 7 (the verb): `open --print` prints the ready link and launches nothing; a
 *    missing config exits non-zero naming the file, and prints no link.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ENTRY_COMMAND,
  bootstrapUrl,
  browserOpener,
  dialHost,
  entryLines,
  openInBrowser,
  readWindowEntry,
  resolveDaemonConfigPath,
  windowAddress,
} from '../lib/window.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')
const REPO_ROOT = join(__dirname, '..', '..', '..')

/** A 64-hex front token, the shape daemon config.mjs mints (randomBytes(32).hex). */
const TOKEN = 'a'.repeat(48) + 'b'.repeat(16)

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'sma-window-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Write a daemon config into the scratch dir and return its path. */
function seedConfig(config: Record<string, unknown>): string {
  const dir = join(scratch, '.sma-daemon')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}

function runCli(args: string[], env: Record<string, string>): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { stdout, stderr: '', status: 0 }
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '').toString(),
      stderr: (err.stderr ?? '').toString(),
      status: typeof err.status === 'number' ? err.status : 1,
    }
  }
}

describe('window.mjs — the entry link is assembled in one place', () => {
  it('Test 1: a wildcard bind is dialled as loopback, a named host is left alone', () => {
    expect(dialHost('0.0.0.0')).toBe('127.0.0.1')
    expect(dialHost('')).toBe('127.0.0.1')
    expect(dialHost('::')).toBe('[::1]')
    expect(dialHost('127.0.0.1')).toBe('127.0.0.1')
    expect(dialHost('192.168.1.9')).toBe('192.168.1.9')
    expect(windowAddress({ bind: '0.0.0.0', port: 7777 })).toBe('http://127.0.0.1:7777')
  })

  it('Test 2: the one-shot exchange link carries the token in the query, once', () => {
    const url = bootstrapUrl({ bind: '127.0.0.1', port: 7777, token: TOKEN })
    expect(url).toBe(`http://127.0.0.1:7777/?token=${TOKEN}`)
    // The bare address is the SAME string minus the exchange, so a reader can tell them apart.
    expect(url.startsWith(windowAddress({ bind: '127.0.0.1', port: 7777 }))).toBe(true)
  })

  it('Test 3: a real config yields the entry; every absence gets its own named reason', () => {
    const path = seedConfig({ bind: '0.0.0.0', port: 7788, token: TOKEN })
    const ok = readWindowEntry({ configPath: path })
    expect(ok.ok).toBe(true)
    expect(ok.address).toBe('http://127.0.0.1:7788')
    expect(ok.url).toBe(`http://127.0.0.1:7788/?token=${TOKEN}`)

    const missing = readWindowEntry({ configPath: join(scratch, 'nowhere', 'config.json') })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toBe('config-missing')

    const brokenPath = join(scratch, 'broken.json')
    writeFileSync(brokenPath, '{ not json')
    expect(readWindowEntry({ configPath: brokenPath }).reason).toBe('config-unreadable')

    const tokenless = seedConfig({ bind: '127.0.0.1', port: 7777 })
    expect(readWindowEntry({ configPath: tokenless }).reason).toBe('no-token')
  })

  it('Test 3b: the config path follows the daemon rule — the env override wins', () => {
    expect(resolveDaemonConfigPath({ env: { SMA_DAEMON_CONFIG: 'C:/custom/daemon.json' } })).toBe('C:/custom/daemon.json')
    expect(resolveDaemonConfigPath({ env: {}, homedir: () => '/home/x' })).toBe(join('/home/x', '.sma-daemon', 'config.json'))
  })

  it('Test 4: the log line carries no token and names the verb; the console line carries the link', () => {
    const cfg = { bind: '127.0.0.1', port: 7777, token: TOKEN }

    const log = entryLines({ ...cfg, isTty: false }).join('\n')
    expect(log).not.toContain(TOKEN)
    expect(log).toContain(ENTRY_COMMAND)
    expect(log).toContain('http://127.0.0.1:7777')

    const console_ = entryLines({ ...cfg, isTty: true }).join('\n')
    expect(console_).toContain(`http://127.0.0.1:7777/?token=${TOKEN}`)
    expect(console_).toContain(ENTRY_COMMAND)
  })

  it('Test 4b: a daemon with no token in its config never invents an entry line', () => {
    const lines = entryLines({ bind: '127.0.0.1', port: 7777, token: '', isTty: true }).join('\n')
    expect(lines).not.toContain('?token=')
  })

  it('Test 5: the launcher argv carries the link; an unknown platform is a named refusal', () => {
    const url = bootstrapUrl({ bind: '127.0.0.1', port: 7777, token: TOKEN })
    const calls: { cmd: string; args: string[] }[] = []
    const fakeSpawn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      return { unref() {} }
    }

    const opened = openInBrowser({ url, platform: 'darwin', spawn: fakeSpawn as never })
    expect(opened.opened).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].args.some((a) => a.includes(TOKEN))).toBe(true)

    expect(browserOpener('sunos')).toBeNull()
    const refused = openInBrowser({ url, platform: 'sunos', spawn: fakeSpawn as never })
    expect(refused.opened).toBe(false)
    expect(refused.reason).toBe('no-launcher')
    expect(calls).toHaveLength(1) // nothing was launched

    // A launcher that throws is a refusal too, never a claimed success.
    const throwing = () => {
      throw new Error('ENOENT')
    }
    const failed = openInBrowser({ url, platform: 'linux', spawn: throwing as never })
    expect(failed.opened).toBe(false)
    expect(failed.reason).toBe('launch-failed')
  })

  it('Test 6: the daemon boot path builds its address through this module, not by hand', () => {
    const main = readFileSync(join(REPO_ROOT, 'daemon', 'src', 'main.mjs'), 'utf8')
    expect(main).toMatch(/from '\.\.\/\.\.\/scripts\/sma\/lib\/window\.mjs'/)
    expect(main).toMatch(/entryLines\(/)
    // The hand-built address is what printed `http://0.0.0.0:7777` at a wildcard bind.
    expect(main).not.toMatch(/http:\/\/\$\{park\.config\.bind\}/)
  })
})

describe('the verb that opens the window', () => {
  it('Test 7: --print prints the ready link and launches nothing', () => {
    const path = seedConfig({ bind: '127.0.0.1', port: 7777, token: TOKEN })
    const { stdout, status } = runCli(['open', '--print'], { SMA_DAEMON_CONFIG: path })
    expect(status).toBe(0)
    expect(stdout).toContain(`http://127.0.0.1:7777/?token=${TOKEN}`)
  })

  it('Test 7b: --print --json carries the link in one field, and says nothing was opened', () => {
    const path = seedConfig({ bind: '127.0.0.1', port: 7777, token: TOKEN })
    const { stdout, status } = runCli(['open', '--print', '--json'], { SMA_DAEMON_CONFIG: path })
    expect(status).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.opened).toBe(false)
    expect(parsed.address).toBe('http://127.0.0.1:7777')
    expect(parsed.bootstrapUrl).toBe(`http://127.0.0.1:7777/?token=${TOKEN}`)
  })

  it('Test 7c: a missing config exits non-zero, names the file, and prints no link', () => {
    const absent = join(scratch, 'nowhere', 'config.json')
    const { stdout, stderr, status } = runCli(['open', '--json'], { SMA_DAEMON_CONFIG: absent })
    expect(status).toBe(1)
    expect(`${stdout}${stderr}`).toContain(absent)
    expect(`${stdout}${stderr}`).not.toContain('?token=')
  })
})
