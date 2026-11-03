/**
 * Assessment scores — import from the command line (same code path as the Eligible pool screen).
 *
 *   npx tsx scripts/scores-import.ts "Competency Assessments Results - 25th Oct SE Offline.csv" …
 *   npx tsx scripts/scores-import.ts --sheets            # refetch every readable Google Sheets tab
 *   npx tsx scripts/scores-import.ts --dry-run *.csv     # only say what each file is and what it holds
 *
 * Options: --date=YYYY-MM-DD (an offline exam whose file name has no date), --allow-shrink (accept an
 * export that removes more than a fifth of the scores stored for it).
 * Each file replaces its own export's scores; files are imported one after another. Everyone assessed is
 * kept (a person new to the database is added for a real score); each line says how many of the people
 * are eligible for job opportunities (in the eligible pool).
 */
import "./server-only-shim";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseCsv } from "@/lib/utils";
import type { ScoreImportResult } from "@/lib/pool/scores/catalogue";
import { parseScores } from "@/lib/pool/scores/parse";
import { scoreSheets } from "@/lib/pool/scores/sources";
import { importScores, syncScoreSheet } from "@/lib/pool/scores/sync";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment (scheduler / deploy) */
}

const line = (r: ScoreImportResult, name: string) => {
  const skipped = r.skipped.reduce((s, x) => s + x.count, 0);
  const head = `${(r.ok ? "OK  " : "FAIL").padEnd(5)}${name.slice(0, 60).padEnd(61)}`;
  if (!r.ok) return `${head}${r.label ? `${r.label} — ` : ""}${r.error}`;
  return `${head}${r.label} · read ${r.rowsRead} · new ${r.inserted} · updated ${r.updated} · unchanged ${r.unchanged} · removed ${r.removed} · skipped ${skipped} · people ${r.people} (eligible ${r.eligiblePeople}) · added ${r.peopleAdded} · profiles ${r.profiles} · issues ${r.issues.length} · ${(r.ms / 1000).toFixed(1)} s`;
};

async function main() {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const date = args.find((a) => a.startsWith("--date="))?.slice(7);
  const files = args.filter((a) => !a.startsWith("--"));
  const allowShrink = flag("--allow-shrink");
  if (!files.length && !flag("--sheets")) throw new Error("Name the CSV files to import, or pass --sheets.");

  let failed = 0;
  for (const file of files) {
    const table = parseCsv(readFileSync(file, "utf8").replace(/^﻿/, ""));
    const name = basename(file);
    if (flag("--dry-run")) {
      const p = parseScores(table, { fileName: name, examDate: date });
      const skipped = p.skipped.map((s) => `${s.reason} ${s.count}`).join(", ");
      console.log(`${name.slice(0, 60).padEnd(61)}${p.error ? `— ${p.error}` : `${p.label} [${p.sourceKey}] · ${p.rows.length} scores of ${p.rowsRead} rows${skipped ? ` · skipped: ${skipped}` : ""}${p.issues.length ? ` · ${p.issues.length} issues` : ""}`}`);
      continue;
    }
    const r = await importScores({ mode: "csv", sourceRef: name, fileName: name, table, examDate: date, allowShrink }, "cli");
    console.log(line(r, name));
    if (!r.ok) failed++;
  }
  if (flag("--sheets") && !flag("--dry-run")) {
    for (const s of scoreSheets()) {
      const r = await syncScoreSheet(s.id, { allowShrink, triggeredBy: "cli" });
      console.log(line(r, `sheet: ${s.tab}`));
      if (!r.ok) failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
