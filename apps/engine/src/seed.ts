import { createHash } from "node:crypto";
import {
  createBot,
  createDocument,
  createStore,
  createTenant,
  type Db,
  issueWidgetKey,
  schema,
  upsertTenantSettings,
  withTenant,
} from "@ace/db";
import { createDemoEmbedder, ingestDocument } from "@ace/knowledge";
import { and, eq, isNull } from "drizzle-orm";
import { issueStaffToken } from "./auth/staff";

const DEMO_TENANTS = ["Demo Clothing A", "Demo Clothing B"] as const;
const DEMO_SEARCH = {
  mode: "index",
  embeddingModel: "demo:hash-v1",
  enrichmentModel: "demo:rules-v1",
  knowledgeThreshold: 0.15,
} as const;
const DEMO_KNOWLEDGE = [
  {
    title: "Returns policy",
    content: "# Exchanges\n\nItems can be exchanged within 7 days with the original receipt.",
  },
  {
    title: "Store guide",
    content: [
      "# Delivery",
      "",
      "Island-wide delivery takes 2-4 working days and costs LKR 400.",
      "",
      "# Linen care",
      "",
      "Hand wash linen in cold water and air dry in the shade.",
    ].join("\n"),
  },
] as const;

/** Deterministic UUID (version 4 layout) per seed name, so re-runs find the same tenant despite RLS. */
export function seedTenantId(name: string): string {
  const hex = createHash("sha256").update(`ace-seed:${name}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface SeededTenant {
  name: string;
  tenantId: string;
  botId: string;
  storeId: string;
  /** A fresh publishable widget key; earlier keys stay valid. */
  key: string;
  /** Fresh local staff token, shown by the seed command once; only its hash is stored. */
  staffToken: string;
}

/** Two demo tenants on the in-memory store (exit criterion: two isolated tenants). Safe to re-run. */
export async function seedDemoTenants(
  db: Db,
  options: { model: string; origins: string[] },
): Promise<SeededTenant[]> {
  const seeded: SeededTenant[] = [];
  for (const name of DEMO_TENANTS) {
    const tenantId = seedTenantId(name);
    const exists = await withTenant(
      db,
      tenantId,
      async (tx) => (await tx.select().from(schema.tenants)).length > 0,
    );
    if (!exists) await createTenant(db, { name, id: tenantId });
    const result = await withTenant(db, tenantId, async (tx) => {
      let [bot] = await tx
        .select({ id: schema.bots.id, storeId: schema.bots.storeId })
        .from(schema.bots)
        .limit(1);
      if (!bot) {
        const store = await createStore(tx, tenantId, {
          platform: "memory",
          currency: "LKR",
          config: { search: DEMO_SEARCH },
        });
        bot = await createBot(tx, tenantId, {
          storeId: store.id,
          persona: {
            assistantName: "Nila",
            storeName: name,
            tone: "warm, concise, helpful",
            languages: ["English", "Sinhala", "Tamil", "Singlish"],
          },
          storeFacts: { currency: "LKR", deliveryInfo: "Island-wide delivery in 2–4 working days." },
          model: options.model,
          cheapModel: options.model,
          budgetSoftUsdMicros: 5_000_000,
          budgetHardUsdMicros: 10_000_000,
        });
      }
      await upsertTenantSettings(tx, tenantId, {
        retention: { messagesDays: 180, tracesDays: 30, handoffDays: 180, otpHours: 24 },
        handoffEmails: ["support@example.test"],
        requireConsent: true,
        contactInfo: "A local support team member can reply in this chat.",
      });
      await tx
        .update(schema.stores)
        .set({ config: { search: DEMO_SEARCH } })
        .where(eq(schema.stores.id, bot.storeId));
      const documentIds: string[] = [];
      for (const document of DEMO_KNOWLEDGE) {
        const contentHash = createHash("sha256").update(document.content).digest("hex");
        const [existing] = await tx
          .select({
            id: schema.knowledgeDocuments.id,
            status: schema.knowledgeDocuments.status,
            contentHash: schema.knowledgeDocuments.contentHash,
          })
          .from(schema.knowledgeDocuments)
          .where(
            and(
              eq(schema.knowledgeDocuments.storeId, bot.storeId),
              eq(schema.knowledgeDocuments.title, document.title),
            ),
          )
          .limit(1);
        if (existing?.status === "ready" && existing.contentHash === contentHash) continue;
        const stored =
          existing && existing.contentHash === contentHash
            ? existing
            : await createDocument(tx, tenantId, {
                storeId: bot.storeId,
                title: document.title,
                sourceType: "markdown",
                sourceUrl: null,
                content: document.content,
                contentHash,
              });
        documentIds.push(stored.id);
      }
      const issued = await issueWidgetKey(tx, tenantId, { botId: bot.id, allowedOrigins: options.origins });
      await tx
        .update(schema.staffTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.staffTokens.name, "Local Support"), isNull(schema.staffTokens.revokedAt)));
      const staff = await issueStaffToken(tx, tenantId, "Local Support");
      return { botId: bot.id, storeId: bot.storeId, key: issued.key, staffToken: staff.token, documentIds };
    });
    for (const documentId of result.documentIds) {
      const outcome = await ingestDocument(
        { db, tenantId, storeId: result.storeId, embedder: createDemoEmbedder() },
        documentId,
      );
      if (outcome !== "ready") throw new Error(`could not seed knowledge document: ${outcome}`);
    }
    const { documentIds: _documentIds, ...publicResult } = result;
    seeded.push({ name, tenantId, ...publicResult });
  }
  return seeded;
}
