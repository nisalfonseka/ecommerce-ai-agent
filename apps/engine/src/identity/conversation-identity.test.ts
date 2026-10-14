import { describe, expect, it } from "vitest";
import { currentIdentity } from "./conversation-identity";

const identity = {
  method: "email_otp",
  email: "shopper@example.com",
  verifiedAt: "2026-10-14T10:00:00.000Z",
} as const;

describe("currentIdentity", () => {
  it("returns a valid stored identity before its expiry", () => {
    expect(
      currentIdentity(
        { identity, identityExpiresAt: new Date("2026-10-14T10:30:00.000Z") },
        new Date("2026-10-14T10:29:00.000Z"),
      ),
    ).toEqual(identity);
  });

  it("fails closed at expiry and for malformed stored data", () => {
    expect(
      currentIdentity(
        { identity, identityExpiresAt: new Date("2026-10-14T10:30:00.000Z") },
        new Date("2026-10-14T10:30:00.000Z"),
      ),
    ).toBeNull();
    expect(
      currentIdentity({ identity: { method: "email_otp" }, identityExpiresAt: null }, new Date()),
    ).toBeNull();
  });
});
