import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

function script(attrs: Record<string, string>, src = "https://cdn.example.lk/ace.js"): HTMLScriptElement {
  const el = document.createElement("script");
  el.src = src;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

describe("readConfig", () => {
  it("reads the key and API origin from the script tag", () => {
    expect(readConfig(script({ "data-key": "pk_live_abc", "data-api": "https://api.example.lk/" }))).toEqual({
      key: "pk_live_abc",
      api: "https://api.example.lk",
    });
  });

  it("defaults the API to the script's own origin", () => {
    expect(readConfig(script({ "data-key": "pk_live_abc" }))?.api).toBe("https://cdn.example.lk");
  });

  it("refuses a missing or malformed key and non-http API URLs", () => {
    expect(readConfig(null)).toBeNull();
    expect(readConfig(script({}))).toBeNull();
    expect(readConfig(script({ "data-key": "sk_secret" }))).toBeNull();
    expect(readConfig(script({ "data-key": "pk_live_abc", "data-api": "javascript:alert(1)" }))).toBeNull();
  });
});
