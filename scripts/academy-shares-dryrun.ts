/**
 * READ-ONLY dry run of the 1.10.0 Academy shares sync against the live sheets (writes nothing: no
 * database, no sheet writes):
 *   npx tsx scripts/academy-shares-dryrun.ts [--max-sheets N]
 * Reads the Academy "> 8LPA Assessed Pool" tab (as the 1.10.0 pool sync would keep it), the CRPs
 * master and every company sheet it lists (Drive modifiedTime, then one spreadsheets.get and one
 * values.batchGet each, paced at 40 Sheets reads a minute), and prints COUNTS only: no names of
 * candidates, no phones, no emails. Mentor names are printed (they are the team's own names).
 */
import "./server-only-shim";
import { parsePoolRows } from "@/lib/mobile/pool/parse";
import { bestOutcome, buildShares, outcomeOfValue, poolIndex, type ShareOutcome, SHARE_OUTCOMES } from "@/lib/mobile/pool/shares";
import { driveMeta, pacer, readCrpMaster, readSheet, SHEETS_PER_MINUTE } from "@/lib/mobile/pool/shares-sync";
import { poolSource } from "@/lib/pool/sources";
import { readTab } from "@/lib/pool/sync";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment */
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STATUS_WORD = /round|select|reject|clear|pend|sched|hold|show|join|offer|shortlist|wait|await|done|complet|interview|absent|fail|pass|process|progress|hire|place|attend|cancel|declin|^yes$|^no$|qualif|drop|next|result|submit/i;

async function main() {
  const maxArg = process.argv.indexOf("--max-sheets");
  const maxSheets = maxArg > 0 ? Number(process.argv[maxArg + 1]) : Infinity;
  const pace = pacer(SHEETS_PER_MINUTE);
  // --diag: how the round / final-status words of the matched rows were read (for tuning the rules).
  const diag = process.argv.includes("--diag");
  const values = new Map<string, number>();

  // 1. The assessed pool, as the 1.10.0 pool sync keeps it (every row with a UID).
  const src = poolSource("academy");
  await pace();
  const table = await readTab(src.spreadsheetId, src.tab);
  const parsed = parsePoolRows(table);
  const legacy = parsePoolRows(table, { assignedOnly: true });
  const assigned = parsed.rows.filter((r) => r.mentor);
  console.log(`pool tab: ${parsed.read} rows read; the pool would hold ${parsed.rows.length} assessed candidates (${assigned.length} assigned, ${parsed.rows.length - assigned.length} unassigned); today's rule keeps ${legacy.rows.length}; ${parsed.issues.length} row issues; ${parsed.rows.filter((r) => r.phone).length} with a phone, ${parsed.rows.filter((r) => r.email).length} with an email`);
  const idx = poolIndex(parsed.rows);
  const mentorOf = new Map(parsed.rows.map((r) => [r.uid, r.mentor.trim() || "(unassigned)"]));

  // 2. The CRPs master.
  const master = await readCrpMaster(pace);
  console.log(`CRPs: ${master.rows} rows, ${master.sheets.length} distinct company sheets, ${master.notSheetLinks} links that aren't Google Sheets, ${master.noLink} rows without a Company Sheet Link`);

  // 3. Every company sheet (read-only).
  let readable = 0;
  let noAccess = 0;
  let otherErrors = 0;
  let tabsRead = 0;
  let academyRows = 0;
  let rowsSeen = 0;
  let sheetsWithAcademy = 0;
  let unknownEmpty = 0;
  const errorKinds = new Map<string, number>();
  const shareOutcomes = new Map<ShareOutcome, number>();
  const sharesByUid = new Map<string, ShareOutcome[]>();
  const started = Date.now();
  for (const [i, sheet] of master.sheets.slice(0, maxSheets).entries()) {
    const meta = await driveMeta(sheet.sheetId);
    await sleep(150);
    if (!meta.ok && meta.noAccess) {
      noAccess++;
      errorKinds.set(meta.error.slice(0, 60), (errorKinds.get(meta.error.slice(0, 60)) ?? 0) + 1);
      continue;
    }
    try {
      const tabs = await readSheet(sheet.sheetId, pace);
      const built = buildShares(sheet, tabs, idx);
      readable++;
      tabsRead += built.tabsRead;
      academyRows += built.academyRows;
      rowsSeen += built.rowsSeen;
      if (built.shares.length) sheetsWithAcademy++;
      for (const s of built.shares) {
        shareOutcomes.set(s.outcome, (shareOutcomes.get(s.outcome) ?? 0) + 1);
        if (s.outcome === "unknown" && !s.rounds.length && !s.finalStatus) unknownEmpty++;
        sharesByUid.set(s.uid, [...(sharesByUid.get(s.uid) ?? []), s.outcome]);
        if (diag) {
          for (const v of [...s.rounds.map((r) => r.value), s.finalStatus].filter(Boolean)) {
            // Only status-like words (never free text such as a typed name, a number or an address).
            if (/\d|@|http/.test(v) || !STATUS_WORD.test(v)) continue;
            const k = `${v.toLowerCase().slice(0, 40)} → ${outcomeOfValue(v, "round")}`;
            values.set(k, (values.get(k) ?? 0) + 1);
          }
        }
      }
    } catch (err) {
      const e = err as { code?: number | string; message?: string };
      const code = Number(e?.code);
      if (code === 403 || code === 404) noAccess++;
      else otherErrors++;
      const kind = `${e?.code ?? ""} ${String(e?.message ?? err).replace(/[\w-]{25,}/g, "<id>").slice(0, 60)}`;
      errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
    }
    if ((i + 1) % 25 === 0) console.log(`  … ${i + 1} sheets checked (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  const checked = Math.min(master.sheets.length, maxSheets);
  console.log(`company sheets: ${checked} checked, ${readable} readable, ${noAccess + otherErrors} unreadable (${noAccess} no access, ${otherErrors} other errors) in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(`unreadable reasons: ${JSON.stringify([...errorKinds.entries()])}`);
  console.log(`candidate tabs read: ${tabsRead}; candidate rows seen: ${rowsSeen}; Academy rows matched: ${academyRows}; sheets with Academy candidates: ${sheetsWithAcademy}`);
  const shareTotal = [...shareOutcomes.values()].reduce((a, b) => a + b, 0);
  console.log(`shares (one per sheet, tab and candidate): ${shareTotal}; by outcome: ${JSON.stringify(Object.fromEntries(SHARE_OUTCOMES.map((o) => [o, shareOutcomes.get(o) ?? 0])))} (unknown with nothing filled in yet: ${unknownEmpty})`);
  const best = new Map<string, number>();
  for (const list of sharesByUid.values()) {
    const b = bestOutcome(list) ?? "none";
    best.set(b, (best.get(b) ?? 0) + 1);
  }
  console.log(`candidates shared at least once: ${sharesByUid.size} of ${parsed.rows.length}; by most advanced outcome: ${JSON.stringify(Object.fromEntries(best))}`);

  if (diag) console.log(`status words → outcome: ${JSON.stringify([...values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120))}`);

  // 4. Shared / never shared per mentor (the sheet's MENTOR names).
  const perMentor = new Map<string, { total: number; shared: number }>();
  for (const r of parsed.rows) {
    const m = mentorOf.get(r.uid)!;
    const x = perMentor.get(m) ?? { total: 0, shared: 0 };
    x.total++;
    if (sharesByUid.has(r.uid)) x.shared++;
    perMentor.set(m, x);
  }
  console.log("per mentor (total / shared / never shared):");
  for (const [m, x] of [...perMentor.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${m}: ${x.total} / ${x.shared} / ${x.total - x.shared}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
