import { defaultExclude, defineConfig } from 'vitest/config'

/**
 * SERIAL_SUITES — the files that must not run beside eleven other workers.
 *
 * Everything else in this suite is in-process. These six are not: between them
 * they run the REAL installer four times (each copy is ~459 files), copy the whole
 * sma-core payload into a temp tree, spawn the real `sma-tools` binary twenty-two
 * times, spawn the 9.7k-line `cli.mjs` eight times, and drive ~60 REAL `git`
 * processes through mkdtemp repositories. That work is the POINT of these tests —
 * the defects they cover were only ever visible through a real child process — so
 * it cannot be mocked away without deleting the coverage.
 *
 * What it cannot survive is being stacked on top of the default file parallelism:
 * measured on this machine, one parallel full run in four was green and the
 * failing set differed every time, while a `--no-file-parallelism` run was
 * 2368/2368. A gate that is green one run in four is not a gate. So these
 * six are pinned to their own project, run with
 * `fileParallelism: false`, in a LATER group order — `sequence.groupOrder` runs
 * groups from lowest to highest, so this group starts only once the parallel
 * group has finished and the machine is otherwise idle. The remaining ~129 files
 * keep the default parallelism and the whole suite still finishes in about a
 * minute.
 *
 * This is the smaller, honest half of the cure; the other half lives in the files
 * themselves (the races and the duplicate child-process deadlines were fixed, and
 * every spawn now reports status/signal/stderr instead of dying inside
 * `JSON.parse`). Pinning buys determinism, not silence: a real regression in any
 * of the six still turns this suite red.
 */
const SERIAL_SUITES = [
  'scripts/sma/__tests__/manifest.test.ts',
  'scripts/sma/__tests__/init-hooks.test.ts',
  'scripts/sma/__tests__/install-layout.test.ts',
  'scripts/sma/__tests__/undo.test.ts',
  'scripts/sma/__tests__/phase-id.test.ts',
  // Nine `sma-tools` spawns: three of the four tracking-verb defects it covers were
  // only ever visible at the operator's terminal (exit code + printed envelope), so
  // the child process is the coverage and cannot be mocked away.
  'scripts/sma/__tests__/tracking-verbs.test.ts',
  // Five throwaway repositories, five real `git worktree add`, and seven CLI spawns —
  // plus real junctions whose teardown order is itself the subject. None of it survives
  // being stacked beside eleven other workers on one machine.
  'scripts/sma/__tests__/worktree-materialize.test.ts',
  // Six more throwaway repositories with real junctions, six more CLI spawns, and one
  // case that is deliberately destructive to the target it created itself — the platform
  // control that justifies unhooking links before git ever sees the copy.
  'scripts/sma/__tests__/worktree-remove-safe.test.ts',
  // The daemon's side of the same story. It drives ONE throwaway repository through the REAL
  // CLI twice — provision, then remove — so the verb answers the rest of that file fakes are
  // proved to be a SUBSET of the live ones. A fake that knows more than the library is how a
  // green suite once covered a call to a method that did not exist.
  'daemon/__tests__/worktree-cleanup.test.ts',
]

/**
 * stripShebang() — the PATTERN rule behind a class of silently shrinking suites.
 *
 * An executable entry point opens with `#!/usr/bin/env node`. The module runner's
 * inline transform cannot parse that line: it throws `SyntaxError: Invalid or
 * unexpected token` and charges it to the file that IMPORTED the script, which
 * then collects ZERO tests. The failure names the victim, never the cause, so the
 * honest reading of the report is "that test file is broken" — and however many
 * cases it held quietly leave the count. It has happened once already, to a suite
 * of 14 cases, and every shebanged file in the tree is the same loaded gun:
 * `tools/verify-rebrand.mjs` becomes one the day anyone imports it.
 *
 * The old cure was a list of externals — one line per victim, added AFTER each
 * one bled. This is the same cure applied to the CLASS: the shebang is stripped
 * from any module whose first bytes are `#!`, so the interpreter line stays in the
 * file (it is product surface — those files are executed directly) and never
 * reaches the parser. Only the first line is touched, and it is replaced by
 * nothing rather than deleted, so every later line keeps its number and stack
 * traces still point where they should.
 *
 * Exported so the rule itself is testable (scripts/sma/__tests__/shebang.test.ts).
 */
export function stripShebang() {
  return {
    name: 'sma-strip-shebang',
    enforce: 'pre',
    transform(code) {
      if (typeof code !== 'string' || !code.startsWith('#!')) return null
      return { code: code.replace(/^#![^\n]*/, ''), map: null }
    },
  }
}

const INCLUDE = ['scripts/sma/__tests__/**/*.test.ts', 'daemon/__tests__/**/*.test.ts']

export default defineConfig({
  plugins: [stripShebang()],
  test: {
    // NOTE: `include` lives in the projects below, never here. `extends: true`
    // CONCATENATES array options, so a root include would be merged into the
    // serial project and every file would run twice (measured: 263 files /
    // 4721 tests instead of 134 / 2392).
    // globals:true lets daemon/src/queue/adapter.mjs's queueAdapterContractSuite
    // register its describe/it block WITHOUT a top-level `import … from 'vitest'`
    // in a runtime module (that import would break the production daemon, which
    // installs pg-boss only). Additive — the explicit-import suites are unaffected.
    globals: true,
    // Many suites spawn REAL node/git child processes by design (pre-bench, undo
    // drills, CLI round-trips). The vitest 5s default trips on cold-boot variance
    // under multi-terminal machine load; 30s bounds a hang without flaking.
    testTimeout: 30000,
    // The same reason, for the SAME suites' setup work — and the gap that was
    // left open: hookTimeout keeps its own 10s default when testTimeout is
    // raised. install-layout's beforeAll copies the entire sma-core payload
    // (459 files, 0.7–1.5s idle on this machine) and the preset group runs the
    // real installer; a loaded box pushes either past 10s, the HOOK dies, and
    // vitest charges the WHOLE FILE — which is exactly the "install-layout
    // (whole file)" red on record. Parity with testTimeout, not inflation: the
    // per-hook bound stays the same order as the per-test one.
    hookTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: 'parallel',
          include: INCLUDE,
          exclude: [...defaultExclude, ...SERIAL_SUITES],
        },
      },
      {
        extends: true,
        test: {
          name: 'serial',
          include: SERIAL_SUITES,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
