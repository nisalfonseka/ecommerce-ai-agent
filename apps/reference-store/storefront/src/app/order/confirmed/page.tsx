import Link from "next/link";

export default async function OrderConfirmed({
  searchParams,
}: {
  searchParams: Promise<{ number?: string }>;
}) {
  const number = (await searchParams).number ?? "";
  return (
    <>
      <h2>Thank you!</h2>
      <p>
        Your order <strong data-testid="order-number">#{/^\d+$/.test(number) ? number : ""}</strong> is
        placed.
      </p>
      <Link href="/">Continue shopping</Link>
    </>
  );
}
