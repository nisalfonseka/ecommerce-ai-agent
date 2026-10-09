import { describeProviderConformance } from "@ace/contracts/testing";
import { MemoryCommerceProvider } from "./memory-provider";
import { memoryFixtures } from "./seed";

describeProviderConformance("memory", async () => {
  const provider = new MemoryCommerceProvider();
  return {
    provider,
    fixtures: { ...memoryFixtures, control: { setStock: async (id, qty) => provider.setStock(id, qty) } },
  };
});
