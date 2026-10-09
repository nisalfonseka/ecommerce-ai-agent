import { createSession, type Persona, type SessionState, type StoreFacts } from "@ace/agent";
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
});

const SessionSchema = z.object({
  shown: z.array(
    z.object({ ref: z.string(), productId: z.string(), title: z.string(), variantIds: z.array(z.string()) }),
  ),
  attributedCartId: z.string().nullable(),
});

export function parsePersona(value: unknown): Persona {
  return PersonaSchema.parse(value);
}

export function parseStoreFacts(value: unknown): StoreFacts {
  return StoreFactsSchema.parse(value);
}

/** Stored session JSON → SessionState; anything unreadable starts a fresh session instead of failing the turn. */
export function parseSession(value: unknown): SessionState {
  const parsed = SessionSchema.safeParse(value);
  return parsed.success ? parsed.data : createSession();
}
