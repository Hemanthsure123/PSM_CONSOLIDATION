import { DSA_NAME, DSA_ORDER, clearsBar } from "@/lib/showcase/dsa-rules";
import {
  PROOF_FACTOR,
  dsaView,
  githubLogin,
  pendingDsa,
  profileRole,
  scoreProjects,
  trustOf,
  type SpBatch,
  type SpDsaView,
  type SpGate,
  type SpRanked,
  type SpRoleFit,
  type SpRoleProject,
  type SpScoredProject,
  type SpStage,
  type SpTrustScore,
} from "@/lib/showcase/scoring";
import { codeCheckable, itemCovered, rulesForProfile, runDsaBar } from "@/lib/showcase/profile-rules";
import { SP_VERSIONS, type SpCandidate, type SpJob, type SpProfileDef, type SpProfileJudgement, type SpRecord, type SpRules } from "@/lib/showcase/types";

/**
 * Sample profiles from job descriptions — the decision for one candidate (pure, browser). Instead
 * of the roles the evidence shows, the candidate is judged against each profile of the run:
 *  1. DSA: the profile's own bar, or none when the profile switches DSA off;
 *  2. mandatory: every mandatory item proven in the projects / experience (the judge's quote,
 *     checked against the resume's evidence text — never the Skills list);
 *  3. strong projects relevant to the profile (2, or 1 exceptional plus relevant experience);
 *  4. verified in code (when the profile requires it): a strong relevant project proven in their
 *     own repository, and every mandatory technology the code can show proven there;
 *  5. minimum relevant experience (when the profile sets one);
 *  6. the judged fit at or above the profile's bar;
 *  7. trust not Low (when the profile uses the trust agent).
 * The funnel stays cheap and strict first: screen → DSA (the loosest bar of the run) → GitHub →
 * the mandatory prefilter (no model) → the resume read → a strong project at all → the judge (one
 * model call for every profile) → the GitHub proof → trust → score. A candidate is listed under
 * every profile they pass, ranked there by that profile's score.
 */

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

const TYPE_WEIGHT: Record<SpJob["employmentType"], number> = { "full-time": 1, contract: 0.8, "part-time": 0.6, freelance: 0.5, internship: 0.5, other: 0.4 };
const COMPANY_WEIGHT: Record<SpJob["companyType"], number> = { product: 1.2, unknown: 1, consulting: 0.8, "it-services": 0.7, staffing: 0.6 };

/** Experience in the profile's domain: the jobs the judge names as relevant. 0-100: a year of full-time product work is full marks. */
export function profileExperience(jobs: SpJob[], relevant: string[]): { score: number; months: number; relevant: boolean } {
  const names = new Set(relevant.map((c) => c.toLowerCase().trim()));
  let eff = 0;
  let months = 0;
  for (const j of jobs) {
    if (!names.has(j.company.toLowerCase().trim())) continue;
    const m = j.months ?? 0;
    months += m;
    eff += m * TYPE_WEIGHT[j.employmentType] * COMPANY_WEIGHT[j.companyType];
  }
  return { score: Math.min(100, Math.round((eff / 12) * 100)), months, relevant: months >= 3 };
}

interface FitStage {
  judged: boolean;
  verified: boolean;
}

/** One profile's gates and score for one candidate. */
export function profileFit(
  p: SpProfileDef,
  scored: SpScoredProject[],
  jobs: SpJob[],
  view: SpDsaView,
  trust: SpTrustScore | null,
  judgement: SpProfileJudgement | null,
  stage: FitStage,
): SpRoleFit {
  const i = p.inputs;
  const relevant = new Set(judgement?.projects ?? []);
  const mine: SpRoleProject[] = scored
    .filter((sp) => relevant.has(sp.p.title))
    .map((sp) => ({ ...sp, native: true, effective: sp.quality * PROOF_FACTOR[sp.proofStatus] }))
    .sort((a, b) => b.effective - a.effective);
  const strong = mine.filter((x) => x.quality >= i.strongProject);
  const exceptional = mine.filter((x) => x.quality >= i.exceptionalProject);
  const experience = profileExperience(jobs, judgement?.jobs ?? []);
  const verifiedStrong = strong.filter((x) => x.proofStatus === "verified");
  const projectsOk = strong.length >= 2 || (exceptional.length >= 1 && experience.relevant);

  // Every technology the candidate's own verified code proves (under this profile's thresholds).
  const provenKeys = new Set(scored.filter((x) => x.proofStatus === "verified").flatMap((x) => x.proof?.provenKeys ?? []));
  const mandatoryInCode = i.requireVerified
    ? codeCheckable(p).map((m) => {
        const ok = itemCovered(m, provenKeys);
        const repo = ok ? scored.find((x) => x.proofStatus === "verified" && m.keys.some((k) => x.proof?.provenKeys.includes(k)))?.proof?.repoUrl ?? "" : "";
        return { item: m.item, ok, how: ok ? `their own code: ${repo.replace(/^https?:\/\/github\.com\//, "")}` : `${m.labels.join(m.mode === "any" ? " or " : ", ")} not proven in their own verified code` };
      })
    : [];

  const unmet = judgement ? judgement.mandatory.filter((m) => !m.met) : [];
  const gates: SpGate[] = [
    i.dsaRequired
      ? { key: "dsa", label: "DSA bar", ok: view.passed, pending: false, detail: view.passed ? view.lines.join("; ") : view.reason }
      : { key: "dsa", label: "DSA bar", ok: true, pending: false, detail: "not required for this profile" },
    {
      key: "mandatory",
      label: "Mandatory",
      ok: Boolean(judgement) && unmet.length === 0,
      pending: !stage.judged,
      detail: !judgement
        ? "profile fit not checked yet"
        : unmet.length
          ? unmet.map((m) => `${m.item}: ${m.why}`).join("; ")
          : p.mandatory.length
            ? judgement.mandatory.map((m) => `${m.item} — “${m.quote}”`).join("; ")
            : "none set",
    },
    {
      key: "projects",
      label: "Strong relevant projects",
      ok: projectsOk,
      pending: !stage.judged,
      detail: projectsOk
        ? `${strong.length} strong (quality ≥ ${i.strongProject})`
        : `${strong.length} strong relevant — needs 2 at quality ≥ ${i.strongProject}, or 1 at ≥ ${i.exceptionalProject} plus relevant experience${mine.length ? `; best: ${mine.slice(0, 3).map((x) => `${x.p.title} ${x.quality}${x.capReasons.length ? ` (${x.capReasons[0]})` : ""}`).join(", ")}` : relevant.size ? "" : "; no project is relevant to this profile"}`,
    },
  ];
  if (i.requireVerified) {
    const codeMissing = mandatoryInCode.filter((m) => !m.ok);
    const ok = verifiedStrong.length >= 1 && codeMissing.length === 0;
    gates.push({
      key: "verified",
      label: "Verified in code",
      ok,
      pending: !stage.verified,
      detail: !stage.verified
        ? "GitHub proof not checked yet"
        : ok
          ? [verifiedStrong.map((x) => `${x.p.title}: ${x.proofWhy}`).join("; "), ...mandatoryInCode.map((m) => `${m.item} — ${m.how}`)].filter(Boolean).join("; ")
          : [
              verifiedStrong.length ? "" : strong.length ? `no strong relevant project is proven by their own code — ${strong.map((x) => `${x.p.title}: ${x.proofWhy}`).join("; ")}` : "no strong relevant project to prove",
              ...codeMissing.map((m) => `${m.item}: ${m.how}`),
            ]
              .filter(Boolean)
              .join("; "),
    });
  }
  if (i.minExperienceMonths > 0) {
    gates.push({
      key: "experience",
      label: "Relevant experience",
      ok: experience.months >= i.minExperienceMonths,
      pending: !stage.judged,
      detail: `${experience.months} months relevant (needs ${i.minExperienceMonths})`,
    });
  }
  gates.push({
    key: "fit",
    label: "Fit to the profile",
    ok: Boolean(judgement) && judgement!.fit >= i.minFit,
    pending: !stage.judged,
    detail: judgement ? `${judgement.fit}/100 (needs ${i.minFit})${judgement.capped ? ` — ${judgement.capped}` : ""}${judgement.evidence ? `: ${judgement.evidence}` : ""}` : "profile fit not checked yet",
  });
  if (i.trustAgent) {
    gates.push({
      key: "trust",
      label: "Trust",
      ok: Boolean(trust && trust.band !== "Low"),
      pending: !trust,
      detail: trust ? `${trust.score}/100 (${trust.band})${trust.band === "Low" ? `: ${trust.checks.filter((x) => x.points < 0).map((x) => x.label).join("; ")}` : ""}` : "trust check not run yet",
    });
  }

  const [a, b, c] = mine.map((x) => x.effective);
  const good = p.goodToHave.length ? (judgement?.goodToHave.length ?? 0) / p.goodToHave.length : 0;
  const verified = mine.filter((x) => x.proofStatus === "verified");
  const parts = {
    projects: Math.round(((a ?? 0) + 0.6 * (b ?? 0) + 0.3 * (c ?? 0)) / 1.9),
    dsa: Math.min(100, Math.round(view.strength * 100) + (DSA_ORDER.filter((k) => clearsBar(k, view.dsa[k], i.dsa)).length >= 2 ? 10 : 0)),
    experience: experience.score,
    engineering: Math.min(
      100,
      30 * Math.min(2, verified.length) +
        5 * Math.min(5, uniq(verified.flatMap((x) => x.proof?.corroborated ?? [])).length) +
        Math.min(15, Math.round(verified.reduce((s, x) => s + (x.proof?.activeDays ?? 0), 0) / 2)),
    ),
    fit: judgement ? Math.round(0.8 * judgement.fit + 20 * Math.min(1, good)) : 0,
  };
  const w = i.weights;
  const total = Math.max(1, w.projects + w.dsa + w.engineering + w.fit);
  const raw = Math.min(100, (w.projects * parts.projects + w.dsa * parts.dsa + w.engineering * parts.engineering + w.fit * parts.fit) / total + (w.experience * parts.experience) / 100);
  const factor = trust ? 0.6 + 0.4 * (trust.score / 100) : 1;
  const score = Math.round(raw * factor);
  const passed = gates.every((g) => g.ok && !g.pending);
  const tier = !passed ? "" : score >= i.showcaseAt && (!i.trustAgent || trust?.band === "High") ? "Showcase" : score >= i.strongAt ? "Strong" : "";
  return {
    role: profileRole(p.id),
    label: p.name.trim() || "Untitled profile",
    projects: mine,
    strong,
    verifiedStrong,
    experience,
    gates,
    passed,
    parts,
    raw: Math.round(raw),
    score,
    tier,
    profile: { id: p.id, name: p.name, topN: i.topN, judgement, mandatoryInCode },
  };
}

const pendingOf = (stage: SpStage, reason: string) => ({ status: "Pending" as const, stage, reason });
const excluded = (stage: SpStage, reason: string) => ({ status: "Excluded" as const, stage, reason });

/** The gates decided before the GitHub proof and the trust check. */
const beforeProof = (f: SpRoleFit) => f.gates.filter((g) => g.key !== "verified" && g.key !== "trust").every((g) => g.ok && !g.pending);

export function evaluateProfileCandidate(
  c: SpCandidate,
  rec: SpRecord,
  rules: SpRules,
  batch: SpBatch,
  rejected: Set<string>,
  profiles: SpProfileDef[],
  hash: string,
): SpRanked {
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
  const needGithubAll = profiles.every((p) => p.inputs.requireVerified);
  const dsaAll = profiles.every((p) => p.inputs.dsaRequired);

  // Screen
  if (!c.resumeUrl) return out(excluded("Screen", "No resume link in the sheet"));
  if (!s || s.version !== SP_VERSIONS.screen) return out(pendingOf("Screen", "Not screened yet"));
  if (s.status === "no-resume") return out(excluded("Screen", "No resume link in the sheet"));
  if (s.status === "not-resume") return out(excluded("Screen", s.error || "The resume link isn't a resume"));
  if (s.status === "error") return out(s.retryable ? pendingOf("Screen", `Screening failed — re-run (${s.error})`) : excluded("Screen", s.error));
  if (s.status === "ok" && !s.evidenceKeys) return out(pendingOf("Screen", "Screen again for the mandatory check (no model)"));
  const first = s.sha ? batch.firstBySha.get(s.sha) : undefined;
  if (first && first.id !== c.id) return out(excluded("Screen", `Same resume file as sheet row ${first.row}`));
  let login = base.login;
  if (login && batch.sharedGithub.has(login.toLowerCase())) {
    if (needGithubAll) return out(excluded("Screen", `GitHub account ${login} is on more than one row`));
    login = "";
  }
  if (!login && needGithubAll) return out(excluded("Screen", "No GitHub profile link in the resume or the sheet — every profile needs code proof"));
  const hasDsaLink = DSA_ORDER.some((k) => s.links[k]);
  if (!hasDsaLink && dsaAll) {
    const named = s.namedWithoutLink.map((k) => DSA_NAME[k]);
    return out(excluded("Screen", `No LeetCode / Codeforces / CodeChef profile link${named.length ? ` — the resume names ${named.join(", ")} without a profile link, so it can't be verified` : ""}`));
  }

  // DSA — read for the loosest bar of the run (CodeChef, the slowest host, waits for the GitHub check).
  const bar = runDsaBar(profiles);
  const loose: SpRules = { ...rules, dsa: bar };
  const view = dsaView(c, rec, loose, batch, bar);
  const next = view.passed || !hasDsaLink ? null : pendingDsa(s.links, rec.dsa, loose);
  const withDsa = { dsa: view, login };
  if (!view.passed && next && next !== "codechef") return out({ ...withDsa, ...pendingOf("DSA", `Reading ${DSA_NAME[next]}`) });
  if (!view.passed && !next && dsaAll) return out({ ...withDsa, ...excluded("DSA", [view.reason, ...view.notes].join("; ")) });

  // GitHub account
  const probe = rec.probe;
  let github = false;
  if (login) {
    if (!probe) return out({ ...withDsa, ...pendingOf("GitHub", "GitHub account not checked yet") });
    if (probe.status === "failed") return out({ ...withDsa, ...pendingOf("GitHub", `GitHub check failed — re-run (${probe.note})`) });
    if (probe.status !== "ok" && needGithubAll) return out({ ...withDsa, ...excluded("GitHub", probe.note) });
    github = probe.status === "ok";
  }
  if (!view.passed && next === "codechef") return out({ ...withDsa, ...pendingOf("DSA", "Reading CodeChef") });

  // Which profiles are still possible: DSA (each profile's own bar) and code proof.
  const views = new Map(profiles.map((p) => [p.id, dsaView(c, rec, rulesForProfile(rules, p), batch, p.inputs.dsa)]));
  const open = profiles.filter((p) => (!p.inputs.dsaRequired || views.get(p.id)!.passed) && (!p.inputs.requireVerified || github));
  const closedWhy = profiles
    .filter((p) => !open.includes(p))
    .map((p) => `${p.name || p.id}: ${p.inputs.dsaRequired && !views.get(p.id)!.passed ? `DSA — ${views.get(p.id)!.reason}` : "needs a GitHub account with code"}`);
  if (!open.length) return out({ ...withDsa, ...excluded(github ? "DSA" : "GitHub", closedWhy.join("; ")) });

  // Mandatory prefilter (no model): the resume's projects / experience must name every mandatory technology of some profile.
  const keys = new Set(s.evidenceKeys ?? []);
  const prefiltered = s.status === "ok" ? open.filter((p) => p.mandatory.every((m) => itemCovered(m, keys))) : open;
  if (!prefiltered.length) {
    const missing = open.map((p) => `${p.name || p.id}: ${p.mandatory.filter((m) => !itemCovered(m, keys)).map((m) => m.item).join(", ")}`);
    return out({ ...withDsa, ...excluded("Prefilter", [`The projects / experience don't name a mandatory technology — ${missing.join("; ")}`, ...closedWhy].join("; ")) });
  }

  // Resume read
  const read = rec.read;
  if (!read || read.version !== SP_VERSIONS.read) return out({ ...withDsa, ...pendingOf("Read", "Resume not read yet") });
  if (read.status === "invalid") return out({ ...withDsa, ...excluded("Read", read.error) });
  if (read.status === "error") return out({ ...withDsa, ...(read.retryable ? pendingOf("Read", `Reading failed — re-run (${read.error})`) : excluded("Read", read.error)) });

  // A strong project at all (the judge is a model call — only for candidates who could pass).
  const verifyCurrent = Boolean(rec.verify && rec.verify.version === SP_VERSIONS.verify && !(rec.verify.basedOn && rec.verify.basedOn !== read.readAt));
  const verified = verifyCurrent && rec.verify!.status === "ok";
  if (!verifyCurrent) rec = { ...rec, verify: undefined };
  const trust = trustOf(c, rec, view);
  const scoredFor = new Map(profiles.map((p) => [p.id, scoreProjects(rec, rulesForProfile(rules, p), batch)]));
  const minStrong = Math.min(...prefiltered.map((p) => p.inputs.strongProject));
  const anyScored = scoredFor.get(prefiltered[0].id) ?? [];
  const more = { ...withDsa, projects: anyScored, trust };
  if (!anyScored.some((x) => x.quality >= minStrong)) {
    const best = [...anyScored].sort((a, b) => b.quality - a.quality).slice(0, 3);
    return out({ ...more, ...excluded("Projects", anyScored.length ? `No strong project (quality ≥ ${minStrong}) — best: ${best.map((x) => `${x.p.title} ${x.quality}${x.capReasons.length ? ` (${x.capReasons[0]})` : ""}`).join(", ")}` : "No projects on the resume") });
  }

  // The profile-fit judge
  const j = rec.judge;
  const judged = Boolean(j && j.version === SP_VERSIONS.judge && j.status === "ok" && j.basedOn === hash && j.readAt === read.readAt);
  if (!judged) {
    if (j && j.status === "error" && j.basedOn === hash && j.readAt === read.readAt && !j.retryable) return out({ ...more, ...excluded("Judge", j.error) });
    return out({ ...more, ...pendingOf("Judge", j?.status === "error" && j.basedOn === hash ? `Profile fit failed — re-run (${j.error})` : "Profile fit not checked yet") });
  }
  const fits = profiles
    .map((p) => profileFit(p, scoredFor.get(p.id) ?? [], read.jobs, views.get(p.id)!, trust, j!.profiles[p.id] ?? null, { judged: true, verified }))
    .sort((a, b) => b.raw - a.raw);
  const withFits = { ...more, fits };
  const nearOrOut = (stage: SpStage, reason: string, f: SpRoleFit | null) => {
    const failed = f ? f.gates.filter((g) => !g.ok && !g.pending).length : 99;
    return { status: failed <= 1 && f && f.strong.length >= 1 ? ("Near miss" as const) : ("Excluded" as const), stage, reason };
  };
  const firstFail = (f: SpRoleFit | null) => {
    const g = f?.gates.find((x) => !x.ok && !x.pending);
    return g ? `${f!.label} — ${g.label}: ${g.detail}` : "No profile passes its checks";
  };
  const possible = fits.filter((f) => open.some((p) => profileRole(p.id) === f.role));
  const pre = possible.filter(beforeProof);
  if (!pre.length) return out({ ...withFits, ...nearOrOut("Judge", firstFail(possible[0] ?? fits[0] ?? null), possible[0] ?? fits[0] ?? null) });

  // GitHub proof (the profiles that need it)
  const needProof = pre.some((f) => profiles.find((p) => profileRole(p.id) === f.role)?.inputs.requireVerified);
  if (needProof && !verified) {
    if (rec.verify?.status === "error" && !rec.verify.retryable) return out({ ...withFits, ...excluded("Verify", rec.verify.error) });
    return out({ ...withFits, ...pendingOf("Verify", rec.verify?.status === "error" ? `GitHub proof failed — re-run (${rec.verify.error})` : "GitHub proof not checked yet") });
  }
  const proven = pre.filter((f) => f.gates.find((g) => g.key === "verified")?.ok ?? true);
  if (!proven.length) return out({ ...withFits, ...nearOrOut("Verify", firstFail(pre[0]), pre[0]) });

  // Trust (the profiles that use it)
  const needTrust = proven.some((f) => f.gates.some((g) => g.key === "trust"));
  if (needTrust && !trust) {
    const t = rec.trust;
    return out({ ...withFits, ...pendingOf("Trust", t?.error ? `Trust check failed — re-run (${t.error})` : "Trust check not run yet") });
  }

  // Score and tiers, per profile
  const passing = fits.filter((f) => f.passed).sort((a, b) => b.score - a.score);
  const listed = passing.filter((f) => f.tier);
  if (!listed.length) {
    const top = passing[0] ?? proven[0];
    if (passing.length) {
      const p = profiles.find((x) => profileRole(x.id) === top.role)!;
      return out({ ...withFits, primary: top, score: top.score, status: "Near miss", stage: "Score", reason: `${top.label}: profile score ${top.score} is below the Strong bar (${p.inputs.strongAt})` });
    }
    return out({ ...withFits, ...nearOrOut("Trust", firstFail(top), top) });
  }
  const primary = listed[0];
  const p0 = profiles.find((x) => profileRole(x.id) === primary.role)!;
  const reason =
    primary.tier === "Strong" && primary.score >= p0.inputs.showcaseAt && p0.inputs.trustAgent && trust?.band !== "High"
      ? `Showcase score, but trust is ${trust?.band} (${trust?.score}/100) — Showcase needs High trust`
      : "";
  return out({ ...withFits, primary, alsoFor: listed.slice(1), score: primary.score, status: primary.tier as "Showcase" | "Strong", stage: "Score", reason, tier: primary.tier as "Showcase" | "Strong" });
}
