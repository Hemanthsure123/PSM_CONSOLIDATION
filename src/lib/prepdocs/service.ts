import "server-only";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { docMetaFor, driveFileId } from "@/lib/mobile/preps/links";
import { normRound, type PrepRow } from "@/lib/mobile/preps/parse";
import { type DocLinkDto, linksFor } from "@/lib/mobile/preps/service";
import { readPrepSnapshot, writePrepCells } from "@/lib/mobile/preps/sheet";
import { pushToUser } from "@/lib/mobile/push";
import type { RosterUser } from "@/lib/mobile/roster";
import { generatePrepDoc, research } from "@/lib/prepdocs/generate";
import { type PrepDoc, SECTION_IDS, SECTION_LABEL, type SectionId, selectSections } from "@/lib/prepdocs/model";
import { renderHtml, renderNotionBlocks } from "@/lib/prepdocs/render";
import { readSources } from "@/lib/prepdocs/sources";
import { createGoogleDoc, findPrepDoc, readGoogleDocText, replaceGoogleDoc, shareViewOnly } from "@/lib/team/drive";
import { teamStatus } from "@/lib/team/google";
import { createNotionPage, notionConfigured, readNotionText, replaceNotionPage } from "@/lib/team/notion";

/**
 * Prep documents per job (or company when a row has no job id) and round: create or update, the
 * sources they were built from, whether newer interview intelligence exists, and the background
 * runs that write them (a document takes about a minute: reading sources, research, writing).
 */

export type DocKind = "gdoc" | "notion";

export interface DocSource {
  url: string;
  kind: "drilldown" | "transcript" | "website";
  title: string;
  modifiedAt: string | null;
}

export interface PrepDocumentDto {
  id: string;
  kind: DocKind;
  url: string;
  title: string;
  version: number;
  round: string;
  updatedAt: string;
  updatedBy: string;
  sections: string[];
  status: "up_to_date" | "update_available";
  /** Why an update is available: "Stan TR1 drill-down changed on 8 Nov", "New transcript". */
  reasons: string[];
  lastChanges: string[];
  unverified: string[];
}

interface DocRow {
  id: string;
  job_key: string;
  company: string;
  round: string;
  round_key: string;
  kind: DocKind;
  external_id: string;
  url: string;
  title: string;
  version: number;
  sources: DocSource[];
  sections: string[];
  inputs: { website?: string | null; linkedin?: string | null };
  last_changes: string[];
  unverified: string[];
  content: PrepDoc | null;
  updated_by: string;
  updated_at: Date;
}

export const jobKeyOf = (p: Pick<PrepRow, "jobId" | "company">) => p.jobId || `company:${p.company.toLowerCase().replace(/\s+/g, " ").trim()}`;
export const roundKeyOf = (round: string) => normRound(round).toLowerCase().replace(/\s+/g, "");

async function loadPrep(key: string) {
  const snap = await readPrepSnapshot();
  const p = snap.byKey.get(key);
  if (!p) throw new UserError(404, "This prep is no longer in the drill-down sheet.", "not_found");
  const sameJob = p.jobId ? snap.preps.filter((r) => r.jobId === p.jobId) : snap.preps.filter((r) => r.company === p.company);
  return { p, sameJob };
}

/** The drill-downs and transcripts for the job, with their names and last-change times. */
async function sourcesFor(p: PrepRow, sameJob: PrepRow[]): Promise<DocLinkDto[]> {
  const links = linksFor(p, sameJob);
  const meta = await docMetaFor(links.map((l) => l.url));
  for (const l of links) {
    const m = meta.get(driveFileId(l.url) ?? "");
    if (m) {
      l.title = m.name;
      l.updatedAt = m.modifiedAt;
    }
  }
  return links.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function toDto(r: DocRow, available: DocLinkDto[]): PrepDocumentDto {
  const reasons: string[] = [];
  const used = new Map(r.sources.map((s) => [s.url, s]));
  for (const a of available) {
    const before = used.get(a.url);
    const name = a.title || (a.kind === "transcript" ? "A transcript" : "A drill-down");
    if (!before) reasons.push(`New ${a.kind === "transcript" ? "transcript" : "drill-down"}: ${name}`);
    else if (a.updatedAt && before.modifiedAt && a.updatedAt > before.modifiedAt) reasons.push(`${name} changed on ${a.updatedAt.slice(0, 10)}`);
  }
  return {
    id: r.id,
    kind: r.kind,
    url: r.url,
    title: r.title,
    version: r.version,
    round: r.round,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by,
    sections: r.sections,
    status: reasons.length ? "update_available" : "up_to_date",
    reasons: reasons.slice(0, 8),
    lastChanges: r.last_changes ?? [],
    unverified: r.unverified ?? [],
  };
}

export async function documentsFor(jobKey: string, roundKey: string): Promise<DocRow[]> {
  return query<DocRow>(
    `select id, job_key, company, round, round_key, kind, external_id, url, title, version, sources, sections, inputs, last_changes, unverified,
            content, updated_by, updated_at from app.prep_documents where job_key = $1 and round_key = $2 order by kind`,
    [jobKey, roundKey],
  );
}

/** The prep document overview: existing documents (with staleness), the sources to pick from, last inputs. */
export async function prepDocsOverview(key: string) {
  const { p, sameJob } = await loadPrep(key);
  const [available, docs, team, run] = await Promise.all([
    sourcesFor(p, sameJob),
    documentsFor(jobKeyOf(p), roundKeyOf(p.round)),
    teamStatus().catch(() => null),
    latestRun(jobKeyOf(p), roundKeyOf(p.round)),
  ]);
  const inputs = docs.find((d) => d.inputs?.website || d.inputs?.linkedin)?.inputs ?? {};
  return {
    company: p.company,
    round: p.round,
    documents: docs.map((d) => toDto(d, available)),
    sources: available,
    sections: SECTION_IDS.map((id) => ({ id, label: SECTION_LABEL[id] })),
    website: inputs.website ?? "",
    linkedin: inputs.linkedin ?? "",
    google: team ? { connected: team.connected, account: team.account, status: team.status } : { connected: false, account: "", status: "not_configured" },
    notion: { configured: notionConfigured() },
    run,
  };
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export interface RunDto {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  step: string;
  error: string | null;
  mode: "create" | "update";
  kind: DocKind;
  result: { documentId: string; url: string; title: string; changes: string[]; unverified: string[]; sections: string[]; model: string; skipped: string[] } | null;
  createdAt: string;
}

async function latestRun(jobKey: string, roundKey: string): Promise<RunDto | null> {
  const rows = await query<{ id: string }>(
    "select id from app.prep_doc_runs where job_key = $1 and round_key = $2 and created_at > now() - interval '1 day' order by created_at desc limit 1",
    [jobKey, roundKey],
  );
  return rows[0] ? getRun(rows[0].id) : null;
}

export async function getRun(id: string): Promise<RunDto | null> {
  const rows = await query<{ id: string; status: RunDto["status"]; step: string; error: string | null; mode: RunDto["mode"]; kind: DocKind; result: RunDto["result"]; created_at: Date; updated_at: Date }>(
    "select id, status, step, error, mode, kind, result, created_at, updated_at from app.prep_doc_runs where id = $1",
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  // A run the server lost (a restart mid-run) is reported as failed, not "running" forever.
  if ((r.status === "running" || r.status === "queued") && Date.now() - r.updated_at.getTime() > 15 * 60_000) {
    await query("update app.prep_doc_runs set status = 'failed', error = 'The server restarted while writing. Start again.', updated_at = now() where id = $1", [id]);
    return { id, status: "failed", step: r.step, error: "The server restarted while writing. Start again.", mode: r.mode, kind: r.kind, result: null, createdAt: r.created_at.toISOString() };
  }
  return { id: r.id, status: r.status, step: r.step, error: r.error, mode: r.mode, kind: r.kind, result: r.result, createdAt: r.created_at.toISOString() };
}

export interface StartBody {
  kind?: unknown;
  sources?: unknown;
  website?: unknown;
  linkedin?: unknown;
  sections?: unknown;
}

const cleanUrl = (v: unknown) => {
  const s = String(v ?? "").trim();
  return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 500) : null;
};

/** Starts creating (or updating) the job + round's document of [kind]; the work runs in the background. */
export async function startDocRun(user: RosterUser, key: string, body: StartBody): Promise<RunDto> {
  const kind: DocKind = body.kind === "notion" ? "notion" : "gdoc";
  if (kind === "notion" && !notionConfigured()) throw new UserError(503, "Notion isn't set up on the server yet.", "notion_not_configured");
  if (kind === "gdoc") {
    const team = await teamStatus();
    if (!team.connected) throw new UserError(503, `Connect the team Google account (${team.account || "not set"}) first: an admin can do it in Me → Team.`, "team_not_connected");
  }
  const { p, sameJob } = await loadPrep(key);
  const available = await sourcesFor(p, sameJob);
  const picked = Array.isArray(body.sources) ? body.sources.map(String) : available.map((a) => a.url);
  const chosen = available.filter((a) => picked.includes(a.url));
  const website = cleanUrl(body.website);
  const linkedin = cleanUrl(body.linkedin);
  if (!chosen.length && !website) throw new UserError(422, "Pick at least one drill-down, transcript or the company website.", "no_sources");
  const sections = (Array.isArray(body.sections) ? body.sections.map(String) : [...SECTION_IDS]).filter((s): s is SectionId => (SECTION_IDS as readonly string[]).includes(s));
  if (!sections.includes("topics")) throw new UserError(422, "Keep the topic sections: they hold the interview questions.", "invalid_sections");
  const jobKey = jobKeyOf(p);
  const roundKey = roundKeyOf(p.round);
  const busy = await query<{ id: string }>(
    "select id from app.prep_doc_runs where job_key = $1 and round_key = $2 and kind = $3 and status in ('queued', 'running') and updated_at > now() - interval '15 minutes'",
    [jobKey, roundKey, kind],
  );
  if (busy.length) return (await getRun(busy[0].id))!;
  const existing = (await documentsFor(jobKey, roundKey)).find((d) => d.kind === kind);
  const request = { prepKey: key, sources: chosen.map((c) => ({ url: c.url, kind: c.kind })), website, linkedin, sections };
  const rows = await query<{ id: string }>(
    `insert into app.prep_doc_runs (document_id, job_key, round_key, kind, mode, status, step, request, requested_by)
     values ($1, $2, $3, $4, $5, 'queued', 'Waiting to start', $6, $7) returning id`,
    [existing?.id ?? null, jobKey, roundKey, kind, existing ? "update" : "create", request, user.email],
  );
  const id = rows[0].id;
  void runDoc(id, user, p, sameJob, kind, request).catch((err) => console.error("[prep-docs] run crashed:", err instanceof Error ? err.message : err));
  return (await getRun(id))!;
}

async function step(id: string, text: string) {
  await query("update app.prep_doc_runs set status = 'running', step = $2, updated_at = now() where id = $1", [id, text]);
}

async function runDoc(
  id: string,
  user: RosterUser,
  p: PrepRow,
  sameJob: PrepRow[],
  kind: DocKind,
  request: { sources: { url: string; kind: "drilldown" | "transcript" }[]; website: string | null; linkedin: string | null; sections: SectionId[] },
): Promise<void> {
  try {
    await step(id, "Reading the drill-downs and transcripts");
    const names = [...new Set(sameJob.map((r) => r.candidate))];
    const sources = await readSources(request.sources, request.website, names);
    const usable = sources.filter((s) => s.text.trim());
    if (!usable.length) throw new Error(`None of the chosen sources could be read (${sources.map((s) => s.error).filter(Boolean).join("; ").slice(0, 200)}).`);

    const jobKey = jobKeyOf(p);
    const roundKey = roundKeyOf(p.round);
    const existing = (await documentsFor(jobKey, roundKey)).find((d) => d.kind === kind) ?? null;
    let existingText: string | null = null;
    let adopt: { id: string; url: string } | null = null;
    if (existing) {
      await step(id, "Reading the current document");
      existingText = kind === "gdoc" ? await readGoogleDocText(existing.external_id).catch(() => null) : await readNotionText(existing.external_id).catch(() => null);
    } else if (kind === "gdoc") {
      // The prompt's rule: never create a duplicate — adopt a document already in the folder.
      adopt = await findPrepDoc(p.company, normRound(p.round)).catch(() => null);
      if (adopt) existingText = await readGoogleDocText(adopt.id).catch(() => null);
    }

    // "Stan - SDE Intern" → company "Stan", role "SDE Intern".
    const [companyName, ...roleParts] = p.company.split(/\s+-\s+/);
    const company = companyName.trim() || p.company;
    const role = roleParts.join(" - ").trim();

    await step(id, "Researching the company");
    const notes = await research(company, role, normRound(p.round), request.website);

    await step(id, "Writing the document");
    const out = await generatePrepDoc({
      company,
      role,
      round: normRound(p.round),
      process: p.process,
      websiteUrl: request.website,
      linkedinUrl: request.linkedin,
      sources,
      research: notes,
      existingText,
    });
    if ("error" in out) throw new Error(out.error);
    const doc = selectSections(out.doc, request.sections);
    if (request.linkedin && !doc.links.some((l) => l.url === request.linkedin)) doc.links.push({ label: "LinkedIn", url: request.linkedin });
    if (request.website && !doc.links.some((l) => l.url === request.website)) doc.links.unshift({ label: "Website", url: request.website });

    await step(id, kind === "gdoc" ? "Saving to Google Docs" : "Saving to Notion");
    let saved: { id: string; url: string };
    if (kind === "gdoc") {
      const target = existing?.external_id ?? adopt?.id;
      saved = target ? await replaceGoogleDoc(target, doc.title, renderHtml(doc)) : await createGoogleDoc(doc.title, renderHtml(doc));
      await step(id, "Sharing (view-only link)");
      await shareViewOnly(saved.id);
    } else {
      saved = existing ? await replaceNotionPage(existing.external_id, doc.title, renderNotionBlocks(doc)) : await createNotionPage(doc.title, renderNotionBlocks(doc));
    }

    const used: DocSource[] = sources.filter((s) => s.text.trim()).map((s) => ({ url: s.url, kind: s.kind, title: s.title, modifiedAt: s.modifiedAt }));
    const rows = await query<{ id: string }>(
      `insert into app.prep_documents (job_key, company, round, round_key, kind, external_id, url, title, version, sources, sections, inputs, last_changes, unverified, content, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, $13, $14, $15, $15)
       on conflict (job_key, round_key, kind) do update set external_id = excluded.external_id, url = excluded.url, title = excluded.title,
         version = app.prep_documents.version + 1, sources = excluded.sources, sections = excluded.sections, inputs = excluded.inputs,
         last_changes = excluded.last_changes, unverified = excluded.unverified, content = excluded.content, updated_by = excluded.updated_by, updated_at = now()
       returning id`,
      [
        jobKey, p.company, normRound(p.round), roundKey, kind, saved.id, saved.url, doc.title, JSON.stringify(used), request.sections,
        JSON.stringify({ website: request.website, linkedin: request.linkedin }), JSON.stringify(doc.changes), JSON.stringify(doc.unverified), JSON.stringify(doc), user.email,
      ],
    );
    const result = {
      documentId: rows[0].id,
      url: saved.url,
      title: doc.title,
      changes: doc.changes,
      unverified: doc.unverified,
      sections: request.sections,
      model: out.model,
      skipped: sources.filter((s) => !s.text.trim()).map((s) => `${s.title || s.url}: ${s.error ?? "empty"}`),
    };
    // The drill-down row's "Prep Document" cell (the source behind EDGE): add the link, never overwrite.
    await linkInSheet(p.key, saved.url).catch((err) => console.warn("[prep-docs] sheet link not written:", err instanceof Error ? err.message.slice(0, 160) : err));
    await notifyDocReady(user.email, p, saved.url, existingText !== null || Boolean(adopt));
    await query("update app.prep_doc_runs set status = 'done', step = 'Done', result = $2, document_id = $3, updated_at = now() where id = $1", [id, JSON.stringify(result), rows[0].id]);
    await query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [
      user.email,
      adopt || existingText ? "prep_document_updated" : "prep_document_created",
      saved.url,
      JSON.stringify({ kind, jobKey, round: p.round, sources: used.length, model: out.model }),
    ]).catch(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[prep-docs] run failed:", message.slice(0, 300));
    await query("update app.prep_doc_runs set status = 'failed', error = $2, updated_at = now() where id = $1", [id, message.slice(0, 500)]).catch(() => undefined);
  }
}

async function linkInSheet(key: string, url: string): Promise<void> {
  const snap = await readPrepSnapshot();
  const p = snap.byKey.get(key);
  const col = snap.columns.prepDocument;
  if (!p || !col || p.prepDocument.includes(url)) return;
  const text = p.prepDocument.trim() ? `${p.prepDocument.trim()}\n${url}` : url;
  await writePrepCells(key, [{ col, text }], (row) => ({ ...row, prepDocument: text }));
}

async function notifyDocReady(email: string, p: PrepRow, url: string, updated: boolean): Promise<void> {
  await pushToUser({
    email,
    kind: "prep_doc_ready",
    data: { prepId: p.key, url, title: updated ? "Prep document updated" : "Prep document ready", body: `${p.company} · ${normRound(p.round) || "Interview"}` },
  }).catch(() => undefined);
}

/** The latest document link for a prep (for WhatsApp messages and "Mark prep given"). */
export async function prepDocLinks(key: string): Promise<{ kind: DocKind; url: string; title: string }[]> {
  const snap = await readPrepSnapshot();
  const p = snap.byKey.get(key);
  if (!p) return [];
  const docs = await documentsFor(jobKeyOf(p), roundKeyOf(p.round));
  return docs.map((d) => ({ kind: d.kind, url: d.url, title: d.title }));
}
