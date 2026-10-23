/**
 * Candidate Bucketing — deterministic self-test (no network, no models).
 * Covers the commit-integrity audit, trace files, bucket rules, scoring, stage /
 * track / verdict normalisation, interview-export parsing, the stage arbiter and
 * the final verifier on fixture state.
 *
 *   npx tsx scripts/bucketing-selftest.ts
 */
import "./server-only-shim";
import { normalizeStage, normalizeTrack, normalizeVerdict, priorityTier, stageLabel, TRUST } from "@/lib/bucketing/config";
import { auditStrict, buildIdentity, traceFiles } from "@/lib/bucketing/commit-integrity";
import { bucketsFor, provenTechSet, synthFromRepo } from "@/lib/bucketing/bucket-rules";
import {
  achievementsScore,
  compareForRanking,
  dsaScore,
  experienceScore,
  internalScore,
  overallScore,
  platformScore,
  projectsScore,
} from "@/lib/bucketing/scoring";
import { stageArbiterNode } from "@/lib/bucketing/nodes/stage-arbiter";
import { finalVerifierNode } from "@/lib/bucketing/nodes/final-verifier";
import { eligibility } from "@/lib/bucketing/nodes/bucketing-agent";
import { inspectInterviewExport, parseBucketingInput, parseResumeSheet } from "@/lib/bucketing/parse";
import { planRefresh } from "@/lib/bucketing/refresh";
import { buildCompleteCsv } from "@/lib/bucketing/csv";
import type { GithubCommitItem } from "@/lib/github-analysis";
import type { State } from "@/lib/bucketing/state";
import type { BucketDecision, BucketingCandidateInput, BucketingResult, Extraction, InterviewRecord, ProjectEvidence, ResumeInfo } from "@/lib/bucketing/types";
import { EMPTY_SCORES, emptyDsa, failedBucketingResult, hireTrackBuckets, interviewNote, journeyClosed } from "@/lib/bucketing/types";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const section = (s: string) => console.log(`\n${s}`);

// ── Stage / track ────────────────────────────────────────────────────────────
section("stage / track normalisation");
ok("TR2 cleared", normalizeStage("TR2 cleared") === "TR2");
ok("tr-2", normalizeStage("tr-2") === "TR2");
ok("TR-1 Cleared", normalizeStage("TR-1 Cleared") === "TR1");
ok("Assessment Cleared", normalizeStage("Assessment Cleared") === "ASSESSMENT");
ok("TR-2 rejected is not TR-2", normalizeStage("TR-2 Rejected") === null);
ok("MERN", normalizeTrack("MERN Stack") === "MERN");
ok("Python FS", normalizeTrack("Python FS") === "PYTHON_FS");
ok("Java Full Stack", normalizeTrack("Java Full Stack") === "JAVA_FS");
ok("Gen AI", normalizeTrack("Gen AI") === "GENAI");
ok("AI-ML → DS / ML", normalizeTrack("AI-ML") === "DSML");
ok("ds&ml", normalizeTrack("ds&ml") === "DSML");
ok("Data Analytics", normalizeTrack("Data Analytics") === "DATA_ANALYTICS");
ok("mern fullstack", normalizeTrack("mern fullstack") === "MERN");
ok("python fullstack", normalizeTrack("python fullstack") === "PYTHON_FS");
ok("gen ai", normalizeTrack("gen ai") === "GENAI");
ok("product", normalizeTrack("product") === "PRODUCT");
ok("strong_hire", normalizeVerdict("strong_hire") === "STRONG_HIRE");
ok("Medium Hire", normalizeVerdict("Medium Hire") === "MEDIUM_HIRE");
ok("rejected is no verdict", normalizeVerdict("rejected") === null);
ok("label names the track and verdict", stageLabel("TR2", "MERN", "STRONG_HIRE") === "MERN TR-2 · Strong hire", stageLabel("TR2", "MERN", "STRONG_HIRE"));
ok("combined-interview label", stageLabel("TR2", null, "MEDIUM_HIRE") === "Combined interview · Medium hire");
ok("tiers: strong 1 · medium 2 · low 3 · TR-1 4 · Asmt 5", [
  priorityTier("TR2", "STRONG_HIRE"),
  priorityTier("TR2", "MEDIUM_HIRE"),
  priorityTier("TR2", "LOW_HIRE"),
  priorityTier("TR1", null),
  priorityTier("ASSESSMENT", null),
].join() === "1,2,3,4,5");

// ── Sheet parsing ────────────────────────────────────────────────────────────
section("sheet parsing");
{
  const csv = [
    ",,,Frontend,,",
    'UID,Name,Number,Parent Contact,Resume,Bucket A TR 1 Status,Bucket A TR 2 Status,Track',
    "1,Ravi Kumar,+91 98765 43210,9000000000,https://drive.google.com/file/d/abc/view,Cleared,Cleared,MERN",
    "2,Priya S,9123456780,9000000001,https://drive.google.com/file/d/def/view,Cleared,Not cleared,",
    "3,Arun T,9988776655,9000000002,,Not cleared,,",
    "4,Asha R,9876501234,9000000003,https://drive.google.com/file/d/ghi/view,,,",
  ].join("\n");
  const rows = parseBucketingInput(csv, { batch: 1, existing: new Map(), defaultStage: "ASSESSMENT", csv: true });
  const good = rows.filter((r) => r.candidate);
  ok("header on row 2, four candidates", good.length === 4, rows.map((r) => r.problem));
  ok("mobile is the candidate's, not the parent's", good[0]?.candidate?.id === "9876543210", good[0]?.candidate);
  ok("TR-2 status + track → MERN TR-2", good[0]?.candidate?.stage === "TR2" && good[0]?.candidate?.track === "MERN");
  ok("TR-1 status → TR1", good[1]?.candidate?.stage === "TR1");
  ok("no status → default (Assessment)", good[3]?.candidate?.stage === "ASSESSMENT");
  ok("no resume link → still a candidate, resume empty", good.some((r) => r.candidate?.id === "9988776655" && r.candidate.resumeUrl === ""));
  const loose = parseBucketingInput("9876543210  https://x.com/r.pdf  TR-2 cleared  Gen AI", { batch: 1, existing: new Map(), defaultStage: "ASSESSMENT" });
  ok("header-less row read by content", loose[0]?.candidate?.stage === "TR2" && loose[0]?.candidate?.track === "GENAI", loose[0]);
}

// ── Interview export + resume sheet ──────────────────────────────────────────
section("interview export + resume sheet");
{
  const head = [
    "id", "name", "phone", "tr1Status", "tr1DsaOverallRating", "tr1OverallTechnicalScore", "offlineOverallScore", "dsaCodingScore",
    "csFundamentalsScore", "sqlMcqScore", "sqlCodingScore", "combinedInterviewVerdict (read-only)",
    "TR2 mern fullstack State", "TR2 mern fullstack Verdict", "TR2 gen ai Verdict", "TR2 ds&ml Verdict", "TR2 product Verdict",
  ];
  const csv = [
    head.join(","),
    "a1,Ravi Kumar,9876543210,pass,7,72,120,90,30,10,12,,done,medium_hire,strong_hire,,",
    "a2,Priya S,9123456780,pass,6,60,100,75,25,,,medium_hire,,,,,",
    "a3,Arun T,9988776655,pass,5,55,95,70,25,,,,done,rejected,,,",
    "a4,Asha R,9876501234,,,,80,60,20,,,,,,,,",
    "a5,Kiran P,9000011111,pass,8,70,130,100,30,,,,,,,low_hire,strong_hire",
  ].join("\n");
  const pii = ["Full Name,Roll Number,Phone Number,Resume Link", "Ravi Kumar,9999912345,+91 98765 43210,https://drive.google.com/file/d/r1/view"].join("\n");
  const resumes = parseResumeSheet(pii, true);
  ok("resume sheet keyed by the phone, not the roll number", resumes.has("9876543210") && !resumes.has("9999912345"), [...resumes.keys()]);
  const rows = parseBucketingInput(csv, { batch: 1, existing: new Map(), defaultStage: "ASSESSMENT", csv: true, resumes });
  const by = (m: string) => rows.find((r) => r.candidate?.id === m)?.candidate;
  const ravi = by("9876543210");
  ok("best TR-2 verdict picks the track (gen ai strong > mern medium)", ravi?.stage === "TR2" && ravi.track === "GENAI" && ravi.verdict === "STRONG_HIRE", ravi);
  ok("both hire tracks kept, best first", ravi?.interview?.tr2.map((t) => `${t.track}:${t.verdict}`).join() === "GENAI:STRONG_HIRE,MERN:MEDIUM_HIRE", ravi?.interview?.tr2);
  ok("scores read", ravi?.interview?.tr1.overallTechnical === 72 && ravi.interview.assessment.offlineOverall === 120 && ravi.interview.assessment.sqlCoding === 12);
  ok("resume joined by phone", ravi?.resumeUrl === "https://drive.google.com/file/d/r1/view", ravi?.resumeUrl);
  const priya = by("9123456780");
  ok("combined-interview hire → TR-2 with no track", priya?.stage === "TR2" && priya.track === null && priya.verdict === "MEDIUM_HIRE", priya);
  const arun = by("9988776655");
  ok("TR-2 rejected → TR-1 cleared", arun?.stage === "TR1" && arun.interview?.tr2Rejected.join() === "MERN", arun);
  ok("no TR-1 → Assessment", by("9876501234")?.stage === "ASSESSMENT");
  const kiran = by("9000011111");
  ok("Product strong hire keeps its tier", kiran?.track === "PRODUCT" && kiran.verdict === "STRONG_HIRE", kiran);
  ok("…and the DS/ML hire gives the bucket", kiran ? hireTrackBuckets(kiran).join() === "DSML" : false, kiran?.interview?.tr2);
}

// ── Commit integrity ─────────────────────────────────────────────────────────
section("commit integrity (strict)");
let n = 0;
const commit = (o: { login?: string | null; name?: string; email?: string; message?: string; parents?: number; committer?: string }): GithubCommitItem => ({
  sha: `${(++n).toString(16).padStart(7, "0")}abcdef`,
  commit: {
    message: o.message ?? "feat: add login page",
    author: { name: o.name ?? "Ravi Kumar", email: o.email ?? "ravi@gmail.com", date: new Date(Date.UTC(2026, 5, n)).toISOString() },
    committer: { name: o.name ?? "Ravi Kumar", email: o.email ?? "ravi@gmail.com", date: new Date(Date.UTC(2026, 5, n)).toISOString() },
  },
  author: o.login === null ? null : { login: o.login ?? "ravi-dev" },
  committer: o.committer ? { login: o.committer } : null,
  parents: Array.from({ length: o.parents ?? 1 }, (_, i) => ({ sha: `p${i}` })),
});
const own = [commit({}), commit({ message: "fix: validation" }), commit({ message: "chore: readme" })];
const id = buildIdentity(["ravi-dev"], own, ["Ravi Kumar Reddy"]);

const clean = auditStrict(own, id, { truncated: false, fileCount: 30 });
ok("own commits → clean", clean.verdict === "clean" && clean.candidateCommits === 3, clean);

const claude = auditStrict(
  [...own, commit({ message: "feat: dashboard\n\nCo-Authored-By: Claude <noreply@anthropic.com>" })],
  id,
  { truncated: false, fileCount: 30 },
);
ok("Claude Code trailer → ai (test 2)", claude.verdict === "ai" && claude.aiCount === 1, claude);

const antigravity = auditStrict([...own, commit({ message: "add charts\n\nCo-authored-by: Antigravity" })], id, { truncated: false, fileCount: 30 });
ok("Antigravity name-only trailer → ai", antigravity.verdict === "ai", antigravity);

const cursor = auditStrict([...own, commit({ message: "refactor\n\nCo-authored-by: Cursor <cursoragent@cursor.com>" })], id, { truncated: false, fileCount: 30 });
ok("Cursor trailer → ai", cursor.verdict === "ai", cursor);

const tutorial = auditStrict([...own, commit({ login: "tutorial-author", name: "Tutorial Author", email: "t@x.com" })], id, { truncated: false, fileCount: 30 });
ok("someone else's commit → foreign (test 3)", tutorial.verdict === "foreign" && tutorial.foreignCount === 1, tutorial);

const teammate = auditStrict([...own, commit({ message: "feat: api\n\nCo-authored-by: Priya S <priya@gmail.com>" })], id, { truncated: false, fileCount: 30 });
ok("teammate co-author → foreign", teammate.verdict === "foreign", teammate);

const unlinkedSame = auditStrict([...own, commit({ login: null, email: "ravi@gmail.com", name: "ravi" })], id, { truncated: false, fileCount: 30 });
ok("unlinked commit with the candidate's email → candidate (test 13)", unlinkedSame.verdict === "clean", unlinkedSame);

const unlinkedName = auditStrict([...own, commit({ login: null, email: "laptop@DESKTOP-1", name: "Ravi Kumar" })], id, { truncated: false, fileCount: 30 });
ok("unlinked commit with the resume name → candidate", unlinkedName.verdict === "clean", unlinkedName);

const unlinkedOther = auditStrict([...own, commit({ login: null, email: "user@DESKTOP-9", name: "HP" })], id, { truncated: false, fileCount: 30 });
ok("unlinked unknown identity → foreign (strict)", unlinkedOther.verdict === "foreign", unlinkedOther);

const bots = auditStrict([...own, commit({ login: "dependabot[bot]", name: "dependabot[bot]", email: "x@users.noreply.github.com" })], id, { truncated: false, fileCount: 30 });
ok("dependabot → exempt", bots.verdict === "clean" && bots.exempt === 1, bots);

const merge = auditStrict([...own, commit({ parents: 2, message: "Merge pull request #2" })], id, { truncated: false, fileCount: 30 });
ok("candidate merge → exempt", merge.verdict === "clean" && merge.exempt === 1, merge);

const humanClaude = auditStrict([...own, commit({ message: "feat\n\nCo-authored-by: Claude Martin <claude.martin@gmail.com>" })], id, { truncated: false, fileCount: 30 });
ok("a human named Claude is foreign, not AI", humanClaude.verdict === "foreign", humanClaude);

const dump = auditStrict([commit({})], id, { truncated: false, fileCount: 80 });
ok("single dump → flag only", dump.verdict === "clean" && dump.flags.some((f) => /landed in 1 commit/.test(f)), dump);

// ── Trace files ──────────────────────────────────────────────────────────────
section("AI-tool trace files (test 4)");
ok("CLAUDE.md", traceFiles(["CLAUDE.md", "src/a.js"], "", []).length === 1);
ok(".cursorrules", traceFiles([".cursorrules"], "", []).length === 1);
ok("Antigravity .agents/rules", traceFiles([".agents/rules/style.md"], "", []).length === 1);
ok("Antigravity .agent/workflows", traceFiles([".agent/workflows/deploy.md"], "", []).length === 1);
ok("lower-case docs/agents.md is not a trace", traceFiles(["docs/agents.md"], "", []).length === 0);
ok("README 'built using ChatGPT' is not a trace", traceFiles([], "A chatbot built using ChatGPT API", []).length === 0);
ok("lovable-tagger", traceFiles([], "", ["lovable-tagger"]).length === 1);

// ── Bucket rules ─────────────────────────────────────────────────────────────
section("bucket rules (code-verified techs)");
const techs = (...keys: string[]) => keys.map((key) => ({ key, conf: 0.9, hard: true }));
const set = (keys: string[], paths: string[] = [], deps: string[] = []) => provenTechSet(techs(...keys), synthFromRepo(paths, deps));
ok("MERN", bucketsFor(set(["react", "nodejs", "mongodb", "javascript"])).join() === "MERN");
ok("Next.js API routes + Mongo = MERN", bucketsFor(set(["react", "mongodb"], ["app/api/users/route.ts"])).includes("MERN"));
ok("React + Express, no Mongo → not MERN", bucketsFor(set(["react", "nodejs"])).length === 0);
ok("React only → no bucket (Frontend is not a bucket)", bucketsFor(set(["react"])).length === 0);
ok("Django + templates + models → Python FS", bucketsFor(set(["django", "html-css"], ["app/models.py", "app/templates/index.html"])).includes("PYTHON_FS"));
ok("Spring Boot + JPA + Thymeleaf → Java FS", bucketsFor(set(["spring-boot", "sql"], ["src/main/resources/templates/home.html"])).includes("JAVA_FS"));
ok("scikit-learn → DS / ML, not GenAI", bucketsFor(set(["scikit-learn", "pandas", "python"])).join() === "DSML");
ok("Pandas + charts → Data Analytics", bucketsFor(set(["pandas", "data-viz", "python"])).join() === "DATA_ANALYTICS");
ok("Power BI → Data Analytics", bucketsFor(set(["powerbi"])).includes("DATA_ANALYTICS"));
ok("Pandas alone → no bucket", bucketsFor(set(["pandas", "python"])).length === 0);
ok("OpenAI SDK → GenAI", bucketsFor(set(["llm", "fastapi-or-flask"])).includes("GENAI"));
ok("low confidence doesn't count", bucketsFor(provenTechSet([{ key: "react", conf: 0.3, hard: true }], [])).length === 0);

// ── Scoring ──────────────────────────────────────────────────────────────────
section("scoring");
const cf = platformScore("codeforces", { solved: 300, contests: 20, rating: 1500 });
const lc = platformScore("leetcode", { solved: 450, contests: 20, rating: 1900 });
ok("platform scores in 0-1", cf > 0 && cf <= 1 && lc > 0 && lc <= 1, { cf, lc });
const base = { ...emptyDsa().platforms };
const onlyCf = dsaScore({ ...base, codeforces: { ...base.codeforces, score: 0.6, solved: 300 } });
const onlyLc = dsaScore({ ...base, leetcode: { ...base.leetcode, score: 0.6, solved: 300 } });
ok("Codeforces outranks LeetCode at equal strength", onlyCf > onlyLc, { onlyCf, onlyLc });
ok("rating without contests ignored", platformScore("codeforces", { solved: 0, contests: 0, rating: 1800 }) === 0);

const iv = (o: { tr1?: number | null; offline?: number | null; sqlMcq?: number | null; sqlCoding?: number | null } = {}): InterviewRecord => ({
  tr2: [],
  tr2Rejected: [],
  combined: null,
  tr1: { status: "pass", selfIntro: null, dsaOverall: null, problemSolving: null, coding: null, communication: null, debugging: null, overallTechnical: o.tr1 ?? null },
  assessment: { offlineOverall: o.offline ?? null, dsaCoding: null, csFundamentals: null, sqlMcq: o.sqlMcq ?? null, sqlCoding: o.sqlCoding ?? null },
});
const full = internalScore(iv({ tr1: 70, offline: 120 }), "STRONG_HIRE", "MERN");
ok("internal = 50% TR-2 + 30% TR-1 + 20% assessment", full.score === 86 && full.parts.tr2 === 100 && full.parts.tr1 === 70 && full.parts.assessment === 75, full);
ok("internal renormalises over the parts present", internalScore(iv({ offline: 120 }), null, null).score === 75);
const da = internalScore(iv({ offline: 80, sqlMcq: 15, sqlCoding: 15 }), null, "DATA_ANALYTICS");
ok("SQL joins the assessment for Data Analytics", da.score === 65 && da.parts.sql === 100, da);
ok("strong hire outranks medium hire on internal", internalScore(iv({ tr1: 60 }), "STRONG_HIRE", null).score > internalScore(iv({ tr1: 60 }), "MEDIUM_HIRE", null).score);
ok("overall = 40/30/20/10", overallScore({ internal: 100, projects: 50, experience: 0, achievements: 100 }) === 65);
const nb = (o: Partial<ProjectEvidence>): ProjectEvidence => ({
  projectId: "P1", title: "t", status: "verified", valid: true, tier: "B", invalidReason: null, repos: [], demo: null,
  techKeys: [], buckets: ["DSML"], backend: false, notebooks: false, note: "", ...o,
});
ok("notebook on GitHub is a bonus for DS / ML", projectsScore("DSML", [nb({ notebooks: true })], 60, 60) > projectsScore("DSML", [nb({})], 60, 60));
ok("resume-only ML project still scores, below a verified one", projectsScore("DSML", [nb({ tier: "R", status: "resume_only" })], 60, 60) < projectsScore("DSML", [nb({})], 60, 60) && projectsScore("DSML", [nb({ tier: "R", status: "resume_only" })], 60, 60) > 0);
ok("no backing project → projects 0", projectsScore("MERN", [nb({})], 80, 80) === 0);
const role = { id: "E1", company: "X", role: "Intern", kind: "internship" as const, duration: "", months: 6, tech: [], techKeys: [], description: "", quote: "", section: "experience" };
ok("in-domain internship 6 months = 90", experienceScore([role], new Set(["E1"])) === 90, experienceScore([role], new Set(["E1"])));
ok("other-domain role = 20", experienceScore([role], new Set()) === 20);
ok("achievements: hackathon win + merged PR", achievementsScore([{ id: "A1", title: "SIH winner", kind: "win", description: "", quote: "" }], [{ claimId: "O1", url: "", status: "verified", note: "" }], 0) === 55);

// ── Stage arbiter + final verifier (fixtures) ───────────────────────────────
section("stage arbiter / final verifier");
const okResume: ResumeInfo = { status: "ok", source: "pdf", transcribed: false, chars: 3000, note: "", model: "test" };
const proj = (id: string, title: string, o: Partial<ProjectEvidence>): ProjectEvidence => ({
  projectId: id,
  title,
  status: "verified",
  valid: true,
  tier: "B",
  invalidReason: null,
  repos: [{ url: `https://github.com/ravi-dev/${id}`, owner: "ravi-dev", repo: id, status: "verified", invalidReason: null, message: "", resolvedFromProfile: false, fork: "", techs: [], traceFiles: [], integrity: null, homepage: "", srcFiles: 10, notebooks: 0 }],
  demo: null,
  techKeys: [],
  buckets: [],
  backend: false,
  notebooks: false,
  note: "",
  ...o,
});
const extraction = (projects: { id: string; title: string; github?: boolean; live?: boolean }[], roles: Extraction["experience"] = []): Extraction => ({
  candidateName: "Ravi Kumar",
  projects: projects.map((p) => ({
    id: p.id,
    title: p.title,
    description: "",
    quote: p.title,
    section: "projects",
    claimedTech: [],
    claimedTechKeys: [],
    github: p.github === false ? [] : [`https://github.com/ravi-dev/${p.id}`],
    live: p.live ? ["https://x.vercel.app"] : [],
    linkPlacement: "in-section",
    period: "",
  })),
  experience: roles,
  openSource: [],
  achievements: [],
  profiles: { github: null, leetcode: null, codechef: null, codeforces: null },
  urls: [],
  dropped: [],
  model: "test",
});
const decision = (o: Partial<BucketDecision>): BucketDecision => ({
  bucket: null,
  flagshipId: "",
  supportingIds: [],
  basis: "flagship",
  flagshipStrength: 70,
  projectStrengths: {},
  rationale: "",
  eligible: [],
  noBucketReason: "",
  tierCBacked: false,
  roleOnly: [],
  model: "test",
  attempt: 1,
  error: "",
  ...o,
});
function state(o: Partial<State>): State {
  const s = {
    input: { id: "9999999999", mobile: "9999999999", name: "Ravi Kumar", resumeUrl: "x", stage: "ASSESSMENT", track: null, batch: 1 },
    resume: okResume,
    resumeText: "",
    extraction: extraction([]),
    domainAnalysis: { domains: [], primary: null, model: "t", attempt: 1, error: "" },
    domainReview: { verdict: "pass", trust: 90, coverage: 1, agreement: 0.9, issues: [], model: "t", adjusted: [], primary: null },
    projectEvidence: { githubUser: "ravi-dev", githubUserSource: "resume", projects: [], oss: [], callsUsed: 0, unavailable: false, notes: [] },
    bucketing: decision({}),
    bucketReview: { verdict: "pass", trust: 90, coverage: 1, agreement: 1, issues: [], model: "t", betterBucket: null },
    dsa: emptyDsa(),
    dsaReview: { verdict: "pass", trust: 100, coverage: 1, agreement: null, issues: [], model: "" },
    final: null,
    finalReview: null,
    attempts: {},
    trace: [],
    errors: [],
    models: [],
    ...o,
  };
  return s as State;
}
/** Arbiter → verifier (→ arbiter repair) as the graph runs them. */
function decide(s: State): State {
  let cur = { ...s };
  for (let i = 0; i < 2; i++) {
    const a = stageArbiterNode(cur);
    cur = { ...cur, ...a, attempts: { ...cur.attempts, ...a.attempts } } as State;
    const v = finalVerifierNode(cur);
    cur = { ...cur, ...v } as State;
    if (cur.finalReview?.verdict !== "revise") break;
  }
  return cur;
}

const evidence = (projects: ProjectEvidence[], unavailable = false) => ({
  githubUser: "ravi-dev",
  githubUserSource: "resume" as const,
  projects,
  oss: [],
  callsUsed: 0,
  unavailable,
  notes: [],
});
const hire = (track: BucketingCandidateInput["track"], verdict: "STRONG_HIRE" | "MEDIUM_HIRE" | "LOW_HIRE", more: Partial<BucketingCandidateInput> = {}): BucketingCandidateInput => ({
  id: "1",
  mobile: "1",
  name: "Ravi",
  resumeUrl: "x",
  stage: "TR2",
  track,
  verdict,
  interview: {
    ...iv({ tr1: 70, offline: 120 }),
    tr2: track ? [{ track, verdict }] : [],
    combined: track ? null : verdict,
  },
  batch: 1,
  ...more,
});

// Test 5: demo-only projects don't place a candidate without an in-domain role.
{
  const s = decide(
    state({
      extraction: extraction([{ id: "P1", title: "Shop", github: false, live: true }]),
      projectEvidence: evidence([proj("P1", "Shop", { status: "demo_only", tier: "C", repos: [], buckets: ["MERN"] })]),
    }),
  );
  ok("demo links only → NO_GITHUB_LINKED_PROJECT (test 5)", s.final?.status === "not_bucketed" && s.final.reasonCodes.includes("NO_GITHUB_LINKED_PROJECT"), s.final);
}

// Test 6: MERN TR-2 strong hire, agent picked GenAI, a valid MERN project exists → MERN.
{
  const projects = [proj("P1", "RAG Bot", { tier: "A", buckets: ["GENAI"] }), proj("P2", "Shop", { buckets: ["MERN"] })];
  const s = decide(
    state({
      input: hire("MERN", "STRONG_HIRE"),
      extraction: extraction([{ id: "P1", title: "RAG Bot" }, { id: "P2", title: "Shop" }]),
      projectEvidence: evidence(projects),
      bucketing: decision({ bucket: "GENAI", flagshipId: "P1", projectStrengths: { P1: 80, P2: 65 }, eligible: eligibility(projects, []).eligible }),
      domainReview: { verdict: "pass", trust: 90, coverage: 1, agreement: 0.9, issues: [], model: "t", adjusted: [{ domain: "GENAI", score: 75, evidence: [], rationale: "" }, { domain: "MERN", score: 60, evidence: [], rationale: "" }], primary: "GENAI" },
    }),
  );
  ok(
    "MERN TR-2 backed → MERN by the track (test 6)",
    s.final?.bucket === "MERN" && s.final.placedBy === "tr2-track" && s.final.flagshipId === "P2" && s.final.stageLabel === "MERN TR-2 · Strong hire" && s.final.priorityTier === 1,
    s.final,
  );
  ok("remark mentions the resume's own GenAI strength", s.final?.remarks.some((r) => /Generative AI/.test(r)) ?? false, s.final?.remarks);
  ok("track confirmed → bucket trust ≥ 95", (s.finalReview?.components.bucket ?? 0) >= TRUST.trackConfirmed, s.finalReview);
  ok("internal score from TR-2 + TR-1 + assessment", s.final?.scores.internal === 86 && s.final.internalParts.tr2 === 100, s.final?.scores);
}

// Test 7: MERN TR-2 with no MERN evidence → still MERN (the interview decides), flagged.
{
  const projects = [proj("P1", "RAG Bot", { buckets: ["GENAI"] })];
  const s = decide(
    state({
      input: hire("MERN", "MEDIUM_HIRE"),
      extraction: extraction([{ id: "P1", title: "RAG Bot" }]),
      projectEvidence: evidence(projects),
      bucketing: decision({ bucket: "GENAI", flagshipId: "P1", projectStrengths: { P1: 70 }, eligible: ["GENAI"] }),
    }),
  );
  ok("TR-2 track wins + TRACK_MISMATCH (test 7)", s.final?.bucket === "MERN" && s.final.flags.includes("TRACK_MISMATCH") && s.final.trackBacked === false, s.final);
  ok("…needs review, no projects score", s.finalReview?.needsReview === true && s.final?.scores.projects === 0, { review: s.finalReview, scores: s.final?.scores });
}

// Test 8: DS/ML TR-2 with a notebook project described on the resume (no GitHub) → DS / ML.
{
  const projects = [proj("P1", "Churn model", { status: "resume_only", tier: "R", repos: [], buckets: ["DSML"] })];
  const s = decide(
    state({
      input: hire("DSML", "STRONG_HIRE"),
      extraction: extraction([{ id: "P1", title: "Churn model", github: false }]),
      projectEvidence: evidence(projects),
      bucketing: decision({ bucket: "DSML", flagshipId: "P1", projectStrengths: { P1: 60 }, eligible: ["DSML"] }),
    }),
  );
  ok("DS/ML TR-2 → DS / ML, backed by a resume-only ML project (test 8)", s.final?.bucket === "DSML" && s.final.trackBacked === true && s.final.validated, s.final);
}

// Several hire tracks at the same verdict → the one the resume backs.
{
  const projects = [proj("P1", "Shop", { buckets: ["MERN"] })];
  const input = hire("GENAI", "STRONG_HIRE");
  input.interview!.tr2 = [{ track: "GENAI", verdict: "STRONG_HIRE" }, { track: "MERN", verdict: "STRONG_HIRE" }];
  const s = decide(
    state({ input, extraction: extraction([{ id: "P1", title: "Shop" }]), projectEvidence: evidence(projects), bucketing: decision({ bucket: "MERN", flagshipId: "P1", eligible: ["MERN"] }) }),
  );
  ok("tie between hire tracks → the backed one", s.final?.bucket === "MERN" && !s.final.flags.includes("TRACK_MISMATCH"), s.final);
}

// Combined-interview hire: TR-2 tier, bucket from the resume.
{
  const projects = [proj("P1", "Shop", { buckets: ["MERN"] })];
  const s = decide(
    state({ input: hire(null, "MEDIUM_HIRE"), extraction: extraction([{ id: "P1", title: "Shop" }]), projectEvidence: evidence(projects), bucketing: decision({ bucket: "MERN", flagshipId: "P1", eligible: ["MERN"] }) }),
  );
  ok("combined hire → evidence bucket, tier 2", s.final?.bucket === "MERN" && s.final.placedBy === "evidence" && s.final.priorityTier === 2 && s.final.stageLabel === "Combined interview · Medium hire", s.final);
}

// Product-track hire with nothing on the resume → not bucketed, but ranked first among the rejects.
{
  const s = decide(state({ input: hire("PRODUCT", "STRONG_HIRE"), extraction: extraction([]), projectEvidence: evidence([]), bucketing: decision({}) }));
  ok("Product hire, no evidence → not bucketed (tier 1)", s.final?.status === "not_bucketed" && s.final.priorityTier === 1 && s.final.scores.internal > 0, s.final);
}

// A TR-2 hire with no resume link → placed by the interview alone.
{
  const s = decide(
    state({
      input: hire("JAVA_FS", "STRONG_HIRE", { resumeUrl: "" }),
      resume: { status: "unreadable", source: "", transcribed: false, chars: 0, note: "No resume link in the sheet", model: "" },
      extraction: null,
      projectEvidence: null,
      domainAnalysis: null,
      domainReview: null,
      bucketing: null,
      bucketReview: null,
      dsaReview: null,
    }),
  );
  ok("no resume, TR-2 hire → bucket by interview + INTERVIEW_ONLY", s.final?.bucket === "JAVA_FS" && s.final.flags.includes("INTERVIEW_ONLY") && s.final.status === "bucketed", s.final);
  ok("…trust capped and flagged for review", (s.finalReview?.trust ?? 100) <= TRUST.caps.interviewOnly && s.finalReview?.needsReview === true, s.finalReview);
}

// An Assessment candidate with no resume link → NO_RESUME_LINK.
{
  const s = decide(
    state({
      input: { id: "5", mobile: "5", name: "", resumeUrl: "", stage: "ASSESSMENT", track: null, batch: 1, interview: iv({ offline: 90 }) },
      resume: { status: "unreadable", source: "", transcribed: false, chars: 0, note: "No resume link in the sheet", model: "" },
      extraction: null,
      projectEvidence: null,
      domainAnalysis: null,
      domainReview: null,
      bucketing: null,
      bucketReview: null,
      dsaReview: null,
    }),
  );
  ok("no resume, Assessment → NO_RESUME_LINK", s.final?.status === "not_bucketed" && s.final.reasonCodes.includes("NO_RESUME_LINK") && s.final.scores.internal > 0, s.final);
}

// TR-1 candidate placed by an in-domain internship (no project).
{
  const role = { id: "E1", company: "Acme", role: "MERN Intern", kind: "internship" as const, duration: "6 months", months: 6, tech: [], techKeys: ["react", "nodejs", "mongodb"], description: "", quote: "", section: "experience" };
  const elig = eligibility([], [role]);
  const s = decide(
    state({
      input: { id: "6", mobile: "6", name: "", resumeUrl: "x", stage: "TR1", track: null, batch: 1 },
      extraction: extraction([], [role]),
      projectEvidence: evidence([]),
      bucketing: decision({ bucket: "MERN", basis: "internship", eligible: elig.eligible, roleOnly: elig.roleOnly }),
    }),
  );
  ok("in-domain internship places a TR-1 candidate", s.final?.bucket === "MERN" && s.final.placedBy === "evidence" && s.final.scores.experience === 90, s.final);
}

// Test 10: GitHub unavailable → retry_needed (non-TR-2), no trust.
{
  const projects = [proj("P1", "Shop", { status: "unavailable", valid: false, tier: "D" })];
  const s = decide(state({ extraction: extraction([{ id: "P1", title: "Shop" }]), projectEvidence: evidence(projects, true) }));
  ok("GitHub 403 → retry_needed (test 10)", s.final?.status === "retry_needed" && s.final.reasonCodes.includes("GITHUB_UNAVAILABLE") && s.finalReview?.trust === null, { final: s.final, review: s.finalReview });
}

// …but a TR-2 hire is still bucketed, flagged for a re-run.
{
  const projects = [proj("P1", "Shop", { status: "unavailable", valid: false, tier: "D" })];
  const s = decide(state({ input: hire("MERN", "STRONG_HIRE"), extraction: extraction([{ id: "P1", title: "Shop" }]), projectEvidence: evidence(projects, true) }));
  ok("GitHub down, TR-2 hire → bucketed + GITHUB_UNAVAILABLE flag", s.final?.bucket === "MERN" && s.final.flags.includes("GITHUB_UNAVAILABLE") && (s.finalReview?.trust ?? 100) <= TRUST.caps.evidencePending, { final: s.final, review: s.finalReview });
}

// Invalid projects → reasons listed.
{
  const projects = [proj("P1", "Clone", { status: "invalid", valid: false, tier: "D", invalidReason: "FOREIGN_COMMIT" }), proj("P2", "Bot", { status: "invalid", valid: false, tier: "D", invalidReason: "AI_TOOL_COMMIT" })];
  const s = decide(state({ extraction: extraction([{ id: "P1", title: "Clone" }, { id: "P2", title: "Bot" }]), projectEvidence: evidence(projects) }));
  ok("invalid repos → FOREIGN_COMMIT + AI_TOOL_COMMIT", s.final?.status === "not_bucketed" && s.final.reasonCodes.includes("FOREIGN_COMMIT") && s.final.reasonCodes.includes("AI_TOOL_COMMIT"), s.final);
}

// Not a resume (short-circuit): no other agent ran.
{
  const s = decide(
    state({
      resume: { status: "not_resume", source: "image", transcribed: true, chars: 0, note: "The resume link is a photograph, not a resume.", model: "t" },
      extraction: null,
      projectEvidence: null,
      domainAnalysis: null,
      domainReview: null,
      bucketing: null,
      bucketReview: null,
      dsaReview: null,
    }),
  );
  ok("photo → NOT_A_RESUME (test 1)", s.final?.status === "not_bucketed" && s.final.reasonCodes.includes("NOT_A_RESUME"), s.final);
}

// An invalid flagship is replaced by a valid one.
{
  const projects = [proj("P1", "Shop", { buckets: ["MERN"] }), proj("P2", "Clone", { status: "invalid", valid: false, tier: "D", invalidReason: "FOREIGN_COMMIT", buckets: [] })];
  const s = decide(
    state({
      extraction: extraction([{ id: "P1", title: "Shop" }, { id: "P2", title: "Clone" }]),
      projectEvidence: evidence(projects),
      bucketing: decision({ bucket: "MERN", flagshipId: "P2", projectStrengths: { P1: 60 } }),
    }),
  );
  ok("invalid flagship replaced by a valid one", s.final?.bucket === "MERN" && s.final.flagshipId === "P1" && s.finalReview?.verdict === "pass", { final: s.final, review: s.finalReview });
}

// Test 12: ranking — strong → medium → low hire → TR-1 → Assessment, regardless of score.
{
  const rows = [
    { id: "a", priorityTier: 4, scores: { overall: 95 }, trust: { trust: 90 } },
    { id: "b", priorityTier: 1, scores: { overall: 40 }, trust: { trust: 70 } },
    { id: "c", priorityTier: 2, scores: { overall: 80 }, trust: { trust: 70 } },
    { id: "d", priorityTier: 1, scores: { overall: 60 }, trust: { trust: 70 } },
    { id: "e", priorityTier: 5, scores: { overall: 99 }, trust: { trust: 99 } },
  ];
  const order = [...rows].sort(compareForRanking).map((r) => r.id).join("");
  ok("tier first, then score (test 12)", order === "dbcae", order);
}

// ── The drive's interview export, read by column name ───────────────────────
section("interview export (real header, any column order)");
const EXPORT_HEADER = [
  "id", "name", "email", "phone", "college", "event", "currentStage", "journeyStatus (read-only)", "journeyReason (read-only)",
  "journeyClosedAt (read-only)", "journeyClosedBy (read-only)", "journeyNotes (read-only)", "journeyStageAtClosure (read-only)", "overallScore",
  "offlineOverallScore", "dsaCodingScore", "csFundamentalsScore", "dsaInterviewDsaScore", "dsaInterviewCsScore", "qualifyingStatus", "subStage",
  "attemptStatus", "reportLink", "offlineAssessmentReportLink", "currentStageReportLink", "feedback", "dsaInterviewQualifyingStatus",
  "dsaInterviewAttemptStatus", "resumeBasedInterviewQualifyingStatus", "resumeBasedInterviewAttemptStatus", "bqCandidateId", "sqlMcqScore",
  "sqlCodingScore", "tr1InterviewAttemptId", "tr1InterviewAttemptDatetime", "tr1InterviewTitle", "tr1InterviewTag", "tr1SelfIntroRating",
  "tr1DsaOverallRating", "tr1ProblemSolvingAbility", "tr1CodingSkills", "tr1CommunicationAndCollaboration", "tr1DebuggingAndIteration",
  "tr1OverallTechnicalScore", "tr1ReportUrl", "tr1Status", "interviewPath (read-only)", "combinedInterviewState (read-only)",
  "combinedInterviewVerdict (read-only)", "combinedInterviewReportLink (read-only)", "combinedInterviewRecordingLink (read-only)",
  ...["data analytics", "ds&ml", "gen ai", "java fullstack", "mern fullstack", "product", "python fullstack"].flatMap((t) => [
    `TR2 ${t} State`,
    `TR2 ${t} Verdict`,
    `TR2 ${t} Recording Link`,
  ]),
];
const exportRow = (o: Record<string, string>) => EXPORT_HEADER.map((h) => o[h] ?? "");
const EXPORT_ROWS: Record<string, string>[] = [
  // TR-2 strong hire (MERN) — separate path.
  { id: "101", name: "Ananya Rao", email: "a@x.com", phone: "9876543210", college: "VSSUT, Odisha", currentStage: "resume_based_interview", "journeyStatus (read-only)": "open", offlineOverallScore: "130", dsaCodingScore: "100", csFundamentalsScore: "30", dsaInterviewQualifyingStatus: "Shortlisted", tr1OverallTechnicalScore: "70", tr1Status: "pass", "interviewPath (read-only)": "separate", "TR2 mern fullstack State": "completed", "TR2 mern fullstack Verdict": "strong_hire", "TR2 gen ai State": "assigned" },
  // TR-1 cleared by the DSA interview, tr1Status blank, TR-2 assigned — pending.
  { id: "102", name: "Bharath K", email: "b@x.com", phone: "9123456780", currentStage: "resume_based_interview", "journeyStatus (read-only)": "open", offlineOverallScore: "110", dsaInterviewQualifyingStatus: "Shortlisted", dsaInterviewDsaScore: "90", dsaInterviewCsScore: "30", "interviewPath (read-only)": "separate", "TR2 java fullstack State": "assigned" },
  // DSA interview not cleared — Assessment, TR-1 scored from the DSA interview.
  { id: "103", name: "Chitra M", email: "c@x.com", phone: "9988776655", currentStage: "dsa_interview", "journeyStatus (read-only)": "open", offlineOverallScore: "80", dsaInterviewQualifyingStatus: "Not Shortlisted", dsaInterviewDsaScore: "30", dsaInterviewCsScore: "10", "interviewPath (read-only)": "separate" },
  // Combined path, pending.
  { id: "104", name: "Deepak S", email: "d@x.com", phone: "9876501234", currentStage: "combined_interview", "journeyStatus (read-only)": "open", offlineOverallScore: "120", "interviewPath (read-only)": "combined", "combinedInterviewState (read-only)": "pending" },
  // Combined path, rejected.
  { id: "105", name: "Esha T", email: "e@x.com", phone: "9000011111", currentStage: "combined_interview", "journeyStatus (read-only)": "open", offlineOverallScore: "100", "interviewPath (read-only)": "combined", "combinedInterviewState (read-only)": "completed", "combinedInterviewVerdict (read-only)": "rejected" },
  // Journey closed.
  { id: "106", name: "Farhan Q", email: "f@x.com", phone: "9000022222", currentStage: "resume_based_interview", "journeyStatus (read-only)": "closed", "journeyReason (read-only)": "not_responding", "journeyNotes (read-only)": "Form not filled.", offlineOverallScore: "95", dsaInterviewQualifyingStatus: "Shortlisted", "interviewPath (read-only)": "separate" },
];
{
  const tsv = [EXPORT_HEADER, ...EXPORT_ROWS.map(exportRow)].map((r) => r.join("\t")).join("\n");
  const check = inspectInterviewExport(tsv);
  ok("pasted export recognised, every column group found", check.ok && check.rows === 6 && check.groups.every((g) => !g.missing.length), check);
  ok("a sheet that isn't the export is refused", !inspectInterviewExport("Phone Number,Resume Link\n9876543210,https://x.com/r.pdf").ok);
  const rows = parseBucketingInput(tsv, { batch: 1, existing: new Map(), defaultStage: "ASSESSMENT", requireExport: true });
  const by = (m: string) => rows.find((r) => r.candidate?.id === m)?.candidate;
  const a = by("9876543210");
  ok("strong hire → TR-2 MERN, GenAI pending", a?.stage === "TR2" && a.track === "MERN" && a.interview?.tr2Pending?.join() === "GENAI", a?.interview);
  ok("export identity kept (id, email, college)", a?.externalId === "101" && a.email === "a@x.com" && a.college === "VSSUT, Odisha", a);
  const b = by("9123456780");
  ok("DSA interview shortlisted, tr1Status blank → TR-1 cleared", b?.stage === "TR1" && b.interview?.tr2Pending?.join() === "JAVA_FS", b);
  ok("…tag note says TR-2 pending", interviewNote(b?.interview) === "TR-2 pending: Java Full Stack", interviewNote(b?.interview));
  const c = by("9988776655");
  ok("DSA interview not shortlisted → Assessment, TR-1 not cleared", c?.stage === "ASSESSMENT" && interviewNote(c.interview) === "TR-1 not cleared", interviewNote(c?.interview));
  ok("…its TR-1 part comes from the DSA interview scores", internalScore(c?.interview, null, null).parts.tr1 === 25, internalScore(c?.interview, null, null).parts);
  ok("combined pending → Assessment + note", by("9876501234")?.stage === "ASSESSMENT" && interviewNote(by("9876501234")?.interview) === "Combined interview pending");
  ok("combined rejected → Assessment + note", interviewNote(by("9000011111")?.interview) === "Combined interview rejected");
  const f = by("9000022222");
  ok("closed journey read", f ? journeyClosed(f) && f.interview?.journey?.reason === "not_responding" : false, f?.interview?.journey);

  // Column order never matters: reverse every column.
  const reversed = [EXPORT_HEADER, ...EXPORT_ROWS.map(exportRow)].map((r) => [...r].reverse().map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n");
  const again = parseBucketingInput(reversed, { batch: 1, existing: new Map(), defaultStage: "ASSESSMENT", csv: true, requireExport: true });
  ok("reversed column order (CSV) → same candidates", JSON.stringify(again.map((r) => r.candidate)) === JSON.stringify(rows.map((r) => r.candidate)));

  // A closed journey is listed, never evaluated.
  const s = decide(
    state({ input: f!, resume: null, extraction: null, projectEvidence: null, domainAnalysis: null, domainReview: null, bucketing: null, bucketReview: null, dsaReview: null }),
  );
  ok("closed journey → not bucketed, JOURNEY_CLOSED", s.final?.status === "not_bucketed" && s.final.reasonCodes.join() === "JOURNEY_CLOSED", s.final);
}

// ── Loading a newer export into a run ────────────────────────────────────────
section("newer export → refresh plan");
{
  const base = (o: Partial<BucketingCandidateInput>): BucketingCandidateInput => ({
    id: "1",
    mobile: "1",
    name: "Ravi",
    resumeUrl: "https://x.com/r.pdf",
    stage: "TR1",
    track: null,
    verdict: null,
    interview: { ...iv({ tr1: 60, offline: 100 }) },
    batch: 1,
    ...o,
  });
  const before = [base({}), base({ id: "2", mobile: "2" }), base({ id: "3", mobile: "3" }), base({ id: "4", mobile: "4" })];
  const res = (id: string, o: Partial<BucketingResult> = {}): BucketingResult => ({
    ...failedBucketingResult(before.find((c) => c.id === id)!, ""),
    status: "bucketed",
    bucket: "MERN",
    reasonCodes: [],
    scores: { ...EMPTY_SCORES, internal: 60, projects: 70, experience: 40, achievements: 20, overall: 55 },
    ...o,
  });
  const results = { "1": res("1"), "2": res("2"), "3": res("3"), "4": res("4") };
  const mern = (v: "STRONG_HIRE" | "MEDIUM_HIRE"): Partial<BucketingCandidateInput> => ({
    stage: "TR2",
    track: "MERN",
    verdict: v,
    interview: { ...iv({ tr1: 60, offline: 100 }), tr2: [{ track: "MERN", verdict: v }] },
  });
  results["2"] = { ...results["2"], stage: "TR2", track: "MERN", verdict: "MEDIUM_HIRE", interview: base(mern("MEDIUM_HIRE")).interview!, placedBy: "tr2-track" };
  before[1] = base({ id: "2", mobile: "2", ...mern("MEDIUM_HIRE") });
  const after = [
    base({ resumeUrl: "" }), // 1: unchanged (no resume sheet this time — the link is kept)
    base({ id: "2", mobile: "2", resumeUrl: "", ...mern("STRONG_HIRE") }), // 2: verdict up, same track → re-score
    base({ id: "3", mobile: "3", resumeUrl: "", stage: "TR2", track: "GENAI", verdict: "MEDIUM_HIRE", interview: { ...iv({ tr1: 60, offline: 100 }), tr2: [{ track: "GENAI", verdict: "MEDIUM_HIRE" }] } }), // 3: new hire track → re-run
    base({ id: "4", mobile: "4", resumeUrl: "", interview: { ...iv({ tr1: 75, offline: 100 }) } }), // 4: new TR-1 score → re-score
    base({ id: "5", mobile: "5" }), // 5: new
  ];
  const plan = planRefresh(before, results, after);
  ok("plan: 1 new · 1 re-run · 2 re-scored · 1 unchanged", plan.added.length === 1 && plan.rerun.length === 1 && plan.rescored.length === 2 && plan.unchanged === 1, {
    added: plan.added.map((c) => c.id),
    rerun: plan.rerun.map((c) => c.id),
    rescored: plan.rescored.map((x) => x.candidate.id),
    unchanged: plan.unchanged,
  });
  const up = plan.rescored.find((x) => x.candidate.id === "2")!;
  ok("verdict upgrade re-scored: tier 1, tag, internal up, bucket kept", up.result.priorityTier === 1 && up.result.stageLabel === "MERN TR-2 · Strong hire" && up.result.scores.internal > 60 && up.result.bucket === "MERN", up.result);
  ok("…the resume link the run had is kept", up.candidate.resumeUrl === "https://x.com/r.pdf");
  ok("…and the change is in the trace", up.result.trace.some((t) => t.node === "refresh"));
  ok("new hire track → re-run", plan.rerun[0]?.id === "3");
}

// ── CSV ──────────────────────────────────────────────────────────────────────
section("CSV export");
{
  const c: BucketingCandidateInput = { id: "9", mobile: "9876543210", name: "Ravi", resumeUrl: "", stage: "ASSESSMENT", track: null, batch: 1, externalId: "77", email: "r@x.com", college: "NIT" };
  const r: BucketingResult = { ...failedBucketingResult(c, "x"), status: "not_bucketed", remarks: ['=HYPERLINK("http://evil","click")'] };
  const csv = buildCompleteCsv([r], [c]);
  ok("export identity columns lead the CSV", csv.split("\r\n")[0].replace(/^﻿/, "").startsWith("Rank,Bucket,id,name,email,phone,college,Tag"), csv.split("\r\n")[0]);
  ok("formula injection neutralised", csv.includes(`"'=HYPERLINK(""http://evil"",""click"")"`), csv.split("\r\n")[1]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
