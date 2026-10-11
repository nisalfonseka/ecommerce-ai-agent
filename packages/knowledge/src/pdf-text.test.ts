import { describe, expect, it, vi } from "vitest";
import { KnowledgeSourceError } from "./errors";
import { MAX_PDF_PAGES, type PdfDocument, pdfPageText, pdfToText } from "./pdf-text";
import { makePdf, textPage } from "./testing";

const MAX_CHARS = 200_000;
const base64 = (pdf: Buffer) => pdf.toString("base64");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KnowledgeSourceError) return error.code;
    throw error;
  }
  throw new Error("expected a KnowledgeSourceError");
}

/** About 3,700 characters of text on one page (40 lines that stay inside the page). */
const FULL_PAGE = textPage(Array.from({ length: 40 }, (_, i) => `Line ${i} ${"x".repeat(110)}`));
/** No text, but ~120,000 path operators: tens of milliseconds of pdf.js work per page. */
const SLOW_PAGE = "0 0 m 1 1 l S ".repeat(120_000);

describe("pdfToText", () => {
  it("extracts the pages one by one, joined by blank lines", async () => {
    const pdf = makePdf({ pages: [textPage(["Returns"]), textPage(["Exchanges within 7 days", "Tags on"])] });
    expect(await pdfToText(base64(pdf), MAX_CHARS)).toBe("Returns\n\nExchanges within 7 days\nTags on");
  });

  it(`refuses more than ${MAX_PDF_PAGES} pages before extracting any text`, async () => {
    const pageText = vi.fn(pdfPageText);
    const tooLong = makePdf({ pages: new Array<string>(MAX_PDF_PAGES + 1).fill(textPage(["Page"])) });
    expect(await codeOf(pdfToText(base64(tooLong), MAX_CHARS, { pageText }))).toBe("pdf_too_long");
    expect(pageText).not.toHaveBeenCalled();

    const atLimit = makePdf({ pages: new Array<string>(MAX_PDF_PAGES).fill(textPage(["Page"])) });
    expect(await pdfToText(base64(atLimit), MAX_CHARS, { pageText })).toContain("Page");
    expect(pageText).toHaveBeenCalledTimes(MAX_PDF_PAGES);
  });

  it("stops at the first page that takes the text over the cap", async () => {
    const pageText = vi.fn(pdfPageText);
    const pdf = makePdf({ pages: new Array<string>(60).fill(FULL_PAGE) });
    expect(await codeOf(pdfToText(base64(pdf), MAX_CHARS, { pageText }))).toBe("too_large");
    const perPage = String(await pageText.mock.results[0]?.value).length;
    expect(perPage).toBeGreaterThan(3_000);
    // k pages hold k·perPage + (k−1)·2 characters (blank-line joins); the first k over the cap is the last read.
    expect(pageText).toHaveBeenCalledTimes(Math.floor((MAX_CHARS + 2) / (perPage + 2)) + 1);
    expect(pageText.mock.calls.length).toBeLessThan(60);
  });

  it("times out between pages of a slow real PDF and reads no page after the deadline", async () => {
    const pageText = vi.fn(pdfPageText);
    const pdf = makePdf({ pages: new Array<string>(30).fill(SLOW_PAGE), compress: true });
    expect(await codeOf(pdfToText(base64(pdf), MAX_CHARS, { deadlineMs: 100, pageText }))).toBe(
      "pdf_timeout",
    );
    const pagesRead = pageText.mock.calls.length;
    expect(pagesRead).toBeGreaterThan(0);
    expect(pagesRead).toBeLessThan(30);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pageText).toHaveBeenCalledTimes(pagesRead);
  });

  it("fails a last page that finishes past the deadline, although the timer could not interrupt it", async () => {
    // Like pdf.js inside one page, this step never yields to timers: the deadline passes while it runs, and is
    // reported late (when the page ends) rather than on time.
    const blockingPage = vi.fn(async () => {
      const end = Date.now() + 300;
      let spins = 0;
      while (Date.now() < end) spins++;
      return `text after ${spins} spins`;
    });
    const pdf = makePdf({ pages: [textPage(["One"])] });
    const started = Date.now();
    expect(await codeOf(pdfToText(base64(pdf), MAX_CHARS, { deadlineMs: 150, pageText: blockingPage }))).toBe(
      "pdf_timeout",
    );
    expect(blockingPage).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("times out a page step that is still running, and destroys the pdf.js loading task", async () => {
    const destroyed = vi.fn();
    let release: () => void = () => undefined;
    const pageText = vi.fn(async (pdf: PdfDocument) => {
      const destroy = pdf.loadingTask.destroy.bind(pdf.loadingTask);
      pdf.loadingTask.destroy = () => {
        destroyed();
        return destroy();
      };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "late text";
    });
    const pdf = makePdf({ pages: [textPage(["One"]), textPage(["Two"])] });
    const started = Date.now();
    expect(await codeOf(pdfToText(base64(pdf), MAX_CHARS, { deadlineMs: 50, pageText }))).toBe("pdf_timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
    await vi.waitFor(() => expect(destroyed).toHaveBeenCalled());
    release(); // the stalled step finishing late does not start the next page
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pageText).toHaveBeenCalledTimes(1);
  });

  it("refuses bytes that are not a PDF, and PDFs over 10 MB", async () => {
    expect(await codeOf(pdfToText(Buffer.from("hello, not a pdf").toString("base64"), MAX_CHARS))).toBe(
      "bad_pdf",
    );
    expect(await codeOf(pdfToText(Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"), MAX_CHARS))).toBe(
      "too_large",
    );
  });
});
