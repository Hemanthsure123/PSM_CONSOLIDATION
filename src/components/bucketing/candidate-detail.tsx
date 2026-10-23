"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoHint } from "@/components/ui/info-hint";
import { SERIES } from "@/components/charts";
import { BUCKET_LABEL, DOMAIN_LABEL, OVERALL_WEIGHTS, REASON_TEXT, TRACK_LABEL, VERDICT_LABEL, isBucket, type Bucket, type Tr2Verdict } from "@/lib/bucketing/config";
import type { BucketingCandidateInput, BucketingResult, DsaPlatform, InterviewRecord, Review } from "@/lib/bucketing/types";
import { cn } from "@/lib/utils";

/** Identity colour per bucket — a fixed slot each, never re-assigned by rank. */
export const BUCKET_COLOR: Record<Bucket, string> = {
  MERN: SERIES[0],
  PYTHON_FS: SERIES[1],
  JAVA_FS: SERIES[2],
  GENAI: SERIES[3],
  DSML: SERIES[4],
  DATA_ANALYTICS: SERIES[6],
};

/** A bucket's name with its colour mark (the mark carries identity, the text stays in ink). */
export function BucketBadge({ bucket, className }: { bucket: Bucket; className?: string }) {
  // A saved v1 result can still name a retired bucket (Frontend): show it plainly.
  const known = isBucket(bucket);
  return (
    <Badge variant="outline" className={className}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: known ? BUCKET_COLOR[bucket] : "currentColor" }} aria-hidden />
      {known ? BUCKET_LABEL[bucket] : String(bucket)}
    </Badge>
  );
}

const pct = (w: number) => `${Math.round(w * 100)}%`;

/** Everything behind one candidate's decision — evidence, audits, reviews and the agent trace. */
export function CandidateDetail({ r, candidate }: { r: BucketingResult; candidate?: BucketingCandidateInput }) {
  const t = r.trust;
  const scored = r.domains.filter((d) => d.score > 0);
  return (
    <div className="space-y-4 rounded-xl border bg-muted/40 p-3 text-[13px] sm:p-4">
      {/* Who, where they landed, how far to trust it */}
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-display text-[16px] font-semibold leading-6">{r.name || "Unnamed candidate"}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {r.mobile} · {r.stageLabel}
          </p>
          {candidate?.college || candidate?.email || candidate?.externalId ? (
            <p className="truncate text-xs text-muted-foreground" title={candidate.college}>
              {[candidate.college, candidate.email, candidate.externalId ? `ID ${candidate.externalId}` : ""].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r.bucket ? (
            <BucketBadge bucket={r.bucket} />
          ) : r.status === "retry_needed" ? (
            <Badge variant="warning">Re-run needed</Badge>
          ) : (
            <Badge variant="secondary">Not bucketed</Badge>
          )}
          {t.trust === null ? (
            <Badge variant="secondary">No trust score</Badge>
          ) : (
            <Badge variant={t.band === "High" ? "success" : t.band === "Medium" ? "secondary" : "destructive"} className="tabular-nums">
              Trust {t.trust} · {t.band}
            </Badge>
          )}
          {t.needsReview ? <Badge variant="warning">Needs review</Badge> : null}
        </div>
        {r.bucket ? (
          <p className="w-full text-xs text-muted-foreground">
            {/* TRACK_MISMATCH / INTERVIEW_ONLY already say how the bucket was set. */}
            {r.flags.some((c) => c === "TRACK_MISMATCH" || c === "INTERVIEW_ONLY")
              ? null
              : r.placedBy === "tr2-track"
                ? "Placed by the TR-2 interview track, and the resume backs it. "
                : r.placedBy === "evidence"
                  ? "Placed by verified resume evidence (projects / in-domain experience). "
                  : null}
            {r.flags.length ? <span className="text-warning">{r.flags.map((c) => REASON_TEXT[c]).join(" · ")}</span> : null}
          </p>
        ) : null}
      </div>

      <InterviewSection r={r} />

      {r.remarks.length ? (
        <Section title="Remarks">
          <ul className="list-disc space-y-1 pl-5">
            {r.remarks.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Trust">
          <p>
            {t.trust === null ? (
              "Not given — evidence missing, re-run this candidate."
            ) : (
              <>
                <b className="tabular-nums">{t.trust}</b> / 100 ({t.band})
              </>
            )}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <Def label="Domain" value={fmt(t.components.domain)} />
            <Def label="Bucket" value={fmt(t.components.bucket)} />
            <Def label="DSA" value={fmt(t.components.dsa)} />
            <Def label="Final checks" value={String(t.components.final)} />
          </dl>
          {t.caps.length ? <p className="mt-2 text-xs text-warning">Capped: {t.caps.join("; ")}</p> : null}
          {t.issues.length ? <p className="mt-1 text-xs text-muted-foreground">{t.issues.join(" · ")}</p> : null}
        </Section>
        <Section
          title="Scores"
          info={
            <>
              Overall = {pct(OVERALL_WEIGHTS.internal)} internal assessments + {pct(OVERALL_WEIGHTS.projects)} projects + {pct(OVERALL_WEIGHTS.experience)}{" "}
              experience + {pct(OVERALL_WEIGHTS.achievements)} achievements. Ranking puts the TR-2 strong, medium and low hire tiers first, then TR-1,
              then Assessment, and uses the overall score inside a tier.
            </>
          }
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <Def label="Overall" value={String(r.scores.overall)} strong />
            <Def label={`Internal (${pct(OVERALL_WEIGHTS.internal)})`} value={String(r.scores.internal)} />
            <Def label={`Projects (${pct(OVERALL_WEIGHTS.projects)})`} value={String(r.scores.projects)} />
            <Def label={`Experience (${pct(OVERALL_WEIGHTS.experience)})`} value={String(r.scores.experience)} />
            <Def label={`Achievements (${pct(OVERALL_WEIGHTS.achievements)})`} value={String(r.scores.achievements)} />
          </dl>
          <p className="mt-2 text-xs text-muted-foreground tabular-nums">
            Internal parts: TR-2 {fmt(r.internalParts.tr2)} · TR-1 {fmt(r.internalParts.tr1)} · Assessment {fmt(r.internalParts.assessment)} · SQL{" "}
            {fmt(r.internalParts.sql)} — flagship strength {r.scores.flagship} · bucket domain {r.scores.domain} · DSA {r.scores.dsa}
          </p>
          {r.reasonCodes.length ? (
            <p className="mt-2 text-xs text-destructive">{r.reasonCodes.map((c) => REASON_TEXT[c]).join(" · ")}</p>
          ) : null}
        </Section>
      </div>

      <Section title="Domain fit" info="Scored from projects, internships and open source only. Skills lists are ignored.">
        <div className="divide-y">
          {scored.length ? (
            scored.map((d) => (
              <div key={d.domain} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 py-1.5 first:pt-0 last:pb-0 sm:grid-cols-[160px_44px_minmax(0,1fr)]">
                <span>{DOMAIN_LABEL[d.domain]}</span>
                <span className="text-right font-medium tabular-nums">{d.score}</span>
                <span className="col-span-2 text-xs text-muted-foreground sm:col-span-1">
                  {d.evidence.map((e) => `${e.itemId}: “${e.quote.slice(0, 90)}”`).join(" · ") || d.rationale}
                </span>
              </div>
            ))
          ) : (
            <span className="text-muted-foreground">No domain scored.</span>
          )}
        </div>
      </Section>

      <Section title={`Projects (${r.projects.length})`}>
        <div className="space-y-3">
          {r.projects.length === 0 ? <span className="text-muted-foreground">No projects found on the resume.</span> : null}
          {r.projects.map((p) => {
            const e = p.evidence;
            return (
              <div key={p.id} className="rounded-lg border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {p.id} · {p.title}
                  </span>
                  {e ? <TierBadge tier={e.tier} valid={e.valid} /> : null}
                  {e ? <span className="text-xs text-muted-foreground">{e.status.replace("_", " ")}</span> : null}
                  {e?.invalidReason ? <Badge variant="destructive">{REASON_TEXT[e.invalidReason]}</Badge> : null}
                </div>
                {e?.buckets.length ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    Meets
                    {e.buckets.map((b) => (
                      <BucketBadge key={b} bucket={b} />
                    ))}
                  </div>
                ) : null}
                {p.description ? <p className="mt-1.5 text-xs text-muted-foreground">{p.description}</p> : null}
                <p className="mt-1.5 text-xs">
                  {p.claimedTech.length ? (
                    <>
                      <span className="text-muted-foreground">Stated tech:</span> {p.claimedTech.join(", ")} ·{" "}
                    </>
                  ) : null}
                  <span className="text-muted-foreground">Link:</span> {p.linkPlacement === "none" ? "none" : p.linkPlacement.replace("-", " ")}
                  {p.github.map((u) => (
                    <Ext key={u} href={u} />
                  ))}
                  {p.live.map((u) => (
                    <Ext key={u} href={u} label="demo" />
                  ))}
                </p>
                {e?.demo && e.demo.status !== "none" ? (
                  <p className="mt-1 text-xs">
                    <span className="text-muted-foreground">Demo:</span> {e.demo.status}
                    {e.demo.title ? ` — “${e.demo.title}”` : ""}
                    {e.demo.note ? ` (${e.demo.note})` : ""}
                  </p>
                ) : null}
                {e?.repos.map((repo) => (
                  <div key={repo.url} className="mt-2 space-y-0.5 border-l-2 pl-2.5 text-xs">
                    <div>
                      <a href={repo.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                        {repo.owner}/{repo.repo}
                      </a>{" "}
                      — {repo.status}: {repo.message}
                      {repo.resolvedFromProfile ? " (matched from a profile link)" : ""}
                    </div>
                    {repo.techs.length ? <div className="text-muted-foreground">Code proves: {repo.techs.map((x) => x.label).join(", ")}</div> : null}
                    {repo.integrity ? (
                      <div className="text-muted-foreground tabular-nums">
                        Commits audited {repo.integrity.audited} · by the candidate {repo.integrity.candidateCommits} · foreign {repo.integrity.foreignCount} · AI-tool{" "}
                        {repo.integrity.aiCount}
                        {repo.integrity.exempt ? ` · exempt (merges / bots) ${repo.integrity.exempt}` : ""}
                      </div>
                    ) : null}
                    {[...(repo.integrity?.ai ?? []), ...(repo.integrity?.foreign ?? [])].slice(0, 3).map((o) => (
                      <div key={o.sha} className="break-words text-destructive">
                        {o.sha} · {o.author} · {o.signature}
                      </div>
                    ))}
                    {repo.traceFiles.length ? <div className="break-words text-destructive">AI-tool files: {repo.traceFiles.join("; ")}</div> : null}
                    {repo.integrity?.flags.map((f) => (
                      <div key={f} className="text-warning">
                        {f}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Experience">
          {r.experience.length ? (
            <ul className="space-y-1.5">
              {r.experience.map((e) => (
                <li key={e.id}>
                  <span className="font-medium">{e.id}</span> {e.role || "—"} at {e.company || "—"}{" "}
                  <span className="text-muted-foreground">
                    ({e.kind}
                    {e.months !== null ? `, ${e.months} months` : e.duration ? `, ${e.duration}` : ""})
                  </span>
                  {e.tech.length ? <div className="text-xs text-muted-foreground">{e.tech.join(", ")}</div> : null}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">None on the resume.</span>
          )}
          {r.openSource.length ? (
            <div className="mt-3">
              <p className="font-medium">Open source</p>
              {r.openSource.map((o) => (
                <div key={o.id} className="text-xs">
                  {o.title} — {o.evidence.map((ev) => `${ev.status}${ev.note ? ` (${ev.note})` : ""}`).join("; ") || "not checked"}
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-3">
            <p className="font-medium">Achievements</p>
            {r.achievements?.length ? (
              <ul className="space-y-0.5 text-xs">
                {r.achievements.map((a) => (
                  <li key={a.id}>
                    {a.title} <span className="text-muted-foreground">({a.kind})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-muted-foreground">None on the resume.</span>
            )}
          </div>
        </Section>
        <Section title={`DSA · score ${r.dsa.score}`} info="Platforms weigh in this order: Codeforces, then CodeChef, then LeetCode.">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="pb-1 text-left font-medium">Platform</th>
                <th className="pb-1 text-right font-medium">Solved</th>
                <th className="pb-1 text-right font-medium">Contests</th>
                <th className="pb-1 text-right font-medium">Rating</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <Platform label="Codeforces" p={r.dsa.platforms.codeforces} />
              <Platform label="CodeChef" p={r.dsa.platforms.codechef} />
              <Platform label="LeetCode" p={r.dsa.platforms.leetcode} />
            </tbody>
          </table>
          {r.dsa.flags.map((f) => (
            <p key={f} className="mt-1 text-xs text-warning">
              {f}
            </p>
          ))}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ReviewBox title="Domain verifier" review={r.reviews.domain} />
        <ReviewBox title="Bucket verifier" review={r.reviews.bucket} />
        <ReviewBox title="DSA verifier" review={r.reviews.dsa} />
      </div>

      <details className="group rounded-lg border bg-card px-4 py-3">
        <summary className="cursor-pointer rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25">
          Agent trace · resume ({r.resume.source || "—"}
          {r.resume.transcribed ? ", transcribed" : ""}) · {r.documentUrls.length} link(s) in the resume · {Math.round(r.durationMs / 1000)}s
        </summary>
        <div className="mt-3 space-y-1 text-xs">
          {r.trace.map((s, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_48px] gap-x-2 sm:grid-cols-[140px_48px_minmax(0,1fr)]">
              <span className="truncate font-mono" title={s.node}>
                {s.node}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">{(s.ms / 1000).toFixed(1)}s</span>
              <span className="col-span-2 sm:col-span-1">{s.decision}</span>
            </div>
          ))}
          {r.documentUrls.length ? <p className="break-words pt-1 text-muted-foreground">Links in the resume: {r.documentUrls.join(" · ")}</p> : null}
          {r.extractionDropped.length ? <p className="text-muted-foreground">Dropped by grounding: {r.extractionDropped.join(" · ")}</p> : null}
          {r.errors.length ? <p className="text-destructive">Errors: {r.errors.join(" · ")}</p> : null}
          <p className="text-muted-foreground">
            Models: {r.models.join(", ") || "—"} · prompt {r.promptVersion} · {new Date(r.evaluatedAt).toLocaleString("en-IN")}
          </p>
        </div>
      </details>
    </div>
  );
}

const fmt = (v: number | null) => (v === null ? "—" : String(v));

function Section({ title, info, children }: { title: string; info?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border bg-card px-4 py-3">
      <h4 className="mb-2 flex items-center gap-1 text-[13px] font-semibold">
        {title}
        {info ? <InfoHint align="start">{info}</InfoHint> : null}
      </h4>
      {children}
    </section>
  );
}

function Def({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", strong ? "text-[15px] font-semibold" : "font-medium")}>{value}</dd>
    </div>
  );
}

function Ext({ href, label }: { href: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 break-all text-primary hover:underline">
      {label ?? href.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)} <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

const TIER_TITLE: Record<string, string> = {
  A: "Verified GitHub + live demo",
  B: "Verified GitHub",
  C: "Demo only — counts with an in-domain internship / job",
  R: "ML / AI project described on the resume — GitHub optional for DS / ML and GenAI",
  D: "No link — not evidence",
};

export function TierBadge({ tier, valid }: { tier: string; valid: boolean }) {
  if (!valid) {
    return (
      <Badge variant="outline" className="whitespace-nowrap" title={TIER_TITLE[tier]}>
        Tier {tier}
      </Badge>
    );
  }
  return (
    <Badge variant={tier === "A" || tier === "B" ? "success" : "secondary"} className="whitespace-nowrap" title={TIER_TITLE[tier]}>
      Tier {tier}
    </Badge>
  );
}

const VERDICT_VARIANT: Record<Tr2Verdict, "success" | "default" | "secondary"> = { STRONG_HIRE: "success", MEDIUM_HIRE: "default", LOW_HIRE: "secondary" };

/** The internal assessments — the strongest signal, shown first. */
function InterviewSection({ r }: { r: BucketingResult }) {
  const iv: InterviewRecord | null = r.interview;
  if (!iv) {
    return (
      <Section title="Internal assessments">
        <span className="text-muted-foreground">No interview scores in the sheet — stage only: {r.stageLabel}.</span>
      </Section>
    );
  }
  const t = iv.tr1;
  const a = iv.assessment;
  const d = iv.dsaInterview;
  const anyTr1 = Boolean(t.status) || [t.selfIntro, t.dsaOverall, t.problemSolving, t.coding, t.communication, t.debugging, t.overallTechnical].some((v) => v !== null);
  const pending = iv.tr2Pending ?? [];
  const drive = [
    iv.currentStage ? `Current stage: ${iv.currentStage.replace(/_/g, " ")}` : "",
    iv.interviewPath ? `${iv.interviewPath} interview path` : "",
  ].filter(Boolean);
  return (
    <Section
      title="Internal assessments"
      info="From the interview export. TR-2 hire verdicts set the priority tier, and a hire in a track places the candidate in that track's bucket."
    >
      {iv.journey?.status === "closed" ? (
        <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
          Journey closed{iv.journey.reason ? ` — ${iv.journey.reason.replace(/_/g, " ")}` : ""}
          {iv.journey.notes ? `: ${iv.journey.notes}` : ""}
        </p>
      ) : null}
      {drive.length ? <p className="mb-2 text-xs text-muted-foreground">{drive.join(" · ")}</p> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">TR-2</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {iv.tr2.map((x) => (
              <Badge key={x.track} variant={VERDICT_VARIANT[x.verdict]}>
                {TRACK_LABEL[x.track]} · {VERDICT_LABEL[x.verdict]}
              </Badge>
            ))}
            {iv.combined ? <Badge variant={VERDICT_VARIANT[iv.combined]}>Combined interview · {VERDICT_LABEL[iv.combined]}</Badge> : null}
            {iv.combinedRejected ? (
              <Badge variant="outline" className="font-normal">
                Combined interview · Rejected
              </Badge>
            ) : null}
            {iv.combinedState === "pending" ? (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                Combined interview · Pending
              </Badge>
            ) : null}
            {iv.tr2Rejected.map((x) => (
              <Badge key={x} variant="outline" className="font-normal">
                {TRACK_LABEL[x]} · Rejected
              </Badge>
            ))}
            {pending.map((x) => (
              <Badge key={x} variant="outline" className="font-normal text-muted-foreground">
                {TRACK_LABEL[x]} · Assigned
              </Badge>
            ))}
            {!iv.tr2.length && !iv.combined && !iv.combinedRejected && iv.combinedState !== "pending" && !iv.tr2Rejected.length && !pending.length ? (
              <span className="text-muted-foreground">Not taken</span>
            ) : null}
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">
            TR-1{t.status ? ` · ${t.status}` : d?.qualifying ? ` · ${d.qualifying === "shortlisted" ? "cleared" : "not cleared"}` : ""}
          </p>
          {d && (d.qualifying || d.dsaScore !== null || d.csScore !== null) ? (
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {[
                `DSA interview: ${d.qualifying || "taken"}`,
                d.dsaScore !== null ? `DSA ${d.dsaScore}/120` : "",
                d.csScore !== null ? `CS ${d.csScore}/40` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {anyTr1 ? (
            <dl className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1">
              <Def label="Technical /100" value={fmt(t.overallTechnical)} strong />
              <Def label="DSA /10" value={fmt(t.dsaOverall)} />
              <Def label="Problem solving" value={fmt(t.problemSolving)} />
              <Def label="Coding" value={fmt(t.coding)} />
              <Def label="Debugging" value={fmt(t.debugging)} />
              <Def label="Communication" value={fmt(t.communication)} />
              <Def label="Self intro" value={fmt(t.selfIntro)} />
            </dl>
          ) : d?.qualifying ? null : (
            <span className="text-muted-foreground">Not taken</span>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">Assessment</p>
          <dl className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1">
            <Def label="Overall /160" value={fmt(a.offlineOverall)} strong />
            <Def label="DSA coding /120" value={fmt(a.dsaCoding)} />
            <Def label="CS /40" value={fmt(a.csFundamentals)} />
            <Def label="SQL MCQ /15" value={fmt(a.sqlMcq)} />
            <Def label="SQL coding /15" value={fmt(a.sqlCoding)} />
          </dl>
        </div>
      </div>
    </Section>
  );
}

function Platform({ label, p }: { label: string; p: DsaPlatform }) {
  if (!p.url) {
    return (
      <tr>
        <td className="py-1.5">{label}</td>
        <td colSpan={3} className="py-1.5 text-right text-muted-foreground">
          No profile
        </td>
      </tr>
    );
  }
  const num = (v: number | null) => (v === null ? <span className="text-muted-foreground">N/A</span> : v);
  return (
    <tr>
      <td className="py-1.5">
        <a href={p.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
          {label}
        </a>
        {p.ratingIgnored ? <div className="text-muted-foreground">Rating ignored — no rated contest</div> : null}
      </td>
      {p.found === false ? (
        <td colSpan={3} className="py-1.5 text-right text-muted-foreground">
          Profile not found
        </td>
      ) : (
        <>
          <td className="py-1.5 text-right tabular-nums">{num(p.solved)}</td>
          <td className="py-1.5 text-right tabular-nums">{num(p.contests)}</td>
          <td className="py-1.5 text-right tabular-nums">{p.rating !== null ? p.rating : <span className="text-muted-foreground">—</span>}</td>
        </>
      )}
    </tr>
  );
}

function ReviewBox({ title, review }: { title: string; review: Review | null }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold">{title}</span>
        {review ? (
          <>
            <Badge variant={review.verdict === "pass" ? "success" : review.verdict === "revise" ? "warning" : "destructive"}>{review.verdict}</Badge>
            <span className="tabular-nums text-muted-foreground">trust {review.trust}</span>
          </>
        ) : (
          <span className="text-muted-foreground">did not run</span>
        )}
      </div>
      {review?.issues.length ? <div className="mt-1.5 text-muted-foreground">{review.issues.join(" · ")}</div> : null}
    </div>
  );
}
