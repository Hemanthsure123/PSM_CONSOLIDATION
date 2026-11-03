/**
 * Standing lookup — offline self-test (no database):
 *   npx tsx scripts/standing-lookup-selftest.ts
 *
 * Covers reading the paste (UUIDs, phone formats, two ids on a line, headers, blank lines,
 * repeats, the row cap), the requirements (groups, the data they need, renamed keys, each text
 * item's wording, skipping items with no result, catalogue order), the rows (matched by phone or
 * UUID, UUID filled from the pool, external, not eligible, unrecognised, blank), the columns, the
 * summary, the clipboard formats, that the three standing columns match Domain shortlisting's
 * CSV exactly, and the marks: always columns of their own — "name (max)" with the marks alone,
 * verdict / date / recording beside them; best / latest / all attempts (per exam date, per
 * interview attempt); a duplicated interview counted once; the pool sheet filling in.
 */
import "./server-only-shim";
import {
  ASSESSED_ONLY,
  DEFAULT_LOOKUP_OPTIONS,
  MAX_LOOKUP_ROWS,
  PICKABLE,
  chooseAttempts,
  classifyCell,
  cleanRequirementKeys,
  includesNeeded,
  internalColumns,
  lookupRows,
  lookupTable,
  markAttempts,
  markKeys,
  parseLookupInput,
  picksAttempts,
  picksInterviews,
  picksMarks,
  productsNeeded,
  requirementLines,
  summarise,
  textKeys,
  toHtmlTable,
  toTsv,
  type LookupData,
} from "@/lib/pool/lookup";
import { standingFor } from "@/lib/pool/match";
import type { AssessmentScore } from "@/lib/pool/scores/catalogue";
import type { AcademyRecord, CandidateStanding, Edge1Record, Edge2Record } from "@/lib/pool/types";

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};

const U1 = "bf031394-f166-4408-8373-b2d7c85382fb";
const U2 = "13574a8f-66ac-4d34-ace6-b31f47716f6f";
const U3 = "070c0f89-3291-4e41-8053-861665a2941d";

// ── Reading the paste ────────────────────────────────────────────────────────
check("UUID", JSON.stringify(classifyCell(` ${U1.toUpperCase()} `)) === JSON.stringify({ userId: U1 }));
check("phone, plain", JSON.stringify(classifyCell("9876543210")) === JSON.stringify({ phone: "9876543210" }));
check("phone, +91 with spaces", JSON.stringify(classifyCell("+91 98765 43210")) === JSON.stringify({ phone: "9876543210" }));
check("phone, leading 0 and dashes", JSON.stringify(classifyCell("098765-43210")) === JSON.stringify({ phone: "9876543210" }));
check("phone, quoted", JSON.stringify(classifyCell('"9876543210"')) === JSON.stringify({ phone: "9876543210" }));
check("a word is neither", classifyCell("Cleared") === null && classifyCell("Name") === null);
check("a short code is neither", classifyCell("A12") === null);
check("a 7-digit number is neither", classifyCell("1234567") === null);
check("digits that aren't a phone are not recognised (a mistyped number)", classifyCell("987654321") === null && classifyCell("98765432101") === null);
check("an all-digit UUID is still a UUID", JSON.stringify(classifyCell("12345678-1234-1234-1234-123456789012")) === JSON.stringify({ userId: "12345678-1234-1234-1234-123456789012" }));
check("a UUID without dashes", JSON.stringify(classifyCell("bf031394f16644088373b2d7c85382fb")) === JSON.stringify({ userId: "bf031394f16644088373b2d7c85382fb" }));

{
  const p = parseLookupInput(["UUID\tPhone\tName", `${U1}\t8849577323\tMirat`, "", "  9059309747  ", "Mirat Parmar", `${U3}`, `${U1}`, "", ""].join("\r\n"));
  check("header row left out", p.headerSkipped);
  check("every line keeps its place (trailing blanks dropped)", p.rows.map((r) => r.line).join() === "2,3,4,5,6,7", p.rows.map((r) => r.line));
  check("two ids on one line", p.rows[0].userId === U1 && p.rows[0].phone === "8849577323");
  check("blank line kept as blank", p.rows[1].problem === "blank");
  check("trimmed phone", p.rows[2].phone === "9059309747" && !p.rows[2].problem);
  check("a name is not recognised", p.rows[3].problem === "unrecognised");
  check("counts", JSON.stringify(p.counts) === JSON.stringify({ ids: 4, userIds: 3, phones: 2, unrecognised: 1, duplicates: 0 }), p.counts);
  const dup = parseLookupInput(`${U1}\n${U1}\n${U2}`);
  check("repeats counted", dup.counts.duplicates === 1 && !dup.headerSkipped);
  const commas = parseLookupInput(`${U2},9876543210`);
  check("comma separated", commas.rows[0].userId === U2 && commas.rows[0].phone === "9876543210");
  const big = parseLookupInput(Array.from({ length: MAX_LOOKUP_ROWS + 5 }, (_, i) => String(9000000000 + i)).join("\n"));
  check("capped at the lookup limit", big.rows.length === MAX_LOOKUP_ROWS && big.overflow === 5);
  check("no header when the first line is an id", !parseLookupInput(`${U1}\nuuid`).headerSkipped);
  check("empty paste", parseLookupInput("  \n\n").rows.length === 0);
}

// ── Fixtures: the pool ───────────────────────────────────────────────────────
const ident = (name: string, phone: string | null, userId: string | null) => ({ name, phone, userId, referenceResumeUrl: null });
const edge2: Edge2Record = {
  product: "edge2",
  ...ident("Mirat Parmar", "8849577323", U1),
  referenceResumeUrl: "https://example.com/mirat.pdf",
  candidateStage: "TR2 CLEARED",
  offlineOverallScore: 112.5,
  dsaCodingScore: 86,
  csFundamentalsScore: 26.5,
  sqlMcqScore: 12,
  sqlCodingScore: null,
  tr1: { selfIntro: 7, dsaOverall: 8, problemSolving: 7.5, coding: 8, communication: null, debugging: 7, overallTechnical: 78 },
  tr2: [
    { track: "mern_fullstack", verdict: "strong_hire" },
    { track: "genai", verdict: "rejected" },
  ],
};
const academy: AcademyRecord = {
  product: "academy",
  ...ident("Mirat Parmar", "8849577323", U1),
  yog: 2025,
  oldBucket: "B",
  dsaOfflineStatus: "27th Sep - Cleared",
  dsaOfflineCleared: true,
  previousPlacement: "",
  studentPreference: "Frontend",
  activePool: true,
  rounds: [
    { bucket: "A", round: 1, score: 78, status: "Strong Hire", cleared: true },
    { bucket: "A", round: 2, score: null, status: "", cleared: false },
  ],
  competency: [
    { subject: "frontend", overallScore: 82, verdictBand: "Strong", clearanceStatus: "Cleared", cleared: true, level: 4, levelLabel: "L4" },
    { subject: "dsa", overallScore: null, verdictBand: "", clearanceStatus: "", cleared: false, level: 0, levelLabel: "" },
  ],
};
const edge1: Edge1Record = { product: "edge1", ...ident("Uday Prasanna", "9059309747", U2), assessmentStatus: "SELECTED", tr1Status: "Medium Hire", tr2Status: "Rejected" };

const mirat: CandidateStanding = {
  candidateId: 11,
  phone: "8849577323",
  userId: U1,
  name: "Mirat Parmar",
  bestProduct: "edge2",
  bestTier: 1,
  bestScore: 93,
  bestLabel: "Edge 2.0 · MERN TR-2 · Strong hire",
  eligible: true,
  standings: [
    { product: "edge2", tier: 1, label: "Edge 2.0 · MERN TR-2 · Strong hire", score: 93, eligible: true },
    { product: "academy", tier: 2, label: "Academy · Bucket A TR-1 Strong hire", score: 74, eligible: true },
  ],
};
const uday: CandidateStanding = {
  candidateId: 12,
  phone: "9059309747",
  userId: U2,
  name: "Uday Prasanna",
  bestProduct: "edge1",
  bestTier: 2,
  bestScore: 62,
  bestLabel: "Edge 1.0 · TR-1 Medium hire · TR-2 not cleared",
  eligible: true,
  standings: [{ product: "edge1", tier: 2, label: "Edge 1.0 · TR-1 Medium hire · TR-2 not cleared", score: 62, eligible: true }],
};
const notEligible: CandidateStanding = {
  candidateId: 13,
  phone: "7000000001",
  userId: null,
  name: "Not Selected",
  bestProduct: "edge1",
  bestTier: 4,
  bestScore: 10,
  bestLabel: "Edge 1.0 · Assessment not cleared",
  eligible: false,
  standings: [{ product: "edge1", tier: 4, label: "Edge 1.0 · Assessment not cleared", score: 10, eligible: false }],
};
const data: LookupData = {
  standings: { [`p:${mirat.phone}`]: mirat, [`u:${U1}`]: mirat, [`p:${uday.phone}`]: uday, [`u:${U2}`]: uday, [`p:${notEligible.phone}`]: notEligible },
  records: { "11": { edge2, academy }, "12": { edge1 } },
};

// ── Requirements ─────────────────────────────────────────────────────────────
check("keys are unique", new Set(PICKABLE.map((r) => r.key)).size === PICKABLE.length);
check("every group has items", ["candidate", "exams", "competency", "bucket", "academy", "edge2", "edge1"].every((g) => PICKABLE.some((r) => r.group === g)));
check("no data for standing-only items", includesNeeded(["name", "other-products", "internal-score"]).length === 0);
check("products in a fixed order", productsNeeded(["academy.preference", "edge1.tr1", "edge2.tr2"]).join() === "edge2,edge1,academy");
check("marks read the marks and the Academy record; profile items the profile", includesNeeded(["marks.dsa_offline", "college"]).join() === "academy,scores,profile");
check("stale keys dropped, catalogue order", cleanRequirementKeys(["edge1.tr2", "gone", "name"]).join() === "name,edge1.tr2");
check("renamed keys keep working", cleanRequirementKeys(["academy.yog", "academy.competency.dsa", "academy.old-bucket"]).join() === "yog,marks.old_offline,marks.dsa_interview");
check("the old Bucket interviews item became every bucket round", cleanRequirementKeys(["academy.interviews"]).join() === "marks.bucket_a_tr1,marks.bucket_a_tr2,marks.bucket_b_tr1,marks.bucket_b_tr2,marks.bucket_c_tr1");
check("marks / interviews / attempts detected", picksMarks(["marks.bucket_b_tr1"]) && picksInterviews(["marks.bucket_b_tr1"]) && !picksInterviews(["marks.dsa_offline"]) && !picksAttempts(["edge2.assessment"]) && !picksMarks(["college", "edge2.tr2"]));
check("text and mark keys split", textKeys(["edge2.assessment", "name", "marks.dsa_offline"]).join() === "name" && markKeys(["edge2.assessment", "name", "marks.dsa_offline"]).join() === "marks.dsa_offline,edge2.assessment");
{
  const all = PICKABLE.map((r) => r.key);
  const lines = requirementLines({ standing: mirat, records: { edge2, academy } }, all);
  const want = [
    "Name: Mirat Parmar",
    "Year of graduation: 2025",
    "Resume: https://example.com/mirat.pdf",
    "Also: Academy · Bucket A TR-1 Strong hire",
    "Score within stage: 93/100",
    "Academy active pool: Yes",
    "Academy preference: Frontend",
    "Edge 2.0 stage: TR2 CLEARED",
    "Edge 2.0 TR-2: MERN Strong hire · GenAI Rejected",
  ];
  check("text items worded, marks never in the cell, missing ones skipped", JSON.stringify(lines) === JSON.stringify(want), lines);
  const picked = requirementLines({ standing: uday, records: { edge1 } }, ["edge2.tr2", "edge1.tr1", "edge1.tr2", "other-products"]);
  check("only picked items with a result", JSON.stringify(picked) === JSON.stringify(["Edge 1.0 TR-1: Medium Hire", "Edge 1.0 TR-2: Rejected"]), picked);
}

// ── Rows ─────────────────────────────────────────────────────────────────────
{
  const input = parseLookupInput(["UUID", U1, "9059309747", "", "7000000001", U3, "hello"].join("\n"));
  const rows = lookupRows(input, data, ["edge2.tr2", "edge1.tr1"]);
  const [byUuid, byPhone, blank, tier4, external, junk] = rows;
  check("matched by UUID", byUuid.status === "internal" && byUuid.cells["Internal Standing"] === "Edge 2.0 · MERN TR-2 · Strong hire" && byUuid.cells["Internal Stage"] === "TR-2 / top" && byUuid.cells["Internal Product"] === "Edge 2.0", byUuid);
  check("matched by phone, UUID filled from the pool", byPhone.status === "internal" && byPhone.uuid === U2 && byPhone.cells["Matched In Pool By"] === "Phone", byPhone);
  check("requirements per person", byUuid.requirements.join("|") === "Edge 2.0 TR-2: MERN Strong hire · GenAI Rejected" && byPhone.requirements.join("|") === "Edge 1.0 TR-1: Medium Hire");
  check("blank stays blank", blank.status === "blank" && Object.keys(blank.cells).length === 0);
  check("not eligible says so", tier4.status === "not-eligible" && tier4.cells["Internal Standing"] === "Edge 1.0 · Assessment not cleared (not eligible)" && tier4.cells["Internal Stage"] === "Not eligible");
  check("unknown id is external", external.status === "external" && external.cells["Internal Standing"] === "External" && !external.cells["Internal Stage"]);
  check("unrecognised line flagged", junk.status === "unrecognised" && junk.cells["Internal Standing"] === "Not a UUID or phone number");
  check("job eligibility: the pool's eligible / not cleared / unknown", byUuid.eligibility === "eligible" && byPhone.eligibility === "eligible" && tier4.eligibility === "not-eligible" && external.eligibility === null && junk.eligibility === null);

  const t = lookupTable(rows, { phoneColumn: input.counts.phones > 0, keys: ["edge2.tr2", "edge1.tr1"] });
  check("columns", t.headers.join("|") === "UUID|Phone|Internal Standing|Internal Stage|Internal Product|Job Eligibility|Requirements", t.headers);
  check("Job Eligibility column", t.rows.map((r) => r["Job Eligibility"]).join("|") === "Eligible|Eligible||Not eligible||", t.rows.map((r) => r["Job Eligibility"]));
  check("one output row per pasted row", t.rows.length === rows.length);
  check("no phone column for a UUID-only paste", lookupTable(lookupRows(parseLookupInput(U1), data, []), { phoneColumn: false, keys: [] }).headers.join("|") === "UUID|Internal Standing|Internal Stage|Internal Product|Job Eligibility");
  const multi = lookupRows(parseLookupInput(U1), data, ["edge2.stage", "edge2.tr2"]);
  check("Requirements is one column, one line per item", lookupTable(multi, { phoneColumn: false, keys: ["edge2.stage", "edge2.tr2"] }).rows[0].Requirements === "Edge 2.0 stage: TR2 CLEARED\nEdge 2.0 TR-2: MERN Strong hire · GenAI Rejected");
  const each = lookupTable(multi, { phoneColumn: false, keys: ["name", "edge2.stage"], options: { ...DEFAULT_LOOKUP_OPTIONS, layout: "columns" } });
  check("…or a column each", each.headers.slice(5).join("|") === "Name|Edge 2.0 stage" && each.rows[0]["Edge 2.0 stage"] === "TR2 CLEARED", each.headers);

  const s = summarise(rows);
  check("summary", JSON.stringify(s) === JSON.stringify({ looked: 4, internal: 2, byTier: { 1: 1, 2: 1, 3: 0 }, notEligible: 1, assessedOnly: 0, external: 1, unrecognised: 1, byProduct: { edge2: 1, edge1: 1, academy: 0 } }), s);
}

// ── Marks: columns of their own ─────────────────────────────────────────────
{
  const sc = (
    assessment: AssessmentScore["assessment"],
    score: number,
    maxScore: number,
    takenOn: string | null,
    result: string,
    sourceKey: string,
    attempt = "1",
    recordingUrl: string | null = null,
  ): AssessmentScore => ({ assessment, score, maxScore, takenOn, result, passed: null, recordingUrl, sourceKey, attempt });
  const scores = [
    sc("old_offline", 153.5, 230, null, "Bucket B", "old_offline", "cycle-4"),
    sc("dsa_offline", 30, 130, "2026-09-27", "Not Qualified", "dsa_offline@2026-09-27"),
    sc("dsa_offline", 92, 130, "2026-10-11", "Qualified", "dsa_offline@2026-10-11"),
    sc("dsa_offline", 57, 130, "2026-10-25", "Qualified", "dsa_offline@2026-10-25"),
    sc("bucket_a_tr1", 65, 100, "2026-02-12", "", "bucket_a_tr1:scheduled", "2026-02-12", "https://drive.google.com/a1"),
    sc("bucket_b_tr1", 8.5, 15, "2026-03-07", "Moved to TR2", "bucket_b_tr1:audit", "2026-03-07"),
    sc("bucket_b_tr1", 12.33, 15, "2026-08-21", "Cleared", "bucket_b_tr1:app", "2026-08-21", "https://drive.google.com/b1"),
    sc("bucket_b_tr1", 12.33, 15, "2026-08-21", "Good – Hire · Cleared", "bucket_b_tr1:audit", "2026-08-21"),
  ];
  const d: LookupData = { ...data, scores: { "11": scores } };
  const rowsFor = (keys: string[]) => lookupRows(parseLookupInput(U1), d, keys);
  const keys = ["marks.old_offline", "marks.dsa_offline", "marks.frontend_interview", "marks.bucket_a_tr1", "marks.bucket_b_tr1", "marks.bucket_c_tr1", "edge2.assessment"];
  const rows = rowsFor(keys);
  const best = lookupTable(rows, { phoneColumn: false, keys });
  const base = "UUID|Internal Standing|Internal Stage|Internal Product|Job Eligibility";
  check(
    "marks: header = name (max), verdict and recording beside it",
    best.headers.join("|") ===
      [
        base,
        "Old offline assessment (230)",
        "Old offline assessment – verdict",
        "DSA offline exam (130)",
        "DSA offline exam – verdict",
        "Frontend competency interview (100)",
        "Frontend competency interview – verdict",
        "Frontend competency interview – recording",
        "Bucket A TR-1 (100)",
        "Bucket A TR-1 – verdict",
        "Bucket A TR-1 – recording",
        "Bucket B TR-1 (15)",
        "Bucket B TR-1 – verdict",
        "Bucket B TR-1 – recording",
        "Bucket C TR-1",
        "Bucket C TR-1 – verdict",
        "Bucket C TR-1 – recording",
        "Edge 2.0 offline (160)",
        "Edge 2.0 DSA coding (120)",
        "Edge 2.0 CS fundamentals (40)",
        "Edge 2.0 SQL MCQ (15)",
        "Edge 2.0 SQL coding (15)",
      ].join("|"),
    best.headers,
  );
  const v = best.rows[0];
  check("a marks cell holds only the marks obtained", v["DSA offline exam (130)"] === "92" && v["Old offline assessment (230)"] === "153.5" && v["Edge 2.0 offline (160)"] === "112.5" && v["Edge 2.0 SQL coding (15)"] === "", v);
  check("verdicts in their own columns", v["DSA offline exam – verdict"] === "Qualified" && v["Old offline assessment – verdict"] === "Bucket B");
  check("an interview not in the interview sheets: the pool sheet's score and verdict", v["Frontend competency interview (100)"] === "82" && v["Frontend competency interview – verdict"] === "L4 · Strong · Cleared" && v["Frontend competency interview – recording"] === "");
  check("Bucket A TR-1 without a verdict in its sheet: the pool sheet's", v["Bucket A TR-1 (100)"] === "65" && v["Bucket A TR-1 – verdict"] === "Strong Hire" && v["Bucket A TR-1 – recording"] === "https://drive.google.com/a1");
  check("the same interview in two sheets counted once, keeping the recording", v["Bucket B TR-1 (15)"] === "12.33" && v["Bucket B TR-1 – verdict"] === "Cleared" && v["Bucket B TR-1 – recording"] === "https://drive.google.com/b1");
  check("no result = empty cells", v["Bucket C TR-1"] === "" && v["Bucket C TR-1 – verdict"] === "");

  const latest = lookupTable(rows, { phoneColumn: false, keys: ["marks.dsa_offline"], options: { ...DEFAULT_LOOKUP_OPTIONS, attempts: "latest", date: true } });
  check("latest attempt, with its date", latest.rows[0]["DSA offline exam (130)"] === "57" && latest.rows[0]["DSA offline exam – date"] === "25 Oct 2026", latest.rows[0]);
  const plain = lookupTable(rows, { phoneColumn: false, keys: ["marks.dsa_offline", "marks.old_offline"], options: { ...DEFAULT_LOOKUP_OPTIONS, verdict: false, date: true } });
  check("marks alone (verdict off); the old offline assessment's date is its cycle", plain.headers.slice(5).join("|") === "Old offline assessment (230)|Old offline assessment – date|DSA offline exam (130)|DSA offline exam – date" && plain.rows[0]["Old offline assessment – date"] === "Cycle 4", plain.headers);

  const all = lookupTable(rowsFor(["marks.dsa_offline", "marks.bucket_b_tr1"]), { phoneColumn: false, keys: ["marks.dsa_offline", "marks.bucket_b_tr1"], options: { ...DEFAULT_LOOKUP_OPTIONS, attempts: "all", verdict: false, recording: false } });
  check(
    "all attempts: an exam per date, an interview per attempt (oldest first)",
    all.headers.slice(5).join("|") === "DSA offline exam 27 Sep 2026 (130)|DSA offline exam 11 Oct 2026 (130)|DSA offline exam 25 Oct 2026 (130)|Bucket B TR-1 #1 (15)|Bucket B TR-1 #2 (15)",
    all.headers,
  );
  check("…with the marks of each", ["30", "92", "57", "8.5", "12.33"].every((x, i) => all.rows[0][all.headers[5 + i]] === x), all.rows[0]);
  check("chooseAttempts: a tie goes to the latest", chooseAttempts(markAttempts({ standing: mirat, records: {}, scores: [sc("dsa_offline", 50, 130, "2026-09-27", "", "a"), sc("dsa_offline", 50, 130, "2026-10-25", "", "b")] }, ["marks.dsa_offline"])["marks.dsa_offline"], "best")[0].takenOn === "2026-10-25");
  const other = lookupTable(lookupRows(parseLookupInput(U1), { ...data, scores: { "11": [sc("dsa_offline", 60, 140, "2026-11-01", "", "x")] } }, ["marks.dsa_offline"]), { phoneColumn: false, keys: ["marks.dsa_offline"] });
  check("an exam set out of another maximum: that maximum in the header, the cell still only the marks", other.headers.includes("DSA offline exam (140)") && other.rows[0]["DSA offline exam (140)"] === "60", other);
  const two = `${U1}
${U2}`;
  const odd = lookupTable(
    lookupRows(parseLookupInput(two), { ...data, scores: { "11": [sc("dsa_offline", 60, 140, "2026-11-01", "", "x")], "12": [sc("dsa_offline", 57, 130, "2026-10-25", "", "y")] } }, ["marks.dsa_offline"]),
    { phoneColumn: false, keys: ["marks.dsa_offline"] },
  );
  check("a column mixing maxima keeps the usual one; only the odd mark says its maximum", odd.rows[0]["DSA offline exam (130)"] === "60/140" && odd.rows[1]["DSA offline exam (130)"] === "57", odd.rows);
  const tag = lookupTable(lookupRows(parseLookupInput(U1), data, ["marks.dsa_offline"]), { phoneColumn: false, keys: ["marks.dsa_offline"] });
  check("no marks stored: the pool sheet's tag as the verdict, no marks", tag.rows[0]["DSA offline exam (130)"] === "" && tag.rows[0]["DSA offline exam – verdict"] === "27th Sep - Cleared", tag.rows[0]);
  const mixed = lookupTable(rowsFor(["name", "marks.dsa_offline"]), { phoneColumn: false, keys: ["name", "marks.dsa_offline"] });
  check("text in Requirements, marks still in columns", mixed.headers.slice(5).join("|") === "Requirements|DSA offline exam (130)|DSA offline exam – verdict" && mixed.rows[0].Requirements === "Name: Mirat Parmar");
}

// ── Assessed, not in the eligible pool ──────────────────────────────────────
{
  const asha = { candidateId: 14, phone: "9000000099", userId: U3, name: "Asha", eligible: false };
  const marks: AssessmentScore[] = [
    { assessment: "dsa_offline", score: 41, maxScore: 130, takenOn: "2026-10-25", result: "Not Qualified", passed: false, recordingUrl: null, sourceKey: "dsa_offline@2026-10-25", attempt: "1" },
  ];
  const d: LookupData = { ...data, assessed: { [`u:${U3}`]: asha, "p:9000000099": asha }, scores: { "14": marks } };
  const keys = ["name", "internal-score", "other-products", "marks.dsa_offline"];
  const rows = lookupRows(parseLookupInput([U3, "9000000099", U1].join("\n")), d, keys);
  const [byId, byPhone, pool] = rows;
  check(
    "assessed outside the pool: their own standing text, Not eligible, no stage or product",
    byId.status === "assessed" && byId.eligibility === "not-eligible" && byId.cells["Internal Standing"] === ASSESSED_ONLY && !byId.cells["Internal Stage"] && !byId.cells["Internal Product"],
    byId,
  );
  check("…matched by phone too, the UUID filled in", byPhone.status === "assessed" && byPhone.uuid === U3, byPhone);
  check("…their name and marks; no stage score or other products", byId.requirements.join("|") === "Name: Asha" && byId.marks["marks.dsa_offline"]?.[0]?.score === 41, byId);
  check("a pool person is still matched first", pool.status === "internal" && pool.eligibility === "eligible");
  const t = lookupTable(rows, { phoneColumn: true, keys });
  check("their row in the table", t.rows[0]["Job Eligibility"] === "Not eligible" && t.rows[0]["DSA offline exam (130)"] === "41" && t.rows[2]["Job Eligibility"] === "Eligible", t.rows[0]);
  const s = summarise(rows);
  check("summary counts them apart", s.assessedOnly === 2 && s.internal === 1 && s.external === 0 && s.notEligible === 0, s);
  check("without the assessed list they are external", lookupRows(parseLookupInput(U3), data, [])[0].status === "external");
}

// ── Same three columns as Domain shortlisting ────────────────────────────────
{
  const st = standingFor(data.standings, "", U1);
  check("assessed", JSON.stringify(internalColumns(st, true)) === JSON.stringify({ "Matched In Pool By": "User ID", "Internal Standing": "Edge 2.0 · MERN TR-2 · Strong hire", "Internal Stage": "TR-2 / top", "Internal Product": "Edge 2.0" }));
  check("not checked vs external", internalColumns(null, false)["Internal Standing"] === "Not checked" && internalColumns(undefined, true)["Internal Standing"] === "External");
}

// ── Clipboard ────────────────────────────────────────────────────────────────
{
  const tsv = toTsv(["A", "B"], [{ A: "x\ty", B: 'say "hi"\nnext' }, { A: "plain" }]);
  check("TSV quotes tabs, quotes and line breaks", tsv === 'A\tB\n"x\ty"\t"say ""hi""\nnext"\nplain\t', JSON.stringify(tsv));
  const html = toHtmlTable(["A"], [{ A: "<b>&\nline" }]);
  check("HTML escaped, line breaks kept", html === "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>&lt;b&gt;&amp;<br>line</td></tr></tbody></table>", html);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
