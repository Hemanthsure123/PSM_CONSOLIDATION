/**
 * Domain Shortlisting — "Inspect GitHub for: domain-fit / all candidates", self-test
 * (no network). Covers who gets inspected and in what order, the cap, and the
 * "strong on GitHub, not on the resume" signal.
 *
 *   npx tsx scripts/domain-github-scope-selftest.ts
 */
import {
  GITHUB_INSPECT_CAP,
  GITHUB_STRONG_SCORE,
  MIN_DOMAIN_SCORE,

  githubHoursFor,
  githubStrengthNotOnResume,
  githubTechsNotOnResume,
  planGithubInspection,
} from "@/lib/domain-scoring";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  }
}
const section = (s: string) => console.log(`\n${s}`);

const cand = (id: string, domainScore: number, o: Partial<{ githubStatus: string; githubProfile: string; githubRepos: string[] }> = {}) => ({
  id,
  domainScore,
  githubStatus: "not-inspected",
  githubProfile: `https://github.com/${id}`,
  githubRepos: [] as string[],
  ...o,
});

section("who is inspected");
{
  const all = [
    cand("low", 30),
    cand("fit70", 70),
    cand("nolink", 90, { githubStatus: "no-link", githubProfile: "" }),
    cand("fit90", 90),
    cand("mid50", 50),
    cand("repoOnly", 20, { githubProfile: "", githubRepos: ["https://github.com/x/y"] }),
    cand("done", 80, { githubStatus: "checked" }),
  ];
  const fit = planGithubInspection(all, "fit", 1);
  ok("fit: only domain-fit candidates, best first", fit.pool.map((c) => c.id).join() === "fit90,fit70", fit.pool.map((c) => c.id));
  ok("fit: below-bar candidates listed (not inspected)", fit.belowBar.map((c) => c.id).join() === "mid50,low,repoOnly", fit.belowBar.map((c) => c.id));
  const every = planGithubInspection(all, "all", 1);
  ok("all: everyone with a link, domain-fit first, then by fit", every.pool.map((c) => c.id).join() === "fit90,fit70,mid50,low,repoOnly", every.pool.map((c) => c.id));
  ok("all: nothing left out as below the bar", every.belowBar.length === 0 && every.overCap.length === 0);
  ok("no link / already inspected never queued", !every.pool.some((c) => c.id === "nolink" || c.id === "done"));
}

section("cap");
{
  const many = Array.from({ length: GITHUB_INSPECT_CAP + 30 }, (_, i) => cand(`c${i}`, MIN_DOMAIN_SCORE + (i % 40)));
  const fit = planGithubInspection(many, "fit", 0);
  ok(`fit: capped at ${GITHUB_INSPECT_CAP}`, fit.pool.length === GITHUB_INSPECT_CAP && fit.overCap.length === 30, { pool: fit.pool.length, over: fit.overCap.length });
  ok("fit: the cap keeps the strongest fits", Math.min(...fit.pool.map((c) => c.domainScore)) >= Math.max(...fit.overCap.map((c) => c.domainScore)));
  ok("fit: room shrinks by what's already inspected", planGithubInspection(many, "fit", GITHUB_INSPECT_CAP - 5).pool.length === 5);
  ok("all: no cap", planGithubInspection(many, "all", 0).pool.length === many.length);
  ok("budget estimate: 2,000 candidates ≈ 8 h", Math.round(githubHoursFor(2000)) === 8, githubHoursFor(2000));
}

section("strong on GitHub, not on the resume");
{
  const base = { githubStatus: "checked", githubScore: 75, githubMatches: 2, githubTechs: ["React", "Node.js", "MongoDB"], domainScore: 40, resumeTechs: ["React"] };
  ok("strong code, resume below the bar → flagged", githubStrengthNotOnResume(base));
  ok("resume clears the bar → not this signal", !githubStrengthNotOnResume({ ...base, domainScore: MIN_DOMAIN_SCORE }));
  ok(`GitHub score under ${GITHUB_STRONG_SCORE} → not flagged`, !githubStrengthNotOnResume({ ...base, githubScore: GITHUB_STRONG_SCORE - 1 }));
  ok("no domain repo → not flagged", !githubStrengthNotOnResume({ ...base, githubMatches: 0 }));
  ok("not inspected → not flagged", !githubStrengthNotOnResume({ ...base, githubStatus: "not-inspected" }));
  ok("proven but unnamed tech listed", githubTechsNotOnResume(base).join() === "Node.js,MongoDB", githubTechsNotOnResume(base));
  ok("case-insensitive match with the resume", githubTechsNotOnResume({ ...base, resumeTechs: ["react", "node.js"] }).join() === "MongoDB");
  ok("resume techs unknown → nothing claimed", githubTechsNotOnResume({ ...base, resumeTechs: undefined }).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
