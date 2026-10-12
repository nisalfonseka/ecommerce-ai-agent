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
  config: {
    search: {
      mode: "index",
      embeddingModel: "demo:hash-v1",
      enrichmentModel: "demo:rules-v1",
      knowledgeThreshold: 0.15,
    },
  },
  credentials: JSON.stringify({
    baseUrl: seed.backendUrl,
    publishableKey: seed.publishableKey,
    secretKey: seed.secretKey,
    regionId: seed.regionId,
    storefrontUrl: origin,
  }),
});
const webhook = await admin(`/tenants/${tenantId}/stores/${storeId}/webhook-secret`, {});
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
for (const document of [
  {
    title: "Returns policy",
    source: {
      type: "markdown",
      text: "# Exchanges\n\nItems can be exchanged within 7 days with the original receipt.",
    },
  },
  {
    title: "Store guide",
    source: {
      type: "markdown",
      text: "# Delivery\n\nIsland-wide delivery takes 2-4 working days and costs LKR 400.\n\n# Linen care\n\nHand wash linen in cold water and air dry in the shade.",
    },
  },
]) {
  await admin(`/tenants/${tenantId}/stores/${storeId}/knowledge`, document);
}
await admin(`/tenants/${tenantId}/stores/${storeId}/sync`, { full: true });
console.log(
  JSON.stringify({
    widgetKey: key,
    tenantId,
    storeId,
    webhookUrl: `${engine}${webhook.path}`,
    webhookSecret: webhook.secret,
  }),
);
