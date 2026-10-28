import type { DsaPlatform } from "@/lib/dsa-types";
import { DSA_ORDER, platformLine } from "@/lib/showcase/dsa-rules";
import { roleLabel } from "@/lib/showcase/roles";
import { namesOf, pendingDsa, type SpOutcome, type SpRanked } from "@/lib/showcase/scoring";
import type { SpCandidate, SpDsa, SpRules } from "@/lib/showcase/types";
import type { VerifyRequest } from "@/lib/showcase/verify";
import type { TrustRequest } from "@/lib/showcase/trust";
import type { JudgeRequest } from "@/lib/showcase/profile-judge";
import { profilesHash, runDsaBar } from "@/lib/showcase/profile-rules";
import type { SpProfileDef } from "@/lib/showcase/types";

/**
 * Sample profiles — what to run next (pure). Every candidate waits at exactly one stage, so the
 * plan is read straight off the decision: the rows still "Pending" at Screen go to the screen
 * route, at DSA to the platform that is next for them, and so on. A changed rule changes the plan
 * without re-reading anything already known.
 */

export interface SpPlan {
  screen: SpCandidate[];
  dsa: Record<DsaPlatform, { id: string; url: string }[]>;
  probe: { id: string; login: string }[];
  read: { id: string; resumeUrl: string; urls: string[] }[];
  /** Profiles from JDs only: the profile-fit judge. */
  judge: JudgeRequest[];
  verify: VerifyRequest[];
  trust: TrustRequest[];
}

export type SpLane = "screen" | "codeforces" | "leetcode" | "codechef" | "probe" | "read" | "judge" | "verify" | "trust";
export const SP_LANES: SpLane[] = ["screen", "codeforces", "leetcode", "probe", "codechef", "read", "judge", "verify", "trust"];
export const SP_LANE_LABEL: Record<SpLane, string> = {
  screen: "Screen resumes",
  codeforces: "Codeforces",
  leetcode: "LeetCode",
  codechef: "CodeChef",
  probe: "GitHub accounts",
  read: "Read resumes",
  judge: "Profile fit",
  verify: "Prove projects on GitHub",
  trust: "Trust check",
};

export function laneSize(plan: SpPlan, lane: SpLane): number {
  if (lane === "codeforces" || lane === "leetcode" || lane === "codechef") return plan.dsa[lane].length;
  return plan[lane].length;
}

/** Rough minutes for a lane at the routes' pacing (for the "about N min" hint). */
export function laneMinutes(lane: SpLane, n: number): number {
  const perItemSec: Record<SpLane, number> = { screen: 0.6, codeforces: 0.08, leetcode: 0.6, codechef: 5.5, probe: 0.4, read: 4, judge: 5, verify: 12, trust: 4 };
  return Math.ceil((n * perItemSec[lane]) / 60);
}

/**
 * Profiles from JDs: the three projects to prove — the strong relevant ones of the profiles still
 * possible, chosen so that together they cover as many mandatory technologies as they can, then
 * by quality.
 */
function profileProjects(r: SpRanked, profiles: SpProfileDef[]) {
  const live = r.fits.filter((f) => f.profile && f.gates.filter((g) => g.key !== "verified" && g.key !== "trust").every((g) => g.ok && !g.pending));
  const want = new Set(
    live.flatMap((f) => profiles.find((p) => p.id === f.profile!.id)?.mandatory.flatMap((m) => m.keys) ?? []),
  );
  const pool = new Map<string, (typeof live)[number]["projects"][number]>();
  for (const f of live) for (const x of f.projects) if (!pool.has(x.p.title) || pool.get(x.p.title)!.quality < x.quality) pool.set(x.p.title, x);
  const left = [...pool.values()];
  const picked: typeof left = [];
  while (picked.length < 3 && left.length) {
    left.sort((a, b) => b.p.techKeys.filter((k) => want.has(k)).length - a.p.techKeys.filter((k) => want.has(k)).length || b.quality - a.quality);
    const next = left.shift()!;
    picked.push(next);
    for (const k of next.p.techKeys) want.delete(k);
  }
  return picked;
}

export function verifyRequest(r: SpRanked, profiles: SpProfileDef[] | null = null): VerifyRequest {
  const s = r.rec.screen!;
  const seen = new Set<string>();
  const strong = profiles?.length
    ? profileProjects(r, profiles)
    : r.fits
        .filter((f) => f.gates.find((g) => g.key === "projects")?.ok)
        .flatMap((f) => f.strong)
        .sort((a, b) => b.quality - a.quality)
        .filter((x) => !seen.has(x.p.title) && seen.add(x.p.title))
        .slice(0, 3);
  const dsaKnown: SpDsa = {};
  for (const k of DSA_ORDER) {
    const p = r.rec.dsa?.[k];
    if (p?.found === true && typeof p.solved === "number") dsaKnown[k] = p;
  }
  const links: Partial<Record<DsaPlatform, string>> = {};
  for (const k of DSA_ORDER) if (s.links[k]) links[k] = s.links[k];
  return {
    id: r.c.id,
    login: r.login,
    names: namesOf(r.c, r.rec),
    projects: strong.map((x) => ({ title: x.p.title, repoUrl: x.p.repoUrl, techKeys: x.p.techKeys, roles: x.roles })),
    repos: (r.rec.probe?.repos ?? []).map((x) => ({ name: x.name, url: x.url })),
    links,
    dsaKnown,
  };
}

export function trustRequest(r: SpRanked): TrustRequest {
  const read = r.rec.read!;
  const dsaLines = DSA_ORDER.map((k) => {
    const p = r.dsa?.dsa[k];
    const line = platformLine(k, p);
    if (!line) return "";
    const owner = p?.ownerName ? `owner's name "${p.ownerName}"` : "shows no owner name";
    return `${line} — ${owner}${p?.identity ? ` (${p.identity === "confirmed" ? "matches" : p.identity === "mismatch" ? "does NOT match" : "can't be compared"})` : ""}`;
  }).filter(Boolean);
  const projectLines = r.projects
    .filter((x) => x.proof || x.quality >= 60)
    .slice(0, 8)
    .map((x) => {
      const proof = x.proof
        ? x.proof.repoUrl
          ? `repo ${x.proof.repoUrl.replace(/^https?:\/\/github\.com\//, "")}: ${x.proofStatus} — ${x.proofWhy}${x.proof.foreignCommits ? `; ${x.proof.foreignCommits} commits by others` : ""}${x.proof.aiCommits ? `; ${x.proof.aiCommits} AI-tool commits` : ""}`
          : x.proofWhy
        : "repo not checked";
      return `${x.p.title} [${x.roles.map(roleLabel).join(", ") || "—"}] — ${proof}`;
    });
  const jobLines = read.jobs.map((j) => `${j.title || "—"} at ${j.company} (${j.employmentType}; ${j.datesText || "no dates"}; ${j.companyType}${j.months ? `; ${j.months} months` : ""})`);
  return {
    id: r.c.id,
    name: r.c.name,
    email: r.c.email,
    mobile: r.c.mobile,
    resumeUrl: r.c.resumeUrl,
    nameOnResume: read.nameOnResume,
    dsaLines,
    github: { login: r.login, profileName: r.rec.probe?.name ?? "" },
    projectLines,
    jobLines,
  };
}

/** Profiles from JDs: what the judge needs — the profiles, and the projects and jobs as read (with the program's capped quality). */
export function judgeRequest(r: SpRanked, profiles: SpProfileDef[]): JudgeRequest {
  const read = r.rec.read!;
  return {
    id: r.c.id,
    resumeUrl: r.c.resumeUrl,
    readAt: read.readAt,
    basedOn: profilesHash(profiles),
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, definesIt: p.definesIt, mandatory: p.mandatory, goodToHave: p.goodToHave })),
    projects: r.projects.map((x) => ({ title: x.p.title, techs: x.p.techs, quote: x.p.quote, signals: x.p.signals.map((s) => s.quote), quality: x.quality, depth: x.p.depth })),
    jobs: read.jobs.map((j) => ({ company: j.company, title: j.title, employmentType: j.employmentType, months: j.months, work: j.work })),
  };
}

export function planShowcase(outcome: SpOutcome, rules: SpRules): SpPlan {
  const plan: SpPlan = { screen: [], dsa: { codeforces: [], leetcode: [], codechef: [] }, probe: [], read: [], judge: [], verify: [], trust: [] };
  const profiles = outcome.profiles;
  // Profile mode reads DSA for the loosest bar of the run.
  const dsaRules = profiles?.length ? { ...rules, dsa: runDsaBar(profiles) } : rules;
  for (const r of outcome.rows) {
    if (r.status !== "Pending") continue;
    const s = r.rec.screen;
    switch (r.stage) {
      case "Screen":
        if (r.c.resumeUrl) plan.screen.push(r.c);
        break;
      case "DSA": {
        const k = s ? pendingDsa(s.links, r.rec.dsa, dsaRules) : null;
        if (k && s) plan.dsa[k].push({ id: r.c.id, url: s.links[k] });
        break;
      }
      case "GitHub":
        plan.probe.push({ id: r.c.id, login: r.login });
        break;
      case "Read":
        plan.read.push({ id: r.c.id, resumeUrl: r.c.resumeUrl, urls: s?.links.urls ?? [] });
        break;
      case "Judge":
        if (profiles?.length) plan.judge.push(judgeRequest(r, profiles));
        break;
      case "Verify":
        plan.verify.push(verifyRequest(r, profiles));
        break;
      case "Trust":
        // Profile mode only sends a candidate here when one of their profiles uses the trust agent.
        if (profiles?.length || rules.trustAgent) plan.trust.push(trustRequest(r));
        break;
    }
  }
  return plan;
}
