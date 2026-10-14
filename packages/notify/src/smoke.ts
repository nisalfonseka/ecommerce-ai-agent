import { createNotifier } from "./index";

export function parseSmokeArgs(args: string[]): { sms: string; email: string } {
  if (!args.includes("--yes")) throw new Error("Refusing to send: pass --yes explicitly.");
  const smsIndex = args.indexOf("--sms");
  const emailIndex = args.indexOf("--email");
  const sms = smsIndex >= 0 ? args[smsIndex + 1] : undefined;
  const email = emailIndex >= 0 ? args[emailIndex + 1] : undefined;
  if (!sms) throw new Error("--sms is required.");
  if (!email) throw new Error("--email is required.");
  return { sms, email };
}

async function main(): Promise<void> {
  const destinations = parseSmokeArgs(process.argv.slice(2));
  const notifier = createNotifier(process.env);
  await notifier.sendSms({ to: destinations.sms, text: "Your notification provider test was successful." });
  await notifier.sendEmail({
    to: destinations.email,
    subject: "Notification provider test",
    text: "Your notification provider test was successful.",
  });
  console.info("SMS and email test notifications accepted by their providers.");
}

if (process.argv[1]?.endsWith("/smoke.ts"))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Notification smoke failed.");
    process.exitCode = 1;
  });
