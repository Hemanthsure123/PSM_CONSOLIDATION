/**
 * Prep kit — read-only check against the real sheets (writes nothing, prints no secrets):
 *   npx tsx scripts/prepkit-check.ts [count]
 * For the latest drill-down rows: the candidate email lookup (company sheet, then internal assessments, then resume; emails are
 * masked), the drill-downs / transcripts a prep document would be built from, and whether the
 * team Google account and Notion are set up.
 */
import "./server-only-shim";

try {
  process.loadEnvFile(".env.local");
} catch {
  console.error("No .env.local in this folder — run from the project root.");
  process.exit(1);
}

const mask = (e: string | null) => (e ? e.replace(/^(.).*?(@.*)$/, "$1***$2") : "-");

async function main() {
  const count = Math.max(1, Math.min(40, Number(process.argv[2] ?? 15)));
  const { readPrepSnapshot } = await import("@/lib/mobile/preps/sheet");
  const { findCandidateEmail } = await import("@/lib/team/contacts");
  const { linksFor } = await import("@/lib/mobile/preps/service");
  const { teamConfig } = await import("@/lib/team/google");
  const { notionConfigured } = await import("@/lib/team/notion");

  const c = teamConfig();
  console.log(`Team Google account: ${c.account || "(not set)"} · OAuth client ${c.configured ? "set" : "missing"}`);
  console.log(`Notion: ${notionConfigured() ? "token + parent page set" : "not set"}`);

  const snap = await readPrepSnapshot();
  console.log(`Drill-down source: ${snap.tab} (${snap.preps.length} rows)`);
  const rows = snap.preps.filter((p) => p.jobId).slice(-count);
  const tally = new Map<string, number>();
  const started = Date.now();
  for (const p of rows) {
    const r = await findCandidateEmail(p.jobId, { name: p.candidate, phone: p.phone, resumeUrl: p.resumeUrl });
    const k = r.matchedBy ? `${r.status} via ${r.matchedBy}` : r.status;
    tally.set(k, (tally.get(k) ?? 0) + 1);
    const sameJob = snap.preps.filter((x) => x.jobId === p.jobId);
    const links = linksFor(p, sameJob);
    console.log(
      `row ${String(p.row).padStart(5)} · ${p.company.slice(0, 28).padEnd(28)} · ${(p.round || "-").slice(0, 10).padEnd(10)} · email ${r.status.padEnd(16)} ${mask(r.email).padEnd(26)} by ${r.matchedBy ?? "-"} · sources ${links.filter((l) => l.kind === "drilldown").length} drill-down / ${links.filter((l) => l.kind === "transcript").length} transcript`,
    );
  }
  console.log(`\nEmail lookup: ${[...tally.entries()].map(([k, v]) => `${k} ${v}`).join(", ")} · ${((Date.now() - started) / 1000).toFixed(1)} s for ${rows.length}`);
}

main().catch((err) => {
  console.error("Check failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
