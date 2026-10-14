import {
  createBot,
  createConversation,
  createDb,
  createStore,
  createTenant,
  revokeStaffToken,
  withTenant,
} from "@ace/db";
import type { JobQueue } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { issueStaffToken } from "../auth/staff";
import { openHandoff } from "../handoff/service";
import { createLogger } from "../log";
import { registerStaffRoutes } from "./staff";

const testDb = await createTestDatabase();
const noJobs = { send: async () => undefined } as JobQueue;

describe.skipIf(testDb === null)("staff API", () => {
  const pool = testDb ? createDb(testDb.appUrl) : null;
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    ping: async () => true,
    resolveWidgetKey: async () => null,
  });
  if (pool) registerStaffRoutes(app, { db: pool.db, jobs: noJobs });

  afterAll(async () => {
    await pool?.close();
    await testDb?.drop();
  });

  async function setup(name: string) {
    if (!pool) throw new Error("test database unavailable");
    const { tenantId } = await createTenant(pool.db, { name });
    const created = await withTenant(pool.db, tenantId, async (tx) => {
      const store = await createStore(tx, tenantId, { platform: "memory", currency: "LKR" });
      const bot = await createBot(tx, tenantId, {
        storeId: store.id,
        persona: { assistantName: "Nila", storeName: name, languages: ["English"] },
        storeFacts: { currency: "LKR" },
        model: "demo:test",
        cheapModel: "demo:test",
        budgetSoftUsdMicros: 1,
        budgetHardUsdMicros: 2,
      });
      const conversation = await createConversation(tx, tenantId, {
        botId: bot.id,
        visitorId: "visitor_staff",
        session: {},
      });
      const first = await issueStaffToken(tx, tenantId, "Nimali");
      const second = await issueStaffToken(tx, tenantId, "Kasun");
      return { conversationId: conversation.id, first, second };
    });
    const handoff = await openHandoff(
      { db: pool.db, jobs: noJobs },
      { tenantId, conversationId: created.conversationId },
      { reason: "complaint", summary: "The package arrived damaged." },
    );
    return { tenantId, handoffId: handoff.id, ...created };
  }

  const call = (token: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("lists, reads, claims, replies, hands back and resolves without exposing tool payloads", async () => {
    const ids = await setup("Staff flow");
    const list = await call(ids.first.token, "GET", "/staff/v1/handoffs?status=open");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([
      expect.objectContaining({ id: ids.handoffId, reason: "complaint", status: "open" }),
    ]);

    const detail = await call(ids.first.token, "GET", `/staff/v1/handoffs/${ids.handoffId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: ids.handoffId, messages: [] });

    expect((await call(ids.first.token, "POST", `/staff/v1/handoffs/${ids.handoffId}/claim`)).status).toBe(
      200,
    );
    const wrong = await call(ids.second.token, "POST", `/staff/v1/handoffs/${ids.handoffId}/reply`, {
      text: "I should not send this",
    });
    expect(wrong.status).toBe(409);
    const reply = await call(ids.first.token, "POST", `/staff/v1/handoffs/${ids.handoffId}/reply`, {
      text: "We can help with that.",
    });
    expect(reply.status).toBe(200);

    const withReply = await call(ids.first.token, "GET", `/staff/v1/handoffs/${ids.handoffId}`);
    expect(await withReply.json()).toMatchObject({
      messages: [{ role: "staff", label: "Team", text: "We can help with that." }],
    });
    expect(
      (await call(ids.first.token, "POST", `/staff/v1/handoffs/${ids.handoffId}/hand-back`)).status,
    ).toBe(204);
  });

  it("returns 404 across tenants and 401 for malformed or revoked tokens", async () => {
    if (!pool) return;
    const owner = await setup("Staff owner");
    const other = await setup("Staff other");
    expect((await call(other.first.token, "GET", `/staff/v1/handoffs/${owner.handoffId}`)).status).toBe(404);
    expect((await call("malformed", "GET", "/staff/v1/handoffs")).status).toBe(401);
    await withTenant(pool.db, owner.tenantId, (tx) => revokeStaffToken(tx, owner.first.id));
    expect((await call(owner.first.token, "GET", "/staff/v1/handoffs")).status).toBe(401);
  });

  it("allows exactly one winner when two staff claim concurrently", async () => {
    const ids = await setup("Staff race");
    const results = await Promise.all([
      call(ids.first.token, "POST", `/staff/v1/handoffs/${ids.handoffId}/claim`),
      call(ids.second.token, "POST", `/staff/v1/handoffs/${ids.handoffId}/claim`),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
  });
});
