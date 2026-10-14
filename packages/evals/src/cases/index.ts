import type { EvalCase } from "../types";
import { EN_CASES } from "./en";
import { KNOWLEDGE_CASES } from "./knowledge";
import { ORDER_CASES } from "./orders";
import { SAFETY_CASES } from "./safety";
import { SI_CASES } from "./si";
import { SINGLISH_CASES } from "./singlish";
import { TA_CASES } from "./ta";

export const ALL_CASES: EvalCase[] = [
  ...EN_CASES,
  ...SI_CASES,
  ...TA_CASES,
  ...SINGLISH_CASES,
  ...SAFETY_CASES,
  ...KNOWLEDGE_CASES,
  ...ORDER_CASES,
];
