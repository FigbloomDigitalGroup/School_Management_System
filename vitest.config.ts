import { defineConfig } from "vitest/config";

// Scoped to packages/shared, the web app's pure helpers (apps/web/src/lib, e.g. the learner CSV import) and server-rendered views (apps/web/src/screens/**/*.test.ts: renderToStaticMarkup, no DOM), the phone apps' pure
// UI helpers (apps/mobile/src/ui/*.test.ts: no React Native imports, so they run in plain Node), the repo-level checks in
// scripts/, tests/security (static checks that read files and run scripts/security-scan.sh in throwaway repos) and
// tests/integrity (what the migration files say about themselves); none of these needs a database — e2e/ is Playwright, not
// Vitest, and would otherwise get picked up by Vitest's default test-file glob. The phone apps' own component tests are Jest
// (`npm test` inside apps/mobile), so they are not listed here.
export default defineConfig({
  test: {
    // Vitest 4 starts one worker per core minus one by default. Several of these suites are file-system and process heavy
    // (tests/security reads the whole client source and runs scripts/security-scan.sh in throwaway repos); on a 12-core Windows
    // machine that many workers pushed them past the 5 s test timeout (measured: all 1765 pass with 4 workers, 5 time out with the
    // default). A fixed small cap keeps timings the same on every machine without raising any timeout.
    maxWorkers: 4,
    include: [
      "packages/shared/src/**/*.test.ts",
      "apps/web/src/lib/**/*.test.ts",
      "apps/web/src/screens/**/*.test.ts",
      "apps/mobile/src/ui/**/*.test.ts",
      "scripts/**/*.test.ts",
      "tests/security/**/*.test.ts",
      "tests/integrity/**/*.test.ts",
    ],
  },
});
