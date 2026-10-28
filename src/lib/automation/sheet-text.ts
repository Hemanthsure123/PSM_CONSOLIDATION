import { STATUS_LABEL, type JobProgress, type JobResult, type JobStatus, type JobStep } from "@/lib/automation/types";

/**
 * What the control row's "Automation Details" cell says (pure; tested). The job id is always
 * at the end — the sheet's Apps Script and the server find the row by it.
 */

const STEP_TEXT: Record<JobStep, string> = {
  queued: "Queued",
  planning: "Planning",
  screening: "Screening resumes",
  evaluating: "Checking GitHub and DSA",
  validating: "Validating",
  delivering: "Writing the shortlist",
  done: "Done",
};

const hhmm = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(at);

export interface DetailsInput {
  jobId: string;
  status: JobStatus;
  step: JobStep;
  progress: JobProgress;
  result: JobResult | null;
  error: string | null;
  queueAhead?: number;
  at?: Date;
}

export function detailsText(d: DetailsInput): string {
  const p = d.progress ?? {};
  const parts: string[] = [];
  if (d.status === "pending") {
    parts.push(d.queueAhead ? `Queued behind ${d.queueAhead} job${d.queueAhead === 1 ? "" : "s"}` : "Queued — starting shortly");
  } else if (d.status === "processing") {
    let line = STEP_TEXT[d.step] ?? d.step;
    if (d.step === "screening" && p.read) line += ` ${p.screened ?? 0} / ${p.read}${p.matches ? ` · ${p.matches} domain matches` : ""}`;
    if (d.step === "evaluating" && p.githubTotal) line = `GitHub ${p.githubDone ?? 0} / ${p.githubTotal}`;
    if (d.step === "evaluating" && p.reviewTotal && (p.githubDone ?? 0) >= (p.githubTotal ?? 0)) line = `Code review ${p.reviewDone ?? 0} / ${p.reviewTotal}`;
    if (p.waitingUntil) line += ` · paused until ${hhmm(new Date(p.waitingUntil))} (rate limit)`;
    if (p.note) line += ` · ${p.note}`;
    parts.push(line);
  } else if (d.status === "failed") {
    parts.push(`Failed: ${d.error ?? "unknown error"}`);
  } else if (d.result) {
    const r = d.result;
    parts.push(
      `${r.shortlisted}${r.requested ? ` of ${r.requested}` : ""} shortlisted → ${r.destinationTab} (${r.sourceTitle})`,
      `${r.read} read · ${r.scored} scored${r.notResumes ? ` · ${r.notResumes} not resumes` : ""}${r.duplicates ? ` · ${r.duplicates} duplicates merged` : ""}`,
    );
    if (d.status === "awaiting_review" && r.reviewReasons.length) parts.push(`Review: ${r.reviewReasons.join("; ")}`);
  }
  parts.push(`${hhmm(d.at ?? new Date())} IST`, `job ${d.jobId}`);
  return parts.join(" · ");
}

export const statusLabel = (s: JobStatus) => STATUS_LABEL[s];
