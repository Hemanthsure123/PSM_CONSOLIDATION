import "server-only";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "@/lib/env";

/**
 * Postgres (Supabase) access for the server. One small pool per server process,
 * cached on globalThis so Next.js hot reloads don't open new pools.
 *
 * It connects through Supabase's TRANSACTION pooler (DATABASE_URL, port 6543): a
 * server connection is held only for one statement or one transaction, so the app
 * scales without exhausting Postgres connections. That mode has no session state, so:
 *  - queries are never named (pg then never prepares them);
 *  - multi-statement work goes through `transaction()` (BEGIN … COMMIT on one connection);
 *  - no session-level SET / advisory locks / LISTEN here — migrations use DIRECT_URL.
 * TLS is required by Supabase; the certificate isn't pinned to Supabase's CA.
 */

const g = globalThis as unknown as { __placementPool?: Pool };

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("The database isn't configured: set DATABASE_URL (with the password) in .env.local.");
    this.name = "DatabaseNotConfiguredError";
  }
}

export const databaseConfigured = () => env.database.configured;

function pool(): Pool {
  if (!env.database.configured) throw new DatabaseNotConfiguredError();
  if (!g.__placementPool) {
    const p = new Pool({
      connectionString: env.database.url,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
      statement_timeout: 60_000,
      query_timeout: 65_000,
      application_name: "placements-app",
    });
    // An idle client can drop (pooler restart, network); log it instead of crashing the process.
    p.on("error", (err) => console.warn("[db] idle client error:", err.message));
    g.__placementPool = p;
  }
  return g.__placementPool;
}

/** A database failure as a sentence for the screen (never the connection string or SQL). */
export function describeDbError(err: unknown): string {
  if (err instanceof DatabaseNotConfiguredError) return err.message;
  const e = err as { code?: string; message?: string };
  if (e?.code === "28P01") return "The database rejected the login — check the password in DATABASE_URL.";
  if (e?.code === "ENOTFOUND" || e?.code === "ECONNREFUSED" || e?.code === "ETIMEDOUT" || /timeout|terminated|ECONNRESET/i.test(e?.message ?? "")) {
    return "Can't reach the database right now — check the connection and try again.";
  }
  if (e?.code === "57014") return "The database took too long to answer — try again.";
  return "The database returned an error — try again.";
}

/** One statement, parameterised ($1, $2 …). */
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const res = await pool().query<T>(text, values);
  return res.rows;
}

/** Several statements as one unit: committed together or rolled back together. */
export async function transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const out = await work(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
