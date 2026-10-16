import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { createToolContext, runTurn } from "@ace/agent";
import { describe, expect, it } from "vitest";
import { createDemoModel } from "./demo-model";

describe("createDemoModel", () => {
  it("searches the catalog for the shopper's words and says it is a demo", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
    });
    const result = await runTurn({
      model: createDemoModel(),
      ctx,
      persona: { assistantName: "Nila", storeName: "Demo", languages: ["English"] },
      store: { currency: "LKR" },
      history: [],
      userMessage: "show me black dresses",
    });
    expect(result.toolCalls).toEqual([
      { name: "search_products", input: { query: "show me black dresses" } },
    ]);
    expect(result.ui.map((part) => part.type)).toEqual(["product_list"]);
    expect(result.text).toMatch(/demo mode/i);
    expect(result.ungroundedAmounts).toEqual([]);
  });

  it("uses ready store knowledge for policy questions and cites the source in keyless demos", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
      knowledge: {
        search: async () => [
          {
            documentTitle: "Returns policy",
            heading: "Exchanges",
            text: "Items can be exchanged within 7 days with the receipt.",
            score: 1,
          },
        ],
      },
    });
    const result = await runTurn({
      model: createDemoModel(),
      ctx,
      persona: { assistantName: "Nila", storeName: "Demo", languages: ["English"] },
      store: { currency: "LKR" },
      history: [],
      userMessage: "Can I exchange an item?",
    });
    expect(result.toolCalls).toEqual([
      { name: "search_knowledge", input: { query: "Can I exchange an item?" } },
    ]);
    expect(result.text).toContain("Returns policy › Exchanges");
    expect(result.text).toContain("7 days");
  });

  it("opens the verification form for local order-support demos", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
      verification: { channels: ["sms", "email"] },
    });
    const result = await runTurn({
      model: createDemoModel(),
      ctx,
      persona: { assistantName: "Nila", storeName: "Demo", languages: ["English"] },
      store: { currency: "LKR" },
      history: [],
      userMessage: "Where is order ACE-1001?",
    });
    expect(result.toolCalls).toEqual([{ name: "lookup_order", input: { orderNumber: "ACE-1001" } }]);
    expect(result.ui).toContainEqual({
      type: "verification_form",
      channels: ["sms", "email"],
      reason: "order_lookup",
    });
  });

  it("requests a human for refunds in local handoff demos", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
      handoff: {
        request: async () => ({
          id: "h1",
          created: true,
          expectedResponse: "A team member will reply here.",
        }),
      },
    });
    const result = await runTurn({
      model: createDemoModel(),
      ctx,
      persona: { assistantName: "Nila", storeName: "Demo", languages: ["English"] },
      store: { currency: "LKR" },
      history: [],
      userMessage: "I need a refund for order ACE-1001",
    });
    expect(result.toolCalls).toEqual([
      {
        name: "request_human",
        input: {
          reason: "refund_or_return",
          summary: "Shopper asks for a refund or return in the local demo.",
        },
      },
    ]);
    expect(result.ui).toContainEqual({ type: "handoff", status: "requested" });
  });
});
