import {
  GOOD_TO_HAVE,
  MANDATORY,
  QA_SECTIONS,
  SECTION_LABEL,
  type MandatoryKey,
  type QaCandidateInput,
  type QaEvaluation,
  type QaFocus,
  type QaRules,
  type QaSection,
} from "@/lib/qa-types";

/**
 * QA Resume Screening — deterministic scoring, shortlist rules and ranking.
 * The model only reports verified evidence; every number here is computed.
 *
 * Mandatory (0–100): 5 items × 20 points, split by where the item is shown —
 *   Skills 4 · Projects 8 · Experience 8   (a listed skill is weaker than using it).
 *   100 only when every mandatory item is in all three sections.
 * Good-to-have bonus: +2 per item shown in a project or job, +1 per item only
 *   in the skills list, +2 for a QA / automation testing project or internship.
 * Final = mandatory + bonus. If any mandatory item is missing from any section
 *   the final score is capped at 99 — only a complete candidate reaches 100+.
 */

export const SECTION_POINTS: Record<QaSection, number> = { skills: 4, projects: 8, experience: 8 };
const HANDS_ON_BONUS = 2;

export interface QaScore {
  mandatoryScore: number;
  bonus: number;
  finalScore: number;
  /** Every mandatory item in all three sections — the only way to 100%. */
  allSectionsComplete: boolean;
  /** Mandatory items present in at least one section (0–5). */
  mandatoryPresent: number;
  missingMandatory: string[];
  /** Mandatory items present somewhere but absent from a section — "Selenium: no Experience". */
  sectionGaps: string[];
  /** A testing project or a QA / testing internship-job (not just a skills list). */
  handsOn: boolean;
  qaProject: boolean;
  qaInternship: boolean;
  goodToHave: string[];
}

const PROJECT_WORK: MandatoryKey[] = ["qa", "software_testing", "manual_testing", "automated_testing"];

export function sectionsOf(q: Record<QaSection, string> | undefined): QaSection[] {
  return q ? QA_SECTIONS.filter((s) => Boolean(q[s])) : [];
}

export function scoreEvaluation(r: QaEvaluation): QaScore {
  let mandatoryScore = 0;
  let complete = true;
  let present = 0;
  const missing: string[] = [];
  const gaps: string[] = [];
  for (const def of MANDATORY) {
    const secs = sectionsOf(r.mandatory?.[def.key]);
    for (const s of secs) mandatoryScore += SECTION_POINTS[s];
    if (secs.length < QA_SECTIONS.length) complete = false;
    if (!secs.length) missing.push(def.label);
    else {
      present++;
      if (secs.length < QA_SECTIONS.length) {
        gaps.push(`${def.label}: no ${QA_SECTIONS.filter((s) => !secs.includes(s)).map((s) => SECTION_LABEL[s]).join(" / ")}`);
      }
    }
  }
  const qaProject = PROJECT_WORK.some((k) => Boolean(r.mandatory?.[k]?.projects));
  const qaInternship = PROJECT_WORK.some((k) => Boolean(r.mandatory?.[k]?.experience));
  const handsOn = qaProject || qaInternship;

  let bonus = 0;
  const found: string[] = [];
  for (const def of GOOD_TO_HAVE) {
    const secs = sectionsOf(r.goodToHave?.[def.key]);
    if (!secs.length) continue;
    found.push(def.label);
    bonus += secs.some((s) => s !== "skills") ? 2 : 1;
  }
  if (handsOn) bonus += HANDS_ON_BONUS;

  const raw = mandatoryScore + bonus;
  return {
    mandatoryScore,
    bonus,
    finalScore: complete ? raw : Math.min(raw, 99),
    allSectionsComplete: complete,
    mandatoryPresent: present,
    missingMandatory: missing,
    sectionGaps: gaps,
    handsOn,
    qaProject,
    qaInternship,
    goodToHave: found,
  };
}

export type QaStatus =
  | "Shortlisted"
  | "Qualified – Outside Top N"
  | "Borderline – Review"
  | "Unverified – Re-screen"
  | "Not Shortlisted"
  | "Not QA – No Testing Terms"
  | "Invalid – Not a Resume"
  | "Error"
  | "Pending";

export const STATUS_ORDER: QaStatus[] = [
  "Shortlisted",
  "Qualified – Outside Top N",
  "Borderline – Review",
  "Unverified – Re-screen",
  "Not Shortlisted",
  "Not QA – No Testing Terms",
  "Invalid – Not a Resume",
  "Error",
  "Pending",
];

export interface QaRanked {
  id: string;
  candidate: QaCandidateInput;
  result: QaEvaluation | undefined;
  score: QaScore | null;
  status: QaStatus;
  /** Why the candidate is not shortlisted ("" when shortlisted). */
  reasons: string[];
  /** Position in the complete ranking (0 = not ranked: error / pending). */
  rank: number;
  /** Position in the shortlist (0 = not shortlisted). */
  shortlistRank: number;
}

const FOCUS_ORDER: Record<QaFocus, number> = { Primary: 0, Secondary: 1, Incidental: 2, None: 3 };

interface Gate {
  kind: "mandatory" | "handsOn" | "experience" | "score";
  reason: string;
}

function gates(s: QaScore, rules: QaRules): Gate[] {
  const out: Gate[] = [];
  if (rules.requireAllMandatory && s.missingMandatory.length) {
    out.push({ kind: "mandatory", reason: `Missing mandatory: ${s.missingMandatory.join(", ")}` });
  }
  if (rules.requireHandsOn && !s.handsOn) {
    out.push({ kind: "handsOn", reason: "No hands-on QA — no testing project or QA / testing internship" });
  }
  if (rules.requireQaExperience && !s.qaInternship) {
    out.push({ kind: "experience", reason: "No QA / testing internship or job" });
  }
  if (s.finalScore < rules.minScore) {
    out.push({ kind: "score", reason: `Score ${s.finalScore}% is below the ${rules.minScore}% bar` });
  }
  return out;
}

/** Missed by exactly one rule, and only narrowly — worth a recruiter's look. */
function isBorderline(failed: Gate[], s: QaScore, rules: QaRules): boolean {
  if (failed.length !== 1) return false;
  const g = failed[0];
  if (g.kind === "score") return s.finalScore >= rules.minScore - 15;
  if (g.kind === "mandatory") return s.missingMandatory.length === 1;
  return true; // hands-on / QA-experience rule only
}

/**
 * Complete ranking: Shortlisted → Qualified outside top N → Borderline →
 * Not shortlisted → Not QA → Errors / pending; within a tier by final score,
 * then mandatory score, bonus, QA focus and mobile (stable across re-runs).
 */
export function rankCandidates(
  candidates: QaCandidateInput[],
  results: Record<string, QaEvaluation>,
  rules: QaRules,
): QaRanked[] {
  const rows: QaRanked[] = candidates.map((c) => {
    const result = results[c.id];
    if (!result) return { id: c.id, candidate: c, result, score: null, status: "Pending", reasons: [], rank: 0, shortlistRank: 0 };
    if (result.status === "error") {
      return { id: c.id, candidate: c, result, score: null, status: "Error", reasons: [result.error], rank: 0, shortlistRank: 0 };
    }
    if (result.status === "invalid") {
      return { id: c.id, candidate: c, result, score: null, status: "Invalid – Not a Resume", reasons: [result.error], rank: 0, shortlistRank: 0 };
    }
    const score = scoreEvaluation(result);
    if (result.status === "screened-out") {
      return {
        id: c.id,
        candidate: c,
        result,
        score,
        status: "Not QA – No Testing Terms",
        reasons: ["No testing / QA terms anywhere in the resume"],
        rank: 0,
        shortlistRank: 0,
      };
    }
    // Evidence that was never checked against the resume's text (an image read
    // before files were identified) can't shortlist anyone — re-screen it.
    if (!result.evidenceVerified) {
      return {
        id: c.id,
        candidate: c,
        result,
        score,
        status: "Unverified – Re-screen",
        reasons: ["Evidence was not checked against the resume's text (image / scanned file read by an older version) — re-screen"],
        rank: 0,
        shortlistRank: 0,
      };
    }
    const failed = gates(score, rules);
    return {
      id: c.id,
      candidate: c,
      result,
      score,
      status: failed.length === 0 ? "Shortlisted" : isBorderline(failed, score, rules) ? "Borderline – Review" : "Not Shortlisted",
      reasons: failed.map((g) => g.reason),
      rank: 0,
      shortlistRank: 0,
    };
  });

  const byScore = (a: QaRanked, b: QaRanked) => {
    const sa = a.score;
    const sb = b.score;
    if (sa && sb) {
      if (sb.finalScore !== sa.finalScore) return sb.finalScore - sa.finalScore;
      if (sb.mandatoryScore !== sa.mandatoryScore) return sb.mandatoryScore - sa.mandatoryScore;
      if (sb.bonus !== sa.bonus) return sb.bonus - sa.bonus;
      const fa = FOCUS_ORDER[a.result?.qaFocus ?? "None"] ?? 3;
      const fb = FOCUS_ORDER[b.result?.qaFocus ?? "None"] ?? 3;
      if (fa !== fb) return fa - fb;
    } else if (sa || sb) {
      return sa ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  };

  // Top-N cap: the best N who clear every rule stay shortlisted.
  if (rules.topN > 0) {
    const passed = rows.filter((r) => r.status === "Shortlisted").sort(byScore);
    passed.slice(rules.topN).forEach((r, i) => {
      r.status = "Qualified – Outside Top N";
      r.reasons = [`Cleared every rule — ranked #${rules.topN + i + 1}, outside the top ${rules.topN}`];
    });
  }

  rows.sort((a, b) => {
    const ta = STATUS_ORDER.indexOf(a.status);
    const tb = STATUS_ORDER.indexOf(b.status);
    return ta !== tb ? ta - tb : byScore(a, b);
  });
  let rank = 0;
  let shortlistRank = 0;
  for (const r of rows) {
    if (r.status === "Error" || r.status === "Pending" || r.status === "Invalid – Not a Resume") continue;
    r.rank = ++rank;
    if (r.status === "Shortlisted") r.shortlistRank = ++shortlistRank;
  }
  return rows;
}

export function summarize(rows: QaRanked[]) {
  const count = (s: QaStatus) => rows.filter((r) => r.status === s).length;
  return {
    evaluated: rows.filter((r) => r.status !== "Pending").length,
    shortlisted: count("Shortlisted"),
    outsideTopN: count("Qualified – Outside Top N"),
    borderline: count("Borderline – Review"),
    notShortlisted: count("Not Shortlisted"),
    notQa: count("Not QA – No Testing Terms"),
    invalid: count("Invalid – Not a Resume"),
    unverified: count("Unverified – Re-screen"),
    errors: count("Error"),
    pending: count("Pending"),
  };
}
