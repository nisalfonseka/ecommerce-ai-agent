import { describe, expect, it } from "vitest";
import { hasApiKey, parseModelSpec, resolveModel } from "./models";

describe("models", () => {
  it("parses provider:model specs", () => {
    expect(parseModelSpec("google:gemini-flash-latest")).toEqual({
      provider: "google",
      modelId: "gemini-flash-latest",
    });
    expect(parseModelSpec("anthropic:claude-sonnet-5-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
  });

  it("rejects unknown providers and malformed specs", () => {
    for (const bad of ["mistral:large", "gemini-flash-latest", "openai:", ":gpt-5.5"]) {
      expect(() => parseModelSpec(bad), bad).toThrow();
    }
  });

  it("checks for API keys without reading their values into output", () => {
    expect(hasApiKey("openai", { OPENAI_API_KEY: "sk-test" })).toBe(true);
    expect(hasApiKey("openai", { OPENAI_API_KEY: "" })).toBe(false);
    expect(hasApiKey("google", {})).toBe(false);
  });

  it("builds a model object without calling the network", () => {
    expect(resolveModel("openai:gpt-5.5")).toMatchObject({ modelId: "gpt-5.5" });
  });
});
