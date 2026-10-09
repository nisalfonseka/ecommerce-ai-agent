/**
 * nDCG@k with gain 2^rel − 1 and discount log2(rank + 1) (rank from 1). The ideal ranking takes the k best
 * grades from `relevant`; ids missing from `relevant` have grade 0. 0 when nothing is relevant.
 */
export function ndcgAt(k: number, ranked: string[], relevant: Record<string, number>): number {
  const dcg = (grades: number[]) =>
    grades.slice(0, k).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const ideal = dcg(Object.values(relevant).sort((a, b) => b - a));
  if (ideal === 0) return 0;
  return dcg(ranked.map((id) => relevant[id] ?? 0)) / ideal;
}
