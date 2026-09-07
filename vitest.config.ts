import { defineConfig } from "vitest/config";

// Scoped to packages/shared only — e2e/ is Playwright, not Vitest, and would
// otherwise get picked up by Vitest's default test-file glob.
export default defineConfig({
  test: {
    include: ["packages/shared/src/**/*.test.ts"],
  },
});
