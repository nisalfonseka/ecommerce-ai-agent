import type { UiPart } from "@ace/agent";
import type { DisplayMessage } from "./api";
import type { SavedConversation } from "./storage";

export interface Message {
  id: number;
  role: "user" | "assistant";
  text: string;
  ui: UiPart[];
}

export interface State {
  messages: Message[];
  sending: boolean;
  /** Transient progress line while tools run ("Searching the catalog…"). */
  status: string | null;
  conversation: SavedConversation | null;
  cartId: string | null;
  error: string | null;
}

export type Action =
  | { type: "user_sent"; text: string }
  | { type: "conversation"; conversation: SavedConversation }
  | { type: "status"; tool: string }
  | { type: "reply"; text: string; ui: UiPart[]; cartId: string | null }
  | { type: "action_result"; ui: UiPart[]; cartId: string | null }
  | { type: "error"; message: string }
  | { type: "restored"; messages: DisplayMessage[] }
  | { type: "set_cart"; cartId: string | null }
  | { type: "reset" };

const STATUS: Record<string, string> = {
  search_products: "Searching the catalog…",
  get_product: "Looking at the product…",
  check_availability: "Checking stock…",
  view_cart: "Opening your cart…",
  add_to_cart: "Adding to your cart…",
  update_cart_line: "Updating your cart…",
  start_checkout: "Preparing checkout…",
  lookup_order: "Looking up your order…",
};

export function statusLabel(tool: string): string {
  return STATUS[tool] ?? "Working…";
}

export function initialState(cartId: string | null): State {
  return { messages: [], sending: false, status: null, conversation: null, cartId, error: null };
}

let nextId = 1;
const message = (role: Message["role"], text: string, ui: UiPart[]): Message => ({
  id: nextId++,
  role,
  text,
  ui,
});

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "user_sent":
      return {
        ...state,
        messages: [...state.messages, message("user", action.text, [])],
        sending: true,
        status: null,
        error: null,
      };
    case "conversation":
      return { ...state, conversation: action.conversation };
    case "status":
      return { ...state, status: statusLabel(action.tool) };
    case "reply":
      return {
        ...state,
        messages: [...state.messages, message("assistant", action.text, action.ui)],
        sending: false,
        status: null,
        cartId: action.cartId ?? state.cartId,
      };
    case "action_result":
      return {
        ...state,
        messages:
          action.ui.length > 0 ? [...state.messages, message("assistant", "", action.ui)] : state.messages,
        cartId: action.cartId ?? state.cartId,
      };
    case "error":
      return { ...state, sending: false, status: null, error: action.message };
    case "restored":
      return { ...state, messages: action.messages.map((m) => message(m.role, m.text, m.ui ?? [])) };
    case "set_cart":
      return { ...state, cartId: action.cartId };
    case "reset":
      return { ...initialState(state.cartId) };
  }
}
