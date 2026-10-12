import type { GithubProjectStats, ProblemStat, ResumeLink } from "@/lib/types";

/** Minimal HTML-escaping for injected values. */
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

export type ReviewLinkKind = "tr1" | "tr2" | "assessment";

export interface ReviewLink {
  kind: ReviewLinkKind;
  label: string;
  sublabel: string;
  href: string;
  /** Interview panel member (TR rounds only). */
  panel?: string;
  /** The panel member's LinkedIn profile (TR rounds only). */
  panelLinkedin?: string;
}

export interface ReportTemplateInput {
  name: string;
  company: string;
  /** "College · Course · Year". */
  subtitle: string;
  /** Resume URL → "View Resume" pill, top-right. */
  resumeUrl: string;
  /** 4–6 one-line achievements (hero). */
  highlights: string[];
  /** JD-matching skills (chips). */
  skills: string[];
  /** Verified per-platform solved counts (shown only when combined > threshold). */
  problemStats: ProblemStat[];
  /** JD-matching GitHub stats, or null. */
  github: GithubProjectStats | null;
  /** Notable JD-matching repos (name → url). */
  projects: { name: string; url: string }[];
  /** Profile links (LeetCode / Codeforces / portfolio). */
  otherLinks: ResumeLink[];
  /** TR-1 / TR-2 / Assessment review links. */
  reviewLinks: ReviewLink[];
}

/** Slightly desaturated, institutional data hues (indigo dominant), cycled. */
const DATA_HUES = ["#4338CA", "#0D9488", "#7C3AED", "#D97706", "#E11D48", "#475569", "#2563EB"];

/** Highlight-card geometry — kept in sync with the `.point` / `.points` CSS. */
const HL_CARD_MAX = 74;
const HL_CARD_GAP = 8;
const HL_TITLE_H = 26;

const ICONS: Record<string, string> = {
  resume:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  tr1: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  tr2: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  assessment:
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="13" y="7" width="3" height="10"/></svg>',
  repo: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  linkedin:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 0 .02 5 2.5 2.5 0 0 0-.02-5zM3 9.5h4v11H3v-11zm7 0h3.8V11h.05c.53-1 1.83-2.05 3.76-2.05 4.02 0 4.76 2.64 4.76 6.07V20.5h-4v-4.9c0-1.17-.02-2.67-1.63-2.67-1.63 0-1.88 1.27-1.88 2.59V20.5h-4v-11z"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
};
const ARROW =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>';

/**
 * Single-page candidate screening report — an "evaluation dossier" built for
 * hiring panelists to shortlist at a glance.
 *
 * System: a gradient indigo→violet hero band (the one bold moment) carrying a
 * serif candidate name for authority; a humanist sans body; and a monospace face
 * for every verified number (a nod to the candidate's own world — code).
 *
 * Layout contract — the page is a fixed A4 flex column:
 *   hero (fixed) · body (flex:1, sections evenly spread) · footer (fixed)
 * Leftover vertical space is shared BETWEEN sections by `justify-content:
 * space-between` on a `gap`-floored column, so a light-content candidate reads
 * as an airy, deliberately spaced document instead of dumping one dead gap in
 * the middle. Every grid that can be under-filled (metric tiles, review cards)
 * sizes its columns to the actual item count so rows are never left ragged.
 * All CSS inline so the PDF renders deterministically; degrades gracefully when
 * a block (stats / github / links) is empty.
 */
export function buildReportHtml(input: ReportTemplateInput): string {
  const { name, company, subtitle, resumeUrl, highlights, skills, problemStats, github, projects, otherLinks, reviewLinks } = input;

  const resumePill = isUrl(resumeUrl)
    ? `<a class="resume-pill" href="${esc(resumeUrl)}">${ICONS.resume}<span>View Resume</span>${ARROW}</a>`
    : "";

  // ── Metrics strip (multi-hue tiles) ──────────────────────────────────────
  const tiles: string[] = [];
  problemStats.forEach((p, i) => {
    const c = DATA_HUES[i % DATA_HUES.length];
    tiles.push(
      `<div class="tile" style="--c:${c}"><div class="tile-num">${p.solved.toLocaleString("en-US")}</div><div class="tile-label">${esc(p.platform)} solved</div></div>`,
    );
  });
  if (github && github.matchingCount > 0) {
    const c = DATA_HUES[problemStats.length % DATA_HUES.length];
    tiles.push(
      `<div class="tile" style="--c:${c}"><div class="tile-num">${github.matchingCount}</div><div class="tile-label">JD-matching projects</div></div>`,
    );
  }
  // A lone tile reads as a wide banner stat rather than a stranded card.
  const metricsStrip = tiles.length
    ? `<section class="metrics${tiles.length === 1 ? " metrics-single" : ""}">${tiles.join("")}</section>`
    : "";

  // ── Highlights ───────────────────────────────────────────────────────────
  const cleanHighlights = highlights.filter((h) => h && h.trim());
  const points = cleanHighlights
    .map(
      (h, i) =>
        `<li class="point"><span class="pt-n">${String(i + 1).padStart(2, "0")}</span><span class="point-text">${esc(h)}</span></li>`,
    )
    .join("");

  // Ceiling for the highlights block, derived from the real card count. The
  // section still SHRINKS for a dense report, but it can never grow past
  // "every card at its max" — so leftover height falls past the records to the
  // foot of the page instead of inflating the cards or the gaps between them.
  const hlCount = Math.max(cleanHighlights.length, 1);
  const hlMaxHeight = HL_TITLE_H + hlCount * HL_CARD_MAX + (hlCount - 1) * HL_CARD_GAP;

  // ── Skills ───────────────────────────────────────────────────────────────
  const chips = skills.filter(Boolean).map((s) => `<span class="chip">${esc(s)}</span>`).join("");
  const skillsBlock = chips
    ? `<div class="block"><div class="section-title">Skills matched to role</div><div class="chips">${chips}</div></div>`
    : "";

  // ── Language mix bar (white hairline dividers, aligned legend grid) ───────
  let stackBlock = "";
  if (github && github.languages.length) {
    const total = github.languages.reduce((s, l) => s + l.count, 0) || 1;
    const segs = github.languages
      .map((l, i) => `<span class="seg" style="width:${(l.count / total) * 100}%;background:${DATA_HUES[i % DATA_HUES.length]}"></span>`)
      .join("");
    const legend = github.languages
      .map(
        (l, i) =>
          `<span class="leg"><span class="dot" style="background:${DATA_HUES[i % DATA_HUES.length]}"></span><span class="leg-l">${esc(l.lang)}</span><b>${l.count}</b></span>`,
      )
      .join("");
    stackBlock = `<div class="block"><div class="section-title">Project stack · ${github.matchingCount} repos</div><div class="bar">${segs}</div><div class="legend">${legend}</div></div>`;
  }

  // ── Projects + profiles ──────────────────────────────────────────────────
  const projectRows = projects
    .filter((p) => isUrl(p.url))
    .slice(0, 5)
    .map((p) => `<a class="repo" href="${esc(p.url)}"><span class="repo-ic">${ICONS.repo}</span><span class="repo-name">${esc(p.name)}</span><span class="repo-arrow">${ARROW}</span></a>`)
    .join("");
  const profileChips = otherLinks
    .filter((l) => isUrl(l.url))
    .map((l) => `<a class="profile" href="${esc(l.url)}">${esc(l.label)}${ARROW}</a>`)
    .join("");
  const projectsBlock =
    projectRows || profileChips
      ? `<div class="block"><div class="section-title">Projects &amp; profiles</div>${projectRows ? `<div class="repos">${projectRows}</div>` : ""}${profileChips ? `<div class="profiles">${profileChips}</div>` : ""}</div>`
      : "";

  const leftBlocks = [skillsBlock, stackBlock].filter(Boolean).join("");
  // Two columns only when both sides have content — otherwise the single block
  // spans the full width instead of sitting in a half-empty grid. With no repos
  // the right column holds only profile chips, so the split favours the left.
  const twoCol =
    leftBlocks && projectsBlock
      ? `<section class="cols${projectRows ? "" : " cols-tight"}"><div class="col">${leftBlocks}</div><div class="col">${projectsBlock}</div></section>`
      : leftBlocks || projectsBlock
        ? `<section class="cols cols-single">${leftBlocks}${projectsBlock}</section>`
        : "";

  // ── Review links ─────────────────────────────────────────────────────────
  const reviews = reviewLinks.filter((l) => isUrl(l.href));
  const reviewCards = reviews
    .map((l) => {
      const panel = (l.panel ?? "").trim();
      const li = (l.panelLinkedin ?? "").trim();
      // The card is a DIV, not an anchor: the panel's LinkedIn is its own link
      // and anchors must never nest.
      const panelRow = panel
        ? isUrl(li)
          ? `<a class="rc-panel" href="${esc(li)}"><span class="rc-li">${ICONS.linkedin}</span><span class="rc-panel-n">${esc(panel)}</span>${ARROW}</a>`
          : `<span class="rc-panel rc-panel-flat"><span class="rc-li">${ICONS.linkedin}</span><span class="rc-panel-n">${esc(panel)}</span></span>`
        : "";
      return `<div class="rcard"><a class="rc-main" href="${esc(l.href)}"><span class="rc-ic">${ICONS[l.kind] ?? ICONS.tr1}</span><span class="rc-body"><span class="rc-title">${esc(l.label)}</span><span class="rc-sub">${esc(l.sublabel)}</span></span><span class="rc-open"><span class="rc-open-t">Open</span>${ARROW}</span></a>${panelRow}</div>`;
    })
    .join("");

  // Credibility line — the technical rounds were run by senior engineers, and
  // their profiles are one click away. Only shown when a TR round is present.
  const hasPanel = reviews.some((l) => (l.kind === "tr1" || l.kind === "tr2") && (l.panel ?? "").trim());
  const screenedNote = hasPanel
    ? `<div class="screened">${ICONS.shield}<span>Technically screened by senior developers from top-tier product companies — panel profiles linked below</span></div>`
    : "";

  // Columns track the real card count so 1 or 2 records fill the row evenly.
  // At 3-up the cards are narrow, so the "Open" word drops to keep every title
  // on a single line.
  const reviewBlock = reviewCards
    ? `<section class="review"><div class="section-title">Interview &amp; assessment records</div>${screenedNote}<div class="rcards${reviews.length >= 3 ? " rcards-3" : ""}" style="grid-template-columns:repeat(${Math.min(reviews.length, 3)},1fr)">${reviewCards}</div></section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  :root {
    --ground:#F6F7FB; --panel:#FFFFFF; --line:#E4E7F0;
    --ink:#15182B; --muted:#5C6178; --faint:#8B90A6;
    --accent:#4338CA; --accent-soft:#EEF2FF; --accent-line:#E0E7FF;
    --serif: Georgia, "Times New Roman", serif;
    --sans: system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    --pad: 44px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size:A4; margin:0; }
  html, body { height:100%; }
  body {
    font-family:var(--sans); color:var(--ink); background:var(--ground);
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  /* Fixed A4 canvas: hero and footer pin, the body absorbs the slack. */
  .page { height:100vh; display:flex; flex-direction:column; overflow:hidden; }
  .section-title {
    font-family:var(--mono); font-size:9.5px; letter-spacing:1.6px; text-transform:uppercase;
    color:var(--accent); margin-bottom:12px; display:flex; align-items:center; gap:9px;
  }
  .section-title::after { content:""; flex:1; height:1px; background:var(--accent-line); }

  /* ── Hero band ── */
  .hero {
    position:relative; overflow:hidden; flex:0 0 auto;
    background:linear-gradient(125deg,#4338CA 0%,#5B36C9 55%,#7C3AED 100%);
    color:#fff; padding:34px var(--pad) 30px;
  }
  .hero::after {
    content:""; position:absolute; top:-60%; right:-10%; width:55%; height:220%;
    background:radial-gradient(closest-side, rgba(255,255,255,.18), rgba(255,255,255,0));
  }
  .hero-row { position:relative; z-index:1; display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  .hero-eyebrow { font-family:var(--mono); font-size:10px; letter-spacing:2.6px; text-transform:uppercase; color:rgba(255,255,255,.78); }
  .name { font-family:var(--serif); font-size:33px; font-weight:700; line-height:1.04; margin-top:11px; letter-spacing:-0.2px; }
  .subtitle { font-size:13px; color:rgba(255,255,255,.86); margin-top:8px; }
  .hero-right { display:flex; flex-direction:column; align-items:flex-end; gap:12px; flex:0 0 auto; text-align:right; }
  .company-tag { font-family:var(--mono); font-size:10px; color:rgba(255,255,255,.72); line-height:1.5; }
  .company-tag b { color:#fff; font-size:12px; }
  .resume-pill {
    display:inline-flex; align-items:center; gap:7px; text-decoration:none;
    background:#fff; color:var(--accent); font-size:12.5px; font-weight:700;
    padding:9px 16px; border-radius:999px; box-shadow:0 4px 12px rgba(20,12,60,.22);
  }

  /* ── Body: sections share leftover height evenly (gap is the floor) ── */
  .body {
    flex:1; min-height:0; padding:24px var(--pad) 22px;
    display:flex; flex-direction:column; gap:20px;
  }

  /* Metrics */
  .metrics { display:flex; gap:12px; flex:0 0 auto; }
  .tile {
    flex:1 1 0; background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--c);
    border-radius:11px; padding:14px 16px; box-shadow:0 1px 2px rgba(20,24,43,.04);
  }
  .tile-num { font-family:var(--mono); font-size:26px; font-weight:700; color:var(--c); line-height:1; }
  .tile-label { font-family:var(--mono); font-size:9.5px; letter-spacing:.8px; text-transform:uppercase; color:var(--muted); margin-top:8px; }
  /* Single stat → wide banner: number and label on one baseline. */
  .metrics-single .tile { display:flex; align-items:baseline; justify-content:space-between; padding:15px 20px; }
  .metrics-single .tile-label { margin-top:0; }

  /* Highlights — ranked cards sized to their CONTENT (a one-liner stays a
     one-liner). They may stretch a little to help fill the page, but the cap is
     deliberately low: highlights must not crowd out the evidence below them.
     Any slack left after the cap is released evenly between cards by
     space-between, so it reads as breathing room rather than a dead lump. */
  .hl { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
  .points { list-style:none; flex:1; display:flex; flex-direction:column; gap:8px; min-height:0; }
  .point {
    flex:1 1 0; min-height:46px; max-height:74px;
    display:flex; align-items:center; gap:13px;
    background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent);
    border-radius:10px; padding:9px 15px; box-shadow:0 1px 2px rgba(20,24,43,.04);
    font-size:13.2px; line-height:1.42; font-weight:500;
  }
  .pt-n {
    flex:0 0 auto; font-family:var(--mono); font-size:10.5px; font-weight:700; color:var(--accent);
    background:var(--accent-soft); border-radius:5px; padding:3px 6px; letter-spacing:.5px;
  }
  .point-text { flex:1; }

  /* Two columns — tops aligned on a shared baseline */
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:30px; align-items:start; }
  .cols-single { grid-template-columns:1fr; }
  .cols-tight { grid-template-columns:2fr 1fr; }
  .col { display:flex; flex-direction:column; gap:20px; min-width:0; }

  /* Chips */
  .chips { display:flex; flex-wrap:wrap; gap:7px; }
  .chip { font-family:var(--mono); font-size:11.5px; color:#3730A3; background:var(--accent-soft); border:1px solid var(--accent-line); padding:5px 10px; border-radius:6px; }

  /* Language bar */
  .bar { display:flex; height:14px; width:100%; border-radius:7px; overflow:hidden; background:#fff; border:1px solid var(--line); }
  .seg { height:100%; }
  .seg + .seg { border-left:1.5px solid #fff; }
  .legend { display:grid; grid-template-columns:repeat(2,1fr); gap:8px 16px; margin-top:11px; }
  .leg { font-size:11.5px; color:var(--ink); display:flex; align-items:center; gap:7px; min-width:0; }
  .leg-l { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .leg b { font-family:var(--mono); color:var(--muted); font-weight:600; }
  .dot { width:9px; height:9px; border-radius:2px; flex:0 0 auto; }

  /* Projects */
  .repos { display:flex; flex-direction:column; gap:8px; }
  .repo { display:flex; align-items:center; gap:9px; text-decoration:none; color:var(--ink);
    border:1px solid var(--line); border-radius:9px; padding:9px 12px; background:var(--panel); }
  .repo-ic { color:var(--accent); display:flex; flex:0 0 auto; }
  .repo-name { flex:1; font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .repo-arrow { color:var(--faint); display:flex; flex:0 0 auto; }
  .profiles { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .profile { display:inline-flex; align-items:center; gap:5px; text-decoration:none; font-size:11.5px; font-weight:600;
    color:var(--accent); background:var(--accent-soft); border:1px solid var(--accent-line); border-radius:6px; padding:6px 10px; }

  /* Review links — sits in normal flow, directly above the footer */
  .review { flex:0 0 auto; }
  .rcards { display:grid; gap:12px; }
  .rcard { display:flex; flex-direction:column; gap:9px; color:var(--ink);
    border:1px solid var(--line); border-radius:11px; padding:13px 14px; background:var(--panel); box-shadow:0 1px 2px rgba(20,24,43,.04); }
  .rc-main { display:flex; align-items:center; gap:11px; text-decoration:none; color:inherit; flex:1; }
  .rc-ic { flex:0 0 34px; width:34px; height:34px; border-radius:9px; background:var(--accent-soft); color:var(--accent);
    display:flex; align-items:center; justify-content:center; }

  /* Panel row — who screened the candidate, linked to their profile */
  .rc-panel { display:flex; align-items:center; gap:6px; text-decoration:none;
    border-top:1px solid var(--line); padding-top:8px; color:var(--accent); font-size:11px; font-weight:600; }
  .rc-panel-flat { color:var(--muted); }
  .rc-li { display:flex; flex:0 0 auto; color:#0A66C2; }
  .rc-panel-n { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* Credibility line above the record cards */
  .screened { display:flex; align-items:center; gap:7px; margin:-4px 0 11px;
    font-size:11px; font-weight:600; color:#3730A3;
    background:var(--accent-soft); border:1px solid var(--accent-line); border-radius:8px; padding:7px 11px; }
  .screened svg { flex:0 0 auto; color:var(--accent); }
  .rc-body { display:flex; flex-direction:column; min-width:0; flex:1; }
  .rc-title { font-size:12.8px; font-weight:700; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rc-sub { font-family:var(--mono); font-size:9px; letter-spacing:.4px; text-transform:uppercase; color:var(--muted); margin-top:3px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rc-open { font-family:var(--mono); font-size:9px; color:var(--accent); display:flex; align-items:center; gap:3px; flex:0 0 auto; }
  .rcards-3 .rc-open-t { display:none; }

  .footer { flex:0 0 auto; padding:14px var(--pad); border-top:1px solid var(--line); background:var(--panel);
    display:flex; justify-content:space-between; align-items:center;
    font-family:var(--mono); font-size:10px; color:var(--muted); }
  .footer b { color:var(--ink); }
</style>
</head>
<body>
  <div class="page">
    <header class="hero">
      <div class="hero-row">
        <div>
          <div class="hero-eyebrow">Candidate Screening Report</div>
          <div class="name">${esc(name || "Candidate")}</div>
          ${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ""}
        </div>
        <div class="hero-right">
          ${company ? `<div class="company-tag">Prepared for<br/><b>${esc(company)}</b></div>` : ""}
          ${resumePill}
        </div>
      </div>
    </header>

    <div class="body">
      ${metricsStrip}

      <section class="block hl" style="max-height:${hlMaxHeight}px">
        <div class="section-title">Top Highlights</div>
        <ul class="points">
          ${points || '<li class="point"><span class="point-text">No highlights could be extracted from the resume.</span></li>'}
        </ul>
      </section>

      ${twoCol}

      ${reviewBlock}
    </div>

    <div class="footer">
      <span><b>${company ? esc(company) + " || Nxtwave" : "NxtWave"}</b></span>
      <span>Confidential · prepared for the hiring team</span>
    </div>
  </div>
</body>
</html>`;
}
