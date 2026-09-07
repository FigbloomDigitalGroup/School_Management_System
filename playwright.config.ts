import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Both projects exercise the same seeded Supabase instance (real auth, real
  // rows) rather than mocks, so they can't run concurrently without racing
  // each other over shared state — e.g. the desktop and phone "teacher" specs
  // both write to Form 2 West's attendance for today. One worker trades some
  // wall-clock time for that being a non-issue instead of a flake to chase.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    /** The parent and teacher flows are phone-first — test them on a phone.
     *  grepInvert (not testIgnore, which matches the file path — everything
     *  lives in one flows.spec.ts, so that never actually excluded anything)
     *  skips the "platform" describe block: the onboarding wizard is a wide
     *  desktop modal, never designed for a phone viewport. */
    { name: "phone", use: { ...devices["Pixel 5"] }, grepInvert: /platform/ },
  ],
  webServer: {
    command: "npm run dev --workspace @figbloom/web",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
