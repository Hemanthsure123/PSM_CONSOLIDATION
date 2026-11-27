import "server-only";
import { query } from "@/lib/db/client";
import { requirementsBySheet, shareCompanyOf } from "@/lib/mobile/pool/requirements-store";
import { academySchemaReady, companiesSchemaReady, isMissingSchema } from "@/lib/mobile/pool/schema";
import { byActivity, ownStatusOf, type ShareDto, shareDto, type ShareRowLike, type ShareStatus } from "@/lib/mobile/pool/shares";

/**
 * What the app reads about company shares (app.company_shares, written by shares-sync.ts). Null when
 * migration 020 isn't applied or the shares were never synced, so the app can tell "never shared"
 * from "not known yet".
 */

export interface ShareRow {
  uid: string;
  dto: ShareDto;
  /** The candidate's own status in the tab, before the requirement's state ("shared": nothing filled in). */
  own: ShareStatus;
  /** The master's Final Status for the company (a closed requirement isn't an active share). */
  masterFinalStatus: string;
}

/** When the company sheets were last synced successfully (null: never, or no migration 020). */
export async function lastSharesSync(): Promise<Date | null> {
  if (!(await academySchemaReady().catch(() => false))) return null;
  try {
    const rows = await query<{ at: Date | null }>("select max(finished_at) as at from app.company_share_syncs where status = 'succeeded'");
    return rows[0]?.at ?? null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

/** Active shares per pool UID, newest activity first ([uids]: only these). Null: never synced. */
export async function sharesByUid(uids?: string[]): Promise<Map<string, ShareRow[]> | null> {
  if (!(await lastSharesSync())) return null;
  const withStatus = await companiesSchemaReady().catch(() => false);
  const [rows, bySheet] = await Promise.all([
    query<ShareRowLike & { uid: string; master_final_status: string }>(
      `select s.id::text as id, s.sheet_id, s.tab, s.tab_gid, s.uid, s.company, s.role, s.rounds, s.final_status, s.stage, s.outcome,
              ${withStatus ? "s.status," : ""} s.first_seen_at, s.changed_at, c.master_final_status
         from app.company_shares s join app.company_sheets c on c.sheet_id = s.sheet_id
        where s.removed_at is null${uids ? " and s.uid = any($1::text[])" : ""}`,
      uids ? [uids] : [],
    ),
    requirementsBySheet(),
  ]);
  rows.sort(byActivity);
  const out = new Map<string, ShareRow[]>();
  for (const r of rows) {
    const list = out.get(r.uid) ?? [];
    const company = shareCompanyOf(r, bySheet, r.master_final_status ?? "");
    list.push({ uid: r.uid, dto: shareDto(r, company), own: ownStatusOf(r).status, masterFinalStatus: r.master_final_status ?? "" });
    out.set(r.uid, list);
  }
  return out;
}
