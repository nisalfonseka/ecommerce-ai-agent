export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const expected = new URL(process.env.DASHBOARD_PUBLIC_URL ?? request.url).origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}
