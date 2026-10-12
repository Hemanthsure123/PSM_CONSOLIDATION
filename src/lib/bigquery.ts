import "server-only";
import { BigQuery } from "@google-cloud/bigquery";
import { env } from "@/lib/env";

/**
 * Lazily-constructed singleton BigQuery client.
 *
 * - Lazy: the client (and its env validation) is created on first use, not at
 *   import — so `next build` can import this module without credentials.
 * - Singleton: stashed on `globalThis` so Next.js hot reloads in dev don't
 *   spawn a new client (and connection pool) every reload.
 */
const globalForBq = globalThis as unknown as { bigquery?: BigQuery };

export function getBigQuery(): BigQuery {
  if (!globalForBq.bigquery) {
    globalForBq.bigquery = new BigQuery({
      projectId: env.gcp.projectId,
      credentials: {
        client_email: env.gcp.clientEmail,
        private_key: env.gcp.privateKey,
      },
    });
  }
  return globalForBq.bigquery;
}

/** Fully-qualified, backtick-quoted table reference for use in SQL. */
export function qualifiedTable(): string {
  return `\`${env.gcp.projectId}.${env.gcp.datasetId}.${env.gcp.tableId}\``;
}
