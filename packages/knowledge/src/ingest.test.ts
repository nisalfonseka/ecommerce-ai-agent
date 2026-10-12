import { createHash } from "node:crypto";
import {
  createDb,
  createDocument,
  createStore,
  createTenant,
  getDocument,
  listChunks,
  withTenant,
} from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDemoEmbedder, type Embedder } from "./embedding";
import { ingestDocument } from "./ingest";

const testDb = await createTestDatabase();

const POLICY_V1 = [
  "# Returns",
  "",
  "## Exchanges",
  "",
  "Exchanges within 7 days of delivery. Items must be unworn with tags attached.",
  "",
  "# Shipping",
  "",
  "Colombo delivery takes 1-2 working days. Outstation delivery takes 3-5 working days.",
].join("\n");
const POLICY_V2 = "# Returns\n\nExchanges within 14 days.";

const failing: Embedder = {
  model: "demo:failing",
  embed: async () => {
    throw new Error("provider unavailable: secret request id 123");
  },
};

describe.skipIf(testDb === null)("ingestDocument", () => {
  let app: ReturnType<typeof createDb>;
  let tenantId: string;
  let storeId: string;
  let otherStoreId: string;

  beforeAll(async () => {
    if (!testDb) return;
    app = createDb(testDb.appUrl);
    ({ tenantId } = await createTenant(app.db, { name: "Knowledge" }));
    [storeId, otherStoreId] = await withTenant(app.db, tenantId, async (tx) => [
      (await createStore(tx, tenantId, { platform: "memory", currency: "LKR" })).id,
      (await createStore(tx, tenantId, { platform: "memory", currency: "LKR" })).id,
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  const upload = (title: string, content: string) =>
    withTenant(app.db, tenantId, (tx) =>
      createDocument(tx, tenantId, {
        storeId,
        title,
        sourceType: "markdown",
        sourceUrl: null,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
      }),
    );
  const read = (documentId: string) =>
    withTenant(app.db, tenantId, async (tx) => ({
      doc: await getDocument(tx, storeId, documentId),
      chunks: await listChunks(tx, storeId, documentId),
    }));

  it("chunks and embeds a document, then marks it ready", async () => {
    const { id } = await upload("Policies", POLICY_V1);
    const deps = { db: app.db, tenantId, storeId, embedder: createDemoEmbedder() };
    expect(await ingestDocument(deps, id)).toBe("ready");
    const { doc, chunks } = await read(id);
    expect(doc).toMatchObject({ status: "ready", error: null, chunkCount: chunks.length, version: 1 });
    expect(chunks.map((c) => c.heading)).toEqual(["Returns > Exchanges", "Shipping"]);
    expect(chunks.every((c) => c.embeddingModel === "demo:hash-v1")).toBe(true);

    // Idempotent: a retry replaces the chunks instead of adding more.
    expect(await ingestDocument(deps, id)).toBe("ready");
    expect((await read(id)).chunks).toHaveLength(chunks.length);
  });

  it("keeps the previous version's chunks when embedding the new version fails", async () => {
    const { id } = await upload("Returns", POLICY_V1);
    expect(await ingestDocument({ db: app.db, tenantId, storeId, embedder: createDemoEmbedder() }, id)).toBe(
      "ready",
    );
    const before = await read(id);

    const reupload = await upload("Returns", POLICY_V2);
    expect(reupload).toMatchObject({ id, version: 2, status: "pending" });
    expect(await ingestDocument({ db: app.db, tenantId, storeId, embedder: failing }, id)).toBe("error");

    const after = await read(id);
    expect(after.doc).toMatchObject({ status: "error", error: "embedding_failed", version: 2 });
    expect(after.doc?.content).toBe(POLICY_V2);
    expect(after.chunks).toEqual(before.chunks);
  });

  it("does not write a superseded version's chunks", async () => {
    const { id } = await upload("Shipping", POLICY_V1);
    const reuploading: Embedder = {
      model: "demo:hash-v1",
      embed: async (values, purpose) => {
        await upload("Shipping", POLICY_V2); // a newer upload lands while this version is being embedded
        return createDemoEmbedder().embed(values, purpose);
      },
    };
    expect(await ingestDocument({ db: app.db, tenantId, storeId, embedder: reuploading }, id)).toBe(
      "missing",
    );
    const { doc, chunks } = await read(id);
    expect(doc).toMatchObject({ status: "pending", version: 2 });
    expect(chunks).toEqual([]);
  });

  it("marks a document with nothing to chunk failed (empty) without calling the embedder", async () => {
    const { id } = await upload("Heading only", "# Title\n\n## Subtitle");
    const embed = vi.fn(createDemoEmbedder().embed);
    expect(
      await ingestDocument({ db: app.db, tenantId, storeId, embedder: { model: "demo:hash-v1", embed } }, id),
    ).toBe("empty");
    expect(embed).not.toHaveBeenCalled();
    const { doc, chunks } = await read(id);
    expect(doc).toMatchObject({ status: "error", error: "empty", chunkCount: 0, version: 1 });
    expect(chunks).toEqual([]);
  });

  it("marks a document over 1,000 chunks failed (too_large) without calling the embedder", async () => {
    const faq = Array.from({ length: 1001 }, (_, i) => `## Q${i}\nA${i}.`).join("\n");
    const { id } = await upload("Huge FAQ", faq);
    const embed = vi.fn(createDemoEmbedder().embed);
    expect(
      await ingestDocument({ db: app.db, tenantId, storeId, embedder: { model: "demo:hash-v1", embed } }, id),
    ).toBe("too_large");
    expect(embed).not.toHaveBeenCalled();
    const { doc, chunks } = await read(id);
    expect(doc).toMatchObject({ status: "error", error: "too_large", chunkCount: 0 });
    expect(chunks).toEqual([]);
  });

  it("reports a document that is gone or belongs to another store as missing", async () => {
    const { id } = await upload("Care", POLICY_V1);
    const embedder = createDemoEmbedder();
    expect(await ingestDocument({ db: app.db, tenantId, storeId: otherStoreId, embedder }, id)).toBe(
      "missing",
    );
    expect(
      await ingestDocument(
        { db: app.db, tenantId, storeId, embedder },
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBe("missing");
  });
});
