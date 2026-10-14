import { describe, expect, it, vi } from "vitest";
import {
  createBrevoEmail,
  createLogNotifier,
  createNotifier,
  createTextLkSms,
  maskDestination,
  NotifyError,
} from "./index";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("text.lk", () => {
  it("sends the documented request and returns the uid", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ status: "success", data: { uid: "sms_1" } }),
    );
    const sender = createTextLkSms({ apiToken: "secret-token", senderId: "Shop", fetch });
    await expect(sender.sendSms({ to: "+94771234567", text: "code 123456" })).resolves.toEqual({
      providerId: "sms_1",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://app.text.lk/api/v3/sms/send");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: "94771234567",
        sender_id: "Shop",
        type: "plain",
        message: "code 123456",
      }),
    });
  });

  it.each([
    [401, {}, "unauthorized"],
    [422, {}, "rejected"],
    [429, {}, "rate_limited"],
    [503, {}, "unavailable"],
    [200, { status: "error", message: "contains secret-token and code 123456" }, "rejected"],
  ] as const)("maps status %s without leaking input", async (status, body, code) => {
    const sender = createTextLkSms({
      apiToken: "secret-token",
      senderId: "Shop",
      fetch: async () => json(body, status),
    });
    const error = await sender.sendSms({ to: "+94771234567", text: "code 123456" }).catch((e) => e);
    expect(error).toBeInstanceOf(NotifyError);
    expect(error.code).toBe(code);
    expect(String(error)).not.toMatch(/secret-token|123456|94771234567/);
  });

  it("rejects malformed destinations before fetch and maps network errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("network");
    });
    const sender = createTextLkSms({ apiToken: "token", senderId: "Shop", fetch });
    await expect(sender.sendSms({ to: "0771234567", text: "x" })).rejects.toMatchObject({
      code: "invalid_destination",
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(sender.sendSms({ to: "+14155552671", text: "x" })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("Brevo", () => {
  it("sends the documented request and returns messageId", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ messageId: "mail_1" }, 201));
    const sender = createBrevoEmail({
      apiKey: "brevo-secret",
      sender: { name: "Shop", email: "help@example.com" },
      fetch,
    });
    await expect(sender.sendEmail({ to: "a@example.com", subject: "Code", text: "123456" })).resolves.toEqual(
      {
        providerId: "mail_1",
      },
    );
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "api-key": "brevo-secret", Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: "Shop", email: "help@example.com" },
        to: [{ email: "a@example.com" }],
        subject: "Code",
        textContent: "123456",
      }),
    });
  });

  it.each([
    [401, "unauthorized"],
    [400, "rejected"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ] as const)("maps %s", async (status, code) => {
    const sender = createBrevoEmail({
      apiKey: "secret",
      sender: { name: "Shop", email: "help@example.com" },
      fetch: async () => json({ message: "private body" }, status),
    });
    await expect(
      sender.sendEmail({ to: "a@example.com", subject: "s", text: "private body" }),
    ).rejects.toMatchObject({ code });
  });
});

describe("factory, log mode and masking", () => {
  it("masks destinations and never logs bodies", async () => {
    expect(maskDestination("+94771234567")).toBe("+94*****4567");
    expect(maskDestination("alice@example.com")).toBe("a***@e***.com");
    const lines: string[] = [];
    const notifier = createLogNotifier((line) => lines.push(line));
    await notifier.sendSms({ to: "+94771234567", text: "secret code" });
    await notifier.sendEmail({ to: "alice@example.com", subject: "private subject", text: "private body" });
    expect(lines.join(" ")).not.toMatch(
      /94771234567|alice@example\.com|secret code|private subject|private body/,
    );
  });

  it("enforces factory variables and keeps log mode out of production", () => {
    expect(() => createNotifier({ NODE_ENV: "production", ACE_NOTIFY_MODE: "log" })).toThrow(
      /ACE_NOTIFY_MODE/,
    );
    expect(() => createNotifier({ NODE_ENV: "development" })).toThrow(/TEXTLK_API_TOKEN/);
    expect(() => createNotifier({ NODE_ENV: "development", TEXTLK_API_TOKEN: "x" })).toThrow(
      /TEXTLK_SENDER_ID/,
    );
    expect(() =>
      createNotifier({ NODE_ENV: "development", TEXTLK_API_TOKEN: "x", TEXTLK_SENDER_ID: "s" }),
    ).toThrow(/BREVO_API_KEY/);
    expect(createNotifier({ NODE_ENV: "development", ACE_NOTIFY_MODE: "log" })).toBeDefined();
  });
});
