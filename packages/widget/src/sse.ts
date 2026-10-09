export interface SseEvent {
  event: string;
  data: unknown;
}

/** Parses a text stream of Server-Sent Events. Blocks with unparseable JSON are skipped. */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncIterable<SseEvent> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk.replace(/\r\n/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
      end = buffer.indexOf("\n\n");
    }
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  try {
    return { event, data: JSON.parse(data.join("\n") || "null") };
  } catch {
    return null;
  }
}

/** Response body bytes → text chunks. */
export async function* textChunks(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}
