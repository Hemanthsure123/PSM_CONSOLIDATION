/**
 * Academy priority pool — reading the Academy sheet's "> 8LPA Assessed Pool" tab. Pure (no I/O), so
 * the rules are unit-tested (scripts/pool-academy-selftest.ts).
 *
 * Only these columns are ever read (the user's rule); every other cell is ignored:
 *   UID, YOG, Name, Email Address, StudentNumber, Location/State, Bachelor's College Name,
 *   Bachelor's Course Name, Bachelor's Specialization, TechStack, MENTOR.
 * Columns are found by their header text (case, spacing, line breaks and curly apostrophes
 * ignored), so inserting or moving columns in the sheet never breaks the sync.
 */

export const POOL_TRACKS = ["frontend", "backend", "fullstack", "aiml"] as const;
export type PoolTrack = (typeof POOL_TRACKS)[number];
export const TRACK_LABEL: Record<PoolTrack, string> = { frontend: "Frontend", backend: "Backend", fullstack: "Full Stack", aiml: "AI/ML" };
export const isPoolTrack = (v: unknown): v is PoolTrack => typeof v === "string" && (POOL_TRACKS as readonly string[]).includes(v);

export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { p0: "P0 · Strong", p1: "P1 · Good", p2: "P2 · Average", p3: "P3 · Poor" };
export const isPriority = (v: unknown): v is Priority => typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);

export type PoolField = "uid" | "yog" | "name" | "email" | "phone" | "location" | "college" | "course" | "specialization" | "techStack" | "mentor";

/** The header text of each column we read (normalised with [normHeader]). */
const HEADERS: Record<PoolField, string[]> = {
  uid: ["uid"],
  yog: ["yog"],
  name: ["name"],
  email: ["email address"],
  phone: ["studentnumber", "student number"],
  location: ["location state"],
  college: ["bachelor s college name"],
  course: ["bachelor s course name"],
  specialization: ["bachelor s specialization"],
  techStack: ["techstack", "tech stack"],
  mentor: ["mentor"],
};
const REQUIRED: PoolField[] = ["uid", "name", "phone", "mentor"];

export const normHeader = (s: unknown) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export interface PoolColumns {
  /** 0-based index of the header row. */
  headerRow: number;
  /** 0-based column index of each field (absent = the sheet has no such column). */
  index: Partial<Record<PoolField, number>>;
}

/**
 * Finds the header row (within the first 10 rows: this tab has a banner row above it) and our
 * columns in it. The first matching column wins (the tab repeats some headers, e.g. "Overall Score").
 */
export function findPoolColumns(rows: unknown[][]): PoolColumns {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cells = (rows[r] ?? []).map(normHeader);
    if (!cells.includes("uid") || !cells.includes("mentor")) continue;
    const index: Partial<Record<PoolField, number>> = {};
    for (const field of Object.keys(HEADERS) as PoolField[]) {
      const at = cells.findIndex((c) => HEADERS[field].includes(c));
      if (at >= 0) index[field] = at;
    }
    const missing = REQUIRED.filter((f) => index[f] === undefined);
    if (missing.length) throw new Error(`The pool tab has no ${missing.map((f) => HEADERS[f][0].toUpperCase()).join(", ")} column.`);
    return { headerRow: r, index };
  }
  throw new Error('The pool tab has no header row with "UID" and "MENTOR".');
}

/** The sheet's TechStack text → one of the four tracks, or null when it isn't one of them. */
export function trackOf(raw: string): PoolTrack | null {
  const k = raw.toLowerCase().replace(/[^a-z]+/g, "");
  if (!k) return null;
  if (k === "frontend" || k === "fe" || k === "frontenddeveloper") return "frontend";
  if (k === "backend" || k === "be" || k === "backenddeveloper") return "backend";
  if (k === "fullstack" || k === "fs" || k === "mernstack" || k === "mern" || k === "fullstackdeveloper") return "fullstack";
  if (k === "aiml" || k === "ai" || k === "ml" || k === "genai" || k === "aimlengineer" || k === "datascience") return "aiml";
  return null;
}

/** 10-digit Indian mobile number (+91 / 0 / spaces removed), or null. */
export function phone10(raw: string): string | null {
  const d = raw.replace(/\D+/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, n) : null;
};

export interface PoolSheetRow {
  uid: string;
  name: string;
  email: string | null;
  phone: string | null;
  yog: number | null;
  location: string | null;
  college: string | null;
  course: string | null;
  specialization: string | null;
  techStack: string | null;
  track: PoolTrack | null;
  mentor: string;
  /** 1-based sheet row, for messages. */
  sheetRow: number;
}

export interface PoolParseIssue {
  row: number;
  message: string;
}

/**
 * The mentored rows of the tab. A row without a MENTOR value is not in the pool (the user's rule).
 * A mentored row without a usable UID is reported, not guessed; a repeated UID keeps its first row.
 */
export function parsePoolRows(rows: unknown[][]): { rows: PoolSheetRow[]; issues: PoolParseIssue[]; read: number } {
  const cols = findPoolColumns(rows);
  const at = (r: unknown[], f: PoolField) => {
    const i = cols.index[f];
    return i === undefined ? "" : String(r[i] ?? "").trim();
  };
  const out: PoolSheetRow[] = [];
  const issues: PoolParseIssue[] = [];
  const seen = new Map<string, number>();
  let read = 0;
  for (let r = cols.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const sheetRow = r + 1;
    const mentor = clip(at(row, "mentor"), 80);
    const uid = at(row, "uid");
    if (!uid && !mentor) continue;
    read++;
    if (!mentor) continue;
    if (!UID.test(uid)) {
      issues.push({ row: sheetRow, message: uid ? `UID "${uid.slice(0, 40)}" isn't valid.` : "Mentored row without a UID." });
      continue;
    }
    const first = seen.get(uid);
    if (first) {
      issues.push({ row: sheetRow, message: `UID repeats row ${first}; the first row is used.` });
      continue;
    }
    seen.set(uid, sheetRow);
    const rawPhone = at(row, "phone");
    const phone = phone10(rawPhone);
    if (rawPhone && !phone) issues.push({ row: sheetRow, message: `StudentNumber "${rawPhone.slice(0, 20)}" isn't a 10-digit mobile number.` });
    const email = at(row, "email").toLowerCase();
    const yog = Number.parseInt(at(row, "yog"), 10);
    const techStack = clip(at(row, "techStack"), 120);
    out.push({
      uid,
      name: clip(at(row, "name"), 200) ?? "",
      email: EMAIL.test(email) && email.length <= 254 ? email : null,
      phone,
      yog: Number.isInteger(yog) && yog >= 2000 && yog <= 2100 ? yog : null,
      location: clip(at(row, "location"), 120),
      college: clip(at(row, "college"), 300),
      course: clip(at(row, "course"), 160),
      specialization: clip(at(row, "specialization"), 160),
      techStack,
      track: techStack ? trackOf(techStack) : null,
      mentor,
      sheetRow,
    });
  }
  return { rows: out, issues, read };
}

// ── Mentors' edits ──────────────────────────────────────────────────────────

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

/** Tech stack tags as typed: trimmed, spaces collapsed, de-duplicated (case-insensitively), at most 20. */
export function cleanTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const keys = new Set<string>();
  for (const v of raw) {
    const t = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
    if (!t) continue;
    const k = t.toLowerCase();
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(t);
  }
  return out.length > MAX_TAGS ? null : out;
}

/** A resume's tech stack: the track label or a tag, 1–40 characters. */
export function cleanStack(raw: unknown): string | null {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  return t && t.length <= MAX_TAG_LENGTH ? t : null;
}

export const RESUME_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/** The resume's type from its MIME type or, failing that, its file name. Null = not accepted. */
export function resumeType(mime: string, name: string): { mime: string; ext: string } | null {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (RESUME_TYPES[m]) return { mime: m, ext: RESUME_TYPES[m] };
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const byExt = Object.entries(RESUME_TYPES).find(([, e]) => e === ext);
  return byExt ? { mime: byExt[0], ext } : null;
}

/** "Asha Rao - Backend - 2026-11-08.pdf" (no characters Drive or phones choke on). */
export function resumeFileName(candidate: string, stack: string, day: string, ext: string): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|#%{}~&]+/g, " ").replace(/\s+/g, " ").trim();
  return `${safe(candidate) || "Candidate"} - ${safe(stack)} - ${day}.${ext}`.slice(0, 200);
}
