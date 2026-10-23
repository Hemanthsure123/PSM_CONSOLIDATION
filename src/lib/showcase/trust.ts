import "server-only";
import { env } from "@/lib/env";
import { runTrustReview } from "@/lib/trust-review";
import { identityCheck } from "@/lib/academy/evaluator";
import { resumeText } from "@/lib/showcase/reader";
import { SP_VERSIONS, type SpTrust } from "@/lib/showcase/types";
import type { AcIdentity } from "@/lib/academy/types";

/**
 * Sample profiles — the trust agent for one finalist (shared core: trust-review.ts). The evidence
 * block is what the program already established: the sheet record and whether the resume carries
 * its email / mobile, the DSA profiles with their owners, the GitHub account and what each flagship
 * repo proves (own commits, AI signatures), the jobs as read. Leads with a different model than
 * the resume reader. Never throws.
 */

const DEFAULT_GEMINI = "gemini:gemini-3.8-flash,gemini:gemini-3.5-flash,gemini:gemini-3-flash-preview,gemini:gemini-3.6-flash,gemini:gemini-2.5-flash";
const chain = () =>
  env.showcase.trustChain.trim() ||
  [DEFAULT_GEMINI, ...env.openai.models.map((m) => `openai:${m}`), "mistral:codestral-latest", "mistral:ministral-14b-latest"].join(",");

const INTRO = `You are the trust reviewer for NxtWave's placement team. Before a student is shown to a company's hiring manager as a SAMPLE PROFILE — only the strongest students are shown — you check whether ONE candidate's resume and evidence can be trusted. You get the resume text and an EVIDENCE block (the placement sheet's record and the program's identity check, the candidate's coding profiles with their numbers and owners' names, what their GitHub repositories prove including who wrote the commits, and how the resume was read). Report the specific reasons to DISBELIEVE something in the profile. A program scores your flags — never give a score or a verdict.`;

export interface TrustRequest {
  id: string;
  name: string;
  email: string;
  mobile: string;
  resumeUrl: string;
  nameOnResume: string;
  /** One line per DSA platform ("Codeforces max rating 1620 · 14 contests · 310 solved — owner name matches"). */
  dsaLines: string[];
  github: { login: string; profileName: string };
  /** One line per flagship project with its proof ("Ledger API [backend] — repo x: 42 own commits over 18 days, proves Node.js, PostgreSQL"). */
  projectLines: string[];
  jobLines: string[];
}

export async function trustCandidate(r: TrustRequest): Promise<SpTrust & { identity: AcIdentity | null }> {
  const fail = (error: string, retryable: boolean) => ({ id: r.id, review: null, error, retryable, version: SP_VERSIONS.trust, identity: null });
  try {
    const got = await resumeText(r.resumeUrl, r.id);
    if (!got.ok) return fail(got.error, got.retryable);
    const identity = identityCheck({ name: r.name, email: r.email, mobile: r.mobile }, got.text, r.nameOnResume);
    const dossier = [
      `SHEET RECORD: name "${r.name || "—"}"`,
      `IDENTITY CHECK (by the program): name on the resume "${identity.nameOnResume || "—"}" — ${identity.nameMatch === null ? "no name to compare" : identity.nameMatch ? "matches the sheet name" : "does NOT match the sheet name"}; sheet email ${identity.emailFound ? "found" : "not found"} in the resume; sheet mobile ${identity.phoneFound ? "found" : "not found"} in the resume.`,
      `CODING PROFILES: ${r.dsaLines.join("; ") || "none"}`,
      `GITHUB ACCOUNT: ${r.github.login || "—"}${r.github.profileName ? ` (profile name "${r.github.profileName}")` : ""}`,
      ...r.projectLines.map((l) => `PROJECT: ${l}`),
      ...r.jobLines.map((l) => `JOB AS READ: ${l}`),
    ].join("\n");
    const out = await runTrustReview({
      label: `showcase-trust:${r.id.slice(0, 16)}`,
      chain: chain(),
      intro: INTRO,
      dossier,
      resumeText: got.text,
      cache: { scope: "showcase-trust", v: SP_VERSIONS.trust, sha: got.sha },
    });
    return { id: r.id, review: out.review, error: out.error, retryable: Boolean(out.error), version: SP_VERSIONS.trust, identity };
  } catch (err) {
    return fail(err instanceof Error ? err.message.slice(0, 200) : "Trust review failed.", true);
  }
}
