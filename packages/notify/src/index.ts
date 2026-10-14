import { createBrevoEmail } from "./brevo";
import { createLogNotifier } from "./log";
import type { Notifier } from "./notifier";
import { createTextLkSms } from "./textlk";

export * from "./brevo";
export * from "./log";
export * from "./mask";
export * from "./notifier";
export * from "./textlk";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function createNotifier(env: Record<string, string | undefined>): Notifier {
  if (env.ACE_NOTIFY_MODE === "log") {
    if (env.NODE_ENV === "production") throw new Error("ACE_NOTIFY_MODE=log is forbidden in production.");
    return createLogNotifier((line) => console.info(line));
  }
  const sms = createTextLkSms({
    apiToken: required(env, "TEXTLK_API_TOKEN"),
    senderId: required(env, "TEXTLK_SENDER_ID"),
  });
  const email = createBrevoEmail({
    apiKey: required(env, "BREVO_API_KEY"),
    sender: { name: required(env, "BREVO_SENDER_NAME"), email: required(env, "BREVO_SENDER_EMAIL") },
  });
  return { sendSms: sms.sendSms, sendEmail: email.sendEmail };
}
