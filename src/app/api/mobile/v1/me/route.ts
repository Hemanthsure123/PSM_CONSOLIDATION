import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";

/** GET /me: the signed-in user as the roster has them now. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (_req, { user }) =>
  NextResponse.json({ id: user.email, email: user.email, name: user.name, role: user.role, teamsLinked: false }),
);
