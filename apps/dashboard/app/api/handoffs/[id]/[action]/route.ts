import { cookies } from "next/headers";
import { hasSameOrigin } from "../../../../../lib/request-security";
import { STAFF_COOKIE } from "../../../../../lib/session";
import { mutateHandoff, StaffApiError } from "../../../../../lib/staff-api";

const ACTIONS = new Set(["claim", "reply", "hand-back", "resolve"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  if (!hasSameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id, action } = await context.params;
  if (!ACTIONS.has(action)) return Response.json({ error: "not_found" }, { status: 404 });
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: { text: string } | undefined;
  if (action === "reply") {
    const value = (await request.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof value?.text === "string" ? value.text.trim() : "";
    if (text.length === 0 || text.length > 2_000) {
      return Response.json({ error: "invalid_input" }, { status: 400 });
    }
    body = { text };
  }
  try {
    await mutateHandoff(token, id, action as "claim" | "reply" | "hand-back" | "resolve", body);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof StaffApiError) {
      return Response.json(
        { error: error.status === 401 ? "unauthorized" : "upstream" },
        { status: error.status },
      );
    }
    throw error;
  }
}
