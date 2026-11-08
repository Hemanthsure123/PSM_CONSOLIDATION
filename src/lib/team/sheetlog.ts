import "server-only";
import { query } from "@/lib/db/client";
import { PREP_CALL_HEADERS, readPrepExtraCells, writePrepExtraCells } from "@/lib/mobile/preps/sheet";
import { type CallSummary, durationText, summaryCell } from "@/lib/team/summary";

/**
 * The drill-down row is the record of a prep's calls and messages. Each finished call (a phone
 * recording or a Google Meet) adds an entry to the row's Prep Call Recording / Transcript /
 * Summary columns, newest first; Prep Call Duration is the total of the real call lengths; every
 * email and WhatsApp hand-off adds a line to Prep Messages. Transcripts, summaries and messages
 * live only here — the database keeps durations and processing status, never their text.
 *
 * Entries carry a short tag ("#c1a2b3c4" phone, "#m…" Meet), so writing the same call twice
 * (a retry) replaces its entry instead of adding a second one. Writes to one row are queued, so
 * two calls finishing together never overwrite each other.
 */

const CELL_MAX = 45_000;
const SEP = "\n\n— — —\n\n";

const queues = new Map<string, Promise<unknown>>();

/** Runs [work] after any earlier work on the same row (in-process; one server instance). */
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(work);
  queues.set(
    key,
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }),
  );
  return next;
}

/** "8 Nov 2026, 4:05 PM" in IST. */
export function istLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
    .format(d)
    .replace(/\bam\b/i, "AM")
    .replace(/\bpm\b/i, "PM");
}

/** Puts [block] first in [cell], dropping the older entry with the same tag; stays under the cell limit. */
export function withEntry(cell: string, tag: string, block: string): string {
  const others = cell
    .split(SEP)
    .map((b) => b.trim())
    .filter((b) => b && !b.includes(tag));
  let out = [block.trim(), ...others].join(SEP);
  // Oldest entries go first when the cell would overflow; the newest is cut, never dropped.
  while (out.length > CELL_MAX && others.length) {
    others.pop();
    out = [block.trim(), ...others].join(SEP);
  }
  return out.length > CELL_MAX ? `${out.slice(0, CELL_MAX - 40)}\n… (cut at the sheet's cell limit)` : out;
}

export interface CallEntry {
  /** "c" + recording id (phone) or "m" + meeting id (Meet). */
  tag: string;
  at: Date;
  source: "Phone call" | "Google Meet";
  /** Who gave the call. */
  by: string;
  durationSec: number;
  recordingUrl: string | null;
  transcript: string;
  summary: CallSummary | null;
}

/** Adds (or replaces) one finished call in the row's call columns and refreshes the total duration. */
export async function recordCallInSheet(prepKey: string, call: CallEntry): Promise<void> {
  await serial(prepKey, async () => {
    const H = PREP_CALL_HEADERS;
    const current = await readPrepExtraCells(prepKey, [H.recording, H.transcript, H.summary]);
    const tag = `#${call.tag.slice(0, 9)}`;
    const head = `[${istLabel(call.at)} · ${call.source} · ${durationText(call.durationSec)} · ${call.by}] ${tag}`;
    await writePrepExtraCells(prepKey, {
      [H.recording]: withEntry(current[H.recording], tag, `${head}\n${call.recordingUrl ?? "(no recording file)"}`),
      [H.transcript]: withEntry(current[H.transcript], tag, `${head}\n${call.transcript.trim() || "(no speech was transcribed)"}`),
      [H.summary]: withEntry(current[H.summary], tag, `${head}\n${call.summary ? summaryCell(call.summary) : "(the call was too short to summarise)"}`),
      [H.duration]: await durationCell(prepKey),
    });
  });
}

/** "3 calls · 41 m 05 s", from the real lengths of the prep's finished phone and Meet calls. */
async function durationCell(prepKey: string): Promise<string> {
  const rows = await query<{ n: string; secs: string | null }>(
    `select count(*)::text as n, sum(secs)::text as secs from (
       select duration_sec as secs from app.call_recordings where prep_key = $1 and status = 'ready'
       union all
       select duration_sec from app.meetings where (prep_key = $1 or $1 = any(prep_keys)) and artifacts_status = 'ready' and duration_sec is not null
     ) calls`,
    [prepKey],
  );
  const n = Number(rows[0]?.n ?? 0);
  const total = Number(rows[0]?.secs ?? 0);
  if (!n) return "";
  return n === 1 ? durationText(total) : `${n} calls · ${durationText(total)}`;
}

/**
 * One line per message in each row's Prep Messages column, newest first:
 * "8 Nov 2026, 4:10 PM · WhatsApp · Meet link · to 98765 43210 · opened · Hemanth".
 */
export async function logMessageInSheet(prepKeys: string[], line: string): Promise<void> {
  const keys = [...new Set(prepKeys.filter((k) => /^[0-9a-f]{24}$/.test(k)))];
  for (const key of keys) {
    await serial(key, async () => {
      const H = PREP_CALL_HEADERS;
      const current = (await readPrepExtraCells(key, [H.messages]))[H.messages].trim();
      let text = current ? `${line}\n${current}` : line;
      if (text.length > CELL_MAX) text = text.slice(0, CELL_MAX).replace(/\n[^\n]*$/, "");
      await writePrepExtraCells(key, { [H.messages]: text });
    }).catch((err) => console.warn("[sheetlog] message not written:", err instanceof Error ? err.message.slice(0, 160) : err));
  }
}

/** The message line, in IST. */
export function messageLine(parts: { at?: Date; channel: "Email" | "WhatsApp"; purpose: string; to: string; status: string; by: string; error?: string | null }): string {
  return [istLabel(parts.at ?? new Date()), parts.channel, parts.purpose, parts.to && `to ${parts.to}`, parts.status, parts.by, parts.error && `(${parts.error.slice(0, 120)})`]
    .filter(Boolean)
    .join(" · ");
}
