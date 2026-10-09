import { describe, expect, it } from "vitest";
import { CAPABILITIES, type Capability, requireCapability } from "./capabilities";
import { CommerceError } from "./errors";

describe("capabilities", () => {
  it("lists each capability once", () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    expect(CAPABILITIES).toContain("orders.lookup");
  });

  it("requireCapability passes when declared", () => {
    const provider = { platform: "test", capabilities: new Set<Capability>(["cart.write"]) };
    expect(() => requireCapability(provider, "cart.write")).not.toThrow();
  });

  it("requireCapability throws NOT_SUPPORTED when missing", () => {
    const provider = { platform: "test", capabilities: new Set<Capability>() };
    try {
      requireCapability(provider, "orders.lookup");
      expect.unreachable("requireCapability should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CommerceError);
      expect(error).toMatchObject({ code: "NOT_SUPPORTED", details: { capability: "orders.lookup" } });
    }
  });
});
