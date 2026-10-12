import type { DurationSource, ExperienceEntry } from "@/lib/experience-types";

/**
 * Deterministic duration maths for Experience Analysis — the model only reads
 * what the resume says (dates / stated duration); every number is computed here
 * so "Jan–Mar 2024", "3 months" and "12 weeks" all land on the same scale.
 * Pure module: safe on client and server.
 */

interface YMD {
  y: number;
  m: number; // 1-12
  d: number | null;
}

/** "2024-03", "2024-03-15" → parts; "2024" or anything else → null (month unknown). */
export function parseDate(value: string): YMD | null {
  const m = (value ?? "").trim().match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = m[3] ? Number(m[3]) : null;
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || (d !== null && (d < 1 || d > 31))) return null;
  return { y, m: mo, d };
}

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  a: 1, an: 1, half: 0.5,
};

/**
 * Parse a stated duration — "3 months", "6 weeks", "1 year 2 months",
 * "2 yrs", "45 days", "six months", "1.5 years" — into months. null if none.
 */
export function parseStatedMonths(text: string): number | null {
  const t = (text ?? "").toLowerCase().replace(/[–—-]/g, " ");
  const num = String.raw`(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an?|half)`;
  const read = (unit: string): number => {
    let total = 0;
    for (const m of t.matchAll(new RegExp(`\\b${num}\\s*\\+?\\s*${unit}\\b`, "g"))) {
      const n = /^\d/.test(m[1]) ? Number(m[1]) : WORD_NUM[m[1]];
      if (Number.isFinite(n)) total += n;
    }
    return total;
  };
  const years = read("(?:years?|yrs?)");
  const months = read("(?:months?|mos?|mnths?|mths?)");
  const weeks = read("(?:weeks?|wks?)");
  const days = read("days?");
  const total = years * 12 + months + weeks / 4.345 + days / 30.44;
  return total > 0 ? total : null;
}

/** Months between two dates. Month-only dates count inclusively (Jan–Mar = 3). */
function monthsBetween(a: YMD, b: YMD): number | null {
  if (a.d !== null && b.d !== null) {
    const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
    return ms >= 0 ? ms / 86_400_000 / 30.44 : null;
  }
  const diff = b.y * 12 + b.m - (a.y * 12 + a.m) + 1;
  return diff > 0 ? diff : null;
}

/** Round to half months below a year, whole months above. */
function tidy(months: number): number {
  return months < 12 ? Math.max(0.5, Math.round(months * 2) / 2) : Math.round(months);
}

export function formatMonths(months: number | null): string {
  if (months === null) return "";
  if (months < 1) {
    const weeks = Math.max(1, Math.round(months * 4.345));
    return `${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const y = Math.floor(months / 12);
  const m = Math.round(months - y * 12);
  return `${y} year${y === 1 ? "" : "s"}${m ? ` ${m} month${m === 1 ? "" : "s"}` : ""}`;
}

/**
 * Resolve an entry's duration: both dates → date maths (an ongoing role runs
 * to `asOf`); otherwise a stated duration in the text; otherwise unknown.
 * Implausible results (negative, over 15 years) are discarded.
 */
export function resolveDuration(
  e: Pick<ExperienceEntry, "startDate" | "endDate" | "ongoing" | "durationText">,
  asOf: Date,
): { months: number | null; label: string; source: DurationSource } {
  const start = parseDate(e.startDate);
  const ongoing = e.ongoing || /^present$/i.test(e.endDate.trim());
  const end = ongoing
    ? { y: asOf.getUTCFullYear(), m: asOf.getUTCMonth() + 1, d: start?.d !== null && start?.d !== undefined ? asOf.getUTCDate() : null }
    : parseDate(e.endDate);

  let months: number | null = null;
  let source: DurationSource = "unknown";
  // A single month with no range in the text ("completed Dec 2024") says when
  // it ended, not how long it ran — don't turn it into "1 month".
  const singleMonth =
    start !== null && end !== null && !ongoing && start.d === null && start.y === end.y && start.m === end.m &&
    !/[–—-]|\bto\b|\btill\b|\buntil\b|\bpresent\b/i.test(e.durationText);
  if (start && end && !singleMonth) {
    const m = monthsBetween(start, end);
    if (m !== null) {
      months = m;
      source = "dates";
    }
  }
  if (months === null) {
    const stated = parseStatedMonths(e.durationText);
    if (stated !== null) {
      months = stated;
      source = "stated";
    }
  }
  if (months === null || months <= 0 || months > 180) return { months: null, label: "", source: "unknown" };
  const tidied = tidy(months);
  return { months: tidied, label: formatMonths(tidied), source };
}

/**
 * Calendar months covered by a set of entries, counting overlapping periods once.
 * Entries with dates contribute their month range; entries with only a stated
 * length add that length. null when nothing has a known duration.
 */
export function coveredMonths(entries: ExperienceEntry[], asOf: Date): number | null {
  const covered = new Set<number>();
  let extra = 0;
  let any = false;
  for (const e of entries) {
    if (e.months === null) continue;
    any = true;
    const start = parseDate(e.startDate);
    const ongoing = e.ongoing || /^present$/i.test(e.endDate.trim());
    const end = ongoing ? { y: asOf.getUTCFullYear(), m: asOf.getUTCMonth() + 1, d: null } : parseDate(e.endDate);
    // Month-level date ranges go into the calendar set (so overlaps count once);
    // day-precise or stated lengths are added as-is.
    if (e.durationSource === "dates" && start && end && start.d === null && e.months >= 1) {
      for (let i = start.y * 12 + start.m; i <= end.y * 12 + end.m && i - (start.y * 12 + start.m) < 180; i++) covered.add(i);
    } else {
      extra += e.months;
    }
  }
  if (!any) return null;
  return tidy(covered.size + extra);
}
