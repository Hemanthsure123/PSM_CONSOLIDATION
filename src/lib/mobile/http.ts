import "server-only";
import { NextResponse } from "next/server";
import { databaseConfigured, describeDbError, query } from "@/lib/db/client";
import { env } from "@/lib/env";
import { type AccessClaims, verifyAccessToken } from "@/lib/mobile/jwt";
import type { RosterUser } from "@/lib/mobile/roster";

/** Every error the app sees: a sentence for the user and a machine code (docs/mobile-api.yaml). */
export function fail(status: number, error: string, code?: string, headers?: HeadersInit): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, { status, headers });
}

export interface MobileRequestContext {
  user: RosterUser;
  claims: AccessClaims;
}

type Handler<P> = (req: Request, ctx: MobileRequestContext, params: P) => Promise<Response>;

/**
 * Wraps a route: checks the Bearer access token, loads the user from the roster (an account
 * removed or deactivated since sign-in is refused at once), and turns thrown errors into the
 * contract's error shape without leaking internals.
 */
export function withUser<P = Record<string, string>>(handler: Handler<P>, opts: { admin?: boolean } = {}) {
  return async (req: Request, route: { params: P | Promise<P> }): Promise<Response> => {
    if (!databaseConfigured()) return fail(503, "The server's database isn't configured.", "db_unavailable");
    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const claims = token ? verifyAccessToken(token, env.mobile.jwtSecret) : null;
    if (!claims) return fail(401, "Your session ended. Sign in again.", "unauthorized");
    try {
      const rows = await query<RosterUser>(
        "select email, name, aliases, role, active, lead_email as \"leadEmail\" from app.users where email = $1",
        [claims.sub],
      );
      const user = rows[0];
      if (!user || !user.active) return fail(401, "Your access was removed. Ask your admin.", "not_on_roster");
      if (opts.admin && user.role !== "admin") return fail(403, "Only admins can do this.", "admin_only");
      return await handler(req, { user, claims }, await route.params);
    } catch (err) {
      return serverError(err);
    }
  };
}

/** For the routes that run before sign-in. */
export function publicRoute<P = Record<string, string>>(handler: (req: Request, params: P) => Promise<Response>) {
  return async (req: Request, route: { params: P | Promise<P> }): Promise<Response> => {
    if (!databaseConfigured()) return fail(503, "The server's database isn't configured.", "db_unavailable");
    try {
      return await handler(req, await route.params);
    } catch (err) {
      return serverError(err);
    }
  };
}

export class UserError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function serverError(err: unknown): Response {
  if (err instanceof UserError) return fail(err.status, err.message, err.code);
  const message = err instanceof Error ? err.message : String(err);
  console.error("[mobile] request failed:", message.slice(0, 300));
  if (/database|ECONN|timeout|pool|terminat/i.test(message)) return fail(503, describeDbError(err), "db_unavailable");
  if (/quota|rate|429|503|ETIMEDOUT/i.test(message)) return fail(503, "Google Sheets is busy. Try again in a minute.", "sheets_unavailable");
  return fail(500, "Something went wrong on the server. Try again.", "server_error");
}

export async function readJson<T>(req: Request): Promise<T | null> {
  return (await req.json().catch(() => null)) as T | null;
}
