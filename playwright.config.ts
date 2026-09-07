import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    /** The parent and teacher flows are phone-first — test them on a phone. */
    { name: "phone", use: { ...devices["Pixel 5"] }, testIgnore: /platform/ },
  ],
  webServer: {
    command: "npm run dev --workspace @figbloom/web",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
