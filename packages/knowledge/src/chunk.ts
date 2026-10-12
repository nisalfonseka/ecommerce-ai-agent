export interface Chunk {
  seq: number;
  /** Heading path, e.g. "Returns > Exchanges"; null for text before the first heading. */
  heading: string | null;
  text: string;
  /** ≈ characters / 4. */
  tokenEstimate: number;
}

/**
 * More chunks than this and the document is refused (too_large): it bounds embedding cost and the rows a
 * pathological upload (thousands of tiny sections) can create. A 200,000-char document of normal prose is ~110.
 */
export const MAX_CHUNKS_PER_DOCUMENT = 1_000;

const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 60;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;
// A chunk is at most TARGET_CHARS of new text, one separator and OVERLAP_CHARS of overlap: 561 ≤ MAX_TOKENS (700).

// Every pattern here runs on untrusted text in the engine's request thread, so none may backtrack
// superlinearly: each is anchored, fixed-width or a single greedy run, and the rest is done with plain loops.
const HEADING_OPEN = /^(#{1,6})[ \t]/;
const FENCE = /^\s*(```|~~~)/;
const WHITESPACE_RUN = /\s+/g;
/** Sentence-ending punctuation (Latin and the Devanagari danda; Sinhala and Tamil use "."). */
const SENTENCE_END = new Set([".", "!", "?", "।"]);

interface Section {
  heading: string | null;
  body: string;
}

interface Unit {
  text: string;
  /** What joins it to the unit before it in the same chunk. */
  sep: string;
}

// Heading sizes are capped because every section keeps its own joined path: uncapped, one 100,000-char title
// over thousands of "## a" sections built over a billion characters of headings and ran V8 out of memory.
/** A title longer than this keeps its first MAX_TITLE_CHARS − 1 characters plus "…". */
const MAX_TITLE_CHARS = 200;
/** A longer path drops its outermost titles first (see headingPath). */
const MAX_HEADING_PATH_CHARS = 400;
const PATH_SEPARATOR = " > ";

const estimate = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
const isBlank = (ch: string | undefined) => ch === " " || ch === "\t";

/**
 * An ATX heading: 1–6 #s, a space or tab, then the title. Surrounding spaces and tabs are trimmed, and a
 * closing run of #s is removed only when it stands alone or follows a space or tab (CommonMark), so "C#" keeps
 * its #. A heading with no title text is not treated as one. Titles over MAX_TITLE_CHARS are cut on a code
 * point boundary and end with "…".
 */
function parseHeading(line: string): { level: number; title: string } | null {
  const open = HEADING_OPEN.exec(line);
  if (!open) return null;
  const level = open[1]?.length ?? 1;
  let start = level;
  let end = line.length;
  while (start < end && isBlank(line[start])) start++;
  while (end > start && isBlank(line[end - 1])) end--;
  let hashes = end;
  while (hashes > start && line[hashes - 1] === "#") hashes--;
  if (hashes < end && (hashes === start || isBlank(line[hashes - 1]))) {
    end = hashes;
    while (end > start && isBlank(line[end - 1])) end--;
  }
  if (end <= start) return null;
  if (end - start <= MAX_TITLE_CHARS) return { level, title: line.slice(start, end) };
  let cut = start + MAX_TITLE_CHARS - 1;
  const last = line.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--; // never leave half of a surrogate pair
  return { level, title: `${line.slice(start, cut)}…` };
}

/**
 * The titles joined with " > ". When that is longer than MAX_HEADING_PATH_CHARS, the outermost titles are
 * dropped first, so the nearest ancestors (the most specific context) stay. Titles are at most
 * MAX_TITLE_CHARS, so the innermost one always fits.
 */
function headingPath(path: { title: string }[]): string {
  let first = 0;
  let length =
    path.reduce((sum, entry) => sum + entry.title.length, 0) + PATH_SEPARATOR.length * (path.length - 1);
  while (length > MAX_HEADING_PATH_CHARS && first < path.length - 1) {
    length -= (path[first]?.title.length ?? 0) + PATH_SEPARATOR.length;
    first++;
  }
  return path
    .slice(first)
    .map((entry) => entry.title)
    .join(PATH_SEPARATOR);
}

/**
 * Splits at every whitespace run that follows sentence punctuation or holds a line break (a break inside a
 * paragraph). One pass over the runs; the regex form of this rule was quadratic on long whitespace runs.
 */
function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const run of paragraph.matchAll(WHITESPACE_RUN)) {
    if (run[0].includes("\n") || SENTENCE_END.has(paragraph[run.index - 1] ?? "")) {
      out.push(paragraph.slice(start, run.index));
      start = run.index + run[0].length;
    }
  }
  out.push(paragraph.slice(start));
  return out;
}

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
    const match = inFence ? null : parseHeading(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    const { level, title } = match;
    while (path.length > 0 && (path[path.length - 1]?.level ?? 0) >= level) path.pop();
    path.push({ level, title });
    heading = headingPath(path);
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
    for (const sentence of splitSentences(trimmed)) {
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
  // The first word start after whitespace (fixed width; `\s+(?=\S)` backtracked on a trailing run).
  const boundary = /\s\S/.exec(window);
  return boundary ? window.slice(boundary.index + 1) : window;
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
