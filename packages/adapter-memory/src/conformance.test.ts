import { describeProviderConformance } from "@ace/contracts/testing";
import { MemoryCommerceProvider } from "./memory-provider";
import { memoryFixtures } from "./seed";

describeProviderConformance("memory", async () => ({
  provider: new MemoryCommerceProvider(),
  fixtures: memoryFixtures,
}));
