import { type CodPolicy, createSession, type Persona, type SessionState, type StoreFacts } from "@ace/agent";
import { CodDetailsSchema, MoneySchema, OrderSchema } from "@ace/contracts";
import { z } from "zod";

export const PersonaSchema = z.object({
  assistantName: z.string().min(1).max(60),
  storeName: z.string().min(1).max(120),
  tone: z.string().max(200).optional(),
  languages: z.array(z.string().min(1)).min(1),
});

export const StoreFactsSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  deliveryInfo: z.string().max(500).optional(),
  /** Cash on delivery (contract orders.place_cod). Off unless enabled; limits are enforced in tool code. */
  cod: z
    .object({
      enabled: z.boolean(),
      /** Highest order total for COD, delivery included, in minor units of `currency`. */
      maxTotal: z.number().int().positive().optional(),
      allowedCities: z.array(z.string().trim().min(1).max(80)).min(1).max(500).optional(),
      /** The country the store delivers COD to (ISO 3166-1 alpha-2). */
      countryCode: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .default("LK"),
    })
    .optional(),
});

const SessionSchema = z.object({
  shown: z.array(
    z.object({ ref: z.string(), productId: z.string(), title: z.string(), variantIds: z.array(z.string()) }),
  ),
  attributedCartId: z.string().nullable(),
  codDraft: z
    .object({
      cartId: z.string(),
      details: CodDetailsSchema,
      subtotal: MoneySchema,
      deliveryFee: MoneySchema,
      total: MoneySchema,
      itemCount: z.number().int(),
    })
    .nullable()
    .optional(),
  lastOrder: z.object({ key: z.string(), order: OrderSchema }).nullable().optional(),
});

export function parsePersona(value: unknown): Persona {
  return PersonaSchema.parse(value);
}

export function parseStoreFacts(value: unknown): StoreFacts & z.output<typeof StoreFactsSchema> {
  return StoreFactsSchema.parse(value);
}

/** The bot's COD settings as the tools enforce them; null when COD is off. */
export function codPolicy(facts: z.output<typeof StoreFactsSchema>): CodPolicy | null {
  if (!facts.cod?.enabled) return null;
  return {
    maxTotal:
      facts.cod.maxTotal === undefined ? null : { amount: facts.cod.maxTotal, currency: facts.currency },
    allowedCities: facts.cod.allowedCities ?? null,
    countryCode: facts.cod.countryCode,
  };
}

/** Stored session JSON → SessionState; anything unreadable starts a fresh session instead of failing the turn. */
export function parseSession(value: unknown): SessionState {
  const parsed = SessionSchema.safeParse(value);
  return parsed.success ? parsed.data : createSession();
}
