import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("a shopper finds, adds and checks out through the widget, and the conversation survives a reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open shopping assistant" }).click();
  const dialog = page.getByRole("dialog", { name: "Shopping assistant" });
  await dialog.getByRole("button", { name: "Start chat" }).click();

  await dialog.getByRole("textbox", { name: "Message" }).fill("black dress");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByText("Black Satin Wrap Dress", { exact: true })).toBeVisible();
  await expect(dialog.getByText("LKR 18,500.00").first()).toBeVisible();
  // Sold-out sizes cannot be added.
  await expect(
    dialog.getByRole("button", { name: "Add Black Linen Shirt Black / L to cart" }),
  ).toBeDisabled();

  await dialog.getByRole("button", { name: "Add Black Satin Wrap Dress Black / M to cart" }).click();
  await expect(dialog.getByText("Subtotal")).toBeVisible();
  // The host page's own cart badge follows ace:cart-updated.
  await expect(page.locator("#cart-count")).toHaveText("1");

  await dialog.getByRole("button", { name: "One more Black Satin Wrap Dress" }).click();
  await expect(page.locator("#cart-count")).toHaveText("2");

  await dialog.getByRole("button", { name: "Checkout" }).last().click();
  await expect(dialog.getByRole("link", { name: "Go to checkout" })).toHaveAttribute(
    "href",
    /^https:\/\/demo-store\.test\/checkout\//,
  );

  await page.reload();
  await page.getByRole("button", { name: "Open shopping assistant" }).click();
  await expect(page.getByRole("dialog").getByText("black dress", { exact: true })).toBeVisible();
});

test("keyboard: Esc closes the assistant", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open shopping assistant" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the development outbox completes a real OTP verification", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open shopping assistant" }).click();
  const dialog = page.getByRole("dialog", { name: "Shopping assistant" });
  await dialog.getByRole("button", { name: "Start chat" }).click();
  await dialog.getByRole("textbox", { name: "Message" }).fill("hello");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByText(/Here is what I found/)).toBeVisible();

  const session = await page.evaluate(() => {
    const script = document.querySelector<HTMLScriptElement>("script[data-key]");
    const key = script?.dataset.key;
    const savedKey = Object.keys(localStorage).find((name) => name.startsWith("ace:conversation:"));
    const saved = savedKey ? JSON.parse(localStorage.getItem(savedKey) ?? "null") : null;
    return { key, saved } as {
      key?: string;
      saved: { conversationId?: string; conversationToken?: string } | null;
    };
  });
  expect(session.key).toMatch(/^pk_/);
  expect(session.saved?.conversationId).toBeTruthy();
  expect(session.saved?.conversationToken).toBeTruthy();
  const conversationId = String(session.saved?.conversationId);
  const conversationToken = String(session.saved?.conversationToken);
  const headers = {
    authorization: `Bearer ${session.key}`,
    origin: "http://localhost:5173",
    "x-conversation-token": conversationToken,
  };

  const started = await request.post("http://localhost:8080/v1/actions/verify_start", {
    headers,
    data: {
      conversationId,
      conversationToken,
      actionId: randomUUID(),
      input: { channel: "email", destination: "shopper@example.com" },
    },
  });
  expect(started.ok()).toBe(true);
  const outbox = await request.get(
    `http://localhost:8080/v1/dev/outbox?conversation=${encodeURIComponent(conversationId)}`,
    { headers },
  );
  expect(outbox.ok()).toBe(true);
  const body = (await outbox.json()) as { messages: { text: string }[] };
  const code = /\b\d{6}\b/.exec(body.messages[0]?.text ?? "")?.[0];
  expect(code).toMatch(/^\d{6}$/);

  const confirmed = await request.post("http://localhost:8080/v1/actions/verify_confirm", {
    headers,
    data: {
      conversationId,
      conversationToken,
      actionId: randomUUID(),
      input: { code },
    },
  });
  expect(await confirmed.json()).toEqual({ ok: true, verified: true });
});
