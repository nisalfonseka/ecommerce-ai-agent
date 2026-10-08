import type { Money, Order, OrderOwner, Product, VerifiedIdentity } from "@ace/contracts";
import type { ConformanceFixtures } from "@ace/contracts/testing";

export interface SeedOrder {
  order: Order;
  owner: OrderOwner;
}

export interface MemorySeed {
  currency: string;
  products: Product[];
  /** variantId → units available. Variant availability is derived from this at read time. */
  stock: Record<string, number>;
  orders: SeedOrder[];
}

const UPDATED_AT = "2026-10-01T00:00:00.000Z";
const BASE_URL = "https://demo-store.test";

function lkr(rupees: number): Money {
  return { amount: rupees * 100, currency: "LKR" };
}

interface ProductSpec {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  attributes: Record<string, string[]>;
  color: string;
  sizes: string[];
  priceRupees: number;
}

function clothingProduct(spec: ProductSpec): Product {
  const handle = spec.id.replace(/^p_/, "").replaceAll("_", "-");
  const price = lkr(spec.priceRupees);
  return {
    id: spec.id,
    handle,
    title: spec.title,
    description: spec.description,
    url: `${BASE_URL}/products/${handle}`,
    category: spec.category,
    tags: spec.tags,
    attributes: spec.attributes,
    images: [{ url: `${BASE_URL}/images/${handle}.jpg`, alt: spec.title }],
    options: [
      { name: "color", values: [spec.color] },
      { name: "size", values: spec.sizes },
    ],
    variants: spec.sizes.map((size) => ({
      id: `${spec.id}_${size.toLowerCase()}`,
      productId: spec.id,
      sku: `${handle}-${size}`.toUpperCase(),
      title: `${spec.color} / ${size}`,
      options: { color: spec.color, size },
      price,
      availability: "in_stock" as const,
    })),
    priceRange: { min: price, max: price },
    updatedAt: UPDATED_AT,
  };
}

const PRODUCTS: ProductSpec[] = [
  {
    id: "p_linen_shirt_black",
    title: "Black Linen Shirt",
    description: "Breathable linen shirt with a relaxed fit for hot days.",
    category: "shirt",
    tags: ["men", "summer"],
    attributes: { color: ["black"], fabric: ["linen"], occasion: ["casual", "office"] },
    color: "Black",
    sizes: ["S", "M", "L"],
    priceRupees: 6500,
  },
  {
    id: "p_oxford_shirt_white",
    title: "White Oxford Shirt",
    description: "Classic cotton oxford shirt.",
    category: "shirt",
    tags: ["men"],
    attributes: { color: ["white"], fabric: ["cotton"], occasion: ["office", "formal"] },
    color: "White",
    sizes: ["M", "L", "XL"],
    priceRupees: 5900,
  },
  {
    id: "p_wrap_dress_black",
    title: "Black Satin Wrap Dress",
    description: "Elegant satin wrap dress for evening events and weddings.",
    category: "dress",
    tags: ["women", "evening"],
    attributes: { color: ["black"], fabric: ["satin"], occasion: ["wedding", "party", "formal"] },
    color: "Black",
    sizes: ["S", "M", "L"],
    priceRupees: 18500,
  },
  {
    id: "p_maxi_dress_floral",
    title: "Floral Maxi Dress",
    description: "Light floral maxi dress for the beach and weekends.",
    category: "dress",
    tags: ["women", "summer"],
    attributes: { color: ["multicolor"], pattern: ["floral"], occasion: ["casual", "beach"] },
    color: "Floral",
    sizes: ["S", "M"],
    priceRupees: 12900,
  },
  {
    id: "p_kurta_navy",
    title: "Navy Cotton Kurta",
    description: "Cotton kurta for festive occasions.",
    category: "kurta",
    tags: ["men", "festive"],
    attributes: { color: ["navy"], fabric: ["cotton"], occasion: ["festive", "casual"] },
    color: "Navy",
    sizes: ["M", "L"],
    priceRupees: 7900,
  },
  {
    id: "p_chinos_black",
    title: "Black Slim Chinos",
    description: "Slim-fit stretch chinos.",
    category: "trousers",
    tags: ["men"],
    attributes: { color: ["black"], fabric: ["cotton"], occasion: ["office", "casual"] },
    color: "Black",
    sizes: ["30", "32", "34"],
    priceRupees: 8900,
  },
];

const STOCK: Record<string, number> = {
  p_linen_shirt_black_s: 5,
  p_linen_shirt_black_m: 3,
  p_linen_shirt_black_l: 0,
  p_oxford_shirt_white_m: 10,
  p_oxford_shirt_white_l: 2,
  p_oxford_shirt_white_xl: 1,
  p_wrap_dress_black_s: 2,
  p_wrap_dress_black_m: 4,
  p_wrap_dress_black_l: 1,
  p_maxi_dress_floral_s: 0,
  p_maxi_dress_floral_m: 6,
  p_kurta_navy_m: 4,
  p_kurta_navy_l: 4,
  p_chinos_black_30: 3,
  p_chinos_black_32: 3,
  p_chinos_black_34: 0,
};

const ORDERS: SeedOrder[] = [
  {
    order: {
      id: "ord_1001",
      number: "ACE-1001",
      status: "shipped",
      paymentStatus: "paid",
      placedAt: "2026-09-28T10:15:00.000Z",
      total: lkr(18500),
      lines: [
        { title: "Black Satin Wrap Dress", variantTitle: "Black / M", quantity: 1, unitPrice: lkr(18500) },
      ],
      tracking: [
        {
          carrier: "Demo Courier",
          number: "DC123456789",
          url: "https://tracking.demo-store.test/DC123456789",
        },
      ],
    },
    owner: { email: "customer@example.com", phone: "+94771234567" },
  },
];

/** A fresh, deep-copied seed — mutating it never affects other providers. */
export function defaultSeed(): MemorySeed {
  return structuredClone({
    currency: "LKR",
    products: PRODUCTS.map(clothingProduct),
    stock: STOCK,
    orders: ORDERS,
  });
}

const verifiedAt = "2026-10-01T00:00:00.000Z";
const owner: VerifiedIdentity = { method: "email_otp", email: "customer@example.com", verifiedAt };
const stranger: VerifiedIdentity = { method: "email_otp", email: "someone-else@example.com", verifiedAt };

export const memoryFixtures: ConformanceFixtures = {
  searchTerm: "black",
  productId: "p_wrap_dress_black",
  inStockVariantId: "p_wrap_dress_black_m",
  outOfStockVariantId: "p_linen_shirt_black_l",
  orderNumber: "ACE-1001",
  orderOwner: owner,
  stranger,
};
