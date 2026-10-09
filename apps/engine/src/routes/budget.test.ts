import { say, scriptedModel } from "@ace/agent/testing";
import { schema, withTenant } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineHarness } from "../testing/harness";

const testDb = await createTestDatabase();

const mustNotBeCalled = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({
        message: "should not be called",
        url: "u",
        requestBodyValues: {},
        statusCode: 500,
      });
    },
  });

describe.skipIf(testDb === null)("budgets and cost", () => {
  let h: Awaited<ReturnType<typeof createEngineHarness>>;
  beforeAll(async () => {
    if (testDb) h = await createEngineHarness(testDb);
  });
  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  const spend = (micros: number) =>
    withTenant(h.pool.db, h.tenantId, (tx) =>
      tx.insert(schema.usageLedger).values({
        tenantId: h.tenantId,
        botId: h.botId,
        turnId: `spend-${micros}-${Date.now()}`,
        model: "test:primary",
        inputTokens: 0,
        outputTokens: 0,
        costUsdMicros: micros,
      }),
    );
  const replyOf = (events: { event: string; data: Record<string, unknown> }[]) =>
    events.find((e) => e.event === "reply")?.data;

  it("records each turn's cost from the price table", async () => {
    h.models["test:primary"] = scriptedModel([say("Hello!")]);
    await h.chat({ message: "hi" });
    const rows = await withTenant(h.pool.db, h.tenantId, (tx) =>
      tx.execute<{ cost: number }>(sql`select cost_usd_micros as cost from turn_traces`),
    );
    // Scripted usage: 10 input tokens at $0.30/M + 5 output at $2.50/M = 15.5 micros, rounded up.
    expect(rows.rows.map((row) => row.cost)).toEqual([16]);
  });

  it("switches to the cheap model past the soft cap", async () => {
    await spend(1_000_000);
    h.models["test:primary"] = mustNotBeCalled();
    h.models["test:cheap"] = scriptedModel([say("Cheap answer.")]);
    expect(replyOf(await h.chat({ message: "hi" }))).toMatchObject({ text: "Cheap answer." });
  });

  it("answers with a contact-only reply past the hard cap, without calling any model", async () => {
    await spend(1_000_000);
    h.models["test:primary"] = mustNotBeCalled();
    h.models["test:cheap"] = mustNotBeCalled();
    const events = await h.chat({ message: "hi" });
    expect(events.map((e) => e.event)).toEqual(["conversation", "reply", "done"]);
    expect(replyOf(events)).toMatchObject({ text: expect.stringMatching(/contact/i), ui: [] });
  });
});
