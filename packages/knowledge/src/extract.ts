import { z } from "zod";
import { chunkText, MAX_CHUNKS_PER_DOCUMENT } from "./chunk";
import { KnowledgeSourceError } from "./errors";
import { fetchPublicUrl } from "./fetch-url";
import { MAX_PDF_BYTES, pdfToText } from "./pdf-text";

const MAX_TEXT_CHARS = 200_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** What the admin API accepts. Limits are checked again in extractText. */
export const KnowledgeSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("markdown"), text: z.string().max(MAX_TEXT_CHARS) }),
  z.object({
    type: z.literal("pdf"),
    base64: z
      .string()
      .max(Math.ceil(MAX_PDF_BYTES / 3) * 4)
      .regex(BASE64),
  }),
  z.object({ type: z.literal("url"), url: z.string().min(1).max(2048) }),
]);
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

// Elements whose content is never policy text. script/style/noscript are raw text: their content is skipped
// up to the closing tag without looking for markup inside it.
const DROPPED = new Set([
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "svg",
  "head",
  "template",
]);
const RAW_TEXT = new Set(["script", "style", "noscript"]);
const PARAGRAPH = new Set([
  "p",
  "div",
  "ul",
  "ol",
  "dl",
  "table",
  "section",
  "article",
  "main",
  "aside",
  "blockquote",
  "pre",
  "figure",
  "form",
]);
const LINE_END = new Set(["li", "tr", "dt", "dd"]);
const CELL = new Set(["td", "th"]);
const HEADING = /^h([1-6])$/;
const TAG_START = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/y;
const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g;
const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES.get(body.toLowerCase()) ?? whole;
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

/** Index just past the `>` that ends the tag starting before `from`, skipping quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return html.length;
}

function separator(name: string, closing: boolean): string {
  const heading = HEADING.exec(name);
  if (heading) return closing ? "\n\n" : `\n\n${"#".repeat(Number(heading[1]))} `;
  if (PARAGRAPH.has(name)) return "\n\n";
  if (name === "br") return "\n";
  if (LINE_END.has(name) && closing) return "\n";
  if (CELL.has(name) && closing) return " ";
  return "";
}

/**
 * HTML → plain text with markdown headings, for chunking only. A small tag-scanning state machine instead of
 * an HTML parser: it drops the contents of script/style/noscript/nav/header/footer/svg (and head/template),
 * turns h1–h6 into "#" lines and paragraph-level and line-level ends into newlines, decodes the common
 * entities (named and numeric) and collapses whitespace. Entities are decoded only in text, so escaped
 * markup stays text.
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") out.push(decodeEntities(text).replace(/[\s\u00a0]+/g, " "));
    text = "";
  };
  /** Set while inside a dropped (non-raw) element; nested elements of the same name are counted. */
  let skip: { name: string; depth: number } | null = null;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      if (!skip) text += html.slice(i);
      break;
    }
    if (!skip) text += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      i = tagEnd(html, lt + 2);
      continue;
    }
    TAG_START.lastIndex = lt;
    const match = TAG_START.exec(html);
    if (!match) {
      // A "<" that does not start a tag is text.
      if (!skip) text += "<";
      i = lt + 1;
      continue;
    }
    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    i = tagEnd(html, lt + match[0].length);
    const selfClosing = html[i - 2] === "/";
    if (skip) {
      if (name === skip.name && !selfClosing) skip.depth += closing ? -1 : 1;
      if (skip.depth === 0) skip = null;
      continue;
    }
    if (DROPPED.has(name)) {
      if (closing || selfClosing) continue;
      flush();
      if (RAW_TEXT.has(name)) {
        const close = new RegExp(`</${name}[\\s/>]`, "gi");
        close.lastIndex = i;
        const found = close.exec(html);
        i = found ? tagEnd(html, found.index + 2 + name.length) : html.length;
      } else {
        skip = { name, depth: 1 };
      }
      continue;
    }
    const sep = separator(name, closing);
    if (sep !== "") {
      flush();
      out.push(sep);
    }
  }
  flush();
  // Spaces around line breaks are trimmed line by line: the regex / *\n */ backtracked quadratically on a long
  // run of spaces with no line break (e.g. thousands of empty table cells, each adding a space).
  return out
    .join("")
    .split("\n")
    .map(trimSpaces)
    .join("\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Removes leading and trailing U+0020 spaces only (flush() has already turned other whitespace into them). */
function trimSpaces(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && line[start] === " ") start++;
  while (end > start && line[end - 1] === " ") end--;
  return line.slice(start, end);
}

/**
 * Line endings normalised, NUL removed (Postgres text rejects it), trimmed. Refuses oversized text (too many
 * characters, or more than MAX_CHUNKS_PER_DOCUMENT chunks), and text with nothing to retrieve: empty, or
 * headings only (it would chunk to nothing and be "ready" with no chunks).
 */
function finish(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replaceAll("\u0000", "").trim();
  if (clean === "") throw new KnowledgeSourceError("empty");
  if (clean.length > MAX_TEXT_CHARS) throw new KnowledgeSourceError("too_large");
  const chunks = chunkText(clean).length;
  if (chunks === 0) throw new KnowledgeSourceError("empty");
  if (chunks > MAX_CHUNKS_PER_DOCUMENT) throw new KnowledgeSourceError("too_large");
  return clean;
}

/**
 * Turns an uploaded source into the text that is stored and chunked. Markdown passes through, PDFs are read
 * page by page with bounded work (pdfToText: page cap, text cap, deadline; pages joined by blank lines), and
 * URLs are fetched with `fetchUrl` (SSRF-checked) and converted from HTML when needed. Expected failures are
 * KnowledgeSourceError.
 */
export async function extractText(
  source: KnowledgeSource,
  fetchUrl: typeof fetchPublicUrl = fetchPublicUrl,
): Promise<{ text: string; sourceUrl: string | null }> {
  switch (source.type) {
    case "markdown":
      if (source.text.length > MAX_TEXT_CHARS) throw new KnowledgeSourceError("too_large");
      return { text: finish(source.text), sourceUrl: null };
    case "pdf":
      return { text: finish(await pdfToText(source.base64, MAX_TEXT_CHARS)), sourceUrl: null };
    case "url": {
      const page = await fetchUrl(source.url);
      const text = page.contentType === "text/html" ? htmlToText(page.body) : page.body;
      return { text: finish(text), sourceUrl: source.url };
    }
  }
}
