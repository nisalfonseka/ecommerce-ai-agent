/**
 * The reference store's catalog: the same clothing as the memory adapter's seed (packages/adapter-memory), so
 * conformance fixtures and demos behave the same on both. Prices are LKR in major units (Medusa v2 stores
 * major units; the adapter converts to minor units).
 */
export interface CatalogProduct {
  /** Stable key, also the SKU prefix: "wrap-dress-black" → SKU "WRAP-DRESS-BLACK-M". */
  handle: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  attributes: Record<string, string[]>;
  color: string;
  /** Size → units in stock. */
  sizes: Record<string, number>;
  priceLkr: number;
}

export const CATALOG: CatalogProduct[] = [
  {
    handle: "linen-shirt-black",
    title: "Black Linen Shirt",
    description: "Breathable linen shirt with a relaxed fit for hot days.",
    category: "shirt",
    tags: ["men", "summer"],
    attributes: { color: ["black"], fabric: ["linen"], occasion: ["casual", "office"] },
    color: "Black",
    sizes: { S: 5, M: 3, L: 0 },
    priceLkr: 6500,
  },
  {
    handle: "oxford-shirt-white",
    title: "White Oxford Shirt",
    description: "Classic cotton oxford shirt.",
    category: "shirt",
    tags: ["men"],
    attributes: { color: ["white"], fabric: ["cotton"], occasion: ["office", "formal"] },
    color: "White",
    sizes: { M: 10, L: 2, XL: 1 },
    priceLkr: 5900,
  },
  {
    handle: "wrap-dress-black",
    title: "Black Satin Wrap Dress",
    description: "Elegant satin wrap dress for evening events and weddings.",
    category: "dress",
    tags: ["women", "evening"],
    attributes: { color: ["black"], fabric: ["satin"], occasion: ["wedding", "party", "formal"] },
    color: "Black",
    sizes: { S: 2, M: 4, L: 1 },
    priceLkr: 18500,
  },
  {
    handle: "maxi-dress-floral",
    title: "Floral Maxi Dress",
    description: "Light floral maxi dress for the beach and weekends.",
    category: "dress",
    tags: ["women", "summer"],
    attributes: { color: ["multicolor"], pattern: ["floral"], occasion: ["casual", "beach"] },
    color: "Floral",
    sizes: { S: 0, M: 6 },
    priceLkr: 12900,
  },
  {
    handle: "kurta-navy",
    title: "Navy Cotton Kurta",
    description: "Cotton kurta for festive occasions.",
    category: "kurta",
    tags: ["men", "festive"],
    attributes: { color: ["navy"], fabric: ["cotton"], occasion: ["festive", "casual"] },
    color: "Navy",
    sizes: { M: 4, L: 4 },
    priceLkr: 7900,
  },
  {
    handle: "chinos-black",
    title: "Black Slim Chinos",
    description: "Slim-fit stretch chinos.",
    category: "trousers",
    tags: ["men"],
    attributes: { color: ["black"], fabric: ["cotton"], occasion: ["office", "casual"] },
    color: "Black",
    sizes: { "30": 3, "32": 3, "34": 0 },
    priceLkr: 8900,
  },
];

export const sku = (handle: string, size: string): string => `${handle}-${size}`.toUpperCase();

/** Island-wide flat delivery fee (LKR, major units). */
export const DELIVERY_FEE_LKR = 400;

/** The order-lookup fixture: an existing order owned by this shopper. */
export const FIXTURE_CUSTOMER = { email: "customer@example.com", phone: "+94771234567" };
