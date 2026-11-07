import { SchemaType, type Schema } from "@google/generative-ai";

/**
 * A prep document as data. The model writes this JSON (never HTML or Notion blocks); the server
 * renders it into a Google Doc or a Notion page. Pure — tested in scripts/prep-selftest.ts.
 */

export const SECTION_IDS = ["overview", "start_here", "about_company", "topics", "checklist", "summary"] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export const SECTION_LABEL: Record<SectionId, string> = {
  overview: "Overview table",
  start_here: "Start here",
  about_company: "About the company",
  topics: "Topic sections (questions asked)",
  checklist: "Checklist",
  summary: "Summary",
};

export interface TopicSection {
  title: string;
  /** HIGH PRIORITY, ASKED EVERY TIME, RESUME-SPECIFIC, ASSIGNMENT-SPECIFIC, MOST IMPORTANT. */
  tags: string[];
  why: string;
  topics: { name: string; revise: string }[];
  /** "asked" = verbatim from the material; "practise" = no real questions for this section. */
  questionsKind: "asked" | "practise";
  questions: string[];
  /** Ordered steps when the round rewards a method (debugging, system design …). */
  method: string[];
  callout: { kind: "priority" | "keep_in_mind"; text: string } | null;
}

export interface PrepDoc {
  title: string;
  subtitle: string;
  overview: { label: string; value: string }[];
  links: { label: string; url: string }[];
  startHere: string[];
  aboutCompany: string[];
  whyItMatters: string;
  sayAloud: string;
  sections: TopicSection[];
  checklistBefore: string[];
  checklistDuring: string[];
  summary: string;
  /** For an update: what changed, in plain words. */
  changes: string[];
  /** Things that could not be verified. */
  unverified: string[];
  /** True when no real interview reports existed (said plainly in the document). */
  noInterviewReports: boolean;
}

const str = { type: SchemaType.STRING } as const;
const strArr = { type: SchemaType.ARRAY, items: str } as const;

export const PREP_DOC_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    title: str,
    subtitle: str,
    overview: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { label: str, value: str }, required: ["label", "value"] } },
    links: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { label: str, url: str }, required: ["label", "url"] } },
    startHere: strArr,
    aboutCompany: strArr,
    whyItMatters: str,
    sayAloud: str,
    sections: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: str,
          tags: strArr,
          why: str,
          topics: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { name: str, revise: str }, required: ["name", "revise"] } },
          questionsKind: { type: SchemaType.STRING, enum: ["asked", "practise"] } as Schema,
          questions: strArr,
          method: strArr,
          callout: {
            type: SchemaType.OBJECT,
            nullable: true,
            properties: { kind: { type: SchemaType.STRING, enum: ["priority", "keep_in_mind"] } as Schema, text: str },
            required: ["kind", "text"],
          },
        },
        required: ["title", "tags", "why", "topics", "questionsKind", "questions", "method"],
      },
    },
    checklistBefore: strArr,
    checklistDuring: strArr,
    summary: str,
    changes: strArr,
    unverified: strArr,
    noInterviewReports: { type: SchemaType.BOOLEAN },
  },
  required: [
    "title", "subtitle", "overview", "links", "startHere", "aboutCompany", "whyItMatters", "sayAloud",
    "sections", "checklistBefore", "checklistDuring", "summary", "changes", "unverified", "noInterviewReports",
  ],
};

export const PREP_DOC_SHAPE_HINT = `Return ONLY a JSON object: {"title","subtitle","overview":[{"label","value"}],"links":[{"label","url"}],"startHere":[..],"aboutCompany":[..],"whyItMatters","sayAloud","sections":[{"title","tags":[..],"why","topics":[{"name","revise"}],"questionsKind":"asked"|"practise","questions":[..],"method":[..],"callout":{"kind":"priority"|"keep_in_mind","text"}|null}],"checklistBefore":[..],"checklistDuring":[..],"summary","changes":[..],"unverified":[..],"noInterviewReports":true|false}`;

/** One line of plain text: Google Docs and Notion show Markdown marks (** and `) literally, so they go. */
const clean = (v: unknown, max = 600) => String(v ?? "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const list = (v: unknown, max = 30, len = 600) => (Array.isArray(v) ? v.map((x) => clean(x, len)).filter(Boolean).slice(0, max) : []);
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/gu;
const noEmoji = (s: string) => s.replace(EMOJI, "").replace(/\s{2,}/g, " ").trim();
const ALLOWED_TAGS = ["HIGH PRIORITY", "ASKED EVERY TIME", "RESUME-SPECIFIC", "ASSIGNMENT-SPECIFIC", "MOST IMPORTANT"];

/** Whatever the model returned → a safe PrepDoc (limits, no emojis, only http(s) links), or null when unusable. */
export function normalizePrepDoc(raw: unknown): PrepDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sections = (Array.isArray(r.sections) ? r.sections : []).slice(0, 10).map((s): TopicSection | null => {
    if (!s || typeof s !== "object") return null;
    const x = s as Record<string, unknown>;
    const title = noEmoji(clean(x.title, 120));
    if (!title) return null;
    const callout = x.callout && typeof x.callout === "object" ? (x.callout as Record<string, unknown>) : null;
    const calloutText = callout ? noEmoji(clean(callout.text, 500)) : "";
    return {
      title,
      tags: list(x.tags, 3, 40).map((t) => t.toUpperCase()).filter((t) => ALLOWED_TAGS.includes(t)),
      why: noEmoji(clean(x.why, 300)),
      topics: (Array.isArray(x.topics) ? x.topics : [])
        .map((t) => (t && typeof t === "object" ? { name: noEmoji(clean((t as Record<string, unknown>).name, 120)), revise: noEmoji(clean((t as Record<string, unknown>).revise, 400)) } : null))
        .filter((t): t is { name: string; revise: string } => Boolean(t?.name))
        .slice(0, 14),
      questionsKind: x.questionsKind === "practise" ? "practise" : "asked",
      questions: list(x.questions, 40, 500).map(noEmoji),
      method: list(x.method, 10, 300).map(noEmoji),
      callout: calloutText ? { kind: callout?.kind === "keep_in_mind" ? "keep_in_mind" : "priority", text: calloutText } : null,
    };
  }).filter((s): s is TopicSection => s !== null);
  const title = noEmoji(clean(r.title, 160));
  if (!title || sections.length === 0) return null;
  return {
    title,
    subtitle: noEmoji(clean(r.subtitle, 200)),
    overview: (Array.isArray(r.overview) ? r.overview : [])
      .map((o) => (o && typeof o === "object" ? { label: noEmoji(clean((o as Record<string, unknown>).label, 60)), value: noEmoji(clean((o as Record<string, unknown>).value, 400)) } : null))
      .filter((o): o is { label: string; value: string } => Boolean(o?.label && o.value))
      .slice(0, 6),
    links: (Array.isArray(r.links) ? r.links : [])
      .map((l) => (l && typeof l === "object" ? { label: clean((l as Record<string, unknown>).label, 60), url: clean((l as Record<string, unknown>).url, 400) } : null))
      .filter((l): l is { label: string; url: string } => Boolean(l && /^https?:\/\/\S+$/i.test(l.url)))
      .slice(0, 6),
    startHere: list(r.startHere, 4, 300).map(noEmoji),
    aboutCompany: list(r.aboutCompany, 7, 300).map(noEmoji),
    whyItMatters: noEmoji(clean(r.whyItMatters, 300)),
    sayAloud: noEmoji(clean(r.sayAloud, 300)),
    sections,
    checklistBefore: list(r.checklistBefore, 12, 200).map(noEmoji),
    checklistDuring: list(r.checklistDuring, 12, 200).map(noEmoji),
    summary: noEmoji(clean(r.summary, 600)),
    changes: list(r.changes, 20, 300),
    unverified: list(r.unverified, 20, 300),
    noInterviewReports: r.noInterviewReports === true,
  };
}

/** Drops the sections the user left out. */
export function selectSections(doc: PrepDoc, keep: SectionId[]): PrepDoc {
  const has = (s: SectionId) => keep.includes(s);
  return {
    ...doc,
    overview: has("overview") ? doc.overview : [],
    links: has("overview") ? doc.links : [],
    startHere: has("start_here") ? doc.startHere : [],
    aboutCompany: has("about_company") ? doc.aboutCompany : [],
    whyItMatters: has("about_company") ? doc.whyItMatters : "",
    sayAloud: has("about_company") ? doc.sayAloud : "",
    sections: has("topics") ? doc.sections : [],
    checklistBefore: has("checklist") ? doc.checklistBefore : [],
    checklistDuring: has("checklist") ? doc.checklistDuring : [],
    summary: has("summary") ? doc.summary : "",
  };
}
