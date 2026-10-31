import { defineConfig } from "vitest/config";

// Scoped to packages/shared, the phone apps' pure UI helpers (apps/mobile/src/ui/*.test.ts: no React
// Native imports, so they run in plain Node) and the repo-level checks in scripts/ — e2e/ is
// Playwright, not Vitest, and would otherwise get picked up by Vitest's default test-file glob.
export default defineConfig({
  test: {
    include: ["packages/shared/src/**/*.test.ts", "apps/mobile/src/ui/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
