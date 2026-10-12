export interface HostHandlers {
  open(): void;
  close(): void;
  /** The host site's cart id; sent with every message and action (spec G2). */
  setCart(cartId: string | null): void;
}

type Queued = [string, ...unknown[]];

/**
 * Installs `window.ACE`. Sites may call it before the async script loads with the snippet
 * `window.ACE = window.ACE || { q: [] }; ACE.q.push(["setCart", "cart_123"]);`; those calls are replayed.
 */
export function installHostApi(win: Window & { ACE?: unknown }, handlers: HostHandlers): void {
  const queued = (win.ACE as { q?: unknown } | undefined)?.q;
  const api: HostHandlers = {
    open: () => handlers.open(),
    close: () => handlers.close(),
    setCart: (cartId) => handlers.setCart(typeof cartId === "string" && cartId.length > 0 ? cartId : null),
  };
  win.ACE = api;
  if (!Array.isArray(queued)) return;
  for (const call of queued as Queued[]) {
    const [method, ...args] = call;
    if (method === "open") api.open();
    else if (method === "close") api.close();
    else if (method === "setCart") api.setCart(args[0] as string | null);
  }
}

/** Tells the host page to refresh its cart badge (spec G2). */
export function emitCartUpdated(
  win: Window,
  detail: { cartId: string | null; itemCount: number | null },
): void {
  win.dispatchEvent(new CustomEvent("ace:cart-updated", { detail }));
}
