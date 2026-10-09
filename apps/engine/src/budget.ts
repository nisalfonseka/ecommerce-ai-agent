import { z } from "zod";

const PriceSchema = z.object({
  /** Integer micro-dollars per million tokens; null until the owner fills it in from the provider's page. */
  inputPerMTokUsdMicros: z.number().int().nonnegative().nullable(),
  outputPerMTokUsdMicros: z.number().int().nonnegative().nullable(),
  source: z.string().min(1),
  checkedOn: z.iso.date().nullable(),
});

const PriceFileSchema = z.object({ models: z.record(z.string(), PriceSchema) }).loose();

export type ModelPrice = z.infer<typeof PriceSchema>;
export type ModelPrices = ReadonlyMap<string, ModelPrice>;

export function loadModelPrices(json: unknown): ModelPrices {
  return new Map(Object.entries(PriceFileSchema.parse(json).models));
}

/** Integer micro-dollars (rounded up), or null when the model's price is unknown. */
export function costMicros(
  prices: ModelPrices,
  modelSpec: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const price = prices.get(modelSpec);
  if (!price || price.inputPerMTokUsdMicros === null || price.outputPerMTokUsdMicros === null) return null;
  const scaled =
    usage.inputTokens * price.inputPerMTokUsdMicros + usage.outputTokens * price.outputPerMTokUsdMicros;
  return Math.ceil(scaled / 1_000_000);
}

export type BudgetState = "ok" | "alert" | "soft" | "hard";

export interface BudgetedBot {
  model: string;
  cheapModel: string;
  budgetSoftUsdMicros: number;
  budgetHardUsdMicros: number;
}

/** Spec §4.7: alert at 80% of the soft cap; cheap model past the soft cap; contact-only past the hard cap. */
export function budgetState(spentMicros: number, bot: BudgetedBot): BudgetState {
  if (spentMicros >= bot.budgetHardUsdMicros) return "hard";
  if (spentMicros >= bot.budgetSoftUsdMicros) return "soft";
  if (spentMicros * 10 >= bot.budgetSoftUsdMicros * 8) return "alert";
  return "ok";
}

export function chooseModel(bot: BudgetedBot, state: BudgetState): { model: string } | { contactOnly: true } {
  if (state === "hard") return { contactOnly: true };
  return { model: state === "soft" ? bot.cheapModel : bot.model };
}
