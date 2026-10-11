import { createHash } from "node:crypto";
import { createDb, createDocument, deleteDocument, getDocument, listChunks, withTenant } from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { createDemoEmbedder, type Embedder } from "@ace/knowledge";
import { parseStoreSearchConfig } from "@ace/search";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capturingLogger, fakeJob, newStore, testDeps } from "../testing";
import { handleKnowledgeIngest } from "./knowledge";

const testDb = await createTestDatabase();
const CONTENT = "# Returns\n\nExchanges within 7 days of delivery.";

describe.skipIf(testDb === null)("knowledge.ingest", () => {
  let app: ReturnType<typeof createDb>;

  beforeAll(() => {
    if (testDb) app = createDb(testDb.appUrl);
  });
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  async function storeWithDocument(search: Record<string, unknown>, content = CONTENT) {
    const store = await newStore(app.db, search);
    const { id } = await withTenant(app.db, store.tenantId, (tx) =>
      createDocument(tx, store.tenantId, {
        storeId: store.storeId,
        title: "Returns",
        sourceType: "markdown",
        sourceUrl: null,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
      }),
    );
    return { ...store, documentId: id };
  }
  const read = (s: { tenantId: string; storeId: string; documentId: string }) =>
    withTenant(app.db, s.tenantId, async (tx) => ({
      doc: await getDocument(tx, s.storeId, s.documentId),
      chunks: await listChunks(tx, s.storeId, s.documentId),
    }));

  it("ingests with the store's embedding model, for live-mode stores too", async () => {
    const search = { mode: "live", embeddingModel: "demo:knowledge-spec" };
    const s = await storeWithDocument(search);
    const embedderFor = vi.fn(() => createDemoEmbedder());
    const { logger, lines } = capturingLogger();
    const deps = testDeps(app.db, {
      embedderFor,
      logger,
      storeSearchConfig: async () => parseStoreSearchConfig({ search }),
    });
    await handleKnowledgeIngest(deps, fakeJob(JOBS.knowledgeIngest, s));

    expect(embedderFor).toHaveBeenCalledWith("demo:knowledge-spec");
    const { doc, chunks } = await read(s);
    expect(doc).toMatchObject({ status: "ready", chunkCount: 1 });
    expect(chunks[0]).toMatchObject({ heading: "Returns", embeddingModel: "demo:hash-v1" });
    expect(lines.at(-1)).toMatchObject({
      msg: "knowledge ingested",
      documentId: s.documentId,
      outcome: "ready",
    });
    expect(JSON.stringify(lines)).not.toContain("Exchanges");
  });

  it("marks the document failed and throws (so pg-boss retries) when embedding fails", async () => {
    const s = await storeWithDocument({ mode: "index", embeddingModel: "demo:x" });
    const failing: Embedder = {
      model: "demo:x",
      embed: async () => {
        throw new Error("rate limited");
      },
    };
    const deps = testDeps(app.db, { embedderFor: () => failing });
    await expect(handleKnowledgeIngest(deps, fakeJob(JOBS.knowledgeIngest, s))).rejects.toThrow(
      /embedding failed/,
    );
    expect((await read(s)).doc).toMatchObject({ status: "error", error: "embedding_failed" });
  });

  it("marks the document failed when the store's embedding model cannot be used", async () => {
    const s = await storeWithDocument({ mode: "index", embeddingModel: "demo:x" });
    const deps = testDeps(app.db, {
      embedderFor: () => {
        throw new Error('Embedding model "demo:x" is not allowed in production.');
      },
    });
    await expect(handleKnowledgeIngest(deps, fakeJob(JOBS.knowledgeIngest, s))).rejects.toThrow(
      /embedding failed/,
    );
    expect((await read(s)).doc).toMatchObject({ status: "error", error: "embedding_failed" });
  });

  it("marks a document with nothing to chunk empty and completes, since a retry cannot help", async () => {
    const s = await storeWithDocument({ mode: "index", embeddingModel: "demo:x" }, "# Returns");
    const embedderFor = vi.fn(() => createDemoEmbedder());
    const { logger, lines } = capturingLogger();
    const deps = testDeps(app.db, { embedderFor, logger });
    await expect(handleKnowledgeIngest(deps, fakeJob(JOBS.knowledgeIngest, s))).resolves.toBeUndefined();
    expect(embedderFor).not.toHaveBeenCalled();
    expect(await read(s)).toMatchObject({
      doc: { status: "error", error: "empty", chunkCount: 0 },
      chunks: [],
    });
    expect(lines.at(-1)).toMatchObject({ msg: "knowledge document empty", outcome: "empty" });
  });

  it("completes quietly for a deleted document", async () => {
    const s = await storeWithDocument({ mode: "index", embeddingModel: "demo:x" });
    await withTenant(app.db, s.tenantId, (tx) => deleteDocument(tx, s.storeId, s.documentId));
    const deps = testDeps(app.db);
    await expect(handleKnowledgeIngest(deps, fakeJob(JOBS.knowledgeIngest, s))).resolves.toBeUndefined();
  });
});
