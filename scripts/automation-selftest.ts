/**
 * Sheet automation — offline self-test (no database, no Google, no model):
 *   npx tsx scripts/automation-selftest.ts
 *
 * Covers reading the instructions cell (labels, one-line "->" form, bullets, GitHub scopes, DSA
 * gates, top N, sheet links), matching tab names, the requested count, the destination tab's
 * date, column detection on real header shapes, validation flags and the job verdict, the
 * delivery table / header merge / idempotency check, and the status text.
 */
import "./server-only-shim";
import { detectDomainColumns } from "@/lib/domain-columns";
import { dsaGatesActive } from "@/lib/dsa-scoring";
import { destinationTabName, dsaGatesOf, githubScopeOf, istDate, parseInstructions, profilesRequiredOf, resolveTabs } from "@/lib/automation/instructions";
import { columnLetter, cellText, deliveredBefore, deliveryTable, mergeHeaders, sheetRows } from "@/lib/automation/delivery-rules";
import { jobVerdict, reviewFlags } from "@/lib/automation/validation";
import { detailsText } from "@/lib/automation/sheet-text";
import type { AutomationPlan } from "@/lib/automation/types";
import type { DomainCandidate, DomainCandidateOutcome, DomainReportResult } from "@/lib/types";

let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};

const TABS = ["Edge Applied", "Academy Applied", "Applied Users", "EDGE 2.0 ", "Sheet9"];

// ── Instructions ─────────────────────────────────────────────────────────────
{
  const p = parseInstructions(
    ["Subsheets: Edge Applied, Academy Applied", "Focus: Flutter developers who shipped apps; Firebase is a must", "GitHub: (domain-fit candidates)", "DSA: yes", "Top: 12"].join("\n"),
  );
  check("labeled: tabs", p.tabs.join("|") === "Edge Applied|Academy Applied", p.tabs);
  check("labeled: focus", p.focus === "Flutter developers who shipped apps; Firebase is a must", p.focus);
  check("labeled: GitHub fit", p.github === "fit" && p.githubExplicit);
  check("labeled: DSA on, no gates", p.dsa.use && !dsaGatesActive(p.dsa.gates));
  check("labeled: top", p.topN === 12);
}
{
  const p = parseInstructions("Edge Applied, Academy Applied -> MERN developers with deployed full-stack apps -> GitHub (all candidates) -> DSA screening");
  check("one line with arrows: GitHub all", p.github === "all", p);
  check("one line with arrows: DSA on", p.dsa.use);
  const r = resolveTabs(p, TABS);
  check("unlabeled tab list is recognised", r.tabs.join("|") === "Edge Applied|Academy Applied" && !r.unknown.length, r);
  check("the rest is the focus", r.focus === "MERN developers with deployed full-stack apps", r.focus);
}
{
  const p = parseInstructions("• Sheets: 'EDGE 2.0 ' ; edge applied\n• Looking for: GenAI engineers (RAG, agents)\n• GitHub: no\n• DSA: no");
  const r = resolveTabs(p, TABS);
  check("quoted names and case / spacing ignored", r.tabs.join("|") === "EDGE 2.0 |Edge Applied", r.tabs);
  check("GitHub off", p.github === "off");
  check("DSA off", !p.dsa.use && p.dsa.explicit);
  check("bullets stripped; focus label", r.focus === "GenAI engineers (RAG, agents)", r.focus);
}
{
  const p = parseInstructions("Subsheets: Edge Aplied\nFocus: Java backend");
  const r = resolveTabs(p, TABS);
  check("unknown tab reported with a suggestion", r.unknown.length === 1 && r.unknown[0].suggestions[0] === "Edge Applied", r.unknown);
}
check("GitHub scope words", githubScopeOf("(all candidates)") === "all" && githubScopeOf("(domain-fit candidates only)") === "fit" && githubScopeOf("yes") === "fit" && githubScopeOf("no") === "off");
{
  const g = dsaGatesOf("CF 1400 or CodeChef 1600, 300 solved, 10 contests, DSA score 50");
  check("DSA gates parsed", g.minRating.codeforces === 1400 && g.minRating.codechef === 1600 && g.minSolved === 300 && g.minContests === 10 && g.minScore === 50, g);
  const lc = dsaGatesOf("LeetCode 1800 rating");
  check("LeetCode rating", lc.minRating.leetcode === 1800 && lc.minSolved === 0, lc);
  const solvedOnly = dsaGatesOf("LeetCode 300 solved");
  check("'LeetCode 300 solved' is a solved count, not a rating", solvedOnly.minSolved === 300 && solvedOnly.minRating.leetcode === 0, solvedOnly);
  const p = parseInstructions("Subsheets: Edge Applied\nFocus: SDE\nDSA: CF 1500");
  check("DSA with a gate turns DSA on", p.dsa.use && p.dsa.gates.minRating.codeforces === 1500);
}
{
  const p = parseInstructions("Subsheets: Edge Applied\nFocus: Need 5 years of Flutter experience\nSheet: https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=0");
  check("'Need 5 …' in the focus is not a top N", p.topN === null, p.topN);
  check("sheet link override", p.sheetUrl?.includes("1AbCdEfGhIjKlMnOpQrStUvWxYz012345") === true, p.sheetUrl);
  check("GitHub default is domain-fit, not explicit", p.github === "fit" && !p.githubExplicit);
  check("DSA default is off", !p.dsa.use && !p.dsa.explicit);
  check("code review: 'no review'", parseInstructions("GitHub: (all candidates) no review").review === false);
}
check("profiles required", profilesRequiredOf("10") === 10 && profilesRequiredOf("8-10") === 10 && profilesRequiredOf("10+") === 10 && profilesRequiredOf("") === null && profilesRequiredOf("TBD") === null);
check("IST date crosses midnight correctly", istDate(new Date("2026-10-28T19:00:00Z")) === "2026-10-29" && istDate(new Date("2026-10-28T18:00:00Z")) === "2026-10-28");
check("destination tab name", destinationTabName("2026-10-28") === "psm_final_shortlisted_2026-10-28");

// ── Columns on real header shapes ────────────────────────────────────────────
{
  const uni = detectDomainColumns(["Timestamp", "USER ID", "Your Name", "Mobile Number\n\n👉 Enter a 10-digit mobile number (without +91 or 0 at the beginning)", "Mail ID", "Upload your Updated Resume ", "Alternate Mobile Number\n👉 Enter a 10-digit mobile number"]);
  check("Edge Applied (Uni Cards)", uni.idColumn === "USER ID" && uni.nameColumn === "Your Name" && uni.phoneColumn.startsWith("Mobile Number") && uni.resumeColumn === "Upload your Updated Resume ", uni);
  const zag = detectDomainColumns(["Timestamp", "", "", "Full Name", "Registered Mobile Number", "Email Address", "Bachelors University / College Name", "Please Upload Your Updated resume", "UID"]);
  check("Edge Applied (Zaggle): UID and Full Name", zag.idColumn === "UID" && zag.nameColumn === "Full Name" && zag.phoneColumn === "Registered Mobile Number", zag);
  const acad = detectDomainColumns(["Applied Datetime", "User Id", "Job Id", "Product", "Gender", "Highest Education Institute Name", "Name", "Phone Number", "Resume Link"]);
  check("Academy Applied: 'Name', not the institute", acad.nameColumn === "Name" && acad.idColumn === "User Id" && acad.resumeColumn === "Resume Link", acad);
  const scanned = detectDomainColumns(["", "User ID", "Resume Link", "Overall Probability", "Projects Remarks"]);
  check("resume column isn't a 'Remarks' column", scanned.resumeColumn === "Resume Link");
}

// ── Validation ───────────────────────────────────────────────────────────────
const base = (o: Partial<DomainCandidateOutcome> = {}): DomainCandidateOutcome => ({
  id: "u1",
  name: "Asha",
  resumeUrl: "https://x/r.pdf",
  assessmentReport: "",
  tr1Panelist: "",
  tr1PanelLinkedin: "",
  tr1Recording: "",
  tr2Panelist: "",
  tr2PanelLinkedin: "",
  tr2Recording: "",
  placedCompany: "",
  ctc: "",
  domainScore: 82,
  coreSkills: ["Flutter"],
  evidence: "Built Flutter apps",
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
  domainProofs: [{ source: "project", quote: "built a Flutter app" }],
  rank: 1,
  shortlisted: true,
  outcomeReason: "",
  priority: 3,
  ...o,
});
const planOf = (o: Partial<AutomationPlan> = {}): AutomationPlan => ({
  version: 1,
  sourceSpreadsheetId: "S",
  sourceTitle: "Uni Cards || Internal",
  tabs: [],
  focus: "Flutter",
  domainName: "Flutter developer",
  brief: "Flutter developer",
  mandatory: "Flutter",
  briefSource: "llm",
  github: "fit",
  review: true,
  dsa: { use: false, gates: { minSolved: 0, minContests: 0, minScore: 0, minRating: { leetcode: 0, codeforces: 0, codechef: 0 } } },
  topN: 5,
  topNSource: "profiles-required",
  notes: [],
  ...o,
});
{
  check("a clean strong candidate has no flags", reviewFlags(base(), planOf()).length === 0, reviewFlags(base(), planOf()));
  check("borderline fit flagged", reviewFlags(base({ domainScore: 57 }), planOf())[0]?.startsWith("Borderline domain fit (57, bar 55)"));
  const gh = reviewFlags(
    base({ githubStatus: "checked", githubIdentity: "mismatch", githubAccountName: "Brad T", githubMandatoryGaps: [{ tech: "Firebase", reason: "none" }], githubAiLikelihood: "high" } as Partial<DomainCandidateOutcome>),
    planOf(),
  );
  check("GitHub flags: identity, mandatory gap, AI signal", gh.length === 3, gh);
  check("no evidence quoted flagged", reviewFlags(base({ domainProofs: [] }), planOf()).some((f) => f.includes("No resume evidence")));
  check("verdict: clean → COMPLETED", jobVerdict({ shortlisted: 5, requested: 5, unscored: 0, flaggedShortlisted: 0, briefSource: "llm" }).status === "completed");
  const v = jobVerdict({ shortlisted: 3, requested: 5, unscored: 2, flaggedShortlisted: 1, briefSource: "focus" });
  check("verdict: shortfall / unscored / flagged / fallback → AWAITING_REVIEW with every reason", v.status === "awaiting_review" && v.reasons.length === 4, v);
}

// ── Delivery ─────────────────────────────────────────────────────────────────
{
  const report: DomainReportResult = {
    link: "",
    storage: "local",
    shortlisted: 1,
    considered: 2,
    candidates: [base({ id: "u1", signals: ["Shortlisted at rank 1 of 1"] }), base({ id: "u2", name: "Bala", rank: 0, shortlisted: false, outcomeReason: "Domain fit 40 is below the 55 bar", priority: 0 })],
    excluded: { mandatory: 0, leetcode: 0, dsa: 0, commits: 0, experience: 0, presentation: 0 },
    limitedToTopN: true,
    reportSkipped: true,
  };
  const t = deliveryTable(report, planOf(), {
    jobId: "11111111-2222-3333-4444-555555555555",
    deliveredAt: "28 Oct 2026, 15:00 IST",
    sourceTabOf: (id) => (id === "u1" ? "Edge Applied" : ""),
    flagsOf: (id) => (id === "u1" ? ["Borderline domain fit (57, bar 55)"] : []),
  });
  check("only the shortlist is delivered", t.rows.length === 1 && t.rows[0].Name === "Asha", t.rows.length);
  check("job columns first", t.headers.slice(0, 5).join("|") === "Job ID|Delivered At|Source Tab|Review Flags|Rank", t.headers.slice(0, 6));
  check("row carries job, source tab and flags", t.rows[0]["Job ID"].startsWith("11111111") && t.rows[0]["Source Tab"] === "Edge Applied" && t.rows[0]["Review Flags"] === "• Borderline domain fit (57, bar 55)");
  check("Signals and internal columns present", t.headers.includes("Signals") && t.headers.includes("Internal Standing"));

  const merged = mergeHeaders(["Job ID", "Rank", "", "Old Column", "", ""], ["Job ID", "Rank", "Name", "Signals"]);
  check("existing headers kept in place, new ones appended", merged.headers.join("|") === "Job ID|Rank||Old Column|Name|Signals" && merged.added.join("|") === "Name|Signals", merged);
  const rows = sheetRows(["Name", "", "Rank"], [{ Name: "Asha", Rank: "1" }]);
  check("rows follow the tab's header order (blank header = blank cell)", JSON.stringify(rows) === JSON.stringify([["Asha", "", "1"]]));
  check("re-delivery detected by Job ID", deliveredBefore(["a", "11111111-2222-3333-4444-555555555555", "b"], "11111111-2222-3333-4444-555555555555") === 1 && deliveredBefore([], "x") === 0);
  check("column letters", columnLetter(1) === "A" && columnLetter(26) === "Z" && columnLetter(27) === "AA" && columnLetter(37) === "AK");
  check("cells capped under the Sheets limit", cellText("x".repeat(60_000)).length === 45_000 && cellText(null) === "");
}

// ── Status text ──────────────────────────────────────────────────────────────
{
  const id = "11111111-2222-3333-4444-555555555555";
  const at = new Date("2026-10-28T09:30:00Z");
  const pending = detailsText({ jobId: id, status: "pending", step: "queued", progress: {}, result: null, error: null, queueAhead: 2, at });
  check("pending: queue position, IST time, job id last", pending === `Queued behind 2 jobs · 15:00 IST · job ${id}`, pending);
  const proc = detailsText({ jobId: id, status: "processing", step: "screening", progress: { read: 389, screened: 120, matches: 14 }, result: null, error: null, at });
  check("processing: counts", proc.startsWith("Screening resumes 120 / 389 · 14 domain matches"), proc);
  const done = detailsText({
    jobId: id,
    status: "awaiting_review",
    step: "done",
    progress: {},
    error: null,
    at,
    result: {
      destinationTab: "psm_final_shortlisted_2026-10-28",
      destinationUrl: "",
      sourceTitle: "Uni Cards || Internal",
      shortlisted: 4,
      requested: 5,
      read: 389,
      scored: 371,
      notResumes: 3,
      unscored: 15,
      duplicates: 12,
      flagged: 1,
      reviewReasons: ["only 4 of 5 cleared every requirement"],
      rowsWritten: 4,
    },
  });
  check("finished: where, counts and the review reason", done.startsWith("4 of 5 shortlisted → psm_final_shortlisted_2026-10-28 (Uni Cards || Internal) · 389 read · 371 scored · 3 not resumes · 12 duplicates merged · Review: only 4 of 5"), done);
  const fail = detailsText({ jobId: id, status: "failed", step: "planning", progress: {}, result: null, error: 'Tab "X" not found', at });
  check("failed: the reason", fail.startsWith('Failed: Tab "X" not found') && fail.endsWith(`job ${id}`));
}

void (null as unknown as DomainCandidate);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
