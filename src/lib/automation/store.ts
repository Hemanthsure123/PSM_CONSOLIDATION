import "server-only";
import { createHash } from "node:crypto";
import { query, transaction } from "@/lib/db/client";
import type { InternalStanding } from "@/lib/pool/types";
import type { DomainCandidate, DomainCandidateRow } from "@/lib/types";
import type { AutomationPlan, ControlRequest, JobProgress, JobResult, JobStatus, JobStep } from "@/lib/automation/types";

/**
 * The automation's durable state (schema `automation`, db/migrations/003_automation.sql):
 * jobs with a lease, the trigger requests, an event log, and per-candidate checkpoints.
 * Every write is a single statement or one transaction, so it works through Supabase's
 * transaction pooler.
 */

export interface JobRow {
  id: string;
  spreadsheetId: string;
  controlTab: string;
  controlRow: number;
  instructions: string;
  inputsHash: string;
  internalSheetUrl: string;
  profilesRequired: string;
  companyName: string;
  status: JobStatus;
  step: JobStep;
  progress: JobProgress;
  plan: AutomationPlan | null;
  result: JobResult | null;
  error: string | null;
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  runDate: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

type Raw = Record<string, unknown>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

function toJob(r: Raw): JobRow {
  return {
    id: String(r.id),
    spreadsheetId: String(r.spreadsheet_id),
    controlTab: String(r.control_tab),
    controlRow: Number(r.control_row),
    instructions: String(r.instructions ?? ""),
    inputsHash: String(r.inputs_hash ?? ""),
    internalSheetUrl: String(r.internal_sheet_url ?? ""),
    profilesRequired: String(r.profiles_required ?? ""),
    companyName: String(r.company_name ?? ""),
    status: r.status as JobStatus,
    step: r.step as JobStep,
    progress: (r.progress ?? {}) as JobProgress,
    plan: (r.plan ?? null) as AutomationPlan | null,
    result: (r.result ?? null) as JobResult | null,
    error: (r.error as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseUntil: iso(r.lease_until),
    runDate: r.run_date ? (r.run_date instanceof Date ? isoDay(r.run_date) : String(r.run_date).slice(0, 10)) : null,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    updatedAt: iso(r.updated_at)!,
  };
}

/** A pg `date` comes back as a local-midnight Date — read its calendar day, not UTC's. */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const inputsHash = (req: Pick<ControlRequest, "instructions" | "internalSheetUrl" | "profilesRequired">) =>
  createHash("sha256").update([req.instructions.trim(), req.internalSheetUrl.trim(), req.profilesRequired.trim()].join("\u0000")).digest("hex").slice(0, 32);

export type CreateOutcome =
  | { kind: "existing"; job: JobRow }
  | { kind: "created"; job: JobRow }
  | { kind: "resumed"; job: JobRow }
  | { kind: "busy"; job: JobRow };

/** Days a failed job can be resumed (instead of started over) by a new "start" with the same inputs. */
const RESUME_WINDOW_DAYS = 14;

/**
 * Record a trigger. The same request id always maps to the same job; a row with a job still
 * running is "busy"; a failed job with identical inputs is resumed from its checkpoint;
 * otherwise a new job is created.
 */
export async function createOrResumeJob(req: ControlRequest, requestId: string): Promise<CreateOutcome> {
  const hash = inputsHash(req);
  try {
    return await transaction(async (tx) => {
      const seen = await tx.query(`select j.* from automation.job_requests r join automation.jobs j on j.id = r.job_id where r.request_id = $1`, [requestId]);
      if (seen.rows[0]) return { kind: "existing" as const, job: toJob(seen.rows[0]) };
      const active = await tx.query(
        `select * from automation.jobs where spreadsheet_id = $1 and control_tab = $2 and control_row = $3 and status in ('pending', 'processing') limit 1`,
        [req.spreadsheetId, req.sheetName, req.row],
      );
      if (active.rows[0]) return { kind: "busy" as const, job: toJob(active.rows[0]) };
      const failed = await tx.query(
        `select * from automation.jobs
          where spreadsheet_id = $1 and control_tab = $2 and control_row = $3 and inputs_hash = $4
            and status = 'failed' and step <> 'queued' and created_at > now() - make_interval(days => $5)
          order by created_at desc limit 1`,
        [req.spreadsheetId, req.sheetName, req.row, hash, RESUME_WINDOW_DAYS],
      );
      if (failed.rows[0]) {
        const id = String(failed.rows[0].id);
        const r = await tx.query(
          `update automation.jobs set status = 'pending', error = null, attempts = 0, lease_owner = null, lease_until = null,
                  finished_at = null, updated_at = now() where id = $1 returning *`,
          [id],
        );
        await tx.query(`insert into automation.job_requests (request_id, job_id) values ($1, $2)`, [requestId, id]);
        await tx.query(`insert into automation.job_events (job_id, step, level, message) values ($1, 'queued', 'info', $2)`, [
          id,
          "Started again with the same inputs — continuing from the last checkpoint.",
        ]);
        return { kind: "resumed" as const, job: toJob(r.rows[0]) };
      }
      const r = await tx.query(
        `insert into automation.jobs (spreadsheet_id, control_tab, control_row, instructions, inputs_hash, internal_sheet_url, profiles_required, company_name)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [req.spreadsheetId, req.sheetName, req.row, req.instructions, hash, req.internalSheetUrl, req.profilesRequired, req.companyName],
      );
      const job = toJob(r.rows[0]);
      await tx.query(`insert into automation.job_requests (request_id, job_id) values ($1, $2)`, [requestId, job.id]);
      await tx.query(`insert into automation.job_events (job_id, step, level, message) values ($1, 'queued', 'info', $2)`, [
        job.id,
        `Triggered from ${req.sheetName} row ${req.row}.`,
      ]);
      return { kind: "created" as const, job };
    });
  } catch (err) {
    // Two triggers for the same row at the same moment: the unique index lets one through.
    if ((err as { code?: string }).code === "23505") {
      const again = await query(`select j.* from automation.job_requests r join automation.jobs j on j.id = r.job_id where r.request_id = $1`, [requestId]);
      if (again[0]) return { kind: "existing", job: toJob(again[0]) };
      const active = await query(
        `select * from automation.jobs where spreadsheet_id = $1 and control_tab = $2 and control_row = $3 and status in ('pending', 'processing') limit 1`,
        [req.spreadsheetId, req.sheetName, req.row],
      );
      if (active[0]) return { kind: "busy", job: toJob(active[0]) };
    }
    throw err;
  }
}

/** How long a worker owns a job without a heartbeat before another may take it over. */
export const LEASE_MS = 180_000;

/**
 * Take the oldest job that is waiting or whose worker went silent (lease expired). One
 * statement with SKIP LOCKED: two workers never get the same job.
 */
export async function claimJob(owner: string): Promise<JobRow | null> {
  const rows = await query(
    `update automation.jobs j
        set status = 'processing', lease_owner = $1, lease_until = now() + make_interval(secs => $2),
            attempts = j.attempts + 1, started_at = coalesce(j.started_at, now()),
            run_date = coalesce(j.run_date, (now() at time zone 'Asia/Kolkata')::date), updated_at = now()
      where j.id = (select id from automation.jobs
                     where status in ('pending', 'processing') and (lease_until is null or lease_until < now())
                     order by created_at limit 1 for update skip locked)
      returning *`,
    [owner, LEASE_MS / 1000],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** Extend the lease (and save progress). False = the lease was lost: stop working on the job. */
export async function heartbeat(jobId: string, owner: string, patch: { step?: JobStep; progress?: JobProgress } = {}): Promise<boolean> {
  const rows = await query(
    `update automation.jobs set lease_until = now() + make_interval(secs => $3), updated_at = now(),
            step = coalesce($4, step), progress = coalesce($5::jsonb, progress)
      where id = $1 and lease_owner = $2 and status = 'processing' returning id`,
    [jobId, owner, LEASE_MS / 1000, patch.step ?? null, patch.progress ? JSON.stringify(patch.progress) : null],
  );
  return rows.length > 0;
}

export async function savePlan(jobId: string, owner: string, plan: AutomationPlan): Promise<boolean> {
  const rows = await query(`update automation.jobs set plan = $3::jsonb, updated_at = now() where id = $1 and lease_owner = $2 returning id`, [
    jobId,
    owner,
    JSON.stringify(plan),
  ]);
  return rows.length > 0;
}

export async function saveResult(jobId: string, owner: string, result: JobResult): Promise<boolean> {
  const rows = await query(`update automation.jobs set result = $3::jsonb, updated_at = now() where id = $1 and lease_owner = $2 returning id`, [
    jobId,
    owner,
    JSON.stringify(result),
  ]);
  return rows.length > 0;
}

/** End the job (completed / awaiting_review / failed) and drop the lease. */
export async function finishJob(jobId: string, owner: string, status: Exclude<JobStatus, "pending" | "processing">, error: string | null): Promise<JobRow | null> {
  const rows = await query(
    `update automation.jobs set status = $3::automation.job_status, error = $4,
            step = case when $3::automation.job_status = 'failed' then step else 'done' end,
            finished_at = now(), lease_owner = null, lease_until = null, updated_at = now()
      where id = $1 and lease_owner = $2 returning *`,
    [jobId, owner, status, error],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** Give the job back after a passing failure; it is taken again after `delayMs`. */
export async function releaseForRetry(jobId: string, owner: string, delayMs: number, error: string): Promise<void> {
  await query(
    `update automation.jobs set lease_owner = null, lease_until = now() + make_interval(secs => $3), error = $4, updated_at = now()
      where id = $1 and lease_owner = $2`,
    [jobId, owner, Math.round(delayMs / 1000), error],
  );
}

export async function getJob(id: string): Promise<JobRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await query(`select * from automation.jobs where id = $1`, [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function listJobs(limit = 20): Promise<JobRow[]> {
  return (await query(`select * from automation.jobs order by created_at desc limit $1`, [Math.min(Math.max(limit, 1), 100)])).map(toJob);
}

/** Jobs waiting in line ahead of this one. */
export async function queuePosition(job: JobRow): Promise<number> {
  const rows = await query<{ n: string }>(
    `select count(*) n from automation.jobs where status in ('pending', 'processing') and created_at < $1 and id <> $2`,
    [job.createdAt, job.id],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function logEvent(jobId: string, step: JobStep | string, level: "info" | "warn" | "error", message: string): Promise<void> {
  await query(`insert into automation.job_events (job_id, step, level, message) values ($1, $2, $3, $4)`, [jobId, step, level, message.slice(0, 2_000)]).catch(
    (err) => console.warn("[automation] event log failed:", err instanceof Error ? err.message : err),
  );
}

export async function jobEvents(jobId: string, limit = 200): Promise<{ at: string; step: string; level: string; message: string }[]> {
  const rows = await query(`select at, step, level, message from automation.job_events where job_id = $1 order by id desc limit $2`, [jobId, limit]);
  return rows.map((r) => ({ at: iso(r.at)!, step: String(r.step), level: String(r.level), message: String(r.message) })).reverse();
}

// ── Candidates (checkpoints) ─────────────────────────────────────────────────

export interface CandidateCheckpoint {
  key: string;
  ord: number;
  sourceTab: string;
  sourceRow: number;
  row: DomainCandidateRow;
  internal: InternalStanding | null;
  state: "pending" | "screened" | "invalid" | "error" | "duplicate";
  candidate: DomainCandidate | null;
  githubState: "none" | "pending" | "done";
  reviewState: "none" | "pending" | "done";
  error: string | null;
  retryable: boolean;
  attempts: number;
  nextTryAt: string | null;
  duplicateOf: string | null;
}

function toCandidate(r: Raw): CandidateCheckpoint {
  return {
    key: String(r.key),
    ord: Number(r.ord),
    sourceTab: String(r.source_tab),
    sourceRow: Number(r.source_row),
    row: r.row_data as DomainCandidateRow,
    internal: (r.internal ?? null) as InternalStanding | null,
    state: r.state as CandidateCheckpoint["state"],
    candidate: (r.candidate ?? null) as DomainCandidate | null,
    githubState: r.github_state as CandidateCheckpoint["githubState"],
    reviewState: r.review_state as CandidateCheckpoint["reviewState"],
    error: (r.error as string | null) ?? null,
    retryable: Boolean(r.retryable),
    attempts: Number(r.attempts ?? 0),
    nextTryAt: iso(r.next_try_at),
    duplicateOf: (r.duplicate_of as string | null) ?? null,
  };
}

export async function candidateCount(jobId: string): Promise<number> {
  const rows = await query<{ n: string }>(`select count(*) n from automation.job_candidates where job_id = $1`, [jobId]);
  return Number(rows[0]?.n ?? 0);
}

/** Store the rows read for a job — once; a resumed job never re-reads the sheet. */
export async function insertCandidates(
  jobId: string,
  items: { key: string; ord: number; sourceTab: string; sourceRow: number; row: DomainCandidateRow; internal: InternalStanding | null; duplicateOf: string | null }[],
): Promise<void> {
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    await query(
      `insert into automation.job_candidates (job_id, key, ord, source_tab, source_row, row_data, internal, state, duplicate_of)
       select $1, t.key, t.ord, t.tab, t.rown, t.row_data, t.internal, case when t.dup is null then 'pending' else 'duplicate' end, t.dup
         from unnest($2::text[], $3::int[], $4::text[], $5::int[], $6::jsonb[], $7::jsonb[], $8::text[]) as t(key, ord, tab, rown, row_data, internal, dup)
       on conflict (job_id, key) do nothing`,
      [
        jobId,
        chunk.map((c) => c.key),
        chunk.map((c) => c.ord),
        chunk.map((c) => c.sourceTab),
        chunk.map((c) => c.sourceRow),
        chunk.map((c) => JSON.stringify(c.row)),
        chunk.map((c) => (c.internal ? JSON.stringify(c.internal) : null)),
        chunk.map((c) => c.duplicateOf),
      ],
    );
  }
}

export async function loadCandidates(jobId: string): Promise<CandidateCheckpoint[]> {
  return (await query(`select * from automation.job_candidates where job_id = $1 order by ord`, [jobId])).map(toCandidate);
}

/** A screening outcome for one candidate. */
export async function saveScreening(
  jobId: string,
  key: string,
  out:
    | { state: "screened"; candidate: DomainCandidate; githubState: "none" | "pending" }
    | { state: "invalid"; error: string }
    | { state: "error"; error: string; retryable: boolean; nextTryAt: Date | null },
): Promise<void> {
  if (out.state === "screened") {
    await query(
      `update automation.job_candidates set state = 'screened', candidate = $3::jsonb, github_state = $4, error = null, retryable = false,
              attempts = attempts + 1, next_try_at = null, updated_at = now() where job_id = $1 and key = $2`,
      [jobId, key, JSON.stringify(out.candidate), out.githubState],
    );
  } else if (out.state === "invalid") {
    await query(
      `update automation.job_candidates set state = 'invalid', error = $3, retryable = false, attempts = attempts + 1, updated_at = now()
        where job_id = $1 and key = $2`,
      [jobId, key, out.error.slice(0, 1_000)],
    );
  } else {
    await query(
      `update automation.job_candidates set state = 'error', error = $3, retryable = $4, attempts = attempts + 1, next_try_at = $5, updated_at = now()
        where job_id = $1 and key = $2`,
      [jobId, key, out.error.slice(0, 1_000), out.retryable, out.nextTryAt],
    );
  }
}

/** The candidate after GitHub inspection or project review. */
export async function saveEvaluated(
  jobId: string,
  key: string,
  candidate: DomainCandidate,
  patch: { githubState?: "pending" | "done"; reviewState?: "pending" | "done" },
): Promise<void> {
  await query(
    `update automation.job_candidates set candidate = $3::jsonb, github_state = coalesce($4, github_state), review_state = coalesce($5, review_state), updated_at = now()
      where job_id = $1 and key = $2`,
    [jobId, key, JSON.stringify(candidate), patch.githubState ?? null, patch.reviewState ?? null],
  );
}

/** Mark candidates for the next evaluation pass (planned once, so a restart keeps the same set). */
export async function markPending(jobId: string, keys: string[], field: "github_state" | "review_state"): Promise<void> {
  if (!keys.length) return;
  await query(`update automation.job_candidates set ${field} = 'pending', updated_at = now() where job_id = $1 and key = any($2::text[]) and ${field} = 'none'`, [
    jobId,
    keys,
  ]);
}

/** Housekeeping: candidate checkpoints of jobs finished more than 30 days ago (the jobs themselves stay). */
export async function pruneOldCheckpoints(): Promise<void> {
  await query(
    `delete from automation.job_candidates c using automation.jobs j
      where c.job_id = j.id and j.finished_at < now() - interval '30 days'`,
  ).catch(() => undefined);
}
