import type { Persona, StoreFacts } from "@ace/agent";

/** Candidates for decision D3; edit freely or override with --models. One conversation model + one cheap model each. */
export const DEFAULT_EVAL_MODELS = [
  "google:gemini-pro-latest",
  "google:gemini-flash-latest",
  "openai:gpt-5.5",
  "openai:gpt-5.4-mini",
  "anthropic:claude-sonnet-5-5",
  "anthropic:claude-haiku-5-5",
];

export const EVAL_PERSONA: Persona = {
  assistantName: "Nila",
  storeName: "Demo Clothing",
  tone: "warm, concise, helpful",
  languages: ["English", "Sinhala", "Tamil", "Singlish"],
};

export const EVAL_STORE: StoreFacts = {
  currency: "LKR",
  deliveryInfo: "Island-wide delivery in 2–4 working days.",
};
