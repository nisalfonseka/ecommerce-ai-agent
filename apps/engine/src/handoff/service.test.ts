import {
  createBot,
  createConversation,
  createDb,
  createStore,
  createTenant,
  getConversation,
  getHandoff,
  listDisplay,
  withTenant,
} from "@ace/db";
import type { JobName, JobPayload, JobQueue } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { claimHandoff, handBack, openHandoff, resolveHandoff, staffReply } from "./service";

const testDb = await createTestDatabase();

class RecordingQueue implements JobQueue {
  sent: { name: JobName; data: unknown }[] = [];
  async send<N extends JobName>(name: N, data: JobPayload<N>): Promise<void> {
    this.sent.push({ name, data });
  }
}

describe.skipIf(testDb === null)("handoff service", () => {
  const pool = testDb ? createDb(testDb.appUrl) : null;
  const jobs = new RecordingQueue();

  afterAll(async () => {
    await pool?.close();
    await testDb?.drop();
  });

  async function conversation(name: string) {
    if (!pool) throw new Error("test database unavailable");
    const { tenantId } = await createTenant(pool.db, { name });
    const conversationId = await withTenant(pool.db, tenantId, async (tx) => {
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
      return (
        await createConversation(tx, tenantId, { botId: bot.id, visitorId: "visitor_123", session: {} })
      ).id;
    });
    return { tenantId, conversationId };
  }

  it("opens once, redacts the summary, changes ownership, and enqueues one alert", async () => {
    if (!pool) return;
    const ids = await conversation("Open handoff");
    const first = await openHandoff({ db: pool.db, jobs }, ids, {
      reason: "complaint",
      summary: "Email me at shopper@example.com about 077 123 4567",
    });
    const second = await openHandoff({ db: pool.db, jobs }, ids, {
      reason: "other",
      summary: "This retry must not replace the original.",
    });
    expect(second).toEqual({ id: first.id, created: false });
    const stored = await withTenant(pool.db, ids.tenantId, (tx) => getHandoff(tx, first.id));
    expect(stored).toMatchObject({
      reason: "complaint",
      summary: "Email me at [email] about [phone]",
      status: "open",
    });
    expect(
      (await withTenant(pool.db, ids.tenantId, (tx) => getConversation(tx, ids.conversationId)))?.status,
    ).toBe("handoff");
    expect(jobs.sent.filter((job) => (job.data as { handoffId?: string }).handoffId === first.id)).toEqual([
      { name: "handoff.notify", data: { tenantId: ids.tenantId, handoffId: first.id } },
    ]);
  });

  it("allows one claim, only that staff member to reply, then hand-back or resolve", async () => {
    if (!pool) return;
    const ids = await conversation("Claim handoff");
    const opened = await openHandoff({ db: pool.db, jobs }, ids, {
      reason: "asked_for_person",
      summary: "Needs help",
    });
    const claims = await Promise.all([
      claimHandoff({ db: pool.db, jobs }, ids.tenantId, opened.id, "Nimali"),
      claimHandoff({ db: pool.db, jobs }, ids.tenantId, opened.id, "Kasun"),
    ]);
    expect(claims.sort()).toEqual(["already_claimed", "claimed"]);
    const row = await withTenant(pool.db, ids.tenantId, (tx) => getHandoff(tx, opened.id));
    const winner = row?.claimedBy ?? "";
    const loser = winner === "Nimali" ? "Kasun" : "Nimali";
    expect(await staffReply({ db: pool.db, jobs }, ids.tenantId, opened.id, loser, "Hello")).toBe(
      "not_claimed_by_you",
    );
    expect(await staffReply({ db: pool.db, jobs }, ids.tenantId, opened.id, winner, "How can I help?")).toBe(
      "sent",
    );
    expect(
      await withTenant(pool.db, ids.tenantId, (tx) => listDisplay(tx, ids.conversationId)),
    ).toContainEqual({ role: "staff", label: "Team", text: "How can I help?" });
    await handBack({ db: pool.db, jobs }, ids.tenantId, opened.id);
    expect(
      (await withTenant(pool.db, ids.tenantId, (tx) => getConversation(tx, ids.conversationId)))?.status,
    ).toBe("open");
    await resolveHandoff({ db: pool.db, jobs }, ids.tenantId, opened.id);
    expect(
      (await withTenant(pool.db, ids.tenantId, (tx) => getConversation(tx, ids.conversationId)))?.status,
    ).toBe("open");

    const next = await openHandoff({ db: pool.db, jobs }, ids, {
      reason: "other",
      summary: "One more question",
    });
    await resolveHandoff({ db: pool.db, jobs }, ids.tenantId, next.id);
    expect(
      (await withTenant(pool.db, ids.tenantId, (tx) => getConversation(tx, ids.conversationId)))?.status,
    ).toBe("closed");
  });

  it("does not reveal another tenant's handoff", async () => {
    if (!pool) return;
    const owner = await conversation("Owner");
    const other = await conversation("Other");
    const opened = await openHandoff({ db: pool.db, jobs }, owner, { reason: "other", summary: "Help" });
    expect(await claimHandoff({ db: pool.db, jobs }, other.tenantId, opened.id, "Intruder")).toBe(
      "not_found",
    );
    expect(await staffReply({ db: pool.db, jobs }, other.tenantId, opened.id, "Intruder", "Hi")).toBe(
      "not_found",
    );
  });
});
