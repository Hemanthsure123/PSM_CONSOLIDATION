import type { Product } from "@/lib/pool/types";

/**
 * Where each product's eligible pool lives. The service account reads these sheets
 * (read-only). Override a source with POOL_<PRODUCT>_SHEET / POOL_<PRODUCT>_TAB if a
 * sheet moves (e.g. POOL_EDGE2_SHEET=<spreadsheet id or URL>).
 */
export interface PoolSource {
  spreadsheetId: string;
  tab: string;
  /** Edge 2.0 only: the PII tab that holds the reference resume link per phone / user id. */
  referenceTab?: string;
}

const DEFAULTS: Record<Product, PoolSource> = {
  edge2: {
    spreadsheetId: "1Mql2SPPBKcHaAuC7Y9gjJxMw1G--dcuPjySLgj_IDSg",
    tab: "Assessment Cleared- 2027 Pool",
    referenceTab: "All Assessment Cleared PII DATA - 2027",
  },
  edge1: { spreadsheetId: "15jQ2GDNF6a6omHS4jSiMC8xo2ZkdJqQbqWA9M8ovc2Y", tab: "Sheet2" },
  academy: { spreadsheetId: "1teoxNOaw3G3p446CV-kPbHbE-1iMcFLJCJ7CMsMsFGs", tab: "> 8LPA Assessed Pool" },
};

const idFrom = (v: string) => v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? v.trim();

export function poolSource(product: Product): PoolSource {
  const key = product.toUpperCase();
  const sheet = process.env[`POOL_${key}_SHEET`]?.trim();
  const tab = process.env[`POOL_${key}_TAB`]?.trim();
  return { ...DEFAULTS[product], ...(sheet ? { spreadsheetId: idFrom(sheet) } : {}), ...(tab ? { tab } : {}) };
}

export const sheetUrl = (s: PoolSource) => `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit`;
