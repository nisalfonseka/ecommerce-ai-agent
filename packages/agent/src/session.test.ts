import { describe, expect, it } from "vitest";
import { createSession, rememberShown, resolveProductRef } from "./session";

describe("session", () => {
  it("numbers shown products from #1 and replaces the previous list", () => {
    const session = createSession();
    rememberShown(session, [{ productId: "a", title: "A", variantIds: ["a1"] }]);
    const shown = rememberShown(session, [
      { productId: "b", title: "B", variantIds: [] },
      { productId: "c", title: "C", variantIds: ["c1"] },
    ]);
    expect(shown.map((s) => s.ref)).toEqual(["#1", "#2"]);
    expect(session.shown.map((s) => s.productId)).toEqual(["b", "c"]);
  });

  it("resolves '#2', '2' and ' #2 ' to the same product", () => {
    const session = createSession();
    rememberShown(session, [
      { productId: "a", title: "A", variantIds: [] },
      { productId: "b", title: "B", variantIds: [] },
    ]);
    for (const ref of ["#2", "2", " #2 "]) expect(resolveProductRef(session, ref)?.productId).toBe("b");
  });

  it("returns undefined for refs that were not shown", () => {
    const session = createSession();
    rememberShown(session, [{ productId: "a", title: "A", variantIds: [] }]);
    for (const ref of ["#7", "#0", "abc", ""]) expect(resolveProductRef(session, ref)).toBeUndefined();
  });
});
