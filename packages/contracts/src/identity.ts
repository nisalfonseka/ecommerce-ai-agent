import { z } from "zod";

const E164 = /^\+[1-9]\d{6,14}$/;
const COUNTRY_CODE = /^[1-9]\d{0,2}$/;
const SRI_LANKA = "94";
/** Sri Lankan numbers are fixed length: 9 digits after the country code (spec A1, the primary market). */
const SRI_LANKA_NATIONAL_DIGITS = 9;
/** Far above any real phone number or email; bounds the work done on untrusted text. */
const MAX_PHONE_INPUT = 64;
const MAX_EMAIL_LENGTH = 254;

const EmailSchema = z.email();

/**
 * A shopper identity proven by the engine (host-site session token or OTP).
 * Built server-side only — never from model output.
 *
 * Every populated identifier must itself have been verified by the engine, and each method carries only what it
 * proves:
 * - `email_otp`: `email` only (proved by a one-time code sent to it).
 * - `phone_otp`: `phone` only (proved by a one-time code sent to it).
 * - `host_session`: `externalCustomerId` (proved by the host's signed token), plus `email` / `phone` only when
 *   that token asserts them as verified. Never copy a shopper-typed value into this object.
 *
 * `identityMatches` compares only the identifiers the method proves, so a value verified one way can never
 * authorise access through another field.
 */
export const VerifiedIdentitySchema = z
  .object({
    method: z.enum(["host_session", "email_otp", "phone_otp"]),
    email: z.email().optional(),
    phone: z.string().regex(E164, "E.164 phone, e.g. +94771234567").optional(),
    externalCustomerId: z.string().min(1).optional(),
    verifiedAt: z.iso.datetime(),
  })
  .superRefine((identity, ctx) => {
    // Messages name the field, never its value: they can reach logs and error responses.
    const issue = (field: "email" | "phone" | "externalCustomerId", message: string) =>
      ctx.addIssue({ code: "custom", message, path: [field] });
    const forbid = (field: "email" | "phone" | "externalCustomerId") => {
      if (identity[field] !== undefined) issue(field, `${field} is not allowed for ${identity.method}`);
    };
    switch (identity.method) {
      case "email_otp":
        if (identity.email === undefined) issue("email", "email_otp identity needs an email");
        forbid("phone");
        forbid("externalCustomerId");
        break;
      case "phone_otp":
        if (identity.phone === undefined) issue("phone", "phone_otp identity needs a phone");
        forbid("email");
        forbid("externalCustomerId");
        break;
      case "host_session":
        if (identity.externalCustomerId === undefined) {
          issue("externalCustomerId", "host_session identity needs an externalCustomerId");
        }
        break;
    }
  });
export type VerifiedIdentity = z.infer<typeof VerifiedIdentitySchema>;

/**
 * The contact data and customer id a platform holds for an order. Stored in whatever shape the platform keeps
 * them (a phone typed at checkout may be "077 123 4567"), so `identityMatches` normalises before comparing.
 */
export interface OrderOwner {
  email?: string | undefined;
  phone?: string | undefined;
  externalCustomerId?: string | undefined;
}

function withCountryCode(countryCode: string, national: string): string | null {
  // Without the length check "+94 (0) 77 123 4567" would become a valid-looking but wrong number.
  if (countryCode === SRI_LANKA && national.length !== SRI_LANKA_NATIONAL_DIGITS) return null;
  const phone = `+${countryCode}${national}`;
  return E164.test(phone) ? phone : null;
}

/**
 * Normalises a shopper-typed or platform-stored phone number to E.164, or null. Spaces, dashes, dots and
 * parentheses are ignored. Without a "+", a single leading 0 (national format) or the default country code is
 * read as `defaultCountryCode`: "077 123 4567" and "94771234567" both become "+94771234567". Any other
 * "+<country code>…" number is kept when it has a valid E.164 shape. Never throws.
 */
export function normalizePhone(input: string, defaultCountryCode = SRI_LANKA): string | null {
  if (typeof input !== "string" || input.length > MAX_PHONE_INPUT) return null;
  const compact = input.replace(/[\s\-().]/g, "");
  if (compact.startsWith("+")) {
    if (!E164.test(compact)) return null;
    const digits = compact.slice(1);
    return digits.startsWith(SRI_LANKA)
      ? withCountryCode(SRI_LANKA, digits.slice(SRI_LANKA.length))
      : compact;
  }
  if (!/^\d+$/.test(compact) || !COUNTRY_CODE.test(defaultCountryCode)) return null;
  const national = /^0([1-9]\d*)$/.exec(compact)?.[1];
  if (national !== undefined) return withCountryCode(defaultCountryCode, national);
  if (compact.startsWith(defaultCountryCode)) {
    return withCountryCode(defaultCountryCode, compact.slice(defaultCountryCode.length));
  }
  return null;
}

/**
 * Case-folds the ASCII letters only. `toLowerCase()` would also map look-alikes such as U+212A KELVIN SIGN to
 * ASCII "k", letting one mailbox be matched as another.
 */
function foldEmail(value: string): string {
  return value.trim().replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/**
 * Trims and lower-cases an email address, or returns null when it is not one. Plus tags and dots are kept: they
 * are not equivalent on every mail provider. Validation runs before folding. Never throws.
 */
export function normalizeEmail(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length > MAX_EMAIL_LENGTH || !EmailSchema.safeParse(trimmed).success) return null;
  return foldEmail(trimmed);
}

function emailsMatch(identityEmail: string | undefined, ownerEmail: string | undefined): boolean {
  if (identityEmail === undefined || ownerEmail === undefined) return false;
  const wanted = foldEmail(identityEmail);
  return wanted !== "" && wanted === foldEmail(ownerEmail);
}

function phonesMatch(identityPhone: string | undefined, ownerPhone: string | undefined): boolean {
  if (identityPhone === undefined || ownerPhone === undefined) return false;
  const wanted = normalizePhone(identityPhone);
  return wanted !== null && wanted === normalizePhone(ownerPhone);
}

function customerIdsMatch(identityId: string | undefined, ownerId: string | undefined): boolean {
  return identityId !== undefined && identityId !== "" && identityId === ownerId;
}

/**
 * Whether `identity` proves ownership of an order held by `owner`. Matching is tied to `identity.method`, so only
 * the identifier that method verified is compared:
 * - `email_otp` → `owner.email` (ASCII case-folded).
 * - `phone_otp` → `owner.phone` (both sides normalised to E.164).
 * - `host_session` → `owner.externalCustomerId`, or `owner.email` / `owner.phone` when the identity carries them
 *   (the engine copies only host-verified values into a host_session identity).
 * Anything else fails closed.
 */
export function identityMatches(identity: VerifiedIdentity, owner: OrderOwner): boolean {
  switch (identity.method) {
    case "email_otp":
      return emailsMatch(identity.email, owner.email);
    case "phone_otp":
      return phonesMatch(identity.phone, owner.phone);
    case "host_session":
      return (
        customerIdsMatch(identity.externalCustomerId, owner.externalCustomerId) ||
        emailsMatch(identity.email, owner.email) ||
        phonesMatch(identity.phone, owner.phone)
      );
    default:
      return false;
  }
}
