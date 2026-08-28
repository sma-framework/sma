/**
 * codex-lane-drill.mjs — the second lane, driven END TO END against the REAL CLI.
 *
 * THE QUESTION THE HERMETIC SUITE CANNOT ANSWER. `daemon/__tests__/build-args.test.ts` proves
 * that the composer creates the per-task home, seeds it and puts the sandbox into the argument
 * array — against a temporary directory, with no process started. That is the right shape for
 * a suite that must pass on a machine with nothing installed, and it proves the WIRE. It
 * cannot prove that the other side accepts what we hand it: that this version of the CLI still
 * parses our config under `--strict-config`, that the login we copied in is the one it
 * authenticates with, that the sandbox value is a value it knows, that the final frame really
 * carries the four token numbers we read off it. Every one of those is a fact about somebody
 * else's program, and the only honest way to learn it is to run it once and write down what
 * came back — including the parts that do not flatter the product.
 *
 * WHY IT EXISTS AT ALL. This lane was wired in name only: the environment named a fresh
 * `CODEX_HOME` for every task and nothing anywhere created it, so «the vendor's native memory
 * is off for every task» was true of a comment and of no disk. A fresh home also REPLACES the
 * operator's own rather than extending it, login included — so the first live run against one
 * answered `401 Missing bearer or basic authentication` and went to the public API endpoint,
 * i.e. did not know it was on a subscription. A claim of that shape is settled by a run, not
 * by a test double that agrees with us by construction.
 *
 * THE SHAPE OF THE DRILL
 *   1. Build a THROWAWAY account under the OS temp directory: the settings mirror the parity
 *      guard reads, and a copy of the first login that exists among the candidates the product
 *      itself would search. Nothing under the operator's home is written to — only read.
 *   2. Ask the PRODUCT for the spec: `createBuildArgs(...)(task, route)`. Not a hand-assembled
 *      command line — a drill that built its own arguments would prove that this file works.
 *   3. Look at the DISK the spec points at: the home exists, and carries `config.toml` and
 *      `auth.json`. Look at the ARGV: the sandbox mode is in it.
 *   4. Spawn the real `codex` through the product's own `spawnWorker`, prompt on stdin, and
 *      parse the stream with the product's own `parseCodexEvent`.
 *   5. Read the final frame with the product's own `codexTokensFromFinal` and print the four
 *      numbers, so «this provider reports cache writes» is a line of a transcript rather than
 *      an assertion about a fixture we wrote.
 *
 * WHAT IT COSTS: one short turn on the account that is logged in. `--dry` does everything
 * except step 4 and 5 and spends nothing.
 *
 * WHAT IT NEEDS: `codex` on PATH, and a login the candidate search can find — the account's
 * own `auth.json`, `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` where `codex login` puts it.
 *
 * Usage:
 *   node tools/codex-lane-drill.mjs [--model <m>] [--effort <e>] [--lane <l>]
 *                                   [--prompt <text>] [--dry]
 *
 * Exit code 0 when every check passed; 1 otherwise, with the failure named.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBuildArgs } from '../daemon/src/runner/build-args.mjs'
import { spawnWorker } from '../daemon/src/runner/spawn.mjs'
import { parseCodexEvent } from '../daemon/src/runner/stream.mjs'
import { codexTokensFromFinal } from '../daemon/src/runner/usage.mjs'
import { defaultEnvelope, envelopeSpawnOptions } from '../daemon/src/queue/capability-envelope.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}
const DRY = argv.includes('--dry')
const MODEL = flag('model', 'gpt-5.6-sol')
const EFFORT = flag('effort', 'max')
const PROMPT = flag('prompt', 'Ответь ровно одним словом: готов')
const LANE = flag('lane', 'research')

const failures = []
const say = (mark, line) => console.log(`${mark} ${line}`)
const ok = (line) => say('  ok', line)
const bad = (line) => {
  failures.push(line)
  say('FAIL', line)
}

/**
 * A throwaway account directory. The settings mirror is written because the profile-parity
 * guard refuses a spawn into an account whose hosted-connectors switch was never mirrored —
 * that guard is not this drill's subject and is satisfied rather than bypassed.
 */
function makeAccount() {
  const root = mkdtempSync(join(tmpdir(), 'sma-codex-drill-'))
  const accountDir = join(root, 'codex-drill')
  mkdirSync(accountDir, { recursive: true })
  writeFileSync(join(accountDir, 'settings.json'), JSON.stringify({ disableClaudeAiConnectors: true }, null, 2))
  return { root, accountDir }
}

const { root, accountDir } = makeAccount()

const config = {
  workers: [
    {
      id: 'codex-drill',
      lane: LANE,
      provider: 'codex',
      model: MODEL,
      effort: EFFORT,
      enabled: true,
      account: { name: 'codex-drill', configDir: accountDir },
    },
  ],
}

const task = { id: `DRILL-${process.pid}`, title: 'живой прогон полосы кодекса', lane: LANE }
const route = { workerId: 'codex-drill', provider: 'codex', useApiFallback: false, reason: 'drill' }

console.log('── the second lane, driven live ──')
console.log(`   model ${MODEL} · effort ${EFFORT} · lane ${LANE}${DRY ? ' · DRY (nothing is spawned)' : ''}`)
console.log(`   account ${accountDir}`)

let spec
try {
  // THE ENVELOPE OF THE LANE, delivered exactly the way the tick delivers it — the sandbox is
  // derived from this grant and from nothing else.
  const envelope = defaultEnvelope(LANE)
  spec = createBuildArgs({ config })(task, route, envelopeSpawnOptions(envelope))
} catch (err) {
  bad(`the composer refused to build a spec: ${err && err.message}`)
  console.log('\n── the drill did not reach a spawn ──')
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}

console.log(`\n   argv: ${spec.bin} ${spec.args.join(' ')}`)
console.log(`   CODEX_HOME: ${spec.env.CODEX_HOME}`)

// ── (3) THE DISK, AND THE ARGV ────────────────────────────────────────────────
const home = String(spec.env.CODEX_HOME)
if (existsSync(home)) ok('the per-task home EXISTS — created by the spawn, not by the CLI finding nothing')
else bad(`the per-task home ${home} was never created`)

const configPath = join(home, 'config.toml')
if (existsSync(configPath)) {
  const toml = readFileSync(configPath, 'utf8')
  ok(`config.toml is there: ${toml.replace(/\n+/g, ' · ').trim()}`)
  if (!toml.includes('memories = false')) bad('the seed does not switch the native memory off')
} else {
  bad('config.toml was never written into the fresh home')
}

if (existsSync(join(home, 'auth.json'))) ok('auth.json is in the home the environment names')
else bad('auth.json never reached the home — a live run would answer 401')

const sandboxAt = spec.args.indexOf('--sandbox')
if (sandboxAt >= 0) ok(`the sandbox is in the argument array: ${spec.args[sandboxAt + 1]}`)
else bad('no --sandbox in the argument array — the boundary of this run is unreadable')

if (spec.args.includes('--strict-config')) ok('--strict-config travels: a seed this CLI cannot parse fails loudly')
else bad('no --strict-config — an unrecognised seed key would be ignored in silence')

if (DRY) {
  console.log(`\n── dry run: ${failures.length === 0 ? 'every wire check passed' : `${failures.length} failed`} ──`)
  rmSync(root, { recursive: true, force: true })
  process.exit(failures.length === 0 ? 0 : 1)
}

// ── (4) + (5) THE LIVE TURN ───────────────────────────────────────────────────
// THE PROGRAM THE COMPOSER RESOLVED, AND NOTHING ELSE. This drill used to carry a `--bin`
// escape hatch so it could still answer its other questions on a machine where the CLI was an
// npm shim the daemon could not start. It is gone on purpose: a drill that can be pointed at a
// working binary by hand proves the lane runs for whoever passed the flag, not for the daemon.
console.log(`\n   spawning ${spec.bin}…`)
const lines = []
let finalFrame = null
let answer = null

const exitCode = await new Promise((resolve) => {
  spawnWorker({
    bin: spec.bin,
    args: spec.args,
    cwd: process.cwd(),
    env: spec.env,
    prompt: PROMPT,
    onLine: (line) => {
      lines.push(line)
      const event = parseCodexEvent(line)
      if (event.usage) finalFrame = event
      if (event.type === 'item.completed') {
        const text = (() => {
          try {
            return JSON.parse(line).item?.text ?? null
          } catch {
            return null
          }
        })()
        if (text) answer = text
      }
    },
    onError: (err) => {
      bad(`the child never started: ${err && err.message}`)
      // A BARE ENOENT SENDS THE READER TO THE WRONG PLACE — it reads as «the CLI is not
      // installed». On Windows an npm-installed CLI is a `.cmd` shim rather than a program, and
      // a shell-less spawn cannot start a batch file (Node refuses `.cmd` without a shell,
      // CVE-2024-27980; a shell is what the safe-child contract forbids). `resolve-bin.mjs`
      // translates such a shim into node plus the script it names — so an ENOENT HERE means
      // that translation did not happen, which is a fact about this machine's installation and
      // is worth saying in the transcript rather than leaving to be re-derived.
      if (err && String(err.code) === 'ENOENT' && process.platform === 'win32') {
        console.log('  note the composer handed back a bare name it could not resolve to an executable or an npm shim;')
        console.log('  note check that the CLI is on PATH for THIS process, and that its .cmd shim names a node script.')
      }
      resolve(1)
    },
    onExit: ({ code }) => resolve(code ?? 1),
  })
})

console.log(`   the child exited with ${exitCode}, ${lines.length} stream line(s)`)
for (const line of lines) console.log(`   | ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`)

if (exitCode !== 0) bad(`the CLI refused the command line we handed it (exit ${exitCode})`)
if (answer) ok(`the worker answered: ${JSON.stringify(answer)}`)
else bad('no agent message came back — the session produced nothing')

if (finalFrame) {
  const tokens = codexTokensFromFinal(finalFrame)
  ok(`the four numbers, read off the final frame: ${JSON.stringify(tokens)}`)
  if (!('cache_write_input_tokens' in (finalFrame.usage || {}))) {
    console.log('  note the frame carried no cache_write_input_tokens field at all — this CLI version does not report it')
  }
} else {
  bad('no turn.completed frame — nothing to book this attempt from')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n── ${failures.length === 0 ? 'the lane runs end to end' : `${failures.length} check(s) failed`} ──`)
process.exit(failures.length === 0 ? 0 : 1)
