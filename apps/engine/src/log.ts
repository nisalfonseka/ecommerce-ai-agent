import { redactDeep, redactPii } from "@ace/db";
import pino, { type Logger } from "pino";

/** pino with PII redaction on every message, field and error (AGENTS.md: never log raw PII). */
export function createLogger(options: { level: string; write?: (line: string) => void }): Logger {
  const destination = options.write ? { write: options.write } : undefined;
  return pino(
    {
      level: options.level,
      hooks: {
        logMethod(args, method) {
          const redacted = args.map((arg) => {
            if (typeof arg === "string") return redactPii(arg);
            if (arg instanceof Error) return { err: { name: arg.name, message: redactPii(arg.message) } };
            if (typeof arg === "object" && arg !== null) {
              const record = arg as Record<string, unknown>;
              const err = record.err;
              const rest = redactDeep(record) as Record<string, unknown>;
              if (err instanceof Error) {
                rest.err = {
                  name: err.name,
                  message: redactPii(err.message),
                  stack: err.stack && redactPii(err.stack),
                };
              }
              return rest;
            }
            return arg;
          });
          method.apply(this, redacted as Parameters<typeof method>);
        },
      },
    },
    destination,
  );
}
