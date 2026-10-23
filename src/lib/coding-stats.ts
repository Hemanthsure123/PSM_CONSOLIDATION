import "server-only";
import { env } from "@/lib/env";
import { acquireHost } from "@/lib/rate-limit";
import type { DomainCommit, GithubProject, GithubProjectStats, LanguageCount } from "@/lib/types";

/**
 * Live stat fetchers for the screening report:
 *  - LeetCode solved / contests / rating (public GraphQL)
 *  - Codeforces solved / rated contests / rating (public REST API)
 *  - CodeChef solved / contests / rating (public profile page — no API exists)
 *  - GitHub JD-matching project stats + latest domain commit (authenticated REST, needs a PAT)
 *
 * Every fetcher is best-effort: it times out and returns null on any failure so
 * a slow/blocked platform can never hang or fail a report.
 */

const TIMEOUT_MS = 7000;
const UA = "nxtwave-placement-automation";

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // no-store: Next.js caches server-side fetches by default — stats must be live.
    return await fetch(url, { ...init, cache: "no-store", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Username / handle parsing ───────────────────────────────────────────────

const LC_RESERVED = new Set(["u", "problems", "contest", "problemset", "discuss", "explore", "tag", "accounts", "profile"]);

export function parseLeetCodeUser(url: string): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  const slash = u.match(/leetcode\.com\/u\/([^/?#]+)/i);
  if (slash) return decodeURIComponent(slash[1]);
  const legacy = u.match(/leetcode\.com\/([^/?#]+)\/?(?:[?#]|$)/i);
  if (legacy && !LC_RESERVED.has(legacy[1].toLowerCase())) return decodeURIComponent(legacy[1]);
  return null;
}

export function parseCodeforcesHandle(url: string): string | null {
  const m = (url ?? "").match(/codeforces\.com\/(?:profile|submissions|contests\/with|blog|usertalk\/with)\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

/** codechef.com/users/<handle> (any subdomain, trailing path ignored). */
export function parseCodeChefHandle(url: string): string | null {
  const m = (url ?? "").match(/codechef\.com\/users\/([^/?#\s]+)/i);
  if (!m) return null;
  const handle = decodeURIComponent(m[1]).trim();
  return /^[A-Za-z0-9_.]{2,40}$/.test(handle) ? handle : null;
}

const GH_RESERVED = new Set(["orgs", "topics", "search", "marketplace", "sponsors", "settings", "about", "features"]);

export function parseGithubUser(url: string): string | null {
  const m = (url ?? "").match(/github\.com\/([^/?#]+)/i);
  if (!m) return null;
  const user = decodeURIComponent(m[1]);
  return GH_RESERVED.has(user.toLowerCase()) ? null : user;
}

// ── Platform stats (solved · contests · rating) ─────────────────────────────

/**
 * One platform's numbers for a profile. `null` always means "unknown" (fetch
 * failed / blocked) — never zero. A rating of `null` on a profile that WAS read
 * (`found: true`) means the user is unrated (no rated contest yet).
 */
export interface PlatformStats {
  /** Profile exists. `null` when we couldn't tell (blocked / network). */
  found: boolean | null;
  solved: number | null;
  /** Rated contests participated. */
  contests: number | null;
  /** Current contest rating. */
  rating: number | null;
  /** Highest contest rating (Codeforces / CodeChef; LeetCode doesn't expose it). */
  maxRating: number | null;
  /** "" when everything was read, else a short reason. */
  note: string;
  /** The name the profile's owner set (LeetCode real name, CodeChef display name), when the page shows one. */
  ownerName?: string;
  /** The GitHub link the owner put on their profile (LeetCode), when set. */
  ownerGithub?: string;
}

const UNKNOWN: PlatformStats = { found: null, solved: null, contests: null, rating: null, maxRating: null, note: "" };

/**
 * Fetch through the host's token bucket, retrying rate limits (429), server
 * errors and timeouts with backoff (Retry-After honoured). Returns the last
 * response, or throws after the final network failure.
 */
async function platformFetch(
  host: string,
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; attempts: number; backoffMs: number },
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    await acquireHost(host);
    try {
      const res = await fetchWithTimeout(url, init, opts.timeoutMs);
      if ((res.status === 429 || res.status >= 500) && attempt < opts.attempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : opts.backoffMs * attempt;
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < opts.attempts) await new Promise((r) => setTimeout(r, opts.backoffMs * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}

const errText = (err: unknown) =>
  err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message.slice(0, 80)) : "request failed";

// ── LeetCode (public GraphQL) ───────────────────────────────────────────────

const LC_QUERY = `query stats($username: String!) {
  matchedUser(username: $username) { githubUrl profile { realName } submitStatsGlobal { acSubmissionNum { difficulty count } } }
  userContestRanking(username: $username) { attendedContestsCount rating }
}`;

export async function getLeetCodeStats(profileUrl: string): Promise<PlatformStats | null> {
  const username = parseLeetCodeUser(profileUrl);
  if (!username) return null;
  try {
    const res = await platformFetch(
      "leetcode.com",
      "https://leetcode.com/graphql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Referer: `https://leetcode.com/u/${encodeURIComponent(username)}/`,
        },
        body: JSON.stringify({ query: LC_QUERY, variables: { username } }),
      },
      { timeoutMs: 12_000, attempts: 3, backoffMs: 2_000 },
    );
    if (!res.ok) return { ...UNKNOWN, note: `LeetCode HTTP ${res.status}` };
    const data = (await res.json()) as {
      data?: {
        matchedUser?: { githubUrl?: string | null; profile?: { realName?: string | null } | null; submitStatsGlobal?: { acSubmissionNum?: { difficulty: string; count: number }[] } } | null;
        userContestRanking?: { attendedContestsCount?: number; rating?: number } | null;
      } | null;
      errors?: { message?: string }[];
    };
    const user = data.data?.matchedUser;
    if (!user) {
      const missing = (data.errors ?? []).some((e) => /does not exist/i.test(e.message ?? ""));
      return missing
        ? { found: false, solved: null, contests: null, rating: null, maxRating: null, note: "Profile not found" }
        : { ...UNKNOWN, note: "LeetCode returned no data" };
    }
    const nums = user.submitStatsGlobal?.acSubmissionNum ?? [];
    const all = nums.find((n) => n.difficulty === "All");
    const solved = all ? Number(all.count) || 0 : nums.reduce((s, n) => s + (Number(n.count) || 0), 0);
    // No ranking object = never took a contest (not an error).
    const ranking = data.data?.userContestRanking ?? null;
    const contests = ranking ? Number(ranking.attendedContestsCount) || 0 : 0;
    const rating = contests > 0 && Number(ranking?.rating) > 0 ? Math.round(Number(ranking?.rating)) : null;
    const ownerName = (user.profile?.realName ?? "").trim();
    const ownerGithub = (user.githubUrl ?? "").trim();
    return { found: true, solved, contests, rating, maxRating: null, note: "", ...(ownerName ? { ownerName } : {}), ...(ownerGithub ? { ownerGithub } : {}) };
  } catch (err) {
    console.warn("[coding-stats] leetcode failed:", errText(err));
    return { ...UNKNOWN, note: `LeetCode ${errText(err)}` };
  }
}

/** Total solved only — kept for the screening report / domain shortlist. */
export async function getLeetCodeSolved(profileUrl: string): Promise<number | null> {
  return (await getLeetCodeStats(profileUrl))?.solved ?? null;
}

// ── Codeforces (public REST) ────────────────────────────────────────────────

interface CfResponse<T> {
  status: "OK" | "FAILED";
  comment?: string;
  result?: T;
}

/** One Codeforces API call; "Call limit exceeded" is retried like a 429. */
async function cfApi<T>(path: string, timeoutMs: number): Promise<CfResponse<T> | { status: "HTTP"; code: number }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await platformFetch(
      "codeforces.com",
      `https://codeforces.com/api/${path}`,
      { headers: { "User-Agent": UA } },
      { timeoutMs, attempts: 2, backoffMs: 2_500 },
    );
    let body: CfResponse<T> | null = null;
    try {
      body = (await res.json()) as CfResponse<T>;
    } catch {
      body = null;
    }
    if (body?.status === "FAILED" && /limit exceeded/i.test(body.comment ?? "") && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2_500 * attempt));
      continue;
    }
    if (body) return body;
    return { status: "HTTP", code: res.status };
  }
  return { status: "HTTP", code: 429 };
}

const cfNotFound = (comment?: string) => /not found|should contain between/i.test(comment ?? "");

/**
 * Codeforces keeps a renamed account's old handle as an alias: user.info resolves it
 * to the current handle, but user.rating / user.status only accept the current one
 * (and answer "not found" for the old). Returns the current handle when `handle` is a
 * renamed account's old handle, else null.
 */
async function cfRenamedHandle(handle: string): Promise<string | null> {
  const res = await cfApi<{ handle?: string }[]>(`user.info?handles=${encodeURIComponent(handle)}`, 15_000);
  if (res.status !== "OK") return null;
  const current = res.result?.[0]?.handle;
  return current && current.toLowerCase() !== handle.toLowerCase() ? current : null;
}

async function codeforcesSolvedCount(handle: string): Promise<{ solved: number | null; note: string; found: boolean | null }> {
  // Heavy accounts have thousands of submissions — give this call real time.
  const res = await cfApi<{ verdict?: string; problem?: { contestId?: number; index?: string; name?: string } }[]>(
    `user.status?handle=${encodeURIComponent(handle)}&from=1&count=100000`,
    30_000,
  );
  if (res.status === "HTTP") return { solved: null, note: `Codeforces HTTP ${res.code}`, found: null };
  if (res.status === "FAILED") {
    return cfNotFound(res.comment)
      ? { solved: null, note: "Profile not found", found: false }
      : { solved: null, note: `Codeforces: ${res.comment ?? "failed"}`, found: null };
  }
  const solved = new Set<string>();
  for (const sub of res.result ?? []) {
    if (sub.verdict === "OK" && sub.problem) {
      solved.add(`${sub.problem.contestId ?? sub.problem.name ?? "x"}-${sub.problem.index ?? "x"}`);
    }
  }
  return { solved: solved.size, note: "", found: true };
}

export interface CodeforcesUser {
  found: boolean;
  rating: number | null;
  maxRating: number | null;
  /** First + last name the user set ("" when none). */
  name: string;
  /** The canonical handle (a renamed account's old handle resolves to the new one). */
  handle: string;
}

/**
 * Many Codeforces users in one paced call (user.info accepts a list): current and highest rating
 * and the owner's name. A handle that doesn't exist makes Codeforces fail the whole call and name
 * it — it is marked not found and the call is repeated without it. `null` for a handle = unknown
 * (rate limit / network), never "not found".
 */
export async function getCodeforcesUsers(handles: string[]): Promise<Map<string, CodeforcesUser | null>> {
  const out = new Map<string, CodeforcesUser | null>();
  let pending = [...new Set(handles.map((h) => h.trim()).filter(Boolean))];
  for (let round = 0; round < 25 && pending.length; round++) {
    const res = await cfApi<{ handle?: string; rating?: number; maxRating?: number; firstName?: string; lastName?: string }[]>(
      `user.info?handles=${pending.map(encodeURIComponent).join(";")}`,
      20_000,
    ).catch(() => null);
    if (res && res.status === "OK" && "result" in res && Array.isArray(res.result)) {
      res.result.forEach((u, i) => {
        const asked = pending[i];
        out.set(asked.toLowerCase(), {
          found: true,
          rating: Number(u.rating) > 0 ? Number(u.rating) : null,
          maxRating: Number(u.maxRating) > 0 ? Number(u.maxRating) : null,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim(),
          handle: u.handle ?? asked,
        });
      });
      return out;
    }
    const missing = res && res.status === "FAILED" ? (res.comment ?? "").match(/handles?:\s*User with handle\s+(\S+)\s+not found/i)?.[1] : undefined;
    if (missing) {
      out.set(missing.toLowerCase(), { found: false, rating: null, maxRating: null, name: "", handle: missing });
      pending = pending.filter((h) => h.toLowerCase() !== missing.toLowerCase());
      continue;
    }
    break; // rate limit / network: the rest stay unknown
  }
  for (const h of pending) if (!out.has(h.toLowerCase())) out.set(h.toLowerCase(), null);
  return out;
}

/** Rated contests of one Codeforces handle (one paced call); null = unknown. */
export async function getCodeforcesRatedContests(handle: string): Promise<number | null> {
  try {
    const res = await cfApi<unknown[]>(`user.rating?handle=${encodeURIComponent(handle)}`, 15_000);
    return res.status === "OK" && "result" in res && Array.isArray(res.result) ? res.result.length : null;
  } catch {
    return null;
  }
}

/** The first / last name a Codeforces user set on their profile ("" when none or unreadable). One paced API call. */
export async function getCodeforcesOwnerName(profileUrl: string): Promise<string> {
  const handle = parseCodeforcesHandle(profileUrl);
  if (!handle) return "";
  try {
    const res = await cfApi<{ firstName?: string; lastName?: string }[]>(`user.info?handles=${encodeURIComponent(handle)}`, 15_000);
    if (res.status !== "OK" || !("result" in res) || !res.result?.[0]) return "";
    const u = res.result[0];
    return [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  } catch {
    return "";
  }
}

export async function getCodeforcesStats(profileUrl: string): Promise<PlatformStats | null> {
  let handle = parseCodeforcesHandle(profileUrl);
  if (!handle) return null;
  try {
    const ratingOf = (h: string) => cfApi<{ newRating?: number }[]>(`user.rating?handle=${encodeURIComponent(h)}`, 15_000);
    let history = await ratingOf(handle);
    let renamedTo = "";
    if (history.status === "FAILED" && cfNotFound(history.comment)) {
      // An old handle of a renamed account (the resume predates the rename) — follow it.
      const current = await cfRenamedHandle(handle);
      if (current) {
        renamedTo = current;
        handle = current;
        history = await ratingOf(current);
      }
      if (history.status === "FAILED" && cfNotFound(history.comment)) {
        return { found: false, solved: null, contests: null, rating: null, maxRating: null, note: "Profile not found" };
      }
    }
    let contests: number | null = null;
    let rating: number | null = null;
    let maxRating: number | null = null;
    const notes: string[] = renamedTo ? [`handle renamed to ${renamedTo}`] : [];
    if (history.status === "OK" && Array.isArray(history.result)) {
      contests = history.result.length;
      const ratings = history.result.map((r) => Number(r.newRating)).filter((n) => Number.isFinite(n));
      rating = ratings.length ? ratings[ratings.length - 1] : null;
      maxRating = ratings.length ? Math.max(...ratings) : null;
    } else {
      notes.push(history.status === "HTTP" ? `rating HTTP ${history.code}` : `rating: ${history.comment ?? "failed"}`);
    }
    const s = await codeforcesSolvedCount(handle);
    if (s.note) notes.push(s.note);
    return {
      found: s.found === false ? false : contests !== null || s.found ? true : null,
      solved: s.solved,
      contests,
      rating,
      maxRating,
      note: notes.join("; "),
    };
  } catch (err) {
    console.warn("[coding-stats] codeforces failed:", errText(err));
    return { ...UNKNOWN, note: `Codeforces ${errText(err)}` };
  }
}

/** Distinct solved only — kept for the screening report / domain shortlist. */
export async function getCodeforcesSolved(profileUrl: string): Promise<number | null> {
  const handle = parseCodeforcesHandle(profileUrl);
  if (!handle) return null;
  try {
    const s = await codeforcesSolvedCount(handle);
    if (s.found !== false) return s.solved;
    const current = await cfRenamedHandle(handle);
    return current ? (await codeforcesSolvedCount(current)).solved : null;
  } catch (err) {
    console.warn("[coding-stats] codeforces failed:", errText(err));
    return null;
  }
}

// ── CodeChef (profile page — CodeChef has no public API) ────────────────────

/**
 * CodeChef exposes no public stats API, so the public profile page
 * (codechef.com/users/<handle>) is read and parsed. Verified markers:
 *   <div class="rating-number">2512</div>       current rating ("NA"/absent = unrated)
 *   (Highest Rating 2538)                        highest rating
 *   Total Problems Solved: 1264                  solved (blank = 0)
 *   Contests Participated: <b>96</b>             contests (else "Contests (96)" / rating history)
 * A missing profile redirects to the home page. CodeChef rate-limits hard
 * (≈ 1 request / 5 s sustained) — the token bucket paces requests and 429s are
 * retried with backoff.
 */
export async function getCodeChefStats(profileUrl: string): Promise<PlatformStats | null> {
  const handle = parseCodeChefHandle(profileUrl);
  if (!handle) return null;
  try {
    const res = await platformFetch(
      "codechef.com",
      `https://www.codechef.com/users/${encodeURIComponent(handle)}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; nxtwave-placement-automation)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      },
      { timeoutMs: 20_000, attempts: 4, backoffMs: 8_000 },
    );
    if (res.status === 429) return { ...UNKNOWN, note: "CodeChef rate-limited — re-run later" };
    if (!res.ok) return { ...UNKNOWN, note: `CodeChef HTTP ${res.status}` };
    const html = await res.text();
    if (!/\/users\//i.test(res.url) || !html.includes("user-details-container")) {
      return { found: false, solved: null, contests: null, rating: null, maxRating: null, note: "Profile not found" };
    }
    return parseCodeChefProfile(html);
  } catch (err) {
    console.warn("[coding-stats] codechef failed:", errText(err));
    return { ...UNKNOWN, note: `CodeChef ${errText(err)}` };
  }
}

/** Parse a CodeChef profile page. Exported for tests. */
export function parseCodeChefProfile(html: string): PlatformStats {
  const num = (m: RegExpMatchArray | null) => (m && m[1] !== undefined && m[1] !== "" ? Number(m[1]) : null);

  // Rating history embedded for the chart — the most reliable contest source.
  let history: { rating?: string }[] | null = null;
  const hist = html.match(/var all_rating\s*=\s*(\[[\s\S]*?\]);/);
  if (hist) {
    try {
      const parsed = JSON.parse(hist[1]) as unknown;
      history = Array.isArray(parsed) ? (parsed as { rating?: string }[]) : null;
    } catch {
      history = null;
    }
  }

  const solvedMatch = html.match(/Total Problems Solved:\s*(\d*)\s*</i);
  const solved = solvedMatch ? (solvedMatch[1] ? Number(solvedMatch[1]) : 0) : null;

  const contests =
    num(html.match(/Contests Participated:\s*<b>\s*(\d+)\s*<\/b>/i)) ??
    num(html.match(/<h3>\s*Contests\s*\((\d+)\)\s*<\/h3>/i)) ??
    (history ? history.length : null);

  // Current rating exactly as the profile shows it: "NA" / "0" = unrated. Only
  // when the rating block itself is missing (layout change) fall back to the
  // last entry of the rating history.
  const ratingDiv = html.match(/<div class="rating-number">\s*([^<]*?)\s*<\/div>/i);
  let rating: number | null = null;
  if (ratingDiv) {
    const n = parseInt(ratingDiv[1], 10);
    rating = Number.isFinite(n) && n > 0 ? n : null;
  } else if (contests && history?.length) {
    const last = Number(history[history.length - 1].rating);
    rating = Number.isFinite(last) && last > 0 ? last : null;
  }
  const maxRating = num(html.match(/Highest Rating\s*(\d+)/i));

  const missing = [solved === null ? "solved" : "", contests === null ? "contests" : ""].filter(Boolean);
  const owner = html.match(/<h1[^>]*class="[^"]*h2-style[^"]*"[^>]*>\s*([^<]{2,80}?)\s*<\/h1>/i)?.[1]?.trim() ?? "";
  return {
    ...(owner ? { ownerName: owner } : {}),
    found: true,
    solved,
    contests,
    rating,
    maxRating: maxRating && maxRating > 0 ? maxRating : null,
    note: missing.length ? `CodeChef page changed — couldn't read ${missing.join(" & ")}` : "",
  };
}

// ── GitHub (authenticated, JD-matching) ──────────────────────────────────────

interface RawRepo {
  name: string;
  full_name: string;
  html_url: string;
  language: string | null;
  fork: boolean;
  description: string | null;
  topics?: string[];
  stargazers_count?: number;
  pushed_at: string | null;
}

/** The configured PAT, or null when unset or still an example placeholder. */
export function githubToken(): string | null {
  const token = env.github.token.trim();
  return token && !/^(ghp|github_pat)_REPLACE/i.test(token) ? token : null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": UA,
  };
}

async function listOwnedRepos(username: string, token: string): Promise<RawRepo[]> {
  const repos: RawRepo[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetchWithTimeout(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&type=owner&sort=updated&page=${page}`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) break;
    const batch = (await res.json()) as RawRepo[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((r) => !r.fork);
}

/**
 * A repo is JD-relevant if its language matches a JD term, or its name,
 * description or topics contain a JD word / two-word phrase as WHOLE words — a
 * substring test would count "html" as "ml" and "email" as "ai".
 */
function repoMatchesJd(repo: RawRepo, jdTerms: string[]): boolean {
  const lang = (repo.language ?? "").toLowerCase();
  if (lang && jdTerms.includes(lang)) return true;
  const words = new Set<string>();
  const phrases = new Set<string>();
  for (const field of [repo.name, repo.description ?? "", ...(repo.topics ?? [])]) {
    // Both as written ("pytorch-examples") and camelCase-split ("DeepLearning").
    for (const seq of [wordsOf(field), wordsOf(field.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))]) {
      seq.forEach((w, i) => {
        words.add(stem(w));
        if (i > 0) phrases.add(`${stem(seq[i - 1])} ${stem(w)}`);
      });
    }
  }
  return jdTerms.some((t) => (t.includes(" ") ? phrases.has(t) : words.has(t)));
}

/**
 * Fetch JD-matching GitHub project stats. Returns null when there's no token, no
 * resolvable username, no JD terms (strictly JD-restricted), or no matches.
 * `lastDomainCommit` also looks up the candidate's newest commit to a matching repo.
 */
export async function getGithubStats(
  githubProfileUrl: string,
  projectUrls: GithubProject[],
  jdTerms: string[],
  opts: { lastDomainCommit?: boolean } = {},
): Promise<GithubProjectStats | null> {
  const token = githubToken();
  if (!token) return null;
  if (jdTerms.length === 0) return null;

  const username =
    parseGithubUser(githubProfileUrl) ||
    projectUrls.map((p) => parseGithubUser(p.url)).find((u): u is string => Boolean(u)) ||
    null;
  if (!username) return null;

  try {
    const repos = await listOwnedRepos(username, token);
    const matching = repos.filter((r) => repoMatchesJd(r, jdTerms));
    if (matching.length === 0) return null;

    const langMap = new Map<string, number>();
    for (const r of matching) {
      const lang = r.language;
      if (!lang) continue;
      langMap.set(lang, (langMap.get(lang) ?? 0) + 1);
    }
    const languages: LanguageCount[] = [...langMap.entries()]
      .map(([lang, count]) => ({ lang, count }))
      .sort((a, b) => b.count - a.count);

    const projects: GithubProject[] = [...matching]
      .sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0))
      .slice(0, 5)
      .map((r) => ({ name: r.name, url: r.html_url }));

    const lastDomainCommit = opts.lastDomainCommit ? await latestDomainCommit(username, matching, token) : null;
    return { matchingCount: matching.length, languages, projects, lastDomainCommit };
  } catch (err) {
    console.warn("[coding-stats] github failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Total public commit contributions over the last ~2 years, via the GitHub
 * GraphQL `contributionsCollection`. A GraphQL window is capped at one year, so
 * we sum two rolling 12-month windows. Returns null on no token / no username /
 * failure (caller treats null as "unknown").
 *
 * This is the "good GitHub profile" signal — genuine, recent commit activity —
 * not just repo count.
 */
export async function getGithubContributions(profileUrl: string): Promise<number | null> {
  const token = githubToken();
  if (!token) return null;
  const username = parseGithubUser(profileUrl);
  if (!username) return null;

  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(now.getFullYear() - 2);

  const windowCommits = async (from: Date, to: Date): Promise<number> => {
    const query = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){totalCommitContributions restrictedContributionsCount}}}`;
    const init: RequestInit = {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ query, variables: { login: username, from: from.toISOString(), to: to.toISOString() } }),
    };
    // One retry with more time on a timeout / network error (cold connections at the
    // start of a batch) — a dropped call would otherwise fail a commits gate.
    let res: Response;
    try {
      res = await fetchWithTimeout("https://api.github.com/graphql", init);
    } catch {
      res = await fetchWithTimeout("https://api.github.com/graphql", init, 15_000);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: { user?: { contributionsCollection?: { totalCommitContributions?: number; restrictedContributionsCount?: number } } };
    };
    const c = data?.data?.user?.contributionsCollection;
    // Public commits + private-but-counted contributions (still "activity").
    return (c?.totalCommitContributions ?? 0) + (c?.restrictedContributionsCount ?? 0);
  };

  try {
    const [recent, prior] = await Promise.all([
      windowCommits(oneYearAgo, now),
      windowCommits(twoYearsAgo, oneYearAgo),
    ]);
    return recent + prior;
  } catch (err) {
    console.warn("[coding-stats] github contributions failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Latest domain commit ─────────────────────────────────────────────────────

interface RawCommit {
  author: { login: string } | null;
  commit: { author: { name?: string; date?: string } | null };
}

/** Bot / automation commits aren't the candidate's own work. */
function isBotCommit(c: RawCommit): boolean {
  return /\[bot\]$/i.test(c.author?.login ?? "") || /\[bot\]|dependabot|renovate|github-actions/i.test(c.commit.author?.name ?? "");
}

/**
 * The candidate's newest commit on a repo's default branch. A commit linked to
 * their account counts; so does an UNLINKED author (a git email that isn't on the
 * profile — common with students) since the repo is their own, flagged
 * `linked: false`. Commits linked to other accounts and bot commits are skipped.
 * null on none / empty repo / failure.
 */
async function latestOwnCommit(username: string, repo: RawRepo, token: string): Promise<DomainCommit | null> {
  const commits = async (query: string): Promise<RawCommit[]> => {
    const res = await fetchWithTimeout(`https://api.github.com/repos/${repo.full_name}/commits?${query}`, {
      headers: githubHeaders(token),
    });
    if (!res.ok) return []; // 409 = empty repo; 404 / rate limit degrade to "none"
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as RawCommit[]) : [];
  };
  const toDomainCommit = (c: RawCommit, linked: boolean): DomainCommit | null => {
    const date = c.commit.author?.date;
    return date ? { date, repo: repo.name, repoUrl: repo.html_url, linked } : null;
  };

  try {
    const me = username.toLowerCase();
    const recent = await commits("per_page=30");
    for (const c of recent) {
      if (isBotCommit(c)) continue;
      const login = c.author?.login?.toLowerCase();
      if (login === me) return toDomainCommit(c, true);
      if (!login) return toDomainCommit(c, false);
    }
    // A full page with nothing of theirs (collaborators / bot flood) — ask for theirs directly.
    if (recent.length < 30) return null;
    const [own] = await commits(`author=${encodeURIComponent(username)}&per_page=1`);
    return own ? toDomainCommit(own, true) : null;
  } catch (err) {
    console.warn(`[coding-stats] commits for ${repo.full_name} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Most repos a single candidate's commit lookup will open (≤2 requests each). */
const COMMIT_LOOKUP_CAP = 6;

/**
 * Newest commit by the candidate across the JD-matching repos. Repos are walked
 * most-recently-pushed first, and a repo's commits can't be newer than its last
 * push — so the walk stops as soon as no remaining repo could beat the best
 * found, which is usually after the first one.
 */
async function latestDomainCommit(username: string, repos: RawRepo[], token: string): Promise<DomainCommit | null> {
  const pushed = (r: RawRepo) => Date.parse(r.pushed_at ?? "") || 0;
  const ordered = [...repos].sort((a, b) => pushed(b) - pushed(a));
  let best: DomainCommit | null = null;
  for (let i = 0; i < ordered.length; i++) {
    if (best && pushed(ordered[i]) <= Date.parse(best.date)) break;
    if (i === COMMIT_LOOKUP_CAP) {
      console.warn(`[coding-stats] last domain commit for ${username}: stopped after ${COMMIT_LOOKUP_CAP} of ${ordered.length} matching repos`);
      break;
    }
    const commit = await latestOwnCommit(username, ordered[i], token);
    if (commit && (!best || Date.parse(commit.date) > Date.parse(best.date))) best = commit;
  }
  return best;
}

// ── JD term extraction ───────────────────────────────────────────────────────

/**
 * Skill aliases: when any spelling in a group appears in the JD, every spelling
 * becomes a term — so "js" matches "javascript" repos and "Deep Learning" matches
 * a "pytorch" repo. Multi-word entries match as whole two-word phrases.
 */
const ALIASES: Record<string, string[]> = {
  javascript: ["js", "node", "nodejs", "node.js"],
  typescript: ["ts"],
  python: ["py", "django", "flask", "fastapi"],
  "c++": ["cpp", "cplusplus"],
  "c#": ["csharp", "dotnet", ".net"],
  golang: ["go"],
  react: ["reactjs", "react.js", "nextjs", "next.js"],
  ai: ["artificial intelligence"],
  "machine learning": ["ml", "scikit-learn", "sklearn", "xgboost"],
  "deep learning": ["neural network", "cnn", "rnn", "lstm", "pytorch", "tensorflow", "keras"],
  pytorch: ["torch"],
  nlp: ["natural language", "bert", "transformer", "sentiment analysis", "text classification", "chatbot"],
  "computer vision": ["cv", "opencv", "yolo", "image classification", "object detection", "image processing"],
  llm: ["large language", "language model", "gpt", "llama", "langchain", "rag", "openai"],
  "hugging face": ["huggingface", "transformer"],
  "data science": ["pandas", "numpy", "data analysis", "matplotlib"],
};

/** Words that say nothing about a domain — never terms. */
const NOISE = new Set(
  (
    "a an and the or of in on at to for with by from as is are be been if it its this that these those into via " +
    "we our my you your i me us they their he she his her them also more other such like etc eg e.g including plus " +
    "can will should must may have has having use used uses using build built building develop developing developed " +
    "work working worked engineer engineers developer developers experience experienced skill skills knowledge " +
    "understanding ability hands exposure good great strong solid excellent basic advanced proficiency proficient " +
    "familiarity familiar required requirement requirements preferred related relevant real result results " +
    "measurable trained intern interned internship team teams role candidate candidates level what makes fit tool " +
    "tools topic topics any all some each well who how why when where which"
  ).split(" "),
);

/**
 * Real domain words too generic to prove relevance ALONE ("learning-react",
 * "data-model", "cloud-notes") — they only count inside a phrase from the JD
 * such as "deep learning", "time series" or "cloud platform".
 */
const WEAK = new Set(
  (
    "learn learning model models train training fine tuning tuned deep face data app apps application applications " +
    "web website project projects system systems based time series vision computer language natural processing " +
    "machine science analysis analytics design development engineering management network networks image images " +
    "text video audio classification detection recognition prediction generation cloud platform platforms full " +
    "stack front back end mobile open source big"
  ).split(" "),
);

/** Lowercase words of free text; dots stay inside words ("node.js") but not at the end. */
function wordsOf(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/\.+$/, ""))
    .filter(Boolean);
}

/** Crude plural fold so "CNNs" meets "cnn" and "transformers" meets "transformer". */
function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** A JD term in matchable form: stemmed words, space-joined ("scikit-learn" → "scikit learn"). */
function normalizeTerm(term: string): string {
  return wordsOf(term).map(stem).join(" ");
}

/**
 * Build the JD term set from the criteria text (skills + JD): whole words that
 * aren't noise or too generic, plus two-word phrases around generic words
 * ("deep learning", "fine tuning"), expanded with aliases. Phrases never cross
 * punctuation, so "NLP, CV, model training" can't yield "cv model".
 */
export function buildJdTerms(text: string): string[] {
  const terms = new Set<string>();
  const isNoise = (w: string) => NOISE.has(w) || NOISE.has(stem(w));
  const isWeak = (w: string) => WEAK.has(w) || WEAK.has(stem(w));
  for (const segment of (text ?? "").split(/[,;:/|()[\]{}\n—–&]+|\.(?=\s|$)/)) {
    const words = wordsOf(segment).filter((w) => w.length >= 2);
    words.forEach((w, i) => {
      if (!isNoise(w) && !isWeak(w)) terms.add(stem(w));
      const prev = words[i - 1];
      if (prev && (isWeak(prev) || isWeak(w)) && !isNoise(prev) && !isNoise(w)) terms.add(`${stem(prev)} ${stem(w)}`);
    });
  }
  for (const [canonical, alts] of Object.entries(ALIASES)) {
    const group = [canonical, ...alts].map(normalizeTerm);
    if (group.some((t) => terms.has(t))) group.forEach((t) => terms.add(t));
  }
  return [...terms];
}

/** Whether the JD/skills signal a DSA / problem-solving emphasis. */
export function jdNeedsDsa(text: string): boolean {
  return /\b(dsa|data structures?|algorithms?|problem[ -]?solving|competitive programming|leetcode|codeforces|codechef)\b/i.test(
    text,
  );
}
