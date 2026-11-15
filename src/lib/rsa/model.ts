import { SchemaType, type Schema } from "@google/generative-ai";

/**
 * An RSA (Rejection Selection Analysis) document as data: the model writes the content sections
 * as JSON, the server fills the header from the sheet and renders the Google Doc. Pure — tested
 * in scripts/rsa-selftest.ts.
 *
 * Rules enforced here (not only asked of the model): bullets only, short lines, at most 3 pages,
 * the person is called "candidate" in the body, every area asked traces to the call, the
 * drill-down or the team's remarks, and the team's remarks always appear in the Remarks section.
 */

export const RSA_RATINGS = ["Good", "Partly answered", "Weak", "Gap", "Not confirmed"] as const;
export type RsaRating = (typeof RSA_RATINGS)[number];

export interface RsaArea {
  area: string;
  asked: string;
  rating: RsaRating;
  /** The short reason after the rating ("covered some metrics, not all"). */
  note: string;
}

export interface RsaContent {
  /** "AI + Growth Engineering Intern" — only when the inputs say it. */
  role: string;
  /** "TR1 → TR2 → HR" — only when the inputs say it. */
  process: string;
  /** "Rejected", "Awaited", "Attended, waiting for results". */
  result: string;
  summary: string[];
  areas: RsaArea[];
  observations: string[];
  actionPlan: string[];
  remarks: { feedbackSource: string; result: string; nextSteps: string; possibleReason: string };
  /** What came up but could not be confirmed from the inputs (shown to the team, not in the document). */
  unconfirmed: string[];
}

/** Everything the document shows. Header fields come from the sheet, never from the model. */
export interface RsaDoc {
  fileName: string;
  /** When the RSA call was (ISO): an update without a new recording keeps it. */
  callAt?: string;
  title: string;
  subtitle: string;
  header: {
    candidateName: string;
    companyRole: string;
    process: string;
    roundAttended: string;
    result: string;
    resumeUrl: string;
    callAndPreparedBy: string;
  };
  content: RsaContent;
  /** The team's remarks, as bullets in the Remarks section. */
  teamRemarks: string[];
}

const str = { type: SchemaType.STRING } as const;
const strArr = { type: SchemaType.ARRAY, items: str } as const;

export const RSA_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    role: str,
    process: str,
    result: str,
    summary: strArr,
    areas: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: { area: str, asked: str, rating: { type: SchemaType.STRING, format: "enum", enum: [...RSA_RATINGS] } as Schema, note: str },
        required: ["area", "asked", "rating", "note"],
      },
    },
    observations: strArr,
    actionPlan: strArr,
    remarks: {
      type: SchemaType.OBJECT,
      properties: { feedbackSource: str, result: str, nextSteps: str, possibleReason: str },
      required: ["feedbackSource", "result", "nextSteps", "possibleReason"],
    },
    unconfirmed: strArr,
  },
  required: ["role", "process", "result", "summary", "areas", "observations", "actionPlan", "remarks", "unconfirmed"],
};

export const RSA_SHAPE_HINT = `Return ONLY a JSON object: {"role","process","result","summary":[..],"areas":[{"area","asked","rating":${RSA_RATINGS.map((r) => `"${r}"`).join("|")},"note"}],"observations":[..],"actionPlan":[..],"remarks":{"feedbackSource","result","nextSteps","possibleReason"},"unconfirmed":[..]}`;

// ── Limits: 1-2 pages usually, never more than 3 ─────────────────────────────

export const RSA_LIMITS = { summary: 6, areas: 10, observations: 6, actionPlan: 7, teamRemarks: 6, unconfirmed: 10, bullet: 220, cell: 240 } as const;

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/gu;
/** One plain line: no Markdown marks (Docs shows them literally), no emojis, collapsed spaces. */
export const clean = (v: unknown, max = 400) =>
  String(v ?? "")
    .replace(/\*\*|`|^#+\s*/g, "")
    .replace(EMOJI, "")
    .replace(/^\s*[-•*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const list = (v: unknown, max: number, len: number) => (Array.isArray(v) ? v.map((x) => clean(x, len)).filter(Boolean).slice(0, max) : []);

// ── "Candidate" only ─────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The body calls the person "candidate" only: their name, "the student", and he / she / his /
 * her / him become "candidate" ("candidate's" for a possessive). Sentence starts are capitalised.
 */
export function candidateOnly(text: string, names: string[]): string {
  let s = ` ${text} `;
  const words = new Set<string>();
  for (const n of names) {
    const full = n.replace(/\s+/g, " ").trim();
    if (full.length >= 3) words.add(full);
    for (const w of full.split(" ")) if (w.replace(/\W/g, "").length >= 3) words.add(w);
  }
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`\\b${escapeRe(w)}('s)?\\b`, "gi"), (_m, poss: string | undefined) => (poss ? "candidate's" : "candidate"));
  }
  s = s
    .replace(/\b(the|this|our)\s+(student|candidate|interviewee)\b/gi, "candidate")
    .replace(/\bstudent('s)?\b/gi, (_m, poss: string | undefined) => (poss ? "candidate's" : "candidate"))
    .replace(/\b(himself|herself)\b/gi, "candidate")
    .replace(/\b(his|hers)\b/gi, "candidate's")
    // "her" before a word is possessive ("her project"); otherwise an object ("asked her").
    .replace(/\bher\b(?=\s+[a-z])/gi, "candidate's")
    .replace(/\b(he|she|him|her)\b/gi, "candidate")
    .replace(/\bcandidate's's\b/gi, "candidate's")
    .replace(/\bcandidate(\s+candidate)+\b/gi, "candidate")
    .trim();
  // "Candidate" at the start of the line and of every sentence.
  return s.replace(/(^|[.!?]\s+)candidate/g, (_m, lead: string) => `${lead}Candidate`);
}

// ── Grounding ────────────────────────────────────────────────────────────────

const STOP = new Set(
  "a an the and or of to in on for with is are was were be been it its this that these those how what why which who when where did do does about from by as at into than then there their they them can could should would will just also any some more most very".split(
    " ",
  ),
);
/** Words that describe any question ("explain", "concept", "overview") say nothing about where it came from. */
const GENERIC = new Set(
  "asked ask asking question questions explain explained explanation explaining overview concept concepts technical discussion discussed details detail approach describe described basic basics understanding knowledge related based round interview panel candidate candidates profile resume topic topics additional general".split(
    " ",
  ),
);
export const contentWords = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).map((w) => w.replace(/\.+$/, "")).filter((w) => w.length >= 3 && !STOP.has(w) && !GENERIC.has(w));

/** Share (0-1) of a line's content words found in the evidence. */
export function support(line: string, evidence: Set<string>): number {
  const w = contentWords(line);
  if (!w.length) return 1;
  return w.filter((x) => evidence.has(x) || evidence.has(x.replace(/s$/, ""))).length / w.length;
}

export const evidenceWords = (texts: string[]) => {
  const set = new Set<string>();
  for (const t of texts) for (const w of contentWords(t)) {
    set.add(w);
    set.add(w.replace(/s$/, ""));
  }
  return set;
};

/** An area asked must trace to the call, the drill-down or the remarks; below this it is dropped. */
export const MIN_SUPPORT = 0.34;

// ── Normalising the model's output ───────────────────────────────────────────

/** Splits the team's remarks into short bullets (lines, then sentences). */
export function remarkBullets(remarks: string): string[] {
  const lines = remarks
    .split(/\r?\n+/)
    .map((l) => clean(l, 600))
    .filter(Boolean);
  const out: string[] = [];
  for (const l of lines) {
    if (l.length <= RSA_LIMITS.bullet) out.push(l);
    else out.push(...(l.match(/[^.!?]+[.!?]?/g) ?? [l]).map((x) => x.trim()).filter(Boolean));
  }
  return out.map((b) => clean(b, RSA_LIMITS.bullet)).filter(Boolean).slice(0, RSA_LIMITS.teamRemarks);
}

export interface NormaliseInput {
  /** The candidate's name (and any other names in the inputs): never in the body. */
  names: string[];
  /** Call transcript, drill-down and remarks: what an area asked must trace to. */
  evidence: string[];
}

/** The model's JSON → safe content (limits, "candidate" only, grounded areas), or null when unusable. */
export function normaliseRsa(raw: unknown, input: NormaliseInput): { content: RsaContent; dropped: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const fix = (s: string) => candidateOnly(s, input.names);
  const bullets = (v: unknown, max: number) => list(v, max, RSA_LIMITS.bullet).map(fix).filter(Boolean);
  const ev = evidenceWords(input.evidence);
  const dropped: string[] = [];
  const areas: RsaArea[] = [];
  for (const a of Array.isArray(r.areas) ? r.areas : []) {
    if (!a || typeof a !== "object") continue;
    const x = a as Record<string, unknown>;
    const area = clean(x.area, 60);
    const asked = fix(clean(x.asked, RSA_LIMITS.cell));
    if (!area || !asked) continue;
    if (support(asked, ev) < MIN_SUPPORT) {
      dropped.push(`${area}: "${asked.slice(0, 80)}" is not in the call, the drill-down or the remarks`);
      continue;
    }
    const rating = (RSA_RATINGS as readonly string[]).includes(String(x.rating)) ? (x.rating as RsaRating) : "Not confirmed";
    areas.push({ area, asked, rating, note: fix(clean(x.note, RSA_LIMITS.cell)) });
    if (areas.length >= RSA_LIMITS.areas) break;
  }
  const summary = bullets(r.summary, RSA_LIMITS.summary);
  if (!summary.length && !areas.length) return null;
  const rm = r.remarks && typeof r.remarks === "object" ? (r.remarks as Record<string, unknown>) : {};
  return {
    content: {
      role: clean(r.role, 120),
      process: clean(r.process, 160),
      result: clean(r.result, 120),
      summary,
      areas,
      observations: bullets(r.observations, RSA_LIMITS.observations),
      actionPlan: bullets(r.actionPlan, RSA_LIMITS.actionPlan),
      remarks: {
        feedbackSource: fix(clean(rm.feedbackSource, RSA_LIMITS.bullet)),
        result: fix(clean(rm.result, RSA_LIMITS.bullet)),
        nextSteps: fix(clean(rm.nextSteps, RSA_LIMITS.bullet)),
        possibleReason: fix(clean(rm.possibleReason, RSA_LIMITS.bullet)),
      },
      unconfirmed: list(r.unconfirmed, RSA_LIMITS.unconfirmed, 200).map(fix),
    },
    dropped,
  };
}

// ── Header, file name, page budget ───────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15-Nov-2026" in IST (the RSA sheet's date format). */
export function sheetDate(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${ist.getUTCDate()}-${MONTHS[ist.getUTCMonth()]}-${ist.getUTCFullYear()}`;
}

/** "15 Nov 2026" in IST. */
export function longDate(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

const part = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

/** RSA_<Candidate_Name>_<Company>_<Round>_<Date>, e.g. RSA_Asha_Rao_Acme_ai_TR1_15-Nov-2026. */
export function rsaFileName(candidate: string, company: string, round: string, date: Date): string {
  return ["RSA", part(candidate) || "Candidate", part(company) || "Company", part(round) || "Round", sheetDate(date)].join("_");
}

/** About how many pages the document takes (the server can't render it). */
export function rsaPages(doc: Pick<RsaDoc, "content" | "teamRemarks">): number {
  const c = doc.content;
  const bullets = [...c.summary, ...c.observations, ...c.actionPlan, ...doc.teamRemarks, ...Object.values(c.remarks)].filter(Boolean);
  let lines = 22; // title, subtitle, header table, five headings
  for (const b of bullets) lines += Math.ceil(b.length / 95) + 0.3;
  for (const a of c.areas) lines += Math.max(Math.ceil(a.asked.length / 32), Math.ceil(`${a.rating}: ${a.note}`.length / 32), 1) + 0.6;
  return lines / 50;
}

/** Trims the longest lists until the document fits in [maxPages] (3). */
export function fitRsa(doc: RsaDoc, maxPages = 3): RsaDoc {
  const d: RsaDoc = { ...doc, content: { ...doc.content, areas: [...doc.content.areas], observations: [...doc.content.observations], actionPlan: [...doc.content.actionPlan], summary: [...doc.content.summary] } };
  const c = d.content;
  // Cut in this order: observations, action plan, areas (keep the gaps), summary — never below a floor.
  for (let guard = 0; rsaPages(d) > maxPages && guard < 40; guard++) {
    if (c.observations.length > 3) c.observations.pop();
    else if (c.actionPlan.length > 4) c.actionPlan.pop();
    else if (c.areas.length > 5) {
      const i = c.areas.map((a) => a.rating).lastIndexOf("Good");
      c.areas.splice(i >= 0 ? i : c.areas.length - 1, 1);
    } else if (c.summary.length > 3) c.summary.pop();
    else break;
  }
  return d;
}
