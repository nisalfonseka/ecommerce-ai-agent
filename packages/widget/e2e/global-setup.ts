import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/dev-stack.sh", import.meta.url));

/** Starts Postgres, the engine and the demo store; returns the teardown. */
export default function globalSetup(): () => void {
  const env = { ...process.env, ACE_DEV_RESET: "1" };
  execFileSync(script, ["start"], { stdio: "inherit", env });
  return () => execFileSync(script, ["stop"], { stdio: "inherit", env });
}
