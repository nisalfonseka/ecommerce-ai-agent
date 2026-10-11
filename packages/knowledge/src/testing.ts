import { deflateSync } from "node:zlib";

export interface TestPdfOptions {
  /** Content stream of each page (PDF operators), one entry per page. */
  pages: string[];
  /** Deflate the content streams (FlateDecode). */
  compress?: boolean;
}

/** A page content stream that draws each line of `lines` in Helvetica. */
export function textPage(lines: string[]): string {
  const ops = lines.map((line) => `(${line.replace(/[\\()]/g, (ch) => `\\${ch}`)}) Tj T*`);
  return `BT /F1 12 Tf 14 TL 72 720 Td ${ops.join(" ")} ET`;
}

/**
 * Builds a minimal, valid PDF 1.4 (catalog, one Pages node, Helvetica, one content stream per page, correct
 * xref) for tests. Identical content streams are stored once and shared, so a 1,000-page PDF stays small.
 */
export function makePdf({ pages, compress = false }: TestPdfOptions): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => {
    objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return objects.length;
  };
  const catalog = add("");
  const pagesNode = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const streams = new Map<string, number>();
  const pageIds: number[] = [];
  for (const content of pages) {
    let stream = streams.get(content);
    if (stream === undefined) {
      const raw = Buffer.from(content, "latin1");
      const data = compress ? deflateSync(raw) : raw;
      const filter = compress ? " /Filter /FlateDecode" : "";
      stream = add(
        Buffer.concat([
          Buffer.from(`<< /Length ${data.length}${filter} >>\nstream\n`, "latin1"),
          data,
          Buffer.from("\nendstream", "latin1"),
        ]),
      );
      streams.set(content, stream);
    }
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesNode} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesNode} 0 R >>`, "latin1");
  objects[pagesNode - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
    "latin1",
  );

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const obj = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(obj);
    offset += obj.length;
  });
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>`,
    "startxref",
    String(offset),
    "%%EOF",
    "",
  ].join("\n");
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}
