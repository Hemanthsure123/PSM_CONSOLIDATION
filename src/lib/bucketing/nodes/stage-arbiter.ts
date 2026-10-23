import "server-only";
import {
  BUCKET_LABEL,
  REASON_TEXT,
  TRACK_BUCKET,
  TRACK_LABEL,
  isBucket,
  priorityTier,
  stageLabel,
  type Bucket,
  type ReasonCode,
} from "@/lib/bucketing/config";
import { eligibility, roleBuckets } from "@/lib/bucketing/nodes/bucketing-agent";
import { bestFlagship } from "@/lib/bucketing/nodes/bucket-verifier";
import { traceEntry } from "@/lib/bucketing/nodes/shared";
import { achievementsScore, domainScoreFor, experienceScore, internalScore, overallScore, projectsScore } from "@/lib/bucketing/scoring";
import {
  EMPTY_SCORES,
  hireTrackBuckets,
  journeyClosed,
  type BucketingStatus,
  type DomainScore,
  type FinalDecision,
  type InternalParts,
  type ProjectEvidence,
  type Scores,
} from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 7 — stage arbiter (the main bucketing agent; deterministic). Puts the
 * internal assessments first, then the verified evidence:
 *  - a TR-2 hire goes to the bucket of the track they were hired in (best verdict;
 *    a tie goes to the track the resume backs). Weak or missing resume evidence
 *    never drops them — it is flagged (TRACK_MISMATCH / INTERVIEW_ONLY) and lowers
 *    the scores and trust;
 *  - everyone else (combined-interview and Product hires, TR-1, Assessment) is
 *    bucketed by a verified project or an in-domain internship / job, or gets the
 *    reasons why not;
 *  - missing evidence (GitHub down, a failed agent) is "retry_needed" — or, for a
 *    track-placed hire, a re-run flag — never a rejection.
 * Scores are computed for everyone, so not-bucketed rows still rank.
 * On a second pass it applies the final verifier's repair instructions.
 */

export function stageArbiterNode(s: State): Update {
  const t0 = Date.now();
  const c = s.input;
  const attempt = (s.attempts.stage_arbiter ?? 0) + 1;
  const repair = attempt > 1 ? (s.finalReview?.issues ?? []) : [];
  const label = stageLabel(c.stage, c.track, c.verdict ?? null);
  const dsa = s.dsa?.score ?? 0;
  const remarks: string[] = [];
  const reasons: ReasonCode[] = [];
  const flags: ReasonCode[] = [];

  const x = s.resume?.status === "ok" ? s.extraction : undefined;
  const pe = s.projectEvidence;
  const projects = x ? (pe?.projects ?? []) : [];
  const experience = x?.experience ?? [];
  const domains: DomainScore[] = x ? (s.domainReview?.adjusted?.length ? s.domainReview.adjusted : (s.domainAnalysis?.domains ?? [])) : [];
  const strengths = s.bucketing?.projectStrengths ?? {};
  const elig = eligibility(projects, experience);
  const backed = (b: Bucket) => elig.eligible.includes(b);
  const agentOk = Boolean(s.domainAnalysis && !s.domainAnalysis.error && s.bucketing && !s.bucketing.error);
  const agentBucket = agentOk && s.bucketing?.bucket && backed(s.bucketing.bucket) ? s.bucketing.bucket : null;

  // The track(s) the candidate was hired in at their best verdict; a tie goes to the one the resume backs.
  const group = hireTrackBuckets(c);
  const trackBucket: Bucket | null =
    group.length <= 1 ? (group[0] ?? null) : (group.find((b) => b === agentBucket) ?? group.find(backed) ?? group[0]);
  const hire = trackBucket
    ? (c.interview?.tr2.find((t) => TRACK_BUCKET[t.track] === trackBucket) ?? (c.track ? { track: c.track, verdict: c.verdict ?? null } : null))
    : null;
  // No verdict in the remark: the tag carries it, and a refreshed export can change it without a re-run.
  const hireText = hire ? `${TRACK_LABEL[hire.track]} TR-2` : "TR-2";

  const inDomainRoles = (b: Bucket | null): Set<string> => {
    if (!b) return new Set();
    const ev = new Set(domains.find((d) => d.domain === b)?.evidence.map((e) => e.itemId) ?? []);
    return new Set(experience.filter((e) => ev.has(e.id) || roleBuckets(e).includes(b)).map((e) => e.id));
  };

  /** Every score, for bucketed and not-bucketed rows alike (the latter use the track or strongest bucket domain). */
  const score = (bucket: Bucket | null, flagshipStrength: number | undefined): { scores: Scores; parts: InternalParts } => {
    const sb = bucket ?? trackBucket ?? topBucket(domains);
    let strength = flagshipStrength;
    if (strength === undefined) {
      const f = sb ? bestFlagship(sb, projects, strengths) : null;
      strength = f ? (strengths[f.projectId] ?? 0) : 0;
    }
    const internal = internalScore(c.interview, c.verdict, sb);
    const domain = domainScoreFor(sb, domains);
    const scores: Scores = {
      ...EMPTY_SCORES,
      internal: internal.score,
      projects: projectsScore(sb, projects, strength, domain),
      experience: experienceScore(experience, inDomainRoles(sb)),
      achievements: achievementsScore(x?.achievements ?? [], x ? (pe?.oss ?? []) : [], dsa),
      domain,
      flagship: strength,
      dsa,
    };
    scores.overall = overallScore(scores);
    return { scores, parts: internal.parts };
  };

  const finish = (
    status: BucketingStatus,
    rest: { bucket?: Bucket | null; flagshipId?: string; flagshipStrength?: number; placedBy?: FinalDecision["placedBy"]; trackBacked?: boolean | null } = {},
  ): Update => {
    const bucket = rest.bucket ?? null;
    const { scores, parts } = score(bucket, rest.flagshipStrength);
    const final: FinalDecision = {
      status,
      bucket,
      stageLabel: label,
      priorityTier: priorityTier(c.stage, c.verdict ?? null),
      validated: projects.some((p) => p.valid && (p.tier === "A" || p.tier === "B" || p.tier === "R")),
      placedBy: rest.placedBy ?? "",
      internalParts: parts,
      reasonCodes: Array.from(new Set(reasons)),
      flags: Array.from(new Set(flags)),
      flagshipId: rest.flagshipId ?? "",
      scores,
      remarks,
      trackBacked: rest.trackBacked ?? null,
      attempt,
    };
    return {
      final,
      attempts: { stage_arbiter: attempt },
      ...traceEntry(
        "stage_arbiter",
        t0,
        `${label}: ${status}${final.bucket ? ` → ${final.bucket}${final.placedBy ? ` (by ${final.placedBy})` : ""}` : ""}${final.reasonCodes.length ? ` [${final.reasonCodes.join(", ")}]` : ""}${final.flags.length ? ` flags ${final.flags.join(", ")}` : ""}; overall ${scores.overall}${attempt > 1 ? " (repair pass)" : ""}`,
      ),
    };
  };

  /** A TR-2 hire whose resume could not be checked: their track's bucket, on the interview alone. */
  const byInterviewOnly = (why: string, rerun?: ReasonCode): Update => {
    flags.push("INTERVIEW_ONLY");
    if (rerun) flags.push(rerun);
    remarks.unshift(`${BUCKET_LABEL[trackBucket!]} — placed by the ${hireText} interview alone; ${why}`);
    return finish("bucketed", { bucket: trackBucket, placedBy: "tr2-track", trackBacked: false, flagshipStrength: 0 });
  };

  // 0) A closed journey in the drive (not responding, placed …) is out of the pool — nothing was read.
  if (journeyClosed(c)) {
    const j = c.interview!.journey!;
    reasons.push("JOURNEY_CLOSED");
    remarks.push(`Journey closed${j.reason ? `: ${j.reason.replace(/_/g, " ")}` : ""}${j.notes ? ` — ${j.notes.replace(/[.\s]+$/, "")}` : ""}. Reopen the journey and re-run to bucket this candidate.`);
    return finish("not_bucketed");
  }

  // 1) The resume itself.
  const r = s.resume;
  if (!r || r.status !== "ok") {
    const noLink = !c.resumeUrl && !c.resumeText?.trim();
    const transient = !noLink && (!r || r.status === "error");
    const note = noLink ? REASON_TEXT.NO_RESUME_LINK : r?.note || "The resume step did not finish";
    if (trackBucket) return byInterviewOnly(`the resume could not be checked (${note}).`, transient ? "PIPELINE_ERROR" : undefined);
    reasons.push(noLink ? "NO_RESUME_LINK" : r?.status === "not_resume" ? "NOT_A_RESUME" : transient ? "PIPELINE_ERROR" : "RESUME_UNREADABLE");
    remarks.push(transient ? `${note} — re-run.` : note);
    return finish(transient ? "retry_needed" : "not_bucketed");
  }
  if (!x || !pe) {
    if (trackBucket) return byInterviewOnly("project verification did not finish — re-run to check the resume.", "PIPELINE_ERROR");
    reasons.push("PIPELINE_ERROR");
    remarks.push("Project verification did not finish — re-run.");
    return finish("retry_needed");
  }

  const invalid = projects.filter((p) => p.status === "invalid");
  const invalidNotes = invalid.map(
    (p) => `${p.projectId} "${p.title}": ${REASON_TEXT[p.invalidReason ?? "REPO_NOT_FOUND_OR_PRIVATE"]} — ${p.note.slice(0, 220)}`,
  );

  // 2) Missing evidence is never a rejection: a re-run for most, a re-run flag on a track-placed hire.
  const pending: ReasonCode[] = [];
  if (pe.unavailable) pending.push("GITHUB_UNAVAILABLE");
  if (!agentOk) pending.push("PIPELINE_ERROR");
  const pendingNote = pe.unavailable
    ? "GitHub could not be checked for every project (rate limit / outage)"
    : `An agent failed (${s.domainAnalysis?.error ? "domain analysis" : "bucketing"}: ${(s.domainAnalysis?.error || s.bucketing?.error || "no output").slice(0, 160)})`;
  if (pending.length && !trackBucket) {
    reasons.push(...pending);
    remarks.push(`${pendingNote} — re-run this candidate.`, ...invalidNotes);
    return finish("retry_needed");
  }
  flags.push(...pending);

  // 3) The bucket: the TR-2 hire track first, otherwise the verified evidence.
  let bucket: Bucket | null;
  let placedBy: FinalDecision["placedBy"];
  let trackBacked: boolean | null = null;
  if (trackBucket) {
    bucket = trackBucket;
    placedBy = "tr2-track";
    trackBacked = backed(trackBucket);
    if (!trackBacked) flags.push("TRACK_MISMATCH");
  } else {
    bucket = agentBucket ?? rankEligible(elig.eligible, domains)[0] ?? null;
    placedBy = bucket ? "evidence" : "";
    if (bucket && bucket !== agentBucket) remarks.push(`The bucketing agent chose no bucket; ${BUCKET_LABEL[bucket]} is the best-backed eligible bucket.`);
  }

  // Repairs requested by the final verifier.
  if (placedBy === "evidence" && repair.some((i) => i.startsWith("invariant:bucket_unbacked"))) {
    remarks.push(`Bucket ${bucket ?? "—"} removed: no verified evidence backs it.`);
    bucket = null;
    placedBy = "";
  }

  if (!bucket) {
    if (!x.projects.length) reasons.push("NO_PROJECTS");
    else if (!projects.some((p) => p.valid && p.tier !== "C")) {
      // Demo-only (tier C) projects back a bucket only alongside an in-domain role.
      if (!x.projects.some((p) => p.github.length)) reasons.push("NO_GITHUB_LINKED_PROJECT");
      reasons.push(...invalid.map((p) => p.invalidReason).filter((v): v is ReasonCode => Boolean(v)));
    }
    if (!reasons.length) reasons.push("NO_BUCKET_FIT");
    remarks.unshift(`Not bucketed: ${s.bucketing?.noBucketReason || REASON_TEXT[reasons[0]]}`);
    if (c.stage === "TR2") {
      remarks.push(
        c.track === "PRODUCT" && !group.length
          ? "Product TR-2 hire — Product has no bucket of its own and no verified evidence fits the 6 buckets; review manually."
          : "TR-2 hire with no verified project or in-domain role for any of the 6 buckets — review manually.",
      );
    }
    if (projects.some((p) => p.tier === "C")) remarks.push("Demo-only projects count only alongside an in-domain internship / job.");
    remarks.push(...invalidNotes);
    return finish("not_bucketed");
  }

  // 4) The flagship: the agent's pick when it is valid and fits; otherwise the strongest fit.
  const own = projects.find((p) => p.projectId === s.bucketing?.flagshipId);
  const ownFits = Boolean(own?.valid && own.buckets.includes(bucket) && !repair.some((i) => i.startsWith("invariant:flagship_invalid")));
  const flagship = ownFits ? own! : bestFlagship(bucket, projects, strengths);
  const flagshipStrength = flagship ? (strengths[flagship.projectId] ?? (ownFits ? (s.bucketing?.flagshipStrength ?? 0) : 0)) : 0;

  // 5) Remarks.
  const roles = experience.filter((e) => inDomainRoles(bucket).has(e.id)).map((e) => `${e.role || "role"} at ${e.company || "company"}`);
  const by = placedBy === "tr2-track" ? `placed by the ${hireText} interview` : "placed by verified evidence";
  remarks.unshift(summaryLine(bucket, by, flagship ?? undefined, flagshipStrength, roles));
  if (placedBy === "tr2-track" && !trackBacked) {
    remarks.push(
      `${REASON_TEXT.TRACK_MISMATCH}: no verified ${BUCKET_LABEL[bucket]} project or role${agentBucket ? `; the resume backs ${BUCKET_LABEL[agentBucket]}` : ""}.`,
    );
  } else if (placedBy === "tr2-track" && agentBucket && agentBucket !== bucket) {
    remarks.push(`The resume's own strongest bucket is ${BUCKET_LABEL[agentBucket]}.`);
  }
  if (placedBy === "evidence" && c.stage === "TR2") {
    remarks.push(
      c.track === "PRODUCT" ? "Product TR-2 hire — Product has no bucket, so the verified resume evidence decides." : "Combined-interview hire (no track) — the verified resume evidence decides the bucket.",
    );
  }
  if (pending.length) remarks.push(`${pendingNote} — re-run to complete the evidence and scores.`);
  const behaviour = projects.flatMap((p) => p.repos.flatMap((rr) => rr.integrity?.flags ?? []).map((f) => `${p.projectId}: ${f}`));
  remarks.push(...behaviour.slice(0, 3), ...invalidNotes);
  return finish("bucketed", { bucket, flagshipId: flagship?.projectId ?? "", flagshipStrength, placedBy, trackBacked });
}

/** The strongest bucket domain with a score. */
function topBucket(domains: DomainScore[]): Bucket | null {
  const top = domains.filter((d) => isBucket(d.domain) && d.score > 0).sort((a, b) => b.score - a.score)[0];
  return top && isBucket(top.domain) ? top.domain : null;
}

/** Eligible buckets, strongest verified domain first. */
function rankEligible(eligible: Bucket[], domains: DomainScore[]): Bucket[] {
  return [...eligible].sort((a, b) => domainScoreFor(b, domains) - domainScoreFor(a, domains));
}

function summaryLine(bucket: Bucket, by: string, flagship: ProjectEvidence | undefined, strength: number, roles: string[]): string {
  const tier = flagship?.tier === "R" ? "described on the resume — ML / AI work, GitHub optional" : `tier ${flagship?.tier}`;
  const f = flagship
    ? `flagship ${flagship.projectId} "${flagship.title}" (${tier}, strength ${strength})`
    : roles.length
      ? "no in-bucket project — backed by in-domain experience"
      : "no verified in-bucket project or role on the resume yet";
  return `${BUCKET_LABEL[bucket]} — ${by}; ${f}${roles.length ? `; in-domain experience: ${roles.slice(0, 2).join("; ")}` : ""}.`;
}
