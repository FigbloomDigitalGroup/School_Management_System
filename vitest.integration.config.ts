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
  },
}));
