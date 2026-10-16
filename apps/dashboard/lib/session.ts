export const STAFF_COOKIE = "ace_staff_token";

export const staffCookieOptions = () => ({
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 8 * 60 * 60,
});
