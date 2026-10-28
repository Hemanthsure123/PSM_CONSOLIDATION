/**
 * Database migrations — applies db/migrations/*.sql in name order, once each.
 *
 *   npx tsx scripts/db-migrate.ts            # apply pending migrations
 *   npx tsx scripts/db-migrate.ts --status   # list applied / pending, change nothing
 *
 * Runs over DIRECT_URL (the session pooler: full sessions, DDL, advisory locks). Each
 * migration runs in its own transaction and is recorded with a checksum in
 * placement.schema_migrations; an applied migration whose file changed afterwards is
 * reported and stops the run (write a new migration instead of editing an old one).
 * A session advisory lock keeps two runs from migrating at the same time.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment (CI / deploy) */
}

const DIR = join(process.cwd(), "db", "migrations");
const LOCK_KEY = 74_210_001; // any constant; shared by every migration run

async function main() {
  const statusOnly = process.argv.includes("--status");
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url || url.includes("[YOUR-PASSWORD]")) throw new Error("Set DIRECT_URL (or DATABASE_URL) with the database password in .env.local.");

  const files = readdirSync(DIR)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query("create schema if not exists placement");
    await client.query(
      "create table if not exists placement.schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now())",
    );
    const applied = new Map((await client.query<{ version: string; checksum: string }>("select version, checksum from placement.schema_migrations")).rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = readFileSync(join(DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
      const version = file.replace(/\.sql$/, "");
      const done = applied.get(version);
      if (done) {
        if (done !== checksum) throw new Error(`${file} was changed after it was applied (checksum ${done} → ${checksum}). Add a new migration instead.`);
        console.log(`  applied  ${file}`);
        continue;
      }
      if (statusOnly) {
        console.log(`  PENDING  ${file}`);
        continue;
      }
      const t0 = Date.now();
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into placement.schema_migrations (version, checksum) values ($1, $2)", [version, checksum]);
        await client.query("commit");
        console.log(`  APPLIED  ${file} (${Date.now() - t0} ms)`);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`${file} failed and was rolled back: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
