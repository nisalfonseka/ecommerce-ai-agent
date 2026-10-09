import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** PayHere status_code → our status (PayHere Checkout API, "Payment notification"). */
const STATUS_BY_CODE: Record<string, PayhereStatus> = {
  "2": "captured",
  "0": "pending",
  "-1": "canceled",
  "-2": "failed",
  "-3": "chargedback",
};

export type PayhereStatus = "captured" | "pending" | "canceled" | "failed" | "chargedback";

const md5Upper = (value: string): string => createHash("md5").update(value).digest("hex").toUpperCase();

/** A Medusa amount (number, numeric string or BigNumber-like) in major units → "1234.50". */
export function formatAmount(amount: unknown): string {
  const value =
    typeof amount === "number" || typeof amount === "string"
      ? Number(amount)
      : typeof amount === "object" && amount !== null && "numeric" in amount
        ? Number((amount as { numeric: unknown }).numeric)
        : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) throw new Error("PayHere amount must be a positive number");
  return value.toFixed(2);
}

/** The `hash` field of the checkout form; computed server-side so the shopper cannot change the amount. */
export function checkoutHash(input: {
  merchantId: string;
  orderId: string;
  amount: unknown;
  currency: string;
  merchantSecret: string;
}): string {
  return md5Upper(
    `${input.merchantId}${input.orderId}${formatAmount(input.amount)}${input.currency}${md5Upper(input.merchantSecret)}`,
  );
}

export type NotificationResult =
  | { valid: false }
  | {
      valid: true;
      orderId: string;
      paymentId: string;
      amount: string;
      currency: string;
      status: PayhereStatus;
    };

const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Verifies a notify_url POST (form fields as strings) against PayHere's `md5sig`. */
export function verifyNotification(
  fields: Record<string, unknown>,
  options: { merchantId: string; merchantSecret: string },
): NotificationResult {
  const field = (name: string) => (typeof fields[name] === "string" ? (fields[name] as string) : "");
  const [merchantId, orderId, amount, currency, code, signature] = [
    "merchant_id",
    "order_id",
    "payhere_amount",
    "payhere_currency",
    "status_code",
    "md5sig",
  ].map(field);
  const status = STATUS_BY_CODE[code ?? ""];
  if (!merchantId || !orderId || !amount || !currency || !signature || !status) return { valid: false };
  if (merchantId !== options.merchantId) return { valid: false };
  const expected = md5Upper(
    `${merchantId}${orderId}${amount}${currency}${code}${md5Upper(options.merchantSecret)}`,
  );
  if (!equal(signature.toUpperCase(), expected)) return { valid: false };
  return { valid: true, orderId, paymentId: field("payment_id") ?? "", amount, currency, status };
}

export interface Verification {
  sessionId: string;
  status: PayhereStatus;
  paymentId: string;
  /** "1234.50", as PayHere reported it; binding it means a later amount change voids the verification. */
  amount: string;
  currency: string;
}

/**
 * Signs a verified notification before it is stored in the payment session, so authorizePayment can trust it
 * even though session data also passes through the Store API.
 */
export function verificationSignature(input: Verification, merchantSecret: string): string {
  return createHmac("sha256", merchantSecret)
    .update(
      [
        "payhere-verification",
        input.sessionId,
        input.status,
        input.paymentId,
        input.amount,
        input.currency,
      ].join("\n"),
    )
    .digest("hex");
}

export function isVerificationValid(
  input: Verification & { signature: string },
  merchantSecret: string,
): boolean {
  return equal(input.signature, verificationSignature(input, merchantSecret));
}
