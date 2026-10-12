import { CommerceError, type CommerceErrorCode } from "@ace/contracts";
import type { z } from "zod";

export interface MedusaHttpOptions {
  baseUrl: string;
  publishableKey: string;
  /** Admin API secret key; only sent to /admin routes. */
  secretKey: string;
  timeoutMs: number;
  fetch: typeof fetch;
}

type Query = Record<string, string | number | boolean | string[] | undefined>;
interface RequestOptions {
  query?: Query;
  body?: unknown;
}

function queryString(query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) params.append(`${name}[]`, item);
    else params.append(name, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

interface MedusaErrorBody {
  type?: unknown;
  code?: unknown;
  message?: unknown;
}

/** Medusa's error body → contract code. The platform message goes to `cause`, never to the model. */
function codeFor(status: number, body: MedusaErrorBody): CommerceErrorCode {
  if (status === 404) return "NOT_FOUND";
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  if (body.code === "insufficient_inventory") return "OUT_OF_STOCK";
  const message = typeof body.message === "string" ? body.message : "";
  if (body.type === "invalid_data" && /do not exist|not found|does not exist/i.test(message))
    return "NOT_FOUND";
  if (
    body.type === "not_allowed" ||
    body.type === "conflict" ||
    body.type === "duplicate_error" ||
    status === 409
  ) {
    return "CONFLICT";
  }
  return "INVALID_INPUT";
}

const MESSAGES: Record<CommerceErrorCode, string> = {
  NOT_FOUND: "The store could not find that.",
  INVALID_INPUT: "The store rejected the request.",
  OUT_OF_STOCK: "Not enough stock for this item.",
  NOT_SUPPORTED: "The store does not support this.",
  UNAUTHORIZED: "The store refused the credentials.",
  CONFLICT: "The store refused the change in the cart's current state.",
  RATE_LIMITED: "The store is busy; try again shortly.",
  UPSTREAM_UNAVAILABLE: "The store is not reachable right now.",
};

export class MedusaHttp {
  constructor(private readonly options: MedusaHttpOptions) {}

  store<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    request?: RequestOptions,
  ): Promise<z.output<S>> {
    return this.send(schema, method, path, { "x-publishable-api-key": this.options.publishableKey }, request);
  }

  admin<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    request?: RequestOptions,
  ): Promise<z.output<S>> {
    const token = Buffer.from(`${this.options.secretKey}:`).toString("base64");
    return this.send(schema, method, path, { authorization: `Basic ${token}` }, request);
  }

  private async send<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    auth: Record<string, string>,
    request: RequestOptions = {},
  ): Promise<z.output<S>> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}${path}${queryString(request.query)}`;
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method,
        headers: { accept: "application/json", "content-type": "application/json", ...auth },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new CommerceError(
        "UPSTREAM_UNAVAILABLE",
        MESSAGES.UPSTREAM_UNAVAILABLE,
        { path },
        { cause: error },
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const errorBody = (typeof body === "object" && body !== null ? body : {}) as MedusaErrorBody;
      const code = codeFor(response.status, errorBody);
      throw new CommerceError(
        code,
        MESSAGES[code],
        { path, platformStatus: response.status },
        { cause: new Error(`Medusa ${response.status}: ${JSON.stringify(body)}`) },
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new CommerceError(
        "UPSTREAM_UNAVAILABLE",
        "The store sent an unexpected response.",
        { path, platformStatus: response.status },
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }
}
