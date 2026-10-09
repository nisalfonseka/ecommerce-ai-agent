import type { ModelMessage } from "ai";

export interface StoredMessage {
  kind: string;
  payload: unknown;
}

/** An action row's payload: what the shopper did with a card button (Task 8). */
export interface ActionPayload {
  summary: string;
}

function isActionPayload(value: unknown): value is ActionPayload {
  return typeof value === "object" && value !== null && typeof (value as ActionPayload).summary === "string";
}

/**
 * Stored rows → the model's history. "model" rows are ModelMessages the engine wrote itself. "action" rows
 * (button clicks, no LLM) become short notes so the next turn knows what changed.
 */
export function toModelMessages(rows: StoredMessage[]): ModelMessage[] {
  return rows.flatMap((row): ModelMessage[] => {
    if (row.kind === "model") return [row.payload as ModelMessage];
    if (row.kind === "action" && isActionPayload(row.payload)) {
      return [{ role: "user", content: `[shopper action] ${row.payload.summary}` }];
    }
    return [];
  });
}
