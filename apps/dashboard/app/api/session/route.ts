import { NextResponse } from "next/server";
import { hasSameOrigin } from "../../../lib/request-security";
import { STAFF_COOKIE, staffCookieOptions } from "../../../lib/session";
import { validateStaffToken } from "../../../lib/staff-api";

const TOKEN = /^st_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/i;

export async function POST(request: Request): Promise<Response> {
  if (!hasSameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!TOKEN.test(token)) return Response.json({ error: "invalid_token" }, { status: 400 });
  if (!(await validateStaffToken(token))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(STAFF_COOKIE, token, staffCookieOptions());
  return response;
}

export async function DELETE(request: Request): Promise<Response> {
  if (!hasSameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(STAFF_COOKIE, "", { ...staffCookieOptions(), maxAge: 0 });
  return response;
}
