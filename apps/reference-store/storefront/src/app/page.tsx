import Link from "next/link";
import { formatPrice, listProducts } from "@/lib/medusa";

export const dynamic = "force-dynamic";

export default async function Home() {
  const products = await listProducts();
  return (
    <>
      <p className="muted">Island-wide delivery. Pay by card or cash on delivery.</p>
      <div className="grid">
        {products.map((product) => {
          const prices = product.variants.flatMap((v) => (v.calculated_price ? [v.calculated_price] : []));
          const from = prices.sort((a, b) => a.calculated_amount - b.calculated_amount)[0];
          return (
            <Link key={product.id} href={`/products/${product.handle}`} className="tile">
              {/* biome-ignore lint/performance/noImgElement: plain store images */}
              <img src={product.thumbnail ?? ""} alt={product.title} />
              <div>
                <span>{product.title}</span>
                {from ? (
                  <span className="price">{formatPrice(from.calculated_amount, from.currency_code)}</span>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
