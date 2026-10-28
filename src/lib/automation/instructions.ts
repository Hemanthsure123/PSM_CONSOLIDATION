import { NO_DSA_GATES, type DsaGates } from "@/lib/dsa-scoring";
import type { GithubScopeChoice, ParsedInstructions } from "@/lib/automation/types";

/**
 * Reading the "Screening Instructions" cell — deterministic, no model (tested in
 * scripts/automation-selftest.ts). The cell is free text, one item per line (or separated by
 * "->", "→" or "|"), labels optional:
 *
 *   Subsheets: Edge Applied, Academy Applied
 *   Focus: Flutter developers who shipped apps; Firebase is a must
 *   GitHub: (domain-fit candidates)            ← or (all candidates) / no
 *   DSA: yes                                   ← or no / CF 1400 / 300 solved
 *   Top: 10                                    ← optional; else the row's "No. of Profiles Required"
 *
 * Unlabeled lines are matched against the real tab names (by the planner), and anything else
 * is the focus text. Instructions are data: nothing in them is executed or sent anywhere but the
 * scoring model, which treats them as untrusted.
 */

const SEP = /\r?\n|\s+(?:->|→|=>)\s+|\s+\|\s+/;
const BULLET = /^\s*(?:[-*•●▪➤→>]+|\d{1,2}[.)])\s*/;
const LABEL_SEP = String.raw`\s*(?:[:=]|[-–—](?=\s))\s*`;

const LABELS: { key: "tabs" | "focus" | "github" | "dsa" | "top" | "sheet"; re: RegExp }[] = [
  // A spreadsheet link first, so "Sheet: <link>" isn't read as a tab list.
  { key: "sheet", re: /^(?:sheet|spreadsheet|source\s*sheet|internal\s*sheets?)\s*[:=\-–—]\s*(https?:\/\/docs\.google\.com\/spreadsheets\S+)/i },
  { key: "tabs", re: new RegExp(String.raw`^(?:sub\s*-?\s*sheets?|sheets?\s*(?:names?|to\s*screen)?|tabs?(?:\s*names?)?|source(?:\s*tabs?)?|screen\s*tabs?)${LABEL_SEP}(.+)$`, "i") },
  { key: "focus", re: new RegExp(String.raw`^(?:focus(?:\s*on)?|prompt|screening\s*prompt|screen\s*for|criteria|looking\s*for|requirements?|role|domain|what\s*to\s*look\s*for)${LABEL_SEP}(.+)$`, "i") },
  { key: "github", re: /^(?:git\s*hub)(?:\s*inspection|\s*screening|\s*check)?\s*[:=\-–—]?\s*(.*)$/i },
  { key: "dsa", re: /^(?:dsa|coding\s*profiles?|competitive\s*programming)(?:\s*screening|\s*check)?\s*[:=\-–—]?\s*(.*)$/i },
  { key: "top", re: /^(?:top|shortlist(?:\s*count)?|profiles?(?:\s*required)?)\s*[:=\-–—]?\s*(\d{1,3})\s*(?:profiles?|candidates?)?\s*$/i },
];

const OFF = /\b(?:no|off|skip|none|false|disable[d]?|not\s+needed|don'?t)\b/i;
const SHEET_URL = /https?:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s]*/i;

/** "(all candidates)" / "(domain-fit candidates only)" / "no" → the GitHub scope. */
export function githubScopeOf(text: string): GithubScopeChoice {
  const t = text.toLowerCase();
  if (OFF.test(t) && !/\(.*\)/.test(t)) return "off";
  if (/\ball\b/.test(t)) return "all";
  return "fit";
}

/** "DSA: CF 1400 or CC 1600, 300 solved, 10 contests, DSA score 50" → gates (0 = none). */
export function dsaGatesOf(text: string): DsaGates {
  const g: DsaGates = { ...NO_DSA_GATES, minRating: { ...NO_DSA_GATES.minRating } };
  const t = text.replace(/,(?=\d{3}\b)/g, "");
  const num = (m: RegExpMatchArray | null) => (m ? Number(m.slice(1).find((x) => x !== undefined)) : 0);
  g.minSolved = num(t.match(/(\d{2,5})\s*\+?\s*(?:problems?\s*|questions?\s*)?solved|solved\D{0,8}(\d{2,5})/i));
  g.minContests = num(t.match(/(\d{1,4})\s*\+?\s*(?:rated\s*)?contests?|contests?\D{0,8}(\d{1,4})/i));
  g.minScore = num(t.match(/dsa\s*score\D{0,6}(\d{1,3})/i));
  const rating = (re: RegExp) => {
    const m = t.match(re);
    return m && !/^\s*\+?\s*(?:problems?|questions?|solved|contests?)/i.test(t.slice((m.index ?? 0) + m[0].length)) ? Number(m[1]) : 0;
  };
  g.minRating.codeforces = rating(/\b(?:cf|codeforces)\b\D{0,10}?(\d{3,4})\b/i);
  g.minRating.codechef = rating(/\b(?:cc|codechef)\b\D{0,10}?(\d{3,4})\b/i);
  g.minRating.leetcode = rating(/\b(?:lc|leetcode)\b\s*(?:rating)?\D{0,8}?(\d{4})\b/i);
  return g;
}

/** Split the cell into items and read each one. */
export function parseInstructions(cell: string): ParsedInstructions {
  const out: ParsedInstructions = {
    tabs: [],
    unlabeled: [],
    focus: "",
    github: "fit",
    githubExplicit: false,
    review: null,
    dsa: { use: false, explicit: false, gates: { ...NO_DSA_GATES, minRating: { ...NO_DSA_GATES.minRating } } },
    topN: null,
    sheetUrl: null,
  };
  const focus: string[] = [];
  const items = (cell ?? "")
    .split(SEP)
    .map((s) => s.replace(BULLET, "").trim())
    .filter(Boolean);
  for (const item of items) {
    const sheet = item.match(SHEET_URL);
    const hit = LABELS.map((l) => ({ key: l.key, m: item.match(l.re) })).find((x) => x.m);
    if (!hit) {
      if (sheet && item.replace(SHEET_URL, "").trim().length < 3) out.sheetUrl ??= sheet[0];
      else out.unlabeled.push(item);
      continue;
    }
    const value = (hit.m![1] ?? "").trim();
    switch (hit.key) {
      case "tabs":
        out.tabs.push(...splitTabList(value));
        break;
      case "focus":
        focus.push(value);
        break;
      case "github":
        out.github = githubScopeOf(value || "yes");
        out.githubExplicit = true;
        if (/\b(?:no|off|skip|without)\s*(?:code\s*)?review\b/i.test(value)) out.review = false;
        else if (/\bcode\s*review\b|\breview\b/i.test(value) && !OFF.test(value.replace(/\(.*?\)/g, ""))) out.review = true;
        break;
      case "dsa":
        out.dsa.explicit = true;
        out.dsa.use = !(OFF.test(value) && !/\d/.test(value));
        if (out.dsa.use) out.dsa.gates = dsaGatesOf(value);
        break;
      case "top":
        out.topN = clampTop(Number(hit.m![1]));
        break;
      case "sheet":
        out.sheetUrl = sheet?.[0] ?? null;
        break;
    }
  }
  // Unlabeled lines naming GitHub or DSA are those settings; the rest wait for the tab check.
  out.unlabeled = out.unlabeled.filter((line) => {
    if (/git\s*hub/i.test(line) && !out.githubExplicit) {
      out.github = githubScopeOf(line.replace(/git\s*hub(\s*inspection)?/i, "") || "yes");
      out.githubExplicit = true;
      return false;
    }
    if (/\bdsa\b|leetcode|codeforces|codechef/i.test(line) && !out.dsa.explicit && line.length < 120) {
      out.dsa.explicit = true;
      out.dsa.use = !(OFF.test(line) && !/\d/.test(line));
      if (out.dsa.use) out.dsa.gates = dsaGatesOf(line);
      return false;
    }
    return true;
  });
  out.focus = focus.join("\n");
  return out;
}

/** "Edge Applied, Academy Applied" or "'Edge Applied'; 'EDGE 2.0 '" → names. */
export function splitTabList(value: string): string[] {
  // Quoted names keep their exact text (commas, trailing spaces); the rest is split on , ; & and.
  const QUOTED = /["“”'‘’]([^"“”'‘’]+)["“”'‘’]/g;
  const quoted = [...value.matchAll(QUOTED)].map((m) => m[1]).filter((n) => n.trim());
  const rest = value
    .replace(QUOTED, ",")
    .split(/\s*[,;]\s*|\s+&\s+|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...quoted, ...rest];
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export const clampTop = (n: number): number | null => (Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 500) : null);

/**
 * The tabs to screen, matched against the spreadsheet's real tabs (case and spacing ignored).
 * Without a "Subsheets:" label, the first unlabeled line whose every name is a real tab is the
 * list. Unmatched names come back with the closest real names.
 */
export function resolveTabs(
  parsed: ParsedInstructions,
  available: string[],
): { tabs: string[]; unknown: { name: string; suggestions: string[] }[]; focus: string } {
  const byNorm = new Map(available.map((t) => [norm(t), t]));
  let wanted = parsed.tabs;
  let rest = parsed.unlabeled;
  if (!wanted.length) {
    const i = rest.findIndex((line) => {
      const names = splitTabList(line);
      return names.length > 0 && names.every((n) => byNorm.has(norm(n)));
    });
    if (i >= 0) {
      wanted = splitTabList(rest[i]);
      rest = rest.filter((_, j) => j !== i);
    }
  }
  const tabs: string[] = [];
  const unknown: { name: string; suggestions: string[] }[] = [];
  for (const name of wanted) {
    const real = byNorm.get(norm(name));
    if (real) {
      if (!tabs.includes(real)) tabs.push(real);
      continue;
    }
    const n = norm(name);
    const words = n.split(" ").filter((w) => w.length > 2);
    const suggestions = available
      .map((t) => ({ t, score: words.filter((w) => norm(t).includes(w)).length + (norm(t).includes(n) || n.includes(norm(t)) ? 2 : 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.t);
    unknown.push({ name, suggestions });
  }
  const focus = [parsed.focus, ...rest].filter(Boolean).join("\n").trim();
  return { tabs, unknown, focus };
}

/** "No. of Profiles Required": "10", "8-10", "10+" → 10; blank or text → null. */
export function profilesRequiredOf(raw: string): number | null {
  const m = String(raw ?? "").match(/\d{1,3}/g);
  if (!m) return null;
  return clampTop(Math.max(...m.map(Number)));
}

/** The calendar date in India (YYYY-MM-DD) — the destination tab's date. */
export function istDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Where a job's shortlist goes, in the candidates' spreadsheet. */
export const destinationTabName = (runDate: string) => `psm_final_shortlisted_${runDate}`;
