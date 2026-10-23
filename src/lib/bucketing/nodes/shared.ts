import "server-only";
import { BUCKET_RULE, BUCKETS, DOMAIN_LABEL, OTHER_DOMAINS, TRACK_LABEL, VERDICT_LABEL } from "@/lib/bucketing/config";
import type { BucketingCandidateInput, Extraction, ProjectEvidence, TraceEntry } from "@/lib/bucketing/types";

/** The verified evidence items as the agents see them — no skills list, no summary, no name or contact. */
export function evidenceItems(x: Extraction, evidence?: ProjectEvidence[]): string {
  const ev = new Map((evidence ?? []).map((e) => [e.projectId, e]));
  const lines: string[] = [];
  for (const p of x.projects) {
    const e = ev.get(p.id);
    const links = [
      p.github.length ? `GitHub linked (${p.github.length})` : "no GitHub link",
      p.live.length ? "demo link" : "",
    ]
      .filter(Boolean)
      .join(", ");
    const verified = e
      ? ` | VERIFIED: tier ${e.tier}${e.valid ? "" : ` — INVALID (${e.invalidReason ?? e.status})`}` +
        (e.techKeys.length ? `; code proves: ${e.techKeys.join(", ")}` : "") +
        (e.buckets.length ? `; bucket rules met: ${e.buckets.join(", ")}` : "; no bucket rule met") +
        (e.demo && e.demo.status !== "none" ? `; demo ${e.demo.status}` : "")
      : "";
    lines.push(
      `${p.id} · PROJECT · "${p.title}"${p.period ? ` (${p.period})` : ""} — ${p.description || p.quote}` +
        (p.claimedTech.length ? ` | tech named: ${p.claimedTech.join(", ")}` : "") +
        ` | ${links}${verified}`,
    );
  }
  for (const e of x.experience) {
    lines.push(
      `${e.id} · ${e.kind.toUpperCase()} · ${e.role || "role not stated"} at ${e.company || "company not stated"}` +
        (e.months !== null ? ` · ${e.months} month(s)` : e.duration ? ` · ${e.duration}` : "") +
        ` — ${e.description || e.quote}` +
        (e.tech.length ? ` | tech named: ${e.tech.join(", ")}` : ""),
    );
  }
  for (const o of x.openSource) lines.push(`${o.id} · OPEN SOURCE · "${o.title}" — ${o.description || o.quote}`);
  for (const a of x.achievements ?? []) lines.push(`${a.id} · ACHIEVEMENT (${a.kind}) · "${a.title}" — ${a.description || a.quote}`);
  return lines.join("\n") || "(no projects, experience, open-source or achievement items)";
}

/** The candidate's internal assessments in one block — the strongest signal, ahead of everything on the resume. */
export function interviewLines(c: BucketingCandidateInput): string {
  const iv = c.interview;
  if (!iv) return c.stage === "TR2" && c.track ? `TR-2 cleared in the ${TRACK_LABEL[c.track]} track.` : `Highest stage: ${c.stage}.`;
  const out: string[] = [];
  if (iv.tr2.length) out.push(`TR-2 hire verdicts: ${iv.tr2.map((t) => `${TRACK_LABEL[t.track]} — ${VERDICT_LABEL[t.verdict]}`).join("; ")}`);
  if (iv.combined) out.push(`Combined interview (no track): ${VERDICT_LABEL[iv.combined]}`);
  if (iv.tr2Rejected.length) out.push(`TR-2 rejected in: ${iv.tr2Rejected.map((t) => TRACK_LABEL[t]).join(", ")}`);
  if (iv.tr1.overallTechnical !== null || iv.tr1.status) {
    out.push(`TR-1: ${iv.tr1.status || "taken"}${iv.tr1.overallTechnical !== null ? `, technical score ${iv.tr1.overallTechnical}/100` : ""}`);
  }
  const a = iv.assessment;
  if (a.offlineOverall !== null) out.push(`Assessment: ${a.offlineOverall}/160 (DSA coding ${a.dsaCoding ?? "?"}/120, CS fundamentals ${a.csFundamentals ?? "?"}/40)`);
  if (a.sqlMcq !== null || a.sqlCoding !== null) out.push(`SQL: MCQ ${a.sqlMcq ?? "?"}/15, coding ${a.sqlCoding ?? "?"}/15`);
  return out.join("\n") || "No interview results.";
}

export const DOMAIN_GUIDE = [
  "The six buckets — always score all six:",
  ...BUCKETS.map((b) => `  ${b} (${DOMAIN_LABEL[b]}): ${BUCKET_RULE[b]}`),
  "Other domains — score only the ones the evidence shows:",
  `  ${OTHER_DOMAINS.map((d) => `${d} (${DOMAIN_LABEL[d]})`).join(", ")}.`,
  "  DSML = classic ML / deep learning / CV / NLP models (notebook work counts); DATA_ANALYTICS = analysis, dashboards, SQL / Excel / Power BI / Tableau; FRONTEND = UI work with no backend of its own.",
].join("\n");

export const RUBRIC = `RUBRIC (0-100)
- 90-100: two or more substantial projects in the domain AND an in-domain internship / job.
- 70-89: one strong flagship project plus another project or an internship in the domain.
- 50-69: one decent, non-trivial project in the domain.
- 30-49: tutorial-level / toy work only (clones, CRUD demos, course exercises).
- 1-29: the domain is only touched in passing.
- 0: no evidence item shows it.
An internship / job in the domain is the strongest single signal; a merged open-source contribution counts like a good project; an achievement (hackathon win, rank, publication) in the domain is a small plus, never the main evidence. Depth matters: auth, real data, deployment, integrations, scale or measurable outcomes lift a project; a static page or a to-do app does not.`;

export function traceEntry(node: string, t0: number, decision: string, model?: string): { trace: TraceEntry[] } {
  return { trace: [{ node, ms: Date.now() - t0, model, decision }] };
}
