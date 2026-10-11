import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeSourceError } from "./errors";
import { extractText, htmlToText, KnowledgeSourceSchema } from "./extract";
import { makePdf, textPage } from "./testing";

const PDF_BASE64 = readFileSync(new URL("./__fixtures__/policy.pdf", import.meta.url)).toString("base64");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KnowledgeSourceError) return error.code;
    throw error;
  }
  throw new Error("expected a KnowledgeSourceError");
}

describe("extractText", () => {
  it("passes markdown through, normalising line endings", async () => {
    expect(
      await extractText({ type: "markdown", text: "# Returns\r\n\r\nExchanges within 7 days.\r\n" }),
    ).toEqual({ text: "# Returns\n\nExchanges within 7 days.", sourceUrl: null });
  });

  it("extracts the text of a PDF", async () => {
    const { text, sourceUrl } = await extractText({ type: "pdf", base64: PDF_BASE64 });
    expect(text).toContain("Exchanges within 7 days");
    expect(sourceUrl).toBeNull();
  });

  it("refuses a file that is not a PDF, and empty text", async () => {
    const notPdf = Buffer.from("hello, not a pdf").toString("base64");
    expect(await codeOf(extractText({ type: "pdf", base64: notPdf }))).toBe("bad_pdf");
    expect(await codeOf(extractText({ type: "markdown", text: "  \n\n " }))).toBe("empty");
  });

  it("refuses text that has headings only, because it chunks to nothing", async () => {
    for (const text of ["# Title", "# Returns\n\n## Exchanges\n", "### Care ###"]) {
      expect(await codeOf(extractText({ type: "markdown", text })), text).toBe("empty");
    }
    const fetchUrl = async () => ({
      body: "<h1>Returns</h1><nav>Home</nav>",
      contentType: "text/html",
      finalUrl: "x",
    });
    expect(await codeOf(extractText({ type: "url", url: "https://shop.example.lk/r" }, fetchUrl))).toBe(
      "empty",
    );
  });

  it("refuses a PDF with more than 300 pages", async () => {
    const pdf = makePdf({ pages: new Array<string>(301).fill(textPage(["Exchanges within 7 days"])) });
    expect(await codeOf(extractText({ type: "pdf", base64: pdf.toString("base64") }))).toBe("pdf_too_long");
  });

  it("fetches a URL with the given fetcher and converts HTML to text", async () => {
    const fetchUrl = vi.fn(async () => ({
      body: "<nav>Home | Shop</nav><h1>Returns</h1><p>Exchanges within 7 days.</p><script>alert(1)</script>",
      contentType: "text/html",
      finalUrl: "https://shop.example.lk/returns",
    }));
    const result = await extractText({ type: "url", url: "https://shop.example.lk/returns?ref=1" }, fetchUrl);
    expect(fetchUrl).toHaveBeenCalledWith("https://shop.example.lk/returns?ref=1");
    expect(result).toEqual({
      text: "# Returns\n\nExchanges within 7 days.",
      sourceUrl: "https://shop.example.lk/returns?ref=1",
    });
  });

  it("keeps fetched markdown and plain text as they are", async () => {
    const fetchUrl = async () => ({ body: "# A\n\n<b>b</b>", contentType: "text/markdown", finalUrl: "x" });
    expect((await extractText({ type: "url", url: "https://shop.example.lk/a.md" }, fetchUrl)).text).toBe(
      "# A\n\n<b>b</b>",
    );
  });
});

describe("KnowledgeSourceSchema", () => {
  it("bounds markdown at 200,000 characters and PDFs at 10 MB decoded", () => {
    expect(KnowledgeSourceSchema.safeParse({ type: "markdown", text: "a".repeat(200_000) }).success).toBe(
      true,
    );
    expect(KnowledgeSourceSchema.safeParse({ type: "markdown", text: "a".repeat(200_001) }).success).toBe(
      false,
    );
    const elevenMb = Buffer.alloc(11 * 1024 * 1024).toString("base64");
    expect(KnowledgeSourceSchema.safeParse({ type: "pdf", base64: elevenMb }).success).toBe(false);
    expect(KnowledgeSourceSchema.safeParse({ type: "pdf", base64: "not base64!" }).success).toBe(false);
    expect(KnowledgeSourceSchema.safeParse({ type: "url", url: "https://shop.example.lk/" }).success).toBe(
      true,
    );
    expect(KnowledgeSourceSchema.safeParse({ type: "docx", data: "" }).success).toBe(false);
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles, navigation, headers, footers and svg", () => {
    const html = `<!doctype html><html><head><title>Policy</title><style>p { color: red }</style></head>
      <body><header><a href="/">Logo</a></header><nav><ul><li>Home</li><li>Shop</li></ul></nav>
      <noscript>Enable JS</noscript><svg><text>icon</text></svg>
      <main><p>Exchanges within 7 days.</p><script type="text/javascript">alert("<p>x</p>")</script></main>
      <footer>© Shop</footer></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Exchanges within 7 days.");
    for (const dropped of ["alert", "color: red", "Logo", "Home", "Shop", "Enable JS", "icon", "©"]) {
      expect(text).not.toContain(dropped);
    }
  });

  it("turns headings into # lines and block ends into newlines", () => {
    const text = htmlToText(
      "<h1>Returns</h1><h2>Exchanges</h2><p>Within 7 days.</p><p>Unworn items.<br>Tags on.</p><ul><li>Dresses</li><li>Shirts</li></ul><div>Contact us</div>",
    );
    expect(text).toBe(
      "# Returns\n\n## Exchanges\n\nWithin 7 days.\n\nUnworn items.\nTags on.\n\nDresses\nShirts\n\nContact us",
    );
  });

  it("decodes common and numeric entities and collapses whitespace", () => {
    expect(
      htmlToText(
        "<p>Shirts   &amp;\n  dresses &lt;3 &quot;new&quot; it&#39;s&nbsp;here &#8364;5 &#x20AC;6</p>",
      ),
    ).toBe(`Shirts & dresses <3 "new" it's here €5 €6`);
  });

  it("does not turn escaped markup into tags, and skips comments and attributes with >", () => {
    expect(htmlToText(`<p title="a > b">&lt;script&gt;x&lt;/script&gt;</p><!-- <p>hidden</p> -->`)).toBe(
      "<script>x</script>",
    );
  });

  it("handles nested dropped elements and unclosed tags", () => {
    expect(htmlToText("<nav><nav>a</nav>b</nav><p>kept")).toBe("kept");
    expect(htmlToText("<p>text <script>never closed")).toBe("text");
  });
});
