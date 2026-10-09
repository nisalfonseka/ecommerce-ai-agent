import { describe, expect, it } from "vitest";
import { ndcgAt } from "./ndcg";

describe("ndcgAt", () => {
  const relevant = { a: 3, b: 2, c: 1 };

  it("is 1 for a perfect ranking", () => {
    expect(ndcgAt(5, ["a", "b", "c"], relevant)).toBe(1);
    // Unjudged results after the ideal prefix do not lower the score.
    expect(ndcgAt(5, ["a", "b", "c", "x", "y"], relevant)).toBe(1);
  });

  it("scores a reversed ranking with gain 2^rel − 1 and a log2 discount", () => {
    // DCG = 1/log2(2) + 3/log2(3) + 7/log2(4) = 6.392789; IDCG = 7 + 3/log2(3) + 1/2 = 9.392789.
    expect(ndcgAt(5, ["c", "b", "a"], relevant)).toBeCloseTo(0.680606, 5);
  });

  it("is 0 when no relevant product is returned", () => {
    expect(ndcgAt(5, ["x", "y", "z"], relevant)).toBe(0);
    expect(ndcgAt(5, [], relevant)).toBe(0);
  });

  it("only counts the first k results, and the ideal uses the best k grades", () => {
    expect(ndcgAt(1, ["b", "a"], relevant)).toBeCloseTo(3 / 7, 10);
    // Four grade-3 products, k = 2: the ideal is two grade-3s, so two of them in any order score 1.
    expect(ndcgAt(2, ["q", "r"], { p: 3, q: 3, r: 3, s: 3 })).toBe(1);
  });

  it("is 0 when nothing is relevant", () => {
    expect(ndcgAt(5, ["a"], {})).toBe(0);
  });
});
