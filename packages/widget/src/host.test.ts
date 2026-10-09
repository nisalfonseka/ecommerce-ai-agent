import { describe, expect, it, vi } from "vitest";
import { emitCartUpdated, installHostApi } from "./host";

describe("installHostApi", () => {
  it("replays calls queued before the script loaded, then serves direct calls", () => {
    const win = window as Window & { ACE?: unknown };
    win.ACE = { q: [["setCart", "cart_early"], ["open"], ["unknown", 1]] };
    const handlers = { open: vi.fn(), close: vi.fn(), setCart: vi.fn() };
    installHostApi(win, handlers);
    expect(handlers.setCart).toHaveBeenCalledWith("cart_early");
    expect(handlers.open).toHaveBeenCalledTimes(1);
    (win.ACE as { setCart(id: string | null): void }).setCart("cart_late");
    expect(handlers.setCart).toHaveBeenLastCalledWith("cart_late");
  });
});

describe("emitCartUpdated", () => {
  it("dispatches ace:cart-updated on window with the cart id and item count", () => {
    const seen: unknown[] = [];
    window.addEventListener("ace:cart-updated", (event) => seen.push((event as CustomEvent).detail));
    emitCartUpdated(window, { cartId: "cart_1", itemCount: 2 });
    expect(seen).toEqual([{ cartId: "cart_1", itemCount: 2 }]);
  });
});
