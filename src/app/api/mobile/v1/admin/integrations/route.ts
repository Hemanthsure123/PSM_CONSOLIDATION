import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { teamStatus } from "@/lib/team/google";
import { notionConfigured } from "@/lib/team/notion";

/** GET /admin/integrations — the team Google account and Notion: configured, connected, last error. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async () => NextResponse.json({ google: await teamStatus(), notion: { configured: notionConfigured() } }), { admin: true });
