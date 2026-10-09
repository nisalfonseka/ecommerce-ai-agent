import type { Capability } from "../capabilities";
import { CommerceError } from "../errors";
import type { CommerceProvider } from "../provider";
import { sampleProduct } from "../test-fixtures";
import { describeProviderConformance } from "./conformance";

const notSupported = () => Promise.reject(new CommerceError("NOT_SUPPORTED", "stub"));
const verifiedAt = "2026-10-01T00:00:00.000Z";

/** Declares only catalog.read: the suite must run that test and skip every other capability test. */
function readOnlyStub(): CommerceProvider {
  const product = sampleProduct();
  return {
    platform: "stub",
    capabilities: new Set<Capability>(["catalog.read"]),
    getProduct: async (id) => (id === product.id ? product : null),
    searchProducts: notSupported,
    listProducts: notSupported,
    getInventory: notSupported,
    createCart: notSupported,
    getCart: notSupported,
    addCartLines: notSupported,
    updateCartLine: notSupported,
    updateCartAttributes: notSupported,
    createCheckout: notSupported,
    lookupOrder: notSupported,
    listOrders: notSupported,
  };
}

describeProviderConformance("read-only stub", async () => ({
  provider: readOnlyStub(),
  fixtures: {
    searchTerm: "dress",
    productId: "prod_dress",
    inStockVariantId: "unused",
    outOfStockVariantId: "unused",
    orderNumber: "unused",
    orderOwner: { method: "email_otp", email: "owner@example.com", verifiedAt },
    stranger: { method: "email_otp", email: "stranger@example.com", verifiedAt },
  },
}));
