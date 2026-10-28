import { clean, cutAtBoundary, supported } from "@/lib/domain-autofill-rules";
import {
  DEFAULT_SP_RULES,
  type SpDsaBar,
  type SpMandatoryItem,
  type SpProfileDef,
  type SpProfileInputs,
  type SpReasonKey,
  type SpRules,
} from "@/lib/showcase/types";

/**
 * Sample profiles from job descriptions — the pure part (browser, server and tests share it):
 * the defaults, the limits every LLM-set value is clamped to, the clean-up of the model's draft
 * (a mandatory item the JD doesn't state is dropped), and the helpers the ranking uses (the
 * loosest DSA bar of a run, one profile's rules, the mandatory checks on evidence and code).
 */

export const PROFILE_MAX = 5;
/** "What defines it" — the judge reads it whole; long enough for a strict, concrete definition. */
export const DEFINES_MAX = 1400;
export const MANDATORY_MAX_ITEMS = 6;
export const GOOD_TO_HAVE_MAX = 12;

/** The tool's defaults — the starting point for a profile typed by hand, and for anything the model leaves out. */
export const DEFAULT_PROFILE_INPUTS: SpProfileInputs = {
  dsaRequired: true,
  dsa: { ...DEFAULT_SP_RULES.dsa },
  strongProject: 75,
  exceptionalProject: 85,
  requireVerified: true,
  proof: { ...DEFAULT_SP_RULES.proof },
  minExperienceMonths: 0,
  minFit: 70,
  showcaseAt: 75,
  strongAt: 60,
  topN: 10,
  trustAgent: true,
  weights: { projects: 45, dsa: 15, engineering: 10, fit: 30, experience: 10 },
};

export const REASON_LABEL: Record<SpReasonKey, string> = {
  dsa: "DSA",
  projects: "Strong projects",
  verified: "Verified in code",
  experience: "Experience",
  fit: "Fit to the profile",
  tiers: "Showcase / Strong cut-offs",
  topN: "Profiles to send",
  trust: "Trust check",
  weights: "Score weights",
};

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Every value in range, and consistent (exceptional above strong, Strong below Showcase, a score that weighs something). */
export function clampInputs(raw: unknown, base: SpProfileInputs = DEFAULT_PROFILE_INPUTS): SpProfileInputs {
  const o = obj(raw);
  const d = obj(o.dsa);
  const p = obj(o.proof);
  const w = obj(o.weights);
  const dsa: SpDsaBar = {
    codeforces: num(d.codeforces, base.dsa.codeforces, 800, 3000),
    codechef: num(d.codechef, base.dsa.codechef, 1000, 3000),
    leetcode: num(d.leetcode, base.dsa.leetcode, 1200, 3000),
    leetcodeSolved: num(d.leetcodeSolved, base.dsa.leetcodeSolved, 0, 3000),
    minContests: num(d.minContests, base.dsa.minContests, 0, 50),
  };
  const strongProject = num(o.strongProject, base.strongProject, 50, 95);
  const exceptionalProject = Math.max(Math.min(100, strongProject + 5), num(o.exceptionalProject, base.exceptionalProject, 55, 100));
  // The model gives the share as a percentage; a stored profile keeps a fraction.
  const shareRaw = p.minSharePct !== undefined ? Number(p.minSharePct) / 100 : p.minShare !== undefined ? Number(p.minShare) : base.proof.minShare;
  const minShare = Number.isFinite(shareRaw) ? Math.max(0.1, Math.min(1, Math.round(shareRaw * 100) / 100)) : base.proof.minShare;
  const showcaseAt = num(o.showcaseAt, base.showcaseAt, 50, 95);
  const strongAt = Math.min(showcaseAt, num(o.strongAt, base.strongAt, 30, 95));
  const dsaRequired = bool(o.dsaRequired, base.dsaRequired);
  const weights = {
    projects: num(w.projects, base.weights.projects, 0, 100),
    dsa: num(w.dsa, base.weights.dsa, 0, 100),
    engineering: num(w.engineering, base.weights.engineering, 0, 100),
    fit: num(w.fit, base.weights.fit, 0, 100),
    experience: num(w.experience, base.weights.experience, 0, 40),
  };
  if (weights.projects + weights.dsa + weights.engineering + weights.fit === 0) Object.assign(weights, { projects: base.weights.projects, fit: base.weights.fit });
  return {
    dsaRequired,
    dsa,
    strongProject,
    exceptionalProject,
    requireVerified: bool(o.requireVerified, base.requireVerified),
    proof: {
      minOwnCommits: num(p.minOwnCommits, base.proof.minOwnCommits, 1, 100),
      minShare,
      minDays: num(p.minDays, base.proof.minDays, 1, 60),
      minSrcFiles: num(p.minSrcFiles, base.proof.minSrcFiles, 1, 200),
      allowAiTraces: bool(p.allowAiTraces, base.proof.allowAiTraces),
    },
    minExperienceMonths: num(o.minExperienceMonths, base.minExperienceMonths, 0, 60),
    minFit: num(o.minFit, base.minFit, 40, 95),
    showcaseAt,
    strongAt,
    topN: num(o.topN, base.topN, 1, 30),
    trustAgent: bool(o.trustAgent, base.trustAgent),
    weights,
  };
}

// ── The model's draft ────────────────────────────────────────────────────────

export interface ProfileDraft {
  name: string;
  definesIt: string;
  mandatory: { item: string; quote: string }[];
  goodToHave: string[];
  notJudged: string[];
  inputs: SpProfileInputs;
  reasons: Partial<Record<SpReasonKey, string>>;
}

const list = (v: unknown, max: number, each = 80): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.map((x) => clean(x, each)).filter(Boolean))).slice(0, max) : [];

/** The model's raw JSON → a draft (never throws; missing values fall back to the defaults). */
export function parseProfileDraft(json: unknown): ProfileDraft {
  const o = obj(json);
  const mandatory = (Array.isArray(o.mandatory) ? o.mandatory : [])
    .map((m) => (typeof m === "string" ? { item: clean(m, 80), quote: "" } : { item: clean(obj(m).item, 80), quote: clean(obj(m).quote, 300) }))
    .filter((m) => m.item);
  const r = obj(o.reasons);
  const reasons: Partial<Record<SpReasonKey, string>> = {};
  for (const k of Object.keys(REASON_LABEL) as SpReasonKey[]) {
    const s = clean(r[k], 240);
    if (s) reasons[k] = s;
  }
  return {
    name: clean(o.domainName ?? o.name, 80),
    definesIt: clean(o.definesIt, 4_000),
    mandatory,
    goodToHave: list(o.goodToHave, GOOD_TO_HAVE_MAX, 60),
    notJudged: list(o.notJudged, 10, 120),
    inputs: clampInputs(o.inputs),
    reasons,
  };
}

const normItem = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();

/**
 * A draft that fits the tool: mandatory items the JD doesn't state are dropped (only when the
 * JD's text is there to check against), duplicates and extras go, "What defines it" is cut at
 * a sentence boundary.
 */
export function finishProfileDraft(draft: ProfileDraft, sourceText: string): { draft: ProfileDraft; dropped: string[]; verified: boolean } {
  const verified = sourceText.trim().length >= 40;
  const dropped: string[] = [];
  const kept: { item: string; quote: string }[] = [];
  const seen = new Set<string>();
  for (const m of draft.mandatory) {
    const key = normItem(m.item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (verified && !supported(m, sourceText)) {
      dropped.push(`${m.item} — not stated as a requirement in the JD`);
      continue;
    }
    if (kept.length >= MANDATORY_MAX_ITEMS) {
      dropped.push(`${m.item} — over the ${MANDATORY_MAX_ITEMS}-item limit`);
      continue;
    }
    kept.push(m);
  }
  const mandatoryKeys = new Set(kept.map((m) => normItem(m.item)));
  return {
    draft: {
      ...draft,
      definesIt: cutAtBoundary(draft.definesIt, DEFINES_MAX),
      mandatory: kept,
      goodToHave: draft.goodToHave.filter((g) => !mandatoryKeys.has(normItem(g))),
    },
    dropped,
    verified,
  };
}

// ── Profiles in a run ────────────────────────────────────────────────────────

export const newProfile = (id: string): SpProfileDef => ({
  id,
  name: "",
  definesIt: "",
  mandatory: [],
  goodToHave: [],
  inputs: structuredClone(DEFAULT_PROFILE_INPUTS),
  llmInputs: null,
  reasons: {},
  notJudged: [],
  source: null,
  model: "",
  draftedAt: "",
});

/** The next free id ("p1", "p2" …). */
export function nextProfileId(profiles: SpProfileDef[]): string {
  const used = new Set(profiles.map((p) => p.id));
  for (let i = 1; ; i++) if (!used.has(`p${i}`)) return `p${i}`;
}

/** Ready to run: a name and a definition. */
export const profileReady = (p: SpProfileDef) => p.name.trim().length > 0 && p.definesIt.trim().length >= 40;

/** Is "React or Angular" one-of, "Java, Spring Boot" all-of? */
export const mandatoryMode = (item: string): "any" | "all" => (/\bor\b|\//i.test(item) ? "any" : "all");

/** A stable hash of what the judge reads (names, definitions, mandatory, good to have) — an edit asks for a new judgement. */
export function profilesHash(profiles: SpProfileDef[]): string {
  const basis = JSON.stringify(
    [...profiles]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => [p.id, p.name.trim(), p.definesIt.trim(), p.mandatory.map((m) => m.item.trim()), p.goodToHave.map((g) => g.trim())]),
  );
  // cyrb53 — small, stable, browser-safe.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < basis.length; i++) {
    const ch = basis.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The bar a candidate must clear for at least one DSA profile (the lowest of each number). Null when no profile needs DSA. */
export function loosestBar(profiles: SpProfileDef[]): SpDsaBar | null {
  const bars = profiles.filter((p) => p.inputs.dsaRequired).map((p) => p.inputs.dsa);
  if (!bars.length) return null;
  return {
    codeforces: Math.min(...bars.map((b) => b.codeforces)),
    codechef: Math.min(...bars.map((b) => b.codechef)),
    leetcode: Math.min(...bars.map((b) => b.leetcode)),
    leetcodeSolved: Math.min(...bars.map((b) => b.leetcodeSolved)),
    minContests: Math.min(...bars.map((b) => b.minContests)),
  };
}

/** The bar the run reads DSA for: the loosest of its DSA profiles (the tool's default when none needs DSA). */
export const runDsaBar = (profiles: SpProfileDef[]): SpDsaBar => loosestBar(profiles) ?? { ...DEFAULT_SP_RULES.dsa };

/** One profile's settings as the role-mode rules the shared checks read (DSA bar, project caps, proof thresholds). */
export function rulesForProfile(rules: SpRules, p: SpProfileDef): SpRules {
  const i = p.inputs;
  return {
    ...rules,
    dsa: i.dsa,
    strongProject: i.strongProject,
    exceptionalProject: i.exceptionalProject,
    proof: i.proof,
    showcaseAt: i.showcaseAt,
    strongAt: i.strongAt,
    topN: i.topN,
    trustAgent: i.trustAgent,
    weights: { projects: i.weights.projects, dsa: i.weights.dsa, engineering: i.weights.engineering, experience: i.weights.experience },
  };
}

/**
 * A language its frameworks imply: a React or Node.js project is JavaScript work, a Spring Boot
 * one is Java, pandas / PyTorch / Django are Python — resumes name the framework, not the language.
 */
const IMPLIED: Record<string, string[]> = {
  javascript: ["react", "nodejs", "angular", "vue", "react-native", "typescript"],
  python: ["pytorch", "scikit-learn", "transformers", "fastapi-or-flask", "django", "pandas", "tensorflow", "huggingface"],
  java: ["spring-boot"],
  php: ["laravel"],
  ruby: ["rails"],
  "machine-learning": ["scikit-learn", "pytorch", "tensorflow"],
};

/** The keys plus the languages their frameworks imply. */
export function withImplied(keys: Iterable<string>): Set<string> {
  const out = new Set(keys);
  for (const [lang, by] of Object.entries(IMPLIED)) if (by.some((k) => out.has(k))) out.add(lang);
  return out;
}

/** Does a set of technology keys satisfy a mandatory item? Items naming no catalogued technology are left to the judge (true). */
export function itemCovered(m: SpMandatoryItem, keys: Set<string>): boolean {
  if (!m.keys.length) return true;
  const all = withImplied(keys);
  return m.mode === "any" ? m.keys.some((k) => all.has(k)) : m.keys.every((k) => all.has(k));
}

/** The mandatory technologies a profile can check in code. */
export const codeCheckable = (p: SpProfileDef) => p.mandatory.filter((m) => m.keys.length);

/** Every input in one line (internal workbook). */
export function inputsInWords(i: SpProfileInputs): string {
  return [
    i.dsaRequired ? `DSA CF ${i.dsa.codeforces} / CC ${i.dsa.codechef} / LC ${i.dsa.leetcode} with ${i.dsa.leetcodeSolved} solved, ${i.dsa.minContests} contests` : "DSA not required",
    `strong ${i.strongProject} / exceptional ${i.exceptionalProject}`,
    i.requireVerified
      ? `verified in code: ${i.proof.minOwnCommits} own commits, ${Math.round(i.proof.minShare * 100)}% share, ${i.proof.minDays} days, ${i.proof.minSrcFiles} files${i.proof.allowAiTraces ? ", AI traces allowed" : ""}`
      : "code proof off",
    `experience ≥ ${i.minExperienceMonths} months`,
    `fit ≥ ${i.minFit}`,
    `Showcase ≥ ${i.showcaseAt}, Strong ≥ ${i.strongAt}`,
    `top ${i.topN}`,
    `trust ${i.trustAgent ? "on" : "off"}`,
    `weights projects ${i.weights.projects} · DSA ${i.weights.dsa} · GitHub ${i.weights.engineering} · fit ${i.weights.fit} · experience +${i.weights.experience}`,
  ].join("; ");
}

/** Plain words for one profile's bar (workbooks, help). */
export function profileRulesInWords(p: SpProfileDef): string[][] {
  const i = p.inputs;
  const d = i.dsa;
  return [
    ["What defines it", p.definesIt],
    ["Mandatory (verified)", p.mandatory.length ? p.mandatory.map((m) => m.item).join("; ") : "—"],
    ["Good to have", p.goodToHave.join(", ") || "—"],
    [
      "DSA",
      i.dsaRequired
        ? `Codeforces ≥ ${d.codeforces} or CodeChef ≥ ${d.codechef} (highest rating), or LeetCode contest rating ≥ ${d.leetcode} with ${d.leetcodeSolved}+ problems solved — at least ${d.minContests} rated contests`
        : "Not required for this profile",
    ],
    ["Projects", `2 strong projects relevant to the profile (quality ≥ ${i.strongProject}), or 1 exceptional (≥ ${i.exceptionalProject}) plus relevant experience; course / tutorial / clone work doesn't count`],
    [
      "Verified in code",
      i.requireVerified
        ? `A strong relevant project in the candidate's own repository (${i.proof.minOwnCommits}+ own commits, ${Math.round(i.proof.minShare * 100)}%+ theirs, ${i.proof.minDays}+ days, ${i.proof.minSrcFiles}+ source files${i.proof.allowAiTraces ? "" : ", no AI app-generator traces"}), and every mandatory technology shown in their own code`
        : "Not required for this profile",
    ],
    ["Experience", i.minExperienceMonths ? `At least ${i.minExperienceMonths} months of relevant internship / job` : "A bonus, not required"],
    ["Fit", `Judged fit to the profile ≥ ${i.minFit} of 100, from projects, experience, certifications and achievements only`],
  ];
}
