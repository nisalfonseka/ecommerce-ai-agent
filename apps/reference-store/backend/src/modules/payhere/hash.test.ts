import { describe, expect, it } from "vitest";
import {
  checkoutHash,
  formatAmount,
  isVerificationValid,
  verificationSignature,
  verifyNotification,
} from "./hash";

// Vectors computed independently from PayHere's documented formulas (Checkout API):
//   hash   = UPPER(md5(merchant_id + order_id + amount(2dp) + currency + UPPER(md5(secret))))
//   md5sig = UPPER(md5(merchant_id + order_id + payhere_amount + payhere_currency + status_code + UPPER(md5(secret))))
const secret = "MySecret123";

describe("formatAmount", () => {
  it("formats major units with two decimals and no thousands separator", () => {
    expect(formatAmount(1000)).toBe("1000.00");
    expect(formatAmount("18900")).toBe("18900.00");
    expect(formatAmount(12.5)).toBe("12.50");
    expect(formatAmount({ numeric: 400 })).toBe("400.00");
  });

  it("rejects amounts that are not positive finite numbers", () => {
    for (const bad of [0, -1, Number.NaN, "abc", Number.POSITIVE_INFINITY]) {
      expect(() => formatAmount(bad)).toThrow();
    }
  });
});

describe("checkoutHash", () => {
  it("matches PayHere's formula", () => {
    expect(
      checkoutHash({
        merchantId: "1211149",
        orderId: "ORD-001",
        amount: 1000,
        currency: "LKR",
        merchantSecret: secret,
      }),
    ).toBe("959F47D377785ED9CD1AFD3BC29EBED3");
    expect(
      checkoutHash({
        merchantId: "1211149",
        orderId: "payses_01ABC",
        amount: "18900",
        currency: "LKR",
        merchantSecret: secret,
      }),
    ).toBe("14C55CEC035AA5A090A3B79D2893374F");
  });
});

describe("verifyNotification", () => {
  const fields = {
    merchant_id: "1211149",
    order_id: "ORD-001",
    payment_id: "320025023469",
    payhere_amount: "1000.00",
    payhere_currency: "LKR",
    status_code: "2",
    md5sig: "1C86CE3B1CF55DAF44B5537EC78F82A8",
  };

  it("accepts a correctly signed notification and maps the status", () => {
    expect(verifyNotification(fields, { merchantId: "1211149", merchantSecret: secret })).toEqual({
      valid: true,
      orderId: "ORD-001",
      paymentId: "320025023469",
      amount: "1000.00",
      currency: "LKR",
      status: "captured",
    });
  });

  it("rejects a tampered amount, status, merchant or a wrong secret", () => {
    const check = (
      changed: Record<string, string>,
      opts = { merchantId: "1211149", merchantSecret: secret },
    ) => verifyNotification({ ...fields, ...changed }, opts).valid;
    expect(check({ payhere_amount: "1.00" })).toBe(false);
    expect(check({ status_code: "0" })).toBe(false);
    expect(check({ md5sig: "" })).toBe(false);
    expect(check({}, { merchantId: "1211149", merchantSecret: "other" })).toBe(false);
    expect(check({ merchant_id: "999" })).toBe(false);
    expect(
      verifyNotification({ order_id: "x" }, { merchantId: "1211149", merchantSecret: secret }).valid,
    ).toBe(false);
  });

  it("maps every PayHere status code", () => {
    const status = (code: string) =>
      verifyNotification(
        { ...fields, status_code: code, md5sig: signed(code) },
        { merchantId: "1211149", merchantSecret: secret },
      );
    expect(status("0")).toMatchObject({ valid: true, status: "pending" });
    expect(status("-1")).toMatchObject({ valid: true, status: "canceled" });
    expect(status("-2")).toMatchObject({ valid: true, status: "failed" });
    expect(status("-3")).toMatchObject({ valid: true, status: "chargedback" });
    expect(status("7")).toMatchObject({ valid: false });
  });
});

describe("verificationSignature", () => {
  const base = {
    sessionId: "s1",
    status: "captured",
    paymentId: "p1",
    amount: "1000.00",
    currency: "LKR",
  } as const;

  it("binds session, status, payment id, amount and currency to the merchant secret", () => {
    const a = verificationSignature(base, secret);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(isVerificationValid({ ...base, signature: a }, secret)).toBe(true);
    for (const changed of [
      { sessionId: "s2" },
      { status: "pending" },
      { amount: "1.00" },
      { currency: "USD" },
    ]) {
      expect(
        isVerificationValid(
          { ...base, ...changed, signature: a } as typeof base & { signature: string },
          secret,
        ),
      ).toBe(false);
    }
    expect(isVerificationValid({ ...base, signature: a }, "x")).toBe(false);
  });
});

import { createHash } from "node:crypto";

function signed(code: string): string {
  const md5 = (s: string) => createHash("md5").update(s).digest("hex").toUpperCase();
  return md5(`1211149ORD-0011000.00LKR${code}${md5(secret)}`);
}
