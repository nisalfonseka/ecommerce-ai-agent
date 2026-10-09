import { notFound } from "next/navigation";
import { formatPrice, getProductByHandle } from "@/lib/medusa";
import { AddToCart } from "./add-to-cart";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ handle: string }> }) {
  const product = await getProductByHandle((await params).handle);
  if (!product) notFound();
  const variants = product.variants.map((variant) => ({
    id: variant.id,
    title: variant.title,
    price: variant.calculated_price
      ? formatPrice(variant.calculated_price.calculated_amount, variant.calculated_price.currency_code)
      : null,
    soldOut: Boolean(variant.manage_inventory) && (variant.inventory_quantity ?? 0) <= 0,
  }));
  return (
    <div className="product">
      {/* biome-ignore lint/performance/noImgElement: plain store images */}
      <img src={product.thumbnail ?? ""} alt={product.title} />
      <div>
        <h2>{product.title}</h2>
        <p className="muted">{product.description}</p>
        <AddToCart variants={variants} />
      </div>
    </div>
  );
}
