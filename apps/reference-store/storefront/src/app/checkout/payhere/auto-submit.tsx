"use client";

import { useEffect, useRef } from "react";

export function AutoSubmit({ action, fields }: { action: string; fields: Record<string, string> }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => form.current?.submit(), []);
  return (
    <form ref={form} method="post" action={action}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p>Taking you to PayHere…</p>
      <noscript>
        <button type="submit">Continue to PayHere</button>
      </noscript>
    </form>
  );
}
