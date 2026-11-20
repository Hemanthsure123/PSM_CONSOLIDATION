/**
 * Eligible pool — offline self-test (no database, no sheets, no model):
 *   npx tsx scripts/pool-selftest.ts
 *
 * Covers: parsing the three sheets (columns by name, header rows, error cells, phone
 * normalisation, duplicates), the standing rules per product, CSV product detection, matching a
 * screened row to the pool (phone first, then user id), the shortlist priority order, the
 * strict-gate helper, and the project review's file grounding.
 */
import "./server-only-shim";
import { detectProduct, normalisePhone, parseAcademy, parseEdge1, parseEdge2, parseLevel } from "@/lib/pool/parse";
import { academyStanding, edge1Standing, edge2Standing, parseVerdict } from "@/lib/pool/standing";
import { edge2Details } from "@/lib/pool/details";
import { isAssessed, standingFor } from "@/lib/pool/match";
import { comparePriority, gateFailure, githubEvidenceScore, priorityGroup, shortlistBar } from "@/lib/domain-scoring";
import { groundPath, normalizeReview } from "@/lib/domain-project-review";
import type { CandidateStanding, InternalStanding } from "@/lib/pool/types";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// ── Parsing helpers ─────────────────────────────────────────────────────────
check("phone +91 with spaces", normalisePhone("+91 98765 43210") === "9876543210");
check("phone with leading 0", normalisePhone("09876543210") === "9876543210");
check("phone too short → null", normalisePhone("98765") === null);
check("level L4 → 4", parseLevel("L4") === 4);
check("level Below L1 → 0", parseLevel("Below L1") === 0);
check("verdict 'Low Hire'", parseVerdict("Low Hire") === "low_hire");
check("verdict 'Rejected'", parseVerdict("Rejected") === "rejected");

// ── Edge 2.0 ────────────────────────────────────────────────────────────────
const edge2Table = [
  ["name", "phone", "bqCandidateId", "Candidate Stage", "offlineOverallScore", "tr1OverallTechnicalScore", "TR2 mern fullstack Verdict", "TR2 genai Verdict", "Ignored column"],
  ["A", "9000000001", "u-1", "TR2 CLEARED", "120", "80", "Strong Hire", "", "x"],
  ["B", "9000000002", "u-2", "TR1 CLEARED", "100", "70", "Low Hire", "", "x"],
  ["C", "9000000003", "u-3", "Assessment Cleared", "90", "", "", "", "x"],
  ["D", "#N/A", "u-4", "TR2 CLEARED", "110", "75", "", "", "x"],
  ["", "", "", "", "", "", "", "", ""],
  ["A again", "+91 90000 00001", "u-1", "Assessment Cleared", "120", "", "", "", "x"],
];
const e2 = parseEdge2(edge2Table);
check("edge2 rows read (blank row skipped)", e2.rowsRead === 5, e2.rowsRead);
check("edge2 duplicate kept once", e2.records.length === 4, e2.records.length);
const a = e2.records.find((r) => r.userId === "u-1")!;
check("edge2 duplicate keeps the stronger row (TR-2)", edge2Standing(a).tier === 1);
check("edge2 TR-2 strong label", edge2Standing(a).label === "Edge 2.0 · TR-2 cleared · MERN Strong hire", edge2Standing(a).label);
const b = e2.records.find((r) => r.userId === "u-2")!;
check(
  "edge2 TR-1 cleared, low hire at TR-2 = not cleared → tier 2",
  edge2Standing(b).tier === 2 && edge2Standing(b).label === "Edge 2.0 · TR-1 cleared · TR-2 not cleared (MERN Low hire)",
  edge2Standing(b).label,
);
check("edge2 assessment → tier 3", edge2Standing(e2.records.find((r) => r.userId === "u-3")!).tier === 3);
const d = e2.records.find((r) => r.userId === "u-4")!;
check("edge2 #N/A phone → matched by user id", d.phone === null);
check("edge2 TR-2 by the sheet's stage alone (no verdict) → tier 1", edge2Standing(d).tier === 1 && edge2Standing(d).label === "Edge 2.0 · TR-2 cleared");
check("edge2 missing columns reported", parseEdge2([["name", "phone"]]).missingColumns.length === 1);

// The pool sheet as it is (Nov 2026): the drive's export, with the stage in a column that has NO
// header — and the drive's currentStage ("dsa_interview" …) beside it, which is not the stage.
const exportHead = [
  "id", "name", "phone", "currentStage", "journeyStatus (read-only)", "journeyReason (read-only)", "offlineOverallScore", "dsaCodingScore",
  "csFundamentalsScore", "dsaInterviewQualifyingStatus", "dsaInterviewAttemptStatus", "bqCandidateId", "tr1Status", "tr1OverallTechnicalScore", "interviewPath (read-only)",
  "combinedInterviewState (read-only)", "combinedInterviewVerdict (read-only)", "TR2 mern fullstack State", "TR2 mern fullstack Verdict",
  "TR2 gen ai State", "TR2 gen ai Verdict",
];
const exportRows = [
  // The reported case: MERN TR-2 strong hire, shown as "Assessment cleared" before the fix.
  ["TR2 CLEARED", "10", "A", "9000000010", "resume_based_interview", "open", "", "110.5", "80.5", "30", "Shortlisted", "", "x-1", "", "", "separate", "", "", "completed", "strong_hire", "", ""],
  // DSA interview shortlisted (the TR-1 AI interview said fail): TR-1 cleared; GenAI TR-2 booked.
  ["TR1 CLEARED", "1", "B", "9000000011", "resume_based_interview", "open", "", "120", "90", "30", "Shortlisted", "", "x-2", "fail", "40", "separate", "", "", "", "", "assigned", ""],
  // The AI interview said pass but the DSA interview did not shortlist: not a TR-1 clear (the sheet agrees).
  ["ASSESSMENT CLEARED", "2", "C", "9000000012", "dsa_interview", "open", "", "95", "70", "25", "Not Shortlisted", "", "x-3", "pass", "9", "separate", "", "", "", "", "", ""],
  // The combined interview: a medium hire is TR-2 cleared (no track).
  ["TR2 CLEARED", "3", "D", "9000000013", "combined_interview", "open", "", "130", "100", "30", "", "", "x-4", "", "", "combined", "completed", "medium_hire", "", "", "", ""],
  // A low hire in the combined interview leaves them at the assessment.
  ["ASSESSMENT CLEARED", "4", "E", "9000000014", "combined_interview", "open", "", "100", "80", "20", "", "", "x-5", "", "", "combined", "completed", "low_hire", "", "", "", ""],
  // "Not Shortlisted" before interviewing (no attempt, no scores, no AI interview): TR-1 not taken yet.
  ["ASSESSMENT CLEARED", "6", "G", "9000000016", "dsa_interview", "open", "", "100", "75", "25", "Not Shortlisted", "not_attempted", "x-7", "", "", "separate", "", "", "", "", "", ""],
  // A TR-2 booked after a TR-1 that is on record as not cleared does not lift them to TR-1 (the sheet agrees).
  ["ASSESSMENT CLEARED", "7", "H", "9000000017", "dsa_interview", "open", "", "100", "75", "25", "Not Shortlisted", "", "x-8", "fail", "30", "separate", "", "", "assigned", "", "", ""],
  // Journey closed: still in the pool, the details say so.
  ["ASSESSMENT CLEARED", "5", "F", "9000000015", "dsa_interview", "closed", "not_responding", "90", "70", "20", "", "", "x-6", "", "", "separate", "", "", "", "", "", ""],
];
for (const [label, table] of [
  ["stage column without a header", [["", ...exportHead], ...exportRows]],
  ["no stage column at all (the 18 Nov tab)", [exportHead, ...exportRows.map((r) => r.slice(1))]],
] as const) {
  const p = parseEdge2(table as unknown as string[][]);
  const by = (ph: string) => p.records.find((r) => r.phone === ph)!;
  const st = (ph: string) => edge2Standing(by(ph));
  check(`edge2 export (${label}): all rows read`, p.records.length === 8 && !p.missingColumns.length, p);
  check(`edge2 export (${label}): MERN strong hire → tier 1`, st("9000000010").tier === 1 && st("9000000010").label === "Edge 2.0 · TR-2 cleared · MERN Strong hire", st("9000000010"));
  check(`edge2 export (${label}): the stage is resolved, currentStage kept apart`, by("9000000010").candidateStage === "TR2 CLEARED" && by("9000000010").driveStage === "resume_based_interview");
  check(
    `edge2 export (${label}): DSA interview shortlisted → TR-1, booked TR-2 pending`,
    st("9000000011").tier === 2 && st("9000000011").label === "Edge 2.0 · TR-1 cleared · TR-2 pending (GenAI)",
    st("9000000011").label,
  );
  check(
    `edge2 export (${label}): AI interview pass but DSA interview not shortlisted → assessment`,
    st("9000000012").tier === 3 && st("9000000012").label === "Edge 2.0 · Assessment cleared · TR-1 not cleared",
    st("9000000012").label,
  );
  check(`edge2 export (${label}): combined medium hire → tier 1`, st("9000000013").tier === 1 && st("9000000013").label === "Edge 2.0 · TR-2 cleared · Combined interview Medium hire", st("9000000013").label);
  check(
    `edge2 export (${label}): combined low hire → assessment`,
    st("9000000014").tier === 3 && st("9000000014").label === "Edge 2.0 · Assessment cleared · Combined interview not cleared (Low hire)",
    st("9000000014").label,
  );
  check(`edge2 export (${label}): not interviewed yet → TR-1 not taken yet`, st("9000000016").tier === 3 && st("9000000016").label === "Edge 2.0 · Assessment cleared · TR-1 not taken yet" && edge2Details(by("9000000016")).includes("TR-1 (DSA interview): Not taken yet"), st("9000000016").label);
  check(`edge2 export (${label}): a booked TR-2 never overrides a failed TR-1`, st("9000000017").tier === 3 && st("9000000017").label === "Edge 2.0 · Assessment cleared · TR-1 not cleared", st("9000000017").label);
  check(`edge2 export (${label}): no sheet-vs-results disagreement logged`, !p.issues.some((x) => /raised/.test(x.problem)), p.issues);
  check(`edge2 export (${label}): detected as Edge 2.0`, detectProduct(table as unknown as string[][]) === "edge2");
  const details = edge2Details(by("9000000010"));
  check(
    `edge2 export (${label}): details carry every result`,
    details[0] === "Assessment: Cleared · 110.5/160 (DSA coding 80.5/120 · CS fundamentals 30/40)" &&
      details.includes("TR-1 (DSA interview): Cleared · Shortlisted") &&
      details.includes("TR-2: MERN Full Stack Strong hire (cleared)"),
    details,
  );
  check(`edge2 export (${label}): closed journey in the details`, edge2Details(by("9000000015")).includes("Drive journey: Closed (not responding)"), edge2Details(by("9000000015")));
  check(`edge2 export (${label}): combined interview in the details`, edge2Details(by("9000000013")).includes("Combined interview (TR-1 + TR-2): Medium hire (cleared)"), edge2Details(by("9000000013")));
}
{
  // A sheet stage below what the results prove is raised, and the row says so.
  const raised = parseEdge2([["", ...exportHead], ["ASSESSMENT CLEARED", ...exportRows[0].slice(1)]]);
  check("edge2 stage raised by the results", raised.records[0].candidateStage === "TR2 CLEARED" && raised.issues.some((x) => /raised to TR2 CLEARED/.test(x.problem)), raised.issues);
  // A column that merely mentions a stage now and then is not taken for the stage column.
  const noisy = parseEdge2([["notes", ...exportHead.slice(1)], ...exportRows.map((r, k) => [k === 0 ? "TR2 CLEARED" : "call back", ...r.slice(2)])]);
  // The export has "overallScore" left of "offlineOverallScore"; the offline score wins, the other only fills a gap.
  const both = parseEdge2([["phone", "bqCandidateId", "overallScore", "offlineOverallScore"], ["9000000021", "o-1", "", "91.86"], ["9000000022", "o-2", "88", ""]]);
  check("edge2 offlineOverallScore preferred over overallScore", both.records[0].offlineOverallScore === 91.86 && both.records[1].offlineOverallScore === 88, both.records.map((r) => r.offlineOverallScore));
  check("edge2 notes column is not the stage column", noisy.records.every((r) => r.sheetStage === ""), noisy.records.map((r) => r.sheetStage));
}

// ── Edge 1.0 ────────────────────────────────────────────────────────────────
const edge1Table = [
  ["User ID", "Name", "Assesment Selection Status", "TR-1 Selection Status", "Tr-2 Selection Status", "Phone Number", "Resume Link"],
  ["e-1", "P", "SELECTED", "Strong Hire", "Shortlisted", "8000000001", "https://x/1"],
  ["e-2", "Q", "SELECTED", "Medium Hire", "Rejected", "8000000002", ""],
  ["e-3", "R", "SELECTED", "Low Hire", "", "8000000003", ""],
  ["e-4", "S", "NOT SELECTED", "", "", "8000000004", ""],
];
const e1 = parseEdge1(edge1Table);
const s1 = (id: string) => edge1Standing(e1.records.find((r) => r.userId === id)!);
check("edge1 TR-2 shortlisted → tier 1", s1("e-1").tier === 1);
check("edge1 TR-1 medium, TR-2 rejected → tier 2", s1("e-2").tier === 2);
check("edge1 TR-1 low hire → assessment tier 3", s1("e-3").tier === 3);
check("edge1 assessment not selected → not eligible", s1("e-4").tier === 4 && !s1("e-4").eligible);

// ── Academy (two header rows: competency groups above their columns) ────────
const academyTable = [
  ["", "", "", "", "", "", "", "", "", "Frontend", "", "", "", "DSA", "", "", ""],
  ["UID", "Name", "Number", "Old Assessment Checks", "DSA Offline", "Bucket A TR1 Status", "Bucket A TR2 Status", "B Bucket TR1 Status", "C Bucket TR1 Status",
    "Overall Score (out of 100)", "Verdict Band", "Clearance Status", "Frontend Levels",
    "Overall Score (out of 100)", "Verdict Band", "Clearance Status", "DSA Levels"],
  ["a-1", "X", "7000000001", "Bucket A", "", "Strong Hire", "Shortlisted", "", "", "", "", "", "", "", "", "", ""],
  ["a-2", "Y", "7000000002", "Bucket B", "", "", "", "", "", "82", "Strong Hire", "Cleared", "L4", "", "", "", ""],
  ["a-3", "Z", "7000000003", "Bucket C", "", "", "", "", "Cleared", "", "", "", "", "", "", "", ""],
  ["a-4", "W", "7000000004", "", "27th Sep - Cleared", "Low Hire", "", "", "", "", "", "", "", "40", "Reject", "Not Cleared", "Below L2"],
];
const ac = parseAcademy(academyTable);
const sa = (id: string) => academyStanding(ac.records.find((r) => r.userId === id)!);
check("academy rows", ac.records.length === 4, ac.issues);
check("academy Bucket A TR-2 cleared → tier 1", sa("a-1").tier === 1);
check("academy Frontend L4 → tier 1", sa("a-2").tier === 1 && /Frontend L4/.test(sa("a-2").label), sa("a-2").label);
check("academy Bucket C TR-1 cleared → tier 2", sa("a-3").tier === 2);
check("academy A TR-1 low hire + DSA exam cleared → tier 3, eligible", sa("a-4").tier === 3 && sa("a-4").eligible);
{
  // Oct 2026: the sheet's phone column was renamed "StudentNumber".
  const renamed = academyTable.map((r, i) => (i === 1 ? r.map((c) => (c === "Number" ? "StudentNumber" : c)) : r));
  const rn = parseAcademy(renamed);
  check("academy phone column renamed StudentNumber", rn.records.length === 4 && rn.records[0].phone === "7000000001" && !rn.missingColumns.length, rn.missingColumns);
  check("detect academy with StudentNumber", detectProduct(renamed) === "academy");
}

// ── CSV product detection ───────────────────────────────────────────────────
check("detect edge2", detectProduct(edge2Table) === "edge2");
check("detect edge1", detectProduct(edge1Table) === "edge1");
check("detect academy (header on row 2)", detectProduct(academyTable) === "academy");
check("detect other sheet → null", detectProduct([["Name", "Email"]]) === null);

// ── Matching a screened row to the pool ─────────────────────────────────────
const standing = (tier: 1 | 2 | 3 | 4, phone: string | null, userId: string | null): CandidateStanding => ({
  candidateId: 1,
  phone,
  userId,
  name: "",
  bestProduct: "edge2",
  bestTier: tier,
  bestScore: 80,
  bestLabel: `tier ${tier}`,
  eligible: tier <= 3,
  standings: [],
});
const map: Record<string, CandidateStanding> = {
  "p:9000000001": standing(1, "9000000001", "u-1"),
  "u-1": standing(1, "9000000001", "u-1"),
  "u:u-9": standing(2, null, "u-9"),
};
check("match by phone (any format)", standingFor(map, "+91-90000-00001", "")?.matchedBy === "phone");
check("match by user id when no phone", standingFor(map, "", "U-9")?.tier === 2);
check("phone wins over user id", standingFor(map, "9000000001", "u-9")?.tier === 1);
check("no match → external", standingFor(map, "9999999999", "zzz") === null);

// ── Shortlist priority ──────────────────────────────────────────────────────
const internal = (tier: 1 | 2 | 3 | 4): InternalStanding => ({ tier, label: "", product: "edge2", score: 50, eligible: tier <= 3, matchedBy: "phone", standings: [] });
const cand = (name: string, domainScore: number, st: InternalStanding | null) => ({ name, domainScore, internal: st });
check("assessed bar is 40", shortlistBar(cand("x", 0, internal(2))) === 40);
check("external bar is 55", shortlistBar(cand("x", 0, null)) === 55);
check("not-eligible (tier 4) counts as external", shortlistBar(cand("x", 0, internal(4))) === 55 && !isAssessed(internal(4)));
check("assessed 60 → priority 1", priorityGroup(cand("x", 60, internal(3))) === 1);
check("assessed 45 → priority 2", priorityGroup(cand("x", 45, internal(1))) === 2);
check("assessed 35 → dropped", priorityGroup(cand("x", 35, internal(1))) === null);
check("external 90 → priority 3", priorityGroup(cand("x", 90, null)) === 3);
check("external 50 → dropped", priorityGroup(cand("x", 50, null)) === null);
const people = [
  cand("ext-95", 95, null),
  cand("asmt-60", 60, internal(3)),
  cand("tr2-56", 56, internal(1)),
  cand("tr1-90", 90, internal(2)),
  cand("tr2-45", 45, internal(1)),
  cand("tr2-80", 80, internal(1)),
];
const order = [...people].sort((x, y) => comparePriority(x, y, (c) => c.domainScore)).map((c) => c.name);
check(
  "order: P1 by stage then score → P2 → external",
  JSON.stringify(order) === JSON.stringify(["tr2-80", "tr2-56", "tr1-90", "asmt-60", "tr2-45", "ext-95"]),
  order,
);

// ── Strict gates (shared by ranking and the review budget) ──────────────────
const gc = { meetsMandatory: false, hasDomainExperience: true, leetcodeSolved: 0, githubCommits2y: 0, githubStatus: "checked", githubNote: "", presentationScore: 80 };
const gates = { mandatoryActive: true, requireExperience: false, minLeetcode: 0, minCommits: 0, checkPresentation: false, minPresentation: 0 };
check("gate: mandatory", gateFailure(gc, gates)?.gate === "mandatory");
check("gate: none when off", gateFailure(gc, { ...gates, mandatoryActive: false }) === null);
check("gate: commits explains a failed check", /unknown/.test(gateFailure({ ...gc, meetsMandatory: true, githubStatus: "failed" }, { ...gates, minCommits: 5 })?.reason ?? ""));

// ── GitHub score in the rank ────────────────────────────────────────────────
check("no review → static score", githubEvidenceScore({ githubScore: 70 }) === 70);
check("review blends 40/60", githubEvidenceScore({ githubScore: 70, projectReview: { status: "reviewed", score: 40 } }) === 52);
check("failed review ignored", githubEvidenceScore({ githubScore: 70, projectReview: { status: "failed", score: 0 } }) === 70);

// ── Project review grounding ────────────────────────────────────────────────
const paths = new Set(["client/src/App.jsx", "server/routes/auth.js", "server/models/User.js", "README.md"]);
check("ground ./ path", groundPath("./server/routes/auth.js", paths) === "server/routes/auth.js");
check("ground unique tail", groundPath("App.jsx", paths) === "client/src/App.jsx");
check("invented path dropped", groundPath("server/routes/payments.js", paths) === null);
const review = normalizeReview(
  {
    relevance: 90,
    completeness: 80,
    depth: 70,
    features: [
      { name: "JWT login", files: ["server/routes/auth.js", "server/models/User.js"] },
      { name: "Payments", files: ["server/routes/payments.js"] },
    ],
    covered: [{ requirement: "Express", files: ["server/routes/auth.js"] }],
    missing: ["Redis"],
    concerns: [],
    summary: "A MERN app with auth.",
  },
  paths,
);
check("features without real files dropped", review.features.length === 1 && review.features[0].name === "JWT login");
check("review score = 45/30/25 blend", review.score === Math.round(90 * 0.45 + 80 * 0.3 + 70 * 0.25), review.score);
const ungrounded = normalizeReview({ relevance: 95, completeness: 95, depth: 95, features: [{ name: "Everything", files: ["nope.js"] }], covered: [], missing: [], concerns: [], summary: "" }, paths);
check("ungrounded review capped at 30", ungrounded.score === 30 && ungrounded.concerns.length === 1);

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
