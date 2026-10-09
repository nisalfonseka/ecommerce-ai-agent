import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const seed = JSON.parse(
  readFileSync(`${process.env.TMPDIR ?? "/tmp"}/ace-store/seed-output.json`, "utf8"),
) as {
  backendUrl: string;
  secretKey: string;
};

async function adminOrder(displayId: string) {
  const auth = `Basic ${Buffer.from(`${seed.secretKey}:`).toString("base64")}`;
  const response = await fetch(
    `${seed.backendUrl}/admin/orders?q=${displayId}&order=display_id&fields=id,display_id,metadata,total&limit=50`,
    { headers: { authorization: auth } },
  );
  const { orders } = (await response.json()) as {
    orders: { display_id: number; metadata: Record<string, string> | null; total: number }[];
  };
  return orders.find((order) => String(order.display_id) === displayId);
}

test("chat card → shared cart → storefront checkout → cash on delivery, with attribution", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Black Satin Wrap Dress").first()).toBeVisible();
  await expect(page.getByTestId("cart-count")).toHaveText("0");

  await page.getByRole("button", { name: "Open shopping assistant" }).click();
  const dialog = page.getByRole("dialog", { name: "Shopping assistant" });
  await dialog.getByRole("button", { name: "Start chat" }).click();
  await dialog.getByRole("textbox", { name: "Message" }).fill("black dress");
  await dialog.getByRole("button", { name: "Send" }).click();
  // Live from Medusa through @ace/adapter-medusa: price and a sold-out size.
  await expect(dialog.getByText("LKR 18,500.00").first()).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Add Black Linen Shirt Black / L to cart" }),
  ).toBeDisabled();

  await dialog.getByRole("button", { name: "Add Black Satin Wrap Dress Black / M to cart" }).click();
  await expect(dialog.getByText("Subtotal")).toBeVisible();
  // The site's own header badge follows the assistant's cart.
  await expect(page.getByTestId("cart-count")).toHaveText("1");

  await dialog.getByRole("button", { name: "Checkout" }).last().click();
  await dialog.getByRole("link", { name: "Go to checkout" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByText("1 × Black Satin Wrap Dress")).toBeVisible();

  await page.getByLabel("Full name").fill("Nimali Perera");
  await page.getByLabel("Phone").fill("+94771234567");
  await page.getByLabel("Address").fill("12 Galle Road");
  await page.getByLabel("City").fill("Colombo");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/order\/confirmed\?number=\d+/);
  const number = await page.getByTestId("order-number").textContent();
  const displayId = (number ?? "").replace("#", "");

  const order = await adminOrder(displayId);
  expect(order?.metadata?.ace_conversation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(order?.total).toBe(18900);
  await expect(page.getByTestId("cart-count")).toHaveText("0");
});

test("adding on the site puts the item in the assistant's cart too", async ({ page }) => {
  await page.goto("/products/kurta-navy");
  await page.getByLabel(/Navy \/ M/).check();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");

  await page.getByRole("button", { name: "Open shopping assistant" }).click();
  const dialog = page.getByRole("dialog", { name: "Shopping assistant" });
  await dialog.getByRole("button", { name: "Start chat" }).click();
  await dialog.getByRole("textbox", { name: "Message" }).fill("kurta");
  await dialog.getByRole("button", { name: "Send" }).click();
  await dialog.getByRole("button", { name: "Add Navy Cotton Kurta Navy / L to cart" }).click();
  await expect(dialog.getByText("Subtotal")).toBeVisible();
  // One cart: the chat added to the site's cart, so the badge shows both items.
  await expect(page.getByTestId("cart-count")).toHaveText("2");
});
