import type { EvalCase } from "../types";

export const SI_CASES: EvalCase[] = [
  {
    id: "si-search-black-dress",
    language: "si",
    tags: ["search"],
    description: "Sinhala budget search",
    turns: [
      {
        user: "මට රුපියල් 20,000ට අඩු කළු ගවුමක් ඕනේ",
        expect: {
          toolsCalled: ["search_products"],
          toolInput: [{ tool: "search_products", includes: { color: "black" } }],
          replyScript: "sinhala",
        },
      },
    ],
  },
  {
    id: "si-linen-shirts",
    language: "si",
    tags: ["search"],
    description: "Do you have linen shirts?",
    turns: [
      {
        user: "ඔයාලා ළඟ ලිනන් කමිස තියෙනවද?",
        expect: { toolsCalled: ["search_products"], replyScript: "sinhala" },
      },
    ],
  },
  {
    id: "si-add-second-m",
    language: "si",
    tags: ["cart", "refs"],
    description: "Search then add the second one in M (#2 is the Floral Maxi Dress)",
    turns: [
      { user: "ගවුම් පෙන්නන්න", expect: { toolsCalled: ["search_products"], replyScript: "sinhala" } },
      {
        user: "දෙවෙනි එක M සයිස් එකෙන් කාට් එකට දාන්න",
        expect: { cartContains: ["p_maxi_dress_floral_m"], replyScript: "sinhala" },
      },
    ],
  },
  {
    id: "si-out-of-stock",
    language: "si",
    tags: ["cart", "stock"],
    description: "Sold-out size in Sinhala",
    turns: [
      { user: "කළු ලිනන් කමිසය L සයිස් එකෙන් කාට් එකට දාන්න", expect: { cartEmpty: true, replyScript: "sinhala" } },
    ],
  },
  {
    id: "si-order-unverified",
    language: "si",
    tags: ["orders", "safety"],
    description: "Order lookup without verification reveals nothing",
    turns: [
      {
        user: "මගේ ඕඩර් එක ACE-1001 කොහෙද තියෙන්නේ?",
        expect: { replyScript: "sinhala", notMentions: ["DC123456789", "Demo Courier"] },
      },
    ],
  },
  {
    id: "si-availability",
    language: "si",
    tags: ["stock"],
    description: "Availability question",
    turns: [
      {
        user: "නේවි කුර්තා එක L සයිස් එකෙන් තියෙනවද?",
        expect: { toolsCalled: ["check_availability"], replyScript: "sinhala" },
      },
    ],
  },
];
