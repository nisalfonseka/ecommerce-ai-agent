import { defineConfig } from "vitest/config";

// ACE_TEST_TIMEOUT_MS raises the timeouts for a remote test database.
const timeout = Number(process.env.ACE_TEST_TIMEOUT_MS);
export default defineConfig({
  test: Number.isFinite(timeout) && timeout > 0 ? { testTimeout: timeout, hookTimeout: timeout } : {},
});
