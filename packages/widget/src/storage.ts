export interface SavedConversation {
  conversationId: string;
  conversationToken: string;
}

type RawStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Browser storage that never throws: private mode, blocked cookies or a full quota fall back to memory for
 * this page view. Holds only the visitor id, the conversation token per widget key, and consent.
 */
export function createStorage(raw: RawStorage | null) {
  const memory = new Map<string, string>();
  const get = (key: string): string | null => {
    try {
      const value = raw?.getItem(key) ?? null;
      if (value !== null) return value;
    } catch {
      // fall through to memory
    }
    return memory.get(key) ?? null;
  };
  const set = (key: string, value: string) => {
    memory.set(key, value);
    try {
      raw?.setItem(key, value);
    } catch {
      // memory copy is enough for this page view
    }
  };
  const remove = (key: string) => {
    memory.delete(key);
    try {
      raw?.removeItem(key);
    } catch {
      // nothing to do
    }
  };
  const conversationKey = (widgetKey: string) => `ace:conversation:${widgetKey}`;

  return {
    visitorId(): string {
      const existing = get("ace:visitor");
      if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
      const id = randomId();
      set("ace:visitor", id);
      return id;
    },
    loadConversation(widgetKey: string): SavedConversation | null {
      try {
        const parsed: unknown = JSON.parse(get(conversationKey(widgetKey)) ?? "null");
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as SavedConversation).conversationId === "string" &&
          typeof (parsed as SavedConversation).conversationToken === "string"
        ) {
          const { conversationId, conversationToken } = parsed as SavedConversation;
          return { conversationId, conversationToken };
        }
      } catch {
        // corrupted: treat as none
      }
      return null;
    },
    saveConversation(widgetKey: string, saved: SavedConversation) {
      set(conversationKey(widgetKey), JSON.stringify(saved));
    },
    clearConversation(widgetKey: string) {
      remove(conversationKey(widgetKey));
    },
    consentGiven: () => get("ace:consent") === "1",
    giveConsent: () => set("ace:consent", "1"),
  };
}

export type WidgetStorage = ReturnType<typeof createStorage>;
