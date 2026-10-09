import type { SearchProductsInput } from "@ace/contracts";

export type EvalLang = "en" | "singlish" | "si" | "ta";

/**
 * Grades: 3 = exactly what was asked, 2 = close (one secondary requirement missed), 1 = an acceptable
 * alternative. Unlisted products are 0. Hard filters (size, price, in stock) are the shopper's explicit
 * constraints, so only products that pass them are graded; stock counts only when `inStockOnly` is set.
 */
export interface RelevanceQuery {
  id: string;
  lang: EvalLang;
  input: SearchProductsInput;
  relevant: Record<string, 1 | 2 | 3>;
  /** Shares no keyword with the title or category of any grade-3 product (eval.test.ts checks it). */
  paraphrase?: true;
}

/** Minor units (LKR cents). */
const rs = (rupees: number) => rupees * 100;

export const EVAL_QUERIES: RelevanceQuery[] = [
  // English
  {
    id: "en-black-dress",
    lang: "en",
    input: { query: "black dress" },
    relevant: {
      p_dress_wrap_black: 3,
      p_dress_sequin_emerald: 1,
      p_dress_midi_polka_navy: 1,
      p_dress_wrap_red: 1,
      p_dress_shirtdress_olive: 1,
    },
  },
  {
    id: "en-white-linen-shirt",
    lang: "en",
    input: { query: "white linen shirt" },
    relevant: {
      p_shirt_linen_white: 3,
      p_shirt_mandarin_cream: 2,
      p_shirt_oxford_white: 2,
      p_shirt_linen_black: 2,
      p_shirt_linen_sky: 2,
      p_kurta_white_linen: 1,
    },
  },
  {
    id: "en-silk-saree-wedding",
    lang: "en",
    input: { query: "silk saree for a wedding" },
    relevant: {
      p_saree_kanchipuram_maroon: 3,
      p_saree_kanchipuram_green: 3,
      p_saree_bridal_ivory: 3,
      p_saree_georgette_pink: 2,
      p_blouse_silk_gold: 1,
      p_blouse_embroidered_maroon: 1,
    },
  },
  {
    id: "en-office-saree-under-10k",
    lang: "en",
    input: { query: "office saree", filters: { priceMax: rs(10000) } },
    relevant: {
      p_saree_chiffon_navy: 3,
      p_saree_chiffon_black: 3,
      p_saree_handloom_blue: 3,
      p_saree_handloom_yellow: 3,
      p_saree_osariya_white: 1,
    },
  },
  {
    id: "en-kurta-men",
    lang: "en",
    input: { query: "kurta for men" },
    relevant: {
      p_kurta_navy_cotton: 3,
      p_kurta_white_linen: 3,
      p_kurta_white_cotton: 3,
      p_kurta_silk_maroon: 3,
    },
  },
  {
    id: "en-stay-cool-hot-weather",
    lang: "en",
    paraphrase: true,
    input: { query: "outfit to stay cool in hot humid weather" },
    relevant: {
      p_shirt_linen_white: 3,
      p_shirt_linen_black: 3,
      p_shirt_linen_sky: 3,
      p_shirt_mandarin_cream: 3,
      p_dress_shift_linen_beige: 3,
      p_trousers_wideleg_cream: 3,
      p_shorts_drawstring_white: 3,
      p_dress_shift_cotton_beige: 2,
      p_dress_kaftan_white: 2,
      p_dress_sundress_yellow: 2,
      p_kurta_white_linen: 2,
      p_jacket_blazer_navy: 1,
    },
  },
  {
    id: "en-jeans-size-32",
    lang: "en",
    input: { query: "jeans", filters: { options: { size: ["32"] } } },
    relevant: {
      p_jeans_slim_blue: 3,
      p_jeans_slim_black: 3,
      p_jeans_mom_light: 3,
      p_trousers_chinos_black: 1,
      p_trousers_chinos_beige: 1,
    },
  },
  {
    id: "en-party-frock-girl",
    lang: "en",
    input: { query: "party frock for a girl" },
    relevant: {
      p_frock_party_pink: 3,
      p_frock_party_white: 3,
      p_frock_lace_yellow: 2,
      p_frock_cotton_floral: 1,
    },
  },
  {
    id: "en-rain-jacket",
    lang: "en",
    input: { query: "rain jacket" },
    relevant: { p_jacket_windcheater_grey: 3, p_jacket_denim_blue: 1, p_jacket_bomber_olive: 1 },
  },
  {
    id: "en-linen-trousers-women-under-8k",
    lang: "en",
    input: { query: "linen trousers for women", filters: { priceMax: rs(8000) } },
    relevant: { p_trousers_wideleg_cream: 3, p_trousers_palazzo_black: 2 },
  },
  {
    id: "en-beach-trip",
    lang: "en",
    paraphrase: true,
    input: { query: "something for a beach trip" },
    relevant: {
      p_dress_kaftan_white: 3,
      p_dress_maxi_floral: 3,
      p_dress_sundress_yellow: 3,
      p_shorts_board_tropical: 3,
      p_shorts_drawstring_white: 3,
      p_shorts_denim_cutoff: 3,
      p_shorts_chino_khaki: 2,
      p_top_crop_white: 1,
    },
  },
  {
    id: "en-poya-temple",
    lang: "en",
    paraphrase: true,
    input: { query: "outfit for a poya day temple visit" },
    relevant: {
      p_saree_osariya_white: 3,
      p_sarong_white_cotton: 3,
      p_kurta_white_linen: 3,
      p_kurta_white_cotton: 3,
      p_shirt_linen_white: 1,
      p_blouse_office_white: 1,
    },
  },
  {
    id: "en-gym-clothes",
    lang: "en",
    paraphrase: true,
    input: { query: "clothes for the gym" },
    relevant: {
      p_tshirt_quickdry_grey: 3,
      p_trousers_cargo_olive: 2,
      p_tshirt_crew_white: 1,
      p_tshirt_crew_black: 1,
      p_tshirt_polo_navy: 1,
    },
  },
  {
    id: "en-navy-blazer-office",
    lang: "en",
    input: { query: "navy blazer for office" },
    relevant: {
      p_jacket_blazer_navy: 3,
      p_trousers_formal_grey: 1,
      p_shirt_oxford_white: 1,
      p_shirt_oxford_blue: 1,
    },
  },
  {
    id: "en-tshirt-under-2500",
    lang: "en",
    input: { query: "t-shirt", filters: { priceMax: rs(2500) } },
    relevant: { p_tshirt_crew_white: 3, p_tshirt_crew_black: 3 },
  },
  {
    id: "en-dress-wedding-reception",
    lang: "en",
    input: { query: "dress for a wedding reception" },
    relevant: {
      p_dress_wrap_black: 3,
      p_dress_wrap_red: 3,
      p_dress_sequin_emerald: 3,
      p_dress_midi_polka_navy: 1,
      p_saree_georgette_pink: 1,
    },
  },
  {
    id: "en-pleated-skirt-m",
    lang: "en",
    input: { query: "pleated skirt", filters: { options: { size: ["M"] } } },
    relevant: { p_skirt_pleated_navy: 3, p_skirt_pleated_black: 3, p_skirt_denim_mini: 1 },
  },
  {
    id: "en-checked-shirt",
    lang: "en",
    input: { query: "checked shirt" },
    relevant: { p_shirt_checked_red: 3, p_shirt_batik_blue: 1, p_sarong_checked_green: 1 },
  },
  {
    id: "en-maroon-saree-blouse",
    lang: "en",
    input: { query: "maroon blouse for saree" },
    relevant: {
      p_blouse_embroidered_maroon: 3,
      p_blouse_silk_gold: 2,
      p_blouse_chiffon_pink: 1,
      p_blouse_puff_ivory: 1,
      p_blouse_office_white: 1,
    },
  },
  {
    id: "en-slim-chinos-34-in-stock",
    lang: "en",
    input: { query: "slim fit chinos", filters: { options: { size: ["34"] }, inStockOnly: true } },
    relevant: {
      p_trousers_chinos_black: 3,
      p_jeans_slim_black: 1,
      p_trousers_formal_grey: 1,
      p_shorts_chino_khaki: 1,
    },
  },
  {
    id: "en-cargo-pants-category",
    lang: "en",
    input: { query: "cargo pants", filters: { category: "trousers" } },
    relevant: {
      p_trousers_cargo_olive: 3,
      p_trousers_chinos_black: 1,
      p_trousers_chinos_beige: 1,
      p_trousers_wideleg_cream: 1,
      p_trousers_palazzo_black: 1,
      p_trousers_formal_grey: 1,
    },
  },
  {
    id: "en-job-interview",
    lang: "en",
    paraphrase: true,
    input: { query: "something to wear to a job interview" },
    relevant: {
      p_shirt_oxford_white: 3,
      p_shirt_oxford_blue: 3,
      p_shirt_formal_pink: 3,
      p_blouse_office_white: 3,
      p_jacket_blazer_navy: 2,
      p_trousers_formal_grey: 2,
      p_saree_chiffon_navy: 2,
      p_saree_chiffon_black: 2,
      p_trousers_chinos_black: 1,
      p_skirt_pleated_navy: 1,
      p_skirt_pleated_black: 1,
    },
  },
  // Singlish (romanised Sinhala, as typed in chat)
  {
    id: "sg-kalu-gawuma-wedding",
    lang: "singlish",
    input: { query: "kalu gawuma wedding ekata" },
    relevant: { p_dress_wrap_black: 3, p_dress_sequin_emerald: 2, p_dress_wrap_red: 2 },
  },
  {
    id: "sg-office-shirt",
    lang: "singlish",
    input: { query: "office ekata shirt ekak" },
    relevant: {
      p_shirt_oxford_white: 3,
      p_shirt_oxford_blue: 3,
      p_shirt_formal_pink: 3,
      p_shirt_linen_white: 2,
      p_shirt_linen_black: 2,
      p_shirt_linen_sky: 2,
      p_shirt_mandarin_cream: 1,
    },
  },
  {
    id: "sg-pirith-sudu-kurta",
    lang: "singlish",
    input: { query: "pirith ekata sudu kurta ekak" },
    relevant: {
      p_kurta_white_linen: 3,
      p_kurta_white_cotton: 3,
      p_sarong_white_cotton: 1,
      p_shirt_linen_white: 1,
      p_kurta_navy_cotton: 1,
    },
  },
  {
    id: "sg-mangalya-sariya",
    lang: "singlish",
    input: { query: "mangalya sariya" },
    relevant: {
      p_saree_kanchipuram_maroon: 3,
      p_saree_kanchipuram_green: 3,
      p_saree_bridal_ivory: 3,
      p_saree_georgette_pink: 2,
      p_blouse_silk_gold: 1,
      p_blouse_embroidered_maroon: 1,
    },
  },
  {
    id: "sg-duwata-frock-under-3k",
    lang: "singlish",
    input: { query: "podi duwata frock ekak 3000ta adu", filters: { priceMax: rs(3000) } },
    relevant: { p_frock_cotton_floral: 3 },
  },
  {
    id: "sg-beach-dress",
    lang: "singlish",
    input: { query: "beach yanna dress ekak" },
    relevant: {
      p_dress_maxi_floral: 3,
      p_dress_sundress_yellow: 3,
      p_dress_kaftan_white: 3,
      p_shorts_denim_cutoff: 1,
      p_shorts_drawstring_white: 1,
    },
  },
  {
    id: "sg-nil-jeans-32",
    lang: "singlish",
    input: { query: "nil jeans size 32", filters: { options: { size: ["32"] } } },
    relevant: { p_jeans_slim_blue: 3, p_jeans_mom_light: 3, p_jeans_slim_black: 1 },
  },
  {
    id: "sg-sudu-sarama-pansal",
    lang: "singlish",
    input: { query: "pansal yanna sudu sarama" },
    relevant: {
      p_sarong_white_cotton: 3,
      p_kurta_white_linen: 1,
      p_kurta_white_cotton: 1,
      p_sarong_checked_green: 1,
      p_sarong_batik_blue: 1,
    },
  },
  {
    id: "sg-linen-kalisama",
    lang: "singlish",
    input: { query: "linen kalisama" },
    relevant: {
      p_trousers_wideleg_cream: 3,
      p_trousers_chinos_black: 1,
      p_trousers_chinos_beige: 1,
      p_trousers_formal_grey: 1,
      p_trousers_palazzo_black: 1,
    },
  },
  {
    id: "sg-rosa-party-saree",
    lang: "singlish",
    input: { query: "rosa party saree ekak" },
    relevant: { p_saree_georgette_pink: 3, p_blouse_chiffon_pink: 1, p_saree_batik_red: 1 },
  },
  {
    id: "sg-gym-tshirt",
    lang: "singlish",
    input: { query: "gym ekata t shirt ekak" },
    relevant: {
      p_tshirt_quickdry_grey: 3,
      p_tshirt_crew_white: 1,
      p_tshirt_crew_black: 1,
      p_tshirt_polo_navy: 1,
    },
  },
  {
    id: "sg-wessa-jacket-in-stock",
    lang: "singlish",
    input: { query: "wessa kalayata jacket ekak", filters: { inStockOnly: true } },
    relevant: { p_jacket_windcheater_grey: 3, p_jacket_denim_blue: 1 },
  },
  // Sinhala script
  {
    id: "si-black-dress",
    lang: "si",
    input: { query: "කළු ගවුමක්" },
    relevant: {
      p_dress_wrap_black: 3,
      p_dress_sequin_emerald: 1,
      p_dress_midi_polka_navy: 1,
      p_dress_wrap_red: 1,
      p_dress_shirtdress_olive: 1,
    },
  },
  {
    id: "si-wedding-saree",
    lang: "si",
    input: { query: "මංගල උත්සවයට සාරියක්" },
    relevant: {
      p_saree_kanchipuram_maroon: 3,
      p_saree_kanchipuram_green: 3,
      p_saree_bridal_ivory: 3,
      p_saree_georgette_pink: 2,
    },
  },
  {
    id: "si-white-shirt",
    lang: "si",
    input: { query: "සුදු කමිසයක්" },
    relevant: {
      p_shirt_linen_white: 3,
      p_shirt_oxford_white: 3,
      p_shirt_mandarin_cream: 2,
      p_shirt_linen_black: 1,
      p_shirt_linen_sky: 1,
      p_shirt_oxford_blue: 1,
      p_shirt_formal_pink: 1,
    },
  },
  {
    id: "si-kids-frock",
    lang: "si",
    input: { query: "ළමයින්ට ෆ්‍රොක් එකක්" },
    relevant: {
      p_frock_party_pink: 3,
      p_frock_party_white: 3,
      p_frock_cotton_floral: 3,
      p_frock_lace_yellow: 3,
    },
  },
  {
    id: "si-office-trousers-32",
    lang: "si",
    input: { query: "කාර්යාලයට කලිසමක්", filters: { options: { size: ["32"] } } },
    relevant: {
      p_trousers_chinos_black: 3,
      p_trousers_chinos_beige: 3,
      p_trousers_formal_grey: 3,
      p_jeans_slim_blue: 1,
      p_jeans_slim_black: 1,
      p_jeans_mom_light: 1,
    },
  },
  {
    id: "si-batik-sarong",
    lang: "si",
    input: { query: "බතික් සරම" },
    relevant: {
      p_sarong_batik_blue: 3,
      p_sarong_checked_green: 1,
      p_sarong_white_cotton: 1,
      p_sarong_handwoven_maroon: 1,
      p_shirt_batik_blue: 1,
      p_skirt_batik_wrap: 1,
    },
  },
  {
    id: "si-red-dress-under-20k",
    lang: "si",
    input: { query: "රතු ගවුමක් 20000ට අඩුවෙන්", filters: { priceMax: rs(20000) } },
    relevant: {
      p_dress_wrap_red: 3,
      p_dress_wrap_black: 1,
      p_dress_maxi_floral: 1,
      p_top_offshoulder_red: 1,
    },
  },
  {
    id: "si-cotton-saree",
    lang: "si",
    input: { query: "කපු සාරියක්" },
    relevant: {
      p_saree_handloom_blue: 3,
      p_saree_handloom_yellow: 3,
      p_saree_osariya_white: 3,
      p_saree_batik_red: 2,
    },
  },
  // Tamil script
  {
    id: "ta-black-shirt",
    lang: "ta",
    input: { query: "கருப்பு சட்டை" },
    relevant: {
      p_shirt_linen_black: 3,
      p_tshirt_crew_black: 2,
      p_tshirt_oversized_graphic: 1,
      p_top_peplum_black: 1,
    },
  },
  {
    id: "ta-silk-saree-wedding",
    lang: "ta",
    input: { query: "திருமணத்திற்கு பட்டு சேலை" },
    relevant: {
      p_saree_kanchipuram_maroon: 3,
      p_saree_kanchipuram_green: 3,
      p_saree_bridal_ivory: 3,
      p_saree_georgette_pink: 2,
      p_blouse_silk_gold: 1,
    },
  },
  {
    id: "ta-cotton-saree",
    lang: "ta",
    input: { query: "பருத்தி சேலை" },
    relevant: {
      p_saree_handloom_blue: 3,
      p_saree_handloom_yellow: 3,
      p_saree_osariya_white: 3,
      p_saree_batik_red: 2,
    },
  },
  {
    id: "ta-women-kurta",
    lang: "ta",
    input: { query: "பெண்களுக்கான குர்தா" },
    relevant: {
      p_kurta_women_printed: 3,
      p_kurta_anarkali_mustard: 3,
      p_kurta_navy_cotton: 1,
      p_kurta_white_linen: 1,
      p_kurta_white_cotton: 1,
      p_kurta_silk_maroon: 1,
    },
  },
  {
    id: "ta-blue-jeans",
    lang: "ta",
    input: { query: "நீல ஜீன்ஸ்" },
    relevant: { p_jeans_slim_blue: 3, p_jeans_mom_light: 3, p_jeans_kids_blue: 2, p_jeans_slim_black: 1 },
  },
  {
    id: "ta-kids-party-frock",
    lang: "ta",
    input: { query: "குழந்தைகளுக்கு பார்ட்டி ஃப்ராக்" },
    relevant: {
      p_frock_party_pink: 3,
      p_frock_party_white: 3,
      p_frock_lace_yellow: 2,
      p_frock_cotton_floral: 1,
    },
  },
  {
    id: "ta-office-white-shirt-l",
    lang: "ta",
    input: { query: "அலுவலகத்திற்கு வெள்ளை சட்டை", filters: { options: { size: ["L"] } } },
    relevant: {
      p_shirt_oxford_white: 3,
      p_shirt_linen_white: 2,
      p_blouse_office_white: 2,
      p_shirt_mandarin_cream: 1,
    },
  },
  {
    id: "ta-beach-wear-in-stock",
    lang: "ta",
    input: { query: "கடற்கரைக்கு ஏற்ற உடை", filters: { inStockOnly: true } },
    relevant: {
      p_dress_kaftan_white: 3,
      p_dress_maxi_floral: 3,
      p_dress_sundress_yellow: 3,
      p_shorts_drawstring_white: 2,
      p_shorts_board_tropical: 2,
      p_shorts_denim_cutoff: 2,
    },
  },
];
