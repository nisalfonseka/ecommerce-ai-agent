import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Tx } from "../client";
import { tenantSettings } from "../schema";

export interface RetentionSettings {
  messagesDays: number;
  tracesDays: number;
  handoffDays: number;
  /** Hours, not days: one-time codes are short-lived. */
  otpHours: number;
}

export interface OtpSettings {
  /** Calling codes without "+", e.g. "94". SMS goes only to these (blocks SMS pumping to premium ranges). */
  allowedCountryCodes: string[];
  channels: ("sms" | "email")[];
}

/** Defaults from AGENTS.md (messages 180 days, traces 30 days, OTP records 24 hours) and workflow §K. */
export const DEFAULT_RETENTION: Readonly<RetentionSettings> = {
  messagesDays: 180,
  tracesDays: 30,
  handoffDays: 180,
  otpHours: 24,
};

/** A tenant may shorten retention (or lengthen it within the legal ceiling), never remove it. */
export const RETENTION_RANGES: Readonly<Record<keyof RetentionSettings, { min: number; max: number }>> = {
  messagesDays: { min: 30, max: 730 },
  tracesDays: { min: 7, max: 90 },
  handoffDays: { min: 30, max: 730 },
  otpHours: { min: 1, max: 72 },
};

export const DEFAULT_OTP: Readonly<OtpSettings> = {
  allowedCountryCodes: ["94"],
  channels: ["sms", "email"],
};

const RETENTION_KEYS = Object.keys(DEFAULT_RETENTION) as (keyof RetentionSettings)[];

const countryCodes = z.array(z.string().regex(/^[0-9]{1,4}$/)).max(50);
const channels = z.array(z.enum(["sms", "email"])).max(2);
const cloneOtp = (otp: Readonly<OtpSettings>): OtpSettings => ({
  allowedCountryCodes: [...otp.allowedCountryCodes],
  channels: [...otp.channels],
});

/** Write-side shapes: out-of-range values are rejected so the dashboard can tell the merchant. */
const retentionPatchSchema = z.strictObject(
  Object.fromEntries(
    RETENTION_KEYS.map((key) => [
      key,
      z.number().int().min(RETENTION_RANGES[key].min).max(RETENTION_RANGES[key].max).optional(),
    ]),
  ) as Record<keyof RetentionSettings, z.ZodOptional<z.ZodNumber>>,
);

export const tenantSettingsPatchSchema = z
  .strictObject({
    retention: retentionPatchSchema,
    handoffEmails: z.array(z.email()).max(10),
    // No defaults here: an otp patch is merged into the stored object, so a field it leaves out must stay as it
    // is. The defaults are applied when settings are read (storedOtpSchema).
    otp: z.strictObject({
      allowedCountryCodes: countryCodes.optional(),
      channels: channels.optional(),
    }),
    requireConsent: z.boolean(),
    privacyNoticeUrl: z
      .url({ protocol: /^https?$/ })
      .max(2_000)
      .nullable(),
    contactInfo: z.string().trim().max(500).nullable(),
  })
  .partial();

/**
 * Top-level fields that are present replace the stored ones (a `handoffEmails` array is replaced as a whole);
 * absent fields are left alone. `retention` and `otp` are objects and are merged key by key: a patch that names
 * only `otpHours` keeps a stored `messagesDays`.
 */
export type TenantSettingsPatch = z.input<typeof tenantSettingsPatchSchema>;

/** Read-side shapes: a corrupt stored value falls back to the default instead of breaking the tenant. */
const storedRetentionSchema = z
  .object(
    Object.fromEntries(RETENTION_KEYS.map((key) => [key, z.number().optional().catch(undefined)])) as Record<
      keyof RetentionSettings,
      z.ZodCatch<z.ZodOptional<z.ZodNumber>>
    >,
  )
  .catch({});
const storedOtpSchema = z
  .object({
    allowedCountryCodes: countryCodes.catch(() => [...DEFAULT_OTP.allowedCountryCodes]),
    channels: channels.catch(() => [...DEFAULT_OTP.channels]),
  })
  .catch(() => cloneOtp(DEFAULT_OTP));

export interface TenantSettings {
  /** The stored overrides only (nothing clamped, nothing defaulted); read it through getRetention(). */
  retention: Partial<RetentionSettings>;
  handoffEmails: string[];
  otp: OtpSettings;
  requireConsent: boolean;
  privacyNoticeUrl: string | null;
  /** Shown on "not sure" answers when no person is reachable. */
  contactInfo: string | null;
  /** The sealed secret is deliberately not part of this object (see getHostSessionSecretSealed). */
  hasHostSessionSecret: boolean;
}

type SettingsRow = Pick<
  typeof tenantSettings.$inferSelect,
  | "retention"
  | "handoffEmails"
  | "otp"
  | "requireConsent"
  | "privacyNoticeUrl"
  | "contactInfo"
  | "hostSessionSecretSealed"
>;

/** A tenant without a settings row gets the defaults (consent required, Sri Lanka SMS only, no alerts). */
export function toTenantSettings(row: SettingsRow | null): TenantSettings {
  if (!row) {
    return {
      retention: {},
      handoffEmails: [],
      otp: cloneOtp(DEFAULT_OTP),
      requireConsent: true,
      privacyNoticeUrl: null,
      contactInfo: null,
      hasHostSessionSecret: false,
    };
  }
  const stored = storedRetentionSchema.parse(row.retention);
  const retention: Partial<RetentionSettings> = {};
  for (const key of RETENTION_KEYS) {
    const value = stored[key];
    if (value !== undefined) retention[key] = value;
  }
  return {
    retention,
    handoffEmails: row.handoffEmails,
    otp: storedOtpSchema.parse(row.otp),
    requireConsent: row.requireConsent,
    privacyNoticeUrl: row.privacyNoticeUrl,
    contactInfo: row.contactInfo,
    hasHostSessionSecret: row.hostSessionSecretSealed !== null,
  };
}

/**
 * The effective retention: stored values clamped to RETENTION_RANGES, defaults for the rest. Tolerant on
 * purpose, because the purge job must never fail (or keep data too long) on a malformed settings row.
 */
export function getRetention(settings: { retention: unknown }): RetentionSettings {
  const stored = storedRetentionSchema.parse(settings.retention);
  const result = { ...DEFAULT_RETENTION };
  for (const key of RETENTION_KEYS) {
    const value = stored[key];
    if (value === undefined) continue;
    const { min, max } = RETENTION_RANGES[key];
    result[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return result;
}

/** RLS limits the select to the current tenant's single row. */
export async function getTenantSettings(tx: Tx): Promise<TenantSettings> {
  const [row] = await tx.select().from(tenantSettings).limit(1);
  return toTenantSettings(row ?? null);
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

/**
 * `column || patch` for a jsonb object column. It runs inside the upsert statement, so concurrent patches
 * cannot overwrite each other's keys, and a stored value that is not an object (corrupt) is replaced by `{}`
 * first instead of being nested into an array.
 */
function mergeJsonb(column: PgColumn, patch: object): SQL {
  return sql`case when jsonb_typeof(${column}) = 'object' then ${column} else '{}'::jsonb end || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * Creates the tenant's row on first use and applies `patch` (see TenantSettingsPatch for the merge rules).
 * Validates `patch`; throws a ZodError on an invalid one.
 */
export async function upsertTenantSettings(
  tx: Tx,
  tenantId: string,
  patch: TenantSettingsPatch,
): Promise<TenantSettings> {
  const parsed = tenantSettingsPatchSchema.parse(patch);
  const scalars: Partial<typeof tenantSettings.$inferInsert> = {};
  if (parsed.handoffEmails !== undefined) scalars.handoffEmails = parsed.handoffEmails;
  if (parsed.requireConsent !== undefined) scalars.requireConsent = parsed.requireConsent;
  if (parsed.privacyNoticeUrl !== undefined) scalars.privacyNoticeUrl = parsed.privacyNoticeUrl;
  if (parsed.contactInfo !== undefined) scalars.contactInfo = parsed.contactInfo;
  const retention = parsed.retention === undefined ? undefined : definedEntries(parsed.retention);
  const otp = parsed.otp === undefined ? undefined : definedEntries(parsed.otp);
  const [row] = await tx
    .insert(tenantSettings)
    .values({ tenantId, ...scalars, ...(retention && { retention }), ...(otp && { otp }) })
    .onConflictDoUpdate({
      target: tenantSettings.tenantId,
      set: {
        ...scalars,
        ...(retention && { retention: mergeJsonb(tenantSettings.retention, retention) }),
        ...(otp && { otp: mergeJsonb(tenantSettings.otp, otp) }),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("tenant settings upsert returned no row");
  return toTenantSettings(row);
}

/** sealSecret() output, or null. Only the host-session verifier reads this; it is not in TenantSettings. */
export async function getHostSessionSecretSealed(tx: Tx): Promise<Buffer | null> {
  const [row] = await tx
    .select({ sealed: tenantSettings.hostSessionSecretSealed })
    .from(tenantSettings)
    .limit(1);
  return row?.sealed ?? null;
}

/** Pass null to turn host-session sign-in off for the tenant. */
export async function setHostSessionSecret(tx: Tx, tenantId: string, sealed: Buffer | null): Promise<void> {
  await tx
    .insert(tenantSettings)
    .values({ tenantId, hostSessionSecretSealed: sealed })
    .onConflictDoUpdate({
      target: tenantSettings.tenantId,
      set: { hostSessionSecretSealed: sealed, updatedAt: new Date() },
    });
}
