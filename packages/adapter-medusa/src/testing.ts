import { readFileSync } from "node:fs";
import type { ConformanceControl, ConformanceFixtures } from "@ace/contracts/testing";
import { z } from "zod";
import { MedusaHttp } from "./http";
import { MedusaCommerceProvider } from "./medusa-provider";
import { InventoryItemsResponse, VariantsResponse } from "./responses";

/** The reference store seed's output (apps/reference-store/backend/src/scripts/seed.ts). */
const SeedOutput = z.object({
  backendUrl: z.url(),
  storefrontUrl: z.url(),
  publishableKey: z.string(),
  secretKey: z.string(),
  regionId: z.string(),
  stockLocationId: z.string(),
  fixtures: z.object({
    searchTerm: z.string(),
    productId: z.string(),
    inStockVariantId: z.string(),
    inStockQuantity: z.number(),
    outOfStockVariantId: z.string(),
    orderNumber: z.string(),
    orderOwnerEmail: z.email(),
  }),
});

/**
 * Test-only: the conformance subject for a running reference store, from ACE_MEDUSA_SEED_OUTPUT. Returns null
 * when it is not set; throws when ACE_REQUIRE_MEDUSA_TESTS=1 demands it (CI).
 */
export function medusaConformance(): {
  provider: () => MedusaCommerceProvider;
  fixtures: ConformanceFixtures;
  /** Puts the fixture variants back to their seeded stock (orders from earlier runs reserve units). */
  resetStock: () => Promise<void>;
} | null {
  const path = process.env.ACE_MEDUSA_SEED_OUTPUT;
  if (!path) {
    if (process.env.ACE_REQUIRE_MEDUSA_TESTS === "1") {
      throw new Error("ACE_REQUIRE_MEDUSA_TESTS=1 but ACE_MEDUSA_SEED_OUTPUT is not set");
    }
    return null;
  }
  const seed = SeedOutput.parse(JSON.parse(readFileSync(path, "utf8")));
  const http = new MedusaHttp({ ...seed, baseUrl: seed.backendUrl, timeoutMs: 10_000, fetch });

  /** Sets a variant's *available* units at the seed's location: stocked = wanted + reserved by open orders. */
  const control: ConformanceControl = {
    async setStock(variantId, quantity) {
      const { variants } = await http.store(VariantsResponse, "GET", "/store/product-variants", {
        query: { id: [variantId], fields: "id,sku" },
      });
      const sku = variants[0]?.sku;
      if (!sku) throw new Error(`variant ${variantId} has no sku`);
      const { inventory_items } = await http.admin(InventoryItemsResponse, "GET", "/admin/inventory-items", {
        query: { sku, fields: "id,*location_levels" },
      });
      const item = inventory_items[0];
      const level = item?.location_levels?.find(
        (candidate) => candidate.location_id === seed.stockLocationId,
      );
      if (!item || !level) throw new Error(`no inventory level for ${sku}`);
      await http.admin(
        z.unknown(),
        "POST",
        `/admin/inventory-items/${item.id}/location-levels/${seed.stockLocationId}`,
        { body: { stocked_quantity: quantity + (level.reserved_quantity ?? 0) } },
      );
    },
  };

  const verifiedAt = "2026-10-01T00:00:00.000Z";
  return {
    provider: () =>
      new MedusaCommerceProvider({
        baseUrl: seed.backendUrl,
        publishableKey: seed.publishableKey,
        secretKey: seed.secretKey,
        regionId: seed.regionId,
        storefrontUrl: seed.storefrontUrl,
      }),
    fixtures: {
      searchTerm: seed.fixtures.searchTerm,
      productId: seed.fixtures.productId,
      inStockVariantId: seed.fixtures.inStockVariantId,
      inStockQuantity: seed.fixtures.inStockQuantity,
      outOfStockVariantId: seed.fixtures.outOfStockVariantId,
      orderNumber: seed.fixtures.orderNumber,
      orderOwner: { method: "email_otp", email: seed.fixtures.orderOwnerEmail, verifiedAt },
      stranger: { method: "email_otp", email: "stranger@example.com", verifiedAt },
      control,
    },
    resetStock: async () => {
      await control.setStock(seed.fixtures.inStockVariantId, seed.fixtures.inStockQuantity);
      await control.setStock(seed.fixtures.outOfStockVariantId, 0);
    },
  };
}
