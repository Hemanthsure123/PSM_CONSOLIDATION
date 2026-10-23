import { bestRating } from "@/lib/dsa-scoring";
import type { DsaPlatform } from "@/lib/dsa-types";
import type { SpDsa, SpDsaBar, SpDsaIdentity, SpDsaPlatform, SpLinks } from "@/lib/showcase/types";

/**
 * Sample profiles — the DSA bar (pure). A candidate clears it on ANY one platform:
 * Codeforces ≥ bar, or CodeChef ≥ bar, or LeetCode contest rating ≥ bar with enough solved —
 * each with a minimum of rated contests, so one lucky contest can't pass. Codeforces and CodeChef
 * use the highest rating; LeetCode exposes only the current one. A profile whose owner is clearly
 * someone else, or a handle that sits on two rows of the sheet, counts for nobody.
 */

export const DSA_ORDER: DsaPlatform[] = ["codeforces", "leetcode", "codechef"];
export const DSA_NAME: Record<DsaPlatform, string> = { leetcode: "LeetCode", codeforces: "Codeforces", codechef: "CodeChef" };
/** Ratings that earn full DSA points (between the bar and these, points rise linearly). */
const DSA_CEILING: Record<DsaPlatform, number> = { codeforces: 1900, codechef: 2100, leetcode: 2200 };

const ratingOf = (key: DsaPlatform, p: SpDsaPlatform | undefined) => (key === "leetcode" ? (p?.rating ?? null) : bestRating(p));
const barOf = (key: DsaPlatform, bar: SpDsaBar) => (key === "codeforces" ? bar.codeforces : key === "codechef" ? bar.codechef : bar.leetcode);

/** Does this one platform clear the bar? (Identity and shared handles are judged separately.) */
export function clearsBar(key: DsaPlatform, p: SpDsaPlatform | undefined, bar: SpDsaBar): boolean {
  if (!p || p.found !== true) return false;
  const r = ratingOf(key, p);
  if (r === null || r < barOf(key, bar)) return false;
  if ((p.contests ?? 0) < bar.minContests) return false;
  if (key === "leetcode" && (p.solved ?? 0) < bar.leetcodeSolved) return false;
  return true;
}

/** "CF 1620 (max) · 14 contests" for one platform. */
export function platformLine(key: DsaPlatform, p: SpDsaPlatform | undefined): string {
  if (!p?.url) return "";
  if (p.found === false) return `${DSA_NAME[key]}: profile not found`;
  if (p.found !== true) return `${DSA_NAME[key]}: couldn't read (${p.note || "unknown"})`;
  const r = ratingOf(key, p);
  const bits = [
    r !== null ? `${key === "leetcode" ? "rating" : "max rating"} ${r}` : "unrated",
    typeof p.contests === "number" ? `${p.contests} contests` : "",
    typeof p.solved === "number" ? `${p.solved} solved` : "",
  ].filter(Boolean);
  return `${DSA_NAME[key]} ${bits.join(" · ")}`;
}

const words = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3);

/**
 * Is the profile's owner this candidate? Confirmed when its name shares a name word with the
 * sheet / resume name or it links the candidate's GitHub; mismatch when it shows a name with no
 * word in common; unconfirmed when it shows none.
 */
export function dsaIdentity(p: SpDsaPlatform | undefined, names: string[], githubLogin: string): { identity: SpDsaIdentity; note: string } {
  if (!p || p.found !== true) return { identity: "unconfirmed", note: "" };
  const gh = (p as { ownerGithub?: string }).ownerGithub ?? "";
  if (githubLogin && gh && gh.toLowerCase().replace(/\/+$/, "").endsWith(`/${githubLogin.toLowerCase()}`)) {
    return { identity: "confirmed", note: "profile links their GitHub" };
  }
  const owner = (p.ownerName ?? "").trim();
  if (!owner) return { identity: "unconfirmed", note: "profile shows no name" };
  const mine = new Set(names.flatMap(words));
  const theirs = words(owner);
  if (!theirs.length || !mine.size) return { identity: "unconfirmed", note: "" };
  if (theirs.some((w) => mine.has(w))) return { identity: "confirmed", note: "profile name matches" };
  // A handle-like display name ("coder_99") says nothing either way.
  if (theirs.join("") === (p.handle ?? "").toLowerCase().replace(/[^a-z]/g, "")) return { identity: "unconfirmed", note: "profile name is the handle" };
  return { identity: "mismatch", note: `profile name "${owner}" doesn't match` };
}

export interface DsaVerdict {
  passed: boolean;
  /** The platform that clears the bar (the strongest when several do). */
  by: DsaPlatform | null;
  /** All platforms read, one line each. */
  lines: string[];
  /** Why it doesn't pass, when it doesn't. */
  reason: string;
  /** 0-1 strength relative to the bar (bar = 0.4, ceiling ratings = 1). */
  strength: number;
  identity: SpDsaIdentity | "";
}

/**
 * The candidate's DSA against the bar. `shared` = handles that appear on more than one row of
 * the sheet ("platform:handle", lower-case) — they count for nobody.
 */
export function dsaVerdict(dsa: SpDsa, bar: SpDsaBar, names: string[], githubLogin: string, shared: Set<string>): DsaVerdict {
  const lines: string[] = [];
  let best: { key: DsaPlatform; strength: number; identity: SpDsaIdentity } | null = null;
  const blocked: string[] = [];
  for (const key of DSA_ORDER) {
    const p = dsa[key];
    if (!p?.url) continue;
    const line = platformLine(key, p);
    if (line) lines.push(line);
    if (!clearsBar(key, p, bar)) continue;
    const id = p.identity ?? dsaIdentity(p, names, githubLogin).identity;
    if (id === "mismatch") {
      blocked.push(`${DSA_NAME[key]} profile belongs to someone else (${p.identityNote || "name differs"})`);
      continue;
    }
    if (shared.has(`${key}:${(p.handle ?? "").toLowerCase()}`)) {
      blocked.push(`${DSA_NAME[key]} handle ${p.handle} is on more than one row`);
      continue;
    }
    const r = ratingOf(key, p)!;
    const strength = Math.min(1, 0.4 + 0.6 * Math.max(0, (r - barOf(key, bar)) / Math.max(1, DSA_CEILING[key] - barOf(key, bar))));
    if (!best || strength > best.strength) best = { key, strength, identity: id };
  }
  if (best) return { passed: true, by: best.key, lines, reason: "", strength: best.strength, identity: best.identity };
  const linked = DSA_ORDER.filter((k) => dsa[k]?.url);
  const reason = blocked.length
    ? blocked.join("; ")
    : !linked.length
      ? "No LeetCode / Codeforces / CodeChef profile link"
      : `DSA below the bar (${lines.join("; ") || "profiles couldn't be read"}) — needs CF ≥ ${bar.codeforces}, CC ≥ ${bar.codechef} or LC ≥ ${bar.leetcode} with ${bar.leetcodeSolved}+ solved, ${bar.minContests}+ contests`;
  return { passed: false, by: null, lines, reason, strength: 0, identity: "" };
}

/**
 * The next platform to read for the bar — Codeforces (batched, fast), LeetCode, then CodeChef (1
 * request / 5 s) — or null when the bar is cleared or nothing is left to read. Only platforms not
 * read yet are scheduled, so changing the bar re-reads nothing that is known.
 */
export function nextDsaPlatform(links: Pick<SpLinks, DsaPlatform>, dsa: SpDsa, bar: SpDsaBar): DsaPlatform | null {
  if (DSA_ORDER.some((k) => clearsBar(k, dsa[k], bar))) return null;
  for (const k of DSA_ORDER) if (links[k] && !dsa[k]) return k;
  return null;
}

/** The handle in a profile URL (lower-case; "" when none) — a browser-side copy of the server parsers. */
export function handleOf(key: DsaPlatform, url: string): string {
  const u = (url ?? "").trim();
  const m =
    key === "leetcode"
      ? (u.match(/leetcode\.com\/u\/([^/?#]+)/i) ?? u.match(/leetcode\.com\/(?!problems|contest|discuss|explore|problemset)([^/?#]+)\/?(?:[?#]|$)/i))
      : key === "codeforces"
        ? u.match(/codeforces\.com\/(?:profile|submissions|contests\/with)\/([^/?#\s]+)/i)
        : u.match(/codechef\.com\/users\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

/** Platform + handle keys that sit on more than one row. */
export function sharedHandles(rows: { links: Pick<SpLinks, DsaPlatform> }[]): Set<string> {
  const count = new Map<string, number>();
  for (const r of rows) {
    for (const k of DSA_ORDER) {
      const h = r.links[k] ? handleOf(k, r.links[k]) : "";
      if (h) count.set(`${k}:${h}`, (count.get(`${k}:${h}`) ?? 0) + 1);
    }
  }
  return new Set([...count.entries()].filter(([, n]) => n > 1).map(([k]) => k));
}
