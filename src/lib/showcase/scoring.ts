import { TRUST_CATEGORY_LABEL } from "@/lib/academy/scoring";
import type { AcTrustCategory, AcTrustFlag, AcTrustSeverity } from "@/lib/academy/types";
import type { DsaPlatform } from "@/lib/dsa-types";
import { bestRating } from "@/lib/dsa-scoring";
import { DSA_NAME, DSA_ORDER, clearsBar, dsaIdentity, dsaVerdict, sharedHandles, type DsaVerdict } from "@/lib/showcase/dsa-rules";
import { SP_ROLE, batchTitleKey, courseKind, roleLabel, rolesFromEvidence } from "@/lib/showcase/roles";
import {
  SP_SIGNAL_LABEL,
  SP_VERSIONS,
  type SpCandidate,
  type SpDataset,
  type SpDsa,
  type SpJob,
  type SpLinks,
  type SpProject,
  type SpProjectProof,
  type SpProofStatus,
  type SpRecord,
  type SpRules,
  type SpSignal,
} from "@/lib/showcase/types";

/**
 * Sample profiles — the decision (pure, runs in the browser, so every rule re-ranks instantly
 * without re-reading anything). For each candidate, stage by stage: is the resume usable and does
 * it link a GitHub and a coding profile; does DSA clear the bar (on a profile that is theirs);
 * is the GitHub a real one; which projects are strong after the program's caps (course / template
 * work, missing complexity signals); which of them the candidate's own code proves; can the
 * profile be trusted. Roles come from the evidence (the technologies each project names and its
 * code proves), a candidate is placed in the role of their strongest projects, and each role tab
 * keeps its best few. Every candidate keeps the reason they stopped where they did.
 */

// ── Batch facts (one sheet, all rows) ────────────────────────────────────────

export const githubLogin = (url: string) => url.match(/github\.com\/([A-Za-z0-9-]{1,39})(?:[/?#]|$)/i)?.[1] ?? "";

export interface SpBatch {
  /** "platform:handle" on more than one row — counts for nobody. */
  sharedDsa: Set<string>;
  /** GitHub logins (lower-case) on more than one row. */
  sharedGithub: Set<string>;
  /** Resume file hash → the first row that has it. */
  firstBySha: Map<string, { id: string; row: number }>;
  /** Distinctive project title → how many candidates' resumes have it. */
  titleCount: Map<string, number>;
}

/** A project title on this many resumes of the batch is course / template work. */
export const BATCH_TITLE_MIN = 3;

const usable = (r: SpRecord | undefined) => Boolean(r?.screen && (r.screen.status === "ok" || r.screen.status === "needs-ocr"));

export function batchFacts(ds: SpDataset, records: Record<string, SpRecord>): SpBatch {
  const screened = ds.candidates.map((c) => records[c.id]).filter(usable) as SpRecord[];
  const sharedDsa = sharedHandles(screened.map((r) => ({ links: r.screen!.links })));
  const gh = new Map<string, number>();
  for (const r of screened) {
    const login = githubLogin(r.screen!.links.githubProfile).toLowerCase();
    if (login) gh.set(login, (gh.get(login) ?? 0) + 1);
  }
  const firstBySha = new Map<string, { id: string; row: number }>();
  for (const c of [...ds.candidates].sort((a, b) => a.sheetRow - b.sheetRow)) {
    const sha = records[c.id]?.screen?.sha;
    if (sha && !firstBySha.has(sha)) firstBySha.set(sha, { id: c.id, row: c.sheetRow });
  }
  const titleCount = new Map<string, number>();
  for (const c of ds.candidates) {
    const read = records[c.id]?.read;
    if (read?.status !== "ok") continue;
    // One resume file counts once (a file uploaded on two rows is the same resume).
    const sha = records[c.id]?.screen?.sha;
    if (sha && firstBySha.get(sha)?.id !== c.id) continue;
    for (const k of new Set(read.projects.map((p) => batchTitleKey(p.title)).filter(Boolean))) titleCount.set(k, (titleCount.get(k) ?? 0) + 1);
  }
  return { sharedDsa, sharedGithub: new Set([...gh].filter(([, n]) => n > 1).map(([k]) => k)), firstBySha, titleCount };
}

// ── DSA ──────────────────────────────────────────────────────────────────────

export interface SpDsaView extends DsaVerdict {
  /** Every platform as finally read (bar stage + verification), with owner identity. */
  dsa: SpDsa;
  notes: string[];
}

export const namesOf = (c: SpCandidate, rec: SpRecord) => [c.name, rec.read?.status === "ok" ? rec.read.nameOnResume : ""].filter(Boolean);

/** The DSA picture: the fuller reading wins; a handle only written in the text counts once its owner is confirmed. */
export function dsaView(c: SpCandidate, rec: SpRecord, rules: SpRules, batch: SpBatch, bar = rules.dsa): SpDsaView {
  const names = namesOf(c, rec);
  const login = githubLogin(rec.screen?.links.githubProfile ?? "");
  const merged: SpDsa = {};
  const notes: string[] = [];
  for (const k of DSA_ORDER) {
    const late = rec.verify?.status === "ok" ? rec.verify.dsa[k] : undefined;
    const early = rec.dsa?.[k];
    const p = late && late.found !== null ? late : early;
    if (!p) continue;
    const id = dsaIdentity(p, names, login);
    if (rec.screen?.inferred.includes(k) && id.identity !== "confirmed") {
      notes.push(`${DSA_NAME[k]} handle is only written on the resume (no link) and the profile's owner isn't confirmed`);
      continue;
    }
    merged[k] = { ...p, identity: id.identity, identityNote: id.note };
  }
  return { ...dsaVerdict(merged, bar, names, login, batch.sharedDsa), dsa: merged, notes };
}

/** A profile that didn't answer this many times counts as unreadable (the bar moves on without it). */
export const DSA_ATTEMPTS = 3;

/**
 * The next platform to read for the bar (Codeforces → LeetCode → CodeChef), or null when the bar
 * is cleared or nothing is left. A profile that didn't answer is read again (up to DSA_ATTEMPTS); a Codeforces reading
 * made under a higher bar (no contest count) is read again when its rating can now clear.
 */
export function pendingDsa(links: Pick<SpLinks, DsaPlatform>, dsa: SpDsa | undefined, rules: SpRules): DsaPlatform | null {
  const d = dsa ?? {};
  if (DSA_ORDER.some((k) => clearsBar(k, d[k], rules.dsa))) return null;
  for (const k of DSA_ORDER) {
    if (!links[k]) continue;
    const p = d[k];
    if (!p || (p.found === null && (p.attempts ?? 1) < DSA_ATTEMPTS)) return k;
    if (k === "codeforces" && p.found && p.contests === null && (bestRating(p) ?? 0) >= rules.dsa.codeforces) return k;
  }
  return null;
}

// ── Projects ─────────────────────────────────────────────────────────────────

/** Most a project can score by the number of complexity signals the resume quotes or the code backs. */
const SIGNAL_CAPS = [60, 72, 82, 90, 100];

export interface SpScoredProject {
  p: SpProject;
  /** Roles the project proves (its technologies, its code), the model's reading breaking ties. */
  roles: string[];
  /** Quality after the caps. */
  quality: number;
  cap: number;
  /** The caps that lowered the model's score. */
  capReasons: string[];
  signals: SpSignal[];
  proof: SpProjectProof | null;
  proofStatus: SpProofStatus | "unchecked";
  proofWhy: string;
}

/** The browser's verdict on one repo against the adjustable thresholds. */
export function judgeProof(pr: SpProjectProof | null | undefined, rules: SpRules): { status: SpProofStatus | "unchecked"; why: string } {
  if (!pr) return { status: "unchecked", why: "not checked" };
  if (pr.status !== "verified") return { status: pr.status, why: pr.why };
  if (pr.ownCommits === 0) return { status: "failed", why: pr.audited ? "none of the commits are theirs" : "no commits to check" };
  const t = rules.proof;
  const misses: string[] = [];
  if (!pr.techMatch) misses.push("the code doesn't show this project's stack");
  if (pr.ownCommits < t.minOwnCommits) misses.push(`${pr.ownCommits} own commit${pr.ownCommits === 1 ? "" : "s"} (needs ${t.minOwnCommits})`);
  if (pr.share < t.minShare) misses.push(`${Math.round(pr.share * 100)}% of the commits are theirs (needs ${Math.round(t.minShare * 100)}%)`);
  if (pr.activeDays < t.minDays) misses.push(`worked on ${pr.activeDays} day${pr.activeDays === 1 ? "" : "s"} (needs ${t.minDays})`);
  if (pr.srcFiles < t.minSrcFiles) misses.push(`${pr.srcFiles} source files (needs ${t.minSrcFiles})`);
  if (!t.allowAiTraces && pr.aiTraces.length) misses.push(`AI-generated: ${pr.aiTraces[0]}`);
  if (misses.length) return { status: "weak", why: misses.join("; ") };
  return { status: "verified", why: `${pr.ownCommits} own commits over ${pr.activeDays} days${pr.provenTechs.length ? `; code proves ${pr.provenTechs.slice(0, 5).join(", ")}` : ""}` };
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const SDE_KEYS = ["c-cpp", "java", "go", "rust"];

function projectRoles(p: SpProject, proof: SpProjectProof | null): string[] {
  const code = proof?.provenKeys ?? [];
  const evidence = uniq([...rolesFromEvidence([...p.techKeys, ...code.filter((k) => !k.startsWith("role:"))]), ...code.filter((k) => k.startsWith("role:")).map((k) => k.slice(5))]);
  const sde = p.roles.includes("sde") && [...p.techKeys, ...code].some((k) => SDE_KEYS.includes(k)) ? ["sde"] : [];
  if (!evidence.length) return uniq([...p.roles, ...sde]);
  // The model's reading orders what the evidence shows; it never adds a role the evidence doesn't.
  return uniq([...p.roles.filter((r) => evidence.includes(r)), ...evidence, ...sde]);
}

export function scoreProjects(rec: SpRecord, rules: SpRules, batch: SpBatch): SpScoredProject[] {
  const read = rec.read;
  if (read?.status !== "ok") return [];
  const proofs = rec.verify?.status === "ok" ? rec.verify.proofs : [];
  return read.projects.map((p) => {
    const proof = proofs.find((x) => x.title === p.title) ?? null;
    const judged = judgeProof(proof, rules);
    const signals = uniq([...p.signals.map((s) => s.type), ...(judged.status === "verified" ? proof!.corroborated : [])]);
    const caps: [number, string][] = [];
    const kind = courseKind(p.title, [p.repoUrl, p.demoUrl].filter(Boolean));
    if (p.courseQuote || kind === "course") caps.push([40, p.courseQuote ? `course / tutorial work (“${p.courseQuote.slice(0, 80)}”)` : "a NxtWave course app"]);
    else if (kind === "toy") caps.push([45, "a common tutorial build"]);
    const dup = batch.titleCount.get(batchTitleKey(p.title)) ?? 0;
    if (dup >= BATCH_TITLE_MIN) caps.push([40, `the same project title is on ${dup} resumes in this sheet`]);
    if (p.depth === "basic") caps.push([55, "basic, tutorial-level depth"]);
    const sigCap = SIGNAL_CAPS[Math.min(SIGNAL_CAPS.length - 1, signals.length)];
    if (sigCap < 100) {
      caps.push([sigCap, signals.length ? `only ${signals.length} verified complexity signal${signals.length === 1 ? "" : "s"} (${signals.map((s) => SP_SIGNAL_LABEL[s]).join(", ")})` : "no verified complexity signal (live deployment, users, scale, architecture …)"]);
    }
    if (!p.quote) caps.push([65, "no description of what they built"]);
    const cap = Math.min(100, ...caps.map((x) => x[0]));
    return {
      p,
      roles: projectRoles(p, judged.status === "verified" ? proof : null),
      quality: Math.min(p.quality, cap),
      cap,
      capReasons: caps.filter((x) => x[0] < p.quality).sort((a, b) => a[0] - b[0]).map((x) => x[1]),
      signals,
      proof,
      proofStatus: judged.status,
      proofWhy: judged.why,
    };
  });
}

// ── Experience ───────────────────────────────────────────────────────────────

const TYPE_WEIGHT: Record<SpJob["employmentType"], number> = { "full-time": 1, contract: 0.8, "part-time": 0.6, freelance: 0.5, internship: 0.5, other: 0.4 };
const COMPANY_WEIGHT: Record<SpJob["companyType"], number> = { product: 1.2, unknown: 1, consulting: 0.8, "it-services": 0.7, staffing: 0.6 };
const FULLSTACK_PARTS = ["frontend", "backend"];

function jobRelevance(j: SpJob, role: string): number {
  if (!j.roles.length) return 0.5;
  if (j.roles.includes(role)) return 1;
  if (FULLSTACK_PARTS.includes(role) && j.roles.includes("fullstack")) return 0.8;
  if (role === "fullstack" && j.roles.some((r) => FULLSTACK_PARTS.includes(r))) return 0.7;
  if (role === "sde") return 0.8;
  return 0.2;
}

/** 0-100: a year of full-time, in-role work at a product company is full marks. */
export function experienceScore(jobs: SpJob[], role: string): { score: number; months: number; relevant: boolean } {
  let eff = 0;
  let months = 0;
  let relevant = false;
  for (const j of jobs) {
    const m = j.months ?? 0;
    const rel = jobRelevance(j, role);
    if (rel >= 0.8) months += m;
    if (rel >= 0.8 && m >= 3) relevant = true;
    eff += m * TYPE_WEIGHT[j.employmentType] * COMPANY_WEIGHT[j.companyType] * rel;
  }
  return { score: Math.min(100, Math.round((eff / 12) * 100)), months, relevant };
}

// ── Trust ────────────────────────────────────────────────────────────────────

export type SpTrustBand = "High" | "Medium" | "Low";

export interface SpTrustCheck {
  label: string;
  points: number;
  detail: string;
  source: "program" | "agent";
}

export interface SpTrustScore {
  score: number;
  band: SpTrustBand;
  checks: SpTrustCheck[];
  summary: string;
}

export const SP_TRUST_BANDS = { high: 80, medium: 60 } as const;
const FLAG_POINTS: Record<AcTrustSeverity, number> = { high: 15, medium: 8, low: 3 };
/** Higher than the academy cap: three serious, grounded doubts alone make trust Low here. */
const AGENT_CAP = 45;
const REPEAT_POINTS = 2;
const SELF_REFUTING = /\b(no conflict|(?:is|seems|looks) plausible|consistent with|not (?:a )?contradict\w*|aligns? with|is aligned|no issue)\b/i;
const SOLVED_CLAIM = /(\d{2,4})\s*\+?\s*(?:dsa |coding |leetcode |dsa\/coding )?(?:problems|questions|solved)/i;
const nameWords = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3);

/**
 * How far the profile can be trusted (0-100): the program's checks (the resume carries the sheet's
 * email / mobile, its name matches; the GitHub account's name; AI-tool commits in the proven repos)
 * plus the trust agent's flags, each grounded in exact words (high −15, medium −8, low −3; a
 * further flag of the same kind −2; at most −45 in all). Null until the trust check has run.
 */
export function trustOf(c: SpCandidate, rec: SpRecord, view: SpDsaView | null): SpTrustScore | null {
  const t = rec.trust;
  if (!t || t.version !== SP_VERSIONS.trust || !t.review) return null;
  if (t.basedOn && rec.verify && t.basedOn !== rec.verify.checkedAt) return null;
  const checks: SpTrustCheck[] = [];
  const add = (label: string, points: number, detail: string, source: SpTrustCheck["source"] = "program") => checks.push({ label, points, detail, source });
  const solved = Math.max(0, ...DSA_ORDER.map((k) => view?.dsa[k]?.solved ?? 0));
  const all = t.review.flags;
  const flags = all.filter((f) => {
    if (SELF_REFUTING.test(f.why)) return false;
    const claim = f.category === "inconsistent" || f.category === "inflated-claim" ? f.evidence.match(SOLVED_CLAIM) : null;
    return !(claim && solved >= 0.9 * Number(claim[1]));
  });
  const agentHas = (cat: AcTrustCategory) => flags.some((f) => f.category === cat);

  const id = t.identity;
  const proven = Boolean(id && (id.emailFound || id.phoneFound));
  if (id) {
    if (proven) add("Resume belongs to this candidate", 0, `the sheet's ${[id.emailFound ? "email" : "", id.phoneFound ? "mobile" : ""].filter(Boolean).join(" and ")} is on the resume`);
    else if (id.nameMatch === false) add("Resume may be someone else's", -55, `name on the resume "${id.nameOnResume || "—"}" doesn't match the sheet, and neither the sheet's email nor mobile is on it`);
    else if (id.nameMatch === true) add("Name matches, contact differs", -3, "neither the sheet's email nor mobile is on the resume");
  }
  if (view?.by) {
    const p = view.dsa[view.by];
    if (p?.identity === "confirmed") add(`${DSA_NAME[view.by]} profile is theirs`, 0, p.identityNote || "owner matches");
    else add(`${DSA_NAME[view.by]} owner not shown`, 0, "the profile shows no name to compare");
  }
  const ghName = rec.probe?.status === "ok" ? rec.probe.name : "";
  if (ghName && !agentHas("github-authorship")) {
    const mine = new Set(namesOf(c, rec).flatMap(nameWords));
    const theirs = nameWords(ghName);
    if (theirs.length && mine.size && !theirs.some((w) => mine.has(w))) add("GitHub account name differs", -8, `the GitHub profile's name is "${ghName}"`);
  }
  const aiRepos = (rec.verify?.status === "ok" ? rec.verify.proofs : []).filter((p) => p.aiCommits > 0);
  if (aiRepos.length && !agentHas("github-authorship")) add("AI coding-tool commits", -Math.min(12, 6 * aiRepos.length), aiRepos.map((p) => p.repoUrl.replace(/^https?:\/\/github\.com\//, "")).join(", "));

  if (all.length > flags.length) add("Agent flags set aside", 0, `${all.length - flags.length} flag(s) that contradicted themselves or matched the coding profile they disputed`, "agent");
  let agentTotal = 0;
  const counted = new Set<AcTrustCategory>();
  for (const f of [...flags].sort((a: AcTrustFlag, b: AcTrustFlag) => FLAG_POINTS[b.severity] - FLAG_POINTS[a.severity])) {
    if (f.category === "identity" && proven) continue;
    const full = counted.has(f.category) ? Math.min(REPEAT_POINTS, FLAG_POINTS[f.severity]) : FLAG_POINTS[f.severity];
    counted.add(f.category);
    const pts = Math.min(full, AGENT_CAP - agentTotal);
    if (pts <= 0) continue;
    agentTotal += pts;
    add(TRUST_CATEGORY_LABEL[f.category], -pts, `${f.why}${f.why ? " — " : ""}“${f.evidence}” (${f.severity})`, "agent");
  }
  const score = Math.max(0, Math.min(100, 100 + checks.reduce((s, x) => s + x.points, 0)));
  return { score, band: score >= SP_TRUST_BANDS.high ? "High" : score >= SP_TRUST_BANDS.medium ? "Medium" : "Low", checks, summary: t.review.summary };
}

// ── Roles: gates and score ───────────────────────────────────────────────────

export interface SpGate {
  key: "dsa" | "projects" | "verified" | "trust";
  label: string;
  ok: boolean;
  /** Not decided yet (the stage that decides it hasn't run). */
  pending: boolean;
  detail: string;
}

export interface SpRoleProject extends SpScoredProject {
  /** Labelled with this role itself (not only through a full-stack project). */
  native: boolean;
  /** Quality × how far GitHub proves it. */
  effective: number;
}

export interface SpRoleFit {
  role: string;
  label: string;
  projects: SpRoleProject[];
  strong: SpRoleProject[];
  verifiedStrong: SpRoleProject[];
  experience: { score: number; months: number; relevant: boolean };
  gates: SpGate[];
  passed: boolean;
  parts: { projects: number; dsa: number; experience: number; engineering: number };
  /** Before the trust factor. */
  raw: number;
  score: number;
}

const PROOF_FACTOR: Record<SpProofStatus | "unchecked", number> = { verified: 1, weak: 0.8, unchecked: 0.7, unavailable: 0.7, failed: 0.6, "no-repo": 0.6 };

function roleFit(role: string, projects: SpScoredProject[], jobs: SpJob[], view: SpDsaView, trust: SpTrustScore | null, rules: SpRules, stage: { verified: boolean }): SpRoleFit {
  const mine: SpRoleProject[] = projects
    .map((sp) => {
      const native = sp.roles.includes(role);
      const viaFullstack = !native && FULLSTACK_PARTS.includes(role) && sp.roles.includes("fullstack");
      if (!native && !viaFullstack) return null;
      return { ...sp, native, effective: sp.quality * PROOF_FACTOR[sp.proofStatus] * (native ? 1 : 0.85) };
    })
    .filter((x): x is SpRoleProject => x !== null)
    .sort((a, b) => b.effective - a.effective);
  const strong = mine.filter((x) => x.quality >= rules.strongProject);
  const exceptional = mine.filter((x) => x.quality >= rules.exceptionalProject);
  const experience = experienceScore(jobs, role);
  const verifiedStrong = strong.filter((x) => x.proofStatus === "verified");
  const projectsOk = strong.length >= 2 || (exceptional.length >= 1 && experience.relevant);
  const gates: SpGate[] = [
    { key: "dsa", label: "DSA bar", ok: view.passed, pending: false, detail: view.passed ? view.lines.join("; ") : view.reason },
    {
      key: "projects",
      label: "Strong projects",
      ok: projectsOk,
      pending: false,
      detail: projectsOk
        ? `${strong.length} strong (quality ≥ ${rules.strongProject})`
        : `${strong.length} strong — needs 2 at quality ≥ ${rules.strongProject}, or 1 at ≥ ${rules.exceptionalProject} plus in-role experience${mine.length ? `; best: ${mine.slice(0, 3).map((x) => `${x.p.title} ${x.quality}${x.capReasons.length ? ` (${x.capReasons[0]})` : ""}`).join(", ")}` : ""}`,
    },
    {
      key: "verified",
      label: "Verified in code",
      ok: verifiedStrong.length >= 1,
      pending: !stage.verified,
      detail: verifiedStrong.length
        ? verifiedStrong.map((x) => `${x.p.title}: ${x.proofWhy}`).join("; ")
        : !stage.verified
          ? "GitHub proof not checked yet"
          : strong.length
            ? `no strong project is proven by their own code — ${strong.map((x) => `${x.p.title}: ${x.proofWhy}`).join("; ")}`
            : "no strong project to prove",
    },
  ];
  if (rules.trustAgent) {
    gates.push({
      key: "trust",
      label: "Trust",
      ok: Boolean(trust && trust.band !== "Low"),
      pending: !trust,
      detail: trust ? `${trust.score}/100 (${trust.band})${trust.band === "Low" ? `: ${trust.checks.filter((x) => x.points < 0).map((x) => x.label).join("; ")}` : ""}` : "trust check not run yet",
    });
  }
  const [a, b, c] = mine.map((x) => x.effective);
  const parts = {
    projects: Math.round(((a ?? 0) + 0.6 * (b ?? 0) + 0.3 * (c ?? 0)) / 1.9),
    dsa: Math.min(100, Math.round(view.strength * 100) + (DSA_ORDER.filter((k) => clearsBar(k, view.dsa[k], rules.dsa)).length >= 2 ? 10 : 0)),
    experience: experience.score,
    engineering: Math.min(
      100,
      30 * Math.min(2, mine.filter((x) => x.proofStatus === "verified").length) +
        5 * Math.min(5, uniq(mine.filter((x) => x.proofStatus === "verified").flatMap((x) => x.proof?.corroborated ?? [])).length) +
        Math.min(15, Math.round(mine.filter((x) => x.proofStatus === "verified").reduce((s, x) => s + (x.proof?.activeDays ?? 0), 0) / 2)),
    ),
  };
  // Projects, DSA and GitHub engineering make the score; experience is a bonus on top (not required).
  const w = rules.weights;
  const total = Math.max(1, w.projects + w.dsa + w.engineering);
  const raw = Math.min(100, (w.projects * parts.projects + w.dsa * parts.dsa + w.engineering * parts.engineering) / total + (w.experience * parts.experience) / 100);
  const factor = trust ? 0.6 + 0.4 * (trust.score / 100) : 1;
  return {
    role,
    label: roleLabel(role),
    projects: mine,
    strong,
    verifiedStrong,
    experience,
    gates,
    passed: gates.every((g) => g.ok && !g.pending),
    parts,
    raw: Math.round(raw),
    score: Math.round(raw * factor),
  };
}

// ── One candidate ────────────────────────────────────────────────────────────

export type SpStatus = "Showcase" | "Strong" | "Near miss" | "Excluded" | "Pending";
export type SpStage = "Screen" | "DSA" | "GitHub" | "Read" | "Projects" | "Verify" | "Trust" | "Score";
export const SP_STAGES: SpStage[] = ["Screen", "DSA", "GitHub", "Read", "Projects", "Verify", "Trust", "Score"];

export interface SpRanked {
  c: SpCandidate;
  rec: SpRecord;
  candidateId: string;
  status: SpStatus;
  /** Where the candidate stopped ("Score" = went through every check). */
  stage: SpStage;
  reason: string;
  login: string;
  dsa: SpDsaView | null;
  projects: SpScoredProject[];
  trust: SpTrustScore | null;
  /** Every role their projects show, best first. */
  fits: SpRoleFit[];
  primary: SpRoleFit | null;
  /** Other roles they also qualify for. */
  alsoFor: SpRoleFit[];
  /** Qualified and their DSA clears the SDE bar too. */
  sde: boolean;
  score: number;
  tier: "Showcase" | "Strong" | "";
  rejected: boolean;
}

const pendingOf = (stage: SpStage, reason: string) => ({ status: "Pending" as const, stage, reason });
const excluded = (stage: SpStage, reason: string) => ({ status: "Excluded" as const, stage, reason });

export function evaluateCandidate(c: SpCandidate, rec: SpRecord, rules: SpRules, batch: SpBatch, rejected: Set<string>): SpRanked {
  const s = rec.screen;
  const base: SpRanked = {
    c,
    rec,
    candidateId: s?.candidateId ?? "",
    status: "Pending",
    stage: "Screen",
    reason: "",
    login: githubLogin(s?.links.githubProfile ?? ""),
    dsa: null,
    projects: [],
    trust: null,
    fits: [],
    primary: null,
    alsoFor: [],
    sde: false,
    score: 0,
    tier: "",
    rejected: rejected.has(c.id),
  };
  const out = (o: Partial<SpRanked>): SpRanked => ({ ...base, ...o });

  // Screen
  if (!c.resumeUrl) return out(excluded("Screen", "No resume link in the sheet"));
  if (!s || s.version !== SP_VERSIONS.screen) return out(pendingOf("Screen", "Not screened yet"));
  if (s.status === "no-resume") return out(excluded("Screen", "No resume link in the sheet"));
  if (s.status === "not-resume") return out(excluded("Screen", s.error || "The resume link isn't a resume"));
  if (s.status === "error") return out(s.retryable ? pendingOf("Screen", `Screening failed — re-run (${s.error})`) : excluded("Screen", s.error));
  const first = s.sha ? batch.firstBySha.get(s.sha) : undefined;
  if (first && first.id !== c.id) return out(excluded("Screen", `Same resume file as sheet row ${first.row}`));
  if (!base.login) return out(excluded("Screen", "No GitHub profile link in the resume or the sheet"));
  if (batch.sharedGithub.has(base.login.toLowerCase())) return out(excluded("Screen", `GitHub account ${base.login} is on more than one row`));
  if (!DSA_ORDER.some((k) => s.links[k])) {
    const named = s.namedWithoutLink.map((k) => DSA_NAME[k]);
    return out(excluded("Screen", `No LeetCode / Codeforces / CodeChef profile link${named.length ? ` — the resume names ${named.join(", ")} without a profile link, so it can't be verified` : ""}`));
  }

  // DSA (CodeChef — the slowest host — waits for the GitHub check)
  const view = dsaView(c, rec, rules, batch);
  const next = view.passed ? null : pendingDsa(s.links, rec.dsa, rules);
  const withDsa = { dsa: view };
  if (!view.passed && next && next !== "codechef") return out({ ...withDsa, ...pendingOf("DSA", `Reading ${DSA_NAME[next]}`) });
  if (!view.passed && !next) return out({ ...withDsa, ...excluded("DSA", [view.reason, ...view.notes].join("; ")) });

  // GitHub account
  const probe = rec.probe;
  if (!probe) return out({ ...withDsa, ...pendingOf("GitHub", "GitHub account not checked yet") });
  if (probe.status === "failed") return out({ ...withDsa, ...pendingOf("GitHub", `GitHub check failed — re-run (${probe.note})`) });
  if (probe.status !== "ok") return out({ ...withDsa, ...excluded("GitHub", probe.note) });
  if (!view.passed) return out({ ...withDsa, ...pendingOf("DSA", "Reading CodeChef") });

  // Resume read
  const read = rec.read;
  if (!read || read.version !== SP_VERSIONS.read) return out({ ...withDsa, ...pendingOf("Read", "Resume not read yet") });
  if (read.status === "invalid") return out({ ...withDsa, ...excluded("Read", read.error) });
  if (read.status === "error") return out({ ...withDsa, ...(read.retryable ? pendingOf("Read", `Reading failed — re-run (${read.error})`) : excluded("Read", read.error)) });

  const verifyCurrent = Boolean(rec.verify && rec.verify.version === SP_VERSIONS.verify && !(rec.verify.basedOn && rec.verify.basedOn !== read.readAt));
  const verified = verifyCurrent && rec.verify!.status === "ok";
  if (!verifyCurrent) rec = { ...rec, verify: undefined };
  const projects = scoreProjects(rec, rules, batch);
  const trust = trustOf(c, rec, view);
  const roles = uniq(projects.flatMap((p) => [...p.roles, ...(p.roles.includes("fullstack") ? FULLSTACK_PARTS : [])]));
  const fits = roles.map((r) => roleFit(r, projects, read.jobs, view, trust, rules, { verified })).sort((a, b) => b.raw - a.raw || b.strong.length - a.strong.length);
  const more = { ...withDsa, projects, trust, fits };
  const bestFit = fits[0] ?? null;
  const gate = (f: SpRoleFit | null, key: SpGate["key"]) => f?.gates.find((g) => g.key === key);
  const nearOrOut = (stage: SpStage, reason: string, f: SpRoleFit | null) => {
    // One gate short (the rest passed or not decided yet) is a near miss worth a human look.
    const failed = f ? f.gates.filter((g) => !g.ok && !g.pending).length : 99;
    return { status: failed <= 1 && f && f.strong.length >= 1 ? ("Near miss" as const) : ("Excluded" as const), stage, reason };
  };

  // Strong projects (before GitHub proof)
  const withProjects = fits.filter((f) => gate(f, "projects")?.ok);
  if (!withProjects.length) {
    return out({ ...more, ...nearOrOut("Projects", projects.length ? (gate(bestFit, "projects")?.detail ?? "No strong project") : "No projects on the resume", bestFit) });
  }

  // GitHub proof
  if (!verified) {
    if (rec.verify?.status === "error" && !rec.verify.retryable) return out({ ...more, ...excluded("Verify", rec.verify.error) });
    return out({ ...more, ...pendingOf("Verify", rec.verify?.status === "error" ? `GitHub proof failed — re-run (${rec.verify.error})` : "GitHub proof not checked yet") });
  }
  const proven = withProjects.filter((f) => gate(f, "verified")?.ok);
  if (!proven.length) return out({ ...more, ...nearOrOut("Verify", gate(withProjects[0], "verified")?.detail ?? "No strong project proven in code", withProjects[0]) });

  // Trust
  if (rules.trustAgent) {
    if (!trust) {
      const t = rec.trust;
      return out({ ...more, ...pendingOf("Trust", t?.error ? `Trust check failed — re-run (${t.error})` : "Trust check not run yet") });
    }
    if (trust.band === "Low") return out({ ...more, ...nearOrOut("Trust", `Low trust (${trust.score}/100): ${trust.checks.filter((x) => x.points < 0).map((x) => x.label).join("; ")}`, proven[0]) });
  }

  // Score and tier
  const passing = fits.filter((f) => f.passed).sort((a, b) => b.score - a.score);
  const primary = passing[0] ?? null;
  if (!primary) return out({ ...more, ...excluded("Score", "No role passes every check") });
  const showcase = primary.score >= rules.showcaseAt && (!rules.trustAgent || trust?.band === "High");
  const tier = showcase ? "Showcase" : primary.score >= rules.strongAt ? "Strong" : "";
  const sde = Boolean(tier) && dsaView(c, rec, rules, batch, rules.sdeBar).passed;
  const scored = { ...more, primary, alsoFor: passing.slice(1), sde, score: primary.score };
  if (!tier) {
    return out({
      ...scored,
      status: "Near miss",
      stage: "Score",
      reason: `Profile score ${primary.score} is below the Strong bar (${rules.strongAt})`,
    });
  }
  const reason =
    tier === "Strong" && primary.score >= rules.showcaseAt && rules.trustAgent && trust?.band !== "High"
      ? `Showcase score, but trust is ${trust?.band} (${trust?.score}/100) — Showcase needs High trust`
      : "";
  return out({ ...scored, status: tier, stage: "Score", reason, tier });
}

// ── The whole run ────────────────────────────────────────────────────────────

export interface SpRoleTab {
  role: string;
  label: string;
  /** Qualified candidates in this tab, best first (taken-out ones excluded). */
  rows: SpRanked[];
  /** The top N shown to the company. */
  shown: SpRanked[];
}

export interface SpOutcome {
  rows: SpRanked[];
  tabs: SpRoleTab[];
  funnel: Record<SpStage, { reached: number; stopped: number; pending: number }>;
  stats: { rows: number; screened: number; dsaPassed: number; read: number; verified: number; showcase: number; strong: number; nearMiss: number; pending: number; roles: number };
}

/** A role's tab order: profile score, then DSA strength, then sheet order. */
const byScore = (role: string) => (a: SpRanked, b: SpRanked) => {
  const fa = role === "sde" ? a.primary : (a.fits.find((f) => f.role === role) ?? a.primary);
  const fb = role === "sde" ? b.primary : (b.fits.find((f) => f.role === role) ?? b.primary);
  return (fb?.score ?? 0) - (fa?.score ?? 0) || (b.dsa?.strength ?? 0) - (a.dsa?.strength ?? 0) || a.c.sheetRow - b.c.sheetRow;
};

export function rankShowcase(ds: SpDataset, records: Record<string, SpRecord>, rules: SpRules, rejectedIds: string[] = []): SpOutcome {
  const batch = batchFacts(ds, records);
  const rejected = new Set(rejectedIds);
  const rows = ds.candidates.map((c) => evaluateCandidate(c, records[c.id] ?? { id: c.id }, rules, batch, rejected));
  const qualified = rows.filter((r) => r.tier);

  const members = new Map<string, SpRanked[]>();
  const put = (role: string, r: SpRanked) => members.set(role, [...(members.get(role) ?? []), r]);
  for (const r of qualified) {
    put(r.primary!.role, r);
    if (rules.everyRole) for (const f of r.alsoFor) put(f.role, r);
    if (r.sde && r.primary!.role !== "sde" && !(rules.everyRole && r.alsoFor.some((f) => f.role === "sde"))) put("sde", r);
  }
  const order = (role: string) => {
    const i = Object.keys(SP_ROLE).indexOf(role);
    return i < 0 ? 100 : i;
  };
  const tabs: SpRoleTab[] = [...members.entries()]
    .map(([role, list]) => {
      const sorted = [...list].sort(byScore(role));
      const kept = sorted.filter((r) => !r.rejected);
      return { role, label: roleLabel(role), rows: kept, shown: kept.slice(0, Math.max(1, rules.topN)) };
    })
    .sort((a, b) => order(a.role) - order(b.role) || b.rows.length - a.rows.length || a.label.localeCompare(b.label));

  const funnel = Object.fromEntries(SP_STAGES.map((s) => [s, { reached: 0, stopped: 0, pending: 0 }])) as SpOutcome["funnel"];
  for (const r of rows) {
    const idx = SP_STAGES.indexOf(r.stage);
    for (let i = 0; i <= idx; i++) funnel[SP_STAGES[i]].reached++;
    if (r.status === "Pending") funnel[r.stage].pending++;
    else if (r.status === "Excluded" || r.status === "Near miss") funnel[r.stage].stopped++;
  }
  const after = (stage: SpStage) => rows.filter((r) => SP_STAGES.indexOf(r.stage) > SP_STAGES.indexOf(stage)).length;
  return {
    rows,
    tabs,
    funnel,
    stats: {
      rows: rows.length,
      screened: rows.filter((r) => r.rec.screen && r.rec.screen.version === SP_VERSIONS.screen).length,
      dsaPassed: rows.filter((r) => r.dsa?.passed).length,
      read: rows.filter((r) => r.rec.read?.status === "ok").length,
      verified: after("Verify"),
      showcase: qualified.filter((r) => r.tier === "Showcase" && !r.rejected).length,
      strong: qualified.filter((r) => r.tier === "Strong" && !r.rejected).length,
      nearMiss: rows.filter((r) => r.status === "Near miss").length,
      pending: rows.filter((r) => r.status === "Pending").length,
      roles: tabs.length,
    },
  };
}

// ── Plain-words summaries (results table, workbooks) ────────────────────────

/** "Codeforces max rating 1720 · 21 contests" — the platform that clears the bar. */
export function dsaHeadline(r: SpRanked): string {
  const v = r.dsa;
  if (!v?.by) return v?.lines[0] ?? "";
  const p = v.dsa[v.by];
  const rating = v.by === "leetcode" ? p?.rating : bestRating(p);
  return [`${DSA_NAME[v.by]} ${v.by === "leetcode" ? "rating" : "max rating"} ${rating ?? "—"}`, typeof p?.contests === "number" ? `${p.contests} contests` : "", typeof p?.solved === "number" ? `${p.solved} solved` : ""].filter(Boolean).join(" · ");
}

export function experienceLine(r: SpRanked): string {
  const jobs = r.rec.read?.status === "ok" ? r.rec.read.jobs : [];
  return jobs
    .map((j) => `${j.title || "—"} at ${j.company}${j.months ? ` (${j.months} mo${j.employmentType === "internship" ? ", internship" : ""})` : j.employmentType === "internship" ? " (internship)" : ""}`)
    .join("; ");
}

/** One line for a company: role, DSA, proven projects, experience. */
export function headline(r: SpRanked): string {
  const f = r.primary;
  if (!f) return "";
  const proven = f.verifiedStrong.length;
  const months = f.experience.months;
  return [f.label, dsaHeadline(r), `${proven} project${proven === 1 ? "" : "s"} verified in their own code`, months ? `${months} months' in-role experience` : ""].filter(Boolean).join(" · ");
}
