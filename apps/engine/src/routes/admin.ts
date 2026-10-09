import { createHash, timingSafeEqual } from "node:crypto";
import {
  createBot,
  createStore,
  createTenant,
  type Db,
  issueWidgetKey,
  revokeWidgetKey,
  schema,
  sealSecret,
  usageReport,
  withTenant,
} from "@ace/db";
import { eq } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { WidgetEnv } from "../auth/widget";
import { PersonaSchema, StoreFactsSchema } from "../bot-config";
import type { ModelPrices } from "../budget";
import { errorResponse } from "../http-errors";

export interface AdminDeps {
  db: Db;
  adminApiKeySha256: string;
  masterKey: Buffer;
  prices: ModelPrices;
}

const UUID = z.uuid();
/** Platforms with an adapter (Phase 3: only the in-memory demo store). */
const PLATFORMS = ["memory"] as const;

const StoreBody = z.object({
  platform: z.enum(PLATFORMS),
  currency: z.string().regex(/^[A-Z]{3}$/),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Store API credentials; sealed before storage, never returned. */
  credentials: z.string().min(1).max(4096).optional(),
});

function botBody(prices: ModelPrices) {
  const known = z.string().refine((spec) => prices.has(spec), "model is not in model-prices.json");
  return z
    .object({
      storeId: z.uuid(),
      persona: PersonaSchema,
      storeFacts: StoreFactsSchema,
      model: known,
      cheapModel: known,
      fallbackModel: known.nullable().optional(),
      budgetSoftUsdMicros: z.number().int().positive(),
      budgetHardUsdMicros: z.number().int().positive(),
      maxSteps: z.number().int().min(1).max(12).optional(),
    })
    .refine(
      (bot) => bot.budgetSoftUsdMicros <= bot.budgetHardUsdMicros,
      "soft budget must not exceed hard budget",
    );
}

const WidgetKeyBody = z.object({
  allowedOrigins: z
    .array(z.string().refine(isBareOrigin, "must be a bare origin such as https://shop.example.lk"))
    .min(1)
    .max(20),
});

/** "https://shop.example.lk" yes; paths, queries, non-http schemes or unparseable strings no. Never throws. */
function isBareOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function adminAuth(expectedSha256: string): MiddlewareHandler {
  const expected = Buffer.from(expectedSha256, "hex");
  return async (c, next) => {
    const key = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const given = createHash("sha256").update(key).digest();
    if (!key || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return errorResponse(c, 401, "unauthorized", "Admin key required.");
    }
    await next();
  };
}

/**
 * Internal admin API (Phase 3; the dashboard comes in Phase 7). Every tenant-scoped route runs inside
 * withTenant, and foreign references (store, bot) are looked up under that tenant first, because Postgres
 * foreign-key checks do not apply RLS.
 */
export function registerAdminRoutes(app: Hono<WidgetEnv>, deps: AdminDeps): void {
  const admin = app.basePath("/admin");
  admin.use("*", adminAuth(deps.adminApiKeySha256));
  const BotBody = botBody(deps.prices);

  const tenantParam = (value: string | undefined): string | null =>
    UUID.safeParse(value).success ? (value ?? null) : null;

  admin.post("/tenants", async (c) => {
    const body = z
      .object({ name: z.string().min(1).max(120) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return errorResponse(c, 400, "invalid_input", "A tenant needs a name.");
    const { tenantId } = await createTenant(deps.db, { name: body.data.name });
    return c.json({ tenantId }, 201);
  });

  admin.post("/tenants/:tenantId/stores", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const body = StoreBody.safeParse(await c.req.json().catch(() => null));
    if (!tenantId) return errorResponse(c, 404, "not_found", "Unknown tenant.");
    if (!body.success) return errorResponse(c, 400, "invalid_input", "Invalid store.");
    const { credentials, ...store } = body.data;
    const created = await withTenant(deps.db, tenantId, (tx) =>
      createStore(tx, tenantId, {
        ...store,
        credentialsSealed: credentials ? sealSecret(credentials, deps.masterKey) : null,
      }),
    );
    return c.json({ storeId: created.id }, 201);
  });

  admin.post("/tenants/:tenantId/bots", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const body = BotBody.safeParse(await c.req.json().catch(() => null));
    if (!tenantId) return errorResponse(c, 404, "not_found", "Unknown tenant.");
    if (!body.success)
      return errorResponse(c, 400, "invalid_input", body.error.issues[0]?.message ?? "Invalid bot.");
    const botId = await withTenant(deps.db, tenantId, async (tx) => {
      const [store] = await tx
        .select({ id: schema.stores.id })
        .from(schema.stores)
        .where(eq(schema.stores.id, body.data.storeId));
      if (!store) return null;
      return (await createBot(tx, tenantId, body.data)).id;
    });
    if (!botId) return errorResponse(c, 404, "not_found", "Unknown store.");
    return c.json({ botId }, 201);
  });

  admin.post("/tenants/:tenantId/bots/:botId/widget-keys", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const botId = c.req.param("botId");
    const body = WidgetKeyBody.safeParse(await c.req.json().catch(() => null));
    if (!tenantId || !UUID.safeParse(botId).success)
      return errorResponse(c, 404, "not_found", "Unknown bot.");
    if (!body.success) return errorResponse(c, 400, "invalid_input", "allowedOrigins must be site origins.");
    const issued = await withTenant(deps.db, tenantId, async (tx) => {
      const [bot] = await tx
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(eq(schema.bots.id, botId));
      return bot ? issueWidgetKey(tx, tenantId, { botId, allowedOrigins: body.data.allowedOrigins }) : null;
    });
    if (!issued) return errorResponse(c, 404, "not_found", "Unknown bot.");
    return c.json(issued, 201);
  });

  admin.delete("/tenants/:tenantId/widget-keys/:keyId", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const keyId = c.req.param("keyId");
    if (!tenantId || !UUID.safeParse(keyId).success)
      return errorResponse(c, 404, "not_found", "Unknown key.");
    const revoked = await withTenant(deps.db, tenantId, (tx) => revokeWidgetKey(tx, keyId));
    return revoked
      ? c.body(null, 204)
      : errorResponse(c, 404, "not_found", "Unknown or already revoked key.");
  });

  admin.get("/tenants/:tenantId/usage", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    if (!tenantId) return errorResponse(c, 404, "not_found", "Unknown tenant.");
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      return errorResponse(c, 400, "invalid_input", "month must be YYYY-MM.");
    const report = await withTenant(deps.db, tenantId, (tx) =>
      usageReport(tx, new Date(`${month}-15T00:00:00Z`)),
    );
    return c.json({ month, ...report });
  });
}
