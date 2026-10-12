import { describe, expect, it, vi } from "vitest";
import { ApiError, type ChatEvent, createApi } from "./api";

function sseResponse(text: string): Response {
  return new Response(new Blob([text]).stream(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("createApi", () => {
  it("streams chat events in order and sends the key and visitor id", async () => {
    const fetch = vi.fn(async () =>
      sseResponse(
        'event: conversation\ndata: {"conversationId":"c1","conversationToken":"t1"}\n\nevent: status\ndata: {"tool":"search_products"}\n\nevent: reply\ndata: {"text":"Hi","ui":[],"cartId":null}\n\nevent: done\ndata: {}\n\n',
      ),
    );
    const api = createApi({ api: "https://api.test", key: "pk_live_a", visitorId: "visitor-123", fetch });
    const events: ChatEvent[] = [];
    await api.chat({ message: "hello", cartId: "cart_1" }, (event) => events.push(event));
    expect(events.map((e) => e.event)).toEqual(["conversation", "status", "reply", "done"]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/chat");
    expect(init.headers).toMatchObject({ authorization: "Bearer pk_live_a", "x-visitor-id": "visitor-123" });
    expect(JSON.parse(String(init.body))).toEqual({ message: "hello", cartId: "cart_1" });
  });

  it("turns error JSON into a typed ApiError", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { code: "turn_in_progress", message: "busy" } }, { status: 409 }),
    );
    const api = createApi({ api: "https://api.test", key: "pk_live_a", visitorId: "visitor-123", fetch });
    const error = await api.chat({ message: "hi" }, () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "turn_in_progress" });
  });

  it("posts actions and loads a conversation with its token", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("/v1/actions/")
        ? Response.json({ result: { ok: true }, ui: [], cartId: "cart_1" })
        : Response.json({ messages: [] }),
    );
    const api = createApi({ api: "https://api.test", key: "pk_live_a", visitorId: "visitor-123", fetch });
    expect(
      await api.action("add_to_cart", {
        conversationId: "c1",
        conversationToken: "t1",
        actionId: "a1",
        input: {},
      }),
    ).toMatchObject({
      cartId: "cart_1",
    });
    expect(await api.loadConversation("c1", "t1")).toEqual({ messages: [] });
    const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ "x-conversation-token": "t1" });
  });
});
