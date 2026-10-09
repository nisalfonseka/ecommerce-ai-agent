import { describe, expect, it } from "vitest";
import { toIsoDateTime } from "./datetime";
import { CommerceError } from "./errors";

describe("toIsoDateTime", () => {
  it("normalises offsets to UTC with milliseconds", () => {
    expect(toIsoDateTime("2026-10-09T10:15:00+05:30")).toBe("2026-10-09T04:45:00.000Z");
    expect(toIsoDateTime("2026-10-09T04:45:00Z")).toBe("2026-10-09T04:45:00.000Z");
  });

  it("accepts a Date", () => {
    expect(toIsoDateTime(new Date(Date.UTC(2026, 9, 9, 4, 45)))).toBe("2026-10-09T04:45:00.000Z");
  });

  it("rejects values that are not datetimes", () => {
    expect(() => toIsoDateTime("yesterday")).toThrow(CommerceError);
    expect(() => toIsoDateTime(new Date(Number.NaN))).toThrow(CommerceError);
  });
});
