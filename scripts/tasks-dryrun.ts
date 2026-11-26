/**
 * READ-ONLY dry run of PSM 1.11.0's task logic against the live control tab and database:
 *   npx tsx scripts/tasks-dryrun.ts
 * Writes nothing: the control tab is only read, and every database read runs in one transaction
 * that starts with `set transaction read only` (never a session-level SET). Prints COUNTS only (and
 * mentor names, the team's own): no companies, candidates, phones or emails.
 *   1. ISE auto-assign: the open blank-Mentor rows whose ISE maps to an active mentor, and how many
 *      the first passes after the grace period would write (10 a minute), per mentor.
 *   2. The next tick's task pushes (assignment, escalation, nudge / soon / overdue slots), as
 *      syncAssignments would send them now (keys already sent are skipped, like the server does).
 *   3. What the lists would show: done, overdue, delivered, open; the digest's audience.
 */
import "./server-only-shim";
import type { PoolClient } from "pg";
import { toJob, type JobRow } from "@/lib/automation/store";
import { transaction } from "@/lib/db/client";
import { AUTO_ASSIGN_MAX_PER_TICK, autoAssignEnabled, autoAssignPlan } from "@/lib/mobile/auto-assign";
import { openForDigest, plannedSlots, type StateRow } from "@/lib/mobile/assignments";
import { type ControlTask, readControlSnapshot } from "@/lib/mobile/control-rows";
import { iseOwnerOf } from "@/lib/mobile/ise";
import { matchMentor, type RosterUser } from "@/lib/mobile/roster";
import { DONE_COLUMNS } from "@/lib/mobile/task-schema";
import { digestSlot, STALE_MS, taskDedupe } from "@/lib/mobile/task-nudges";
import {
  type AssignmentRow,
  deliveredAtOf,
  deriveState,
  inHistoryWindow,
  isDelivered,
  isUnassignedOpen,
  keepInList,
  toSummary,
} from "@/lib/mobile/tasks";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment */
}

const ESCALATE_AFTER_MS = 30 * 60_000;
const tally = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const show = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));

async function rows<T>(tx: PoolClient, sql: string, values: unknown[] = []): Promise<T[]> {
  return (await tx.query(sql, values)).rows as T[];
}

async function main() {
  const snap = await readControlSnapshot(true); // Sheets: read only
  const now = Date.now();
  const at = new Date(now);

  await transaction(async (tx) => {
    await tx.query("set transaction read only");
    const roster = await rows<RosterUser>(
      tx,
      `select u.email, u.name, u.aliases, u.role, u.active, u.lead_email as "leadEmail",
              coalesce((select array_agg(l.login_email order by l.login_email) from app.user_logins l where l.user_email = u.email), '{}') as "signInEmails"
         from app.users u order by u.active desc, u.role = 'admin' desc, u.name`,
    );
    const cols = await rows<{ n: number }>(
      tx,
      "select count(*)::int as n from information_schema.columns where table_schema = 'app' and table_name = 'assignments' and column_name = any($1::text[])",
      [DONE_COLUMNS],
    );
    const doneReady = Number(cols[0]?.n ?? 0) === DONE_COLUMNS.length;
    console.log(`control tab: ${snap.tasks.length} rows with a company; roster: ${roster.filter((u) => u.active).length} active`);
    console.log(`migration 021 applied: ${doneReady ? "yes" : "no (done / auto-assign / device health stay off until it is)"}; MOBILE_ISE_AUTO_ASSIGN: ${autoAssignEnabled() ? "on" : "off"}`);

    const ids = snap.tasks.map((t) => t.taskId);
    const stored = new Map(
      (
        await rows<AssignmentRow & { auto_assigned_at?: string | null }>(
          tx,
          `select task_id, ack_at, ack_by, assignee_email, job_id${doneReady ? ", done_at, done_by, auto_assigned, auto_assigned_at" : ""} from app.assignments where task_id = any($1::text[])`,
          [ids],
        )
      ).map((r) => [r.task_id, r]),
    );
    const jobRows = await rows<Record<string, unknown>>(
      tx,
      `select distinct on (control_row) * from automation.jobs
        where spreadsheet_id = $1 and control_tab = $2 and control_row = any($3::int[])
        order by control_row, created_at desc`,
      [snap.spreadsheetId, snap.tab, snap.tasks.map((t) => t.row)],
    );
    const byRow = new Map(jobRows.map((r) => toJob(r)).map((j) => [j.controlRow, j]));
    const jobs = new Map<string, JobRow>();
    for (const t of snap.tasks) {
      const j = byRow.get(t.row);
      if (j && j.companyName.trim().toLowerCase() === t.company.trim().toLowerCase()) jobs.set(t.taskId, j);
    }
    const sentKeys = async (keys: string[]) =>
      new Map(
        keys.length
          ? (await rows<{ dedupe_key: string; at: Date }>(tx, "select dedupe_key, at from app.notifications where dedupe_key = any($1::text[])", [keys])).map((r) => [
              r.dedupe_key,
              new Date(r.at).getTime(),
            ])
          : [],
      );

    // ── 1. ISE auto-assign ──────────────────────────────────────────────────
    const open = snap.tasks.filter((t) => isUnassignedOpen(t, at));
    const mapped = open.filter((t) => iseOwnerOf(t.pc, roster)?.active);
    const skip = new Set(
      mapped
        .filter((t) => {
          const a = stored.get(t.taskId);
          return a && (a.auto_assigned_at || (a.done_at && !a.assignee_email));
        })
        .map((t) => t.taskId),
    );
    // As if the server had been watching these rows since they appeared (the grace period counts
    // from the assigned time); a fresh process waits 5 more minutes first.
    const longSeen = new Map(mapped.map((t) => [`${t.taskId}|${iseOwnerOf(t.pc, roster)!.email}`, 0]));
    const plan = autoAssignPlan(mapped, roster, now, { firstSeen: longSeen, skip, max: Number.MAX_SAFE_INTEGER });
    const perMentor = new Map<string, number>();
    for (const c of plan.write) tally(perMentor, c.owner.name);
    const noDate = plan.write.filter((c) => !c.task.assignedAt).length;
    const pastDeadline = plan.write.filter((c) => c.task.deadline && c.task.deadline.getTime() <= now).length;
    const unmappedIse = new Map<string, number>();
    for (const t of open.filter((x) => !iseOwnerOf(x.pc, roster)?.active)) tally(unmappedIse, t.pc.trim() ? "(ISE with no mapping)" : "(PC blank)");
    console.log("\n1. ISE auto-assign");
    console.log(`   open blank-Mentor rows: ${open.length}; ISE maps to an active mentor: ${mapped.length}; not mapped: ${JSON.stringify(show(unmappedIse))}`);
    console.log(`   would be auto-assigned now (past the 5-min grace): ${plan.write.length} → ${JSON.stringify(show(perMentor))}`);
    console.log(`     of which ${noDate} have no assigned date, ${pastDeadline} are already past their deadline; still in the grace period: ${plan.waiting.length}; skipped (auto-assigned before / done): ${skip.size}`);
    console.log(`   at ${AUTO_ASSIGN_MAX_PER_TICK} a minute that takes ${Math.ceil(plan.write.length / AUTO_ASSIGN_MAX_PER_TICK)} minute(s) after the first 5 minutes of a deploy`);

    // ── 2. The next tick's task pushes ──────────────────────────────────────
    const assigned = snap.tasks
      .map((task) => ({ task, assignee: task.mentor ? matchMentor(task.mentor, roster) : null }))
      .filter((x): x is { task: ControlTask; assignee: RosterUser } => x.assignee !== null);
    type Cand = { task: ControlTask; assignee: RosterUser; started: boolean; assignKey: string };
    const cands: Cand[] = [];
    const states: StateRow[] = [];
    let quiet = 0;
    const escalations: string[] = [];
    for (const { task, assignee } of assigned) {
      const prev = stored.get(task.taskId);
      const reassigned = Boolean(prev && prev.assignee_email !== assignee.email);
      const acked = !reassigned && Boolean(prev?.ack_at);
      const doneAt = !reassigned && prev?.done_at ? new Date(prev.done_at) : null;
      const job = jobs.get(task.taskId);
      const deadline = task.deadline?.getTime() ?? null;
      states.push({ email: assignee.email, task, state: deriveState(task, acked ? (prev?.ack_at ?? null) : null, job, at, doneAt) });
      if (doneAt || isDelivered(job) || (deadline !== null && deadline < now - STALE_MS)) {
        quiet++;
        continue;
      }
      const started = acked || Boolean(job);
      if (deadline !== null && !started && now >= deadline + ESCALATE_AFTER_MS) {
        const lead = assignee.leadEmail ? roster.find((u) => u.email === assignee.leadEmail && u.active) : undefined;
        for (const t of lead ? [lead] : roster.filter((u) => u.active && u.role === "admin" && u.email !== assignee.email)) escalations.push(`escalate:${task.taskId}:${t.email}`);
      }
      cands.push({ task, assignee, started, assignKey: taskDedupe.slot("assign", task.taskId, assignee.email) });
    }
    const told = await sentKeys(cands.map((c) => c.assignKey));
    const assignNow = cands.filter((c) => !told.has(c.assignKey));
    const plans = cands.flatMap((c) =>
      plannedSlots(
        {
          taskId: c.task.taskId,
          email: c.assignee.email,
          deadline: c.task.deadline?.getTime() ?? null,
          toldAt: told.has(c.assignKey) ? told.get(c.assignKey)! : now,
          started: c.started,
        },
        now,
      ).map((p) => ({ c, p })),
    );
    const sent = await sentKeys([...plans.flatMap(({ p }) => (p.legacyKey ? [p.key, p.legacyKey] : [p.key])), ...escalations]);
    const bySlot = new Map<string, number>();
    const byMentor = new Map<string, number>();
    for (const { c, p } of plans) {
      if (sent.has(p.key) || (p.legacyKey && sent.has(p.legacyKey))) continue;
      tally(bySlot, p.slot);
      tally(byMentor, c.assignee.name);
    }
    const slotTotal = [...bySlot.values()].reduce((a, b) => a + b, 0);
    console.log("\n2. The next tick's task pushes (if it ran now)");
    console.log(`   assigned rows: ${assigned.length}; done / delivered / past (no pushes): ${quiet}; open: ${cands.length} (${cands.filter((c) => c.started).length} started)`);
    console.log(`   assignment pushes not yet sent: ${assignNow.length}; escalations not yet sent: ${escalations.filter((k) => !sent.has(k)).length}`);
    console.log(`   nudge / soon / overdue pushes: ${slotTotal} → by slot ${JSON.stringify(show(bySlot))}; by mentor ${JSON.stringify(show(byMentor))}`);
    const due = digestSlot(now);
    console.log(`   task digest window now: ${due ? `${due.slot} ${due.day}` : "none (09:15–12:00 and 18:00–22:00 IST)"}`);

    // ── 3. What the lists would show ────────────────────────────────────────
    const appRows = await rows<{ target: string; email: string | null }>(
      tx,
      `select distinct on (target) target, case when action = 'task_taken' then actor_email else detail->>'to' end as email
         from app.audit_log where action in ('task_taken', 'task_assigned') and target = any($1::text[]) order by target, at desc`,
      [assigned.map((x) => x.task.taskId)],
    );
    const app = new Map(appRows.filter((r) => r.email).map((r) => [r.target, String(r.email).toLowerCase()]));
    const listed = assigned
      .filter(({ task }) => inHistoryWindow(task, at))
      .map(({ task, assignee }) => {
        const job = jobs.get(task.taskId);
        const s = toSummary(task, assignee, stored.get(task.taskId), job, roster, at, { appAssignee: app.get(task.taskId) });
        return { s, finishedAt: s.doneAt ? Date.parse(s.doneAt) : (deliveredAtOf(job)?.getTime() ?? null) };
      });
    const kept = listed.filter((x) => keepInList(x.s.state, x.finishedAt, at));
    const byState = new Map<string, number>();
    const via = new Map<string, number>();
    for (const x of kept) {
      tally(byState, x.s.state);
      tally(via, x.s.assignedVia);
    }
    const overdueByMentor = new Map<string, number>();
    for (const x of kept.filter((k) => k.s.state === "overdue")) tally(overdueByMentor, x.s.assigneeName ?? "?");
    const unassignedOverdue = open.filter((t) => t.deadline && t.deadline.getTime() <= now).length;
    console.log("\n3. What Mine / Team would show");
    console.log(`   team list: ${kept.length} tasks (${listed.length - kept.length} done / delivered dropped after 7 days) → ${JSON.stringify(show(byState))}`);
    console.log(`   done: ${byState.get("done") ?? 0}; overdue: ${byState.get("overdue") ?? 0} → by mentor ${JSON.stringify(show(overdueByMentor))}`);
    console.log(`   assignedVia: ${JSON.stringify(show(via))}; unassigned list: ${open.length} rows (${unassignedOverdue} past their deadline)`);
    const audience = roster.filter((u) => u.active && openForDigest(states, u.email, now).length > 0);
    console.log(`   task digest audience (active members with open tasks): ${audience.length} → ${JSON.stringify(Object.fromEntries(audience.map((u) => [u.name, openForDigest(states, u.email, now).length])))}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message.slice(0, 300) : err);
  process.exit(1);
});
