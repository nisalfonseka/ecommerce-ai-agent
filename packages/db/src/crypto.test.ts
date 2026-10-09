import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./crypto";

const master = randomBytes(32);

describe("sealSecret / openSecret", () => {
  it("round-trips and never repeats ciphertext", () => {
    const a = sealSecret("shpat_secret_token", master);
    const b = sealSecret("shpat_secret_token", master);
    expect(openSecret(a, master)).toBe("shpat_secret_token");
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from("shpat_secret_token"))).toBe(false);
  });

  it("rejects tampering and the wrong master key", () => {
    const sealed = sealSecret("token", master);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => openSecret(tampered, master)).toThrow();
    expect(() => openSecret(sealed, randomBytes(32))).toThrow();
  });

  it("requires a 32-byte master key and a known format version", () => {
    expect(() => sealSecret("x", randomBytes(31))).toThrow(/32 bytes/);
    const sealed = sealSecret("x", master);
    sealed[0] = 9;
    expect(() => openSecret(sealed, master)).toThrow(/version/);
  });
});
