import {
  COMPETENCY_LABEL,
  PRODUCT_LABEL,
  TR2_TRACK_LABEL,
  VERDICT_LABEL,
  VERDICT_ORDER,
  type AcademyRecord,
  type Edge1Record,
  type Edge2Record,
  type PoolRecord,
  type Standing,
  type Verdict,
} from "@/lib/pool/types";

/**
 * The eligible pool's standing rules — one place, pure and tested
 * (scripts/pool-selftest.ts). Bump RULES_VERSION when a rule changes: every record's
 * hash changes with it, so the next sync re-derives every standing.
 *
 * Edge 1.0 / Edge 2.0 (TR-2 cleared > TR-1 cleared > assessment cleared):
 *  - Edge 1.0: assessment "SELECTED" → eligible; TR-1 cleared = Strong / Medium Hire
 *    (Low Hire never went on to TR-2, so it's not a clear); TR-2 cleared = "Shortlisted".
 *  - Edge 2.0: the higher of the sheet's stage column and what the interview results prove:
 *      TR-2 cleared = a strong / medium hire in any TR-2 track, or in the combined interview;
 *      TR-1 cleared = the DSA interview "Shortlisted" (the TR-1 AI interview's own pass/fail
 *      only counts when the DSA interview has no status), or a TR-2 taken or booked while TR-1
 *      isn't on record as not cleared ("Not Shortlisted" counts only once they interviewed);
 *      assessment cleared = everyone in the pool (it is the "Assessment Cleared" pool).
 *    A low hire or rejection at TR-2 is not a TR-2 clear (the person stays TR-1 cleared); a
 *    low hire or rejection in the combined interview leaves them at the assessment.
 * Academy (everyone in the > 8 LPA assessed pool is eligible):
 *  - top: Bucket A TR-2 cleared, or a competency interview at L3 / L4 / L5;
 *  - then TR-1 cleared in Bucket A (Strong / Medium Hire), B or C — or Bucket B's TR-2;
 *  - then assessment cleared (old DSA offline bucket A > B > C > D, or a competency exam).
 *
 * Version 2 (2026-11-20): Edge 2.0 stages come from the interview results too. The pool sheet's
 * stage column lost its header, so v1 read the drive's currentStage instead and put every Edge 2.0
 * candidate at "Assessment cleared".
 */
export const RULES_VERSION = 2;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** "Strong Hire", "strong_hire", "medium hire" … → verdict. "Rejected", "Reject", "No hire" → rejected. */
export function parseVerdict(raw: string): Verdict | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!s) return null;
  if (/\breject|\bno hire\b|\bnot (cleared|selected)\b/.test(s)) return "rejected";
  if (/\bstrong\b.*\bhire\b/.test(s)) return "strong_hire";
  if (/\b(medium|moderate|mid)\b.*\bhire\b/.test(s)) return "medium_hire";
  if (/\b(low|weak)\b.*\bhire\b/.test(s)) return "low_hire";
  return null;
}

/** "Cleared", "Shortlisted", "Selected", "Pass" → true; "Not Cleared", "Rejected" → false. */
export function isCleared(raw: string): boolean {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s || /\bnot\b|reject|fail/.test(s)) return false;
  return /\b(cleared|shortlisted|selected|pass(ed)?|qualified)\b/.test(s);
}

const verdictRank = (v: Verdict) => VERDICT_ORDER.indexOf(v);

// ── Edge 1.0 ─────────────────────────────────────────────────────────────────

export function edge1Standing(r: Edge1Record): Standing {
  const p = PRODUCT_LABEL.edge1;
  const assessed = /^selected$/i.test(r.assessmentStatus.trim());
  const tr1 = parseVerdict(r.tr1Status);
  const tr1Cleared = tr1 === "strong_hire" || tr1 === "medium_hire";
  const tr2Cleared = /^shortlisted$/i.test(r.tr2Status.trim()) || (Boolean(r.tr2Status.trim()) && isCleared(r.tr2Status));
  const tr2Rejected = /reject/i.test(r.tr2Status);
  if (tr2Cleared) {
    return { tier: 1, label: `${p} · TR-2 cleared${tr1 ? ` (TR-1 ${VERDICT_LABEL[tr1]})` : ""}`, internalScore: tr1 === "strong_hire" ? 96 : 92, eligible: true };
  }
  if (tr1Cleared) {
    return {
      tier: 2,
      label: `${p} · TR-1 ${VERDICT_LABEL[tr1!]}${tr2Rejected ? " · TR-2 not cleared" : ""}`,
      internalScore: (tr1 === "strong_hire" ? 74 : 66) - (tr2Rejected ? 4 : 0),
      eligible: true,
    };
  }
  if (assessed) {
    return {
      tier: 3,
      label: `${p} · Assessment cleared${tr1 === "low_hire" || tr1 === "rejected" ? " · TR-1 not cleared" : ""}`,
      internalScore: tr1 === "low_hire" ? 42 : tr1 === "rejected" ? 38 : 40,
      eligible: true,
    };
  }
  return { tier: 4, label: `${p} · Assessment not cleared`, internalScore: 10, eligible: false };
}

// ── Edge 2.0 ─────────────────────────────────────────────────────────────────

export type Edge2StageKey = "tr2" | "tr1" | "assessment";
const STAGE_RANK: Record<Edge2StageKey, number> = { assessment: 0, tr1: 1, tr2: 2 };
/** The pool sheet's own words for each stage (what candidate_stage stores). */
export const EDGE2_STAGE_TEXT: Record<Edge2StageKey, string> = { tr2: "TR2 CLEARED", tr1: "TR1 CLEARED", assessment: "ASSESSMENT CLEARED" };

/** "TR2 CLEARED", "tr1 cleared", "Assessment Cleared" → stage. The drive's currentStage ("dsa_interview" …) is not a stage here → null. */
export function edge2Stage(raw: string): Edge2StageKey | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/\btr ?2\b/.test(s)) return "tr2";
  if (/\btr ?1\b/.test(s)) return "tr1";
  if (/\bassess?ment\b/.test(s)) return "assessment";
  return null;
}

const isHire = (v: Verdict | null | undefined): v is "strong_hire" | "medium_hire" => v === "strong_hire" || v === "medium_hire";

/** Best TR-2 verdict over the tracks (best first), and whether it clears TR-2 (low hire doesn't). */
export function bestTr2(tr2: Edge2Record["tr2"]): Edge2Record["tr2"][number] | null {
  return [...tr2].sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict))[0] ?? null;
}

/**
 * The TR-1 round's outcome. The DSA interview's status decides: "Shortlisted" = cleared; "Not
 * Shortlisted" = not cleared — but only once the candidate interviewed (an attempt, DSA-interview
 * scores, or a TR-1 AI interview result), since the drive shows "Not Shortlisted" before anyone
 * interviews. The TR-1 AI interview's own pass / fail decides only when the DSA interview has no
 * status. "not_taken" = still to interview; null = nothing on record.
 */
export function edge2Tr1Outcome(r: Pick<Edge2Record, "dsaInterview" | "tr1Status">): "cleared" | "not_cleared" | "not_taken" | null {
  const d = r.dsaInterview;
  const dsa = (d?.status ?? "").trim();
  const ai = (r.tr1Status ?? "").trim().toLowerCase();
  const interviewed = /^attempted$/i.test(d?.attempt ?? "") || d?.dsaScore != null || d?.csScore != null || /^(pass|fail)/.test(ai);
  if (dsa) {
    if (isCleared(dsa)) return "cleared";
    if (/\bnot\b|reject|fail/i.test(dsa)) return interviewed ? "not_cleared" : "not_taken";
  }
  if (/^pass/.test(ai)) return "cleared";
  if (/^fail/.test(ai)) return "not_cleared";
  return null;
}

/** The stage the interview results prove on their own (see the rules above). */
export function edge2EvidenceStage(r: Edge2Record): Edge2StageKey {
  if (r.tr2.some((t) => isHire(t.verdict)) || isHire(r.combined?.verdict)) return "tr2";
  const tr1 = edge2Tr1Outcome(r);
  if (tr1 === "cleared") return "tr1";
  // A TR-2 is only taken or booked after TR-1 is cleared — unless TR-1 is on record as not
  // cleared (a booking left over from before the result does not override it).
  if (tr1 !== "not_cleared" && (r.tr2.length > 0 || (r.tr2Pending?.length ?? 0) > 0)) return "tr1";
  return "assessment";
}

/** The candidate's stage: the higher of the sheet's stage column and the evidence. Everyone in the pool cleared the assessment. */
export function edge2ResolvedStage(r: Edge2Record): Edge2StageKey {
  const sheet = edge2Stage(r.sheetStage ?? "") ?? edge2Stage(r.candidateStage) ?? "assessment";
  const evidence = edge2EvidenceStage(r);
  return STAGE_RANK[evidence] > STAGE_RANK[sheet] ? evidence : sheet;
}

/** "MERN Strong hire". */
const trackVerdict = (t: Edge2Record["tr2"][number]) => `${TR2_TRACK_LABEL[t.track]} ${VERDICT_LABEL[t.verdict]}`;

/**
 * 0-100 from the Edge 2.0 scores, over the parts present: TR-2 verdict 50% (strong 100, medium 85;
 * the best track or the combined interview), TR-1 30% (the AI interview's technical score, else its
 * ratings, else the DSA interview's scores), assessment 20%.
 */
export function edge2InternalScore(r: Edge2Record): number {
  const parts: [number, number][] = [];
  const best = bestTr2(r.tr2);
  const tr2 = [best?.verdict, r.combined?.verdict].filter(isHire).sort((a, b) => verdictRank(a) - verdictRank(b))[0];
  if (tr2) parts.push([tr2 === "strong_hire" ? 100 : 85, 0.5]);
  const t = r.tr1;
  const ratings = [t.dsaOverall, t.problemSolving, t.coding, t.debugging].filter((v): v is number => v !== null);
  const d = r.dsaInterview;
  if (t.overallTechnical !== null) parts.push([t.overallTechnical, 0.3]);
  else if (ratings.length) parts.push([(ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10, 0.3]);
  else if (d && (d.dsaScore !== null || d.csScore !== null)) {
    parts.push([100 * (0.75 * Math.min(1, (d.dsaScore ?? 0) / 120) + 0.25 * Math.min(1, (d.csScore ?? 0) / 40)), 0.3]);
  }
  if (r.offlineOverallScore !== null) parts.push([(r.offlineOverallScore / 160) * 100, 0.2]);
  const w = parts.reduce((s, [, x]) => s + x, 0);
  return w ? clamp(parts.reduce((s, [v, x]) => s + v * x, 0) / w) : 0;
}

/**
 * "Edge 2.0 · TR-2 cleared · MERN Strong hire", "Edge 2.0 · TR-1 cleared · TR-2 not cleared (GenAI
 * Low hire)", "Edge 2.0 · Assessment cleared · TR-1 not cleared". The full results (scores, every
 * round) are in recordDetails (src/lib/pool/details.ts).
 */
export function edge2Standing(r: Edge2Record): Standing {
  const p = PRODUCT_LABEL.edge2;
  const stage = edge2ResolvedStage(r);
  const score = edge2InternalScore(r);
  const byVerdict = [...r.tr2].sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict));
  const pending = (r.tr2Pending ?? []).filter((t) => !r.tr2.some((v) => v.track === t));
  const combined = r.combined?.verdict ?? null;
  const pendingText = pending.length ? `TR-2 pending (${pending.map((t) => TR2_TRACK_LABEL[t]).join(", ")})` : "";
  const join = (...parts: string[]) => [p, ...parts.filter(Boolean)].join(" · ");

  if (stage === "tr2") {
    const hires = [...byVerdict.filter((t) => isHire(t.verdict)).map(trackVerdict), ...(isHire(combined) ? [`Combined interview ${VERDICT_LABEL[combined]}`] : [])];
    // Cleared by the sheet's stage alone: no verdict on record to name.
    return { tier: 1, label: join("TR-2 cleared", hires.join(", ")), internalScore: score, eligible: true };
  }
  if (stage === "tr1") {
    const notCleared = byVerdict.filter((t) => !isHire(t.verdict));
    return {
      tier: 2,
      label: join("TR-1 cleared", notCleared.length ? `TR-2 not cleared (${notCleared.map(trackVerdict).join(", ")})` : "", pendingText),
      internalScore: score,
      eligible: true,
    };
  }
  const combinedText = combined ? `Combined interview not cleared (${VERDICT_LABEL[combined]})` : /pending/i.test(r.combined?.state ?? "") ? "Combined interview pending" : "";
  const tr1 = edge2Tr1Outcome(r);
  return {
    tier: 3,
    label: join("Assessment cleared", tr1 === "not_cleared" ? "TR-1 not cleared" : tr1 === "not_taken" ? "TR-1 not taken yet" : "", combinedText),
    internalScore: score,
    eligible: true,
  };
}

// ── Academy ──────────────────────────────────────────────────────────────────

const LEVEL_POINTS: Record<number, number> = { 5: 100, 4: 94, 3: 86 };

export function academyStanding(r: AcademyRecord): Standing {
  const p = PRODUCT_LABEL.academy;
  const round = (bucket: "A" | "B" | "C", n: 1 | 2) => r.rounds.find((x) => x.bucket === bucket && x.round === n);
  const aTr1 = round("A", 1);
  const aTr1Verdict = aTr1 ? parseVerdict(aTr1.status) : null;
  const aTr1Cleared = Boolean(aTr1?.cleared);
  const aTr2Cleared = Boolean(round("A", 2)?.cleared);
  const bTr1Cleared = Boolean(round("B", 1)?.cleared);
  const bTr2Cleared = Boolean(round("B", 2)?.cleared);
  const cTr1Cleared = Boolean(round("C", 1)?.cleared);
  const topLevels = r.competency
    .filter((c) => c.cleared && (c.level ?? 0) >= 3)
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0));

  if (aTr2Cleared || topLevels.length) {
    const parts = [
      ...(aTr2Cleared ? ["Bucket A TR-2 cleared"] : []),
      ...topLevels.map((c) => `${COMPETENCY_LABEL[c.subject]} L${c.level}`),
    ];
    const aTr2Score = round("A", 2)?.score ?? null;
    const points = Math.max(aTr2Cleared ? 90 + Math.min(8, (aTr2Score ?? 0) / 12) : 0, ...topLevels.map((c) => LEVEL_POINTS[c.level ?? 0] ?? 0));
    return { tier: 1, label: `${p} · ${parts.join(" · ")}`, internalScore: clamp(points), eligible: true };
  }
  if (aTr1Cleared || bTr1Cleared || bTr2Cleared || cTr1Cleared) {
    const label = bTr2Cleared
      ? "Bucket B TR-2 cleared (frontend)"
      : aTr1Cleared
        ? `Bucket A TR-1 ${aTr1Verdict ? VERDICT_LABEL[aTr1Verdict] : "cleared"}`
        : bTr1Cleared
          ? "Bucket B TR-1 cleared"
          : "Bucket C TR-1 cleared";
    const points = bTr2Cleared ? 72 : aTr1Cleared ? (aTr1Verdict === "strong_hire" ? 74 : 68) : bTr1Cleared ? 62 : 56;
    return { tier: 2, label: `${p} · ${label}`, internalScore: points, eligible: true };
  }
  const lower = r.competency.filter((c) => c.cleared).sort((a, b) => (b.level ?? 0) - (a.level ?? 0))[0];
  const bucketPoints: Record<string, number> = { A: 46, B: 42, C: 38, D: 34 };
  const points = Math.max(
    r.oldBucket ? bucketPoints[r.oldBucket] : 30,
    r.dsaOfflineCleared ? 44 : 0,
    lower ? 40 + (lower.level ?? 0) * 4 : 0,
  );
  const label = [
    r.oldBucket ? `Bucket ${r.oldBucket} (DSA offline)` : "",
    r.dsaOfflineCleared ? "DSA competency exam cleared" : "",
    lower ? `${COMPETENCY_LABEL[lower.subject]} ${lower.levelLabel || "cleared"}` : "",
  ].filter(Boolean);
  return { tier: 3, label: `${p} · ${label.length ? label.join(" · ") : "Assessment cleared"}`, internalScore: clamp(points), eligible: true };
}

export function standingOf(r: PoolRecord): Standing {
  return r.product === "edge1" ? edge1Standing(r) : r.product === "edge2" ? edge2Standing(r) : academyStanding(r);
}
