import "server-only";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { normRound } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { listRoster, type RosterUser } from "@/lib/mobile/roster";
import { pushToUser } from "@/lib/mobile/push";
import { downloadFile, shareWith, subFolder, uploadFile } from "@/lib/team/drive";
import { recordCallInSheet } from "@/lib/team/sheetlog";
import { transcribe } from "@/lib/team/stt";
import { durationText, summariseCall } from "@/lib/team/summary";

/**
 * Prep calls recorded by the mentors' phones, submitted from the app: the audio is saved to the
 * team Drive, transcribed (ElevenLabs / Deepgram) and summarised, and the transcript and summary
 * are written to the drill-down row (Prep Call Recording / Transcript / Summary / Duration). The
 * database keeps only what's needed to process the file and count call time: who, when, the real
 * length (from the file itself) and the status — never the transcript or the summary.
 */

/** 40 MB ≈ an hour of phone-call audio; keeps the free server well inside its memory. */
export const MAX_RECORDING_BYTES = 40 * 1024 * 1024;
const AUDIO = /^audio\/|^video\/mp4$|^application\/octet-stream$/;

/** What the app gets back: the call is saved; the sheet columns follow in a minute or two. */
export interface SubmittedRecording {
  id: string;
  callAt: string;
  durationSec: number;
  status: string;
}

interface RecRow {
  id: string;
  prep_key: string;
  mentor_email: string;
  call_at: Date;
  duration_sec: number;
  drive_file_id: string | null;
  drive_url: string | null;
  status: string;
}

export async function uploadPhoneRecording(
  user: RosterUser,
  key: string,
  file: { bytes: Buffer; mime: string; name: string },
  meta: { callAt: Date; durationSec: number; deviceKey: string },
): Promise<SubmittedRecording> {
  if (file.bytes.length === 0) throw new UserError(422, "The recording is empty.", "invalid_recording");
  if (file.bytes.length > MAX_RECORDING_BYTES) throw new UserError(413, "The recording is larger than 40 MB.", "recording_too_large");
  if (!AUDIO.test(file.mime)) throw new UserError(415, "That file isn't an audio recording.", "invalid_recording");
  if (!/^[\w.:-]{6,200}$/.test(meta.deviceKey)) throw new UserError(422, "Missing recording id.", "invalid_recording");
  if (!Number.isFinite(meta.callAt.getTime()) || meta.callAt.getTime() > Date.now() + 5 * 60_000) throw new UserError(422, "The call time isn't valid.", "invalid_recording");
  if (!Number.isFinite(meta.durationSec) || meta.durationSec < 1 || meta.durationSec > 6 * 3600) throw new UserError(422, "The call duration isn't valid.", "invalid_recording");
  const snap = await readPrepSnapshot();
  const p = snap.byKey.get(key);
  if (!p) throw new UserError(404, "This prep is no longer in the drill-down sheet.", "not_found");

  // Same file submitted again (a retry after a dropped connection): answer with what we have.
  const existing = await query<RecRow>("select * from app.call_recordings where device_key = $1", [meta.deviceKey]);
  if (existing[0]?.drive_file_id) return submitted(existing[0]);

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
  const rows = await query<RecRow>(
    `insert into app.call_recordings (prep_key, mentor_email, device_key, call_at, duration_sec, file_name, drive_file_id, drive_url, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'transcribing')
     on conflict (device_key) do update set drive_file_id = excluded.drive_file_id, drive_url = excluded.drive_url, status = 'transcribing', error = null, updated_at = now()
     returning *`,
    [key, user.email, meta.deviceKey, meta.callAt, Math.round(meta.durationSec), file.name.slice(0, 200), audio.id, audio.url],
  );
  await audit(user.email, "call_recording_submitted", key, { durationSec: meta.durationSec, callAt: meta.callAt.toISOString() });
  void processRecording(rows[0].id, file).catch((err) => console.error("[recordings] crashed:", err instanceof Error ? err.message : err));
  return submitted(rows[0]);
}

const submitted = (r: RecRow): SubmittedRecording => ({ id: r.id, callAt: r.call_at.toISOString(), durationSec: r.duration_sec, status: r.status });

const audit = (actor: string, action: string, target: string, detail: Record<string, unknown>) =>
  query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [actor, action, target, JSON.stringify(detail)]).catch(() => undefined);

const ext = (mime: string, name: string) => name.match(/\.(m4a|mp3|aac|amr|wav|ogg|opus|3gp|mp4)$/i)?.[0] ?? (mime.includes("mpeg") ? ".mp3" : ".m4a");

/** "2026-11-08 16:05" in IST. */
const istStamp = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ");

const g = globalThis as unknown as { __recRunning?: Set<string> };
const running = (g.__recRunning ??= new Set());

/**
 * Transcript → summary → the row's call columns, in one pass held in memory (nothing of the text
 * is stored in the database). A failure marks the recording failed; the ticker retries from the
 * Drive file (3 attempts), so a provider outage only delays the sheet.
 */
async function processRecording(id: string, file?: { bytes: Buffer; mime: string; name: string }): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    const rec = (await query<RecRow>("select * from app.call_recordings where id = $1", [id]))[0];
    if (!rec || rec.status === "ready") return;
    const snap = await readPrepSnapshot().catch(() => null);
    const p = snap?.byKey.get(rec.prep_key);
    const ctx = { company: p?.company ?? "Company", round: normRound(p?.round ?? "") || "Prep", candidate: p?.candidate ?? "Candidate" };
    await query("update app.call_recordings set attempts = attempts + 1, updated_at = now() where id = $1", [id]);
    try {
      await setStatus(id, "transcribing");
      const audio = file ?? (rec.drive_file_id ? await downloadFile(rec.drive_file_id) : null);
      if (!audio) throw new Error("The recording file is missing; submit it again.");
      const transcript = (await transcribe(audio.bytes, audio.mime)).text;
      await setStatus(id, "summarising");
      // A call with almost no speech (voicemail, a dropped line) has nothing to summarise.
      const summary = transcript.trim().length >= 200 ? await summariseCall(transcript, { company: ctx.company, round: ctx.round }) : null;
      // Ready first (so the duration total counts this call), then the sheet; a failed sheet write
      // puts it back to failed and the ticker writes it again.
      await query("update app.call_recordings set status = 'ready', error = null, updated_at = now() where id = $1", [id]);
      const roster = await listRoster();
      try {
        await recordCallInSheet(rec.prep_key, {
          tag: `c${rec.id.replace(/-/g, "").slice(0, 8)}`,
          at: rec.call_at,
          source: "Phone call",
          by: roster.find((u) => u.email === rec.mentor_email)?.name ?? rec.mentor_email,
          durationSec: rec.duration_sec,
          recordingUrl: rec.drive_url,
          transcript,
          summary,
        });
      } catch (err) {
        await setStatus(id, "failed", `Not written to the sheet: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
        return;
      }
      await query("update app.call_recordings set sheet_written_at = now() where id = $1", [id]);
      await pushToUser({
        email: rec.mentor_email,
        kind: "recording_ready",
        data: { prepId: rec.prep_key, title: "Call added to the sheet", body: `${ctx.candidate} · ${ctx.company} · ${durationText(rec.duration_sec)}` },
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
       from app.meetings where kind in ('prep', 'mock', 'guidance') and artifacts_status = 'ready' and duration_sec is not null
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
