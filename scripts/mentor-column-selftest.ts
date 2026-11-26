/**
 * The Mentor / Assigned Mentor column — offline self-test (no database; made-up people only):
 *   npx tsx scripts/mentor-column-selftest.ts
 *
 * Covers the label's wording ("<Mentor> · Mentor assigned · <Tech stack>", without the stack,
 * blank), blank and placeholder cells, the tech stack (TechStack, else the mentor's track), the
 * roster's display name, matching (phone's last 10 digits, then UID, then email; the first key
 * that finds a pool row decides; the matched record's ids as a fallback), and the column's place
 * right after Internal Standing in every output: Domain shortlisting's CSVs ("Assigned Mentor"),
 * the sheet-automation tab ("Mentor", inserted in place into an older tab) and the Standing
 * lookup ("Mentor"), with every other column keeping its order.
 */
import "./server-only-shim";
import { ANCHORED_COLUMNS, KEY_COLUMNS, deliveryTable, planHeaders, unscoredRow } from "@/lib/automation/delivery-rules";
import { domainCsv, type DomainCsvInput } from "@/lib/domain-csv";
import { lookupColumns, lookupRows, lookupTable, parseLookupInput, type LookupData } from "@/lib/pool/lookup";
import {
  ASSIGNED_MENTOR_HEADER,
  MENTOR_HEADER,
  buildMentorLabels,
  cleanCell,
  emailKey,
  mentorForRow,
  mentorKeys,
  mentorLabel,
  mentorLabelFor,
  mentorParts,
  phoneKey,
  uidKey,
  type PoolMentorRow,
} from "@/lib/pool/mentor-label";
import { techStackOf } from "@/lib/pool/mentors";
import { matchMentor, type RosterUser } from "@/lib/mobile/roster";
import type { AutomationPlan } from "@/lib/automation/types";
import type { CandidateStanding, InternalStanding } from "@/lib/pool/types";
import type { DomainCandidateOutcome, DomainReportResult } from "@/lib/types";

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};

// Made-up people (the repo is public).
const UID_A = "00000000-0000-4000-8000-00000000000a";
const UID_B = "00000000-0000-4000-8000-00000000000b";
const UID_C = "00000000-0000-4000-8000-00000000000c";
const UID_D = "00000000-0000-4000-8000-00000000000d";
const roster: RosterUser[] = [
  { email: "kiran.demo@example.com", name: "Kiran Demo", aliases: ["KD"], role: "member", active: true, leadEmail: null },
  { email: "old.mentor@example.com", name: "Old Mentor", aliases: [], role: "member", active: false, leadEmail: null },
];
const displayName = (sheetName: string) => matchMentor(sheetName, roster)?.name ?? null;

// ── The label ────────────────────────────────────────────────────────────────
{
  check("with a tech stack", mentorLabel("Kiran Demo", "MERN Stack") === "Kiran Demo · Mentor assigned · MERN Stack", mentorLabel("Kiran Demo", "MERN Stack"));
  check("without a tech stack", mentorLabel("Kiran Demo", null) === "Kiran Demo · Mentor assigned" && mentorLabel("Kiran Demo", "  ") === "Kiran Demo · Mentor assigned");
  check("no mentor → blank", mentorLabel("", "MERN") === "" && mentorLabel(null, "MERN") === "" && mentorLabel("   ", "") === "");
  check("placeholder cells mean nobody", ["-", "—", "NA", "N/A", "n.a.", "None", "nil", "Not assigned", "Unassigned", "TBD"].every((x) => mentorLabel(x, "MERN") === ""), ["-", "NA", "N/A"].map((x) => mentorLabel(x, "x")));
  check("a placeholder tech stack is no tech stack", mentorLabel("Kiran Demo", "NA") === "Kiran Demo · Mentor assigned");
  check("cells on one line, trimmed", mentorLabel("  Kiran \n Demo ", " Java\tBackend ") === "Kiran Demo · Mentor assigned · Java Backend" && cleanCell("\u0007x ") === "x");
  check("parts back for the screen", JSON.stringify(mentorParts("Kiran Demo · Mentor assigned · MERN Stack")) === JSON.stringify({ name: "Kiran Demo", techStack: "MERN Stack" }) && mentorParts("Kiran Demo · Mentor assigned")?.techStack === "" && mentorParts("") === null && mentorParts("Not a label") === null);
  check("headers", MENTOR_HEADER === "Mentor" && ASSIGNED_MENTOR_HEADER === "Assigned Mentor");
}

// ── Tech stack and the roster's name ─────────────────────────────────────────
{
  check("tech stack: the sheet's TechStack first", techStackOf(" MERN Stack ", "aiml") === "MERN Stack");
  check("…else the track the mentor chose", techStackOf(null, "fullstack") === "Full Stack" && techStackOf("", "aiml") === "AI/ML");
  check("…else none", techStackOf(null, null) === null && techStackOf("", "not-a-track") === null);
  check("roster name for an alias", displayName("kd") === "Kiran Demo" && displayName(" kiran DEMO ") === "Kiran Demo");
  check("not on the roster (or inactive): no roster name", displayName("Someone New") === null && displayName("Old Mentor") === null);
}

// ── Keys and matching ────────────────────────────────────────────────────────
const poolRows: PoolMentorRow[] = [
  { uid: UID_A, phone: "9000000001", email: "asha.test@example.com", mentorName: "KD", techStack: "MERN Stack", updatedAt: 1 },
  { uid: UID_B, phone: "9000000002", email: "bala.test@example.com", mentorName: "  Someone   New ", techStack: null, updatedAt: 1 },
  // Unassigned (stored with mentor_name = ''): in the pool, no mentor.
  { uid: UID_C, phone: "9000000003", email: "chitra.test@example.com", mentorName: "", techStack: "Java Backend", updatedAt: 1 },
  // The same phone twice: the row with a mentor wins over an unassigned duplicate.
  { uid: UID_D, phone: "9000000004", email: null, mentorName: "Kiran Demo", techStack: null, updatedAt: 1 },
  { uid: "00000000-0000-4000-8000-0000000000dd", phone: "9000000004", email: null, mentorName: "", techStack: null, updatedAt: 9 },
];
const labels = buildMentorLabels(poolRows, displayName);
{
  check("phone keys: last 10 digits", phoneKey("+91 90000 00001") === "9000000001" && phoneKey("09000000001") === "9000000001" && phoneKey("+091 9000000001") === "9000000001" && phoneKey("(+91) 90000 00001") === "9000000001" && phoneKey("12345") === null && phoneKey("") === null);
  check("…two numbers in one cell aren't guessed", phoneKey("9000000001 / 9000000002") === null);
  check("uid / email keys lower-cased", uidKey(` ${UID_A.toUpperCase()} `) === UID_A && emailKey(" Asha.Test@Example.com ") === "asha.test@example.com" && emailKey("not-an-email") === null && uidKey("has space") === null);
  check("key order: phone, UID, email", mentorKeys({ email: "a@b.co", userId: "abc123", phone: "9000000001" }).join("|") === "p:9000000001|u:abc123|e:a@b.co");
  check("roster display name + tech stack", labels["p:9000000001"] === "Kiran Demo · Mentor assigned · MERN Stack" && labels[`u:${UID_A}`] === labels["p:9000000001"] && labels["e:asha.test@example.com"] === labels["p:9000000001"], labels);
  check("not on the roster: the sheet's name, trimmed", labels["p:9000000002"] === "Someone New · Mentor assigned", labels["p:9000000002"]);
  check("unassigned: in the map, blank", "p:9000000003" in labels && labels["p:9000000003"] === "");
  check("a shared phone: the row with a mentor wins", labels["p:9000000004"] === "Kiran Demo · Mentor assigned", labels["p:9000000004"]);

  check("matched by phone (any format)", mentorLabelFor(labels, { phone: "+91 90000-00001" }) === "Kiran Demo · Mentor assigned · MERN Stack");
  check("then by UID (any case)", mentorLabelFor(labels, { phone: "9999999999", userId: UID_B.toUpperCase() }) === "Someone New · Mentor assigned");
  check("then by email", mentorLabelFor(labels, { phone: "", userId: "", email: "ASHA.TEST@example.com" }) === "Kiran Demo · Mentor assigned · MERN Stack");
  check("the first key that finds a pool row decides (an unassigned phone match stays blank)", mentorLabelFor(labels, { phone: "9000000003", userId: UID_A }) === "");
  check("not in the pool → blank", mentorLabelFor(labels, { phone: "9111111111", userId: "nobody-123" }) === "" && mentorLabelFor(labels, {}) === "" && mentorLabelFor(undefined, { phone: "9000000001" }) === "");
  check("a fallback ref is tried after the row's own ids", mentorLabelFor(labels, { phone: "9111111111" }, { phone: null, userId: UID_A }) === "Kiran Demo · Mentor assigned · MERN Stack");
  const records: Record<string, CandidateStanding> = {
    "p:9222222222": { candidateId: 1, phone: "9222222222", userId: UID_B, name: "Bala Test", bestProduct: "academy", bestTier: 2, bestScore: 60, bestLabel: "Academy · TR-1", eligible: true, standings: [] },
  };
  check("a sheet row matched to a pool record by phone finds the mentor under the record's UID", mentorForRow(labels, { phone: "9222222222" }, records) === "Someone New · Mentor assigned");
  check("…and without the records it stays blank", mentorForRow(labels, { phone: "9222222222" }) === "");
  check("empty pool → no labels", Object.keys(buildMentorLabels([])).length === 0);
}

// ── Domain shortlisting CSVs: "Assigned Mentor" right after Internal Standing ──
const cand = (o: Partial<DomainCandidateOutcome> = {}): DomainCandidateOutcome => ({
  id: "c1",
  name: "Asha Test",
  resumeUrl: "https://example.com/r.pdf",
  assessmentReport: "",
  tr1Panelist: "",
  tr1PanelLinkedin: "",
  tr1Recording: "",
  tr2Panelist: "",
  tr2PanelLinkedin: "",
  tr2Recording: "",
  placedCompany: "",
  ctc: "",
  domainScore: 80,
  coreSkills: ["React"],
  evidence: "Built React apps",
  githubProfile: "",
  githubRepos: [],
  githubStatus: "off",
  githubNote: "",
  githubScore: 0,
  githubMatches: 0,
  githubTechs: [],
  githubTopRepos: [],
  githubAiLikelihood: "",
  githubAiSummary: "",
  leetcodeSolved: 0,
  codeforcesSolved: 0,
  githubCommits2y: 0,
  githubLastDomainCommit: null,
  meetsMandatory: true,
  hasDomainExperience: false,
  experience: "",
  presentationScore: 0,
  presentationNotes: "",
  rank: 1,
  shortlisted: true,
  outcomeReason: "",
  priority: 3,
  ...o,
});
const report = (candidates: DomainCandidateOutcome[]): DomainReportResult => ({
  link: "",
  storage: "local",
  shortlisted: candidates.filter((c) => c.shortlisted).length,
  considered: candidates.length,
  candidates,
  excluded: { mandatory: 0, leetcode: 0, dsa: 0, commits: 0, experience: 0, presentation: 0 },
  limitedToTopN: false,
  reportSkipped: true,
});
const st: InternalStanding = { tier: 2, label: "Academy · Bucket A TR-1 Strong hire", product: "academy", score: 60, eligible: true, matchedBy: "phone", standings: [] };
const people = report([
  cand({ id: "a", name: "Asha Test", phone: "9000000001", userId: UID_A, internal: st }),
  cand({ id: "b", name: "Bala Test", phone: "", userId: UID_B, rank: 2 }),
  cand({ id: "c", name: "Chitra Test", phone: "9000000003", rank: 3 }),
  cand({ id: "e", name: "Esha Test", phone: "9111111111", rank: 0, shortlisted: false, outcomeReason: "Domain fit 40 is below the 55 bar" }),
]);
const csvInput = (o: Partial<DomainCsvInput> = {}): DomainCsvInput => ({
  kind: "complete",
  result: people,
  domain: "MERN",
  mandatoryActive: false,
  dsaOn: false,
  githubOn: false,
  trackDomainCommit: false,
  presentation: false,
  poolChecked: true,
  unscored: [{ row: cand({ id: "f", name: "Farah Test", phone: "", userId: UID_D }), status: "Not a resume", reason: "A certificate", internal: null }],
  ...o,
});
{
  const withMentors = domainCsv(csvInput({ mentorOf: (r) => mentorLabelFor(labels, r) }));
  const h = withMentors.headers;
  check("Assigned Mentor right after Internal Standing", h[h.indexOf("Internal Standing") + 1] === "Assigned Mentor" && h[h.indexOf("Assigned Mentor") + 1] === "Internal Stage", h);
  check("one Assigned Mentor column, headers unique", h.filter((x) => x === "Assigned Mentor").length === 1 && new Set(h).size === h.length);
  const before = domainCsv(csvInput()).headers;
  check("every other column keeps its order (insert only)", JSON.stringify(h.filter((x) => x !== "Assigned Mentor")) === JSON.stringify(before.filter((x) => x !== "Assigned Mentor")), { h, before });
  check(
    "the column's place in the full order",
    h.slice(h.indexOf("Resume"), h.indexOf("Signals") + 1).join("|") === "Resume|Matched In Pool By|Internal Standing|Assigned Mentor|Internal Stage|Internal Product|Signals Used|Signals",
    h,
  );
  const cell = withMentors.rows.map((r) => r["Assigned Mentor"]);
  check("values: by phone, by UID, unassigned blank, not in the pool blank, unscored row too", cell.join("|") === "Kiran Demo · Mentor assigned · MERN Stack|Someone New · Mentor assigned|||Kiran Demo · Mentor assigned", cell);
  check("not looked up: the column is there, blank", before.includes("Assigned Mentor") && domainCsv(csvInput()).rows.every((r) => r["Assigned Mentor"] === ""));
  const shortlisted = domainCsv(csvInput({ kind: "shortlisted", mentorOf: (r) => mentorLabelFor(labels, r) }));
  check("shortlisted CSV too", shortlisted.headers.includes("Assigned Mentor") && shortlisted.rows.length === 3 && shortlisted.rows[0]["Assigned Mentor"].startsWith("Kiran Demo"));
  check("the caller can name the header", domainCsv(csvInput({ mentorHeader: "Mentor" })).headers.includes("Mentor") && !domainCsv(csvInput({ mentorHeader: "Mentor" })).headers.includes("Assigned Mentor"));
}

// ── Sheet automation: "Mentor" right after Internal Standing ──────────────────
const plan: AutomationPlan = {
  version: 1,
  sourceSpreadsheetId: "S",
  sourceTitle: "Demo || Internal",
  tabs: [],
  focus: "MERN",
  domainName: "MERN developer",
  brief: "MERN developer",
  mandatory: "",
  briefSource: "llm",
  github: "off",
  review: false,
  dsa: { use: false, gates: { minSolved: 0, minContests: 0, minScore: 0, minRating: { leetcode: 0, codeforces: 0, codechef: 0 } } },
  topN: 5,
  topNSource: "profiles-required",
  notes: [],
};
{
  const ctx = {
    jobId: "job-1",
    deliveredAt: "27 Nov 2026, 10:00 IST",
    sourceTabOf: () => "Applied",
    flagsOf: () => [],
    unscored: [unscoredRow(cand({ id: "g", name: "Gita Test", phone: "9000000002" }), "error", "Couldn't download", null, "Applied")],
    mentorOf: (r: { phone?: string; userId?: string }) => mentorLabelFor(labels, r),
  };
  const t = deliveryTable(people, plan, ctx);
  check("key columns still lead", t.headers.slice(0, KEY_COLUMNS.length).join("|") === KEY_COLUMNS.join("|"));
  check("Mentor right after Internal Standing", t.headers[t.headers.indexOf("Internal Standing") + 1] === "Mentor" && !t.headers.includes("Assigned Mentor"), t.headers);
  check("Mentor values", t.rows.map((r) => r.Mentor).join("|") === "Kiran Demo · Mentor assigned · MERN Stack|Someone New · Mentor assigned|||Someone New · Mentor assigned", t.rows.map((r) => r.Mentor));
  const noMentors = deliveryTable(people, plan, { ...ctx, mentorOf: undefined });
  check("without labels: blank, same columns", noMentors.headers.join("|") === t.headers.join("|") && noMentors.rows.every((r) => r.Mentor === ""));

  // An older tab (before the Mentor column): inserted in place, nothing else moves.
  const old = t.headers.filter((h) => h !== "Mentor");
  const p = planHeaders(old, t.headers);
  check("an older tab gets Mentor inserted right after Internal Standing", p.headers.join("|") === t.headers.join("|") && p.inserts.length === 1 && p.inserts[0] === old.indexOf("Internal Standing") + 1 && !p.appended.length, p);
  const older = ["Job ID", "Delivered At", "Rank", "Name", "Status", "Internal Standing", "Internal Stage"];
  const q = planHeaders(older, t.headers);
  check(
    "…after the missing key columns are inserted (indices applied in order)",
    q.headers.slice(0, 10).join("|") === "Job ID|Delivered At|Mobile Number|Rank|Name|Status|Not Shortlisted Because|Review Flags|Source Tab|Internal Standing" &&
      q.headers[10] === "Mentor" &&
      q.headers[11] === "Internal Stage" &&
      q.inserts.at(-1) === 10,
    q,
  );
  // Replaying the inserts on the old header gives the planned header.
  const replay = [...older];
  const planned = q.headers.slice(0, older.length + q.inserts.length);
  for (const i of q.inserts) replay.splice(i, 0, planned[i]);
  check("…replaying the inserts on the old header gives the new one", replay.join("|") === planned.join("|"), replay);
  check("a tab that has Mentor already: nothing inserted", planHeaders(t.headers, t.headers).inserts.length === 0);
  check("a tab without Internal Standing: Mentor is appended", planHeaders(["Job ID", "Delivered At", "Mobile Number", "Name"], t.headers).appended.includes("Mentor"));
  check("an empty tab gets the full header", planHeaders([], t.headers).headers.join("|") === t.headers.join("|"));
  check("anchored columns", JSON.stringify(ANCHORED_COLUMNS) === JSON.stringify([["Mentor", "Internal Standing"]]));
}

// ── Standing lookup: "Mentor" right after Internal Standing ───────────────────
{
  const standing: CandidateStanding = {
    candidateId: 7,
    phone: "9333333333",
    userId: UID_A,
    name: "Asha Test",
    bestProduct: "academy",
    bestTier: 2,
    bestScore: 70,
    bestLabel: "Academy · Bucket A TR-1 Strong hire",
    eligible: true,
    standings: [{ product: "academy", tier: 2, label: "Academy · Bucket A TR-1 Strong hire", score: 70, eligible: true }],
  };
  const data: LookupData = { standings: { "p:9333333333": standing, [`u:${UID_A}`]: standing }, records: {}, mentors: labels };
  const input = parseLookupInput(["Phone", "9333333333", UID_B, "", "9000000003", "9111111111", "hello"].join("\n"));
  const rows = lookupRows(input, data, []);
  check(
    "values: via the matched record's UID, by UID, blank line, unassigned, external, unrecognised",
    rows.map((r) => r.mentor).join("|") === "Kiran Demo · Mentor assigned · MERN Stack|Someone New · Mentor assigned||||",
    rows.map((r) => r.mentor),
  );
  const t = lookupTable(rows, { phoneColumn: true, keys: [] });
  check("columns", t.headers.join("|") === "UUID|Phone|Internal Standing|Mentor|Internal Stage|Internal Product|Job Eligibility", t.headers);
  check("cells", t.rows[0].Mentor === "Kiran Demo · Mentor assigned · MERN Stack" && t.rows[3].Mentor === "");
  check("its own kind (styled on screen)", lookupColumns(rows, { phoneColumn: false, keys: [] }).find((c) => c.header === "Mentor")?.kind === "mentor");
  check("without labels: blank", lookupRows(input, { ...data, mentors: undefined }, []).every((r) => r.mentor === ""));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
