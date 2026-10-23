import "server-only";
import { env } from "@/lib/env";
import { runTrustReview, verifyFlags } from "@/lib/trust-review";
import type { AcEvalRequest, AcGithub, AcIdentity, AcResumeItem, AcTrustReview } from "@/lib/academy/types";
import type { DsaSnapshot } from "@/lib/dsa-types";

/**
 * Academy bucketing — the trust agent. A second model, given the resume and everything
 * else known about the candidate (the sheet record, the competency interviews and the
 * interviewers' notes, what their GitHub code proves, their coding-profile numbers, how
 * the resume was read), lists the reasons the profile might not be trustworthy — each
 * with the exact words it rests on. The shared core (trust-review.ts) keeps only grounded
 * flags; they are scored in the browser (scoring.ts → trustScore).
 *
 * It leads with a different model than the resume reader, so no model checks its own
 * reading. Reused for 24 h for the same resume file and the same evidence.
 */

export { verifyFlags };

const DEFAULT_GEMINI = "gemini:gemini-3.8-flash,gemini:gemini-3.5-flash,gemini:gemini-3-flash-preview,gemini:gemini-3.6-flash,gemini:gemini-2.5-flash";
const chain = () =>
  env.academy.trustChain.trim() ||
  [DEFAULT_GEMINI, ...env.openai.models.map((m) => `openai:${m}`), "mistral:codestral-latest", "mistral:ministral-14b-latest"].join(",");

const TRUST_VERSION = 3;

const INTRO = `You are the trust reviewer for NxtWave's academy placement team. Before students are assigned to mentors and sent to companies, you check whether ONE candidate's resume and evidence can be trusted. You get the resume text and an EVIDENCE block (the placement sheet's record, competency interview results and the interviewers' notes, what the candidate's GitHub code proves, coding-profile numbers, and how the resume was read). Report the specific reasons to DISBELIEVE something in the profile. A program scores your flags — never give a score or a verdict.`;

export interface TrustInput {
  request: AcEvalRequest;
  resumeText: string;
  /** For the cache key: the resume file's content hash. */
  resumeSha: string;
  items: AcResumeItem[];
  skills: string[];
  identity: AcIdentity;
  github: AcGithub | null;
  dsa: DsaSnapshot | null;
}

/** What the agent is told besides the resume — every line is something the program already knows. */
export function trustDossier(t: TrustInput): string {
  const c = t.request;
  const lines: string[] = [];
  lines.push(`SHEET RECORD: name "${c.name || "—"}"`);
  lines.push(
    `IDENTITY CHECK (by the program): name on the resume "${t.identity.nameOnResume || "—"}" — ${t.identity.nameMatch === null ? "no name to compare" : t.identity.nameMatch ? "matches the sheet name" : "does NOT match the sheet name"}; sheet email ${t.identity.emailFound ? "found" : "not found"} in the resume; sheet mobile ${t.identity.phoneFound ? "found" : "not found"} in the resume.`,
  );
  const comps = c.context?.competencies.filter((k) => k.level || k.score !== null) ?? [];
  lines.push(`COMPETENCY INTERVIEWS: ${comps.length ? comps.map((k) => `${k.name} ${k.level || "—"}${k.score !== null ? ` (${k.score}/100)` : ""}`).join("; ") : "none"}`);
  for (const i of c.context?.interviews ?? []) {
    const bits = [
      i.status ? `status ${i.status}` : "",
      i.level ? `level ${i.level}` : "",
      i.integrityScore ? `integrity ${i.integrityScore}/5` : "",
      i.integrityNote ? `integrity note: "${i.integrityNote}"` : "",
      i.remarks ? `interviewer remarks: "${i.remarks}"` : "",
    ].filter(Boolean);
    if (bits.length) lines.push(`INTERVIEW — ${i.tab}: ${bits.join("; ")}`);
  }
  if (t.github?.status === "checked") {
    const repos = t.github.repos.map((r) => `${r.name} [${r.techs.join(", ") || "no bucket technology proven"}]${r.aiLikelihood === "high" ? " (AI-written commits detected)" : ""}`);
    lines.push(`GITHUB CODE (${t.github.profile}): ${repos.join("; ") || "no repos analysed"}`);
  } else if (t.github) {
    lines.push(`GITHUB: ${t.github.status} — ${t.github.note}`);
  }
  if (t.dsa) {
    const p = (name: string, x: DsaSnapshot["leetcode"]) => (x.url ? `${name} ${x.solved ?? "?"} solved, ${x.contests ?? "?"} contests${x.found === false ? " (profile not found)" : ""}` : "");
    const d = [p("LeetCode", t.dsa.leetcode), p("Codeforces", t.dsa.codeforces), p("CodeChef", t.dsa.codechef)].filter(Boolean);
    lines.push(`CODING PROFILES: ${d.join("; ") || "none linked"}`);
  }
  lines.push(
    `RESUME AS READ: ${t.items.map((i) => `[${i.stack}, ${i.kind}, ${i.depth}] ${i.title}${i.org ? ` @ ${i.org}` : ""}${i.techs.length ? ` — ${i.techs.join(", ")}` : ""}`).join(" | ") || "no items"}`,
  );
  return lines.join("\n");
}

/** The trust agent's review, or why there is none. Never throws. */
export function reviewTrust(t: TrustInput): Promise<{ review: AcTrustReview | null; error: string; fromCache: boolean }> {
  return runTrustReview({
    label: `academy-trust:${t.request.id.slice(0, 12)}`,
    chain: chain(),
    intro: INTRO,
    dossier: trustDossier(t),
    resumeText: t.resumeText,
    cache: { scope: "academy-trust", v: TRUST_VERSION, sha: t.resumeSha },
  });
}
