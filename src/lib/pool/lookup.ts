import { isAssessed, standingFor } from "@/lib/pool/match";
import { normalisePhone, normaliseUserId } from "@/lib/pool/parse";
import {
  COMPETENCY_LABEL,
  PRODUCT_LABEL,
  STAGE_SHORT,
  TR2_TRACK_LABEL,
  VERDICT_LABEL,
  type CandidateStanding,
  type CompetencySubject,
  type InternalStanding,
  type PersonRecords,
  type Product,
  type Tier,
} from "@/lib/pool/types";

/**
 * Standing lookup — internal standings for pasted UUIDs / phone numbers, from the eligible
 * pool (the Edge 2.0, Edge 1.0 and Academy assessments; never a resume). Pure and client-safe;
 * tested in scripts/standing-lookup-selftest.ts.
 *
 * Output: UUID (+ Phone when phones were pasted), Internal Standing, Internal Stage, Internal
 * Product — the same three values Domain shortlisting exports — and, when requirements are
 * picked, ONE "Requirements" column holding only those items the candidate has a result for.
 * Rows keep the pasted order (blank lines too), so the result pastes back beside the source.
 */

/** The lookup endpoint's cap per request. */
export const MAX_LOOKUP_ROWS = 20_000;

// ── The three standing columns (shared with Domain shortlisting's CSVs) ─────────

export const STANDING_HEADERS = ["Internal Standing", "Internal Stage", "Internal Product"] as const;

/**
 * Internal Standing / Stage / Product (and how the person was matched) for one standing.
 * Not in the pool = "External" — or "Not checked" when the pool wasn't looked up at all.
 */
export function internalColumns(st: InternalStanding | null | undefined, poolChecked: boolean): Record<string, string> {
  if (st) {
    const s = st as InternalStanding;
    const label = s.label;
    return {
      "Matched In Pool By": s.matchedBy === "phone" ? "Phone" : "User ID",
      "Internal Standing": isAssessed(s) ? label : `${label} (not eligible)`,
      "Internal Stage": STAGE_SHORT[s.tier],
      "Internal Product": PRODUCT_LABEL[s.product],
    };
  }
  return { "Internal Standing": poolChecked ? "External" : "Not checked" };
}

// ── Reading the paste ─────────────────────────────────────────────────────────

export interface LookupInputRow {
  /** 1-based line in the paste. */
  line: number;
  phone: string | null;
  userId: string | null;
  /** "blank" keeps a blank line's place; "unrecognised" = text with no UUID or phone number. */
  problem: "" | "blank" | "unrecognised";
  /** The line as pasted (trimmed, for messages). */
  raw: string;
}

export interface LookupInput {
  rows: LookupInputRow[];
  /** The first line was a header ("UUID", "Phone" …) and was left out. */
  headerSkipped: boolean;
  /** Lines past MAX_LOOKUP_ROWS (not read). */
  overflow: number;
  counts: { ids: number; userIds: number; phones: number; unrecognised: number; duplicates: number };
}

const PHONE_SHAPE = /^\+?[\d\s().-]{10,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_WORD = /\b(uuid|uid|user ?id|id|phone|mobile|contact|number|name)\b/i;

/** One pasted cell as a phone number or a user id (UUID / numeric id), or neither. */
export function classifyCell(cell: string): { phone: string } | { userId: string } | null {
  const v = cell.trim().replace(/^["']|["']$/g, "");
  if (!v) return null;
  if (PHONE_SHAPE.test(v)) {
    const p = normalisePhone(v);
    if (p) return { phone: p };
  }
  if (UUID.test(v)) return { userId: v.toLowerCase() };
  // Digits that aren't a valid phone number are most likely a mistyped one — not an id.
  if (/^[+\d\s().-]+$/.test(v)) return null;
  // A user id: a UUID (every id in the pool is one), or another id of 6+ letters and digits —
  // never a plain word ("Name", "Cleared").
  const u = normaliseUserId(v);
  if (u && u.length >= 6 && /\d/.test(u) && /[a-z]/.test(u)) return { userId: u };
  return null;
}

/**
 * The pasted text as rows: one line each, cells split on tabs or commas (a row copied from a
 * sheet can carry a UUID and a phone number). Every line keeps its place — blank and
 * unrecognised ones too — so the output lines up with the source when pasted back.
 */
export function parseLookupInput(text: string): LookupInput {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const rows: LookupInputRow[] = [];
  let headerSkipped = false;
  let overflow = 0;
  lines.forEach((rawLine, i) => {
    const raw = rawLine.trim();
    const cells = rawLine.split(/[\t,;]/);
    let phone: string | null = null;
    let userId: string | null = null;
    for (const cell of cells) {
      const c = classifyCell(cell);
      if (c && "phone" in c) phone ??= c.phone;
      else if (c) userId ??= c.userId;
    }
    if (!rows.length && !headerSkipped && !phone && !userId && raw && HEADER_WORD.test(raw)) {
      headerSkipped = true;
      return;
    }
    if (rows.length >= MAX_LOOKUP_ROWS) {
      overflow++;
      return;
    }
    rows.push({ line: i + 1, phone, userId, problem: !raw ? "blank" : phone || userId ? "" : "unrecognised", raw: raw.slice(0, 120) });
  });
  const keys = rows.filter((r) => !r.problem).map((r) => (r.phone ? `p:${r.phone}` : `u:${r.userId}`));
  return {
    rows,
    headerSkipped,
    overflow,
    counts: {
      ids: keys.length,
      userIds: rows.filter((r) => r.userId).length,
      phones: rows.filter((r) => r.phone).length,
      unrecognised: rows.filter((r) => r.problem === "unrecognised").length,
      duplicates: keys.length - new Set(keys).size,
    },
  };
}

// ── Requirements: assessment details, picked one by one ──────────────────────

export type RequirementGroup = "general" | "edge2" | "edge1" | "academy";
export const REQUIREMENT_GROUPS: { group: RequirementGroup; label: string }[] = [
  { group: "general", label: "Any product" },
  { group: "edge2", label: "Edge 2.0" },
  { group: "edge1", label: "Edge 1.0" },
  { group: "academy", label: "Academy" },
];

/** A matched person: the best standing, every product's standing and the records asked for. */
export interface MatchedPerson {
  standing: CandidateStanding;
  records: PersonRecords;
}

export interface Requirement {
  key: string;
  group: RequirementGroup;
  /** The chip's label. */
  label: string;
  /** How the item reads in the Requirements cell ("Edge 2.0 TR-1 ratings: …"). */
  cellLabel: string;
  /** The products whose records it reads (none = the standing alone). */
  needs: Product[];
  /** The candidate's result, or "" when they have none (the item is then skipped). */
  value: (p: MatchedPerson) => string;
}

/** 7, 7.5, 86.25 — no trailing zeros. */
const n = (v: number) => String(Math.round(v * 100) / 100);
const parts = (xs: [string, number | null, number?][]) =>
  xs
    .filter((x): x is [string, number, number?] => typeof x[1] === "number")
    .map(([label, v, of]) => `${label} ${n(v)}${of ? `/${of}` : ""}`)
    .join(" · ");

function competency(subject: CompetencySubject): Requirement {
  return {
    key: `academy.competency.${subject}`,
    group: "academy",
    label: `${COMPETENCY_LABEL[subject]} competency`,
    cellLabel: `Academy ${COMPETENCY_LABEL[subject]} competency`,
    needs: ["academy"],
    value: ({ records }) => {
      const c = records.academy?.competency.find((x) => x.subject === subject);
      if (!c) return "";
      return [
        c.levelLabel || (c.level !== null ? (c.level === 0 ? "Below L1" : `L${c.level}`) : ""),
        c.overallScore !== null ? `${n(c.overallScore)}/100` : "",
        c.verdictBand,
        c.clearanceStatus || (c.cleared ? "Cleared" : ""),
      ]
        .filter(Boolean)
        .join(" · ");
    },
  };
}

/** Every pickable requirement, in the order they appear in the cell. */
export const REQUIREMENTS: Requirement[] = [
  // Any product
  { key: "name", group: "general", label: "Name", cellLabel: "Name", needs: [], value: ({ standing }) => standing.name },
  {
    key: "other-products",
    group: "general",
    label: "Other products",
    cellLabel: "Also",
    needs: [],
    value: ({ standing }) =>
      standing.standings
        .filter((s) => s.product !== standing.bestProduct)
        .map((s) => `${s.label}${s.eligible ? "" : " (not eligible)"}`)
        .join("; "),
  },
  { key: "internal-score", group: "general", label: "Score within stage", cellLabel: "Score within stage", needs: [], value: ({ standing }) => `${standing.bestScore}/100` },
  {
    key: "resume",
    group: "general",
    label: "Resume link (pool)",
    cellLabel: "Resume",
    needs: ["edge2", "edge1", "academy"],
    value: ({ standing, records }) =>
      [standing.bestProduct, ...(["edge2", "edge1", "academy"] as Product[])].map((p) => records[p]?.referenceResumeUrl).find(Boolean) ?? "",
  },
  // Edge 2.0
  { key: "edge2.stage", group: "edge2", label: "Candidate stage", cellLabel: "Edge 2.0 stage", needs: ["edge2"], value: ({ records }) => records.edge2?.candidateStage ?? "" },
  {
    key: "edge2.assessment",
    group: "edge2",
    label: "Assessment scores",
    cellLabel: "Edge 2.0 assessment",
    needs: ["edge2"],
    value: ({ records }) => {
      const r = records.edge2;
      return r
        ? parts([
            ["Offline", r.offlineOverallScore, 160],
            ["DSA coding", r.dsaCodingScore, 120],
            ["CS fundamentals", r.csFundamentalsScore, 40],
            ["SQL MCQ", r.sqlMcqScore, 15],
            ["SQL coding", r.sqlCodingScore, 15],
          ])
        : "";
    },
  },
  {
    key: "edge2.tr1",
    group: "edge2",
    label: "TR-1 ratings",
    cellLabel: "Edge 2.0 TR-1",
    needs: ["edge2"],
    value: ({ records }) => {
      const t = records.edge2?.tr1;
      return t
        ? parts([
            ["Overall technical", t.overallTechnical, 100],
            ["DSA", t.dsaOverall, 10],
            ["Problem solving", t.problemSolving, 10],
            ["Coding", t.coding, 10],
            ["Debugging", t.debugging, 10],
            ["Communication", t.communication, 10],
            ["Self intro", t.selfIntro, 10],
          ])
        : "";
    },
  },
  {
    key: "edge2.tr2",
    group: "edge2",
    label: "TR-2 verdicts",
    cellLabel: "Edge 2.0 TR-2",
    needs: ["edge2"],
    value: ({ records }) => (records.edge2?.tr2 ?? []).map((v) => `${TR2_TRACK_LABEL[v.track] ?? v.track} ${VERDICT_LABEL[v.verdict] ?? v.verdict}`).join(" · "),
  },
  // Edge 1.0
  { key: "edge1.assessment", group: "edge1", label: "Assessment", cellLabel: "Edge 1.0 assessment", needs: ["edge1"], value: ({ records }) => records.edge1?.assessmentStatus ?? "" },
  { key: "edge1.tr1", group: "edge1", label: "TR-1", cellLabel: "Edge 1.0 TR-1", needs: ["edge1"], value: ({ records }) => records.edge1?.tr1Status ?? "" },
  { key: "edge1.tr2", group: "edge1", label: "TR-2", cellLabel: "Edge 1.0 TR-2", needs: ["edge1"], value: ({ records }) => records.edge1?.tr2Status ?? "" },
  // Academy
  {
    key: "academy.interviews",
    group: "academy",
    label: "Bucket interviews (TR-1 / TR-2)",
    cellLabel: "Academy interviews",
    needs: ["academy"],
    value: ({ records }) =>
      (records.academy?.rounds ?? [])
        .map((r) => `Bucket ${r.bucket} TR-${r.round} ${r.status || (r.cleared ? "Cleared" : "Not cleared")}${r.score !== null ? ` (${n(r.score)})` : ""}`)
        .join(" · "),
  },
  competency("dsa"),
  competency("frontend"),
  competency("backend"),
  competency("software"),
  {
    key: "academy.old-bucket",
    group: "academy",
    label: "Old assessment bucket",
    cellLabel: "Academy old assessment",
    needs: ["academy"],
    value: ({ records }) => (records.academy?.oldBucket ? `Bucket ${records.academy.oldBucket}` : ""),
  },
  {
    key: "academy.dsa-offline",
    group: "academy",
    label: "DSA offline exam",
    cellLabel: "Academy DSA offline",
    needs: ["academy"],
    value: ({ records }) => records.academy?.dsaOfflineStatus || (records.academy?.dsaOfflineCleared ? "Cleared" : ""),
  },
  {
    key: "academy.active-pool",
    group: "academy",
    label: "Active pool",
    cellLabel: "Academy active pool",
    needs: ["academy"],
    value: ({ records }) => (records.academy?.activePool === true ? "Yes" : records.academy?.activePool === false ? "No" : ""),
  },
  {
    key: "academy.placement",
    group: "academy",
    label: "Previous placement",
    cellLabel: "Academy previous placement",
    needs: ["academy"],
    value: ({ records }) => records.academy?.previousPlacement ?? "",
  },
  { key: "academy.preference", group: "academy", label: "Preference", cellLabel: "Academy preference", needs: ["academy"], value: ({ records }) => records.academy?.studentPreference ?? "" },
  { key: "academy.yog", group: "academy", label: "Year of graduation", cellLabel: "Academy YOG", needs: ["academy"], value: ({ records }) => (records.academy?.yog ? String(records.academy.yog) : "") },
];

const BY_KEY = new Map(REQUIREMENTS.map((r) => [r.key, r]));

/** Known keys only, in catalogue order (drops stale keys from an older saved choice). */
export const cleanRequirementKeys = (keys: string[]): string[] => REQUIREMENTS.map((r) => r.key).filter((k) => keys.includes(k));

/** The products whose records the picked requirements read. */
export function productsNeeded(keys: string[]): Product[] {
  const set = new Set(keys.flatMap((k) => BY_KEY.get(k)?.needs ?? []));
  return (["edge2", "edge1", "academy"] as Product[]).filter((p) => set.has(p));
}

/** The Requirements cell's lines: "<item>: <result>" for each picked item the candidate has a result for. */
export function requirementLines(person: MatchedPerson, keys: string[]): string[] {
  return cleanRequirementKeys(keys)
    .map((k) => {
      const req = BY_KEY.get(k)!;
      const v = req.value(person).trim();
      return v ? `${req.cellLabel}: ${v}` : "";
    })
    .filter(Boolean);
}

// ── The result ────────────────────────────────────────────────────────────────

export type LookupStatus = "internal" | "not-eligible" | "external" | "unrecognised" | "blank";

export interface LookupRow {
  line: number;
  status: LookupStatus;
  tier: Tier | null;
  product: Product | null;
  /** Pasted, or the pool's when only a phone number was pasted. */
  uuid: string;
  phone: string;
  cells: Record<string, string>;
  requirements: string[];
}

export interface LookupData {
  standings: Record<string, CandidateStanding>;
  records: Record<string, PersonRecords>;
}

/** Every pasted row with its standing and, for matched people, the picked requirements. */
export function lookupRows(input: LookupInput, data: LookupData, keys: string[]): LookupRow[] {
  return input.rows.map((r): LookupRow => {
    const base = { line: r.line, uuid: r.userId ?? "", phone: r.phone ?? "", requirements: [] as string[], tier: null, product: null, cells: {} as Record<string, string> };
    if (r.problem === "blank") return { ...base, status: "blank" };
    if (r.problem === "unrecognised") return { ...base, status: "unrecognised", cells: { "Internal Standing": "Not a UUID or phone number" } };
    const st = standingFor(data.standings, r.phone ?? "", r.userId ?? "");
    if (!st) return { ...base, status: "external", cells: internalColumns(null, true) };
    const key = st.matchedBy === "phone" ? `p:${normalisePhone(r.phone ?? "")}` : `u:${normaliseUserId(r.userId ?? "")}`;
    const standing = data.standings[key];
    const person: MatchedPerson = { standing, records: data.records[String(standing.candidateId)] ?? {} };
    return {
      ...base,
      uuid: r.userId ?? standing.userId ?? "",
      status: isAssessed(st) ? "internal" : "not-eligible",
      tier: st.tier,
      product: st.product,
      cells: internalColumns(st, true),
      requirements: requirementLines(person, keys),
    };
  });
}

/** Columns and rows for the CSV / the clipboard: UUID, Phone (when pasted), the three standing columns, Requirements (when picked). */
export function lookupTable(rows: LookupRow[], opts: { phoneColumn: boolean; requirements: boolean }): { headers: string[]; rows: Record<string, string>[] } {
  const headers = ["UUID", ...(opts.phoneColumn ? ["Phone"] : []), ...STANDING_HEADERS, ...(opts.requirements ? ["Requirements"] : [])];
  return {
    headers,
    rows: rows.map((r) => ({
      UUID: r.uuid,
      Phone: r.phone,
      ...r.cells,
      Requirements: r.requirements.join("\n"),
    })),
  };
}

export interface LookupSummary {
  /** Rows with an id. */
  looked: number;
  internal: number;
  byTier: Record<1 | 2 | 3, number>;
  notEligible: number;
  external: number;
  unrecognised: number;
  byProduct: Record<Product, number>;
}

export function summarise(rows: LookupRow[]): LookupSummary {
  const s: LookupSummary = { looked: 0, internal: 0, byTier: { 1: 0, 2: 0, 3: 0 }, notEligible: 0, external: 0, unrecognised: 0, byProduct: { edge2: 0, edge1: 0, academy: 0 } };
  for (const r of rows) {
    if (r.status === "blank") continue;
    if (r.status === "unrecognised") {
      s.unrecognised++;
      continue;
    }
    s.looked++;
    if (r.status === "external") s.external++;
    else if (r.status === "not-eligible") s.notEligible++;
    else {
      s.internal++;
      if (r.tier && r.tier <= 3) s.byTier[r.tier as 1 | 2 | 3]++;
      if (r.product) s.byProduct[r.product]++;
    }
  }
  return s;
}

// ── Clipboard (Google Sheets / Excel) ────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An HTML table — Sheets and Excel keep multi-line cells intact when pasting it. */
export function toHtmlTable(headers: string[], rows: Record<string, string>[]): string {
  const cell = (tag: "th" | "td", v: string) => `<${tag}>${escapeHtml(v).replace(/\n/g, "<br>")}</${tag}>`;
  return `<table><thead><tr>${headers.map((h) => cell("th", h)).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${headers.map((h) => cell("td", r[h] ?? "")).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/** Tab-separated text; a cell with a tab, quote or line break is quoted (as Excel does). */
export function toTsv(headers: string[], rows: Record<string, string>[]): string {
  const cell = (v: string) => (/[\t"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.map(cell).join("\t"), ...rows.map((r) => headers.map((h) => cell(r[h] ?? "")).join("\t"))].join("\n");
}
