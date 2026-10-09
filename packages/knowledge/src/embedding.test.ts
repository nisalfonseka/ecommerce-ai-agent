import { MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAiEmbedder, createDemoEmbedder, EMBEDDING_DIMENSIONS, embedderFor } from "./embedding";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // inputs are unit vectors
}

describe("demo embedder", () => {
  const demo = createDemoEmbedder();

  it("is deterministic, 768-dimensional and unit length", async () => {
    const [a] = await demo.embed(["black dress"], "document");
    const [b] = await demo.embed(["black dress"], "query");
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt((a ?? []).reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
    expect(demo.model).toBe("demo:hash-v1");
  });

  it("ranks lexical overlap above unrelated text", async () => {
    const [q, same, other] = await demo.embed(["black dress", "dress black", "linen shirt"], "query");
    expect(cosine(q ?? [], same ?? [])).toBeGreaterThan(cosine(q ?? [], other ?? []));
  });

  it("handles Sinhala and empty input", async () => {
    const [si, empty] = await demo.embed(["කළු ගවුම", ""], "document");
    expect(si).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(si).not.toEqual(empty);
    expect(empty?.[0]).toBe(1);
  });
});

describe("createAiEmbedder", () => {
  function mock(dim: number) {
    const model = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 1000,
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() => new Array<number>(dim).fill(0.1)),
        warnings: [],
      }),
    });
    return model;
  }

  it("batches 120 values into 50/50/20 and passes the purpose's provider options", async () => {
    const model = mock(EMBEDDING_DIMENSIONS);
    const purposes: string[] = [];
    const embedder = createAiEmbedder("google:x", {
      model,
      providerOptions: (purpose) => {
        purposes.push(purpose);
        return { google: { purpose } };
      },
    });
    const out = await embedder.embed(
      Array.from({ length: 120 }, (_, i) => `v${i}`),
      "query",
    );
    expect(out).toHaveLength(120);
    expect(model.doEmbedCalls.map((c) => c.values.length).sort((a, b) => b - a)).toEqual([50, 50, 20]);
    expect(model.doEmbedCalls.every((c) => c.providerOptions?.google?.purpose === "query")).toBe(true);
    expect(purposes.every((p) => p === "query")).toBe(true);
    expect(embedder.model).toBe("google:x");
  });

  it("rejects vectors of the wrong dimension", async () => {
    const embedder = createAiEmbedder("openai:x", { model: mock(1536), providerOptions: () => ({}) });
    await expect(embedder.embed(["a"], "document")).rejects.toThrow("embedding dimension 1536 ≠ 768");
  });
});

describe("embedderFor", () => {
  const resolve = () => {
    throw new Error("should not resolve");
  };

  it("refuses demo specs unless allowed", () => {
    expect(() => embedderFor("demo:x", { allowDemo: false, resolve })).toThrow();
    expect(embedderFor("demo:x", { allowDemo: true, resolve }).model).toBe("demo:hash-v1");
  });
});
