import { codeForStatus, type Notifier, NotifyError } from "./notifier";

const URL = "https://app.text.lk/api/v3/sms/send";
const E164 = /^\+[1-9]\d{7,14}$/;

interface TextLkResponse {
  status?: unknown;
  data?: { uid?: unknown };
}

export function createTextLkSms(opts: {
  apiToken: string;
  senderId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Pick<Notifier, "sendSms"> {
  const request = opts.fetch ?? fetch;
  return {
    async sendSms({ to, text }) {
      if (!E164.test(to)) throw new NotifyError("invalid_destination", "SMS destination is invalid.");
      let response: Response;
      try {
        // Deliberately no retries: a repeated SMS costs money and may deliver the same code twice.
        response = await request(URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            recipient: to.slice(1),
            sender_id: opts.senderId,
            type: "plain",
            message: text,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch (cause) {
        throw new NotifyError("unavailable", "SMS provider is unavailable.", cause);
      }
      const body = (await response.json().catch(() => null)) as TextLkResponse | null;
      if (!response.ok)
        throw new NotifyError(codeForStatus(response.status), "SMS provider rejected the request.");
      if (body?.status !== "success") throw new NotifyError("rejected", "SMS provider rejected the request.");
      return { providerId: typeof body.data?.uid === "string" ? body.data.uid : null };
    },
  };
}
