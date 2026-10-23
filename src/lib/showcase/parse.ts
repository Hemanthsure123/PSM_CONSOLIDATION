import { columnLabels, detectHeaderRow, type AcGrid } from "@/lib/academy/parse";
import type { SpCandidate, SpDataset } from "@/lib/showcase/types";

/**
 * Sample profiles — one sheet tab into candidate rows. The header row is found (not assumed),
 * columns are recognised by their header (name, email, mobile, resume, GitHub / LeetCode /
 * Codeforces / CodeChef, college, degree, year), the resume column falls back to the column with
 * the most document links. Rows are de-duplicated by email, then mobile. Pure.
 */

const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const mobileKey = (v: string) => v.replace(/\D/g, "").slice(-10);
const isUrl = (v: string) => /^https?:\/\//i.test(v);

type Field = keyof SpDataset["detected"];

const HEADERS: [Field, RegExp, RegExp?][] = [
  ["name", /^(full\s*)?name$|student\s*name|candidate\s*name|^name\b/i, /parent|father|mother|college|company|guardian/i],
  ["email", /e-?mail/i, /parent|college/i],
  ["mobile", /mobile|phone|contact|whats\s*app|^number$/i, /parent|father|mother|guardian|emergency/i],
  ["resume", /resume|\bcv\b|bio-?data/i],
  ["github", /git\s*hub/i],
  ["leetcode", /leet\s*code/i],
  ["codeforces", /code\s*forces|^cf\b|cf\s*handle/i],
  ["codechef", /code\s*chef|^cc\b|cc\s*handle/i],
  ["college", /college|university|institut/i],
  ["degree", /degree|branch|department|stream|^course/i],
  ["yog", /\byog\b|year of (?:passing|graduation)|graduation year|pass\s*out|passing year|^batch$/i],
];

const DOC_LINK = /drive\.google|docs\.google|\.pdf\b|resume|\bcv\b|s3\.|amazonaws|dropbox|onedrive/i;

export function buildSpDataset(src: { url: string; title: string; tab: AcGrid }, loadedAt = new Date().toISOString()): SpDataset {
  const g = src.tab.values;
  const hr = detectHeaderRow(g);
  const { base, labels } = columnLabels(g, hr);
  const rows = g.slice(hr + 1).map((r) => r ?? []);
  const warnings: string[] = [];
  const col: Record<Field, number> = { name: -1, email: -1, mobile: -1, resume: -1, github: -1, leetcode: -1, codeforces: -1, codechef: -1, college: -1, degree: -1, yog: -1 };
  for (const [field, re, not] of HEADERS) col[field] = base.findIndex((h) => re.test(h) && !(not && not.test(h)));
  if (col.resume < 0) {
    // No "Resume" header: the column holding the most document links.
    let best = -1;
    let bestCount = 0;
    for (let i = 0; i < base.length; i++) {
      const n = rows.filter((r) => isUrl(norm(r[i])) && DOC_LINK.test(norm(r[i]))).length;
      if (n > bestCount) {
        bestCount = n;
        best = i;
      }
    }
    if (best >= 0 && bestCount >= Math.max(3, rows.length * 0.2)) col.resume = best;
  }
  if (col.resume < 0) warnings.push("No resume column found — name it \"Resume\" or put the resume links in one column.");
  if (col.email < 0 && col.mobile < 0) warnings.push("No email or mobile column — candidates are keyed by row number.");

  const cell = (r: string[], i: number) => (i >= 0 ? norm(r[i]) : "");
  const seen = new Set<string>();
  let dupes = 0;
  const candidates: SpCandidate[] = [];
  rows.forEach((r, idx) => {
    if (!r.some((c) => norm(c))) return;
    const email = cell(r, col.email).toLowerCase();
    const mobile = mobileKey(cell(r, col.mobile));
    const id = (email.includes("@") ? email : "") || (mobile.length === 10 ? mobile : "") || `row-${hr + 2 + idx}`;
    if (seen.has(id) || (mobile.length === 10 && seen.has(`m:${mobile}`))) {
      dupes++;
      return;
    }
    seen.add(id);
    if (mobile.length === 10) seen.add(`m:${mobile}`);
    const values: Record<string, string> = {};
    labels.forEach((label, i) => {
      values[label] = cell(r, i);
    });
    const link = (i: number) => {
      const v = cell(r, i);
      return v && !/^(na|n\/a|nil|none|-+)$/i.test(v) ? v : "";
    };
    candidates.push({
      id,
      sheetRow: hr + 2 + idx,
      name: cell(r, col.name),
      email,
      mobile: cell(r, col.mobile),
      resumeUrl: isUrl(cell(r, col.resume)) ? cell(r, col.resume) : "",
      sheetLinks: { github: link(col.github), leetcode: link(col.leetcode), codeforces: link(col.codeforces), codechef: link(col.codechef) },
      college: cell(r, col.college),
      degree: cell(r, col.degree),
      yog: cell(r, col.yog),
      values,
    });
  });
  if (dupes) warnings.push(`${dupes} repeated row${dupes === 1 ? "" : "s"} (same email or mobile) skipped.`);

  const detected = Object.fromEntries((Object.keys(col) as Field[]).map((f) => [f, col[f] >= 0 ? labels[col[f]] : ""])) as SpDataset["detected"];
  return { loadedAt, source: { url: src.url, title: src.title, tab: src.tab.name }, columns: labels, detected, candidates, warnings };
}

/** The tab with the most resume links (the one to screen), else the first. */
export function pickCandidateTab(tabs: { name: string; rows: string[][] }[]): string {
  let best = tabs[0]?.name ?? "";
  let bestScore = -1;
  for (const t of tabs) {
    const hr = detectHeaderRow(t.rows);
    const header = (t.rows[hr] ?? []).map(norm);
    const score = (header.some((h) => /resume|\bcv\b/i.test(h)) ? 10 : 0) + (header.some((h) => /e-?mail|mobile|phone/i.test(h)) ? 5 : 0) + header.filter(Boolean).length / 100;
    if (score > bestScore) {
      bestScore = score;
      best = t.name;
    }
  }
  return best;
}
