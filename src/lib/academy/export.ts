import { toCsv } from "@/lib/utils";
import type { DsaPlatformResult } from "@/lib/dsa-types";
import { bestRating } from "@/lib/dsa-scoring";
import { summarizeAcademy, SIGNAL_LABEL, type AcRanked } from "@/lib/academy/scoring";
import {
  AC_BUCKETS,
  AC_BUCKET_LABEL,
  AC_BUCKET_SCOPE,
  AC_PLACEMENT_LABEL,
  type AcBucket,
  type AcColumn,
  type AcDataset,
  type AcPlacement,
  type AcRules,
} from "@/lib/academy/types";
import { buildXlsx, type XlsxCell, type XlsxSheet } from "@/lib/academy/xlsx";

/**
 * Academy bucketing exports — one column layout for every tab: the program's
 * decision first (bucket, tag, scores, why), then the evidence (resume items,
 * GitHub repos, DSA), then every column of the three sheets once. A source column
 * that is empty for every candidate is left out, except the ones the team fills
 * in (mentor, tech stack, priority tag); "Tech Stack Based" is filled with the
 * bucket.
 */

export const AC_TABS = ["frontend", "backend", "aiml", "fullstack", "mixed", "needs", "all"] as const;
export type AcTab = (typeof AC_TABS)[number];

export const AC_TAB_LABEL: Record<AcTab, string> = {
  frontend: "Frontend",
  backend: "Backend",
  aiml: "AI-ML",
  fullstack: "Full Stack",
  mixed: "Mixed",
  needs: "Needs evidence",
  all: "All candidates",
};

/** The rows of one tab, in their order. */
export function tabRows(rows: AcRanked[], tab: AcTab): AcRanked[] {
  if (tab === "all") {
    const order = (r: AcRanked) =>
      r.placement ? AC_TABS.indexOf(r.placement) : { "Needs evidence": 5, Pending: 6, "Placed – not bucketed": 7, "Not in active pool": 8, "Not eligible": 9 }[r.status as string] ?? 10;
    return [...rows].sort((a, b) => order(a) - order(b) || a.rank - b.rank || a.candidate.sheetRow - b.candidate.sheetRow);
  }
  if (tab === "needs") return rows.filter((r) => r.status === "Needs evidence" || r.status === "Pending").sort((a, b) => a.candidate.sheetRow - b.candidate.sheetRow);
  return rows.filter((r) => r.placement === tab).sort((a, b) => a.rank - b.rank);
}

const PRIORITY_LABEL = { P1: "P1 · Active, not placed", P2: "P2 · Active, placed", "": "" } as const;

function platformLine(p: DsaPlatformResult | undefined): string {
  if (!p || !p.url) return "";
  if (p.found === false) return `${p.url} — not found`;
  const r = bestRating(p);
  const bits = [p.solved !== null ? `${p.solved} solved` : "solved ?", typeof p.contests === "number" ? `${p.contests} contests` : "", r !== null ? `rating ${r}` : ""].filter(Boolean);
  return `${bits.join(" · ")} — ${p.url}${p.note && p.found !== true ? ` (${p.note})` : ""}`;
}

const label = (b: string) => AC_BUCKET_LABEL[b as AcBucket] ?? (b === "other" ? "Other" : b);

/** The decision + evidence columns, keyed by header. */
function computed(r: AcRanked): Record<string, string> {
  const c = r.candidate;
  const e = r.result;
  const res = r.signals.resume;
  const gh = r.signals.github;
  const bucket = r.placement ? AC_PLACEMENT_LABEL[r.placement] : r.status;
  return {
    "Rank in Bucket": r.rank ? String(r.rank) : "",
    "Academy Bucket": bucket,
    "Mixed Tech Stacks": r.mixedWith.map((b) => `${AC_BUCKET_LABEL[b]} ${r.scores[b]}`).join(" · "),
    "Nudged From": r.nudgedFrom ? AC_BUCKET_LABEL[r.nudgedFrom] : "",
    "Backend Share of Own Web Work (%)": r.backendShare !== null ? String(Math.round(r.backendShare * 100)) : "",
    "Trust Score": r.trust && r.trust.score !== null ? String(r.trust.score) : "",
    "Trust Band": r.trust?.band ?? "",
    "Trust Checks": r.trust ? r.trust.checks.filter((x) => x.points < 0).map((x) => `${x.label} (${x.points}${x.source === "agent" ? ", agent" : ""}): ${x.detail}`).join(" | ") : "",
    "Trust Summary": r.trust?.summary ?? "",
    "Identity Check": e?.identity
      ? `${e.identity.emailFound ? "email ✓" : "email ✗"} · ${e.identity.phoneFound ? "mobile ✓" : "mobile ✗"} · name ${e.identity.nameMatch === null ? "—" : e.identity.nameMatch ? "✓" : "✗"}${e.identity.nameOnResume ? ` (${e.identity.nameOnResume})` : ""}`
      : "",
    Tag: r.tag,
    Priority: PRIORITY_LABEL[r.priority],
    "Bucket Confidence": r.confidence,
    "Priority Score": r.placement ? String(r.priorityScore) : "",
    "Bucket Fit": r.placement ? String(r.fit) : "",
    "Evidence Coverage (%)": r.placement ? String(Math.round(r.coverage * 100)) : "",
    ...Object.fromEntries(AC_BUCKETS.map((b) => [`${AC_BUCKET_LABEL[b]} Score`, r.used.length ? String(r.scores[b]) : ""])),
    "Why This Bucket": r.reasons.join(" | "),
    "Signals Used": r.used.map((k) => SIGNAL_LABEL[k]).join(", "),
    "Eligible Via": c.eligibility.via.join(", "),
    "Assessment Score": String(r.assessment.score),
    "Assessment Basis": r.assessment.basis,
    "DSA Score": String(r.dsa.score),
    "DSA Basis": r.dsa.basis,
    "Suggested Bucket (without resume)": r.suggested ? AC_BUCKET_LABEL[r.suggested] : "",
    "Resume Projects & Experience": res
      ? res.items
          .map((x) => `[${label(x.stack)}] ${x.item.title}${x.item.org ? ` @ ${x.item.org}` : ""} (${x.item.kind}, ${x.item.depth})${x.item.techs.length ? ` — ${x.item.techs.join(", ")}` : ""}`)
          .join(" | ")
      : "",
    "Resume Skills": e?.skills.join(", ") ?? "",
    "Primary Profile": e?.primaryProfile ?? "",
    "Resume Remarks": e?.status === "ok" ? e.remarks : e?.error ?? "",
    "GitHub Profile": e?.github?.profile ?? "",
    "GitHub Status": e?.github ? `${e.github.status}${e.github.note ? ` — ${e.github.note}` : ""}${e.github.fromCache ? " (cached)" : ""}` : "",
    "GitHub Repos by Stack": gh
      ? gh.repos
          .filter((x) => x.points)
          .map((x) => `[${label(x.stack)}] ${x.repo.name} — ${x.repo.techs.join(", ")}${x.repo.aiLikelihood === "high" ? " (AI-written commits)" : ""}`)
          .join(" | ")
      : "",
    "GitHub Proven Technologies": e?.github?.provenTechs.join(", ") ?? "",
    LeetCode: platformLine(e?.dsa?.leetcode),
    Codeforces: platformLine(e?.dsa?.codeforces),
    CodeChef: platformLine(e?.dsa?.codechef),
    "Preference Read As": r.signals.preference ? r.signals.preference.order.map((b) => AC_BUCKET_LABEL[b]).join(", ") : "",
    "Verification Notes": e?.checks.join("; ") ?? "",
    "Model Used": e?.model ?? "",
    "Read At": e?.analyzedAt ?? "",
  };
}

const FIRST = [
  "Rank in Bucket",
  "Academy Bucket",
  "Mixed Tech Stacks",
  "Nudged From",
  "Tag",
  "Priority",
  "Bucket Confidence",
  "Priority Score",
  "Bucket Fit",
  "Evidence Coverage (%)",
  ...AC_BUCKETS.map((b) => `${AC_BUCKET_LABEL[b]} Score`),
  "Why This Bucket",
  "Signals Used",
  "Trust Score",
  "Trust Band",
  "Trust Checks",
  "Trust Summary",
  "Identity Check",
  "Backend Share of Own Web Work (%)",
  "Eligible Via",
  "Assessment Score",
  "Assessment Basis",
  "DSA Score",
  "DSA Basis",
  "Suggested Bucket (without resume)",
  "Resume Projects & Experience",
  "Resume Skills",
  "Primary Profile",
  "Resume Remarks",
  "GitHub Profile",
  "GitHub Status",
  "GitHub Repos by Stack",
  "GitHub Proven Technologies",
  "LeetCode",
  "Codeforces",
  "CodeChef",
  "Preference Read As",
];
const LAST = ["Verification Notes", "Model Used", "Read At"];
/** Source columns kept even when empty — the team fills them in. */
const KEEP_EMPTY = /mentor|tech stack|priority tag/i;
const TECH_STACK_COL = /^tech stack based$/i;
const NUMERIC = new Set(["Rank in Bucket", "Priority Score", "Bucket Fit", "Evidence Coverage (%)", "Trust Score", "Backend Share of Own Web Work (%)", "Assessment Score", "DSA Score", ...AC_BUCKETS.map((b) => `${AC_BUCKET_LABEL[b]} Score`)]);

/** Source columns worth exporting (empty-for-everyone ones dropped). */
export function exportColumns(ds: AcDataset): AcColumn[] {
  const taken = new Set([...FIRST, ...LAST].map((h) => h.toLowerCase()));
  return ds.columns
    .filter((col) => KEEP_EMPTY.test(col.label) || ds.candidates.some((c) => c.values[col.key]))
    .map((col) => (taken.has(col.label.toLowerCase()) ? { ...col, label: `Sheet · ${col.label}` } : col));
}

export function exportHeaders(ds: AcDataset): string[] {
  return [...FIRST, ...exportColumns(ds).map((c) => c.label), ...LAST];
}

export function exportRecord(r: AcRanked, cols: AcColumn[]): Record<string, string> {
  const out = computed(r);
  for (const col of cols) {
    let v = r.candidate.values[col.key] ?? "";
    if (col.source === "s1" && TECH_STACK_COL.test(col.label) && r.placement) {
      v =
        r.placement === "mixed"
          ? `Mixed (${r.mixedWith.map((b) => AC_BUCKET_LABEL[b]).join(" / ")})`
          : `${AC_BUCKET_LABEL[r.placement]}${r.nudgedFrom ? ` (nudged from ${AC_BUCKET_LABEL[r.nudgedFrom]})` : ""}`;
    }
    out[col.label] = v;
  }
  return out;
}

/** Always shown, even when empty in a tab: the decision and the columns the team fills in. */
const ALWAYS = new Set(["Rank in Bucket", "Academy Bucket", "Tag", "Priority"]);

/**
 * One tab's records and columns. A column empty for every row of the tab is left out (a bucket
 * tab doesn't carry another tab's interview columns), except the decision and team columns.
 */
function tabTable(ds: AcDataset, rows: AcRanked[]): { headers: string[]; records: Record<string, string>[] } {
  const cols = exportColumns(ds);
  const records = rows.map((r) => exportRecord(r, cols));
  const headers = exportHeaders(ds).filter((h) => ALWAYS.has(h) || KEEP_EMPTY.test(h) || records.some((rec) => rec[h]));
  return { headers, records };
}

export function buildAcademyCsv(ds: AcDataset, rows: AcRanked[]): string {
  const t = tabTable(ds, rows);
  return "﻿" + toCsv(t.headers, t.records);
}

function toCells(headers: string[], rec: Record<string, string>): XlsxCell[] {
  return headers.map((h) => {
    const v = rec[h] ?? "";
    return NUMERIC.has(h) && v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
  });
}

/** Summary tab: what was read, the rules, the counts, and what each bucket means. */
function summarySheet(title: string, ds: AcDataset, rows: AcRanked[], rules: AcRules): XlsxSheet {
  const s = summarizeAcademy(rows);
  const on = (b: boolean) => (b ? "On" : "Off");
  const lines: [string, string | number][] = [
    ["Run", title],
    ["Generated", new Date().toISOString()],
    ["Sheets loaded", ds.loadedAt],
    ["Sheet 1 (eligibility, pool)", `${ds.sources.s1.title} › ${ds.sources.s1.tabs.join(", ")} — ${ds.sources.s1.url}`],
    ["Sheet 2 (competency interviews)", `${ds.sources.s2.title} › ${ds.sources.s2.tabs.join(", ")} — ${ds.sources.s2.url}`],
    ["Sheet 3 (old process)", `${ds.sources.s3.title} › ${ds.sources.s3.tabs.join(", ")} — ${ds.sources.s3.url}`],
    ["", ""],
    ["Candidates in sheet 1", s.candidates],
    ["Eligible (L3/L4 competency, DSA Offline cleared, or old Bucket A)", s.eligible],
    ["Eligible and Active Pool = Yes (in scope)", s.inScope],
    ["  P1 · Active, not placed", s.p1],
    ["  P2 · Active, placed", s.p2],
    ...AC_BUCKETS.map((b) => [`${AC_BUCKET_LABEL[b]}`, s.byPlacement[b]] as [string, number]),
    ["Mixed (verify over call on priority)", s.byPlacement.mixed],
    ["Needs evidence / pending", s.needsEvidence + s.pending],
    ["Tagged to verify over call", s.toVerify],
    ["Nudged Full Stack → Backend (temporary rebalancing)", rules.nudge.enabled ? s.nudged : "off"],
    ["Trust (high / medium / low / unverified)", rules.trust.enabled ? `${s.trust.High} / ${s.trust.Medium} / ${s.trust.Low} / ${s.trust.Unverified}` : "off"],
    ["Resume links that can't be opened (share them with the service account, then read again)", s.unreadable],
    ["Not in active pool", s.notActive],
    ["Not eligible", s.notEligible],
    ["", ""],
    ["Signals", `Resume ${on(rules.signals.resume)} (weight ${rules.weights.resume}) · GitHub ${on(rules.signals.github)} (${rules.weights.github}) · Competency TR ${on(rules.signals.competency)} (${rules.weights.competency}) · Preference ${on(rules.signals.preference)} (${rules.weights.preference}) · DSA ${on(rules.signals.dsa)} (ranking only)`],
    [
      "Rebalancing (temporary)",
      rules.nudge.enabled
        ? `Full Stack candidates with at least ${rules.nudge.minBackendShare}% backend in their own web work and a Backend score of at least ${rules.nudge.minBackendScore} move to Backend, most backend-leaning first, at most ${rules.nudge.maxMoves || "half the Full Stack − Backend gap"}; low-trust candidates are not moved`
        : "Off",
    ],
    [
      "Trust agent",
      rules.trust.enabled
        ? `On — score 100 minus identity, GitHub authorship, interview integrity and resume-vs-interview checks and the agent's grounded flags; below ${rules.trust.relyAt} the resume and GitHub count at half weight`
        : "Off",
    ],
    ["Mixed rule", `Second bucket within ${rules.mixedMargin} points of the first, both at least ${rules.mixedMinScore}${rules.feBeAsFullStack ? "; Frontend / Backend / Full Stack close together = Full Stack" : ""}`],
    ["Ranking inside a bucket", `P1 before P2, then priority score = fit ${rules.rankWeights.fit} · assessments ${rules.rankWeights.assessment}${rules.signals.dsa ? ` · DSA ${rules.rankWeights.dsa}` : ""} (weighted average; fit × (0.5 + 0.5 × evidence coverage), so a bucket read only from the preference note ranks lower), then old bucket A > B > C > D`],
    ["Placed candidates", rules.includePlaced ? "Bucketed after the not-placed ones (P2)" : "Not bucketed"],
    ["", ""],
    ...AC_BUCKETS.map((b) => [`${AC_BUCKET_LABEL[b]} covers`, AC_BUCKET_SCOPE[b]] as [string, string]),
    ...ds.warnings.map((w) => ["Warning", w] as [string, string]),
  ];
  return { name: "Summary", header: ["Item", "Value"], rows: lines.map(([k, v]) => [k, v]), widths: [58, 120] };
}

/** The workbook: Summary, the five bucket tabs, Needs evidence, All candidates. */
export function buildAcademyWorkbook(title: string, ds: AcDataset, rows: AcRanked[], rules: AcRules): Uint8Array {
  const sheets: XlsxSheet[] = [summarySheet(title, ds, rows, rules)];
  for (const tab of AC_TABS) {
    const t = tabTable(ds, tabRows(rows, tab));
    sheets.push({ name: AC_TAB_LABEL[tab], header: t.headers, rows: t.records.map((rec) => toCells(t.headers, rec)) });
  }
  return buildXlsx(sheets);
}

export function placementOfTab(tab: AcTab): AcPlacement | null {
  return tab === "needs" || tab === "all" ? null : tab;
}
