import "server-only";
import { randomUUID } from "node:crypto";
import { google, type Auth, type calendar_v3 } from "googleapis";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { normRound, type PrepRow } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster, type RosterUser } from "@/lib/mobile/roster";
import { jobKeyOf } from "@/lib/prepdocs/service";
import { isEmail } from "@/lib/team/contacts";
import { readGoogleDocText, shareWith } from "@/lib/team/drive";
import { withTeam } from "@/lib/team/google";
import { sendEmail } from "@/lib/team/mail";
import { logMessageInSheet, messageLine, recordCallInSheet } from "@/lib/team/sheetlog";
import { type CallSummary, summariseCall } from "@/lib/team/summary";
import { istRange, istWhen, type MeetingKind, whatsappMeeting } from "@/lib/team/templates";

/**
 * Meetings created as the team account: a Google Calendar event with a Meet link, Meet's auto
 * recording + transcript switched on for the space, an email (with a calendar invite) from the
 * team account sent now or at a set time, and — after the call — the real duration, recording,
 * transcript and an AI summary pulled from Meet.
 *
 * Placeholders in the email subject / body: {meet_link} and {when} are filled once the Meet link
 * exists (the draft is written before it does).
 */

export const MEETING_KINDS: MeetingKind[] = ["prep", "guidance", "mock", "custom"];
const MEET = "https://meet.googleapis.com/v2";

export interface MeetingInput {
  kind?: unknown;
  prepId?: unknown;
  /** Guidance for several candidates: their preps (the emails go to each; the call is logged on each row). */
  prepIds?: unknown;
  jobId?: unknown;
  company?: unknown;
  title?: unknown;
  startsAt?: unknown;
  durationMin?: unknown;
  attendees?: unknown;
  record?: unknown;
  email?: unknown;
  force?: unknown;
}

export interface MeetingDto {
  id: string;
  kind: MeetingKind;
  title: string;
  prepId: string | null;
  /** Every prep the meeting is for (one for a prep call, several for a guidance session). */
  prepIds: string[];
  jobKey: string | null;
  company: string;
  startsAt: string;
  endsAt: string;
  meetUrl: string | null;
  calendarUrl: string | null;
  record: boolean;
  recordingOn: boolean | null;
  attendees: { email: string; name: string }[];
  status: "scheduled" | "cancelled";
  email: { status: string; subject: string; sendAt: string | null; sentAt: string | null; error: string | null };
  /** After the call: the real duration. Transcript and summary go to the drill-down rows only. */
  artifacts: {
    status: string;
    durationSec: number | null;
    recordingUrl: string | null;
    transcriptUrl: string | null;
  };
  createdBy: string;
  createdByName: string;
  /** WhatsApp text with the Meet link, per candidate attendee (filled in). */
  whatsapp: string;
  warnings: string[];
}

interface MeetingRow {
  id: string;
  kind: MeetingKind;
  title: string;
  prep_key: string | null;
  prep_keys: string[];
  job_key: string | null;
  company: string;
  starts_at: Date;
  ends_at: Date;
  calendar_event_id: string | null;
  meet_space: string | null;
  meet_code: string | null;
  meet_url: string | null;
  record: boolean;
  recording_on: boolean | null;
  attendees: { email: string; name: string }[];
  status: "scheduled" | "cancelled";
  email_subject: string;
  email_body: string;
  email_status: string;
  email_send_at: Date | null;
  email_sent_at: Date | null;
  email_error: string | null;
  conference_record: string | null;
  recording_file_id: string | null;
  recording_url: string | null;
  transcript_url: string | null;
  duration_sec: number | null;
  artifacts_status: string;
  created_by: string;
  created_at: Date;
}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const audit = (actor: string, action: string, target: string, detail: Record<string, unknown>) =>
  query("insert into app.audit_log (actor_email, action, target, detail) values ($1, $2, $3, $4)", [actor, action, target, JSON.stringify(detail)]).catch(() => undefined);

const fill = (text: string, r: { meet_url: string | null; starts_at: Date; ends_at: Date }) =>
  text.replace(/\{meet_link\}/g, r.meet_url ?? "").replace(/\{when\}/g, istRange(r.starts_at, r.ends_at));

function emailText(r: MeetingRow): string {
  let body = fill(r.email_body, r);
  if (r.meet_url && !body.includes(r.meet_url)) body += `\n\nGoogle Meet: ${r.meet_url}\nWhen: ${istRange(r.starts_at, r.ends_at)}`;
  return body;
}

async function meetFetch<T>(auth: Auth.OAuth2Client, path: string, init: RequestInit = {}): Promise<T> {
  const { token } = await auth.getAccessToken();
  const res = await fetch(`${MEET}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Meet ${res.status}: ${(await res.text()).slice(0, 240)}`);
  return (await res.json()) as T;
}

/** Turns on Meet's own recording + transcript for the space (the organiser is the team account). */
async function enableArtifacts(auth: Auth.OAuth2Client, meetCode: string, record: boolean): Promise<{ space: string | null; on: boolean; warning: string | null }> {
  let space: string | null = null;
  try {
    space = (await meetFetch<{ name: string }>(auth, `spaces/${encodeURIComponent(meetCode)}`)).name ?? null;
    if (!record || !space) return { space, on: false, warning: null };
    const autoRecord = process.env.MEET_AUTO_RECORD?.trim().toLowerCase() !== "off";
    const autoTranscribe = process.env.MEET_AUTO_TRANSCRIBE?.trim().toLowerCase() !== "off";
    const mask = [
      autoRecord && "config.artifactConfig.recordingConfig.autoRecordingGeneration",
      autoTranscribe && "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
    ].filter(Boolean);
    if (!mask.length) return { space, on: false, warning: null };
    await meetFetch(auth, `${space}?updateMask=${mask.join(",")}`, {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          artifactConfig: {
            ...(autoRecord ? { recordingConfig: { autoRecordingGeneration: "ON" } } : {}),
            ...(autoTranscribe ? { transcriptionConfig: { autoTranscriptionGeneration: "ON" } } : {}),
          },
        },
      }),
    });
    return { space, on: true, warning: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[meetings] auto-record not set:", msg.slice(0, 240));
    return { space, on: false, warning: "Meet didn't accept auto-recording for this call. Start the recording from the Meet window." };
  }
}

function cleanAttendees(raw: unknown): { email: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { email: string; name: string }[] = [];
  for (const a of raw) {
    const email = str((a as { email?: unknown })?.email, 254).toLowerCase();
    if (!email) continue;
    if (!isEmail(email)) throw new UserError(422, `"${email}" isn't a valid email.`, "invalid_attendee");
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: str((a as { name?: unknown })?.name, 120) });
  }
  if (out.length > 100) throw new UserError(422, "A meeting can have at most 100 guests.", "invalid_attendee");
  return out;
}

/** The preps of a guidance session: every id must be a prep in the sheet (at most 100). */
async function prepsOf(raw: unknown): Promise<PrepRow[]> {
  if (!Array.isArray(raw) || !raw.length) return [];
  const ids = [...new Set(raw.map((x) => String(x ?? "")))];
  if (ids.length > 100) throw new UserError(422, "A guidance session can have at most 100 candidates.", "invalid_meeting");
  const snap = await readPrepSnapshot();
  return ids.map((id) => {
    const p = /^[0-9a-f]{24}$/.test(id) ? snap.byKey.get(id) : undefined;
    if (!p) throw new UserError(404, "One of the candidates is no longer in the drill-down sheet. Refresh and pick again.", "not_found");
    return p;
  });
}

async function context(kind: MeetingKind, prepId: string, jobId: string, company: string): Promise<{ prep: PrepRow | null; jobKey: string | null; company: string }> {
  if (prepId) {
    if (!/^[0-9a-f]{24}$/.test(prepId)) throw new UserError(404, "This prep doesn't exist.", "not_found");
    const p = (await readPrepSnapshot()).byKey.get(prepId);
    if (!p) throw new UserError(404, "This prep is no longer in the drill-down sheet.", "not_found");
    return { prep: p, jobKey: jobKeyOf(p), company: p.company };
  }
  if (jobId) {
    const p = (await readPrepSnapshot()).preps.find((x) => x.jobId === jobId);
    if (!p && !company) throw new UserError(404, "This job isn't in the drill-down sheet.", "not_found");
    return { prep: null, jobKey: jobId, company: p?.company ?? company };
  }
  if (kind === "prep" || kind === "mock") throw new UserError(422, "Pick the prep this meeting is for.", "invalid_meeting");
  return { prep: null, jobKey: null, company };
}

function defaultTitle(kind: MeetingKind, company: string, prep: PrepRow | null): string {
  const round = prep ? normRound(prep.round) : "";
  const who = prep?.candidate ? ` · ${prep.candidate}` : "";
  if (kind === "prep") return `Interview prep: ${[company, round].filter(Boolean).join(" ")}${who}`;
  if (kind === "mock") return `Mock interview: ${[company, round].filter(Boolean).join(" ")}${who}`;
  if (kind === "guidance") return company ? `Guidance session: ${company}` : "Guidance session";
  return company ? `Meeting: ${company}` : "Meeting";
}

/** Creates the calendar event + Meet link, switches on recording, sends or schedules the email. */
export async function createMeeting(user: RosterUser, input: MeetingInput): Promise<MeetingDto> {
  const kind = str(input.kind) as MeetingKind;
  if (!MEETING_KINDS.includes(kind)) throw new UserError(422, "Pick the meeting type.", "invalid_meeting");
  const start = new Date(str(input.startsAt, 40));
  if (!Number.isFinite(start.getTime())) throw new UserError(422, "Pick when the meeting starts.", "invalid_meeting");
  if (start.getTime() < Date.now() - 10 * 60_000) throw new UserError(422, "That time has already passed.", "invalid_meeting");
  if (start.getTime() > Date.now() + 120 * 86_400_000) throw new UserError(422, "Meetings can be scheduled up to 120 days ahead.", "invalid_meeting");
  const minutes = Math.round(Number(input.durationMin));
  if (!Number.isFinite(minutes) || minutes < 10 || minutes > 240) throw new UserError(422, "A meeting lasts between 10 minutes and 4 hours.", "invalid_meeting");
  const end = new Date(start.getTime() + minutes * 60_000);
  const attendees = cleanAttendees(input.attendees);
  if (!attendees.length) throw new UserError(422, "Add at least one guest's email.", "invalid_attendee");
  const record = input.record !== false;
  const force = input.force === true;
  const em = (input.email ?? {}) as { mode?: unknown; subject?: unknown; body?: unknown; sendAt?: unknown };
  const mode = str(em.mode) || "none";
  if (!["now", "scheduled", "none"].includes(mode)) throw new UserError(422, "Choose when the email goes out.", "invalid_meeting");
  const subject = str(em.subject, 300);
  const body = str(em.body, 8000);
  if (mode !== "none" && (!subject || !body)) throw new UserError(422, "Write the email's subject and message.", "invalid_meeting");
  let sendAt: Date | null = null;
  if (mode === "scheduled") {
    sendAt = new Date(str(em.sendAt, 40));
    if (!Number.isFinite(sendAt.getTime()) || sendAt.getTime() < Date.now() - 60_000) throw new UserError(422, "Pick a future time for the email.", "invalid_meeting");
    if (sendAt.getTime() > start.getTime()) throw new UserError(422, "The email must go out before the meeting starts.", "invalid_meeting");
  }

  const group = kind === "guidance" || kind === "custom" ? await prepsOf(input.prepIds) : [];
  const companies = [...new Set(group.map((p) => p.company))];
  const jobs = [...new Set(group.map((p) => p.jobId).filter(Boolean))];
  const ctx = group.length
    ? { prep: null, jobKey: jobs.length === 1 ? jobs[0] : null, company: companies.length === 1 ? companies[0] : str(input.company, 200) }
    : await context(kind, str(input.prepId, 40), str(input.jobId, 80), str(input.company, 200));
  const title = str(input.title, 200) || defaultTitle(kind, ctx.company, ctx.prep);
  const prepKey = ctx.prep?.key ?? null;
  const prepKeys = prepKey ? [prepKey] : group.map((p) => p.key);

  if (!force) {
    if (prepKey) {
      const dup = await query<{ starts_at: Date }>(
        "select starts_at from app.meetings where prep_key = $1 and kind = $2 and status = 'scheduled' and abs(extract(epoch from starts_at - $3::timestamptz)) < 3600 limit 1",
        [prepKey, kind, start],
      );
      if (dup.length) throw new UserError(409, `A ${kind} meeting for this prep is already scheduled at ${istWhen(dup[0].starts_at)}.`, "duplicate_meeting");
    }
    const clash = await query<{ title: string; starts_at: Date; ends_at: Date }>(
      `select title, starts_at, ends_at from app.meetings m
        where status = 'scheduled' and starts_at < $2 and ends_at > $1
          and (created_by = $3 or exists (select 1 from jsonb_array_elements(m.attendees) a where a->>'email' = any($4::text[])))
        order by starts_at limit 1`,
      [start, end, user.email, attendees.map((a) => a.email)],
    );
    if (clash.length) throw new UserError(409, `This overlaps "${clash[0].title}" (${istRange(clash[0].starts_at, clash[0].ends_at)}).`, "meeting_conflict");
  }

  const guests = attendees.some((a) => a.email === user.email) ? attendees : [...attendees, { email: user.email, name: user.name }];
  const created = await withTeam(async (auth) => {
    const cal = google.calendar({ version: "v3", auth });
    const ev = await cal.events.insert({
      calendarId: "primary",
      conferenceDataVersion: 1,
      sendUpdates: "none",
      requestBody: {
        summary: title,
        description: body ? fill(body, { meet_url: null, starts_at: start, ends_at: end }).replace(/^.*Google Meet:\s*$/gm, "").replace(/\n{3,}/g, "\n\n") : `Scheduled by ${user.name} (NxtWave Placements).`,
        start: { dateTime: start.toISOString(), timeZone: "Asia/Kolkata" },
        end: { dateTime: end.toISOString(), timeZone: "Asia/Kolkata" },
        attendees: guests.map((a) => ({ email: a.email, displayName: a.name || undefined })),
        guestsCanSeeOtherGuests: kind !== "guidance",
        guestsCanInviteOthers: false,
        conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
      },
    });
    let event: calendar_v3.Schema$Event = ev.data;
    for (let i = 0; i < 4 && !event.hangoutLink && event.conferenceData?.createRequest?.status?.statusCode === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 800));
      event = (await cal.events.get({ calendarId: "primary", eventId: event.id! })).data;
    }
    const meetUrl = event.hangoutLink ?? event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? null;
    const code = event.conferenceData?.conferenceId ?? meetUrl?.split("/").pop() ?? null;
    if (!meetUrl || !code) {
      await cal.events.delete({ calendarId: "primary", eventId: event.id!, sendUpdates: "none" }).catch(() => undefined);
      throw new UserError(502, "Google didn't create a Meet link. Try again.", "meet_unavailable");
    }
    const art = await enableArtifacts(auth, code, record);
    return { event, meetUrl, code, art };
  });

  let row: MeetingRow;
  try {
    row = (
      await query<MeetingRow>(
        `insert into app.meetings (kind, title, prep_key, prep_keys, job_key, company, starts_at, ends_at, calendar_event_id, meet_space, meet_code, meet_url,
           record, recording_on, attendees, email_subject, email_body, email_status, email_send_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
        [
          kind, title, prepKey, prepKeys, ctx.jobKey, ctx.company, start, end, created.event.id, created.art.space, created.code, created.meetUrl,
          record, record ? created.art.on : null, JSON.stringify(guests), subject, body, mode === "scheduled" ? "scheduled" : "none", sendAt, user.email,
        ],
      )
    )[0];
  } catch (err) {
    await withTeam((auth) => google.calendar({ version: "v3", auth }).events.delete({ calendarId: "primary", eventId: created.event.id!, sendUpdates: "none" })).catch(() => undefined);
    throw err;
  }
  await audit(user.email, "meeting_created", row.id, { kind, prepKey, preps: prepKeys.length, jobKey: ctx.jobKey, startsAt: start.toISOString(), guests: guests.length, record, email: mode });
  const warnings = created.art.warning ? [created.art.warning] : [];
  if (mode === "now") {
    const sent = await sendMeetingEmails(row, user.email);
    row = sent.row;
    if (sent.failed) warnings.push(`The email didn't reach ${sent.failed} guest${sent.failed > 1 ? "s" : ""}: ${row.email_error ?? ""}`.trim());
  }
  return toDto(row, await listRoster(), warnings, created.event.htmlLink ?? null);
}

/** Emails every guest (one email each, so guests don't see each other), with the invite attached. */
async function sendMeetingEmails(r: MeetingRow, actor: string, method: "REQUEST" | "CANCEL" = "REQUEST"): Promise<{ row: MeetingRow; failed: number }> {
  const uidRows = r.calendar_event_id
    ? await withTeam((auth) => google.calendar({ version: "v3", auth }).events.get({ calendarId: "primary", eventId: r.calendar_event_id! }))
        .then((e) => e.data.iCalUID ?? null)
        .catch(() => null)
    : null;
  const uid = uidRows ?? `${r.id}@psm.nxtwave`;
  const text = method === "CANCEL" ? `This meeting has been cancelled: ${r.title} (${istRange(r.starts_at, r.ends_at)}).\n\nRegards,\nNxtWave Placements` : emailText(r);
  const subject = method === "CANCEL" ? `Cancelled: ${fill(r.email_subject || r.title, r)}` : fill(r.email_subject, r);
  let failed = 0;
  let lastError: string | null = null;
  const lines: string[] = [];
  const by = (await listRoster()).find((u) => u.email === actor)?.name ?? actor;
  const what = method === "CANCEL" ? "Meeting cancellation" : `${KIND_LABEL[r.kind]} invite`;
  for (const a of r.attendees) {
    try {
      await sendEmail({
        to: [a.email],
        replyTo: r.created_by,
        subject,
        text,
        invite: {
          uid,
          sequence: method === "CANCEL" ? 1 : 0,
          start: r.starts_at,
          end: r.ends_at,
          title: r.title,
          description: text,
          location: r.meet_url ?? "",
          attendees: [{ email: a.email, name: a.name }],
          method,
        },
      });
      lines.push(messageLine({ channel: "Email", purpose: what, to: a.email, status: "sent", by }));
    } catch (err) {
      failed++;
      lastError = err instanceof Error ? err.message.slice(0, 300) : String(err);
      lines.push(messageLine({ channel: "Email", purpose: what, to: a.email, status: "failed", by, error: lastError }));
    }
  }
  // Each candidate's row gets the lines (newest first, so the list reads top-down).
  if (lines.length) await logMessageInSheet(keysOf(r), lines.reverse().join("\n"));
  if (method === "CANCEL") return { row: r, failed };
  const ok = failed < r.attendees.length;
  const row = (
    await query<MeetingRow>(
      "update app.meetings set email_status = $2, email_sent_at = case when $3 then now() else email_sent_at end, email_error = $4, updated_at = now() where id = $1 returning *",
      [r.id, ok ? "sent" : "failed", ok, lastError],
    )
  )[0];
  return { row, failed };
}

const KIND_LABEL: Record<MeetingKind, string> = { prep: "Prep call", mock: "Mock interview", guidance: "Guidance session", custom: "Meeting" };

/** The drill-down rows a meeting belongs to. */
const keysOf = (r: Pick<MeetingRow, "prep_key" | "prep_keys">) => [...new Set([r.prep_key, ...(r.prep_keys ?? [])].filter((k): k is string => Boolean(k)))];

export async function cancelMeeting(user: RosterUser, id: string): Promise<MeetingDto> {
  const r = (await query<MeetingRow>("select * from app.meetings where id = $1", [id]))[0];
  if (!r) throw new UserError(404, "This meeting doesn't exist.", "not_found");
  if (r.created_by !== user.email && user.role !== "admin") throw new UserError(403, "Only the person who scheduled it (or an admin) can cancel it.", "forbidden");
  if (r.status === "cancelled") return toDto(r, await listRoster(), [], null);
  if (r.calendar_event_id) {
    await withTeam((auth) => google.calendar({ version: "v3", auth }).events.delete({ calendarId: "primary", eventId: r.calendar_event_id!, sendUpdates: "none" })).catch((err) => {
      if (!/404|410|deleted/i.test(String(err))) throw err;
    });
  }
  if (r.email_status === "sent" && r.ends_at > new Date()) await sendMeetingEmails(r, user.email, "CANCEL");
  const row = (
    await query<MeetingRow>(
      "update app.meetings set status = 'cancelled', email_status = case when email_status = 'scheduled' then 'none' else email_status end, artifacts_status = case when artifacts_status = 'pending' then 'none' else artifacts_status end, updated_at = now() where id = $1 returning *",
      [id],
    )
  )[0];
  await audit(user.email, "meeting_cancelled", id, { kind: r.kind, prepKey: r.prep_key });
  return toDto(row, await listRoster(), [], null);
}

/** Sends a meeting's email again (e.g. after it failed). */
export async function resendMeetingEmail(user: RosterUser, id: string): Promise<MeetingDto> {
  const r = (await query<MeetingRow>("select * from app.meetings where id = $1", [id]))[0];
  if (!r) throw new UserError(404, "This meeting doesn't exist.", "not_found");
  if (r.status !== "scheduled") throw new UserError(409, "This meeting was cancelled.", "meeting_cancelled");
  if (!r.email_subject || !r.email_body) throw new UserError(422, "This meeting has no email to send.", "invalid_meeting");
  const sent = await sendMeetingEmails(r, user.email);
  return toDto(sent.row, await listRoster(), sent.failed ? [`The email didn't reach ${sent.failed} guest(s).`] : [], null);
}

export async function listMeetings(user: RosterUser, opts: { from: Date; to: Date; prepKey?: string; jobKey?: string; mine?: boolean }): Promise<MeetingDto[]> {
  const rows = await query<MeetingRow>(
    `select * from app.meetings where starts_at >= $1 and starts_at < $2
       and ($3::text is null or prep_key = $3 or $3 = any(prep_keys)) and ($4::text is null or job_key = $4) and ($5::text is null or created_by = $5)
     order by starts_at limit 500`,
    [opts.from, opts.to, opts.prepKey ?? null, opts.jobKey ?? null, opts.mine ? user.email : null],
  );
  const roster = await listRoster();
  return rows.map((r) => toDto(r, roster, [], null));
}

export async function meetingsFor(prepKey: string): Promise<MeetingDto[]> {
  const rows = await query<MeetingRow>("select * from app.meetings where prep_key = $1 or $1 = any(prep_keys) order by starts_at desc limit 50", [prepKey]);
  const roster = await listRoster();
  return rows.map((r) => toDto(r, roster, [], null));
}

function toDto(r: MeetingRow, roster: RosterUser[], warnings: string[], calendarUrl: string | null): MeetingDto {
  const creator = roster.find((u) => u.email === r.created_by);
  const candidate = r.attendees.find((a) => a.email !== r.created_by);
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    prepId: r.prep_key,
    prepIds: keysOf(r),
    jobKey: r.job_key,
    company: r.company,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    meetUrl: r.meet_url,
    calendarUrl,
    record: r.record,
    recordingOn: r.recording_on,
    attendees: r.attendees,
    status: r.status,
    email: {
      status: r.email_status,
      subject: fill(r.email_subject, r),
      sendAt: r.email_send_at?.toISOString() ?? null,
      sentAt: r.email_sent_at?.toISOString() ?? null,
      error: r.email_error,
    },
    artifacts: {
      status: r.artifacts_status,
      durationSec: r.duration_sec,
      recordingUrl: r.recording_url,
      transcriptUrl: r.transcript_url,
    },
    createdBy: r.created_by,
    createdByName: creator?.name ?? r.created_by,
    whatsapp: whatsappMeeting(r.kind, {
      candidate: r.attendees.length === 2 || r.kind !== "guidance" ? candidate?.name : undefined,
      company: r.company,
      mentor: creator?.name ?? "NxtWave Placements",
      meetUrl: r.meet_url ?? undefined,
      meetWhen: istRange(r.starts_at, r.ends_at),
    }),
    warnings,
  };
}

// ── Background work (the minute ticker) ─────────────────────────────────────

const gt = globalThis as unknown as { __meetLastArtifacts?: number; __meetBusy?: boolean };

/** Scheduled emails that are due, 10-minute reminders, and Meet artifacts after calls. */
export async function syncMeetings(now = new Date()): Promise<{ emails: number; reminders: number; artifacts: number }> {
  if (gt.__meetBusy) return { emails: 0, reminders: 0, artifacts: 0 };
  gt.__meetBusy = true;
  try {
    let emails = 0;
    const due = await query<MeetingRow>("select * from app.meetings where email_status = 'scheduled' and status = 'scheduled' and email_send_at <= $1 order by email_send_at limit 10", [now]);
    for (const r of due) {
      // Claim it first so two ticks never send twice.
      const claimed = await query("update app.meetings set email_status = 'none', updated_at = now() where id = $1 and email_status = 'scheduled' returning id", [r.id]);
      if (!claimed.length) continue;
      try {
        await sendMeetingEmails(r, r.created_by);
        emails++;
      } catch (err) {
        await query("update app.meetings set email_status = 'failed', email_error = $2 where id = $1", [r.id, err instanceof Error ? err.message.slice(0, 300) : String(err)]);
      }
    }

    let reminders = 0;
    const soon = await query<MeetingRow>(
      "update app.meetings set reminded_at = now() where status = 'scheduled' and reminded_at is null and starts_at > $1 and starts_at <= $1::timestamptz + interval '11 minutes' returning *",
      [now],
    );
    for (const r of soon) {
      await pushToUser({
        email: r.created_by,
        kind: "meeting_reminder",
        dedupeKey: `meet:soon:${r.id}`,
        data: { meetingId: r.id, ...(r.prep_key ? { prepId: r.prep_key } : {}), meetUrl: r.meet_url ?? "", title: `Starts in 10 min · ${r.company || r.title}`, body: r.title },
      }).catch(() => undefined);
      reminders++;
    }

    let artifacts = 0;
    if (!gt.__meetLastArtifacts || now.getTime() - gt.__meetLastArtifacts > 5 * 60_000) {
      gt.__meetLastArtifacts = now.getTime();
      artifacts = await syncArtifacts(now).catch((err) => {
        console.warn("[meetings] artifacts:", err instanceof Error ? err.message.slice(0, 200) : err);
        return 0;
      });
    }
    return { emails, reminders, artifacts };
  } finally {
    gt.__meetBusy = false;
  }
}

interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
}
interface Artifact {
  name: string;
  state?: string;
  driveDestination?: { file?: string; exportUri?: string };
  docsDestination?: { document?: string; exportUri?: string };
}

async function syncArtifacts(now: Date): Promise<number> {
  const rows = await query<MeetingRow>(
    `select * from app.meetings where status = 'scheduled' and artifacts_status = 'pending' and meet_code is not null
       and ends_at < $1::timestamptz - interval '5 minutes'
       and (artifacts_checked_at is null or artifacts_checked_at < $1::timestamptz - interval '10 minutes')
     order by ends_at limit 5`,
    [now],
  );
  let done = 0;
  for (const r of rows) {
    await query("update app.meetings set artifacts_checked_at = now() where id = $1", [r.id]);
    try {
      if (await collect(r, now)) done++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[meetings] artifacts failed:", r.id.slice(0, 8), msg.slice(0, 200));
      if (now.getTime() - r.ends_at.getTime() > 48 * 3600_000) await query("update app.meetings set artifacts_status = 'failed' where id = $1", [r.id]);
    }
  }
  return done;
}

/** One meeting: real duration from Meet's conference records, recording + transcript files, summary. */
async function collect(r: MeetingRow, now: Date): Promise<boolean> {
  const sinceEnd = now.getTime() - r.ends_at.getTime();
  const found = await withTeam(async (auth) => {
    const space = r.meet_space ?? (await meetFetch<{ name: string }>(auth, `spaces/${encodeURIComponent(r.meet_code!)}`)).name;
    const list = await meetFetch<{ conferenceRecords?: ConferenceRecord[] }>(auth, `conferenceRecords?filter=${encodeURIComponent(`space.name="${space}"`)}`);
    const records = (list.conferenceRecords ?? []).filter((c) => c.startTime);
    if (!records.length) return { space, records, recordings: [] as Artifact[], transcripts: [] as Artifact[] };
    const recordings: Artifact[] = [];
    const transcripts: Artifact[] = [];
    for (const c of records) {
      recordings.push(...((await meetFetch<{ recordings?: Artifact[] }>(auth, `${c.name}/recordings`)).recordings ?? []));
      transcripts.push(...((await meetFetch<{ transcripts?: Artifact[] }>(auth, `${c.name}/transcripts`)).transcripts ?? []));
    }
    return { space, records, recordings, transcripts };
  });
  if (!found.records.length) {
    // Nobody joined (or Meet hasn't listed it yet): give up after 6 hours.
    if (sinceEnd > 6 * 3600_000) await query("update app.meetings set artifacts_status = 'none', meet_space = $2 where id = $1", [r.id, found.space]);
    return false;
  }
  if (found.records.some((c) => !c.endTime)) return false; // still in progress
  const durationSec = Math.round(found.records.reduce((s, c) => s + (Date.parse(c.endTime!) - Date.parse(c.startTime!)) / 1000, 0));
  const pendingFiles = [...found.recordings, ...found.transcripts].some((a) => a.state !== "FILE_GENERATED");
  if (pendingFiles && sinceEnd < 24 * 3600_000) {
    await query("update app.meetings set duration_sec = $2, conference_record = $3, meet_space = $4 where id = $1", [r.id, durationSec, found.records[0].name, found.space]);
    return false;
  }
  const rec = found.recordings.find((a) => a.state === "FILE_GENERATED" && a.driveDestination?.file);
  const docs = found.transcripts.filter((a) => a.state === "FILE_GENERATED" && a.docsDestination?.document);
  let transcript = "";
  for (const d of docs) transcript += `${await readGoogleDocText(d.docsDestination!.document!).catch(() => "")}\n`;
  transcript = transcript.trim();
  const team = (await listRoster()).filter((u) => u.active).map((u) => u.email);
  if (rec?.driveDestination?.file) await shareWith(rec.driveDestination.file, team).catch(() => undefined);
  for (const d of docs) await shareWith(d.docsDestination!.document!, team).catch(() => undefined);
  let summary: CallSummary | null = null;
  if (transcript.length >= 200) {
    const p = keysOf(r)[0] ? (await readPrepSnapshot().catch(() => null))?.byKey.get(keysOf(r)[0]) : null;
    summary = await summariseCall(transcript, { company: r.company, round: p ? normRound(p.round) : r.kind }).catch((err) => {
      console.warn("[meetings] summary failed:", err instanceof Error ? err.message.slice(0, 160) : err);
      return null;
    });
  }
  await query(
    `update app.meetings set artifacts_status = 'ready', duration_sec = $2, conference_record = $3, meet_space = $4, recording_file_id = $5, recording_url = $6,
       transcript_url = $7, updated_at = now() where id = $1`,
    [
      r.id,
      durationSec,
      found.records[0].name,
      found.space,
      rec?.driveDestination?.file ?? null,
      rec?.driveDestination?.exportUri ?? (rec?.driveDestination?.file ? `https://drive.google.com/file/d/${rec.driveDestination.file}/view` : null),
      docs[0]?.docsDestination?.exportUri ?? (docs[0] ? `https://docs.google.com/document/d/${docs[0].docsDestination!.document}/edit` : null),
    ],
  );
  // The call on each candidate's row (held in memory only; never stored in the database).
  const recordingUrl = rec?.driveDestination?.file ? `https://drive.google.com/file/d/${rec.driveDestination.file}/view` : null;
  const by = (await listRoster()).find((u) => u.email === r.created_by)?.name ?? r.created_by;
  let written = 0;
  for (const key of keysOf(r)) {
    await recordCallInSheet(key, {
      tag: `m${r.id.replace(/-/g, "").slice(0, 8)}`,
      at: new Date(found.records[0].startTime!),
      source: "Google Meet",
      by: `${by} (${KIND_LABEL[r.kind]})`,
      durationSec,
      recordingUrl,
      transcript,
      summary,
    })
      .then(() => written++)
      .catch((err) => console.warn("[meetings] sheet write failed:", err instanceof Error ? err.message.slice(0, 160) : err));
  }
  if (written) await query("update app.meetings set sheet_written_at = now() where id = $1", [r.id]);
  await pushToUser({
    email: r.created_by,
    kind: "recording_ready",
    dedupeKey: `meet:ready:${r.id}`,
    data: { meetingId: r.id, ...(r.prep_key ? { prepId: r.prep_key } : {}), title: written ? "Meet call added to the sheet" : "Meet call finished", body: r.title },
  }).catch(() => undefined);
  return true;
}
