import { accentFor, DocBuilder } from "@/lib/docx/kit";
import type { PrepDoc } from "@/lib/prepdocs/model";

/**
 * PrepDoc → .docx with the master prompt's exact visual specification (§7: Letter page, Calibri /
 * Cambria, one accent per company, INFO / GRID tables, callout boxes, one bullet level), converted
 * into the Google Doc on upload; → Notion blocks; → plain text (an update reads it back). The fixed
 * order (§6): title block, overview, START HERE, [About], numbered sections, checklist, IN SHORT,
 * [sources].
 */

export async function renderDocx(doc: PrepDoc, company: string): Promise<Buffer> {
  const b = new DocBuilder(accentFor(company));
  b.titleBlock(doc.title, doc.subtitle, doc.sourceLine);
  b.infoTable(doc.overview);
  if (doc.startHere.length) {
    b.spacer(100);
    b.box("START HERE — read this first", doc.startHere, "info");
  }
  if (doc.aboutCompany.length) {
    b.h1(`About ${company}`);
    for (const x of doc.aboutCompany) b.bullet(x);
  }
  let n = 0;
  for (const s of doc.sections) {
    b.h1(`${++n}. ${s.title}`, s.tag || undefined);
    if (s.intro) b.para(s.intro);
    if (s.topics.length) {
      b.h2("Topics to prepare");
      for (const t of s.topics) b.topic(t.name, t.revise);
    }
    if (s.grid) {
      b.spacer(60);
      b.gridTable(s.grid.header, s.grid.rows);
    }
    if (s.asked.length) {
      b.h2("Questions asked in real interviews");
      for (const q of s.asked) b.bullet(q);
    }
    if (s.practise.length) {
      b.h2("Questions to practise");
      for (const q of s.practise) b.bullet(q);
    }
    if (s.box) {
      b.spacer(100);
      b.box(s.box.label, s.box.body, "warn");
    }
  }
  const c = doc.checklist;
  if (c.before.length || c.during.length) {
    b.h1(`${++n}. Checklist`);
    if (c.before.length) {
      b.h2(c.beforeHeading);
      c.before.forEach((x, i) => b.numbered(i + 1, x));
    }
    if (c.during.length) {
      b.h2(c.duringHeading);
      c.during.forEach((x, i) => b.numbered(i + 1, x));
    }
  }
  if (doc.inShort) {
    b.spacer(110);
    b.box("IN SHORT", [doc.inShort], "info");
  }
  if (doc.sources.length) {
    b.spacer(90);
    b.links("Sources: ", doc.sources.map((s) => ({ label: s.title, url: s.url })));
  }
  return b.build(`${doc.title} ${doc.subtitle}`.trim());
}

/** Plain text of a document (for updates the model reads the current version). */
export function renderText(doc: PrepDoc): string {
  const lines: string[] = [doc.title, doc.subtitle, doc.sourceLine, ""];
  for (const r of doc.overview) lines.push(`${r.label}: ${r.value}`);
  if (doc.startHere.length) lines.push("", "START HERE", ...doc.startHere);
  if (doc.aboutCompany.length) lines.push("", "ABOUT THE COMPANY", ...doc.aboutCompany.map((b) => `- ${b}`));
  doc.sections.forEach((s, i) => {
    lines.push("", `${i + 1}. ${s.title.toUpperCase()}${s.tag ? `   ${s.tag}` : ""}`, s.intro);
    if (s.topics.length) lines.push("Topics to prepare:", ...s.topics.map((t) => `- ${t.name} — ${t.revise}`));
    if (s.grid) lines.push(s.grid.header.join(" | "), ...s.grid.rows.map((r) => r.join(" | ")));
    if (s.asked.length) lines.push("Questions asked in real interviews:", ...s.asked.map((q) => `- ${q}`));
    if (s.practise.length) lines.push("Questions to practise:", ...s.practise.map((q) => `- ${q}`));
    if (s.box) lines.push(`${s.box.label}: ${s.box.body.join(" ")}`);
  });
  if (doc.checklist.before.length) lines.push("", doc.checklist.beforeHeading.toUpperCase(), ...doc.checklist.before.map((c, i) => `${i + 1}. ${c}`));
  if (doc.checklist.during.length) lines.push("", doc.checklist.duringHeading.toUpperCase(), ...doc.checklist.during.map((c, i) => `${i + 1}. ${c}`));
  if (doc.inShort) lines.push("", "IN SHORT", doc.inShort);
  if (doc.sources.length) lines.push("", `Sources: ${doc.sources.map((s) => `${s.title} (${s.url})`).join(" · ")}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ── Notion ───────────────────────────────────────────────────────────────────

type RichText = { type: "text"; text: { content: string; link?: { url: string } | null }; annotations?: Record<string, boolean | string> };
export type NotionBlock = Record<string, unknown>;

/** Notion caps a rich-text item at 2,000 characters. */
const rt = (content: string, opts: { bold?: boolean; italic?: boolean; url?: string; color?: string } = {}): RichText[] => {
  const chunks: RichText[] = [];
  for (let i = 0; i < content.length || i === 0; i += 1900) {
    chunks.push({
      type: "text",
      text: { content: content.slice(i, i + 1900), ...(opts.url ? { link: { url: opts.url } } : {}) },
      ...(opts.bold || opts.italic || opts.color ? { annotations: { bold: Boolean(opts.bold), italic: Boolean(opts.italic), ...(opts.color ? { color: opts.color } : {}) } } : {}),
    });
    if (!content) break;
  }
  return chunks;
};
const para = (texts: RichText[]): NotionBlock => ({ object: "block", type: "paragraph", paragraph: { rich_text: texts } });
const h2 = (t: RichText[]): NotionBlock => ({ object: "block", type: "heading_2", heading_2: { rich_text: t } });
const h3 = (t: string): NotionBlock => ({ object: "block", type: "heading_3", heading_3: { rich_text: rt(t) } });
const bullet = (texts: RichText[]): NotionBlock => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: texts } });
const numbered = (t: string): NotionBlock => ({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: rt(t) } });
const callout = (texts: RichText[], color: string): NotionBlock => ({ object: "block", type: "callout", callout: { rich_text: texts, color, icon: null } });
const table = (rows: RichText[][][], width: number, header: boolean): NotionBlock => ({
  object: "block",
  type: "table",
  table: {
    table_width: width,
    has_column_header: header,
    has_row_header: !header,
    children: rows.map((cells) => ({ object: "block", type: "table_row", table_row: { cells } })),
  },
});

export function renderNotionBlocks(doc: PrepDoc): NotionBlock[] {
  const b: NotionBlock[] = [];
  if (doc.subtitle) b.push(para(rt(doc.subtitle)));
  if (doc.sourceLine) b.push(para(rt(doc.sourceLine, { italic: true, color: "gray" })));
  if (doc.overview.length) b.push(table(doc.overview.map((r) => [rt(r.label, { bold: true }), rt(r.value)]), 2, false));
  if (doc.startHere.length) b.push(callout([...rt("START HERE — read this first\n", { bold: true }), ...rt(doc.startHere.join("\n"))], "blue_background"));
  if (doc.aboutCompany.length) {
    b.push(h2(rt("About the company")));
    for (const x of doc.aboutCompany) b.push(bullet(rt(x)));
  }
  doc.sections.forEach((s, i) => {
    b.push(h2([...rt(`${i + 1}. ${s.title}`), ...(s.tag ? rt(`   ${s.tag}`, { color: "orange" }) : [])]));
    if (s.intro) b.push(para(rt(s.intro)));
    if (s.topics.length) {
      b.push(h3("Topics to prepare"));
      for (const t of s.topics) b.push(bullet([...rt(t.name, { bold: true }), ...rt(t.revise ? ` — ${t.revise}` : "")]));
    }
    if (s.grid) b.push(table([s.grid.header.map((h) => rt(h, { bold: true })), ...s.grid.rows.map((r) => s.grid!.header.map((_, k) => rt(r[k] ?? "")))], s.grid.header.length, true));
    if (s.asked.length) {
      b.push(h3("Questions asked in real interviews"));
      for (const q of s.asked) b.push(bullet(rt(q)));
    }
    if (s.practise.length) {
      b.push(h3("Questions to practise"));
      for (const q of s.practise) b.push(bullet(rt(q)));
    }
    if (s.box) b.push(callout([...rt(`${s.box.label}\n`, { bold: true }), ...rt(s.box.body.join("\n"))], "yellow_background"));
  });
  const c = doc.checklist;
  if (c.before.length || c.during.length) {
    b.push(h2(rt(`${doc.sections.length + 1}. Checklist`)));
    if (c.before.length) {
      b.push(h3(c.beforeHeading));
      for (const x of c.before) b.push(numbered(x));
    }
    if (c.during.length) {
      b.push(h3(c.duringHeading));
      for (const x of c.during) b.push(numbered(x));
    }
  }
  if (doc.inShort) b.push(callout([...rt("IN SHORT\n", { bold: true }), ...rt(doc.inShort)], "blue_background"));
  if (doc.sources.length) b.push(para([...rt("Sources: "), ...doc.sources.flatMap((s, i) => [...(i ? rt(" · ") : []), ...rt(s.title, { url: s.url })])]));
  return b;
}
