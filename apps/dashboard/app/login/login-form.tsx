"use client";

import { useState } from "react";

export function LoginForm() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="login-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || token.trim() === "") return;
        setBusy(true);
        setError(null);
        try {
          const response = await fetch("/api/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: token.trim() }),
          });
          if (!response.ok) throw new Error("That staff token is not valid.");
          window.location.assign("/inbox");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Sign in failed.");
          setBusy(false);
        }
      }}
    >
      <label>
        Staff token
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <button type="submit" disabled={busy || token.trim() === ""}>
        Sign in
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
