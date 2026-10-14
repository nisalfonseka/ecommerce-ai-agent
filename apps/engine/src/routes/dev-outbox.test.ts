import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createConversationTokens } from "../auth/conversation-token";
import { createDevOutbox } from "../identity/dev-outbox";
import { createLogger } from "../log";
import { registerDevOutboxRoute } from "./dev-outbox";

const ORIGIN = "https://shop.test";
const headers = {
  authorization: "Bearer pk_dev_test",
  origin: ORIGIN,
};

function appWithOutbox(enabled: boolean) {
  const app = createApp({
    logger: createLogger({ level: "silent" }),
    ping: async () => true,
    resolveWidgetKey: async (key) =>
      key === "pk_dev_test" ? { tenantId: "tenant-a", botId: "bot-a", allowedOrigins: [ORIGIN] } : null,
  });
  const tokens = createConversationTokens("s".repeat(40));
  const outbox = createDevOutbox();
  registerDevOutboxRoute(app, enabled ? { outbox, tokens } : null);
  return { app, outbox, tokens };
}

describe("GET /v1/dev/outbox", () => {
  it("returns only the latest code message for the authenticated conversation", async () => {
    const { app, outbox, tokens } = appWithOutbox(true);
    const conversationId = "616069d8-cec7-48d9-b8d0-2f3f94b80ac9";
    outbox.record({
      tenantId: "tenant-a",
      conversationId,
      channel: "email",
      text: "Your verification code is 123456.",
    });
    const token = tokens.sign({ tenantId: "tenant-a", conversationId });
    const response = await app.request(`/v1/dev/outbox?conversation=${conversationId}`, {
      headers: { ...headers, "x-conversation-token": token },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messages: [{ channel: "email", text: "Your verification code is 123456." }],
    });
    expect(
      (
        await app.request(`/v1/dev/outbox?conversation=${conversationId}`, {
          headers: { ...headers, "x-conversation-token": "forged" },
        })
      ).status,
    ).toBe(404);
  });

  it("is not registered when development outbox access is disabled", async () => {
    const { app } = appWithOutbox(false);
    const response = await app.request("/v1/dev/outbox?conversation=616069d8-cec7-48d9-b8d0-2f3f94b80ac9", {
      headers,
    });
    expect(response.status).toBe(404);
  });
});
