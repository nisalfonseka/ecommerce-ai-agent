import { readFileSync } from "node:fs";
import type { ConformanceControl } from "@ace/contracts/testing";
import { describeProviderConformance } from "@ace/contracts/testing";
import { describe, it } from "vitest";
import { z } from "zod";
import { MedusaHttp } from "./http";
import { MedusaCommerceProvider } from "./medusa-provider";
import { InventoryItemsResponse, VariantsResponse } from "./responses";

/**
 * Runs the contract suite against a real Medusa backend (scripts/reference-store.sh start). Set
 * ACE_MEDUSA_SEED_OUTPUT to the seed's JSON; CI also sets ACE_REQUIRE_MEDUSA_TESTS=1 so a skip fails the job.
 */
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

const path = process.env.ACE_MEDUSA_SEED_OUTPUT;
if (!path && process.env.ACE_REQUIRE_MEDUSA_TESTS === "1") {
  throw new Error("ACE_REQUIRE_MEDUSA_TESTS=1 but ACE_MEDUSA_SEED_OUTPUT is not set");
}

if (path) {
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
        {
          body: { stocked_quantity: quantity + (level.reserved_quantity ?? 0) },
        },
      );
    },
  };

  // Earlier runs and manual tests place orders, which reserve stock: start from the seeded quantities.
  let reset: Promise<void> | undefined;
  const fixtures = {
    ...seed.fixtures,
    orderOwner: {
      method: "email_otp",
      email: seed.fixtures.orderOwnerEmail,
      verifiedAt: "2026-10-01T00:00:00.000Z",
    },
    stranger: { method: "email_otp", email: "stranger@example.com", verifiedAt: "2026-10-01T00:00:00.000Z" },
    control,
  } as const;

  describeProviderConformance(
    "medusa",
    async () => {
      reset ??= (async () => {
        await control.setStock(seed.fixtures.inStockVariantId, seed.fixtures.inStockQuantity);
        await control.setStock(seed.fixtures.outOfStockVariantId, 0);
      })();
      await reset;
      return {
        provider: new MedusaCommerceProvider({
          baseUrl: seed.backendUrl,
          publishableKey: seed.publishableKey,
          secretKey: seed.secretKey,
          regionId: seed.regionId,
          storefrontUrl: seed.storefrontUrl,
        }),
        fixtures,
      };
    },
    { replay: false },
  );
} else {
  describe.skip("Medusa conformance (needs ACE_MEDUSA_SEED_OUTPUT; see scripts/reference-store.sh)", () => {
    it("skipped", () => {});
  });
}
