import { type NextRequest, NextResponse } from "next/server";
import { STAFF_COOKIE } from "./lib/session";

export function proxy(request: NextRequest) {
  if (!request.cookies.get(STAFF_COOKIE)?.value) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/inbox/:path*", "/handoffs/:path*"] };
