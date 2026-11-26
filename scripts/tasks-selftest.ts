/**
 * Self-test for PSM 1.9.0's server logic that needs no network or database:
 *   npx tsx scripts/tasks-selftest.ts
 * Unassigned tasks (the list filter, the ISE → mentor mapping, the task_unassigned push timing,
 * text and recipients), the summary / detail fields, analytics activity counting, prep nudge
 * slots, feedback checks and the inbox text of the new push kinds. All data here is made up.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import { istClock, unassignedRecipients, unassignedStages, unassignedText } from "@/lib/mobile/assignments";
import { buildActivity, countPrepsGiven, countShortlistings, istDays } from "@/lib/mobile/analytics";
import type { ControlTask } from "@/lib/mobile/control-rows";
import { cleanFeedback, feedbackPush } from "@/lib/mobile/feedback";
import { DEFAULT_ISE_OWNERS, iseFirstName, iseOwnerOf, iseOwnersFromEnv, parseIseOwners } from "@/lib/mobile/ise";
import { prepNudge } from "@/lib/mobile/preps/notify";
import type { PrepRow } from "@/lib/mobile/preps/parse";
import { inboxText } from "@/lib/mobile/push";
import type { RosterUser } from "@/lib/mobile/roster";
import { byDeadline, isUnassigned, isUnassignedOpen, oneAtATime, toDetail, toSummary } from "@/lib/mobile/tasks";

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
  .finally(() => console.log(process.exitCode ? `\nSome 1.9.0 self-tests failed (${passed} passed).` : `All ${passed} 1.9.0 self-tests passed.`));
