import type { EvalCase } from "../types";

export const DEFAULT_KNOWLEDGE = [
  {
    title: "Returns policy",
    markdown: "# Exchanges\n\nItems can be exchanged within 7 days with the original receipt.",
  },
  {
    title: "Delivery policy",
    markdown: "# Island-wide delivery\n\nDelivery takes 2-4 working days and costs LKR 400.",
  },
  {
    title: "Payment policy",
    markdown: "# Cash on delivery\n\nCash on delivery is available for orders up to LKR 50,000.",
  },
  {
    title: "Size guide",
    markdown: "# Clothing sizes\n\nS: chest 36 inches. M: 38 inches. L: 40 inches. XL: 42 inches.",
  },
  {
    title: "Care guide",
    markdown: "# Linen\n\nHand wash linen in cold water and air dry in the shade.",
  },
];

export const KNOWLEDGE_CASES: EvalCase[] = [
  {
    id: "knowledge-en-exchange",
    language: "en",
    tags: ["knowledge"],
    description: "English exchange window with a citation",
    turns: [
      {
        user: "How long do I have to exchange an item?",
        expect: {
          toolsCalled: ["search_knowledge"],
          mentions: ["7 days"],
          mentionsAny: ["Returns policy", "according to"],
        },
      },
    ],
  },
  {
    id: "knowledge-en-delivery",
    language: "en",
    tags: ["knowledge"],
    description: "English delivery time with a citation",
    turns: [
      {
        user: "How many days does delivery take?",
        expect: {
          toolsCalled: ["search_knowledge"],
          mentionsAny: ["2-4", "2–4"],
          mentions: ["Delivery policy"],
        },
      },
    ],
  },
  {
    id: "knowledge-en-care",
    language: "en",
    tags: ["knowledge"],
    description: "English linen care with a citation",
    turns: [
      {
        user: "How should I wash linen?",
        expect: {
          toolsCalled: ["search_knowledge"],
          mentionsAny: ["hand wash", "cold water"],
          mentions: ["Care guide"],
        },
      },
    ],
  },
  {
    id: "knowledge-singlish-exchange",
    language: "singlish",
    tags: ["knowledge"],
    description: "Singlish exchange question",
    turns: [
      {
        user: "maru karanna puluwanda?",
        expect: {
          toolsCalled: ["search_knowledge"],
          mentions: ["7"],
          mentionsAny: ["Returns policy", "exchange"],
        },
      },
    ],
  },
  {
    id: "knowledge-singlish-delivery",
    language: "singlish",
    tags: ["knowledge"],
    description: "Singlish delivery charge question",
    turns: [
      {
        user: "delivery kiyada?",
        expect: {
          toolsCalled: ["search_knowledge"],
          mentions: ["400"],
          mentionsAny: ["Delivery policy", "delivery"],
        },
      },
    ],
  },
  {
    id: "knowledge-si-exchange",
    language: "si",
    tags: ["knowledge"],
    description: "Sinhala exchange window question",
    turns: [
      {
        user: "භාණ්ඩයක් මාරු කරන්න දවස් කීයක් තියෙනවාද?",
        expect: { toolsCalled: ["search_knowledge"], mentions: ["7"], replyScript: "sinhala" },
      },
    ],
  },
  {
    id: "knowledge-si-delivery",
    language: "si",
    tags: ["knowledge"],
    description: "Sinhala delivery time question",
    turns: [
      {
        user: "බෙදාහැරීමට දවස් කීයක් ගත වෙනවාද?",
        expect: { toolsCalled: ["search_knowledge"], mentionsAny: ["2-4", "2–4"], replyScript: "sinhala" },
      },
    ],
  },
  {
    id: "knowledge-ta-exchange",
    language: "ta",
    tags: ["knowledge"],
    description: "Tamil exchange window question",
    turns: [
      {
        user: "பொருளை மாற்ற எத்தனை நாட்கள் உள்ளன?",
        expect: { toolsCalled: ["search_knowledge"], mentions: ["7"], replyScript: "tamil" },
      },
    ],
  },
  {
    id: "knowledge-ta-care",
    language: "ta",
    tags: ["knowledge"],
    description: "Tamil linen care question",
    turns: [
      {
        user: "லினன் துணியை எப்படி கழுவ வேண்டும்?",
        expect: { toolsCalled: ["search_knowledge"], mentionsAny: ["கை", "குளிர்"], replyScript: "tamil" },
      },
    ],
  },
  {
    id: "knowledge-low-confidence",
    language: "en",
    tags: ["knowledge", "low-confidence"],
    description: "Unknown policy is not guessed",
    knowledge: [],
    turns: [
      {
        user: "Do you sell gift cards?",
        expect: {
          toolsCalled: ["search_knowledge"],
          mentionsAny: ["not sure", "contact"],
          notMentions: ["yes"],
        },
      },
    ],
  },
];
