import { defineConfig } from "vitest/config";

// Scoped to packages/shared, the web app's pure helpers (apps/web/src/lib, e.g. the learner CSV import), tests/security
// (static checks that read files and run scripts/security-scan.sh in throwaway repos) and tests/integrity (what the migration
// files say about themselves); none of these needs a database — e2e/ is Playwright, not Vitest, and would otherwise get
// picked up by Vitest's default test-file glob.
export default defineConfig({
  test: {
    include: ["packages/shared/src/**/*.test.ts", "apps/web/src/lib/**/*.test.ts", "tests/security/**/*.test.ts", "tests/integrity/**/*.test.ts"],
  },
});
