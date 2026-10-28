import { NextResponse, type NextRequest } from "next/server";

/**
 * Sign-in for a deployed copy of the app. The app holds candidate PII and can write
 * to the database, so a deployment must never be open to the internet.
 *
 * Set APP_BASIC_AUTH="user:password" (a long random password) in the host's
 * environment and every page and API route asks for it (HTTP Basic, over HTTPS only).
 * Unset — as in local development — nothing is asked. A host-level sign-in (Vercel
 * Deployment Protection, Cloudflare Access, an SSO proxy) is the stronger option and
 * can replace this; see docs/architecture.md.
 *
 * Open without this sign-in: /api/health (liveness — "is the app up, which build"), so the
 * host's health check and an agent waiting for a sleeping instance can poll it; it returns no
 * candidate data. And /api/automation/*, which checks its own Bearer token (AUTOMATION_TOKEN —
 * the sheet's Apps Script uses it). Everything else, /api/status included, needs the sign-in.
 */

const PUBLIC_PATHS = new Set(["/api/health"]);
const OWN_AUTH_PREFIX = "/api/automation/";

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const expected = process.env.APP_BASIC_AUTH?.trim();
  const path = req.nextUrl.pathname;
  if (!expected || PUBLIC_PATHS.has(path) || path.startsWith(OWN_AUTH_PREFIX)) return NextResponse.next();
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    let given = "";
    try {
      given = atob(header.slice(6).trim());
    } catch {
      given = "";
    }
    if (safeEqual(given, expected)) return NextResponse.next();
  }
  return new NextResponse("Sign in to continue.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="NxtWave Placements", charset="UTF-8"' },
  });
}

export const config = {
  // Everything except Next's own static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
