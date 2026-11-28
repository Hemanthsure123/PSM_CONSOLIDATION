/**
 * Imports a reviewed analysis of applications into app.application_reviews and app.job_comparisons
 * (PSM 1.13.0), so candidate feedback documents use it:
 *   npx tsx scripts/review-import.ts --dir <review folder> [--source review-2026-11] [--apply]
 * Without --apply it only reads and prints counts (no names, phones or emails). With --apply it writes
 * over DIRECT_URL in one transaction: the rows of this source are replaced (a re-run after the review
 * changed gives the review's current state). Only Academy assessed candidates in app.pool_candidates
 * are stored; the comparisons are counts per job (every pool, nobody named).
 *
 * The folder is the November Academy review's working folder: reasons.json (every application read),
 * candidate_counts.json (applied / sent / company decision per job and phone) and
 * asg/asg_tables.json (the assignment review's "Nov assignments – Candidates" table).
 */
import "./server-only-shim";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";
import { assignmentRows, comparisonsOf, importRows, type ReviewAppRecord, type ReviewReasonRecord, tenDigits } from "@/lib/feedback-docs/review-import";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment */
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const PROVENANCE = "November Academy review (stakeholder sheets: Academy Resume Rejection Analysis – Nov 2026, Track 1 / Track 2 trackers, assignment review)";

async function main() {
  const dir = arg("dir");
  const source = arg("source") ?? "review-2026-11";
  const apply = process.argv.includes("--apply");
  if (!dir) throw new Error("usage: --dir <review folder> [--source review-2026-11] [--apply]");
  if (!/^[a-z0-9][a-z0-9._-]{1,40}$/.test(source) || source === "live") throw new Error("--source must be a short name other than 'live'.");
  const read = <T,>(f: string): T => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T;

  const reasons = read<ReviewReasonRecord[]>("reasons.json");
  const counts = read<{ apps: ReviewAppRecord[] }>("candidate_counts.json");
  let asgTable: unknown[][] = [];
  try {
    const t = read<{ tabs: { name: string; rows: unknown[][] }[] }>(path.join("asg", "asg_tables.json")).tabs.find((x) => /candidates/i.test(x.name));
    asgTable = t?.rows ?? [];
  } catch {
    asgTable = [];
  }
  const assignments = assignmentRows(asgTable);
  const rows = importRows(reasons, counts.apps, assignments);
  const comparisons = comparisonsOf(reasons);
  console.log(`review: ${reasons.length} reads, ${counts.apps.length} counted applications, ${assignments.length} assignment results → ${rows.length} (phone, job) rows; comparisons for ${comparisons.size} jobs`);

  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  db.on("error", () => undefined);
  await db.connect();
  try {
    const people = (await db.query<{ uid: string; phone: string | null }>("select uid, phone from app.pool_candidates where removed_at is null and phone is not null")).rows;
    const uidOf = new Map<string, string>();
    const shared = new Set<string>();
    for (const p of people) {
      const phone = tenDigits(p.phone);
      if (!phone) continue;
      if (uidOf.has(phone) && uidOf.get(phone) !== p.uid) shared.add(phone);
      uidOf.set(phone, p.uid);
    }
    for (const ph of shared) uidOf.delete(ph);
    const mine = rows.filter((r) => uidOf.has(r.phone)).map((r) => ({ ...r, uid: uidOf.get(r.phone)! }));
    const byOutcome = (f: (r: (typeof mine)[number]) => boolean) => mine.filter(f).length;
    console.log(
      `pool candidates matched: ${new Set(mine.map((r) => r.uid)).size} people, ${mine.length} rows ` +
        `(sent ${byOutcome((r) => Boolean(r.sent))}, company-selected ${byOutcome((r) => r.decision === "selected")}, rejected ${byOutcome((r) => r.decision === "rejected")}, with an assignment ${byOutcome((r) => r.assignment !== null)})`,
    );
    if (!apply) {
      console.log("dry run: nothing written (add --apply to write)");
      return;
    }
    await db.query("BEGIN");
    try {
      await db.query("delete from app.application_reviews where source = $1", [source]);
      for (let i = 0; i < mine.length; i += 500) {
        const c = mine.slice(i, i + 500);
        await db.query(
          `insert into app.application_reviews (source, uid, job_id, applied, sent, decision, primary_reason, reasons, details, read, screening, resume_url, checked, assignment, provenance)
           select $1, x.uid, x.job_id, x.applied, x.sent, x.decision, x.primary_reason,
                  array(select jsonb_array_elements_text(x.reasons)), array(select jsonb_array_elements_text(x.details)),
                  x.read, x.screening, x.resume_url, x.checked, x.assignment, $3
             from jsonb_to_recordset($2::jsonb) as x(uid text, job_id text, applied boolean, sent boolean, decision text, primary_reason text,
                  reasons jsonb, details jsonb, read jsonb, screening text, resume_url text, checked text, assignment jsonb)
            where exists (select 1 from app.pool_candidates p where p.uid = x.uid)
           on conflict (source, uid, job_id) do nothing`,
          [
            source,
            JSON.stringify(
              c.map((r) => ({
                uid: r.uid,
                job_id: r.jobId,
                applied: r.applied,
                sent: r.sent,
                decision: r.decision,
                primary_reason: r.primaryReason,
                reasons: r.reasons,
                details: r.details,
                read: r.read,
                screening: r.screening,
                resume_url: r.resumeUrl,
                checked: r.checked,
                assignment: r.assignment,
              })),
            ),
            PROVENANCE,
          ],
        );
      }
      await db.query("delete from app.job_comparisons where source = $1", [source]);
      const comps = [...comparisons.entries()].map(([job_id, c]) => ({
        job_id,
        selected: c.selected,
        with_internship: c.withInternship,
        with_links: c.withLinks,
        with_project: c.withProject,
        all_must_haves: c.allMustHaves,
        fit_avg: c.fitAvg,
      }));
      if (comps.length) {
        await db.query(
          `insert into app.job_comparisons (source, job_id, selected, with_internship, with_links, with_project, all_must_haves, fit_avg)
           select $1, x.job_id, x.selected, x.with_internship, x.with_links, x.with_project, x.all_must_haves, x.fit_avg
             from jsonb_to_recordset($2::jsonb) as x(job_id text, selected int, with_internship int, with_links int, with_project int, all_must_haves int, fit_avg numeric)`,
          [source, JSON.stringify(comps)],
        );
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    const [{ n }] = (await db.query<{ n: number }>("select count(*)::int as n from app.application_reviews where source = $1", [source])).rows;
    const [{ m }] = (await db.query<{ m: number }>("select count(*)::int as m from app.job_comparisons where source = $1", [source])).rows;
    console.log(`written: ${n} application reviews and ${m} job comparisons (source ${source})`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
