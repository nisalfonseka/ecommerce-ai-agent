// Registers the local reference store (Medusa) with the local engine through the admin API: tenant, medusa store
// (sealed credentials), a bot on the keyless demo model with cash on delivery on, and a widget key for the
// storefront's origin. Prints {"widgetKey": "..."}.
// Usage: node scripts/connect-reference-store.mjs <seed-output.json> <engine-url> <admin-key> <storefront-origin>
import { readFileSync } from "node:fs";

const [seedPath, engine, adminKey, origin] = process.argv.slice(2);
if (!seedPath || !engine || !adminKey || !origin) {
  console.error(
    "usage: connect-reference-store.mjs <seed-output.json> <engine-url> <admin-key> <storefront-origin>",
  );
  process.exit(2);
}
const seed = JSON.parse(readFileSync(seedPath, "utf8"));

async function admin(path, body) {
  const response = await fetch(`${engine}/admin${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`POST ${path} → ${response.status} ${JSON.stringify(json)}`);
  return json;
}

const { tenantId } = await admin("/tenants", { name: "Reference Store" });
const { storeId } = await admin(`/tenants/${tenantId}/stores`, {
  platform: "medusa",
  currency: "LKR",
  credentials: JSON.stringify({
    baseUrl: seed.backendUrl,
    publishableKey: seed.publishableKey,
    secretKey: seed.secretKey,
    regionId: seed.regionId,
    storefrontUrl: origin,
  }),
});
const { botId } = await admin(`/tenants/${tenantId}/bots`, {
  storeId,
  persona: {
    assistantName: "Nila",
    storeName: "Reference Store",
    languages: ["English", "Sinhala", "Tamil"],
  },
  storeFacts: { currency: "LKR", deliveryInfo: "Island-wide delivery, LKR 400.", cod: { enabled: true } },
  model: "demo:search-only",
  cheapModel: "demo:search-only",
  budgetSoftUsdMicros: 1_000_000,
  budgetHardUsdMicros: 2_000_000,
});
const { key } = await admin(`/tenants/${tenantId}/bots/${botId}/widget-keys`, { allowedOrigins: [origin] });
console.log(JSON.stringify({ widgetKey: key, tenantId }));
