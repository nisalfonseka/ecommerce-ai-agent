import { describe, expect, it } from "vitest";
import { createStorage } from "./storage";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceeded");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("createStorage", () => {
  it("keeps one visitor id and a conversation per widget key", () => {
    const storage = createStorage(memoryStorage());
    const visitor = storage.visitorId();
    expect(visitor).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(storage.visitorId()).toBe(visitor);
    storage.saveConversation("pk_live_a", { conversationId: "c1", conversationToken: "t1" });
    expect(storage.loadConversation("pk_live_a")).toEqual({ conversationId: "c1", conversationToken: "t1" });
    expect(storage.loadConversation("pk_live_b")).toBeNull();
    storage.clearConversation("pk_live_a");
    expect(storage.loadConversation("pk_live_a")).toBeNull();
  });

  it("remembers consent", () => {
    const storage = createStorage(memoryStorage());
    expect(storage.consentGiven()).toBe(false);
    storage.giveConsent();
    expect(storage.consentGiven()).toBe(true);
  });

  it("still works when the browser blocks storage", () => {
    for (const raw of [throwing, null]) {
      const storage = createStorage(raw);
      const visitor = storage.visitorId();
      expect(storage.visitorId()).toBe(visitor);
      storage.saveConversation("pk_live_a", { conversationId: "c1", conversationToken: "t1" });
      expect(storage.loadConversation("pk_live_a")).toEqual({
        conversationId: "c1",
        conversationToken: "t1",
      });
      storage.giveConsent();
      expect(storage.consentGiven()).toBe(true);
    }
  });

  it("ignores corrupted saved data", () => {
    const raw = memoryStorage();
    const storage = createStorage(raw);
    raw.setItem("ace:conversation:pk_live_a", "{not json");
    expect(storage.loadConversation("pk_live_a")).toBeNull();
    raw.setItem("ace:conversation:pk_live_a", JSON.stringify({ conversationId: 5 }));
    expect(storage.loadConversation("pk_live_a")).toBeNull();
  });
});
