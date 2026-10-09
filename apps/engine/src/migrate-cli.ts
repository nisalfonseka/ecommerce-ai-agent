import { MIGRATIONS_FOLDER, runMigrations } from "@ace/db";

// One-shot: `node dist/migrate.js`. Runs as the database owner; sets the ace_app login password.
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appPassword = process.env.ACE_APP_DB_PASSWORD;
if (!ownerUrl || !appPassword) {
  console.error("MIGRATION_DATABASE_URL and ACE_APP_DB_PASSWORD are required");
  process.exit(1);
}
await runMigrations(ownerUrl, appPassword, process.env.ACE_MIGRATIONS_DIR ?? MIGRATIONS_FOLDER);
console.log("migrations applied");
