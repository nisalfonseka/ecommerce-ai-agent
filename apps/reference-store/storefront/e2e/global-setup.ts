import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../../scripts/store-stack.sh", import.meta.url));

/** Starts Medusa, the engine and the storefront; returns the teardown. */
export default function globalSetup(): (() => void) | undefined {
  if (process.env.ACE_E2E_REUSE_STACK === "1") return undefined;
  execFileSync(script, ["start"], { stdio: "inherit" });
  return () => execFileSync(script, ["stop"], { stdio: "inherit" });
}
