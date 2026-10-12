"use server";

import { getBigQuery, qualifiedTable } from "@/lib/bigquery";
import { SEARCH_COLUMNS, SOURCE_TRACK_ID, alwaysFetchIds, getBqColumn } from "@/lib/columns";
import { coerceCell, normalizeIdentifier } from "@/lib/utils";
import type { ActionResult, IdentifierType } from "@/lib/types";

const BATCH_LIMIT = 5000;

/** SQL expression producing the normalized match key for a row. */
function rowKeyExpr(type: IdentifierType, column: string): string {
  switch (type) {
    case "email":
      return `LOWER(CAST(\`${column}\` AS STRING))`;
    case "phone":
      return `REGEXP_REPLACE(CAST(\`${column}\` AS STRING), r'[^0-9]', '')`;
    default:
      return `CAST(\`${column}\` AS STRING)`;
  }
}

export interface EnrichedRow {
  /** Raw source_track value (drives the dashboard). */
  sourceTrack: string;
  /** Selected BigQuery values, keyed by logical column id. */
  values: Record<string, string>;
}

export interface EnrichmentResult {
  /** Normalized-identifier → enriched data. */
  matches: Record<string, EnrichedRow>;
  /** How many distinct identifiers matched a BigQuery row. */
  matchedCount: number;
  /** How many distinct identifiers were queried. */
  queriedCount: number;
}

/**
 * Batch-enrich internal-sheet candidates from BigQuery. For every identifier we
 * read `source_track` (always — it powers the dashboard) plus the columns the
 * user ticked. Matching is done in a single parameterized query.
 */
export async function enrichFromBigQuery(
  identifiers: string[],
  type: IdentifierType,
  selectedBqColumnIds: string[],
  /** False when TR/assessment links come from the uploaded sheet — then there is
   *  no reason to query those columns at all. */
  includeReportLinks = true,
): Promise<ActionResult<EnrichmentResult>> {
  // Always include source_track (+ report-link columns unless sheet-sourced);
  // add the user's choices.
  const wantedIds = Array.from(
    new Set([...alwaysFetchIds(includeReportLinks), ...selectedBqColumnIds]),
  );
  const wantedCols = wantedIds
    .map((id) => getBqColumn(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  const idColumn = SEARCH_COLUMNS[type];

  // Dedupe normalized identifiers.
  const keys = Array.from(
    new Set(identifiers.map((v) => normalizeIdentifier(v, type)).filter(Boolean)),
  );
  if (keys.length === 0) {
    return { ok: false, error: "No valid identifiers to match against BigQuery." };
  }

  // SELECT only the identifier column + wanted columns (backtick-quoted because
  // the physical names contain spaces / symbols).
  const selectCols = Array.from(
    new Set([idColumn, ...wantedCols.map((c) => c.bq)]),
  )
    .map((name) => `\`${name}\` AS \`${name}\``)
    .join(", ");

  const sql = `
    SELECT ${selectCols}
    FROM ${qualifiedTable()}
    WHERE ${rowKeyExpr(type, idColumn)} IN UNNEST(@vals)
    LIMIT ${BATCH_LIMIT}
  `;

  try {
    const [rows] = await getBigQuery().query({
      query: sql,
      params: { vals: keys },
      types: { vals: ["STRING"] },
    });

    const matches: Record<string, EnrichedRow> = {};
    for (const raw of rows as Record<string, unknown>[]) {
      const key = normalizeIdentifier(coerceCell(raw[idColumn]), type);
      if (!key) continue;
      const values: Record<string, string> = {};
      for (const col of wantedCols) values[col.id] = coerceCell(raw[col.bq]);
      matches[key] = {
        sourceTrack: values[SOURCE_TRACK_ID] ?? "",
        values,
      };
    }

    return {
      ok: true,
      data: { matches, matchedCount: Object.keys(matches).length, queriedCount: keys.length },
    };
  } catch (err) {
    return { ok: false, error: describeBqError(err) };
  }
}

/** Turn raw BigQuery/auth errors into actionable operator messages. */
function describeBqError(err: unknown): string {
  console.error("[bigquery] error:", err);
  const message = err instanceof Error ? err.message : String(err);

  if (/invalid_grant|account not found|invalid.?jwt|invalid_rapt/i.test(message)) {
    return (
      "BigQuery authentication failed (invalid service-account credentials). " +
      "Check GCP_SERVICE_ACCOUNT_CLIENT_EMAIL and GCP_SERVICE_ACCOUNT_PRIVATE_KEY in .env.local."
    );
  }
  if (/Not found: Table|does not have|Permission|accessDenied|Unrecognized name/i.test(message)) {
    return (
      "BigQuery rejected the query — verify the dataset/table names, column names, " +
      `and that the service account has read access. (${message})`
    );
  }
  return `BigQuery enrichment failed: ${message}`;
}
