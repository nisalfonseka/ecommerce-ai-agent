import { useEffect, useId, useRef, useState } from "preact/hooks";

type Channel = "sms" | "email";
type StartResult =
  | { ok: true; maskedDestination: string; expiresInSeconds: number }
  | {
      ok: false;
      reason: "invalid_destination" | "channel_disabled" | "rate_limited" | "unavailable";
      retryAfterSeconds?: number;
    };
type ConfirmResult =
  | { ok: true; verified: true }
  | { ok: false; reason: "invalid_code" | "expired" | "locked" | "no_pending" };

function startError(result: Extract<StartResult, { ok: false }>): string {
  if (result.reason === "rate_limited") {
    const minutes = Math.max(1, Math.ceil((result.retryAfterSeconds ?? 60) / 60));
    return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  if (result.reason === "channel_disabled") return "That verification method is not available.";
  if (result.reason === "unavailable") return "Verification is unavailable right now. Please try again.";
  return "Enter a valid email address or phone number.";
}

function confirmError(result: Extract<ConfirmResult, { ok: false }>): string {
  if (result.reason === "invalid_code") return "Wrong code. Please try again.";
  if (result.reason === "locked") return "Verification is locked. Try again later.";
  if (result.reason === "expired") return "That code expired. Send a new code.";
  return "Send a new code to continue.";
}

export function VerificationForm(props: {
  channels: Channel[];
  onAction(type: string, input: Record<string, unknown>): Promise<unknown>;
}) {
  const [channel, setChannel] = useState<Channel>(props.channels[0] ?? "email");
  const [destination, setDestination] = useState("");
  const [masked, setMasked] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const destinationId = useId();
  const codeId = useId();

  useEffect(() => {
    if (masked) codeRef.current?.focus();
  }, [masked]);

  if (verified) {
    return (
      <div class="card verify" aria-live="polite">
        <strong>Verified</strong>
      </div>
    );
  }

  const start = async (event: Event) => {
    event.preventDefault();
    if (busy || destination.trim() === "") return;
    setBusy(true);
    setError(null);
    const result = (await props.onAction("verify_start", {
      channel,
      destination: destination.trim(),
    })) as StartResult | null;
    setBusy(false);
    if (!result) return setError("Verification is unavailable right now. Please try again.");
    if (!result.ok) return setError(startError(result));
    setMasked(result.maskedDestination);
  };

  const confirm = async (event: Event) => {
    event.preventDefault();
    if (busy || !/^\d{6}$/.test(code)) return;
    setBusy(true);
    setError(null);
    const result = (await props.onAction("verify_confirm", { code })) as ConfirmResult | null;
    setBusy(false);
    if (!result) return setError("Verification is unavailable right now. Please try again.");
    if (!result.ok) return setError(confirmError(result));
    setVerified(true);
  };

  return (
    <div class="card verify" aria-live="polite">
      {!masked ? (
        <form onSubmit={start}>
          <fieldset>
            <legend>Verify to see order details</legend>
            <div class="channel-choice">
              {props.channels.map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="verification-channel"
                    value={value}
                    checked={channel === value}
                    onChange={() => setChannel(value)}
                  />
                  {value === "sms" ? "SMS" : "Email"}
                </label>
              ))}
            </div>
            <label class="field" htmlFor={destinationId}>
              {channel === "sms" ? "Phone number" : "Email address"}
              {channel === "sms" ? (
                <input
                  type="tel"
                  id={destinationId}
                  autocomplete="tel"
                  value={destination}
                  onInput={(event) => setDestination((event.target as HTMLInputElement).value)}
                />
              ) : (
                <input
                  type="email"
                  id={destinationId}
                  autocomplete="email"
                  value={destination}
                  onInput={(event) => setDestination((event.target as HTMLInputElement).value)}
                />
              )}
            </label>
            <button type="submit" class="primary" disabled={busy || destination.trim() === ""}>
              Send code
            </button>
          </fieldset>
        </form>
      ) : (
        <form onSubmit={confirm}>
          <fieldset>
            <legend>Enter the code sent to {masked}</legend>
            <label class="field" htmlFor={codeId}>
              6-digit code
              <input
                ref={codeRef}
                id={codeId}
                inputMode="numeric"
                autocomplete="one-time-code"
                maxlength={6}
                pattern="[0-9]{6}"
                value={code}
                onInput={(event) =>
                  setCode((event.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, 6))
                }
              />
            </label>
            <button type="submit" class="primary" disabled={busy || !/^\d{6}$/.test(code)}>
              Verify
            </button>
          </fieldset>
        </form>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
