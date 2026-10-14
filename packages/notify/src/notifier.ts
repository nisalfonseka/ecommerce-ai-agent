export type NotifyErrorCode =
  | "unauthorized"
  | "rejected"
  | "rate_limited"
  | "unavailable"
  | "invalid_destination";

export class NotifyError extends Error {
  constructor(
    readonly code: NotifyErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NotifyError";
  }
}

export interface Notifier {
  sendSms(input: { to: string; text: string }): Promise<{ providerId: string | null }>;
  sendEmail(input: { to: string; subject: string; text: string }): Promise<{ providerId: string | null }>;
}

export function codeForStatus(status: number): NotifyErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}
