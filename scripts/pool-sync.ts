/**
 * Eligible pool — sync from the command line (same code path as the dashboard).
 *
 *   npx tsx scripts/pool-sync.ts                      # every product, from its Google Sheet
 *   npx tsx scripts/pool-sync.ts edge2                # one product
 *   npx tsx scripts/pool-sync.ts academy --csv=file.csv   # one product, from a CSV export
 *
 * New people are added, changed records are overwritten, unchanged ones are left alone.
 */
import "./server-only-shim";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseCsv } from "@/lib/utils";
import { syncPool } from "@/lib/pool/sync";
import { poolSummary } from "@/lib/pool/queries";
import { PRODUCTS, PRODUCT_LABEL, type Product } from "@/lib/pool/types";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment (scheduler / deploy) */
}

async function main() {
  const args = process.argv.slice(2);
  const csv = args.find((a) => a.startsWith("--csv="))?.slice(6);
  const named = args.filter((a) => !a.startsWith("--")) as Product[];
  const products = named.length ? named : [...PRODUCTS];
  for (const p of products) if (!PRODUCTS.includes(p)) throw new Error(`Unknown product "${p}" — use ${PRODUCTS.join(", ")}.`);
  if (csv && products.length !== 1) throw new Error("--csv needs exactly one product.");

  for (const product of products) {
    const res = csv
      ? await syncPool(product, { mode: "csv", fileName: basename(csv), table: parseCsv(readFileSync(csv, "utf8")) }, "cli")
      : await syncPool(product, { mode: "sheet" }, "cli");
    console.log(
      `${PRODUCT_LABEL[product].padEnd(9)} ${res.ok ? "OK  " : "FAIL"} read ${res.rowsRead} · new ${res.inserted} · updated ${res.updated} · unchanged ${res.unchanged} · skipped ${res.skipped} · ${(res.ms / 1000).toFixed(1)} s${res.error ? ` — ${res.error}` : ""}`,
    );
    for (const i of res.issues.slice(0, 8)) console.log(`    row ${i.row}: ${i.problem}`);
    if (res.issues.length > 8) console.log(`    … ${res.issues.length - 8} more issue(s)`);
  }
  const s = await poolSummary();
  console.log(`\nPeople: ${s.people.total} (tier 1: ${s.people.byTier[1]}, tier 2: ${s.people.byTier[2]}, tier 3: ${s.people.byTier[3]}, tier 4: ${s.people.byTier[4]}; in 2+ products: ${s.people.inMoreThanOneProduct})`);
  for (const p of s.products) console.log(`  ${PRODUCT_LABEL[p.product].padEnd(9)} ${p.total} records, ${p.eligible} eligible — tiers ${JSON.stringify(p.byTier)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
