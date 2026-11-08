/**
 * Read-only check of the Academy priority pool as the server sees it (changes nothing):
 *   npx tsx scripts/pool-academy-live.ts
 * Prints the last sheet copies, how many candidates each mentor gets (matched to the roster), how
 * many have marks and interviews, and what one mentor's list would contain. No names or phones.
 */
import "./server-only-shim";
import { query } from "@/lib/db/client";
import { listPool } from "@/lib/mobile/pool/service";
import { listRoster } from "@/lib/mobile/roster";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment */
}

async function main() {
  const syncs = await query<{ started_at: Date; status: string; active: number; added: number; updated: number; removed: number; triggered_by: string; error: string | null }>(
    "select started_at, status, active, added, updated, removed, triggered_by, error from app.pool_syncs order by started_at desc limit 3",
  );
  console.log("last sheet copies:", syncs.map((s) => ({ at: s.started_at.toISOString(), status: s.status, active: s.active, added: s.added, by: s.triggered_by, error: s.error })));
  const roster = await listRoster();
  for (const u of roster.filter((r) => r.active)) {
    const { body } = await listPool(u);
    const items = body.items;
    console.log(
      `${u.name} (${u.role}): sees ${items.length} (scope ${body.scope}); with marks ${items.filter((i) => i.assessments > 0).length}; ` +
        `with interviews ${items.filter((i) => (i.interviews?.count ?? 0) > 0).length}; interviews readable ${body.interviewsAvailable}; ` +
        `tracks ${JSON.stringify(items.reduce<Record<string, number>>((m, i) => ((m[i.track ?? "none"] = (m[i.track ?? "none"] ?? 0) + 1), m), {}))}` +
        (body.unmatchedMentors.length ? `; unmatched mentors ${JSON.stringify(body.unmatchedMentors)}` : ""),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
