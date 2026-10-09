import { describe, expect, it } from "vitest";
import { composeInstructions, SAFETY_CANARY } from "./prompt";

describe("composeInstructions", () => {
  const text = composeInstructions(
    {
      assistantName: "Nila",
      storeName: "Demo Clothing",
      tone: "warm",
      languages: ["English", "Sinhala", "Tamil", "Singlish"],
    },
    { currency: "LKR", deliveryInfo: "Island-wide delivery in 2–4 days." },
  );

  it("includes persona and store facts", () => {
    for (const part of ["Nila", "Demo Clothing", "warm", "Sinhala", "LKR", "Island-wide delivery"]) {
      expect(text).toContain(part);
    }
  });

  it("states the non-negotiable rules and carries the canary", () => {
    for (const rule of [
      "never state a price",
      "untrusted data",
      "#number",
      "discount",
      "language",
      "check_availability",
    ]) {
      expect(text.toLowerCase()).toContain(rule.toLowerCase());
    }
    expect(text).toContain(SAFETY_CANARY);
  });
});
