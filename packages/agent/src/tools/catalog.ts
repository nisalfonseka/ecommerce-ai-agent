import { CommerceError, isCommerceError, type Product } from "@ace/contracts";
import { z } from "zod";
import { observeMoney, type ToolContext } from "../context";
import { formatMoney, formatPriceRange, toMinorUnits } from "../format";
import { rememberShown } from "../session";
import { runTool } from "../tool-result";
import type { VariantChoice } from "../ui";
import { defineTool } from "./define";
import { resolveProductId } from "./resolve";

const SEARCH_LIMIT = 5;

const ProductPointer = {
  ref: z.string().optional().describe('A number from the latest results, e.g. "#2"'),
  productId: z.string().optional(),
};

function optionFilter(input: {
  color?: string | undefined;
  size?: string | undefined;
}): Record<string, string[]> | undefined {
  const options: Record<string, string[]> = {};
  if (input.color) options.color = [input.color];
  if (input.size) options.size = [input.size];
  return Object.keys(options).length > 0 ? options : undefined;
}

function matchesOptions(
  options: Record<string, string>,
  wanted: Record<string, string[]> | undefined,
): boolean {
  for (const [name, values] of Object.entries(wanted ?? {})) {
    const actual = options[name]?.toLowerCase();
    if (actual === undefined || !values.some((value) => value.toLowerCase() === actual)) return false;
  }
  return true;
}

async function requireProduct(ctx: ToolContext, productId: string): Promise<Product> {
  const product = await ctx.provider.getProduct(productId);
  if (!product) throw new CommerceError("NOT_FOUND", `No product with id ${productId}.`, { productId });
  observeMoney(ctx, product);
  return product;
}

/**
 * Live size/colour choices for a product card (UI only; the model never sees them). A card whose product
 * cannot be read gets no choices instead of failing the whole search.
 */
async function cardVariants(
  ctx: ToolContext,
  productId: string,
  matching: string[],
): Promise<VariantChoice[]> {
  try {
    const product = await ctx.provider.getProduct(productId);
    if (!product) return [];
    observeMoney(ctx, product.variants);
    const wanted = new Set(matching);
    return product.variants
      .filter((variant) => wanted.size === 0 || wanted.has(variant.id))
      .map((variant) => ({
        variantId: variant.id,
        title: variant.title,
        options: variant.options,
        price: variant.price,
        availability: variant.availability,
      }));
  } catch (error) {
    if (!isCommerceError(error)) ctx.onUnexpectedError(error);
    return [];
  }
}

export const searchProductsTool = defineTool({
  name: "search_products",
  description:
    "Search the store's catalog. Use it for every product question before answering. Translate the shopper's words into short English catalog terms (e.g. 'black dress', 'linen shirt'). Prices are in rupees. Results are numbered #1..#n; refer to products by these numbers.",
  requires: ["catalog.search"],
  inputSchema: z.object({
    query: z.string().trim().min(1).max(200).optional(),
    category: z.string().optional().describe("dress, shirt, trousers, kurta"),
    color: z.string().optional(),
    size: z.string().optional().describe("S, M, L, XL, or waist sizes like 32"),
    minPrice: z.number().nonnegative().optional().describe("rupees"),
    maxPrice: z.number().positive().optional().describe("rupees"),
    inStockOnly: z.boolean().optional(),
  }),
  run: (ctx, input) =>
    runTool(async () => {
      const result = await ctx.provider.searchProducts({
        query: input.query,
        filters: {
          category: input.category,
          options: optionFilter(input),
          priceMin: toMinorUnits(input.minPrice),
          priceMax: toMinorUnits(input.maxPrice),
          inStockOnly: input.inStockOnly,
        },
        limit: SEARCH_LIMIT,
      });
      observeMoney(ctx, result.items);
      const shown = rememberShown(
        ctx.session,
        result.items.map((item) => ({
          productId: item.id,
          title: item.title,
          variantIds: item.matchingVariantIds,
        })),
      );
      const variants = await Promise.all(
        result.items.map((item) => cardVariants(ctx, item.id, item.matchingVariantIds)),
      );
      const items = result.items.map((item, index) => ({
        ...item,
        ref: shown[index]?.ref ?? `#${index + 1}`,
        variants: variants[index] ?? [],
      }));
      ctx.ui.push({ type: "product_list", items });
      return {
        items: items.map((item) => ({
          ref: item.ref,
          productId: item.id,
          title: item.title,
          price: formatPriceRange(item.priceRange),
          availability: item.availability,
        })),
        more: result.nextCursor !== null,
      };
    }, ctx.onUnexpectedError),
});

export const getProductTool = defineTool({
  name: "get_product",
  description:
    "Get full details of one product: description, fabric and occasion attributes, every size/colour variant with price and availability. Use before recommending a size or answering detailed questions.",
  requires: ["catalog.read"],
  inputSchema: z.object(ProductPointer),
  run: (ctx, input) =>
    runTool(async () => {
      const product = await requireProduct(ctx, resolveProductId(ctx, input));
      ctx.ui.push({ type: "product_detail", product });
      return {
        productId: product.id,
        title: product.title,
        description: product.description,
        category: product.category,
        attributes: product.attributes,
        variants: product.variants.map((variant) => ({
          variantId: variant.id,
          title: variant.title,
          options: variant.options,
          price: formatMoney(variant.price),
          availability: variant.availability,
        })),
      };
    }, ctx.onUnexpectedError),
});

export const checkAvailabilityTool = defineTool({
  name: "check_availability",
  description:
    "Check live stock for a product, optionally for one size and/or colour. Use before telling a shopper something is available.",
  requires: ["catalog.read", "inventory.read"],
  inputSchema: z.object({ ...ProductPointer, size: z.string().optional(), color: z.string().optional() }),
  run: (ctx, input) =>
    runTool(async () => {
      const product = await requireProduct(ctx, resolveProductId(ctx, input));
      const wanted = optionFilter(input);
      const variants = product.variants.filter((variant) => matchesOptions(variant.options, wanted));
      const levels = variants.length > 0 ? await ctx.provider.getInventory(variants.map((v) => v.id)) : [];
      const byId = new Map(levels.map((level) => [level.variantId, level]));
      return {
        productId: product.id,
        variants: variants.map((variant) => {
          const level = byId.get(variant.id);
          // A variant the store omits from inventory is unsellable; null means the store hides exact counts.
          return {
            variantId: variant.id,
            title: variant.title,
            availability: level?.availability ?? "out_of_stock",
            quantityAvailable: level ? level.quantityAvailable : 0,
          };
        }),
      };
    }, ctx.onUnexpectedError),
});
