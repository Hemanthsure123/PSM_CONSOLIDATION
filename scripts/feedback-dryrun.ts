/**
 * READ-ONLY dry run of a 1.13.0 candidate feedback document (no Google Doc, no database writes, no
 * pushes, model caches off):
 *   npx tsx scripts/feedback-dryrun.ts --uid <uid> --from 2026-11-01 --to 2026-11-30 --out <dir> [--snapshots <dir>] [--review-dir <dir>]
 * Reads the candidate's company-sheet rows (a read-only transaction), the CRPs master and the
 * candidate's applications from the internal sheets of the period's jobs (live where the service
 * account can open them, else <snapshots>/<sheetId>.json), reviews each resume with the model, and
 * writes <out>/feedback.docx, feedback.txt and feedback.json. Prints counts only; the files hold the
 * candidate's data, so keep <out> outside the repo. --review-dir: use a reviewed analysis's folder (as
 * scripts/review-import.ts would import it) for the jobs it covers, instead of the model.
 */
import "./server-only-shim";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";
import { buildApplications, internalSheetsOf, poolLookup } from "@/lib/mobile/pool/applications";
import { readInternalSheet } from "@/lib/mobile/pool/applications-sync";
import { inferCrpYear, ownStatusOf, parseCrpMonth, roundsOf } from "@/lib/mobile/pool/shares";
import { driveMeta, pacer, readCrpMaster, SHEETS_PER_MINUTE } from "@/lib/mobile/pool/shares-sync";
import { normRound } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import {
  assembleJobs,
  buildContent,
  checkContent,
  factsFromLive,
  factsFromReview,
  idDoneMonth,
  type FbApplication,
  type FbRequirement,
  type FbSheet,
  type Comparison,
  type ImportedReview,
  type JobFacts,
  jobsInPeriod,
  resumeLabels,
} from "@/lib/feedback-docs/model";
import { assignmentRows, comparisonsOf, importRows, type ReviewAppRecord, type ReviewReasonRecord, tenDigits } from "@/lib/feedback-docs/review-import";
import { feedbackText, renderFeedbackDocx } from "@/lib/feedback-docs/render";
import { type JobToReview, reviewResumes } from "@/lib/feedback-docs/review";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment */
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const uid = arg("uid");
  const from = arg("from");
  const to = arg("to");
  const out = arg("out");
  const snapshots = arg("snapshots");
  if (!uid || !from || !to || !out) throw new Error("usage: --uid <uid> --from YYYY-MM-DD --to YYYY-MM-DD --out <dir> [--snapshots <dir>] [--review-dir <dir>]");
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  // The app's own database client is switched off: the model caches then neither read nor write.
  delete process.env.DATABASE_URL;
  // One short connection per query: the sheet reads take minutes and an idle connection is dropped.
  const ro = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    db.on("error", () => undefined);
    await db.connect();
    try {
      await db.query("BEGIN READ ONLY");
      return (await db.query(sql, params)).rows as T[];
    } finally {
      await db.query("ROLLBACK").catch(() => undefined);
      await db.end().catch(() => undefined);
    }
  };
  {
    const [cand] = await ro<{ uid: string; name: string; phone: string | null; email: string | null }>("select uid, name, phone, email from app.pool_candidates where uid = $1", [uid]);
    if (!cand) throw new Error("No such candidate in app.pool_candidates.");
    const pace = pacer(SHEETS_PER_MINUTE);
    const master = await readCrpMaster(pace);
    const stored = new Map((await ro<{ key: string; crp_year: number | null }>("select key, crp_year from app.crp_requirements")).map((r) => [r.key, r.crp_year]));
    const deals = new Map((await ro<{ deal_id: string; jd_url: string | null }>("select deal_id, jd_url from app.hubspot_deals where jd_url is not null")).map((d) => [d.deal_id, d.jd_url]));
    const now = new Date();
    const requirements: (FbRequirement & { internalSheetId: string | null })[] = master.requirements.map((r) => {
      const m = parseCrpMonth(r.crpMonth);
      return {
        key: r.key,
        sheetId: r.sheetId,
        internalSheetId: r.internalSheetId,
        company: r.company,
        role: r.role,
        jobId: r.jobId,
        crpMonth: r.crpMonth,
        crpYear: stored.get(r.key) ?? (m ? m.year ?? inferCrpYear(m.month, now) : null),
        crpWeek: r.crpWeek,
        finalStatus: r.finalStatus,
        stage: r.stage,
        idStatus: r.idStatus,
        academySent: r.academySent,
        assessedSent: r.assessedSent,
        nonAssessedSent: r.nonAssessedSent,
        techStack: r.techStack,
        jdUrl: r.jdUrl ?? (r.hubspotDealId ? deals.get(r.hubspotDealId) ?? null : null),
        idMonth: r.idMonth,
        idYear: (() => {
          const m = parseCrpMonth(r.idMonth);
          return m ? m.year ?? inferCrpYear(m.month, now) : null;
        })(),
      };
    });

    // Applications: the internal sheets of jobs whose CRP month (or ID-done month) is within a month of
    // the period. The server reads every internal sheet; this only keeps the dry run short.
    const lo = new Date(Date.parse(`${from}T00:00:00Z`) - 40 * 86_400_000).toISOString().slice(0, 10);
    const hi = new Date(Date.parse(`${to}T00:00:00Z`) + 40 * 86_400_000).toISOString().slice(0, 10);
    const near = requirements.filter((r) => {
      const m = parseCrpMonth(r.crpMonth);
      if (!m || !r.crpYear) return true;
      const start = new Date(Date.UTC(r.crpYear, m.month, 1)).toISOString().slice(0, 10);
      if (start >= lo.slice(0, 8) + "01" && start <= hi) return true;
      const id = idDoneMonth(r);
      return Boolean(id && id.from <= hi && id.to >= lo);
    });
    const pool = poolLookup([cand]);
    const applications: FbApplication[] = [];
    let sheetsRead = 0;
    let sheetsMissing = 0;
    for (const s of internalSheetsOf(near)) {
      const file = snapshots ? path.join(snapshots, `${s.sheetId}.json`) : "";
      let tabs;
      if (file && fs.existsSync(file)) {
        tabs = (JSON.parse(fs.readFileSync(file, "utf8")).tabs as { title: string; gid: number; hidden?: boolean; values: unknown[][] }[]).map((x) => ({
          info: { title: x.title, gid: x.gid, hidden: Boolean(x.hidden), rowCount: x.values.length, columnCount: 26 },
          rows: x.values,
        }));
      } else {
        const meta = await driveMeta(s.sheetId);
        if (!meta.ok) {
          sheetsMissing++;
          continue;
        }
        tabs = await readInternalSheet(s.sheetId, pace).catch(() => null);
        if (!tabs) {
          sheetsMissing++;
          continue;
        }
      }
      sheetsRead++;
      for (const a of buildApplications(s, tabs, pool).applications) applications.push({ jobId: a.jobId, appliedAt: a.appliedAt === null ? null : new Date(a.appliedAt), resumeUrl: a.resumeUrl, source: a.source });
    }
    console.log(`internal sheets near the period: ${sheetsRead} read, ${sheetsMissing} not readable here; applications found: ${applications.length}`);

    const shareRows = await ro<{ id: string; sheet_id: string; tab: string; role: string; company: string; rounds: unknown; final_status: string; status: string | null; outcome: string; first_seen_at: Date }>(
      "select id::text as id, sheet_id, tab, role, company, rounds, final_status, status, outcome, first_seen_at from app.company_shares where uid = $1 and removed_at is null",
      [uid],
    );
    const shares = shareRows.map((s) => ({
      id: s.id,
      sheetId: s.sheet_id,
      tab: s.tab,
      role: s.role,
      company: s.company,
      rounds: roundsOf(s.rounds),
      finalStatus: s.final_status,
      own: ownStatusOf(s).status,
      firstSeen: s.first_seen_at,
      resumeUrl: null,
    }));
    const sheetIds = [...new Set([...shares.map((s) => s.sheetId), ...requirements.filter((r) => r.sheetId).map((r) => r.sheetId!)])];
    const sheets = new Map<string, FbSheet>();
    for (const s of await ro<{ sheet_id: string; last_read_at: Date | null; read_error: string | null }>("select sheet_id, last_read_at, read_error from app.company_sheets where sheet_id = any($1::text[])", [sheetIds])) {
      sheets.set(s.sheet_id, { readable: Boolean(s.last_read_at) && !s.read_error, tabs: new Map() });
    }
    for (const t of await ro<{ sheet_id: string; tab: string; n: number }>("select sheet_id, tab, count(*)::int as n from app.company_shares where sheet_id = any($1::text[]) and removed_at is null group by sheet_id, tab", [sheetIds])) {
      sheets.get(t.sheet_id)?.tabs.set(t.tab, t.n);
    }
    // A reviewed analysis (local folder), for the jobs it covers.
    const reviewDir = arg("review-dir");
    let reviews: ImportedReview[] = [];
    let comparisons = new Map<string, Comparison>();
    if (reviewDir && cand.phone) {
      const reasons = JSON.parse(fs.readFileSync(path.join(reviewDir, "reasons.json"), "utf8")) as ReviewReasonRecord[];
      const apps = (JSON.parse(fs.readFileSync(path.join(reviewDir, "candidate_counts.json"), "utf8")) as { apps: ReviewAppRecord[] }).apps;
      const asg = (JSON.parse(fs.readFileSync(path.join(reviewDir, "asg", "asg_tables.json"), "utf8")) as { tabs: { name: string; rows: unknown[][] }[] }).tabs.find((t) => /candidates/i.test(t.name))?.rows ?? [];
      reviews = importRows(reasons, apps, assignmentRows(asg))
        .filter((r) => r.phone === tenDigits(cand.phone))
        .map(({ phone: _p, ...r }) => ({ ...r, source: "review-2026-11" }));
      comparisons = comparisonsOf(reasons);
      console.log(`reviewed analysis: ${reviews.length} of the candidate's applications, comparisons for ${comparisons.size} jobs`);
    }
    const snap = await readPrepSnapshot();
    const interviews = snap.preps
      .filter((p) => cand.phone && p.phone === cand.phone)
      .map((p) => ({ jobId: p.jobId, company: p.company, round: normRound(p.round), day: p.interviewDay, cancelled: p.interviewState === "cancelled" || p.interviewState === "rescheduled" }));

    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const all = assembleJobs({ candidate: { uid, name: cand.name }, requirements, applications, shares, sheets, interviews, today, reviews });
    const jobs = jobsInPeriod(all, { from, to });
    console.log(`jobs: ${all.length} in all, ${jobs.length} in the period; outcomes: ${JSON.stringify(jobs.reduce<Record<string, number>>((m, j) => ((m[j.outcome] = (m[j.outcome] ?? 0) + 1), m), {}))}`);
    if (process.argv.includes("--details")) {
      // Every job of the candidate (any period): for checking the rules by hand. Local use only.
      for (const j of all.sort((a, b) => (a.period?.from ?? "").localeCompare(b.period?.from ?? ""))) {
        console.log(
          `  ${jobs.includes(j) ? "*" : " "} ${j.period ? `${j.period.from}…${j.period.to}` : "no CRP period".padEnd(21)} ${j.outcome.padEnd(15)} ${j.company} – ${j.role} | applied ${j.appliedAt ? j.appliedAt.toISOString().slice(0, 10) : "-"} | shared ${j.shared} | resume ${j.resumeUrl ? "yes" : "NO"} | ${j.flags.join(",")} | ${j.items.map((i) => `${i.label}:${i.result}`).join("; ")} | review ${j.review ? `${j.review.applied ? "applied" : "-"}/${j.review.sent ? "sent" : "-"}/${j.review.decision ?? "-"}` : "none"}${j.idDone ? ` | ID done ${j.idDone.from.slice(0, 7)}` : ""}`,
        );
      }
    }

    if (process.argv.includes("--no-review")) return;
    const facts = new Map<string, JobFacts>();
    for (const j of jobs) if (j.review) facts.set(j.key, factsFromReview(j.review));
    const live = jobs.filter((j) => !j.review && j.resumeUrl);
    const urls = [...new Set(live.map((j) => j.resumeUrl!))].sort(
      (a, b) => (jobs.find((j) => j.resumeUrl === a)?.appliedAt?.getTime() ?? 0) - (jobs.find((j) => j.resumeUrl === b)?.appliedAt?.getTime() ?? 0),
    );
    const allUrls = [...new Set(jobs.map((j) => j.resumeUrl).filter((u): u is string => Boolean(u)))];
    const labels = resumeLabels(allUrls, cand.name);
    const items = urls.map((u) => ({
      url: u,
      label: labels.get(u)!,
      jobs: live.filter((j) => j.resumeUrl === u).map((j): JobToReview => ({ key: j.key, company: j.company, role: j.role, techStack: j.techStack, jdUrl: j.jdUrl })),
    }));
    const started = Date.now();
    const reviewed = await reviewResumes(items, (d, t) => {
      if (d === t) console.log(`resumes read: ${t}`);
    });
    for (const j of live) {
      const u = reviewed.canonical.get(j.resumeUrl!) ?? j.resumeUrl!;
      j.resumeUrl = u;
      const rv = reviewed.reviews.get(u);
      if (rv) facts.set(j.key, factsFromLive(rv, rv.jobs.get(j.key)));
    }
    console.log(`reviews: ${reviewed.reviews.size} by the model (${reviewed.calls} calls, ${reviewed.cached} cached) in ${Math.round((Date.now() - started) / 1000)} s; ${jobs.filter((j) => j.review).length} jobs from the reviewed analysis`);
    const content = buildContent(jobs, {
      candidate: { uid, name: cand.name },
      period: { from, to },
      today,
      facts,
      comparisons,
      resumeLabels: labels,
      model: reviewed.models[0] ?? null,
      applicationsReadAt: new Date(),
      sourcesMissing: [],
    });
    const problems = checkContent(content);
    console.log(problems.length ? `CHECKS FAILED: ${problems.join("; ")}` : "checks: all numbers agree");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "feedback.docx"), await renderFeedbackDocx(content));
    fs.writeFileSync(path.join(out, "feedback.txt"), feedbackText(content));
    fs.writeFileSync(path.join(out, "feedback.json"), JSON.stringify(content, null, 1));
    console.log(`written: ${path.join(out, "feedback.docx")} (+ .txt, .json); ${content.notes.length} reviewer notes`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
