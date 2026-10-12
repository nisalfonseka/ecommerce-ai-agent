import { describe, expect, it } from "vitest";
import { initialState, reduce, statusLabel } from "./state";

describe("conversation state", () => {
  it("tracks a turn: user message, status, reply with UI and cart", () => {
    let s = reduce(initialState(null), { type: "user_sent", text: "black dress" });
    expect(s.sending).toBe(true);
    s = reduce(s, { type: "conversation", conversation: { conversationId: "c1", conversationToken: "t1" } });
    s = reduce(s, { type: "status", tool: "search_products" });
    expect(s.status).toBe(statusLabel("search_products"));
    s = reduce(s, { type: "reply", text: "Here you go.", ui: [], cartId: "cart_1" });
    expect(s).toMatchObject({
      sending: false,
      status: null,
      cartId: "cart_1",
      conversation: { conversationId: "c1" },
    });
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "black dress"],
      ["assistant", "Here you go."],
    ]);
  });

  it("keeps the cart id when a reply has none, and records errors", () => {
    let s = reduce(initialState("cart_host"), { type: "user_sent", text: "hi" });
    s = reduce(s, { type: "reply", text: "Hello", ui: [], cartId: null });
    expect(s.cartId).toBe("cart_host");
    s = reduce(s, { type: "user_sent", text: "again" });
    s = reduce(s, { type: "error", message: "Try again." });
    expect(s).toMatchObject({ sending: false, error: "Try again." });
  });

  it("adds action results as assistant UI and restores history", () => {
    let s = reduce(initialState(null), {
      type: "restored",
      messages: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "Hello!", ui: [] },
      ],
    });
    expect(s.messages).toHaveLength(2);
    s = reduce(s, { type: "action_result", ui: [], cartId: "cart_2" });
    expect(s.cartId).toBe("cart_2");
  });
});
