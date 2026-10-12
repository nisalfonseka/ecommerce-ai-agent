import { type Db, getCatalogProduct, setEmbedding, withTenant } from "@ace/db";
import type { Embedder } from "@ace/knowledge";
import { z } from "zod";
import { embeddingHash, embeddingText } from "./rows";

const StringLists = z.record(z.string(), z.array(z.string())).catch({});

/**
 * The embed.product job body. Embeds the stored row's embedding text (purpose "document") and stores the vector,
 * its hash and the embedder's model. Skipped when the stored hash and model already match; "missing" for an
 * unknown or deleted product. The model call runs outside any transaction.
 */
export async function embedStoredProduct(
  deps: { db: Db; tenantId: string; storeId: string; embedder: Embedder },
  productId: string,
): Promise<"embedded" | "skipped" | "missing"> {
  const row = await withTenant(deps.db, deps.tenantId, (tx) =>
    getCatalogProduct(tx, deps.storeId, productId),
  );
  if (row?.status !== "active") return "missing";
  const text = embeddingText({
    title: row.title,
    category: row.category,
    attributes: StringLists.parse(row.attributes),
    tags: row.tags,
    description: row.description,
  });
  const hash = embeddingHash(text);
  if (row.embeddedHash === hash && row.embeddingModel === deps.embedder.model) return "skipped";

  const [embedding] = await deps.embedder.embed([text], "document");
  if (!embedding) throw new Error("embedder returned no vector");
  // The hash is the one we embedded: if the row changed meanwhile, the next job sees a mismatch and re-embeds.
  await withTenant(deps.db, deps.tenantId, (tx) =>
    setEmbedding(tx, deps.storeId, productId, {
      embedding,
      embeddedHash: hash,
      embeddingModel: deps.embedder.model,
    }),
  );
  return "embedded";
}
