import { ASSESSMENTS, type AssessmentScore } from "@/lib/pool/scores/catalogue";
import { edge2Stage, isCleared, parseVerdict } from "@/lib/pool/standing";
import { COMPETENCY_LABEL, TR2_TRACK_LABEL, VERDICT_LABEL, type PersonRecords } from "@/lib/pool/types";

/**
 * The prep page's "Internal assessments" tags, from our own assessment records. Pure (tested in
 * scripts/prep-selftest.ts). Every score carries its maximum ("16/100"), and every tag a tone:
 *   pass    (green) cleared, selected, strong / medium hire, qualified;
 *   fail    (red)   not cleared, rejected, low / no hire;
 *   neutral (grey)  facts without a verdict (bucket placement, section scores, ratings, year).
 */

export interface Tag {
  label: string;
  tone: "pass" | "fail" | "neutral";
  /** "Academy", "Edge 2.0", "Edge 1.0", "Marks", "Sheet". */
  group: string;
}

const pass = (label: string, group: string): Tag => ({ label, tone: "pass", group });
const fail = (label: string, group: string): Tag => ({ label, tone: "fail", group });
const info = (label: string, group: string): Tag => ({ label, tone: "neutral", group });

/** 16 → "16", 4.58 → "4.6". */
export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "" : Number.isInteger(n) ? String(n) : n.toFixed(1));
const outOf = (n: number | null | undefined, max: number | null | undefined) => (n === null || n === undefined ? "" : max ? `${fmt(n)}/${fmt(max)}` : fmt(n));
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
const sentence = (s: string) => {
  const t = tidy(s);
  return t === t.toUpperCase() && /[A-Z]/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t;
};

/** A verdict's colour from its words: cleared / selected / strong or medium hire → pass; not, rejected, low hire, fail → fail. */
export function toneOf(text: string): Tag["tone"] {
  const t = text.toLowerCase();
  if (!t.trim()) return "neutral";
  const v = parseVerdict(text);
  if (v === "strong_hire" || v === "medium_hire") return "pass";
  if (v === "low_hire" || v === "rejected") return "fail";
  if (/\bnot\b|reject|fail|needs improvement|below/.test(t)) return "fail";
  if (isCleared(text) || /\bselected\b|\bpassed\b|\bqualified\b/.test(t)) return "pass";
  return "neutral";
}

const join = (...parts: (string | null | undefined | false)[]) => parts.filter((p): p is string => Boolean(p && String(p).trim())).join(" · ");

/** Maximum marks of the Academy bucket interviews (Bucket C TR-1 has none on record). */
const BUCKET_MAX: Record<string, number> = { A1: 100, A2: 100, B1: 15, B2: 10 };

export function recordTags(rec: PersonRecords): Tag[] {
  const tags: Tag[] = [];

  const a = rec.academy;
  if (a) {
    const G = "Academy";
    if (a.oldBucket) tags.push(info(`Old offline assessment · Bucket ${a.oldBucket}`, G));
    if (a.dsaOfflineStatus.trim() || a.dsaOfflineCleared) {
      tags.push(a.dsaOfflineCleared ? pass(join("DSA offline exam", "Cleared"), G) : fail(join("DSA offline exam", sentence(a.dsaOfflineStatus)), G));
    }
    for (const r of a.rounds) {
      const label = join(`Bucket ${r.bucket} TR-${r.round}`, outOf(r.score, BUCKET_MAX[`${r.bucket}${r.round}`]), r.status ? sentence(r.status) : r.cleared ? "Cleared" : "");
      if (r.cleared) tags.push(pass(label, G));
      else if (r.status.trim() || r.score !== null) tags.push(toneOf(r.status) === "pass" ? info(label, G) : fail(label, G));
    }
    for (const c of a.competency) {
      const level = c.levelLabel.trim() || (c.level !== null ? `L${c.level}` : "");
      const verdict = c.cleared ? "Cleared" : sentence(c.clearanceStatus || c.verdictBand);
      const label = join(`${COMPETENCY_LABEL[c.subject]} competency`, outOf(c.overallScore, 100), level, verdict);
      if (c.cleared) tags.push(pass(label, G));
      else if (verdict || c.overallScore !== null) tags.push(fail(label, G));
    }
    if (a.previousPlacement.trim()) tags.push(info(`Previous placement: ${tidy(a.previousPlacement)}`, G));
    if (a.studentPreference.trim()) tags.push(info(`Prefers: ${tidy(a.studentPreference)}`, G));
    if (a.activePool === false) tags.push(info("Not in the active pool", G));
    if (a.yog) tags.push(info(`Graduating ${a.yog}`, G));
  }

  const e2 = rec.edge2;
  if (e2) {
    const G = "Edge 2.0";
    const stage = edge2Stage(e2.candidateStage);
    if (stage) tags.push(pass(stage === "tr2" ? "TR-2 cleared" : stage === "tr1" ? "TR-1 cleared" : "Assessment cleared", G));
    // Everyone in the Edge 2.0 pool cleared the offline assessment; its scores are facts.
    if (e2.offlineOverallScore !== null) tags.push(info(`Offline assessment · ${outOf(e2.offlineOverallScore, 160)}`, G));
    const sections = [
      e2.dsaCodingScore !== null ? `DSA coding ${outOf(e2.dsaCodingScore, 120)}` : null,
      e2.csFundamentalsScore !== null ? `CS fundamentals ${outOf(e2.csFundamentalsScore, 40)}` : null,
      e2.sqlMcqScore !== null ? `SQL MCQ ${outOf(e2.sqlMcqScore, 15)}` : null,
      e2.sqlCodingScore !== null ? `SQL coding ${outOf(e2.sqlCodingScore, 15)}` : null,
    ].filter(Boolean);
    if (sections.length) tags.push(info(sections.join(" · "), G));
    const t = e2.tr1;
    if (t.overallTechnical !== null) {
      const label = `TR-1 technical · ${outOf(t.overallTechnical, 100)}`;
      // Took TR-1: cleared when the stage moved past the assessment, not cleared when it didn't.
      tags.push(stage === "tr1" || stage === "tr2" ? pass(`${label} · Cleared`, G) : stage === "assessment" ? fail(`${label} · Not cleared`, G) : info(label, G));
    }
    const ratings = [
      t.dsaOverall !== null ? `DSA ${fmt(t.dsaOverall)}` : null,
      t.problemSolving !== null ? `Problem solving ${fmt(t.problemSolving)}` : null,
      t.coding !== null ? `Coding ${fmt(t.coding)}` : null,
      t.debugging !== null ? `Debugging ${fmt(t.debugging)}` : null,
      t.communication !== null ? `Communication ${fmt(t.communication)}` : null,
      t.selfIntro !== null ? `Self intro ${fmt(t.selfIntro)}` : null,
    ].filter(Boolean);
    if (ratings.length) tags.push(info(`TR-1 ratings (out of 10): ${ratings.join(" · ")}`, G));
    for (const v of e2.tr2) {
      const label = `${TR2_TRACK_LABEL[v.track]} TR-2 · ${VERDICT_LABEL[v.verdict]}`;
      tags.push(v.verdict === "strong_hire" || v.verdict === "medium_hire" ? pass(label, G) : fail(label, G));
    }
  }

  const e1 = rec.edge1;
  if (e1) {
    const G = "Edge 1.0";
    const assessment = tidy(e1.assessmentStatus);
    if (assessment) {
      tags.push(/^selected$/i.test(assessment) ? pass("Assessment · Cleared", G) : toneOf(assessment) === "pass" ? pass(`Assessment · ${sentence(assessment)}`, G) : fail(`Assessment · ${sentence(assessment)}`, G));
    }
    const tr1 = tidy(e1.tr1Status);
    if (tr1) {
      const v = parseVerdict(tr1);
      const label = `TR-1 · ${v ? VERDICT_LABEL[v] : sentence(tr1)}`;
      const tone = v === "strong_hire" || v === "medium_hire" ? "pass" : v ? "fail" : toneOf(tr1);
      tags.push({ label, tone, group: G });
    }
    const tr2 = tidy(e1.tr2Status);
    if (tr2) tags.push({ label: `TR-2 · ${sentence(tr2)}`, tone: /shortlisted/i.test(tr2) ? "pass" : toneOf(tr2), group: G });
  }
  return tags;
}

/**
 * Final marks of the Academy exams and interviews, the best attempt of each:
 * "DSA offline exam · 92/130 · Qualified". [skipBucketRounds] when the Academy record already
 * shows the bucket rounds.
 */
export function markTags(scores: AssessmentScore[], skipBucketRounds: boolean): Tag[] {
  const best = new Map<string, AssessmentScore>();
  for (const s of scores) {
    const prev = best.get(s.assessment);
    if (!prev || s.score / (s.maxScore || 1) > prev.score / (prev.maxScore || 1)) best.set(s.assessment, s);
  }
  return ASSESSMENTS.filter((a) => best.has(a.key) && !(skipBucketRounds && a.key.startsWith("bucket_"))).map((a) => {
    const s = best.get(a.key)!;
    const label = join(a.label, outOf(s.score, s.maxScore || a.max), s.result ? sentence(s.result) : "");
    const tone: Tag["tone"] = s.passed === true ? "pass" : s.passed === false ? "fail" : toneOf(s.result);
    return { label, tone, group: "Marks" };
  });
}
