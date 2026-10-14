import { codeForStatus, type Notifier, NotifyError } from "./notifier";

const URL = "https://api.brevo.com/v3/smtp/email";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createBrevoEmail(opts: {
  apiKey: string;
  sender: { name: string; email: string };
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Pick<Notifier, "sendEmail"> {
  const request = opts.fetch ?? fetch;
  return {
    async sendEmail({ to, subject, text }) {
      if (!EMAIL.test(to)) throw new NotifyError("invalid_destination", "Email destination is invalid.");
      let response: Response;
      try {
        // Deliberately no retries: callers own deduplication and retry policy.
        response = await request(URL, {
          method: "POST",
          headers: { "api-key": opts.apiKey, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ sender: opts.sender, to: [{ email: to }], subject, textContent: text }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch (cause) {
        throw new NotifyError("unavailable", "Email provider is unavailable.", cause);
      }
      const body = (await response.json().catch(() => null)) as { messageId?: unknown } | null;
      if (!response.ok)
        throw new NotifyError(codeForStatus(response.status), "Email provider rejected the request.");
      return { providerId: typeof body?.messageId === "string" ? body.messageId : null };
    },
  };
}
