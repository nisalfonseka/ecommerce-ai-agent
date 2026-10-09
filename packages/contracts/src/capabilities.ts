import { CommerceError } from "./errors";

export const CAPABILITIES = [
  "catalog.search",
  "catalog.read",
  "catalog.list",
  "inventory.read",
  "cart.write",
  "checkout.handoff",
  "orders.lookup",
  /** Contract v1.1: cash-on-delivery orders placed after the shopper confirms (ADR-007). */
  "orders.place_cod",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function requireCapability(
  provider: { platform: string; capabilities: ReadonlySet<Capability> },
  capability: Capability,
): void {
  if (!provider.capabilities.has(capability)) {
    throw new CommerceError("NOT_SUPPORTED", `${provider.platform} does not support ${capability}`, {
      capability,
    });
  }
}
