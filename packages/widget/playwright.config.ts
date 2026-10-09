import { defineConfig } from "@playwright/test";

// End-to-end: the real engine (keyless demo model), Postgres and the demo store page (scripts/dev-stack.sh).
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:5173",
    // The container's preinstalled Chromium; CI installs Playwright's own and leaves this unset.
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    trace: "retain-on-failure",
  },
});
