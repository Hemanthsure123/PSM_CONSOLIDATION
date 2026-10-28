import { normalisePhone, normaliseUserId } from "@/lib/pool/parse";
import type { CandidateStanding, InternalStanding } from "@/lib/pool/types";

/**
 * Matching a sheet row to the eligible pool: by phone first, then by user id. Client-safe;
 * the map comes from /api/pool/lookup (keys "p:<phone>" / "u:<userId>").
 */
export function standingFor(map: Record<string, CandidateStanding>, phone: string, userId: string): InternalStanding | null {
  const p = normalisePhone(phone ?? "");
  const byPhone = p ? map[`p:${p}`] : undefined;
  const u = byPhone ? null : normaliseUserId(userId ?? "");
  const s = byPhone ?? (u ? map[`u:${u}`] : undefined);
  if (!s) return null;
  return {
    tier: s.bestTier,
    label: s.bestLabel,
    product: s.bestProduct,
    score: s.bestScore,
    eligible: s.eligible,
    matchedBy: byPhone ? "phone" : "userId",
    standings: s.standings,
  };
}

/** Internal and eligible (tiers 1-3) — the people the shortlist puts first. Tier 4 counts as external. */
export const isAssessed = (s: InternalStanding | null | undefined): s is InternalStanding => Boolean(s && s.eligible && s.tier <= 3);
