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
