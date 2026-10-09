import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

describe("cursor", () => {
  it("round-trips offsets", () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(37))).toBe(37);
  });

  it("treats a missing cursor as the first page", () => {
    expect(decodeCursor(undefined)).toBe(0);
  });

  it("rejects garbage and tampered cursors with INVALID_INPUT", () => {
    for (const bad of ["%%%", "bm9wZQ", btoa("o:-1"), btoa("o:1.5"), btoa("offset:3")]) {
      expect(() => decodeCursor(bad), bad).toThrow(CommerceError);
    }
  });
});
