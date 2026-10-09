import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const NONCE = 12;
const TAG = 16;
const KEY = 32;

function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, sealed: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE));
  decipher.setAuthTag(sealed.subarray(NONCE, NONCE + TAG));
  return Buffer.concat([decipher.update(sealed.subarray(NONCE + TAG)), decipher.final()]);
}

function requireMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY) throw new Error("master key must be 32 bytes");
}

/**
 * Envelope encryption for store credentials: a fresh AES-256-GCM data key per value, wrapped by the master
 * key. Layout: version (1) ‖ wrapped data key (nonce ‖ tag ‖ 32 bytes) ‖ nonce ‖ tag ‖ ciphertext.
 */
export function sealSecret(plaintext: string, masterKey: Buffer): Buffer {
  requireMasterKey(masterKey);
  const dataKey = randomBytes(KEY);
  const wrapped = encrypt(masterKey, dataKey);
  return Buffer.concat([Buffer.from([VERSION]), wrapped, encrypt(dataKey, Buffer.from(plaintext, "utf8"))]);
}

/** Throws on a wrong master key, tampering or an unknown version. */
export function openSecret(sealed: Buffer, masterKey: Buffer): string {
  requireMasterKey(masterKey);
  if (sealed[0] !== VERSION) throw new Error(`unknown sealed-secret version ${sealed[0]}`);
  const wrappedEnd = 1 + NONCE + TAG + KEY;
  const dataKey = decrypt(masterKey, sealed.subarray(1, wrappedEnd));
  return decrypt(dataKey, sealed.subarray(wrappedEnd)).toString("utf8");
}
