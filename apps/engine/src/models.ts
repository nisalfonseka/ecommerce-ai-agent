import { resolveModel } from "@ace/agent";
import type { LanguageModel } from "ai";
import { createDemoModel } from "./demo-model";

/**
 * Bot config model spec → model. "demo:*" is the keyless demo model, refused unless allowDemo (never in
 * production). Everything else goes through the agent's provider resolution (AGENTS.md rule 16).
 */
export function createModelResolver(options: { allowDemo: boolean }): (spec: string) => LanguageModel {
  const cache = new Map<string, LanguageModel>();
  return (spec) => {
    const cached = cache.get(spec);
    if (cached) return cached;
    let model: LanguageModel;
    if (spec.startsWith("demo:")) {
      if (!options.allowDemo) throw new Error("The demo model is disabled in production");
      model = createDemoModel();
    } else {
      model = resolveModel(spec);
    }
    cache.set(spec, model);
    return model;
  };
}
