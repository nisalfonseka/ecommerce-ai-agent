import { CommerceError } from "@ace/contracts";
import { z } from "zod";

const CursorSchema = z.object({ offset: z.number().int().nonnegative(), q: z.string().min(1) });
export type SearchCursor = z.infer<typeof CursorSchema>;

export function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

const invalid = () => new CommerceError("INVALID_INPUT", "Invalid cursor");

/** Offset of a cursor issued for the search with fingerprint `q`; 0 when absent. Anything else → INVALID_INPUT. */
export function decodeCursor(cursor: string | undefined, q: string): number {
  if (cursor === undefined) return 0;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = CursorSchema.safeParse(raw);
  // A cursor from another query would page through a different result list.
  if (!parsed.success || parsed.data.q !== q) throw invalid();
  return parsed.data.offset;
}
