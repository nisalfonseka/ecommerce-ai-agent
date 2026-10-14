import { maskDestination } from "./mask";
import type { Notifier } from "./notifier";

export function createLogNotifier(log: (line: string) => void): Notifier {
  return {
    async sendSms({ to }) {
      log(`notification sms to ${maskDestination(to)}`);
      return { providerId: null };
    },
    async sendEmail({ to }) {
      log(`notification email to ${maskDestination(to)}`);
      return { providerId: null };
    },
  };
}
