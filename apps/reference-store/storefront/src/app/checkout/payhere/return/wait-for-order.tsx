"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { completeAfterPayhere } from "../../../actions";

export function WaitForOrder({ cartId }: { cartId: string }) {
  const router = useRouter();
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let stopped = false;
    const attempt = async () => {
      const order = await completeAfterPayhere(cartId);
      if (stopped) return;
      if (order) router.replace(`/order/confirmed?number=${order.number}`);
      else if (tries < 20) setTimeout(() => setTries((n) => n + 1), 3000);
    };
    void attempt();
    return () => {
      stopped = true;
    };
  }, [cartId, router, tries]);
  return (
    <p>
      {tries < 20
        ? "Confirming your payment with PayHere…"
        : "We are still waiting for PayHere. We will email you once the payment is confirmed."}
    </p>
  );
}
