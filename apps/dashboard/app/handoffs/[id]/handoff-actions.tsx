"use client";

import { useState } from "react";

type Action = "claim" | "reply" | "hand-back" | "resolve";

export function HandoffActions({ id, status }: { id: string; status: "open" | "claimed" | "resolved" }) {
  const [pending, setPending] = useState<Action | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async (action: Action, body?: { text: string }) => {
    if (pending) return;
    setPending(action);
    setError(null);
    try {
      const response = await fetch(`/api/handoffs/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) throw new Error("The action could not be completed.");
      if (action === "reply") setReply("");
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
    } finally {
      setPending(null);
    }
  };

  if (status === "resolved") return <p>This conversation is resolved.</p>;
  return (
    <section className="actions" aria-busy={pending !== null}>
      <h2>Actions</h2>
      <button
        type="button"
        disabled={pending !== null || status !== "open"}
        onClick={() => void run("claim")}
      >
        Claim
      </button>
      <label>
        Reply
        <textarea
          value={reply}
          maxLength={2_000}
          disabled={pending !== null || status !== "claimed"}
          onChange={(event) => setReply(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={pending !== null || status !== "claimed" || reply.trim() === ""}
        onClick={() => void run("reply", { text: reply.trim() })}
      >
        Send reply
      </button>
      <button
        type="button"
        disabled={pending !== null || status !== "claimed"}
        onClick={() => void run("hand-back")}
      >
        Hand back to assistant
      </button>
      <button type="button" disabled={pending !== null} onClick={() => void run("resolve")}>
        Resolve
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
