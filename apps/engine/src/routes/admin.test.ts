import { createHash, randomBytes } from "node:crypto";
import { createDb } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadModelPrices } from "../budget";
import { createLogger } from "../log";
import { registerAdminRoutes } from "./admin";

const testDb = await createTestDatabase();
const ADMIN_KEY = "admin-test-key-0123456789";

describe.skipIf(testDb === null)("admin API", () => {
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
});
