import { edge2ResolvedStage, edge2Tr1Outcome, isCleared, parseVerdict } from "@/lib/pool/standing";
import {
  COMPETENCY_LABEL,
  TR2_TRACK_NAME,
  VERDICT_LABEL,
  VERDICT_ORDER,
  type AcademyRecord,
  type Edge1Record,
  type Edge2Record,
  type PoolRecord,
} from "@/lib/pool/types";

/**
 * Assessment details — every result behind a person's standing, one line each, for the
 * "Internal Standing" column of Domain shortlisting and the Standing lookup:
 *
 *   Assessment: Cleared · 110.5/160 (DSA coding 80.5/120 · CS fundamentals 30/40)
 *   TR-1 (DSA interview): Cleared · Shortlisted
 *   TR-2: MERN Full Stack Strong hire (cleared)
 *
 * Built from the stored records only — never a resume. Every score carries its maximum where the
 * drive has one. Pure and client-safe; tested in scripts/pool-selftest.ts.
 */

/** Maximum marks of the Academy bucket interviews (Bucket C TR-1 has none on record). */
export const ACADEMY_ROUND_MAX: Record<string, number> = { A1: 100, A2: 100, B1: 15, B2: 10 };
/** Edge 2.0 drive maxima. */
const EDGE2_MAX = { offline: 160, dsa: 120, cs: 40, sql: 15, dsaInterviewDsa: 120, dsaInterviewCs: 40, tr1Technical: 100 } as const;

/** 110.25 → "110.25", 7.20 → "7.2", 32 → "32". */
const num = (v: number) => String(Math.round(v * 100) / 100);
/** "80.5/120"; a score above the stated maximum is shown on its own (the drive's maxima changed once). */
const outOf = (v: number | null | undefined, max?: number) => (v === null || v === undefined ? "" : max && v <= max ? `${num(v)}/${max}` : num(v));
const joinParts = (sep: string, ...parts: (string | false | null | undefined)[]) => parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
const tidy = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();
/** "NOT SHORTLISTED" → "Not shortlisted"; "Strong Hire" stays. */
const sentence = (s: string) => {
  const t = tidy(s);
  return t && t === t.toUpperCase() && /[A-Z]/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t;
};
/** "pass" → "Pass". */
const capital = (s: string) => {
  const t = sentence(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
};
/** A verdict word from a sheet cell: "strong_hire" / "Strong Hire" → "Strong hire"; anything else as written. */
const verdictText = (raw: string) => {
  const v = parseVerdict(raw);
  return v ? VERDICT_LABEL[v] : sentence(raw.replace(/_/g, " "));
};
const isHire = (v: string | null | undefined) => v === "strong_hire" || v === "medium_hire";

// ── Edge 2.0 ─────────────────────────────────────────────────────────────────

export function edge2Details(r: Edge2Record): string[] {
  const lines: string[] = [];
  const stage = edge2ResolvedStage(r);
  const combinedPath = r.interviewPath === "combined" || Boolean(r.combined?.verdict) || /pending|completed/.test(r.combined?.state ?? "");

  const sections = joinParts(
    " · ",
    r.dsaCodingScore !== null && `DSA coding ${outOf(r.dsaCodingScore, EDGE2_MAX.dsa)}`,
    r.csFundamentalsScore !== null && `CS fundamentals ${outOf(r.csFundamentalsScore, EDGE2_MAX.cs)}`,
    r.sqlMcqScore !== null && `SQL MCQ ${outOf(r.sqlMcqScore, EDGE2_MAX.sql)}`,
    r.sqlCodingScore !== null && `SQL coding ${outOf(r.sqlCodingScore, EDGE2_MAX.sql)}`,
  );
  lines.push(`Assessment: ${joinParts(" · ", "Cleared", outOf(r.offlineOverallScore, EDGE2_MAX.offline))}${sections ? ` (${sections})` : ""}`);

  // TR-1 — the DSA interview, plus the TR-1 AI interview's own scores when it ran.
  const t = r.tr1;
  const tr1 = edge2Tr1Outcome(r);
  const dsa = r.dsaInterview ?? { status: "", attempt: "", dsaScore: null, csScore: null };
  const dsaScores = joinParts(" · ", dsa.dsaScore !== null && `DSA ${outOf(dsa.dsaScore, EDGE2_MAX.dsaInterviewDsa)}`, dsa.csScore !== null && `CS ${outOf(dsa.csScore, EDGE2_MAX.dsaInterviewCs)}`);
  const ratings = joinParts(
    " · ",
    t.dsaOverall !== null && `DSA ${num(t.dsaOverall)}`,
    t.problemSolving !== null && `problem solving ${num(t.problemSolving)}`,
    t.coding !== null && `coding ${num(t.coding)}`,
    t.debugging !== null && `debugging ${num(t.debugging)}`,
    t.communication !== null && `communication ${num(t.communication)}`,
    t.selfIntro !== null && `self intro ${num(t.selfIntro)}`,
  );
  const ai = joinParts(
    ", ",
    r.tr1Status && `AI interview ${capital(r.tr1Status)}`,
    t.overallTechnical !== null && `technical ${outOf(t.overallTechnical, EDGE2_MAX.tr1Technical)}`,
    ratings && `ratings out of 10: ${ratings}`,
  );
  const onRecord = Boolean(dsa.status || dsaScores || ai);
  const tr1Cleared = tr1 === "cleared" || (tr1 !== "not_cleared" && (stage === "tr1" || (stage === "tr2" && !combinedPath)));
  if (tr1 === "not_taken" && !tr1Cleared) {
    lines.push("TR-1 (DSA interview): Not taken yet");
  } else if (onRecord || (tr1Cleared && !combinedPath)) {
    const result = tr1Cleared ? "Cleared" : tr1 === "not_cleared" ? "Not cleared" : "Taken";
    const parts = joinParts(" · ", result, dsa.status && sentence(dsa.status) + (dsaScores ? ` (${dsaScores})` : ""), !dsa.status && dsaScores, ai);
    lines.push(`TR-1 (DSA interview): ${parts}`);
  }

  // The combined interview (TR-1 + TR-2 in one, no track).
  const cv = r.combined?.verdict ?? null;
  if (cv) lines.push(`Combined interview (TR-1 + TR-2): ${VERDICT_LABEL[cv]}${isHire(cv) ? " (cleared)" : " (not cleared)"}`);
  else if (/pending/.test(r.combined?.state ?? "")) lines.push("Combined interview (TR-1 + TR-2): Pending — not taken yet");

  // TR-2 — one interview per track.
  const taken = [...r.tr2].sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict));
  const pending = (r.tr2Pending ?? []).filter((p) => !taken.some((v) => v.track === p));
  const tr2 = joinParts(
    " · ",
    ...taken.map((v) => `${TR2_TRACK_NAME[v.track]} ${VERDICT_LABEL[v.verdict]} (${isHire(v.verdict) ? "cleared" : "not cleared"})`),
    ...pending.map((p) => `${TR2_TRACK_NAME[p]} booked, not taken yet`),
  );
  if (tr2) lines.push(`TR-2: ${tr2}`);
  else if (stage === "tr2" && !cv) lines.push("TR-2: Cleared (per the pool sheet; no verdict on record)");

  if (r.journey?.status === "closed") lines.push(`Drive journey: Closed${r.journey.reason ? ` (${r.journey.reason.replace(/_/g, " ")})` : ""}`);
  return lines;
}

// ── Edge 1.0 ─────────────────────────────────────────────────────────────────

export function edge1Details(r: Edge1Record): string[] {
  const lines: string[] = [];
  const a = tidy(r.assessmentStatus);
  if (a) lines.push(`Assessment: ${/^selected$/i.test(a) ? "Cleared (Selected)" : sentence(a)}`);
  const t1 = tidy(r.tr1Status);
  if (t1) {
    const v = parseVerdict(t1);
    lines.push(`TR-1: ${verdictText(t1)}${v ? (isHire(v) ? " (cleared)" : " (not cleared)") : ""}`);
  }
  const t2 = tidy(r.tr2Status);
  if (t2) lines.push(`TR-2: ${sentence(t2)}${/^shortlisted$/i.test(t2) || isCleared(t2) ? " (cleared)" : /reject|not/i.test(t2) ? " (not cleared)" : ""}`);
  return lines;
}

// ── Academy ──────────────────────────────────────────────────────────────────

export function academyDetails(r: AcademyRecord): string[] {
  const lines: string[] = [];
  if (r.oldBucket) lines.push(`Old DSA offline assessment: Bucket ${r.oldBucket}`);
  if (tidy(r.dsaOfflineStatus)) lines.push(`DSA competency exam: ${sentence(r.dsaOfflineStatus)}${r.dsaOfflineCleared && !/clear/i.test(r.dsaOfflineStatus) ? " (cleared)" : ""}`);
  const rounds = [...r.rounds].sort((a, b) => a.bucket.localeCompare(b.bucket) || a.round - b.round);
  for (const x of rounds) {
    const status = tidy(x.status);
    if (!status && x.score === null && !x.cleared) continue;
    const parts = joinParts(" · ", status ? verdictText(status) : x.cleared ? "Cleared" : "", outOf(x.score, ACADEMY_ROUND_MAX[`${x.bucket}${x.round}`]));
    lines.push(`Bucket ${x.bucket} TR-${x.round}: ${parts || "Taken"}${x.cleared ? (/clear|shortlist|select/i.test(parts) ? "" : " (cleared)") : status ? " (not cleared)" : ""}`);
  }
  const competency = [...r.competency].sort((a, b) => (b.level ?? -1) - (a.level ?? -1));
  for (const c of competency) {
    const level = tidy(c.levelLabel) || (c.level === 0 ? "Below L1" : c.level !== null ? `L${c.level}` : "");
    const parts = joinParts(" · ", level, tidy(c.verdictBand) && verdictText(c.verdictBand), c.cleared ? "Cleared" : tidy(c.clearanceStatus) && sentence(c.clearanceStatus), outOf(c.overallScore, 100));
    lines.push(`${COMPETENCY_LABEL[c.subject]} competency: ${parts || "Taken"}`);
  }
  return lines;
}

/** One record's details (the record's product decides the shape). */
export function recordDetails(r: PoolRecord): string[] {
  return r.product === "edge2" ? edge2Details(r) : r.product === "edge1" ? edge1Details(r) : academyDetails(r);
}
