import type { DomainCommit, DomainGithubRepo } from "@/lib/types";
import { formatDay } from "@/lib/utils";

/** One shortlisted candidate as it appears in the domain report. */
export interface DomainCardInput {
  rank: number;
  name: string;
  coreSkills: string[];
  evidence: string;
  /** One-line domain internship/work experience ("" = none). */
  experience: string;
  resumeUrl: string;
  assessmentReport: string;
  tr1Panelist: string;
  tr1PanelLinkedin: string;
  tr1Recording: string;
  tr2Panelist: string;
  tr2PanelLinkedin: string;
  tr2Recording: string;
  placedCompany: string;
  ctc: string;
  /** GitHub profile URL ("" = none). */
  githubProfile: string;
  /** Public repos whose code proves the domain, from deep GitHub inspection (0 = none/off). */
  githubMatches: number;
  /** 0-100 deep GitHub fit for the domain (0 = none/off). */
  githubScore: number;
  /** Domain technologies proven in the repos' code, strongest first. */
  githubTechs: string[];
  /** The best domain-relevant repos. */
  githubTopRepos: DomainGithubRepo[];
  leetcodeSolved: number;
  codeforcesSolved: number;
  /** GitHub commit contributions in the last ~2 years (0 = none/off). */
  githubCommits2y: number;
  /** Latest commit to a domain-relevant repo (null = none / off). */
  lastDomainCommit: DomainCommit | null;
  /** Whether to render the coding-stats row at all (DSA, GitHub or domain-commit enabled). */
  showCoding: boolean;
  /** 0-100 resume structure / alignment / visual quality (0 = not graded). */
  presentationScore: number;
  /** One line naming what drives the presentation score ("" = none). */
  presentationNotes: string;
  /** Whether the presentation badge is rendered at all (check was on). */
  showPresentation: boolean;
}

export interface DomainReportInput {
  /** Label for this run (e.g. batch/drive name). */
  runName: string;
  /** Short domain label (e.g. "AI / ML"). */
  domain: string;
  resumesScanned: number;
  candidatesConsidered: number;
  candidates: DomainCardInput[];
  /** Show the scan-summary stat strip (scanned / matches / shortlisted). */
  showStats: boolean;
  /** The shortlist was cut to a top N (headline reads "Top N"); off = everyone who cleared the gates. */
  limitedToTopN: boolean;
}

function esc(value: string): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isUrl(v: string): boolean {
  return /^https?:\/\//i.test((v ?? "").trim());
}

/** Placeholder "empty" values that appear in sheets and must not be rendered. */
const BLANK_RE = /^(#?\s*n[./]?a\.?|na|null|none|nil|nan|-+|—+|_+|tbd|pending|not\s*(placed|applicable|available))$/i;
function clean(v: string): string {
  const s = (v ?? "").trim();
  return BLANK_RE.test(s) ? "" : s;
}

/** Trim a domain label to a sane length for the title / skills heading. */
function shortLabel(v: string, max: number): string {
  const s = (v || "the domain").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const ICONS = {
  linkedin:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 0 .02 5 2.5 2.5 0 0 0-.02-5zM3 9.5h4v11H3v-11zm7 0h3.8V11h.05c.53-1 1.83-2.05 3.76-2.05 4.02 0 4.76 2.64 4.76 6.07V20.5h-4v-4.9c0-1.17-.02-2.67-1.63-2.67-1.63 0-1.88 1.27-1.88 2.59V20.5h-4v-11z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  assessment:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="13" y="7" width="3" height="10"/></svg>',
  resume:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  placed:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-4V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M9 7V5h6v2"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M12 2A10 10 0 0 0 8.84 21.5c.5.09.68-.22.68-.48v-1.7C6.73 19.91 6.14 18 6.14 18c-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>',
  layout:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
};

/** Presentation bands — label + palette for the resume-quality badge. */
function presentationBand(score: number): { label: string; cls: string } {
  if (score >= 85) return { label: "Recruiter-ready resume", cls: "pres-a" };
  if (score >= 70) return { label: "Well-structured resume", cls: "pres-b" };
  return { label: "Resume formatting needs polish", cls: "pres-c" };
}
const ARROW =
  '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>';

/**
 * The domain-shortlist report — the strongest candidates for one domain, ranked,
 * each shown with the domain skills they can back up plus a grouped interview
 * trail (assessment, TR-1/TR-2 panel + LinkedIn + recordings) so a hiring reader
 * can verify and reach out in one click.
 *
 * Multi-page by design (a top-10 won't fit one A4): `break-inside: avoid` keeps
 * a candidate card whole; page 1 bleeds the hero to the top, later pages get a
 * top margin (see @page rules).
 */
export function buildDomainReportHtml(input: DomainReportInput): string {
  const { runName, domain, resumesScanned, candidatesConsidered, candidates, showStats, limitedToTopN } = input;
  const titleLabel = shortLabel(domain, 56);
  const skillLabel = shortLabel(domain, 34);

  const cards = candidates
    .map((c) => {
      // ── placement (top-right) ────────────────────────────────────────────
      const placed = clean(c.placedCompany);
      const ctc = clean(c.ctc);
      const placedText = placed ? `Placed at ${esc(placed)}${ctc ? ` · ${esc(ctc)}` : ""}` : ctc ? esc(ctc) : "";
      const placedPill = placedText ? `<span class="placed">${ICONS.placed}<span>${placedText}</span></span>` : "";

      // ── skills ───────────────────────────────────────────────────────────
      const chips = c.coreSkills
        .filter(Boolean)
        .map((s) => `<span class="chip">${esc(s)}</span>`)
        .join("");

      // ── github proof (deep inspection: what the repos' code actually uses) ─
      // Shown only when at least one repo's code / manifests prove a domain technology.
      const ghProfile = clean(c.githubProfile);
      const githubBadge = (() => {
        if (c.githubMatches <= 0) return "";
        const repoWord = c.githubMatches === 1 ? "repository" : "repositories";
        const head = `<span>GitHub-verified · ${c.githubMatches} domain ${repoWord}</span>${
          c.githubScore > 0 ? `<span class="ghscore">${c.githubScore}<i>/100</i></span>` : ""
        }`;
        const badge = isUrl(ghProfile)
          ? `<a class="ghbadge" href="${esc(ghProfile)}">${ICONS.github}${head}${ARROW}</a>`
          : `<span class="ghbadge ghbadge-flat">${ICONS.github}${head}</span>`;
        const techs = c.githubTechs.slice(0, 6).map(esc).join(" · ");
        const repos = c.githubTopRepos
          .slice(0, 3)
          .filter((r) => isUrl(r.url))
          .map((r) => `<a class="ghrepo" href="${esc(r.url)}">${esc(shortLabel(r.name, 30))}${ARROW}</a>`)
          .join("");
        return `${badge}${techs ? `<div class="ghtechs">Proven in code: <b>${techs}</b></div>` : ""}${
          repos ? `<div class="ghrepos">${repos}</div>` : ""
        }`;
      })();

      // ── coding stats strip (LeetCode / Codeforces solved · GitHub commits · last domain commit) ─
      const nf = (n: number) => n.toLocaleString("en-US");
      const lastCommitDay = c.lastDomainCommit ? formatDay(c.lastDomainCommit.date) : "";
      const statCells = [
        c.leetcodeSolved > 0 ? `<span class="cstat"><b>${nf(c.leetcodeSolved)}</b><i>LeetCode</i></span>` : "",
        c.codeforcesSolved > 0 ? `<span class="cstat"><b>${nf(c.codeforcesSolved)}</b><i>Codeforces</i></span>` : "",
        c.githubCommits2y > 0 ? `<span class="cstat"><b>${nf(c.githubCommits2y)}</b><i>commits · 2y</i></span>` : "",
        c.lastDomainCommit && lastCommitDay
          ? `<span class="cstat"><b>${esc(lastCommitDay)}</b><i>last domain commit · ${esc(shortLabel(c.lastDomainCommit.repo, 24))}</i></span>`
          : "",
      ].filter(Boolean);
      const codingRow = c.showCoding && statCells.length ? `<div class="cstats">${statCells.join("")}</div>` : "";

      // ── resume presentation (structure / alignment / visual quality) ──────
      const presBadge = (() => {
        if (!c.showPresentation || c.presentationScore <= 0) return "";
        const band = presentationBand(c.presentationScore);
        const notes = clean(c.presentationNotes);
        return `<div class="pres ${band.cls}">${ICONS.layout}<span class="pres-label">${band.label}</span><span class="pres-score">${c.presentationScore}<i>/100</i></span>${
          notes ? `<span class="pres-note">${esc(notes)}</span>` : ""
        }</div>`;
      })();

      // ── interview trail ──────────────────────────────────────────────────
      const panelRow = (label: string, name: string, linkedin: string, recording: string): string => {
        const nm = clean(name);
        if (!nm && !isUrl(recording)) return "";
        const li = isUrl(linkedin)
          ? `<a class="li" href="${esc(linkedin)}">${ICONS.linkedin}<span>LinkedIn</span></a>`
          : "";
        const rec = isUrl(recording)
          ? `<a class="rec" href="${esc(recording)}">${ICONS.play}<span>Recording</span>${ARROW}</a>`
          : `<span class="rec rec-off">No recording</span>`;
        return `<div class="trrow"><span class="trlabel">${label}</span><span class="trname">${nm ? esc(nm) : "Panel"}</span>${li}<span class="trspacer"></span>${rec}</div>`;
      };
      const tr1 = panelRow("TR-1", c.tr1Panelist, c.tr1PanelLinkedin, c.tr1Recording);
      const tr2 = panelRow("TR-2", c.tr2Panelist, c.tr2PanelLinkedin, c.tr2Recording);
      const hasPanel = clean(c.tr1Panelist) || clean(c.tr2Panelist);
      const trLinks = [
        isUrl(c.assessmentReport)
          ? `<a class="doc" href="${esc(c.assessmentReport)}">${ICONS.assessment}<span>Assessment report</span>${ARROW}</a>`
          : "",
        isUrl(c.resumeUrl) ? `<a class="doc doc-cv" href="${esc(c.resumeUrl)}">${ICONS.resume}<span>Resume</span>${ARROW}</a>` : "",
      ]
        .filter(Boolean)
        .join("");

      const trailInner = [
        hasPanel
          ? `<div class="screened">${ICONS.shield}<span>Screened by senior developers from top-tier product companies</span></div>`
          : "",
        tr1,
        tr2,
        trLinks ? `<div class="docs">${trLinks}</div>` : "",
      ]
        .filter(Boolean)
        .join("");
      const trail = trailInner
        ? `<div class="trail"><div class="trail-label">Interview trail</div>${trailInner}</div>`
        : "";

      const rankClass = c.rank <= 3 ? ` rank-top rank-${c.rank}` : "";

      return `<article class="card">
  <div class="card-top">
    <div class="rank${rankClass}">${String(c.rank).padStart(2, "0")}</div>
    <div class="name">${esc(c.name || "Candidate")}</div>
    ${placedPill}
  </div>

  <div class="skills-label">Core ${esc(skillLabel)} skills</div>
  ${chips ? `<div class="chips">${chips}</div>` : `<div class="chips-empty">Not specified</div>`}
  ${c.evidence ? `<p class="evidence">${esc(c.evidence)}</p>` : ""}
  ${clean(c.experience) ? `<div class="exp">${ICONS.placed}<span>${esc(clean(c.experience))}</span></div>` : ""}
  ${presBadge}
  ${codingRow}
  ${githubBadge ? `<div class="ghwrap">${githubBadge}</div>` : ""}
  ${trail}
</article>`;
    })
    .join("");

  const empty = `<div class="empty">No candidate showed strong evidence for ${esc(titleLabel)} in the scanned resumes. Try broadening the domain.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  :root {
    --ground:#F5F6FB; --panel:#FFFFFF; --line:#E6E8F0; --line-soft:#EEF0F6;
    --ink:#141627; --muted:#606579; --faint:#9096AC;
    --accent:#4338CA; --accent-2:#6D28D9; --accent-soft:#EEF0FE; --accent-line:#DDE1FB;
    --serif: Georgia, "Times New Roman", serif;
    --sans: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    --pad: 42px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size:A4; margin:15mm 0 13mm; }
  @page :first { margin:0; }
  body { font-family:var(--sans); color:var(--ink); background:var(--ground);
    -webkit-print-color-adjust:exact; print-color-adjust:exact; }

  /* ── Hero ── */
  .hero { position:relative; overflow:hidden; min-height:148px; display:flex; align-items:center;
    background:linear-gradient(120deg,#4338CA 0%,#5B33CE 52%,#7C3AED 100%); color:#fff; padding:36px var(--pad) 32px; }
  .hero::after { content:""; position:absolute; top:-55%; right:-8%; width:52%; height:210%;
    background:radial-gradient(closest-side, rgba(255,255,255,.16), rgba(255,255,255,0)); }
  .hero-row { position:relative; z-index:1; width:100%; display:flex; justify-content:space-between; align-items:center; gap:24px; }
  .eyebrow { font-family:var(--mono); font-size:10px; letter-spacing:3px; text-transform:uppercase; color:rgba(255,255,255,.75); }
  .h1 { font-family:var(--serif); font-size:33px; font-weight:700; line-height:1.05; margin-top:11px; letter-spacing:-.3px; }
  .curated { font-family:var(--mono); font-size:10px; color:rgba(255,255,255,.7); line-height:1.7; text-align:right; flex:0 0 auto; }
  .curated b { display:block; color:#fff; font-size:13px; letter-spacing:.5px; margin-top:2px; }

  /* ── Scan summary ── */
  .stats { display:flex; gap:11px; padding:20px var(--pad) 0; }
  .stat { flex:1; background:var(--panel); border:1px solid var(--line); border-radius:11px; padding:13px 16px; }
  .stat b { display:block; font-family:var(--mono); font-size:22px; font-weight:700; color:var(--accent); line-height:1; }
  .stat i { display:block; font-style:normal; font-family:var(--mono); font-size:9px; letter-spacing:.9px;
    text-transform:uppercase; color:var(--muted); margin-top:7px; }

  .section-title { font-family:var(--mono); font-size:9.5px; letter-spacing:1.8px; text-transform:uppercase;
    color:var(--muted); display:flex; align-items:center; gap:10px; padding:22px var(--pad) 13px; }
  /* When the stat strip is hidden, the shortlist follows the hero directly. */
  .section-title-lead { padding-top:26px; }
  .section-title::after { content:""; flex:1; height:1px; background:var(--line); }

  .list { padding:0 var(--pad) 26px; display:flex; flex-direction:column; gap:13px; }

  /* ── Candidate card ── */
  .card { background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:16px 18px;
    box-shadow:0 1px 3px rgba(20,22,40,.05); break-inside:avoid; page-break-inside:avoid; }

  .card-top { display:flex; align-items:center; gap:12px; }
  .rank { flex:0 0 auto; font-family:var(--mono); font-size:12px; font-weight:700; color:var(--accent);
    background:var(--accent-soft); border-radius:8px; padding:6px 9px; line-height:1; }
  .rank-top { color:#fff; }
  .rank-1 { background:linear-gradient(135deg,#B45309,#F59E0B); }
  .rank-2 { background:linear-gradient(135deg,#5B6472,#949CAA); }
  .rank-3 { background:linear-gradient(135deg,#7C2D12,#C2703B); }
  .name { flex:1; min-width:0; font-size:17px; font-weight:700; letter-spacing:-.2px; line-height:1.2;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .placed { flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700;
    color:#065F46; background:#ECFDF5; border:1px solid #A7F3D0; border-radius:999px; padding:5px 12px; }
  .placed svg { color:#059669; }

  .skills-label { font-family:var(--mono); font-size:9px; letter-spacing:1.3px; text-transform:uppercase;
    color:var(--faint); margin-top:15px; }
  .chips { display:flex; flex-wrap:wrap; gap:7px; margin-top:8px; }
  .chips-empty { color:var(--faint); margin-top:8px; font-size:12px; font-style:italic; }
  .chip { font-family:var(--mono); font-size:11px; font-weight:600; color:#3730A3; background:var(--accent-soft);
    border:1px solid var(--accent-line); padding:5px 11px; border-radius:7px; }

  .evidence { font-size:12.3px; line-height:1.55; color:#3A3F55; margin-top:12px;
    padding-left:11px; border-left:2px solid var(--accent-line); }

  /* Domain internship/work experience */
  .exp { display:flex; align-items:center; gap:7px; margin-top:10px; font-size:11.5px; font-weight:600; color:#0F5132;
    background:#ECFDF5; border:1px solid #A7F3D0; border-radius:8px; padding:6px 11px; }
  .exp svg { flex:0 0 auto; color:#059669; }

  /* Resume presentation — structure, alignment and visual quality of the document */
  .pres { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:10px; font-size:11.5px;
    border:1px solid; border-radius:8px; padding:6px 11px; }
  .pres svg { flex:0 0 auto; }
  .pres-label { font-weight:700; }
  .pres-score { font-family:var(--mono); font-size:11px; font-weight:700; background:rgba(255,255,255,.7);
    border-radius:5px; padding:2px 6px; }
  .pres-score i { font-style:normal; font-size:8.5px; opacity:.7; }
  .pres-note { flex:1 1 100%; font-size:10.5px; font-weight:500; opacity:.85; }
  .pres-a { color:#0F5132; background:#ECFDF5; border-color:#A7F3D0; }
  .pres-b { color:#3730A3; background:var(--accent-soft); border-color:var(--accent-line); }
  .pres-c { color:#92400E; background:#FFFBEB; border-color:#FDE68A; }

  /* Coding stats — objective proof (LeetCode / Codeforces / recent commits) */
  .cstats { display:flex; flex-wrap:wrap; gap:9px; margin-top:12px; }
  .cstat { display:flex; flex-direction:column; align-items:flex-start; background:var(--ground);
    border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:9px; padding:7px 13px; min-width:88px; }
  .cstat b { font-family:var(--mono); font-size:16px; font-weight:700; color:var(--accent); line-height:1; }
  .cstat i { font-style:normal; font-family:var(--mono); font-size:8.5px; letter-spacing:.7px; text-transform:uppercase;
    color:var(--muted); margin-top:5px; }

  .ghwrap { margin-top:11px; }
  .ghbadge { display:inline-flex; align-items:center; gap:6px; text-decoration:none; font-size:11px; font-weight:700;
    color:#1F2328; background:#F3F4F8; border:1px solid var(--line); border-radius:999px; padding:5px 12px; }
  .ghbadge svg:first-child { color:#1F2328; }
  .ghscore { font-family:var(--mono); font-size:10.5px; font-weight:700; color:#fff; background:#1F2328;
    border-radius:5px; padding:2px 6px; }
  .ghscore i { font-style:normal; font-size:8.5px; opacity:.75; }
  .ghtechs { margin-top:7px; font-size:10.5px; color:var(--muted); }
  .ghtechs b { color:var(--ink); font-weight:600; }
  .ghrepos { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .ghrepo { display:inline-flex; align-items:center; gap:4px; text-decoration:none; font-family:var(--mono); font-size:10px;
    font-weight:600; color:#1F2328; background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:3px 8px; }

  /* ── Interview trail (grouped panel) ── */
  .trail { margin-top:14px; background:var(--ground); border:1px solid var(--line-soft); border-radius:11px; padding:12px 13px; }
  .trail-label { font-family:var(--mono); font-size:8.5px; letter-spacing:1.4px; text-transform:uppercase;
    color:var(--faint); margin-bottom:9px; }
  .screened { display:flex; align-items:center; gap:8px; font-size:11px; font-weight:600; color:#3730A3;
    background:var(--accent-soft); border:1px solid var(--accent-line); border-radius:8px; padding:7px 11px; margin-bottom:9px; }
  .screened svg { flex:0 0 auto; color:var(--accent); }

  .trrow { display:flex; align-items:center; gap:9px; font-size:11.5px; padding:5px 0; }
  .trrow + .trrow { border-top:1px solid var(--line-soft); }
  .trlabel { flex:0 0 auto; font-family:var(--mono); font-size:9px; font-weight:700; letter-spacing:.5px; color:#fff;
    background:var(--accent); border-radius:5px; padding:3px 7px; }
  .trname { font-weight:600; color:var(--ink); }
  .li { display:inline-flex; align-items:center; gap:4px; text-decoration:none; font-size:10.5px; font-weight:600; color:#0A66C2; }
  .li svg { color:#0A66C2; }
  .trspacer { flex:1; }
  .rec { display:inline-flex; align-items:center; gap:5px; text-decoration:none; font-size:10.5px; font-weight:700; color:var(--accent); }
  .rec-off { color:var(--faint); font-weight:500; }

  .docs { display:flex; flex-wrap:wrap; gap:8px; margin-top:11px; padding-top:10px; border-top:1px solid var(--line-soft); }
  .doc { display:inline-flex; align-items:center; gap:6px; text-decoration:none; font-size:11px; font-weight:600;
    border-radius:8px; padding:6px 11px; border:1px solid var(--line); background:var(--panel); color:var(--ink); }
  .doc-cv { color:var(--accent); border-color:var(--accent-line); background:var(--accent-soft); }

  .empty { margin:0 var(--pad); padding:28px; text-align:center; color:var(--muted); font-size:13px;
    background:var(--panel); border:1px dashed var(--line); border-radius:13px; }

  .foot { padding:13px var(--pad); border-top:1px solid var(--line); background:var(--panel);
    display:flex; justify-content:space-between; font-family:var(--mono); font-size:9.5px; color:var(--muted); }
  .foot b { color:var(--ink); }
</style>
</head>
<body>
  <header class="hero">
    <div class="hero-row">
      <div>
        <div class="eyebrow">Domain shortlist</div>
        <div class="h1">${limitedToTopN ? `Top ${candidates.length}` : `${candidates.length} shortlisted`} — ${esc(titleLabel)}</div>
      </div>
      ${runName ? `<div class="curated">Curated for<b>${esc(runName)}</b></div>` : ""}
    </div>
  </header>

  ${
    showStats
      ? `<div class="stats">
    <div class="stat"><b>${resumesScanned}</b><i>candidates scanned</i></div>
    <div class="stat"><b>${candidatesConsidered}</b><i>domain matches</i></div>
    <div class="stat"><b>${candidates.length}</b><i>shortlisted</i></div>
  </div>`
      : ""
  }

  <div class="section-title${showStats ? "" : " section-title-lead"}">Ranked shortlist</div>
  ${candidates.length ? `<div class="list">${cards}</div>` : empty}

  <div class="foot">
    <span><b>NxtWave${runName ? ` · ${esc(runName)}` : ""}</b></span>
    <span>Confidential · shortlisted for the hiring team</span>
  </div>
</body>
</html>`;
}
