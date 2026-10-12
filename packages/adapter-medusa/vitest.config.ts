import { defineConfig } from "vitest/config";

// The conformance run talks to a real Medusa backend over HTTP.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
