import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only Hanji's own unit tests; .edgebase/ holds generated runtime
    // targets that ship their own test suites.
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'functions/**/*.ts'],
      // Ratchet gate enforced by `npm run test:coverage` (CI backend-unit job).
      // Thresholds sit just below the measured baseline after the security and
      // data-integrity suites (2026-07-10: statements 34.12 / branches 25.45 /
      // functions 37.66 / lines 36.28). Large end-to-end handlers also remain
      // covered by CI runtime smokes; never lower this unit-test ratchet.
      thresholds: {
        statements: 33,
        branches: 25,
        functions: 37,
        lines: 36,
      },
    },
  },
});
