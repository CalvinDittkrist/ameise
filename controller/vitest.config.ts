import { defineConfig } from 'vitest/config'

// The tests start the built binary and wait on it, not on a CPU, so each file gets time to spare.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30000 },
})
