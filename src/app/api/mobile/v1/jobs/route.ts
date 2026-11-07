import { NextResponse } from "next/server";
import { query } from "@/lib/db/client";
import { toJob } from "@/lib/automation/store";
import { withUser } from "@/lib/mobile/http";
import { toMobileJob } from "@/lib/mobile/jobs";
import { listTasks } from "@/lib/mobile/tasks";

/** GET /jobs?scope=mine|team: the latest screening of each of my tasks, newest first. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (req, { user }) => {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "team" ? "team" : "mine";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 100);
  const { tasks } = await listTasks(user, scope);
  const ids = tasks.map((t) => t.jobId).filter((id): id is string => Boolean(id));
  const taskOf = new Map(tasks.filter((t) => t.jobId).map((t) => [t.jobId!, t.id]));
  const rows = ids.length
    ? await query("select * from automation.jobs where id = any($1::uuid[]) order by created_at desc limit $2", [ids, limit])
    : [];
  return NextResponse.json({ jobs: rows.map(toJob).map((j) => toMobileJob(j, taskOf.get(j.id) ?? null)) });
});
