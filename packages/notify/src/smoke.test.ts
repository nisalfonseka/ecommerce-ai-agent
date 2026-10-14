import { describe, expect, it } from "vitest";
import { parseSmokeArgs } from "./smoke";

describe("notification smoke arguments", () => {
  it("requires explicit confirmation and both destinations", () => {
    expect(() => parseSmokeArgs(["--sms", "+94771234567", "--email", "a@example.com"])).toThrow(/--yes/);
    expect(() => parseSmokeArgs(["--yes", "--email", "a@example.com"])).toThrow(/--sms/);
    expect(() => parseSmokeArgs(["--yes", "--sms", "+94771234567"])).toThrow(/--email/);
    expect(parseSmokeArgs(["--yes", "--sms", "+94771234567", "--email", "a@example.com"])).toEqual({
      sms: "+94771234567",
      email: "a@example.com",
    });
  });
});
