import { defineConfig } from 'vitest/config'

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

export default defineConfig({
  plugins: [stripShebang()],
  test: {
    include: ['scripts/sma/__tests__/**/*.test.ts', 'daemon/__tests__/**/*.test.ts'],
    // globals:true lets daemon/src/queue/adapter.mjs's queueAdapterContractSuite
    // register its describe/it block WITHOUT a top-level `import … from 'vitest'`
    // in a runtime module (that import would break the production daemon, which
    // installs pg-boss only). Additive — the explicit-import suites are unaffected.
    globals: true,
    // Many suites spawn REAL node/git child processes by design (pre-bench, undo
    // drills, CLI round-trips). The vitest 5s default trips on cold-boot variance
    // under multi-terminal machine load; 30s bounds a hang without flaking.
    testTimeout: 30000,
  },
})
