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
import { KEY_COLUMNS, cellText, columnLetter, deliveredKeys, deliveryTable, planHeaders, rowKey, sheetRows, unscoredRow } from "@/lib/automation/delivery-rules";
import { contenders, scoreBounds, shortlistFinal, waveOf } from "@/lib/automation/ranking-bounds";
import { adaptiveConcurrency } from "@/lib/automation/load";
import { buildJdTechSpec, mandatoryTechsAbsent, splitMandatoryItems } from "@/lib/github-analysis";
import type { InternalStanding } from "@/lib/pool/types";
import { jobVerdict, reviewFlags } from "@/lib/automation/validation";
import { detailsLink, detailsText } from "@/lib/automation/sheet-text";
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

// ── Delivery: complete screening, mobile number as the key ───────────────────
{
  const report: DomainReportResult = {
    link: "",
    storage: "local",
    shortlisted: 1,
    considered: 2,
    candidates: [
      base({ id: "9876543210", phone: "+91 98765 43210", signals: ["Shortlisted at rank 1 of 1"] }),
      base({ id: "u2", name: "Bala", phone: "9123456780", rank: 0, shortlisted: false, outcomeReason: "Domain fit 40 is below the 55 bar", priority: 0 }),
    ],
    excluded: { mandatory: 0, leetcode: 0, dsa: 0, commits: 0, experience: 0, presentation: 0 },
    limitedToTopN: true,
    reportSkipped: true,
  };
  const ctx = {
    jobId: "11111111-2222-3333-4444-555555555555",
    deliveredAt: "29 Oct 2026, 15:00 IST",
    sourceTabOf: (id: string) => (id === "9876543210" ? "Edge Applied" : "Academy Applied"),
    flagsOf: (id: string) => (id === "9876543210" ? ["Borderline domain fit (57, bar 55)"] : []),
    unscored: [unscoredRow({ ...base({ id: "9000000001", name: "Cara" }), phone: "9000000001" }, "error", "Couldn't download the resume", null, "Edge Applied")],
  };
  const t = deliveryTable(report, planOf(), ctx);
  check("key columns first, mobile number before the name", t.headers.slice(0, 9).join("|") === KEY_COLUMNS.join("|"), t.headers.slice(0, 9));
  check("no separate Phone column", !t.headers.includes("Phone"));
  check("complete screening: shortlist, then the rest, then unscreened", t.rows.map((r) => r.Status).join("|") === "Shortlisted|Not shortlisted|Could not be evaluated", t.rows.map((r) => r.Status));
  check("mobile numbers as 10 digits", t.rows.map((r) => r["Mobile Number"]).join("|") === "9876543210|9123456780|9000000001", t.rows.map((r) => r["Mobile Number"]));
  check("rows carry source tab, flags and Signals", t.rows[0]["Source Tab"] === "Edge Applied" && t.rows[0]["Review Flags"] === "• Borderline domain fit (57, bar 55)" && t.rows[2]["Source Tab"] === "Edge Applied" && t.rows[2].Signals.includes("Could not be evaluated"));
  const s = deliveryTable(report, planOf(), ctx, "shortlist");
  check("the early delivery is the shortlist alone", s.rows.length === 1 && s.rows[0].Name === "Asha");

  // An older tab: key columns inserted in place, others appended; nothing moves under existing data.
  const old = ["Job ID", "Delivered At", "Source Tab", "Review Flags", "Rank", "Name", "Status", "Domain Score"];
  const p = planHeaders(old, t.headers);
  check("missing key columns are inserted at their place", p.headers.slice(0, 5).join("|") === "Job ID|Delivered At|Mobile Number|Source Tab|Review Flags" && p.inserts[0] === 2, p);
  check("other new columns are appended at the end", p.appended.includes("Signals") && p.headers.indexOf("Signals") > p.headers.indexOf("Domain Score"));
  check("an empty tab gets the full header", planHeaders([], t.headers).headers.join("|") === t.headers.join("|"));

  // Idempotency by mobile number.
  const headers = p.headers;
  const written = sheetRows(headers, s.rows);
  const keys = deliveredKeys(headers, written, ctx.jobId);
  check("rows already written for this job are recognised by mobile number", keys.has("m:9876543210") && keys.size === 1, [...keys]);
  check("…and skipped on the full delivery", t.rows.filter((r) => !keys.has(rowKey(r))).length === 2);
  check("another job's rows don't count", deliveredKeys(headers, written, "other-job").size === 0);
  check("row key falls back to user id, then tab + name", rowKey({ "Mobile Number": "", "User ID": "ABC-1" }) === "u:abc-1" && rowKey({ "Source Tab": "T", Name: "N" }) === "r:T|N");
  check("column letters", columnLetter(1) === "A" && columnLetter(26) === "Z" && columnLetter(27) === "AA" && columnLetter(37) === "AK");
  check("cells capped under the Sheets limit", cellText("x".repeat(60_000)).length === 45_000 && cellText(null) === "");
}

// ── Ranking bounds: who can still reach the top N ────────────────────────────
{
  const tier = (t: 1 | 2 | 3): InternalStanding => ({ tier: t, label: `T${t}`, product: "edge2", score: 50, eligible: true, matchedBy: "phone", standings: [] });
  const cfg = { topN: 2, useGithub: true, useDsa: false, mandatoryActive: true, dsaGates: { minSolved: 0, minContests: 0, minScore: 0, minRating: { leetcode: 0, codeforces: 0, codechef: 0 } } };
  const c = (id: string, fit: number, t: 1 | 2 | 3 | null, o: Partial<DomainCandidateOutcome> = {}) => base({ id, domainScore: fit, internal: t ? tier(t) : null, ...o });
  const pool = [c("a", 90, 1), c("b", 80, 1), c("c", 75, 1), c("d", 55, 1), c("e", 95, 2), c("x", 99, null), c("m", 95, 1, { meetsMandatory: false })];
  const g = contenders(pool, cfg, "github");
  // K = 2nd at the lowest = b (80). Contenders in tier 1 with max ≥ 80: a, b, c (75+20), not d (55+20 = 75).
  check("contenders: within reach of the N-th place", [...g].sort().join() === "a,b,c", [...g]);
  check("a lower stage or external can't overtake, whatever their fit", !g.has("e") && !g.has("x"));
  check("a candidate missing a must-have is never a contender", !g.has("m"));
  check("bounds before GitHub: up to +20", scoreBounds(c("q", 70, 1), cfg, "github").max === 90 && scoreBounds(c("q", 70, 1), cfg, "github").min === 70);
  const after = c("r", 70, 1, { githubStatus: "checked", githubScore: 50, githubTopRepos: [{ name: "x", url: "u", matchPct: 80, techs: [] }] } as Partial<DomainCandidateOutcome>);
  const rb = scoreBounds(after, cfg, "review");
  check("bounds before the code review: 40% of GitHub up to +60", rb.min === 70 + 4 && rb.max === 70 + 16, rb);
  check("GitHub off: no spread", scoreBounds(c("q", 70, 1), { ...cfg, useGithub: false }, "github").max === 70);
  check("fewer than N clear: everyone is a contender", contenders([c("a", 90, 1)], { ...cfg, topN: 5 }, "github").size === 1);

  // The shortlist is final once nobody unscreened can enter it.
  const screenedTop = [c("a", 90, 1), c("b", 80, 1)];
  check("final: N TR-2 fits, only TR-1 / external left", shortlistFinal(screenedTop, [tier(2), tier(3), null], cfg));
  check("not final while a TR-2 is unscreened", !shortlistFinal(screenedTop, [tier(1)], cfg));
  check("not final with fewer than N cleared", !shortlistFinal([c("a", 90, 1)], [tier(2)], cfg));
  check("waves: TR-2, TR-1, assessment, then everyone else", waveOf(tier(1)) === 0 && waveOf(tier(3)) === 2 && waveOf(null) === 3);
}

// ── "X or Y" must-haves (GitHub) ─────────────────────────────────────────────
{
  const stan = "Node.js or Golang APIs; MongoDB or MySQL; RESTful APIs with Express.js, NestJS, Gin or Fiber; JWT authentication";
  const groups = buildJdTechSpec(stan, "", { modelledOnly: true }).mandatoryGroups ?? [];
  check("alternatives are one requirement each", JSON.stringify(groups) === JSON.stringify([["Node.js / Express", "Go"], ["SQL", "MongoDB"], ["REST APIs"]]), groups);
  const legacy = buildJdTechSpec(stan.replace(/; /g, ", "), "", { modelledOnly: true }).mandatoryGroups;
  check("the same groups from a comma-joined text", JSON.stringify(legacy) === JSON.stringify(groups), legacy);
  check("a plain list stays separate requirements", JSON.stringify(buildJdTechSpec("React, Node.js, MongoDB", "", { modelledOnly: true }).mandatoryGroups) === JSON.stringify([["React"], ["Node.js / Express"], ["MongoDB"]]));
  check("'Java/Kotlin and Spring Boot' = (Java or Kotlin) + Spring Boot", JSON.stringify(splitMandatoryItems("Java/Kotlin and Spring Boot").map((i) => i.alternatives)) === "[true,false]");
  check("a Go resume isn't failed on an Express alternative", mandatoryTechsAbsent(stan, "Built REST APIs in Go with Gin and MySQL, JWT auth").length === 0);
  check("a plain must-have the resume never names is still caught", mandatoryTechsAbsent("React, Node.js", "Built a React app with Firebase").join() === "Node.js / Express");
}

// ── Free-plan back-pressure ──────────────────────────────────────────────────
{
  const MB = 1024 * 1024;
  check("full width with memory to spare", adaptiveConcurrency(5, 8, 200 * MB) === 5);
  check("halved when memory is high", adaptiveConcurrency(5, 8, 400 * MB) === 2);
  check("one at a time near the limit", adaptiveConcurrency(5, 8, 460 * MB) === 1);
  check("never above the maximum", adaptiveConcurrency(20, 8, 100 * MB) === 8);
}

// ── Status text ──────────────────────────────────────────────────────────────
{
  const id = "11111111-2222-3333-4444-555555555555";
  const at = new Date("2026-10-28T09:30:00Z");
  const pending = detailsText({ jobId: id, status: "pending", step: "queued", progress: {}, result: null, error: null, queueAhead: 2, at });
  check("pending: queue position, IST time, job id last", pending === `Queued behind 2 jobs · 15:00 IST · job ${id}`, pending);
  const proc = detailsText({ jobId: id, status: "processing", step: "screening", progress: { read: 111, screened: 40, matches: 30, mustHaves: 20 }, result: null, error: null, at });
  check("processing: fit and must-haves counted apart", proc.startsWith("Screening resumes 40 / 111 · 30 fit the domain · 20 meet every must-have"), proc);
  const early = { read: 111, screened: 60, matches: 50, mustHaves: 30, shortlistTab: "psm_final_shortlisted_2026-10-29", shortlistUrl: "https://docs.google.com/x#gid=1", shortlistCount: 10 };
  const ready = detailsText({ jobId: id, status: "processing", step: "screening", progress: early, result: null, error: null, at });
  check("shortlist ready while the rest is screened", ready.startsWith("Shortlist ready (10) → psm_final_shortlisted_2026-10-29 · Completing the full screening 60 / 111"), ready);
  const link = detailsLink(ready, { progress: early, result: null });
  check("the tab name is the link", Boolean(link) && ready.slice(link!.start, link!.end) === "psm_final_shortlisted_2026-10-29" && link!.url.endsWith("#gid=1"));
  const result = {
    destinationTab: "psm_final_shortlisted_2026-10-29",
    destinationUrl: "https://docs.google.com/x#gid=1",
    sourceTitle: "Stan || Internal",
    shortlisted: 10,
    requested: 10,
    read: 111,
    scored: 111,
    notResumes: 0,
    unscored: 0,
    duplicates: 1,
    flagged: 0,
    reviewReasons: [],
    rowsWritten: 111,
    complete: true,
  };
  const done = detailsText({ jobId: id, status: "completed", step: "done", progress: {}, error: null, at, result });
  check("finished: shortlist and the complete ranking", done.startsWith("10 of 10 shortlisted, all 111 candidates ranked → psm_final_shortlisted_2026-10-29 (Stan || Internal) · 111 read · 111 scored · 1 duplicates merged"), done);
  check("no link before anything is delivered", detailsLink(proc, { progress: {}, result: null }) === null);
  const fail = detailsText({ jobId: id, status: "failed", step: "planning", progress: {}, result: null, error: 'Tab "X" not found', at });
  check("failed: the reason", fail.startsWith('Failed: Tab "X" not found') && fail.endsWith(`job ${id}`));
}

void (null as unknown as DomainCandidate);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
