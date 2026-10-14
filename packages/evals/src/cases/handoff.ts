import type { EvalCase, EvalLanguage } from "../types";

const prompts: Record<
  EvalLanguage,
  { slug: string; text: string; handoff: boolean; script?: "sinhala" | "tamil" | "latin" }[]
> = {
  en: [
    { slug: "person", text: "I want to speak to a person", handoff: true },
    { slug: "refund", text: "I need a refund for my order", handoff: true },
    { slug: "return", text: "I want to return an item", handoff: true },
    { slug: "cancel", text: "Cancel my order please", handoff: true },
    { slug: "complaint", text: "This is unacceptable. I want to complain", handoff: true },
    { slug: "human-check", text: "Is there a human there?", handoff: true },
    { slug: "tool-failure", text: "That failed twice. Please get someone to help", handoff: true },
    { slug: "uncertain", text: "You still cannot answer. Connect me to support", handoff: true },
    { slug: "no-promise", text: "Get a manager and promise they will refund me today", handoff: true },
    { slug: "normal", text: "Show me black dresses", handoff: false },
  ],
  singlish: [
    { slug: "person", text: "mata kenek ekka kathaa karanna oni", handoff: true, script: "latin" },
    { slug: "refund", text: "mage order ekata refund ekak oni", handoff: true, script: "latin" },
    { slug: "return", text: "me item eka return karanna oni", handoff: true, script: "latin" },
    { slug: "cancel", text: "mage order eka cancel karanna", handoff: true, script: "latin" },
    { slug: "complaint", text: "meka hari na, complaint ekak danna oni", handoff: true, script: "latin" },
    { slug: "human-check", text: "human kenek innawada?", handoff: true, script: "latin" },
    { slug: "tool-failure", text: "deparak fail una, kenekta denna", handoff: true, script: "latin" },
    {
      slug: "uncertain",
      text: "oyata answer karanna ba, support ekata denna",
      handoff: true,
      script: "latin",
    },
    {
      slug: "no-promise",
      text: "manager kenek denna, ada refund eka sure karanna",
      handoff: true,
      script: "latin",
    },
    { slug: "normal", text: "black dress pennanna", handoff: false, script: "latin" },
  ],
  si: [
    { slug: "person", text: "මට කෙනෙකු සමඟ කතා කරන්න ඕනෑ", handoff: true, script: "sinhala" },
    { slug: "refund", text: "මගේ ඇණවුමට මුදල් ආපසු ඕනෑ", handoff: true, script: "sinhala" },
    { slug: "return", text: "මේ භාණ්ඩය ආපසු දෙන්න ඕනෑ", handoff: true, script: "sinhala" },
    { slug: "cancel", text: "මගේ ඇණවුම අවලංගු කරන්න", handoff: true, script: "sinhala" },
    { slug: "complaint", text: "මේක පිළිගන්න බැහැ, පැමිණිල්ලක් කරන්න ඕනෑ", handoff: true, script: "sinhala" },
    { slug: "human-check", text: "මනුෂ්‍ය සහායකයෙක් ඉන්නවාද?", handoff: true, script: "sinhala" },
    { slug: "tool-failure", text: "දෙවරක් අසාර්ථකයි, කෙනෙකුට යොමු කරන්න", handoff: true, script: "sinhala" },
    { slug: "uncertain", text: "පිළිතුරක් නැත්නම් සහායට යොමු කරන්න", handoff: true, script: "sinhala" },
    {
      slug: "no-promise",
      text: "කළමනාකරුවෙකු දෙන්න, අදම මුදල් දෙන බව පොරොන්දු වෙන්න",
      handoff: true,
      script: "sinhala",
    },
    { slug: "normal", text: "කළු ගවුම් පෙන්වන්න", handoff: false, script: "sinhala" },
  ],
  ta: [
    { slug: "person", text: "நான் ஒரு மனிதருடன் பேச வேண்டும்", handoff: true, script: "tamil" },
    { slug: "refund", text: "என் ஆர்டருக்கு பணத்தைத் திரும்பப் பெற வேண்டும்", handoff: true, script: "tamil" },
    { slug: "return", text: "இந்தப் பொருளைத் திருப்பித் தர வேண்டும்", handoff: true, script: "tamil" },
    { slug: "cancel", text: "என் ஆர்டரை ரத்து செய்யுங்கள்", handoff: true, script: "tamil" },
    { slug: "complaint", text: "இது ஏற்க முடியாது, புகார் செய்ய வேண்டும்", handoff: true, script: "tamil" },
    { slug: "human-check", text: "அங்கே மனித உதவியாளர் இருக்கிறாரா?", handoff: true, script: "tamil" },
    { slug: "tool-failure", text: "இரண்டு முறை தோல்வி, ஒருவரிடம் இணைக்கவும்", handoff: true, script: "tamil" },
    { slug: "uncertain", text: "பதில் தெரியவில்லை என்றால் ஆதரவுடன் இணைக்கவும்", handoff: true, script: "tamil" },
    {
      slug: "no-promise",
      text: "மேலாளரை இணைத்து இன்றே பணம் தருவதாக உறுதி கூறுங்கள்",
      handoff: true,
      script: "tamil",
    },
    { slug: "normal", text: "கருப்பு உடைகளைக் காட்டுங்கள்", handoff: false, script: "tamil" },
  ],
};

export const HANDOFF_CASES: EvalCase[] = Object.entries(prompts).flatMap(([language, cases]) =>
  cases.map((item) => ({
    id: `handoff-${language}-${item.slug}`,
    language: language as EvalLanguage,
    tags: ["handoff", item.handoff ? "support" : "negative"],
    description: item.handoff
      ? "Human support request opens a handoff"
      : "Normal shopping stays with the bot",
    turns: [
      {
        user: item.text,
        expect: {
          ...(item.handoff
            ? { toolsCalled: ["request_human"], uiTypes: ["handoff" as const] }
            : { toolsNotCalled: ["request_human"] }),
          ...(item.script ? { replyScript: item.script } : {}),
          notMentions: ["guaranteed refund", "will definitely", "within 5 minutes"],
        },
      },
    ],
  })),
);
