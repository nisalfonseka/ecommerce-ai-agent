import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies migrations as the database owner, then enables login for the app role with `appPassword`.
 * The password is restricted to a safe alphabet because ALTER ROLE cannot take a bind parameter.
 */
export async function runMigrations(
  ownerUrl: string,
  appPassword: string,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(appPassword)) {
    throw new Error("runMigrations: app password must be 16-128 characters of A-Z a-z 0-9 _ -");
  }
  const { db, close } = createDb(ownerUrl, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
    await db.execute(sql.raw(`ALTER ROLE ace_app LOGIN PASSWORD '${appPassword}'`));
  } finally {
    await close();
  }
}
