/**
 * Self-test for PSM 1.9.0–1.11.0's task logic that needs no network or database:
 *   npx tsx scripts/tasks-selftest.ts
 * Unassigned tasks (the list filter, the ISE → mentor mapping, the task_unassigned push timing,
 * text and recipients), the summary / detail fields, analytics activity counting, prep nudge
 * slots, feedback checks and the inbox text of the new push kinds.
 * 1.11.0: the done state, the list order and the 7-day drop, the nudge / soon / overdue slots with
 * an injected `now`, ISE auto-assign eligibility (grace period, cap), the task digest, device
 * health and shortlistings without double counting. All data here is made up.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import { istClock, openForDigest, plannedSlots, unassignedRecipients, unassignedStages, unassignedText } from "@/lib/mobile/assignments";
import { AUTO_ASSIGN_GRACE_MS, AUTO_ASSIGN_HOLD_MS, autoAssignEnabled, autoAssignPlan, holdsUnassignedPushes } from "@/lib/mobile/auto-assign";
import { buildActivity, countPrepsGiven, countShortlistings, istDays, rowStats, summarize } from "@/lib/mobile/analytics";
import type { ControlTask } from "@/lib/mobile/control-rows";
import { cleanHealth, deviceHealthy } from "@/lib/mobile/device-health";
import { cleanFeedback, feedbackPush } from "@/lib/mobile/feedback";
import { DEFAULT_ISE_OWNERS, iseFirstName, iseOwnerOf, iseOwnersFromEnv, parseIseOwners } from "@/lib/mobile/ise";
import { prepNudge } from "@/lib/mobile/preps/notify";
import type { PrepRow } from "@/lib/mobile/preps/parse";
import { inboxText } from "@/lib/mobile/push";
import type { RosterUser } from "@/lib/mobile/roster";
import { companyList, digestSlot, doneText, iseAssignText, nudgeText, taskDedupe, taskDigestText, taskNudge } from "@/lib/mobile/task-nudges";
import {
  assignedViaOf,
  byDeadline,
  canMarkDone,
  deliveredAtOf,
  deriveState,
  doneAtFor,
  isUnassigned,
  isUnassignedOpen,
  keepInList,
  listGroup,
  oneAtATime,
  orderTasks,
  toDetail,
  toSummary,
  type AssignmentRow,
  type TaskState,
} from "@/lib/mobile/tasks";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const H = 3_600_000;
const M = 60_000;
const NOW = Date.parse("2026-11-26T08:00:00Z"); // 13:30 IST
const at = (offsetMs: number) => new Date(NOW + offsetMs);

function task(p: Partial<ControlTask> = {}): ControlTask {
  return {
    taskId: "a".repeat(24),
    row: 10,
    company: "Acme Widgets",
    product: "Edge",
    pc: "",
    crm: "",
    techStack: "React",
    hubspotUrl: "",
    remarks: "",
    internalSheetUrl: "",
    jdUrl: "",
    openings: "1",
    profilesRequired: 10,
    mechanism: "",
    mentor: "",
    assignedAt: at(-H),
    deadline: at(3 * H),
    deadlineInferred: false,
    trigger: "",
    automationStatus: "",
    automationDetails: "",
    ...p,
  };
}

const user = (email: string, name: string, role: RosterUser["role"] = "member", active = true): RosterUser => ({
  email,
  name,
  aliases: [],
  role,
  active,
  leadEmail: null,
});
// Mentor first names the default mapping uses, with made-up addresses.
const roster: RosterUser[] = [
  user("admin.one@example.com", "Adminya", "admin"),
  user("lead.one@example.com", "Leadra", "lead"),
  user("m.gaurav@example.com", "Gaurav"),
  user("m.rakesh@example.com", "Rakesh"),
  user("m.faraaz@example.com", "Faraaz"),
  user("m.gone@example.com", "Oldname", "member", false),
];

// ── The unassigned list ─────────────────────────────────────────────────────

test("unassigned filter: blank Mentor, a company, assigned in the last 7 days (or no date), deadline at most 24 h ago (or none)", () => {
  const now = new Date(NOW);
  assert.equal(isUnassignedOpen(task(), now), true);
  assert.equal(isUnassignedOpen(task({ mentor: "  " }), now), true); // whitespace is blank
  assert.equal(isUnassignedOpen(task({ mentor: "Gaurav" }), now), false);
  assert.equal(isUnassignedOpen(task({ mentor: "Someone not on the roster" }), now), false); // a name still counts as assigned
  assert.equal(isUnassignedOpen(task({ company: " " }), now), false);
  assert.equal(isUnassignedOpen(task({ assignedAt: at(-7 * 24 * H + M) }), now), true);
  assert.equal(isUnassignedOpen(task({ assignedAt: at(-7 * 24 * H - M) }), now), false);
  assert.equal(isUnassignedOpen(task({ assignedAt: null }), now), true);
  assert.equal(isUnassignedOpen(task({ deadline: at(-24 * H + M) }), now), true);
  assert.equal(isUnassignedOpen(task({ deadline: at(-24 * H - M) }), now), false);
  assert.equal(isUnassignedOpen(task({ deadline: null, assignedAt: null }), now), true);
  assert.equal(isUnassigned(task({ mentor: "" })), true);
});

test("unassigned list order: soonest deadline first, no deadline last", () => {
  const rows = [
    task({ row: 1, deadline: null }),
    task({ row: 2, deadline: at(5 * H) }),
    task({ row: 3, deadline: at(-2 * H) }),
    task({ row: 4, deadline: at(5 * H) }),
    task({ row: 5, deadline: null }),
  ];
  assert.deepEqual([...rows].sort(byDeadline).map((t) => t.row), [3, 2, 4, 1, 5]);
});

// ── ISE → mentor ────────────────────────────────────────────────────────────

test("ISE → mentor: first word of the PC cell, case-insensitive, matched to the roster", () => {
  const owners = parseIseOwners(DEFAULT_ISE_OWNERS);
  assert.equal(iseFirstName("  SNEHA  Q. "), "sneha");
  assert.equal(iseOwnerOf("Sneha Q", roster, owners)?.email, "m.gaurav@example.com");
  assert.equal(iseOwnerOf("akanksha", roster, owners)?.name, "Rakesh");
  assert.equal(iseOwnerOf("VISHAAL", roster, owners)?.name, "Faraaz");
  assert.equal(iseOwnerOf("Vishal R", roster, owners)?.name, "Faraaz");
  assert.equal(iseOwnerOf("Snehal", roster, owners), null); // whole first word, not a prefix
  assert.equal(iseOwnerOf("", roster, owners), null);
  assert.equal(iseOwnerOf("Unknown Person", roster, owners), null);
  // The mentor left the roster (inactive): no owner.
  assert.equal(iseOwnerOf("sneha", roster.map((u) => (u.name === "Gaurav" ? { ...u, active: false } : u)), owners), null);
});

test("ISE → mentor: MOBILE_ISE_OWNERS replaces the default; an unreadable value falls back to it", () => {
  const custom = iseOwnersFromEnv("asha=Rakesh; bala|balu = Faraaz ;broken;=x");
  assert.deepEqual([...custom.entries()].sort(), [["asha", "Rakesh"], ["bala", "Faraaz"], ["balu", "Faraaz"]]);
  assert.equal(iseOwnerOf("Balu M", roster, custom)?.email, "m.faraaz@example.com");
  assert.equal(iseOwnerOf("Sneha Q", roster, custom), null); // the default is replaced, not merged
  assert.equal(iseOwnersFromEnv("").get("sneha"), "Gaurav");
  assert.equal(iseOwnersFromEnv(undefined).get("vishal"), "Faraaz");
  assert.equal(iseOwnersFromEnv("nonsense").get("akanksha"), "Rakesh");
  const saved = process.env.MOBILE_ISE_OWNERS;
  process.env.MOBILE_ISE_OWNERS = "kavya=Gaurav";
  try {
    assert.equal(iseOwnerOf("Kavya", roster)?.name, "Gaurav"); // read from the environment by default
    assert.equal(iseOwnerOf("Sneha", roster), null);
  } finally {
    if (saved === undefined) delete process.env.MOBILE_ISE_OWNERS;
    else process.env.MOBILE_ISE_OWNERS = saved;
  }
});

// ── task_unassigned pushes ──────────────────────────────────────────────────

test("unassigned push timing: new (assigned ≤ 6 h ago, before the deadline), half, soon (30 min), due", () => {
  // Assigned 08:00Z, deadline 12:00Z: half at 10:00Z, soon from 11:30Z, due from 12:00Z.
  const t = task({ assignedAt: new Date("2026-11-26T08:00:00Z"), deadline: new Date("2026-11-26T12:00:00Z") });
  const s = (iso: string) => unassignedStages(t, Date.parse(iso));
  assert.deepEqual(s("2026-11-26T08:01:00Z"), ["new"]);
  assert.deepEqual(s("2026-11-26T09:59:00Z"), ["new"]);
  assert.deepEqual(s("2026-11-26T10:00:00Z"), ["new", "half"]);
  assert.deepEqual(s("2026-11-26T11:30:00Z"), ["new", "soon"]);
  assert.deepEqual(s("2026-11-26T11:59:59Z"), ["new", "soon"]);
  assert.deepEqual(s("2026-11-26T12:00:00Z"), ["due"]); // the deadline passed: no more "new"
  assert.deepEqual(s("2026-11-27T11:59:00Z"), ["due"]);
  assert.deepEqual(s("2026-11-27T12:01:00Z"), []); // more than a day past: history
  // The first sync after a deploy: a row assigned 7 hours ago gets no "new" (only its reminder).
  const old = task({ assignedAt: at(-7 * H), deadline: at(5 * H) });
  assert.deepEqual(unassignedStages(old, NOW), ["half"]);
  // First seen with 20 minutes left: "soon", never also "half".
  assert.deepEqual(unassignedStages(task({ assignedAt: at(-M), deadline: at(20 * M) }), NOW), ["new", "soon"]);
  // No deadline: only "new". No assigned date: never "new" or "half".
  assert.deepEqual(unassignedStages(task({ assignedAt: at(-H), deadline: null }), NOW), ["new"]);
  assert.deepEqual(unassignedStages(task({ assignedAt: null, deadline: at(5 * H) }), NOW), []);
  assert.deepEqual(unassignedStages(task({ assignedAt: null, deadline: at(10 * M) }), NOW), ["soon"]);
});

test("unassigned push text: the contract's titles and bodies, IST times", () => {
  const t = task({ company: "Acme", pc: "Sneha Q", profilesRequired: 10, deadline: new Date("2026-11-26T12:30:00Z") }); // 6:00 PM IST
  const now = Date.parse("2026-11-26T06:00:00Z");
  assert.deepEqual(unassignedText("new", t, now), { title: "New task · Acme (ISE Sneha Q)", body: "10 profiles by 6:00 PM · no mentor yet. Tap to take it." });
  assert.deepEqual(unassignedText("half", t, now), { title: "Still no mentor · Acme", body: "Sneha Q's task · due 6:00 PM. Take it or assign someone." });
  assert.deepEqual(unassignedText("soon", t, now), unassignedText("half", t, now));
  assert.deepEqual(unassignedText("due", t, now), { title: "Deadline passed · Acme", body: "Nobody took Sneha Q's task." });
  const bare = task({ company: "Acme", pc: "", profilesRequired: 1, deadline: null });
  assert.deepEqual(unassignedText("new", bare, now), { title: "New task · Acme", body: "1 profile · no mentor yet. Tap to take it." });
  assert.equal(unassignedText("due", bare, now).body, "Nobody took this task.");
  assert.equal(istClock(new Date("2026-11-27T04:15:00Z"), now), "27 Nov, 9:45 AM"); // another IST day
  assert.equal(istClock(new Date("2026-11-26T18:29:00Z"), now), "11:59 PM");
  assert.equal(istClock(new Date("2026-11-26T06:30:00Z"), now), "12:00 PM");
});

test("unassigned push recipients: new → everyone active; reminders and due → the ISE's mentor and the admins", () => {
  const gaurav = roster.find((u) => u.name === "Gaurav")!;
  assert.deepEqual(unassignedRecipients("new", gaurav, roster).map((u) => u.name), ["Adminya", "Leadra", "Gaurav", "Rakesh", "Faraaz"]);
  assert.deepEqual(unassignedRecipients("half", gaurav, roster).map((u) => u.name), ["Gaurav", "Adminya"]);
  assert.deepEqual(unassignedRecipients("due", null, roster).map((u) => u.name), ["Adminya"]);
  const adminOwner = roster.find((u) => u.role === "admin")!;
  assert.deepEqual(unassignedRecipients("soon", adminOwner, roster).map((u) => u.name), ["Adminya"]); // once, not twice
});

// ── Summary and detail fields ───────────────────────────────────────────────

test("TaskSummary: unassigned rows are new / overdue with assigneeName, ise, product and iseOwner", () => {
  const now = new Date(NOW);
  const s = toSummary(task({ pc: "Akanksha", product: "Edge , Academy" }), null, undefined, undefined, roster, now);
  assert.equal(s.state, "new");
  assert.equal(s.assignee, null);
  assert.equal(s.assigneeName, null);
  assert.equal(s.ise, "Akanksha");
  assert.equal(s.product, "Edge , Academy");
  assert.deepEqual(s.iseOwner, { email: "m.rakesh@example.com", name: "Rakesh" });
  // A running job doesn't make an unassigned row "screening".
  const job = { id: "j", status: "processing" } as never;
  assert.equal(toSummary(task({ deadline: at(-M) }), null, undefined, job, roster, now).state, "overdue");
  assert.equal(toSummary(task({ pc: "" }), null, undefined, undefined, roster, now).iseOwner, null);
  const faraaz = roster.find((u) => u.name === "Faraaz")!;
  const mine = toSummary(task({ mentor: "Faraaz" }), faraaz, undefined, undefined, roster, now);
  assert.equal(mine.assigneeName, "Faraaz");
  assert.equal(mine.assignee, "m.faraaz@example.com");
  assert.equal(mine.state, "new");
  // Every field is present, even when unknown.
  for (const k of ["assigneeName", "ise", "product", "iseOwner"]) assert.ok(k in s, k);
});

test("TaskDetail: canTake when the Mentor cell is blank; canAssign for admins and leads", () => {
  const d = (t: ControlTask, role: RosterUser["role"]) => toDetail(t, null, undefined, undefined, "https://x/edit#gid=0", roster, { role });
  assert.equal(d(task(), "member").canTake, true);
  assert.equal(d(task(), "member").canAssign, false);
  assert.equal(d(task(), "lead").canAssign, true);
  assert.equal(d(task(), "admin").canAssign, true);
  assert.equal(d(task({ mentor: "Gaurav" }), "admin").canTake, false);
  assert.equal(d(task(), "member").sheetRowUrl, "https://x/edit#gid=0&range=A10");
});

// ── Analytics activity ──────────────────────────────────────────────────────

test("activity: shortlistings count deliveries inside the range only", () => {
  const range = { from: new Date("2026-11-01T00:00:00+05:30"), to: new Date("2026-11-08T00:00:00+05:30") };
  const n = countShortlistings(
    [
      { assigneeEmail: "a@example.com", deliveredAt: new Date("2026-11-03T10:00:00+05:30") },
      { assigneeEmail: "a@example.com", deliveredAt: new Date("2026-11-07T23:59:00+05:30") },
      { assigneeEmail: "a@example.com", deliveredAt: new Date("2026-11-08T00:00:00+05:30") }, // the range end is exclusive
      { assigneeEmail: "a@example.com", deliveredAt: null }, // not delivered
      { assigneeEmail: "b@example.com", deliveredAt: new Date("2026-10-31T23:00:00+05:30") }, // before
      { assigneeEmail: null, deliveredAt: new Date("2026-11-03T10:00:00+05:30") },
    ],
    range,
  );
  assert.equal(n.get("a@example.com"), 2);
  assert.equal(n.get("b@example.com"), undefined);
});

test('activity: preps given need "Prep Given" done and the interview day in the range; both mentors count', () => {
  const range = { from: new Date("2026-11-01T00:00:00+05:30"), to: new Date("2026-11-08T00:00:00+05:30") };
  assert.deepEqual(istDays(range), { first: "2026-11-01", last: "2026-11-07" });
  const p = (prepStatus: PrepRow["prepStatus"], prepBy: string[], interviewDay: string | null) => ({ prepStatus, prepBy, interviewDay });
  const n = countPrepsGiven(
    [
      p("done", ["GAURAV"], "2026-11-01"),
      p("done", ["Gaurav", "Rakesh"], "2026-11-07"),
      p("pending", ["Gaurav"], "2026-11-03"), // only the name is filled: not given
      p("missed", ["Rakesh"], "2026-11-03"),
      p("done", ["Rakesh"], "2026-11-08"), // after the range
      p("done", ["Faraaz"], null),
      p("done", ["Not On Roster"], "2026-11-02"),
    ],
    roster,
    range,
  );
  assert.equal(n.get("m.gaurav@example.com"), 2);
  assert.equal(n.get("m.rakesh@example.com"), 1);
  assert.equal(n.get("m.faraaz@example.com"), undefined);
});

test("activity: one row per member, non-negative integers, most active first", () => {
  const members = [
    { email: "x@example.com", name: "Xena" },
    { email: "y@example.com", name: "Yuri" },
    { email: "z@example.com", name: "Zara" },
    { email: "x@example.com", name: "Xena" },
  ];
  const rows = buildActivity(members, {
    shortlistings: new Map([["y@example.com", 2]]),
    prepCalls: new Map([["y@example.com", 1], ["z@example.com", 5], ["q@example.com", 9]]),
    rsas: new Map([["x@example.com", -3]]),
    mockInterviews: new Map([["z@example.com", 1.7]]),
  });
  assert.deepEqual(rows.map((r) => r.name), ["Zara", "Yuri", "Xena"]);
  assert.deepEqual(rows[0], { email: "z@example.com", name: "Zara", shortlistings: 0, prepsGiven: 0, prepCalls: 5, rsas: 0, guidanceMeets: 0, mockInterviews: 1 });
  assert.equal(rows[2].rsas, 0);
  assert.equal(rows.length, 3);
});

// ── Prep nudges ─────────────────────────────────────────────────────────────

test("prep nudges: 3 h / 1 h / 15 min reminders, each only if assigned before that moment", () => {
  const due = NOW;
  const longAgo = due - 24 * H;
  const r = (before: number, assigned: number | null = longAgo) => prepNudge(due - before, due, assigned, due + 5 * H).reminder;
  assert.equal(r(3 * H + M), null);
  assert.equal(r(3 * H), "soon3h");
  assert.equal(r(61 * M), "soon3h");
  assert.equal(r(60 * M), "soon1h");
  assert.equal(r(16 * M), "soon1h");
  assert.equal(r(15 * M), "soon");
  assert.equal(r(1000), "soon");
  // Assigned 2 h before the deadline: no 3 h reminder; the 1 h and 15 min ones still come.
  assert.equal(r(2 * H - M, due - 2 * H), null);
  assert.equal(r(50 * M, due - 2 * H), "soon1h");
  // Assigned 10 minutes before the deadline: no reminder at all (the assignment push says it).
  assert.equal(r(5 * M, due - 10 * M), null);
  assert.equal(r(5 * M, null), "soon");
  assert.equal(prepNudge(due - 5 * M, due, longAgo, null).overdueSlot, null);
});

test("prep nudges: overdue at the deadline, then every 2 h until the interview, at most 4", () => {
  const due = NOW;
  const o = (after: number, start: number | null = due + 24 * H) => prepNudge(due + after, due, due - H, start).overdueSlot;
  assert.equal(o(0), 0);
  assert.equal(o(2 * H - M), 0);
  assert.equal(o(2 * H), 1);
  assert.equal(o(4 * H), 2);
  assert.equal(o(6 * H), 3);
  assert.equal(o(8 * H), 3); // capped: four in total (slots 0–3)
  assert.equal(o(20 * H), 3);
  assert.equal(o(3 * H, due + 3 * H), null); // the interview has started
  assert.equal(o(3 * H, due + 3 * H + M), 1);
  assert.equal(o(5 * H, null), 2); // no interview time known: still every 2 h, at most 4
  assert.equal(prepNudge(due + M, due, due - H, due + H).reminder, null);
});

// ── Feedback and push kinds ─────────────────────────────────────────────────

test("feedback: categories, trimmed 1–2000 character messages, optional fields clipped", () => {
  const f = cleanFeedback({ category: "Problem", message: "  The list\r\nis empty  ", screen: " Tasks ", appVersion: "1.9.0", device: 42 });
  assert.deepEqual(f, { category: "problem", message: "The list\nis empty", screen: "Tasks", appVersion: "1.9.0", device: null });
  const code = (body: unknown) => {
    try {
      cleanFeedback(body);
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  assert.equal(code({ category: "bug", message: "x" }), "invalid_category");
  assert.equal(code({ category: "idea", message: "   " }), "no_message");
  assert.equal(code({ category: "idea" }), "no_message");
  assert.equal(code(null), "invalid_category");
  assert.equal(code({ category: "other", message: "x".repeat(2000) }), "ok");
  assert.equal(code({ category: "other", message: "x".repeat(2001) }), "too_long");
  const push = feedbackPush("id-1", "Xena", { category: "idea", message: `${"word ".repeat(100)}\n\nend` });
  assert.equal(push.title, "Feedback from Xena · Idea");
  assert.equal(push.body.length, 300);
  assert.equal(push.feedbackId, "id-1");
  assert.equal(push.from, "Xena");
  assert.equal(push.category, "idea");
});

test("push kinds task_unassigned and feedback have inbox text; their own title / body wins", () => {
  assert.equal(inboxText("task_unassigned", { company: "Acme" }).title, "New task · Acme");
  assert.equal(inboxText("feedback", { from: "Xena" }).title, "Feedback from Xena");
  assert.deepEqual(inboxText("task_unassigned", { title: "Still no mentor · Acme", body: "b" }), { title: "Still no mentor · Acme", body: "b" });
});

// ── 1.11.0: Shortlisting done ───────────────────────────────────────────────

const D = 86_400_000;
const mkJob = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: "j1", status, createdAt: "2026-11-26T06:00:00Z", updatedAt: "2026-11-26T07:00:00Z", finishedAt: null, progress: {}, result: null, ...extra }) as never;
const person = (name: string) => roster.find((u) => u.name === name)!;
const arow = (p: Partial<AssignmentRow> = {}): AssignmentRow => ({
  task_id: "t",
  ack_at: null,
  ack_by: null,
  assignee_email: "m.gaurav@example.com",
  job_id: null,
  done_at: null,
  done_by: null,
  auto_assigned: false,
  auto_assigned_at: null,
  ...p,
});

test("deriveState: done wins over every other state; done and delivered tasks are never overdue", () => {
  const now = new Date(NOW);
  const late = task({ mentor: "Gaurav", deadline: at(-H) });
  assert.equal(deriveState(late, null, undefined, now), "overdue");
  assert.equal(deriveState(late, null, undefined, now, at(-30 * M)), "done");
  assert.equal(deriveState(late, at(-2 * H).toISOString(), mkJob("processing"), now, at(-M).toISOString()), "done");
  assert.equal(deriveState(task({ mentor: "Gaurav" }), null, mkJob("completed"), now, at(-M)), "done");
  assert.equal(deriveState(task({ mentor: "Gaurav" }), null, mkJob("completed"), now), "shortlist_ready"); // delivered still shows as delivered
  assert.equal(deriveState(late, null, mkJob("awaiting_review"), now), "shortlist_ready");
  assert.equal(deriveState(late, null, mkJob("failed"), now), "overdue");
  assert.equal(deriveState(task({ mentor: "Gaurav" }), null, undefined, now, null), "new");
});

test("done mark: only for the person the row is assigned to now; leads / admins may mark a row nobody has", () => {
  const doneAt = "2026-11-26T07:00:00Z";
  assert.equal(doneAtFor(arow({ done_at: doneAt }), "m.gaurav@example.com")?.toISOString(), "2026-11-26T07:00:00.000Z");
  assert.equal(doneAtFor(arow({ done_at: doneAt }), "m.rakesh@example.com"), null); // reassigned since
  assert.equal(doneAtFor(arow({ assignee_email: null, done_at: doneAt }), null)?.getTime(), Date.parse(doneAt));
  assert.equal(doneAtFor(arow({ assignee_email: null, done_at: doneAt }), "m.gaurav@example.com"), null);
  assert.equal(doneAtFor(arow(), "m.gaurav@example.com"), null);
  assert.equal(doneAtFor(undefined, null), null);
  // Before migration 021 the row has no done_at at all.
  assert.equal(doneAtFor({ assignee_email: "m.gaurav@example.com" } as AssignmentRow, "m.gaurav@example.com"), null);
  assert.equal(canMarkDone(person("Gaurav"), person("Gaurav")), true);
  assert.equal(canMarkDone(person("Rakesh"), person("Gaurav")), false);
  assert.equal(canMarkDone(person("Leadra"), person("Gaurav")), true);
  assert.equal(canMarkDone(person("Adminya"), null), true);
  assert.equal(canMarkDone(person("Gaurav"), null), false);
});

test("TaskSummary 1.11.0: doneAt, doneBy (a name), autoAssigned and assignedVia (sheet / ise / app)", () => {
  const now = new Date(NOW);
  const gaurav = person("Gaurav");
  const t = task({ mentor: "Gaurav", pc: "Sneha Q", deadline: at(-H) });
  const done = toSummary(t, gaurav, arow({ done_at: at(-10 * M).toISOString(), done_by: "lead.one@example.com" }), undefined, roster, now);
  assert.equal(done.state, "done");
  assert.equal(done.doneAt, at(-10 * M).toISOString());
  assert.equal(done.doneBy, "Leadra");
  assert.equal(toSummary(t, gaurav, arow({ done_at: at(-M).toISOString(), done_by: "gone.person@example.com" }), undefined, roster, now).doneBy, "gone.person");
  const open = toSummary(t, gaurav, arow(), undefined, roster, now);
  assert.equal(open.state, "overdue");
  assert.equal(open.doneAt, null);
  assert.equal(open.doneBy, null);
  assert.equal(open.assignedVia, "sheet");
  assert.equal(open.autoAssigned, false);
  const ise = toSummary(t, gaurav, arow({ auto_assigned: true }), undefined, roster, now);
  assert.equal(ise.assignedVia, "ise");
  assert.equal(ise.autoAssigned, true);
  assert.equal(toSummary(t, gaurav, arow(), undefined, roster, now, { appAssignee: gaurav.email }).assignedVia, "app");
  // Marks left for someone else (the row moved to Gaurav since) don't count.
  const moved = toSummary(t, gaurav, arow({ assignee_email: "m.rakesh@example.com", auto_assigned: true, done_at: at(-M).toISOString() }), undefined, roster, now);
  assert.equal(moved.state, "overdue");
  assert.equal(moved.assignedVia, "sheet");
  assert.equal(assignedViaOf(arow({ assignee_email: "m.rakesh@example.com" }), gaurav.email, "m.rakesh@example.com"), "sheet");
  assert.equal(assignedViaOf(arow({ auto_assigned: true }), gaurav.email, gaurav.email), "ise");
  assert.equal(assignedViaOf(undefined, null, null), "sheet");
  // A row nobody has, marked done by an admin.
  const blank = toSummary(task({ deadline: at(-H) }), null, arow({ assignee_email: null, done_at: at(-M).toISOString(), done_by: "admin.one@example.com" }), undefined, roster, now);
  assert.equal(blank.state, "done");
  assert.equal(blank.doneBy, "Adminya");
  for (const k of ["doneAt", "doneBy", "autoAssigned", "assignedVia"]) assert.ok(k in open, k);
  assert.equal(toDetail(t, gaurav, arow({ auto_assigned: true }), undefined, "https://x/edit#gid=0", roster, { role: "member" }).assignedVia, "ise");
});

test("Mine order: overdue, due today, upcoming, no deadline, then done / delivered (newest first)", () => {
  const now = new Date(NOW); // 13:30 IST, 26 Nov
  const s = (id: string, state: TaskState, deadline: Date | null, assignedAt: Date | null = at(-H)) => ({
    id,
    state,
    deadline: deadline?.toISOString() ?? null,
    assignedAt: assignedAt?.toISOString() ?? null,
  });
  const items = [
    { summary: s("done-3d", "done", at(H)), finishedAt: NOW - 3 * D },
    { summary: s("nodl-old", "new", null, at(-5 * H)), finishedAt: null },
    { summary: s("tomorrow", "acknowledged", new Date("2026-11-27T04:00:00Z")), finishedAt: null }, // 9:30 AM IST tomorrow
    { summary: s("tonight", "new", new Date("2026-11-26T18:00:00Z")), finishedAt: null }, // 11:30 PM IST today
    { summary: s("late-5h", "overdue", at(-5 * H)), finishedAt: null },
    { summary: s("delivered-1h", "shortlist_ready", at(-2 * H)), finishedAt: NOW - H },
    { summary: s("soon", "screening", at(30 * M)), finishedAt: null },
    { summary: s("late-1h", "overdue", at(-H)), finishedAt: null },
    { summary: s("nodl-new", "new", null, at(-M)), finishedAt: null },
    { summary: s("done-1d", "done", null), finishedAt: NOW - D },
  ];
  assert.deepEqual(
    orderTasks(items, now).map((x) => x.id),
    ["late-5h", "late-1h", "soon", "tonight", "tomorrow", "nodl-new", "nodl-old", "delivered-1h", "done-1d", "done-3d"],
  );
  assert.equal(listGroup({ state: "new", deadline: "2026-11-26T18:29:00Z" }, now), 1); // 11:59 PM IST: today
  assert.equal(listGroup({ state: "new", deadline: "2026-11-26T18:31:00Z" }, now), 2); // 12:01 AM IST: tomorrow
  assert.equal(listGroup({ state: "shared", deadline: null }, now), 4);
  assert.equal(listGroup({ state: "acknowledged", deadline: at(-M).toISOString() }, now), 0);
});

test("done and delivered tasks stay listed for 7 days after they were finished, then drop off", () => {
  const now = new Date(NOW);
  assert.equal(keepInList("done", NOW - 7 * D + M, now), true);
  assert.equal(keepInList("done", NOW - 7 * D - M, now), false);
  assert.equal(keepInList("shortlist_ready", NOW - 8 * D, now), false);
  assert.equal(keepInList("shortlist_ready", NOW - D, now), true);
  assert.equal(keepInList("overdue", NOW - 30 * D, now), true); // open tasks: the 45-day window still decides
  assert.equal(keepInList("new", null, now), true);
  assert.equal(deliveredAtOf(mkJob("completed", { finishedAt: "2026-11-20T10:00:00Z" }))?.toISOString(), "2026-11-20T10:00:00.000Z");
  assert.equal(deliveredAtOf(mkJob("awaiting_review"))?.toISOString(), "2026-11-26T07:00:00.000Z"); // no end time: its last update
  assert.equal(deliveredAtOf(mkJob("processing", { progress: { shortlistUrl: "https://x" } })), null);
  assert.equal(deliveredAtOf(undefined), null);
});

// ── 1.11.0: nudge / soon / overdue slots ────────────────────────────────────

test("task slots: nudge:30 and nudge:90 while not started; never past the deadline, never 6 h after", () => {
  const told = NOW;
  const n = (after: number, p: Partial<Parameters<typeof taskNudge>[0]> = {}) =>
    taskNudge({ now: told + after, deadline: told + 24 * H, toldAt: told, started: false, finished: false, ...p }).nudge;
  assert.equal(n(29 * M), null);
  assert.equal(n(30 * M), "nudge:30");
  assert.equal(n(89 * M), "nudge:30");
  assert.equal(n(90 * M), "nudge:90");
  assert.equal(n(6 * H - M), "nudge:90");
  assert.equal(n(6 * H), null);
  assert.equal(n(45 * M, { started: true }), null);
  assert.equal(n(45 * M, { toldAt: null }), null);
  assert.equal(n(45 * M, { deadline: told + 40 * M }), null); // past the deadline: overdue takes over
  assert.equal(n(45 * M, { deadline: null }), "nudge:30");
});

test("task slots: soon1h and soon15 before the deadline, each only when told before that moment", () => {
  const due = NOW;
  const r = (before: number, toldAt: number | null = due - 24 * H, started = true) => taskNudge({ now: due - before, deadline: due, toldAt, started, finished: false }).reminder;
  assert.equal(r(61 * M), null);
  assert.equal(r(60 * M), "soon1h");
  assert.equal(r(16 * M), "soon1h");
  assert.equal(r(15 * M), "soon15");
  assert.equal(r(1000), "soon15");
  assert.equal(r(50 * M, due - 51 * M), null); // told 51 min before: the 1 h moment had passed
  assert.equal(r(10 * M, due - 51 * M), "soon15");
  assert.equal(r(5 * M, due - 10 * M), null); // told 10 min before: the assignment push said it
  assert.equal(r(5 * M, null), "soon15");
  assert.equal(r(30 * M, due - 24 * H, false), "soon1h"); // started or not
});

test("task slots: overdue at the deadline, then every 2 h, at most 4, nothing a day later", () => {
  const due = NOW;
  const o = (after: number, started = true) => taskNudge({ now: due + after, deadline: due, toldAt: due - H, started, finished: false }).overdueSlot;
  assert.equal(o(-1), null);
  assert.equal(o(0), 0);
  assert.equal(o(2 * H - M), 0);
  assert.equal(o(2 * H), 1);
  assert.equal(o(4 * H), 2);
  assert.equal(o(6 * H), 3);
  assert.equal(o(10 * H), 3);
  assert.equal(o(24 * H), 3);
  assert.equal(o(24 * H + M), null);
  assert.equal(o(H, false), 0);
});

test("task slots: done and delivered tasks skip everything", () => {
  for (const now of [NOW - 50 * M, NOW - 10 * M, NOW + M, NOW + 3 * H]) {
    assert.deepEqual(taskNudge({ now, deadline: NOW, toldAt: NOW - 2 * H, started: false, finished: true }), { nudge: null, reminder: null, overdueSlot: null });
  }
});

test("task slots: dedupe keys, the 1.10 keys standing for soon15 / overdue:0, at most 8 per task, texts", () => {
  const id = "c".repeat(24);
  const c = { taskId: id, email: "m.gaurav@example.com", deadline: NOW, toldAt: NOW - 3 * H, started: false };
  assert.deepEqual(plannedSlots(c, NOW - 10 * M), [
    { kind: "reminder", slot: "nudge:90", key: `nudge:90:${id}:m.gaurav@example.com`, legacyKey: null },
    { kind: "reminder", slot: "soon15", key: `soon15:${id}:m.gaurav@example.com`, legacyKey: `soon:${id}:m.gaurav@example.com` },
  ]);
  assert.deepEqual(plannedSlots(c, NOW + M).map((p) => [p.kind, p.slot, p.legacyKey]), [["overdue", "overdue:0", `overdue:${id}:m.gaurav@example.com`]]);
  assert.deepEqual(plannedSlots(c, NOW + 3 * H).map((p) => [p.key, p.legacyKey]), [[`overdue:1:${id}:m.gaurav@example.com`, null]]);
  assert.deepEqual(plannedSlots({ ...c, started: true }, NOW - 2 * H), []);
  // Every minute for 36 hours: 2 nudges + 2 soon + 4 overdue keys, never more.
  const keys = new Set<string>();
  for (let t = NOW - 6 * H; t <= NOW + 30 * H; t += M) for (const p of plannedSlots({ ...c, toldAt: NOW - 6 * H }, t)) keys.add(p.key);
  assert.equal(keys.size, 8);
  const tk = { company: "Acme", profilesRequired: 10, deadline: new Date("2026-11-26T12:30:00Z") }; // 6:00 PM IST
  const now = Date.parse("2026-11-26T11:30:00Z");
  assert.deepEqual(nudgeText("nudge:30", tk, now), { title: "Not started · Acme", body: "Assigned to you 30 min ago · due 6:00 PM. Tap Start now." });
  assert.equal(nudgeText("nudge:90", tk, now).title, "Still not started · Acme");
  assert.deepEqual(nudgeText("soon1h", tk, now), { title: "Due in 1 hour · Acme", body: "10 profiles by 6:00 PM. Mark done when the shortlist is shared." });
  assert.equal(nudgeText("soon15", tk, now).title, "Due in 15 minutes · Acme");
  assert.deepEqual(nudgeText("overdue:0", tk, now), { title: "Overdue · Acme", body: "The deadline (6:00 PM) has passed. Mark done when the shortlist is shared." });
  assert.equal(nudgeText("overdue:2", tk, now).body, "4 h past the deadline (6:00 PM). Mark done when the shortlist is shared.");
  assert.deepEqual(iseAssignText("Acme", "Sneha Q"), { title: "New task · Acme", body: "Assigned to you as Sneha Q's mentor (ISE)" });
  assert.deepEqual(doneText("Rakesh", "Acme", new Date("2026-11-26T11:00:00Z"), "Sneha Q", now), {
    title: "Rakesh finished Acme's shortlisting",
    body: "Marked done at 4:30 PM · ISE Sneha Q.",
  });
  assert.equal(taskDedupe.done(id, new Date(1_000), "a@example.com"), `done:${id}:1000:a@example.com`);
});

// ── 1.11.0: automatic assignment by ISE ─────────────────────────────────────

test("ISE auto-assign: blank Mentor + an ISE that maps to an active mentor, 5 min after the later of assigned and first seen", () => {
  const owners = parseIseOwners(DEFAULT_ISE_OWNERS);
  const id = (n: number) => String(n).repeat(24);
  const rows = [
    task({ taskId: id(1), row: 1, pc: "Sneha Q", assignedAt: at(-10 * M), deadline: at(3 * H) }),
    task({ taskId: id(2), row: 2, pc: "Akanksha", assignedAt: at(-2 * M), deadline: at(2 * H) }), // inside the grace period
    task({ taskId: id(3), row: 3, pc: "Unknown Person", assignedAt: at(-H) }), // no mapping: today's unassigned flow
    task({ taskId: id(4), row: 4, pc: "Vishaal", mentor: "Faraaz", assignedAt: at(-H) }), // a PC filled it in
    task({ taskId: id(5), row: 5, pc: "Vishaal", assignedAt: at(-8 * D) }), // not open: assigned 8 days ago
    task({ taskId: id(6), row: 6, pc: "Vishaal", assignedAt: null, deadline: null }), // no assigned date: first seen decides
    task({ taskId: id(7), row: 7, pc: "Sneha", assignedAt: at(-H) }), // auto-assigned once before
  ];
  const firstSeen = new Map([
    [`${id(1)}|m.gaurav@example.com`, NOW - 20 * M],
    [`${id(6)}|m.faraaz@example.com`, NOW - 4 * M],
  ]);
  const plan = autoAssignPlan(rows, roster, NOW, { firstSeen, skip: new Set([id(7)]), owners });
  assert.deepEqual(plan.write.map((c) => [c.task.row, c.owner.name]), [[1, "Gaurav"]]);
  assert.deepEqual(plan.waiting.map((c) => [c.task.row, c.owner.name]), [[2, "Rakesh"], [6, "Faraaz"]]);
  assert.deepEqual(plan.deferred, []);
  assert.equal(plan.keys.length, 3);
  // First seen after the assigned time: the grace period counts from first seen; unseen = now.
  const one = [task({ pc: "Sneha", assignedAt: at(-H) })];
  const key = `${"a".repeat(24)}|m.gaurav@example.com`;
  assert.equal(autoAssignPlan(one, roster, NOW, { firstSeen: new Map([[key, NOW - 4 * M]]), skip: new Set(), owners }).write.length, 0);
  assert.equal(autoAssignPlan(one, roster, NOW, { firstSeen: new Map([[key, NOW - AUTO_ASSIGN_GRACE_MS]]), skip: new Set(), owners }).write.length, 1);
  const unseen = autoAssignPlan(one, roster, NOW, { firstSeen: new Map(), skip: new Set(), owners });
  assert.equal(unseen.write.length, 0);
  assert.deepEqual(unseen.keys, [key]);
  // An assigned time in the future: wait for it.
  assert.equal(autoAssignPlan([task({ pc: "Sneha", assignedAt: at(H) })], roster, NOW, { firstSeen: new Map([[key, NOW - H]]), skip: new Set(), owners }).write.length, 0);
  // The mapped mentor is inactive: nobody (today's unassigned flow).
  const noGaurav = roster.map((u) => (u.name === "Gaurav" ? { ...u, active: false } : u));
  assert.equal(autoAssignPlan(one, noGaurav, NOW, { firstSeen: new Map([[key, NOW - H]]), skip: new Set(), owners }).keys.length, 0);
});

test("ISE auto-assign: at most 10 a minute, soonest deadline first; pushes held 15 minutes; MOBILE_ISE_AUTO_ASSIGN=off", () => {
  const owners = parseIseOwners(DEFAULT_ISE_OWNERS);
  const many = Array.from({ length: 12 }, (_, i) => task({ taskId: String(i).padStart(24, "0"), row: 100 + i, pc: "Sneha", assignedAt: at(-H), deadline: at((12 - i) * H) }));
  const seen = new Map(many.map((t) => [`${t.taskId}|m.gaurav@example.com`, NOW - H]));
  const plan = autoAssignPlan(many, roster, NOW, { firstSeen: seen, skip: new Set(), owners });
  assert.equal(plan.write.length, 10);
  assert.equal(plan.deferred.length, 2);
  assert.deepEqual(plan.write.slice(0, 2).map((c) => c.task.row), [111, 110]);
  assert.deepEqual(plan.deferred.map((c) => c.task.row), [101, 100]);
  assert.equal(autoAssignPlan(many, roster, NOW, { firstSeen: seen, skip: new Set(), owners, max: 3 }).write.length, 3);
  assert.equal(holdsUnassignedPushes({ anchor: NOW - AUTO_ASSIGN_HOLD_MS + M }, NOW), true);
  assert.equal(holdsUnassignedPushes({ anchor: NOW - AUTO_ASSIGN_HOLD_MS }, NOW), false);
  assert.ok(AUTO_ASSIGN_GRACE_MS === 5 * M && AUTO_ASSIGN_HOLD_MS > AUTO_ASSIGN_GRACE_MS);
  for (const v of [undefined, "", "on", "true", "yes"]) assert.equal(autoAssignEnabled(v), true, String(v));
  for (const v of ["off", " OFF ", "false", "0", "no", "disabled"]) assert.equal(autoAssignEnabled(v), false, v);
});

// ── 1.11.0: task digest ─────────────────────────────────────────────────────

test("task digest: 09:15 and 18:00 IST windows; counts and the first 3 companies; nothing without open tasks", () => {
  const ist = (hhmm: string) => Date.parse(`2026-11-26T${hhmm}:00+05:30`);
  assert.equal(digestSlot(ist("09:14")), null);
  assert.deepEqual(digestSlot(ist("09:15")), { slot: "am", day: "2026-11-26" });
  assert.deepEqual(digestSlot(ist("11:59")), { slot: "am", day: "2026-11-26" });
  assert.equal(digestSlot(ist("12:00")), null);
  assert.equal(digestSlot(ist("17:59")), null);
  assert.deepEqual(digestSlot(ist("18:00")), { slot: "pm", day: "2026-11-26" });
  assert.deepEqual(digestSlot(ist("21:59")), { slot: "pm", day: "2026-11-26" });
  assert.equal(digestSlot(ist("22:00")), null);
  const open = [
    { company: "Acme", group: 0 },
    { company: "Globex", group: 1 },
    { company: "Initech", group: 1 },
    { company: "acme", group: 2 },
    { company: "Umbrella", group: 3 },
  ];
  assert.deepEqual(taskDigestText("am", open), { title: "Your tasks today: 5 open · 1 overdue · 2 due today", body: "Acme, Globex, Initech +1 more", count: 5 });
  assert.deepEqual(taskDigestText("pm", open.slice(0, 2)), { title: "Still open: Acme, Globex", body: "Mark done when the shortlist is shared.", count: 2 });
  assert.deepEqual(taskDigestText("am", [{ company: "Acme", group: 2 }]), { title: "Your tasks today: 1 open", body: "Acme", count: 1 });
  assert.equal(taskDigestText("am", []), null);
  assert.equal(taskDigestText("pm", []), null);
  assert.equal(companyList([{ company: "A" }, { company: " " }, { company: "B" }], 1), "A +1 more");
  assert.equal(taskDedupe.digest("am", "2026-11-26", "x@example.com"), "task:digest:am:2026-11-26:x@example.com");
});

test("task digest: one person's open tasks in list order; done, delivered, history and other people's left out", () => {
  const r = (email: string, company: string, state: TaskState, deadline: Date | null, row: number, assignedAt: Date | null = at(-H)) => ({
    email,
    task: task({ company, deadline, row, mentor: "x", assignedAt }),
    state,
  });
  const rows = [
    r("a@example.com", "Later Co", "acknowledged", at(30 * H), 1),
    r("a@example.com", "Done Co", "done", at(-H), 2),
    r("a@example.com", "Ready Co", "shortlist_ready", at(H), 3),
    r("a@example.com", "Late Co", "overdue", at(-2 * H), 4),
    r("a@example.com", "Today Co", "new", at(2 * H), 5),
    r("b@example.com", "Other Co", "overdue", at(-H), 6),
    r("a@example.com", "Ancient Co", "overdue", new Date(NOW - 50 * D), 7, new Date(NOW - 51 * D)),
    r("a@example.com", "Open Co", "new", null, 8),
  ];
  assert.deepEqual(openForDigest(rows, "a@example.com", NOW), [
    { company: "Late Co", group: 0 },
    { company: "Today Co", group: 1 },
    { company: "Later Co", group: 2 },
    { company: "Open Co", group: 3 },
  ]);
  assert.deepEqual(openForDigest(rows, "nobody@example.com", NOW), []);
});

// ── 1.11.0: device health, shortlistings, push kinds ────────────────────────

test("device health: healthy = notifications on, task channel on, not background-restricted; battery only warns", () => {
  const h = (n: boolean | null, c: boolean | null, b: boolean | null, r: boolean | null) => ({ notificationsEnabled: n, taskChannelEnabled: c, batteryOptimized: b, backgroundRestricted: r });
  assert.equal(deviceHealthy(h(true, true, false, false)), true);
  assert.equal(deviceHealthy(h(true, true, true, false)), true); // battery optimised: a warning, still healthy
  assert.equal(deviceHealthy(h(false, true, false, false)), false);
  assert.equal(deviceHealthy(h(true, false, false, false)), false);
  assert.equal(deviceHealthy(h(true, true, false, true)), false);
  assert.equal(deviceHealthy(h(null, null, null, null)), false); // an older app that never reported
  assert.equal(deviceHealthy(h(true, null, false, false)), false);
  assert.deepEqual(cleanHealth({ notificationsEnabled: true, taskChannelEnabled: "yes", batteryOptimized: false, backgroundRestricted: false, manufacturer: "  Xiaomi  " }), {
    notificationsEnabled: true,
    taskChannelEnabled: null,
    batteryOptimized: false,
    backgroundRestricted: false,
    manufacturer: "Xiaomi",
  });
  assert.equal(cleanHealth({ manufacturer: "Xiaomi" }), null); // nothing reported: what's stored stays
  assert.equal(cleanHealth(null), null);
  assert.equal(cleanHealth({ notificationsEnabled: false })?.notificationsEnabled, false);
  assert.equal(cleanHealth({ notificationsEnabled: true, manufacturer: "x".repeat(200) })?.manufacturer?.length, 80);
});

test("activity 1.11.0: shortlistings = marked done in the range + delivered in the range, each task once", () => {
  const range = { from: new Date("2026-11-01T00:00:00+05:30"), to: new Date("2026-11-08T00:00:00+05:30") };
  const inside = new Date("2026-11-03T10:00:00+05:30");
  const before = new Date("2026-10-20T10:00:00+05:30");
  const n = countShortlistings(
    [
      { assigneeEmail: "a@example.com", deliveredAt: inside, doneAt: inside }, // both: once
      { assigneeEmail: "a@example.com", deliveredAt: null, doneAt: inside }, // marked done only
      { assigneeEmail: "a@example.com", deliveredAt: before, doneAt: inside }, // delivered before, done inside
      { assigneeEmail: "a@example.com", deliveredAt: inside, doneAt: before }, // delivered inside
      { assigneeEmail: "a@example.com", deliveredAt: before, doneAt: before }, // neither
      { assigneeEmail: "b@example.com", deliveredAt: null, doneAt: new Date("2026-11-08T00:00:00+05:30") }, // the end is exclusive
      { assigneeEmail: null, deliveredAt: null, doneAt: inside },
      { assigneeEmail: "c@example.com", deliveredAt: inside }, // the 1.10 shape (no doneAt)
    ],
    range,
  );
  assert.equal(n.get("a@example.com"), 4);
  assert.equal(n.get("b@example.com"), undefined);
  assert.equal(n.get("c@example.com"), 1);
});

test("analytics 1.11.0: a done task is never overdue; its done time decides on time when nothing was delivered", () => {
  const now = new Date(NOW);
  const faraaz = person("Faraaz");
  const t = task({ mentor: "Faraaz", deadline: at(-H) });
  const open = rowStats(t, faraaz, undefined, null, "u", now);
  assert.equal(open.onTime, false);
  assert.equal(open.doneAt, null);
  const early = rowStats(t, faraaz, undefined, null, "u", now, at(-2 * H));
  assert.equal(early.onTime, true);
  assert.equal(early.doneAt, at(-2 * H).toISOString());
  const late = rowStats(t, faraaz, undefined, null, "u", now, at(-30 * M));
  assert.equal(late.onTime, false);
  const { totals, byMember } = summarize([open, early, late], now);
  assert.equal(totals.overdue, 1);
  assert.equal(byMember[0].overdue, 1);
  assert.equal(totals.delivered, 0); // "delivered" stays the automation's
});

test("push kinds task_done and task_digest have inbox text; their own title / body wins", () => {
  assert.equal(inboxText("task_done", { by: "Rakesh", company: "Acme" }).title, "Rakesh finished Acme's shortlisting");
  assert.deepEqual(inboxText("task_digest", { title: "Your tasks today: 1 open", body: "Acme" }), { title: "Your tasks today: 1 open", body: "Acme" });
  assert.equal(inboxText("task_digest", {}).title, "Your tasks");
});

async function asyncTests() {
  // Two people tap Take together: the second waits for the first and reads its name.
  let cell = "";
  const tryTake = (name: string) =>
    oneAtATime("b".repeat(24), async () => {
      const seen = cell; // the fresh read
      await new Promise((r) => setTimeout(r, 20)); // the sheet write takes a moment
      if (seen) throw new Error(`${seen} already took this task.`);
      cell = name;
      return name;
    });
  const [a, b] = await Promise.allSettled([tryTake("Xena"), tryTake("Yuri")]);
  assert.equal(a.status === "fulfilled" && a.value, "Xena");
  assert.equal(b.status === "rejected" && (b.reason as Error).message, "Xena already took this task.");
  assert.equal(cell, "Xena");
  // A failed run doesn't block the next one.
  assert.equal(await oneAtATime("b".repeat(24), async () => "next"), "next");
  passed++;
}

asyncTests()
  .catch((e) => {
    console.error(`✗ take / assign run one at a time per task\n  ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => console.log(process.exitCode ? `\nSome task self-tests failed (${passed} passed).` : `All ${passed} task (1.9.0–1.11.0) self-tests passed.`));
