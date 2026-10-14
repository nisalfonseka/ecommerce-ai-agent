import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { createDb, openSecret, schema, upsertAttributedOrder, withTenant } from "@ace/db";
import type { JobName, JobPayload, JobQueue } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { createDemoEmbedder, ingestDocument } from "@ace/knowledge";
import { makePdf, textPage } from "@ace/knowledge/testing";
import { createDemoEnricher, enrichStoredProduct, syncProduct } from "@ace/search";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadModelPrices } from "../budget";
import { createLogger } from "../log";
import { registerAdminRoutes } from "./admin";

const testDb = await createTestDatabase();
const ADMIN_KEY = "admin-test-key-0123456789";
const MASTER_KEY = randomBytes(32);

class RecordingQueue implements JobQueue {
  sent: JobName[] = [];
  sends: { name: JobName; data: unknown; debounceKey?: string }[] = [];
  async send<N extends JobName>(
    name: N,
    data: JobPayload<N>,
    options?: { debounceKey?: string; debounceSeconds?: number },
  ): Promise<void> {
    this.sent.push(name);
    this.sends.push({ name, data, debounceKey: options?.debounceKey });
  }
}

describe.skipIf(testDb === null)("admin API", () => {
  const jobs = new RecordingQueue();
  let pool: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (!testDb) return;
    pool = createDb(testDb.appUrl);
    const logger = createLogger({ level: "silent" });
    app = createApp({ logger, ping: async () => true, resolveWidgetKey: async () => null });
    registerAdminRoutes(app, {
      db: pool.db,
      adminApiKeySha256: createHash("sha256").update(ADMIN_KEY).digest("hex"),
      masterKey: MASTER_KEY,
      jobs,
      prices: loadModelPrices({
        models: {
          "demo:search-only": {
            inputPerMTokUsdMicros: 0,
            outputPerMTokUsdMicros: 0,
            source: "x",
            checkedOn: null,
          },
        },
      }),
    });
  });
  afterAll(async () => {
    await pool?.close();
    await testDb?.drop();
  });

  const call = (method: string, path: string, body?: unknown, key = ADMIN_KEY) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (res: Response) => (await res.json()) as Record<string, string>;

  const bot = (storeId: string, overrides: Record<string, unknown> = {}) => ({
    storeId,
    persona: { assistantName: "Nila", storeName: "Demo", languages: ["English", "Sinhala"] },
    storeFacts: { currency: "LKR" },
    model: "demo:search-only",
    cheapModel: "demo:search-only",
    budgetSoftUsdMicros: 5_000_000,
    budgetHardUsdMicros: 10_000_000,
    ...overrides,
  });

  it("refuses requests without the admin key", async () => {
    expect((await call("POST", "/admin/tenants", { name: "X" }, "wrong")).status).toBe(401);
    expect((await app.request("/admin/tenants", { method: "POST" })).status).toBe(401);
  });

  it("creates a tenant, store, bot and widget key, then revokes the key", async () => {
    const { tenantId } = await json(await call("POST", "/admin/tenants", { name: "Admin Flow" }));
    const storeRes = await call("POST", `/admin/tenants/${tenantId}/stores`, {
      platform: "memory",
      currency: "LKR",
      credentials: "secret-api-token",
    });
    expect(storeRes.status).toBe(201);
    const { storeId } = await json(storeRes);
    const botRes = await call("POST", `/admin/tenants/${tenantId}/bots`, bot(storeId ?? ""));
    expect(botRes.status).toBe(201);
    const { botId } = await json(botRes);
    const keyRes = await call("POST", `/admin/tenants/${tenantId}/bots/${botId}/widget-keys`, {
      allowedOrigins: ["https://shop.example.lk"],
    });
    expect(keyRes.status).toBe(201);
    const { key, keyId } = await json(keyRes);
    expect(key).toMatch(/^pk_live_/);
    expect((await call("DELETE", `/admin/tenants/${tenantId}/widget-keys/${keyId}`)).status).toBe(204);
    expect((await call("DELETE", `/admin/tenants/${tenantId}/widget-keys/${keyId}`)).status).toBe(404);
  });

  it("rotates and returns a tenant host-session secret only in the response", async () => {
    const { tenantId } = await json(await call("POST", "/admin/tenants", { name: "Host Sessions" }));
    const path = `/admin/tenants/${tenantId}/host-session-secret`;
    const first = await call("POST", path);
    expect(first.status).toBe(201);
    const firstSecret = (await json(first)).secret ?? "";
    expect(Buffer.from(firstSecret, "base64url")).toHaveLength(32);
    const secondSecret = (await json(await call("POST", path))).secret ?? "";
    expect(secondSecret).not.toBe(firstSecret);
    const [row] = await withTenant(pool.db, tenantId ?? "", (tx) =>
      tx.select({ sealed: schema.tenantSettings.hostSessionSecretSealed }).from(schema.tenantSettings),
    );
    expect(row?.sealed).not.toBeNull();
    expect(openSecret(row?.sealed ?? Buffer.alloc(0), MASTER_KEY)).toBe(secondSecret);
    expect(
      (await call("POST", "/admin/tenants/00000000-0000-4000-8000-000000000000/host-session-secret")).status,
    ).toBe(404);
  });

  it("registers a Medusa store only with complete credentials, and never echoes them", async () => {
    const { tenantId } = await json(await call("POST", "/admin/tenants", { name: "Medusa Store" }));
    const credentials = {
      baseUrl: "https://store-api.example.lk",
      publishableKey: "pk_123",
      secretKey: "sk_super_secret",
      regionId: "reg_1",
      storefrontUrl: "https://shop.example.lk",
    };
    const create = (body: Record<string, unknown>) =>
      call("POST", `/admin/tenants/${tenantId}/stores`, { platform: "medusa", currency: "LKR", ...body });
    expect((await create({})).status).toBe(400);
    expect((await create({ credentials: "not json" })).status).toBe(400);
    const incomplete = await create({
      credentials: JSON.stringify({ ...credentials, secretKey: undefined }),
    });
    expect(incomplete.status).toBe(400);
    const created = await create({ credentials: JSON.stringify(credentials) });
    expect(created.status).toBe(201);
    expect(await created.text()).not.toContain("sk_super_secret");
  });

  it("validates and stores the store's search config", async () => {
    const { tenantId } = await json(await call("POST", "/admin/tenants", { name: "Admin Search Config" }));
    const create = (config: unknown) =>
      call("POST", `/admin/tenants/${tenantId}/stores`, { platform: "memory", currency: "LKR", config });
    for (const search of [{ mode: "fast" }, { knowledgeThreshold: 1.5 }, { embeddingModel: 7 }, "index"]) {
      const res = await create({ search });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_input" } });
    }
    const search = { mode: "index", embeddingModel: "demo:hash-v1" };
    const created = await create({ search, other: true });
    expect(created.status).toBe(201);
    const { storeId } = await json(created);
    const [row] = await withTenant(pool.db, tenantId ?? "", (tx) =>
      tx
        .select({ config: schema.stores.config })
        .from(schema.stores)
        .where(eq(schema.stores.id, storeId ?? "")),
    );
    expect(row?.config).toEqual({ search, other: true });
  });

  it("validates bots: known models, persona shape and caps", async () => {
    const { tenantId } = await json(await call("POST", "/admin/tenants", { name: "Admin Validation" }));
    const { storeId } = await json(
      await call("POST", `/admin/tenants/${tenantId}/stores`, { platform: "memory", currency: "LKR" }),
    );
    const create = (overrides: Record<string, unknown>) =>
      call("POST", `/admin/tenants/${tenantId}/bots`, bot(storeId ?? "", overrides));
    expect((await create({ model: "openai:unlisted" })).status).toBe(400);
    expect((await create({ persona: { assistantName: "" } })).status).toBe(400);
    expect((await create({ budgetSoftUsdMicros: 10, budgetHardUsdMicros: 5 })).status).toBe(400);
    expect(
      (await call("POST", `/admin/tenants/${tenantId}/stores`, { platform: "shopify", currency: "LKR" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/admin/tenants/${tenantId}/bots/${storeId}/widget-keys`, {
          allowedOrigins: ["not a url"],
        })
      ).status,
    ).toBe(400);
  });

  it("keeps tenants apart and reports usage per tenant", async () => {
    const { tenantId: a } = await json(await call("POST", "/admin/tenants", { name: "Usage A" }));
    const { tenantId: b } = await json(await call("POST", "/admin/tenants", { name: "Usage B" }));
    const { storeId } = await json(
      await call("POST", `/admin/tenants/${a}/stores`, { platform: "memory", currency: "LKR" }),
    );
    // Tenant B cannot attach a bot to tenant A's store.
    expect((await call("POST", `/admin/tenants/${b}/bots`, bot(storeId ?? ""))).status).toBe(404);
    const usage = await call("GET", `/admin/tenants/${a}/usage?month=2026-10`);
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual({
      month: "2026-10",
      costUsdMicros: 0,
      turns: 0,
      conversations: 0,
      avgCostPerConversationUsdMicros: null,
    });
    expect((await call("GET", `/admin/tenants/not-a-uuid/usage`)).status).toBe(404);
  });

  describe("enrichment review and overrides", () => {
    const SHIRT = "p_linen_shirt_black";
    async function seededStore(name: string) {
      const { tenantId } = await json(await call("POST", "/admin/tenants", { name }));
      const { storeId } = await json(
        await call("POST", `/admin/tenants/${tenantId}/stores`, { platform: "memory", currency: "LKR" }),
      );
      const deps = {
        db: pool.db,
        tenantId: tenantId ?? "",
        storeId: storeId ?? "",
        jobs: new RecordingQueue(),
      };
      await syncProduct(
        { ...deps, provider: new MemoryCommerceProvider(), embeddingModel: "demo:embed" },
        SHIRT,
      );
      await enrichStoredProduct({ ...deps, enricher: createDemoEnricher() }, SHIRT);
      return { tenantId, storeId };
    }
    const overridesPath = (t?: string, s?: string) =>
      `/admin/tenants/${t}/stores/${s}/products/${SHIRT}/overrides`;

    it("lists enriched products with their overrides and edits them", async () => {
      const { tenantId, storeId } = await seededStore("Review A");
      jobs.sent = [];
      const put = await call("PUT", overridesPath(tenantId, storeId), {
        attributes: { color: ["navy"] },
        hidden: true,
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        productId: SHIRT,
        overrides: { color: ["navy"] },
        attributes: { color: ["navy"] },
        hidden: true,
      });
      expect(jobs.sent).toEqual(["embed.product"]);

      const list = await call("GET", `/admin/tenants/${tenantId}/stores/${storeId}/enrichment?limit=10`);
      expect(list.status).toBe(200);
      const page = (await list.json()) as { items: Record<string, unknown>[]; nextCursor: string | null };
      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        productId: SHIRT,
        enrichmentModel: "demo:rules-v1",
        overrides: { color: ["navy"] },
        enriched: { fabric: ["linen"] },
      });
    });

    it("pages with a cursor without overlap", async () => {
      const { tenantId, storeId } = await seededStore("Review Page");
      const deps = {
        db: pool.db,
        tenantId: tenantId ?? "",
        storeId: storeId ?? "",
        jobs: new RecordingQueue(),
      };
      for (const id of ["p_oxford_shirt_white", "p_wrap_dress_black"]) {
        await syncProduct(
          { ...deps, provider: new MemoryCommerceProvider(), embeddingModel: "demo:embed" },
          id,
        );
        await enrichStoredProduct({ ...deps, enricher: createDemoEnricher() }, id);
      }
      type Page = { items: { productId: string }[]; nextCursor: string | null };
      const base = `/admin/tenants/${tenantId}/stores/${storeId}/enrichment`;
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await call(
          "GET",
          `${base}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        const page = (await res.json()) as Page;
        expect(page.items).toHaveLength(1);
        seen.push(...page.items.map((i) => i.productId));
        cursor = page.nextCursor;
        pages += 1;
        if (pages === 1) expect(cursor).not.toBeNull();
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual(["p_linen_shirt_black", "p_oxford_shirt_white", "p_wrap_dress_black"]);
      expect((await call("GET", `${base}?limit=0`)).status).toBe(400);
    });

    it("rejects out-of-range or unknown overrides with 400", async () => {
      const { tenantId, storeId } = await seededStore("Review B");
      expect((await call("PUT", overridesPath(tenantId, storeId), { boost: 2 })).status).toBe(400);
      expect(
        (await call("PUT", overridesPath(tenantId, storeId), { attributes: { mood: ["x"] } })).status,
      ).toBe(400);
    });

    it("answers 404 for another tenant's product or an unknown one", async () => {
      const a = await seededStore("Review Owner");
      const b = await seededStore("Review Intruder");
      // tenant B's path with tenant A's store, and A's tenant with B's store
      expect((await call("PUT", overridesPath(b.tenantId, a.storeId), { hidden: true })).status).toBe(404);
      expect((await call("PUT", overridesPath(a.tenantId, b.storeId), { hidden: true })).status).toBe(404);
      expect((await call("GET", `/admin/tenants/${b.tenantId}/stores/${a.storeId}/enrichment`)).status).toBe(
        404,
      );
      expect(
        (
          await call("PUT", `/admin/tenants/${a.tenantId}/stores/${a.storeId}/products/nope/overrides`, {
            hidden: true,
          })
        ).status,
      ).toBe(404);
      const own = await call("GET", `/admin/tenants/${a.tenantId}/stores/${a.storeId}/enrichment`);
      expect(((await own.json()) as { items: { hidden: boolean }[] }).items[0]?.hidden).toBe(false);
    });
  });
  describe("sync and attribution", () => {
    async function store(name: string, config?: unknown) {
      const { tenantId } = await json(await call("POST", "/admin/tenants", { name }));
      const { storeId } = await json(
        await call("POST", `/admin/tenants/${tenantId}/stores`, {
          platform: "memory",
          currency: "LKR",
          config,
        }),
      );
      return { tenantId: tenantId ?? "", storeId: storeId ?? "" };
    }
    const syncPath = (s: { tenantId: string; storeId: string }) =>
      `/admin/tenants/${s.tenantId}/stores/${s.storeId}/sync`;

    it("enqueues a reconcile (incremental by default) and answers 202", async () => {
      const s = await store("Sync A");
      jobs.sends = [];
      expect((await call("POST", syncPath(s), { full: true })).status).toBe(202);
      expect((await call("POST", syncPath(s))).status).toBe(202);
      expect(jobs.sends).toEqual([
        { name: "sync.reconcile", data: { ...s, full: true }, debounceKey: `${s.storeId}:full` },
        { name: "sync.reconcile", data: { ...s, full: false }, debounceKey: `${s.storeId}:incremental` },
      ]);
      expect((await call("POST", syncPath(s), { full: "yes" })).status).toBe(400);
    });

    it("reports sync state and catalog counts", async () => {
      const s = await store("Sync B", { search: { mode: "index", embeddingModel: "demo:hash-v1" } });
      const before = await call("GET", syncPath(s));
      expect(before.status).toBe(200);
      expect(await before.json()).toEqual({
        state: { status: "never", lastFullSyncAt: null, lastIncrementalSyncAt: null, lastError: null },
        counts: { active: 0, deleted: 0, enriched: 0, embedded: 0, staleEmbeddings: 0 },
      });
      await syncProduct(
        {
          db: pool.db,
          ...s,
          provider: new MemoryCommerceProvider(),
          jobs: new RecordingQueue(),
          embeddingModel: "demo:hash-v1",
        },
        "p_linen_shirt_black",
      );
      const after = (await (await call("GET", syncPath(s))).json()) as { counts: { active: number } };
      expect(after.counts.active).toBe(1);
    });

    it("answers 404 for another tenant's or an unknown store", async () => {
      const a = await store("Sync Owner");
      const b = await store("Sync Intruder");
      jobs.sends = [];
      const crossed = { tenantId: b.tenantId, storeId: a.storeId };
      expect((await call("POST", syncPath(crossed), {})).status).toBe(404);
      expect((await call("GET", syncPath(crossed))).status).toBe(404);
      expect((await call("GET", syncPath({ tenantId: a.tenantId, storeId: "nope" }))).status).toBe(404);
      expect(jobs.sends).toEqual([]);
    });

    it("reports attribution for a date range, per currency, and validates dates", async () => {
      const s = await store("Attribution");
      await withTenant(pool.db, s.tenantId, async (tx) => {
        for (const [orderId, amount, currency, placedAt] of [
          ["o1", 1_000, "LKR", "2026-09-10T00:00:00Z"],
          ["o2", 2_000, "LKR", "2026-09-20T00:00:00Z"],
          ["o3", 50, "USD", "2026-09-21T00:00:00Z"],
          ["o4", 9_999, "LKR", "2026-10-02T00:00:00Z"],
        ] as const) {
          await upsertAttributedOrder(tx, {
            tenantId: s.tenantId,
            storeId: s.storeId,
            orderId,
            orderNumber: orderId,
            conversationId: null,
            totalAmount: amount,
            currency,
            placedAt: new Date(placedAt),
          });
        }
      });
      const res = await call(
        "GET",
        `/admin/tenants/${s.tenantId}/attribution?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-10-01T00:00:00.000Z",
        orders: 3,
        chatAssisted: 0,
        revenue: [
          { currency: "LKR", total: 3_000, chatAssisted: 0 },
          { currency: "USD", total: 50, chatAssisted: 0 },
        ],
      });
      const monthToDate = (await (await call("GET", `/admin/tenants/${s.tenantId}/attribution`)).json()) as {
        from: string;
      };
      const now = new Date();
      expect(monthToDate.from).toBe(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      );
      expect((await call("GET", `/admin/tenants/${s.tenantId}/attribution?from=yesterday`)).status).toBe(400);
      expect(
        (await call("GET", `/admin/tenants/${s.tenantId}/attribution?from=2026-10-02&to=2026-10-01`)).status,
      ).toBe(400);
    });
  });
  describe("knowledge", () => {
    async function store(name: string) {
      const { tenantId } = await json(await call("POST", "/admin/tenants", { name }));
      const { storeId } = await json(
        await call("POST", `/admin/tenants/${tenantId}/stores`, { platform: "memory", currency: "LKR" }),
      );
      return { tenantId: tenantId ?? "", storeId: storeId ?? "" };
    }
    const base = (s: { tenantId: string; storeId: string }) =>
      `/admin/tenants/${s.tenantId}/stores/${s.storeId}/knowledge`;
    const markdown = (title: string, text: string) => ({ title, source: { type: "markdown", text } });
    const POLICY = `# Returns\n\nExchanges within 7 days.\n\n${"Unworn items with tags. ".repeat(120)}`;
    const chunkCount = (tenantId: string, documentId: string) =>
      withTenant(pool.db, tenantId, async (tx) => {
        const result = await tx.execute(
          sql`select count(*)::int as n from knowledge_chunks where document_id = ${documentId}`,
        );
        return Number((result.rows[0] as { n: number } | undefined)?.n ?? -1);
      });

    it("uploads markdown, answers 202 and enqueues knowledge.ingest", async () => {
      const s = await store("Knowledge Upload");
      jobs.sends = [];
      const res = await call("POST", base(s), markdown("Returns policy", POLICY));
      expect(res.status).toBe(202);
      const { id, status } = await json(res);
      expect(status).toBe("pending");
      expect(jobs.sends).toEqual([
        { name: "knowledge.ingest", data: { ...s, documentId: id }, debounceKey: undefined },
      ]);

      const list = await call("GET", base(s));
      expect(list.status).toBe(200);
      const { items } = (await list.json()) as { items: Record<string, unknown>[] };
      expect(items).toHaveLength(1);
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(
        ["chunkCount", "id", "sourceType", "status", "title", "updatedAt", "version"].sort(),
      );
      expect(items[0]).toMatchObject({ id, title: "Returns policy", sourceType: "markdown", version: 1 });

      const one = await call("GET", `${base(s)}/${id}`);
      expect(one.status).toBe(200);
      const doc = (await one.json()) as { content: string; status: string };
      expect(doc).toMatchObject({ id, title: "Returns policy", status: "pending", chunkCount: 0 });
      expect(doc.content).toBe(POLICY.trim().slice(0, 2000));
      expect(doc.content).toHaveLength(2000);
    });

    it("replaces the content and bumps the version on re-upload with the same title", async () => {
      const s = await store("Knowledge Reupload");
      const first = await json(await call("POST", base(s), markdown("FAQ", "# FAQ\n\nOld answer.")));
      jobs.sends = [];
      const second = await call("POST", base(s), markdown("FAQ", "# FAQ\n\nNew answer."));
      expect(second.status).toBe(202);
      expect((await json(second)).id).toBe(first.id);
      expect(jobs.sends.map((j) => j.name)).toEqual(["knowledge.ingest"]);
      const doc = (await (await call("GET", `${base(s)}/${first.id}`)).json()) as Record<string, unknown>;
      expect(doc).toMatchObject({ version: 2, content: "# FAQ\n\nNew answer." });
      const { items } = (await (await call("GET", base(s))).json()) as { items: unknown[] };
      expect(items).toHaveLength(1);
    });

    it("accepts a PDF", async () => {
      const s = await store("Knowledge PDF");
      const base64 = readFileSync(
        new URL("../../../../packages/knowledge/src/__fixtures__/policy.pdf", import.meta.url),
      ).toString("base64");
      const res = await call("POST", base(s), { title: "Policy PDF", source: { type: "pdf", base64 } });
      expect(res.status).toBe(202);
      const doc = (await (await call("GET", `${base(s)}/${(await json(res)).id}`)).json()) as Record<
        string,
        unknown
      >;
      expect(doc).toMatchObject({
        sourceType: "pdf",
        content: expect.stringContaining("Exchanges within 7 days"),
      });
    });

    it("answers 400 with the extraction error code, and for invalid bodies", async () => {
      const s = await store("Knowledge Errors");
      jobs.sends = [];
      const blocked = await call("POST", base(s), {
        title: "Internal",
        source: { type: "url", url: "http://169.254.169.254/latest/meta-data" },
      });
      expect(blocked.status).toBe(400);
      expect(await blocked.json()).toMatchObject({ error: { code: "blocked_address" } });
      const ftp = await call("POST", base(s), { title: "FTP", source: { type: "url", url: "ftp://x.lk/a" } });
      expect(await ftp.json()).toMatchObject({ error: { code: "bad_url" } });
      const empty = await call("POST", base(s), markdown("Empty", "   "));
      expect(await empty.json()).toMatchObject({ error: { code: "empty" } });
      for (const body of [
        markdown("", "text"),
        markdown("x".repeat(201), "text"),
        { title: "No source" },
        { title: "Bad", source: { type: "docx" } },
      ]) {
        const res = await call("POST", base(s), body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: { code: "invalid_input" } });
      }
      expect(jobs.sends).toEqual([]);
    });

    it("answers 400 for heading-only text, over 1,000 chunks, and a PDF over 300 pages", async () => {
      const s = await store("Knowledge Limits");
      jobs.sends = [];
      const headings = await call("POST", base(s), markdown("Headings", "# Returns\n\n## Exchanges"));
      expect(headings.status).toBe(400);
      expect(await headings.json()).toMatchObject({ error: { code: "empty" } });
      const faq = Array.from({ length: 1001 }, (_, i) => `## Q${i}\nA${i}.`).join("\n");
      const many = await call("POST", base(s), markdown("Huge FAQ", faq));
      expect(many.status).toBe(400);
      expect(await many.json()).toMatchObject({ error: { code: "too_large" } });
      const pages = new Array<string>(301).fill(textPage(["Exchanges within 7 days"]));
      const long = await call("POST", base(s), {
        title: "Long PDF",
        source: { type: "pdf", base64: makePdf({ pages }).toString("base64") },
      });
      expect(long.status).toBe(400);
      expect(await long.json()).toMatchObject({ error: { code: "pdf_too_long" } });
      expect(jobs.sends).toEqual([]);
      const { items } = (await (await call("GET", base(s))).json()) as { items: unknown[] };
      expect(items).toEqual([]);
    });

    it("limits the upload body to 15 MB", async () => {
      const s = await store("Knowledge Limit");
      const res = await app.request(base(s), {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(markdown("Huge", "a".repeat(16 * 1024 * 1024))),
      });
      expect(res.status).toBe(413);
    });

    it("keeps tenants and stores apart: 404 for another tenant's document", async () => {
      const a = await store("Knowledge Owner");
      const b = await store("Knowledge Intruder");
      const { id } = await json(await call("POST", base(a), markdown("Private", "# Private\n\nOwner only.")));
      const crossed = [
        `${base({ tenantId: b.tenantId, storeId: a.storeId })}/${id}`,
        `${base(b)}/${id}`,
        `${base({ tenantId: a.tenantId, storeId: b.storeId })}/${id}`,
      ];
      for (const path of crossed) {
        expect((await call("GET", path)).status, path).toBe(404);
        expect((await call("DELETE", path)).status, path).toBe(404);
      }
      expect(
        (await call("POST", base({ tenantId: b.tenantId, storeId: a.storeId }), markdown("X", "y"))).status,
      ).toBe(404);
      expect((await call("GET", base({ tenantId: b.tenantId, storeId: a.storeId }))).status).toBe(404);
      expect((await call("GET", `${base(a)}/not-a-uuid`)).status).toBe(404);
      expect((await call("GET", `${base(a)}/${id}`)).status).toBe(200);
    });

    it("deletes a document with its chunks", async () => {
      const s = await store("Knowledge Delete");
      const { id = "" } = await json(await call("POST", base(s), markdown("Care", POLICY)));
      expect(await ingestDocument({ db: pool.db, ...s, embedder: createDemoEmbedder() }, id)).toBe("ready");
      expect(await chunkCount(s.tenantId, id)).toBeGreaterThan(0);
      expect((await call("DELETE", `${base(s)}/${id}`)).status).toBe(204);
      expect(await chunkCount(s.tenantId, id)).toBe(0);
      expect((await call("GET", `${base(s)}/${id}`)).status).toBe(404);
      expect((await call("DELETE", `${base(s)}/${id}`)).status).toBe(404);
    });
  });
});
