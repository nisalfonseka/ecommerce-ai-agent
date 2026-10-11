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

const estimate = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
const isBlank = (ch: string | undefined) => ch === " " || ch === "\t";

/**
 * An ATX heading: 1–6 #s, a space or tab, then the title. Surrounding spaces and tabs are trimmed, and a
 * closing run of #s is removed only when it stands alone or follows a space or tab (CommonMark), so "C#" keeps
 * its #. A heading with no title text is not treated as one.
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
  return end > start ? { level, title: line.slice(start, end) } : null;
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
