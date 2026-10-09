import {
  formatAmount,
  isVerificationValid,
  type PayhereStatus,
  verificationSignature,
  verifyNotification,
} from "./hash";

export interface StoredSession {
  id: string;
  /** Major units, as Medusa stores it. */
  amount: unknown;
  currency_code: string;
  data: Record<string, unknown>;
}

export interface StoredVerification {
  status: PayhereStatus;
  paymentId: string;
  amount: string;
  currency: string;
  signature: string;
}

export interface NotificationDeps {
  merchantId: string;
  merchantSecret: string;
  retrieveSession(id: string): Promise<StoredSession | null>;
  saveSessionData(session: StoredSession, data: Record<string, unknown>): Promise<void>;
  /** Authorizes and captures the session and completes its cart (Medusa processPaymentWorkflow). */
  processPayment(input: { sessionId: string; amount: unknown }): Promise<void>;
}

export type NotificationOutcome =
  | { status: 400; outcome: "invalid_signature" | "unknown_session" | "amount_mismatch" }
  | { status: 200; outcome: PayhereStatus | "duplicate" };

/** Reads a stored verification, or null if it is missing or its signature does not hold. */
export function storedVerification(
  sessionId: string,
  data: Record<string, unknown>,
  merchantSecret: string,
): StoredVerification | null {
  const value = data.payhere_verification;
  if (typeof value !== "object" || value === null) return null;
  const v = value as Partial<StoredVerification>;
  if (
    typeof v.status !== "string" ||
    typeof v.paymentId !== "string" ||
    typeof v.amount !== "string" ||
    typeof v.currency !== "string" ||
    typeof v.signature !== "string"
  ) {
    return null;
  }
  const verification = v as StoredVerification;
  return isVerificationValid({ sessionId, ...verification }, merchantSecret) ? verification : null;
}

/**
 * Handles PayHere's server-to-server notify_url POST. Only a correctly signed notification for the session's
 * exact amount and currency is recorded; only a captured one completes the order.
 */
export async function handleNotification(
  fields: Record<string, unknown>,
  deps: NotificationDeps,
): Promise<NotificationOutcome> {
  const result = verifyNotification(fields, deps);
  if (!result.valid) return { status: 400, outcome: "invalid_signature" };
  const session = await deps.retrieveSession(result.orderId);
  if (!session) return { status: 400, outcome: "unknown_session" };
  if (
    formatAmount(session.amount) !== result.amount ||
    session.currency_code.toUpperCase() !== result.currency
  ) {
    return { status: 400, outcome: "amount_mismatch" };
  }
  const previous = storedVerification(session.id, session.data, deps.merchantSecret);
  if (previous?.status === "captured") return { status: 200, outcome: "duplicate" };

  const verification = {
    status: result.status,
    paymentId: result.paymentId,
    amount: result.amount,
    currency: result.currency,
  };
  const signature = verificationSignature({ sessionId: session.id, ...verification }, deps.merchantSecret);
  await deps.saveSessionData(session, {
    ...session.data,
    payhere_verification: { ...verification, signature },
  });
  if (result.status === "captured")
    await deps.processPayment({ sessionId: session.id, amount: session.amount });
  return { status: 200, outcome: result.status };
}
