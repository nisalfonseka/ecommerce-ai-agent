import { defineConfig } from "vitest/config";

// Later tasks add database tests here; ACE_TEST_TIMEOUT_MS raises the timeouts for a remote database.
const timeout = Number(process.env.ACE_TEST_TIMEOUT_MS);
export default defineConfig({
  test: Number.isFinite(timeout) && timeout > 0 ? { testTimeout: timeout, hookTimeout: timeout } : {},
});
