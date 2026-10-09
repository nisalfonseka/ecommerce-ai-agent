import type { EvalCase } from "../types";

export const TA_CASES: EvalCase[] = [
  {
    id: "ta-search-black-dress",
    language: "ta",
    tags: ["search"],
    description: "Tamil budget search",
    turns: [
      {
        user: "எனக்கு 20,000 ரூபாய்க்குள் ஒரு கருப்பு ஆடை வேண்டும்",
        expect: {
          toolsCalled: ["search_products"],
          toolInput: [{ tool: "search_products", includes: { color: "black" } }],
          replyScript: "tamil",
        },
      },
    ],
  },
  {
    id: "ta-linen-shirts",
    language: "ta",
    tags: ["search"],
    description: "Do you have linen shirts?",
    turns: [
      { user: "லினன் சட்டைகள் இருக்கிறதா?", expect: { toolsCalled: ["search_products"], replyScript: "tamil" } },
    ],
  },
  {
    id: "ta-ordinal-add",
    language: "ta",
    tags: ["cart", "refs"],
    description: "Search then add the second one in M (#2 is the Floral Maxi Dress)",
    turns: [
      { user: "ஆடைகளைக் காட்டுங்கள்", expect: { toolsCalled: ["search_products"], replyScript: "tamil" } },
      {
        user: "இரண்டாவது ஆடையை M அளவில் கார்ட்டில் சேர்க்கவும்",
        expect: { cartContains: ["p_maxi_dress_floral_m"], replyScript: "tamil" },
      },
    ],
  },
  {
    id: "ta-add-kurta",
    language: "ta",
    tags: ["cart"],
    description: "Add kurta in M",
    turns: [
      {
        user: "நேவி காட்டன் குர்தாவை M அளவில் கார்ட்டில் சேர்க்கவும்",
        expect: { cartContains: ["p_kurta_navy_m"], replyScript: "tamil" },
      },
    ],
  },
  {
    id: "ta-out-of-stock",
    language: "ta",
    tags: ["cart", "stock"],
    description: "Sold-out size",
    turns: [
      {
        user: "கருப்பு லினன் சட்டையை L அளவில் கார்ட்டில் சேர்க்கவும்",
        expect: { cartEmpty: true, replyScript: "tamil" },
      },
    ],
  },
  {
    id: "ta-checkout",
    language: "ta",
    tags: ["checkout"],
    description: "Add then pay",
    turns: [
      {
        user: "வெள்ளை ஆக்ஸ்போர்டு சட்டையை M அளவில் சேர்க்கவும்",
        expect: { cartContains: ["p_oxford_shirt_white_m"] },
      },
      { user: "இப்போது பணம் செலுத்த வேண்டும்", expect: { toolsCalled: ["start_checkout"], replyScript: "tamil" } },
    ],
  },
];
