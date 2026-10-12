import { describe, expect, it } from "vitest";
import { createModelResolver } from "./models";

describe("createModelResolver", () => {
  it("serves the demo model only when allowed", () => {
    expect(createModelResolver({ allowDemo: true })("demo:search-only")).toMatchObject({ provider: "demo" });
    expect(() => createModelResolver({ allowDemo: false })("demo:search-only")).toThrow(/demo/);
  });

  it("resolves provider specs from bot config and caches them", () => {
    const resolve = createModelResolver({ allowDemo: false });
    const model = resolve("openai:gpt-5.5");
    expect(model).toMatchObject({ modelId: "gpt-5.5" });
    expect(resolve("openai:gpt-5.5")).toBe(model);
    expect(() => resolve("mistral:large")).toThrow();
  });
});
