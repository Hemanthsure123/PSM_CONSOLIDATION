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
check("edge2 TR-2 strong label", edge2Standing(a).label === "Edge 2.0 · MERN TR-2 · Strong hire", edge2Standing(a).label);
const b = e2.records.find((r) => r.userId === "u-2")!;
check("edge2 TR-1 cleared, low hire at TR-2 = not cleared → tier 2", edge2Standing(b).tier === 2 && /TR-2 not cleared/.test(edge2Standing(b).label));
check("edge2 assessment → tier 3", edge2Standing(e2.records.find((r) => r.userId === "u-3")!).tier === 3);
const d = e2.records.find((r) => r.userId === "u-4")!;
check("edge2 #N/A phone → matched by user id", d.phone === null);
check("edge2 combined-interview TR-2 (no track verdict) → tier 1", edge2Standing(d).tier === 1 && edge2Standing(d).label === "Edge 2.0 · TR-2 cleared");
check("edge2 missing columns reported", parseEdge2([["name", "phone"]]).missingColumns.includes("Candidate Stage"));

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
