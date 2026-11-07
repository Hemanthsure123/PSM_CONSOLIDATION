/**
 * Self-test for the Calendar's prep logic (no network, no database):
 *   npx tsx scripts/prep-selftest.ts
 * Date and timing cells as the team types them, column detection, stable keys, prep / interview
 * statuses, the SLA (45 minutes for next-day interviews, 24 h before later ones), and categories.
 */
import "./server-only-shim";
import assert from "node:assert/strict";
import {
  addDays,
  atIst,
  categoryFromSheet,
  dayOf,
  findPrepColumns,
  interviewStateOf,
  isOpen,
  parseDay,
  parseTimeRange,
  phone10,
  prepStatusOf,
  processSteps,
  rowsToPreps,
  slaFor,
  splitNames,
} from "@/lib/mobile/preps/parse";

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

test("dates: serial numbers and the team's text spellings", () => {
  assert.equal(parseDay(46332), "2026-11-06");
  assert.equal(parseDay(46332.6), "2026-11-06");
  assert.equal(parseDay("Jan 16th , 2026", 2026), "2026-01-16");
  assert.equal(parseDay("Feb2 , 2026", 2026), "2026-02-02");
  assert.equal(parseDay("March 3 , 2026", 2026), "2026-03-03");
  assert.equal(parseDay("  Jan7 , 2026", 2026), "2026-01-07");
  assert.equal(parseDay("OCt 5", 2026), "2026-10-05");
  assert.equal(parseDay("Sep 24 2026 & ", 2026), "2026-09-24");
  assert.equal(parseDay("Jan 31 , 2026 ", 2026), "2026-01-31");
});

test("dates: day-first prep dates, typo years fixed, junk refused", () => {
  assert.equal(parseDay("06-10-2026", 2026), "2026-10-06");
  assert.equal(parseDay("11-10-26", 2026), "2026-10-11");
  assert.equal(parseDay("Jun 25, 0206", 2026), "2026-06-25");
  assert.equal(parseDay("Jan 27 , 2028", 2026), "2026-01-27");
  assert.equal(parseDay("Interview Date - To be Finalised", 2026), null);
  assert.equal(parseDay("Feb 30, 2026", 2026), null);
  assert.equal(parseDay("", 2026), null);
  assert.equal(parseDay(12), null);
});

const at = (r: ReturnType<typeof parseTimeRange>) => (r ? [r.start, r.end] : null);
test("timings: 24-hour, ranges, AM/PM, serial fractions", () => {
  assert.deepEqual(at(parseTimeRange("15:00")), [900, null]);
  assert.deepEqual(at(parseTimeRange("16:00- 17:00")), [960, 1020]);
  assert.deepEqual(at(parseTimeRange("18:00 - 18:30")), [1080, 1110]);
  assert.deepEqual(at(parseTimeRange("9:30 am")), [570, null]);
  assert.deepEqual(at(parseTimeRange("10 :00")), [600, null]);
  assert.deepEqual(at(parseTimeRange(0.5833333333333334)), [840, null]);
  assert.deepEqual(at(parseTimeRange("8:00PM-9:00PM")), [1200, 1260]);
  assert.deepEqual(at(parseTimeRange("9:00:00 PM - 9:50PM")), [1260, 1310]);
  assert.deepEqual(at(parseTimeRange("16:28 PM")), [988, null]);
});

test("timings: 12-hour without AM/PM reads as office hours", () => {
  assert.deepEqual(at(parseTimeRange("3:00 - 3:20")), [900, 920]);
  assert.deepEqual(at(parseTimeRange("12:30- 1:00")), [750, 780]);
  assert.deepEqual(at(parseTimeRange("12:00 - 01:00")), [720, 780]);
  assert.deepEqual(at(parseTimeRange("02:00- 03:00")), [840, 900]);
  assert.deepEqual(at(parseTimeRange("11:00 - 12:00")), [660, 720]);
  assert.deepEqual(at(parseTimeRange("8:20 - 9:30")), [500, 570]);
});

test("timings: nothing to read", () => {
  assert.equal(parseTimeRange("Interview Date - To be Finalised"), null);
  assert.equal(parseTimeRange(""), null);
  assert.equal(parseTimeRange(46332), null);
  assert.equal(parseTimeRange("x"), null);
});

test("statuses: prep given and candidate status", () => {
  assert.equal(prepStatusOf(""), "pending");
  assert.equal(prepStatusOf("Yes"), "done");
  assert.equal(prepStatusOf("Missed"), "missed");
  assert.equal(prepStatusOf("Not informed to PSM priorly"), "not_informed");
  assert.equal(prepStatusOf("DNP"), "no_response");
  assert.equal(prepStatusOf("Candidate was busy"), "no_response");
  assert.equal(prepStatusOf("Cancled"), "cancelled");
  assert.equal(interviewStateOf(""), "scheduled");
  assert.equal(interviewStateOf("completed and waiting for results "), "completed");
  assert.equal(interviewStateOf("Selected for Next round"), "next_round");
  assert.equal(interviewStateOf("She selected for the tr 2"), "next_round");
  assert.equal(interviewStateOf("Rejected in TR round"), "rejected");
  assert.equal(interviewStateOf("Panel Didn't Join"), "no_show");
  assert.equal(interviewStateOf("Final stage-hold"), "hold");
  assert.equal(interviewStateOf("Hired"), "selected");
  assert.equal(interviewStateOf("TR1 Done but got rescheduled again"), "rescheduled");
});

test("small readers: phone, names, process", () => {
  assert.equal(phone10("+91 93474 39963"), "9347439963");
  assert.equal(phone10("12345"), "");
  assert.deepEqual(splitNames("HEMANTH, RAKESH"), ["HEMANTH", "RAKESH"]);
  assert.deepEqual(splitNames("Faraaz "), ["Faraaz"]);
  assert.deepEqual(processSteps("TR1, TR2, TR 3 , HR"), ["TR1", "TR2", "TR3", "HR"]);
});

const header = [
  "Product", "Date of entry", "Interview Date", "Interview Timings", "Job ID", "Company Name", "Candidate Name", "Candidate\nMobile No",
  "Candidate Resume", "Round Category", "Interview Process", "Candidate's Status", "Prep Given", "Prep given by", "Prep Date", "Prep Time",
  "Prep Document", "Remarks", "HubSpot Link", "", "Company Interview Mode", "Meeting link ", "Interview Recording Link", "Transcript Link",
  "Drilldown link", "Completion Date & Time", "Extra after Z",
];
const row = (over: Record<number, unknown>) => {
  const r: unknown[] = [
    "Edge", 46332, 46333, "16:00 - 17:00", "ABC-123", "Acme", "Ravi Kumar", "9876543210", "", "TR 1", "TR1, TR2", "", "", "", "", "", "", "",
    "", "", "Online", "", "", "", "https://docs.google.com/document/d/1Ay2yH80U7lwZBb4f6Z8UKSxym6mPUZP_9A/edit", "", "IGNORED",
  ];
  for (const [k, v] of Object.entries(over)) r[Number(k)] = v;
  return r;
};

test("columns by header; rows to preps; stable keys across moves; duplicates kept apart", () => {
  const cols = findPrepColumns(header);
  assert.equal(cols.prepBy, 14);
  assert.equal(cols.completion, 26);
  assert.throws(() => findPrepColumns(["Product", "Company Name"]), /missing/);
  const a = rowsToPreps([header, row({}), row({ 6: "Sita", 7: "9123456789" })], cols, 2026);
  const b = rowsToPreps([header, row({ 6: "Sita", 7: "9123456789" }), [], row({})], cols, 2026);
  assert.equal(a.length, 2);
  assert.equal(a[0].key, b[1].key);
  assert.equal(a[0].round, "TR1");
  assert.equal(a[0].interviewDay, "2026-11-07");
  assert.deepEqual([a[0].interviewTime?.start, a[0].interviewTime?.end], [960, 1020]);
  assert.equal(b[1].row, 4);
  const dup = rowsToPreps([header, row({}), row({})], cols, 2026);
  assert.notEqual(dup[0].key, dup[1].key);
  assert.equal(a[0].drilldownUrl.startsWith("https://"), true);
});

test("drag-filled years: entry never in a later year, interview typo follows the entry", () => {
  const cols = findPrepColumns(header);
  const [p] = rowsToPreps([header, row({ 1: "Jan 27 , 2027", 2: "Jan 27th , 2027" })], cols, 2026);
  assert.equal(p.entryDay, "2026-01-27");
  assert.equal(p.interviewDay, "2026-01-27");
  const [q] = rowsToPreps([header, row({ 1: "Dec 30, 2026", 2: "Jan 3, 2027" })], cols, 2026);
  assert.equal(q.interviewDay, "2027-01-03"); // a real next-year interview stays
});

test("yearless dates pick the year nearest the entry (December → January)", () => {
  assert.equal(parseDay("Jan 5", 2026, "2026-12-20"), "2027-01-05");
  assert.equal(parseDay("Dec 30", 2027, "2027-01-02"), "2026-12-30");
  assert.equal(parseDay("OCt 5", 2026, "2026-10-01"), "2026-10-05");
  const cols = findPrepColumns(header);
  const [p] = rowsToPreps([header, row({ 1: "Dec 20, 2026", 2: "Jan 5" })], cols, 2026, "2026-12-20");
  assert.equal(p.interviewDay, "2027-01-05");
});

test("a rescheduled copy keeps its own key whatever the row order; identical rows still differ", () => {
  const cols = findPrepColumns(header);
  const first = row({ 1: 46330 });
  const second = row({ 1: 46333, 2: 46335 });
  const a = rowsToPreps([header, first, second], cols, 2026);
  const b = rowsToPreps([header, second, first], cols, 2026);
  assert.equal(a[0].key, b[1].key);
  assert.equal(a[1].key, b[0].key);
  assert.notEqual(a[0].key, a[1].key);
  const twins = rowsToPreps([header, first, first], cols, 2026);
  assert.notEqual(twins[0].key, twins[1].key);
});

test("SLA: next-day interview → 45 minutes from entry", () => {
  const seen = atIst("2026-11-06", 15 * 60); // 3 PM IST
  const s = slaFor({ interviewDay: "2026-11-07", interviewTime: { start: 960, end: 1020 } }, seen, false);
  assert.equal(s.kind, "mandatory");
  assert.equal(s.dueAt!.getTime() - seen.getTime(), 45 * 60_000);
  // 3 PM today → 4 PM tomorrow is 25 h away: informed in time.
  assert.equal(s.informedLate, false);
});

test("SLA: later interview → 24 h before it; informed late flagged; baseline has none", () => {
  const seen = atIst("2026-11-06", 10 * 60);
  const later = slaFor({ interviewDay: "2026-11-09", interviewTime: { start: 14 * 60, end: null } }, seen, false);
  assert.equal(later.kind, "before_interview");
  assert.equal(later.dueAt!.toISOString(), atIst("2026-11-08", 14 * 60).toISOString());
  assert.equal(later.informedLate, false);
  const late = slaFor({ interviewDay: "2026-11-06", interviewTime: { start: 18 * 60, end: null } }, seen, false);
  assert.equal(late.kind, "mandatory");
  assert.equal(late.informedLate, true);
  assert.equal(slaFor({ interviewDay: "2026-11-07", interviewTime: null }, seen, true).kind, "none");
  assert.equal(slaFor({ interviewDay: null, interviewTime: null }, seen, false).dueAt, null);
});

test("open preps and days in IST", () => {
  assert.equal(isOpen({ prepStatus: "pending", interviewDay: "2026-11-07" }, "2026-11-07"), true);
  assert.equal(isOpen({ prepStatus: "pending", interviewDay: "2026-11-06" }, "2026-11-07"), false);
  assert.equal(isOpen({ prepStatus: "done", interviewDay: "2026-11-08" }, "2026-11-07"), false);
  assert.equal(dayOf(new Date("2026-11-06T19:00:00Z")), "2026-11-07"); // 00:30 IST
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("categories from the sheet's Product cell (the pool overrides)", () => {
  assert.deepEqual(categoryFromSheet("Academy Assessed"), { category: "academy", edgeVersion: null, note: "" });
  assert.equal(categoryFromSheet("Edge 2.0").edgeVersion, "2.0");
  assert.equal(categoryFromSheet("Edge").edgeVersion, null);
  assert.equal(categoryFromSheet("NIAT").note, "NIAT");
  assert.equal(categoryFromSheet("").category, "external");
});

console.log(`${passed} prep tests passed${process.exitCode ? " — with failures above" : ""}`);
