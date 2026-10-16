import pg from "pg";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "./testing";

const testDb = await createTestDatabase();

describe.skipIf(testDb === null)("test database teardown", () => {
  it("waits for a closing session instead of force-terminating it", async () => {
    if (!testDb) return;
    const client = new pg.Client({ connectionString: testDb.appUrl });
    const errors: Error[] = [];
    client.on("error", (error) => errors.push(error));
    await client.connect();

    const closing = new Promise<void>((resolve, reject) => {
      setTimeout(() => client.end().then(resolve, reject), 1_000);
    });
    await testDb.drop();
    await closing;

    expect(errors).toEqual([]);
  });
});
