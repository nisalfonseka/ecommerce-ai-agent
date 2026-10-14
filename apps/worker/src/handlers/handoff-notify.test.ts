import {
  createBot,
  createConversation,
  createDb,
  createHandoff,
  createStore,
  createTenant,
  getHandoff,
  upsertTenantSettings,
  withTenant,
} from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import type { Notifier } from "@ace/notify";
import { NotifyError } from "@ace/notify";
import { afterAll, describe, expect, it } from "vitest";
import { capturingLogger, fakeJob, testDeps } from "../testing";
import { handleHandoffNotify } from "./handoff-notify";

const testDb = await createTestDatabase();

describe.skipIf(testDb === null)("handoff.notify", () => {
  const pool = testDb ? createDb(testDb.appUrl) : null;

  afterAll(async () => {
    await pool?.close();
    await testDb?.drop();
  });

  async function seed(name: string, emails: string[]) {
    if (!pool) throw new Error("test database unavailable");
    const { tenantId } = await createTenant(pool.db, { name });
    const handoff = await withTenant(pool.db, tenantId, async (tx) => {
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
        visitorId: "visitor_notify",
        session: {},
      });
      await upsertTenantSettings(tx, tenantId, { handoffEmails: emails });
      return (
        await createHandoff(tx, tenantId, {
          conversationId: conversation.id,
          reason: "complaint",
          summary: "Package arrived damaged.",
        })
      ).handoff;
    });
    return { tenantId, handoffId: handoff.id };
  }

  it("emails every configured address once without a transcript", async () => {
    if (!pool) return;
    const ids = await seed("Notify once", ["a@shop.lk", "b@shop.lk"]);
    const sent: { to: string; subject: string; text: string }[] = [];
    const notifier: Notifier = {
      sendSms: async () => ({ providerId: null }),
      sendEmail: async (input) => {
        sent.push(input);
        return { providerId: "email" };
      },
    };
    const deps = testDeps(pool.db, {
      notifier,
      dashboardBaseUrl: "https://dashboard.example.lk",
    });
    const job = fakeJob(JOBS.handoffNotify, ids);
    await handleHandoffNotify(deps, job);
    await handleHandoffNotify(deps, job);
    expect(sent.map((email) => email.to)).toEqual(["a@shop.lk", "b@shop.lk"]);
    for (const email of sent) {
      expect(email.subject).toContain("complaint");
      expect(email.text).toContain("Package arrived damaged.");
      expect(email.text).toContain(`https://dashboard.example.lk/handoffs/${ids.handoffId}`);
      expect(email.text).not.toContain("transcript");
    }
    expect(
      (await withTenant(pool.db, ids.tenantId, (tx) => getHandoff(tx, ids.handoffId)))?.notifiedAt,
    ).toBeInstanceOf(Date);
  });

  it("warns and completes when no address is configured", async () => {
    if (!pool) return;
    const ids = await seed("Notify none", []);
    const { logger, lines } = capturingLogger();
    const deps = testDeps(pool.db, { logger });
    await expect(handleHandoffNotify(deps, fakeJob(JOBS.handoffNotify, ids))).resolves.toBeUndefined();
    expect(lines).toContainEqual(expect.objectContaining({ msg: "handoff alert has no recipients" }));
  });

  it("retries unavailable delivery but completes a rejected address with only the error code logged", async () => {
    if (!pool) return;
    const unavailable = await seed("Notify unavailable", ["retry@shop.lk"]);
    const rejected = await seed("Notify rejected", ["reject@shop.lk"]);
    const { logger, lines } = capturingLogger();
    const failing = (code: "unavailable" | "rejected"): Notifier => ({
      sendSms: async () => ({ providerId: null }),
      sendEmail: async () => {
        throw new NotifyError(code, "provider detail must not be logged");
      },
    });
    await expect(
      handleHandoffNotify(
        testDeps(pool.db, { logger, notifier: failing("unavailable") }),
        fakeJob(JOBS.handoffNotify, unavailable),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      handleHandoffNotify(
        testDeps(pool.db, { logger, notifier: failing("rejected") }),
        fakeJob(JOBS.handoffNotify, rejected),
      ),
    ).resolves.toBeUndefined();
    expect(lines).toContainEqual(expect.objectContaining({ errorCode: "rejected" }));
    expect(JSON.stringify(lines)).not.toContain("provider detail must not be logged");
  });
});
