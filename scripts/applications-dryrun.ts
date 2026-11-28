/**
 * READ-ONLY dry run of the 1.13.0 applications sync against the live sheets (writes nothing: no
 * database, no sheet writes):
 *   npx tsx scripts/applications-dryrun.ts [--max-sheets N] [--snapshots <dir>]
 * Reads the Academy "> 8LPA Assessed Pool" tab (the pool the sync matches against), the CRPs master
 * and the internal sheets it lists ("Internal sheet Link"), paced at 40 Sheets reads a minute, and
 * prints COUNTS only: no names, phones or emails of candidates. --snapshots <dir>: read each internal
 * sheet from <dir>/<sheetId>.json ({ title, tabs: [{ title, gid, values }] }) instead of the API, for
 * sheets only the team account can open (its token can't be used locally).
 */
import "./server-only-shim";
import { buildApplications, internalSheetsOf, poolLookup } from "@/lib/mobile/pool/applications";
import { readInternalSheet } from "@/lib/mobile/pool/applications-sync";
import { parsePoolRows } from "@/lib/mobile/pool/parse";
import { driveMeta, pacer, readCrpMaster, SHEETS_PER_MINUTE } from "@/lib/mobile/pool/shares-sync";
import { poolSource } from "@/lib/pool/sources";
import { readTab } from "@/lib/pool/sync";
import * as fs from "node:fs";
import * as path from "node:path";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment */
}

async function main() {
  const maxArg = process.argv.indexOf("--max-sheets");
  const maxSheets = maxArg > 0 ? Number(process.argv[maxArg + 1]) : Infinity;
  const snapArg = process.argv.indexOf("--snapshots");
  const snapshots = snapArg > 0 ? process.argv[snapArg + 1] : null;
  const pace = pacer(SHEETS_PER_MINUTE);

  const src = poolSource("academy");
  await pace();
  const parsed = parsePoolRows(await readTab(src.spreadsheetId, src.tab));
  const pool = poolLookup(parsed.rows);
  console.log(`pool: ${parsed.rows.length} assessed candidates`);

  const master = await readCrpMaster(pace);
  const sheets = internalSheetsOf(master.requirements);
  const withInternal = master.requirements.filter((r) => r.internalSheetId).length;
  console.log(`CRPs: ${master.requirements.length} requirements, ${withInternal} with an internal sheet link, ${sheets.length} distinct internal sheets`);
  const knownJobs = new Set(master.requirements.map((r) => r.jobId.trim().toLowerCase()).filter(Boolean));

  let readable = 0;
  let unreadable = 0;
  let noTabs = 0;
  let tabs = 0;
  let rows = 0;
  let matched = 0;
  let noJob = 0;
  let apps = 0;
  let dated = 0;
  let withResume = 0;
  let portal = 0;
  let form = 0;
  let unknownJob = 0;
  const people = new Set<string>();
  const errors = new Map<string, number>();
  for (const s of sheets.slice(0, maxSheets)) {
    const file = snapshots ? path.join(snapshots, `${s.sheetId}.json`) : "";
    if (snapshots && !fs.existsSync(file)) {
      unreadable++;
      errors.set("no snapshot", (errors.get("no snapshot") ?? 0) + 1);
      continue;
    }
    if (!snapshots) {
      const meta = await driveMeta(s.sheetId);
      if (!meta.ok) {
        unreadable++;
        errors.set(meta.error.slice(0, 60), (errors.get(meta.error.slice(0, 60)) ?? 0) + 1);
        continue;
      }
    }
    try {
      const t = snapshots
        ? (JSON.parse(fs.readFileSync(file, "utf8")).tabs as { title: string; gid: number; hidden?: boolean; values: unknown[][] }[]).map((x) => ({
            info: { title: x.title, gid: x.gid, hidden: Boolean(x.hidden), rowCount: x.values.length, columnCount: 26 },
            rows: x.values,
          }))
        : await readInternalSheet(s.sheetId, pace);
      readable++;
      if (!t.length) noTabs++;
      const b = buildApplications(s, t, pool);
      tabs += b.tabsRead;
      rows += b.rowsSeen;
      matched += b.academyRows;
      noJob += b.noJob;
      apps += b.applications.length;
      for (const a of b.applications) {
        people.add(a.uid);
        if (a.appliedAt !== null) dated++;
        if (a.resumeUrl) withResume++;
        if (a.source === "portal") portal++;
        else form++;
        if (!knownJobs.has(a.jobId)) unknownJob++;
      }
    } catch (err) {
      unreadable++;
      const m = (err instanceof Error ? err.message : String(err)).slice(0, 60);
      errors.set(m, (errors.get(m) ?? 0) + 1);
    }
  }
  console.log(`internal sheets: ${readable} read (${noTabs} without an applications tab), ${unreadable} unreadable`);
  console.log(`applications tabs: ${tabs}; rows naming someone: ${rows}; matched to the pool: ${matched}; matched without a job: ${noJob}`);
  console.log(`applications kept: ${apps} (portal ${portal}, form ${form}) by ${people.size} candidates; with a date: ${dated}; with a resume link: ${withResume}; job id not in the CRPs master: ${unknownJob}`);
  if (errors.size) console.log("read errors:", [...errors.entries()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
