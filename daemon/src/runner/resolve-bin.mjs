/**
 * resolve-bin.mjs — HOW a named worker CLI is started on THIS operating system.
 *
 * WHAT IT IS FOR, said as the failure it exists to end. The composer names a worker's program
 * the way a person would type it: `claude`, `codex`. On every POSIX machine that is the whole
 * story — the kernel searches PATH and honours a shebang, so a CLI shipped as a shell script
 * and a CLI shipped as a binary start identically. On Windows they do not. `CreateProcess`
 * runs executables; it does not run batch files, and Node refuses to spawn a `.cmd` without a
 * shell on purpose (CVE-2024-27980). A shell is exactly what `spawn.mjs`'s safe-child contract
 * forbids, for a reason that has nothing to do with convenience.
 *
 * So on Windows a CLI distributed through npm — which installs a `.cmd` SHIM, not a program —
 * cannot be started by this daemon at all. That is not a hypothetical: the Codex lane was
 * fixed end to end (fresh home created, seeded and authenticated, sandbox on the command line,
 * the CLI accepting every argument we hand it) and still could not run one task, because
 * `spawn codex` answered ENOENT. The Claude lane worked the whole time for one accidental
 * reason: it ships as a real `.exe`. A lane that is correct in every part and cannot start is
 * indistinguishable, from the screen, from a lane that was never built.
 *
 * WHAT IT DOES, and the two rules it will not break:
 *
 *   1. IT NEVER USES A SHELL. The answer is always an ARGUMENT VECTOR — a program and the
 *      arguments that go in front of the caller's own. An npm shim is a batch file whose only
 *      content is «run node on this script», so the honest translation is to run node on that
 *      script: `node <…>/codex.js exec --json …` is byte-for-byte the command the shim would
 *      have built, minus the interpreter that could have been talked into building another one.
 *
 *   2. IT ONLY SPEAKS WHEN THE BARE NAME WOULD FAIL. A name that resolves to something the
 *      operating system can execute directly is returned UNCHANGED, and every non-Windows
 *      platform is returned unchanged without a single filesystem call. Nothing that works
 *      today starts differently tomorrow because this module exists; it is a fallback, not a
 *      layer. `how` says which of the two happened, so a spawn record can be read afterwards
 *      instead of guessed at.
 *
 * WHAT IT REFUSES TO GUESS. A `.cmd` that does not name node is left alone: it might be a
 * wrapper doing something this module has no theory about, and inventing an interpreter for it
 * would be worse than the ENOENT it replaces. Likewise a script path the shim names but that is
 * not on the disk — the shim is then not the npm shape we recognise, and «as named» is the
 * honest answer.
 *
 * PURE + DI (readiness.mjs posture): fs, env, platform and the node binary are all injected, so
 * the suite drives every branch on any machine and no case touches a real installation.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'

/** Extensions Windows can hand straight to `CreateProcess`. A hit here is left alone. */
export const EXECUTABLE_EXTENSIONS = Object.freeze(['.exe', '.com'])

/** Extensions that are a batch file — never executable, sometimes an npm shim. */
export const SHIM_EXTENSIONS = Object.freeze(['.cmd', '.bat'])

/** What a shim may hand to node. Anything else is not a script this module will run. */
const NODE_SCRIPT_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs'])

/** `%dp0%` / `%~dp0` — the shim's own directory, in cmd's notation. */
const SHIM_DIR_TOKEN = /%~?dp0%?/i

/**
 * The interpreter named as a PROGRAM — `node` or `node.exe` standing on its own.
 *
 * WHY THE WORD BOUNDARY IS NOT DECORATION. A bare `/node/` search matches `node_modules`, which
 * appears in the PATH of practically every npm-installed script — so any batch file quoting a
 * package path would have read as «this runs node» and been handed to node on that evidence.
 * The trailing class refuses that: in `node_modules` the next character is `_`, in
 * `SET "_prog=node"` and `"%dp0%\node.exe"` it is a quote.
 */
const NODE_AS_PROGRAM = /(^|[^a-z0-9_])node(\.exe)?([^a-z0-9_]|$)/i

/** Every double-quoted token in a batch file; the npm template quotes the script path. */
const QUOTED_TOKEN = /"([^"]+)"/g

/**
 * nodeScriptOf(text, shimDir, existsFn) → the node script an npm shim hands to node, or null.
 *
 * READ RATHER THAN INTERPRETED. This does not execute, expand or emulate a batch file — it
 * looks for the one shape npm generates: a quoted path under the shim's own directory ending
 * in a node script extension, next to the word `node`. Both conditions are required. A file
 * that quotes a `.js` path but never mentions node is not the shape we recognise, and a file
 * that mentions node but names no script on this disk is not either.
 */
function nodeScriptOf(text, shimDir, existsFn) {
  const body = String(text ?? '')
  if (!NODE_AS_PROGRAM.test(body)) return null // not the «run node on a script» shape — do not guess

  for (const match of body.matchAll(QUOTED_TOKEN)) {
    const token = match[1].trim()
    if (!NODE_SCRIPT_EXTENSIONS.some((ext) => token.toLowerCase().endsWith(ext))) continue

    // The path is written against the shim's own directory. Separators are normalized rather
    // than trusted: the token is authored for cmd and read here on whatever platform runs.
    const withoutToken = token.replace(SHIM_DIR_TOKEN, '')
    const segments = withoutToken.split(/[\\/]+/).filter((s) => s !== '')
    if (segments.length === 0) continue
    const candidate = SHIM_DIR_TOKEN.test(token) ? join(shimDir, ...segments) : normalize(token)

    let there = false
    try {
      there = existsFn(candidate)
    } catch {
      there = false // an unreadable path is an absent one, never a crash on the way to a spawn
    }
    if (there) return candidate
  }
  return null
}

/** The PATH directories, unquoted and de-duplicated, in the order the system would search. */
function pathDirs(env) {
  const raw = (env && (env.PATH ?? env.Path ?? env.path)) || ''
  const seen = new Set()
  const out = []
  for (const entry of String(raw).split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '' || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

/**
 * resolveWorkerBin({name, env, fsImpl, platform, execPath}) → how to start this program.
 *
 * Returns `{bin, prefixArgs, how}`:
 *   - `how: 'as-named'` — `bin` is the name it was given and `prefixArgs` is empty. This is the
 *     answer on every non-Windows platform, and on Windows whenever the name resolves to
 *     something directly executable (or to nothing this module understands).
 *   - `how: 'node-shim'` — the name resolved ONLY to an npm batch shim, which cannot be spawned
 *     without a shell. `bin` is the node binary this daemon is already running under and
 *     `prefixArgs` is the script the shim would have run. `shim` and `script` name both files,
 *     so the choice is readable rather than mysterious.
 *
 * The caller puts `prefixArgs` in FRONT of the CLI's own argument array; nothing about the
 * command the CLI receives changes.
 *
 * @param {{name:string, env?:object, fsImpl?:object, platform?:string, execPath?:string}} [o]
 * @returns {{bin:string, prefixArgs:string[], how:string, shim?:string, script?:string}}
 */
export function resolveWorkerBin({ name, env = process.env, fsImpl, platform = process.platform, execPath = process.execPath } = {}) {
  const bare = String(name ?? '').trim()
  const asNamed = { bin: bare, prefixArgs: [], how: 'as-named' }
  if (bare === '') return asNamed

  // EVERY OTHER PLATFORM IS RETURNED UNTOUCHED, and without a filesystem call: there the
  // kernel resolves PATH and honours a shebang, so a shim and a binary already start alike.
  if (platform !== 'win32') return asNamed

  const existsFn = (fsImpl && fsImpl.existsSync) || fsExistsSync
  const readFn = (fsImpl && fsImpl.readFileSync) || fsReadFileSync
  const there = (p) => {
    try {
      return existsFn(p)
    } catch {
      return false
    }
  }

  // A name that already carries a directory is a path the operator gave us; the only question
  // left is whether it is a batch shim we must translate.
  const named = /[\\/]/.test(bare) || isAbsolute(bare)
  const shimCandidates = []
  if (named) {
    if (SHIM_EXTENSIONS.some((ext) => bare.toLowerCase().endsWith(ext)) && there(bare)) shimCandidates.push(bare)
  } else {
    const dirs = pathDirs(env)
    // A DIRECTLY EXECUTABLE HIT WINS AND CHANGES NOTHING. Found first, in PATH order, exactly
    // as the operating system would find it — and then the bare name is handed back, because
    // rewriting a command line that already works buys nothing and risks resolving to a
    // different file than the spawn would have.
    for (const dir of dirs) {
      for (const ext of EXECUTABLE_EXTENSIONS) {
        if (there(join(dir, bare + ext))) return asNamed
      }
      for (const ext of SHIM_EXTENSIONS) {
        const candidate = join(dir, bare + ext)
        if (there(candidate)) shimCandidates.push(candidate)
      }
    }
  }

  for (const shim of shimCandidates) {
    let text = ''
    try {
      text = String(readFn(shim, 'utf8'))
    } catch {
      continue // unreadable is the same as absent — the next candidate, or the bare name
    }
    const script = nodeScriptOf(text, dirname(shim), there)
    if (script) return { bin: execPath, prefixArgs: [script], how: 'node-shim', shim, script }
  }

  return asNamed
}
