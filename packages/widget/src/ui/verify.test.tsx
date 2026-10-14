import type { UiPart } from "@ace/agent";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Card } from "./cards";

const part: UiPart = {
  type: "verification_form",
  channels: ["email", "sms"],
  reason: "order_lookup",
};

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

const button = (name: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent?.includes(name));

async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`missing ${selector}`);
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("VerificationForm", () => {
  it("sends and confirms a code without sending another chat message", async () => {
    const onAction = vi.fn(async (action: string) =>
      action === "verify_start"
        ? { ok: true as const, maskedDestination: "s***@e***.com", expiresInSeconds: 600 }
        : { ok: true as const, verified: true as const },
    );
    await act(async () => render(<Card part={part} busy={false} onAction={onAction} />, container));
    await type("input[type=email]", "shopper@example.com");
    await act(async () => button("Send code")?.closest("form")?.requestSubmit());

    const code = container.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]");
    expect(container.textContent).toContain("s***@e***.com");
    expect(code?.getAttribute("inputmode")).toBe("numeric");
    expect(document.activeElement).toBe(code);
    await type("input[autocomplete=one-time-code]", "123456");
    await act(async () => button("Verify")?.closest("form")?.requestSubmit());

    expect(container.textContent).toContain("Verified");
    expect(onAction.mock.calls).toEqual([
      ["verify_start", { channel: "email", destination: "shopper@example.com" }],
      ["verify_confirm", { code: "123456" }],
    ]);
  });

  it("shows rate-limit, wrong-code and locked errors without revealing attempts", async () => {
    const results = [
      { ok: false as const, reason: "rate_limited" as const, retryAfterSeconds: 121 },
      { ok: true as const, maskedDestination: "s***@e***.com", expiresInSeconds: 600 },
      { ok: false as const, reason: "invalid_code" as const },
      { ok: false as const, reason: "locked" as const },
    ];
    const onAction = vi.fn(async () => results.shift() ?? null);
    await act(async () => render(<Card part={part} busy={false} onAction={onAction} />, container));
    await type("input[type=email]", "shopper@example.com");
    await act(async () => button("Send code")?.closest("form")?.requestSubmit());
    expect(container.textContent).toContain("Try again in 3 minutes.");
    await act(async () => button("Send code")?.closest("form")?.requestSubmit());
    await type("input[autocomplete=one-time-code]", "123456");
    await act(async () => button("Verify")?.closest("form")?.requestSubmit());
    expect(container.textContent).toContain("Wrong code. Please try again.");
    expect(container.textContent).not.toMatch(/attempts? remaining/i);
    await act(async () => button("Verify")?.closest("form")?.requestSubmit());
    expect(container.textContent).toContain("Verification is locked. Try again later.");
  });
});
