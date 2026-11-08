/**
 * Read-only check of the Academy priority pool's source (changes nothing):
 *   npx tsx scripts/pool-academy-check.ts
 * Reads the "> 8LPA Assessed Pool" tab exactly as the server does and prints how many mentored rows
 * it finds per mentor and track, and the row problems. No candidate details are printed.
 */
import "./server-only-shim";
import { parsePoolRows } from "@/lib/mobile/pool/parse";
import { POOL_SHEET } from "@/lib/mobile/pool/sync";
import { readTab } from "@/lib/pool/sync";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment */
}

async function main() {
  const table = await readTab(POOL_SHEET.spreadsheetId, POOL_SHEET.tab);
  const r = parsePoolRows(table);
  const by = (k: (x: (typeof r.rows)[number]) => string) =>
    Object.entries(r.rows.reduce<Record<string, number>>((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  console.log(`rows with a UID or mentor: ${r.read}; mentored (in the pool): ${r.rows.length}`);
  console.log("per mentor:", by((x) => x.mentor));
  console.log("per track:", by((x) => x.track ?? `(other: ${x.techStack ?? "blank"})`));
  console.log(`with email: ${r.rows.filter((x) => x.email).length}, with phone: ${r.rows.filter((x) => x.phone).length}`);
  console.log(`row problems: ${r.issues.length}`, r.issues.slice(0, 20));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
