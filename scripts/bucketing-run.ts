/**
 * Candidate Bucketing — run the real workflow (models, GitHub, coding sites) on a
 * batch outside Next.js and write the bucket lists.
 *
 *   npx tsx scripts/bucketing-run.ts <input.csv|input.json> <out-dir> [concurrency] [REASON,REASON…]
 *
 * input.csv: a sheet export (e.g. the "Assessed Pool" master sheet) — see
 *   src/lib/bucketing/parse.ts; rows with no stage count as Assessment cleared.
 * input.json: [{ mobile, name?, resumeUrl, stage, track?, githubUrl?, … }].
 *
 * Resumable: results are appended to <out-dir>/results.json as they arrive and a
 * re-run skips every candidate already finished (re-run-needed rows run again).
 * Writes complete.csv, one CSV per bucket, not-bucketed.csv, summary.md and
 * open-in-dashboard.json (Candidate Bucketing → "Open a results file").
 * Pauses when the GitHub hourly budget runs low instead of failing candidates.
 */
import "./server-only-shim";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BUCKET_LABEL, BUCKETS, REASON_TEXT, STAGE_TIER, normalizeStage, normalizeTrack, type ReasonCode } from "@/lib/bucketing/config";
import { runBucketing } from "@/lib/bucketing/graph";
import { parseBucketingInput } from "@/lib/bucketing/parse";
import { buildBucketCsv, buildCompleteCsv, buildNotBucketedCsv, rankBuckets } from "@/lib/bucketing/csv";
import { checkGithubAccess } from "@/lib/github-analysis";
import { failedBucketingResult, noResumeResult, type BucketingCandidateInput, type BucketingImportFile, type BucketingResult } from "@/lib/bucketing/types";

process.loadEnvFile(".env.local");

const GITHUB_FLOOR = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readInput(path: string): { candidates: BucketingCandidateInput[]; noResume: BucketingCandidateInput[] } {
  const text = readFileSync(path, "utf8");
  if (/\.json$/i.test(path)) {
    const rows = JSON.parse(text) as Record<string, string>[];
    const candidates = rows.map((r, i): BucketingCandidateInput => {
      const stage = normalizeStage(r.stage ?? "") ?? "ASSESSMENT";
      return {
        id: r.mobile || String(i + 1),
        mobile: r.mobile || String(i + 1),
        name: r.name ?? "",
        resumeUrl: r.resumeUrl ?? "",
        resumeText: r.resumeText,
        stage,
        track: stage === "TR2" ? normalizeTrack(r.track ?? "") : null,
        githubUrl: r.githubUrl,
        leetcodeUrl: r.leetcodeUrl,
        codechefUrl: r.codechefUrl,
        codeforcesUrl: r.codeforcesUrl,
        batch: 1,
      };
    });
    return { candidates, noResume: [] };
  }
  const parsed = parseBucketingInput(text, { batch: 1, existing: new Map(), defaultStage: "ASSESSMENT", csv: true });
  const skipped = parsed.filter((p) => !p.candidate);
  if (skipped.length) {
    const why = new Map<string, number>();
    for (const s of skipped) why.set(s.problem, (why.get(s.problem) ?? 0) + 1);
    console.log(`Skipped ${skipped.length} row(s): ${[...why].map(([k, v]) => `${v} × ${k}`).join("; ")}`);
  }
  return {
    candidates: parsed.flatMap((p) => (p.candidate ? [p.candidate] : [])),
    noResume: parsed.flatMap((p) => (p.stub ? [p.stub] : [])),
  };
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
  const file: BucketingImportFile = { name: basename(dir), candidates, results };
  writeFileSync(join(dir, "open-in-dashboard.json"), JSON.stringify(file));
  writeFileSync(join(dir, "complete.csv"), buildCompleteCsv(results, candidates));
  writeFileSync(join(dir, "not-bucketed.csv"), buildNotBucketedCsv(results, candidates));
  for (const b of BUCKETS) writeFileSync(join(dir, `bucket-${b.toLowerCase()}.csv`), buildBucketCsv(b, results, candidates));

  const ranked = rankBuckets(results);
  const stageCount = (rs: BucketingResult[], tier: number) => rs.filter((r) => r.priorityTier === tier).length;
  const reasons = new Map<ReasonCode, number>();
  for (const r of [...ranked.notBucketed, ...ranked.retry]) for (const c of r.reasonCodes) reasons.set(c, (reasons.get(c) ?? 0) + 1);
  const lines = [
    `# Candidate buckets`,
    ``,
    `${results.length} of ${candidates.length} candidates evaluated · ${results.length - ranked.notBucketed.length - ranked.retry.length} bucketed · ${ranked.notBucketed.length} not bucketed · ${ranked.retry.length} need a re-run`,
    ``,
    `| Bucket | Total | TR-2 | TR-1 | Assessment | Needs review |`,
    `|---|---|---|---|---|---|`,
    ...BUCKETS.map((b) => {
      const rs = ranked.buckets[b];
      return `| ${BUCKET_LABEL[b]} | ${rs.length} | ${stageCount(rs, 1)} | ${stageCount(rs, 2)} | ${stageCount(rs, 3)} | ${rs.filter((r) => r.trust.needsReview).length} |`;
    }),
    `| Not bucketed | ${ranked.notBucketed.length} | ${stageCount(ranked.notBucketed, 1)} | ${stageCount(ranked.notBucketed, 2)} | ${stageCount(ranked.notBucketed, 3)} | |`,
    `| Re-run needed | ${ranked.retry.length} | ${stageCount(ranked.retry, 1)} | ${stageCount(ranked.retry, 2)} | ${stageCount(ranked.retry, 3)} | |`,
    ``,
    `## Why candidates were not bucketed`,
    ...[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `- ${n} × ${REASON_TEXT[c]}`),
  ];
  writeFileSync(join(dir, "summary.md"), lines.join("\n"));
}

async function main() {
  const [inputPath, outDir, conc, rerunArg] = process.argv.slice(2);
  if (!inputPath || !outDir) throw new Error("usage: bucketing-run.ts <input.csv|input.json> <out-dir> [concurrency] [REASON,REASON…]");
  // Optional: also re-run finished candidates with these reason codes (e.g. RESUME_UNREADABLE after re-sharing).
  const rerun = new Set((rerunArg ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  mkdirSync(outDir, { recursive: true });
  const input = readInput(inputPath);
  // Rows with no resume link are listed as "no resume" so every candidate is accounted for.
  const candidates = [...input.candidates, ...input.noResume];
  const resultsPath = join(outDir, "results.json");
  const prior: BucketingResult[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : [];
  const done = new Map(
    prior.filter((r) => r.status !== "retry_needed" && !r.reasonCodes.some((c) => rerun.has(c))).map((r) => [r.id, r]),
  );
  const results = new Map<string, BucketingResult>(prior.map((r) => [r.id, r]));
  for (const c of input.noResume) if (!results.has(c.id)) results.set(c.id, noResumeResult(c));

  // TR-2 first, then TR-1, then Assessment — input order inside each stage.
  const queue = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.resumeUrl && !done.has(c.id))
    .sort((a, b) => STAGE_TIER[a.c.stage] - STAGE_TIER[b.c.stage] || a.i - b.i);
  console.log(`${candidates.length} candidates · ${done.size} already done · ${queue.length} to run`);

  await githubGate();
  let lastGate = Date.now();
  let next = 0;
  let finished = 0;
  const workers = Array.from({ length: Math.max(1, Number(conc) || 4) }, async () => {
    for (;;) {
      const job = queue[next++];
      if (!job) return;
      if (Date.now() - lastGate > 120_000) {
        lastGate = Date.now();
        await githubGate();
      }
      const t0 = Date.now();
      const r = await runBucketing(job.c).catch((e) => failedBucketingResult(job.c, e instanceof Error ? e.message : String(e), Date.now() - t0));
      results.set(r.id, r);
      finished += 1;
      const trust = r.trust.trust === null ? "—" : `${r.trust.trust} ${r.trust.band}`;
      console.log(
        `[${finished}/${queue.length}] ${r.stageLabel.padEnd(28)} ${r.mobile.padEnd(11)} ${r.status.padEnd(13)} ${(r.bucket ?? "").padEnd(10)} overall ${String(r.scores.overall).padStart(3)} trust ${trust.padEnd(10)} ${(r.durationMs / 1000).toFixed(0)}s ${[...r.reasonCodes, ...r.flags].join(",")}`,
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
