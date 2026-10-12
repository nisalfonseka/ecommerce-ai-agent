import { createHash } from "node:crypto";
import { createDb, createDocument, createStore, createTenant, withTenant } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDemoEmbedder, type Embedder } from "./embedding";
import { ingestDocument } from "./ingest";
import { createKnowledgeSearch } from "./retrieve";

const testDb = await createTestDatabase();

const failingEmbedder: Embedder = {
  model: "demo:hash-v1",
  embed: async () => {
    throw new Error("embedding service unavailable");
  },
};

describe.skipIf(testDb === null)("createKnowledgeSearch", () => {
  let app: ReturnType<typeof createDb>;
  let tenantA: string;
  let tenantB: string;
  let storeA: string;
  let storeA2: string;
  let storeB: string;

  beforeAll(async () => {
    if (!testDb) return;
    app = createDb(testDb.appUrl);
    ({ tenantId: tenantA } = await createTenant(app.db, { name: "Knowledge A" }));
    ({ tenantId: tenantB } = await createTenant(app.db, { name: "Knowledge B" }));
    [storeA, storeA2] = await withTenant(app.db, tenantA, async (tx) => [
      (await createStore(tx, tenantA, { platform: "memory", currency: "LKR" })).id,
      (await createStore(tx, tenantA, { platform: "memory", currency: "LKR" })).id,
    ]);
    storeB = await withTenant(
      app.db,
      tenantB,
      async (tx) => (await createStore(tx, tenantB, { platform: "memory", currency: "LKR" })).id,
    );
  });

  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  async function add(
    tenantId: string,
    storeId: string,
    title: string,
    content: string,
    embedder: Embedder = createDemoEmbedder(),
  ) {
    const doc = await withTenant(app.db, tenantId, (tx) =>
      createDocument(tx, tenantId, {
        storeId,
        title,
        sourceType: "markdown",
        sourceUrl: null,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
      }),
    );
    await ingestDocument({ db: app.db, tenantId, storeId, embedder }, doc.id);
    return doc.id;
  }

  it("ranks a confident passage first and returns no passage for an unrelated question", async () => {
    await add(tenantA, storeA, "Returns policy", "# Exchanges\n\nExchange items within 7 days with receipt.");
    await add(tenantA, storeA, "Care guide", "# Linen\n\nHand wash linen in cold water and air dry.");
    const knowledge = createKnowledgeSearch({
      db: app.db,
      tenantId: tenantA,
      storeId: storeA,
      embedder: createDemoEmbedder(),
    });
    const returns = await knowledge.search("how many days to exchange");
    expect(returns[0]).toMatchObject({ documentTitle: "Returns policy", heading: "Exchanges" });
    expect(returns[0]?.text).toContain("7 days");
    expect(await knowledge.search("do you sell gift cards")).toEqual([]);
  });

  it("never crosses the tenant or store boundary and excludes non-ready documents", async () => {
    await add(tenantA, storeA, "Visible", "# Scope\n\nThe scope word for this store is alpha.");
    await add(tenantA, storeA2, "Other store secret", "# Scope\n\nThe scope word is beta.");
    await add(tenantB, storeB, "Other tenant secret", "# Scope\n\nThe scope word is gamma.");
    await add(tenantA, storeA, "Broken", "# Gift cards\n\nGift cards are sold.", failingEmbedder);

    const passages = await createKnowledgeSearch({
      db: app.db,
      tenantId: tenantA,
      storeId: storeA,
      embedder: createDemoEmbedder(),
    }).search("scope word gift cards");
    expect(passages.map((passage) => passage.documentTitle)).toEqual(["Visible"]);
  });

  it("falls back to qualified full-text results when query embedding fails", async () => {
    await add(tenantA, storeA, "Payment guide", "# Cash on delivery\n\nCash on delivery is available.");
    const onError = vi.fn();
    const passages = await createKnowledgeSearch({
      db: app.db,
      tenantId: tenantA,
      storeId: storeA,
      embedder: failingEmbedder,
      onError,
    }).search("cash delivery");
    expect(passages[0]?.documentTitle).toBe("Payment guide");
    expect(onError).toHaveBeenCalledOnce();
  });
});
