import type { Product, Variant } from "./catalog";

/** Test-only builders. Not exported from the package index. */
export function sampleVariant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "var_dress_m",
    productId: "prod_dress",
    sku: "DRESS-M",
    title: "Black / M",
    options: { color: "Black", size: "M" },
    price: { amount: 1850000, currency: "LKR" },
    availability: "in_stock",
    ...overrides,
  };
}

export function sampleProduct(overrides: Partial<Product> = {}): Product {
  const variant = sampleVariant();
  return {
    id: "prod_dress",
    handle: "black-wrap-dress",
    title: "Black Satin Wrap Dress",
    description: "A satin wrap dress for evening events.",
    url: "https://demo-store.test/products/black-wrap-dress",
    category: "dress",
    tags: ["women"],
    attributes: { color: ["black"], occasion: ["wedding", "party"] },
    images: [{ url: "https://demo-store.test/images/dress.jpg", alt: "Black Satin Wrap Dress" }],
    options: [
      { name: "color", values: ["Black"] },
      { name: "size", values: ["M"] },
    ],
    variants: [variant],
    priceRange: { min: variant.price, max: variant.price },
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}
