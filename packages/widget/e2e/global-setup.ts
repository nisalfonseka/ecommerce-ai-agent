import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/dev-stack.sh", import.meta.url));

/** Starts Postgres, the engine and the demo store; returns the teardown. */
export default function globalSetup(): () => void {
  execFileSync(script, ["start"], { stdio: "inherit" });
  return () => execFileSync(script, ["stop"], { stdio: "inherit" });
}
