import { randomUUID } from "node:crypto";
import pg from "pg";
import { installJobSchema } from "./jobs";
import { runMigrations } from "./migrate";

/** Fixed so parallel test files agree; ace_app is cluster-wide. Test clusters only. */
const TEST_APP_PASSWORD = "ace_app_test_password";
const DROP_WAIT_MS = 5_000;
const DROP_POLL_MS = 25;

async function waitForSessionsToClose(client: pg.Client, database: string): Promise<void> {
  const deadline = Date.now() + DROP_WAIT_MS;
  while (true) {
    const result = await client.query<{ count: number }>(
      "select count(*)::int as count from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [database],
    );
    const count = result.rows[0]?.count ?? 0;
    if (count === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Test database ${database} still has ${count} open session(s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, DROP_POLL_MS));
  }
}

export interface TestDatabase {
  /** Superuser/owner URL for this database (bypasses RLS: use only for setup). */
  ownerUrl: string;
  /** ace_app URL: what the engine uses, subject to RLS. */
  appUrl: string;
  drop(): Promise<void>;
}

/**
 * Creates a fresh, migrated database on the cluster named by ACE_TEST_DATABASE_URL.
 * Returns null when it is unset, unless ACE_REQUIRE_DB_TESTS=1 (CI), which makes a missing database an error.
 */
export async function createTestDatabase(): Promise<TestDatabase | null> {
  const base = process.env.ACE_TEST_DATABASE_URL;
  if (!base) {
    if (process.env.ACE_REQUIRE_DB_TESTS === "1") {
      throw new Error("ACE_TEST_DATABASE_URL is required (ACE_REQUIRE_DB_TESTS=1)");
    }
    return null;
  }
  const name = `ace_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const owner = new URL(base);
  owner.pathname = `/${name}`;
  // Test files run in parallel, and ace_app is cluster-wide: concurrent ALTER ROLE fails with "tuple
  // concurrently updated". An advisory lock on the shared base database serialises the setup.
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query("select pg_advisory_lock(7731001)");
    await admin.query(`CREATE DATABASE ${name}`);
    await runMigrations(owner.toString(), TEST_APP_PASSWORD);
    await installJobSchema(owner.toString());
  } finally {
    await admin.query("select pg_advisory_unlock(7731001)").catch(() => undefined);
    await admin.end();
  }
  const app = new URL(owner);
  app.username = "ace_app";
  app.password = TEST_APP_PASSWORD;

  return {
    ownerUrl: owner.toString(),
    appUrl: app.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: base });
      await client.connect();
      try {
        // pool.end() can resolve just before PostgreSQL removes its backend session. Waiting avoids
        // force-killing that closing client, which would emit an uncaught 57P01 in the test worker.
        await waitForSessionsToClose(client, name);
        await client.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await client.end();
      }
    },
  };
}
