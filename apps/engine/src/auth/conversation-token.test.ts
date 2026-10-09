import { describe, expect, it } from "vitest";
import { createConversationTokens } from "./conversation-token";

const tokens = createConversationTokens("x".repeat(40));
const a = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
};

describe("conversation tokens", () => {
  it("verifies its own token and binds tenant and conversation", () => {
    expect(tokens.verify(tokens.sign(a))).toEqual(a);
  });

  it("rejects tampering, other secrets and garbage", () => {
    const token = tokens.sign(a);
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...a, conversationId: "33333333-3333-4333-8333-333333333333" }),
    ).toString("base64url");
    expect(tokens.verify(`${forged}.${mac}`)).toBeNull();
    expect(tokens.verify(`${payload}.${mac?.slice(0, -2)}xx`)).toBeNull();
    expect(createConversationTokens("y".repeat(40)).verify(token)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", ".", `${payload}.`]) expect(tokens.verify(bad), bad).toBeNull();
  });
});
