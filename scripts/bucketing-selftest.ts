/**
 * Candidate Bucketing — deterministic self-test (no network, no models).
 * Covers the commit-integrity audit, trace files, bucket rules, scoring, stage /
 * track normalisation, the stage arbiter and the final verifier on fixture state.
 *
 *   npx tsx scripts/bucketing-selftest.ts
 */
import "./server-only-shim";
import { normalizeStage, normalizeTrack, stageLabel } from "@/lib/bucketing/config";
import { auditStrict, buildIdentity, traceFiles } from "@/lib/bucketing/commit-integrity";
import { bucketsFor, provenTechSet, synthFromRepo } from "@/lib/bucketing/bucket-rules";
import { compareForRanking, dsaScore, platformScore, validationScore } from "@/lib/bucketing/scoring";
import { stageArbiterNode } from "@/lib/bucketing/nodes/stage-arbiter";
import { finalVerifierNode } from "@/lib/bucketing/nodes/final-verifier";
import { eligibility } from "@/lib/bucketing/nodes/bucketing-agent";
import { parseBucketingInput } from "@/lib/bucketing/parse";
import type { GithubCommitItem } from "@/lib/github-analysis";
import type { State } from "@/lib/bucketing/state";
import type { BucketDecision, Extraction, ProjectEvidence, ResumeInfo } from "@/lib/bucketing/types";
import { emptyDsa } from "@/lib/bucketing/types";

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
ok("AI-ML", normalizeTrack("AI-ML") === "AIML");
ok("Data Analytics", normalizeTrack("Data Analytics") === "DATA_ANALYTICS");
ok("label names the track", stageLabel("TR2", "MERN") === "MERN TR-2 cleared");

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
  ok("header on row 2, three candidates", good.length === 3, rows.map((r) => r.problem));
  ok("mobile is the candidate's, not the parent's", good[0]?.candidate?.id === "9876543210", good[0]?.candidate);
  ok("TR-2 status + track → MERN TR-2", good[0]?.candidate?.stage === "TR2" && good[0]?.candidate?.track === "MERN");
  ok("TR-1 status → TR1", good[1]?.candidate?.stage === "TR1");
  ok("no status → default (Assessment)", good[2]?.candidate?.stage === "ASSESSMENT");
  ok("no resume link → stub kept", rows.some((r) => r.stub?.id === "9988776655"));
  const loose = parseBucketingInput("9876543210  https://x.com/r.pdf  TR-2 cleared  Gen AI", { batch: 1, existing: new Map(), defaultStage: "ASSESSMENT" });
  ok("header-less row read by content", loose[0]?.candidate?.stage === "TR2" && loose[0]?.candidate?.track === "GENAI", loose[0]);
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
ok("React + Express, no Mongo → neither MERN nor Frontend", bucketsFor(set(["react", "nodejs"])).length === 0);
ok("React only → Frontend", bucketsFor(set(["react"])).join() === "FRONTEND");
ok("React + Firebase → Frontend", bucketsFor(set(["react"], ["firebase.json"])).join() === "FRONTEND");
ok("Django + templates + models → Python FS", bucketsFor(set(["django", "html-css"], ["app/models.py", "app/templates/index.html"])).includes("PYTHON_FS"));
ok("Spring Boot + JPA + Thymeleaf → Java FS", bucketsFor(set(["spring-boot", "sql"], ["src/main/resources/templates/home.html"])).includes("JAVA_FS"));
ok("scikit-learn only → no bucket (not GenAI)", bucketsFor(set(["scikit-learn", "pandas", "python"])).length === 0);
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
  repos: [{ url: `https://github.com/ravi-dev/${id}`, owner: "ravi-dev", repo: id, status: "verified", invalidReason: null, message: "", resolvedFromProfile: false, fork: "", techs: [], traceFiles: [], integrity: null, homepage: "", srcFiles: 10 }],
  demo: null,
  techKeys: [],
  buckets: [],
  backend: false,
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

// Test 5: demo-only projects don't validate.
{
  const s = decide(
    state({
      extraction: extraction([{ id: "P1", title: "Shop", github: false, live: true }]),
      projectEvidence: { githubUser: "", githubUserSource: "", projects: [proj("P1", "Shop", { status: "demo_only", tier: "C", repos: [], buckets: ["FRONTEND"] })], oss: [], callsUsed: 0, unavailable: false, notes: [] },
    }),
  );
  ok("demo links only → NO_GITHUB_LINKED_PROJECT (test 5)", s.final?.status === "not_bucketed" && s.final.reasonCodes.includes("NO_GITHUB_LINKED_PROJECT"), s.final);
}

// Test 6: MERN TR-2, agent picked GenAI, a valid MERN project exists → MERN.
{
  const projects = [proj("P1", "RAG Bot", { tier: "A", buckets: ["GENAI"] }), proj("P2", "Shop", { buckets: ["MERN"] })];
  const s = decide(
    state({
      input: { id: "1", mobile: "1", name: "Ravi", resumeUrl: "x", stage: "TR2", track: "MERN", batch: 1 },
      extraction: extraction([{ id: "P1", title: "RAG Bot" }, { id: "P2", title: "Shop" }]),
      projectEvidence: { githubUser: "ravi-dev", githubUserSource: "resume", projects, oss: [], callsUsed: 0, unavailable: false, notes: [] },
      bucketing: decision({ bucket: "GENAI", flagshipId: "P1", projectStrengths: { P1: 80, P2: 65 }, eligible: eligibility(projects, []).eligible }),
      domainReview: { verdict: "pass", trust: 90, coverage: 1, agreement: 0.9, issues: [], model: "t", adjusted: [{ domain: "GENAI", score: 75, evidence: [], rationale: "" }, { domain: "MERN", score: 60, evidence: [], rationale: "" }], primary: "GENAI" },
    }),
  );
  ok("MERN TR-2 backed → MERN (test 6)", s.final?.bucket === "MERN" && s.final.flagshipId === "P2" && s.final.stageLabel === "MERN TR-2 cleared", s.final);
  ok("remark mentions the resume's own GenAI strength", s.final?.remarks.some((r) => /Generative AI/.test(r)) ?? false, s.final?.remarks);
  ok("trust given with a band", typeof s.finalReview?.trust === "number" && Boolean(s.finalReview.band), s.finalReview);
}

// Test 7: MERN TR-2 with no MERN evidence → resume bucket + TRACK_MISMATCH.
{
  const projects = [proj("P1", "RAG Bot", { buckets: ["GENAI"] })];
  const s = decide(
    state({
      input: { id: "2", mobile: "2", name: "Ravi", resumeUrl: "x", stage: "TR2", track: "MERN", batch: 1 },
      extraction: extraction([{ id: "P1", title: "RAG Bot" }]),
      projectEvidence: { githubUser: "ravi-dev", githubUserSource: "resume", projects, oss: [], callsUsed: 0, unavailable: false, notes: [] },
      bucketing: decision({ bucket: "GENAI", flagshipId: "P1", projectStrengths: { P1: 70 }, eligible: ["GENAI"] }),
    }),
  );
  ok("TRACK_MISMATCH (test 7)", s.final?.bucket === "GENAI" && s.final.flags.includes("TRACK_MISMATCH"), s.final);
}

// Test 8: AI-ML TR-2 with notebooks only → NO_BUCKET_FIT.
{
  const projects = [proj("P1", "Churn model", { buckets: [] })];
  const s = decide(
    state({
      input: { id: "3", mobile: "3", name: "Ravi", resumeUrl: "x", stage: "TR2", track: "AIML", batch: 1 },
      extraction: extraction([{ id: "P1", title: "Churn model" }]),
      projectEvidence: { githubUser: "ravi-dev", githubUserSource: "resume", projects, oss: [], callsUsed: 0, unavailable: false, notes: [] },
      bucketing: decision({ bucket: null, noBucketReason: "No valid project's code meets any bucket rule." }),
    }),
  );
  ok("AI-ML TR-2 → NO_BUCKET_FIT (test 8)", s.final?.status === "not_bucketed" && s.final.reasonCodes.includes("NO_BUCKET_FIT") && s.final.stageLabel === "AI-ML TR-2 cleared", s.final);
}

// Test 10: GitHub unavailable → retry_needed, no trust.
{
  const projects = [proj("P1", "Shop", { status: "unavailable", valid: false, tier: "D" })];
  const s = decide(
    state({
      extraction: extraction([{ id: "P1", title: "Shop" }]),
      projectEvidence: { githubUser: "ravi-dev", githubUserSource: "resume", projects, oss: [], callsUsed: 40, unavailable: true, notes: [] },
    }),
  );
  ok("GitHub 403 → retry_needed (test 10)", s.final?.status === "retry_needed" && s.final.reasonCodes.includes("GITHUB_UNAVAILABLE") && s.finalReview?.trust === null, { final: s.final, review: s.finalReview });
}

// Invalid projects → reasons listed.
{
  const projects = [proj("P1", "Clone", { status: "invalid", valid: false, tier: "D", invalidReason: "FOREIGN_COMMIT" }), proj("P2", "Bot", { status: "invalid", valid: false, tier: "D", invalidReason: "AI_TOOL_COMMIT" })];
  const s = decide(
    state({
      extraction: extraction([{ id: "P1", title: "Clone" }, { id: "P2", title: "Bot" }]),
      projectEvidence: { githubUser: "ravi-dev", githubUserSource: "resume", projects, oss: [], callsUsed: 6, unavailable: false, notes: [] },
    }),
  );
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

// Final verifier repairs an invalid flagship.
{
  const projects = [proj("P1", "Shop", { buckets: ["MERN"] }), proj("P2", "Clone", { status: "invalid", valid: false, tier: "D", invalidReason: "FOREIGN_COMMIT", buckets: [] })];
  const s = decide(
    state({
      extraction: extraction([{ id: "P1", title: "Shop" }, { id: "P2", title: "Clone" }]),
      projectEvidence: { githubUser: "ravi-dev", githubUserSource: "resume", projects, oss: [], callsUsed: 6, unavailable: false, notes: [] },
      bucketing: decision({ bucket: "MERN", flagshipId: "P2", projectStrengths: { P1: 60 } }),
    }),
  );
  ok("invalid flagship repaired to a valid one", s.final?.bucket === "MERN" && s.final.flagshipId === "P1" && s.final.attempt === 2, s.final);
}

// Validation score.
{
  const projects = [proj("P1", "A", { tier: "A", demo: { url: "u", status: "reachable", httpStatus: 200, title: "", matchesProject: true, note: "" } }), proj("P2", "B", {})];
  const v = validationScore(projects, [{ id: "E1", company: "X", role: "Intern", kind: "internship", duration: "", months: 6, tech: [], techKeys: [], description: "", quote: "", section: "experience" }], [], new Set(["E1"]));
  ok("validation = 50 + 10 + 5 + 10 + 5", v === 80, v);
}

// Test 12: ranking puts TR-2 first regardless of score.
{
  const rows = [
    { id: "a", priorityTier: 3, scores: { overall: 95 }, trust: { trust: 90 } },
    { id: "b", priorityTier: 1, scores: { overall: 40 }, trust: { trust: 70 } },
    { id: "c", priorityTier: 2, scores: { overall: 80 }, trust: { trust: 70 } },
    { id: "d", priorityTier: 1, scores: { overall: 60 }, trust: { trust: 70 } },
  ];
  const order = [...rows].sort(compareForRanking).map((r) => r.id).join("");
  ok("TR-2 → TR-1 → Assessment, then score (test 12)", order === "dbca", order);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
