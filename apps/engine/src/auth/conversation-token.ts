import { createHmac, timingSafeEqual } from "node:crypto";

export interface ConversationClaims {
  tenantId: string;
  conversationId: string;
}

/**
 * Bearer token that proves the holder started this conversation (knowing a conversation ID is not enough).
 * Format: base64url(JSON claims) "." base64url(HMAC-SHA256).
 */
export function createConversationTokens(secret: string): {
  sign(claims: ConversationClaims): string;
  verify(token: string): ConversationClaims | null;
} {
  const mac = (payload: string) => createHmac("sha256", secret).update(payload).digest();
  return {
    sign(claims) {
      const payload = Buffer.from(
        JSON.stringify({ tenantId: claims.tenantId, conversationId: claims.conversationId }),
      ).toString("base64url");
      return `${payload}.${mac(payload).toString("base64url")}`;
    },
    verify(token) {
      const parts = token.split(".");
      const [payload, signature] = parts;
      if (parts.length !== 2 || !payload || !signature) return null;
      const expected = mac(payload);
      const given = Buffer.from(signature, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (
          typeof claims === "object" &&
          claims !== null &&
          typeof (claims as ConversationClaims).tenantId === "string" &&
          typeof (claims as ConversationClaims).conversationId === "string"
        ) {
          const { tenantId, conversationId } = claims as ConversationClaims;
          return { tenantId, conversationId };
        }
      } catch {
        return null;
      }
      return null;
    },
  };
}
