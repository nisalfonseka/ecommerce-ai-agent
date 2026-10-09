import { describe, expect, it } from "vitest";
import {
  checkUserMessage,
  extractPriceMentions,
  findUngroundedAmounts,
  MAX_USER_MESSAGE_CHARS,
  shopperAmounts,
} from "./guardrails";

describe("checkUserMessage", () => {
  it("rejects empty and oversized messages", () => {
    expect(checkUserMessage("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkUserMessage("x".repeat(MAX_USER_MESSAGE_CHARS + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(checkUserMessage("black dress?")).toEqual({ ok: true });
  });
});

describe("extractPriceMentions", () => {
  it.each([
    ["It is LKR 18,500.00 today", [1850000]],
    ["Rs. 18,500/= only", [1850000]],
    ["Rs 5900 and Rs.6,500", [590000, 650000]],
    ["මිල රු. 12,900 යි", [1290000]],
    ["விலை ரூ. 7,900", [790000]],
    ["18500 rupees", [1850000]],
    ["රුපියල් 20,000ට අඩු", [2000000]],
    ["price 18,500/-", [1850000]],
    ["விலை 18,500 ரூபாய்", [1850000]],
    ["20,000 ரூபாய்க்குள்", [2000000]],
    ["18,500 රුපියල්", [1850000]],
    ["මිල 18,500 රු.", [1850000]],
    ["Size 32 waist, 2 items, order ACE-1001", []],
    ["Comes in 2 colours 3 sizes", []],
  ])("%s", (text, expected) => {
    expect(extractPriceMentions(text)).toEqual(expected);
  });
});

describe("shopperAmounts", () => {
  it("reads every number the shopper wrote as rupees, with or without a currency", () => {
    expect(shopperAmounts("black dress under 20,000, max Rs. 18500.50")).toEqual([2000000, 1850050]);
    expect(shopperAmounts("20000ta adu")).toEqual([2000000]);
    expect(shopperAmounts("no numbers")).toEqual([]);
  });
});

describe("findUngroundedAmounts", () => {
  it("returns only amounts no tool reported", () => {
    const observed = new Set([1850000]);
    expect(findUngroundedAmounts("Only LKR 18,500.00, was Rs. 25,000", observed)).toEqual([2500000]);
    expect(findUngroundedAmounts("No prices here", observed)).toEqual([]);
  });
});
