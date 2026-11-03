import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every test builds its own in-memory SQLite DB and fake clock, so files are independent.
    restoreMocks: true,
    // node:sqlite is still flagged experimental before Node 24.15; keep test output clean.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
