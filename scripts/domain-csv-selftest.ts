/**
 * Domain Shortlisting — trust and the results CSVs, self-test (no network, no models).
 * Covers grounding the model's domain score and core skills in the resume's evidence text,
 * the GitHub account identity check, the shortlist order and its tie-breaks, the Signals
 * lines, and which CSV columns appear for which run.
 *
 *   npx tsx scripts/domain-csv-selftest.ts
 */
import "./server-only-shim";
import { CERTIFICATION_ONLY_CAP, SINGLE_EVIDENCE_CAP, UNGROUNDED_CAP, githubIdentity, groundDomainFit } from "@/lib/domain-evidence";
import { combinedScore, compareShortlist, gateFailure, githubEvidenceScore, githubStrengthNotOnResume, rankParts } from "@/lib/domain-scoring";
import { candidateSignals, type SignalsContext } from "@/lib/domain-signals";
import { domainCsv, type DomainCsvInput } from "@/lib/domain-csv";
import { buildDomainReport } from "@/actions/domain";
import { EMPTY_PLATFORM, type DsaSnapshot } from "@/lib/dsa-types";
import { dsaScore } from "@/lib/dsa-scoring";
import { parseCsv, toCsv } from "@/lib/utils";
import type { InternalStanding } from "@/lib/pool/types";
import type { DomainCandidate, DomainCandidateOutcome, DomainReportResult } from "@/lib/types";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
}
const section = (s: string) => console.log(`\n${s}`);

// The resume's EVIDENCE text — Skills list and summary already removed (resume-sections.ts).
const EVIDENCE = [
  "Projects",
  "ShopKart — built a MERN e-commerce app with React, Node.js, Express and MongoDB, JWT auth and Razorpay payments.",
  "ChatNow — real-time chat with Socket.io and Redis pub/sub, deployed on AWS EC2.",
  "Experience",
  "Backend intern at Acme Pvt Ltd — wrote REST APIs in Node.js and Express for the orders service, cut p95 latency by 40%.",
  "Certifications",
  "AWS Certified Cloud Practitioner",
  "Achievements",
  "Finalist, Smart India Hackathon 2025 — built a grievance portal in React.",
].join("\n");

section("domain score grounding");
{
  const strong = groundDomainFit(
    {
      domainScore: 88,
      coreSkills: ["React", "Node.js", "MongoDB"],
      skillQuotes: ["MERN e-commerce app with React", "wrote REST APIs in Node.js and Express", "React, Node.js, Express and MongoDB"],
      proofs: [
        { source: "project", quote: "built a MERN e-commerce app with React, Node.js, Express and MongoDB" },
        { source: "experience", quote: "wrote REST APIs in Node.js and Express for the orders service" },
      ],
    },
    EVIDENCE,
    { sectionsRemoved: true },
  );
  ok("two quoted proofs keep 88", strong.domainScore === 88 && !strong.capped, strong);
  ok("every quoted skill kept", strong.coreSkills.join() === "React,Node.js,MongoDB", strong.coreSkills);
  ok("model proofs first, then skill quotes, deduped", strong.proofs[0].source === "project" && strong.proofs.length <= 5, strong.proofs);

  const invented = groundDomainFit(
    {
      domainScore: 85,
      coreSkills: ["Kubernetes", "React"],
      skillQuotes: ["deployed microservices on Kubernetes", "led a React Native migration"],
      proofs: [{ source: "project", quote: "designed a Kubernetes operator for autoscaling" }],
    },
    EVIDENCE,
    { sectionsRemoved: true },
  );
  ok("invented quotes → capped at 35", invented.domainScore === UNGROUNDED_CAP && invented.rawScore === 85, invented);
  ok("a skill whose quote is invented is dropped", !invented.coreSkills.includes("React") && !invented.coreSkills.includes("Kubernetes"), invented.coreSkills);
  ok("the cap says why", invented.capped.includes("no domain evidence"), invented.capped);

  const skillsOnly = groundDomainFit(
    { domainScore: 70, coreSkills: ["Django", "PostgreSQL"], skillQuotes: ["", ""], proofs: [] },
    EVIDENCE,
    { sectionsRemoved: true },
  );
  ok("skills only in the Skills list → 35", skillsOnly.domainScore === UNGROUNDED_CAP && skillsOnly.coreSkills.length === 0, skillsOnly);

  const certOnly = groundDomainFit(
    { domainScore: 72, coreSkills: [], skillQuotes: [], proofs: [{ source: "certification", quote: "AWS Certified Cloud Practitioner" }] },
    EVIDENCE,
    { sectionsRemoved: true },
  );
  ok("certifications alone → 50", certOnly.domainScore === CERTIFICATION_ONLY_CAP && certOnly.capped.includes("certifications"), certOnly);

  const single = groundDomainFit(
    { domainScore: 90, coreSkills: [], skillQuotes: [], proofs: [{ source: "achievement", quote: "Finalist, Smart India Hackathon 2025 — built a grievance portal in React" }] },
    EVIDENCE,
    { sectionsRemoved: true },
  );
  ok("one piece of evidence → under 80", single.domainScore === SINGLE_EVIDENCE_CAP, single);
  ok("hackathons count as evidence", single.proofs.length === 1 && single.proofs[0].source === "achievement", single.proofs);

  const unquoted = groundDomainFit({ domainScore: 86, coreSkills: ["React", "Express"], skillQuotes: ["", ""], proofs: [] }, EVIDENCE, { sectionsRemoved: true });
  ok("an answer with no quotes at all stays under 80", unquoted.domainScore === SINGLE_EVIDENCE_CAP && unquoted.coreSkills.length === 2, unquoted);

  const low = groundDomainFit({ domainScore: 30, coreSkills: [], skillQuotes: [], proofs: [] }, EVIDENCE, { sectionsRemoved: true });
  ok("a low score is never raised", low.domainScore === 30 && !low.capped, low);

  const loose = groundDomainFit(
    {
      domainScore: 80,
      coreSkills: ["Socket.io", "Redis"],
      skillQuotes: ["real-time chat with Socket.io", "redis pub/sub"],
      proofs: [{ source: "project", quote: "ChatNow — real time chat with Socket.io and Redis pub/sub" }],
    },
    EVIDENCE,
    { sectionsRemoved: true },
  );
  ok("quotes match despite case / punctuation", loose.domainScore === 80 && loose.coreSkills.length === 2, loose);
}

section("GitHub identity");
{
  ok("display name shares a name word → match", githubIdentity("Hemanth Kumar", "Hemanth K", "hk-dev") === "match");
  ok("login carries the name → match", githubIdentity("Hemanth Kumar", "", "hemanth123") === "match");
  ok("another person's full name → mismatch", githubIdentity("Ravi Teja", "Brad Traversy", "bradtraversy") === "mismatch");
  ok("a one-word handle proves nothing → unknown", githubIdentity("Ravi Teja", "Coder", "xyz-dev") === "unknown");
  ok("no display name → unknown", githubIdentity("Ravi Teja", "", "rt-dev") === "unknown");
  ok("no candidate name → unknown", githubIdentity("", "Brad Traversy", "bradtraversy") === "unknown");
  ok("initials / reordered names still match", githubIdentity("K. Sai Venkata Krishna", "Sai Krishna", "skrish") === "match");
}

// ── fixtures ──────────────────────────────────────────────────────────────────
const plat = (p: Partial<typeof EMPTY_PLATFORM>) => ({ ...EMPTY_PLATFORM, url: "https://codeforces.com/profile/x", found: true, note: "OK", ...p });
const dsaOf = (cfRating: number, solved: number): DsaSnapshot => {
  const d = { leetcode: EMPTY_PLATFORM, codeforces: plat({ solved, contests: 20, rating: cfRating, maxRating: cfRating }), codechef: EMPTY_PLATFORM };
  return { ...d, totalSolved: solved, totalContests: 20, score: dsaScore(d), partial: false };
};
const internal = (tier: 1 | 2 | 3 | 4, label = "Edge 2.0 · MERN TR-2 · Strong hire"): InternalStanding => ({
  tier,
  label,
  product: "edge2",
  score: 50,
  eligible: tier <= 3,
  matchedBy: "phone",
  standings: [],
});
const cand = (id: string, domainScore: number, o: Partial<DomainCandidate> = {}): DomainCandidate => ({
  id,
  name: id,
  resumeUrl: `https://drive.example/${id}`,
  assessmentReport: "",
  tr1Panelist: "",
  tr1PanelLinkedin: "",
  tr1Recording: "",
  tr2Panelist: "",
  tr2PanelLinkedin: "",
  tr2Recording: "",
  placedCompany: "",
  ctc: "",
  domainScore,
  coreSkills: ["React", "Node.js"],
  evidence: "Built MERN apps",
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
  ...o,
});
const checkedGh = (score: number, o: Partial<DomainCandidate> = {}): Partial<DomainCandidate> => ({
  githubProfile: "https://github.com/someone",
  githubStatus: "checked",
  githubScore: score,
  githubMatches: 2,
  githubTechs: ["React", "Node.js"],
  githubTopRepos: [{ name: "shopkart", url: "https://github.com/someone/shopkart", matchPct: 80, techs: ["React"] } as DomainCandidate["githubTopRepos"][number]],
  githubCommits2y: 120,
  githubCheckedAt: "2026-10-27T09:30:00.000Z",
  githubIdentity: "match",
  githubAccountName: "Someone",
  ...o,
});

section("rank order and tie-breaks");
{
  const theirs = cand("theirs", 70, checkedGh(80));
  const notTheirs = cand("notTheirs", 70, checkedGh(80, { githubIdentity: "mismatch", githubAccountName: "Brad Traversy" }));
  ok("a mismatched account scores 0 GitHub evidence", githubEvidenceScore(notTheirs) === 0 && githubEvidenceScore(theirs) === 80);
  ok("…and adds no rank points", rankParts(notTheirs, true).github === 0 && rankParts(theirs, true).github === 16, [rankParts(notTheirs, true), rankParts(theirs, true)]);
  ok("…nor a 'strong GitHub, not on resume' flag", !githubStrengthNotOnResume({ ...notTheirs, domainScore: 30, githubScore: 90 }));
  const commitsGate = gateFailure(notTheirs, { mandatoryActive: false, requireExperience: false, minLeetcode: 0, minCommits: 10, checkPresentation: false, minPresentation: 0 });
  ok("…nor counts toward a commits gate", commitsGate?.gate === "commits" && commitsGate.reason.includes("Brad Traversy"), commitsGate);

  const assessedLow = cand("assessedLow", 56, { internal: internal(1) });
  const externalHigh = cand("externalHigh", 95);
  const by = (a: DomainCandidate, b: DomainCandidate) => compareShortlist(a, b, false);
  ok("assessed (priority 1) before external (priority 3)", [externalHigh, assessedLow].sort(by)[0].id === "assessedLow");
  const tr1 = cand("tr1", 90, { internal: internal(2, "Edge 2.0 · TR-1 cleared") });
  ok("inside priority 1, the internal stage first (TR-2 before TR-1)", [tr1, assessedLow].sort(by)[0].id === "assessedLow");

  // Equal rank score: domain fit decides, then GitHub evidence, DSA, skills proven, name.
  const fitA = cand("fitA", 80, { presentationScore: 60 });
  const fitB = cand("fitB", 70, { presentationScore: 100 }); // 70 + 10 presentation = 80
  ok("same rank score: higher domain fit first", combinedScore(fitA, false, true) === combinedScore(fitB, false, true) && compareShortlist(fitA, fitB, false, true) < 0);
  const dsaA = cand("dsaA", 70, { dsa: dsaOf(1800, 400) });
  const dsaB = cand("dsaB", 70, { dsa: dsaOf(1000, 50) });
  ok("same fit, DSA off: stronger DSA breaks the tie", compareShortlist(dsaB, dsaA, false) > 0);
  const skillsA = cand("Zed", 70, { coreSkills: ["React", "Node.js", "MongoDB"] });
  const skillsB = cand("Amy", 70, { coreSkills: ["React"] });
  ok("then more skills proven in projects / experience", compareShortlist(skillsB, skillsA, false) > 0);
  const nameA = cand("Amy", 70);
  const nameB = cand("Zed", 70);
  ok("finally the name — never an arbitrary order", compareShortlist(nameB, nameA, false) > 0 && compareShortlist(nameA, nameB, false) < 0);
}

section("Signals");
const ctx = (o: Partial<SignalsContext> = {}): SignalsContext => ({
  useGithub: true,
  githubChecked: true,
  useDsa: false,
  checkPresentation: false,
  mandatoryActive: true,
  requireExperience: false,
  shortlisted: 3,
  poolChecked: true,
  ...o,
});
const outcome = (c: DomainCandidate, o: Partial<DomainCandidateOutcome> = {}): DomainCandidateOutcome => ({
  ...c,
  rank: 1,
  shortlisted: true,
  outcomeReason: "",
  priority: 3,
  ...o,
});
{
  const c = outcome(
    cand("Asha", 82, {
      ...checkedGh(70),
      domainProofs: [
        { source: "project", quote: "built a MERN e-commerce app with React, Node.js, Express and MongoDB" },
        { source: "skill", skill: "Redis", quote: "Redis pub/sub" },
      ],
      hasDomainExperience: true,
      experience: "Backend intern at Acme (6 months)",
    }),
  );
  const s = candidateSignals(c, ctx());
  ok("first line: where they landed and the priority", s[0].startsWith("Shortlisted at rank 1 of 3") && s[0].includes("priority 3"), s[0]);
  const total = combinedScore(c, true);
  ok("the rank-score line matches the score the shortlist used", s.some((l) => l.startsWith(`Rank score ${total} = domain fit 82 + GitHub +14`)), s);
  ok("an external candidate says so when the pool was checked", s.some((l) => l.startsWith("External")), s);
  ok("resume quotes with their source", s.some((l) => l.startsWith("Resume (project): “built a MERN")) && s.some((l) => l.startsWith("Resume — Redis: “Redis pub/sub”")), s);
  ok("GitHub line with repos, commits and proven tech", s.some((l) => l.startsWith("GitHub 70/100 (+14 rank points): 2 domain repos, 120 commits in 2 years; their code proves React, Node.js")), s);
  ok("mandatory and experience lines", s.includes("Meets every mandatory requirement") && s.some((l) => l.startsWith("Domain experience: Backend intern")), s);
  ok("no DSA / presentation lines when they weren't screened", !s.some((l) => l.startsWith("DSA") || l.startsWith("Resume presentation")), s);

  const notChecked = candidateSignals(c, ctx({ poolChecked: false }));
  ok("no 'External' claim when the pool wasn't looked up", !notChecked.some((l) => l.startsWith("External")), notChecked);

  const assessed = candidateSignals(outcome(cand("Bala", 60, { internal: internal(1) }), { priority: 1 }), ctx({ useGithub: false, githubChecked: false }));
  ok("assessed: the stage and product", assessed.some((l) => l.startsWith("Internal assessment: Edge 2.0 · MERN TR-2 · Strong hire — TR-2 cleared / top level in Edge 2.0")), assessed);
  ok("assessed: the rank line explains stage-first ordering", assessed.some((l) => l.includes("ordered by internal stage first")), assessed);

  const capped = candidateSignals(
    outcome(cand("Chetan", 35, { rawDomainScore: 85, domainCapped: "no domain evidence quoted from the projects / experience / achievements" }), {
      rank: 0,
      shortlisted: false,
      outcomeReason: "Domain fit 35 is below the 55 bar",
      priority: 0,
    }),
    ctx({ useGithub: false, githubChecked: false }),
  );
  ok("a dropped candidate: the reason first", capped[0] === "Not shortlisted — Domain fit 35 is below the 55 bar", capped[0]);
  ok("a capped score shows what the model said and why it was lowered", capped.some((l) => l.startsWith("Domain fit 35/100 (the model said 85; lowered: no domain evidence")), capped);
  ok("no rank-score line without a rank", !capped.some((l) => l.startsWith("Rank score")), capped);

  const mismatch = candidateSignals(outcome(cand("Dev", 70, checkedGh(90, { githubIdentity: "mismatch", githubAccountName: "Brad Traversy" }))), ctx());
  ok("a mismatched GitHub account is called out", mismatch.some((l) => l.includes("“Brad Traversy” doesn't match the candidate")), mismatch);
  ok("…and earns +0", mismatch.some((l) => l.startsWith("GitHub 90/100 (+0 rank points)")), mismatch);

  const dsa = candidateSignals(outcome(cand("Esha", 70, { dsa: dsaOf(1600, 300) })), ctx({ useDsa: true, useGithub: false, githubChecked: false }));
  ok("DSA line with the platform stats", dsa.some((l) => /^DSA \d+\/100 \(\+\d+ rank points\): Codeforces 300 solved 20 contests rating 1600$/.test(l)), dsa);
}

section("CSV columns");
const result = (candidates: DomainCandidateOutcome[]): DomainReportResult => ({
  link: "",
  storage: "local",
  shortlisted: candidates.filter((c) => c.shortlisted).length,
  considered: candidates.length,
  candidates,
  excluded: { mandatory: 0, leetcode: 0, dsa: 0, commits: 0, experience: 0, presentation: 0 },
  limitedToTopN: false,
  reportSkipped: true,
});
const input = (o: Partial<DomainCsvInput> & Pick<DomainCsvInput, "result">): DomainCsvInput => ({
  kind: "complete",
  domain: "MERN backend",
  mandatoryActive: false,
  dsaOn: false,
  githubOn: false,
  trackDomainCommit: false,
  presentation: false,
  poolChecked: true,
  unscored: [],
  ...o,
});
{
  const plain = result([
    outcome(cand("Asha", 82, { scoredBy: "gemini/2.5" }), { signals: ["Shortlisted at rank 1 of 1", "Domain fit 82/100"], rankScore: 82 }),
    outcome(cand("Bala", 40), { rank: 0, shortlisted: false, outcomeReason: "Domain fit 40 is below the 55 bar", priority: 0 }),
  ]);
  const base = domainCsv(input({ result: plain }));
  ok(
    "fixed columns first, in the requested order",
    base.headers.slice(0, 9).join("|") === "Rank|Name|Status|Not Shortlisted Because|Priority|Rank Score|Domain|Domain Score|Resume Core Skills",
    base.headers.slice(0, 9),
  );
  ok("no DSA columns when DSA wasn't screened", !base.headers.some((h) => h.startsWith("DSA") || h.includes("LeetCode") || h.includes("Codeforces")), base.headers);
  ok("no GitHub columns when GitHub wasn't inspected", !base.headers.some((h) => h.includes("GitHub")), base.headers);
  ok("no presentation columns when not graded", !base.headers.some((h) => h.startsWith("Resume Presentation")));
  ok("no Meets Mandatory without mandatory requirements", !base.headers.includes("Meets Mandatory"));
  ok("no interview / placement columns when the sheet has none", !base.headers.some((h) => ["Placed Company", "Package (LPA)", "Assessment Report", "TR-1 Panelist", "TR-2 Recording"].includes(h)));
  ok(
    "experience, resume, internal and Signals columns always",
    ["Has Domain Experience", "Domain Experience", "Resume", "Matched In Pool By", "Internal Standing", "Internal Stage", "Internal Product", "Signals"].every((h) => base.headers.includes(h)),
  );
  ok("complete CSV adds the audit columns last", base.headers.slice(-3).join("|") === "Scored By|Phone|User ID", base.headers.slice(-3));
  ok("headers are unique", new Set(base.headers).size === base.headers.length);
  ok("Signals are bullet lines", base.rows[0].Signals === "• Shortlisted at rank 1 of 1\n• Domain fit 82/100", base.rows[0].Signals);
  ok("external when the pool was checked", base.rows[0]["Internal Standing"] === "External" && base.rows[0]["Matched In Pool By"] === undefined);
  ok("'Not checked' when it wasn't", domainCsv(input({ result: plain, poolChecked: false })).rows[0]["Internal Standing"] === "Not checked");
  ok("rank score only for ranked rows", base.rows[0]["Rank Score"] === "82" && base.rows[1]["Rank Score"] === "");

  const shortlistOnly = domainCsv(input({ result: plain, kind: "shortlisted" }));
  ok("shortlisted CSV: only the shortlist, no audit columns", shortlistOnly.rows.length === 1 && !shortlistOnly.headers.includes("Scored By"), shortlistOnly.rows.length);

  const dsaRun = domainCsv(input({ result: result([outcome(cand("Esha", 70, { dsa: dsaOf(1600, 300) }))]), dsaOn: true }));
  const dsaHeaders = [
    "DSA Score",
    "LeetCode Solved",
    "LeetCode Contests Participated",
    "LeetCode Rating",
    "Codeforces Solved",
    "Codeforces Contests Participated",
    "Codeforces Rating",
    "CodeChef Solved",
    "CodeChef Contests Participated",
    "CodeChef Rating",
    "Total Solved",
    "Total Contests",
    "Codeforces Max Rating",
    "CodeChef Highest Rating",
    "LeetCode URL",
    "Codeforces URL",
    "CodeChef URL",
    "DSA Notes",
  ];
  ok("DSA screened: the DSA block, in order, right after core skills", dsaRun.headers.slice(9, 9 + dsaHeaders.length).join("|") === dsaHeaders.join("|"), dsaRun.headers.slice(9, 28));
  ok("DSA cells: measured values, blank for unlinked platforms", dsaRun.rows[0]["Codeforces Rating"] === "1600" && dsaRun.rows[0]["LeetCode Solved"] === "", dsaRun.rows[0]);
  ok("DSA notes say when nothing else is linked", dsaRun.rows[0]["DSA Notes"] === "", dsaRun.rows[0]["DSA Notes"]);

  const gh = result([
    outcome(cand("Asha", 82, checkedGh(70, { githubLastDomainCommit: { date: "2026-09-01T00:00:00Z", repo: "shopkart", repoUrl: "https://github.com/someone/shopkart", linked: true } as DomainCandidate["githubLastDomainCommit"] }))),
    outcome(cand("Dev", 75, checkedGh(90, { githubIdentity: "mismatch", githubAccountName: "Brad Traversy" })), { rank: 2 }),
    outcome(cand("Gita", 60, { githubStatus: "no-link" }), { rank: 3 }),
  ]);
  const ghRun = domainCsv(input({ result: gh, githubOn: true, trackDomainCommit: true, mandatoryActive: true }));
  const want = [
    "GitHub Check",
    "GitHub Fit Score",
    "GitHub Domain Repos",
    "GitHub Proven Tech",
    "GitHub Evidence",
    "Mandatory Not Proven on GitHub",
    "Claimed but Not Found on GitHub",
    "GitHub Top Repos",
    "GitHub Commits (2y)",
    "Last Domain Commit",
    "Last Domain Commit Repo",
    "Commit Email Linked To Profile",
    "GitHub AI-Commit Signal",
    "GitHub AI-Commit Detail",
    "GitHub Notes",
    "GitHub Checked At",
    "GitHub Profile",
  ];
  ok("GitHub inspected: the requested GitHub columns, in order", want.every((h, i) => ghRun.headers.indexOf(h) === ghRun.headers.indexOf(want[0]) + i), ghRun.headers);
  ok("plus whether the account is theirs", ghRun.headers.includes("GitHub Account Is Theirs"));
  ok("no project-review columns when no review ran", !ghRun.headers.includes("Project Review Score"));
  ok("Meets Mandatory with mandatory requirements", ghRun.headers.includes("Meets Mandatory"));
  const [asha, dev, gita] = ghRun.rows;
  ok("checked: numbers filled", asha["GitHub Fit Score"] === "70" && asha["GitHub Commits (2y)"] === "120" && asha["GitHub Score Used in Rank"] === "70", asha);
  ok("latest domain commit filled", asha["Last Domain Commit"] === "2026-09-01" && asha["Commit Email Linked To Profile"] === "Yes", asha);
  ok("mismatch: flagged, and 0 used in the rank", dev["GitHub Account Is Theirs"].startsWith("No — the account belongs to “Brad Traversy”") && dev["GitHub Score Used in Rank"] === "0", dev);
  ok("no link: status, but no numbers (blank = unknown, not 0)", gita["GitHub Check"] === "No GitHub link in resume" && gita["GitHub Fit Score"] === "" && gita["GitHub Commits (2y)"] === "", gita);

  const commitOnly = domainCsv(input({ result: gh, trackDomainCommit: true }));
  ok("latest-commit lookup alone: no GitHub score columns", commitOnly.headers.includes("Last Domain Commit") && !commitOnly.headers.includes("GitHub Fit Score") && !commitOnly.headers.includes("GitHub Score Used in Rank"));

  const placed = domainCsv(input({ result: result([outcome(cand("Asha", 82, { placedCompany: "Zaggle", ctc: "12" })), outcome(cand("Bala", 70), { rank: 2 })]), presentation: true }));
  ok("placement columns appear once a row has them", placed.headers.includes("Placed Company") && placed.headers.includes("Package (LPA)") && !placed.headers.includes("TR-1 Panelist"), placed.headers);
  ok("presentation columns when graded", placed.headers.includes("Resume Presentation Score") && placed.headers.includes("Resume Presentation Notes"));

  const st = internal(2, "Edge 2.0 · TR-1 cleared");
  const withUnscored = domainCsv(
    input({
      result: plain,
      unscored: [
        { row: cand("Hari", 0), status: "Not a resume", reason: "The link is a certificate image", internal: null },
        { row: cand("Indu", 0), status: "Not evaluated", reason: "The run was stopped before this candidate", internal: st },
      ],
    }),
  );
  ok("complete CSV accounts for every row", withUnscored.rows.length === 4, withUnscored.rows.length);
  const indu = withUnscored.rows[3];
  ok(
    "an unscored row keeps its internal standing and a signal",
    indu["Internal Stage"] === "TR-1" && indu["Matched In Pool By"] === "Phone" && indu.Signals === "• Not evaluated: The run was stopped before this candidate",
    indu,
  );
  ok("…and no invented scores", indu["Domain Score"] === undefined && indu["Rank"] === undefined);

  // Multi-line cells survive the CSV round trip.
  const text = toCsv(withUnscored.headers, withUnscored.rows);
  const back = parseCsv(text);
  ok("CSV round-trips with multi-line Signals", back.length === 5 && back[1][back[0].indexOf("Signals")] === "• Shortlisted at rank 1 of 1\n• Domain fit 82/100", back.length);
}

section("end to end (buildDomainReport → CSV)");
(async () => {
  const pool = [
    cand("Asha", 82, { ...checkedGh(70), internal: null }),
    cand("Bala", 60, { internal: internal(1) }),
    cand("Dev", 85, checkedGh(95, { githubIdentity: "mismatch", githubAccountName: "Brad Traversy" })),
    cand("Chetan", 35, { rawDomainScore: 85, domainCapped: "no domain evidence quoted from the projects / experience / achievements" }),
  ];
  const built = await buildDomainReport(pool, {
    domain: "MERN backend",
    topN: 10,
    limitToTopN: false,
    runName: "t",
    resumesScanned: 4,
    useDsa: false,
    useGithub: true,
    showDomainCommit: false,
    showStats: false,
    generateReport: false,
    minCommits: 0,
    mandatoryActive: false,
    requireExperience: false,
    checkPresentation: false,
    minPresentation: 0,
    poolChecked: true,
  });
  ok("report built", built.ok);
  if (built.ok) {
    const r = built.data;
    const order = r.candidates.filter((c) => c.shortlisted).map((c) => c.id);
    ok("assessed first, then by rank score — a borrowed GitHub doesn't lift Dev over Asha", order.join() === "Bala,Asha,Dev", order);
    const dev = r.candidates.find((c) => c.id === "Dev")!;
    const asha = r.candidates.find((c) => c.id === "Asha")!;
    ok("rank scores", asha.rankScore === 82 + 14 && dev.rankScore === 85, { asha: asha.rankScore, dev: dev.rankScore });
    ok("every outcome carries Signals", r.candidates.every((c) => (c.signals ?? []).length >= 2), r.candidates.map((c) => c.signals?.length));
    const csv = domainCsv(input({ result: r, githubOn: true }));
    ok("CSV rows follow the outcomes", csv.rows.map((x) => x.Name).join() === "Bala,Asha,Dev,Chetan", csv.rows.map((x) => x.Name));
    ok("the dropped candidate's reason", csv.rows[3]["Not Shortlisted Because"] === "Domain fit 35 is below the 55 bar", csv.rows[3]);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
