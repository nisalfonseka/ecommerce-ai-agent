import { createHmac, timingSafeEqual } from "node:crypto";
import {
  normalizeEmail,
  normalizePhone,
  type VerifiedIdentity,
  VerifiedIdentitySchema,
} from "@ace/contracts";
import { z } from "zod";

const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const HeaderSchema = z.object({ alg: z.literal("HS256"), typ: z.literal("JWT") });
const ClaimsSchema = z.object({
  sub: z.string().min(1).max(500),
  email: z.string().max(254).optional(),
  emailVerified: z.boolean().optional(),
  phone: z.string().max(64).optional(),
  phoneVerified: z.boolean().optional(),
  exp: z.number().int().positive(),
});

export interface HostSessionClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  phone?: string;
  phoneVerified?: boolean;
  exp: number;
}

function signature(input: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(input, "ascii").digest();
}

export function signHostSession(claims: HostSessionClaims, secret: Buffer): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${signature(unsigned, secret).toString("base64url")}`;
}

/** Verifies a tenant-scoped host token. All failures are deliberately indistinguishable (`null`). */
export function verifyHostSession(
  token: string,
  secret: Buffer,
  now: Date = new Date(),
): VerifiedIdentity | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;
    const header = HeaderSchema.safeParse(JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")));
    const claims = ClaimsSchema.safeParse(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")));
    if (!header.success || !claims.success) return null;
    const expected = signature(`${headerPart}.${payloadPart}`, secret);
    const actual = Buffer.from(signaturePart, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (claims.data.exp <= nowSeconds || claims.data.exp > nowSeconds + MAX_LIFETIME_SECONDS) return null;

    const identity: VerifiedIdentity = {
      method: "host_session",
      externalCustomerId: claims.data.sub,
      verifiedAt: now.toISOString(),
    };
    if (claims.data.emailVerified) {
      const email = normalizeEmail(claims.data.email ?? "");
      if (!email) return null;
      identity.email = email;
    }
    if (claims.data.phoneVerified) {
      const phone = normalizePhone(claims.data.phone ?? "");
      if (!phone) return null;
      identity.phone = phone;
    }
    const parsed = VerifiedIdentitySchema.safeParse(identity);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
