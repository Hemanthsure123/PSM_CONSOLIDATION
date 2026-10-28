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
 *  - Edge 2.0: the stage is the sheet's "Candidate Stage". TR-2 verdicts per track rank
 *    strong > medium; low hire counts as rejected for TR-2.
 * Academy (everyone in the > 8 LPA assessed pool is eligible):
 *  - top: Bucket A TR-2 cleared, or a competency interview at L3 / L4 / L5;
 *  - then TR-1 cleared in Bucket A (Strong / Medium Hire), B or C — or Bucket B's TR-2;
 *  - then assessment cleared (old DSA offline bucket A > B > C > D, or a competency exam).
 */
export const RULES_VERSION = 1;

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

/** "TR2 CLEARED", "tr1 cleared", "Assessment Cleared" → stage. */
export function edge2Stage(raw: string): "tr2" | "tr1" | "assessment" | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/\btr ?2\b/.test(s)) return "tr2";
  if (/\btr ?1\b/.test(s)) return "tr1";
  if (/\bassess?ment\b/.test(s)) return "assessment";
  return null;
}

/** Best TR-2 verdict over the tracks (best first), and whether it clears TR-2 (low hire doesn't). */
export function bestTr2(tr2: Edge2Record["tr2"]): Edge2Record["tr2"][number] | null {
  return [...tr2].sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict))[0] ?? null;
}

/** 0-100 from the Edge 2.0 scores: TR-2 verdict 50% (strong 100, medium 85), TR-1 30%, assessment 20%, over the parts present. */
export function edge2InternalScore(r: Edge2Record): number {
  const parts: [number, number][] = [];
  const best = bestTr2(r.tr2);
  if (best && (best.verdict === "strong_hire" || best.verdict === "medium_hire")) parts.push([best.verdict === "strong_hire" ? 100 : 85, 0.5]);
  const t = r.tr1;
  if (t.overallTechnical !== null) parts.push([t.overallTechnical, 0.3]);
  else {
    const ratings = [t.dsaOverall, t.problemSolving, t.coding, t.debugging].filter((v): v is number => v !== null);
    if (ratings.length) parts.push([(ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10, 0.3]);
  }
  if (r.offlineOverallScore !== null) parts.push([(r.offlineOverallScore / 160) * 100, 0.2]);
  const w = parts.reduce((s, [, x]) => s + x, 0);
  return w ? clamp(parts.reduce((s, [v, x]) => s + v * x, 0) / w) : 0;
}

export function edge2Standing(r: Edge2Record): Standing {
  const p = PRODUCT_LABEL.edge2;
  const stage = edge2Stage(r.candidateStage);
  const best = bestTr2(r.tr2);
  const score = edge2InternalScore(r);
  const hired = best && (best.verdict === "strong_hire" || best.verdict === "medium_hire") ? best : null;
  if (stage === "tr2") {
    return {
      tier: 1,
      // A combined-interview clear has no track verdict in the pool's columns.
      label: hired ? `${p} · ${TR2_TRACK_LABEL[hired.track]} TR-2 · ${VERDICT_LABEL[hired.verdict]}` : `${p} · TR-2 cleared`,
      internalScore: score,
      eligible: true,
    };
  }
  if (stage === "tr1") {
    const notCleared = r.tr2.filter((v) => v.verdict === "low_hire" || v.verdict === "rejected");
    return {
      tier: 2,
      label: `${p} · TR-1 cleared${notCleared.length ? ` · TR-2 not cleared (${notCleared.map((v) => TR2_TRACK_LABEL[v.track]).join(", ")})` : ""}`,
      internalScore: score,
      eligible: true,
    };
  }
  // Everyone in the 2027 pool cleared the DSA offline assessment.
  return { tier: 3, label: `${p} · Assessment cleared`, internalScore: score, eligible: true };
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
