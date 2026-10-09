import { createHash, randomBytes } from "node:crypto";
import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { createDb } from "@ace/db";
import type { JobName, JobPayload, JobQueue } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { createDemoEnricher, enrichStoredProduct, syncProduct } from "@ace/search";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadModelPrices } from "../budget";
import { createLogger } from "../log";
import { registerAdminRoutes } from "./admin";

const testDb = await createTestDatabase();
const ADMIN_KEY = "admin-test-key-0123456789";

class RecordingQueue implements JobQueue {
  sent: JobName[] = [];
  async send<N extends JobName>(name: N, _data: JobPayload<N>): Promise<void> {
    this.sent.push(name);
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
      masterKey: randomBytes(32),
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

    it("pages with a cursor", async () => {
      const { tenantId, storeId } = await seededStore("Review Page");
      const first = (await (
        await call("GET", `/admin/tenants/${tenantId}/stores/${storeId}/enrichment?limit=1`)
      ).json()) as { nextCursor: string | null };
      expect(first.nextCursor).toBeNull(); // one product only
      expect(
        (await call("GET", `/admin/tenants/${tenantId}/stores/${storeId}/enrichment?limit=0`)).status,
      ).toBe(400);
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
});
