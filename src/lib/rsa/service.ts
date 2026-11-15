import "server-only";
import { query } from "@/lib/db/client";
import { runLlmChain } from "@/lib/llm-router";
import { UserError } from "@/lib/mobile/http";
import { docMetaFor, driveFileId } from "@/lib/mobile/preps/links";
import { normRound, type PrepRow } from "@/lib/mobile/preps/parse";
import { type DocLinkDto, linksFor } from "@/lib/mobile/preps/service";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster, type RosterUser } from "@/lib/mobile/roster";
import { jobKeyOf, roundKeyOf } from "@/lib/prepdocs/service";
import { readSources } from "@/lib/prepdocs/sources";
import { docTabs } from "@/lib/prepdocs/tabs";
import { fetchResume } from "@/lib/resume";
import { contentFromBytes, looksLikeResume, transcribeDocument, visionTiers } from "@/lib/resume-content";
import {
  candidateOnly,
  fitRsa,
  longDate,
  normaliseRsa,
  remarkBullets,
  RSA_SCHEMA,
  RSA_SHAPE_HINT,
  rsaFileName,
  sheetDate,
  type RsaContent,
  type RsaDoc,
} from "@/lib/rsa/model";
import { RSA_INSTRUCTION, RSA_SYSTEM } from "@/lib/rsa/prompt";
import { renderRsaDocx, rsaText } from "@/lib/rsa/render";
import { addRsaRow, sameDoc } from "@/lib/rsa/sheet";
import { createGoogleDocFromDocx, downloadFile, readGoogleDocText, replaceGoogleDocFromDocx, shareViewOnly, shareWith, subFolder, uploadFile } from "@/lib/team/drive";
import { teamStatus } from "@/lib/team/google";
import { transcribe } from "@/lib/team/stt";

/**
 * RSA documents (Rejection Selection Analysis): after a call with the candidate about an interview,
 * the team builds one short Google Doc per prep (candidate + job + round) from the drill-down, the
 * call recording, the resume the company has and the team's remarks. Updating it rewrites the same
 * document (same link) and never adds a second row to the RSA sheet. The recording, the transcript
 * and an uploaded resume are kept in the team Drive; the database keeps the document, the inputs'
 * links and the run status, never the transcript.
 */

const DEFAULT_CHAIN =
  "gemini:gemini-3.5-flash,gemini:gemini-2.5-flash,openai:gpt-5.5,openai:gpt-5.4-mini,mistral:codestral-latest,mistral:ministral-14b-latest";
const chain = () => process.env.RSA_LLM_CHAIN?.trim() || process.env.PREP_LLM_CHAIN?.trim() || DEFAULT_CHAIN;

export const MAX_RSA_RECORDING_BYTES = 40 * 1024 * 1024;
export const MAX_RSA_RESUME_BYTES = 10 * 1024 * 1024;
const AUDIO = /^audio\/|^video\/mp4$|^application\/octet-stream$/;
const RESUME_FILE = /^application\/pdf$|wordprocessingml|^application\/octet-stream$/;
const MAX_REMARKS = 4000;
const STALE_MS = 15 * 60_000;

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface RsaDocumentDto {
  id: string;
  url: string;
  title: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  drilldownUrl: string;
  tabs: string[];
  resumeUrl: string;
  remarks: string;
  /** "added" / "exists": the RSA sheet has its row; "failed": it couldn't be written (see sheetError). */
  sheetStatus: "pending" | "added" | "exists" | "failed";
  sheetError: string | null;
  /** Things the call mentioned that couldn't be confirmed (for the team, not in the document). */
  unconfirmed: string[];
}

export interface RsaRunDto {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  step: string;
  error: string | null;
  mode: "create" | "update";
  result: { rsaId: string; url: string; title: string; version: number; sheetStatus: string; warnings: string[] } | null;
  createdAt: string;
}

interface RsaRow {
  id: string;
  prep_key: string;
  candidate: string;
  phone: string;
  uid: string | null;
  company: string;
  round: string;
  product: string;
  drilldown_url: string;
  drilldown_tabs: string[];
  resume_url: string;
  remarks: string;
  recording_file_id: string;
  recording_url: string;
  transcript_file_id: string | null;
  external_id: string;
  url: string;
  title: string;
  version: number;
  content: RsaDoc;
  sheet_status: RsaDocumentDto["sheetStatus"];
  sheet_error: string | null;
  updated_by: string;
  updated_at: Date;
}

const toDto = (r: RsaRow, names: Map<string, string>): RsaDocumentDto => ({
  id: r.id,
  url: r.url,
  title: r.title,
  version: r.version,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: names.get(r.updated_by) ?? r.updated_by,
  drilldownUrl: r.drilldown_url,
  tabs: r.drilldown_tabs ?? [],
  resumeUrl: r.resume_url,
  remarks: r.remarks,
  sheetStatus: r.sheet_status,
  sheetError: r.sheet_error,
  unconfirmed: r.content?.content?.unconfirmed ?? [],
});

async function rsaOf(key: string): Promise<RsaRow | null> {
  return (await query<RsaRow>("select * from app.rsa_documents where prep_key = $1", [key]))[0] ?? null;
}

async function loadPrep(key: string) {
  const snap = await readPrepSnapshot();
  const p = snap.byKey.get(key);
  if (!p) throw new UserError(404, "This prep is no longer in the drill-down sheet.", "not_found");
  const sameJob = p.jobId ? snap.preps.filter((r) => r.jobId === p.jobId) : snap.preps.filter((r) => r.company === p.company);
  return { p, sameJob };
}

/** The job's drill-downs (own first), with their names and — for multi-tab Google Docs — their tabs. */
async function drilldownsFor(p: PrepRow, sameJob: PrepRow[]): Promise<DocLinkDto[]> {
  const links = linksFor(p, sameJob).filter((l) => l.kind === "drilldown");
  const meta = await docMetaFor(links.map((l) => l.url));
  for (const l of links) {
    const m = meta.get(driveFileId(l.url) ?? "");
    if (m) {
      l.title = m.name;
      l.updatedAt = m.modifiedAt;
    }
  }
  await Promise.race([
    Promise.all(
      links
        .filter((l) => /^https:\/\/docs\.google\.com\/document\//i.test(l.url) && driveFileId(l.url))
        .slice(0, 8)
        .map(async (l) => {
          const tabs = await docTabs(driveFileId(l.url)!, l.updatedAt);
          if (tabs && tabs.length > 1) l.tabs = tabs;
          if (tabs === null) l.tabsUnknown = true;
        }),
    ),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
  return links.sort((a, b) => Number(b.own) - Number(a.own) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** The candidate's UID from our databases (eligible pool, Academy pool), by phone. */
async function uidFor(phone: string): Promise<string | null> {
  if (!/^\d{10}$/.test(phone)) return null;
  const rows = await query<{ uid: string }>(
    `select uid from (
       select user_id as uid, 1 as o from placement.candidates where phone = $1 and user_id is not null
       union all select uid, 2 from app.pool_candidates where phone = $1 and uid is not null
       union all select uid, 3 from placement.academy_records where phone = $1 and uid is not null
     ) x order by o limit 1`,
    [phone],
  ).catch(() => []);
  return rows[0]?.uid?.trim() || null;
}

// ── Overview ────────────────────────────────────────────────────────────────

export async function rsaOverview(user: RosterUser, key: string) {
  const { p, sameJob } = await loadPrep(key);
  const [drilldowns, existing, team, run, roster] = await Promise.all([
    drilldownsFor(p, sameJob),
    rsaOf(key),
    teamStatus().catch(() => null),
    latestRun(key),
    listRoster(),
  ]);
  const names = new Map(roster.map((u) => [u.email, u.name]));
  const lastRecording = existing ? null : await recordingFromRuns(key);
  return {
    prepId: key,
    candidate: p.candidate,
    company: p.company,
    round: normRound(p.round),
    phone: p.phone,
    product: p.product,
    drilldowns,
    /** The resume link on the drill-down row (what the company has); the app may send another. */
    resumeUrl: existing?.resume_url || p.resumeUrl,
    rsa: existing ? toDto(existing, names) : null,
    /** A recording from an earlier attempt that didn't finish: an RSA can be made without uploading it again. */
    hasRecording: Boolean(existing?.recording_file_id || lastRecording),
    run,
    google: team ? { connected: team.connected, account: team.account, status: team.status } : { connected: false, account: "", status: "not_configured" },
    preparedBy: user.name,
  };
}

// ── Runs ─────────────────────────────────────────────────────────────────────

async function latestRun(key: string): Promise<RsaRunDto | null> {
  const rows = await query<{ id: string }>(
    "select id from app.rsa_runs where prep_key = $1 and created_at > now() - interval '1 day' order by created_at desc limit 1",
    [key],
  );
  return rows[0] ? getRsaRun(rows[0].id) : null;
}

export async function getRsaRun(id: string): Promise<RsaRunDto | null> {
  const rows = await query<{ id: string; status: RsaRunDto["status"]; step: string; error: string | null; mode: RsaRunDto["mode"]; result: RsaRunDto["result"]; created_at: Date; updated_at: Date }>(
    "select id, status, step, error, mode, result, created_at, updated_at from app.rsa_runs where id = $1",
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  // A run the server lost (a restart mid-run) is reported as failed, not "running" forever.
  if ((r.status === "running" || r.status === "queued") && Date.now() - r.updated_at.getTime() > STALE_MS) {
    const error = "The server restarted while writing. Start again (the recording is kept).";
    await query("update app.rsa_runs set status = 'failed', error = $2, updated_at = now() where id = $1 and status in ('queued', 'running')", [id, error]);
    return { id, status: "failed", step: r.step, error, mode: r.mode, result: null, createdAt: r.created_at.toISOString() };
  }
  return { id: r.id, status: r.status, step: r.step, error: r.error, mode: r.mode, result: r.result, createdAt: r.created_at.toISOString() };
}

/** The recording saved by an earlier run of this prep that didn't produce a document. */
async function recordingFromRuns(key: string): Promise<{ fileId: string; url: string; callAt: string | null } | null> {
  const rows = await query<{ request: { recording?: { fileId?: string; url?: string; callAt?: string | null } } }>(
    "select request from app.rsa_runs where prep_key = $1 and request ? 'recording' order by created_at desc limit 1",
    [key],
  );
  const rec = rows[0]?.request?.recording;
  return rec?.fileId ? { fileId: rec.fileId, url: rec.url ?? "", callAt: rec.callAt ?? null } : null;
}

export interface RsaSubmission {
  recording: { bytes: Buffer; mime: string; name: string } | null;
  callAt: Date | null;
  drilldownUrl: string;
  tabs: string[];
  resumeUrl: string;
  resumeFile: { bytes: Buffer; mime: string; name: string } | null;
  remarks: string;
}

interface RunRequest {
  drilldownUrl: string;
  tabs: string[];
  resume: { url: string; fileId: string | null };
  remarks: string;
  recording: { fileId: string; url: string; callAt: string | null; fresh: boolean };
}

const httpUrl = (v: string) => (/^https?:\/\/\S+$/i.test(v.trim()) ? v.trim().slice(0, 1000) : "");

const ext = (mime: string, name: string) => name.match(/\.(m4a|mp3|aac|amr|wav|ogg|opus|3gp|mp4|pdf|docx)$/i)?.[0] ?? (mime.includes("mpeg") ? ".mp3" : mime.includes("pdf") ? ".pdf" : ".m4a");

/** Validates the inputs, saves the recording (and an uploaded resume) to the team Drive, and starts the run. */
export async function startRsa(user: RosterUser, key: string, s: RsaSubmission): Promise<RsaRunDto> {
  const team = await teamStatus();
  if (!team.connected) throw new UserError(503, `Connect the team Google account (${team.account || "not set"}) first: an admin can do it in Me → Team.`, "team_not_connected");
  const { p, sameJob } = await loadPrep(key);
  const existing = await rsaOf(key);

  // Drill-down (required): one of the job's drill-downs, and the tabs to read when it has several.
  const drilldownUrl = httpUrl(s.drilldownUrl);
  if (!drilldownUrl) throw new UserError(422, "Choose the candidate's drill-down.", "no_drilldown");
  const drilldowns = await drilldownsFor(p, sameJob);
  const chosen = drilldowns.find((d) => sameDoc(d.url, drilldownUrl));
  if (!chosen) throw new UserError(422, "That drill-down isn't one of this job's drill-downs.", "invalid_drilldown");
  let tabs: string[] = [];
  if (chosen.tabs?.length) {
    const valid = new Set(chosen.tabs.map((t) => t.id));
    tabs = [...new Set(s.tabs.filter((t) => valid.has(t)))];
    if (!tabs.length) throw new UserError(422, `Pick which tabs of "${chosen.title || "the drill-down"}" to read.`, "no_tabs");
  }

  // Resume (required): the link the company has, or a file.
  if (s.resumeFile) {
    if (s.resumeFile.bytes.length === 0) throw new UserError(422, "The resume file is empty.", "invalid_resume");
    if (s.resumeFile.bytes.length > MAX_RSA_RESUME_BYTES) throw new UserError(413, "The resume is larger than 10 MB.", "resume_too_large");
    if (!RESUME_FILE.test(s.resumeFile.mime) && !/\.(pdf|docx)$/i.test(s.resumeFile.name)) throw new UserError(415, "The resume must be a PDF or Word (.docx) file.", "invalid_resume");
  }
  const resumeLink = httpUrl(s.resumeUrl);
  if (!s.resumeFile && !resumeLink) throw new UserError(422, "Add the resume that was sent to the company.", "no_resume");

  // Remarks (optional).
  const remarks = s.remarks.replace(/\r\n/g, "\n").trim();
  if (remarks.length > MAX_REMARKS) throw new UserError(422, `Remarks can be at most ${MAX_REMARKS} characters.`, "remarks_too_long");

  // Recording (required): a new one, else the one this RSA (or an unfinished attempt) already has.
  if (s.recording) {
    if (s.recording.bytes.length === 0) throw new UserError(422, "The recording is empty.", "invalid_recording");
    if (s.recording.bytes.length > MAX_RSA_RECORDING_BYTES) throw new UserError(413, "The recording is larger than 40 MB.", "recording_too_large");
    if (!AUDIO.test(s.recording.mime)) throw new UserError(415, "That file isn't an audio recording.", "invalid_recording");
  }
  const previous = existing ? { fileId: existing.recording_file_id, url: existing.recording_url, callAt: existing.content?.callAt ?? null } : await recordingFromRuns(key);
  if (!s.recording && !previous) throw new UserError(422, "Add the RSA call recording.", "no_recording");

  // One run at a time per prep (a double tap or two team members at once): the database's
  // one-active-run index decides, before any file is uploaded.
  const id = await claimRun(key, existing, user.email);
  if (typeof id !== "string") return id;

  // Files are saved before answering: once the app gets a 202 they are safe even if the server restarts.
  let request: RunRequest;
  try {
    const roster = (await listRoster()).filter((u) => u.active).map((u) => u.email);
    const label = `${p.company} - ${normRound(p.round) || "Interview"} - ${p.candidate}`;
    let recording: RunRequest["recording"];
    if (s.recording) {
      const folder = await subFolder("RSA call recordings");
      const saved = await uploadFile(`RSA call - ${label} - ${sheetDate(s.callAt ?? new Date())}${ext(s.recording.mime, s.recording.name)}`, s.recording.mime, s.recording.bytes, folder);
      await shareWith(saved.id, roster);
      recording = { fileId: saved.id, url: saved.url, callAt: (s.callAt ?? new Date()).toISOString(), fresh: true };
    } else {
      recording = { ...previous!, fresh: false };
    }
    let resume: RunRequest["resume"] = { url: resumeLink, fileId: null };
    if (s.resumeFile) {
      const folder = await subFolder("RSA resumes");
      const saved = await uploadFile(`Resume - ${label}${ext(s.resumeFile.mime, s.resumeFile.name)}`, s.resumeFile.mime || "application/pdf", s.resumeFile.bytes, folder);
      // The resume link goes into the document and the sheet: anyone with it can view.
      await shareViewOnly(saved.id);
      resume = { url: saved.url, fileId: saved.id };
    }
    request = { drilldownUrl: chosen.url, tabs, resume, remarks, recording };
    await query("update app.rsa_runs set request = $2, updated_at = now() where id = $1", [id, JSON.stringify(request)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query("update app.rsa_runs set status = 'failed', error = $2, updated_at = now() where id = $1", [id, `The files couldn't be saved to the team Drive: ${message.slice(0, 300)}`]);
    throw new UserError(502, "The recording or resume couldn't be saved to the team Drive. Try again.", "drive_failed");
  }
  await audit(user.email, existing ? "rsa_update_started" : "rsa_create_started", key, { run: id, newRecording: request.recording.fresh, resumeFile: Boolean(request.resume.fileId), remarks: remarks.length });
  void runRsa(id, user, key, request, s.recording && request.recording.fresh ? s.recording : null).catch((err) =>
    console.error("[rsa] run crashed:", err instanceof Error ? err.message : err),
  );
  return (await getRsaRun(id))!;
}

/** Starts a run for the prep, or returns the one already in progress (a stale one is failed first). */
async function claimRun(key: string, existing: RsaRow | null, email: string): Promise<string | RsaRunDto> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rows = await query<{ id: string }>(
      `insert into app.rsa_runs (rsa_id, prep_key, mode, status, step, request, requested_by)
       values ($1, $2, $3, 'queued', 'Saving the files', '{}', $4)
       on conflict (prep_key) where status in ('queued', 'running') do nothing returning id`,
      [existing?.id ?? null, key, existing ? "update" : "create", email],
    );
    if (rows[0]) return rows[0].id;
    const active = await query<{ id: string }>("select id from app.rsa_runs where prep_key = $1 and status in ('queued', 'running') limit 1", [key]);
    if (!active[0]) continue;
    const run = await getRsaRun(active[0].id);
    if (run && run.status !== "failed") return run;
  }
  throw new UserError(409, "Another RSA run for this candidate just started. Refresh in a moment.", "run_in_progress");
}

const audit = (actor: string, action: string, target: string, detail: Record<string, unknown>) =>
  query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [actor, action, target, JSON.stringify(detail)]).catch(() => undefined);

async function step(id: string, text: string) {
  await query("update app.rsa_runs set status = 'running', step = $2, updated_at = now() where id = $1", [id, text]);
}

/** The call's transcript: from the new recording, else the transcript saved last time, else the saved recording. */
async function transcriptFor(rec: RunRequest["recording"], existing: RsaRow | null, audio: { bytes: Buffer; mime: string } | null, label: string): Promise<{ text: string; fileId: string | null }> {
  if (!rec.fresh && existing?.transcript_file_id && existing.recording_file_id === rec.fileId) {
    const saved = await downloadFile(existing.transcript_file_id).catch(() => null);
    if (saved && saved.bytes.length) return { text: saved.bytes.toString("utf8"), fileId: existing.transcript_file_id };
  }
  const file = audio ?? (await downloadFile(rec.fileId));
  const text = (await transcribe(file.bytes, file.mime)).text.trim();
  if (text.length < 80) throw new Error("The recording has almost no speech. Check that it is the RSA call and try again.");
  const folder = await subFolder("RSA call transcripts");
  const saved = await uploadFile(`Transcript - ${label}.txt`, "text/plain", text, folder).catch(() => null);
  return { text, fileId: saved?.id ?? null };
}

/** The resume's text (a file with no text layer is transcribed first). */
async function resumeText(resume: RunRequest["resume"]): Promise<string> {
  const fetched = resume.fileId ? { ok: true as const, bytes: await downloadFile(resume.fileId).then((f) => ({ data: f.bytes, mimeType: f.mime })) } : await fetchResume(resume.url);
  if (!fetched.ok) throw new Error(`The resume couldn't be opened (${fetched.error.slice(0, 120)}). Share it with the team or upload the file.`);
  const content = await contentFromBytes(fetched.bytes);
  if (typeof content === "string") throw new Error(content);
  if (looksLikeResume(content.text)) return content.text;
  if (!content.inline) throw new Error("The resume has no readable text.");
  const doc = await transcribeDocument(content.inline, { chain: visionTiers(chain()), label: "rsa-resume", timeoutMs: 90_000 });
  if (!doc.ok) throw new Error(`The scanned resume couldn't be read: ${doc.error.slice(0, 120)}`);
  if (doc.type !== "resume") throw new Error("The resume link doesn't open a resume.");
  return doc.text;
}

function evidenceText(input: { known: string[]; remarks: string; transcript: string; drilldown: string; resume: string; existing: string | null }, budget: number): string {
  const parts = [
    "=== KNOWN FACTS (from the sheet) ===",
    ...input.known,
    "",
    "=== TEAM REMARKS (highest priority) ===",
    input.remarks || "(none)",
    "",
  ];
  if (input.existing) parts.push("=== CURRENT RSA (update it; keep what is still right, apply the new remarks and inputs) ===", input.existing.slice(0, 12_000), "");
  const left = Math.max(12_000, budget - parts.join("\n").length);
  parts.push(
    "=== RSA CALL TRANSCRIPT ===",
    input.transcript.slice(0, Math.floor(left * 0.55)),
    "",
    "=== DRILL-DOWN (hiring intelligence) ===",
    input.drilldown.slice(0, Math.floor(left * 0.3)),
    "",
    "=== RESUME (the one the company has) ===",
    input.resume.slice(0, Math.floor(left * 0.15)),
  );
  return parts.join("\n");
}

async function runRsa(id: string, user: RosterUser, key: string, request: RunRequest, audio: { bytes: Buffer; mime: string } | null): Promise<void> {
  try {
    const { p, sameJob } = await loadPrep(key);
    const existing = await rsaOf(key);
    const round = normRound(p.round) || "Interview";
    const [companyName, ...roleParts] = p.company.split(/\s+-\s+/);
    const company = companyName.trim() || p.company;
    const sheetRole = roleParts.join(" - ").trim();
    const label = `${p.company} - ${round} - ${p.candidate}`;

    await step(id, request.recording.fresh || !existing?.transcript_file_id ? "Transcribing the call" : "Reading the call");
    const transcript = await transcriptFor(request.recording, existing, audio, label);

    await step(id, "Reading the drill-down");
    // Other candidates' names in the drill-down are removed; this candidate's name is handled by the writer rules.
    const others = [...new Set(sameJob.filter((r) => r.key !== key).map((r) => r.candidate))];
    const [dd] = await readSources([{ url: request.drilldownUrl, kind: "drilldown", ...(request.tabs.length ? { tabs: request.tabs } : {}) }], null, others);
    if (!dd?.text.trim()) throw new Error(`The drill-down couldn't be read (${dd?.error ?? "empty"}).`);

    await step(id, "Reading the resume");
    const resume = await resumeText(request.resume);

    await step(id, existing ? "Updating the RSA" : "Writing the RSA");
    const interview = [p.interviewDay ? longDate(new Date(`${p.interviewDay}T12:00:00+05:30`)) : "", p.interviewTimeText].filter(Boolean).join(", ");
    const known = [
      `COMPANY: ${company}`,
      sheetRole ? `ROLE: ${sheetRole}` : "",
      `ROUND: ${round}`,
      p.process.length ? `PROCESS: ${p.process.join(" → ")}` : "",
      interview ? `INTERVIEW: ${interview}` : "",
      p.candidateStatus ? `RESULT IN THE SHEET: ${p.candidateStatus}` : "RESULT IN THE SHEET: not updated",
    ].filter(Boolean);
    const names = [p.candidate];
    // An update starts from the document as it is now (edits made by hand in Google Docs are kept).
    const existingText = existing ? ((await readGoogleDocText(existing.external_id).catch(() => "")).trim() || (existing.content ? rsaText(existing.content) : "")) || null : null;
    const evidence = [transcript.text, dd.text, request.remarks, existingText ?? ""];
    const res = await runLlmChain({
      label: `rsa:${key.slice(0, 8)}`,
      chain: chain(),
      system: RSA_SYSTEM,
      schema: RSA_SCHEMA,
      shapeHint: RSA_SHAPE_HINT,
      temperature: 0.1,
      maxOutputTokens: 8000,
      timeoutMs: 150_000,
      accept: (j) => normaliseRsa(j, { names, evidence }) !== null,
      build: (_tier, budget) => {
        const text = `${RSA_INSTRUCTION}\n\n${evidenceText({ known, remarks: request.remarks, transcript: transcript.text, drilldown: dd.text, resume, existing: existingText }, budget)}`;
        return { geminiParts: text, text };
      },
    });
    if (!res.ok) throw new Error(`The RSA couldn't be written: ${res.error.slice(0, 200)}`);
    const norm = normaliseRsa(res.json, { names, evidence })!;
    const content: RsaContent = norm.content;

    const callAt = request.recording.callAt ? new Date(request.recording.callAt) : new Date();
    const resultText = p.candidateStatus || content.result || "Awaited";
    const doc = fitRsa({
      // An update keeps the document's name (and so its date).
      fileName: existing?.content?.fileName || rsaFileName(p.candidate, company, round, callAt),
      callAt: callAt.toISOString(),
      title: "INTERVIEW SUMMARY ANALYSIS (RSA)",
      subtitle: `${company} – ${round} Interview Feedback`,
      header: {
        candidateName: p.candidate,
        companyRole: [company, sheetRole || content.role].filter(Boolean).join(" / "),
        process: p.process.length ? p.process.join(" → ") : content.process,
        roundAttended: [round, interview].filter(Boolean).join(" – "),
        result: resultText,
        resumeUrl: request.resume.url,
        callAndPreparedBy: `${longDate(callAt)} / ${user.name}`,
      },
      content: { ...content, remarks: { ...content.remarks, result: resultText } },
      teamRemarks: remarkBullets(request.remarks).map((b) => candidateOnly(b, names)),
    });

    await step(id, "Saving to Google Docs");
    const docx = await renderRsaDocx(doc, company);
    // An update rewrites the same document: the link in the sheet keeps working.
    const saved = existing ? await replaceGoogleDocFromDocx(existing.external_id, doc.fileName, docx) : await createGoogleDocFromDocx(doc.fileName, docx, await subFolder("RSA Documents"));
    await shareViewOnly(saved.id);

    const uid = await uidFor(p.phone);
    const rows = await query<{ id: string; version: number }>(
      `insert into app.rsa_documents (prep_key, candidate, phone, uid, company, round, job_key, round_key, product, drilldown_url, drilldown_tabs, resume_url,
         remarks, recording_file_id, recording_url, transcript_file_id, external_id, url, title, content, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21)
       on conflict (prep_key) do update set candidate = excluded.candidate, phone = excluded.phone, uid = coalesce(excluded.uid, app.rsa_documents.uid),
         company = excluded.company, round = excluded.round, job_key = excluded.job_key, round_key = excluded.round_key, product = excluded.product,
         drilldown_url = excluded.drilldown_url, drilldown_tabs = excluded.drilldown_tabs, resume_url = excluded.resume_url, remarks = excluded.remarks,
         recording_file_id = excluded.recording_file_id, recording_url = excluded.recording_url, transcript_file_id = excluded.transcript_file_id,
         external_id = excluded.external_id, url = excluded.url, title = excluded.title, content = excluded.content,
         version = app.rsa_documents.version + 1, updated_by = excluded.updated_by, updated_at = now()
       returning id, version`,
      [
        key, p.candidate.slice(0, 200), /^\d{10}$/.test(p.phone) ? p.phone : "", uid, p.company.slice(0, 300), round.slice(0, 100), jobKeyOf(p), roundKeyOf(p.round),
        p.product.slice(0, 100), request.drilldownUrl, request.tabs, request.resume.url, request.remarks, request.recording.fileId, request.recording.url,
        transcript.fileId, saved.id, saved.url, doc.fileName.slice(0, 300), JSON.stringify(doc), user.email,
      ],
    );
    const rsaId = rows[0].id;

    // The RSA sheet: one row per document, added once (an update keeps the same link, so no new row).
    await step(id, "Adding it to the RSA sheet");
    let sheetStatus: RsaDocumentDto["sheetStatus"] = "failed";
    let sheetError: string | null = null;
    const warnings: string[] = [...norm.dropped];
    try {
      const r = await addRsaRow({
        date: sheetDate(new Date()),
        uid: uid ?? "",
        company: p.company,
        candidate: p.candidate,
        mobile: p.phoneRaw.trim() || p.phone,
        resume: request.resume.url,
        product: p.product,
        drilldown: request.drilldownUrl,
        rsaDoc: saved.url,
      });
      sheetStatus = r.status;
      if (r.missing.length) warnings.push(`The RSA sheet has no column for: ${r.missing.join(", ")}`);
    } catch (err) {
      sheetError = err instanceof Error ? err.message.slice(0, 300) : String(err);
      warnings.push(`Not added to the RSA sheet: ${sheetError}`);
    }
    await query("update app.rsa_documents set sheet_status = $2, sheet_error = $3 where id = $1", [rsaId, sheetStatus, sheetError]);

    const result = { rsaId, url: saved.url, title: doc.fileName, version: rows[0].version, sheetStatus, warnings: warnings.slice(0, 12) };
    await query("update app.rsa_runs set status = 'done', step = 'Done', rsa_id = $2, result = $3, updated_at = now() where id = $1", [id, rsaId, JSON.stringify(result)]);
    await audit(user.email, existing ? "rsa_updated" : "rsa_created", saved.url, { prepKey: key, version: rows[0].version, sheet: sheetStatus, model: `${res.provider}/${res.model}` });
    await pushToUser({
      email: user.email,
      kind: "rsa_ready",
      data: { prepId: key, url: saved.url, title: existing ? "RSA document updated" : "RSA document ready", body: `${p.candidate} · ${company} · ${round}` },
    }).catch(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[rsa] run failed:", message.slice(0, 300));
    await query("update app.rsa_runs set status = 'failed', error = $2, updated_at = now() where id = $1", [id, message.slice(0, 500)]).catch(() => undefined);
  }
}
