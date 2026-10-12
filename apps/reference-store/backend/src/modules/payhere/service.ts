import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types";
import { AbstractPaymentProvider, MedusaError } from "@medusajs/framework/utils";
import { checkoutHash, formatAmount } from "./hash";
import { storedVerification } from "./notification";

export interface PayhereOptions {
  merchantId: string;
  merchantSecret: string;
  sandbox: boolean;
  storefrontUrl: string;
  backendUrl: string;
}

const CHECKOUT_URL = {
  sandbox: "https://sandbox.payhere.lk/pay/checkout",
  live: "https://www.payhere.lk/pay/checkout",
};

/**
 * PayHere card payments (spec G18, workflow §F). The storefront POSTs the session's form fields to PayHere;
 * PayHere calls /payhere/notify, which verifies md5sig and stores a signed verification in the session. A
 * payment is authorized only with that verification, never on the shopper's word.
 */
export default class PayhereProviderService extends AbstractPaymentProvider<PayhereOptions> {
  static identifier = "payhere";

  static validateOptions(options: Record<string, unknown>): void {
    for (const name of ["merchantId", "merchantSecret", "storefrontUrl", "backendUrl"]) {
      if (typeof options[name] !== "string" || options[name] === "") {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, `PayHere option ${name} is required`);
      }
    }
  }

  protected readonly options: PayhereOptions;

  // biome-ignore lint/suspicious/noExplicitAny: Medusa's provider constructor signature.
  constructor(container: Record<string, any>, options: PayhereOptions) {
    super(container, options);
    this.options = options;
  }

  /** The checkout form PayHere expects; the amount is fixed by the server-computed hash. */
  private formData(sessionId: string, amount: unknown, currencyCode: string): Record<string, unknown> {
    const currency = currencyCode.toUpperCase();
    const { merchantId, merchantSecret, storefrontUrl, backendUrl, sandbox } = this.options;
    return {
      session_id: sessionId,
      checkout_url: sandbox ? CHECKOUT_URL.sandbox : CHECKOUT_URL.live,
      merchant_id: merchantId,
      order_id: sessionId,
      amount: formatAmount(amount),
      currency,
      hash: checkoutHash({ merchantId, orderId: sessionId, amount, currency, merchantSecret }),
      return_url: `${storefrontUrl}/checkout/payhere/return?session_id=${encodeURIComponent(sessionId)}`,
      cancel_url: `${storefrontUrl}/checkout?payhere=cancelled`,
      notify_url: `${backendUrl}/payhere/notify`,
    };
  }

  private sessionId(data: Record<string, unknown> | undefined): string {
    const id = data?.session_id;
    if (typeof id !== "string" || id === "") {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "PayHere needs the payment session id");
    }
    return id;
  }

  private verified(data: Record<string, unknown> | undefined) {
    const sessionId = typeof data?.session_id === "string" ? data.session_id : "";
    const verification = storedVerification(sessionId, data ?? {}, this.options.merchantSecret);
    // The verification must be for the amount this session asks for now.
    return verification && verification.amount === data?.amount && verification.currency === data?.currency
      ? verification
      : null;
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const sessionId = this.sessionId(input.data);
    // Medusa merges the shopper's session data into what we return, so a `payhere_verification` may be forged;
    // it only counts with a valid HMAC from /payhere/notify (checked in authorizePayment).
    return {
      id: sessionId,
      status: "pending",
      data: this.formData(sessionId, input.amount, input.currency_code),
    };
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const sessionId = this.sessionId(input.data);
    const data = this.formData(sessionId, input.amount, input.currency_code);
    // Kept as-is; it only counts while it still matches the (possibly new) amount.
    if (input.data?.payhere_verification) data.payhere_verification = input.data.payhere_verification;
    return { status: "pending", data };
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const status = this.verified(input.data)?.status === "captured" ? "captured" : "pending";
    return { status, data: input.data };
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const verification = this.verified(input.data);
    if (verification?.status === "captured") return { status: "captured", data: input.data };
    if (verification?.status === "canceled") return { status: "canceled", data: input.data };
    if (verification?.status === "failed" || verification?.status === "chargedback") {
      return { status: "error", data: input.data };
    }
    return { status: "pending", data: input.data };
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    // PayHere captures at checkout; there is nothing left to capture.
    return { data: input.data };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: input.data };
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data };
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data };
  }

  async refundPayment(_input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Refund PayHere payments from the PayHere merchant portal.",
    );
  }

  /** Notifications arrive on /payhere/notify instead, which can record a signed verification. */
  async getWebhookActionAndData(): Promise<WebhookActionResult> {
    return { action: "not_supported" };
  }
}
