import { describe, expect, it } from "vitest";
import { type Chunk, chunkText } from "./chunk";

function sentences(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `${prefix} rule ${i + 1} applies to items bought from branch number ${i + 1} within seven days.`,
  );
}

function paragraphs(lines: string[], perParagraph = 4): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += perParagraph) out.push(lines.slice(i, i + perParagraph).join(" "));
  return out.join("\n\n");
}

const exchanges = sentences("Exchange", 70);
const refunds = sentences("Refund", 50);
const shipping = sentences("Shipping", 12);
const POLICY = [
  "# Returns",
  "",
  "## Exchanges",
  "",
  paragraphs(exchanges),
  "",
  "## Refunds",
  "",
  paragraphs(refunds),
  "",
  "# Shipping",
  "",
  paragraphs(shipping),
].join("\n");

/** Length of the longest suffix of `prev` (≥ 20 chars) that `next` starts with; 0 when there is none. */
function overlapLength(prev: string, next: string): number {
  for (let k = Math.min(prev.length, next.length); k >= 20; k--) {
    if (next.startsWith(prev.slice(-k))) return k;
  }
  return 0;
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

describe("chunkText", () => {
  const chunks = chunkText(POLICY);

  it("keeps every chunk within 700 tokens and numbers them in order", () => {
    expect(chunks.length).toBeGreaterThan(4);
    chunks.forEach((chunk, i) => {
      expect(chunk.seq).toBe(i);
      expect(chunk.tokenEstimate).toBe(Math.ceil(chunk.text.length / 4));
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(700);
    });
  });

  it("carries the heading path on each chunk", () => {
    const headings = [...new Set(chunks.map((c) => c.heading))];
    expect(headings).toEqual(["Returns > Exchanges", "Returns > Refunds", "Shipping"]);
    expect(chunks.filter((c) => c.heading === "Returns > Exchanges").length).toBeGreaterThan(1);
  });

  it("overlaps consecutive chunks of one section, never across sections", () => {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1] as Chunk;
      const next = chunks[i] as Chunk;
      const overlap = overlapLength(prev.text, next.text);
      if (prev.heading === next.heading) {
        expect(overlap, `chunk ${i}`).toBeGreaterThan(0);
        expect(Math.ceil(overlap / 4), `chunk ${i}`).toBeLessThanOrEqual(60);
      } else {
        expect(overlap, `chunk ${i}`).toBe(0);
      }
    }
  });

  it("reproduces every sentence when joined without the overlap", () => {
    const parts = chunks.map((chunk, i) => {
      const prev = chunks[i - 1];
      const overlap = prev && prev.heading === chunk.heading ? overlapLength(prev.text, chunk.text) : 0;
      return chunk.text.slice(overlap);
    });
    const joined = normalise(parts.join(" "));
    for (const sentence of [...exchanges, ...refunds, ...shipping]) expect(joined).toContain(sentence);
    // Without the overlap nothing is repeated.
    for (const sentence of exchanges) expect(joined.split(sentence).length - 1).toBe(1);
  });

  it("puts text before the first heading under a null heading", () => {
    const [first] = chunkText("Welcome to our store.\n\n# Returns\n\nExchanges within 7 days.");
    expect(first).toMatchObject({ heading: null, text: "Welcome to our store." });
  });

  it("splits unpunctuated text and very long words without exceeding the limit", () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const giant = "x".repeat(9000);
    for (const chunk of chunkText(`# Long\n\n${words}\n\n${giant}`)) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(700);
    }
  });

  it("returns no chunks for empty or heading-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n# Only a heading\n")).toEqual([]);
  });
});
