import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args";

describe("parseCliArgs", () => {
  it("parses models, only and output path", () => {
    expect(parseCliArgs(["--models", "google:a,openai:b", "--only", "si", "--out", "r.md"])).toEqual({
      models: ["google:a", "openai:b"],
      only: "si",
      out: "r.md",
    });
  });

  it("defaults to nulls", () => {
    expect(parseCliArgs([])).toEqual({ models: null, only: null, out: null });
  });

  it("ignores a bare -- separator added by pnpm", () => {
    expect(parseCliArgs(["--", "--only", "ta"])).toEqual({ models: null, only: "ta", out: null });
  });

  it("rejects unknown flags", () => {
    expect(() => parseCliArgs(["--model", "x"])).toThrow();
  });
});
