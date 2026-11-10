import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// Separate from vitest.config.ts, which is deliberately limited to packages/shared (pure logic, no database).
// These tests sign in to a real local Supabase, so they only run on request: npm run test:integration.
export default defineConfig(({ mode }) => ({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // Only the URL and the anon key reach the tests. The service-role key and the M-Pesa secrets in .env do not.
    env: loadEnv(mode, process.cwd(), ["VITE_SUPABASE_", "SUPABASE_URL"]),
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // One file at a time: every file works in the same database, and some briefly change what other files read (parentFees links a
    // throwaway learner to the seeded parent, which rolesInSchool counts; payments bills whole terms, which slows every unfiltered
    // read under the 8 second statement timeout). Parallel files made results depend on timing.
    fileParallelism: false,
  },
}));
