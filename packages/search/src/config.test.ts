import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { parseStoreSearchConfig, StoreSearchConfigSchema } from "./config";

describe("store search config", () => {
  it("defaults to live mode with the S1 embedding model", () => {
    const defaults = {
      mode: "live",
      embeddingModel: "google:gemini-embedding-001",
      enrichmentModel: "google:gemini-flash-lite-latest",
      knowledgeThreshold: 0.6,
    };
    expect(StoreSearchConfigSchema.parse(undefined)).toEqual(defaults);
    expect(parseStoreSearchConfig({})).toEqual(defaults);
    expect(parseStoreSearchConfig(null)).toEqual(defaults);
    expect(parseStoreSearchConfig({ currency: "LKR" })).toEqual(defaults);
  });

  it("reads storeConfig.search", () => {
    expect(
      parseStoreSearchConfig({
        search: { mode: "index", embeddingModel: "demo:hash", knowledgeThreshold: 0.4 },
      }),
    ).toMatchObject({ mode: "index", embeddingModel: "demo:hash", knowledgeThreshold: 0.4 });
  });

  it("rejects bad values with INVALID_INPUT", () => {
    for (const search of [{ mode: "fast" }, { knowledgeThreshold: 2 }, { embeddingModel: 5 }, "index"]) {
      try {
        parseStoreSearchConfig({ search });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CommerceError);
        expect(error).toMatchObject({ code: "INVALID_INPUT" });
      }
    }
  });
});
