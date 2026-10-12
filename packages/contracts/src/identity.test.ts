import { describe, expect, it } from "vitest";
import {
  identityMatches,
  normalizeEmail,
  normalizePhone,
  type VerifiedIdentity,
  VerifiedIdentitySchema,
} from "./identity";
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

  it("accepts each method's own shape", () => {
    const shapes = [
      { method: "email_otp", email: "a@example.com", verifiedAt },
      { method: "phone_otp", phone: "+94771234567", verifiedAt },
      { method: "host_session", externalCustomerId: "cus_1", verifiedAt },
      {
        method: "host_session",
        externalCustomerId: "cus_1",
        email: "a@example.com",
        phone: "+94771234567",
        verifiedAt,
      },
    ];
    for (const shape of shapes)
      expect(VerifiedIdentitySchema.safeParse(shape).success, shape.method).toBe(true);
  });

  it("rejects an email_otp identity that carries a phone or a customer id", () => {
    const base = { method: "email_otp", email: "a@example.com", verifiedAt };
    expect(VerifiedIdentitySchema.safeParse({ ...base, phone: "+94771234567" }).success).toBe(false);
    expect(VerifiedIdentitySchema.safeParse({ ...base, externalCustomerId: "cus_1" }).success).toBe(false);
  });

  it("rejects a phone_otp identity that carries an email or a customer id", () => {
    const base = { method: "phone_otp", phone: "+94771234567", verifiedAt };
    expect(VerifiedIdentitySchema.safeParse({ ...base, email: "a@example.com" }).success).toBe(false);
    expect(VerifiedIdentitySchema.safeParse({ ...base, externalCustomerId: "cus_1" }).success).toBe(false);
  });

  it("rejects an OTP identity that lacks its own identifier even when it has another", () => {
    const noEmail = { method: "email_otp", phone: "+94771234567", verifiedAt };
    const noPhone = { method: "phone_otp", email: "a@example.com", verifiedAt };
    expect(VerifiedIdentitySchema.safeParse(noEmail).success).toBe(false);
    expect(VerifiedIdentitySchema.safeParse(noPhone).success).toBe(false);
  });

  it("requires a host_session identity to carry the host's customer id", () => {
    const email = { method: "host_session", email: "a@example.com", verifiedAt };
    const phone = { method: "host_session", phone: "+94771234567", verifiedAt };
    expect(VerifiedIdentitySchema.safeParse(email).success).toBe(false);
    expect(VerifiedIdentitySchema.safeParse(phone).success).toBe(false);
    expect(VerifiedIdentitySchema.safeParse({ method: "host_session", verifiedAt }).success).toBe(false);
  });

  it("does not echo contact data in its error messages", () => {
    const result = VerifiedIdentitySchema.safeParse({
      method: "email_otp",
      email: "private.person@example.com",
      phone: "+94771234567",
      verifiedAt,
    });
    expect(result.success).toBe(false);
    const text = JSON.stringify(result.error?.issues ?? []);
    expect(text).not.toContain("private.person");
    expect(text).not.toContain("771234567");
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

  it("matches a phone owner stored in any common shape", () => {
    const identity: VerifiedIdentity = { method: "phone_otp", phone: "+94771234567", verifiedAt };
    for (const phone of ["+94771234567", "0771234567", "94771234567", "+94 77 123 4567", "077-123 4567"]) {
      expect(identityMatches(identity, { phone }), phone).toBe(true);
    }
  });

  it("does not match a different phone, or an owner phone that is not a phone number", () => {
    const identity: VerifiedIdentity = { method: "phone_otp", phone: "+94771234567", verifiedAt };
    expect(identityMatches(identity, { phone: "+94771234568" })).toBe(false);
    expect(identityMatches(identity, { phone: "0771234568" })).toBe(false);
    expect(identityMatches(identity, { phone: "not a phone" })).toBe(false);
    expect(identityMatches(identity, { phone: "" })).toBe(false);
  });

  it("never matches an email_otp identity by phone, whatever else the object carries", () => {
    const identity: VerifiedIdentity = { method: "email_otp", email: "a@example.com", verifiedAt };
    // A phone-only owner never matches an email-only identity.
    expect(identityMatches(identity, { phone: "+94771234567" })).toBe(false);
    // Even an object that bypassed the schema and carries a verified-looking phone is matched by email only.
    const smuggled = { ...identity, phone: "+94771234567" } as VerifiedIdentity;
    expect(identityMatches(smuggled, { phone: "+94771234567" })).toBe(false);
    expect(identityMatches(smuggled, { email: "a@example.com" })).toBe(true);
    // A phone that merely equals the email string is still not an email match.
    expect(identityMatches(identity, { phone: "a@example.com" })).toBe(false);
  });

  it("never matches a phone_otp identity by email or customer id", () => {
    const identity: VerifiedIdentity = { method: "phone_otp", phone: "+94771234567", verifiedAt };
    expect(identityMatches(identity, { email: "a@example.com" })).toBe(false);
    const smuggled = {
      ...identity,
      email: "a@example.com",
      externalCustomerId: "cus_1",
    } as VerifiedIdentity;
    expect(identityMatches(smuggled, { email: "a@example.com" })).toBe(false);
    expect(identityMatches(smuggled, { externalCustomerId: "cus_1" })).toBe(false);
    expect(identityMatches(smuggled, { phone: "+94771234567" })).toBe(true);
  });

  it("never matches an OTP identity by customer id", () => {
    const smuggled = {
      method: "email_otp",
      email: "a@example.com",
      externalCustomerId: "cus_1",
      verifiedAt,
    } as VerifiedIdentity;
    expect(identityMatches(smuggled, { externalCustomerId: "cus_1" })).toBe(false);
  });

  it("matches a host_session by customer id, or by the host-verified email or phone it carries", () => {
    const byId: VerifiedIdentity = { method: "host_session", externalCustomerId: "cus_1", verifiedAt };
    expect(identityMatches(byId, { externalCustomerId: "cus_1" })).toBe(true);
    expect(identityMatches(byId, { externalCustomerId: "cus_2" })).toBe(false);
    // Without a verified email or phone on the identity the owner's contact data cannot match.
    expect(identityMatches(byId, { email: "a@example.com", phone: "+94771234567" })).toBe(false);

    const full: VerifiedIdentity = {
      method: "host_session",
      externalCustomerId: "cus_1",
      email: "A@Example.com",
      phone: "+94771234567",
      verifiedAt,
    };
    expect(identityMatches(full, { email: "a@example.com" })).toBe(true);
    expect(identityMatches(full, { phone: "0771234567" })).toBe(true);
    expect(identityMatches(full, { email: "b@example.com", phone: "+94771234568" })).toBe(false);
  });

  it("does not let two empty values match", () => {
    const blank = { method: "host_session", externalCustomerId: "", verifiedAt } as VerifiedIdentity;
    expect(identityMatches(blank, { externalCustomerId: "" })).toBe(false);
    const noEmail = { method: "email_otp", email: "", verifiedAt } as VerifiedIdentity;
    expect(identityMatches(noEmail, { email: "" })).toBe(false);
    expect(identityMatches(noEmail, { email: "  " })).toBe(false);
  });

  it("folds only ASCII case, so look-alike characters never collide", () => {
    // U+212A KELVIN SIGN lower-cases to ASCII "k" under toLowerCase().
    const identity: VerifiedIdentity = { method: "email_otp", email: "kim@example.com", verifiedAt };
    expect(identityMatches(identity, { email: "Kim@example.com" })).toBe(false);
  });

  it("fails closed for an unknown method", () => {
    const unknown = { method: "carrier_pigeon", email: "a@example.com", verifiedAt } as never;
    expect(identityMatches(unknown, { email: "a@example.com" })).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("turns Sri Lankan numbers in any common shape into one E.164 number", () => {
    for (const input of [
      "0771234567",
      "94771234567",
      "+94771234567",
      "+94 77 123 4567",
      "077-1234567",
      "077-123 4567",
      "(077) 123 4567",
      "  0771234567  ",
    ]) {
      expect(normalizePhone(input), input).toBe("+94771234567");
    }
  });

  it("keeps other E.164 numbers that fit the identity phone shape", () => {
    expect(normalizePhone("+447700900123")).toBe("+447700900123");
    expect(normalizePhone("+1 (415) 555-0132")).toBe("+14155550132");
  });

  it("returns null for anything that is not a phone number, and never throws", () => {
    const inputs = [
      "",
      "   ",
      "12345",
      "+0771234567",
      "call me",
      "077 abc 4567",
      "07712345678901234",
      "+94",
      "+9477123456", // one digit short of a Sri Lankan number
      "+940771234567", // "+94 (0) 77 …" is not a valid number once the 0 is kept
      "0094771234567",
      "+++94771234567",
      "9477123456",
      "x".repeat(10_000),
      "9".repeat(10_000),
    ];
    for (const input of inputs) expect(normalizePhone(input), input.slice(0, 24)).toBeNull();
    expect(normalizePhone(undefined as unknown as string)).toBeNull();
    expect(normalizePhone(null as unknown as string)).toBeNull();
  });

  it("reads national numbers with the given default country code", () => {
    expect(normalizePhone("07700900123", "44")).toBe("+447700900123");
    expect(normalizePhone("447700900123", "44")).toBe("+447700900123");
    expect(normalizePhone("0771234567", "not a code")).toBeNull();
    // An explicit "+" number does not need a usable default.
    expect(normalizePhone("+94771234567", "not a code")).toBe("+94771234567");
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  A@B.com ")).toBe("a@b.com");
    expect(normalizeEmail("Customer@Example.COM")).toBe("customer@example.com");
  });

  it("keeps plus tags and dots, which are not safe to fold for every mail provider", () => {
    expect(normalizeEmail("a+tag@gmail.com")).toBe("a+tag@gmail.com");
    expect(normalizeEmail("first.last@gmail.com")).toBe("first.last@gmail.com");
    expect(normalizeEmail("firstlast@gmail.com")).not.toBe(normalizeEmail("first.last@gmail.com"));
  });

  it("returns null for anything that is not an email address, and never throws", () => {
    for (const input of [
      "",
      "   ",
      "not-an-email",
      "a@",
      "@b.com",
      "a b@c.com",
      "a@b",
      `${"a".repeat(300)}@b.com`,
    ]) {
      expect(normalizeEmail(input), input.slice(0, 24)).toBeNull();
    }
    expect(normalizeEmail(undefined as unknown as string)).toBeNull();
  });

  it("validates before folding, so look-alike characters cannot become ASCII", () => {
    expect(normalizeEmail("Kim@example.com")).toBeNull(); // KELVIN SIGN
  });

  it("produces values the identity schema accepts", () => {
    const email = normalizeEmail(" Some.One+Tag@Example.com ");
    expect(email).not.toBeNull();
    expect(VerifiedIdentitySchema.safeParse({ method: "email_otp", email, verifiedAt }).success).toBe(true);
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

  it("rejects an identity whose fields do not fit its method", () => {
    const result = LookupOrderInputSchema.safeParse({
      orderNumber: "ACE-1001",
      identity: { method: "email_otp", email: "a@example.com", phone: "+94771234567", verifiedAt },
    });
    expect(result.success).toBe(false);
  });
});
