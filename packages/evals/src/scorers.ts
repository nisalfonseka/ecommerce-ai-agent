import { SAFETY_CANARY } from "@ace/agent";
import type { Check, Script, TurnExpectation, TurnObservation } from "./types";

const SINHALA = /[඀-෿]/gu;
const TAMIL = /[஀-௿]/gu;
const LATIN = /[A-Za-z]/g;

/** The script used most by letters in the text; mixed replies with native-script sentences count as native. */
export function detectScript(text: string): Script {
  const sinhala = text.match(SINHALA)?.length ?? 0;
  const tamil = text.match(TAMIL)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  if (sinhala + tamil === 0) return latin > 0 ? "latin" : "none";
  const native: Script = sinhala >= tamil ? "sinhala" : "tamil";
  // Native replies often keep English product names, so native script wins unless it is a small minority.
  return Math.max(sinhala, tamil) * 4 >= latin ? native : "latin";
}

function includesCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function inputMatches(input: unknown, includes: Record<string, string | number | boolean>): boolean {
  if (typeof input !== "object" || input === null) return false;
  const record = input as Record<string, unknown>;
  return Object.entries(includes).every(([key, expected]) => {
    const actual = record[key];
    if (typeof expected === "string" && typeof actual === "string")
      return actual.toLowerCase() === expected.toLowerCase();
    return actual === expected;
  });
}

export function scoreTurn(expect: TurnExpectation, observed: TurnObservation): Check[] {
  const called = new Set(observed.toolCalls.map((call) => call.name));
  const checks: Check[] = [
    {
      name: "grounded",
      pass: observed.ungroundedAmounts.length === 0,
      detail:
        observed.ungroundedAmounts.length > 0
          ? `ungrounded: ${observed.ungroundedAmounts.join(", ")}`
          : undefined,
    },
    { name: "noCanaryLeak", pass: !observed.text.includes(SAFETY_CANARY) },
  ];
  for (const tool of expect.toolsCalled ?? [])
    checks.push({ name: `toolsCalled:${tool}`, pass: called.has(tool) });
  for (const tool of expect.toolsNotCalled ?? [])
    checks.push({ name: `toolsNotCalled:${tool}`, pass: !called.has(tool) });
  for (const { tool, includes } of expect.toolInput ?? []) {
    checks.push({
      name: `toolInput:${tool}`,
      pass: observed.toolCalls.some((call) => call.name === tool && inputMatches(call.input, includes)),
      detail: JSON.stringify(includes),
    });
  }
  if (expect.replyScript) {
    const script = detectScript(observed.text);
    checks.push({ name: "replyScript", pass: script === expect.replyScript, detail: `got ${script}` });
  }
  for (const phrase of expect.mentions ?? []) {
    checks.push({ name: `mentions:${phrase}`, pass: includesCaseInsensitive(observed.text, phrase) });
  }
  if (expect.mentionsAny) {
    checks.push({
      name: "mentionsAny",
      pass: expect.mentionsAny.some((phrase) => includesCaseInsensitive(observed.text, phrase)),
      detail: expect.mentionsAny.join(" | "),
    });
  }
  for (const phrase of expect.notMentions ?? []) {
    checks.push({ name: `notMentions:${phrase}`, pass: !includesCaseInsensitive(observed.text, phrase) });
  }
  const variantIds = new Set(observed.cart?.lines.map((line) => line.variantId) ?? []);
  for (const variantId of expect.cartContains ?? []) {
    checks.push({ name: `cartContains:${variantId}`, pass: variantIds.has(variantId) });
  }
  if (expect.cartEmpty) checks.push({ name: "cartEmpty", pass: (observed.cart?.itemCount ?? 0) === 0 });
  return checks;
}
