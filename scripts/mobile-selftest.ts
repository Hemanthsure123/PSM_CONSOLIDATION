/**
 * Self-test for the Android app's server logic that needs no network or database:
 *   npx tsx scripts/mobile-selftest.ts
 * Deadline parsing (incl. the "12:30 → 3:00" AM/PM slip), stable task ids, column detection,
 * Mentor matching, access tokens, and config → control-row cells → instructions parser round trip.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import { dsaGatesOf, githubScopeOf, parseInstructions, withColumnSettings } from "@/lib/automation/instructions";
import { findColumns, parseCount, parseSheetDate, resolveDeadline, rowsToTasks, taskIdFor } from "@/lib/mobile/control-rows";
import { parseRange, rowStats, summarize } from "@/lib/mobile/analytics";
import { signAccessToken, verifyAccessToken } from "@/lib/mobile/jwt";
import { cleanSignInEmails, matchMentor, resolveSignIn, type RosterUser } from "@/lib/mobile/roster";
import { configToCells, validateConfig } from "@/lib/mobile/screening";

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

const istHour = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).getUTCHours();

test("text dates are month-first, IST", () => {
  const a = parseSheetDate("10/15/2026 12:30:00")!;
  assert.equal(a.at.toISOString(), "2026-10-15T07:00:00.000Z");
  assert.equal(parseSheetDate("10/15/2026 3:00 PM")!.at.toISOString(), "2026-10-15T09:30:00.000Z");
  assert.equal(parseSheetDate("")?.at, undefined);
});

test("serial numbers are wall time in IST", () => {
  // 2026-10-15 12:30 IST as a Sheets serial.
  const serial = 46310 + 12.5 / 24;
  assert.equal(istHour(parseSheetDate(serial)!.at), 12);
});

test('a same-day "3:00" deadline after a "12:30" assignment is read as 3 PM, flagged', () => {
  const assigned = parseSheetDate("10/15/2026 12:30:00")!.at;
  const r = resolveDeadline(assigned, parseSheetDate("10/15/2026 3:00:00"));
  assert.equal(istHour(r.deadline!), 15);
  assert.equal(r.inferred, true);
});

test("a deadline that already makes sense is left alone", () => {
  const assigned = parseSheetDate("10/16/2026 10:00:00")!.at;
  const r = resolveDeadline(assigned, parseSheetDate("10/16/2026 13:00:00"));
  assert.equal(istHour(r.deadline!), 13);
  assert.equal(r.inferred, false);
  const explicit = resolveDeadline(assigned, parseSheetDate("10/16/2026 9:00 AM"));
  assert.equal(explicit.inferred, false); // written with AM: trust it
});

const header = [
  "Date", "Job ID", "Product", "Company Name", "PC", "CRM", "Tech Stack", "Hubspot Link", "Company remarks/Shortlisting remarks ",
  "Internal Sheets", "JD", "Assigned Date & Time", "Expected Deadline (Timeline)", "No. of Openings (ISE / PC)", "No. of Profiles Required",
  "Proposed Shortlisting Mechanism", "Mentor", "Subsheets", "Screening Instructions", "Github", "DSA", "Experience in Screening Domain",
  "Trigger", "Automation Status", "Automation Details",
];

test("columns are found by header text (row 2 like EDGE)", () => {
  const c = findColumns([[], header]);
  assert.equal(c.headerRow, 2);
  assert.equal(c.company, 4);
  assert.equal(c.mentor, 17);
  assert.equal(c.trigger, 23);
  assert.equal(c.deadline, 13);
});

test("task ids survive inserted rows and change with the assignment", () => {
  const row = ["", "J1", "Edge", "Acme", "Akanksha", "Sharan", "Flutter", "", "Refer to edge applied", "https://docs.google.com/spreadsheets/d/x", "", "10/15/2026 12:30:00", "10/15/2026 3:00:00", "1", "5", "", "Faraaz"];
  const c = findColumns([[], header]);
  const before = rowsToTasks("S", "T", [[], header, row], c)[0];
  const after = rowsToTasks("S", "T", [[], header, ["", "", "", "Other"], row], c)[1];
  assert.equal(before.taskId, after.taskId);
  assert.equal(after.row, 4);
  assert.equal(before.mentor, "Faraaz");
  assert.equal(before.profilesRequired, 5);
  assert.equal(before.deadlineInferred, true);
  assert.notEqual(taskIdFor("S", "T", ["Acme", "10/15/2026 12:30:00", "J1", ""]), taskIdFor("S", "T", ["Acme", "10/16/2026 12:30:00", "J1", ""]));
});

test("rows repeating the same identity still get distinct task ids; the first keeps the stable one", () => {
  const row = ["", "", "Edge", "Foxo.Club", "", "", "React", "", "", "", "", "10/19/2026 12:05:00", "", "1", "5", "", ""];
  const c = findColumns([[], header]);
  const single = rowsToTasks("S", "T", [[], header, row], c);
  const tripled = rowsToTasks("S", "T", [[], header, row, [...row], [...row]], c);
  assert.equal(tripled.length, 3);
  assert.equal(new Set(tripled.map((t) => t.taskId)).size, 3);
  assert.equal(tripled[0].taskId, single[0].taskId);
  // Stable across reads: the same sheet gives the same ids.
  assert.deepEqual(rowsToTasks("S", "T", [[], header, row, [...row], [...row]], c).map((t) => t.taskId), tripled.map((t) => t.taskId));
});

const roster: RosterUser[] = [
  { email: "hemanthreddy.sure@nxtwave.co.in", name: "Hemanth", aliases: [], role: "admin", active: true, leadEmail: null, signInEmails: ["hemanthsure668@gmail.com"] },
  { email: "bepari.faraazahmed@nxtwave.co.in", name: "Faraaz", aliases: ["Faraaz Ahmed"], role: "member", active: true, leadEmail: null },
  { email: "old@nxtwave.co.in", name: "Gone", aliases: [], role: "member", active: false, leadEmail: null, signInEmails: ["gone@gmail.com"] },
];

test("Mentor cells match names, aliases and emails; inactive people never match", () => {
  assert.equal(matchMentor("Hemanth", roster)?.email, "hemanthreddy.sure@nxtwave.co.in");
  assert.equal(matchMentor(" faraaz ", roster)?.name, "Faraaz");
  assert.equal(matchMentor("Faraaz Ahmed", roster)?.name, "Faraaz");
  assert.equal(matchMentor("hemanthreddy.sure@nxtwave.co.in", roster)?.name, "Hemanth");
  assert.equal(matchMentor("Gone", roster), null);
  assert.equal(matchMentor("", roster), null);
});

test("sign-in is decided by the roster: roster email or a linked account, never the domain alone", () => {
  // The linked Gmail signs in as Hemanth (same tasks, role, pushes).
  assert.equal(resolveSignIn("HemanthSure668@gmail.com", roster)?.email, "hemanthreddy.sure@nxtwave.co.in");
  assert.equal(resolveSignIn("hemanthreddy.sure@nxtwave.co.in", roster)?.role, "admin");
  // Unlinked accounts are nobody, whatever their domain.
  assert.equal(resolveSignIn("hemanthsure3@gmail.com", roster), null);
  assert.equal(resolveSignIn("someone@nxtwave.co.in", roster), null);
  assert.equal(resolveSignIn("", roster), null);
  // An inactive person's linked account resolves to them, so the caller can refuse with "access removed".
  assert.equal(resolveSignIn("gone@gmail.com", roster)?.active, false);
  // A Mentor cell holding the linked email still finds the person.
  assert.equal(matchMentor("hemanthsure668@gmail.com", roster)?.name, "Hemanth");
});

test("linked sign-in accounts: cleaned, one person each, never a roster email", () => {
  const a = "a@nxtwave.co.in";
  const b = "b@nxtwave.co.in";
  const ok = cleanSignInEmails([{ email: a, signInEmails: [" A.Personal@Gmail.com ", "a.personal@gmail.com"] }, { email: b }]);
  assert.deepEqual(ok.get(a), ["a.personal@gmail.com"]);
  assert.deepEqual(ok.get(b), []);
  const refused = (entries: { email: string; signInEmails?: unknown }[], re: RegExp) =>
    assert.throws(() => cleanSignInEmails(entries), (e: Error) => re.test(e.message));
  refused([{ email: a, signInEmails: ["not-an-email"] }], /isn't an email/);
  refused([{ email: a, signInEmails: [b] }, { email: b }], /someone else's roster email/);
  refused([{ email: a, signInEmails: [a] }], /already/);
  refused([{ email: a, signInEmails: ["x@gmail.com"] }, { email: b, signInEmails: ["X@gmail.com"] }], /linked to both/);
  refused([{ email: a, signInEmails: ["1@g.com", "2@g.com", "3@g.com", "4@g.com", "5@g.com", "6@g.com"] }], /at most 5/);
});

test("access tokens: valid, forged, expired", () => {
  const secret = "s".repeat(48);
  const t = signAccessToken({ sub: "a@nxtwave.in", role: "member", name: "A", sid: "sid-1" }, secret, 1_000_000);
  assert.equal(verifyAccessToken(t, secret, 1_000_000 + 60_000)?.sub, "a@nxtwave.in");
  assert.equal(verifyAccessToken(t, "x".repeat(48), 1_000_000), null);
  assert.equal(verifyAccessToken(t, secret, 1_000_000 + 16 * 60_000), null);
  const [h, , s] = t.split(".");
  const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: "admin@nxtwave.in", sid: "x", exp: 9e9 })).toString("base64url")}.${s}`;
  assert.equal(verifyAccessToken(tampered, secret), null);
});

test("config → control cells → the automation's own parser reads back the same settings", () => {
  const config = validateConfig({
    subsheets: ["Edge Applied", "Academy Applied"],
    focus: "Backend interns with strong APIs and SQL",
    mustHaves: ["Java or Kotlin", "SQL"],
    github: "fit",
    codeReview: false,
    dsa: { enabled: true, minRating: { codeforces: 1400 }, minSolved: 300 },
    experience: "1+ years",
    topN: 10,
  });
  const cells = configToCells(config);
  assert.equal(cells.github, "Domain-fit candidates (no review)");
  assert.equal(cells.dsa, "CF 1400, 300 solved");
  assert.equal(githubScopeOf(cells.github), "fit");
  const parsed = parseInstructions(
    withColumnSettings(cells.instructions, { subsheets: cells.subsheets, github: cells.github, dsa: cells.dsa, experience: cells.experience }),
  );
  assert.deepEqual(parsed.tabs, ["Edge Applied", "Academy Applied"]);
  assert.equal(parsed.github, "fit");
  assert.equal(parsed.review, false);
  assert.equal(parsed.dsa.use, true);
  assert.equal(parsed.dsa.gates.minRating.codeforces, 1400);
  assert.equal(parsed.dsa.gates.minSolved, 300);
  assert.equal(parsed.topN, 10);
  assert.match(parsed.focus, /Backend interns/);
  assert.match(parsed.focus, /Java or Kotlin; SQL/);
  assert.equal(dsaGatesOf(configToCells({ ...config, dsa: { enabled: true } }).dsa).minSolved, 0); // "Yes"
  assert.equal(configToCells({ ...config, github: "off" }).github, "Off");
  assert.equal(configToCells({ ...config, experience: "" }).experience, "Not required");
});

test("analytics: delivered on time, late, running, overdue, and the median", () => {
  const c = findColumns([[], header]);
  const mk = (company: string, assigned: string, deadline: string) =>
    rowsToTasks("S", "T", [[], header, ["", "J", "Edge", company, "", "", "", "", "", "", "", assigned, deadline, "1", "10", "", "Faraaz"]], c)[0];
  const now = new Date("2026-10-20T12:00:00Z");
  const job = (status: string, created: string, finished: string | null, extra: Record<string, unknown> = {}) =>
    ({ status, createdAt: created, finishedAt: finished, updatedAt: finished ?? created, progress: {}, result: { read: 100, shortlisted: 10 }, ...extra }) as never;
  const onTime = rowStats(mk("A", "10/15/2026 10:00:00", "10/15/2026 13:00:00"), null, job("completed", "2026-10-15T05:00:00Z", "2026-10-15T05:20:00Z"), null, "u", now);
  assert.equal(onTime.onTime, true);
  assert.equal(onTime.minutesToShortlist, 20);
  assert.equal(onTime.shortlisted, 10);
  const late = rowStats(mk("B", "10/15/2026 10:00:00", "10/15/2026 11:00:00"), null, job("completed", "2026-10-15T05:00:00Z", "2026-10-15T06:30:00Z"), null, "u", now);
  assert.equal(late.onTime, false);
  const early = rowStats(mk("C", "10/15/2026 10:00:00", "10/15/2026 13:00:00"), null,
    job("processing", "2026-10-15T05:00:00Z", null, { updatedAt: "2026-10-15T05:10:00Z", progress: { shortlistUrl: "https://x", shortlistCount: 7 }, result: null }), null, "u", now);
  assert.equal(early.deliveredAt, "2026-10-15T05:10:00.000Z"); // the early shortlist counts as delivered
  assert.equal(early.shortlisted, 7);
  const faraaz: RosterUser = { email: "f@nxtwave.co.in", name: "Faraaz", aliases: [], role: "member", active: true, leadEmail: null };
  const overdue = rowStats(mk("D", "10/15/2026 10:00:00", "10/15/2026 13:00:00"), faraaz, undefined, null, "u", now);
  assert.equal(overdue.onTime, false);
  // The same row with nobody assigned in the app (handled by hand) isn't judged.
  assert.equal(rowStats(mk("D", "10/15/2026 10:00:00", "10/15/2026 13:00:00"), null, undefined, null, "u", now).onTime, null);
  const future = rowStats(mk("E", "10/20/2026 10:00:00", "10/21/2026 13:00:00"), null, undefined, null, "u", now);
  assert.equal(future.onTime, null); // not judged yet
  const { totals, byMember } = summarize([onTime, late, early, overdue, future], now);
  assert.equal(totals.tasks, 5);
  assert.equal(totals.delivered, 3);
  assert.equal(totals.onTimePercent, 50); // 2 of the 4 judged
  assert.equal(totals.medianMinutesToShortlist, 20); // 10, 20, 90
  assert.equal(totals.overdue, 1);
  assert.equal(byMember.find((m) => m.email === "f@nxtwave.co.in")?.overdue, 1);
  assert.equal(byMember.reduce((n, m) => n + m.tasks, 0), 5);
  const r = parseRange(new URLSearchParams("days=30"), now);
  assert.equal(Math.round((r.to.getTime() - r.from.getTime()) / 86_400_000), 30);
  assert.throws(() => parseRange(new URLSearchParams("from=2026-10-10&to=2026-10-01"), now), /before/);
});

test('counts read as shown: "10-15" → 15 (Sheets stores it as a date), "20+" → 20', () => {
  assert.equal(parseCount("10-15"), 15);
  assert.equal(parseCount("20+"), 20);
  assert.equal(parseCount("12"), 12);
  assert.equal(parseCount(""), 0);
  const c = findColumns([[], header]);
  const raw = [[], header, ["", "J", "Edge", "Acme", "", "", "", "", "", "", "", "", "", "1", 46310]];
  const shown = [[], header, ["", "J", "Edge", "Acme", "", "", "", "", "", "", "", "", "", "1", "10-15"]];
  assert.equal(rowsToTasks("S", "T", raw, c, shown)[0].profilesRequired, 15);
});

test("invalid configs are refused with a sentence", () => {
  assert.throws(() => validateConfig({ subsheets: [], focus: "x", github: "fit", dsa: { enabled: false }, topN: 5 }), /subsheet/);
  assert.throws(() => validateConfig({ subsheets: ["A"], focus: "", github: "fit", dsa: { enabled: false }, topN: 5 }), /focus/);
  assert.throws(() => validateConfig({ subsheets: ["A"], focus: "x", github: "fit", dsa: { enabled: false }, topN: 0 }), /Top N/);
});

console.log(process.exitCode ? `\nSome mobile self-tests failed (${passed} passed).` : `All ${passed} mobile self-tests passed.`);
