/**
 * Standing lookup — offline self-test (no database):
 *   npx tsx scripts/standing-lookup-selftest.ts
 *
 * Covers reading the paste (UUIDs, phone formats, two ids on a line, headers, blank lines,
 * repeats, the row cap), the requirements (which products they need, each item's wording,
 * skipping items with no result, catalogue order), the rows (matched by phone or UUID, UUID
 * filled from the pool, external, not eligible, unrecognised, blank), the columns, the
 * summary, the clipboard formats, and that the three standing columns match Domain
 * shortlisting's CSV exactly.
 */
import "./server-only-shim";
import {
  MAX_LOOKUP_ROWS,
  REQUIREMENTS,
  classifyCell,
  cleanRequirementKeys,
  internalColumns,
  lookupRows,
  lookupTable,
  parseLookupInput,
  productsNeeded,
  requirementLines,
  summarise,
  toHtmlTable,
  toTsv,
  type LookupData,
} from "@/lib/pool/lookup";
import { standingFor } from "@/lib/pool/match";
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
check("keys are unique", new Set(REQUIREMENTS.map((r) => r.key)).size === REQUIREMENTS.length);
check("no products for standing-only items", productsNeeded(["name", "other-products", "internal-score"]).length === 0);
check("products in a fixed order", productsNeeded(["academy.yog", "edge1.tr1", "edge2.tr1"]).join() === "edge2,edge1,academy");
check("stale keys dropped, catalogue order", cleanRequirementKeys(["edge1.tr2", "gone", "name"]).join() === "name,edge1.tr2");
{
  const all = REQUIREMENTS.map((r) => r.key);
  const lines = requirementLines({ standing: mirat, records: { edge2, academy } }, all);
  const want = [
    "Name: Mirat Parmar",
    "Also: Academy · Bucket A TR-1 Strong hire",
    "Score within stage: 93/100",
    "Resume: https://example.com/mirat.pdf",
    "Edge 2.0 stage: TR2 CLEARED",
    "Edge 2.0 assessment: Offline 112.5/160 · DSA coding 86/120 · CS fundamentals 26.5/40 · SQL MCQ 12/15",
    "Edge 2.0 TR-1: Overall technical 78/100 · DSA 8/10 · Problem solving 7.5/10 · Coding 8/10 · Debugging 7/10 · Self intro 7/10",
    "Edge 2.0 TR-2: MERN Strong hire · GenAI Rejected",
    "Academy interviews: Bucket A TR-1 Strong Hire (78) · Bucket A TR-2 Not cleared",
    "Academy DSA competency: Below L1",
    "Academy Frontend competency: L4 · 82/100 · Strong · Cleared",
    "Academy old assessment: Bucket B",
    "Academy DSA offline: 27th Sep - Cleared",
    "Academy active pool: Yes",
    "Academy preference: Frontend",
    "Academy YOG: 2025",
  ];
  check("every item worded, missing ones skipped (no Edge 1.0, no backend / SE, no placement)", JSON.stringify(lines) === JSON.stringify(want), lines);
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

  const t = lookupTable(rows, { phoneColumn: input.counts.phones > 0, requirements: true });
  check("columns", t.headers.join("|") === "UUID|Phone|Internal Standing|Internal Stage|Internal Product|Requirements", t.headers);
  check("one output row per pasted row", t.rows.length === rows.length);
  check("no phone column for a UUID-only paste", lookupTable(lookupRows(parseLookupInput(U1), data, []), { phoneColumn: false, requirements: false }).headers.join("|") === "UUID|Internal Standing|Internal Stage|Internal Product");
  const multi = lookupRows(parseLookupInput(U1), data, ["edge2.stage", "edge2.tr2"]);
  check("Requirements is one column, one line per item", lookupTable(multi, { phoneColumn: false, requirements: true }).rows[0].Requirements === "Edge 2.0 stage: TR2 CLEARED\nEdge 2.0 TR-2: MERN Strong hire · GenAI Rejected");

  const s = summarise(rows);
  check("summary", JSON.stringify(s) === JSON.stringify({ looked: 4, internal: 2, byTier: { 1: 1, 2: 1, 3: 0 }, notEligible: 1, external: 1, unrecognised: 1, byProduct: { edge2: 1, edge1: 1, academy: 0 } }), s);
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
