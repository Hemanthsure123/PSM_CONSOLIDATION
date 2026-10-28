import "server-only";
import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { fetchResume, type ResumeBytes } from "@/lib/resume";
import { contentFromBytes, looksLikeResume } from "@/lib/resume-content";
import { collectResumeUrls, extractProfileLinksFromResume, toCodeChefUrl, toCodeforcesUrl, toLeetCodeUrl } from "@/lib/resume-links";
import { splitGithub } from "@/lib/domain-screen";
import { techKeysInText } from "@/lib/github-analysis";
import { evidenceText } from "@/lib/resume-sections";
import { FOLDER, resumeInFolder } from "@/lib/resume-folder";
import type { DsaPlatform } from "@/lib/dsa-types";
import { SP_VERSIONS, type SpCandidate, type SpLinks, type SpScreen } from "@/lib/showcase/types";

/**
 * Sample profiles — stage 1 for one row, no model: download the resume, read its text and
 * links (PDF link annotations, URLs in the text, handles written as "LeetCode: ravi_07"), add
 * the sheet's own GitHub / DSA columns, and fingerprint the file. Never throws.
 */

const asText = (text: string): ResumeBytes => ({ data: Buffer.from(text, "utf8"), mimeType: "text/plain" });

/** Words after "LeetCode:" that are badges / numbers, not handles. */
const NOT_A_HANDLE =
  /^(knight|guardian|rating|ratings|rated|rank|ranked|ranking|max|maximum|peak|highest|best|current|top|solved|problems?|questions?|contests?|profile|link|badge|badges|stars?|expert|pupil|specialist|master|newbie|candidate|global|india|div|division|level|streak|days?|achieved|achievements?|with|and|the|over|more|than|participated|\d+\+?)$/i;

const HANDLE_TEXT: [DsaPlatform, RegExp, (h: string) => string][] = [
  ["leetcode", /leet\s*code\s*(?:id|handle|user\s*name|username|profile)?\s*[:\-–|]\s*@?([A-Za-z][A-Za-z0-9_-]{2,29})\b/i, toLeetCodeUrl],
  ["codeforces", /code\s*forces\s*(?:id|handle|user\s*name|username|profile)?\s*[:\-–|]\s*@?([A-Za-z][A-Za-z0-9_.-]{2,23})\b/i, toCodeforcesUrl],
  ["codechef", /code\s*chef\s*(?:id|handle|user\s*name|username|profile)?\s*[:\-–|]\s*@?([A-Za-z][A-Za-z0-9_]{2,23})\b/i, toCodeChefUrl],
];
const NAMED: Record<DsaPlatform, RegExp> = { leetcode: /leet\s*code/i, codeforces: /code\s*forces/i, codechef: /code\s*chef/i };

/** Stable, non-reversible ID shown to companies instead of a name. */
export function candidateIdFor(c: Pick<SpCandidate, "email" | "mobile" | "id">): string {
  const basis = (c.email || c.mobile.replace(/\D/g, "").slice(-10) || c.id).toLowerCase();
  const salt = env.showcase.idSalt || "nxtwave-sample-profiles";
  const h = createHash("sha256").update(`${salt}:${basis}`).digest();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[h[i] % alphabet.length];
  return `NW-${out}`;
}

const empty = (c: SpCandidate, status: SpScreen["status"], error: string, retryable = false): SpScreen => ({
  id: c.id,
  status,
  error,
  retryable,
  resumeUrl: c.resumeUrl,
  sha: "",
  source: "",
  links: { githubProfile: "", githubRepos: [], leetcode: "", codeforces: "", codechef: "", urls: [] },
  namedWithoutLink: [],
  inferred: [],
  fromSheet: [],
  candidateId: candidateIdFor(c),
  version: SP_VERSIONS.screen,
});

export async function screenCandidate(c: SpCandidate): Promise<SpScreen> {
  if (!/^https?:\/\//i.test(c.resumeUrl)) return empty(c, "no-resume", "No resume link in the sheet.");
  try {
    let link = c.resumeUrl.trim();
    if (FOLDER.test(link)) {
      const inside = await resumeInFolder(link);
      if ("error" in inside) return empty(c, "error", inside.error, inside.retryable);
      link = inside.url;
    }
    const fetched = await fetchResume(link);
    if (!fetched.ok) {
      return fetched.transient
        ? empty(c, "error", `Resume download failed temporarily (${fetched.error.slice(0, 80)}) — re-run.`, true)
        : empty(c, "error", "Resume could not be downloaded — not shared with the service account or deleted.");
    }
    const bytes = fetched.bytes;
    const content = await contentFromBytes(bytes);
    if (typeof content === "string") return empty(c, "not-resume", content);
    const sha = createHash("sha256").update(bytes.data).digest("hex");
    const textLayer = looksLikeResume(content.text);
    // A PDF's hidden link annotations come from the file itself; anything else from its text.
    const forLinks: ResumeBytes = content.source === "pdf" ? bytes : asText(content.text);

    const [dsaLinks, urls] = await Promise.all([
      extractProfileLinksFromResume(forLinks, false).catch(() => ({ leetcode: null, codeforces: null, codechef: null })),
      collectResumeUrls(forLinks).catch(() => [] as string[]),
    ]);
    const gh = splitGithub(urls);
    const links: SpLinks = {
      githubProfile: gh.profile,
      githubRepos: gh.repos.slice(0, 25),
      leetcode: dsaLinks.leetcode?.url ?? "",
      codeforces: dsaLinks.codeforces?.url ?? "",
      codechef: dsaLinks.codechef?.url ?? "",
      urls: urls.slice(0, 60),
    };
    const inferred: DsaPlatform[] = [];
    const namedWithoutLink: DsaPlatform[] = [];
    for (const [key, re, toUrl] of HANDLE_TEXT) {
      if (links[key]) continue;
      const m = content.text.match(re);
      if (m && !NOT_A_HANDLE.test(m[1])) {
        const url = toUrl(m[1]);
        if (url) {
          links[key] = url;
          inferred.push(key);
          continue;
        }
      }
      if (NAMED[key].test(content.text)) namedWithoutLink.push(key);
    }
    // The sheet's own columns fill what the resume doesn't link.
    const fromSheet: string[] = [];
    if (!links.githubProfile && c.sheetLinks.github) {
      const s = splitGithub([/^https?:\/\//i.test(c.sheetLinks.github) ? c.sheetLinks.github : `https://github.com/${c.sheetLinks.github.replace(/^@/, "")}`]);
      if (s.profile) {
        links.githubProfile = s.profile;
        fromSheet.push("github");
      }
    }
    const sheetDsa: [DsaPlatform, string, (h: string) => string][] = [
      ["leetcode", c.sheetLinks.leetcode, toLeetCodeUrl],
      ["codeforces", c.sheetLinks.codeforces, toCodeforcesUrl],
      ["codechef", c.sheetLinks.codechef, toCodeChefUrl],
    ];
    for (const [key, v, toUrl] of sheetDsa) {
      if (links[key] || !v) continue;
      const url = toUrl(v);
      if (url) {
        links[key] = url;
        fromSheet.push(key);
        const i = namedWithoutLink.indexOf(key);
        if (i >= 0) namedWithoutLink.splice(i, 1);
      }
    }
    return {
      ...empty(c, textLayer ? "ok" : content.inline ? "needs-ocr" : "not-resume", textLayer ? "" : content.inline ? "No text layer (scanned / image resume)" : "The file has no readable resume text."),
      sha,
      source: content.source,
      links,
      namedWithoutLink,
      inferred,
      fromSheet,
      // What the projects / experience / certifications / achievements name (never the Skills list) — for the profiles' prefilter.
      ...(textLayer ? { evidenceKeys: techKeysInText(evidenceText(content.text).text) } : {}),
    };
  } catch (err) {
    return empty(c, "error", err instanceof Error ? err.message.slice(0, 200) : "Screening failed.", true);
  }
}
