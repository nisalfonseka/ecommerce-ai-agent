import { describe, expect, it } from "vitest";
import { LEXICON } from "./lexicon";
import { normalizeQuery, queryFingerprint } from "./query";
import { VOCAB } from "./vocabulary";

describe("normalizeQuery", () => {
  it("rewrites Singlish into catalog English and keeps unknown words", () => {
    const out = normalizeQuery("Kalu GAWUMA wedding ekata");
    expect(out.text).toContain("black dress wedding");
    expect(out.text).toBe("black dress wedding ekata");
    expect(out.terms).toEqual(["black", "dress", "wedding", "ekata"]);
  });

  it("rewrites Sinhala and Tamil", () => {
    expect(normalizeQuery("කළු ගවුම").text).toBe("black dress");
    expect(normalizeQuery("சிவப்பு சேலை").text).toBe("red saree");
  });

  it("maps multi-word phrases before single words (longest match)", () => {
    expect(normalizeQuery("sudu kamisa office eka").text).toBe("white shirt office");
    expect(normalizeQuery("mangalya eka").text).toBe("wedding");
  });

  it("keeps a zero-width joiner inside a Sinhala word", () => {
    // ෆ්\u200dරොක් (frock) is written with a ZWJ (rakaransaya); it must stay one token and match.
    const frock = "ෆ්\u200dරොක්";
    expect(normalizeQuery(`රතු ${frock}`)).toEqual({ text: "red frock", terms: ["red", "frock"] });
  });

  it("passes unknown words through, punctuation dropped, terms unique", () => {
    expect(normalizeQuery("Linen, linen!! blazer?")).toEqual({
      text: "linen linen blazer",
      terms: ["linen", "blazer"],
    });
    expect(normalizeQuery("  ?! ")).toEqual({ text: "", terms: [] });
  });
});

describe("LEXICON", () => {
  it("targets only catalog vocabulary", () => {
    const vocab = new Set<string>(Object.values(VOCAB).flat());
    for (const [key, target] of Object.entries(LEXICON)) {
      expect(vocab.has(target), `${key} → ${target}`).toBe(true);
    }
  });

  it("keys are already normalised (NFKC, lowercase, single spaces)", () => {
    for (const key of Object.keys(LEXICON)) {
      expect(key).toBe(key.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " "));
    }
  });

  it("covers the required words", () => {
    const required: Record<string, string> = {
      gawuma: "dress",
      gauma: "dress",
      sariya: "saree",
      saree: "saree",
      kamisa: "shirt",
      kamisaya: "shirt",
      kalisama: "trousers",
      sarama: "sarong",
      kalu: "black",
      sudu: "white",
      rathu: "red",
      nil: "blue",
      kola: "green",
      kaha: "yellow",
      rosa: "pink",
      dhamburu: "brown",
      mangalya: "wedding",
      "wedding eka": "wedding",
      "office eka": "office",
      cotton: "cotton",
      kapu: "cotton",
      ගවුම: "dress",
      සාරිය: "saree",
      කමිසය: "shirt",
      කලිසම: "trousers",
      සරම: "sarong",
      කළු: "black",
      සුදු: "white",
      රතු: "red",
      නිල්: "blue",
      කොළ: "green",
      මංගල: "wedding",
      சேலை: "saree",
      சட்டை: "shirt",
      கால்சட்டை: "trousers",
      உடை: "dress",
      கருப்பு: "black",
      வெள்ளை: "white",
      சிவப்பு: "red",
      நீலம்: "blue",
      பச்சை: "green",
      திருமண: "wedding",
    };
    for (const [key, target] of Object.entries(required)) {
      expect(LEXICON[key.normalize("NFKC")], key).toBe(target);
    }
  });
});

describe("queryFingerprint", () => {
  it("is stable across key order and differs by query or filters", () => {
    const a = queryFingerprint("black dress", { options: { size: ["M"] }, priceMax: 100 });
    expect(a).toHaveLength(12);
    expect(queryFingerprint("black dress", { priceMax: 100, options: { size: ["M"] } })).toBe(a);
    expect(queryFingerprint("red dress", { options: { size: ["M"] }, priceMax: 100 })).not.toBe(a);
    expect(queryFingerprint("black dress", { options: { size: ["L"] }, priceMax: 100 })).not.toBe(a);
    expect(queryFingerprint(undefined, {})).not.toBe(queryFingerprint("", { inStockOnly: true }));
  });
});
