import type { EvalCase } from "../types";

const verifiedOwner = {
  method: "email_otp" as const,
  email: "customer@example.com",
  verifiedAt: "2026-10-01T00:00:00.000Z",
};

export const SINGLISH_CASES: EvalCase[] = [
  {
    id: "sg-black-dress-budget",
    language: "singlish",
    tags: ["search"],
    description: "Romanised Sinhala budget search",
    turns: [
      {
        user: "mata kalu gawumak one, 20000ta adu",
        expect: {
          toolsCalled: ["search_products"],
          toolInput: [{ tool: "search_products", includes: { color: "black" } }],
          replyScript: "latin",
        },
      },
    ],
  },
  {
    id: "sg-linen-shirts",
    language: "singlish",
    tags: ["search"],
    description: "linen shirts thiyenawada?",
    turns: [
      {
        user: "linen shirts thiyenawada?",
        expect: { toolsCalled: ["search_products"], replyScript: "latin" },
      },
    ],
  },
  {
    id: "sg-add-second",
    language: "singlish",
    tags: ["cart", "refs"],
    description: "Search then add the second one in M (#2 is the Floral Maxi Dress)",
    turns: [
      { user: "dresses tika pennanna", expect: { toolsCalled: ["search_products"] } },
      {
        user: "deweni eka M size eken cart ekata danna",
        expect: { cartContains: ["p_maxi_dress_floral_m"] },
      },
    ],
  },
  {
    id: "sg-white-shirt-xl",
    language: "singlish",
    tags: ["stock"],
    description: "XL availability",
    turns: [
      {
        user: "white oxford shirt eka XL thiyenawada?",
        expect: { mentionsAny: ["XL", "yes", "ow", "available", "thiyenawa"] },
      },
    ],
  },
  {
    id: "sg-order-verified",
    language: "singlish",
    tags: ["orders"],
    description: "Verified order status",
    setup: { identity: verifiedOwner },
    turns: [
      {
        user: "mage order eka koheda? ACE-1001",
        expect: { toolsCalled: ["lookup_order"], mentionsAny: ["shipped", "DC123456789", "yawala"] },
      },
    ],
  },
  {
    id: "sg-festive-kurta",
    language: "singlish",
    tags: ["search"],
    description: "Occasion search",
    turns: [
      {
        user: "festival ekata kurta ekak thiyenawada?",
        expect: { toolsCalled: ["search_products"], mentions: ["kurta"] },
      },
    ],
  },
];
