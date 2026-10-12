import { defineConfig } from "@playwright/test";

// The reference store end to end: Medusa, the engine on the Medusa adapter (keyless demo model) and this
// storefront with the assistant (scripts/store-stack.sh). ACE_E2E_REUSE_STACK=1 uses an already running stack.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 90_000,
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:8000",
    // The container's preinstalled Chromium; CI installs Playwright's own and leaves this unset.
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    trace: "retain-on-failure",
  },
});
