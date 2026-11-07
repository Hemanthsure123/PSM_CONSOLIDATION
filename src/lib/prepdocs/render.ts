import type { PrepDoc } from "@/lib/prepdocs/model";

/**
 * PrepDoc → a Google Doc (HTML that Drive converts on upload) and → Notion blocks. Pure.
 * Layout follows the team prompt: title, italic subtitle, overview table, callouts, topic
 * sections with 2-column tables when there are 5+ subtopics, checklists and a summary callout.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const CALLOUT = (bg: string, border: string, inner: string) =>
  `<table style="border-collapse:collapse;width:100%;margin:8pt 0"><tr><td style="background:${bg};border-left:4pt solid ${border};padding:8pt 10pt">${inner}</td></tr></table>`;

/** "**Name** — what to revise" as HTML. */
const topicLine = (name: string, revise: string) => `<b>${esc(name)}</b> — ${esc(revise)}`;

export function renderHtml(doc: PrepDoc): string {
  const out: string[] = [];
  out.push(`<html><head><meta charset="utf-8"><title>${esc(doc.title)}</title></head><body style="font-family:Arial;font-size:11pt;line-height:1.35">`);
  out.push(`<h1 style="font-size:20pt">${esc(doc.title)}</h1>`);
  if (doc.subtitle) out.push(`<p><i>${esc(doc.subtitle)}</i></p>`);

  if (doc.overview.length || doc.links.length) {
    const rows = doc.overview.map((r) => `<tr><td style="border:1px solid #c9d1dd;padding:5pt;width:30%"><b>${esc(r.label)}</b></td><td style="border:1px solid #c9d1dd;padding:5pt">${esc(r.value)}</td></tr>`);
    if (doc.links.length) {
      rows.push(`<tr><td style="border:1px solid #c9d1dd;padding:5pt"><b>Links</b></td><td style="border:1px solid #c9d1dd;padding:5pt">${doc.links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(" | ")}</td></tr>`);
    }
    out.push(`<h2>Overview</h2><table style="border-collapse:collapse;width:100%">${rows.join("")}</table>`);
  }

  if (doc.startHere.length) {
    out.push(`<h2>Start here</h2>`);
    out.push(CALLOUT("#fff7e0", "#e0a400", doc.startHere.map((l) => `<p style="margin:2pt 0">${esc(l)}</p>`).join("")));
  }

  if (doc.aboutCompany.length || doc.whyItMatters || doc.sayAloud) {
    out.push(`<h2>About the company</h2><ul>`);
    for (const b of doc.aboutCompany) out.push(`<li>${esc(b)}</li>`);
    if (doc.whyItMatters) out.push(`<li><b>Why this matters for this role</b> — ${esc(doc.whyItMatters)}</li>`);
    out.push(`</ul>`);
    if (doc.sayAloud) out.push(`<p><b>Say it in one line:</b> <i>${esc(doc.sayAloud)}</i></p>`);
  }

  for (const s of doc.sections) {
    out.push(`<h2>${esc(s.title)}${s.tags.length ? ` <span style="font-size:9pt;color:#9a5b00">[${s.tags.map(esc).join("] [")}]</span>` : ""}</h2>`);
    if (s.why) out.push(`<p>${esc(s.why)}</p>`);
    if (s.topics.length) {
      out.push(`<h3>Topics to prepare</h3>`);
      if (s.topics.length >= 5) {
        out.push(`<table style="border-collapse:collapse;width:100%">${s.topics.map((t) => `<tr><td style="border:1px solid #c9d1dd;padding:5pt;width:32%"><b>${esc(t.name)}</b></td><td style="border:1px solid #c9d1dd;padding:5pt">${esc(t.revise)}</td></tr>`).join("")}</table>`);
      } else {
        out.push(`<ul>${s.topics.map((t) => `<li>${topicLine(t.name, t.revise)}</li>`).join("")}</ul>`);
      }
    }
    if (s.method.length) out.push(`<h3>How to approach it</h3><ol>${s.method.map((m) => `<li>${esc(m)}</li>`).join("")}</ol>`);
    if (s.questions.length) {
      out.push(`<h3>${s.questionsKind === "asked" ? "Questions asked in real interviews" : "Questions to practise"}</h3>`);
      if (s.questionsKind === "practise") out.push(`<p><i>No real questions were reported for this section yet. Practise these.</i></p>`);
      out.push(`<ul>${s.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`);
    }
    if (s.callout) {
      const priority = s.callout.kind === "priority";
      out.push(CALLOUT(priority ? "#fdedeb" : "#ebf1fe", priority ? "#c8372d" : "#1f57e0", `<p style="margin:0"><b>${priority ? "Priority area" : "What to keep in mind"}:</b> ${esc(s.callout.text)}</p>`));
    }
  }

  if (doc.checklistBefore.length || doc.checklistDuring.length) {
    out.push(`<h2>Checklist</h2>`);
    if (doc.checklistBefore.length) out.push(`<h3>Before the interview</h3><ul>${doc.checklistBefore.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`);
    if (doc.checklistDuring.length) out.push(`<h3>In the interview</h3><ul>${doc.checklistDuring.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`);
  }
  if (doc.summary) {
    out.push(`<h2>Summary</h2>`);
    out.push(CALLOUT("#e8f6ef", "#0f7b55", `<p style="margin:0">${esc(doc.summary)}</p>`));
  }
  out.push(`</body></html>`);
  return out.join("\n");
}

/** Plain text of a document (for updates the model reads the current version). */
export function renderText(doc: PrepDoc): string {
  const lines: string[] = [doc.title, doc.subtitle, ""];
  for (const r of doc.overview) lines.push(`${r.label}: ${r.value}`);
  if (doc.startHere.length) lines.push("", "START HERE", ...doc.startHere);
  if (doc.aboutCompany.length) lines.push("", "ABOUT THE COMPANY", ...doc.aboutCompany.map((b) => `- ${b}`), doc.whyItMatters ? `- Why this matters: ${doc.whyItMatters}` : "", doc.sayAloud);
  for (const s of doc.sections) {
    lines.push("", `${s.title.toUpperCase()}${s.tags.length ? ` [${s.tags.join(", ")}]` : ""}`, s.why);
    for (const t of s.topics) lines.push(`- ${t.name} — ${t.revise}`);
    s.method.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
    if (s.questions.length) lines.push(s.questionsKind === "asked" ? "Questions asked in real interviews:" : "Questions to practise:", ...s.questions.map((q) => `- ${q}`));
    if (s.callout) lines.push(`${s.callout.kind === "priority" ? "Priority area" : "What to keep in mind"}: ${s.callout.text}`);
  }
  if (doc.checklistBefore.length) lines.push("", "BEFORE THE INTERVIEW", ...doc.checklistBefore.map((c) => `- ${c}`));
  if (doc.checklistDuring.length) lines.push("", "IN THE INTERVIEW", ...doc.checklistDuring.map((c) => `- ${c}`));
  if (doc.summary) lines.push("", "SUMMARY", doc.summary);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ── Notion ───────────────────────────────────────────────────────────────────

type RichText = { type: "text"; text: { content: string; link?: { url: string } | null }; annotations?: Record<string, boolean> };
export type NotionBlock = Record<string, unknown>;

/** Notion caps a rich-text item at 2,000 characters. */
const rt = (content: string, opts: { bold?: boolean; italic?: boolean; url?: string } = {}): RichText[] => {
  const chunks: RichText[] = [];
  for (let i = 0; i < content.length || i === 0; i += 1900) {
    chunks.push({
      type: "text",
      text: { content: content.slice(i, i + 1900), ...(opts.url ? { link: { url: opts.url } } : {}) },
      ...(opts.bold || opts.italic ? { annotations: { bold: Boolean(opts.bold), italic: Boolean(opts.italic) } } : {}),
    });
    if (!content) break;
  }
  return chunks;
};
const para = (texts: RichText[]): NotionBlock => ({ object: "block", type: "paragraph", paragraph: { rich_text: texts } });
const h2 = (t: string): NotionBlock => ({ object: "block", type: "heading_2", heading_2: { rich_text: rt(t) } });
const h3 = (t: string): NotionBlock => ({ object: "block", type: "heading_3", heading_3: { rich_text: rt(t) } });
const bullet = (texts: RichText[]): NotionBlock => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: texts } });
const numbered = (t: string): NotionBlock => ({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: rt(t) } });
const callout = (texts: RichText[], color: string): NotionBlock => ({ object: "block", type: "callout", callout: { rich_text: texts, color, icon: null } });
const table = (rows: RichText[][][]): NotionBlock => ({
  object: "block",
  type: "table",
  table: {
    table_width: 2,
    has_column_header: false,
    has_row_header: true,
    children: rows.map((cells) => ({ object: "block", type: "table_row", table_row: { cells } })),
  },
});

export function renderNotionBlocks(doc: PrepDoc): NotionBlock[] {
  const b: NotionBlock[] = [];
  if (doc.subtitle) b.push(para(rt(doc.subtitle, { italic: true })));
  if (doc.overview.length || doc.links.length) {
    b.push(h2("Overview"));
    const rows = doc.overview.map((r) => [rt(r.label, { bold: true }), rt(r.value)]);
    if (doc.links.length) rows.push([rt("Links", { bold: true }), doc.links.flatMap((l, i) => [...(i ? rt(" | ") : []), ...rt(l.label, { url: l.url })])]);
    b.push(table(rows));
  }
  if (doc.startHere.length) {
    b.push(h2("Start here"));
    b.push(callout(rt(doc.startHere.join("\n")), "yellow_background"));
  }
  if (doc.aboutCompany.length || doc.whyItMatters || doc.sayAloud) {
    b.push(h2("About the company"));
    for (const x of doc.aboutCompany) b.push(bullet(rt(x)));
    if (doc.whyItMatters) b.push(bullet([...rt("Why this matters for this role", { bold: true }), ...rt(` — ${doc.whyItMatters}`)]));
    if (doc.sayAloud) b.push(para([...rt("Say it in one line: ", { bold: true }), ...rt(doc.sayAloud, { italic: true })]));
  }
  for (const s of doc.sections) {
    b.push(h2(`${s.title}${s.tags.length ? ` [${s.tags.join("] [")}]` : ""}`));
    if (s.why) b.push(para(rt(s.why)));
    if (s.topics.length) {
      b.push(h3("Topics to prepare"));
      if (s.topics.length >= 5) b.push(table(s.topics.map((t) => [rt(t.name, { bold: true }), rt(t.revise)])));
      else for (const t of s.topics) b.push(bullet([...rt(t.name, { bold: true }), ...rt(` — ${t.revise}`)]));
    }
    if (s.method.length) {
      b.push(h3("How to approach it"));
      for (const m of s.method) b.push(numbered(m));
    }
    if (s.questions.length) {
      b.push(h3(s.questionsKind === "asked" ? "Questions asked in real interviews" : "Questions to practise"));
      if (s.questionsKind === "practise") b.push(para(rt("No real questions were reported for this section yet. Practise these.", { italic: true })));
      for (const q of s.questions) b.push(bullet(rt(q)));
    }
    if (s.callout) {
      const priority = s.callout.kind === "priority";
      b.push(callout([...rt(priority ? "Priority area: " : "What to keep in mind: ", { bold: true }), ...rt(s.callout.text)], priority ? "red_background" : "blue_background"));
    }
  }
  if (doc.checklistBefore.length || doc.checklistDuring.length) {
    b.push(h2("Checklist"));
    if (doc.checklistBefore.length) {
      b.push(h3("Before the interview"));
      for (const c of doc.checklistBefore) b.push(bullet(rt(c)));
    }
    if (doc.checklistDuring.length) {
      b.push(h3("In the interview"));
      for (const c of doc.checklistDuring) b.push(bullet(rt(c)));
    }
  }
  if (doc.summary) {
    b.push(h2("Summary"));
    b.push(callout(rt(doc.summary), "green_background"));
  }
  return b;
}
