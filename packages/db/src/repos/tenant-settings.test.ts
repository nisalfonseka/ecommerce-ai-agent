import { describe, expect, it } from "vitest";
import {
  DEFAULT_OTP,
  DEFAULT_RETENTION,
  getRetention,
  tenantSettingsPatchSchema,
  toTenantSettings,
} from "./tenant-settings";

describe("toTenantSettings", () => {
  it("returns the defaults when a tenant has no settings row", () => {
    expect(toTenantSettings(null)).toEqual({
      retention: {},
      handoffEmails: [],
      otp: { allowedCountryCodes: ["94"], channels: ["sms", "email"] },
      requireConsent: true,
      privacyNoticeUrl: null,
      contactInfo: null,
      hasHostSessionSecret: false,
    });
  });

  it("falls back field by field when stored jsonb is corrupt, so one bad row cannot break a tenant", () => {
    const settings = toTenantSettings({
      retention: "forever",
      handoffEmails: [],
      otp: { allowedCountryCodes: ["94", "+1 555"], channels: ["push"] },
      requireConsent: true,
      privacyNoticeUrl: null,
      contactInfo: null,
      hostSessionSecretSealed: null,
    });
    expect(settings.retention).toEqual({});
    expect(settings.otp).toEqual(DEFAULT_OTP);
  });

  it("keeps a valid tightened otp configuration, including an empty channel list", () => {
    const settings = toTenantSettings({
      retention: { messagesDays: 90 },
      handoffEmails: ["support@shop.lk"],
      otp: { allowedCountryCodes: [], channels: ["email"] },
      requireConsent: false,
      privacyNoticeUrl: "https://shop.lk/privacy",
      contactInfo: "Call 011 234 5678",
      hostSessionSecretSealed: Buffer.from("sealed"),
    });
    expect(settings).toEqual({
      retention: { messagesDays: 90 },
      handoffEmails: ["support@shop.lk"],
      otp: { allowedCountryCodes: [], channels: ["email"] },
      requireConsent: false,
      privacyNoticeUrl: "https://shop.lk/privacy",
      contactInfo: "Call 011 234 5678",
      hasHostSessionSecret: true,
    });
  });

  it("never carries the sealed host-session secret itself", () => {
    const settings = toTenantSettings({
      retention: {},
      handoffEmails: [],
      otp: DEFAULT_OTP,
      requireConsent: true,
      privacyNoticeUrl: null,
      contactInfo: null,
      hostSessionSecretSealed: Buffer.from("sealed"),
    });
    expect(JSON.stringify(settings)).not.toContain("sealed");
    expect(Object.keys(settings)).not.toContain("hostSessionSecretSealed");
  });
});

describe("getRetention", () => {
  it("uses the documented defaults for anything that is not set", () => {
    expect(getRetention({ retention: {} })).toEqual(DEFAULT_RETENTION);
    expect(DEFAULT_RETENTION).toEqual({ messagesDays: 180, tracesDays: 30, handoffDays: 180, otpHours: 24 });
  });

  it("clamps out-of-range values to the nearest bound", () => {
    expect(
      getRetention({ retention: { messagesDays: 5, tracesDays: 365, handoffDays: 99_999, otpHours: 0 } }),
    ).toEqual({
      messagesDays: 30,
      tracesDays: 90,
      handoffDays: 730,
      otpHours: 1,
    });
    expect(
      getRetention({ retention: { messagesDays: 4000, tracesDays: 1, handoffDays: -3, otpHours: 500 } }),
    ).toEqual({
      messagesDays: 730,
      tracesDays: 7,
      handoffDays: 30,
      otpHours: 72,
    });
  });

  it("keeps in-range values, rounding fractions", () => {
    expect(
      getRetention({ retention: { messagesDays: 45, tracesDays: 14.6, handoffDays: 365, otpHours: 2 } }),
    ).toEqual({
      messagesDays: 45,
      tracesDays: 15,
      handoffDays: 365,
      otpHours: 2,
    });
  });

  it("falls back to the default for values that are not finite numbers", () => {
    expect(
      getRetention({
        retention: { messagesDays: "90", tracesDays: Number.NaN, handoffDays: null, otpHours: {} },
      }),
    ).toEqual(DEFAULT_RETENTION);
    expect(getRetention({ retention: null })).toEqual(DEFAULT_RETENTION);
  });
});

describe("tenantSettingsPatchSchema", () => {
  it("accepts a partial update", () => {
    const parsed = tenantSettingsPatchSchema.parse({
      retention: { messagesDays: 90, otpHours: 12 },
      handoffEmails: ["a@shop.lk"],
      privacyNoticeUrl: null,
    });
    expect(parsed.retention).toEqual({ messagesDays: 90, otpHours: 12 });
  });

  it("rejects out-of-range retention, so the dashboard gets feedback instead of a silent clamp", () => {
    for (const retention of [
      { messagesDays: 29 },
      { messagesDays: 731 },
      { tracesDays: 6 },
      { tracesDays: 91 },
      { handoffDays: 29 },
      { otpHours: 0 },
      { otpHours: 73 },
      { messagesDays: 90.5 },
    ]) {
      expect(tenantSettingsPatchSchema.safeParse({ retention }).success, JSON.stringify(retention)).toBe(
        false,
      );
    }
  });

  it("rejects unknown keys, bad emails, bad country codes and non-http notice URLs", () => {
    for (const patch of [
      { tenantId: "00000000-0000-4000-8000-000000000001" },
      { handoffEmails: ["not-an-email"] },
      { otp: { allowedCountryCodes: ["+94"], channels: ["sms"] } },
      { otp: { allowedCountryCodes: ["94"], channels: ["whatsapp"] } },
      { privacyNoticeUrl: "javascript:alert(1)" },
      { contactInfo: "x".repeat(501) },
    ]) {
      expect(tenantSettingsPatchSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("keeps a partial otp patch partial, so it merges instead of resetting the other field", () => {
    const parsed = tenantSettingsPatchSchema.parse({ otp: { channels: ["email"] } });
    expect(parsed.otp).toEqual({ channels: ["email"] });
    expect(tenantSettingsPatchSchema.parse({ otp: { allowedCountryCodes: ["94"] } }).otp).toEqual({
      allowedCountryCodes: ["94"],
    });
  });

  it("reads a partly stored otp object with the default for the missing field", () => {
    const settings = toTenantSettings({
      retention: {},
      handoffEmails: [],
      otp: { channels: ["email"] },
      requireConsent: true,
      privacyNoticeUrl: null,
      contactInfo: null,
      hostSessionSecretSealed: null,
    });
    expect(settings.otp).toEqual({ allowedCountryCodes: ["94"], channels: ["email"] });
  });
});
