export interface GraphQuery {
  graph(input: {
    entity: string;
    fields: string[];
    filters: Record<string, unknown>;
  }): Promise<{ data: Record<string, unknown>[] }>;
}

/** Inventory level -> inventory item -> variants -> products. Distinct, in first-seen order. */
export async function productIdsForInventoryLevel(query: GraphQuery, levelId: string): Promise<string[]> {
  const { data: levels } = await query.graph({
    entity: "inventory_level",
    fields: ["id", "inventory_item_id"],
    filters: { id: levelId },
  });
  const itemIds = levels.map((level) => level.inventory_item_id).filter((id) => typeof id === "string");
  if (itemIds.length === 0) return [];
  const { data: items } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "variants.product_id"],
    filters: { id: itemIds },
  });
  const ids = new Set<string>();
  for (const item of items) {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    for (const variant of variants) {
      const productId = (variant as { product_id?: unknown } | null)?.product_id;
      if (typeof productId === "string") ids.add(productId);
    }
  }
  return [...ids];
}
