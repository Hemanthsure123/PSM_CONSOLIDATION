/**
 * Candidate Bucketing — run the real workflow (models, GitHub, coding sites) on a
 * batch outside Next.js and write the bucket lists.
 *
 *   npx tsx scripts/bucketing-run.ts <input.csv|input.json> <out-dir> [concurrency]
 *       [--resumes=<resume-sheet.csv>] [--scope=all|tr2|hires] [--limit=N] [--mobiles=a,b] [--rerun=REASON,REASON]
 *
 * input.csv: the interview export (candidates_all-colleges…csv, read by column name) or any sheet export —
 *   see src/lib/bucketing/parse.ts; rows with no stage count as Assessment cleared.
 * --resumes: a resume sheet (e.g. the PII sheet: Phone Number + Resume Link) matched by phone.
 * --scope: tr2 = TR-2 hires only (incl. combined interview); hires = TR-2 strong + medium only.
 * --limit: run only the first N of the queue (priority order) — for a small real test.
 * input.json: [{ mobile, name?, resumeUrl, stage, track?, verdict?, githubUrl?, … }].
 *
 * Resumable: results are appended to <out-dir>/results.json as they arrive and a
 * re-run skips every candidate already finished (re-run-needed rows, and bucketed
 * rows with evidence pending, run again). Writes complete.csv, one CSV per bucket,
 * not-bucketed.csv, summary.md and open-in-dashboard.json (Candidate Bucketing →
 * "Open a results file"). Pauses when the GitHub hourly budget runs low instead
 * of failing candidates.
 */
import "./server-only-shim";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  BUCKET_LABEL,
  BUCKETS,
  REASON_TEXT,
  RERUN_CODES,
  TIER_SHORT,
  TIERS,
  normalizeStage,
  normalizeTrack,
  normalizeVerdict,
  type ReasonCode,
} from "@/lib/bucketing/config";
import { runBucketing } from "@/lib/bucketing/graph";
import { inspectInterviewExport, parseBucketingInput, readResumeSheet } from "@/lib/bucketing/parse";
import { planRefresh } from "@/lib/bucketing/refresh";
import { buildBucketCsv, buildCompleteCsv, buildNotBucketedCsv, rankBuckets } from "@/lib/bucketing/csv";
import { checkGithubAccess } from "@/lib/github-analysis";
import {
  failedBucketingResult,
  tierOf,
  upgradeResult,
  type BucketingCandidateInput,
  type BucketingImportFile,
  type BucketingResult,
} from "@/lib/bucketing/types";

process.loadEnvFile(".env.local");

const GITHUB_FLOOR = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readInput(path: string, resumesPath: string): BucketingCandidateInput[] {
  const text = readFileSync(path, "utf8");
  if (/\.json$/i.test(path)) {
    const rows = JSON.parse(text) as Record<string, string>[];
    return rows.map((r, i): BucketingCandidateInput => {
      const stage = normalizeStage(r.stage ?? "") ?? "ASSESSMENT";
      return {
        id: r.mobile || String(i + 1),
        mobile: r.mobile || String(i + 1),
        name: r.name ?? "",
        resumeUrl: r.resumeUrl ?? "",
        resumeText: r.resumeText,
        stage,
        track: stage === "TR2" ? normalizeTrack(r.track ?? "") : null,
        verdict: stage === "TR2" ? normalizeVerdict(r.verdict ?? "") : null,
        githubUrl: r.githubUrl,
        leetcodeUrl: r.leetcodeUrl,
        codechefUrl: r.codechefUrl,
        codeforcesUrl: r.codeforcesUrl,
        batch: 1,
      };
    });
  }
  // The interview export, read by column name — show what it has before anything runs.
  const check = inspectInterviewExport(text, !/\.(tsv|txt)$/i.test(path));
  if (check.ok) {
    console.log(`Interview export: ${check.rows} rows · ${check.groups.map((g) => `${g.label} ${g.found}/${g.total}`).join(" · ")}`);
    const missing = check.groups.flatMap((g) => g.missing);
    if (missing.length) console.log(`  missing columns (read as empty): ${missing.join(", ")}`);
  } else {
    console.log(`Not the interview export (${check.error.slice(0, 80)}…) — reading it as a plain sheet.`);
  }
  const sheet = resumesPath ? readResumeSheet(readFileSync(resumesPath, "utf8")) : undefined;
  if (sheet?.error) throw new Error(`Resume sheet: ${sheet.error}`);
  if (sheet) console.log(`Resume sheet: ${sheet.links.size} resume links by phone`);
  const parsed = parseBucketingInput(text, { batch: 1, existing: new Map(), defaultStage: "ASSESSMENT", csv: !/\.(tsv|txt)$/i.test(path), resumes: sheet?.links });
  const skipped = parsed.filter((p) => !p.candidate);
  if (skipped.length) {
    const why = new Map<string, number>();
    for (const s of skipped) why.set(s.problem, (why.get(s.problem) ?? 0) + 1);
    console.log(`Skipped ${skipped.length} row(s): ${[...why].map(([k, v]) => `${v} × ${k}`).join("; ")}`);
  }
  return parsed.flatMap((p) => (p.candidate ? [p.candidate] : []));
}

async function githubGate() {
  for (;;) {
    const g = await checkGithubAccess();
    if (!g.ok) throw new Error(g.message);
    if (g.remaining > GITHUB_FLOOR) return;
    const wait = Math.max(30_000, Date.parse(g.resetAt) - Date.now() + 5_000);
    console.log(`GitHub budget low (${g.remaining} left) — pausing ${Math.round(wait / 60_000)} min until the hourly reset.`);
    await sleep(wait);
  }
}

function writeOutputs(dir: string, results: BucketingResult[], candidates: BucketingCandidateInput[]) {
  writeFileSync(join(dir, "results.json"), JSON.stringify(results));
  // Candidate Bucketing → "Open a results file" loads this as a saved run (re-run / add batches work too).
  const ids = new Set(results.map((r) => r.id));
  const file: BucketingImportFile = { name: basename(dir), candidates: candidates.filter((c) => ids.has(c.id)), results };
  writeFileSync(join(dir, "open-in-dashboard.json"), JSON.stringify(file));
  writeFileSync(join(dir, "complete.csv"), buildCompleteCsv(results, candidates));
  writeFileSync(join(dir, "not-bucketed.csv"), buildNotBucketedCsv(results, candidates));
  for (const b of BUCKETS) writeFileSync(join(dir, `bucket-${b.toLowerCase()}.csv`), buildBucketCsv(b, results, candidates));

  const ranked = rankBuckets(results);
  const split = (rs: BucketingResult[]) => TIERS.map((t) => rs.filter((r) => r.priorityTier === t).length).join(" | ");
  const reasons = new Map<ReasonCode, number>();
  for (const r of [...ranked.notBucketed, ...ranked.retry]) for (const c of r.reasonCodes) reasons.set(c, (reasons.get(c) ?? 0) + 1);
  const flags = new Map<ReasonCode, number>();
  for (const b of BUCKETS) for (const r of ranked.buckets[b]) for (const c of r.flags) flags.set(c, (flags.get(c) ?? 0) + 1);
  const bucketed = BUCKETS.reduce((s, b) => s + ranked.buckets[b].length, 0);
  const lines = [
    `# Candidate buckets`,
    ``,
    `${results.length} candidates evaluated · ${bucketed} bucketed · ${ranked.notBucketed.length} not bucketed · ${ranked.retry.length} need a re-run`,
    ``,
    `| Bucket | Total | ${TIERS.map((t) => TIER_SHORT[t]).join(" | ")} | Needs review |`,
    `|---|---|${TIERS.map(() => "---").join("|")}|---|`,
    ...BUCKETS.map((b) => {
      const rs = ranked.buckets[b];
      return `| ${BUCKET_LABEL[b]} | ${rs.length} | ${split(rs)} | ${rs.filter((r) => r.trust.needsReview).length} |`;
    }),
    `| Not bucketed | ${ranked.notBucketed.length} | ${split(ranked.notBucketed)} | |`,
    `| Re-run needed | ${ranked.retry.length} | ${split(ranked.retry)} | |`,
    ``,
    `## Flags on bucketed candidates`,
    ...(flags.size ? [...flags.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `- ${n} × ${REASON_TEXT[c]}`) : ["- none"]),
    ``,
    `## Why candidates were not bucketed`,
    ...[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `- ${n} × ${REASON_TEXT[c]}`),
  ];
  writeFileSync(join(dir, "summary.md"), lines.join("\n"));
}

function args() {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (m) flags[m[1]] = m[2];
    else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const { pos, flags } = args();
  const [inputPath, outDir, conc] = pos;
  if (!inputPath || !outDir) {
    throw new Error("usage: bucketing-run.ts <input.csv|input.json> <out-dir> [concurrency] [--resumes=…] [--scope=all|tr2|hires] [--limit=N] [--mobiles=…] [--rerun=…]");
  }
  // Optional: also re-run finished candidates with these reason codes (e.g. RESUME_UNREADABLE after re-sharing).
  const rerun = new Set((flags.rerun ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  mkdirSync(outDir, { recursive: true });
  let candidates = readInput(inputPath, flags.resumes ?? "");
  const scope = flags.scope ?? "all";
  if (scope === "tr2") candidates = candidates.filter((c) => c.stage === "TR2");
  else if (scope === "hires") candidates = candidates.filter((c) => tierOf(c) <= 2);
  if (flags.mobiles) {
    const want = new Set(flags.mobiles.split(",").map((s) => s.trim()));
    candidates = candidates.filter((c) => want.has(c.mobile));
  }

  const resultsPath = join(outDir, "results.json");
  const prior: BucketingResult[] = existsSync(resultsPath) ? (JSON.parse(readFileSync(resultsPath, "utf8")) as BucketingResult[]).map(upgradeResult) : [];
  const done = new Map(
    prior
      .filter((r) => r.status !== "retry_needed" && !r.flags.some((f) => RERUN_CODES.has(f)) && !r.reasonCodes.some((c) => rerun.has(c)))
      .map((r) => [r.id, r]),
  );
  const results = new Map<string, BucketingResult>(prior.map((r) => [r.id, r]));

  // A newer export over an earlier run: re-score changed tiers / scores from the saved
  // evidence, and run again the candidates whose bucket may move (same plan as the dashboard).
  const priorFile = join(outDir, "open-in-dashboard.json");
  const priorCandidates: BucketingCandidateInput[] = existsSync(priorFile) ? ((JSON.parse(readFileSync(priorFile, "utf8")) as BucketingImportFile).candidates ?? []) : [];
  if (priorCandidates.length) {
    const plan = planRefresh(priorCandidates, Object.fromEntries(results), candidates);
    for (const { result } of plan.rescored) results.set(result.id, result);
    for (const c of plan.rerun) done.delete(c.id);
    if (plan.rescored.length || plan.rerun.length) {
      console.log(`Newer export: ${plan.rescored.length} re-scored from saved evidence · ${plan.rerun.length} to run again (TR-2 track / journey / resume changed)`);
    }
  }

  // TR-2 strong → medium → low hire → TR-1 → Assessment — input order inside each tier.
  let queue = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !done.has(c.id))
    .sort((a, b) => tierOf(a.c) - tierOf(b.c) || a.i - b.i);
  if (flags.limit) queue = queue.slice(0, Math.max(0, Number(flags.limit) || 0));
  const withResume = queue.filter(({ c }) => c.resumeUrl).length;
  console.log(`${candidates.length} candidates (scope ${scope}) · ${done.size} already done · ${queue.length} to run (${withResume} with a resume)`);

  if (withResume) await githubGate();
  let lastGate = Date.now();
  let next = 0;
  let finished = 0;
  const workers = Array.from({ length: Math.max(1, Number(conc) || 4) }, async () => {
    for (;;) {
      const job = queue[next++];
      if (!job) return;
      if (job.c.resumeUrl && Date.now() - lastGate > 120_000) {
        lastGate = Date.now();
        await githubGate();
      }
      const t0 = Date.now();
      const r = await runBucketing(job.c).catch((e) => failedBucketingResult(job.c, e instanceof Error ? e.message : String(e), Date.now() - t0));
      results.set(r.id, r);
      finished += 1;
      const trust = r.trust.trust === null ? "—" : `${r.trust.trust} ${r.trust.band}`;
      console.log(
        `[${finished}/${queue.length}] ${r.stageLabel.padEnd(34)} ${r.mobile.padEnd(11)} ${r.status.padEnd(13)} ${(r.bucket ?? "").padEnd(15)} overall ${String(r.scores.overall).padStart(3)} int ${String(r.scores.internal).padStart(3)} trust ${trust.padEnd(10)} ${(r.durationMs / 1000).toFixed(0)}s ${[...r.reasonCodes, ...r.flags].join(",")}`,
      );
      if (finished % 5 === 0) writeOutputs(outDir, [...results.values()], candidates);
    }
  });
  await Promise.all(workers);
  writeOutputs(outDir, [...results.values()], candidates);
  console.log(readFileSync(join(outDir, "summary.md"), "utf8"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
