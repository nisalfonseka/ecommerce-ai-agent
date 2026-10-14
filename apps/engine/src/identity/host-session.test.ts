import { describe, expect, it } from "vitest";
import { signHostSession, verifyHostSession } from "./host-session";

const secret = Buffer.alloc(32, 9);
const now = new Date("2026-10-14T10:00:00.000Z");
const exp = Math.floor(now.getTime() / 1000) + 3600;

describe("host session identity", () => {
  it("accepts verified claims and drops unverified contact fields", () => {
    const token = signHostSession(
      {
        sub: "customer-1",
        email: " Customer@Example.com ",
        emailVerified: true,
        phone: "077 123 4567",
        phoneVerified: false,
        exp,
      },
      secret,
    );
    expect(verifyHostSession(token, secret, now)).toEqual({
      method: "host_session",
      externalCustomerId: "customer-1",
      email: "customer@example.com",
      verifiedAt: now.toISOString(),
    });
    expect(
      verifyHostSession(
        signHostSession(
          { sub: "customer-2", email: "ignore@example.com", emailVerified: false, exp },
          secret,
        ),
        secret,
        now,
      ),
    ).toEqual({
      method: "host_session",
      externalCustomerId: "customer-2",
      verifiedAt: now.toISOString(),
    });
  });

  it("rejects tampering, wrong secrets, expiry and excessive lifetimes", () => {
    const token = signHostSession({ sub: "customer-1", exp }, secret);
    const [header, payload, signature] = token.split(".");
    expect(verifyHostSession(`${header}.${payload}x.${signature}`, secret, now)).toBeNull();
    expect(verifyHostSession(token, Buffer.alloc(32, 8), now)).toBeNull();
    expect(
      verifyHostSession(signHostSession({ sub: "customer-1", exp: exp - 3601 }, secret), secret, now),
    ).toBeNull();
    expect(
      verifyHostSession(signHostSession({ sub: "customer-1", exp: exp + 24 * 3600 }, secret), secret, now),
    ).toBeNull();
  });

  it("rejects malformed claims and invalid verified contacts", () => {
    expect(verifyHostSession(signHostSession({ sub: "", exp }, secret), secret, now)).toBeNull();
    expect(
      verifyHostSession(
        signHostSession({ sub: "customer-1", email: "bad", emailVerified: true, exp }, secret),
        secret,
        now,
      ),
    ).toBeNull();
  });
});
