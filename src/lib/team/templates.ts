/**
 * Draft messages the app shows before anything is sent. Every draft is editable in the app; these
 * are the professional defaults. Plain text only (WhatsApp and email), simple English, no emojis.
 */

export type MeetingKind = "prep" | "guidance" | "mock" | "custom";

export interface DraftContext {
  candidate?: string;
  company: string;
  role?: string;
  round?: string;
  /** "Tue, 12 Nov, 4:00 PM" (IST) of the interview, when known. */
  interviewWhen?: string;
  mentor: string;
  docUrl?: string;
  meetUrl?: string;
  /** "Tue, 12 Nov, 4:00 – 4:45 PM IST" of the meeting. */
  meetWhen?: string;
}

export interface Draft {
  subject: string;
  body: string;
}

const first = (name?: string) => {
  const n = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : "";
};
const hi = (name?: string) => (first(name) ? `Hi ${first(name)},` : "Hi,");
const roundText = (c: DraftContext) => [c.company, c.round].filter(Boolean).join(" ");
const lines = (...l: (string | false | undefined | null)[]) => l.filter((x) => x !== false && x !== undefined && x !== null).join("\n");

/** WhatsApp: the prep document. */
export function whatsappPrepDoc(c: DraftContext): string {
  return lines(
    hi(c.candidate),
    "",
    `Here is your preparation document for the ${roundText(c)} interview${c.interviewWhen ? ` on ${c.interviewWhen}` : ""}.`,
    c.docUrl ? c.docUrl : false,
    "",
    "Please go through it fully before our prep call. It has the questions asked in this company's interviews and what to focus on.",
    "",
    `${c.mentor}`,
    "NxtWave Placements",
  );
}

/** WhatsApp: the Meet link of a scheduled meeting. */
export function whatsappMeeting(kind: MeetingKind, c: DraftContext): string {
  const what = kind === "mock" ? "mock interview" : kind === "guidance" ? "guidance session" : kind === "prep" ? "prep call" : "meeting";
  return lines(
    hi(c.candidate),
    "",
    `Your ${what} for ${roundText(c)} is scheduled${c.meetWhen ? ` on ${c.meetWhen}` : ""}.`,
    c.meetUrl ? `Google Meet link: ${c.meetUrl}` : false,
    c.docUrl && kind !== "custom" ? `Prep document: ${c.docUrl}` : false,
    "",
    "Please join on time from a laptop with a working camera and microphone, in a quiet place.",
    "",
    `${c.mentor}`,
    "NxtWave Placements",
  );
}

/** WhatsApp: a short reminder before the meeting. */
export function whatsappReminder(c: DraftContext): string {
  return lines(hi(c.candidate), "", `Reminder: we meet${c.meetWhen ? ` at ${c.meetWhen}` : " soon"}.`, c.meetUrl ? `Join here: ${c.meetUrl}` : false, "", c.mentor);
}

/** Email that goes with a meeting invite. */
export function meetingEmail(kind: MeetingKind, c: DraftContext): Draft {
  const subjects: Record<MeetingKind, string> = {
    prep: `Interview preparation call: ${roundText(c)}`,
    mock: `Mock interview: ${roundText(c)}`,
    guidance: `Guidance session: ${c.company}${c.role ? ` ${c.role}` : ""}`,
    custom: `Meeting: ${c.company}`,
  };
  const intro: Record<MeetingKind, string> = {
    prep: `This is your preparation call for the ${roundText(c)} interview${c.interviewWhen ? ` on ${c.interviewWhen}` : ""}. We will go through the likely questions and how to answer them.`,
    mock: `This is a mock interview for the ${roundText(c)} round. Treat it like the real interview; you will get feedback at the end.`,
    guidance: `This session is to guide you on the ${c.company} hiring process: the rounds, what they look for, and how to prepare.`,
    custom: "Please find the meeting details below.",
  };
  return {
    subject: subjects[kind],
    body: lines(
      c.candidate ? `Hi ${first(c.candidate)},` : "Hi everyone,",
      "",
      intro[kind],
      "",
      c.meetWhen ? `When: ${c.meetWhen}` : false,
      c.meetUrl ? `Google Meet: ${c.meetUrl}` : false,
      c.docUrl && kind !== "custom" ? `Prep document (read before the call): ${c.docUrl}` : false,
      "",
      "Please join from a laptop with a working camera and microphone, in a quiet place. The session may be recorded for review.",
      "",
      "Regards,",
      c.mentor,
      "NxtWave Placements",
    ),
  };
}

export function draftsFor(c: DraftContext) {
  return {
    whatsappPrepDoc: whatsappPrepDoc(c),
    whatsappMeeting: {
      prep: whatsappMeeting("prep", c),
      mock: whatsappMeeting("mock", c),
      guidance: whatsappMeeting("guidance", c),
      custom: whatsappMeeting("custom", c),
    },
    email: {
      prep: meetingEmail("prep", c),
      mock: meetingEmail("mock", c),
      guidance: meetingEmail("guidance", c),
      custom: meetingEmail("custom", c),
    },
  };
}

/** "Tue, 12 Nov, 4:00 – 4:45 PM IST" */
export function istRange(start: Date, end: Date): string {
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(start);
  const t = (d: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(d).toUpperCase();
  return `${day}, ${t(start)} – ${t(end)} IST`;
}

/** "Tue, 12 Nov, 4:00 PM IST" */
export function istWhen(d: Date): string {
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(d);
  const t = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(d).toUpperCase();
  return `${day}, ${t} IST`;
}
