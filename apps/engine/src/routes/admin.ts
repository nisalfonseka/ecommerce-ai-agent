import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  attributionReport,
  type CatalogProductRow,
  countCatalog,
  createBot,
  createStore,
  createTenant,
  type Db,
  enrichmentReport,
  getSyncState,
  issueWidgetKey,
  revokeWidgetKey,
  schema,
  sealSecret,
  setStoreWebhookSecret,
  usageReport,
  withTenant,
} from "@ace/db";
import { JOBS, type JobQueue, reconcileDebounceKey } from "@ace/db/jobs";
import { MedusaCredentialsSchema } from "@ace/providers";
import {
  applyMerchantOverrides,
  MerchantOverridesSchema,
  parseStoreSearchConfig,
  StoreSearchConfigSchema,
} from "@ace/search";
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
  jobs: JobQueue;
}

const UUID = z.uuid();
/** Platforms with an adapter. */
const PLATFORMS = ["memory", "medusa"] as const;

const StoreBody = z.object({
  platform: z.enum(PLATFORMS),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Stored as given; `search` must satisfy StoreSearchConfigSchema (defaults are applied when read). */
  config: z
    .record(z.string(), z.unknown())
    .refine((config) => StoreSearchConfigSchema.safeParse(config.search).success, {
      message: "config.search is invalid",
      path: ["search"],
    })
    .optional(),
  /** Store API credentials; sealed before storage, never returned. */
  credentials: z.string().min(1).max(4096).optional(),
});

function validMedusaCredentials(credentials: string | undefined): boolean {
  if (!credentials) return false;
  try {
    return MedusaCredentialsSchema.safeParse(JSON.parse(credentials)).success;
  } catch {
    return false;
  }
}

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

const SyncBody = z.object({ full: z.boolean().default(false) });

/** An ISO date ("2026-10-01", midnight UTC) or date-time with offset. */
const IsoInstant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]).transform((v) => new Date(v));

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
    if (store.platform === "medusa" && !validMedusaCredentials(credentials)) {
      // The message names the fields, never their values.
      return errorResponse(
        c,
        400,
        "invalid_input",
        "Medusa stores need JSON credentials: baseUrl, publishableKey, secretKey, regionId, storefrontUrl.",
      );
    }
    const created = await withTenant(deps.db, tenantId, (tx) =>
      createStore(tx, tenantId, {
        ...store,
        credentialsSealed: credentials ? sealSecret(credentials, deps.masterKey) : null,
      }),
    );
    return c.json({ storeId: created.id }, 201);
  });

  // Rotation: the previous secret stops working at once. The secret is shown only in this response.
  admin.post("/tenants/:tenantId/stores/:storeId/webhook-secret", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const storeId = c.req.param("storeId");
    if (!tenantId || !UUID.safeParse(storeId).success)
      return errorResponse(c, 404, "not_found", "Unknown store.");
    const secret = randomBytes(32).toString("base64url");
    const sealed = sealSecret(secret, deps.masterKey);
    const stored = await withTenant(deps.db, tenantId, (tx) => setStoreWebhookSecret(tx, storeId, sealed));
    if (!stored) return errorResponse(c, 404, "not_found", "Unknown store.");
    return c.json({ secret, path: `/webhooks/${storeId}` }, 201);
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
  const storeExists = (tenantId: string, storeId: string) =>
    withTenant(deps.db, tenantId, async (tx) => {
      const [store] = await tx
        .select({ id: schema.stores.id })
        .from(schema.stores)
        .where(eq(schema.stores.id, storeId));
      return store !== undefined;
    });

  const reviewItem = (row: CatalogProductRow) => ({
    productId: row.productId,
    title: row.title,
    enriched: row.enriched,
    overrides: row.overrides,
    attributes: row.attributes,
    hidden: row.hidden,
    boost: row.boost,
    enrichmentModel: row.enrichmentModel,
  });

  // Onboarding review (workflow A5): what the enricher decided and what the merchant changed.
  admin.get("/tenants/:tenantId/stores/:storeId/enrichment", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const storeId = c.req.param("storeId");
    if (!tenantId || !UUID.safeParse(storeId).success)
      return errorResponse(c, 404, "not_found", "Unknown store.");
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().min(1).max(200).optional(),
      })
      .safeParse({ limit: c.req.query("limit"), cursor: c.req.query("cursor") });
    if (!query.success) return errorResponse(c, 400, "invalid_input", "limit must be 1-200.");
    if (!(await storeExists(tenantId, storeId))) return errorResponse(c, 404, "not_found", "Unknown store.");
    const page = await withTenant(deps.db, tenantId, (tx) => enrichmentReport(tx, storeId, query.data));
    return c.json({ items: page.items.map(reviewItem), nextCursor: page.nextCursor });
  });

  admin.put("/tenants/:tenantId/stores/:storeId/products/:productId/overrides", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const storeId = c.req.param("storeId");
    const productId = c.req.param("productId");
    if (!tenantId || !UUID.safeParse(storeId).success)
      return errorResponse(c, 404, "not_found", "Unknown product.");
    const body = MerchantOverridesSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return errorResponse(c, 400, "invalid_input", "Invalid overrides.");
    // applyMerchantOverrides is RLS-scoped and store-scoped; the explicit check keeps the 404 uniform.
    if (!(await storeExists(tenantId, storeId)))
      return errorResponse(c, 404, "not_found", "Unknown product.");
    const row = await applyMerchantOverrides({ ...deps, tenantId, storeId }, productId, body.data);
    if (!row) return errorResponse(c, 404, "not_found", "Unknown product.");
    return c.json(reviewItem(row));
  });
  const storeSearchConfigOf = (tenantId: string, storeId: string) =>
    withTenant(deps.db, tenantId, async (tx) => {
      const [store] = await tx
        .select({ config: schema.stores.config })
        .from(schema.stores)
        .where(eq(schema.stores.id, storeId));
      return store ? parseStoreSearchConfig(store.config) : null;
    });

  // Manual (re)sync, e.g. onboarding step A4. The worker runs it; collapses with the scheduled run.
  admin.post("/tenants/:tenantId/stores/:storeId/sync", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const storeId = c.req.param("storeId");
    if (!tenantId || !UUID.safeParse(storeId).success)
      return errorResponse(c, 404, "not_found", "Unknown store.");
    const raw = await c.req.text();
    let body: unknown = {};
    try {
      body = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return errorResponse(c, 400, "invalid_input", "Body must be JSON.");
    }
    const parsed = SyncBody.safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_input", "full must be a boolean.");
    if (!(await storeExists(tenantId, storeId))) return errorResponse(c, 404, "not_found", "Unknown store.");
    const { full } = parsed.data;
    await deps.jobs.send(
      JOBS.syncReconcile,
      { tenantId, storeId, full },
      { debounceKey: reconcileDebounceKey(storeId, full) },
    );
    return c.json({ queued: true, full }, 202);
  });

  admin.get("/tenants/:tenantId/stores/:storeId/sync", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    const storeId = c.req.param("storeId");
    if (!tenantId || !UUID.safeParse(storeId).success)
      return errorResponse(c, 404, "not_found", "Unknown store.");
    const search = await storeSearchConfigOf(tenantId, storeId);
    if (!search) return errorResponse(c, 404, "not_found", "Unknown store.");
    const report = await withTenant(deps.db, tenantId, async (tx) => {
      const state = await getSyncState(tx, storeId);
      return {
        state: {
          status: state?.status ?? "never",
          lastFullSyncAt: state?.lastFullSyncAt ?? null,
          lastIncrementalSyncAt: state?.lastIncrementalSyncAt ?? null,
          lastError: state?.lastError ?? null,
        },
        // Stale embeddings are counted against the store's configured model (J9).
        counts: await countCatalog(tx, storeId, search.embeddingModel),
      };
    });
    return c.json(report);
  });

  // Chat-assisted orders and revenue per currency (workflow F). Default range: month to date (UTC).
  admin.get("/tenants/:tenantId/attribution", async (c) => {
    const tenantId = tenantParam(c.req.param("tenantId"));
    if (!tenantId) return errorResponse(c, 404, "not_found", "Unknown tenant.");
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const query = z
      .object({ from: IsoInstant.optional(), to: IsoInstant.optional() })
      .transform((q) => ({ from: q.from ?? monthStart, to: q.to ?? now }))
      .refine((range) => range.from < range.to, "from must be before to")
      .safeParse({ from: c.req.query("from"), to: c.req.query("to") });
    if (!query.success)
      return errorResponse(c, 400, "invalid_input", "from and to must be ISO dates, from before to.");
    const range = query.data;
    const report = await withTenant(deps.db, tenantId, (tx) => attributionReport(tx, range));
    return c.json({ from: range.from.toISOString(), to: range.to.toISOString(), ...report });
  });
}
