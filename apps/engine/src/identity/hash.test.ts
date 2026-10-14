import { describe, expect, it } from "vitest";
import { deriveKey, hashCode, identityHash } from "./hash";

describe("identity hashes", () => {
  it("uses stable, domain-separated keys", () => {
    const master = Buffer.alloc(32, 7);
    const otp = deriveKey(master, "ace/otp/v1");
    const identity = deriveKey(master, "ace/identity-hash/v1");
    expect(otp).toHaveLength(32);
    expect(identity).toHaveLength(32);
    expect(otp.equals(identity)).toBe(false);
    expect(deriveKey(master, "ace/otp/v1").equals(otp)).toBe(true);
  });

  it("binds identity hashes to tenant, kind and normalized value", () => {
    const key = deriveKey(Buffer.alloc(32, 4), "ace/identity-hash/v1");
    const first = identityHash(key, "tenant-a", "email", "a@example.com");
    expect(identityHash(key, "tenant-a", "email", "a@example.com")).toBe(first);
    expect(identityHash(key, "tenant-b", "email", "a@example.com")).not.toBe(first);
    expect(identityHash(key, "tenant-a", "phone", "a@example.com")).not.toBe(first);
  });

  it("binds a code hash to its salt", () => {
    const key = deriveKey(Buffer.alloc(32, 2), "ace/otp/v1");
    expect(hashCode(key, "123456", "salt-a")).toBe(hashCode(key, "123456", "salt-a"));
    expect(hashCode(key, "123456", "salt-b")).not.toBe(hashCode(key, "123456", "salt-a"));
  });
});
