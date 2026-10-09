import { parseInput } from "@ace/contracts";
import { z } from "zod";

/** `stores.config.search`. The engine admin route, the provider factory and the worker all validate with it. */
export const StoreSearchConfigSchema = z
  .object({
    mode: z.enum(["live", "index"]).default("live"),
    embeddingModel: z.string().default("google:gemini-embedding-001"), // S1
    enrichmentModel: z.string().default("google:gemini-flash-lite-latest"),
    /** Cosine threshold for knowledge retrieval; calibrated per embedding model (Task 11 Step 2). */
    knowledgeThreshold: z.number().min(0).max(1).default(0.6),
  })
  .prefault({});
export type StoreSearchConfig = z.output<typeof StoreSearchConfigSchema>;

/** Reads `storeConfig.search` (absent → defaults). Bad values → CommerceError INVALID_INPUT. */
export function parseStoreSearchConfig(storeConfig: unknown): StoreSearchConfig {
  const search =
    typeof storeConfig === "object" && storeConfig !== null && !Array.isArray(storeConfig)
      ? (storeConfig as Record<string, unknown>).search
      : undefined;
  return parseInput(StoreSearchConfigSchema, search);
}
