import "server-only";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { normRound } from "@/lib/mobile/preps/parse";
import { PREP_CALL_HEADERS, readPrepSnapshot, writePrepExtraCells } from "@/lib/mobile/preps/sheet";
import { listRoster, type RosterUser } from "@/lib/mobile/roster";
import { pushToUser } from "@/lib/mobile/push";
import { downloadFile, shareWith, subFolder, uploadFile } from "@/lib/team/drive";
import { transcribe } from "@/lib/team/stt";
import { type CallSummary, durationText, summariseCall, summaryCell } from "@/lib/team/summary";

/**
 * Prep-call recordings made by the mentors' phones (auto call recording), uploaded by the app:
 * saved to the team Drive, transcribed (ElevenLabs / Deepgram), summarised, and written back to
 * the drill-down row's "Prep Call Transcript / Summary / Duration" columns. The duration is the
 * recording file's own length — never an estimate.
 */

/** 40 MB ≈ an hour of phone-call audio; keeps the free server well inside its memory. */
export const MAX_RECORDING_BYTES = 40 * 1024 * 1024;
const AUDIO = /^audio\/|^video\/mp4$|^application\/octet-stream$/;

export interface RecordingDto {
  id: string;
  source: "phone" | "meet";
  callAt: string;
  durationSec: number;
  mentorEmail: string;
  mentorName: string;
  status: string;
  error: string | null;
  recordingUrl: string | null;
  transcriptUrl: string | null;
  transcript: string | null;
  summary: CallSummary | null;
}

interface RecRow {
  id: string;
  prep_key: string;
  mentor_email: string;
  call_at: Date;
  duration_sec: number;
  file_name: string;
  drive_url: string | null;
  transcript_url: string | null;
  transcript_text: string | null;
  summary: CallSummary | null;
  status: string;
  error: string | null;
}

export async function uploadPhoneRecording(
  user: RosterUser,
  key: string,
  file: { bytes: Buffer; mime: string; name: string },
  meta: { callAt: Date; durationSec: number; deviceKey: string },
): Promise<RecordingDto> {
  if (file.bytes.length === 0) throw new UserError(422, "The recording is empty.", "invalid_recording");
  if (file.bytes.length > MAX_RECORDING_BYTES) throw new UserError(413, "The recording is larger than 40 MB.", "recording_too_large");
  if (!AUDIO.test(file.mime)) throw new UserError(415, "That file isn't an audio recording.", "invalid_recording");
  if (!/^[\w.:-]{6,200}$/.test(meta.deviceKey)) throw new UserError(422, "Missing recording id.", "invalid_recording");
  if (!Number.isFinite(meta.callAt.getTime()) || meta.callAt.getTime() > Date.now() + 5 * 60_000) throw new UserError(422, "The call time isn't valid.", "invalid_recording");
  if (!Number.isFinite(meta.durationSec) || meta.durationSec < 1 || meta.durationSec > 6 * 3600) throw new UserError(422, "The call duration isn't valid.", "invalid_recording");
  const snap = await readPrepSnapshot();
  const p = snap.byKey.get(key);
  if (!p) throw new UserError(404, "This prep is no longer in the drill-down sheet.", "not_found");

  // Same file uploaded again (a retry after a dropped connection): answer with what we have.
  const existing = await query<{ id: string; drive_file_id: string | null }>("select id, drive_file_id from app.call_recordings where device_key = $1", [meta.deviceKey]);
  if (existing[0]?.drive_file_id) return (await recordingDto(existing[0].id))!;

  // Save to Drive inside the request: once the app gets a 200, the recording is safe even if the
  // server restarts before the transcript is done (the ticker resumes from Drive).
  const team = (await listRoster()).filter((u) => u.active).map((u) => u.email);
  const folder = await subFolder("Prep call recordings");
  const audio = await uploadFile(
    `${p.company} - ${normRound(p.round) || "Prep"} - ${p.candidate} - ${istStamp(meta.callAt)}${ext(file.mime, file.name)}`,
    file.mime,
    file.bytes,
    folder,
  );
  await shareWith(audio.id, team);
  const rows = await query<{ id: string }>(
    `insert into app.call_recordings (prep_key, mentor_email, device_key, call_at, duration_sec, file_name, drive_file_id, drive_url, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'transcribing')
     on conflict (device_key) do update set drive_file_id = excluded.drive_file_id, drive_url = excluded.drive_url, status = 'transcribing', error = null, updated_at = now()
     returning id`,
    [key, user.email, meta.deviceKey, meta.callAt, Math.round(meta.durationSec), file.name.slice(0, 200), audio.id, audio.url],
  );
  const id = rows[0].id;
  await audit(user.email, "call_recording_uploaded", key, { durationSec: meta.durationSec, callAt: meta.callAt.toISOString() });
  void processRecording(id, file).catch((err) => console.error("[recordings] crashed:", err instanceof Error ? err.message : err));
  return (await recordingDto(id))!;
}

const audit = (actor: string, action: string, target: string, detail: Record<string, unknown>) =>
  query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [actor, action, target, JSON.stringify(detail)]).catch(() => undefined);

const ext = (mime: string, name: string) => name.match(/\.(m4a|mp3|aac|amr|wav|ogg|opus|3gp|mp4)$/i)?.[0] ?? (mime.includes("mpeg") ? ".mp3" : ".m4a");

/** "2026-11-08 16:05" in IST. */
const istStamp = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ");

const g = globalThis as unknown as { __recRunning?: Set<string> };
const running = (g.__recRunning ??= new Set());

/**
 * Transcript → summary → sheet columns. Resumable: each step is skipped when its result is
 * already stored, so a retry after a crash or a provider outage only redoes what's missing.
 */
async function processRecording(id: string, file?: { bytes: Buffer; mime: string; name: string }): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    const rec = (await query<RecRow & { drive_file_id: string | null }>("select * from app.call_recordings where id = $1", [id]))[0];
    if (!rec || rec.status === "ready") return;
    const snap = await readPrepSnapshot().catch(() => null);
    const p = snap?.byKey.get(rec.prep_key);
    const ctx = { company: p?.company ?? "Company", round: normRound(p?.round ?? "") || "Prep", candidate: p?.candidate ?? "Candidate" };
    await query("update app.call_recordings set attempts = attempts + 1, updated_at = now() where id = $1", [id]);
    try {
      let transcript = rec.transcript_text;
      if (!transcript) {
        await setStatus(id, "transcribing");
        const audio = file ?? (rec.drive_file_id ? await downloadFile(rec.drive_file_id) : null);
        if (!audio) throw new Error("The recording file is missing; upload it again.");
        const t = await transcribe(audio.bytes, audio.mime);
        transcript = t.text;
        const team = (await listRoster()).filter((u) => u.active).map((u) => u.email);
        const doc = await uploadFile(
          `Transcript - ${ctx.company} - ${ctx.round} - ${ctx.candidate} - ${istStamp(rec.call_at)}`,
          "text/plain",
          `${ctx.company} | ${ctx.round} prep call | ${istStamp(rec.call_at)} IST | ${durationText(rec.duration_sec)}\n\n${transcript}`,
          await subFolder("Prep call transcripts"),
          "application/vnd.google-apps.document",
        );
        await shareWith(doc.id, team);
        await query("update app.call_recordings set transcript_url = $2, transcript_text = $3, updated_at = now() where id = $1", [id, doc.url, transcript]);
      }
      if (!rec.summary) {
        await setStatus(id, "summarising");
        const summary = await summariseCall(transcript, { company: ctx.company, round: ctx.round });
        await query("update app.call_recordings set summary = $2, updated_at = now() where id = $1", [id, JSON.stringify(summary)]);
      }
      await query("update app.call_recordings set status = 'ready', error = null, updated_at = now() where id = $1", [id]);
      await writeSheetColumns(rec.prep_key).catch((err) => console.warn("[recordings] sheet write failed:", err instanceof Error ? err.message : err));
      await pushToUser({
        email: rec.mentor_email,
        kind: "recording_ready",
        data: { prepId: rec.prep_key, title: "Call summary ready", body: `${ctx.candidate} · ${ctx.company} · ${durationText(rec.duration_sec)}` },
        dedupeKey: `recording_ready:${id}`,
      }).catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[recordings] failed:", message.slice(0, 300));
      await setStatus(id, "failed", message.slice(0, 500));
    }
  } finally {
    running.delete(id);
  }
}

async function setStatus(id: string, status: string, error: string | null = null) {
  await query("update app.call_recordings set status = $2, error = $3, updated_at = now() where id = $1", [id, status, error]);
}

/** A mentor asks to try a failed recording again. */
export async function retryRecording(user: RosterUser, id: string): Promise<RecordingDto> {
  const rec = (await query<{ id: string; mentor_email: string; status: string }>("select id, mentor_email, status from app.call_recordings where id = $1", [id]))[0];
  if (!rec) throw new UserError(404, "This recording doesn't exist.", "not_found");
  if (rec.mentor_email !== user.email && user.role !== "admin") throw new UserError(403, "Only the mentor who recorded the call can retry it.", "forbidden");
  if (rec.status === "failed") {
    await query("update app.call_recordings set attempts = 0, status = 'transcribing', error = null, updated_at = now() where id = $1", [id]);
    void processRecording(id).catch(() => undefined);
  }
  return (await recordingDto(id))!;
}

/** Ticker: resumes recordings interrupted by a restart and retries failures (3 attempts). */
export async function resumeRecordings(): Promise<number> {
  const rows = await query<{ id: string }>(
    `select id from app.call_recordings
      where drive_file_id is not null and attempts < 3
        and ((status = 'failed' and updated_at < now() - interval '5 minutes')
          or (status in ('uploaded', 'transcribing', 'summarising') and updated_at < now() - interval '20 minutes'))
      order by updated_at limit 3`,
  );
  for (const r of rows) await processRecording(r.id);
  return rows.length;
}

/** Fills "Prep Call Transcript / Summary / Duration" from every ready call of the prep (latest first). */
export async function writeSheetColumns(prepKey: string): Promise<void> {
  const calls = await query<{ call_at: Date; duration_sec: number; transcript_url: string | null; summary: CallSummary | null }>(
    `select call_at, duration_sec, transcript_url, summary from app.call_recordings where prep_key = $1 and status = 'ready'
     union all
     select starts_at, duration_sec, transcript_url, summary from app.meetings where prep_key = $1 and artifacts_status = 'ready' and duration_sec is not null
     order by 1 desc`,
    [prepKey],
  );
  if (!calls.length) return;
  const total = calls.reduce((s, c) => s + (c.duration_sec ?? 0), 0);
  const latest = calls.find((c) => c.summary);
  await writePrepExtraCells(prepKey, {
    [PREP_CALL_HEADERS.transcript]: calls.map((c) => c.transcript_url).filter(Boolean).join("\n"),
    [PREP_CALL_HEADERS.summary]: latest?.summary ? summaryCell(latest.summary) : "",
    [PREP_CALL_HEADERS.duration]: calls.length === 1 ? durationText(total) : `${calls.length} calls · ${durationText(total)}`,
  });
  await query("update app.call_recordings set sheet_written_at = now() where prep_key = $1 and status = 'ready'", [prepKey]);
}

async function recordingDto(id: string): Promise<RecordingDto | null> {
  const r = (await query<RecRow>("select * from app.call_recordings where id = $1", [id]))[0];
  if (!r) return null;
  const roster = await listRoster();
  return phoneDto(r, roster);
}

function phoneDto(r: RecRow, roster: RosterUser[]): RecordingDto {
  return {
    id: r.id,
    source: "phone",
    callAt: r.call_at.toISOString(),
    durationSec: r.duration_sec,
    mentorEmail: r.mentor_email,
    mentorName: roster.find((u) => u.email === r.mentor_email)?.name ?? r.mentor_email,
    status: r.status,
    error: r.error,
    recordingUrl: r.drive_url,
    transcriptUrl: r.transcript_url,
    transcript: r.transcript_text,
    summary: r.summary,
  };
}

/** Phone recordings and Meet recordings of one prep, newest first. */
export async function recordingsFor(prepKey: string): Promise<RecordingDto[]> {
  const [phone, meets, roster] = await Promise.all([
    query<RecRow>("select * from app.call_recordings where prep_key = $1 order by call_at desc", [prepKey]),
    query<{ id: string; starts_at: Date; duration_sec: number | null; created_by: string; artifacts_status: string; recording_url: string | null; transcript_url: string | null; transcript_text: string | null; summary: CallSummary | null }>(
      "select id, starts_at, duration_sec, created_by, artifacts_status, recording_url, transcript_url, transcript_text, summary from app.meetings where prep_key = $1 and artifacts_status = 'ready' order by starts_at desc",
      [prepKey],
    ),
    listRoster(),
  ]);
  const out = phone.map((r) => phoneDto(r, roster));
  for (const m of meets) {
    out.push({
      id: m.id,
      source: "meet",
      callAt: m.starts_at.toISOString(),
      durationSec: m.duration_sec ?? 0,
      mentorEmail: m.created_by,
      mentorName: roster.find((u) => u.email === m.created_by)?.name ?? m.created_by,
      status: "ready",
      error: null,
      recordingUrl: m.recording_url,
      transcriptUrl: m.transcript_url,
      transcript: m.transcript_text,
      summary: m.summary,
    });
  }
  return out.sort((a, b) => b.callAt.localeCompare(a.callAt));
}

export async function uploadedDeviceKeys(email: string, since: Date): Promise<string[]> {
  const rows = await query<{ device_key: string }>("select device_key from app.call_recordings where mentor_email = $1 and call_at >= $2", [email, since]);
  return rows.map((r) => r.device_key);
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface CallAnalytics {
  from: string;
  to: string;
  members: { email: string; name: string; calls: number; totalSec: number; avgSec: number; phoneCalls: number; meetCalls: number }[];
  team: { calls: number; totalSec: number; avgSec: number };
  daily: { day: string; calls: number; totalSec: number }[];
}

/** Prep calls per mentor between two IST days, from the recordings' real durations. */
export async function callAnalytics(from: string, to: string, onlyEmail: string | null): Promise<CallAnalytics> {
  const rows = await query<{ email: string; source: string; day: string; secs: number }>(
    // "day" is a SQL keyword: every alias takes AS.
    `select mentor_email as email, 'phone' as source, to_char(call_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day, duration_sec as secs
       from app.call_recordings where status <> 'failed'
        and (call_at at time zone 'Asia/Kolkata')::date between $1::date and $2::date
     union all
     select created_by, 'meet', to_char(starts_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD'), duration_sec
       from app.meetings where kind = 'prep' and artifacts_status = 'ready' and duration_sec is not null
        and (starts_at at time zone 'Asia/Kolkata')::date between $1::date and $2::date`,
    [from, to],
  );
  const roster = await listRoster();
  const filtered = onlyEmail ? rows.filter((r) => r.email === onlyEmail) : rows;
  const by = new Map<string, CallAnalytics["members"][number]>();
  const daily = new Map<string, { calls: number; totalSec: number }>();
  for (const r of filtered) {
    const m = by.get(r.email) ?? { email: r.email, name: roster.find((u) => u.email === r.email)?.name ?? r.email, calls: 0, totalSec: 0, avgSec: 0, phoneCalls: 0, meetCalls: 0 };
    m.calls++;
    m.totalSec += Number(r.secs) || 0;
    if (r.source === "phone") m.phoneCalls++;
    else m.meetCalls++;
    by.set(r.email, m);
    const d = daily.get(r.day) ?? { calls: 0, totalSec: 0 };
    d.calls++;
    d.totalSec += Number(r.secs) || 0;
    daily.set(r.day, d);
  }
  const members = [...by.values()].map((m) => ({ ...m, avgSec: m.calls ? Math.round(m.totalSec / m.calls) : 0 })).sort((a, b) => b.totalSec - a.totalSec);
  const calls = members.reduce((s, m) => s + m.calls, 0);
  const totalSec = members.reduce((s, m) => s + m.totalSec, 0);
  return {
    from,
    to,
    members,
    team: { calls, totalSec, avgSec: calls ? Math.round(totalSec / calls) : 0 },
    daily: [...daily.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
