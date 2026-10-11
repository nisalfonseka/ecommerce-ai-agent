import { setImmediate as nextTurn } from "node:timers/promises";
import { getDocumentProxy } from "unpdf";
import { KnowledgeSourceError } from "./errors";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;
/** For the whole extraction, loading included. */
export const PDF_DEADLINE_MS = 20_000;
const PAGE_BREAK = "\n\n";

export type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

export interface PdfTextOptions {
  /** Default PDF_DEADLINE_MS. */
  deadlineMs?: number;
  /** Test seam: reads one page's text. Defaults to pdfPageText. */
  pageText?: (pdf: PdfDocument, pageNumber: number) => Promise<string>;
}

/** One page's text, items joined as unpdf's extractText joins them. */
export async function pdfPageText(pdf: PdfDocument, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  try {
    const { items } = await page.getTextContent();
    return items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
  } finally {
    page.cleanup();
  }
}

/**
 * The text of a base64 PDF, pages joined by blank lines, with bounded work: at most MAX_PDF_BYTES, at most
 * MAX_PDF_PAGES (checked from the page count before any text is read → pdf_too_long), pages read one at a time
 * and stopping at the first page that takes the text over `maxChars` (→ too_large), and one deadline for the
 * whole extraction (→ pdf_timeout), after which the pdf.js loading task is destroyed.
 *
 * pdf.js runs on this thread here (unpdf's build has no worker) and its internal messages are microtasks, so
 * the deadline timer can only fire between pages, never inside one page's parsing. Each page is therefore
 * preceded by a turn of the event loop and a clock check, and the clock is checked once more after the last
 * page. One pathological page still runs to its end before the timeout is reported (measured: ~1 s for an
 * 80 KB one-page PDF of compressed path operators, linear in size); only a worker thread could stop it.
 */
export async function pdfToText(
  base64: string,
  maxChars: number,
  options: PdfTextOptions = {},
): Promise<string> {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_PDF_BYTES) throw new KnowledgeSourceError("too_large");
  const deadlineMs = options.deadlineMs ?? PDF_DEADLINE_MS;
  const pageText = options.pageText ?? pdfPageText;
  const deadlineAt = Date.now() + deadlineMs;
  const pastDeadline = () => Date.now() >= deadlineAt;

  // The bundled pdf.js no longer compiles font programs with eval (the CVE-2024-4367 path is gone).
  // Verbosity 0 (errors only): pdf.js writes warnings straight to the console, outside the redacting logger.
  const loading = getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const work = (async () => {
    let pdf: PdfDocument;
    try {
      pdf = await loading;
    } catch {
      throw new KnowledgeSourceError("bad_pdf");
    }
    if (pastDeadline()) throw new KnowledgeSourceError("pdf_timeout");
    if (pdf.numPages > MAX_PDF_PAGES) throw new KnowledgeSourceError("pdf_too_long");
    const pages: string[] = [];
    let length = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      await nextTurn();
      if (pastDeadline()) throw new KnowledgeSourceError("pdf_timeout");
      let text: string;
      try {
        text = await pageText(pdf, pageNumber);
      } catch {
        throw new KnowledgeSourceError("bad_pdf");
      }
      length += (pages.length > 0 ? PAGE_BREAK.length : 0) + text.length;
      pages.push(text);
      // Counted before normalisation (CR, NUL, trim), so the stop is at worst a little early.
      if (length > maxChars) throw new KnowledgeSourceError("too_large");
    }
    // The last page may have run past the deadline without the timer getting a turn: still a timeout.
    if (pastDeadline()) throw new KnowledgeSourceError("pdf_timeout");
    return pages.join(PAGE_BREAK);
  })();
  // After the deadline the work is abandoned; its own rejection (often a destroyed-document error) is expected.
  work.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KnowledgeSourceError("pdf_timeout")), deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    // On success, failure or expiry. Once the loading task is destroyed, pdf.js calls still pending on the
    // document reject, so abandoned work stops at its next step. A document still loading is destroyed when
    // it resolves.
    loading.then(
      (pdf) => pdf.loadingTask.destroy().catch(() => undefined),
      () => undefined,
    );
  }
}
