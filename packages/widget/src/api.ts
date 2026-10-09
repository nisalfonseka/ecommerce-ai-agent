import type { UiPart } from "@ace/agent";
import { parseSse, textChunks } from "./sse";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ChatEvent =
  | { event: "conversation"; data: { conversationId: string; conversationToken: string } }
  | { event: "status"; data: { tool: string } }
  | { event: "reply"; data: { text: string; ui: UiPart[]; cartId: string | null } }
  | { event: "done"; data: unknown }
  | { event: "error"; data: { code: string; message: string } };

export interface ChatRequest {
  message: string;
  conversationId?: string;
  conversationToken?: string;
  cartId?: string;
}

export interface ActionResponse {
  result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
  ui: UiPart[];
  cartId: string | null;
}

export interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
  ui?: UiPart[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const KNOWN_EVENTS = new Set(["conversation", "status", "reply", "done", "error"]);

async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new ApiError(
    res.status,
    body?.error?.code ?? "http_error",
    body?.error?.message ?? `HTTP ${res.status}`,
  );
}

/** The engine's widget API (ADR-004 events for chat; JSON for actions and history). */
export function createApi(options: { api: string; key: string; visitorId: string; fetch?: Fetch }) {
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${options.key}`,
    "x-visitor-id": options.visitorId,
    ...extra,
  });

  return {
    async chat(request: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<void> {
      const res = await doFetch(`${options.api}/v1/chat`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(request),
      });
      if (!res.ok || !res.body) throw await toApiError(res);
      for await (const event of parseSse(textChunks(res.body))) {
        if (KNOWN_EVENTS.has(event.event)) onEvent(event as ChatEvent);
      }
    },

    async action(type: string, body: Record<string, unknown>): Promise<ActionResponse> {
      const res = await doFetch(`${options.api}/v1/actions/${encodeURIComponent(type)}`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await toApiError(res);
      return (await res.json()) as ActionResponse;
    },

    async loadConversation(conversationId: string, token: string): Promise<{ messages: DisplayMessage[] }> {
      const res = await doFetch(`${options.api}/v1/conversations/${encodeURIComponent(conversationId)}`, {
        headers: headers({ "x-conversation-token": token }),
      });
      if (!res.ok) throw await toApiError(res);
      return (await res.json()) as { messages: DisplayMessage[] };
    },
  };
}

export type WidgetApi = ReturnType<typeof createApi>;
