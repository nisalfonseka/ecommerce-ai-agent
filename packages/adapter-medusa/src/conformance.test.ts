import { describeProviderConformance } from "@ace/contracts/testing";
import { describe, it } from "vitest";
import { medusaConformance } from "./testing";

// Runs against a real Medusa backend (scripts/reference-store.sh start; ACE_MEDUSA_SEED_OUTPUT). Replay is the
// engine's job (ADR-002): apps/engine runs the replay tests over IdempotentCommerceProvider(Medusa).
const medusa = medusaConformance();

if (medusa) {
  let reset: Promise<void> | undefined;
  describeProviderConformance(
    "medusa",
    async () => {
      reset ??= medusa.resetStock();
      await reset;
      return { provider: medusa.provider(), fixtures: medusa.fixtures };
    },
    { replay: false },
  );
} else {
  describe.skip("Medusa conformance (needs ACE_MEDUSA_SEED_OUTPUT; see scripts/reference-store.sh)", () => {
    it("skipped", () => {});
  });
}
