/**
 * window.mjs — the ONE place that assembles the fleet window's entry link.
 *
 * WHY THIS EXISTS. The window is armed the way a door to a machine's whole work life
 * should be: a token on every route, an HttpOnly SameSite=Strict cookie, and a query
 * string that is NEVER a credential — with exactly one sanctioned exception, the
 * `GET /?token=…` bootstrap that trades the token for that cookie once. That posture is
 * correct and nothing here loosens it. What was missing was the other half: the product
 * shipped no command that PERFORMS the one exchange. So the only way into your own window
 * was to open `~/.sma-daemon/config.json`, lift the 64-character token out of it and paste
 * an address together by hand — after every daemon restart, for every person, with the
 * newest user hitting it first and with a `401` as the only explanation offered.
 *
 * A door whose key is correct and whose keyhole nobody documented is still a locked door.
 *
 * ONE ASSEMBLER, TWO CALLERS. The verb and the daemon's own boot line both build the entry
 * from here, so they cannot drift into two different answers about the same door — and the
 * rule about where the token may be written is enforced in one function instead of being
 * remembered twice.
 *
 * ═══════════════ WHERE THE TOKEN MAY BE WRITTEN, AND WHERE IT MAY NOT ══════════════════
 * The config file is mode 0600 on purpose. A daemon LOG is not: it is a plain file under
 * the user's log directory, and on macOS it is exactly the file a support screenshot or a
 * `tail` in a shared session shows. So `entryLines` splits by destination rather than by
 * taste:
 *   - a CONSOLE (stdout is a tty — a person started the daemon in their own terminal and is
 *     looking at it) gets the ready link, because that is the moment the link is useful and
 *     the reader is the owner;
 *   - a LOG (stdout redirected to a file by the supervisor) gets the address, the reason a
 *     bare visit answers 401, and the VERB — never the token.
 * The verb obeys the same rule from the other side: it hands the link to the browser and
 * prints the token-free address, and only `--print` (the machine with no browser, where the
 * person has asked for the string) puts the link on the screen.
 *
 * A wildcard bind is DIALLED as loopback. `0.0.0.0` is an address to listen on and never
 * one to browse to; the boot line used to print it verbatim, which is a second way the same
 * door read as closed.
 *
 * Node built-ins only; zero deps, zero network. env, homedir, the file reader and the
 * process launcher are all injected, so a test never depends on the machine it runs on.
 */

import { readFileSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

/** The bind and port the daemon defaults to, mirrored for a config that states neither. */
export const DEFAULT_BIND = '127.0.0.1'
export const DEFAULT_PORT = 7777

/**
 * ENTRY_COMMAND — the one command a person types to open the window, named ONCE.
 * The boot line, the CLI's own words and the docs all quote this string, so renaming the
 * verb can never leave a document teaching a command that no longer answers.
 */
export const ENTRY_COMMAND = 'node scripts/sma/cli.mjs open'

/**
 * resolveDaemonConfigPath({env, homedir}) — the daemon config file, resolved by the DAEMON's
 * own rule: `SMA_DAEMON_CONFIG` wins, otherwise `~/.sma-daemon/config.json`.
 *
 * Deliberately mirrored rather than imported: the CLI and the daemon are separate layers
 * (importing daemon/src/config.mjs from a CLI verb drags the whole config module, its
 * validators and its policy imports into a command that only wants three fields), and this
 * is the same reading the ledger verb next door already does by hand.
 *
 * @param {{env?:object, homedir?:Function}} [opts]
 * @returns {string}
 */
export function resolveDaemonConfigPath({ env = process.env, homedir = osHomedir } = {}) {
  const override = env && env.SMA_DAEMON_CONFIG
  if (override && String(override).trim()) return String(override)
  return join(homedir(), '.sma-daemon', 'config.json')
}

/**
 * dialHost(bind) — the host a BROWSER is pointed at for a daemon listening on `bind`.
 *
 * A wildcard is not an address: `0.0.0.0` means «every interface» to a listener and means
 * nothing to a browser (Windows refuses it outright). The dialled form of a wildcard is
 * loopback, which is the interface the person typing is on. An IPv6 literal is bracketed so
 * the `:port` that follows still parses.
 *
 * @param {*} bind
 * @returns {string}
 */
export function dialHost(bind) {
  const raw = String(bind ?? '').trim()
  if (!raw || raw === '0.0.0.0' || raw === '*') return DEFAULT_BIND
  if (raw === '::' || raw === '::0' || raw === '[::]') return '[::1]'
  if (raw.startsWith('[')) return raw // already bracketed
  if (raw.includes(':')) return `[${raw}]` // a bare IPv6 literal
  return raw
}

/** The port as a number, falling back to the daemon's default for anything unusable. */
function portOf(port) {
  const n = Number(port)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PORT
}

/**
 * windowAddress({bind, port}) — the window's address with NO credential in it. This is the
 * string that may be printed anywhere: it is also the string that answers 401 on its own,
 * which is the whole point of the posture.
 *
 * @param {{bind?:*, port?:*}} config
 * @returns {string}
 */
export function windowAddress({ bind, port } = {}) {
  return `http://${dialHost(bind)}:${portOf(port)}`
}

/**
 * bootstrapUrl({bind, port, token}) — the ONE-SHOT exchange link: the single request in the
 * whole product where the token rides a URL, and it rides it to be traded for the HttpOnly
 * cookie. Returns '' for a token-less config rather than a link with an empty credential in
 * it, so no caller can print half a door.
 *
 * @param {{bind?:*, port?:*, token?:*}} config
 * @returns {string}
 */
export function bootstrapUrl({ bind, port, token } = {}) {
  const t = String(token ?? '')
  if (!t) return ''
  return `${windowAddress({ bind, port })}/?token=${encodeURIComponent(t)}`
}

/**
 * readWindowEntry({configPath, readFile}) — read the daemon's own config and derive the
 * entry from it.
 *
 *   {ok:true, configPath, bind, port, token, address, url}
 *   {ok:false, configPath, reason: 'config-missing' | 'config-unreadable' | 'no-token'}
 *
 * Every absence gets its OWN name, because the three have three different next steps (start
 * the daemon once / repair the file / the daemon minted no token) and a single «could not
 * open the window» would send a person looking in the wrong place. Never throws.
 *
 * @param {{configPath:string, readFile?:Function}} opts
 * @returns {object}
 */
export function readWindowEntry({ configPath, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  let raw
  try {
    raw = readFile(configPath)
  } catch {
    return { ok: false, configPath, reason: 'config-missing' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, configPath, reason: 'config-unreadable' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, configPath, reason: 'config-unreadable' }
  const token = typeof parsed.token === 'string' ? parsed.token : ''
  if (!token) return { ok: false, configPath, reason: 'no-token' }
  const bind = parsed.bind ?? DEFAULT_BIND
  const port = portOf(parsed.port)
  return {
    ok: true,
    configPath,
    bind,
    port,
    token,
    address: windowAddress({ bind, port }),
    url: bootstrapUrl({ bind, port, token }),
  }
}

/**
 * entryLines({bind, port, token, isTty}) — the lines the daemon prints under its «front
 * armed» sentence, chosen by WHERE they are going.
 *
 * See the header: a console is the owner looking at their own terminal, a log is a file that
 * is not 0600. The token crosses into the first and never into the second. A token-less
 * config (the daemon has not minted one yet) never produces a link at all.
 *
 * @param {{bind?:*, port?:*, token?:*, isTty?:boolean}} opts
 * @returns {string[]}
 */
export function entryLines({ bind, port, token, isTty = false } = {}) {
  const address = windowAddress({ bind, port })
  const url = bootstrapUrl({ bind, port, token })
  const why = `A bare visit to ${address} answers 401 by design: the token rides a URL exactly once, to be traded for the session cookie.`
  if (isTty && url) {
    return [why, `Open it now: ${url}`, `Or from any terminal, any time: ${ENTRY_COMMAND}`]
  }
  return [
    why,
    `Open it with: ${ENTRY_COMMAND} — it builds that one-shot link from the daemon config itself. The token is deliberately kept out of this log.`,
  ]
}

/**
 * shouldPrintLink({printOnly, opened}) — may the one-shot link cross onto the SCREEN?
 *
 * It is a named function rather than an inline condition because it is the whole of the
 * rule, and a rule that lives inside an `if` in a 12k-line file is a rule nobody can point
 * at or test. Exactly two cases say yes: the person asked for the string (`--print`), or
 * nothing else can carry it (no launcher, or the launcher refused). The ordinary path —
 * the browser took the link — says no, so the terminal, its scrollback and any transcript
 * of the session keep a token-free address and nothing more.
 *
 * @param {{printOnly?:boolean, opened?:boolean}} opts
 * @returns {boolean}
 */
export function shouldPrintLink({ printOnly = false, opened = false } = {}) {
  return printOnly === true || opened !== true
}

/**
 * OPENERS — the per-platform hand-off to whatever the desktop calls «open this link».
 *
 * Three platforms have a sanctioned launcher and the rest have none THAT THIS KNOWS, which
 * is a refusal with a name rather than a guess: a wrong guess launches nothing and reports
 * success, which is the failure mode this whole task exists to remove.
 */
const OPENERS = Object.freeze({
  // `start` is a cmd builtin, so cmd is the executable; the empty "" is the window TITLE
  // argument `start` consumes when its first quoted argument would otherwise be taken for one.
  win32: (url) => ({ cmd: 'cmd', args: ['/c', 'start', '', url] }),
  darwin: (url) => ({ cmd: 'open', args: [url] }),
  linux: (url) => ({ cmd: 'xdg-open', args: [url] }),
})

/**
 * browserOpener(platform) — a function building {cmd, args} for that platform, or null when
 * this module knows no launcher for it.
 *
 * @param {string} platform
 * @returns {Function|null}
 */
export function browserOpener(platform) {
  return OPENERS[String(platform ?? '')] ?? null
}

/**
 * openInBrowser({url, platform, spawn}) — hand the one-shot link to the desktop's own
 * browser and return whether that actually happened.
 *
 *   {opened:true, cmd, args} | {opened:false, reason:'no-launcher'|'launch-failed'}
 *
 * Detached and unref'd: the CLI's job ends when the browser has the link, and a verb that
 * held the terminal until the browser closed would be its own bug. A launcher that throws is
 * a refusal — never a claimed success, because the caller's whole fallback (print the link
 * instead) depends on this answer being honest.
 *
 * The link is passed as an ARGUMENT, which on a shared machine means it is visible in the
 * process table for as long as the launcher lives. That is inherent to handing a URL to a
 * browser — the browser's own argv carries it too — and it is why `--print` exists as the
 * path for anyone who would rather paste it themselves.
 *
 * @param {{url:string, platform?:string, spawn:Function}} opts
 * @returns {{opened:boolean, reason?:string, cmd?:string, args?:string[]}}
 */
export function openInBrowser({ url, platform = process.platform, spawn } = {}) {
  const build = browserOpener(platform)
  if (!build) return { opened: false, reason: 'no-launcher' }
  const { cmd, args } = build(String(url ?? ''))
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    if (child && typeof child.unref === 'function') child.unref()
  } catch {
    return { opened: false, reason: 'launch-failed' }
  }
  return { opened: true, cmd, args }
}
