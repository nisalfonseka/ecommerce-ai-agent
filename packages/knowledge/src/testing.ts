import { deflateSync } from "node:zlib";
import { chunkText } from "./chunk";
import { createDemoEmbedder, type Embedder } from "./embedding";
import { DEFAULT_KNOWLEDGE_THRESHOLD, DEMO_THRESHOLD, type KnowledgeSearch } from "./retrieve";

export const KNOWLEDGE_CALIBRATION_DOCUMENTS = [
  {
    title: "Returns",
    markdown: "# Exchanges\n\nItems can be exchanged within 7 days with the original receipt.",
  },
  {
    title: "Delivery",
    markdown: "# Island-wide delivery\n\nDelivery takes 2-4 working days and costs LKR 400.",
  },
  {
    title: "Payment",
    markdown: "# Cash on delivery\n\nCash on delivery is available for orders up to LKR 50,000.",
  },
  {
    title: "Size",
    markdown:
      "# Clothing sizes\n\nS chest 36 inches. M chest 38 inches. L chest 40 inches. XL chest 42 inches.",
  },
  { title: "Care", markdown: "# Linen\n\nHand wash linen in cold water and air dry in the shade." },
];

export const KNOWLEDGE_CALIBRATION_QUERIES: [query: string, title: string | null][] = [
  ["exchanging deadline", "Returns"],
  ["receipt exchange", "Returns"],
  ["exchange days", "Returns"],
  ["delivery duration", "Delivery"],
  ["island delivery", "Delivery"],
  ["delivery costs", "Delivery"],
  ["cash payment", "Payment"],
  ["cash limit", "Payment"],
  ["cash availability", "Payment"],
  ["medium chest", "Size"],
  ["clothing sizing", "Size"],
  ["XL inches", "Size"],
  ["washing linens", "Care"],
  ["cold wash", "Care"],
  ["drying linen", "Care"],
  ["vouchers presents", null],
  ["Sunday opening", null],
  ["shop address", null],
  ["repairs tailoring", null],
  ["loyalty rewards", null],
];

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

interface StaticChunk {
  id: string;
  documentTitle: string;
  heading: string | null;
  text: string;
  embeddedText: string;
}

const WORD = /\p{L}[\p{L}\p{M}\p{N}]*/gu;

function words(text: string): Set<string> {
  return new Set(text.normalize("NFKC").toLowerCase().match(WORD) ?? []);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    a2 += x * x;
    b2 += y * y;
  }
  return a2 === 0 || b2 === 0 ? 0 : dot / Math.sqrt(a2 * b2);
}

/** In-memory equivalent of retrieval, for deterministic agent tests and live evals without Postgres. */
export function createStaticKnowledge(
  docs: { title: string; markdown: string }[],
  embedder: Embedder = createDemoEmbedder(),
  options: { threshold?: number } = {},
): KnowledgeSearch {
  const chunks: StaticChunk[] = docs.flatMap((doc, documentIndex) =>
    chunkText(doc.markdown).map((chunk) => ({
      id: `${documentIndex}:${chunk.seq}`,
      documentTitle: doc.title,
      heading: chunk.heading,
      text: chunk.text,
      embeddedText: chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text,
    })),
  );
  const indexed = embedder.embed(
    chunks.map((chunk) => chunk.embeddedText),
    "document",
  );
  const threshold =
    options.threshold ?? (embedder.model === "demo:hash-v1" ? DEMO_THRESHOLD : DEFAULT_KNOWLEDGE_THRESHOLD);
  return {
    async search(query, searchOptions) {
      const limit = Math.max(1, Math.floor(searchOptions?.limit ?? 3));
      const [vectors, queryVectors] = await Promise.all([indexed, embedder.embed([query], "query")]);
      const queryVector = queryVectors[0];
      if (!queryVector) return [];
      const vector = chunks
        .map((chunk, index) => ({ chunk, score: cosine(vectors[index] ?? [], queryVector) }))
        .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
        .slice(0, 8);
      const queryWords = words(query);
      const fullText = chunks
        .map((chunk) => {
          const overlap = [...words(chunk.embeddedText)].filter((word) => queryWords.has(word)).length;
          return { chunk, score: queryWords.size === 0 ? 0 : overlap / queryWords.size };
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
        .slice(0, 8);
      const vectorTop = new Set(vector.slice(0, 3).map((row) => row.chunk.id));
      const fullTextTop = new Set(fullText.slice(0, 3).map((row) => row.chunk.id));
      const allowed = new Set(vector.filter((row) => row.score >= threshold).map((row) => row.chunk.id));
      for (const id of vectorTop) if (fullTextTop.has(id)) allowed.add(id);
      const scores = new Map<string, { chunk: StaticChunk; score: number }>();
      for (const leg of [vector, fullText]) {
        leg.forEach((row, index) => {
          if (!allowed.has(row.chunk.id)) return;
          const current = scores.get(row.chunk.id) ?? { chunk: row.chunk, score: 0 };
          current.score += 1 / (60 + index + 1);
          scores.set(row.chunk.id, current);
        });
      }
      return [...scores.values()]
        .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
        .slice(0, limit)
        .map(({ chunk, score }) => ({
          documentTitle: chunk.documentTitle,
          heading: chunk.heading,
          text: chunk.text,
          score,
        }));
    },
  };
}

export async function calibrateKnowledgeThreshold(
  embedder: Embedder,
  thresholds: number[],
): Promise<{ threshold: number; correct: number; total: number }[]> {
  const queryTexts = KNOWLEDGE_CALIBRATION_QUERIES.map(([query]) => query);
  const queryVectors = await embedder.embed(queryTexts, "query");
  const queryCache = new Map(queryTexts.map((query, index) => [query, queryVectors[index] ?? []]));
  const documentCache = new Map<string, Promise<number[][]>>();
  const cached: Embedder = {
    model: embedder.model,
    embed(values, purpose) {
      if (purpose === "query" && values.length === 1) {
        const vector = queryCache.get(values[0] ?? "");
        if (vector) return Promise.resolve([vector]);
      }
      const key = JSON.stringify([purpose, values]);
      const existing = documentCache.get(key);
      if (existing) return existing;
      const pending = embedder.embed(values, purpose);
      documentCache.set(key, pending);
      return pending;
    },
  };
  const scores: { threshold: number; correct: number; total: number }[] = [];
  for (const threshold of thresholds) {
    const knowledge = createStaticKnowledge(KNOWLEDGE_CALIBRATION_DOCUMENTS, cached, { threshold });
    let correct = 0;
    for (const [query, expected] of KNOWLEDGE_CALIBRATION_QUERIES) {
      const actual = (await knowledge.search(query, { limit: 1 }))[0]?.documentTitle ?? null;
      if (actual === expected) correct += 1;
    }
    scores.push({ threshold, correct, total: KNOWLEDGE_CALIBRATION_QUERIES.length });
  }
  return scores.sort((a, b) => b.correct - a.correct || a.threshold - b.threshold);
}
