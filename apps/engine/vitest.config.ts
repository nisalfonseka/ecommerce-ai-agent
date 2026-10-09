import { defineConfig } from "vitest/config";

// Integration tests may run against a remote database; ACE_TEST_TIMEOUT_MS raises the per-test and hook timeouts.
const timeout = Number(process.env.ACE_TEST_TIMEOUT_MS);
export default defineConfig({
  test: Number.isFinite(timeout) && timeout > 0 ? { testTimeout: timeout, hookTimeout: timeout } : {},
});
