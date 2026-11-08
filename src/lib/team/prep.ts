import "server-only";
import { google } from "googleapis";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { atIst, normRound, type PrepRow } from "@/lib/mobile/preps/parse";
import { readPrepSnapshot } from "@/lib/mobile/preps/sheet";
import { rosterUser, type RosterUser } from "@/lib/mobile/roster";
import { documentsFor, jobKeyOf, prepDocLinks, prepDocsOverview, roundKeyOf } from "@/lib/prepdocs/service";
import { type ContactResult, findCandidateEmail } from "@/lib/team/contacts";
import { teamStatus, withTeam } from "@/lib/team/google";
import { meetingsFor } from "@/lib/team/meetings";
import { logMessageInSheet, messageLine } from "@/lib/team/sheetlog";
import { draftsFor, istWhen } from "@/lib/team/templates";

/**
 * What the app's prep actions need, one call each: the prep document (view / create / edit), the
 * Google Meet scheduler (drafts with the document link filled in, the meetings), the candidates'
 * emails (one prep, a set of preps for a guidance session, or a job), and WhatsApp hand-offs
 * (logged on the drill-down row, like every message).
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
  return p;
}

async function draftsOf(user: RosterUser, p: PrepRow) {
  const links = await prepDocLinks(p.key);
  const docUrl = links.find((l) => l.kind === "gdoc")?.url ?? links[0]?.url ?? (/^https?:\/\//.test(p.prepDocument.trim()) ? p.prepDocument.trim().split(/\s+/)[0] : undefined);
  return draftsFor({
    candidate: p.candidate,
    company: p.company,
    round: normRound(p.round),
    interviewWhen: formatInterviewWhen(p) ?? undefined,
    mentor: user.name,
    docUrl,
    meetUrl: "{meet_link}",
    meetWhen: "{when}",
  });
}

/** GET /preps/{id}/documents: the document(s) for the job + round, what they can be built from, the WhatsApp draft. */
export async function documentOverview(user: RosterUser, key: string) {
  const p = await prepOf(key);
  const [docs, drafts] = await Promise.all([prepDocsOverview(key), draftsOf(user, p)]);
  return { prepId: key, candidate: p.candidate, phone: p.phone, ...docs, whatsapp: drafts.whatsappPrepDoc };
}

/** GET /preps/{id}/meeting-setup: who and what the meeting is for, the message drafts, its meetings. */
export async function meetingSetup(user: RosterUser, key: string) {
  const p = await prepOf(key);
  const [drafts, meetings, team] = await Promise.all([draftsOf(user, p), meetingsFor(key), teamStatus().catch(() => null)]);
  return {
    prepId: key,
    jobKey: jobKeyOf(p),
    candidate: p.candidate,
    company: p.company,
    round: normRound(p.round),
    phone: p.phone,
    interviewWhen: formatInterviewWhen(p),
    google: team ? { connected: team.connected, account: team.account, status: team.status } : { connected: false, account: "", status: "not_configured" },
    email: drafts.email,
    whatsapp: drafts.whatsappMeeting,
    placeholders: ["{meet_link}", "{when}"],
    meetings,
  };
}

/** The candidate's email (company sheet → our assessment sheets → resume; never guessed). */
export async function prepContact(key: string): Promise<ContactResult & { candidate: string }> {
  const p = await prepOf(key);
  const r = await findCandidateEmail(p.jobId, { name: p.candidate, phone: p.phone, resumeUrl: p.resumeUrl });
  return { ...r, candidate: p.candidate };
}

export interface CandidateContact {
  prepId: string;
  candidate: string;
  company: string;
  round: string;
  contact: ContactResult;
}

/** Four lookups at a time, in the order given. */
async function lookUp(rows: PrepRow[]): Promise<CandidateContact[]> {
  const out: CandidateContact[] = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      const p = rows[i];
      out[i] = {
        prepId: p.key,
        candidate: p.candidate,
        company: p.company,
        round: normRound(p.round),
        contact: await findCandidateEmail(p.jobId, { name: p.candidate, phone: p.phone, resumeUrl: p.resumeUrl }),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
  return out;
}

/** Emails for the candidates picked for a guidance session (any companies), at most 100. */
export async function contactsFor(prepIds: unknown): Promise<CandidateContact[]> {
  if (!Array.isArray(prepIds) || !prepIds.length) throw new UserError(422, "Pick at least one candidate.", "invalid_body");
  const ids = [...new Set(prepIds.map((x) => String(x ?? "")))].slice(0, 100);
  const snap = await readPrepSnapshot();
  const rows = ids.map((id) => snap.byKey.get(id)).filter((p): p is PrepRow => Boolean(p));
  if (!rows.length) throw new UserError(404, "These candidates are no longer in the drill-down sheet.", "not_found");
  return lookUp(rows);
}

/** Emails of every candidate of a job, one entry per person (the latest round's row), at most 100. */
export async function jobContacts(jobId: string): Promise<CandidateContact[]> {
  const snap = await readPrepSnapshot();
  const rows = snap.preps.filter((p) => p.jobId === jobId);
  if (!rows.length) throw new UserError(404, "This job isn't in the drill-down sheet.", "not_found");
  const people = new Map<string, PrepRow>();
  for (const p of rows) people.set(p.phone || p.candidate.toLowerCase(), p);
  return lookUp([...people.values()].slice(0, 100));
}

const PURPOSE_LABEL: Record<string, string> = {
  prep_document: "Prep document",
  meeting_link: "Meet link",
  reminder: "Reminder",
  follow_up: "Follow-up",
  custom: "Message",
};

/** The app opened WhatsApp with a message: a line on the row's Prep Messages (no delivery receipt exists). */
export async function logWhatsapp(user: RosterUser, key: string, body: { purpose?: unknown; to?: unknown }) {
  const p = await prepOf(key);
  const purpose = PURPOSE_LABEL[String(body.purpose)] ?? PURPOSE_LABEL.custom;
  const to = String(body.to ?? p.phone).replace(/[^\d+]/g, "").slice(0, 20);
  await logMessageInSheet([key], messageLine({ channel: "WhatsApp", purpose, to, status: "opened", by: user.name }));
  return { ok: true };
}

/**
 * Edit the prep document by hand: the team account gives the person (their roster email and the
 * Google accounts they sign in with) edit access to the job + round's Google Doc and returns its
 * link. A later "rewrite" reads the edited text first, so manual changes are kept.
 */
export async function grantEditAccess(user: RosterUser, key: string): Promise<{ url: string; title: string; emails: string[] }> {
  const p = await prepOf(key);
  const doc = (await documentsFor(jobKeyOf(p), roundKeyOf(p.round))).find((d) => d.kind === "gdoc");
  if (!doc) throw new UserError(404, "There is no Google Doc for this round yet. Create it first.", "no_document");
  const me = (await rosterUser(user.email)) ?? user;
  const emails = [...new Set([me.email, ...(me.signInEmails ?? [])].map((e) => e.toLowerCase()))];
  const granted: string[] = [];
  let lastError = "";
  await withTeam(async (auth) => {
    const drive = google.drive({ version: "v3", auth });
    for (const email of emails) {
      // An address that isn't a Google account can't be given access; the others still are.
      await drive.permissions
        .create({ fileId: doc.external_id, sendNotificationEmail: false, requestBody: { type: "user", role: "writer", emailAddress: email }, supportsAllDrives: true })
        .then(() => granted.push(email))
        .catch((err) => {
          lastError = err instanceof Error ? err.message.slice(0, 160) : String(err);
        });
    }
  });
  if (!granted.length) throw new UserError(502, `Google didn't give edit access (${lastError || "unknown reason"}).`, "share_failed");
  await query("insert into app.audit_log (actor_email, action, target, detail) values ($1, 'prep_document_edit_access', $2, $3)", [user.email, doc.url, JSON.stringify({ emails: granted })]).catch(() => undefined);
  return { url: doc.url, title: doc.title, emails: granted };
}
