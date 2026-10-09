import { describe, expect, it } from "vitest";
import { identityMatches, VerifiedIdentitySchema } from "./identity";
import { LookupOrderInputSchema } from "./orders";

const verifiedAt = "2026-10-01T00:00:00.000Z";

describe("VerifiedIdentitySchema", () => {
  it("requires at least one identifier", () => {
    expect(VerifiedIdentitySchema.safeParse({ method: "email_otp", verifiedAt }).success).toBe(false);
  });

  it("requires E.164 phone numbers", () => {
    const local = { method: "phone_otp", phone: "0771234567", verifiedAt };
    const e164 = { method: "phone_otp", phone: "+94771234567", verifiedAt };
    expect(VerifiedIdentitySchema.safeParse(local).success).toBe(false);
    expect(VerifiedIdentitySchema.safeParse(e164).success).toBe(true);
  });
});

describe("identityMatches", () => {
  const owner = { email: "Customer@Example.com", phone: "+94771234567" };

  it("matches email case-insensitively", () => {
    expect(identityMatches({ method: "email_otp", email: "customer@example.com", verifiedAt }, owner)).toBe(
      true,
    );
  });

  it("matches by phone", () => {
    expect(identityMatches({ method: "phone_otp", phone: "+94771234567", verifiedAt }, owner)).toBe(true);
  });

  it("does not match a different person", () => {
    expect(identityMatches({ method: "email_otp", email: "someone@example.com", verifiedAt }, owner)).toBe(
      false,
    );
  });

  it("does not match when the owner lacks the identifier type", () => {
    const identity = { method: "host_session" as const, externalCustomerId: "cus_1", verifiedAt };
    expect(identityMatches(identity, owner)).toBe(false);
  });
});

describe("LookupOrderInputSchema", () => {
  it("trims the order number", () => {
    const parsed = LookupOrderInputSchema.parse({
      orderNumber: "  ACE-1001 ",
      identity: { method: "email_otp", email: "a@example.com", verifiedAt },
    });
    expect(parsed.orderNumber).toBe("ACE-1001");
  });
});
