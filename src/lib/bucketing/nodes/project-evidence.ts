import "server-only";
import { parseGithubLink } from "@/lib/github-repo";
import {
  githubBudget,
  githubGetJson,
  inspectRepository,
  type GithubBudget,
  type GithubCommitItem,
  type RepoInspection,
  type RepoInspectionResult,
} from "@/lib/github-analysis";
import { auditStrict, buildIdentity, traceFiles } from "@/lib/bucketing/commit-integrity";
import { bucketsFor, hasBackend, provenTechSet, synthFromRepo } from "@/lib/bucketing/bucket-rules";
import { LIMITS, TECH_CONF, TIMEOUTS, type ReasonCode } from "@/lib/bucketing/config";
import { traceEntry } from "@/lib/bucketing/nodes/shared";
import { NOT_A_DEMO } from "@/lib/bucketing/nodes/ingest";
import type {
  DemoCheck,
  ExtractedProject,
  OssEvidence,
  ProjectEvidence,
  ProjectEvidenceResult,
  RepoEvidence,
  Tier,
} from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Project evidence (deterministic tools, no model). For each resume project:
 * resolve its GitHub repo(s), read what the code proves, audit every commit
 * strictly (bucketing/commit-integrity.ts), look for AI-tool trace files, and
 * probe its live demo. Each project gets a tier:
 *   A valid GitHub + reachable demo · B valid GitHub · C demo only (reachable and
 *   about this project) · D not evidence.
 * A rate limit, a rejected token or a network failure makes a project
 * "unavailable" — never invalid: missing evidence is not negative evidence.
 */

type Repo = { owner: string; repo: string; fromProfile: boolean; link: string };

const STOP = new Set(["app", "application", "project", "website", "web", "site", "system", "using", "based", "the", "and", "for", "with", "management", "platform", "tool", "clone", "portfolio"]);
const tokens = (s: string) =>
  (s ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));

/** Every name token (≥ 3 letters) of a GitHub profile name appears in the resume name. */
function sameName(profileName: string, resumeNames: string[]): boolean {
  const words = (s: string) => s.toLowerCase().normalize("NFKD").split(/[^a-z]+/).filter((w) => w.length >= 3);
  const have = new Set(resumeNames.flatMap(words));
  const want = words(profileName);
  return want.length > 0 && want.every((w) => have.has(w));
}

/** "achal-sayee" for "Achal Sayee" (two name tokens inside the login, or the whole one-word name). */
function loginCarriesName(login: string, resumeNames: string[]): boolean {
  const letters = login.toLowerCase().replace(/[^a-z]/g, "");
  const toks = Array.from(new Set(resumeNames.flatMap((n) => n.toLowerCase().normalize("NFKD").split(/[^a-z]+/).filter((w) => w.length >= 3))));
  if (!letters || !toks.length) return false;
  const inside = toks.filter((t) => letters.includes(t)).length;
  return toks.length === 1 ? inside === 1 && toks[0].length >= 5 : inside >= 2;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ── Demo links ───────────────────────────────────────────────────────────────

/** Pages that answer 200 but are not the app: platform 404s, suspended services, parked domains, server defaults. */
const SOFT_404: RegExp[] = [
  /DEPLOYMENT_NOT_FOUND|The deployment could not be found on Vercel/i,
  /There isn['’]t a GitHub Pages site here/i,
  /no-such-app|There['’]s nothing here, yet|herokucdn\.com\/error-pages/i,
  /Service Suspended|This service has been suspended/i,
  /Firebase Hosting Setup Complete|Site Not Found[\s\S]{0,200}Firebase/i,
  /Not Found - Request ID|Page not found[\s\S]{0,300}netlify/i,
  /this domain (?:may be|is) for sale|domain is for sale|sedoparking|parked (?:free|domain)/i,
  /Welcome to nginx!|Apache2 (?:Ubuntu |Debian )?Default Page/i,
  /Application not found|application error[\s\S]{0,200}heroku/i,
];
const DEPLOY_RE =
  /https?:\/\/[^\s)"'<>\]]*(?:vercel\.app|netlify\.app|onrender\.com|herokuapp\.com|railway\.app|github\.io|pages\.dev|fly\.dev|surge\.sh|firebaseapp\.com|web\.app|azurewebsites\.net|amplifyapp\.com|streamlit\.app|huggingface\.co\/spaces|koyeb\.app|deno\.dev|replit\.app|glitch\.me)[^\s)"'<>\]]*/gi;

/** Free tiers that sleep and need longer to answer the first request. */
const SLEEPY = /onrender\.com|streamlit\.app|herokuapp\.com|railway\.app|koyeb\.app|huggingface\.co\/spaces|glitch\.me|replit\.app/i;

/** Letters and digits only, lower-case: "Nxt Trendz" and "suryatrendznxt" become comparable. */
const compact = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Does the page (host, title, opening text) name the project? Substring match, so "iChat" finds "ichat.ccbp.tech". */
function namesProject(projectTitle: string, haystack: string): boolean {
  const hay = compact(haystack);
  const words = new Set([...tokens(projectTitle), ...projectTitle.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w))]);
  return [...words].some((w) => w.length >= 4 && hay.includes(w));
}

async function probeDemo(url: string, projectTitle: string): Promise<DemoCheck> {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  const sleepy = SLEEPY.test(url);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(sleepy ? TIMEOUTS.demoColdStartMs : TIMEOUTS.demoProbeMs),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; nxtwave-placement-automation)" },
    });
    const body = (await res.text().catch(() => "")).slice(0, 200_000);
    const title = (body.match(/<title[^>]*>([^<]{0,200})<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
    if (res.status >= 400) return { url, status: "unreachable", httpStatus: res.status, title, matchesProject: false, note: `HTTP ${res.status}` };
    const head = body.slice(0, 30_000);
    if (SOFT_404.some((re) => re.test(head) || re.test(title))) {
      return { url, status: "soft-404", httpStatus: res.status, title, matchesProject: false, note: "answers, but shows a platform error / parked / default page" };
    }
    const matchesProject = namesProject(projectTitle, `${host.split(".")[0]} ${title} ${head.replace(/<[^>]+>/g, " ").slice(0, 6000)}`);
    return { url, status: "reachable", httpStatus: res.status, title, matchesProject, note: "" };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === "TimeoutError" || err.name === "AbortError" ? "timed out" : err.message.slice(0, 80)) : "failed";
    return {
      url,
      status: "unreachable",
      httpStatus: 0,
      title: "",
      matchesProject: false,
      note: sleepy && msg === "timed out" ? `timed out after ${TIMEOUTS.demoColdStartMs / 1000}s (free-tier app asleep?)` : msg,
    };
  }
}

/** The demo to probe for a project: the resume's own link first, then the repo homepage, then a README deploy link. */
function demoCandidate(p: ExtractedProject, repos: RepoInspection[]): string {
  if (p.live[0]) return p.live[0];
  for (const r of repos) if (/^https?:\/\//i.test(r.homepage) && !/github\.com/i.test(r.homepage) && !NOT_A_DEMO.test(r.homepage)) return r.homepage;
  for (const r of repos) {
    const m = r.readme.match(DEPLOY_RE);
    if (m?.[0]) return m[0].replace(/[.,;)]+$/, "");
  }
  return "";
}

// ── Repo resolution ──────────────────────────────────────────────────────────

/** A profile link in a project section → the owner's repo whose name best matches the project. */
async function repoFromProfile(
  owner: string,
  p: ExtractedProject,
  budget: GithubBudget,
  cache: Map<string, { name: string; description: string | null; fork: boolean; size: number }[] | null>,
): Promise<string | null> {
  if (!cache.has(owner)) {
    const res = await githubGetJson<{ name: string; description: string | null; fork: boolean; size: number }[]>(
      `/users/${encodeURIComponent(owner)}/repos?per_page=100&type=owner&sort=pushed`,
      budget,
    );
    cache.set(owner, res.ok && Array.isArray(res.data) ? res.data : null);
  }
  const repos = cache.get(owner);
  if (!repos) return null;
  const want = new Set(tokens(p.title));
  let best: { name: string; hits: number } | null = null;
  for (const r of repos) {
    if (r.size === 0) continue;
    const hits = tokens(`${r.name} ${r.description ?? ""}`).filter((w) => want.has(w)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { name: r.name, hits };
  }
  return best?.name ?? null;
}

// ── Link re-attribution ──────────────────────────────────────────────────────

/** Technologies too broad to say which project a repo belongs to. */
const BROAD = new Set(["python", "javascript", "typescript", "html-css", "java", "go", "rust", "c-cpp", "php", "ruby", "excel", "data-viz", "rest-api"]);

interface Move {
  link: string;
  from: string;
  to: string;
  why: string;
}

/**
 * A repo whose proven code shares no specific technology (and no name) with the
 * project it was attached to, but does with another project, is moved to that
 * project. Links written inside a project's own block are never moved.
 */
function reattribute(plan: Map<string, { repos: Repo[]; problems: string[] }>, projects: ExtractedProject[], byKey: Map<string, RepoInspectionResult>): Move[] {
  const moves: Move[] = [];
  const specific = (keys: Iterable<string>) => new Set([...keys].filter((k) => !BROAD.has(k)));
  const fit = (p: ExtractedProject, repoName: string, proven: Set<string>) => {
    const claimed = specific(p.claimedTechKeys);
    const shared = [...proven].filter((k) => claimed.has(k));
    // Whole-word match only: "iChat" must not claim "chatbot-pdf".
    const repoWords = new Set(tokens(repoName));
    const name = tokens(p.title).some((w) => repoWords.has(w));
    return { score: shared.length + (name ? 2 : 0), shared, name, claimed: claimed.size };
  };
  for (const [pid, step] of plan) {
    const p = projects.find((q) => q.id === pid);
    if (!p || p.linkPlacement === "in-section") continue;
    for (const r of [...step.repos]) {
      const res = byKey.get(`${r.owner}/${r.repo}`.toLowerCase());
      if (!res?.ok) continue;
      const proven = specific(res.repo.techs.filter((t) => t.hard && t.conf >= TECH_CONF).map((t) => t.key));
      if (!proven.size) continue;
      const here = fit(p, r.repo, proven);
      if (here.score > 0 || here.claimed === 0) continue;
      const best = projects
        .filter((q) => q.id !== pid)
        .map((q) => ({ q, f: fit(q, r.repo, proven) }))
        .filter((o) => o.f.score > 0)
        .sort((a, b) => b.f.score - a.f.score)[0];
      if (!best) continue;
      step.repos = step.repos.filter((x) => x !== r);
      const target = plan.get(best.q.id) ?? { repos: [], problems: [] };
      target.repos.push(r);
      plan.set(best.q.id, target);
      moves.push({
        link: r.link,
        from: pid,
        to: best.q.id,
        why: `its code (${[...proven].slice(0, 4).join(", ")}) shares nothing with ${pid}'s stated tech but ${best.f.name ? `is named like "${best.q.title}"` : `matches ${best.q.id} (${best.f.shared.join(", ")})`}`,
      });
    }
  }
  return moves;
}

// ── Node ─────────────────────────────────────────────────────────────────────

const REASON_ORDER: ReasonCode[] = ["AI_TOOL_COMMIT", "AI_TOOL_TRACE", "FOREIGN_COMMIT", "REPO_NOT_FOUND_OR_PRIVATE"];

export async function projectEvidenceNode(s: State): Promise<Update> {
  const t0 = Date.now();
  const x = s.extraction!;
  const budget = githubBudget(LIMITS.GITHUB_CALLS_PER_CANDIDATE);
  const notes: string[] = [];

  // 1) Whose work is this? Sheet column → resume profile link → the owner most project repos share.
  let githubUser = "";
  let githubUserSource: ProjectEvidenceResult["githubUserSource"] = "";
  const rowLink = parseGithubLink(s.input.githubUrl ?? "");
  if (rowLink.kind !== "invalid") {
    githubUser = rowLink.owner;
    githubUserSource = "row";
  } else if (x.profiles.github?.handle) {
    githubUser = x.profiles.github.handle;
    githubUserSource = "resume";
  } else {
    const owners = new Map<string, number>();
    for (const p of x.projects) {
      for (const u of p.github) {
        const l = parseGithubLink(u);
        if (l.kind !== "invalid") owners.set(l.owner.toLowerCase(), (owners.get(l.owner.toLowerCase()) ?? 0) + 1);
      }
    }
    const top = [...owners.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      githubUser = top[0];
      githubUserSource = "repo-owner";
      if (owners.size > 1) notes.push(`No GitHub profile on the resume; took "${top[0]}" (owner of most project repos) as the candidate's account.`);
    }
  }

  // 2) Projects to audit: the first ones with a GitHub link (resumes lead with their best work).
  const audited = x.projects.filter((p) => p.github.length > 0).slice(0, LIMITS.MAX_PROJECTS_AUDITED);
  const skipped = x.projects.filter((p) => p.github.length > 0).slice(LIMITS.MAX_PROJECTS_AUDITED);
  const profileCache = new Map<string, { name: string; description: string | null; fork: boolean; size: number }[] | null>();
  const plan = new Map<string, { repos: Repo[]; problems: string[] }>();
  let repoSlots = LIMITS.MAX_REPOS_AUDITED;
  for (const p of audited) {
    const repos: Repo[] = [];
    const problems: string[] = [];
    for (const link of p.github.slice(0, 2)) {
      if (repoSlots <= 0) break;
      const l = parseGithubLink(link);
      if (l.kind === "repo") {
        repos.push({ owner: l.owner, repo: l.repo, fromProfile: false, link });
        repoSlots -= 1;
      } else if (l.kind === "profile") {
        const name = await repoFromProfile(l.owner, p, budget, profileCache);
        if (name) {
          repos.push({ owner: l.owner, repo: name, fromProfile: true, link });
          repoSlots -= 1;
        } else {
          problems.push(profileCache.get(l.owner) === null && budget.stop ? "unavailable" : `profile link only (${link}) — no repository matches "${p.title}"`);
        }
      } else {
        problems.push(`not a GitHub repository link (${link})`);
      }
    }
    plan.set(p.id, { repos, problems });
  }

  // 3) Inspect every repo (bounded concurrency; raw file reads are free).
  const allRepos = [...plan.values()].flatMap((v) => v.repos);
  const inspected = await pool(allRepos, 3, (r) => inspectRepository(r.owner, r.repo, budget, { maxCommits: LIMITS.MAX_COMMITS_AUDITED }));
  const byKey = new Map<string, RepoInspectionResult>(allRepos.map((r, i) => [`${r.owner}/${r.repo}`.toLowerCase(), inspected[i]]));

  // 3b) Hidden links are matched to projects by the model. When a repo's code contradicts
  //     the project it was put on (no shared technology, no name match) and clearly fits
  //     another project, it is moved there — and the move is recorded.
  const moves = reattribute(plan, x.projects, byKey);
  const projectsAfter: ExtractedProject[] = x.projects.map((p) => {
    const outLinks = moves.filter((m) => m.from === p.id).map((m) => m.link);
    const inLinks = moves.filter((m) => m.to === p.id).map((m) => m.link);
    if (!outLinks.length && !inLinks.length) return p;
    return {
      ...p,
      github: [...p.github.filter((u) => !outLinks.includes(u)), ...inLinks],
      linkPlacement: inLinks.length ? "code-match" : p.github.length > outLinks.length ? p.linkPlacement : "none",
    };
  });
  for (const [id, step] of plan) if (!step.repos.length && !step.problems.length) plan.delete(id);
  const moveNotes = moves.map((m) => `GitHub link ${m.link} moved from ${m.from} to ${m.to}: ${m.why}`);
  notes.push(...moveNotes);

  // 4) The candidate's identity: login, emails on their linked commits, profile name, resume name.
  const resumeNames = [s.input.name, x.candidateName].filter(Boolean);
  const ownerCounts = new Map<string, number>();
  for (const r of allRepos) ownerCounts.set(r.owner, (ownerCounts.get(r.owner) ?? 0) + 1);
  const topOwner = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  let login = githubUser || topOwner;
  let profileName = "";
  if (login) {
    const u = await githubGetJson<{ name?: string | null; type?: string }>(`/users/${encodeURIComponent(login)}`, budget);
    // A resume / sheet "profile" that is an organisation or no account at all can't be the candidate.
    if (githubUser && (u.status === 404 || u.data?.type === "Organization") && topOwner && topOwner.toLowerCase() !== login.toLowerCase()) {
      notes.push(`"${login}" is ${u.status === 404 ? "not a GitHub account" : "an organisation"} — the project repos' owner @${topOwner} is used instead.`);
      login = topOwner;
      githubUserSource = "repo-owner";
      const u2 = await githubGetJson<{ name?: string | null }>(`/users/${encodeURIComponent(login)}`, budget);
      profileName = u2.data?.name ?? "";
    } else {
      profileName = u.data?.name ?? "";
    }
  }
  // A project repo under another account counts as the candidate's own only when that
  // account carries the candidate's name — in its profile name or its login (a second / older account).
  const logins = [login];
  const others = Array.from(new Set(allRepos.map((r) => r.owner.toLowerCase()))).filter((o) => o !== login.toLowerCase()).slice(0, 2);
  for (const o of others) {
    const u = await githubGetJson<{ name?: string | null; type?: string }>(`/users/${encodeURIComponent(o)}`, budget);
    if (u.data?.type !== "Organization" && (sameName(u.data?.name ?? "", resumeNames) || loginCarriesName(o, resumeNames))) {
      logins.push(o);
      notes.push(`@${o} treated as the candidate's account too — it carries the resume name.`);
    }
  }
  const allCommits: GithubCommitItem[] = inspected.flatMap((r) => (r.ok ? r.repo.commits : []));
  const identity = buildIdentity(logins, allCommits, [profileName, ...resumeNames].filter(Boolean));

  // 5) Per-repo verdicts.
  const repoEvidence = (r: Repo): RepoEvidence => {
    const res = byKey.get(`${r.owner}/${r.repo}`.toLowerCase());
    const base: RepoEvidence = {
      url: `https://github.com/${r.owner}/${r.repo}`,
      owner: r.owner,
      repo: r.repo,
      status: "unavailable",
      invalidReason: null,
      message: "",
      resolvedFromProfile: r.fromProfile,
      fork: "",
      techs: [],
      traceFiles: [],
      integrity: null,
      homepage: "",
      srcFiles: 0,
    };
    if (!res) return { ...base, message: "not inspected" };
    if (!res.ok) {
      return res.failure === "unavailable"
        ? { ...base, status: "unavailable", message: res.message }
        : { ...base, status: "invalid", invalidReason: "REPO_NOT_FOUND_OR_PRIVATE", message: res.message };
    }
    const repo = res.repo;
    const integrity = auditStrict(repo.commits, identity, { truncated: repo.commitsTruncated, fileCount: repo.paths.length });
    const traces = traceFiles(repo.paths, repo.readme, repo.dependencies);
    const techs = repo.techs.filter((t) => t.hard && t.conf >= TECH_CONF).map((t) => ({ key: t.key, label: t.label, conf: t.conf, detail: t.detail }));
    let invalidReason: ReasonCode | null = null;
    let message = "";
    if (integrity.aiCount > 0) {
      invalidReason = "AI_TOOL_COMMIT";
      message = `${integrity.aiCount} AI-tool commit(s), e.g. ${integrity.ai[0]?.signature ?? ""}`;
    } else if (traces.length) {
      invalidReason = "AI_TOOL_TRACE";
      message = `AI coding-tool files: ${traces.slice(0, 3).join("; ")}`;
    } else if (integrity.foreignCount > 0) {
      invalidReason = "FOREIGN_COMMIT";
      message = `${integrity.foreignCount} commit(s) not by the candidate, e.g. ${integrity.foreign[0]?.signature ?? ""}${repo.fork ? ` (fork of ${repo.parent})` : ""}`;
    } else if (integrity.verdict === "empty") {
      invalidReason = "REPO_NOT_FOUND_OR_PRIVATE";
      message = "no commits to audit";
    }
    return {
      ...base,
      url: repo.url,
      owner: repo.owner,
      repo: repo.repo,
      status: invalidReason ? "invalid" : "verified",
      invalidReason,
      message: message || `no AI / foreign signatures in ${integrity.audited} commit(s)${integrity.truncated ? " (history truncated)" : ""}`,
      fork: repo.parent,
      techs,
      traceFiles: traces,
      integrity,
      homepage: repo.homepage,
      srcFiles: repo.srcFiles,
    };
  };

  // 6) Demo probes (parallel): audited projects and demo-only projects.
  const demoOnly = projectsAfter.filter((p) => !p.github.length && p.live.length).slice(0, LIMITS.MAX_DEMO_CHECKS);
  const demoJobs: { id: string; url: string; title: string }[] = [];
  for (const p of projectsAfter.filter((q) => plan.has(q.id))) {
    const repos = (plan.get(p.id)?.repos ?? [])
      .map((r) => byKey.get(`${r.owner}/${r.repo}`.toLowerCase()))
      .filter((r): r is Extract<RepoInspectionResult, { ok: true }> => Boolean(r?.ok))
      .map((r) => r.repo);
    const url = demoCandidate(p, repos);
    if (url) demoJobs.push({ id: p.id, url, title: p.title });
  }
  for (const p of demoOnly) demoJobs.push({ id: p.id, url: p.live[0], title: p.title });
  const demoResults = await Promise.all(demoJobs.map((j) => probeDemo(j.url, j.title)));
  const demos = new Map(demoJobs.map((j, i) => [j.id, demoResults[i]]));

  // 7) Project verdicts and tiers.
  const projects: ProjectEvidence[] = [];
  let unavailable = false;
  for (const p of projectsAfter) {
    const demo = demos.get(p.id) ?? null;
    const base: ProjectEvidence = {
      projectId: p.id,
      title: p.title,
      status: "no_link",
      valid: false,
      tier: "D",
      invalidReason: null,
      repos: [],
      demo,
      techKeys: [],
      buckets: [],
      backend: false,
      note: "",
    };
    const step = plan.get(p.id);
    if (!step) {
      if (p.github.length) {
        projects.push({ ...base, status: "not_audited", note: `not audited — only the first ${LIMITS.MAX_PROJECTS_AUDITED} GitHub-linked projects are checked` });
        continue;
      }
      if (p.live.length) {
        const claimed = new Set(p.claimedTechKeys);
        const ok = demo?.status === "reachable" && demo.matchesProject;
        projects.push({
          ...base,
          status: "demo_only",
          valid: ok,
          tier: ok ? "C" : "D",
          techKeys: [...claimed],
          buckets: ok ? bucketsFor(claimed) : [],
          backend: hasBackend(claimed),
          note: ok ? "demo only — reachable and about this project (claimed tech, not code-verified)" : `demo only — ${demo ? `${demo.status}${demo.note ? ` (${demo.note})` : ""}${demo.status === "reachable" ? ", page doesn't name the project" : ""}` : "not checked"}`,
        });
        continue;
      }
      projects.push({ ...base, note: "no GitHub or demo link in this project's section" });
      continue;
    }

    const repos = step.repos.map(repoEvidence);
    const problems = step.problems;
    const invalid = repos.filter((r) => r.status === "invalid");
    const pending = repos.filter((r) => r.status === "unavailable").length + problems.filter((q) => q === "unavailable").length;
    const hardProblems = problems.filter((q) => q !== "unavailable");
    const verified = repos.filter((r) => r.status === "verified");
    const synth = repos.flatMap((r) => {
      const res = byKey.get(`${r.owner}/${r.repo}`.toLowerCase());
      return res?.ok ? synthFromRepo(res.repo.paths, res.repo.dependencies) : [];
    });
    const set = provenTechSet(verified.flatMap((r) => r.techs.map((t) => ({ key: t.key, conf: t.conf, hard: true }))), synth);

    let status: ProjectEvidence["status"];
    let invalidReason: ReasonCode | null = null;
    let note = "";
    if (invalid.length || (hardProblems.length && !repos.length)) {
      status = "invalid";
      invalidReason = REASON_ORDER.find((code) => invalid.some((r) => r.invalidReason === code)) ?? "REPO_NOT_FOUND_OR_PRIVATE";
      note = invalid.map((r) => `${r.owner}/${r.repo}: ${r.message}`).concat(hardProblems).join(" · ");
    } else if (pending) {
      status = "unavailable";
      unavailable = true;
      note = repos.filter((r) => r.status === "unavailable").map((r) => r.message).join(" · ") || "GitHub unavailable";
    } else {
      status = "verified";
      note = verified.map((r) => `${r.owner}/${r.repo}: ${r.message}`).join(" · ");
      if (verified.some((r) => r.resolvedFromProfile)) note += " · repo matched by name from a profile link";
    }
    const valid = status === "verified";
    const tier: Tier = valid ? (demo?.status === "reachable" ? "A" : "B") : "D";
    projects.push({
      ...base,
      status,
      valid,
      tier,
      invalidReason,
      repos,
      techKeys: [...set],
      buckets: valid ? bucketsFor(set) : [],
      backend: hasBackend(set),
      note,
    });
  }
  for (const p of skipped) notes.push(`${p.id} "${p.title}" not audited (cap of ${LIMITS.MAX_PROJECTS_AUDITED} GitHub projects).`);

  // 8) Open-source claims — a merged PR authored by the candidate, or commits by them in someone else's repo.
  const oss: OssEvidence[] = [];
  let ossChecks = 0;
  for (const claim of x.openSource) {
    if (!claim.urls.length) {
      oss.push({ claimId: claim.id, url: "", status: "unverified", note: "no PR / repository link to check" });
      continue;
    }
    for (const url of claim.urls.slice(0, 2)) {
      if (ossChecks >= LIMITS.MAX_OSS_CHECKS) break;
      ossChecks += 1;
      // OSS is a bonus: an unavailable check is reported, never a reason to re-run.
      oss.push(await verifyOss(claim.id, url, login, budget));
    }
  }

  const result: ProjectEvidenceResult = {
    githubUser: login,
    githubUserSource: githubUser ? githubUserSource : login ? "repo-owner" : "",
    projects,
    oss,
    callsUsed: LIMITS.GITHUB_CALLS_PER_CANDIDATE - budget.restLeft,
    unavailable,
    notes: budget.stop && budget.reason ? [...notes, `GitHub: ${budget.reason}`] : notes,
  };
  const counts = (["A", "B", "C"] as Tier[]).map((t) => `${t}:${projects.filter((p) => p.valid && p.tier === t).length}`).join(" ");
  const bad = projects.filter((p) => p.status === "invalid").map((p) => `${p.projectId} ${p.invalidReason}`);
  return {
    projectEvidence: result,
    // The moved links, so every later agent and the report see the corrected attribution.
    ...(moves.length ? { extraction: { ...x, projects: projectsAfter, dropped: [...x.dropped, ...moveNotes] } } : {}),
    ...traceEntry(
      "project_evidence",
      t0,
      `${allRepos.length} repo(s) audited as @${login || "?"}; valid ${counts}` +
        (moves.length ? `; ${moves.length} link(s) re-attributed by code` : "") +
        (bad.length ? `; invalid ${bad.join(", ")}` : "") +
        (unavailable ? "; GitHub UNAVAILABLE for some" : "") +
        `; ${result.callsUsed} REST calls`,
    ),
  };
}

async function verifyOss(claimId: string, url: string, login: string, budget: GithubBudget): Promise<OssEvidence> {
  const pr = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!login) return { claimId, url, status: "unverified", note: "candidate's GitHub account unknown" };
  if (pr) {
    const res = await githubGetJson<{ merged_at?: string | null; user?: { login?: string } }>(`/repos/${pr[1]}/${pr[2]}/pulls/${pr[3]}`, budget);
    if (!res.ok) return { claimId, url, status: res.status === 404 ? "unverified" : "unavailable", note: res.status === 404 ? "PR not found" : "GitHub unavailable" };
    const author = (res.data?.user?.login ?? "").toLowerCase();
    if (author !== login.toLowerCase()) return { claimId, url, status: "unverified", note: `PR opened by @${author || "?"}, not the candidate` };
    return res.data?.merged_at
      ? { claimId, url, status: "verified", note: `merged ${res.data.merged_at.slice(0, 10)}` }
      : { claimId, url, status: "unverified", note: "PR not merged" };
  }
  const l = parseGithubLink(url);
  if (l.kind !== "repo") return { claimId, url, status: "unverified", note: "not a PR or repository link" };
  if (l.owner.toLowerCase() === login.toLowerCase()) return { claimId, url, status: "unverified", note: "the candidate's own repository, not a contribution" };
  const res = await githubGetJson<unknown[]>(`/repos/${l.owner}/${l.repo}/commits?author=${encodeURIComponent(login)}&per_page=1`, budget);
  if (!res.ok) return { claimId, url, status: res.status === 404 ? "unverified" : "unavailable", note: res.status === 404 ? "repository not found" : "GitHub unavailable" };
  return Array.isArray(res.data) && res.data.length
    ? { claimId, url, status: "verified", note: `commits by @${login} in ${l.owner}/${l.repo}` }
    : { claimId, url, status: "unverified", note: `no commits by @${login} in ${l.owner}/${l.repo}` };
}
