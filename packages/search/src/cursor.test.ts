import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

describe("search cursor", () => {
  it("round-trips the offset for the same query", () => {
    const cursor = encodeCursor({ offset: 7, q: "abc123def456" });
    expect(decodeCursor(cursor, "abc123def456")).toBe(7);
    expect(decodeCursor(undefined, "abc123def456")).toBe(0);
  });

  it("rejects a cursor from another query, or a malformed one, with INVALID_INPUT", () => {
    const cursor = encodeCursor({ offset: 7, q: "abc123def456" });
    for (const bad of [cursor, "not-a-cursor", btoa("o:3"), encodeCursor({ offset: -1, q: "zzz" })]) {
      try {
        decodeCursor(bad, "zzz");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CommerceError);
        expect(error).toMatchObject({ code: "INVALID_INPUT" });
      }
    }
  });
});
