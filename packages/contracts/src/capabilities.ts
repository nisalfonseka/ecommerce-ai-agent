import { CommerceError } from "./errors";

export const CAPABILITIES = [
  "catalog.search",
  "catalog.read",
  "catalog.list",
  "inventory.read",
  "cart.write",
  "checkout.handoff",
  "orders.lookup",
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
