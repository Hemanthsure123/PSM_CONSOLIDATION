import { accentFor, DocBuilder } from "@/lib/docx/kit";
import type { RsaDoc } from "@/lib/rsa/model";

/**
 * RsaDoc → .docx (converted into the Google Doc on upload) and → plain text (what an update reads
 * back). The structure is the team's RSA format: title, subtitle, header details, then Summary,
 * Area-wise Analysis (table), Key Observations, Action Plan and Remarks — bullets only.
 */

export function rsaHeaderRows(doc: RsaDoc): { label: string; value: string }[] {
  const h = doc.header;
  return [
    { label: "Candidate Name", value: h.candidateName },
    { label: "Company / Role", value: h.companyRole },
    { label: "Process", value: h.process },
    { label: "Round Attended", value: h.roundAttended },
    { label: "Result", value: h.result },
    { label: "Resume", value: h.resumeUrl },
    { label: "RSA Call Date / Prepared By", value: h.callAndPreparedBy },
  ].filter((r) => r.value);
}

export function remarkLines(doc: RsaDoc): { label: string; text: string }[] {
  const r = doc.content.remarks;
  return [
    { label: "Feedback source", text: r.feedbackSource },
    { label: "Result", text: r.result },
    { label: "Next steps", text: r.nextSteps },
    { label: "Possible reason (not confirmed)", text: r.possibleReason.replace(/^not confirmed\s*[:\-–—]\s*/i, "") },
    ...doc.teamRemarks.map((t) => ({ label: "Team remark", text: t })),
  ].filter((x) => x.text);
}

export async function renderRsaDocx(doc: RsaDoc, company: string): Promise<Buffer> {
  const b = new DocBuilder(accentFor(company));
  b.titleBlock(doc.title, doc.subtitle, "");
  b.infoTable(
    rsaHeaderRows(doc).map((r) =>
      r.label === "Resume" && /^https?:\/\//i.test(r.value) ? { label: r.label, value: [DocBuilder.link("Resume link", r.value)] } : r,
    ),
    2600,
  );
  const c = doc.content;
  b.h1("1. Summary");
  for (const s of c.summary) b.bullet(s);
  if (c.areas.length) {
    b.h1("2. Area-wise Analysis");
    b.gridTable(
      ["Area", "What Was Asked", "Gap / Performance"],
      c.areas.map((a) => [a.area, a.asked, a.note ? `${a.rating}: ${a.note}` : a.rating]),
      [2100, 3900, 3360],
    );
  }
  const n = c.areas.length ? 3 : 2;
  if (c.observations.length) {
    b.h1(`${n}. Key Observations`);
    for (const o of c.observations) b.bullet(o);
  }
  if (c.actionPlan.length) {
    b.h1(`${n + (c.observations.length ? 1 : 0)}. Action Plan`);
    for (const a of c.actionPlan) b.bullet(a);
  }
  const remarks = remarkLines(doc);
  if (remarks.length) {
    b.h1(`${n + (c.observations.length ? 1 : 0) + (c.actionPlan.length ? 1 : 0)}. Remarks`);
    for (const r of remarks) b.bullet([{ text: `${r.label}: `, bold: true }, { text: r.text }]);
  }
  return b.build(doc.fileName);
}

/** The document as plain text (an update reads the current version back). */
export function rsaText(doc: RsaDoc): string {
  const c = doc.content;
  const lines = [doc.title, doc.subtitle, ...rsaHeaderRows(doc).map((r) => `${r.label}: ${r.value}`), "", "SUMMARY", ...c.summary.map((s) => `- ${s}`)];
  if (c.areas.length) lines.push("", "AREA-WISE ANALYSIS", ...c.areas.map((a) => `- ${a.area} | ${a.asked} | ${a.rating}${a.note ? `: ${a.note}` : ""}`));
  if (c.observations.length) lines.push("", "KEY OBSERVATIONS", ...c.observations.map((s) => `- ${s}`));
  if (c.actionPlan.length) lines.push("", "ACTION PLAN", ...c.actionPlan.map((s) => `- ${s}`));
  const remarks = remarkLines(doc);
  if (remarks.length) lines.push("", "REMARKS", ...remarks.map((r) => `- ${r.label}: ${r.text}`));
  return lines.join("\n");
}
