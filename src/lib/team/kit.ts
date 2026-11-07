import "server-only";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { atIst, normRound, type PrepRow } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import type { RosterUser } from "@/lib/mobile/roster";
import { jobKeyOf, prepDocLinks, prepDocsOverview } from "@/lib/prepdocs/service";
import { type ContactResult, findCandidateEmail } from "@/lib/team/contacts";
import { meetingsFor } from "@/lib/team/meetings";
import { recordingsFor } from "@/lib/team/recordings";
import { draftsFor, istWhen } from "@/lib/team/templates";

/**
 * The prep kit for one prep: its document(s) and sources, meetings, call recordings, and the
 * message drafts (WhatsApp / email) with the latest document link already in them.
 */

/** "Tue, 12 Nov, 4:00 PM IST", or the day alone when the time is unknown. */
function formatInterviewWhen(p: PrepRow): string | null {
  if (!p.interviewDay || p.interviewTbd) return null;
  if (p.interviewTime) return istWhen(atIst(p.interviewDay, p.interviewTime.start));
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(atIst(p.interviewDay, 12 * 60));
}

async function prepOf(key: string) {
  if (!/^[0-9a-f]{24}$/.test(key)) throw new UserError(404, "This prep doesn't exist.", "not_found");
  const snap = await readPrepSnapshot();
  const p = snap.byKey.get(key);
  if (!p) throw new UserError(404, "This prep is no longer in the drill-down sheet.", "not_found");
  return { p, snap };
}

export async function prepKit(user: RosterUser, key: string) {
  const { p } = await prepOf(key);
  const [docs, meetings, recordings, links] = await Promise.all([prepDocsOverview(key), meetingsFor(key), recordingsFor(key), prepDocLinks(key)]);
  const docUrl = links.find((l) => l.kind === "gdoc")?.url ?? links[0]?.url ?? (/^https?:\/\//.test(p.prepDocument.trim()) ? p.prepDocument.trim().split(/\s+/)[0] : undefined);
  const base = {
    candidate: p.candidate,
    company: p.company,
    round: normRound(p.round),
    interviewWhen: formatInterviewWhen(p) ?? undefined,
    mentor: user.name,
    docUrl,
  };
  return {
    prepId: key,
    jobKey: jobKeyOf(p),
    candidate: p.candidate,
    phone: p.phone,
    documents: docs,
    meetings,
    recordings,
    drafts: {
      ...draftsFor({ ...base, meetUrl: "{meet_link}", meetWhen: "{when}" }),
      placeholders: ["{meet_link}", "{when}"],
    },
  };
}

/** The candidate's email from the CRPs → company sheet (never guessed). */
export async function prepContact(key: string): Promise<ContactResult & { candidate: string }> {
  const { p } = await prepOf(key);
  const r = await findCandidateEmail(p.jobId, { name: p.candidate, phone: p.phone, resumeUrl: p.resumeUrl });
  return { ...r, candidate: p.candidate };
}

/** Emails of every candidate of a job (for a guidance session), four lookups at a time. */
export async function jobContacts(jobId: string): Promise<{ prepId: string; candidate: string; round: string; contact: ContactResult }[]> {
  const snap = await readPrepSnapshot();
  const rows = snap.preps.filter((p) => p.jobId === jobId);
  if (!rows.length) throw new UserError(404, "This job isn't in the drill-down sheet.", "not_found");
  // One entry per candidate (the same person appears once per round; the latest row wins).
  const people = new Map<string, PrepRow>();
  for (const p of rows) people.set(p.phone || p.candidate.toLowerCase(), p);
  const list = [...people.values()].slice(0, 100);
  const out: { prepId: string; candidate: string; round: string; contact: ContactResult }[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const p = list[i];
      out[i] = { prepId: p.key, candidate: p.candidate, round: normRound(p.round), contact: await findCandidateEmail(jobId, { name: p.candidate, phone: p.phone, resumeUrl: p.resumeUrl }) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return out;
}

const PURPOSES = ["prep_document", "meeting_link", "reminder", "follow_up", "custom"];

/** The app opened WhatsApp with a message: logged as "opened" (there is no delivery receipt). */
export async function logWhatsapp(user: RosterUser, key: string, body: { purpose?: unknown; to?: unknown; meetingId?: unknown }) {
  const { p } = await prepOf(key);
  const purpose = PURPOSES.includes(String(body.purpose)) ? String(body.purpose) : "custom";
  const to = String(body.to ?? p.phone).replace(/[^\d+]/g, "").slice(0, 20);
  const meetingId = /^[0-9a-f-]{36}$/.test(String(body.meetingId ?? "")) ? String(body.meetingId) : null;
  await query("insert into app.communications (channel, purpose, prep_key, meeting_id, to_address, status, created_by) values ('whatsapp', $1, $2, $3, $4, 'opened', $5)", [
    purpose,
    key,
    meetingId,
    to,
    user.email,
  ]);
  return { ok: true };
}

/** Messages and emails for a prep, newest first (the kit's history list). */
export async function communicationsFor(key: string) {
  const rows = await query<{ at: Date; channel: string; purpose: string; to_address: string; status: string; error: string | null; created_by: string }>(
    "select at, channel, purpose, to_address, status, error, created_by from app.communications where prep_key = $1 order by at desc limit 100",
    [key],
  );
  return rows.map((r) => ({ at: r.at.toISOString(), channel: r.channel, purpose: r.purpose, to: r.to_address, status: r.status, error: r.error, by: r.created_by }));
}
