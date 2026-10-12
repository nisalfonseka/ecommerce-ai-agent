import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isVerificationValid } from "./hash";
import { handleNotification, type NotificationDeps, type StoredSession } from "./notification";

const merchantId = "1211149";
const merchantSecret = "MySecret123";
const md5 = (s: string) => createHash("md5").update(s).digest("hex").toUpperCase();

function notify(overrides: Record<string, string> = {}): Record<string, string> {
  const fields = {
    merchant_id: merchantId,
    order_id: "payses_1",
    payment_id: "320025023469",
    payhere_amount: "18900.00",
    payhere_currency: "LKR",
    status_code: "2",
    ...overrides,
  };
  const sig = md5(
    `${fields.merchant_id}${fields.order_id}${fields.payhere_amount}${fields.payhere_currency}${fields.status_code}${md5(merchantSecret)}`,
  );
  return { ...fields, md5sig: overrides.md5sig ?? sig };
}

function deps(
  session: StoredSession | null = { id: "payses_1", amount: 18900, currency_code: "lkr", data: {} },
) {
  const saved: Record<string, unknown>[] = [];
  const d: NotificationDeps = {
    merchantId,
    merchantSecret,
    retrieveSession: vi.fn(async (id: string) => (session && session.id === id ? session : null)),
    saveSessionData: vi.fn(async (_session: StoredSession, data: Record<string, unknown>) => {
      saved.push(data);
    }),
    processPayment: vi.fn(async () => {}),
  };
  return { d, saved };
}

describe("handleNotification", () => {
  it("rejects a bad signature without touching the session", async () => {
    const { d } = deps();
    expect(await handleNotification(notify({ md5sig: "00" }), d)).toEqual({
      status: 400,
      outcome: "invalid_signature",
    });
    expect(d.retrieveSession).not.toHaveBeenCalled();
    expect(d.processPayment).not.toHaveBeenCalled();
  });

  it("rejects an unknown session", async () => {
    const { d } = deps(null);
    expect(await handleNotification(notify(), d)).toEqual({ status: 400, outcome: "unknown_session" });
  });

  it("rejects a payment for a different amount or currency than the session", async () => {
    const changes: Record<string, string>[] = [{ payhere_amount: "100.00" }, { payhere_currency: "USD" }];
    for (const changed of changes) {
      const { d } = deps();
      expect(await handleNotification(notify(changed), d)).toEqual({
        status: 400,
        outcome: "amount_mismatch",
      });
      expect(d.saveSessionData).not.toHaveBeenCalled();
    }
  });

  it("stores a signed verification and processes a captured payment", async () => {
    const { d, saved } = deps();
    expect(await handleNotification(notify(), d)).toEqual({ status: 200, outcome: "captured" });
    const verification = saved[0]?.payhere_verification as Record<string, string>;
    expect(
      isVerificationValid(
        {
          sessionId: "payses_1",
          status: "captured",
          paymentId: "320025023469",
          amount: "18900.00",
          currency: "LKR",
          signature: verification.signature ?? "",
        },
        merchantSecret,
      ),
    ).toBe(true);
    expect(d.processPayment).toHaveBeenCalledWith({ sessionId: "payses_1", amount: 18900 });
  });

  it("records but does not process pending, failed or cancelled payments", async () => {
    for (const code of ["0", "-1", "-2"]) {
      const { d, saved } = deps();
      expect((await handleNotification(notify({ status_code: code }), d)).status).toBe(200);
      expect(saved).toHaveLength(1);
      expect(d.processPayment).not.toHaveBeenCalled();
    }
  });

  it("ignores a repeated captured notification", async () => {
    const first = deps();
    await handleNotification(notify(), first.d);
    const session = { id: "payses_1", amount: 18900, currency_code: "lkr", data: first.saved[0] ?? {} };
    const second = deps(session);
    expect(await handleNotification(notify(), second.d)).toEqual({ status: 200, outcome: "duplicate" });
    expect(second.d.processPayment).not.toHaveBeenCalled();
  });
});
