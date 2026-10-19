import "server-only";
import {
  BUCKET_LABEL,
  REASON_TEXT,
  STAGE_TIER,
  TRACK_BUCKET,
  TRACK_LABEL,
  stageLabel,
  type Bucket,
  type ReasonCode,
} from "@/lib/bucketing/config";
import { roleBuckets } from "@/lib/bucketing/nodes/bucketing-agent";
import { bestFlagship } from "@/lib/bucketing/nodes/bucket-verifier";
import { traceEntry } from "@/lib/bucketing/nodes/shared";
import { domainScoreFor, overallScore, validationScore } from "@/lib/bucketing/scoring";
import type { BucketingStatus, FinalDecision, ProjectEvidence, Scores } from "@/lib/bucketing/types";
import type { State, Update } from "@/lib/bucketing/state";

/**
 * Agent 7 — stage arbiter (the main bucketing agent; deterministic). Applies the
 * interview stage on top of the verified evidence:
 *  - a resume is validated only with ≥ 1 Tier A/B project; otherwise no bucket,
 *    with the reasons;
 *  - TR-2 in MERN / Python FS / Java FS / GenAI: that track's bucket wins when a
 *    valid project or a verified internship backs it; otherwise the resume's
 *    bucket stays and TRACK_MISMATCH is flagged;
 *  - TR-2 in AI-ML / Data Analytics: the resume's bucket, or NO_BUCKET_FIT;
 *  - missing evidence (GitHub down, a failed agent) is "retry_needed", never a
 *    rejection.
 * On a second pass it applies the final verifier's repair instructions.
 */

export function stageArbiterNode(s: State): Update {
  const t0 = Date.now();
  const c = s.input;
  const attempt = (s.attempts.stage_arbiter ?? 0) + 1;
  const repair = attempt > 1 ? (s.finalReview?.issues ?? []) : [];
  const label = stageLabel(c.stage, c.track);
  const dsaScore = s.dsa?.score ?? 0;
  const remarks: string[] = [];
  const reasons: ReasonCode[] = [];
  const flags: ReasonCode[] = [];

  const finish = (
    status: BucketingStatus,
    rest: Partial<FinalDecision> & { scores?: Scores } = {},
  ): Update => {
    const final: FinalDecision = {
      status,
      bucket: null,
      stageLabel: label,
      priorityTier: STAGE_TIER[c.stage],
      validated: false,
      reasonCodes: Array.from(new Set(reasons)),
      flags: Array.from(new Set(flags)),
      flagshipId: "",
      scores: { overall: 0, validation: 0, domain: 0, flagship: 0, dsa: dsaScore },
      remarks,
      trackBacked: null,
      attempt,
      ...rest,
    };
    return {
      final,
      attempts: { stage_arbiter: attempt },
      ...traceEntry(
        "stage_arbiter",
        t0,
        `${label}: ${status}${final.bucket ? ` → ${final.bucket}` : ""}${final.reasonCodes.length ? ` [${final.reasonCodes.join(", ")}]` : ""}${final.flags.length ? ` flags ${final.flags.join(", ")}` : ""}${attempt > 1 ? " (repair pass)" : ""}`,
      ),
    };
  };

  // 1) The resume itself.
  const r = s.resume;
  if (!r || r.status === "error") {
    reasons.push("PIPELINE_ERROR");
    remarks.push(r?.note || "The resume step did not finish — re-run.");
    return finish("retry_needed");
  }
  if (r.status === "not_resume") {
    reasons.push("NOT_A_RESUME");
    remarks.push(r.note);
    return finish("not_bucketed");
  }
  if (r.status === "unreadable") {
    reasons.push("RESUME_UNREADABLE");
    remarks.push(r.note);
    return finish("not_bucketed");
  }

  const x = s.extraction!;
  const pe = s.projectEvidence;
  if (!pe) {
    reasons.push("PIPELINE_ERROR");
    remarks.push("Project verification did not finish — re-run.");
    return finish("retry_needed");
  }
  const projects = pe.projects;
  const ab = projects.filter((p) => p.valid && (p.tier === "A" || p.tier === "B"));
  const invalid = projects.filter((p) => p.status === "invalid");
  for (const p of invalid) {
    remarks.push(`${p.projectId} "${p.title}": ${REASON_TEXT[p.invalidReason ?? "REPO_NOT_FOUND_OR_PRIVATE"]} — ${p.note.slice(0, 220)}`);
  }

  // 2) Missing evidence is never a rejection.
  if (pe.unavailable) {
    reasons.push("GITHUB_UNAVAILABLE");
    remarks.unshift("GitHub could not be checked for every project (rate limit / outage) — re-run this candidate.");
    return finish("retry_needed", { validated: ab.length > 0 });
  }

  // 3) Validation gate: ≥ 1 Tier A/B project.
  if (!ab.length) {
    if (!x.projects.length) reasons.push("NO_PROJECTS");
    else if (!x.projects.some((p) => p.github.length)) reasons.push("NO_GITHUB_LINKED_PROJECT");
    else {
      const codes = invalid.map((p) => p.invalidReason).filter((v): v is ReasonCode => Boolean(v));
      reasons.push(...(codes.length ? codes : (["INSUFFICIENT_EVIDENCE"] as ReasonCode[])));
    }
    if (projects.some((p) => p.tier === "C")) remarks.push("Demo-only projects can support a bucket but can't validate a resume.");
    remarks.unshift(`Not validated: no project has a verified GitHub repository.`);
    return finish("not_bucketed");
  }

  // 4) The agents must have finished.
  if (!s.domainAnalysis || s.domainAnalysis.error || !s.bucketing || s.bucketing.error) {
    reasons.push("PIPELINE_ERROR");
    remarks.unshift(
      `An agent failed (${s.domainAnalysis?.error ? "domain analysis" : "bucketing"}: ${(s.domainAnalysis?.error || s.bucketing?.error || "no output").slice(0, 160)}) — re-run.`,
    );
    return finish("retry_needed", { validated: true });
  }

  const domains = s.domainReview?.adjusted?.length ? s.domainReview.adjusted : s.domainAnalysis.domains;
  const strengths = s.bucketing.projectStrengths;
  let bucket: Bucket | null = s.bucketing.bucket;
  let flagshipId = s.bucketing.flagshipId;
  let flagshipStrength = s.bucketing.flagshipStrength;
  let trackBacked: boolean | null = null;

  // 5) The TR-2 track.
  if (c.stage === "TR2" && !c.track) {
    remarks.push("TR-2 track not given — the bucket comes from the resume; add the track (MERN / Python FS / Java FS / GenAI / AI-ML / DA) and re-run to apply the TR-2 rule.");
  }
  if (c.stage === "TR2" && c.track) {
    const tb = TRACK_BUCKET[c.track];
    if (tb) {
      const projBacked = projects.filter((p) => p.valid && p.buckets.includes(tb));
      const roleBacked = x.experience.filter((e) => roleBuckets(e).includes(tb));
      trackBacked = projBacked.length > 0 || roleBacked.length > 0;
      if (trackBacked) {
        if (bucket !== tb) remarks.push(`Placed by the ${TRACK_LABEL[c.track]} TR-2 track; the resume's own strongest bucket was ${bucket ? BUCKET_LABEL[bucket] : "none"}.`);
        bucket = tb;
        const f = bestFlagship(tb, projects, strengths);
        if (f) {
          if (f.projectId !== flagshipId) {
            flagshipId = f.projectId;
            flagshipStrength = strengths[f.projectId] ?? flagshipStrength;
          }
        } else {
          // Backed by an internship only: the best valid project anchors the strength score.
          const anchor = [...ab].sort((a, b) => (strengths[b.projectId] ?? 0) - (strengths[a.projectId] ?? 0))[0];
          flagshipId = "";
          flagshipStrength = anchor ? (strengths[anchor.projectId] ?? 0) : 0;
          remarks.push(`${BUCKET_LABEL[tb]} rests on internship ${roleBacked.map((e) => e.id).join(", ")} — no ${BUCKET_LABEL[tb]} project in the code.`);
        }
      } else {
        flags.push("TRACK_MISMATCH");
        remarks.push(
          `${TRACK_LABEL[c.track]} TR-2 cleared, but no verified project or internship shows ${BUCKET_LABEL[tb]} — the bucket comes from the resume.`,
        );
      }
    } else if (!bucket) {
      reasons.push("NO_BUCKET_FIT");
      remarks.unshift(`${TRACK_LABEL[c.track]} TR-2 cleared; no verified project fits the 5 buckets.`);
    }
  }

  // 6) Repairs requested by the final verifier.
  if (repair.some((i) => i.startsWith("invariant:flagship_invalid"))) {
    const f = bucket ? bestFlagship(bucket, projects, strengths) : null;
    flagshipId = f?.projectId ?? "";
    flagshipStrength = f ? (strengths[f.projectId] ?? 0) : 0;
  }
  if (repair.some((i) => i.startsWith("invariant:bucket_unbacked"))) {
    remarks.push(`Bucket ${bucket ?? "—"} removed: no verified evidence backs it.`);
    bucket = null;
  }

  if (!bucket) {
    if (!reasons.length) reasons.push("NO_BUCKET_FIT");
    if (s.bucketing.noBucketReason) remarks.push(s.bucketing.noBucketReason);
    return finish("not_bucketed", { validated: true, trackBacked, scores: { overall: 0, validation: 0, domain: 0, flagship: 0, dsa: dsaScore } });
  }

  // 7) Scores.
  const domainEvidence = new Set(domains.find((d) => d.domain === bucket)?.evidence.map((e) => e.itemId) ?? []);
  const inDomain = new Set([
    ...x.experience.filter((e) => domainEvidence.has(e.id) || roleBuckets(e).includes(bucket!)).map((e) => e.id),
  ]);
  const scores: Scores = { overall: 0, validation: validationScore(projects, x.experience, pe.oss, inDomain), domain: domainScoreFor(bucket, domains), flagship: flagshipStrength, dsa: dsaScore };
  scores.overall = overallScore(scores);

  const flagship = projects.find((p) => p.projectId === flagshipId);
  remarks.unshift(summaryLine(bucket, flagship, flagshipStrength, x.experience.filter((e) => inDomain.has(e.id)).map((e) => `${e.role} at ${e.company}`)));
  const behaviour = projects.flatMap((p) => p.repos.flatMap((rr) => rr.integrity?.flags ?? []).map((f) => `${p.projectId}: ${f}`));
  remarks.push(...behaviour.slice(0, 3));
  return finish("bucketed", { bucket, validated: true, flagshipId, trackBacked, scores });
}

function summaryLine(bucket: Bucket, flagship: ProjectEvidence | undefined, strength: number, roles: string[]): string {
  const f = flagship ? `flagship ${flagship.projectId} "${flagship.title}" (tier ${flagship.tier}, strength ${strength})` : "no in-bucket flagship project";
  return `${BUCKET_LABEL[bucket]} — ${f}${roles.length ? `; in-domain experience: ${roles.slice(0, 2).join("; ")}` : ""}.`;
}
