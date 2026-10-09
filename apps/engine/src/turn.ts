import { randomUUID } from "node:crypto";
import {
  checkUserMessage,
  createSession,
  createToolContext,
  runTurn,
  scrubPrices,
  shopperAmounts,
  type ToolContext,
  type TurnResult,
} from "@ace/agent";
import {
  acquireTurnLease,
  appendMessages,
  type BotRow,
  type ConversationRow,
  createConversation,
  type Db,
  getBotWithStore,
  getConversation,
  loadMessages,
  type MessageInput,
  monthToDateCostMicros,
  recordToolCalls,
  recordTurn,
  releaseLease,
  type StoreRow,
  saveSessionAndRelease,
  withTenant,
} from "@ace/db";
import type { LanguageModel, ModelMessage } from "ai";
import type { Logger } from "pino";
import type { createConversationTokens } from "./auth/conversation-token";
import type { WidgetIdentity } from "./auth/widget";
import { parsePersona, parseSession, parseStoreFacts } from "./bot-config";
import { budgetState, chooseModel, costMicros, type ModelPrices } from "./budget";
import { toModelMessages } from "./history";
import type { ErrorCode } from "./http-errors";
import type { ProviderFactory } from "./providers";
import type { Emit } from "./sse";

/** How long one turn may hold a conversation before another request can take it over. */
const DEFAULT_LEASE_MS = 90_000;
export const SCRUBBED_PRICE = "[see the product card]";
const APOLOGY = "Sorry, I can't answer right now. Please try again in a moment.";
const CONTACT_ONLY =
  "Sorry, the chat assistant is not available right now. Please contact the store directly for help.";

export interface TurnDeps {
  db: Db;
  providers: ProviderFactory;
  tokens: ReturnType<typeof createConversationTokens>;
  /** Model spec from bot config → model. Kept injectable so tests and the keyless demo use scripted models. */
  models: (spec: string) => LanguageModel;
  logger: Logger;
  leaseMs?: number;
  /** Owner-maintained price table (E2); unknown prices mean unknown cost, so budgets cannot trigger. */
  prices: ModelPrices;
  /** Provider retries per model before falling back (default: the agent's, i.e. once). */
  modelRetries?: number;
  now?: () => number;
}

/** A refusal decided before the SSE stream opens, so it can be a plain HTTP error. */
export class TurnError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TurnError";
  }
}

export interface PreparedTurn {
  widget: WidgetIdentity;
  conversation: ConversationRow;
  conversationToken: string;
  bot: BotRow;
  store: StoreRow;
}

export interface TurnRequest {
  message: string;
  conversationId?: string | undefined;
  conversationToken?: string | undefined;
  cartId?: string | undefined;
  visitorId: string;
}

const notFound = () => new TurnError(404, "not_found", "Conversation not found.");

/**
 * Verifies the conversation token, loads the bot and takes the turn lease on an existing conversation.
 * A missing, forged or foreign token looks exactly like a missing conversation (404).
 */
export async function leaseExistingConversation(
  deps: TurnDeps,
  widget: WidgetIdentity,
  conversationId: string,
  conversationToken: string | undefined,
): Promise<PreparedTurn> {
  const { tenantId, botId } = widget;
  const claims = deps.tokens.verify(conversationToken ?? "");
  if (!claims || claims.tenantId !== tenantId || claims.conversationId !== conversationId) throw notFound();
  return withTenant(deps.db, tenantId, async (tx) => {
    const loaded = await getBotWithStore(tx, botId);
    const existing = await getConversation(tx, conversationId);
    if (!loaded || !existing || existing.botId !== botId) throw notFound();
    const conversation = await acquireTurnLease(tx, existing.id, deps.leaseMs ?? DEFAULT_LEASE_MS);
    if (!conversation) throw new TurnError(409, "turn_in_progress", "Still answering the previous message.");
    return {
      widget,
      conversation,
      conversationToken: conversationToken ?? "",
      bot: loaded.bot,
      store: loaded.store,
    };
  });
}

/** Validates the message, then opens a new conversation or leases the existing one. */
export async function prepareTurn(
  deps: TurnDeps,
  widget: WidgetIdentity,
  request: TurnRequest,
): Promise<PreparedTurn> {
  const check = checkUserMessage(request.message);
  if (!check.ok) throw new TurnError(400, "invalid_input", `Message rejected: ${check.reason}.`);
  if (request.conversationId !== undefined) {
    return leaseExistingConversation(deps, widget, request.conversationId, request.conversationToken);
  }
  const { tenantId, botId } = widget;
  return withTenant(deps.db, tenantId, async (tx) => {
    const loaded = await getBotWithStore(tx, botId);
    if (!loaded) throw notFound();
    const created = await createConversation(tx, tenantId, {
      botId,
      visitorId: request.visitorId,
      session: createSession(),
      cartId: request.cartId ?? null,
    });
    const conversation = await acquireTurnLease(tx, created.id, deps.leaseMs ?? DEFAULT_LEASE_MS);
    if (!conversation) throw new Error("lease on a new conversation failed");
    return {
      widget,
      conversation,
      conversationToken: deps.tokens.sign({ tenantId, conversationId: conversation.id }),
      bot: loaded.bot,
      store: loaded.store,
    };
  });
}

function outcomesOf(ctx: ToolContext, result: TurnResult, scrubbed: boolean): string[] {
  const outcomes = new Set<string>();
  for (const entry of ctx.toolLog) {
    if (entry.ok && entry.name === "add_to_cart") outcomes.add("added_to_cart");
    if (entry.ok && entry.name === "start_checkout") outcomes.add("checkout_started");
  }
  if (result.regenerated) outcomes.add("regenerated");
  if (scrubbed) outcomes.add("grounding_scrubbed");
  return [...outcomes];
}

/** The rows to store: the turn's messages, with display data on the shopper's message and the final reply. */
function messageRows(result: TurnResult, shownText: string, userText: string): MessageInput[] {
  const messages = [...result.newMessages];
  const last = messages.at(-1);
  if (last?.role === "assistant" && shownText !== result.text) {
    // Keep what the shopper saw, so the model does not repeat a scrubbed price next turn.
    messages[messages.length - 1] = { role: "assistant", content: shownText };
  }
  return messages.map((message, index): MessageInput => {
    const isFirst = index === 0 && message.role === "user";
    const isReply = index === messages.length - 1 && message.role === "assistant";
    return {
      kind: "model",
      payload: message,
      display: isFirst
        ? { role: "user", text: userText }
        : isReply
          ? { role: "assistant", text: shownText, ui: result.ui }
          : undefined,
    };
  });
}

/** Runs the agent for a prepared turn, persists it, and emits status/reply/done (or error). Never throws. */
export async function runPreparedTurn(
  deps: TurnDeps,
  prepared: PreparedTurn,
  request: TurnRequest,
  emit: Emit,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const started = now();
  const { tenantId } = prepared.widget;
  const conversationId = prepared.conversation.id;
  const turnId = randomUUID();
  let released = false;
  let model = prepared.bot.model;

  try {
    const spent = await withTenant(deps.db, tenantId, (tx) =>
      monthToDateCostMicros(tx, prepared.bot.id, new Date(now())),
    );
    const state = budgetState(spent, prepared.bot);
    if (state !== "ok")
      deps.logger.warn({ botId: prepared.bot.id, state, spent }, "bot budget threshold reached");
    const choice = chooseModel(prepared.bot, state);
    if ("contactOnly" in choice) {
      await answerContactOnly(deps, prepared, request, turnId, now() - started);
      released = true;
      emit("reply", { text: CONTACT_ONLY, ui: [], cartId: request.cartId ?? prepared.conversation.cartId });
      emit("done", {});
      return;
    }
    model = choice.model;
    const stored = await withTenant(deps.db, tenantId, (tx) => loadMessages(tx, conversationId));
    const history: ModelMessage[] = toModelMessages(stored.rows);
    const ctx = createToolContext({
      provider: deps.providers(tenantId, prepared.store),
      conversationId,
      turnId,
      session: parseSession(prepared.conversation.session),
      cartId: request.cartId ?? prepared.conversation.cartId,
      onToolStart: (name) => emit("status", { tool: name }),
      onUnexpectedError: (error) => deps.logger.error({ err: error, turnId }, "tool failed unexpectedly"),
      now,
    });
    const input = {
      ctx,
      persona: parsePersona(prepared.bot.persona),
      store: parseStoreFacts(prepared.bot.storeFacts),
      history,
      userMessage: request.message,
      maxSteps: prepared.bot.maxSteps,
      maxRetries: deps.modelRetries,
    };

    let result: TurnResult;
    try {
      result = await runTurn({ ...input, model: deps.models(model) });
    } catch (error) {
      // Retrying after a tool ran could repeat a cart write under new keys, so only fall back before any tool.
      const fallback = prepared.bot.fallbackModel;
      if (!fallback || ctx.toolLog.length > 0) throw error;
      deps.logger.warn({ err: error, turnId, model }, "primary model failed; using fallback");
      model = fallback;
      result = await runTurn({ ...input, model: deps.models(model) });
    }

    const allowed = new Set([...ctx.observedAmounts, ...shopperAmounts(request.message)]);
    const scrubbed = result.ungroundedAmounts.length > 0;
    const text = scrubbed ? scrubPrices(result.text, allowed, SCRUBBED_PRICE) : result.text;

    await withTenant(deps.db, tenantId, async (tx) => {
      await appendMessages(
        tx,
        tenantId,
        conversationId,
        stored.nextSeq,
        messageRows(result, text, request.message),
      );
      await recordToolCalls(
        tx,
        tenantId,
        conversationId,
        turnId,
        ctx.toolLog.map((entry, index) => {
          const call = result.toolCalls[index];
          return {
            name: entry.name,
            input: call?.name === entry.name ? call.input : null,
            output: null,
            ok: entry.ok,
            errorCode: entry.errorCode ?? null,
            ms: entry.ms,
          };
        }),
      );
      await recordTurn(tx, tenantId, {
        conversationId,
        botId: prepared.bot.id,
        turnId,
        model,
        promptVersion: result.promptVersion,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsdMicros: costMicros(deps.prices, model, result.usage),
        latencyMs: now() - started,
        toolNames: ctx.toolLog.map((entry) => entry.name),
        outcomes: outcomesOf(ctx, result, scrubbed),
        regenerated: result.regenerated,
        ungroundedCount: result.ungroundedAmounts.length,
        error: null,
      });
      await saveSessionAndRelease(tx, conversationId, { session: ctx.session, cartId: ctx.cartId });
    });
    released = true;
    emit("reply", { text, ui: result.ui, cartId: ctx.cartId });
    emit("done", {});
  } catch (error) {
    deps.logger.error({ err: error, turnId, model }, "turn failed");
    emit("error", { code: "model_unavailable", message: APOLOGY });
  } finally {
    if (!released) {
      await withTenant(deps.db, tenantId, (tx) => releaseLease(tx, conversationId)).catch((error: unknown) =>
        deps.logger.error({ err: error, turnId }, "could not release turn lease"),
      );
    }
  }
}

/** Hard budget cap: store the exchange and a trace, call no model (spec §4.7 "contact us" mode). */
async function answerContactOnly(
  deps: TurnDeps,
  prepared: PreparedTurn,
  request: TurnRequest,
  turnId: string,
  latencyMs: number,
): Promise<void> {
  const { tenantId } = prepared.widget;
  const conversationId = prepared.conversation.id;
  await withTenant(deps.db, tenantId, async (tx) => {
    const stored = await loadMessages(tx, conversationId);
    await appendMessages(tx, tenantId, conversationId, stored.nextSeq, [
      {
        kind: "model",
        payload: { role: "user", content: request.message },
        display: { role: "user", text: request.message },
      },
      {
        kind: "model",
        payload: { role: "assistant", content: CONTACT_ONLY },
        display: { role: "assistant", text: CONTACT_ONLY, ui: [] },
      },
    ]);
    await recordTurn(tx, tenantId, {
      conversationId,
      botId: prepared.bot.id,
      turnId,
      model: "none",
      promptVersion: "none",
      inputTokens: 0,
      outputTokens: 0,
      costUsdMicros: 0,
      latencyMs,
      toolNames: [],
      outcomes: ["budget_contact_only"],
      regenerated: false,
      ungroundedCount: 0,
      error: null,
    });
    await releaseLease(tx, conversationId);
  });
}
