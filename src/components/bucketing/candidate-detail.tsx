"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoHint } from "@/components/ui/info-hint";
import { SERIES } from "@/components/charts";
import { BUCKET_LABEL, DOMAIN_LABEL, REASON_TEXT, type Bucket } from "@/lib/bucketing/config";
import type { BucketingResult, DsaPlatform, Review } from "@/lib/bucketing/types";
import { cn } from "@/lib/utils";

/** Identity colour per bucket — a fixed slot each, never re-assigned by rank. */
export const BUCKET_COLOR: Record<Bucket, string> = {
  MERN: SERIES[0],
  PYTHON_FS: SERIES[1],
  JAVA_FS: SERIES[2],
  GENAI: SERIES[3],
  FRONTEND: SERIES[4],
};

/** A bucket's name with its colour mark (the mark carries identity, the text stays in ink). */
export function BucketBadge({ bucket, className }: { bucket: Bucket; className?: string }) {
  return (
    <Badge variant="outline" className={className}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: BUCKET_COLOR[bucket] }} aria-hidden />
      {BUCKET_LABEL[bucket]}
    </Badge>
  );
}

/** Everything behind one candidate's decision — evidence, audits, reviews and the agent trace. */
export function CandidateDetail({ r }: { r: BucketingResult }) {
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
      </div>

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
          info="Overall = 40% bucket domain + 25% validation + 20% flagship + 15% DSA."
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
            <Def label="Overall" value={String(r.scores.overall)} strong />
            <Def label="Domain (40%)" value={String(r.scores.domain)} />
            <Def label="Validation (25%)" value={String(r.scores.validation)} />
            <Def label="Flagship (20%)" value={String(r.scores.flagship)} />
            <Def label="DSA (15%)" value={String(r.scores.dsa)} />
          </dl>
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

export function TierBadge({ tier, valid }: { tier: string; valid: boolean }) {
  if (!valid) return <Badge variant="outline" className="whitespace-nowrap">Tier {tier}</Badge>;
  return (
    <Badge variant={tier === "A" || tier === "B" ? "success" : "secondary"} className="whitespace-nowrap">
      Tier {tier}
    </Badge>
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
