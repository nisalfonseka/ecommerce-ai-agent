import { describe, expect, it, vi } from "vitest";
import { createDemoEmbedder } from "./embedding";
import { DEMO_THRESHOLD } from "./retrieve";
import { calibrateKnowledgeThreshold } from "./testing";

describe("demo knowledge threshold calibration", () => {
  it("pins the threshold with the highest accuracy over 15 answerable and 5 unknown questions", async () => {
    const candidates = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];
    const demo = createDemoEmbedder();
    const embed = vi.fn(demo.embed);
    const scores = await calibrateKnowledgeThreshold({ model: demo.model, embed }, candidates);
    expect(scores[0]).toEqual({ threshold: DEMO_THRESHOLD, correct: 20, total: 20 });
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls.map((call) => call[1]).sort()).toEqual(["document", "query"]);
  });
});
