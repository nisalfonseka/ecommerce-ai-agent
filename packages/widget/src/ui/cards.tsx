import type { UiPart, VariantChoice } from "@ace/agent";
import { formatMoney, formatPriceRange } from "../money";
import { safeUrl } from "../safe-url";
import { CodSummary, DeliveryForm } from "./cod";

export type RunAction = (type: string, input: Record<string, unknown>) => void;

interface CardProps {
  part: UiPart;
  busy: boolean;
  onAction: RunAction;
}

const AVAILABILITY: Record<string, string> = {
  in_stock: "In stock",
  low_stock: "Only a few left",
  backorder: "On backorder",
  out_of_stock: "Out of stock",
};

function VariantButtons(props: {
  title: string;
  variants: VariantChoice[];
  busy: boolean;
  onAction: RunAction;
}) {
  if (props.variants.length === 0) return null;
  return (
    <fieldset class="variants">
      <legend class="sr-only">Sizes for {props.title}</legend>
      {props.variants.map((variant) => (
        <button
          type="button"
          key={variant.variantId}
          class="chip"
          disabled={props.busy || variant.availability === "out_of_stock"}
          aria-label={`Add ${props.title} ${variant.title} to cart`}
          onClick={() => props.onAction("add_to_cart", { variantId: variant.variantId, quantity: 1 })}
        >
          {variant.options.size ?? variant.title}
        </button>
      ))}
    </fieldset>
  );
}

export function Card({ part, busy, onAction }: CardProps) {
  switch (part.type) {
    case "product_list":
      return (
        <ul class="products">
          {part.items.map((item) => {
            const image = safeUrl(item.image?.url);
            const link = safeUrl(item.url);
            return (
              <li class="product" key={item.id}>
                {image && <img src={image} alt={item.image?.alt ?? item.title} loading="lazy" />}
                <div class="product-body">
                  <span class="ref">{item.ref}</span>
                  {link ? (
                    <a href={link} target="_blank" rel="noopener noreferrer" class="title">
                      {item.title}
                    </a>
                  ) : (
                    <span class="title">{item.title}</span>
                  )}
                  <span class="price">{formatPriceRange(item.priceRange)}</span>
                  <span class={`badge ${item.availability}`}>
                    {AVAILABILITY[item.availability] ?? item.availability}
                  </span>
                  <VariantButtons
                    title={item.title}
                    variants={item.variants}
                    busy={busy}
                    onAction={onAction}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      );
    case "product_detail": {
      const { product } = part;
      const variants: VariantChoice[] = product.variants.map((v) => ({
        variantId: v.id,
        title: v.title,
        options: v.options,
        price: v.price,
        availability: v.availability,
      }));
      return (
        <div class="card">
          <span class="title">{product.title}</span>
          <span class="price">{formatPriceRange(product.priceRange)}</span>
          <VariantButtons title={product.title} variants={variants} busy={busy} onAction={onAction} />
        </div>
      );
    }
    case "cart": {
      const { cart } = part;
      if (cart.lines.length === 0) return <div class="card">Your cart is empty.</div>;
      return (
        <div class="card cart">
          <ul>
            {cart.lines.map((line) => (
              <li key={line.id} class="line">
                <span>
                  {line.title} · {line.variantTitle}
                </span>
                <span class="qty">
                  <button
                    type="button"
                    aria-label={`One fewer ${line.title}`}
                    disabled={busy}
                    onClick={() =>
                      onAction("update_cart_line", { lineId: line.id, quantity: line.quantity - 1 })
                    }
                  >
                    −
                  </button>
                  <span>
                    <span class="sr-only">Quantity </span>
                    {line.quantity}
                  </span>
                  <button
                    type="button"
                    aria-label={`One more ${line.title}`}
                    disabled={busy || line.quantity >= 20}
                    onClick={() =>
                      onAction("update_cart_line", { lineId: line.id, quantity: line.quantity + 1 })
                    }
                  >
                    +
                  </button>
                </span>
                <span class="price">{formatMoney(line.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <div class="subtotal">
            <span>Subtotal</span>
            <span>{formatMoney(cart.subtotal)}</span>
          </div>
          <button
            type="button"
            class="primary"
            disabled={busy}
            onClick={() => onAction("start_checkout", {})}
          >
            Checkout
          </button>
        </div>
      );
    }
    case "checkout": {
      const url = safeUrl(part.checkout.url);
      return url ? (
        <a class="primary button" href={url} target="_top" rel="noopener">
          Go to checkout
        </a>
      ) : (
        <div class="card">The checkout link is not available. Please use the store's cart.</div>
      );
    }
    case "order": {
      const { order } = part;
      return (
        <div class="card">
          <span class="title">Order {order.number}</span>
          <span>Status: {order.status}</span>
          <span class="price">{formatMoney(order.total)}</span>
          {order.tracking.map((t) => {
            const link = safeUrl(t.url);
            return (
              <span key={t.number}>
                {t.carrier}:{" "}
                {link ? (
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    {t.number}
                  </a>
                ) : (
                  t.number
                )}
              </span>
            );
          })}
        </div>
      );
    }
    case "verification_required":
      return (
        <div class="card notice">To see order details, please verify your email or phone (coming soon).</div>
      );
    case "delivery_form":
      return (
        <DeliveryForm
          countryCode={part.countryCode}
          cities={part.cities}
          prefill={part.prefill}
          busy={busy}
          onAction={onAction}
        />
      );
    case "cod_summary":
      return <CodSummary part={part} busy={busy} onAction={onAction} />;
  }
}
