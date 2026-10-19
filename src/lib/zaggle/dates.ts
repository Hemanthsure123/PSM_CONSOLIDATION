/**
 * Zaggle SDE 1 screening — employment dates, read deterministically. Pure (no
 * I/O): the server parses each job's dates as the resume writes them, the
 * browser adds the months up under the current rules.
 *
 * Months are counted the way LinkedIn does — both ends inclusive: Jan 2025 –
 * Dec 2025 is 12 months, Jan 2025 – Present (Oct 2026) is 22. Overlapping jobs
 * are never double-counted: the months are a set.
 */

/** A calendar month as one number: year × 12 + (month − 1). */
export type MonthIndex = number;

export const monthIndex = (year: number, month: number): MonthIndex => year * 12 + (month - 1);
export const ymOf = (i: MonthIndex): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;

/** "2025-03" → index; anything else → null. */
export function parseYm(s: string): MonthIndex | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 ? monthIndex(y, mo) : null;
}

export interface ParsedRange {
  start: MonthIndex;
  end: MonthIndex;
  /** The job is ongoing ("Present", "Current", "Till date"…) — ended at `asOf`. */
  current: boolean;
  /** False when a date gave only a year ("2024 – 2025") — the month count is approximate. */
  precise: boolean;
}

export type DateReading =
  | ({ kind: "range" } & ParsedRange)
  /** Only a duration is written ("6 months", "1 yr 2 mos") — can't be placed on the calendar. */
  | { kind: "duration"; months: number }
  | { kind: "none" };

const MONTHS: [RegExp, number][] = [
  [/^jan/, 1],
  [/^feb/, 2],
  [/^mar/, 3],
  [/^apr/, 4],
  [/^may/, 5],
  [/^jun/, 6],
  [/^jul/, 7],
  [/^aug/, 8],
  [/^sep/, 9],
  [/^oct/, 10],
  [/^nov/, 11],
  [/^dec/, 12],
];
const MONTH_WORD = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const PRESENT = "(?:present|current(?:ly)?|now|ongoing|till\\s*(?:date|now|today)|to\\s*date|today|continuing|currently\\s*working)";

/**
 * One date token: "Jan 2025", "January, 2025", "Jan'25", "Jan-25", "15 Jan 2025",
 * "01/2025", "1-2025", "15/01/2025", "2025-01", "2025/01", "2025", or a "present" word.
 */
const TOKEN = new RegExp(
  [
    `(?<named>(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(?<![a-z])${MONTH_WORD}\\.?[\\s,'’\\-/]*(?<ny>\\d{4}|\\d{2})(?!\\d))`,
    `(?<dmy>(?<!\\d)\\d{1,2}[/.\\-](?<dm>\\d{1,2})[/.\\-](?<dy>\\d{4})(?!\\d))`,
    `(?<my>(?<!\\d)(?<mm>\\d{1,2})[/.\\-](?<myy>\\d{4})(?!\\d))`,
    `(?<ym>(?<!\\d)(?<ymy>\\d{4})[/.\\-](?<ymm>\\d{1,2})(?![\\d/.\\-]))`,
    `(?<year>(?<![\\d/.\\-])(?<yy>(?:19|20)\\d{2})(?![\\d/.\\-]))`,
    `(?<present>\\b${PRESENT}\\b)`,
  ].join("|"),
  "gi",
);

type Tok = { kind: "month"; i: MonthIndex } | { kind: "year"; y: number } | { kind: "present" };

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
const okMonth = (m: number) => m >= 1 && m <= 12;
const okYear = (y: number) => y >= 1990 && y <= 2100;

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const g = m.groups ?? {};
    if (g.present) out.push({ kind: "present" });
    else if (g.named) {
      const word = (g.named.toLowerCase().match(/[a-z]+/g) ?? []).find((w) => MONTHS.some(([re]) => re.test(w))) ?? "";
      const mo = MONTHS.find(([re]) => re.test(word))?.[1] ?? 0;
      const y = fullYear(g.ny);
      if (okMonth(mo) && okYear(y)) out.push({ kind: "month", i: monthIndex(y, mo) });
    } else if (g.dmy) {
      const mo = Number(g.dm);
      const y = Number(g.dy);
      if (okMonth(mo) && okYear(y)) out.push({ kind: "month", i: monthIndex(y, mo) });
    } else if (g.my) {
      const mo = Number(g.mm);
      const y = Number(g.myy);
      if (okMonth(mo) && okYear(y)) out.push({ kind: "month", i: monthIndex(y, mo) });
    } else if (g.ym) {
      const mo = Number(g.ymm);
      const y = Number(g.ymy);
      if (okMonth(mo) && okYear(y)) out.push({ kind: "month", i: monthIndex(y, mo) });
    } else if (g.year) {
      const y = Number(g.yy);
      if (okYear(y)) out.push({ kind: "year", y });
    }
  }
  return out;
}

/** "6 months", "1 year", "1.5 years", "1 yr 2 mos", "2 yrs" → months; else null. */
export function parseDuration(text: string): number | null {
  const t = (text ?? "").toLowerCase();
  const y = t.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/);
  const m = t.match(/(\d+)\s*\+?\s*(?:months?|mos?|mnths?)\b/);
  if (!y && !m) return null;
  const months = Math.round((y ? Number(y[1]) * 12 : 0) + (m ? Number(m[1]) : 0));
  return months > 0 && months < 600 ? months : null;
}

/**
 * Read a job's dates as written ("Jan 2025 – Present", "06/2024 - 12/2024",
 * "Mar'25 to Aug'25", "2024 – 2025", "6 months"). `asOf` ends an ongoing job.
 */
export function readDates(text: string, asOf: MonthIndex): DateReading {
  const toks = tokens(text ?? "");
  const dated = toks.filter((t) => t.kind !== "present");
  const ongoing = toks.some((t) => t.kind === "present");
  if (!dated.length) {
    const d = parseDuration(text);
    return d ? { kind: "duration", months: d } : { kind: "none" };
  }
  const first = dated[0];
  const second = dated.length > 1 ? dated[1] : null;
  const startOf = (t: Tok) => (t.kind === "month" ? t.i : t.kind === "year" ? monthIndex(t.y, 1) : asOf);
  const endOf = (t: Tok) => (t.kind === "month" ? t.i : t.kind === "year" ? monthIndex(t.y, 12) : asOf);
  const precise = first.kind === "month" && (second ? second.kind === "month" : true);

  let start = startOf(first);
  let end: MonthIndex;
  let current = false;
  if (second && !(ongoing && toks.indexOf(second) > toks.findIndex((t) => t.kind === "present"))) {
    end = endOf(second);
  } else if (ongoing) {
    end = asOf;
    current = true;
  } else {
    // A single date and no "present": that one month (or that year).
    end = first.kind === "year" ? monthIndex(first.y, 12) : start;
  }
  // Year-only ends: "2023 – 2024" reads as Jan 2023 – Dec 2024 (24 months) — too generous for
  // a resume that usually means about a year; count whole years between them instead.
  if (first.kind === "year" && second?.kind === "year") {
    start = monthIndex(first.y, 1);
    end = Math.max(start, monthIndex(second.y, 1) - 1);
  }
  if (end > asOf) end = asOf; // future dates (planned / typo) never count beyond today
  if (end < start) return { kind: "none" };
  return { kind: "range", start, end, current, precise };
}

/** Inclusive month count of one range. */
export const monthsIn = (start: MonthIndex, end: MonthIndex) => (end >= start ? end - start + 1 : 0);

/** Months covered by any of the ranges — overlaps counted once. */
export function unionMonths(ranges: { start: MonthIndex; end: MonthIndex }[]): number {
  const seen = new Set<number>();
  for (const r of ranges) for (let i = r.start; i <= r.end; i++) seen.add(i);
  return seen.size;
}

/** "Jan 2025" for display. */
export function monthLabel(i: MonthIndex): string {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[i % 12]} ${Math.floor(i / 12)}`;
}

/** "1 yr 3 mo", "9 mo". */
export function formatMonths(n: number): string {
  if (n <= 0) return "0 mo";
  const y = Math.floor(n / 12);
  const m = n % 12;
  return [y ? `${y} yr` : "", m ? `${m} mo` : ""].filter(Boolean).join(" ");
}
