import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows";
import { handleNotification } from "../../../modules/payhere/notification";

/** PayHere notify_url (server to server, form-encoded). See modules/payhere for the verification rules. */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const merchantId = process.env.PAYHERE_MERCHANT_ID;
  const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET;
  if (!merchantId || !merchantSecret) {
    res.status(404).json({ message: "PayHere is not configured" });
    return;
  }
  const payments = req.scope.resolve(Modules.PAYMENT);
  const result = await handleNotification((req.body ?? {}) as Record<string, unknown>, {
    merchantId,
    merchantSecret,
    retrieveSession: async (id) => {
      const [session] = await payments.listPaymentSessions({ id });
      return session
        ? {
            id: session.id,
            amount: session.amount,
            currency_code: session.currency_code,
            data: session.data ?? {},
          }
        : null;
    },
    saveSessionData: async (session, data) => {
      await payments.updatePaymentSession({
        id: session.id,
        amount: session.amount as number,
        currency_code: session.currency_code,
        data,
      });
    },
    processPayment: async ({ sessionId, amount }) => {
      await processPaymentWorkflow(req.scope).run({
        input: { action: "captured", data: { session_id: sessionId, amount: amount as number } },
      });
    },
  });
  // Never log the raw body: it can hold the shopper's name, email and masked card.
  logger.info(`payhere notify: ${result.outcome}`);
  res.status(result.status).json({ outcome: result.outcome });
}
