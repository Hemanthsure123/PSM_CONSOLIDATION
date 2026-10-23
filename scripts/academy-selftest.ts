import "./server-only-shim";
/**
 * Academy bucketing self-test — pure logic only (no network, no model):
 * reading / joining the three sheets, eligibility, stack classification, the
 * Mixed rule, ranking, the exports and the .xlsx file.
 *
 *   npx tsx scripts/academy-selftest.ts
 */
import { buildDataset, columnLabels, detectHeaderRow, readEligibility, type AcGrid } from "@/lib/academy/parse";
import { verifyFlags } from "@/lib/academy/trust-agent";
import { identityCheck } from "@/lib/academy/evaluator";
import {
  assign,
  classifyItem,
  classifyRepo,
  combine,
  competencySignal,
  preferenceSignal,
  rankAcademy,
  repoWeight,
  resumeSignal,
  summarizeAcademy,
  techMixBackendShare,
  itemBackendShare,
  trustScore,
  MIXED_TAG,
} from "@/lib/academy/scoring";
import { buildAcademyCsv, buildAcademyWorkbook, exportHeaders, tabRows } from "@/lib/academy/export";
import { buildXlsx, crc32, safeSheetName } from "@/lib/academy/xlsx";
import { AC_EVAL_VERSION, DEFAULT_AC_RULES, type AcEvaluation, type AcResumeItem, type AcRules, type AcScores } from "@/lib/academy/types";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── Sheet fixtures ───────────────────────────────────────────────────────────

const S1_HEAD = [
  "UID", "DSA Offline", "Old Assessment Checks", "YOG", "Name", "Email Address", "Number", "Previous Placement Info(Last Updated on Oct 09,2026)",
  "Student Preference", "Active Pool", "Resume", "Bucket A TR 1 Score", "Bucket A TR 1 Status", "TR1 recording", "Bucket B TR 1 Score", "Bucket B TR 1 Status", "TR1 recording",
  "Overall Score (out of 100)", "Verdict Band", "Clearance Status", "Frontend Levels", "Competency (FE) TR1 Recording",
  "Overall Score (out of 100)", "Verdict Band", "Clearance Status", "Dsa Levels",
  "Overall Score (out of 100)", "Verdict Band", "Clearance Status", "Backend Levels",
  "Psm Mentor", "Tech Stack Based", "Location/State",
];
const groupRow = Array(S1_HEAD.length).fill("");
groupRow[17] = "Frontend (Last Updated on Oct 15,2026)";
groupRow[22] = "DSA";
groupRow[26] = "Backend(Last Updated on Oct 15,2026)";

type Row = Record<string, string>;
/** A sheet-1 row by header name (the nth repeated header via "name#n"). */
function s1Row(v: Row): string[] {
  const seen = new Map<string, number>();
  return S1_HEAD.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return v[`${h}#${n}`] ?? (n === 1 ? v[h] ?? "" : "");
  });
}
const R = "https://drive.google.com/file/d/RESUME";
const s1Rows = [
  // u1: FE L4, active, not placed, resume — eligible via competency.
  s1Row({ UID: "u1", Name: "Asha", "Email Address": "asha@x.com", Number: "9000000001", "Previous Placement Info(Last Updated on Oct 09,2026)": "Not Placed", "Active Pool": "Yes", Resume: `${R}1`, "Frontend Levels": "L4", "Overall Score (out of 100)#1": "88", "Student Preference": "Roles/Tech: Full Stack, Frontend | Location: Hyderabad" }),
  // u2: old Bucket A, active, PLACED, resume.
  s1Row({ UID: "u2", Name: "Bala", "Email Address": "bala@x.com", Number: "9000000002", "Old Assessment Checks": "Bucket - A", "Previous Placement Info(Last Updated on Oct 09,2026)": "Placed", "Active Pool": "yes", Resume: `${R}2`, "Bucket A TR 1 Score": "72", "Bucket A TR 1 Status": "Strong Hire", "TR1 recording#1": "rec-a" }),
  // u3: DSA Offline cleared, active, no resume, no levels → preference only.
  s1Row({ UID: "u3", Name: "Chitra", "Email Address": "chitra@x.com", Number: "9000000003", "DSA Offline": "27th Sep - Cleared", "Previous Placement Info(Last Updated on Oct 09,2026)": "Not Placed", "Active Pool": "Yes", "Student Preference": "Role: AI Developer | Package: 5+ lpa" }),
  // u4: Below L3 + "Not Cleared" + Bucket B → not eligible.
  s1Row({ UID: "u4", Name: "Dev", "Email Address": "dev@x.com", Number: "9000000004", "DSA Offline": "Not Cleared", "Old Assessment Checks": "Bucket - B", "Frontend Levels": "Below L1", "Dsa Levels": "Below L2", "Active Pool": "Yes", "Bucket B TR 1 Status": "Cleared", "TR1 recording#2": "rec-b" }),
  // u5: eligible (DSA L3) but Active Pool = No.
  s1Row({ UID: "u5", Name: "Esha", "Email Address": "esha@x.com", Number: "9000000005", "Dsa Levels": "L3", "Active Pool": "No", Resume: `${R}5` }),
  // u6: eligible, active, blank YOG (filled from sheet 3 by mobile), email matches sheet 2 only.
  s1Row({ UID: "u6", Name: "", "Email Address": "farah@x.com", Number: "+91 90000 00006", "Old Assessment Checks": "Bucket - A", "Previous Placement Info(Last Updated on Oct 09,2026)": "Not Placed", "Active Pool": "Yes", Resume: `${R}6` }),
  // u7: eligible, active, resume; no evidence at all once read (empty resume) → Needs evidence.
  s1Row({ UID: "u7", Name: "Gopi", "Email Address": "gopi@x.com", Number: "9000000007", "Backend Levels": "L3", "Previous Placement Info(Last Updated on Oct 09,2026)": "Not Placed", "Active Pool": "Yes", Resume: `${R}7` }),
  // u1 again — repeated UID row is skipped.
  s1Row({ UID: "u1", Name: "Asha dup", "Active Pool": "No" }),
  [],
];
const s1: AcGrid = { name: "Sahana Working New Criteria", values: [groupRow, S1_HEAD, ...s1Rows] };

const FE_HEAD = ["UID", "Candidate Name", "Candidate Email", "Interviewer", "Template", "Status", "HTML & CSS", "HTML & CSS – Domain Rating", "Overall Score (out of 100)", "Levels", "Recording Link", "Integrity Score", "", "Overall Remarks"];
const s2fe: AcGrid = {
  name: "Frontend Development",
  values: [
    FE_HEAD,
    ["u1", "Asha", "asha@x.com", "Int A", "Frontend Development", "no_show", "", "", "", "", "", "", "", ""],
    ["u1", "Asha", "asha@x.com", "Int B", "Frontend Development", "completed", "Card 1 — HTML & CSS: 4 - Solid", "4", "88", "L4", "rec-1", "4.3", "It felt like she was reading from somewhere", "Good with React"],
    ["u1", "Asha", "asha@x.com", "Int C", "Frontend Development", "cancelled", "", "", "", "", "", "", "", ""],
    ["zz-other-uid", "Farah K", "farah@x.com", "Int D", "Frontend Development", "completed", "Card 1 — HTML & CSS: 3 - Basics", "3", "61", "L2", "rec-6", "5", "Ok", ""],
  ],
};
const s2help: AcGrid = { name: "Readme", values: [["Offline Cleared : 16th Aug", "Frontend"], ["Eligible Count", "11"]] };
const S3_HEAD = ["User ID", "Student Name", "Mobile Number", "Email ID", "YOG", "Cycle", "Bucket", "overall_candidate_score", "Coding Exam user score", "College"];
const s3: AcGrid = {
  name: "Offline Attended - Old Process",
  values: [
    S3_HEAD,
    ["u2", "Bala", "9000000002", "bala@x.com", "2025", "Cycle 4", "Bucket - A", "180", "96", "College B"],
    ["other", "Farah", "9000000006", "f2@x.com", "2026", "Cycle 9", "Bucket - A", "150", "70", "College F"],
    ["u4", "Dev", "9000000004", "dev@x.com", "2027", "Cycle 2", "Bucket - B", "90", "30", "College D"],
  ],
};

// ── Parsing ──────────────────────────────────────────────────────────────────

check("header row found under the group row", detectHeaderRow(s1.values) === 1);
const { labels } = columnLabels(s1.values, 1);
check("repeated Overall Score named by its group", labels[17] === "Frontend · Overall Score (out of 100)" && labels[22] === "DSA · Overall Score (out of 100)" && labels[26] === "Backend · Overall Score (out of 100)", labels.slice(17, 30).join(" | "));
check("repeated TR recording named by its round", labels[13] === "Bucket A TR 1 · TR1 recording" && labels[16] === "Bucket B TR 1 · TR1 recording", `${labels[13]} / ${labels[16]}`);
check("labels are unique", new Set(labels.map((l) => l.toLowerCase())).size === labels.length);

const ds = buildDataset({
  s1: { url: "s1", title: "Pool", tab: s1 },
  s2: { url: "s2", title: "Interviews", tabs: [s2fe, s2help] },
  s3: { url: "s3", title: "Old", tab: s3 },
});
const by = (id: string) => ds.candidates.find((c) => c.id === id)!;
check("blank and repeated rows skipped", ds.candidates.length === 7, String(ds.candidates.length));
check("repeated UID warned", ds.warnings.some((w) => /repeated UID/.test(w)));
check("sheet 2 helper tab ignored", eq(ds.sources.s2.tabs, ["Frontend Development"]));
check("eligibility — FE L4", by("u1").eligibility.eligible && eq(by("u1").eligibility.levels, ["Frontend L4"]));
check("eligibility — old Bucket A", by("u2").eligibility.bucketA && by("u2").oldBucket === "A");
check("eligibility — DSA Offline cleared", by("u3").eligibility.dsaOffline);
check("not eligible — Below L1 / Not Cleared / Bucket B", !by("u4").eligibility.eligible);
check("eligibility — DSA L3 counts", by("u5").eligibility.eligible && by("u5").eligibility.levels[0] === "DSA L3");
check("Active Pool yes is case-insensitive", by("u2").activePool && !by("u5").activePool);
check("placement read", by("u1").placement === "not-placed" && by("u2").placement === "placed");
check("competency block mapped", by("u1").competencies.find((k) => k.name === "Frontend")?.score === 88 && by("u1").competencies.find((k) => k.name === "Frontend")?.bucket === "frontend");
check("old round read", eq(by("u2").oldRounds, [{ label: "Bucket A TR 1", score: "72", status: "Strong Hire" }]));
check("readEligibility numeric DSA Offline ≥ 50", readEligibility([], "62", "").dsaOffline && !readEligibility([], "41", "").dsaOffline);

const feKey = (label: string) => ds.columns.find((c) => c.label === `Frontend Development · ${label}`)?.key ?? "?";
check("sheet 2 latest completed interview", by("u1").values[feKey("Interviewer")] === "Int B", by("u1").values[feKey("Interviewer")]);
check("sheet 2 attempts summarised", /3 \(no_show, completed, cancelled\)/.test(by("u1").values["s2:Frontend Development:attempts"] ?? ""));
check("sheet 2 card text dropped, rating kept", !ds.columns.some((c) => c.label === "Frontend Development · HTML & CSS") && ds.columns.some((c) => c.label === "Frontend Development · HTML & CSS – Domain Rating"));
check("sheet 2 duplicates of sheet 1 not repeated", !ds.columns.some((c) => /Frontend Development · (Levels|Overall Score \(out of 100\)|UID|Candidate Email)$/.test(c.label)));
check("sheet 2 joined by email when the UID differs", by("u6").s2Tabs.includes("Frontend Development") && by("u6").values[feKey("Interviewer")] === "Int D");
check("sheet 2 fills a blank name", by("u6").name === "Farah K", by("u6").name);
check("sheet 3 by UID", by("u2").s3Match === "uid" && by("u2").oldCoding === 96 && by("u2").oldOverall === 180);
check("sheet 3 by mobile (+91 / spaces ignored)", by("u6").s3Match === "mobile");
const yogKey = ds.columns.find((c) => c.label === "YOG")!.key;
check("sheet 3 fills sheet 1 blanks (YOG)", by("u2").values[yogKey] === "2025");
check("sheet 3 Bucket not repeated when sheet 1 has it", (by("u2").values["s3:bucket"] ?? "") === "");
check("sheet 3 extra columns prefixed", ds.columns.some((c) => c.label === "Old process · Cycle") && !ds.columns.some((c) => c.label === "Old process · Student Name"));

// ── Stack classification ─────────────────────────────────────────────────────

check("MERN → Full Stack", classifyItem("frontend", ["react", "nodejs", "mongodb"]).stack === "fullstack");
check("React + public API → Frontend", classifyItem("frontend", ["react", "javascript", "rest-api"]).stack === "frontend");
check("Node + Mongo → Backend", classifyItem("backend", ["nodejs", "mongodb", "javascript"]).stack === "backend");
check("PyTorch → AI-ML", classifyItem("other", ["pytorch", "python"]).stack === "aiml");
check("LLM inside a full-stack app the model calls full stack → Full Stack", classifyItem("fullstack", ["react", "nodejs", "llm"]).stack === "fullstack");
check("LLM app → AI-ML", classifyItem("aiml", ["react", "llm"]).stack === "aiml");
check("React Native → Other", classifyItem("other", ["react-native", "react", "javascript"]).stack === "other");
check("No techs → the model's reading", classifyItem("aiml", []).stack === "aiml");
check("Data tools + model aiml → AI-ML", classifyItem("aiml", ["pandas", "powerbi"]).stack === "aiml");
check("Repo: React + REST routes + Node → Full Stack", classifyRepo(["react", "nodejs", "rest-api"]) === "fullstack");
check("Repo: REST routes only → Backend", classifyRepo(["rest-api", "fastapi-or-flask"]) === "backend");
check("Repo: Flutter → Other", classifyRepo(["flutter"]) === "other");
check("Practice repo weighted 0.3, course project 0.5", repoWeight({ name: "BlogList-ReactJs-CODING-PRACTICE-22", aiLikelihood: "none" } as never) === 0.3 && repoWeight({ name: "nxtTrendz", aiLikelihood: "none" } as never) === 0.5 && repoWeight({ name: "expense-api", aiLikelihood: "high" } as never) === 0.5);

const item = (stack: AcResumeItem["stack"], techKeys: string[], kind: AcResumeItem["kind"] = "project", depth: AcResumeItem["depth"] = "substantial"): AcResumeItem => ({ kind, title: `${stack}-${techKeys.join("-")}`, org: "", stack, depth, techs: techKeys, techKeys, quote: "" });
const evalOf = (id: string, items: AcResumeItem[], extra: Partial<AcEvaluation> = {}): AcEvaluation => ({
  id,
  status: "ok",
  error: "",
  retryable: false,
  resumeUrl: by(id)?.resumeUrl ?? "",
  read: { github: true, dsa: true },
  items,
  skills: [],
  skillKeys: [],
  primaryProfile: "",
  remarks: "",
  github: null,
  dsa: null,
  checks: [],
  model: "test",
  source: "pdf",
  transcribed: false,
  durationMs: 1,
  analyzedAt: "2026-10-21T00:00:00Z",
  version: AC_EVAL_VERSION,
  ...extra,
});

const rs = resumeSignal(evalOf("u1", [item("fullstack", ["react", "nodejs", "mongodb"]), item("fullstack", ["react", "nodejs", "sql"])]))!;
check("two MERN projects: Full Stack leads", rs.scores.fullstack > rs.scores.frontend && rs.scores.fullstack > rs.scores.backend, JSON.stringify(rs.scores));
const rs2 = resumeSignal(evalOf("u1", [item("frontend", ["react"]), item("backend", ["nodejs", "mongodb"])]))!;
check("separate FE + BE projects count toward Full Stack", rs2.scores.fullstack > 0 && rs2.scores.fullstack === rs2.scores.frontend, JSON.stringify(rs2.scores));
const rsJob = resumeSignal(evalOf("u1", [item("backend", ["spring-boot"], "job", "production")]))!;
const rsBasic = resumeSignal(evalOf("u1", [item("backend", ["spring-boot"], "project", "basic")]))!;
check("a production job outweighs a basic project", rsJob.scores.backend > rsBasic.scores.backend * 2, `${rsJob.scores.backend} vs ${rsBasic.scores.backend}`);

const pref = preferenceSignal("Roles/Tech: Full Stack, Frontend, AI | Location: Hyderabad, Bangalore | CTC: 8+")!;
check("preference order kept", eq(pref.order, ["fullstack", "frontend", "aiml"]) && pref.scores.fullstack === 100 && pref.scores.frontend === 80, JSON.stringify(pref));
check("preference: location / CTC ignored, none named → null", preferenceSignal("Roles/Tech: open to any relevant role | Location: open to all location | CTC: 5LPA") === null);
check("preference: a skills list counts half", (preferenceSignal("Skills: React, Node")?.scores.frontend ?? 0) === 50);
check("preference: React Native is not frontend", !preferenceSignal("Roles: React Native developer")?.order.includes("frontend"));

const comp = competencySignal(by("u1"))!;
check("competency: FE L4 = 100, 0.8 to Full Stack", comp.scores.frontend === 100 && comp.scores.fullstack === 80);
check("competency: DSA level names no stack", competencySignal(by("u5")) === null);

// ── The Mixed rule ───────────────────────────────────────────────────────────

const S = (fe: number, be: number, ai: number, fs: number): AcScores => ({ frontend: fe, backend: be, aiml: ai, fullstack: fs });
const R0 = DEFAULT_AC_RULES;
check("clear lead → that bucket", assign(S(20, 30, 85, 40), R0).placement === "aiml");
check("AI-ML and Full Stack within 10, both ≥ 50 → Mixed", (() => {
  const a = assign(S(40, 40, 70, 64), R0);
  return a.placement === "mixed" && eq(a.mixedWith, ["aiml", "fullstack"]);
})());
check("runner-up below the minimum → no Mixed", assign(S(10, 10, 52, 45), R0).placement === "aiml");
check("Frontend ≈ Full Stack → Full Stack (FE + BE = Full Stack on)", assign(S(76, 51, 32, 75), R0).placement === "fullstack");
check("Frontend ≈ Backend → Full Stack", assign(S(70, 66, 10, 20), R0).placement === "fullstack");
check("…and Mixed when the switch is off", assign(S(76, 51, 32, 75), { ...R0, feBeAsFullStack: false }).placement === "mixed");
check("the margin is adjustable", assign(S(40, 40, 70, 58), { ...R0, mixedMargin: 15 }).placement === "mixed" && assign(S(40, 40, 70, 58), R0).placement === "aiml");
check("combine renormalises over available signals", (() => {
  const c = combine({ resume: { scores: S(0, 0, 80, 0) }, preference: null }, R0);
  return c.scores.aiml === 80 && eq(c.used, ["resume"]);
})());
check("combine: a switched-off signal is ignored", combine({ resume: { scores: S(0, 0, 80, 0) }, preference: { scores: S(100, 0, 0, 0) } }, { ...R0, signals: { ...R0.signals, preference: false } }).scores.frontend === 0);
check("combine: FE and BE strength lifts Full Stack", combine({ resume: { scores: S(70, 60, 0, 10) } }, R0).scores.fullstack === 60);
check("combine: a Frontend interview counts at half weight for AI-ML", (() => {
  const c = combine({ resume: { scores: S(0, 0, 80, 0) }, competency: competencySignal(by("u1")) }, R0);
  return c.scores.aiml === Math.round((45 * 80) / (45 + 10)) && c.scores.frontend > 0;
})());
check("combine: preference alone can't outweigh an interview", (() => {
  const c = combine({ competency: competencySignal(by("u1")), preference: { scores: S(0, 100, 0, 0) } }, R0);
  return assign(c.scores, R0).placement !== "backend";
})());
check("combine: no GitHub repo of a stack counts at half weight", (() => {
  const gh = { scores: S(0, 0, 0, 99), observes: S(0.5, 0.5, 0.5, 1) };
  const c = combine({ resume: { scores: S(0, 0, 95, 58) }, github: gh }, R0);
  return c.scores.aiml === Math.round((45 * 95) / (45 + 12.5)) && c.scores.fullstack === Math.round((45 * 58 + 25 * 99) / 70);
})());
check("coverage: preference alone is 10% of the evidence, every signal 100%", (() => {
  const one = combine({ preference: { scores: S(100, 0, 0, 0) } }, R0).coverage.frontend;
  const all = combine({ resume: { scores: S(50, 0, 0, 0) }, github: { scores: S(50, 0, 0, 0) }, competency: { scores: S(50, 0, 0, 0) }, preference: { scores: S(50, 0, 0, 0) } }, R0).coverage.frontend;
  return one === 0.1 && all === 1;
})());
check("Mixed: Frontend / Backend / Full Stack collapse to Full Stack beside AI-ML", (() => {
  const a = assign(S(72, 65, 72, 74), R0);
  return a.placement === "mixed" && eq(a.mixedWith, ["fullstack", "aiml"]);
})());

// ── Ranking, statuses, exports ───────────────────────────────────────────────

const results: Record<string, AcEvaluation> = {
  u1: evalOf("u1", [item("fullstack", ["react", "nodejs", "mongodb"]), item("fullstack", ["react", "nodejs", "sql"]), item("frontend", ["react"])]),
  u2: evalOf("u2", [item("aiml", ["pytorch"]), item("aiml", ["llm"]), item("fullstack", ["react", "nodejs", "mongodb"]), item("fullstack", ["react", "django", "sql"])]),
  u6: evalOf("u6", [item("fullstack", ["react", "nodejs", "mongodb"], "internship", "production"), item("fullstack", ["react", "nodejs", "sql"])]),
  u7: evalOf("u7", []),
};
const rules: AcRules = DEFAULT_AC_RULES;
const rows = rankAcademy(ds.candidates, results, rules);
const row = (id: string) => rows.find((r) => r.id === id)!;
check("u1 → Full Stack", row("u1").placement === "fullstack", `${row("u1").placement} ${JSON.stringify(row("u1").scores)}`);
check("u2 (AI + FS evenly) → Mixed with the tag", row("u2").placement === "mixed" && row("u2").tag === MIXED_TAG, `${row("u2").placement} ${JSON.stringify(row("u2").scores)}`);
check("u3 (no resume) bucketed from preference and tagged", row("u3").placement === "aiml" && /No resume/.test(row("u3").tag), `${row("u3").placement} ${row("u3").tag}`);
check("u4 not eligible", row("u4").status === "Not eligible");
check("u5 not in active pool", row("u5").status === "Not in active pool");
check("u7: no stack in resume, Backend L3 → Backend from competency", row("u7").placement === "backend", `${row("u7").status} ${row("u7").placement}`);
check("P1 before P2 in a bucket, even with a lower priority score", (() => {
  const alt = rankAcademy(ds.candidates, { ...results, u2: evalOf("u2", [item("fullstack", ["react", "nodejs", "mongodb"]), item("fullstack", ["react", "django", "sql"])]) }, rules);
  const fs = alt.filter((r) => r.placement === "fullstack").sort((a, b) => a.rank - b.rank);
  const p2 = fs.find((r) => r.id === "u2");
  const p1Lower = fs.find((r) => r.priority === "P1" && p2 && r.priorityScore < p2.priorityScore);
  return Boolean(p2 && p1Lower && p1Lower.rank < p2.rank && fs[fs.length - 1].id === "u2");
})());
check("P2 placed candidate is P2", row("u2").priority === "P2");
check("placed switched off → not bucketed", rankAcademy(ds.candidates, results, { ...rules, includePlaced: false }).find((r) => r.id === "u2")!.status === "Placed – not bucketed");
check("unread resume → Pending", rankAcademy(ds.candidates, {}, rules).find((r) => r.id === "u1")!.status === "Pending");
check("resume signal off → bucketed without reading (FE L4 interview + Full Stack preference)", rankAcademy(ds.candidates, {}, { ...rules, signals: { ...rules.signals, resume: false } }).find((r) => r.id === "u1")!.placement === "fullstack");
check("temporary read error → Needs evidence with a suggestion", (() => {
  const r = rankAcademy(ds.candidates, { u1: { ...evalOf("u1", []), status: "error", error: "Resume download failed temporarily (503)", retryable: true } }, rules).find((x) => x.id === "u1")!;
  return r.status === "Needs evidence" && r.suggested === "fullstack";
})());
check("unshared resume → bucketed from the other signals, tagged", (() => {
  const r = rankAcademy(ds.candidates, { u1: { ...evalOf("u1", []), status: "error", error: "Resume could not be downloaded — check that it is shared with the service account or public.", retryable: false } }, rules).find((x) => x.id === "u1")!;
  return r.placement === "fullstack" && /not shared with the service account/.test(r.tag);
})());
check("assessment: Bucket A + Strong Hire = 90", row("u2").assessment.score === 90, String(row("u2").assessment.score));
check("DSA: old coding exam 96/120 = 80", row("u2").dsa.score === 80, String(row("u2").dsa.score));
const sum = summarizeAcademy(rows);
check("summary counts", sum.inScope === 5 && sum.p1 === 4 && sum.p2 === 1 && sum.byPlacement.mixed === 1, JSON.stringify(sum));

const headers = exportHeaders(ds);
check("export headers unique", new Set(headers.map((h) => h.toLowerCase())).size === headers.length);
check("empty source columns dropped, team columns kept", !headers.includes("Location/State") && headers.includes("Psm Mentor") && headers.includes("Tech Stack Based"));
const csv = buildAcademyCsv(ds, tabRows(rows, "mixed"));
check("CSV has a BOM and the Mixed row", csv.startsWith("﻿") && csv.includes("Bala") && csv.includes(MIXED_TAG));
check("a tab leaves out columns empty in it, keeps the team columns", (() => {
  const head = csv.slice(1).split("\r\n")[0];
  return !head.includes("Suggested Bucket (without resume)") && head.includes("Psm Mentor") && head.includes("Mixed Tech Stacks");
})());
check("Tech Stack Based filled with the bucket", /Mixed \((AI-ML \/ Full Stack|Full Stack \/ AI-ML)\)/.test(csv), csv.split("\r\n")[1]?.slice(0, 200));
check("tabs: every in-scope candidate in exactly one bucket tab or Needs evidence", (() => {
  const ids = ["frontend", "backend", "aiml", "fullstack", "mixed", "needs"].flatMap((t) => tabRows(rows, t as never).map((r) => r.id));
  return new Set(ids).size === ids.length && ids.length === sum.inScope;
})());


// ── Nudge (temporary rebalancing) and the trust check ───────────────────────

check("interviews read from sheet 2 (integrity score, unnamed note column, remarks)", (() => {
  const iv = by("u1").interviews?.find((i) => i.tab === "Frontend Development");
  return iv?.status === "completed" && iv.integrityScore === "4.3" && /reading from somewhere/.test(iv.integrityNote) && iv.remarks === "Good with React";
})());
check("tech mix: MERN is 50/50, an API-heavy app leans backend", techMixBackendShare(["react", "html-css", "nodejs", "mongodb", "rest-api"]) === 0.5 && techMixBackendShare(["react", "nodejs", "sql", "rest-api"]) > 0.6);
check("item side: the resume's focus decides, technologies otherwise", (() => {
  const base = item("fullstack", ["react", "nodejs", "mongodb"]);
  return itemBackendShare({ ...base, focus: "backend" }) === 0.75 && itemBackendShare({ ...base, focus: "frontend" }) === 0.25 && itemBackendShare(base) === techMixBackendShare(base.techKeys);
})());
check("a backend-focused full-stack project lifts Backend over Frontend", (() => {
  const r = resumeSignal(evalOf("u1", [{ ...item("fullstack", ["react", "nodejs", "sql"]), focus: "backend" }]))!;
  return r.scores.backend > r.scores.frontend && r.web.be > r.web.fe;
})());

const beLean = (id: string) =>
  evalOf(id, [
    { ...item("fullstack", ["react", "nodejs", "mongodb"], "internship", "production"), focus: "backend" },
    { ...item("fullstack", ["react", "spring-boot", "sql"]), focus: "backend" },
    item("backend", ["nodejs", "mongodb"]),
  ]);
const nudgeResults = { ...results, u6: beLean("u6") };
const nudgeRules: AcRules = { ...rules, nudge: { ...rules.nudge, maxMoves: 1 } };
const withNudge = rankAcademy(ds.candidates, nudgeResults, nudgeRules);
const n6 = withNudge.find((r) => r.id === "u6")!;
const without = rankAcademy(ds.candidates, nudgeResults, { ...nudgeRules, nudge: { ...nudgeRules.nudge, enabled: false } }).find((r) => r.id === "u6")!;
check("without the nudge a backend-leaning full-stack candidate stays Full Stack", without.placement === "fullstack", `${without.placement} ${JSON.stringify(without.scores)} share ${without.backendShare}`);
check("the nudge moves them to Backend, tagged and explained", n6.placement === "backend" && n6.nudgedFrom === "fullstack" && /Nudged from Full Stack/.test(n6.tag) && /^Nudged Full Stack → Backend/.test(n6.reasons[0]), `${n6.placement} ${n6.tag}`);
check("nudged rows rank in Backend with their Backend score as fit", n6.fit === n6.scores.backend && n6.rank >= 1);
check("the nudge never moves a frontend-leaning Full Stack candidate", withNudge.find((r) => r.id === "u1")!.placement === "fullstack");
check("the nudge respects 'move at most'", rankAcademy(ds.candidates, nudgeResults, { ...nudgeRules, nudge: { ...nudgeRules.nudge, maxMoves: 0 } }).filter((r) => r.nudgedFrom).length === 0);
check("a low-trust candidate is never nudged", (() => {
  const lowTrust = { ...beLean("u6"), identity: { nameOnResume: "Someone Else", nameMatch: false, emailFound: false, phoneFound: false } };
  const r = rankAcademy(ds.candidates, { ...results, u6: lowTrust }, nudgeRules).find((x) => x.id === "u6")!;
  return r.placement !== "backend" || !r.nudgedFrom;
})());

const idOk = identityCheck({ name: "Asha Rao", email: "asha@x.com", mobile: "+91 90000 00001" }, "ASHA RAO\nasha@x.com | 90000-00001\nSkills ...", "Asha Rao");
const idBad = identityCheck({ name: "Asha Rao", email: "asha@x.com", mobile: "9000000001" }, "RAVI KUMAR\nravi@y.com 9876543210", "Ravi Kumar");
check("identity: sheet email / mobile found on the resume", idOk.emailFound && idOk.phoneFound && idOk.nameMatch === true);
check("identity: a different person's resume", !idBad.emailFound && !idBad.phoneFound && idBad.nameMatch === false);

const tBad = trustScore(by("u1"), { ...evalOf("u1", [item("fullstack", ["react"])]), identity: idBad });
check("trust: someone else's resume costs 55 (Low on its own), integrity note 12", tBad.score === 100 - 55 - 12 && tBad.band === "Low", `${tBad.score} ${tBad.checks.map((x) => x.label).join("; ")}`);
const tGood = trustScore(by("u2"), { ...evalOf("u2", [item("aiml", ["pytorch"])]), identity: idOk });
check("trust: verified identity, no doubts = 100 High", tGood.score === 100 && tGood.band === "High");
check("trust: no resume reading = Unverified", trustScore(by("u3"), undefined).band === "Unverified" && trustScore(by("u3"), undefined).score === null);
const flagsMany = {
  flags: [
    { category: "inflated-claim" as const, severity: "high" as const, evidence: "used by 10 lakh users", why: "x" },
    { category: "inflated-claim" as const, severity: "high" as const, evidence: "saved 1 crore", why: "x" },
    { category: "inflated-claim" as const, severity: "medium" as const, evidence: "Fortune 500 clients", why: "x" },
    { category: "timeline" as const, severity: "high" as const, evidence: "2019 - 2024 full-time", why: "x" },
    { category: "copied-text" as const, severity: "high" as const, evidence: "a b c", why: "x" },
    { category: "inconsistent" as const, severity: "high" as const, evidence: "800+ problems", why: "x" },
  ],
  summary: "",
  model: "test",
  dropped: 0,
};
const tMany = trustScore(by("u2"), { ...evalOf("u2", [item("aiml", ["pytorch"])]), identity: idOk, trust: flagsMany });
check("trust: one issue counts once (+2 per extra example), agent total capped at 40", tMany.score === 60, String(tMany.score));
check("trust: low trust halves resume + GitHub weight and tags the row", (() => {
  const r = rankAcademy(ds.candidates, { ...results, u1: { ...results.u1, identity: idBad } }, rules).find((x) => x.id === "u1")!;
  return Boolean(r.trust && r.trust.score! < 60 && /Low trust/.test(r.tag) && r.confidence === "Low");
})());
check("trust: switched off = no trust effects", rankAcademy(ds.candidates, { ...results, u1: { ...results.u1, identity: idBad } }, { ...rules, trust: { ...rules.trust, enabled: false } }).find((x) => x.id === "u1")!.trust === null);

check("trust: self-refuting, no-show and profile-matching flags are set aside", (() => {
  const t = trustScore(by("u2"), {
    ...evalOf("u2", [item("aiml", ["pytorch"])]),
    identity: idOk,
    dsa: { leetcode: {} as never, codeforces: {} as never, codechef: {} as never, totalSolved: 481, totalContests: 3, score: 40, partial: false },
    trust: {
      flags: [
        { category: "timeline", severity: "high", evidence: "Aug 2024", why: "That is plausible, so no conflict here." },
        { category: "interview-integrity", severity: "medium", evidence: "status no_show", why: "The interview was not completed." },
        { category: "inconsistent", severity: "high", evidence: "Top 2% — 400+ problems solved", why: "Profile records 481." },
      ],
      summary: "",
      model: "test",
      dropped: 0,
    },
  });
  return t.score === 100 && t.checks.some((x) => x.label === "Agent flags set aside");
})());
const vf = verifyFlags(
  {
    flags: [
      { category: "inconsistent", severity: "high", evidence: "Solved 800+ problems on LeetCode", why: "profile shows 300" },
      { category: "inflated-claim", severity: "medium", evidence: "words that are nowhere", why: "made up" },
      { category: "inconsistent", severity: "medium", evidence: "COMPETENCY INTERVIEWS: none", why: "absence" },
      { category: "bogus", severity: "high", evidence: "Solved 800+ problems", why: "bad category" },
    ],
    summary: "Mostly fine.",
  },
  "Projects\nSolved 800+ problems on LeetCode and built apps",
  "COMPETENCY INTERVIEWS: none\nCODING PROFILES: LeetCode 300 solved",
  "test",
);
check("trust agent: only grounded flags about something said are kept", vf.flags.length === 1 && vf.flags[0].evidence.startsWith("Solved 800+") && vf.dropped === 3, JSON.stringify(vf));

// ── .xlsx ────────────────────────────────────────────────────────────────────

check("CRC-32 known value", crc32(new TextEncoder().encode("123456789")) === 0xcbf43926);
const used = new Set<string>();
check("sheet names made safe and unique", safeSheetName("AI/ML: [best]?", used) === "AI ML best" && safeSheetName("AI/ML: [best]?", used) === "AI ML best 2");
const wb = buildAcademyWorkbook("Test run", ds, rows, rules);
const view = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
check("xlsx starts with a ZIP local header", view.getUint32(0, true) === 0x04034b50);
const eocd = wb.byteLength - 22;
check("xlsx ends with the ZIP directory", view.getUint32(eocd, true) === 0x06054b50);
const entries = view.getUint16(eocd + 10, true);
check("xlsx has the parts for 8 sheets", entries === 5 + 8, String(entries));
// Walk the central directory: every entry's CRC must match its stored bytes.
let p = view.getUint32(eocd + 16, true);
let crcOk = true;
const names: string[] = [];
for (let i = 0; i < entries; i++) {
  const nameLen = view.getUint16(p + 28, true);
  const crc = view.getUint32(p + 16, true);
  const size = view.getUint32(p + 20, true);
  const local = view.getUint32(p + 42, true);
  const name = new TextDecoder().decode(wb.subarray(p + 46, p + 46 + nameLen));
  names.push(name);
  const localNameLen = view.getUint16(local + 26, true);
  const data = wb.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
  if (crc32(data) !== crc) crcOk = false;
  p += 46 + nameLen;
}
check("xlsx entries' CRCs match", crcOk);
check("xlsx has workbook, styles and sheets", names.includes("xl/workbook.xml") && names.includes("xl/styles.xml") && names.includes("xl/worksheets/sheet8.xml"));
const tiny = new TextDecoder().decode(buildXlsx([{ name: "T", header: ["A", "B"], rows: [[1, "x & <y>"], [null, " lead"]] }]));
check("xlsx escapes text, keeps numbers numeric", tiny.includes("<v>1</v>") && tiny.includes("x &amp; &lt;y&gt;") && tiny.includes('xml:space="preserve"'));

console.log(`\nacademy self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
