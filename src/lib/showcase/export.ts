import { toCsv } from "@/lib/utils";
import { buildXlsx, type XlsxCell, type XlsxSheet } from "@/lib/academy/xlsx";
import { DSA_NAME, DSA_ORDER, platformLine } from "@/lib/showcase/dsa-rules";
import { roleLabel } from "@/lib/showcase/roles";
import { dsaHeadline, experienceLine, headline, SP_STAGE_LABEL, type SpOutcome, type SpRanked, type SpRoleFit, type SpRoleProject, type SpRoleTab } from "@/lib/showcase/scoring";
import { REASON_LABEL, inputsInWords, profileRulesInWords } from "@/lib/showcase/profile-rules";
import { SP_SIGNAL_LABEL, type SpDataset, type SpProfileDef, type SpReasonKey, type SpRules } from "@/lib/showcase/types";

/**
 * Sample profiles — the two workbooks. The COMPANY workbook is what a CRM sends to a hiring
 * manager: one tab per role with the top profiles, a Candidate ID instead of a name, and only what
 * the program verified (the resume's own words, DSA numbers, what the code proves); emails, phone
 * numbers and name words are scrubbed from every text, and profile links (which show names) only
 * go in when the run says so. The INTERNAL workbook has the same tabs with the candidate's details,
 * every score part and check, plus near misses and every screened row with where it stopped.
 */

export type SpAudience = "company" | "internal";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+?91[\s-]?)?(?:\d[\s-]?){9}\d\b/g;
const LINK = /\bhttps?:\/\/\S+|\b(?:www\.)?(?:github|linkedin|leetcode|codeforces|codechef)\.com\/\S*/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameWords = (s: string) =>
  (s ?? "")
    .normalize("NFKD")
    .split(/[^A-Za-z]+/)
    .filter((w) => w.length >= 3);

/** Text safe for a company: no email, phone, name words or (unless allowed) profile links. */
export function scrub(text: string, names: string[], keepLinks: boolean): string {
  let t = (text ?? "").replace(EMAIL, "[email]").replace(PHONE, "[phone]");
  if (!keepLinks) t = t.replace(LINK, "[link]");
  for (const w of [...new Set(names.flatMap(nameWords).map((x) => x.toLowerCase()))]) t = t.replace(new RegExp(`\\b${escapeRe(w)}\\b`, "gi"), "[name]");
  return t;
}

const names = (r: SpRanked) => [r.c.name, r.rec.read?.status === "ok" ? r.rec.read.nameOnResume : ""].filter(Boolean);

function projectCells(x: SpRoleProject | undefined, r: SpRanked, audience: SpAudience, rules: SpRules): string[] {
  if (!x) return ["", "", "", "", ""];
  const links = audience === "internal" || rules.companyLinks;
  const clean = (s: string) => (audience === "company" ? scrub(s, names(r), rules.companyLinks) : s);
  const evidence = x.p.signals.map((s) => `${SP_SIGNAL_LABEL[s.type]}: “${clean(s.quote)}”`);
  const proof =
    x.proofStatus === "verified"
      ? `✓ Verified in code — ${x.proof!.ownCommits} own commits over ${x.proof!.activeDays} days${x.proof!.provenTechs.length ? `; code shows ${x.proof!.provenTechs.slice(0, 6).join(", ")}` : ""}${x.proof!.corroborated.length ? `; repo backs: ${x.proof!.corroborated.map((s) => SP_SIGNAL_LABEL[s]).join(", ")}` : ""}`
      : audience === "company"
        ? "Not verified in code"
        : `${x.proofStatus}: ${x.proofWhy}`;
  const repo = x.proof?.repoUrl || x.p.repoUrl;
  return [
    `${clean(x.p.title)}${x.p.quote ? ` — “${clean(x.p.quote)}”` : ""}`,
    x.p.techs.join(", "),
    evidence.join("\n"),
    proof,
    links ? [repo, x.p.demoUrl || x.proof?.homepage || ""].filter(Boolean).join("\n") : "",
  ];
}

const PROJECT_HEADERS = (n: number) => [`Project ${n}`, `Project ${n} stack`, `Project ${n} highlights (resume's words)`, `Project ${n} verification`, `Project ${n} links`];

function dsaLinks(r: SpRanked): string {
  return DSA_ORDER.map((k) => r.dsa?.dsa[k]?.url ?? "").filter(Boolean).join("\n");
}

function fitFor(r: SpRanked, tab: SpRoleTab) {
  return tab.role === "sde" ? r.primary! : (r.fits.find((f) => f.role === tab.role) ?? r.primary!);
}

/** Profiles from JDs: the mandatory items with what proves each (resume words, own code). */
function mandatoryCell(f: SpRoleFit, clean: (s: string) => string): string {
  const j = f.profile?.judgement;
  if (!j?.mandatory.length) return "";
  const code = new Map((f.profile?.mandatoryInCode ?? []).map((m) => [m.item, m]));
  return j.mandatory
    .map((m) => `${m.met ? "✓" : "✗"} ${m.item}${m.met ? ` — “${clean(m.quote)}”` : ` — ${m.why}`}${code.get(m.item)?.ok ? ` · ${code.get(m.item)!.how}` : ""}`)
    .join("\n");
}

/** One role (or profile) tab, for either audience. */
function roleTable(tab: SpRoleTab, audience: SpAudience, rules: SpRules): { header: string[]; rows: XlsxCell[][] } {
  const company = audience === "company";
  const list = company ? tab.shown : tab.rows;
  const byProfile = tab.role.startsWith("profile:");
  const header = [
    "Rank",
    "Candidate ID",
    ...(company ? [] : ["Name", "Email", "Mobile", "Resume", "Sheet row", "Shown to company"]),
    "Tier",
    "Profile score",
    "Headline",
    ...(byProfile ? ["Why this profile fits", "Mandatory — verified", "Good to have found"] : []),
    "Degree",
    "College",
    "Year",
    "DSA",
    ...(company && !rules.companyLinks ? [] : ["DSA profiles"]),
    ...PROJECT_HEADERS(1),
    ...PROJECT_HEADERS(2),
    ...PROJECT_HEADERS(3),
    "Experience",
    "Verified skills",
    ...(company && !rules.companyLinks ? [] : ["GitHub"]),
    byProfile ? "Also fits" : "Also strong for",
    ...(company
      ? []
      : ["Score: projects", "Score: DSA", "Score: experience", "Score: GitHub engineering", ...(byProfile ? ["Score: fit"] : []), "Trust", "Trust checks", "Gates", "Note"]),
  ];
  const rows = list.map((r, i): XlsxCell[] => {
    const f = fitFor(r, tab);
    const read = r.rec.read?.status === "ok" ? r.rec.read : null;
    const clean = (s: string) => (company ? scrub(s, names(r), rules.companyLinks) : s);
    const top = f.projects.slice(0, 3);
    return [
      i + 1,
      r.candidateId,
      ...(company ? [] : [r.c.name, r.c.email, r.c.mobile, r.c.resumeUrl, r.c.sheetRow, tab.shown.includes(r) ? "Yes" : "No (beyond top N)"]),
      f.tier || r.tier,
      f.score,
      clean(tab.role === "sde" ? `SDE · ${headline(r)}` : headline(r, f)),
      ...(byProfile
        ? [clean(f.profile?.judgement?.evidence ?? ""), mandatoryCell(f, clean), (f.profile?.judgement?.goodToHave ?? []).map((g) => g.item).join(", ")]
        : []),
      read?.education.degree || r.c.degree,
      read?.education.institution || r.c.college,
      read?.education.year || r.c.yog,
      r.dsa?.lines.join("\n") ?? "",
      ...(company && !rules.companyLinks ? [] : [dsaLinks(r)]),
      ...projectCells(top[0], r, audience, rules),
      ...projectCells(top[1], r, audience, rules),
      ...projectCells(top[2], r, audience, rules),
      clean(experienceLine(r)),
      (read?.skills ?? []).slice(0, 20).join(", "),
      ...(company && !rules.companyLinks ? [] : [r.rec.screen?.links.githubProfile ?? ""]),
      byProfile
        ? r.fits.filter((x) => x.tier && x.role !== tab.role).map((x) => x.label).join(", ")
        : [r.primary && r.primary.role !== tab.role ? r.primary.label : "", ...r.alsoFor.filter((x) => x.role !== tab.role).map((x) => x.label)].filter(Boolean).join(", "),
      ...(company
        ? []
        : [
            f.parts.projects,
            f.parts.dsa,
            f.parts.experience,
            f.parts.engineering,
            ...(byProfile ? [f.parts.fit ?? ""] : []),
            r.trust ? `${r.trust.score} (${r.trust.band})` : "off",
            (r.trust?.checks ?? []).map((x) => `${x.points ? `${x.points} ` : ""}${x.label}: ${x.detail}`).join("\n"),
            f.gates.map((g) => `${g.ok ? "✓" : "✗"} ${g.label}: ${g.detail}`).join("\n"),
            r.reason,
          ]),
    ];
  });
  return { header, rows };
}

function rulesInWords(rules: SpRules): string[][] {
  const d = rules.dsa;
  return [
    ["DSA (every role)", `Codeforces ≥ ${d.codeforces} or CodeChef ≥ ${d.codechef} (highest rating), or LeetCode contest rating ≥ ${d.leetcode} with ${d.leetcodeSolved}+ problems solved — at least ${d.minContests} rated contests, on a profile linked from the resume`],
    ["Projects", `At least 2 strong projects in the role (quality ≥ ${rules.strongProject} of 100 on a 15+ LPA product-company bar), or 1 exceptional project (≥ ${rules.exceptionalProject}) plus in-role experience; course / tutorial / clone work doesn't count`],
    ["Verified in code", `At least one strong project in the candidate's own GitHub repository: ${rules.proof.minOwnCommits}+ own commits, ${Math.round(rules.proof.minShare * 100)}%+ of the commits theirs, work on ${rules.proof.minDays}+ days, ${rules.proof.minSrcFiles}+ source files, code that shows the project's stack${rules.proof.allowAiTraces ? "" : ", no AI app-generator traces"}`],
    ["Experience", "A strong bonus (full-time and product-company work count most), not required"],
  ];
}

/** About tab for the company when the profiles come from JDs: each profile's definition and bar. */
function profilesAboutSheet(outcome: SpOutcome, profiles: SpProfileDef[]): XlsxSheet {
  const rows: XlsxCell[][] = [
    ["What this is", "Sample profiles of NxtWave students for your open roles — only the strongest for each role are included."],
    ["How they were chosen", "Each profile was checked by program against the resume's projects, experience, certifications and achievements, the student's own GitHub code and their competitive-programming profiles:"],
  ];
  for (const p of profiles) {
    const tab = outcome.tabs.find((t) => t.role === `profile:${p.id}`);
    rows.push(["", ""], [p.name || "Profile", `${tab?.shown.length ?? 0} profile${tab?.shown.length === 1 ? "" : "s"} (${tab?.shown.filter((r) => r.fits.find((f) => f.role === tab.role)?.tier === "Showcase").length ?? 0} Showcase)`]);
    rows.push(...profileRulesInWords(p));
    rows.push(["Tiers", `Showcase = the very top (profile score ≥ ${p.inputs.showcaseAt}); Strong = clearly strong (≥ ${p.inputs.strongAt})`]);
  }
  rows.push(["", ""], ["Candidate ID", "Each student has a stable ID — quote it to ask for the full profile or an interview."], ["Generated", new Date().toISOString().slice(0, 10)]);
  return { name: "About these profiles", header: ["Sample profiles", "NxtWave"], rows, widths: [26, 140] };
}

/** Internal summary rows for the profiles: the definition, every input with the JD's reason, and what was edited. */
function profilesSummaryRows(profiles: SpProfileDef[]): XlsxCell[][] {
  const rows: XlsxCell[][] = [];
  for (const p of profiles) {
    const edited = p.llmInputs && JSON.stringify(p.llmInputs) !== JSON.stringify(p.inputs);
    rows.push(["", ""], [`Profile: ${p.name || p.id}`, p.source ? `Drafted from ${p.source.name} (${p.source.kind}) by ${p.model}` : "Typed by hand"]);
    rows.push(...profileRulesInWords(p));
    rows.push(["Inputs", `${inputsInWords(p.inputs)}${edited ? " (edited after the draft)" : ""}`]);
    for (const k of Object.keys(REASON_LABEL) as SpReasonKey[]) if (p.reasons[k]) rows.push([`Reason — ${REASON_LABEL[k]}`, p.reasons[k]!]);
    if (p.notJudged.length) rows.push(["Not judged from resumes", p.notJudged.join("; ")]);
  }
  return rows;
}

/** About tab for the company: what these profiles are and how they were chosen. */
function aboutSheet(outcome: SpOutcome, rules: SpRules): XlsxSheet {
  if (outcome.profiles) return profilesAboutSheet(outcome, outcome.profiles);
  const rows: XlsxCell[][] = [
    ["What this is", "Sample profiles of NxtWave students — only the strongest in each role are included."],
    ["How they were chosen", "Every profile cleared the same strict bar, checked by program against the resume, the student's own GitHub code and their competitive-programming profiles:"],
    ...rulesInWords(rules),
    ["Tiers", `Showcase = the very top (profile score ≥ ${rules.showcaseAt}); Strong = clearly strong (≥ ${rules.strongAt})`],
    ["Candidate ID", "Each student has a stable ID — quote it to ask for the full profile or an interview."],
    ["", ""],
    ...outcome.tabs.map((t) => [t.label, `${t.shown.length} profile${t.shown.length === 1 ? "" : "s"} (${t.shown.filter((r) => r.tier === "Showcase").length} Showcase)`]),
    ["Generated", new Date().toISOString().slice(0, 10)],
  ];
  return { name: "About these profiles", header: ["Sample profiles", "NxtWave"], rows, widths: [26, 140] };
}

function summarySheet(title: string, ds: SpDataset, outcome: SpOutcome, rules: SpRules): XlsxSheet {
  const s = outcome.stats;
  const rows: XlsxCell[][] = [
    ["Run", title],
    ["Generated", new Date().toISOString()],
    ["Sheet", `${ds.source.title} › ${ds.source.tab} — ${ds.source.url}`],
    ["Rows (after repeats removed)", s.rows],
    ["Showcase / Strong", `${s.showcase} / ${s.strong}`],
    ["Near misses (worth a look by hand)", s.nearMiss],
    ["Still pending (run the stages again)", s.pending],
    [outcome.profiles ? "Profiles with candidates" : "Roles with profiles", s.roles],
    ["", ""],
    ...outcome.stages.map((st) => [`Stage: ${SP_STAGE_LABEL[st]}`, `${outcome.funnel[st].reached} reached · ${outcome.funnel[st].stopped} stopped here · ${outcome.funnel[st].pending} pending`]),
    ...(outcome.profiles ? profilesSummaryRows(outcome.profiles) : []),
    ["", ""],
    ...(outcome.profiles ? [] : rulesInWords(rules)),
    ["Trust agent", rules.trustAgent ? `On — Low trust is excluded; Showcase needs High trust` : "Off"],
    ["Score", `Projects ${rules.weights.projects} · DSA ${rules.weights.dsa} · GitHub engineering ${rules.weights.engineering} (weighted average), plus up to ${rules.weights.experience} points for experience, × trust factor (0.6 + 0.4 × trust/100)`],
    ["Placement", rules.everyRole ? "Listed in every role the candidate qualifies for" : "Listed once, in the role of their strongest projects (the SDE tab lists every qualified candidate whose DSA clears the SDE bar)"],
    ["SDE bar", `Codeforces ≥ ${rules.sdeBar.codeforces} or CodeChef ≥ ${rules.sdeBar.codechef} or LeetCode ≥ ${rules.sdeBar.leetcode} with ${rules.sdeBar.leetcodeSolved}+ solved, ${rules.sdeBar.minContests}+ contests`],
    ["Company workbook", `Top ${rules.topN} per role; Candidate IDs instead of names; ${rules.companyLinks ? "GitHub / DSA / project links included" : "no profile links"}`],
    ...ds.warnings.map((w) => ["Warning", w]),
  ];
  return { name: "Summary", header: ["Item", "Value"], rows, widths: [40, 140] };
}

function allSheet(outcome: SpOutcome, name: string, filter: (r: SpRanked) => boolean): XlsxSheet {
  const header = ["Sheet row", "Candidate ID", "Name", "Email", "Mobile", "Status", "Stopped at", "Why", "Best role", "Profile score", "DSA", "GitHub", "Resume"];
  const rows = outcome.rows.filter(filter).map((r): XlsxCell[] => {
    const best = r.primary ?? r.fits[0];
    return [
      r.c.sheetRow,
      r.candidateId,
      r.c.name,
      r.c.email,
      r.c.mobile,
      r.rejected && r.tier ? `${r.status} (taken out by hand)` : r.status,
      r.stage,
      r.reason,
      best?.label ?? "",
      best ? best.score : "",
      r.dsa ? dsaHeadline(r) || r.dsa.lines.join("; ") : "",
      r.rec.screen?.links.githubProfile ?? "",
      r.c.resumeUrl,
    ];
  });
  return { name, header, rows, widths: [9, 12, 24, 28, 14, 12, 11, 90, 22, 9, 40, 34, 40] };
}

/** The company workbook (.xlsx bytes). */
export function buildCompanyWorkbook(outcome: SpOutcome, rules: SpRules): Uint8Array {
  const sheets: XlsxSheet[] = [aboutSheet(outcome, rules)];
  for (const tab of outcome.tabs) {
    if (!tab.shown.length) continue;
    const t = roleTable(tab, "company", rules);
    sheets.push({ name: tab.label, header: t.header, rows: t.rows });
  }
  return buildXlsx(sheets);
}

/** The internal workbook (.xlsx bytes). */
export function buildInternalWorkbook(title: string, ds: SpDataset, outcome: SpOutcome, rules: SpRules): Uint8Array {
  const sheets: XlsxSheet[] = [summarySheet(title, ds, outcome, rules)];
  for (const tab of outcome.tabs) {
    const t = roleTable(tab, "internal", rules);
    sheets.push({ name: tab.label, header: t.header, rows: t.rows });
  }
  sheets.push(allSheet(outcome, "Near misses", (r) => r.status === "Near miss"));
  sheets.push(allSheet(outcome, "Taken out by hand", (r) => r.rejected && Boolean(r.tier)));
  sheets.push(allSheet(outcome, "All screened", () => true));
  return buildXlsx(sheets);
}

/** One role tab as CSV. */
export function buildRoleCsv(tab: SpRoleTab, audience: SpAudience, rules: SpRules): string {
  const t = roleTable(tab, audience, rules);
  const records = t.rows.map((row) => Object.fromEntries(t.header.map((h, i) => [h, row[i] === null || row[i] === undefined ? "" : String(row[i])])));
  return "﻿" + toCsv(t.header, records);
}

/** "frontend-engineer" for file names. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "role";

/** Profile links for one platform (for the results panel). */
export function dsaPlatformLines(r: SpRanked): { key: string; label: string; line: string; url: string; identity: string }[] {
  return DSA_ORDER.filter((k) => r.dsa?.dsa[k]).map((k) => ({
    key: k,
    label: DSA_NAME[k],
    line: platformLine(k, r.dsa!.dsa[k]),
    url: r.dsa!.dsa[k]!.url,
    identity: r.dsa!.dsa[k]!.identityNote || r.dsa!.dsa[k]!.identity || "",
  }));
}

export { roleLabel };
