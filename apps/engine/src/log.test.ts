import { describe, expect, it } from "vitest";
import { createLogger } from "./log";

describe("createLogger", () => {
  it("redacts emails and phone numbers in messages, fields and errors", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", write: (line) => lines.push(line) });
    log.info({ query: "mail a@b.lk", nested: { phone: "+94771234567" } }, "shopper 0771234567 asked");
    log.error({ err: new Error("lookup failed for a@b.lk") }, "boom");
    const out = lines.join("\n");
    expect(out).not.toMatch(/a@b\.lk|94771234567|0771234567/);
    expect(out).toContain("[email]");
    expect(out).toContain("[phone]");
    expect(out).toContain("lookup failed for [email]");
  });
});
