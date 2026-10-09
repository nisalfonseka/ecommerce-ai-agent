import { callTool, say, scriptedModel } from "@ace/agent/testing";
import { describe, expect, it } from "vitest";
import { runCase } from "./runner";
import type { EvalCase } from "./types";

const persona = { assistantName: "Nila", storeName: "Demo", languages: ["English"] };
const store = { currency: "LKR" };

const evalCase: EvalCase = {
  id: "en-add-first",
  language: "en",
  tags: ["cart"],
  description: "search then add #1 (Black Satin Wrap Dress sorts first)",
  turns: [
    { user: "show me dresses", expect: { toolsCalled: ["search_products"] } },
    {
      user: "the first one in M please",
      expect: { toolsCalled: ["add_to_cart"], cartContains: ["p_wrap_dress_black_m"] },
    },
  ],
};

describe("runCase", () => {
  it("runs multi-turn cases against a fresh memory store and scores each turn", async () => {
    const model = scriptedModel([
      callTool("c1", "search_products", { category: "dress" }),
      say("Two dresses: #1 and #2."),
      callTool("c2", "add_to_cart", { ref: "#1", size: "M" }),
      say("Added the dress in M."),
    ]);
    const result = await runCase(evalCase, { model, modelSpec: "mock:scripted", persona, store });
    expect(result.error).toBeUndefined();
    expect(result.turns).toHaveLength(2);
    expect(result.passed).toBe(true);
    expect(result.turns[1]?.cart?.lines[0]?.variantId).toBe("p_wrap_dress_black_m");
  });

  it("records a thrown error as a failed case", async () => {
    const model = scriptedModel([]);
    const result = await runCase(evalCase, { model, modelSpec: "mock:empty", persona, store });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("applies seed and identity setup", async () => {
    const model = scriptedModel([
      callTool("c1", "lookup_order", { orderNumber: "ACE-1001" }),
      say("It has shipped."),
    ]);
    const result = await runCase(
      {
        id: "order",
        language: "en",
        tags: ["orders"],
        description: "verified lookup",
        setup: {
          identity: {
            method: "email_otp",
            email: "customer@example.com",
            verifiedAt: "2026-10-01T00:00:00.000Z",
          },
        },
        turns: [{ user: "where is ACE-1001?", expect: { mentions: ["shipped"] } }],
      },
      { model, modelSpec: "mock", persona, store },
    );
    expect(result.passed).toBe(true);
  });
});
