import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts (the app build config) on purpose: tests
// don't need the React/Tailwind plugins and the app build must not sweep tests.
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    // Only Hanji's own unit tests (mirrors backend/vitest.config.ts).
    // Component tests are .test.tsx and opt into jsdom via the
    // `// @vitest-environment jsdom` pragma; plain logic tests stay on node.
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    setupFiles: ["./tests/setup.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // Ratchet gate enforced by `npm run test:coverage` (CI web-checks job).
      // Thresholds sit about one percentage point below the measured baseline
      // (2026-07-10, after the accessibility and view-layer suites: statements
      // 27.53 / branches 23.03 / functions 25.98 / lines 28.72). Raise them as
      // component/unit coverage grows; never lower them to admit a regression.
      thresholds: {
        statements: 26,
        branches: 21,
        functions: 24,
        lines: 27,
      },
    },
  },
});
