/** One ranked project as it appears in the consolidation report. */
export interface ProjectCardInput {
  rank: number;
  title: string;
  /** The project's wording as written in the candidate's resume. */
  description: string;
  tech: string[];
  candidate: string;
  github: string;
  live: string;
  /** Resume link — where this project can be seen in context. */
  resumeUrl: string;
  /** Company the candidate was placed in ("" = none). */
  placedCompany: string;
  /** CTC / pay scale of the placement, verbatim from the sheet ("" = none). */
  ctc: string;
}

export interface ProjectsReportInput {
  /** Label for this run (batch, role, or drive name). */
  runName: string;
  /** How many resumes were scanned to produce this shortlist. */
  resumesScanned: number;
  /** Total projects considered before ranking. */
  projectsConsidered: number;
  projects: ProjectCardInput[];
  /**
   * Show candidate names and resume links. Turn OFF when the report is shared
   * beyond the team: a resume carries the candidate's phone number and email.
   */
  showCandidates: boolean;
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

const ICONS = {
  github:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 2A10 10 0 0 0 8.84 21.5c.5.09.68-.22.68-.48v-1.7C6.73 19.91 6.14 18 6.14 18c-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>',
  live: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg>',
  resume:
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  placed:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-4V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M9 7V5h6v2"/></svg>',
};
const ARROW =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>';

/**
 * The projects consolidation report — a ranked shortlist of the strongest
 * projects found across every scanned resume, for one brief.
 *
 * Unlike the per-candidate screening report this document is intentionally
 * MULTI-PAGE (a top-10 will not fit on one A4), so it uses a flowing layout with
 * `break-inside: avoid` on each project so a card never splits across a page.
 * Every project carries its repo/demo links and a link back to the resume it
 * came from, so a reviewer can verify any claim in two clicks.
 */
export function buildProjectsReportHtml(input: ProjectsReportInput): string {
  const { runName, resumesScanned, projectsConsidered, projects, showCandidates } = input;

  const cards = projects
    .map((p) => {
      const placed = (p.placedCompany ?? "").trim();
      const ctc = (p.ctc ?? "").trim();
      // The placement pill — the strongest business signal on the card — carries
      // the company and its CTC, shown in both modes (neither is personal contact
      // data). CTC can also stand alone if a company name wasn't captured.
      const placedText = placed
        ? `Placed at ${esc(placed)}${ctc ? ` · ${esc(ctc)}` : ""}`
        : ctc
          ? esc(ctc)
          : "";
      const placedPill = placedText
        ? `<span class="placed">${ICONS.placed}<span>${placedText}</span></span>`
        : "";
      const links = [
        isUrl(p.github)
          ? `<a class="lnk lnk-gh" href="${esc(p.github)}">${ICONS.github}<span>GitHub</span>${ARROW}</a>`
          : "",
        isUrl(p.live)
          ? `<a class="lnk lnk-live" href="${esc(p.live)}">${ICONS.live}<span>Live demo</span>${ARROW}</a>`
          : "",
        // The resume link exposes the candidate's personal contact details, so
        // it travels only with attribution turned on.
        showCandidates && isUrl(p.resumeUrl)
          ? `<a class="lnk lnk-cv" href="${esc(p.resumeUrl)}">${ICONS.resume}<span>Resume</span>${ARROW}</a>`
          : "",
      ]
        .filter(Boolean)
        .join("");

      const chips = p.tech
        .filter(Boolean)
        .map((t) => `<span class="chip">${esc(t)}</span>`)
        .join("");

      const nameText = showCandidates && p.candidate ? `<span class="who-name">${esc(p.candidate)}</span>` : "";
      const whoRow =
        nameText || placedPill
          ? `<div class="who">${nameText}${placedPill}</div>`
          : "";

      const rankClass = p.rank <= 3 ? ` rank-top rank-${p.rank}` : "";

      return `<article class="card">
  <div class="card-top">
    <div class="rank${rankClass}">${String(p.rank).padStart(2, "0")}</div>
    <div class="card-head">
      <div class="title">${esc(p.title)}</div>
      ${whoRow}
    </div>
  </div>
  <p class="desc">${esc(p.description)}</p>
  ${chips ? `<div class="chips">${chips}</div>` : ""}
  ${links ? `<div class="links">${links}</div>` : ""}
</article>`;
    })
    .join("");

  const empty = `<div class="empty">No projects matching this brief were found in the scanned resumes.</div>`;

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
    --pad: 40px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  /* Page 1 is flush so the hero bleeds to the top edge; every later page gets a
     top/bottom margin so cards never butt against the paper edge. Side gutters
     come from element padding, so side page-margin stays 0. */
  @page { size:A4; margin:15mm 0 13mm; }
  @page :first { margin:0; }
  body {
    font-family:var(--sans); color:var(--ink); background:var(--ground);
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }

  /* ── Cover band (first page only) ── */
  .hero {
    position:relative; overflow:hidden;
    background:linear-gradient(125deg,#4338CA 0%,#5B36C9 55%,#7C3AED 100%);
    color:#fff; padding:38px var(--pad) 34px; min-height:150px;
    display:flex; align-items:center;
  }
  .hero::after {
    content:""; position:absolute; top:-60%; right:-10%; width:55%; height:220%;
    background:radial-gradient(closest-side, rgba(255,255,255,.18), rgba(255,255,255,0));
  }
  .hero-row { position:relative; z-index:1; width:100%; display:flex; justify-content:space-between; align-items:center; gap:24px; }
  .eyebrow { font-family:var(--mono); font-size:10px; letter-spacing:2.6px; text-transform:uppercase; color:rgba(255,255,255,.78); }
  .h1 { font-family:var(--serif); font-size:32px; font-weight:700; line-height:1.06; margin-top:12px; }
  .company-tag { font-family:var(--mono); font-size:10px; color:rgba(255,255,255,.72); line-height:1.6; text-align:right; flex:0 0 auto; }
  .company-tag b { color:#fff; font-size:13px; letter-spacing:.4px; }

  /* Scan summary strip */
  .stats { display:flex; gap:10px; padding:22px var(--pad) 0; }
  .stat { flex:1; background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent);
    border-radius:10px; padding:11px 14px; }
  .stat b { display:block; font-family:var(--mono); font-size:20px; color:var(--accent); line-height:1; }
  .stat i { display:block; font-style:normal; font-family:var(--mono); font-size:9px; letter-spacing:.8px;
    text-transform:uppercase; color:var(--muted); margin-top:6px; }

  .section-title {
    font-family:var(--mono); font-size:9.5px; letter-spacing:1.6px; text-transform:uppercase;
    color:var(--accent); display:flex; align-items:center; gap:9px; padding:20px var(--pad) 12px;
  }
  .section-title::after { content:""; flex:1; height:1px; background:var(--accent-line); }

  .list { padding:0 var(--pad) 26px; display:flex; flex-direction:column; gap:12px; }

  /* ── Project card — never split across pages ── */
  .card {
    background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent);
    border-radius:11px; padding:14px 16px; box-shadow:0 1px 2px rgba(20,24,43,.04);
    break-inside:avoid; page-break-inside:avoid;
  }
  .card-top { display:flex; align-items:flex-start; gap:12px; }
  .rank {
    flex:0 0 auto; font-family:var(--mono); font-size:12px; font-weight:700; color:var(--accent);
    background:var(--accent-soft); border-radius:6px; padding:5px 8px; line-height:1;
  }
  /* Rank badge — the podium gets a warm accent so the best jump out. */
  .rank-top { color:#fff; }
  .rank-1 { background:linear-gradient(135deg,#B45309,#F59E0B); }
  .rank-2 { background:linear-gradient(135deg,#57606A,#8B95A1); }
  .rank-3 { background:linear-gradient(135deg,#7C2D12,#C2703B); }

  .card-head { flex:1; min-width:0; }
  .title { font-size:15px; font-weight:700; line-height:1.3; }
  .who { margin-top:6px; display:flex; flex-wrap:wrap; align-items:center; gap:7px 10px; }
  .who-name { font-size:11.5px; font-weight:600; color:var(--muted); }
  /* Placement pill — the headline business signal (company · CTC). */
  .placed { display:inline-flex; align-items:center; gap:5px; font-size:10.5px; font-weight:700;
    color:#065F46; background:#ECFDF5; border:1px solid #A7F3D0; border-radius:999px; padding:3px 10px; }
  .placed svg { color:#059669; }

  .desc { font-size:12.4px; line-height:1.55; color:#2A2E45; margin-top:11px; }

  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
  .chip { font-family:var(--mono); font-size:10.5px; color:#3730A3; background:var(--accent-soft);
    border:1px solid var(--accent-line); padding:3px 8px; border-radius:5px; }

  .links { display:flex; flex-wrap:wrap; gap:8px; margin-top:11px; padding-top:10px; border-top:1px solid var(--line); }
  .lnk { display:inline-flex; align-items:center; gap:5px; text-decoration:none; font-size:11px; font-weight:600;
    border-radius:6px; padding:5px 9px; border:1px solid var(--line); background:var(--ground); color:var(--ink); }
  .lnk-gh { color:#1F2328; }
  .lnk-live { color:#0D9488; }
  .lnk-cv { color:var(--accent); }

  .empty { margin:0 var(--pad); padding:26px; text-align:center; color:var(--muted); font-size:13px;
    background:var(--panel); border:1px dashed var(--line); border-radius:11px; }

  .foot { padding:12px var(--pad); border-top:1px solid var(--line); background:var(--panel);
    display:flex; justify-content:space-between; font-family:var(--mono); font-size:9.5px; color:var(--muted); }
  .foot b { color:var(--ink); }
</style>
</head>
<body>
  <header class="hero">
    <div class="hero-row">
      <div>
        <div class="eyebrow">Real-world project showcase</div>
        <div class="h1">Top ${projects.length} Project${projects.length === 1 ? "" : "s"}</div>
      </div>
      ${runName ? `<div class="company-tag">Curated for<br/><b>${esc(runName)}</b></div>` : ""}
    </div>
  </header>

  <div class="stats">
    <div class="stat"><b>${resumesScanned}</b><i>resumes scanned</i></div>
    <div class="stat"><b>${projectsConsidered}</b><i>projects considered</i></div>
    <div class="stat"><b>${projects.length}</b><i>shortlisted</i></div>
  </div>

  <div class="section-title">Ranked shortlist</div>
  ${projects.length ? `<div class="list">${cards}</div>` : empty}

  <div class="foot">
    <span><b>NxtWave${runName ? ` · ${esc(runName)}` : ""}</b></span>
    <span>${
      showCandidates
        ? "Internal · contains candidate names &amp; resume links"
        : "Descriptions quoted verbatim from real candidate resumes"
    }</span>
  </div>
</body>
</html>`;
}
