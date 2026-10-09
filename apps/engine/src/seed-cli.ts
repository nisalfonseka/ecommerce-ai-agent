import { createDb } from "@ace/db";
import { seedDemoTenants } from "./seed";

// `pnpm seed`: needs DATABASE_URL (ace_app). Prints widget keys; treat them like any publishable key.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const { db, close } = createDb(url);
try {
  const tenants = await seedDemoTenants(db, {
    model: process.env.ACE_SEED_MODEL ?? "demo:search-only",
    origins: (process.env.ACE_SEED_ORIGINS ?? "http://localhost:5173").split(",").map((o) => o.trim()),
  });
  console.table(tenants.map(({ name, tenantId, key }) => ({ name, tenantId, widgetKey: key })));
} finally {
  await close();
}
