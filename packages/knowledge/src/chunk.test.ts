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

  it("strips only a closing run of #s that follows whitespace, as CommonMark does", () => {
    const doc = [
      "# Returns ##",
      "Body one.",
      "## Learn C#",
      "Body two.",
      "### foo#",
      "Body three.",
      "#### Care ###   ",
      "Body four.",
      "# \t Spaced title\t",
      "Body five.",
    ].join("\n\n");
    expect(chunkText(doc).map((chunk) => chunk.heading)).toEqual([
      "Returns",
      "Returns > Learn C#",
      "Returns > Learn C# > foo#",
      "Returns > Learn C# > foo# > Care",
      "Spaced title",
    ]);
  });

  it("keeps a 150-character heading whole", () => {
    const title = `Returns ${"x".repeat(142)}`;
    expect(title).toHaveLength(150);
    expect(chunkText(`# ${title}\n\nBody.`)[0]?.heading).toBe(title);
  });

  it("caps a heading title at 200 characters, cutting on a code-point boundary", () => {
    const heading = (title: string) => chunkText(`# ${title}\n\nBody.`)[0]?.heading;
    expect(heading("a".repeat(200))).toBe("a".repeat(200));
    expect(heading("a".repeat(201))).toBe(`${"a".repeat(199)}…`);
    // An emoji (two UTF-16 units) across the cut is dropped whole, never split into a lone surrogate.
    expect(heading(`${"a".repeat(198)}😀${"b".repeat(10)}`)).toBe(`${"a".repeat(198)}…`);
    expect(heading(`${"a".repeat(197)}😀${"b".repeat(10)}`)).toBe(`${"a".repeat(197)}😀…`);
  });

  it("drops the outermost levels first when the heading path passes 400 characters", () => {
    const [a, b, c] = ["A", "B", "C"].map((letter) => letter.repeat(150));
    const doc = `# ${a}\n\n## ${b}\n\n### ${c}\n\nBody.\n\n## Short\n\nMore.`;
    expect(chunkText(doc).map((chunk) => chunk.heading)).toEqual([`${b} > ${c}`, `${a} > Short`]);
  });

  it("recognises a heading only with 1–6 #s, a space or tab, and some title text", () => {
    for (const line of ["#hashtag", "####### Seven", "#   ", "# ###"]) {
      expect(chunkText(`${line}\n\nBody.`)[0]?.heading, line).toBeNull();
    }
    expect(chunkText("###### Six\n\nBody.")[0]?.heading).toBe("Six");
    expect(chunkText("#\tTabbed\n\nBody.")[0]?.heading).toBe("Tabbed");
  });

  it("splits a long paragraph at sentence ends and line breaks, not at other whitespace", () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Filler sentence number ${i} is here.`).join(" ");
    const paragraph = `Exchanges within 7 days.   Refunds   take five days!\tCall us?  Keep tags  \n  on items। සිංහල වාක්‍යය. ${filler}`;
    expect(paragraph.length).toBeGreaterThan(2000);
    const [first] = chunkText(paragraph);
    expect(first?.text).toMatch(
      /^Exchanges within 7 days\. Refunds {3}take five days! Call us\? Keep tags on items। සිංහල වාක්‍යය\. Filler sentence number 0 is here\. Filler/,
    );
  });
});

// Uploads run chunkText on the engine's request thread, so hostile text must not make it superlinear.
describe("chunkText on hostile input (200,000 chars)", () => {
  const BUDGET_MS = 1000;
  const timed = (text: string) => {
    const started = performance.now();
    const chunks = chunkText(text);
    return { chunks, ms: performance.now() - started };
  };

  it("a run of spaces between two letters", () => {
    const { chunks, ms } = timed(`a${" ".repeat(199_998)}b`);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["a b"]);
  });

  it('a heading line "# a", spaces, "#x" (no closing sequence)', () => {
    const line = `# a${" ".repeat(199_995)}#x`;
    const { chunks, ms } = timed(`${line}\n\nBody.`);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe(`${line.slice(2, 201)}…`);
  });

  it("a 100,000-char top heading over thousands of small sections (no heading-path amplification)", () => {
    const top = `# ${"t".repeat(100_000)}\n`;
    const text = top + "## a\nb\n".repeat(Math.floor((200_000 - top.length) / 7));
    const { chunks, ms } = timed(text);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(chunks.length).toBeGreaterThan(14_000);
    expect(chunks[0]?.heading).toBe(`${"t".repeat(199)}… > a`);
    expect(chunks.every((chunk) => (chunk.heading?.length ?? 0) <= 400)).toBe(true);
    // Uncapped, this was ~14,000 × 100,004 = 1.4 billion characters of headings (V8 ran out of memory).
    expect(chunks.reduce((sum, chunk) => sum + (chunk.heading?.length ?? 0), 0)).toBeLessThan(5_000_000);
  });

  it("a heading line with a line separator in it", () => {
    const { ms } = timed(`# ${" ".repeat(199_990)}a\u2028b\n\nBody.`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('repeated "\\n \\n \\n"', () => {
    const { chunks, ms } = timed("\n \n \n".repeat(40_000));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(chunks).toEqual([]);
  });

  it("a paragraph of whitespace runs that hold no line break", () => {
    const { chunks, ms } = timed(`a${" \t\u00a0".repeat(66_000)}b. c`);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["a b. c"]);
  });
});
