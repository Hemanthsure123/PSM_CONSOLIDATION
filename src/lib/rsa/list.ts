import "server-only";
import { query } from "@/lib/db/client";
import { docMetaFor, driveFileId } from "@/lib/mobile/preps/links";
import { normRound } from "@/lib/mobile/preps/parse";
import { sheetDate } from "@/lib/rsa/model";
import { rsaEntriesForPhone, sameDoc } from "@/lib/rsa/sheet";

/**
 * A candidate's past RSA documents, shown with their interviews (a prep's page, an Academy pool
 * candidate): the RSA sheet's rows for their phone and the documents the app wrote. Also the app's
 * RSAs for a job + round, which prep documents read as company-specific hiring intelligence.
 */

/** A past RSA of the candidate (the RSA sheet, plus documents written by the app). */
export interface RsaListItemDto {
  url: string;
  title: string;
  company: string;
  round: string;
  /** "15-Nov-2026" as in the sheet, or "" when unknown. */
  date: string;
  /** This prep's own RSA. */
  own: boolean;
}

// ── Past RSAs (shown next to a candidate's interviews) ──────────────────────

/** A candidate's RSA documents, newest first: the RSA sheet's rows for their phone, and the app's own. */
export async function rsaDocumentsForPhone(phone: string, ownKey?: string): Promise<RsaListItemDto[]> {
  if (!/^\d{10}$/.test(phone)) return [];
  const [entries, mine] = await Promise.all([
    rsaEntriesForPhone(phone).catch((err) => {
      console.warn("[rsa] sheet not read:", err instanceof Error ? err.message.slice(0, 160) : err);
      return [];
    }),
    query<{ prep_key: string; url: string; title: string; company: string; round: string; created_at: Date }>(
      "select prep_key, url, title, company, round, created_at from app.rsa_documents where phone = $1 order by created_at desc limit 30",
      [phone],
    ).catch(() => []),
  ]);
  const out: RsaListItemDto[] = mine.map((m) => ({ url: m.url, title: m.title, company: m.company, round: m.round, date: sheetDate(m.created_at), own: m.prep_key === ownKey }));
  const meta = await docMetaFor(entries.filter((e) => !out.some((o) => sameDoc(o.url, e.url))).map((e) => e.url)).catch(() => new Map());
  for (const e of entries) {
    if (out.some((o) => sameDoc(o.url, e.url))) continue;
    const m = meta.get(driveFileId(e.url) ?? "");
    out.push({ url: e.url, title: m?.name || `RSA · ${e.company || "Interview"}`, company: e.company, round: roundIn(m?.name ?? ""), date: e.date, own: false });
  }
  return out.slice(0, 30);
}

/** "TR1" / "HR" / "Round 2" in a document name, or "". */
export function roundIn(name: string): string {
  // "_" counts as a word character, so the edges are spelled out ("…_Acme_TR1_15-Nov…").
  const m = name.match(/(?:^|[^a-z0-9])(TR\s*-?\s*\d|HR|MR|CTO|Round\s*\d|Technical\s*Round\s*\d)(?=$|[^a-z0-9])/i);
  return m ? normRound(m[1]) : "";
}

/** For prep documents: the app's RSAs for a job + round (company- and round-specific hiring intelligence). */
export async function rsaDocsForRound(jobKey: string, roundKey: string): Promise<{ url: string; title: string; candidate: string; updatedAt: string }[]> {
  const rows = await query<{ url: string; title: string; candidate: string; updated_at: Date }>(
    "select url, title, candidate, updated_at from app.rsa_documents where job_key = $1 and round_key = $2 order by updated_at desc limit 20",
    [jobKey, roundKey],
  ).catch(() => []);
  return rows.map((r) => ({ url: r.url, title: r.title, candidate: r.candidate, updatedAt: r.updated_at.toISOString() }));
}
