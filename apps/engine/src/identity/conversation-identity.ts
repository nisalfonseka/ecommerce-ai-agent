import { type VerifiedIdentity, VerifiedIdentitySchema } from "@ace/contracts";

export function currentIdentity(
  conversation: { identity: unknown; identityExpiresAt?: Date | string | null },
  now: Date,
): VerifiedIdentity | null {
  const expires = conversation.identityExpiresAt;
  if (!expires) return null;
  const expiry = expires instanceof Date ? expires : new Date(expires);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) return null;
  const identity = VerifiedIdentitySchema.safeParse(conversation.identity);
  return identity.success ? identity.data : null;
}
