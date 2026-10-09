import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type ProviderName = "google" | "openai" | "anthropic";

export const PROVIDER_ENV_KEYS: Record<ProviderName, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

function isProvider(value: string): value is ProviderName {
  return value === "google" || value === "openai" || value === "anthropic";
}

/** "google:gemini-flash-latest" → { provider: "google", modelId: "gemini-flash-latest" } */
export function parseModelSpec(spec: string): { provider: ProviderName; modelId: string } {
  const separator = spec.indexOf(":");
  const provider = spec.slice(0, separator);
  const modelId = spec.slice(separator + 1);
  if (separator <= 0 || modelId.length === 0 || !isProvider(provider)) {
    throw new Error(`Invalid model spec "${spec}". Use google:<id>, openai:<id> or anthropic:<id>.`);
  }
  return { provider, modelId };
}

/** The only place provider SDKs are used. Keys are read from the environment by each provider. */
export function resolveModel(spec: string): LanguageModel {
  const { provider, modelId } = parseModelSpec(spec);
  switch (provider) {
    case "google":
      return google(modelId);
    case "openai":
      return openai(modelId);
    case "anthropic":
      return anthropic(modelId);
  }
}

export function hasApiKey(
  provider: ProviderName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[PROVIDER_ENV_KEYS[provider]];
  return value !== undefined && value.length > 0;
}
