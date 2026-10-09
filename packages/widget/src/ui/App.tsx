import type { UiPart } from "@ace/agent";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import { ApiError, type ChatEvent, type WidgetApi } from "../api";
import { emitCartUpdated } from "../host";
import { initialState, reduce } from "../state";
import type { WidgetStorage } from "../storage";
import { uuid } from "../uuid";
import { Card } from "./cards";

const MAX_MESSAGE = 2000;

export interface HostControls {
  open(): void;
  close(): void;
  setCart(cartId: string | null): void;
}

interface AppProps {
  widgetKey: string;
  api: WidgetApi;
  storage: WidgetStorage;
  win: Window;
  initialCartId: string | null;
  /** Receives open/close/setCart so window.ACE can drive the widget. */
  bindHost?: (controls: HostControls) => void;
}

function itemCountOf(ui: UiPart[]): number | null {
  for (let i = ui.length - 1; i >= 0; i -= 1) {
    const part = ui[i];
    if (part?.type === "cart") return part.cart.itemCount;
  }
  return null;
}

function friendlyError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "turn_in_progress") return "Still answering your last message. One moment, please.";
    if (error.code === "rate_limited") return "Too many messages. Please wait a moment and try again.";
    if (error.code === "forbidden_origin" || error.code === "unauthorized")
      return "The assistant is not available on this site.";
    return error.message;
  }
  return "Can't reach the assistant right now. Please check your connection and try again.";
}

export function App({ widgetKey, api, storage, win, initialCartId, bindHost }: AppProps) {
  const [state, dispatch] = useReducer(reduce, initialCartId, initialState);
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(storage.consentGiven());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };

  useEffect(() => {
    bindHost?.({
      open: () => setOpen(true),
      close: () => close(),
      setCart: (cartId) => dispatch({ type: "set_cart", cartId }),
    });
  }, [bindHost]);

  // Resume the saved conversation; a 404 (expired or foreign) starts fresh.
  useEffect(() => {
    const saved = storage.loadConversation(widgetKey);
    if (!saved) return;
    api
      .loadConversation(saved.conversationId, saved.conversationToken)
      .then((history) => {
        dispatch({ type: "conversation", conversation: saved });
        dispatch({ type: "restored", messages: history.messages });
      })
      .catch(() => storage.clearConversation(widgetKey));
  }, [api, storage, widgetKey]);

  useEffect(() => {
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
  }, [state.messages.length, state.status]);

  // Keyboard users: focus moves into the dialog when it opens and back to the launcher when it closes.
  useLayoutEffect(() => {
    if (open) {
      const target = consent
        ? inputRef.current
        : panelRef.current?.querySelector<HTMLButtonElement>(".consent button");
      (target ?? panelRef.current)?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      launcherRef.current?.focus();
    }
  }, [open, consent]);

  const announceCart = (cartId: string | null, ui: UiPart[], previous: string | null) => {
    const itemCount = itemCountOf(ui);
    if (itemCount !== null || (cartId !== null && cartId !== previous)) {
      emitCartUpdated(win, { cartId: cartId ?? previous, itemCount });
    }
  };

  async function send(text: string, retry = true): Promise<void> {
    const before = stateRef.current;
    if (retry) dispatch({ type: "user_sent", text });
    try {
      await api.chat(
        {
          message: text,
          ...(before.conversation ?? {}),
          ...(before.cartId ? { cartId: before.cartId } : {}),
        },
        (event: ChatEvent) => {
          if (event.event === "conversation") {
            storage.saveConversation(widgetKey, event.data);
            dispatch({ type: "conversation", conversation: event.data });
          } else if (event.event === "status") {
            dispatch({ type: "status", tool: event.data.tool });
          } else if (event.event === "reply") {
            dispatch({ type: "reply", text: event.data.text, ui: event.data.ui, cartId: event.data.cartId });
            announceCart(event.data.cartId, event.data.ui, before.cartId);
          } else if (event.event === "error") {
            dispatch({ type: "error", message: event.data.message });
          }
        },
      );
    } catch (error) {
      if (retry && error instanceof ApiError && error.status === 404 && before.conversation) {
        // The saved conversation expired: start a new one with the same message.
        storage.clearConversation(widgetKey);
        dispatch({ type: "reset" });
        dispatch({ type: "user_sent", text });
        return send(text, false);
      }
      dispatch({ type: "error", message: friendlyError(error) });
    }
  }

  async function runAction(type: string, input: Record<string, unknown>): Promise<void> {
    const conversation = stateRef.current.conversation;
    if (busyRef.current || !conversation) return;
    busyRef.current = true;
    setBusy(true);
    const previous = stateRef.current.cartId;
    try {
      const response = await api.action(type, {
        ...conversation,
        actionId: uuid(),
        ...(previous ? { cartId: previous } : {}),
        input,
      });
      dispatch({ type: "action_result", ui: response.ui, cartId: response.cartId });
      if (!response.result.ok) dispatch({ type: "error", message: response.result.error.message });
      announceCart(response.cartId, response.ui, previous);
    } catch (error) {
      dispatch({ type: "error", message: friendlyError(error) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const onSubmit = (event: Event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || state.sending) return;
    setDraft("");
    void send(text);
  };

  // The launcher stays mounted (hidden while open) so focus can return to it on close.
  const launcher = (
    <button
      type="button"
      class="launcher"
      ref={launcherRef}
      hidden={open}
      aria-label="Open shopping assistant"
      onClick={() => setOpen(true)}
    >
      <span aria-hidden="true">💬</span>
    </button>
  );
  if (!open) return launcher;

  return (
    <>
      {launcher}
      <div
        class="panel"
        role="dialog"
        aria-label="Shopping assistant"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      >
        <header>
          <span>Shopping assistant</span>
          <button type="button" class="close" aria-label="Close" onClick={close}>
            ×
          </button>
        </header>
        <div class="messages" aria-live="polite" ref={listRef}>
          {state.messages.map((message) => (
            <div key={message.id} class={`message ${message.role}`}>
              {message.text && <p>{message.text}</p>}
              {message.ui.map((part, index) => (
                <Card
                  key={`${message.id}-${index}`}
                  part={part}
                  busy={busy}
                  onAction={(t, i) => void runAction(t, i)}
                />
              ))}
            </div>
          ))}
          {state.status && <p class="status">{state.status}</p>}
          {state.error && (
            <p class="error" role="alert">
              {state.error}
            </p>
          )}
        </div>
        {consent ? (
          <form class="composer" onSubmit={onSubmit}>
            <textarea
              ref={inputRef}
              aria-label="Message"
              rows={2}
              maxLength={MAX_MESSAGE}
              value={draft}
              placeholder="Ask about products, sizes or your cart…"
              onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  (event.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                }
              }}
            />
            <button type="submit" disabled={state.sending || draft.trim().length === 0}>
              Send
            </button>
          </form>
        ) : (
          <div class="consent">
            <p>
              This chat is an AI shopping assistant for this store. Your messages are stored to answer you and
              to improve the service. Please don't share passwords or card details.
            </p>
            <button
              type="button"
              class="primary"
              onClick={() => {
                storage.giveConsent();
                setConsent(true);
              }}
            >
              Start chat
            </button>
          </div>
        )}
      </div>
    </>
  );
}
