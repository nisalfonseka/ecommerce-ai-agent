export interface DevOutboxEntry {
  tenantId: string;
  conversationId: string;
  channel: "sms" | "email";
  text: string;
}

export interface DevOutbox {
  record(entry: DevOutboxEntry): void;
  latest(tenantId: string, conversationId: string): Pick<DevOutboxEntry, "channel" | "text"> | null;
}

/** In-memory OTP delivery inspection for local browser tests. Never construct this in production. */
export function createDevOutbox(): DevOutbox {
  const messages = new Map<string, DevOutboxEntry>();
  const key = (tenantId: string, conversationId: string) => `${tenantId}:${conversationId}`;
  return {
    record(entry) {
      messages.set(key(entry.tenantId, entry.conversationId), { ...entry });
    },
    latest(tenantId, conversationId) {
      const entry = messages.get(key(tenantId, conversationId));
      return entry ? { channel: entry.channel, text: entry.text } : null;
    },
  };
}
