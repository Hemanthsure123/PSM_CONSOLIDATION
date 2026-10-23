import {
  AC_BUCKETS,
  AC_BUCKET_LABEL,
  AC_EVAL_VERSION,
  ZERO_SCORES,
  type AcBucket,
  type AcCandidate,
  type AcEvaluation,
  type AcGithubRepo,
  type AcPlacement,
  type AcResumeItem,
  type AcRules,
  type AcScores,
  type AcStack,
  type AcTrustCategory,
  type AcTrustFlag,
  type AcTrustSeverity,
} from "@/lib/academy/types";

/**
 * Academy bucketing — the program's decisions, in the browser. Pure: changing a
 * rule re-buckets instantly and no resume is read again.
 *
 * Per candidate, each switched-on signal scores the four buckets 0-100:
 *  - resume: every project / internship / job, classified by the technologies the
 *    resume names for it (the model's reading only when it names none), weighted
 *    by kind and depth; the Skills list adds a little;
 *  - GitHub: every inspected repo, classified by what its CODE proves;
 *  - competency: the competency interview levels in sheet 1 (Frontend → Frontend …);
 *  - student preference: the roles / stacks the student asked for.
 * The signals are averaged by weight over the ones the candidate has. One bucket
 * per candidate; Mixed only when the runner-up is within the margin and both are
 * strong. Inside a bucket: Active · Not placed first, then stack fit, internal
 * assessments and DSA.
 */

// ── Technologies → stacks (github-analysis.ts catalogue keys) ────────────────

const FE_STRONG = new Set(["react", "angular", "vue", "html-css"]);
const FE_WEAK = new Set(["javascript", "typescript"]);
const BE = new Set([
  "nodejs",
  "django",
  "fastapi-or-flask",
  "spring-boot",
  "dotnet",
  "go",
  "php",
  "laravel",
  "ruby",
  "rails",
  "sql",
  "mongodb",
  "redis",
  "kafka",
]);
/**
 * "REST APIs" / "GraphQL" on a resume item may only mean the UI CALLS an API; they
 * count as backend only where building one is shown — a repo's code, the Skills list.
 */
const BE_BUILT = new Set([...BE, "rest-api", "graphql"]);
const AI_STRONG = new Set([
  "pytorch",
  "scikit-learn",
  "transformers",
  "llm",
  "llm-finetuning",
  "llm-inference",
  "huggingface",
  "nlp",
  "model-evaluation",
  "image-analysis",
  "tensorflow",
  "time-series",
  "machine-learning",
  "healthcare-ai",
]);
/** Data analysis tools: AI-ML (DS) only when nothing else decides. */
const AI_DATA = new Set(["pandas", "spark", "powerbi", "tableau", "data-viz", "excel"]);
const MOBILE = new Set(["android", "flutter", "swift-ios", "react-native", "android-architecture", "app-release"]);

export interface TechSides {
  fe: boolean;
  be: boolean;
  ai: boolean;
  data: boolean;
  mobile: boolean;
}

export function techSides(keys: string[], built = false): TechSides {
  const k = new Set(keys);
  const mobile = [...k].some((x) => MOBILE.has(x));
  // "React Native" also reads as React — a mobile app is not web frontend.
  if (k.has("react-native")) k.delete("react");
  const be = [...k].some((x) => (built ? BE_BUILT : BE).has(x));
  const fe = [...k].some((x) => FE_STRONG.has(x)) || ([...k].some((x) => FE_WEAK.has(x)) && !be);
  return { fe, be, ai: [...k].some((x) => AI_STRONG.has(x)), data: [...k].some((x) => AI_DATA.has(x)), mobile };
}

/** Which stack one resume item is — from its technologies; the model's reading when they don't decide. */
export function classifyItem(model: AcStack, keys: string[]): { stack: AcStack; why: string } {
  const s = techSides(keys);
  if (s.ai) {
    if (model === "fullstack" && s.fe && s.be) return { stack: "fullstack", why: "UI + own server + database, with an AI feature" };
    return { stack: "aiml", why: "ML / GenAI technologies" };
  }
  if (s.mobile && model === "other") return { stack: "other", why: "mobile app" };
  if (s.fe && s.be) return { stack: "fullstack", why: "UI and server / database technologies" };
  if (s.fe) return model === "fullstack" ? { stack: "fullstack", why: "described as full stack" } : { stack: "frontend", why: "UI technologies only" };
  if (s.be) {
    if (model === "fullstack") return { stack: "fullstack", why: "described as full stack" };
    if (model === "aiml") return { stack: "aiml", why: "described as ML / data work" };
    return { stack: "backend", why: "server / database technologies only" };
  }
  if (s.data && (model === "aiml" || model === "other")) return { stack: "aiml", why: "data analysis tools" };
  return { stack: model, why: keys.length ? "the model's reading (technologies don't decide)" : "the model's reading (no technologies named)" };
}

/** A repo's stack from what its code proves (no model). */
export function classifyRepo(keys: string[]): AcStack {
  const s = techSides(keys, true);
  if (s.ai) return "aiml";
  if (s.mobile && !s.be) return "other";
  if (s.fe && s.be) return "fullstack";
  if (s.fe) return "frontend";
  if (s.be) return "backend";
  if (s.data) return "aiml";
  return "other";
}

// ── Signal scores ────────────────────────────────────────────────────────────

export const KIND_WEIGHT: Record<AcResumeItem["kind"], number> = { job: 1.6, internship: 1.3, freelance: 1.2, project: 1 };
export const DEPTH_WEIGHT: Record<AcResumeItem["depth"], number> = { production: 1.25, substantial: 1, basic: 0.5 };
const ITEM_POINTS = 25;
const REPO_POINTS = 30;
const SKILL_POINTS = 3;
const SKILL_CAP = 12;
/** Soft ceiling: more evidence keeps counting, with diminishing returns (25 → 39, 50 → 63, 100 → 86, 200 → 98). */
const SOFT_K = 50;
const soft = (raw: number) => (raw <= 0 ? 0 : Math.round(100 * (1 - Math.exp(-raw / SOFT_K))));

/**
 * Raw evidence per bucket → 0-100. Full-stack work also counts toward Frontend and Backend by the
 * side the candidate worked on (`fsSides`), and separate frontend + backend work counts toward
 * Full Stack (the smaller of the two).
 */
function scoresFrom(direct: AcScores, fsSides: { fe: number; be: number }): AcScores {
  const fe = direct.frontend + fsSides.fe;
  const be = direct.backend + fsSides.be;
  const fs = direct.fullstack + Math.min(direct.frontend, direct.backend);
  return { frontend: soft(fe), backend: soft(be), aiml: soft(direct.aiml), fullstack: soft(fs) };
}

const FE_UI = new Set(["react", "angular", "vue"]);
const BE_SERVER = new Set(["nodejs", "django", "fastapi-or-flask", "spring-boot", "dotnet", "go", "php", "laravel", "ruby", "rails"]);
const BE_DATA = new Set(["sql", "mongodb", "redis", "kafka"]);
const BE_API = new Set(["rest-api", "graphql"]);

/**
 * Backend share (0-1) of a full-stack item / repo from its technologies, by layer so a MERN app
 * is 50/50: frontend = UI framework + styling (of 2), backend = server + data + API (of 3).
 */
export function techMixBackendShare(keys: string[]): number {
  const k = new Set(keys);
  const has = (set: Set<string>) => ([...k].some((x) => set.has(x)) ? 1 : 0);
  const fe = (has(FE_UI) + (k.has("html-css") ? 1 : 0)) / 2;
  const be = (has(BE_SERVER) + has(BE_DATA) + has(BE_API)) / 3;
  return fe + be ? be / (fe + be) : 0.5;
}

/** Backend share of a full-stack resume item: the side the resume says they worked on, else its technologies. */
export function itemBackendShare(item: AcResumeItem): number {
  if (item.focus === "backend") return 0.75;
  if (item.focus === "frontend") return 0.25;
  if (item.focus === "balanced") return 0.5;
  return techMixBackendShare(item.techKeys);
}

/** The candidate's own frontend vs backend work in points (projects, internships, jobs or repos; skills lists excluded). */
export interface WebWork {
  fe: number;
  be: number;
}

export interface ClassifiedItem {
  item: AcResumeItem;
  stack: AcStack;
  why: string;
  points: number;
}

export interface ResumeSignal {
  scores: AcScores;
  web: WebWork;
  items: ClassifiedItem[];
  skillCounts: Record<"frontend" | "backend" | "aiml", number>;
}

export function resumeSignal(e: AcEvaluation): ResumeSignal | null {
  if (e.status !== "ok" || (!e.items.length && !e.skillKeys.length)) return null;
  const direct: AcScores = { ...ZERO_SCORES };
  const sides = { fe: 0, be: 0 };
  const items = e.items.map((item) => {
    const c = classifyItem(item.stack, item.techKeys);
    const points = ITEM_POINTS * KIND_WEIGHT[item.kind] * DEPTH_WEIGHT[item.depth];
    if (c.stack !== "other") direct[c.stack] += points;
    if (c.stack === "fullstack") {
      const share = itemBackendShare(item);
      sides.be += points * share;
      sides.fe += points * (1 - share);
    }
    return { item, stack: c.stack, why: c.why, points: c.stack === "other" ? 0 : Math.round(points * 10) / 10 };
  });
  const web: WebWork = { fe: direct.frontend + sides.fe, be: direct.backend + sides.be };
  const k = new Set(e.skillKeys);
  const count = (set: Set<string>) => [...k].filter((x) => set.has(x)).length;
  const skillCounts = {
    frontend: count(FE_STRONG) + count(FE_WEAK),
    backend: count(BE_BUILT),
    aiml: count(AI_STRONG) + count(AI_DATA),
  };
  const sk = (n: number) => Math.min(SKILL_CAP, SKILL_POINTS * n);
  direct.frontend += sk(skillCounts.frontend);
  direct.backend += sk(skillCounts.backend);
  direct.aiml += sk(skillCounts.aiml);
  return { scores: scoresFrom(direct, sides), web, items, skillCounts };
}

export interface GithubSignal {
  scores: AcScores;
  /** How much the signal speaks for each bucket (0-1): a bucket with no repo counts half — not every project is on GitHub. */
  observes: AcScores;
  web: WebWork;
  repos: { repo: AcGithubRepo; stack: AcStack; points: number }[];
}

/** Course exercises and practice repos ("…-CODING-PRACTICE-24", "matchGame-…-Assignment-3") show little of a stack. */
const PRACTICE_REPO = /coding[-_ ]?practice|practice|assignment|exercise|tutorial|course|learning|sample|demo|hello[-_ ]?world|test(ing)?[-_ ]?repo/i;
/** The academy's own course projects (NxtTrendz, NxtWatch, …): every student has them, so they count for half. */
const COURSE_REPO = /^nxt[-_ ]?[a-z]/i;

/** How much one repo counts: practice 0.3, course project 0.5, hard AI-authorship evidence halves it. */
export function repoWeight(repo: AcGithubRepo): number {
  const kind = PRACTICE_REPO.test(repo.name) ? 0.3 : COURSE_REPO.test(repo.name) ? 0.5 : 1;
  return kind * (repo.aiLikelihood === "high" ? 0.5 : 1);
}

export function githubSignal(e: AcEvaluation): GithubSignal | null {
  const g = e.github;
  if (!g || g.status !== "checked") return null;
  const direct: AcScores = { ...ZERO_SCORES };
  const sides = { fe: 0, be: 0 };
  const repos = g.repos.map((repo) => {
    const stack = classifyRepo(repo.techKeys);
    const points = stack === "other" || !repo.relevant ? 0 : Math.round(REPO_POINTS * repoWeight(repo) * 10) / 10;
    if (points) direct[stack as AcBucket] += points;
    if (points && stack === "fullstack") {
      const share = techMixBackendShare(repo.techKeys);
      sides.be += points * share;
      sides.fe += points * (1 - share);
    }
    return { repo, stack, points };
  });
  if (!repos.some((r) => r.points > 0)) return null;
  const scores = scoresFrom(direct, sides);
  const observes = Object.fromEntries(AC_BUCKETS.map((b) => [b, scores[b] > 0 ? 1 : 0.5])) as AcScores;
  return { scores, observes, web: { fe: direct.frontend + sides.fe, be: direct.backend + sides.be }, repos };
}

/** L4 100 · L3 80 · L2 55 · L1 35 · Below 15. */
export function levelValue(level: string): number | null {
  const s = (level ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^below/.test(s)) return 15;
  const m = s.match(/^l\s*([1-4])\b/);
  return m ? [0, 35, 55, 80, 100][Number(m[1])] : null;
}

export interface CompetencySignal {
  scores: AcScores;
  /**
   * An interview speaks fully for its own stack and at half weight for the others (a Frontend
   * interview says little about AI-ML, so it neither sinks nor props up that bucket).
   */
  observes: AcScores;
  used: string[];
}

export function competencySignal(c: AcCandidate): CompetencySignal | null {
  const s: AcScores = { ...ZERO_SCORES };
  const observes: AcScores = { frontend: 0.5, backend: 0.5, aiml: 0.5, fullstack: 0.5 };
  const used: string[] = [];
  for (const k of c.competencies) {
    if (!k.bucket) continue;
    const v = levelValue(k.level) ?? (k.score !== null ? Math.max(0, Math.min(100, k.score)) : null);
    if (v === null) continue;
    s[k.bucket] = Math.max(s[k.bucket], v);
    observes[k.bucket] = 1;
    if (k.bucket === "frontend" || k.bucket === "backend") observes.fullstack = 1;
    used.push(`${k.name} ${k.level || `${k.score}/100`}`);
  }
  if (!used.length) return null;
  // A frontend (or backend) interview proves most of what full-stack work needs, not the other side:
  // it counts 0.8 toward Full Stack (both together count their average), so the interview backs the
  // web stacks without deciding between Frontend and Full Stack — the resume and GitHub do that.
  const web = s.frontend && s.backend ? (s.frontend + s.backend) / 2 : 0.8 * Math.max(s.frontend, s.backend);
  s.fullstack = Math.max(s.fullstack, Math.round(web));
  return { scores: s, observes, used };
}

const PREF_PATTERNS: [AcBucket, RegExp][] = [
  ["fullstack", /full[\s-]*stack|\bmern\b|\bmean stack\b|\bmevn\b/gi],
  ["aiml", /\bgen(?:erative)?[\s-]*ai\b|\bai\b|\bai\/ml\b|\bml\b|machine learning|deep learning|data scien\w*|data analy\w*|\bllms?\b|\brag\b|\bagentic\b|\bnlp\b|computer vision/gi],
  ["backend", /back[\s-]*end|\bnode(?:\.?js)?\b|\bexpress(?:\.?js)?\b|\bspring(?: boot)?\b|\bdjango\b|\bdatabase\b|\bapi developer\b/gi],
  ["frontend", /front[\s-]*end|\breact(?:\.?js)?\b(?![\s-]*native)|\bui developer\b|\bweb developer\b|\bangular\b|\bvue(?:\.?js)?\b/gi],
];
/** Parts of the preference note that are about logistics, not stacks. */
const PREF_NOISE = /^\s*"?\s*(location|preferred location|ctc|expected|package|bond|noc|immediate|opportunity|availability|current|exam|stipend|priority)/i;
const PREF_RANK = [100, 80, 65, 50];

export interface PreferenceSignal {
  scores: AcScores;
  order: AcBucket[];
}

/** The stacks the student asked for, in the order they were named (a Skills list counts half). */
export function preferenceSignal(text: string): PreferenceSignal | null {
  const parts = (text ?? "").split(/\||\n|;/).map((p) => p.trim()).filter((p) => p && !PREF_NOISE.test(p));
  const first = new Map<AcBucket, number>();
  const strength = new Map<AcBucket, number>();
  let offset = 0;
  for (const p of parts) {
    const w = /^\s*skills?\b/i.test(p) ? 0.5 : 1;
    for (const [b, re] of PREF_PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(p);
      if (!m) continue;
      if (!first.has(b)) first.set(b, offset + m.index);
      strength.set(b, Math.min(1, (strength.get(b) ?? 0) + w));
    }
    offset += p.length + 1;
  }
  if (!first.size) return null;
  const order = [...first.entries()].sort((a, b) => a[1] - b[1]).map(([b]) => b);
  const scores: AcScores = { ...ZERO_SCORES };
  order.forEach((b, i) => {
    scores[b] = Math.round(PREF_RANK[Math.min(i, PREF_RANK.length - 1)] * (strength.get(b) ?? 0));
  });
  return { scores, order };
}

// ── Internal assessments and DSA (ranking only) ──────────────────────────────

const OLD_BASE: Record<string, number> = { A: 70, B: 45, C: 30, D: 15 };

function roundAdjust(status: string): number {
  const s = status.toLowerCase();
  if (/strong hire/.test(s)) return 20;
  if (/medium hire/.test(s)) return 10;
  if (/low hire/.test(s)) return 0;
  if (/reject/.test(s)) return -20;
  if (/shortlist/.test(s)) return 10;
  if (/not\s*cleared/.test(s)) return -5;
  if (/cleared/.test(s)) return 10;
  return 0;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export interface Basis {
  score: number;
  basis: string;
}

/**
 * The strongest internal assessment result (0-100): a competency interview's
 * overall score, DSA Offline cleared, or the old-process bucket (A 70 · B 45 ·
 * C 30 · D 15) moved by its interview rounds (Strong Hire +20 … Rejected −20).
 */
export function assessmentScore(c: AcCandidate): Basis {
  const parts: Basis[] = [];
  for (const k of c.competencies) {
    const v = k.score ?? levelValue(k.level);
    if (v === null) continue;
    parts.push({ score: clamp(v), basis: `${k.name} ${k.level || "interview"}${k.score !== null ? ` · ${k.score}/100` : ""}` });
  }
  if (c.eligibility.dsaOffline) parts.push({ score: 70, basis: "DSA Offline cleared" });
  if (c.oldBucket) {
    const adj = c.oldRounds.reduce((sum, r) => sum + roundAdjust(r.status), 0);
    const rounds = c.oldRounds.filter((r) => r.status).map((r) => `${r.label} ${r.status}`);
    parts.push({ score: clamp(OLD_BASE[c.oldBucket] + adj), basis: `Old Bucket ${c.oldBucket}${rounds.length ? ` (${rounds.join(", ")})` : ""}` });
  }
  if (!parts.length) return { score: 0, basis: "no assessment result" };
  return parts.reduce((best, p) => (p.score > best.score ? p : best), parts[0]);
}

/** DSA strength (0-100): coding profiles, the DSA competency interview, DSA Offline, the old coding exam — the best of them. */
export function dsaStrength(c: AcCandidate, e: AcEvaluation | undefined, useProfiles: boolean): Basis {
  const parts: Basis[] = [];
  if (useProfiles && e?.dsa && e.dsa.score > 0) parts.push({ score: e.dsa.score, basis: `coding profiles ${e.dsa.score}` });
  const dsaComp = c.competencies.find((k) => k.name === "DSA");
  const v = dsaComp ? dsaComp.score ?? levelValue(dsaComp.level) : null;
  if (dsaComp && v !== null) parts.push({ score: clamp(v), basis: `DSA interview ${dsaComp.level || ""}${dsaComp.score !== null ? ` ${dsaComp.score}/100` : ""}`.trim() });
  if (c.eligibility.dsaOffline) parts.push({ score: 60, basis: "DSA Offline cleared" });
  if (c.oldCoding !== null) parts.push({ score: clamp((c.oldCoding / 120) * 100), basis: `old coding exam ${c.oldCoding}/120` });
  if (!parts.length) return { score: 0, basis: "no DSA result" };
  return parts.reduce((best, p) => (p.score > best.score ? p : best), parts[0]);
}

// ── Trust ────────────────────────────────────────────────────────────────────

export type AcTrustBand = "High" | "Medium" | "Low" | "Unverified";

export interface AcTrustCheck {
  label: string;
  /** Points taken off (negative) — 0 for a check that passed. */
  points: number;
  detail: string;
  source: "program" | "agent";
}

export interface AcTrust {
  /** 0-100; null when there is no resume reading to check. */
  score: number | null;
  band: AcTrustBand;
  checks: AcTrustCheck[];
  /** The trust agent reviewed this candidate (its flags are in `checks`). */
  agentRan: boolean;
  summary: string;
}

export const TRUST_BANDS = { high: 80, medium: 60 } as const;
const FLAG_POINTS: Record<AcTrustSeverity, number> = { high: 15, medium: 8, low: 3 };
/** The agent's flags together take at most this much off. */
const AGENT_CAP = 40;
/** A further flag in a category already counted takes off at most this much (one issue, many examples). */
const REPEAT_POINTS = 2;

export const TRUST_CATEGORY_LABEL: Record<AcTrustCategory, string> = {
  identity: "Resume may not be theirs",
  "inflated-claim": "Unsupported claim",
  timeline: "Timeline doesn't add up",
  "template-project": "Course project presented as original",
  inconsistent: "Contradicts other evidence",
  "copied-text": "Generic / copied descriptions",
  "github-authorship": "GitHub work may not be theirs",
  "interview-integrity": "Interview integrity concern",
};

/** Words in an interviewer's note that mean the interview itself can't be fully trusted. */
const INTEGRITY_CUE =
  /reading (?:from|out)|read(?:ing)? (?:from )?(?:somewhere|notes|the screen)|cheat|cop(?:y|ied|ying)|malpractice|suspicious|not genuine|outside help|someone (?:else )?(?:was )?(?:helping|prompting|answering)|prompt(?:ed|ing) by|looking (?:away|elsewhere|off[- ]screen)|camera (?:was )?(?:off|not on|turned off)|not sharing (?:the )?screen/i;

/** A flag whose own reasoning says there is no problem. */
const SELF_REFUTING = /\b(no conflict|(?:is|seems|looks) plausible|consistent with|not (?:a )?contradict\w*|aligns? with|is aligned|no issue)\b/i;
const SOLVED_CLAIM = /(\d{2,4})\s*\+?\s*(?:dsa |coding |leetcode |dsa\/coding )?(?:problems|questions|solved)/i;

/**
 * Agent flags the program sets aside: reasoning that refutes itself ("plausible, so no conflict"),
 * a missed interview called an integrity issue, a "solved N+" claim the linked profiles meet.
 */
function setAside(f: AcTrustFlag, e: AcEvaluation): boolean {
  if (SELF_REFUTING.test(f.why)) return true;
  if (f.category === "interview-integrity" && !INTEGRITY_CUE.test(`${f.evidence} ${f.why}`) && !/integrity\s*[0-3](?:\.\d+)?\s*\/\s*5/i.test(f.evidence)) return true;
  const claim = f.category === "inconsistent" || f.category === "inflated-claim" ? `${f.evidence}`.match(SOLVED_CLAIM) : null;
  const solved = e.dsa?.totalSolved ?? null;
  if (claim && solved !== null && solved >= 0.9 * Number(claim[1])) return true;
  return false;
}

const bandOf = (score: number): AcTrustBand => (score >= TRUST_BANDS.high ? "High" : score >= TRUST_BANDS.medium ? "Medium" : "Low");

/**
 * How far the candidate's evidence can be trusted (0-100). The program's own checks — does the
 * resume carry the sheet's email / mobile, AI-written commits on GitHub, the interviewers'
 * integrity scores and notes, resume claims against the interview level — plus the trust agent's
 * flags, each grounded in exact words (high −15, medium −8, low −3; a further flag of the same kind
 * −2; at most −40 in all). Where
 * the agent already raised a point, the program's matching check isn't counted twice.
 */
export function trustScore(c: AcCandidate, e: AcEvaluation | undefined): AcTrust {
  if (!e || e.status !== "ok") return { score: null, band: "Unverified", checks: [], agentRan: false, summary: "" };
  const checks: AcTrustCheck[] = [];
  const all = e.trust?.flags ?? [];
  const flags = all.filter((f) => !setAside(f, e));
  const agentHas = (cat: AcTrustCategory) => flags.some((f) => f.category === cat);
  const add = (label: string, points: number, detail: string, source: AcTrustCheck["source"] = "program") => checks.push({ label, points, detail, source });

  const id = e.identity;
  const proven = Boolean(id && (id.emailFound || id.phoneFound));
  if (id) {
    if (proven) add("Resume belongs to this candidate", 0, `the sheet's ${[id.emailFound ? "email" : "", id.phoneFound ? "mobile" : ""].filter(Boolean).join(" and ")} is on the resume`);
    else if (id.nameMatch === false)
      // Nothing else on the resume can be trusted if it isn't theirs: this alone makes trust Low.
      add("Resume may be someone else's", -55, `name on the resume "${id.nameOnResume || "—"}" doesn't match the sheet, and neither the sheet's email nor mobile is on it`);
    else if (id.nameMatch === true) add("Name matches, contact differs", -3, "neither the sheet's email nor mobile is on the resume");
  }

  if (all.length > flags.length) {
    add("Agent flags set aside", 0, `${all.length - flags.length} flag(s) that contradicted themselves, called a no-show an integrity issue, or matched the coding profile they disputed`, "agent");
  }
  let agentTotal = 0;
  const counted = new Set<AcTrustCategory>();
  // Strongest first, so a category's first flag is its most serious.
  const ordered = [...flags].sort((a, b) => FLAG_POINTS[b.severity] - FLAG_POINTS[a.severity]);
  for (const f of ordered) {
    if (f.category === "identity" && proven) continue; // the program proved the resume is theirs
    const full = counted.has(f.category) ? Math.min(REPEAT_POINTS, FLAG_POINTS[f.severity]) : FLAG_POINTS[f.severity];
    counted.add(f.category);
    const pts = Math.min(full, AGENT_CAP - agentTotal);
    if (pts <= 0) continue;
    agentTotal += pts;
    add(TRUST_CATEGORY_LABEL[f.category], -pts, `${f.why}${f.why ? " — " : ""}“${f.evidence}” (${f.severity})`, "agent");
  }

  const aiRepos = e.github?.status === "checked" ? e.github.repos.filter((r) => r.aiLikelihood === "high") : [];
  if (aiRepos.length && !agentHas("github-authorship")) add("AI-written commits on GitHub", -Math.min(12, 6 * aiRepos.length), aiRepos.map((r) => r.name).join(", "));

  if (!agentHas("interview-integrity")) {
    const ivs = c.interviews ?? [];
    const scored = ivs
      .map((i) => ({ i, v: Number(i.integrityScore) }))
      .filter((x) => x.i.integrityScore && Number.isFinite(x.v))
      .sort((a, b) => a.v - b.v);
    const worst = scored[0];
    if (worst && worst.v < 3) add("Low interview integrity", -15, `${worst.i.tab}: ${worst.v}/5`);
    else if (worst && worst.v < 4) add("Interview integrity below 4/5", -8, `${worst.i.tab}: ${worst.v}/5`);
    const cue = ivs.find((i) => INTEGRITY_CUE.test(`${i.integrityNote} ${i.remarks}`));
    if (cue) add("Interviewer noted an integrity concern", -12, `${cue.tab}: “${(cue.integrityNote || cue.remarks).slice(0, 160)}”`);
  }

  const fe = c.competencies.find((k) => k.bucket === "frontend" && k.level);
  if (fe && /^(below|l\s*1\b)/i.test(fe.level.trim()) && !agentHas("inconsistent")) {
    const claimed = e.items.filter((i) => (i.stack === "frontend" || i.stack === "fullstack") && i.depth !== "basic").length;
    if (claimed >= 2) add("Resume frontend work vs interview", -8, `${claimed} substantial frontend / full-stack items on the resume, but the frontend interview found ${fe.level}`);
  }

  const score = Math.max(0, Math.min(100, 100 + checks.reduce((s, x) => s + x.points, 0)));
  return { score, band: bandOf(score), checks, agentRan: Boolean(e.trust), summary: e.trust?.summary ?? "" };
}

// ── Bucketing ────────────────────────────────────────────────────────────────

export type AcStatus = "Bucketed" | "Mixed" | "Needs evidence" | "Pending" | "Placed – not bucketed" | "Not in active pool" | "Not eligible";
export type AcConfidence = "High" | "Medium" | "Low" | "";
export type AcSignalKey = "resume" | "github" | "competency" | "preference";

export const SIGNAL_LABEL: Record<AcSignalKey, string> = { resume: "Resume", github: "GitHub", competency: "Competency TR", preference: "Student preference" };

export const MIXED_TAG = "Verify over call on priority";

export interface AcRanked {
  id: string;
  candidate: AcCandidate;
  result?: AcEvaluation;
  status: AcStatus;
  placement: AcPlacement | null;
  /** For Mixed: the near-equal buckets, strongest first. */
  mixedWith: AcBucket[];
  /** Set when the nudge moved the candidate (temporary rebalancing): the bucket they scored into. */
  nudgedFrom: AcBucket | null;
  /** Final 0-100 per bucket. */
  scores: AcScores;
  signals: { resume: ResumeSignal | null; github: GithubSignal | null; competency: CompetencySignal | null; preference: PreferenceSignal | null };
  used: AcSignalKey[];
  /** Share of the switched-on evidence behind the candidate's bucket (0-1): 1 = every signal speaks for it. */
  coverage: number;
  /** Backend share (0-1) of their own frontend + backend work (resume items and repos); null = too little web work. */
  backendShare: number | null;
  /** Score of the bucket the candidate is in (Mixed: the strongest). */
  fit: number;
  assessment: Basis;
  dsa: Basis;
  /** Trust score and its checks; null when the trust check is switched off. */
  trust: AcTrust | null;
  priorityScore: number;
  priority: "P1" | "P2" | "";
  /** Position inside the candidate's own bucket sheet. */
  rank: number;
  confidence: AcConfidence;
  tag: string;
  /** Why this bucket — one line per decision. */
  reasons: string[];
  /** Bucket the other signals suggest when the resume couldn't be read. */
  suggested: AcBucket | null;
}

const topOf = (s: AcScores): AcBucket => AC_BUCKETS.reduce((best, b) => (s[b] > s[best] ? b : best), AC_BUCKETS[0]);
const WEB = new Set<AcBucket>(["frontend", "backend", "fullstack"]);
const ALL_OBSERVED: AcScores = { frontend: 1, backend: 1, aiml: 1, fullstack: 1 };

type SignalInput = { scores: AcScores; observes?: AcScores } | null;

/**
 * Combine the available signals into one score per bucket: a weighted average, per bucket, of
 * the signals by how much each can speak for it (an interview fully for its own stack and at half
 * weight for the others; GitHub at half weight where the candidate has no repo of that stack).
 * `coverage` is how much of the switched-on evidence stands behind each bucket (0-1) — the ranking
 * discounts thinly evidenced candidates.
 */
export function combine(signals: Partial<Record<AcSignalKey, SignalInput>>, rules: AcRules): { scores: AcScores; used: AcSignalKey[]; coverage: AcScores } {
  const keys = Object.keys(SIGNAL_LABEL) as AcSignalKey[];
  const used = keys.filter((k) => rules.signals[k] && signals[k] && rules.weights[k] > 0);
  const enabled = keys.filter((k) => rules.signals[k] && rules.weights[k] > 0).reduce((t, k) => t + rules.weights[k], 0);
  const scores: AcScores = { ...ZERO_SCORES };
  const coverage: AcScores = { ...ZERO_SCORES };
  for (const b of AC_BUCKETS) {
    let W = 0;
    let sum = 0;
    for (const k of used) {
      const sig = signals[k]!;
      const w = rules.weights[k] * (sig.observes ? sig.observes[b] : 1);
      W += w;
      sum += w * sig.scores[b];
    }
    scores[b] = W ? Math.round(sum / W) : 0;
    coverage[b] = enabled ? Math.round((W / enabled) * 100) / 100 : 0;
  }
  // Frontend and backend strength together is full-stack strength.
  if (Math.min(scores.frontend, scores.backend) > scores.fullstack) {
    scores.fullstack = Math.min(scores.frontend, scores.backend);
    coverage.fullstack = Math.min(coverage.frontend, coverage.backend);
  }
  return { scores, used, coverage };
}

/** One bucket, or Mixed when the runner-up is within the margin and both are strong. */
export function assign(scores: AcScores, rules: AcRules): { placement: AcPlacement | null; mixedWith: AcBucket[]; reason: string } {
  const order = [...AC_BUCKETS].sort((a, b) => scores[b] - scores[a] || AC_BUCKETS.indexOf(b) - AC_BUCKETS.indexOf(a));
  const top = order[0];
  if (scores[top] <= 0) return { placement: null, mixedWith: [], reason: "No stack evidence" };
  let close = order.filter((b) => scores[b] >= rules.mixedMinScore && scores[top] - scores[b] <= rules.mixedMargin);
  const line = (bs: AcBucket[]) => bs.map((b) => `${AC_BUCKET_LABEL[b]} ${scores[b]}`).join(", ");
  // Frontend / Backend / Full Stack close together are one direction — Full Stack covers both halves.
  const web = close.filter((b) => WEB.has(b));
  let merged = "";
  if (rules.feBeAsFullStack && web.length >= 2 && (web.includes("fullstack") || (web.includes("frontend") && web.includes("backend")))) {
    merged = `${line(web)} are close — Full Stack covers frontend and backend`;
    close = [...close.filter((b) => !WEB.has(b)), "fullstack" as AcBucket].sort((a, b) => scores[b] - scores[a]);
  }
  if (close.length >= 2) {
    return { placement: "mixed", mixedWith: close, reason: `${line(close)} within ${rules.mixedMargin} points — Mixed${merged ? ` (${merged})` : ""}` };
  }
  if (merged) return { placement: "fullstack", mixedWith: [], reason: merged };
  const second = order[1];
  return {
    placement: top,
    mixedWith: [],
    reason: `${AC_BUCKET_LABEL[top]} ${scores[top]} vs ${AC_BUCKET_LABEL[second]} ${scores[second]} (lead ${scores[top] - scores[second]})`,
  };
}

function confidenceOf(r: Pick<AcRanked, "placement" | "scores" | "used" | "signals" | "trust">): AcConfidence {
  if (!r.placement) return "";
  if (r.placement === "mixed") return "Low";
  const p = r.placement;
  const others = AC_BUCKETS.filter((b) => b !== p).map((b) => r.scores[b]);
  const lead = r.scores[p] - Math.max(...others);
  const agrees = r.used.filter((k) => {
    const s = r.signals[k];
    if (!s) return false;
    const t = topOf(s.scores);
    return t === p || (p === "fullstack" && (t === "frontend" || t === "backend"));
  }).length;
  const hasResume = r.used.includes("resume");
  let conf: AcConfidence = hasResume && agrees >= 2 && lead >= 15 ? "High" : (hasResume && lead >= 8) || agrees >= 2 ? "Medium" : "Low";
  // The evidence is only as good as its trust.
  if (r.trust?.band === "Low") conf = "Low";
  else if (r.trust?.band === "Medium" && conf === "High") conf = "Medium";
  return conf;
}

function describe(r: Omit<AcRanked, "reasons" | "rank">): string[] {
  const out: string[] = [];
  const rs = r.signals.resume;
  if (rs && r.used.includes("resume")) {
    const by = new Map<AcStack, string[]>();
    for (const it of rs.items) by.set(it.stack, [...(by.get(it.stack) ?? []), it.item.title]);
    const parts = [...by.entries()]
      .filter(([s]) => s !== "other")
      .sort((a, b) => b[1].length - a[1].length)
      .map(([s, t]) => `${t.length} ${AC_BUCKET_LABEL[s as AcBucket]} (${t.slice(0, 3).join("; ")}${t.length > 3 ? "; …" : ""})`);
    out.push(`Resume: ${parts.length ? parts.join(" · ") : "skills list only"}`);
  }
  const gs = r.signals.github;
  if (gs && r.used.includes("github")) {
    const by = new Map<AcStack, string[]>();
    for (const x of gs.repos) if (x.points) by.set(x.stack, [...(by.get(x.stack) ?? []), x.repo.name]);
    out.push(`GitHub: ${[...by.entries()].map(([s, n]) => `${n.length} ${AC_BUCKET_LABEL[s as AcBucket]} repo${n.length === 1 ? "" : "s"}`).join(" · ")}`);
  }
  if (r.signals.competency && r.used.includes("competency")) out.push(`Competency: ${r.signals.competency.used.join(", ")}`);
  if (r.signals.preference && r.used.includes("preference")) out.push(`Preference: ${r.signals.preference.order.map((b) => AC_BUCKET_LABEL[b]).join(", ")}`);
  if (r.backendShare !== null && WEB.has((r.placement === "mixed" ? r.mixedWith[0] : r.placement) as AcBucket)) {
    out.push(`Own web work: ${Math.round(r.backendShare * 100)}% backend, ${100 - Math.round(r.backendShare * 100)}% frontend`);
  }
  if (r.trust && r.trust.score !== null) {
    const issues = r.trust.checks.filter((x) => x.points < 0);
    out.push(`Trust ${r.trust.score} (${r.trust.band})${issues.length ? `: ${issues.map((x) => x.label).join("; ")}` : ""}`);
  }
  return out;
}

/** Least frontend + backend work (points) for the backend share to mean anything — about one project. */
const MIN_WEB_WORK = 25;

/** Backend share of the candidate's own web work, from the signals the rules use. */
function backendShareOf(signals: AcRanked["signals"], used: AcSignalKey[]): number | null {
  let fe = 0;
  let be = 0;
  if (signals.resume && used.includes("resume")) {
    fe += signals.resume.web.fe;
    be += signals.resume.web.be;
  }
  if (signals.github && used.includes("github")) {
    fe += signals.github.web.fe;
    be += signals.github.web.be;
  }
  return fe + be >= MIN_WEB_WORK ? be / (fe + be) : null;
}

/** Priority score: weighted average of evidenced fit, best assessment and DSA, scaled by trust. */
function priorityOf(fit: number, coverage: number, assessment: Basis, dsa: Basis, trust: AcTrust | null, rules: AcRules): number {
  // Thin evidence ranks lower: a bucket read only from the preference note counts its fit at 55%,
  // one backed by every signal at 100% (fit × (0.5 + 0.5 × coverage)).
  const w = rules.rankWeights;
  const parts: [number, number][] = [
    [w.fit, fit * (0.5 + 0.5 * coverage)],
    [w.assessment, assessment.score],
    ...(rules.signals.dsa ? ([[w.dsa, dsa.score]] as [number, number][]) : []),
  ];
  const W = parts.reduce((s, [x]) => s + x, 0);
  const base = W ? parts.reduce((s, [x, v]) => s + x * v, 0) / W : 0;
  // Trust 100 keeps the score, trust 50 takes 20% off.
  const factor = trust && trust.score !== null ? 0.6 + 0.4 * (trust.score / 100) : 1;
  return Math.round(base * factor * 10) / 10;
}

const half = (s: SignalInput): SignalInput => (s ? { ...s, observes: Object.fromEntries(AC_BUCKETS.map((b) => [b, (s.observes ?? ALL_OBSERVED)[b] * 0.5])) as AcScores } : s);

/** Bucket every candidate and rank each bucket. */
export function rankAcademy(candidates: AcCandidate[], results: Record<string, AcEvaluation>, rules: AcRules): AcRanked[] {
  const coverageOf = new Map<string, AcScores>();
  const rows: AcRanked[] = candidates.map((c) => {
    const e = results[c.id];
    const assessment = assessmentScore(c);
    const dsa = dsaStrength(c, e, rules.signals.dsa);
    const priority: AcRanked["priority"] = c.activePool ? (c.placement === "placed" ? "P2" : "P1") : "";
    const base: Omit<AcRanked, "reasons" | "rank"> = {
      id: c.id,
      candidate: c,
      result: e,
      status: "Not eligible",
      placement: null,
      mixedWith: [],
      nudgedFrom: null,
      scores: { ...ZERO_SCORES },
      signals: { resume: null, github: null, competency: null, preference: null },
      used: [],
      coverage: 0,
      backendShare: null,
      fit: 0,
      assessment,
      dsa,
      trust: null,
      priorityScore: 0,
      priority,
      confidence: "",
      tag: "",
      suggested: null,
    };
    if (!c.eligibility.eligible) return { ...base, rank: 0, reasons: ["Sheet 1: no L3 / L4 competency, DSA Offline not cleared, not old Bucket A"] };
    if (!c.activePool) return { ...base, status: "Not in active pool", rank: 0, reasons: [`Active Pool: ${c.activePoolRaw || "blank"}`] };
    if (c.placement === "placed" && !rules.includePlaced) return { ...base, status: "Placed – not bucketed", rank: 0, reasons: ["Already placed (switched off in the rules)"] };

    const signals = {
      resume: e && e.status === "ok" ? resumeSignal(e) : null,
      github: e && e.status === "ok" ? githubSignal(e) : null,
      competency: competencySignal(c),
      preference: preferenceSignal(c.preference),
    };
    const trust = rules.trust.enabled ? trustScore(c, e) : null;
    const needResume = rules.signals.resume && Boolean(c.resumeUrl);
    if (needResume && !e) return { ...base, status: "Pending", signals, trust, rank: 0, reasons: ["Resume not read yet"] };

    // Below the trust bar, the resume and GitHub count at half weight — the bucket leans on the interview and preference.
    const lowTrust = Boolean(trust && trust.score !== null && trust.score < rules.trust.relyAt);
    const { scores, used, coverage } = combine(lowTrust ? { ...signals, resume: half(signals.resume), github: half(signals.github) } : signals, rules);
    const fallback = combine({ competency: signals.competency, preference: signals.preference }, rules);
    // A read that failed for a passing reason waits for a re-run; a resume that can't be read at all
    // (not shared, gone, unsupported file) is treated like no resume and bucketed from the rest.
    if (needResume && e && e.status === "error" && e.retryable) {
      const s = assign(fallback.scores, rules);
      return {
        ...base,
        status: "Needs evidence",
        signals,
        trust,
        scores: fallback.scores,
        used: fallback.used,
        suggested: s.placement && s.placement !== "mixed" ? s.placement : s.mixedWith[0] ?? null,
        tag: "Resume read failed — re-run",
        rank: 0,
        reasons: [`Resume: ${e.error}`],
      };
    }
    const a = assign(scores, rules);
    if (!a.placement) {
      return {
        ...base,
        status: "Needs evidence",
        signals,
        trust,
        scores,
        used,
        tag: "No stack evidence — collect resume / verify over call",
        rank: 0,
        reasons: [
          !c.resumeUrl
            ? "No resume link in sheet 1"
            : e && e.status !== "ok"
              ? `Resume can't be read: ${e.error}`
              : "The resume shows no frontend, backend, AI-ML or full-stack work",
          "No competency level or stack preference to go on",
        ],
      };
    }
    coverageOf.set(c.id, coverage);
    const lead: AcBucket = a.placement === "mixed" ? a.mixedWith[0] : a.placement;
    const fit = scores[lead];
    const row: Omit<AcRanked, "reasons" | "rank"> = {
      ...base,
      status: a.placement === "mixed" ? "Mixed" : "Bucketed",
      placement: a.placement,
      mixedWith: a.mixedWith,
      scores,
      signals,
      used,
      coverage: coverage[lead],
      backendShare: backendShareOf(signals, used),
      fit,
      trust,
      priorityScore: priorityOf(fit, coverage[lead], assessment, dsa, trust, rules),
    };
    row.confidence = confidenceOf(row);
    const noResume = !used.includes("resume");
    const tags: string[] = [];
    if (a.placement === "mixed") tags.push(MIXED_TAG);
    if (noResume && e?.status === "invalid") tags.push("Resume link is not a resume — verify over call");
    else if (noResume && e?.status === "error")
      tags.push(`Resume can't be read (${/not found|shared|download/i.test(e.error) ? "not shared with the service account" : e.error.slice(0, 60)}) — verify over call`);
    else if (noResume && !c.resumeUrl && rules.signals.resume) tags.push("No resume — verify over call");
    if (lowTrust) tags.push(`Low trust (${trust!.score}/100) — verify over call`);
    if (!tags.length && row.confidence === "Low") tags.push("Low confidence — verify over call");
    row.tag = tags.join(" · ");
    return { ...row, rank: 0, reasons: [a.reason, ...describe(row)] };
  });

  // Temporary rebalancing: Full Stack candidates whose own web work is mostly backend move to Backend —
  // the most backend-leaning first, at most `maxMoves` (0 = half the Full Stack − Backend gap, so
  // Backend never overtakes Full Stack). Low-trust candidates stay where the evidence put them.
  if (rules.nudge.enabled) {
    const fs = rows.filter((r) => r.placement === "fullstack");
    const be = rows.filter((r) => r.placement === "backend").length;
    const cap = rules.nudge.maxMoves > 0 ? rules.nudge.maxMoves : Math.max(0, Math.floor((fs.length - be) / 2));
    const movers = fs
      .filter((r) => r.backendShare !== null && r.backendShare * 100 >= rules.nudge.minBackendShare && r.scores.backend >= rules.nudge.minBackendScore && r.trust?.band !== "Low")
      .sort((a, b) => b.backendShare! - a.backendShare! || b.scores.backend - a.scores.backend)
      .slice(0, cap);
    for (const r of movers) {
      const pct = Math.round(r.backendShare! * 100);
      const cov = coverageOf.get(r.id)?.backend ?? r.coverage;
      r.placement = "backend";
      r.nudgedFrom = "fullstack";
      r.fit = r.scores.backend;
      r.coverage = cov;
      r.priorityScore = priorityOf(r.fit, cov, r.assessment, r.dsa, r.trust, rules);
      r.tag = [`Nudged from Full Stack (${pct}% backend work) — verify over call`, ...(r.tag ? [r.tag] : [])].join(" · ");
      r.reasons = [
        `Nudged Full Stack → Backend: ${pct}% of their own web work is backend (at least ${rules.nudge.minBackendShare}%), Backend ${r.scores.backend} (at least ${rules.nudge.minBackendScore})`,
        ...r.reasons,
      ];
    }
  }

  // Rank inside each bucket sheet: P1 (active, not placed) first, then the priority score, then old bucket A > B > C > D.
  const oldTier = (r: AcRanked) => ({ A: 1, B: 2, C: 3, D: 4, "": 5 })[r.candidate.oldBucket];
  const byPlacement = new Map<string, AcRanked[]>();
  for (const r of rows) {
    if (!r.placement) continue;
    byPlacement.set(r.placement, [...(byPlacement.get(r.placement) ?? []), r]);
  }
  for (const list of byPlacement.values()) {
    list.sort(
      (a, b) =>
        (a.priority === b.priority ? 0 : a.priority === "P1" ? -1 : 1) ||
        b.priorityScore - a.priorityScore ||
        oldTier(a) - oldTier(b) ||
        (a.candidate.name || a.id).localeCompare(b.candidate.name || b.id),
    );
    list.forEach((r, i) => (r.rank = i + 1));
  }
  return rows;
}

export interface AcSummary {
  candidates: number;
  eligible: number;
  inScope: number;
  p1: number;
  p2: number;
  byPlacement: Record<AcPlacement, number>;
  /** Full Stack candidates the nudge moved to Backend. */
  nudged: number;
  trust: Record<AcTrustBand, number>;
  needsEvidence: number;
  pending: number;
  evaluated: number;
  /** Reads that failed for a passing reason — worth a re-run now. */
  errors: number;
  /** Resume links that can't be read (not shared, deleted, not a resume) — need fixing at the source. */
  unreadable: number;
  notActive: number;
  notEligible: number;
  placedOut: number;
  toVerify: number;
}

export function summarizeAcademy(rows: AcRanked[]): AcSummary {
  const byPlacement: Record<AcPlacement, number> = { frontend: 0, backend: 0, aiml: 0, fullstack: 0, mixed: 0 };
  for (const r of rows) if (r.placement) byPlacement[r.placement]++;
  const inScope = rows.filter((r) => r.candidate.eligibility.eligible && r.candidate.activePool && r.status !== "Placed – not bucketed");
  const trust: Record<AcTrustBand, number> = { High: 0, Medium: 0, Low: 0, Unverified: 0 };
  for (const r of inScope) if (r.trust) trust[r.trust.band]++;
  return {
    candidates: rows.length,
    eligible: rows.filter((r) => r.candidate.eligibility.eligible).length,
    inScope: inScope.length,
    p1: inScope.filter((r) => r.priority === "P1").length,
    p2: inScope.filter((r) => r.priority === "P2").length,
    byPlacement,
    nudged: rows.filter((r) => r.nudgedFrom).length,
    trust,
    needsEvidence: rows.filter((r) => r.status === "Needs evidence").length,
    pending: rows.filter((r) => r.status === "Pending").length,
    evaluated: inScope.filter((r) => r.result).length,
    errors: inScope.filter((r) => r.result?.status === "error" && r.result.retryable).length,
    unreadable: inScope.filter((r) => (r.result?.status === "error" && !r.result.retryable) || r.result?.status === "invalid").length,
    notActive: rows.filter((r) => r.status === "Not in active pool").length,
    notEligible: rows.filter((r) => r.status === "Not eligible").length,
    placedOut: rows.filter((r) => r.status === "Placed – not bucketed").length,
    toVerify: rows.filter((r) => r.placement && r.tag).length,
  };
}

/** Candidates whose resume must be read for these rules (in scope, with a link, not yet read or read with older checks / other options). */
export function needsRead(rows: AcRanked[], rules: AcRules): AcRanked[] {
  return rows.filter((r) => {
    const c = r.candidate;
    if (!c.eligibility.eligible || !c.activePool || !c.resumeUrl || !rules.signals.resume) return false;
    if (c.placement === "placed" && !rules.includePlaced) return false;
    const e = r.result;
    if (!e) return true;
    return e.resumeUrl !== c.resumeUrl;
  });
}

/** Read results that are missing what the rules now ask for (GitHub / DSA / trust switched on later) or used older checks. */
export function staleReads(rows: AcRanked[], rules: AcRules): AcRanked[] {
  return rows.filter((r) => {
    const e = r.result;
    if (!e || e.status === "error" || !r.candidate.activePool || !r.candidate.eligibility.eligible) return false;
    if (e.version < AC_EVAL_VERSION) return true;
    if (e.status !== "ok") return false;
    return (rules.signals.github && !e.read.github) || (rules.signals.dsa && !e.read.dsa) || (rules.trust.enabled && !e.read.trust);
  });
}
