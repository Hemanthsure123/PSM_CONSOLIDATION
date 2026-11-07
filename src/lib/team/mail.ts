import "server-only";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { teamConfig, withTeam } from "@/lib/team/google";

/**
 * Emails sent from the team account through Gmail (gmail.send). A meeting email carries an
 * iCalendar invite (text/calendar, METHOD:REQUEST) so Gmail / Outlook show "Add to calendar" with
 * the Meet link. Replies go to the mentor who scheduled it (Reply-To).
 */

export interface InviteEvent {
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  title: string;
  description: string;
  location: string;
  attendees: { email: string; name?: string }[];
  method: "REQUEST" | "CANCEL";
}

export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  invite?: InviteEvent;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const b64 = (s: string) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
const addr = (email: string, name?: string) => {
  const e = oneLine(email).replace(/[<>,;"]/g, "");
  return name ? `"${encodeWord(oneLine(name).replace(/"/g, ""))}" <${e}>` : e;
};

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** RFC 5545 line folding (75 octets). */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let chunk = "";
  for (const ch of line) {
    if (Buffer.byteLength(chunk + ch, "utf8") > (out.length ? 74 : 75)) {
      out.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  out.push(chunk);
  return out.join("\r\n ");
}

export function buildIcs(ev: InviteEvent, organizer: { email: string; name: string }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//NxtWave//PSM Placements//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${ev.method}`,
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${icsTime(new Date())}`,
    `DTSTART:${icsTime(ev.start)}`,
    `DTEND:${icsTime(ev.end)}`,
    `SEQUENCE:${ev.sequence}`,
    `SUMMARY:${icsText(ev.title)}`,
    `DESCRIPTION:${icsText(ev.description)}`,
    `LOCATION:${icsText(ev.location)}`,
    `ORGANIZER;CN=${icsText(organizer.name)}:mailto:${organizer.email}`,
    ...ev.attendees.map(
      (a) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${a.name ? `;CN=${icsText(a.name)}` : ""}:mailto:${a.email}`,
    ),
    `STATUS:${ev.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    ...(ev.method === "REQUEST" ? ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT10M", "END:VALARM"] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function fromName(): string {
  return process.env.EMAIL_FROM_NAME?.trim() || "NxtWave Placements";
}

/** The raw RFC 2822 message (exported for the self-test). */
export function buildMime(mail: OutgoingEmail, from: { email: string; name: string }): string {
  const mixed = `mix_${randomBytes(12).toString("hex")}`;
  const alt = `alt_${randomBytes(12).toString("hex")}`;
  const headers = [
    `From: ${addr(from.email, from.name)}`,
    `To: ${mail.to.map((t) => addr(t)).join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.map((t) => addr(t)).join(", ")}`] : []),
    ...(mail.replyTo ? [`Reply-To: ${addr(mail.replyTo)}`] : []),
    `Subject: ${encodeWord(oneLine(mail.subject))}`,
    "MIME-Version: 1.0",
  ];
  if (!mail.invite) {
    return [...headers, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(mail.text)].join("\r\n");
  }
  const ics = buildIcs(mail.invite, from);
  const method = mail.invite.method;
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(mail.text),
    `--${alt}`,
    `Content-Type: text/calendar; charset="UTF-8"; method=${method}`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(ics),
    `--${alt}--`,
    `--${mixed}`,
    'Content-Type: application/ics; name="invite.ics"',
    'Content-Disposition: attachment; filename="invite.ics"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(ics),
    `--${mixed}--`,
    "",
  ].join("\r\n");
}

/** Sends one email from the team account. Returns Gmail's message id. */
export async function sendEmail(mail: OutgoingEmail): Promise<string> {
  if (!mail.to.length) throw new Error("No recipient.");
  const from = { email: teamConfig().account, name: fromName() };
  const raw = Buffer.from(buildMime(mail, from), "utf8").toString("base64url");
  return withTeam(async (auth) => {
    const res = await google.gmail({ version: "v1", auth }).users.messages.send({ userId: "me", requestBody: { raw } });
    return res.data.id ?? "";
  });
}
