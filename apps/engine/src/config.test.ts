import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const valid = {
  DATABASE_URL: "postgres://ace_app:pw@localhost:5432/ace",
  ACE_MASTER_KEY: randomBytes(32).toString("base64"),
  ADMIN_API_KEY_SHA256: "a".repeat(64),
  CONVERSATION_TOKEN_SECRET: "s".repeat(40),
};

describe("loadConfig", () => {
  it("parses a valid environment with defaults", () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(8080);
    expect(config.masterKey).toHaveLength(32);
    expect(config.trustProxyHops).toBe(1);
  });

  it("names the bad variable without echoing secret values", () => {
    const short = randomBytes(16).toString("base64");
    let message = "";
    try {
      loadConfig({ ...valid, ACE_MASTER_KEY: short });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ACE_MASTER_KEY");
    expect(message).not.toContain(short);
    expect(() => loadConfig({ ...valid, CONVERSATION_TOKEN_SECRET: "short" })).toThrow(
      /CONVERSATION_TOKEN_SECRET/,
    );
  });
});
