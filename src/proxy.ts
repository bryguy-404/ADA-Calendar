import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

/** Refresh both the downstream request and browser cookies before Server Components run. */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const isDemo = process.env.NODE_ENV !== "production" && process.env.ADA_DEMO_MODE === "true";
  if (isDemo || !url || !key || request.nextUrl.pathname === "/api/email/webhook"
    || request.nextUrl.pathname.startsWith("/api/integrations/crm/v1/")) return response;
  const appUrl = new URL(process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? request.url);
  const origin = request.headers.get("origin");
  // Route handlers enforce mutation origins; do not rotate cookies for cross-origin traffic.
  if (origin && origin !== appUrl.origin) return response;
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values) {
        for (const { name, value } of values) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of values) response.cookies.set(name, value, { ...options, domain: undefined, path: "/", sameSite: "lax", secure: appUrl.protocol === "https:", httpOnly: true });
      },
    },
  });
  // getClaims verifies the JWT and refreshes expired tokens; it is not a membership grant.
  // Live data access independently verifies the current user and active workspace membership.
  await client.auth.getClaims();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
