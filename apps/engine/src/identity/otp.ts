import { randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeEmail, normalizePhone, type VerifiedIdentity } from "@ace/contracts";
import {
  appendMessages,
  consumeVerification,
  countRecentStarts,
  createVerification,
  type Db,
  getLatestUnconsumedVerification,
  getTenantSettings,
  loadMessages,
  lockVerificationStart,
  openSecret,
  reserveAttempt,
  saveConversationIdentity,
  sealSecret,
  withTenant,
} from "@ace/db";
import { maskDestination, type Notifier, NotifyError } from "@ace/notify";
import type { DevOutbox } from "./dev-outbox";
import { deriveKey, hashCode, identityHash } from "./hash";

const CODE_SECONDS = 10 * 60;
const IDENTITY_SECONDS = 30 * 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const DESTINATION_LIMIT = 3;
const CONVERSATION_LIMIT = 5;
const MAX_ATTEMPTS = 6;
const RANDOM_SPACE = 2 ** 32;
const UNBIASED_LIMIT = Math.floor(RANDOM_SPACE / 1_000_000) * 1_000_000;

export interface OtpDeps {
  db: Db;
  notifier: Notifier;
  masterKey: Buffer;
  now?: () => Date;
  random?: (n: number) => Buffer;
  ipLimiter?: {
    check(key: string): { ok: true } | { ok: false; retryAfterS: number };
  };
  outbox?: Pick<DevOutbox, "record">;
}

export type StartResult =
  | { ok: true; maskedDestination: string; expiresInSeconds: 600 }
  | {
      ok: false;
      reason: "invalid_destination" | "channel_disabled" | "rate_limited" | "unavailable";
      retryAfterSeconds?: number;
    };

export type ConfirmResult =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; reason: "invalid_code" | "expired" | "locked" | "no_pending" };

function normalizeDestination(channel: "sms" | "email", destination: string): string | null {
  return channel === "sms" ? normalizePhone(destination) : normalizeEmail(destination);
}

function allowedPhone(phone: string, countryCodes: string[]): boolean {
  const digits = phone.slice(1);
  return countryCodes.some((code) => digits.startsWith(code));
}

function secureCode(random: (n: number) => Buffer): string {
  for (;;) {
    const bytes = random(4);
    if (bytes.length !== 4) throw new Error("OTP random source returned the wrong number of bytes");
    const value = bytes.readUInt32BE(0);
    if (value < UNBIASED_LIMIT) return String(value % 1_000_000).padStart(6, "0");
  }
}

function otpText(code: string): string {
  return `Your verification code is ${code}. It expires in 10 minutes. Do not share this code.`;
}

export async function startVerification(
  deps: OtpDeps,
  ctx: { tenantId: string; conversationId: string; ip: string; actionId?: string },
  input: { channel: "sms" | "email"; destination: string },
): Promise<StartResult> {
  const now = (deps.now ?? (() => new Date()))();
  const normalized = normalizeDestination(input.channel, input.destination);
  if (!normalized) return { ok: false, reason: "invalid_destination" };

  const key = deriveKey(deps.masterKey, "ace/identity-hash/v1");
  const kind = input.channel === "sms" ? "phone" : "email";
  const destinationHash = identityHash(key, ctx.tenantId, kind, normalized);
  const ipCheck = deps.ipLimiter?.check(`otp:${ctx.tenantId}:${ctx.ip}`) ?? { ok: true as const };
  if (!ipCheck.ok) {
    return { ok: false, reason: "rate_limited", retryAfterSeconds: ipCheck.retryAfterS };
  }

  const random = deps.random ?? randomBytes;
  const code = secureCode(random);
  const salt = random(16).toString("base64url");
  const codeKey = deriveKey(deps.masterKey, "ace/otp/v1");

  try {
    const result = await withTenant(deps.db, ctx.tenantId, async (tx): Promise<StartResult> => {
      const settings = await getTenantSettings(tx);
      if (!settings.otp.channels.includes(input.channel)) return { ok: false, reason: "channel_disabled" };
      if (input.channel === "sms" && !allowedPhone(normalized, settings.otp.allowedCountryCodes)) {
        return { ok: false, reason: "invalid_destination" };
      }

      await lockVerificationStart(tx, ctx.conversationId, destinationHash);
      const since = new Date(now.getTime() - RATE_WINDOW_MS);
      const [destinationStarts, conversationStarts] = await Promise.all([
        countRecentStarts(tx, { destinationHash, since }),
        countRecentStarts(tx, { conversationId: ctx.conversationId, since }),
      ]);
      if (destinationStarts >= DESTINATION_LIMIT || conversationStarts >= CONVERSATION_LIMIT) {
        return { ok: false, reason: "rate_limited", retryAfterSeconds: 3600 };
      }

      await createVerification(tx, ctx.tenantId, {
        conversationId: ctx.conversationId,
        channel: input.channel,
        destinationHash,
        destinationSealed: sealSecret(normalized, deps.masterKey),
        codeHash: hashCode(codeKey, code, salt),
        salt,
        expiresAt: new Date(now.getTime() + CODE_SECONDS * 1000),
      });
      const text = otpText(code);
      if (input.channel === "sms") await deps.notifier.sendSms({ to: normalized, text });
      else await deps.notifier.sendEmail({ to: normalized, subject: "Your verification code", text });
      const response = {
        ok: true as const,
        maskedDestination: maskDestination(normalized),
        expiresInSeconds: 600 as const,
      };
      if (ctx.actionId) {
        const messages = await loadMessages(tx, ctx.conversationId);
        await appendMessages(tx, ctx.tenantId, ctx.conversationId, messages.nextSeq, [
          {
            kind: "action",
            payload: {
              actionId: ctx.actionId,
              type: "verify_start",
              ok: true,
              summary: "verification code sent",
              response,
            },
          },
        ]);
      }
      return response;
    });
    if (result.ok) {
      deps.outbox?.record({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        channel: input.channel,
        text: otpText(code),
      });
    }
    return result;
  } catch (error) {
    if (error instanceof NotifyError) return { ok: false, reason: "unavailable" };
    throw error;
  }
}

export async function confirmVerification(
  deps: OtpDeps,
  ctx: { tenantId: string; conversationId: string; actionId?: string },
  input: { code: string },
): Promise<ConfirmResult> {
  const now = (deps.now ?? (() => new Date()))();
  const codeKey = deriveKey(deps.masterKey, "ace/otp/v1");
  const identityKey = deriveKey(deps.masterKey, "ace/identity-hash/v1");
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const pending = await getLatestUnconsumedVerification(tx, ctx.conversationId);
    if (!pending) return { ok: false, reason: "no_pending" };
    if (pending.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
    if (pending.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };
    const attempt = await reserveAttempt(tx, pending.id, MAX_ATTEMPTS, now);
    if (attempt === null) return { ok: false, reason: "locked" };
    // Five comparisons are allowed. The sixth submission spends the final reservation but is never compared.
    if (attempt >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };

    const expected = Buffer.from(pending.codeHash, "base64url");
    const actual = Buffer.from(hashCode(codeKey, input.code, pending.salt), "base64url");
    const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!matches) return { ok: false, reason: "invalid_code" };
    if (!(await consumeVerification(tx, pending.id, now))) return { ok: false, reason: "no_pending" };

    const destination = openSecret(pending.destinationSealed, deps.masterKey);
    const verifiedAt = now.toISOString();
    const identity: VerifiedIdentity =
      pending.channel === "sms"
        ? { method: "phone_otp", phone: destination, verifiedAt }
        : { method: "email_otp", email: destination, verifiedAt };
    const kind = pending.channel === "sms" ? "phone" : "email";
    const saved = await saveConversationIdentity(tx, ctx.conversationId, {
      identity,
      identityHash: identityHash(identityKey, ctx.tenantId, kind, destination),
      expiresAt: new Date(now.getTime() + IDENTITY_SECONDS * 1000),
    });
    if (!saved) throw new Error("verification conversation disappeared");
    const messages = await loadMessages(tx, ctx.conversationId);
    await appendMessages(tx, ctx.tenantId, ctx.conversationId, messages.nextSeq, [
      {
        kind: "action",
        payload: {
          actionId: ctx.actionId,
          type: "verify_confirm",
          ok: true,
          summary: "shopper identity verified",
          response: { ok: true, verified: true },
        },
      },
    ]);
    return { ok: true, identity };
  });
}
