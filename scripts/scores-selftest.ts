/**
 * Assessment scores — self-test.
 *   npx tsx scripts/scores-selftest.ts                 # offline: the readers of every export
 *   SCORES_TEST_DATABASE_URL=postgresql://…@127.0.0.1:…/db?sslmode=disable npx tsx scripts/scores-selftest.ts
 *                                                      # + the import against a LOCAL, migrated, EMPTY test database
 *                                                      #   (an import replaces its export's scores — never point it at real data)
 *
 * Offline: dates (with and without a year), verdicts, every export's shape as it really comes
 * (two header rows, a verdict under an unnamed column, two "Overall Score" columns, ids with junk,
 * no-shows, repeats), only the ONE final score read, the verdict and recording of each interview,
 * the export's identity and its people / profiles. Database: everyone assessed kept (a new
 * person only for a score, phones never taken over), the job-eligibility tag (the view
 * placement.assessed_people), idempotent re-import, a corrected score, the shrink guard, removal
 * on replace, profile ranks, recordings stored, the Find filter by eligibility, the summary.
 */
import "./server-only-shim";
import { dateFromName, formatDate, parseDate, parseScores, passedOf } from "@/lib/pool/scores/parse";
import type { Table } from "@/lib/pool/parse";

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
};

const TODAY = new Date("2026-10-30T10:00:00Z");
const U = (n: number) => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(n).padStart(12, "0")}`;
const ctx = (fileName: string, examDate?: string) => ({ fileName, examDate, today: TODAY });

// ── Dates and verdicts ───────────────────────────────────────────────────────
const dates: [string, string | null][] = [
  ["2026-03-13", "2026-03-13"],
  ["25-Sep-2026", "2026-09-25"],
  ["August 31, 2026", "2026-08-31"],
  ["Sep 13, 2026 at 04:17PM", "2026-09-13"],
  ["31/08/2026", "2026-08-31"],
  ["03/09/2026", "2026-09-03"],
  ["9/25/2026, 9:13:37 PM", "2026-09-25"],
  ["Mar 7", "2026-03-07"],
  ["Aug 23", "2026-08-23"],
  ["Nov 5", "2026-11-05"],
  ["Dec 20", "2025-12-20"],
  ["7 Mar", "2026-03-07"],
  ["31/02/2026", null],
  ["soon", null],
  ["", null],
];
for (const [raw, want] of dates) check(`date "${raw}"`, parseDate(raw, TODAY) === want, parseDate(raw, TODAY));
const names: [string, string | null][] = [
  ["Competency Assessments Results - 25th Oct SE Offline.csv", "2026-10-25"],
  ["Competency Assessments Results - 25oct DSA offline.csv", "2026-10-25"],
  ["Competency Assessments Results - 27 Sep Offline FE .csv", "2026-09-27"],
  ["Competency Assessments Results - 16th Aug - offline frontend engg.csv", "2026-08-16"],
  ["Competency Assessments Results - 11th Oct DSA Offline (1).csv", "2026-10-11"],
  ["DSA offline Oct 25 2025.csv", "2025-10-25"],
  ["Competency Assessments Results - DSA Offline.csv", null],
];
for (const [n, want] of names) check(`date in "${n}"`, dateFromName(n, TODAY) === want, dateFromName(n, TODAY));
check("formatDate", formatDate("2026-09-13") === "13 Sep 2026" && formatDate(null) === "");
check("verdicts", passedOf("Cleared") === true && passedOf("Qualified ") === true && passedOf("Shortlisted") === true);
check("negative verdicts", passedOf("Not Cleared") === false && passedOf("Not Qualified") === false && passedOf("Rejected") === false && passedOf("Reject") === false);
check("other verdicts are no verdict", passedOf("Moved to TR2 ( Non-Eliminating till Cycle 4)") === null && passedOf("") === null && passedOf("Strong Hire") === null);

// ── Old offline assessment (the assessed roster) ─────────────────────────────
{
  const t: Table = [
    ["User ID", "Student Name", "Mobile Number", "Email ID", "YOG", "Cycle", "Bucket", "overall_candidate_score", "Coding Exam user score", "DSA MCQs user score", "College ", "Bach. Degree", "Bach. Department"],
    [U(1), "Rudhran", "+91 73055 14664", "r@x.com", "2027", "Cycle 12", "Bucket - D", "75.37", "30.37", "1", "Hindustan Institute", "B Tech (Bachelor of Technology)", "Computer Science Engineering (CSE)"],
    [U(2), "Asha", "9876543210", "a@x.com", "#N/A", "Cycle 4", "Bucket - A", "227", "120", "10", "#REF!", "", ""],
    [U(3), "Too High", "9876543211", "", "2026", "Cycle 1", "Bucket - B", "231", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "", "", "", "", ""],
  ];
  const p = parseScores(t, ctx("Post Assessment eligible students for Placement Pool - Offline Attended - Old Process.csv"));
  check("old offline recognised", p.source === "old_offline" && p.assessment === "old_offline" && p.sourceKey === "old_offline" && !p.error, p);
  check("ONE final score (overall_candidate_score), not a section", p.rows[0].score === 75.37 && p.rows[0].maxScore === 230, p.rows[0]);
  check("bucket is the verdict, cycle the attempt", p.rows[0].result === "Bucket D" && p.rows[0].attempt === "cycle-12" && p.rows[0].takenOn === null && p.rows[0].passed === null);
  check("above the maximum: skipped with an issue", p.rows.length === 2 && p.issues.some((i) => /231/.test(i.problem)), p.issues);
  check("blank rows aren't read", p.rowsRead === 3);
  check("phone and name kept", p.people.find((x) => x.userId === U(1))?.phone === "7305514664" && p.people.find((x) => x.userId === U(1))?.name === "Rudhran");
  const prof = p.profiles.find((x) => x.userId === U(1));
  check("profile from the roster (rank 1)", p.profileRank === 1 && prof?.yog === 2027 && prof.college === "Hindustan Institute" && prof.department.startsWith("Computer"), prof);
  check("#N/A / #REF! read as empty", !p.profiles.some((x) => x.userId === U(2)), p.profiles);
}

// ── Competency offline exams ─────────────────────────────────────────────────
{
  const head = ["candidate_id", "attempt_status", "overall_total_score", "overall_candidate_score", "Problem Solving Coding max score", "Problem Solving Coding user score", "DSA MCQs max score", "DSA MCQs user score", "Qualified Status", "YOG", "Bootcamp"];
  const t: Table = [
    head,
    [U(1), "ATTEMPTED", "130", "57", "120", "50", "10", "7", "Qualified", "2025", "#N/A"],
    [U(2), "ATTEMPTED", "130", "28", "120", "25", "10", "3", "Not Qualified", "2026", "Batch 1"],
    [U(3), "NOT_ATTEMPTED", "130", "", "120", "", "10", "", "", "2027", "#N/A"],
    [U(1), "ATTEMPTED", "130", "60", "120", "55", "10", "5", "Qualified", "2025", "#N/A"],
  ];
  const p = parseScores(t, ctx("Competency Assessments Results - 25oct DSA offline.csv"));
  check("DSA offline exam, dated from the file name", p.assessment === "dsa_offline" && p.sourceKey === "dsa_offline@2026-10-25" && p.label === "DSA offline exam · 25 Oct 2026", p);
  check("the final score with its own maximum", p.rows.find((r) => r.userId === U(2))?.score === 28 && p.rows[0].maxScore === 130 && p.rows[0].takenOn === "2026-10-25");
  check("not attempted = skipped, not a score", p.skipped.some((s) => s.reason === "not_attempted" && s.count === 1) && !p.rows.some((r) => r.userId === U(3)), p.skipped);
  check("same candidate twice in one exam: the higher score", p.rows.filter((r) => r.userId === U(1)).length === 1 && p.rows.find((r) => r.userId === U(1))?.score === 60);
  check("verdict", p.rows.find((r) => r.userId === U(2))?.result === "Not Qualified" && p.rows.find((r) => r.userId === U(2))?.passed === false);
  check("YOG only fills gaps (rank 3), also for someone who didn't attempt", p.profileRank === 3 && p.profiles.length === 3, p.profiles);

  const subj = (col: string, name: string) => parseScores([["candidate_id", "attempt_status", "overall_total_score", "overall_candidate_score", `${col} max score`, `${col} user score`], [U(5), "ATTEMPTED", "100", "40", "50", "20"]], ctx(name)).assessment;
  check("subjects from the section headers", subj("HTML & CSS  MCQs", "27 Sep FE.csv") === "frontend_offline" && subj("Node JS MCQs", "25 Oct BE.csv") === "backend_offline" && subj("CS Fundamentals", "25 Oct SE.csv") === "software_offline");

  // 13 Sep: the verdict sits under an unnamed column; attempted_on carries the date.
  const shifted: Table = [
    ["candidate_id", "invited_on", "attempt_status", "overall_total_score", "overall_candidate_score", "attempted_on", "Problem Solving Coding max score", "Problem Solving Coding user score", "DSA MCQs user score", "", "", ""],
    [U(6), "Sep 12, 2026 at 01:26PM", "ATTEMPTED", "130", "91", "Sep 13, 2026 at 04:46PM", "120", "85", "6", "Qualified", "2027", "#N/A"],
    [U(7), "Sep 12, 2026 at 01:26PM", "ATTEMPTED", "130", "30", "Sep 13, 2026 at 04:17PM", "120", "25", "5", "Not Qualified", "2026", "Batch 1"],
  ];
  const s = parseScores(shifted, ctx("Competency Assessments Results - 13th Sep DSA offline.csv"));
  check("verdict found under an unnamed column", s.rows[0].result === "Qualified" && s.rows[1].result === "Not Qualified", s.rows);
  check("date from attempted_on", s.sourceKey === "dsa_offline@2026-09-13");

  // 16 Aug: "user_id", "Overall Score " and no maximum column; a "test" row.
  const aug: Table = [
    ["user_id", "Qualified status", "Attempt Status", "Overall Score ", "Problem Solving Coding user score", "DSA MCQs user score", "personalized_message"],
    [U(8), "Qualified ", "ATTEMPTED", "92", "85", "7", "Thank you…"],
    [U(9), "Not Qualified", "test", "25", "25", "0", "…"],
  ];
  const a = parseScores(aug, ctx("Competency Assessments Results - 16th Aug DSA - offline.csv"));
  check("older export: Overall Score, catalogue maximum, test row skipped", a.rows.length === 1 && a.rows[0].score === 92 && a.rows[0].maxScore === 130 && a.skipped[0]?.reason === "test", a);

  const undated = parseScores(t, ctx("Competency Assessments Results - DSA Offline.csv"));
  check("no date anywhere: ask for it", undated.needsDate && undated.rows.length === 0);
  check("…and the date given is used", parseScores(t, ctx("Competency Assessments Results - DSA Offline.csv", "2026-10-25")).sourceKey === "dsa_offline@2026-10-25");
}

// ── Competency interviews (sheet tabs) ───────────────────────────────────────
{
  const fe: Table = [
    ["Date", "UID", "Candidate Name", "Template", "Date", "Status", "HTML & CSS", "Overall Score ", "Overall Score (out of 100)", "Verdict Band", "Clearance Status ", "Levels ", "Recording Link"],
    ["", U(1), "Ajay", "Frontend Development", "August 31, 2026", "completed", "Card 1 — 3", "3.3", "66", "Medium Hire", "Cleared", "L3", "https://drive.google.com/file/d/rec1/view"],
    ["", `${U(2)} pav`, "Bavaji", "Frontend Development", "August 31, 2026", "completed", "", "1.5", "30", "Reject", "Not Cleared", "Below L1", "Not fetched yet — open the interview → ⋮ → Meet"],
    ["", U(3), "Krishnansu", "Frontend Development", "August 31, 2026", "no_show", "", "", "", "", "", "", ""],
    ["", U(1), "Ajay", "Frontend Development", "August 31, 2026", "completed", "", "3.8", "76", "Strong Hire", "Cleared", "L4", ""],
  ];
  const p = parseScores(fe, ctx("Frontend Development"));
  check("frontend interview", p.assessment === "frontend_interview" && p.sourceKey === "frontend_interview:log", p);
  check("the score out of 100, not the 1–5 average", p.rows[0].score === 66 && p.rows[0].maxScore === 100, p.rows[0]);
  check("verdict: level · band · clearance", p.rows[0].result === "L3 · Medium Hire · Cleared" && p.rows[0].passed === true);
  check("the recording link kept; text that isn't a link is no recording", p.rows[0].recordingUrl === "https://drive.google.com/file/d/rec1/view" && p.rows.find((r) => r.userId === U(2))?.recordingUrl === null);
  check("the Date column that has dates", p.rows[0].takenOn === "2026-08-31");
  check("an id with extra text is read, with a note", p.rows.some((r) => r.userId === U(2)) && p.issues.some((i) => /extra text/.test(i.problem)));
  check("no-show skipped", p.skipped.some((s) => s.reason === "no_show"));
  check("a repeat the same day is its own attempt", p.rows.filter((r) => r.userId === U(1)).map((r) => r.attempt).join() === "2026-08-31,2026-08-31#2");

  const dsa = (first: string) =>
    parseScores(
      [
        ["UID", "Candidate Name", "Template", "Date", "Status", first, "Overall Score (out of 100)", "Verdict Band", "Clearance Status ", "Level"],
        [U(4), "Vikas", "Programming with Problem Solving (DSA)", "26-Sep-2026", "completed", "5", "86.8", "Strong Hire", "Cleared", "L4"],
      ],
      ctx("DSA"),
    );
  check("DSA 2.0 and the discontinued format are separate exports", dsa("Problem 1 — Easy").sourceKey === "dsa_interview:v2" && dsa("Problem 1 -Approach").sourceKey === "dsa_interview:v1");
  check("the feedback tabs (no score out of 100) are not an export", Boolean(parseScores([["UID", "Template", "Final Verdict"], [U(1), "Frontend Development", "4"]], ctx("Feedback")).error));
}

// ── Bucket A / B interview sheets ────────────────────────────────────────────
{
  const b1: Table = [
    ["Interview ID", "Cycle", "Candidate ID", "Candidate Name", "Mobile Number", "Interview Date", "Interview Status", "Part 1", "", "Overall Summary", "", "Interview Recording Link", "Clearance Status", "", "", ""],
    ["", "", "", "", "", "", "", "Ownership", "Part 1 Avg", "Total (/15)", "Performance Band", "", "**Non-eliminating", "College Combined", "Bach. Degree", "Bach. Department"],
    ["INT-1", "Cycle - 1", U(1), "Gnana", "9014793593", "Mar 7", "Completed", "4", "3.75", "7.42", "Satisfactory – Conditional hire", "https://drive.google.com/file/d/b1/view?usp=drive_link", "Moved to TR2 ( Non-Eliminating till Cycle 4)", "VIT, Amaravati", "B Tech", "CSBS"],
    ["INT-2", "Cycle - 1", U(2), "Pradyumna", "7799577334", "Mar 7", "Completed", "3", "3.00", "12.5", "Good – Hire with positive feedback", "", "Cleared", "#N/A", "", ""],
  ];
  const p = parseScores(b1, ctx("Academy Bucket B - TR 1 - Interview Audit & Evaluation.csv"));
  check("Bucket B TR-1 audit: the sub-header's Total (/15)", p.assessment === "bucket_b_tr1" && p.sourceKey === "bucket_b_tr1:audit" && p.rows[0].score === 7.42 && p.rows[0].maxScore === 15, p.rows);
  check("dated without a year", p.rows[0].takenOn === "2026-03-07" && p.rows[0].attempt === "2026-03-07");
  check("verdict: performance band · clearance", p.rows[1].result === "Good – Hire with positive feedback · Cleared" && p.rows[1].passed === true && p.rows[0].passed === null, p.rows);
  check("the interview's recording", p.rows[0].recordingUrl === "https://drive.google.com/file/d/b1/view?usp=drive_link" && p.rows[1].recordingUrl === null);
  check("college from the sub-header, rank 2", p.profileRank === 2 && p.profiles[0]?.college === "VIT, Amaravati" && p.profiles.length === 1, p.profiles);

  const b2: Table = [
    ["Candidate UID", "Candidate Name", "interview Date", "Interview Status", "Overall Summary", "", "Cycle", "", "", ""],
    ["", "", "", "", "Total (/10)", "Performance Band", "", "Total Score( TR1 + TR2)", "Clearance Status ", "Final Status \n\n\n\n"],
    [U(3), "Bhanu", "2026-03-13", "Completed", "4.00", "Needs improvement", "Cycle 1", "10.67", "Not Cleared", "Not Cleared"],
    ["fv", "", "", "Completed", "5", "", "", "", "", ""],
  ];
  const q = parseScores(b2, ctx("Academy Bucket B - TR 2 - Interview Audit & Evaluation.csv"));
  check("Bucket B TR-2 audit: Total (/10), not the TR1 + TR2 total; band · final status", q.assessment === "bucket_b_tr2" && q.rows.length === 1 && q.rows[0].score === 4 && q.rows[0].result === "Needs improvement · Not Cleared" && q.rows[0].passed === false, q);
  check("a bad id is reported", q.issues.some((i) => /"fv"/.test(i.problem)));

  const app = (score: string, name: string) =>
    parseScores(
      [
        ["UID", "Candidate Name", "Candidate Email", "Template", "Date", "Status", "Final Verdict", score, "Recording Link", "Clearance Status"],
        [U(4), "karunyags2005@gmail.com", "x@y.com", "Academy Bucket B", "Aug 13", "completed", "4.4", "8.8", "Event not found in Calendar (check date / time)", "Cleared"],
        [U(5), "Vinayak", "v@y.com", "Academy Bucket B", "Aug 13", "cancelled", "", "0", "", ""],
      ],
      ctx(name),
    );
  const tr1 = app("Final Score ( 15 points)", "TR1 - Conducted in app.csv");
  const tr2 = app("Final Score (10)", "TR-2 Conducting in App.csv");
  check("in-app TR-1 / TR-2", tr1.sourceKey === "bucket_b_tr1:app" && tr2.sourceKey === "bucket_b_tr2:app" && tr2.rows[0].score === 8.8 && tr2.rows[0].maxScore === 10);
  check("a cancelled round's 0 is not a score", tr2.rows.length === 1 && tr2.skipped[0]?.reason === "cancelled");
  check("an email in the name column isn't kept as a name", tr2.people.find((x) => x.userId === U(4))?.name === "");
  check("in-app verdict; a calendar note is no recording", tr2.rows[0].result === "Cleared" && tr2.rows[0].recordingUrl === null);

  const a1 = parseScores(
    [
      ["UID", "Candidate Name", "Interview Date", "Interview Recording Link", "Interview status", "Communication", "Total Score (out of 100)", "NxtWave team scoring out of 100"],
      [U(6), "Vaishhnavi", "2026-02-12", "https://drive.google.com/file/d/a1/view", "Completed", "4", "65", ""],
      [U(7), "Saravanan", "2026-02-12", "", "Completed", "4", "", ""],
      [U(8), "Abhi", "2026-02-13", "", "Canceled", "", "", ""],
    ],
    ctx("Bucket A - Round 1 - Scheduled Interviews.csv"),
  );
  check("Bucket A TR-1 (no verdict in this sheet)", a1.assessment === "bucket_a_tr1" && a1.rows.length === 1 && a1.rows[0].score === 65 && a1.rows[0].maxScore === 100 && a1.rows[0].result === "" && a1.rows[0].recordingUrl === "https://drive.google.com/file/d/a1/view");
  check("completed without a score / canceled: skipped", a1.skipped.some((s) => s.reason === "no final score") && a1.skipped.some((s) => s.reason === "canceled"));

  const a2 = parseScores(
    [
      ["Candidate UID", "Candidate Name", "Interview Date", "Recording Link", "Interview status", "Project", "Overall Score", "Final Verdict By Nxtwave", "", "", "Placement Pool Eligibility "],
      ["", "", "", "", "", "Projects Explanation", "", "Frontend Bucket", "Backend Bucket", "Full Stack Bucket", ""],
      [U(9), "Gopisetti", "2026-02-19", "https://drive.google.com/file/d/a2/view", "Completed", "Understands", "50", "Medium Hire", "Low Hire", "Low Hire", "Shortlisted"],
    ],
    ctx("Bucket A - Round 2 - Scheduled Interviews.csv"),
  );
  check(
    "Bucket A TR-2: overall score; pool eligibility, then the panel's verdict per bucket",
    a2.assessment === "bucket_a_tr2" && a2.rows[0].score === 50 && a2.rows[0].result === "Shortlisted · Frontend Medium Hire · Backend Low Hire · Full Stack Low Hire" && a2.rows[0].passed === true && a2.rows[0].recordingUrl === "https://drive.google.com/file/d/a2/view",
    a2.rows,
  );
}

check("an unknown sheet is not imported", Boolean(parseScores([["Name", "Score"], ["x", "1"]], ctx("x.csv")).error));

// ── Database (only against a local test database) ────────────────────────────
async function dbTests(url: string) {
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("SCORES_TEST_DATABASE_URL must point at a local test database.");
  process.env.DATABASE_URL = url;
  const { query } = await import("@/lib/db/client");
  const { importScores } = await import("@/lib/pool/scores/sync");
  const { assessedOutsidePool, scoresFor, profilesFor, filterPeople, scoresSummary } = await import("@/lib/pool/scores/queries");
  const T = (n: number) => `ffffffff-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const clean = () => query("delete from placement.candidates where user_id like 'ffffffff-0000-4000-8000-%' or phone in ('9000000001', '9000000002')");
  await clean();
  const [{ other }] = await query<{ other: string }>("select count(*) other from placement.assessment_scores");
  if (Number(other) > 0) throw new Error("The test database already holds assessment scores — use an empty one (the test replaces whole exports).");
  // The eligible pool: T(1)…T(3) in the Academy pool. T(99) is in the database with the phone the roster gives T(2).
  for (const n of [1, 2, 3]) {
    const [{ id }] = await query<{ id: string }>("insert into placement.candidates (user_id, name) values ($1, $2) returning id", [T(n), `Pool ${n}`]);
    await query(
      `insert into placement.academy_records (candidate_id, uid, name, tier, stage_label, internal_score, eligible, row_hash, source)
       values ($1, $2, $3, 3, 'Academy · test', 50, true, 'h', 'csv')`,
      [id, T(n), `Pool ${n}`],
    );
  }
  await query("insert into placement.candidates (user_id, phone, name) values ($1, '9000000002', 'Someone else')", [T(99)]);
  await query("refresh materialized view placement.candidate_standing");

  const roster = (rows: [number, string, string, string][]): Table => [
    ["User ID", "Student Name", "Mobile Number", "YOG", "Cycle", "Bucket", "overall_candidate_score", "College"],
    ...rows.map(([n, score, phone, college]) => [T(n), `Student ${n}`, phone, "2026", "Cycle 1", "Bucket - B", score, college]),
  ];
  const twelve = Array.from({ length: 12 }, (_, i) => [i + 1, String(100 + i), i === 0 ? "9000000001" : i === 1 ? "9000000002" : "", "Test College of Engineering"] as [number, string, string, string]);
  const first = await importScores({ mode: "csv", sourceRef: "test", fileName: "Old Process.csv", table: roster(twelve) }, "selftest");
  check("db: everyone assessed is kept; the 9 not known before are added", first.ok && first.inserted === 12 && first.peopleAdded === 9 && first.profiles === 12, first);
  check("db: …and 3 of the 12 are eligible (in the eligible pool)", first.people === 12 && first.eligiblePeople === 3, first);
  check("db: a phone used by someone else is not taken", first.issues.some((i) => /9000000002/.test(i.problem)), first.issues);
  const [pool1] = await query<{ phone: string | null; name: string }>("select phone, name from placement.candidates where user_id = $1", [T(1)]);
  check("db: a pool person's missing phone is filled, their name kept", pool1.phone === "9000000001" && pool1.name === "Pool 1", pool1);
  const again = await importScores({ mode: "csv", sourceRef: "test", fileName: "Old Process.csv", table: roster(twelve) }, "selftest");
  check("db: re-import writes nothing", again.ok && again.unchanged === 12 && again.inserted + again.updated + again.removed === 0 && again.peopleAdded === 0, again);
  const corrected = twelve.map((r) => (r[0] === 3 ? ([3, "199", "", r[3]] as [number, string, string, string]) : r));
  const fix = await importScores({ mode: "csv", sourceRef: "test", fileName: "Old Process.csv", table: roster(corrected) }, "selftest");
  check("db: a corrected score is updated", fix.ok && fix.updated === 1 && fix.unchanged === 11);
  const shrink = await importScores({ mode: "csv", sourceRef: "test", fileName: "Old Process.csv", table: roster(corrected.slice(0, 5)) }, "selftest");
  check("db: a much smaller export asks first and changes nothing", !shrink.ok && shrink.needsConfirm?.existing === 12 && shrink.needsConfirm.incoming === 5, shrink);
  const [{ n }] = await query<{ n: string }>("select count(*) n from placement.assessment_scores s join placement.candidates c on c.id = s.candidate_id where c.user_id like 'ffffffff-0000-4000-8000-%'");
  check("db: …still 12 stored", Number(n) === 12);
  const replaced = await importScores({ mode: "csv", sourceRef: "test", fileName: "Old Process.csv", table: roster(corrected.slice(0, 5)), allowShrink: true }, "selftest");
  check("db: confirmed, the missing rows are removed", replaced.ok && replaced.removed === 7 && replaced.unchanged === 5);

  // An exam export: only people with a score are added; YOG fills gaps only.
  const exam: Table = [
    ["candidate_id", "attempt_status", "overall_total_score", "overall_candidate_score", "Problem Solving Coding user score", "Qualified Status", "YOG"],
    [T(1), "ATTEMPTED", "130", "88", "80", "Qualified", "2031"],
    [T(50), "ATTEMPTED", "130", "60", "55", "Qualified", "2027"],
    [T(51), "NOT_ATTEMPTED", "130", "", "", "", "2027"],
  ];
  const e = await importScores({ mode: "csv", sourceRef: "test", fileName: "Competency Assessments Results - 25oct DSA offline.csv", table: exam }, "selftest");
  check("db: exam import adds only the person with a score", e.ok && e.inserted === 2 && e.peopleAdded === 1 && e.eligiblePeople === 1, e);
  // An interview export with recordings.
  const interview: Table = [
    ["UID", "Candidate Name", "Template", "Date", "Status", "Recording Link", "Problem 1 — Easy", "Overall Score (out of 100)", "Verdict Band", "Clearance Status", "Level"],
    [T(1), "Pool 1", "Programming with Problem Solving (DSA)", "26-Sep-2026", "completed", "https://drive.google.com/file/d/r1/view", "4", "86.8", "Strong Hire", "Cleared", "L4"],
    [T(60), "Outside", "Programming with Problem Solving (DSA)", "26-Sep-2026", "completed", "https://drive.google.com/file/d/r2/view", "3", "70", "Medium Hire", "Cleared", "L3"],
  ];
  const iv = await importScores({ mode: "sheet", sourceRef: "test", fileName: "DSA 2.0 (current)", table: interview }, "selftest");
  check("db: interview import keeps both, 1 eligible", iv.ok && iv.inserted === 2 && iv.peopleAdded === 1 && iv.people === 2 && iv.eligiblePeople === 1, iv);

  const outside = await assessedOutsidePool([{ userId: T(1) }, { userId: T(50) }, { userId: T(51) }, { phone: "9000000001" }, { userId: T(99) }]);
  check(
    "db: the lookup finds people assessed outside the pool (not the pool person, nobody unassessed)",
    outside[`u:${T(50)}`]?.eligible === false && !outside[`u:${T(1)}`] && !outside["p:9000000001"] && !outside[`u:${T(51)}`] && !outside[`u:${T(99)}`],
    outside,
  );
  const tags = await query<{ user_id: string; eligible: boolean; job_eligibility: string; in_academy_pool: boolean; scores: number }>(
    "select user_id, eligible, job_eligibility, in_academy_pool, scores from placement.assessed_people where user_id = any($1::text[]) order by user_id",
    [[T(1), T(4), T(50), T(99)]],
  );
  check(
    "db: the view tags Eligible only the pool people; someone never assessed isn't in it",
    tags.map((t) => `${t.user_id.slice(-2)}:${t.job_eligibility}:${t.in_academy_pool}`).join() === "01:Eligible:true,04:Not eligible:false,50:Not eligible:false" && tags[0].scores === 3,
    tags,
  );
  const ids = [(await query<{ id: string }>("select id from placement.candidates where user_id = $1", [T(1)]))[0].id, outside[`u:${T(50)}`].candidateId].map(Number);
  const prof = await profilesFor(ids);
  check("db: the roster's year wins over the exam's; the exam fills a gap", prof[ids[0]]?.yog === 2026 && prof[ids[0]]?.college === "Test College of Engineering" && prof[ids[1]]?.yog === 2027, prof);
  const sc = await scoresFor(ids);
  check(
    "db: every score of a person, oldest first, with its recording",
    sc[ids[0]]?.map((x) => x.assessment).join() === "old_offline,dsa_interview,dsa_offline" && sc[ids[0]][1].recordingUrl === "https://drive.google.com/file/d/r1/view" && sc[ids[0]][1].result === "L4 · Strong Hire · Cleared",
    sc[ids[0]],
  );
  const f = await filterPeople({ colleges: ["test college"], assessment: "old_offline", minScore: 102 });
  check("db: filter by college and minimum marks, best first", f.people.map((x) => x.userId).join() === [T(3), T(5), T(4)].join() && f.people.map((x) => x.eligible).join() === "true,false,false", f.people);
  const el = await filterPeople({ colleges: ["test college"], eligibility: "eligible" });
  check("db: Find the eligible only", el.total === 3 && el.people.every((x) => x.eligible) && el.people.map((x) => x.userId).sort().join() === [T(1), T(2), T(3)].join(), el.people);
  const ne = await filterPeople({ yogs: [2026], eligibility: "not-eligible" });
  check("db: Find the not eligible only", ne.total === 9 && ne.people.every((x) => !x.eligible), ne);
  const sum = await scoresSummary();
  const old = sum.assessments.find((a) => a.key === "old_offline");
  check(
    "db: summary — people with marks, eligible / not, per assessment",
    sum.people.total === 7 && sum.people.eligible === 3 && sum.people.eligibleAcademy === 3 && sum.people.notEligible === 4 && old?.people === 5 && old.eligible === 3,
    sum.people,
  );
  check("db: the import log counts the people added", sum.recentImports.some((r) => r.sourceKey === "old_offline" && r.peopleAdded === 9));
  await clean();
  await query("refresh materialized view placement.candidate_standing");
}

(async () => {
  const url = process.env.SCORES_TEST_DATABASE_URL;
  if (url) await dbTests(url);
  console.log(`\n${passed} passed, ${failed} failed${url ? "" : " (offline; set SCORES_TEST_DATABASE_URL for the database checks)"}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
