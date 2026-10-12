import { describe, expect, it } from "vitest";
import { parseSse } from "./sse";

async function* chunks(parts: string[]) {
  for (const part of parts) yield part;
}

async function collect(parts: string[]) {
  const events = [];
  for await (const event of parseSse(chunks(parts))) events.push(event);
  return events;
}

describe("parseSse", () => {
  it("parses events, including ones split across chunks", async () => {
    expect(
      await collect([
        'event: status\ndata: {"tool":"search_products"}\n\neve',
        'nt: reply\ndata: {"text":"Hi',
        '"}\n\n',
      ]),
    ).toEqual([
      { event: "status", data: { tool: "search_products" } },
      { event: "reply", data: { text: "Hi" } },
    ]);
  });

  it("handles CRLF line endings and skips malformed blocks", async () => {
    expect(await collect(["event: done\r\ndata: {}\r\n\r\n", "event: broken\ndata: {nope\n\n"])).toEqual([
      { event: "done", data: {} },
    ]);
  });
});
