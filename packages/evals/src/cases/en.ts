import type { EvalCase } from "../types";

const verifiedOwner = {
  method: "email_otp" as const,
  email: "customer@example.com",
  verifiedAt: "2026-10-01T00:00:00.000Z",
};

export const EN_CASES: EvalCase[] = [
  {
    id: "en-search-black-dress-budget",
    language: "en",
    tags: ["search"],
    description: "Budget + colour + category search",
    turns: [
      {
        user: "I need a black dress for a wedding under 20,000 rupees",
        expect: { toolsCalled: ["search_products"], mentions: ["Wrap Dress"], replyScript: "latin" },
      },
    ],
  },
  {
    id: "en-search-no-results",
    language: "en",
    tags: ["search"],
    description: "Honest answer when nothing matches",
    turns: [
      {
        user: "Do you sell tuxedos?",
        expect: {
          toolsCalled: ["search_products"],
          toolsNotCalled: ["add_to_cart"],
          notMentions: ["tuxedo for", "we have a tuxedo"],
        },
      },
    ],
  },
  {
    id: "en-ordinal-add",
    language: "en",
    tags: ["cart", "refs"],
    description: "Add the second result in a size (#2 is the Floral Maxi Dress)",
    turns: [
      { user: "Show me your dresses", expect: { toolsCalled: ["search_products"] } },
      {
        user: "I'll take the second one in medium",
        expect: { toolsCalled: ["add_to_cart"], cartContains: ["p_maxi_dress_floral_m"] },
      },
    ],
  },
  {
    id: "en-descriptive-ref",
    language: "en",
    tags: ["cart", "refs"],
    description: "Pick a shown product by colour instead of number",
    turns: [
      { user: "Show me your dresses", expect: { toolsCalled: ["search_products"] } },
      {
        user: "I'll take the black one in medium",
        expect: { toolsCalled: ["add_to_cart"], cartContains: ["p_wrap_dress_black_m"] },
      },
    ],
  },
  {
    id: "en-needs-size",
    language: "en",
    tags: ["cart"],
    description: "Ask for size instead of guessing",
    turns: [
      {
        user: "Add the black linen shirt to my cart",
        expect: { cartEmpty: true, mentionsAny: ["size", "S, M", "small", "medium"] },
      },
    ],
  },
  {
    id: "en-out-of-stock-alternative",
    language: "en",
    tags: ["cart", "stock"],
    description: "Sold-out size → offer alternatives",
    turns: [
      {
        user: "Please add the black linen shirt in L",
        expect: {
          cartEmpty: true,
          mentionsAny: ["out of stock", "sold out", "not available", "unavailable"],
        },
      },
    ],
  },
  {
    id: "en-availability-question",
    language: "en",
    tags: ["stock"],
    description: "Live stock check",
    turns: [
      {
        user: "Is the black satin wrap dress available in large?",
        expect: {
          toolsCalled: ["check_availability"],
          mentionsAny: ["yes", "available", "in stock", "1 left", "last one", "only"],
        },
      },
    ],
  },
  {
    id: "en-checkout",
    language: "en",
    tags: ["cart", "checkout"],
    description: "Add then checkout",
    turns: [
      {
        user: "Add the navy cotton kurta in M to my cart",
        expect: { toolsCalled: ["add_to_cart"], cartContains: ["p_kurta_navy_m"] },
      },
      { user: "Great, I want to pay now", expect: { toolsCalled: ["start_checkout"] } },
    ],
  },
  {
    id: "en-cod",
    language: "en",
    tags: ["cart", "cod"],
    description: "Cash on delivery shows the delivery form; the assistant never collects details in chat",
    setup: { cod: true },
    turns: [
      {
        user: "Add the navy cotton kurta in M to my cart",
        expect: { toolsCalled: ["add_to_cart"], cartContains: ["p_kurta_navy_m"] },
      },
      {
        user: "Can I pay cash on delivery?",
        expect: {
          toolsCalled: ["start_cod_order"],
          toolsNotCalled: ["start_checkout"],
          mentionsAny: ["form", "details"],
        },
      },
    ],
  },
  {
    id: "en-change-quantity",
    language: "en",
    tags: ["cart"],
    description: "Update quantity via cart line",
    turns: [
      { user: "Add one white oxford shirt in M", expect: { cartContains: ["p_oxford_shirt_white_m"] } },
      { user: "Actually make that 2", expect: { toolsCalled: ["update_cart_line"] } },
    ],
  },
  {
    id: "en-order-verified",
    language: "en",
    tags: ["orders"],
    description: "Verified shopper asks for order status",
    setup: { identity: verifiedOwner },
    turns: [
      {
        user: "Where is my order ACE-1001?",
        expect: { toolsCalled: ["lookup_order"], mentionsAny: ["shipped", "on its way", "DC123456789"] },
      },
    ],
  },
  {
    id: "en-product-details",
    language: "en",
    tags: ["search", "details"],
    description: "Fabric question answered from product data",
    turns: [
      {
        user: "What fabric is the black linen shirt?",
        expect: { mentions: ["linen"], toolsNotCalled: ["add_to_cart"] },
      },
    ],
  },
];
