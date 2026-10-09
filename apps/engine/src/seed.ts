import { createHash } from "node:crypto";
import { createBot, createStore, createTenant, type Db, issueWidgetKey, schema, withTenant } from "@ace/db";

const DEMO_TENANTS = ["Demo Clothing A", "Demo Clothing B"] as const;

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
  /** A fresh publishable widget key; earlier keys stay valid. */
  key: string;
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
      let [bot] = await tx.select({ id: schema.bots.id }).from(schema.bots).limit(1);
      if (!bot) {
        const store = await createStore(tx, tenantId, { platform: "memory", currency: "LKR" });
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
      const issued = await issueWidgetKey(tx, tenantId, { botId: bot.id, allowedOrigins: options.origins });
      return { botId: bot.id, key: issued.key };
    });
    seeded.push({ name, tenantId, ...result });
  }
  return seeded;
}
