/**
 * Domain shortlisting × DSA — deterministic self-test (no network, no models).
 * The DSA score (LeetCode / Codeforces / CodeChef: solved, contests, rating), the
 * rank bonus, the DSA gates, and how buildDomainReport applies them.
 *
 *   npx tsx scripts/dsa-domain-selftest.ts
 */
import "./server-only-shim";
import { bestRating, dsaBonus, dsaGateFailure, dsaGatesActive, dsaScore, NO_DSA_GATES, platformDsaScore, ratingsLine, type DsaGates } from "@/lib/dsa-scoring";
import { combinedScore } from "@/lib/domain-scoring";
import { buildDomainReport } from "@/actions/domain";
import { buildDomainReportHtml, type DomainCardInput } from "@/lib/domain-report-template";
import { EMPTY_PLATFORM, type DsaPlatformResult, type DsaSnapshot } from "@/lib/dsa-types";
import type { DomainCandidate } from "@/lib/types";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

const plat = (p: Partial<DsaPlatformResult>): DsaPlatformResult => ({ ...EMPTY_PLATFORM, url: "https://x", found: true, note: "OK", ...p });
const snap = (lc: Partial<DsaPlatformResult> | null, cf: Partial<DsaPlatformResult> | null, cc: Partial<DsaPlatformResult> | null, partial = false): DsaSnapshot => {
  const leetcode = lc ? plat(lc) : EMPTY_PLATFORM;
  const codeforces = cf ? plat(cf) : EMPTY_PLATFORM;
  const codechef = cc ? plat(cc) : EMPTY_PLATFORM;
  const all = [leetcode, codeforces, codechef];
  const solved = all.map((p) => p.solved).filter((n): n is number => typeof n === "number");
  const contests = all.map((p) => p.contests).filter((n): n is number => typeof n === "number");
  const d = { leetcode, codeforces, codechef };
  return {
    ...d,
    totalSolved: solved.length ? solved.reduce((a, b) => a + b, 0) : null,
    totalContests: contests.length ? contests.reduce((a, b) => a + b, 0) : null,
    score: dsaScore(d),
    partial,
  };
};

// ── DSA score ────────────────────────────────────────────────────────────────
console.log("DSA score");
// A Manav-like profile: CF 1584 (20 contests, 200 solved), CC 1666 (10, 100), LC 250 solved, no contests.
const manav = snap({ solved: 250, contests: 0 }, { solved: 200, contests: 20, rating: 1500, maxRating: 1584 }, { solved: 100, contests: 10, rating: 1666, maxRating: 1666 });
ok("mixed profile scores 71", manav.score === 71, manav.score);
ok("empty profile scores 0", snap(null, null, null).score === 0);
ok("bestRating = max(rating, maxRating)", bestRating(manav.codeforces) === 1584);
ok("bestRating null when unrated", bestRating(plat({ solved: 10 })) === null);
// A LeetCode rating without a rated contest counts for nothing; with contests it does.
const lcNoContest = platformDsaScore("leetcode", plat({ solved: 600, contests: 0, rating: 2000 }));
const lcContest = platformDsaScore("leetcode", plat({ solved: 600, contests: 30, rating: 2000 }));
ok("LC rating ignored without contests", Math.abs(lcNoContest - 0.4) < 1e-9, lcNoContest);
ok("LC rating counts with contests", Math.abs(lcContest - 0.84) < 1e-9, lcContest);
// Same maxed record on each platform → Codeforces > CodeChef > LeetCode.
const maxed = (k: "leetcode" | "codeforces" | "codechef") =>
  dsaScore({ leetcode: undefined, codeforces: undefined, codechef: undefined, [k]: plat({ solved: 600, contests: 30, rating: 2400 }) });
ok("maxed CF = 100", maxed("codeforces") === 100, maxed("codeforces"));
ok("maxed CC = 85", maxed("codechef") === 85, maxed("codechef"));
ok("maxed LC = 70", maxed("leetcode") === 70, maxed("leetcode"));
// More contests / higher rating never lowers the score.
const lower = snap(null, { solved: 200, contests: 5, rating: 1200 }, null).score;
const higher = snap(null, { solved: 200, contests: 25, rating: 1800 }, null).score;
ok("contests + rating raise the score", higher > lower, { lower, higher });
// A breadth bonus for each other active platform.
const cfOnly = snap(null, { solved: 200, contests: 20, maxRating: 1584 }, null).score;
const cfPlus = snap({ solved: 50 }, { solved: 200, contests: 20, maxRating: 1584 }, { solved: 30 }).score;
ok("breadth +5 per other active platform", cfPlus - cfOnly === 10, { cfOnly, cfPlus });
ok("ratingsLine", ratingsLine(manav) === "CF 1584 · CC 1666", ratingsLine(manav));

// ── rank bonus ───────────────────────────────────────────────────────────────
console.log("Rank bonus");
ok("bonus off when toggle off", dsaBonus(100, false) === 0);
ok("bonus 15 at 100", dsaBonus(100, true) === 15);
ok("bonus 11 at 71", dsaBonus(71, true) === 11);
ok("bonus 0 for no score", dsaBonus(undefined, true) === 0 && dsaBonus(0, true) === 0);
const base = { domainScore: 70, githubScore: 0 };
ok("combinedScore adds DSA only with useDsa", combinedScore({ ...base, dsa: manav }, false, false, true) === 81 && combinedScore({ ...base, dsa: manav }, false) === 70);

// ── gates ────────────────────────────────────────────────────────────────────
console.log("Gates");
const g = (p: Partial<DsaGates>): DsaGates => ({ ...NO_DSA_GATES, ...p, minRating: { ...NO_DSA_GATES.minRating, ...(p.minRating ?? {}) } });
ok("no gates inactive", !dsaGatesActive(NO_DSA_GATES) && !dsaGatesActive(undefined));
ok("rating-only gate active", dsaGatesActive(g({ minRating: { codechef: 1600, leetcode: 0, codeforces: 0 } })));
ok("no gates → pass", dsaGateFailure(manav, NO_DSA_GATES) === "");
ok("solved 300 passes (550)", dsaGateFailure(manav, g({ minSolved: 300 })) === "");
ok("solved 600 fails", dsaGateFailure(manav, g({ minSolved: 600 })).startsWith("550 problems solved"), dsaGateFailure(manav, g({ minSolved: 600 })));
ok("contests 40 fails (30)", dsaGateFailure(manav, g({ minContests: 40 })).startsWith("30 rated contests"));
ok("CF 1600 alone fails", dsaGateFailure(manav, g({ minRating: { codeforces: 1600, codechef: 0, leetcode: 0 } })) === "Rating CF 1584 — needs CF 1600");
ok("CF 1600 or CC 1600 passes", dsaGateFailure(manav, g({ minRating: { codeforces: 1600, codechef: 1600, leetcode: 0 } })) === "");
ok("score 75 fails (71)", dsaGateFailure(manav, g({ minScore: 75 })) === "DSA score 71, below the 75 minimum");
ok("score 70 passes", dsaGateFailure(manav, g({ minScore: 70 })) === "");
ok("unread snapshot fails a gate", dsaGateFailure(undefined, g({ minSolved: 1 })).includes("not read"));
const partial = snap({ solved: 20 }, null, null, true);
ok("partial read says so", dsaGateFailure(partial, g({ minSolved: 100 })).includes("couldn't be read in full"));

// ── buildDomainReport ────────────────────────────────────────────────────────
console.log("buildDomainReport");
const cand = (id: string, domainScore: number, dsa?: DsaSnapshot): DomainCandidate => ({
  id, name: id, resumeUrl: "", assessmentReport: "", tr1Panelist: "", tr1PanelLinkedin: "", tr1Recording: "",
  tr2Panelist: "", tr2PanelLinkedin: "", tr2Recording: "", placedCompany: "", ctc: "",
  domainScore, coreSkills: [], evidence: "", githubProfile: "", githubRepos: [], githubStatus: "off", githubNote: "",
  githubScore: 0, githubMatches: 0, githubTechs: [], githubTopRepos: [], githubAiLikelihood: "", githubAiSummary: "",
  leetcodeSolved: dsa?.leetcode.solved ?? 0, codeforcesSolved: dsa?.codeforces.solved ?? 0, ...(dsa ? { dsa } : {}),
  githubCommits2y: 0, githubLastDomainCommit: null, meetsMandatory: true, hasDomainExperience: true, experience: "",
  presentationScore: 0, presentationNotes: "",
});
const chef = snap(null, null, { solved: 150, contests: 15, rating: 1800, maxRating: 1800 }); // 35
ok("CodeChef-only profile scores 35", chef.score === 35, chef.score);
const pool = [cand("A", 70, manav), cand("B", 90, snap(null, null, null)), cand("C", 75, chef), cand("D", 40, manav)];
const opts = {
  domain: "Backend", topN: 10, limitToTopN: false, runName: "t", resumesScanned: 4, useDsa: true, useGithub: false,
  showDomainCommit: false, showStats: false, generateReport: false, minCommits: 0, mandatoryActive: false,
  requireExperience: false, checkPresentation: false, minPresentation: 0,
};

(async () => {
  const gated = await buildDomainReport(pool, { ...opts, dsaGates: g({ minRating: { codeforces: 1400, codechef: 1600, leetcode: 0 } }) });
  ok("gated run ok", gated.ok);
  if (gated.ok) {
    const r = gated.data;
    const order = r.candidates.filter((c) => c.shortlisted).map((c) => c.id);
    ok("A (CF 1584) and C (CC 1800) shortlisted, A first on DSA", JSON.stringify(order) === '["A","C"]', order);
    const b = r.candidates.find((c) => c.id === "B");
    ok("B (no profiles) dropped by the rating gate", b?.shortlisted === false && b.outcomeReason === "Rating CF — / CC — — needs CF 1400 or CC 1600", b?.outcomeReason);
    ok("excluded.dsa counts B only", r.excluded.dsa === 1, r.excluded);
    const d = r.candidates.find((c) => c.id === "D");
    ok("D below the domain bar first", Boolean(d?.outcomeReason.startsWith("Domain fit 40")), d?.outcomeReason);
  }
  // Toggle on, no gates: everyone above the domain bar stays, DSA only re-ranks.
  const ranked = await buildDomainReport(pool, { ...opts, dsaGates: NO_DSA_GATES });
  if (ranked.ok) {
    const order = ranked.data.candidates.filter((c) => c.shortlisted).map((c) => c.id);
    ok("no gates: B 90 > A 70+11 > C 75+5", JSON.stringify(order) === '["B","A","C"]', order);
    ok("no gates: nobody excluded by DSA", ranked.data.excluded.dsa === 0);
  } else ok("ranked run ok", false, ranked.error);
  // Toggle off: DSA neither ranks nor gates; C (75) beats A (70).
  const off = await buildDomainReport(pool, { ...opts, useDsa: false });
  if (off.ok) {
    const order = off.data.candidates.filter((c) => c.shortlisted).map((c) => c.id);
    ok("DSA off: B > C > A by domain fit", JSON.stringify(order) === '["B","C","A"]', order);
  } else ok("off run ok", false, off.error);
  // Older clients' LeetCode-only gate still works.
  const legacy = await buildDomainReport(pool, { ...opts, minLeetcode: 200 });
  if (legacy.ok) {
    const order = legacy.data.candidates.filter((c) => c.shortlisted).map((c) => c.id);
    ok("legacy minLeetcode 200 keeps A only", JSON.stringify(order) === '["A"]', order);
  } else ok("legacy run ok", false, legacy.error);

  // ── PDF report card ────────────────────────────────────────────────────────
  console.log("Report card");
  const card: DomainCardInput = {
    rank: 1, name: "A", coreSkills: [], evidence: "", experience: "", resumeUrl: "", assessmentReport: "",
    tr1Panelist: "", tr1PanelLinkedin: "", tr1Recording: "", tr2Panelist: "", tr2PanelLinkedin: "", tr2Recording: "",
    placedCompany: "", ctc: "", githubProfile: "", githubMatches: 0, githubScore: 0, githubTechs: [], githubTopRepos: [],
    presentationScore: 0, presentationNotes: "", showPresentation: false,
    leetcodeSolved: 250, codeforcesSolved: 200, codechefSolved: 100, dsaScore: 71,
    ratings: { codeforces: 1584, codechef: 1666, leetcode: null },
    githubCommits2y: 0, lastDomainCommit: null, showCoding: true,
  };
  const html = buildDomainReportHtml({ runName: "t", domain: "Backend", resumesScanned: 1, candidatesConsidered: 1, candidates: [card], showStats: false, limitedToTopN: false });
  ok("card shows the DSA score", html.includes("<b>71</b><i>DSA score /100</i>"));
  ok("card shows CF solved + rating", html.includes("<b>200</b><i>Codeforces · rating 1,584</i>"));
  ok("card shows CodeChef", html.includes("<b>100</b><i>CodeChef · rating 1,666</i>"));
  ok("card shows LeetCode solved", html.includes("<b>250</b><i>LeetCode</i>"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
