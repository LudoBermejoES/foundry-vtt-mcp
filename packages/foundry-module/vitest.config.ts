import { defineConfig } from 'vitest/config';

/**
 * This package had no test harness before: it is browser-context Foundry code
 * that reaches for the `game` / `Actor` / `Hooks` / `foundry` globals. It turns
 * out to be testable anyway — the modules only *use* those globals at call time
 * (plus `Hooks.on` in one constructor), so a test can install a minimal fake
 * Foundry world on `globalThis` and drive the real `FoundryDataAccess` code.
 * See src/import-actors.test.ts for the harness.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
