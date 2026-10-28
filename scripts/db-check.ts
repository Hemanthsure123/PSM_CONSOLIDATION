/**
 * Supabase Postgres — connection check. Read-only: it creates nothing and writes nothing.
 *
 *   npx tsx scripts/db-check.ts
 *
 * Checks DATABASE_URL (transaction pooler, app runtime) and DIRECT_URL (session pooler,
 * migrations) from .env.local:
 *  - password still "[YOUR-PASSWORD]": only checks that the host answers as Postgres
 *    with TLS (no login attempt, so no failed-auth lockout on the pooler);
 *  - password set: logs in over TLS and runs a read-only query.
 * Passwords are never printed.
 */
import net from "node:net";
import { Client } from "pg";

try {
  process.loadEnvFile(".env.local");
} catch {
  console.error("No .env.local in this folder — run from the project root.");
  process.exit(1);
}

const PLACEHOLDER = "[YOUR-PASSWORD]";
const TIMEOUT_MS = 10_000;

/** host:port, user and database of a URL — never the password. */
function describe(raw: string): { host: string; port: number; user: string; db: string; hasPassword: boolean } {
  // "[YOUR-PASSWORD]" isn't valid in a URL's userinfo; swap it out just to parse.
  const u = new URL(raw.replace(PLACEHOLDER, "placeholder"));
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username),
    db: u.pathname.replace(/^\//, "") || "postgres",
    hasPassword: !raw.includes(PLACEHOLDER) && Boolean(u.password),
  };
}

/** Does host:port speak Postgres with TLS? Sends only the SSLRequest packet — no login. */
function probeTls(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port, timeout: TIMEOUT_MS });
    s.once("connect", () => s.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
    s.once("data", (b) => {
      s.destroy();
      const answer = String.fromCharCode(b[0]);
      resolve(answer === "S" ? `reachable, Postgres with TLS (${Date.now() - t0} ms)` : `reachable, but TLS refused (answer "${answer}")`);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve("timed out");
    });
    s.once("error", (e: NodeJS.ErrnoException) => resolve(`unreachable (${e.code ?? e.message})`));
  });
}

async function query(url: string): Promise<string> {
  // Supabase requires TLS. Encrypted; the certificate chain isn't pinned to Supabase's CA here.
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: TIMEOUT_MS, statement_timeout: TIMEOUT_MS });
  const t0 = Date.now();
  try {
    await client.connect();
    const r = await client.query<{ db: string; usr: string; version: string; now: Date }>(
      "select current_database() as db, current_user as usr, split_part(version(), ' on ', 1) as version, now() as now",
    );
    const row = r.rows[0];
    return `connected in ${Date.now() - t0} ms — ${row.version}, database "${row.db}", user "${row.usr}", server time ${row.now.toISOString()}`;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const hint =
      err.code === "28P01" || /password authentication failed/i.test(err.message ?? "")
        ? " — wrong password (URL-encode special characters)"
        : /Tenant or user not found/i.test(err.message ?? "")
          ? " — the user must be postgres.<project-ref> on the pooler"
          : "";
    return `FAILED: ${err.code ? `${err.code} ` : ""}${(err.message ?? "unknown error").slice(0, 200)}${hint}`;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  let failed = false;
  for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const url = process.env[name]?.trim();
    if (!url) {
      console.log(`${name}: not set`);
      failed = true;
      continue;
    }
    let d: ReturnType<typeof describe>;
    try {
      d = describe(url);
    } catch {
      console.log(`${name}: not a valid postgresql:// URL`);
      failed = true;
      continue;
    }
    console.log(`${name}: ${d.user}@${d.host}:${d.port}/${d.db}`);
    const probe = await probeTls(d.host, d.port);
    console.log(`  network: ${probe}`);
    if (!probe.startsWith("reachable, Postgres")) {
      failed = true;
      continue;
    }
    if (!d.hasPassword) {
      console.log(`  login:   skipped — password not set yet (replace ${PLACEHOLDER} in .env.local)`);
      continue;
    }
    const res = await query(url);
    console.log(`  login:   ${res}`);
    if (res.startsWith("FAILED")) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

void main();
