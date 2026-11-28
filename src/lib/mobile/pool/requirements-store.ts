import "server-only";
import { query } from "@/lib/db/client";
import type { RequirementRecord } from "@/lib/mobile/pool/companies-model";
import { companiesSchemaReady } from "@/lib/mobile/pool/schema";
import { combinedState, type MasterState, masterClosed, pickRequirement, requirementState, type ShareCompany } from "@/lib/mobile/pool/shares";

/**
 * The CRPs master's requirement rows as stored by the hourly sync (migration 022), and the company
 * state a share is read with: its requirement's (when the tab names it), else the whole sheet's.
 */

interface ReqRow {
  key: string;
  row_index: number;
  sheet_id: string | null;
  company: string;
  role: string;
  job_id: string;
  job_type: string;
  crp_month: string;
  crp_year: number | null;
  crp_week: number | null;
  openings: number | null;
  ctc_text: string;
  final_status: string;
  stage: string;
  id_status: string;
  academy_sent: number | null;
  assessed_sent: number | null;
  non_assessed_sent: number | null;
  requested: string;
  tech_stack: string;
  pass_out: string;
  interview_process: string;
  ise: string;
  crm: string;
  jd_url: string | null;
  hubspot_url: string | null;
  hubspot_deal_id: string | null;
  /** Migration 023. */
  internal_sheet_id?: string | null;
  id_month?: string;
  id_year?: number | null;
}

const toReq = (r: ReqRow): RequirementRecord => ({
  key: r.key,
  rowIndex: r.row_index,
  sheetId: r.sheet_id,
  company: r.company,
  role: r.role,
  jobId: r.job_id,
  jobType: r.job_type,
  crpMonth: r.crp_month,
  crpYear: r.crp_year,
  crpWeek: r.crp_week,
  openings: r.openings,
  ctcText: r.ctc_text,
  finalStatus: r.final_status,
  stage: r.stage,
  idStatus: r.id_status,
  academySent: r.academy_sent,
  assessedSent: r.assessed_sent,
  nonAssessedSent: r.non_assessed_sent,
  requested: r.requested,
  techStack: r.tech_stack,
  passOut: r.pass_out,
  interviewProcess: r.interview_process,
  ise: r.ise,
  crm: r.crm,
  jdUrl: r.jd_url,
  hubspotUrl: r.hubspot_url,
  hubspotDealId: r.hubspot_deal_id,
  internalSheetId: r.internal_sheet_id ?? null,
  idMonth: r.id_month ?? "",
  idYear: r.id_year ?? null,
});

export async function loadRequirements(): Promise<RequirementRecord[]> {
  return (await query<ReqRow>("select * from app.crp_requirements order by row_index")).map(toReq);
}


const g = globalThis as unknown as { __reqBySheet?: { at: number; map: Map<string, RequirementRecord[]> | null } };

/** Requirements per company sheet (cached 60 s); null before migration 022. */
export async function requirementsBySheet(): Promise<Map<string, RequirementRecord[]> | null> {
  const hit = g.__reqBySheet;
  if (hit && Date.now() - hit.at < 60_000) return hit.map;
  let map: Map<string, RequirementRecord[]> | null = null;
  if (await companiesSchemaReady().catch(() => false)) {
    map = new Map();
    for (const r of await loadRequirements()) if (r.sheetId) map.set(r.sheetId, [...(map.get(r.sheetId) ?? []), r]);
  }
  g.__reqBySheet = { at: Date.now(), map };
  return map;
}

/**
 * The company a share is read with. [masterFinalStatus] (company_sheets, " / "-joined) is the
 * fallback before migration 022 or for a sheet the master no longer lists.
 */
export function shareCompanyOf(
  share: { sheet_id: string; tab: string; role: string },
  bySheet: Map<string, RequirementRecord[]> | null,
  masterFinalStatus: string,
): ShareCompany {
  const reqs = bySheet?.get(share.sheet_id) ?? [];
  if (reqs.length) {
    const req = pickRequirement({ tab: share.tab, role: share.role }, reqs);
    if (req) return { state: requirementState(req.finalStatus, req.stage, req.idStatus), statusText: req.finalStatus };
    const states = reqs.map((r) => requirementState(r.finalStatus, r.stage, r.idStatus));
    return { state: combinedState(states), statusText: [...new Set(reqs.map((r) => r.finalStatus).filter(Boolean))].join(" / ") };
  }
  const parts = masterFinalStatus.split(" / ").map((p) => p.trim()).filter(Boolean);
  const state: MasterState = !parts.length ? "unknown" : masterClosed(masterFinalStatus) ? "closed" : combinedState(parts.map((p) => requirementState(p)));
  return { state, statusText: masterFinalStatus };
}
