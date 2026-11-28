/**
 * Self-test for PSM 1.10.0's Academy shares (pure parts only: no network, no database):
 *   npx tsx scripts/academy-shares-selftest.ts
 * The CRPs master, company-sheet tab and header detection on synthetic grids, outcome and stage
 * normalisation (the contract's examples), matching to the assessed pool, change detection (new /
 * status change / removed / baseline / renamed tab), the push cap, GET /pool's summary and groups,
 * the digest text and the dedupe keys. Every person here is made up.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import { inboxText } from "@/lib/mobile/push";
import {
  baselineSharedAt,
  bestOutcome,
  buildShares,
  capPushes,
  cellText,
  dayLabel,
  diffShares,
  digestText,
  findTabColumns,
  interviewTimeKey,
  interviewTimeLabel,
  isActiveShare,
  isLiveInterview,
  matchRow,
  MAX_ROWS_PER_TAB,
  outcomeOfValue,
  parseCrpsMaster,
  phonesIn,
  pickTabs,
  poolDedupe,
  poolIndex,
  readTabRows,
  resumeStamp,
  type Round,
  type ShareRecord,
  shareDto,
  shareHash,
  shareOutcome,
  shareStage,
  shareVerdict,
  sheetIdOf,
  sheetUrl,
  statusChangeText,
  type StoredShare,
  tabColumns,
  type TabInfo,
  weekStart,
} from "@/lib/mobile/pool/shares";
import { groupKeyOf, poolGroups, poolSummary, type SummaryItem } from "@/lib/mobile/pool/summary";

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

const ID_A = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const link = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;
const UID1 = "11111111-2222-4333-8444-555555555551";
const UID2 = "11111111-2222-4333-8444-555555555552";
const UID3 = "11111111-2222-4333-8444-555555555553";
const tab = (title: string, gid: number, hidden = false): TabInfo => ({ title, gid, hidden, rowCount: 1000, columnCount: 26 });

// ── The CRPs master ─────────────────────────────────────────────────────────

test("master: columns by name, merged company names inherit, one entry per sheet", () => {
  const header = ["Company Name", "Role", "JOB ID", "CRP Month", "Final Status", "Current Stage of Interview", "ISE", "CRM", "Internal sheet Link", "Company Sheet Link"];
  const m = parseCrpsMaster([
    header,
    ["Acme Robotics", "SDE 1", "job-1", "Nov", "Process in Progress", "Interview in progress", "Asha", "Ravi", "", link(ID_A)],
    ["", "Support Engineer", "job-2", "Nov", "", "", "#REF!", "Ravi", "", link(ID_A)],
    ["", "Data Analyst", "job-3", "Oct", "", "", "Asha", "", "", link(ID_B)],
    ["Other Co", "QA", "job-4", "Oct", "", "", "", "", "", "https://example.com/shared-profiles/x"],
    ["Third Co", "QA", "job-5", "Oct", "", "", "", "", "", ""],
    [],
  ]);
  assert.equal(m.rows, 5);
  assert.equal(m.sheets.length, 2);
  assert.equal(m.notSheetLinks, 1);
  assert.equal(m.noLink, 1);
  const a = m.sheets.find((s) => s.sheetId === ID_A)!;
  assert.equal(a.company, "Acme Robotics");
  assert.deepEqual(a.roles, ["SDE 1", "Support Engineer"]);
  assert.deepEqual(a.jobIds, ["job-1", "job-2"]);
  assert.equal(a.ise, "Asha");
  assert.equal(a.masterFinalStatus, "Process in Progress");
  assert.equal(m.sheets.find((s) => s.sheetId === ID_B)!.company, "Acme Robotics");
  assert.throws(() => parseCrpsMaster([["Role", "JD"]]), /Company Sheet Link/);
});

test("sheet links: only Google Sheets", () => {
  assert.equal(sheetIdOf(link(ID_A)), ID_A);
  assert.equal(sheetIdOf(`https://docs.google.com/spreadsheets/u/1/d/${ID_B}/edit`), ID_B);
  assert.equal(sheetIdOf(`https://drive.google.com/file/d/${ID_A}/view`), null);
  assert.equal(sheetIdOf("see the sheet"), null);
  assert.equal(sheetUrl(ID_A, 42), `https://docs.google.com/spreadsheets/d/${ID_A}/edit#gid=42`);
  assert.equal(sheetUrl(ID_A), `https://docs.google.com/spreadsheets/d/${ID_A}/edit`);
});

// ── Company sheet tabs ──────────────────────────────────────────────────────

const roundHeader = [
  "Full Name", "Mobile Number", "Email Id", "Bachelors College Name", "Resume", "TR1 Recording Link", "Interview Time",
  "Assessment Round", "Introductory Call", "Online Coding Round", "Resume Shortlisted", "Assignment Round", "TR Round 1", "TR Round 2", "MR Round", "HR Round", "Final Status ", "Reason for Selection/Rejection", "GitHub Profile link",
];

test("tabs: hidden copies and Read me tabs are skipped", () => {
  const picked = pickTabs([tab("READ ME!", 1), tab("JD-1", 2), tab("Copy of JD-1", 3, true), tab("Readme", 4), tab("Batch 2", 5)]);
  assert.deepEqual(picked.map((t) => t.title), ["JD-1", "Batch 2"]);
});

test("header: found within the first 6 rows; round columns by name, links / times / notes are not rounds", () => {
  const cols = tabColumns([["Acme · shared profiles"], [], roundHeader, ["Asha Test", "9000000001"]])!;
  assert.equal(cols.headerRow, 2);
  assert.deepEqual(cols.phones, [1]);
  assert.deepEqual(cols.emails, [2]);
  assert.equal(cols.name, 0);
  assert.equal(cols.resume, 4);
  assert.equal(cols.finalStatus, 16);
  assert.deepEqual(
    cols.rounds.map((r) => r.name),
    ["Assessment Round", "Introductory Call", "Online Coding Round", "Resume Shortlisted", "Assignment Round", "TR Round 1", "TR Round 2", "MR Round", "HR Round"],
  );
  // Seven banner rows: the header is out of reach (not guessed).
  assert.equal(findTabColumns([[], [], [], [], [], [], roundHeader]), null);
});

test("header: no phone column, or nothing about a process, is not a share list", () => {
  assert.equal(findTabColumns([["Full Name", "Email", "Resume"]]), null);
  assert.equal(findTabColumns([["Full Name", "Mobile Number", "Role"]]), null);
  assert.equal(findTabColumns([]), null);
  // A parent's / HR contact is not the candidate's number; an alternate number is.
  const c = findTabColumns([["Name", "Parent Contact", "Contact Number", "Alternate Mobile", "HR Contact", "Final Status"]])!;
  assert.deepEqual(c.phones, [2, 3]);
});

test("rows: phones by their last 10 digits, several per cell, email fallback, formula errors blank", () => {
  const cols = tabColumns([roundHeader])!;
  const rows = readTabRows(
    [
      roundHeader,
      ["Asha Test", "+91 90000 00001", "asha@example.com", "X", "https://forms.example.com/1730000000000_cv.pdf", "", "", "Cleared", "", "", "Yes", "", "#REF!"],
      ["Ravi Test", "09000000002 / 9000000012", "", "", "", "", "", "", "", "", "", "", "Selected", "", "", "", "Selected"],
      ["No Contact", "", "", "", "", "", "", "Cleared"],
      ["Email Only", "n/a", "Email.Only@Example.com"],
    ],
    cols,
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].phones, ["9000000001"]);
  assert.deepEqual(rows[0].rounds, [{ name: "Assessment Round", value: "Cleared" }, { name: "Resume Shortlisted", value: "Yes" }]);
  assert.equal(rows[0].resumeAt, 1_730_000_000_000);
  assert.deepEqual(rows[1].phones, ["9000000002", "9000000012"]);
  assert.equal(rows[1].finalStatus, "Selected");
  assert.equal(rows[2].email, "email.only@example.com");
  assert.equal(rows[2].sheetRow, 5);
  assert.deepEqual(phonesIn("1234567890"), []);
  assert.equal(cellText("#N/A"), "");
  assert.equal(cellText("  Cleared \n "), "Cleared");
});

test("rows: a huge tab is capped", () => {
  const head = ["Name", "Mobile", "Final Status"];
  const many = Array.from({ length: MAX_ROWS_PER_TAB + 50 }, (_, i) => ["P", String(9_000_000_000 + i), ""]);
  const rows = readTabRows([head, ...many], tabColumns([head])!);
  assert.equal(rows.length, MAX_ROWS_PER_TAB);
});

test("resume link stamps and the baseline share date", () => {
  assert.equal(resumeStamp("https://x.example.com/1730000000000_resume.pdf"), 1_730_000_000_000);
  assert.equal(resumeStamp("https://drive.google.com/file/d/abc/view"), null);
  assert.equal(resumeStamp("https://x.example.com/9990000000000.pdf"), null);
  const now = Date.UTC(2026, 10, 27);
  assert.equal(baselineSharedAt(Date.UTC(2026, 6, 1), Date.UTC(2026, 4, 1), now), Date.UTC(2026, 6, 1));
  assert.equal(baselineSharedAt(Date.UTC(2026, 2, 1), Date.UTC(2026, 4, 1), now), Date.UTC(2026, 4, 1));
  assert.equal(baselineSharedAt(null, null, now), now);
  assert.equal(baselineSharedAt(now + 99_999, null, now), now);
});

// ── Outcome and stage ───────────────────────────────────────────────────────

test("outcomes: the contract's examples", () => {
  for (const v of ["Selected", "Offer released", "Hired"]) assert.equal(outcomeOfValue(v), "selected", v);
  for (const v of ["Rejected", "Not Cleared", "Not shortlisted", "Failed"]) assert.equal(outcomeOfValue(v), "rejected", v);
  for (const v of ["Cleared", "Shortlisted", "Passed", "Moved to next round", "Scheduled", "Pending", "Awaiting Results", "Process in Progress"]) assert.equal(outcomeOfValue(v), "in_process", v);
  assert.equal(outcomeOfValue("Hold"), "on_hold");
  assert.equal(outcomeOfValue("On-Hold"), "on_hold");
  for (const v of ["Absent", "No show", "Didn't join", "did not join"]) assert.equal(outcomeOfValue(v), "no_show", v);
  for (const v of ["", "Asha", "Karnataka", "Available"]) assert.equal(outcomeOfValue(v), "unknown", v);
});

test("outcomes: round context, negations and odd values", () => {
  // "Selected" in a round column = that round cleared, unless it is the tab's last round.
  assert.equal(outcomeOfValue("Selected", "round"), "in_process");
  assert.equal(outcomeOfValue("Selected", "round", true), "selected");
  assert.equal(outcomeOfValue("R1 Select", "round"), "in_process");
  assert.equal(outcomeOfValue("R1 reject", "round"), "rejected");
  assert.equal(outcomeOfValue("Yes", "round"), "in_process");
  assert.equal(outcomeOfValue("No", "round"), "rejected");
  assert.equal(outcomeOfValue("Yes", "final"), "unknown");
  assert.equal(outcomeOfValue("Not selected"), "rejected");
  assert.equal(outcomeOfValue("Selected for next round"), "in_process");
  assert.equal(outcomeOfValue("Offer declined"), "rejected");
  assert.equal(outcomeOfValue("Panel didn't join"), "in_process");
  assert.equal(outcomeOfValue("Requirement closed"), "rejected");
  assert.equal(outcomeOfValue("Placed but yet to receive the offer"), "selected");
  // Found in the live sheets' dry run (2026-11-27).
  assert.equal(outcomeOfValue("Did not complete"), "rejected");
  assert.equal(outcomeOfValue("Not completed"), "rejected");
  assert.equal(outcomeOfValue("Not attempted"), "no_show");
  assert.equal(outcomeOfValue("Interviewing"), "in_process");
  assert.equal(outcomeOfValue("Completed & waiting for results"), "in_process");
  assert.equal(outcomeOfValue("Yet to schedule"), "in_process");
});

test("header: form questions are not round columns", () => {
  const c = tabColumns([["Full Name", "Mobile Number", "Resume", "Are you willing to attend the offline drive", "What was the biggest challenge in the assignment", "Assignment Round", "Final Status"]])!;
  assert.deepEqual(c.rounds.map((r) => r.name), ["Assignment Round"]);
});

const R = (name: string, value: string): Round => ({ name, value });

test("share outcome: Final Status first, else the latest round that says something", () => {
  assert.equal(shareOutcome([R("TR Round 1", "Cleared")], "Selected"), "selected");
  assert.equal(shareOutcome([R("TR Round 1", "Cleared"), R("TR Round 2", "Rejected")], ""), "rejected");
  assert.equal(shareOutcome([R("TR Round 1", "Selected")], "", "HR Round"), "in_process");
  assert.equal(shareOutcome([R("TR Round 1", "Selected"), R("HR Round", "Selected")], "", "HR Round"), "selected");
  // A note in the latest round falls back to the one before.
  assert.equal(shareOutcome([R("TR Round 1", "Cleared"), R("TR Round 2", "Panel: Asha")], ""), "in_process");
  // "Resume Shortlisted" placed after the rounds still happened first.
  assert.equal(shareOutcome([R("TR Round 1", "Rejected"), R("Resume Shortlisted", "Yes")], ""), "rejected");
  // A Final Status that says nothing known leaves it to the rounds.
  assert.equal(shareOutcome([R("Assignment Round", "Pending")], "Will confirm tomorrow"), "in_process");
  assert.equal(shareOutcome([], ""), "unknown");
});

test("stage labels", () => {
  assert.equal(shareStage([R("TR Round 1", "Cleared")], "Selected"), "Selected");
  assert.equal(shareStage([R("Assessment Round", "Cleared"), R("TR Round 1", "Cleared")], ""), "TR Round 1 · Cleared");
  assert.equal(shareStage([R("Assignment Round", "Pending")], ""), "Assignment Round · Pending");
  assert.equal(shareStage([], ""), "Shared");
  assert.equal(shareStage([], "Will confirm"), "Will confirm");
  assert.ok(shareStage([R("TR Round 1", "x".repeat(300))], "").length <= 80);
});

test("most advanced outcome and active shares", () => {
  assert.equal(bestOutcome(["rejected", "in_process", "selected"]), "selected");
  assert.equal(bestOutcome(["rejected", "in_process"]), "in_process");
  assert.equal(bestOutcome(["rejected", "no_show"]), "no_show");
  assert.equal(bestOutcome([]), null);
  assert.equal(isActiveShare("in_process", "Process in Progress"), true);
  assert.equal(isActiveShare("in_process", "Position closed from NxtWave"), false);
  assert.equal(isActiveShare("selected", ""), false);
});

// ── Matching and building ───────────────────────────────────────────────────

const pool = poolIndex([
  { uid: UID1, phone: "9000000001", email: "asha@example.com" },
  { uid: UID2, phone: "9000000002", email: null },
  { uid: UID3, phone: null, email: "meera@example.com" },
]);

test("matching: phone (last 10 digits), then email; anyone else is never kept", () => {
  assert.deepEqual(matchRow({ phones: ["9000000001"], email: null }, pool), { uid: UID1, phone: "9000000001" });
  assert.deepEqual(matchRow({ phones: ["9999999999", "9000000002"], email: null }, pool), { uid: UID2, phone: "9000000002" });
  assert.deepEqual(matchRow({ phones: ["9999999999"], email: "meera@example.com" }, pool), { uid: UID3, phone: "9999999999" });
  assert.equal(matchRow({ phones: ["9999999999"], email: "x@example.com" }, pool), null);
});

test("building shares: Academy rows only, one per candidate per tab, role from the master for one tab", () => {
  const rows = [
    roundHeader,
    ["Asha Test", "9000000001", "", "", "", "", "", "Cleared"],
    ["Asha Test", "9000000001", "", "", "", "", "", "Cleared", "", "", "", "", "Cleared"],
    ["Not Academy", "9876543210", "", "", "", "", "", "Cleared"],
    ["Meera Test", "", "meera@example.com", "", "", "", "", "", "", "", "", "", "", "", "", "", "Rejected"],
  ];
  const one = buildShares({ company: "Acme", roles: ["SDE 1"] }, [{ info: tab("JD-1", 0), rows }, { info: tab("Old copy", 9, true), rows }], pool);
  assert.equal(one.tabsRead, 1);
  assert.equal(one.academyRows, 3);
  assert.equal(one.shares.length, 2);
  const asha = one.shares.find((s) => s.uid === UID1)!;
  assert.equal(asha.role, "SDE 1");
  assert.equal(asha.stage, "TR Round 1 · Cleared");
  assert.equal(asha.outcome, "in_process");
  assert.equal(one.shares.find((s) => s.uid === UID3)!.outcome, "rejected");
  assert.ok(!JSON.stringify(one.shares).includes("9876543210"));
  const two = buildShares({ company: "Acme", roles: ["SDE 1"] }, [{ info: tab("Batch 1", 0), rows }, { info: tab("Batch 2", 1), rows }], pool);
  assert.deepEqual([...new Set(two.shares.map((s) => s.role))].sort(), ["Batch 1", "Batch 2"]);
});

// ── Change detection ────────────────────────────────────────────────────────

const rec = (uid: string, tabName: string, rounds: Round[], finalStatus = ""): ShareRecord => ({
  tab: tabName,
  gid: 0,
  uid,
  phone: null,
  company: "Acme",
  role: "SDE 1",
  rounds,
  finalStatus,
  stage: shareStage(rounds, finalStatus),
  outcome: shareOutcome(rounds, finalStatus),
  status: shareVerdict(rounds, finalStatus).status,
  hash: shareHash(rounds, finalStatus),
  resumeAt: null,
  resumeUrl: null,
});
const stored = (id: string, r: ShareRecord, removed = false): StoredShare => ({
  id,
  tab: r.tab,
  uid: r.uid,
  rounds: r.rounds,
  finalStatus: r.finalStatus,
  outcome: r.outcome,
  hash: r.hash,
  firstSeenAt: 1,
  changedAt: 1,
  removed,
});

test("changes: a sheet's first read is a baseline (recorded, no events)", () => {
  const d = diffShares([], [rec(UID1, "JD-1", []), rec(UID2, "JD-1", [R("TR Round 1", "Cleared")])], true);
  assert.equal(d.writes.length, 2);
  assert.equal(d.events.length, 0);
  assert.equal(d.removed.length, 0);
});

test("changes: new share, status change, unchanged, removed", () => {
  const before = [stored("1", rec(UID1, "JD-1", [R("TR Round 1", "Scheduled")])), stored("2", rec(UID2, "JD-1", [])), stored("3", rec(UID3, "JD-1", []))];
  const next = [rec(UID1, "JD-1", [R("TR Round 1", "Cleared")]), rec(UID2, "JD-1", []), rec(UID3, "JD-2", [])];
  const d = diffShares(before, next, false);
  const types = d.events.map((e) => `${e.type}:${e.share.uid === UID1 ? 1 : e.share.uid === UID2 ? 2 : 3}`);
  // UID3 moved from JD-1 to JD-2 in the same sheet: not a new share.
  assert.deepEqual(types, ["status:1"]);
  assert.deepEqual(d.removed.map((r) => r.id), ["3"]);
  assert.equal(d.writes.find((w) => w.uid === UID3)!.from?.id, "3");
  const brandNew = diffShares(before, [...next, rec("11111111-2222-4333-8444-555555555559", "JD-1", [])], false);
  assert.equal(brandNew.events.filter((e) => e.type === "new").length, 1);
});

test("changes: a removed share that comes back is not new; whitespace-only edits are not changes", () => {
  const a = rec(UID1, "JD-1", [R("TR Round 1", "Cleared")]);
  const d = diffShares([stored("1", a, true)], [rec(UID1, "JD-1", [R("TR Round 1", "Cleared")])], false);
  assert.equal(d.events.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(shareHash([R("TR Round 1", "Cleared")], ""), shareHash([R("TR Round 1", cellText("  Cleared ")) ], ""));
  assert.notEqual(shareHash([R("TR Round 1", "Cleared")], ""), shareHash([R("TR Round 1", "Cleared")], "Selected"));
});

test("change text", () => {
  assert.equal(
    statusChangeText({ rounds: [R("TR Round 1", "Scheduled")], finalStatus: "" }, { rounds: [R("TR Round 1", "Cleared"), R("TR Round 2", "Scheduled")], finalStatus: "", stage: "x" }),
    "TR Round 2: Scheduled · TR Round 1: Cleared",
  );
  assert.equal(
    statusChangeText({ rounds: [R("HR Round", "Pending")], finalStatus: "" }, { rounds: [R("HR Round", "Pending")], finalStatus: "Selected", stage: "Selected" }),
    "Final status: Selected",
  );
  assert.equal(statusChangeText({ rounds: [R("A", "x")], finalStatus: "" }, { rounds: [], finalStatus: "", stage: "Shared" }), "Now: Shared");
  const many = Array.from({ length: 6 }, (_, i) => R(`Round ${i}`, "Cleared"));
  assert.match(statusChangeText(null, { rounds: many, finalStatus: "", stage: "x" }), /\+3 more$/);
});

test("push cap: at most 30 per mentor per run, the rest in one summary", () => {
  const items = Array.from({ length: 42 }, (_, i) => i);
  const c = capPushes(items, 30);
  assert.equal(c.send.length, 29);
  assert.equal(c.summarised.length, 13);
  assert.equal(capPushes(items.slice(0, 30), 30).summarised.length, 0);
});

// ── GET /pool summary and groups ────────────────────────────────────────────

const item = (name: string, email: string | null, opts: Partial<SummaryItem> = {}): SummaryItem => ({
  mentor: { name, email },
  mine: false,
  sharesCount: 0,
  stage: null,
  upcomingInterviews: 0,
  ...opts,
});

test("groups: mine first, then mentors A–Z, then Unassigned; keys", () => {
  const items = [
    item("", null),
    item("Zara", "zara@example.com", { sharesCount: 2, stage: "in_process", upcomingInterviews: 1 }),
    item("Asif Sheet", null, { sharesCount: 1, stage: "selected" }),
    item("Kiran", "kiran@example.com", { mine: true, upcomingInterviews: 2 }),
    item("Kiran", "kiran@example.com", { mine: true, sharesCount: 3, stage: "rejected" }),
    item("bala", "bala@example.com"),
    item("", null, { sharesCount: 1 }),
  ];
  const groups = poolGroups(items);
  assert.deepEqual(groups.map((g) => g.key), ["kiran@example.com", "name:asif sheet", "bala@example.com", "zara@example.com", "unassigned"]);
  assert.equal(groups[0].mine, true);
  assert.equal(groups[0].total, 2);
  assert.equal(groups[0].shared, 1);
  assert.equal(groups[0].neverShared, 1);
  assert.equal(groups[0].upcomingInterviews, 2);
  assert.equal(groups.at(-1)!.mentor, null);
  assert.equal(groups.at(-1)!.total, 2);
  assert.equal(groupKeyOf({ name: "  Asif  Sheet ", email: null }), "name:asif sheet");
  const s = poolSummary(items);
  assert.deepEqual(s, { total: 7, assigned: 5, unassigned: 2, shared: 4, neverShared: 3, inProcess: 1, selected: 1, upcomingInterviews: 3 });
});

test("summary: never synced shares count neither shared nor never shared", () => {
  const s = poolSummary([item("A", "a@example.com", { sharesCount: null }), item("", null, { sharesCount: null })]);
  assert.equal(s.shared, 0);
  assert.equal(s.neverShared, 0);
  assert.equal(s.unassigned, 1);
  assert.deepEqual(poolGroups([]), []);
});

test("share DTO: IST share day, sheet link to the tab, defensive rounds", () => {
  const dto = shareDto({
    id: "7",
    sheet_id: ID_A,
    tab: "JD-1",
    tab_gid: 5,
    company: "Acme",
    role: "SDE 1",
    rounds: [{ name: "TR Round 1", value: "Cleared" }, { bad: true }, "x"],
    final_status: "",
    stage: "TR Round 1 · Cleared",
    outcome: "weird",
    first_seen_at: new Date("2026-11-26T20:00:00Z"),
    changed_at: new Date("2026-11-27T05:00:00Z"),
  });
  assert.equal(dto.sharedOn, "2026-11-27");
  assert.equal(dto.sheetUrl, `https://docs.google.com/spreadsheets/d/${ID_A}/edit#gid=5`);
  assert.deepEqual(dto.rounds, [{ name: "TR Round 1", value: "Cleared" }]);
  // Worked out again from the rounds (a row read before migration 022 has no stored status).
  assert.equal(dto.outcome, "in_process");
  assert.equal(dto.status, "in_process");
  assert.equal(dto.kind, "shared");
  assert.equal(dto.companyStatus, "");
});

// ── Digest, interviews and dedupe keys ──────────────────────────────────────

test("digest text: the contract's example, zero parts left out, nothing when all zero", () => {
  assert.equal(
    digestText({ today: 5, todayMine: 2, tomorrow: 3, tomorrowMine: 0, sharedYesterday: 12, selectedThisWeek: 1 }),
    "Academy interviews today 5 (2 yours) · tomorrow 3 · shared yesterday 12 · selected this week 1",
  );
  assert.equal(digestText({ today: 0, todayMine: 0, tomorrow: 2, tomorrowMine: 1, sharedYesterday: 0, selectedThisWeek: 0 }), "Academy interviews tomorrow 2 (1 yours)");
  assert.equal(digestText({ today: 0, todayMine: 0, tomorrow: 0, tomorrowMine: 0, sharedYesterday: 4, selectedThisWeek: 0 }), "Academy: shared yesterday 4");
  assert.equal(digestText({ today: 0, todayMine: 0, tomorrow: 0, tomorrowMine: 0, sharedYesterday: 0, selectedThisWeek: 0 }), null);
});

test("days, weeks and interview times", () => {
  assert.equal(dayLabel("2026-11-27", "2026-11-27"), "today");
  assert.equal(dayLabel("2026-11-28", "2026-11-27"), "tomorrow");
  assert.equal(dayLabel("2026-12-03", "2026-11-27"), "Thu 3 Dec");
  assert.equal(weekStart("2026-11-27"), "2026-11-23");
  assert.equal(weekStart("2026-11-23"), "2026-11-23");
  assert.equal(weekStart("2026-11-29"), "2026-11-23");
  assert.equal(interviewTimeLabel({ interviewTime: { start: 960, end: 1020 }, interviewTimeText: "" }), "4:00 PM – 5:00 PM");
  assert.equal(interviewTimeKey({ interviewTime: { start: 960, end: 1020 }, interviewTimeText: "" }), "960-1020");
  assert.equal(interviewTimeKey({ interviewTime: null, interviewTimeText: "After Lunch " }), "afterlunch");
  assert.equal(isLiveInterview({ interviewDay: "2026-11-28", interviewState: "scheduled" }), true);
  assert.equal(isLiveInterview({ interviewDay: "2026-11-28", interviewState: "cancelled" }), false);
  assert.equal(isLiveInterview({ interviewDay: null, interviewState: "scheduled" }), false);
});

test("dedupe keys", () => {
  const e = "mentor@example.com";
  assert.equal(poolDedupe.assigned(UID1, e), `pool:assigned:${UID1}:${e}`);
  assert.equal(poolDedupe.shared("42", e), `pool:shared:42:${e}`);
  assert.equal(poolDedupe.status("42", "abcdef0123456789", e), `pool:status:42:abcdef0123456789:${e}`);
  assert.equal(poolDedupe.interview("0123456789abcdef01234567", "2026-11-28", "960-1020", e), `pool:iv:0123456789abcdef01234567:2026-11-28:960-1020:${e}`);
  assert.equal(poolDedupe.interview("0123456789abcdef01234567", "2026-11-28", "", e), `pool:iv:0123456789abcdef01234567:2026-11-28:-:${e}`);
  assert.equal(poolDedupe.meeting("m-1", e), `pool:meet:m-1:${e}`);
  assert.equal(poolDedupe.digest("2026-11-27", e), `academy:digest:2026-11-27:${e}`);
  // The same rounds + final status always give the same key; a change gives a new one.
  assert.equal(shareHash([R("TR Round 1", "Cleared")], ""), shareHash([R("TR Round 1", "Cleared")], ""));
});

test("inbox lines for the new kinds", () => {
  assert.equal(inboxText("pool_status", { title: "Asha Test · Acme", body: "TR Round 1: Cleared" }).title, "Asha Test · Acme");
  assert.equal(inboxText("pool_shared", { name: "Asha Test", company: "Acme" }).title, "Shared with Acme · Asha Test");
  assert.equal(inboxText("academy_digest", {}).title, "Academy candidates");
  for (const k of ["pool_assigned", "pool_interview", "pool_meeting"] as const) assert.ok(inboxText(k, {}).title.length > 0);
});

console.log(process.exitCode ? `academy-shares selftest: FAILED (${passed} passed)` : `${passed} academy-shares tests passed`);
