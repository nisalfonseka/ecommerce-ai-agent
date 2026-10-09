import type { UiPart } from "@ace/agent";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResponse, ChatEvent, WidgetApi } from "../api";
import { createStorage } from "../storage";
import { App } from "./App";

const money = (amount: number) => ({ amount, currency: "LKR" });

const productList: UiPart = {
  type: "product_list",
  items: [
    {
      ref: "#1",
      id: "p_linen",
      handle: "linen",
      title: "Black Linen Shirt <img src=x onerror=alert(1)>",
      url: "https://shop.example.lk/products/linen",
      image: { url: "https://shop.example.lk/linen.jpg", alt: "Linen shirt" },
      priceRange: { min: money(650000), max: money(650000) },
      availability: "in_stock",
      matchingVariantIds: ["v_s", "v_l"],
      variants: [
        {
          variantId: "v_s",
          title: "Black / S",
          options: { color: "Black", size: "S" },
          price: money(650000),
          availability: "in_stock",
        },
        {
          variantId: "v_l",
          title: "Black / L",
          options: { color: "Black", size: "L" },
          price: money(650000),
          availability: "out_of_stock",
        },
      ],
    },
  ],
};

const cartPart = (itemCount: number): UiPart => ({
  type: "cart",
  cart: {
    id: "cart_9",
    currency: "LKR",
    lines: [
      {
        id: "line_1",
        productId: "p_linen",
        variantId: "v_s",
        title: "Black Linen Shirt",
        variantTitle: "Black / S",
        quantity: itemCount,
        unitPrice: money(650000),
        lineTotal: money(650000 * itemCount),
      },
    ],
    subtotal: money(650000 * itemCount),
    itemCount,
    attributes: {},
    updatedAt: "2026-10-09T00:00:00.000Z",
  },
});

function fakeApi(replyUi: UiPart[] = [productList], replyText = "Here you go.") {
  const chat = vi.fn(async (_request: unknown, onEvent: (event: ChatEvent) => void) => {
    onEvent({ event: "conversation", data: { conversationId: "c1", conversationToken: "t1" } });
    onEvent({ event: "status", data: { tool: "search_products" } });
    onEvent({ event: "reply", data: { text: replyText, ui: replyUi, cartId: null } });
    onEvent({ event: "done", data: {} });
  });
  let resolveAction: ((value: ActionResponse) => void) | undefined;
  const action = vi.fn(
    () =>
      new Promise<ActionResponse>((resolve) => {
        resolveAction = resolve;
      }),
  );
  const api = {
    chat,
    action,
    loadConversation: vi.fn(async () => ({ messages: [] })),
  } as unknown as WidgetApi;
  return { api, chat, action, finishAction: (value: ActionResponse) => resolveAction?.(value) };
}

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  render(null, container);
  container.remove();
});

async function mount(api: WidgetApi, consented = true) {
  const storage = createStorage(null);
  if (consented) storage.giveConsent();
  await act(async () => {
    render(
      <App widgetKey="pk_live_test" api={api} storage={storage} win={window} initialCartId={null} />,
      container,
    );
  });
  return storage;
}

const q = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label") ?? b.textContent ?? "").includes(name),
  );

async function openAndSend(text: string) {
  await act(async () => button("Open shopping assistant")?.click());
  const input = q<HTMLTextAreaElement>("textarea");
  if (!input) throw new Error("no composer");
  await act(async () => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => q<HTMLFormElement>("form")?.requestSubmit());
}

describe("App", () => {
  it("has an accessible launcher and dialog, and Esc closes it", async () => {
    await mount(fakeApi().api);
    expect(q("[role=dialog]")).toBeNull();
    await act(async () => button("Open shopping assistant")?.click());
    const dialog = q("[role=dialog]");
    expect(dialog?.getAttribute("aria-label")).toBe("Shopping assistant");
    expect(q("[aria-live=polite]")).not.toBeNull();
    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(q("[role=dialog]")).toBeNull();
  });

  it("moves focus into the dialog on open and back to the launcher on close", async () => {
    await mount(fakeApi().api, false);
    await act(async () => button("Open shopping assistant")?.click());
    expect(q("[role=dialog]")?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(q("[role=dialog]")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open shopping assistant");
  });

  it("asks for consent before showing the composer", async () => {
    const storage = await mount(fakeApi().api, false);
    await act(async () => button("Open shopping assistant")?.click());
    expect(q("textarea")).toBeNull();
    await act(async () => button("Start chat")?.click());
    expect(q("textarea")).not.toBeNull();
    expect(storage.consentGiven()).toBe(true);
  });

  it("renders model and product text as text, never HTML", async () => {
    await mount(fakeApi([productList], "<img src=x onerror=alert(1)> hello").api);
    await openAndSend("linen");
    expect(container.querySelectorAll("img[src=x]")).toHaveLength(0);
    expect(container.textContent).toContain("<img src=x onerror=alert(1)> hello");
    expect(container.textContent).toContain("LKR 6,500.00");
  });

  it("disables sold-out sizes and sends one action per click, with a fresh actionId", async () => {
    const fake = fakeApi();
    await mount(fake.api);
    await openAndSend("linen");
    expect(
      button("Add Black Linen Shirt <img src=x onerror=alert(1)> Black / L")?.hasAttribute("disabled"),
    ).toBe(true);
    const add = button("Add Black Linen Shirt <img src=x onerror=alert(1)> Black / S");
    await act(async () => {
      add?.click();
      add?.click();
    });
    expect(fake.action).toHaveBeenCalledTimes(1);
    const [type, body] = fake.action.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(type).toBe("add_to_cart");
    expect(body).toMatchObject({
      conversationId: "c1",
      conversationToken: "t1",
      input: { variantId: "v_s", quantity: 1 },
    });
    expect(String(body.actionId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("tells the host page when the cart changes", async () => {
    const fake = fakeApi();
    await mount(fake.api);
    const seen: unknown[] = [];
    window.addEventListener("ace:cart-updated", (event) => seen.push((event as CustomEvent).detail));
    await openAndSend("linen");
    await act(async () => button("Add Black Linen Shirt <img src=x onerror=alert(1)> Black / S")?.click());
    await act(async () =>
      fake.finishAction({ result: { ok: true, data: {} }, ui: [cartPart(1)], cartId: "cart_9" }),
    );
    expect(seen).toEqual([{ cartId: "cart_9", itemCount: 1 }]);
    expect(container.textContent).toContain("Subtotal");
  });

  it("shows checkout only for http(s) links", async () => {
    const safe: UiPart = {
      type: "checkout",
      checkout: { cartId: "c", url: "https://shop.example.lk/checkout/c", expiresAt: null },
    };
    const evil: UiPart = {
      type: "checkout",
      checkout: { cartId: "c", url: "javascript:alert(1)", expiresAt: null },
    };
    await mount(fakeApi([safe, evil], "Ready").api);
    await openAndSend("pay");
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("https://shop.example.lk/checkout/c");
    expect(links.some((href) => href?.startsWith("javascript"))).toBe(false);
  });

  it("collects delivery details in a labelled form and sends them only as the cod_quote action", async () => {
    const form: UiPart = {
      type: "delivery_form",
      cartId: "cart_9",
      countryCode: "LK",
      cities: null,
      prefill: null,
    };
    const fake = fakeApi([form], "Please fill in your delivery details.");
    await mount(fake.api);
    await openAndSend("cash on delivery please");
    const field = (label: string) => {
      const input = [
        ...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
      ].find((el) => el.closest("label")?.textContent?.includes(label));
      if (!input) throw new Error(`no field labelled ${label}`);
      return input;
    };
    const type = async (label: string, value: string) => {
      const input = field(label);
      await act(async () => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    expect(field("Phone").getAttribute("autocomplete")).toBe("tel");
    await type("Full name", "Nimali <b>Perera</b>");
    await type("Phone", "077 123 4567");
    await type("Address", "12 Galle Road");
    await type("City", "Colombo 03");
    await act(async () => button("Continue")?.click());
    expect(fake.action).toHaveBeenCalledTimes(1);
    const [type_, body] = fake.action.mock.calls[0] as unknown as [
      string,
      { input: Record<string, unknown> },
    ];
    expect(type_).toBe("cod_quote");
    expect(body.input).toEqual({
      name: "Nimali <b>Perera</b>",
      phone: "077 123 4567",
      address: { line1: "12 Galle Road", city: "Colombo 03", countryCode: "LK" },
    });
    expect(fake.chat).toHaveBeenCalledTimes(1);
  });

  it("shows the COD summary as text and confirms once with place_cod_order", async () => {
    const summary: UiPart = {
      type: "cod_summary",
      cartId: "cart_9",
      countryCode: "LK",
      lines: (cartPart(1) as Extract<UiPart, { type: "cart" }>).cart.lines,
      subtotal: money(650000),
      deliveryFee: money(40000),
      total: money(690000),
      deliverTo: {
        name: "<img src=x onerror=alert(1)>",
        phone: "+94771234567",
        line1: "12 Galle Road",
        city: "Colombo",
      },
    };
    const fake = fakeApi([summary], "Please confirm.");
    await mount(fake.api);
    await openAndSend("cod");
    expect(container.textContent).toContain("LKR 400.00");
    expect(container.textContent).toContain("LKR 6,900.00");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelectorAll("img[src=x]")).toHaveLength(0);
    const confirm = button("Confirm order");
    await act(async () => {
      confirm?.click();
      confirm?.click();
    });
    expect(fake.action).toHaveBeenCalledTimes(1);
    expect((fake.action.mock.calls[0] as unknown as [string])[0]).toBe("place_cod_order");
  });

  it("lets the shopper edit the details from the summary without placing anything", async () => {
    const summary: UiPart = {
      type: "cod_summary",
      cartId: "cart_9",
      countryCode: "LK",
      lines: [],
      subtotal: money(650000),
      deliveryFee: money(40000),
      total: money(690000),
      deliverTo: { name: "Nimali", phone: "+94771234567", line1: "12 Galle Road", city: "Colombo" },
    };
    const fake = fakeApi([summary], "Please confirm.");
    await mount(fake.api);
    await openAndSend("cod");
    await act(async () => button("Edit details")?.click());
    const name = [...container.querySelectorAll("input")].find((el) =>
      el.closest("label")?.textContent?.includes("Full name"),
    );
    expect(name?.value).toBe("Nimali");
    expect(fake.action).not.toHaveBeenCalled();
  });
});
