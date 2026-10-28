import type { Product, Tier } from "@/lib/pool/types";

/**
 * The eligibility rules in words — the same rules src/lib/pool/standing.ts applies,
 * written for the dashboard and the Domain shortlisting help. Keep the two in step.
 */
export const TIER_RULES: { tier: Exclude<Tier, 4>; title: string; rules: Record<Product, string> }[] = [
  {
    tier: 1,
    title: "TR-2 cleared · top level",
    rules: {
      edge2: "TR-2 cleared — Strong or Medium hire in a track (Low hire is not a clear)",
      edge1: "TR-2 shortlisted",
      academy: "Bucket A TR-2 cleared, or L3 / L4 / L5 in any competency interview",
    },
  },
  {
    tier: 2,
    title: "TR-1 cleared",
    rules: {
      edge2: "TR-1 cleared",
      edge1: "TR-1 Strong or Medium hire",
      academy: "TR-1 cleared in Bucket A, B or C",
    },
  },
  {
    tier: 3,
    title: "Assessment cleared",
    rules: {
      edge2: "DSA offline assessment cleared",
      edge1: "Assessment selected",
      academy: "Old DSA offline (Bucket A–D) or a competency exam",
    },
  },
];

/** Domain shortlisting's order. Gates the run sets (mandatory, experience, DSA, commits, presentation) apply to everyone. */
export const SHORTLIST_ORDER: { group: 1 | 2 | 3; title: string; detail: string }[] = [
  { group: 1, title: "Assessed + good resume", detail: "Internally assessed, domain fit 55+. Ranked TR-2 → TR-1 → assessment, then by score." },
  { group: 2, title: "Assessed + average resume", detail: "Internally assessed, domain fit 40–54. Same order inside." },
  { group: 3, title: "External, best resumes", detail: "Not in the pool, domain fit 55+. Ranked by score." },
];
