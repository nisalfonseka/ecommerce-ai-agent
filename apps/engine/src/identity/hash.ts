import { createHmac, hkdfSync } from "node:crypto";

export type DerivedKeyLabel = "ace/otp/v1" | "ace/identity-hash/v1";

/** Domain-separated application key. Changing a label intentionally invalidates all hashes in that domain. */
export function deriveKey(masterKey: Buffer, label: DerivedKeyLabel): Buffer {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), label, 32));
}

export function identityHash(
  key: Buffer,
  tenantId: string,
  kind: "email" | "phone",
  normalized: string,
): string {
  return createHmac("sha256", key)
    .update(`${tenantId.length}:${tenantId}|${kind}|${normalized}`, "utf8")
    .digest("base64url");
}

export function hashCode(key: Buffer, code: string, salt: string): string {
  return createHmac("sha256", key).update(`${salt.length}:${salt}|${code}`, "utf8").digest("base64url");
}
