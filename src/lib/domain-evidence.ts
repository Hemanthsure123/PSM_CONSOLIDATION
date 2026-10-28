import { inText, loose, textCtx, type TextCtx } from "@/lib/qa-verify";
import type { DomainProof } from "@/lib/types";

/**
 * Domain Shortlisting — keeping the model honest (pure, tested in
 * scripts/domain-csv-selftest.ts). The domain score, the core skills and the evidence come
 * from a model; before they are used, they are checked against the resume's EVIDENCE text —
 * its projects, experience, certifications and achievements (hackathons, contests, research),
 * with the Skills list and the profile summary taken out (resume-sections.ts):
 *  - a core skill counts only when the model's quote for it is really in that text and the
 *    skill itself is named there;
 *  - a domain score needs quoted evidence: none at all caps it at 35 (below every bar), only
 *    certifications at 50, a single piece of evidence keeps it under 80;
 *  - a fit whose skills are all only in the Skills list / summary is capped at 35.
 * Plus the GitHub identity check: a GitHub account that clearly belongs to someone else
 * doesn't count.
 */

/** Below every shortlisting bar (40 for internally assessed candidates). */
export const UNGROUNDED_CAP = 35;
/** Certifications alone can't make a domain fit (55). */
export const CERTIFICATION_ONLY_CAP = 50;
/** 80+ (a strong fit) needs at least two pieces of quoted evidence. */
export const SINGLE_EVIDENCE_CAP = 79;

/**
 * A skill is named in a text — written out ("Jetpack Compose"), squeezed ("jetpackcompose"),
 * or with at least half of its words present ("State Management" ← "managed app state").
 */
export function skillInResume(skill: string, text: string, ctx: TextCtx = textCtx(text)): boolean {
  if (inText(skill, ctx) || ctx.loose.includes(loose(skill))) return true;
  const words = skill.toLowerCase().match(/[a-z0-9+#]{3,}/g) ?? [];
  if (!words.length) return false;
  const lower = text.toLowerCase();
  return words.filter((w) => lower.includes(w)).length / words.length >= 0.5;
}

export interface FitToGround {
  domainScore: number;
  coreSkills: string[];
  /** The model's quote per core skill (parallel to coreSkills; "" = none given). */
  skillQuotes: string[];
  proofs: DomainProof[];
}

export interface GroundedFit {
  domainScore: number;
  /** The model's score before any cap. */
  rawScore: number;
  coreSkills: string[];
  /** The quotes that held up (evidence for the report and the CSV's Signals). */
  proofs: DomainProof[];
  /** Why the score was lowered ("" = not lowered). */
  capped: string;
}

/** Check a model's domain fit against the resume's evidence text (Skills list and summary already removed). */
export function groundDomainFit(fit: FitToGround, evidence: string, opts: { sectionsRemoved: boolean }): GroundedFit {
  const ctx = textCtx(evidence);
  const kept: string[] = [];
  const skillProofs: DomainProof[] = [];
  let named = 0;
  fit.coreSkills.forEach((skill, i) => {
    const quote = (fit.skillQuotes[i] ?? "").trim();
    if (!skillInResume(skill, evidence, ctx)) return;
    named++;
    if (quote) {
      if (!inText(quote, ctx)) return;
      skillProofs.push({ source: "skill", skill, quote });
    }
    kept.push(skill);
  });
  const proofs = fit.proofs.filter((p) => inText(p.quote, ctx));
  // An answer with no quotes at all (a model that ignored the format) is weak evidence at best:
  // its skills named in the evidence text count as one piece, so it stays under 80.
  const unquoted = fit.proofs.length === 0 && !fit.skillQuotes.some(Boolean);
  const work = unquoted ? Math.min(1, kept.length) : proofs.filter((p) => p.source !== "certification").length + skillProofs.length;
  const grounded = unquoted ? Math.min(1, kept.length) : proofs.length + skillProofs.length;

  let score = fit.domainScore;
  let capped = "";
  const cap = (to: number, why: string) => {
    if (score > to) {
      score = to;
      capped = why;
    }
  };
  if (opts.sectionsRemoved && fit.coreSkills.length >= 2 && named === 0) cap(UNGROUNDED_CAP, "every skill it named is only in the Skills list / summary");
  if (grounded === 0) cap(UNGROUNDED_CAP, "no domain evidence quoted from the projects / experience / achievements");
  else if (work === 0) cap(CERTIFICATION_ONLY_CAP, "only certifications back it — no project, experience or achievement");
  else if (grounded < 2) cap(SINGLE_EVIDENCE_CAP, "only one piece of quoted evidence (80+ needs two)");

  // Distinct proofs, the model's ranked ones first.
  const seen = new Set<string>();
  const all = [...proofs, ...skillProofs].filter((p) => {
    const k = loose(p.quote);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { domainScore: score, rawScore: fit.domainScore, coreSkills: kept, proofs: all.slice(0, 5), capped };
}

const nameWords = (s: string) =>
  (s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3);

/**
 * Does the GitHub account look like the candidate's? "match" when its display name shares a
 * name word with the candidate (or the login contains one); "mismatch" only when it shows a
 * full name (two words or more) with nothing in common; otherwise "unknown" — a missing or
 * handle-like name proves nothing either way.
 */
export function githubIdentity(candidateName: string, accountName: string, login: string): "match" | "mismatch" | "unknown" {
  const mine = nameWords(candidateName);
  if (!mine.length) return "unknown";
  const l = (login ?? "").toLowerCase();
  if (mine.some((w) => w.length >= 4 && l.includes(w))) return "match";
  const theirs = nameWords(accountName);
  if (!theirs.length) return "unknown";
  if (theirs.some((w) => mine.includes(w))) return "match";
  return theirs.length >= 2 ? "mismatch" : "unknown";
}
