import { goToLogin } from "./login-redirect";

export interface HandoffSummary {
  id: string;
  conversationId: string;
  reason: string;
  summary: string;
  status: "open" | "claimed" | "resolved";
  claimedBy: string | null;
  createdAt: string;
}

export interface StaffMessage {
  role: "user" | "assistant" | "staff";
  text: string;
  label?: string;
  ui?: unknown[];
}

export interface HandoffDetail extends HandoffSummary {
  messages: StaffMessage[];
}

export class StaffApiError extends Error {
  constructor(readonly status: number) {
    super(`Staff API returned HTTP ${status}`);
  }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Unauthorized = () => never;

const baseUrl = () => process.env.ENGINE_INTERNAL_URL ?? "http://engine:8080";

async function request<T>(
  token: string,
  path: string,
  fetch_: Fetch,
  unauthorized: Unauthorized,
): Promise<T> {
  const response = await fetch_(`${baseUrl()}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (response.status === 401) unauthorized();
  if (!response.ok) throw new StaffApiError(response.status);
  return (await response.json()) as T;
}

export async function validateStaffToken(token: string, fetch_: Fetch = fetch): Promise<boolean> {
  const response = await fetch_(`${baseUrl()}/staff/v1/handoffs?status=open`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return response.ok;
}

export async function listHandoffs(
  token: string,
  fetch_: Fetch = fetch,
  unauthorized: Unauthorized = goToLogin,
): Promise<HandoffSummary[]> {
  const rows = await request<HandoffSummary[]>(token, "/staff/v1/handoffs?status=open", fetch_, unauthorized);
  return rows.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function getHandoff(token: string, id: string, fetch_: Fetch = fetch): Promise<HandoffDetail> {
  return request<HandoffDetail>(token, `/staff/v1/handoffs/${encodeURIComponent(id)}`, fetch_, goToLogin);
}

export async function mutateHandoff(
  token: string,
  id: string,
  action: "claim" | "reply" | "hand-back" | "resolve",
  body?: { text: string },
  fetch_: Fetch = fetch,
): Promise<void> {
  const response = await fetch_(`${baseUrl()}/staff/v1/handoffs/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new StaffApiError(response.status);
}
