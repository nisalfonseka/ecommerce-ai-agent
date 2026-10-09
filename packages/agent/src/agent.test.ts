import { MemoryCommerceProvider } from "@ace/adapter-memory";
import type { ModelMessage } from "ai";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AgentInputError, runTurn } from "./agent";
import { createToolContext } from "./context";
import { PROMPT_VERSION } from "./prompt";
import { createSession } from "./session";
import { callTool, say, scriptedModel } from "./testing";

const persona = { assistantName: "Nila", storeName: "Demo Clothing", languages: ["English"] };
const store = { currency: "LKR" };

describe("runTurn", () => {
  it("searches, answers with a grounded price and returns UI parts and messages", async () => {
    const provider = new MemoryCommerceProvider();
    const ctx = createToolContext({ provider, conversationId: "conv", turnId: "t1" });
    const model = scriptedModel([
      callTool("c1", "search_products", { query: "dress", color: "black" }),
      say("#1 is the Black Satin Wrap Dress at LKR 18,500.00."),
    ]);
    const result = await runTurn({ model, ctx, persona, store, history: [], userMessage: "black dress?" });
    expect(result.text).toBe("#1 is the Black Satin Wrap Dress at LKR 18,500.00.");
    expect(result.toolCalls).toEqual([
      { name: "search_products", input: { query: "dress", color: "black" } },
    ]);
    expect(result.ui.map((part) => part.type)).toEqual(["product_list"]);
    expect(result.ungroundedAmounts).toEqual([]);
    expect(result.regenerated).toBe(false);
    expect(result.promptVersion).toBe(PROMPT_VERSION);
    expect(result.newMessages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("keeps #refs across turns so 'the second one in M' adds the right variant", async () => {
    const provider = new MemoryCommerceProvider();
    const session = createSession();
    const history: ModelMessage[] = [];
    const turn1 = createToolContext({ provider, conversationId: "conv", turnId: "t1", session });
    const r1 = await runTurn({
      model: scriptedModel([
        callTool("c1", "search_products", { category: "dress" }),
        say("Here are two dresses."),
      ]),
      ctx: turn1,
      persona,
      store,
      history,
      userMessage: "show me dresses",
    });
    history.push(...r1.newMessages);
    const second = session.shown[1];
    const turn2 = createToolContext({
      provider,
      conversationId: "conv",
      turnId: "t2",
      session,
      cartId: turn1.cartId,
    });
    await runTurn({
      model: scriptedModel([callTool("c1", "add_to_cart", { ref: "#2", size: "M" }), say("Added.")]),
      ctx: turn2,
      persona,
      store,
      history,
      userMessage: "I'll take the second one in M",
    });
    const cart = await provider.getCart(turn2.cartId ?? "");
    expect(cart?.lines.map((line) => line.productId)).toEqual([second?.productId]);
    expect(cart?.lines[0]?.variantTitle).toContain("M");
  });

  it("regenerates once when the reply states a price no tool returned", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "conv",
      turnId: "t1",
    });
    const model = scriptedModel([
      say("That dress is Rs. 999 today!"),
      say("Let me check the current price for you."),
    ]);
    const result = await runTurn({
      model,
      ctx,
      persona,
      store,
      history: [],
      userMessage: "how much is the dress?",
    });
    expect(result.regenerated).toBe(true);
    expect(result.text).toBe("Let me check the current price for you.");
    expect(result.ungroundedAmounts).toEqual([]);
    expect(result.newMessages.at(-1)).toEqual({
      role: "assistant",
      content: "Let me check the current price for you.",
    });
  });

  it("reports amounts that are still ungrounded after the retry", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "conv",
      turnId: "t1",
    });
    const model = scriptedModel([say("Rs. 999"), say("Still Rs. 999")]);
    const result = await runTurn({ model, ctx, persona, store, history: [], userMessage: "price?" });
    expect(result.ungroundedAmounts).toEqual([99900]);
  });

  it("does not flag a budget the shopper wrote in this turn", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "conv",
      turnId: "t1",
    });
    const model = scriptedModel([say("Here are dresses under Rs. 20,000.")]);
    const result = await runTurn({
      model,
      ctx,
      persona,
      store,
      history: [],
      userMessage: "dresses under 20,000?",
    });
    expect(result.regenerated).toBe(false);
    expect(result.ungroundedAmounts).toEqual([]);
  });

  it("rewrites with the tools still declared but disabled, so tool history stays valid", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "conv",
      turnId: "t1",
    });
    const model = scriptedModel([
      callTool("c1", "search_products", { category: "dress" }),
      say("Only Rs. 999!"),
      say("Here are our dresses."),
    ]);
    await runTurn({ model, ctx, persona, store, history: [], userMessage: "dresses" });
    const rewrite = model.doGenerateCalls[2];
    expect(rewrite?.tools?.map((t) => t.name)).toContain("search_products");
    expect(rewrite?.toolChoice).toEqual({ type: "none" });
  });

  it("rejects empty or oversized input before calling the model", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "conv",
      turnId: "t1",
    });
    const model = scriptedModel([say("unused")]);
    await expect(
      runTurn({ model, ctx, persona, store, history: [], userMessage: " " }),
    ).rejects.toBeInstanceOf(AgentInputError);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("retries a failing model once by default (spec §5) and as configured", async () => {
    const failing = () =>
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            message: "overloaded",
            url: "u",
            requestBodyValues: {},
            statusCode: 503,
            isRetryable: true,
          });
        },
      });
    const ctx = () =>
      createToolContext({ provider: new MemoryCommerceProvider(), conversationId: "conv", turnId: "t1" });
    const once = failing();
    await expect(
      runTurn({ model: once, ctx: ctx(), persona, store, history: [], userMessage: "hi" }),
    ).rejects.toThrow();
    expect(once.doGenerateCalls).toHaveLength(2);
    const never = failing();
    await expect(
      runTurn({ model: never, ctx: ctx(), persona, store, history: [], userMessage: "hi", maxRetries: 0 }),
    ).rejects.toThrow();
    expect(never.doGenerateCalls).toHaveLength(1);
  }, 15_000);
});
