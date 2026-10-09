import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { ALL_TOOLS } from "@ace/agent";
import { describe, expect, it } from "vitest";
import { ALL_CASES } from "./index";

const toolNames = new Set(ALL_TOOLS.map((tool) => tool.name));

describe("golden cases", () => {
  it("has unique ids and at least 30 cases", () => {
    expect(ALL_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
  });

  it("covers every language with at least 5 cases and has safety cases", () => {
    for (const language of ["en", "si", "ta", "singlish"] as const) {
      expect(ALL_CASES.filter((c) => c.language === language).length, language).toBeGreaterThanOrEqual(5);
    }
    expect(ALL_CASES.filter((c) => c.tags.includes("safety")).length).toBeGreaterThanOrEqual(4);
  });

  it("only references tools that exist", () => {
    for (const evalCase of ALL_CASES) {
      for (const turn of evalCase.turns) {
        const named = [
          ...(turn.expect.toolsCalled ?? []),
          ...(turn.expect.toolsNotCalled ?? []),
          ...(turn.expect.toolInput ?? []).map((t) => t.tool),
        ];
        for (const name of named) expect(toolNames.has(name), `${evalCase.id}: ${name}`).toBe(true);
      }
    }
  });

  it("dress searches list the wrap dress as #1 and the maxi dress as #2 (the ordinal cases rely on it)", async () => {
    const provider = new MemoryCommerceProvider();
    for (const input of [{ query: "dress" }, { filters: { category: "dress" } }]) {
      const { items } = await provider.searchProducts(input);
      expect(items.map((item) => item.id)).toEqual(["p_wrap_dress_black", "p_maxi_dress_floral"]);
    }
  });
});
