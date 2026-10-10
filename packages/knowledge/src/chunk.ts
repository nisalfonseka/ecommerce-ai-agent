export interface Chunk {
  seq: number;
  /** Heading path, e.g. "Returns > Exchanges"; null for text before the first heading. */
  heading: string | null;
  text: string;
  /** ≈ characters / 4. */
  tokenEstimate: number;
}

const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 60;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;
// A chunk is at most TARGET_CHARS of new text, one separator and OVERLAP_CHARS of overlap: 561 ≤ MAX_TOKENS (700).

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;
/** Sentence ends (Latin and Devanagari danda; Sinhala and Tamil use "."), or a line break inside a paragraph. */
const SENTENCE_BREAK = /(?<=[.!?।])\s+|\s*\n\s*/;

interface Section {
  heading: string | null;
  body: string;
}

interface Unit {
  text: string;
  /** What joins it to the unit before it in the same chunk. */
  sep: string;
}

const estimate = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  const path: { level: number; title: string }[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  let inFence = false;
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body !== "") sections.push({ heading, body });
    lines = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    const level = match[1]?.length ?? 1;
    while (path.length > 0 && (path[path.length - 1]?.level ?? 0) >= level) path.pop();
    path.push({ level, title: match[2] ?? "" });
    heading = path.map((entry) => entry.title).join(" > ");
  }
  flush();
  return sections;
}

/** Splits a piece longer than TARGET_CHARS at word boundaries, hard-cutting words that are longer still. */
function splitWords(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (let word of text.split(/\s+/)) {
    while (word.length > TARGET_CHARS) {
      if (current !== "") pieces.push(current);
      current = "";
      pieces.push(word.slice(0, TARGET_CHARS));
      word = word.slice(TARGET_CHARS);
    }
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length <= TARGET_CHARS) {
      current = candidate;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/** Paragraphs, falling back to sentences, then words, so no unit is longer than TARGET_CHARS. */
function units(body: string): Unit[] {
  const out: Unit[] = [];
  for (const paragraph of body.split(/\n[ \t]*\n/)) {
    const trimmed = paragraph.trim();
    if (trimmed === "") continue;
    if (trimmed.length <= TARGET_CHARS) {
      out.push({ text: trimmed, sep: "\n\n" });
      continue;
    }
    let sep = "\n\n";
    for (const sentence of trimmed.split(SENTENCE_BREAK)) {
      if (sentence === "") continue;
      for (const piece of sentence.length <= TARGET_CHARS ? [sentence] : splitWords(sentence)) {
        out.push({ text: piece, sep });
        sep = " ";
      }
    }
  }
  return out;
}

function pack(list: Unit[]): string[] {
  const bodies: string[] = [];
  let current = "";
  for (const unit of list) {
    const candidate = current === "" ? unit.text : `${current}${unit.sep}${unit.text}`;
    if (candidate.length <= TARGET_CHARS) {
      current = candidate;
    } else {
      bodies.push(current);
      current = unit.text;
    }
  }
  if (current !== "") bodies.push(current);
  return bodies;
}

/** The last ≤ OVERLAP_CHARS of `text`, starting at a word boundary when there is one. */
function tail(text: string): string {
  if (text.length <= OVERLAP_CHARS) return text;
  const window = text.slice(text.length - OVERLAP_CHARS);
  const boundary = /\s+(?=\S)/.exec(window);
  return boundary ? window.slice(boundary.index + boundary[0].length) : window;
}

/**
 * Splits on markdown headings first, then paragraphs, then sentences (then words); target 500 tokens
 * (≈ chars/4), max 700. Consecutive chunks of one section overlap by up to 60 tokens: each starts with the
 * previous chunk's tail, so a fact on a boundary is retrievable from either side. Sections never overlap.
 */
export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of splitSections(text)) {
    let previous: string | null = null;
    for (const body of pack(units(section.body))) {
      const chunkBody: string = previous === null ? body : `${tail(previous)} ${body}`;
      chunks.push({
        seq: chunks.length,
        heading: section.heading,
        text: chunkBody,
        tokenEstimate: estimate(chunkBody),
      });
      previous = chunkBody;
    }
  }
  return chunks;
}
