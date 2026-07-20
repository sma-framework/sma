import { defineConfig } from 'vitest/config'

export default defineConfig({
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
