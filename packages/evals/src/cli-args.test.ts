import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args";

describe("parseCliArgs", () => {
  it("parses models, only and output path", () => {
    expect(parseCliArgs(["--models", "google:a,openai:b", "--only", "si", "--out", "r.md"])).toEqual({
      models: ["google:a", "openai:b"],
      only: "si",
      out: "r.md",
      rpm: null,
    });
  });

  it("defaults to nulls", () => {
    expect(parseCliArgs([])).toEqual({ models: null, only: null, out: null, rpm: null });
  });

  it("ignores a bare -- separator added by pnpm", () => {
    expect(parseCliArgs(["--", "--only", "ta"])).toEqual({ models: null, only: "ta", out: null, rpm: null });
  });

  it("parses a positive integer --rpm and rejects anything else", () => {
    expect(parseCliArgs(["--rpm", "5"]).rpm).toBe(5);
    for (const bad of ["0", "-1", "2.5", "five"]) expect(() => parseCliArgs(["--rpm", bad]), bad).toThrow();
  });

  it("rejects unknown flags", () => {
    expect(() => parseCliArgs(["--model", "x"])).toThrow();
  });
});
