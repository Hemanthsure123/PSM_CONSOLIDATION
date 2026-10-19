import "server-only";
import { BUCKET_RULE, BUCKETS, DOMAIN_LABEL, OTHER_DOMAINS } from "@/lib/bucketing/config";
import type { Extraction, ProjectEvidence, TraceEntry } from "@/lib/bucketing/types";

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
  return lines.join("\n") || "(no projects, experience or open-source items)";
}

export const DOMAIN_GUIDE = [
  "The five buckets — always score all five:",
  ...BUCKETS.map((b) => `  ${b} (${DOMAIN_LABEL[b]}): ${BUCKET_RULE[b]}`),
  "Other domains — score only the ones the evidence shows:",
  `  ${OTHER_DOMAINS.map((d) => `${d} (${DOMAIN_LABEL[d]})`).join(", ")}.`,
  "  AIML = classic ML / deep learning / CV / NLP models; DATA_ANALYTICS = analysis, dashboards, SQL / Excel / Power BI / Tableau.",
].join("\n");

export const RUBRIC = `RUBRIC (0-100)
- 90-100: two or more substantial projects in the domain AND an in-domain internship / job.
- 70-89: one strong flagship project plus another project or an internship in the domain.
- 50-69: one decent, non-trivial project in the domain.
- 30-49: tutorial-level / toy work only (clones, CRUD demos, course exercises).
- 1-29: the domain is only touched in passing.
- 0: no evidence item shows it.
An internship / job in the domain is the strongest single signal; a merged open-source contribution counts like a good project. Depth matters: auth, real data, deployment, integrations, scale or measurable outcomes lift a project; a static page or a to-do app does not.`;

export function traceEntry(node: string, t0: number, decision: string, model?: string): { trace: TraceEntry[] } {
  return { trace: [{ node, ms: Date.now() - t0, model, decision }] };
}
