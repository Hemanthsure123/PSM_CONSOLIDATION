import { NextResponse } from "next/server";
import { withUser } from "@/lib/mobile/http";
import { latestRelease } from "@/lib/mobile/releases";

/**
 * GET /app/releases/latest — { release: { versionCode, versionName, notes, sizeBytes, sha256,
 * minSupported, publishedAt, downloadPath } | null }. The phone compares versionCode with its own
 * and offers the update.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async () => NextResponse.json({ release: await latestRelease() }, { headers: { "Cache-Control": "no-store" } }));
