import { z } from "zod";

/**
 * A shopper identity proven by the engine (host-site session token or OTP).
 * Built server-side only — never from model output.
 */
export const VerifiedIdentitySchema = z
  .object({
    method: z.enum(["host_session", "email_otp", "phone_otp"]),
    email: z.email().optional(),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, "E.164 phone, e.g. +94771234567")
      .optional(),
    externalCustomerId: z.string().min(1).optional(),
    verifiedAt: z.iso.datetime(),
  })
  .refine((v) => v.email !== undefined || v.phone !== undefined || v.externalCustomerId !== undefined, {
    message: "identity needs an email, phone or externalCustomerId",
  });
export type VerifiedIdentity = z.infer<typeof VerifiedIdentitySchema>;

export interface OrderOwner {
  email?: string | undefined;
  phone?: string | undefined;
  externalCustomerId?: string | undefined;
}

export function identityMatches(identity: VerifiedIdentity, owner: OrderOwner): boolean {
  if (identity.email && owner.email && identity.email.toLowerCase() === owner.email.toLowerCase())
    return true;
  if (identity.phone && owner.phone && identity.phone === owner.phone) return true;
  if (
    identity.externalCustomerId &&
    owner.externalCustomerId &&
    identity.externalCustomerId === owner.externalCustomerId
  ) {
    return true;
  }
  return false;
}
