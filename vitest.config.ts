import { defineConfig } from 'vitest/config'
import TestLogReporter from './testLogReporter'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/__tests__/**/*.test.ts'],
    // NEW: imported and instantiated directly, rather than passed as a
    // bare string path -- this is the pattern shown consistently across
    // Vitest's own docs and removes any ambiguity about path resolution.
    reporters: ['default', new TestLogReporter()]
  }
})