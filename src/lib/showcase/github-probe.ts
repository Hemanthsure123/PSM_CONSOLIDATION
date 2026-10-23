import "server-only";
import { env } from "@/lib/env";
import { inspectionCacheKey, readInspectionCache, writeInspectionCache } from "@/lib/github-inspect-cache";
import type { SpProbe, SpProbeRepo } from "@/lib/showcase/types";

/**
 * Sample profiles — a cheap look at a GitHub account before anything expensive: one GraphQL
 * query (its own rate pool, separate from the REST calls the deep inspection uses) for the
 * account type, its name and its 60 most recently pushed own, non-fork repositories with size,
 * language and commit count. Weeds out missing accounts, organisations and accounts with no
 * real code, and gives the per-project verification its repo list. Reused for 24 h.
 */

const VERSION = 1;
/** A repository smaller than this is a stub, not a project. */
const MIN_REPO_KB = 30;

const QUERY = `query($login:String!){
  repositoryOwner(login:$login){
    __typename login
    ... on User {
      name createdAt
      repositories(first:60, ownerAffiliations:OWNER, isFork:false, orderBy:{field:PUSHED_AT, direction:DESC}) {
        nodes { name url diskUsage pushedAt isArchived primaryLanguage { name }
          defaultBranchRef { target { ... on Commit { history { totalCount } } } } }
      }
    }
  }
}`;

interface GqlRepo {
  name: string;
  url: string;
  diskUsage: number | null;
  pushedAt: string;
  isArchived: boolean;
  primaryLanguage: { name: string } | null;
  defaultBranchRef: { target: { history?: { totalCount: number } } | null } | null;
}

export async function probeGithub(login: string): Promise<SpProbe> {
  const now = new Date().toISOString();
  const fail = (status: SpProbe["status"], note: string, retryAfterMs?: number): SpProbe => ({ status, note, login, name: "", createdAt: "", repos: [], checkedAt: now, ...(retryAfterMs ? { retryAfterMs } : {}) });
  const token = env.github.token;
  if (!token) return fail("failed", "GITHUB_TOKEN is not set in .env.local.");
  if (!login) return fail("not-found", "No GitHub username.");
  const key = inspectionCacheKey({ scope: "showcase-probe", v: VERSION, login: login.toLowerCase() });
  const hit = await readInspectionCache<SpProbe>(key);
  if (hit) return hit.value;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "nxtwave-placement-automation" },
      body: JSON.stringify({ query: QUERY, variables: { login } }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const waitMs = Number.isFinite(reset) && reset > 0 ? Math.max(5_000, reset * 1000 - Date.now() + 2_000) : 60_000;
    if (res.status === 401) return fail("failed", "GitHub rejected GITHUB_TOKEN (401).");
    if (res.status === 403 || res.status === 429) return fail("failed", "GitHub rate limit — waiting for the reset.", waitMs);
    if (!res.ok) return fail("failed", `GitHub HTTP ${res.status}`, 30_000);
    const body = (await res.json()) as {
      data?: { repositoryOwner?: { __typename: string; login: string; name?: string | null; createdAt?: string; repositories?: { nodes: GqlRepo[] } } | null };
      errors?: { type?: string; message?: string }[];
    };
    if (body.errors?.some((e) => e.type === "RATE_LIMITED")) return fail("failed", "GitHub rate limit — waiting for the reset.", waitMs);
    const owner = body.data?.repositoryOwner;
    let out: SpProbe;
    if (!owner) out = fail("not-found", `GitHub account "${login}" does not exist.`);
    else if (owner.__typename !== "User") out = { ...fail("organisation", `"${login}" is an organisation, not a person's account.`), login: owner.login };
    else {
      const repos: SpProbeRepo[] = (owner.repositories?.nodes ?? []).map((r) => ({
        name: r.name,
        url: r.url,
        diskKb: r.diskUsage ?? 0,
        pushedAt: r.pushedAt,
        language: r.primaryLanguage?.name ?? "",
        commits: r.defaultBranchRef?.target?.history?.totalCount ?? 0,
        archived: r.isArchived,
      }));
      const real = repos.filter((r) => r.diskKb >= MIN_REPO_KB && r.commits > 0);
      out = {
        status: real.length ? "ok" : "no-code",
        note: real.length ? "" : "No own, non-fork repository with real code.",
        login: owner.login,
        name: owner.name ?? "",
        createdAt: owner.createdAt ?? "",
        repos,
        checkedAt: now,
      };
    }
    await writeInspectionCache(key, out);
    return out;
  } catch (err) {
    return fail("failed", err instanceof Error ? (err.name === "AbortError" ? "GitHub timed out" : err.message.slice(0, 120)) : "GitHub failed", 15_000);
  }
}
