import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/sma/__tests__/**/*.test.ts'],
    // Many suites spawn REAL node/git child processes by design (pre-bench, undo
    // drills, CLI round-trips). The vitest 5s default trips on cold-boot variance
    // under multi-terminal machine load; 30s bounds a hang without flaking.
    testTimeout: 30000,
  },
})
