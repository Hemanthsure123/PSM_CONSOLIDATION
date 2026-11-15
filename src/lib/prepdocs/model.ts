import { SchemaType, type Schema } from "@google/generative-ai";

/**
 * A prep document as data (format v2, the team's master prompt of 2026-11-15). The model writes
 * this JSON — never the file; the server renders the .docx / Notion page. Pure — tested in
 * scripts/prep-actions-selftest.ts.
 *
 * The rules the master prompt calls absolute are enforced here, not only asked of the model:
 *   - a question under "Questions asked in real interviews" must trace to the supplied material
 *     or a named research source, else it moves to "Questions to practise" (§2 evidence tiers);
 *   - links only if supplied or actually found (§4), no constructed URLs;
 *   - the fixed vocabularies for priority tags (at most 3) and box labels (§7.9);
 *   - no emojis, no nested bullets, no Markdown marks (§7.10);
 *   - the page budget from the evidence volume, never more than 7 pages, cut in the §5 order.
 */

export const SECTION_IDS = ["overview", "start_here", "about_company", "topics", "checklist", "summary"] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export const SECTION_LABEL: Record<SectionId, string> = {
  overview: "Overview table",
  start_here: "Start here",
  about_company: "About the company (only with supplied or confirmed details)",
  topics: "Numbered sections (topics and questions)",
  checklist: "Checklist",
  summary: "In short",
};

export const PRIORITY_TAGS = [
  "HIGHEST PRIORITY",
  "MOST IMPORTANT",
  "PRIORITY AREA",
  "ASKED IN EVERY ROUND",
  "RESUME-SPECIFIC",
  "ASSIGNMENT-SPECIFIC",
  "LIKELY CASE",
  "A CLEAR GAP",
  "PREPARE THIS CAREFULLY",
  "ASKED IN DEPTH",
  "THE HARDEST PART",
] as const;

export const BOX_LABELS = ["PRIORITY AREA", "WHAT TO KEEP IN MIND", "BEFORE THE ROUND", "A LINE YOU CAN USE", "HOW TO ANSWER THIS", "A STRONG ANSWER SHAPE FOR THIS SECTION"] as const;

export const OVERVIEW_LABELS = ["What this round is", "The role", "What they test", "What it is not", "What is at stake", "Be ready for", "What they do not expect"] as const;

export interface PrepSection {
  title: string;
  /** One of PRIORITY_TAGS, or "". */
  tag: string;
  /** One or two plain sentences: why it matters and what evidence it rests on. */
  intro: string;
  topics: { name: string; revise: string }[];
  /** Tier 1 / 3: from the supplied material or a named source about this company. */
  asked: string[];
  /** Tier 4: the writer's own judgement from the job description. */
  practise: string[];
  /** A 3-column comparison, only when the content is genuinely comparative. */
  grid: { header: string[]; rows: string[][] } | null;
  box: { label: string; body: string[] } | null;
}

export interface PrepDoc {
  /** Set by the server: the company name in capitals. */
  title: string;
  /** Set by the server: "Role · Round · Preparation Guide". */
  subtitle: string;
  /** One true sentence naming what the guide is built from. */
  sourceLine: string;
  overview: { label: string; value: string }[];
  startHere: string[];
  /** Only when company details were supplied or a named source confirmed them. */
  aboutCompany: string[];
  sections: PrepSection[];
  checklist: { beforeHeading: string; before: string[]; duringHeading: string; during: string[] };
  inShort: string;
  /** Pages actually read (research) or links supplied — never constructed. */
  sources: { title: string; url: string }[];
  /** For an update: what changed, in plain words. */
  changes: string[];
  /** Things that could not be verified. */
  unverified: string[];
  /** True when no real interview reports existed (said plainly in START HERE). */
  noInterviewReports: boolean;
}

const str = { type: SchemaType.STRING } as const;
const strArr = { type: SchemaType.ARRAY, items: str } as const;

export const PREP_DOC_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    sourceLine: str,
    overview: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { label: str, value: str }, required: ["label", "value"] } },
    startHere: strArr,
    aboutCompany: strArr,
    sections: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: str,
          tag: str,
          intro: str,
          topics: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { name: str, revise: str }, required: ["name", "revise"] } },
          asked: strArr,
          practise: strArr,
          grid: { type: SchemaType.OBJECT, nullable: true, properties: { header: strArr, rows: { type: SchemaType.ARRAY, items: strArr } }, required: ["header", "rows"] },
          box: { type: SchemaType.OBJECT, nullable: true, properties: { label: str, body: strArr }, required: ["label", "body"] },
        },
        required: ["title", "tag", "intro", "topics", "asked", "practise"],
      },
    },
    checklist: {
      type: SchemaType.OBJECT,
      properties: { beforeHeading: str, before: strArr, duringHeading: str, during: strArr },
      required: ["beforeHeading", "before", "duringHeading", "during"],
    },
    inShort: str,
    sources: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { title: str, url: str }, required: ["title", "url"] } },
    changes: strArr,
    unverified: strArr,
    noInterviewReports: { type: SchemaType.BOOLEAN },
  },
  required: ["sourceLine", "overview", "startHere", "aboutCompany", "sections", "checklist", "inShort", "sources", "changes", "unverified", "noInterviewReports"],
};

export const PREP_DOC_SHAPE_HINT = `Return ONLY a JSON object: {"sourceLine","overview":[{"label","value"}],"startHere":[..],"aboutCompany":[..],"sections":[{"title","tag","intro","topics":[{"name","revise"}],"asked":[..],"practise":[..],"grid":{"header":[3 strings],"rows":[[3 strings]]}|null,"box":{"label","body":[..]}|null}],"checklist":{"beforeHeading","before":[..],"duringHeading","during":[..]},"inShort","sources":[{"title","url"}],"changes":[..],"unverified":[..],"noInterviewReports":true|false}`;

// ── Cleaning ─────────────────────────────────────────────────────────────────

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}]/gu;
/** One plain line: Docs and Notion show Markdown marks literally, so they go; no emojis, no bullet glyphs. */
const clean = (v: unknown, max = 600) =>
  String(v ?? "")
    .replace(/\*\*|`|^#+\s*/g, "")
    .replace(EMOJI, "")
    .replace(/^\s*(?:[-•*]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const list = (v: unknown, max = 30, len = 600) => (Array.isArray(v) ? v.map((x) => clean(x, len)).filter(Boolean).slice(0, max) : []);
const httpUrl = (u: string) => /^https?:\/\/[^\s<>"]+$/i.test(u);

const pickWord = (v: unknown, allowed: readonly string[]) => {
  const s = clean(v, 60).toUpperCase();
  return allowed.find((a) => a.toUpperCase() === s) ?? "";
};

// ── Evidence tiers ───────────────────────────────────────────────────────────

const STOP = new Set(
  "a an the and or of to in on for with is are was were be been it its this that these those how what why which who when where did do does about from by as at into than then there their they them can could should would will just also any some more most very you your".split(
    " ",
  ),
);
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9+#]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * The evidence a "real interview" question must trace to: the supplied material (drill-downs,
 * transcripts, RSAs, the company's own text) and the research notes from named sources.
 */
export class Evidence {
  private readonly vocab = new Set<string>();
  private readonly text: string;
  readonly urls: Set<string>;

  constructor(texts: string[], urls: string[]) {
    this.text = texts.join("\n").toLowerCase().replace(/\s+/g, " ");
    for (const w of words(this.text)) this.vocab.add(w);
    this.urls = new Set(urls.map((u) => u.trim().replace(/\/+$/, "").toLowerCase()));
  }

  /** A question traces when most of its content words are in the evidence (asked questions are lightly cleaned, not rewritten). */
  traces(question: string): boolean {
    const w = words(question);
    if (!w.length) return false;
    if (this.text.includes(question.toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, ""))) return true;
    return w.filter((x) => this.vocab.has(x) || this.vocab.has(x.replace(/s$/, ""))).length / w.length >= 0.75;
  }

  /** A link was supplied or found by research — never constructed. */
  knows(url: string): boolean {
    const u = url.trim().replace(/\/+$/, "").toLowerCase();
    return this.urls.has(u) || this.text.includes(u);
  }
}

export interface NormaliseOptions {
  evidence: Evidence;
  /** Company details were supplied (website / LinkedIn read) or research found named facts. */
  companyDetailsAllowed: boolean;
}

/** Whatever the model returned → a safe PrepDoc, or null when unusable. [moved] counts questions moved to "practise". */
export function normalizePrepDoc(raw: unknown, opts?: NormaliseOptions): PrepDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  let tags = 0;
  const sections = (Array.isArray(r.sections) ? r.sections : [])
    .slice(0, 13)
    .map((s): PrepSection | null => {
      if (!s || typeof s !== "object") return null;
      const x = s as Record<string, unknown>;
      const title = clean(x.title, 90).replace(/^\d+[.)]\s*/, "");
      if (!title) return null;
      let tag = pickWord(x.tag, PRIORITY_TAGS);
      if (tag && ++tags > 3) tag = "";
      let asked = list(x.asked, 40, 400);
      let practise = list(x.practise, 25, 400);
      if (opts) {
        const moved = asked.filter((q) => !opts.evidence.traces(q));
        asked = asked.filter((q) => opts.evidence.traces(q));
        practise = [...moved, ...practise].slice(0, 25);
      }
      const g = x.grid && typeof x.grid === "object" ? (x.grid as Record<string, unknown>) : null;
      const header = g ? list(g.header, 3, 60) : [];
      const rows = g && Array.isArray(g.rows) ? g.rows.map((row) => list(row, 3, 240)).filter((row) => row.length >= 2).slice(0, 10) : [];
      const b = x.box && typeof x.box === "object" ? (x.box as Record<string, unknown>) : null;
      const boxLabel = b ? pickWord(b.label, BOX_LABELS) || "WHAT TO KEEP IN MIND" : "";
      const boxBody = b ? list(b.body, 4, 400) : [];
      return {
        title,
        tag,
        intro: clean(x.intro, 320),
        topics: (Array.isArray(x.topics) ? x.topics : [])
          .map((t) => (t && typeof t === "object" ? { name: clean((t as Record<string, unknown>).name, 90), revise: clean((t as Record<string, unknown>).revise, 300) } : null))
          .filter((t): t is { name: string; revise: string } => Boolean(t?.name))
          .slice(0, 12),
        asked,
        practise,
        grid: header.length >= 2 && rows.length ? { header: header.slice(0, 3), rows } : null,
        box: boxBody.length ? { label: boxLabel, body: boxBody } : null,
      };
    })
    .filter((s): s is PrepSection => s !== null && (s.topics.length > 0 || s.asked.length > 0 || s.practise.length > 0));
  if (!sections.length) return null;
  const c = r.checklist && typeof r.checklist === "object" ? (r.checklist as Record<string, unknown>) : {};
  const sources = (Array.isArray(r.sources) ? r.sources : [])
    .map((l) => (l && typeof l === "object" ? { title: clean((l as Record<string, unknown>).title, 120), url: clean((l as Record<string, unknown>).url, 500) } : null))
    .filter((l): l is { title: string; url: string } => Boolean(l?.title && httpUrl(l.url) && (!opts || opts.evidence.knows(l.url))))
    .slice(0, 8);
  return {
    title: "",
    subtitle: "",
    sourceLine: clean(r.sourceLine, 240),
    overview: (Array.isArray(r.overview) ? r.overview : [])
      .map((o) => (o && typeof o === "object" ? { label: clean((o as Record<string, unknown>).label, 40), value: clean((o as Record<string, unknown>).value, 300) } : null))
      .filter((o): o is { label: string; value: string } => Boolean(o?.label && o.value))
      .slice(0, 6),
    startHere: list(r.startHere, 4, 500),
    aboutCompany: opts && !opts.companyDetailsAllowed ? [] : list(r.aboutCompany, 7, 300),
    sections,
    checklist: {
      beforeHeading: clean(c.beforeHeading, 40) || "Before the interview",
      before: list(c.before, 10, 200),
      duringHeading: clean(c.duringHeading, 40) || "In the interview",
      during: list(c.during, 6, 200),
    },
    inShort: clean(r.inShort, 400).replace(/^in short\s*[:—-]\s*/i, ""),
    sources,
    changes: list(r.changes, 20, 300),
    unverified: list(r.unverified, 20, 300),
    noInterviewReports: r.noInterviewReports === true,
  };
}

/** Drops the parts the user left out. */
export function selectSections(doc: PrepDoc, keep: SectionId[]): PrepDoc {
  const has = (s: SectionId) => keep.includes(s);
  return {
    ...doc,
    overview: has("overview") ? doc.overview : [],
    startHere: has("start_here") ? doc.startHere : [],
    aboutCompany: has("about_company") ? doc.aboutCompany : [],
    sections: has("topics") ? doc.sections : [],
    checklist: has("checklist") ? doc.checklist : { ...doc.checklist, before: [], during: [] },
    inShort: has("summary") ? doc.inShort : "",
  };
}

// ── Page budget (§5) ─────────────────────────────────────────────────────────

export type Richness = "thin" | "okay" | "rich";
export const PAGE_BUDGET: Record<Richness, number> = { thin: 3, okay: 5, rich: 7 };
export const PAGE_CEILING = 7;

/** How much real interview intelligence there is: real questions and the volume of supplied material. */
export function richness(realQuestions: number, materialChars: number): Richness {
  if (realQuestions >= 25 || materialChars >= 40_000) return "rich";
  if (realQuestions >= 6 || materialChars >= 8_000) return "okay";
  return "thin";
}

/** About how many US Letter pages the document takes at the spec's sizes (~95 chars a line, ~46 lines a page). */
export function pagesOf(doc: PrepDoc): number {
  let lines = 4; // title block
  const text = (s: string, per = 95) => Math.max(1, Math.ceil(s.length / per));
  if (doc.overview.length) lines += doc.overview.reduce((n, o) => n + Math.max(text(o.value, 70), 1) + 0.4, 1);
  if (doc.startHere.length) lines += doc.startHere.reduce((n, p) => n + text(p, 88) + 0.4, 2.5);
  if (doc.aboutCompany.length) lines += 2 + doc.aboutCompany.reduce((n, b) => n + text(b), 0);
  for (const s of doc.sections) {
    lines += 2.5 + (s.intro ? text(s.intro) : 0);
    if (s.topics.length) lines += 1.6 + s.topics.reduce((n, t) => n + text(`${t.name} — ${t.revise}`), 0);
    if (s.asked.length) lines += 1.6 + s.asked.reduce((n, q) => n + text(q), 0);
    if (s.practise.length) lines += 1.6 + s.practise.reduce((n, q) => n + text(q), 0);
    if (s.grid) lines += 1.5 + s.grid.rows.reduce((n, r) => n + Math.max(...r.map((c) => text(c, 30))) + 0.5, 0);
    if (s.box) lines += 3 + s.box.body.reduce((n, b) => n + text(b, 88), 0);
  }
  if (doc.checklist.before.length || doc.checklist.during.length) lines += 5 + [...doc.checklist.before, ...doc.checklist.during].reduce((n, c) => n + text(c), 0);
  if (doc.inShort) lines += 3 + text(doc.inShort, 88);
  if (doc.sources.length) lines += 2;
  return lines / 46;
}

/** Two questions test the same thing in different words (real questions need a closer match). */
const near = (a: string, b: string, min = 0.8) => {
  const x = new Set(words(a));
  const y = words(b);
  if (!x.size || !y.length) return false;
  return y.filter((w) => x.has(w)).length / Math.max(x.size, y.length) >= min;
};

/**
 * Cuts the document down to [budget] pages in the master prompt's order: duplicate questions,
 * thin sections merged, topic bullets compressed, Tier 4 questions, the behavioural section.
 * Never cuts START HERE, Tier 1 questions, the checklist or IN SHORT.
 */
export function fitToBudget(doc: PrepDoc, budget: number): { doc: PrepDoc; cuts: string[] } {
  const max = Math.min(budget, PAGE_CEILING);
  const d: PrepDoc = { ...doc, sections: doc.sections.map((s) => ({ ...s, topics: [...s.topics], asked: [...s.asked], practise: [...s.practise] })) };
  const cuts: string[] = [];
  if (pagesOf(d) <= max) return { doc: d, cuts };

  // 1. Duplicate questions (the same thing in different words), across the whole document.
  const seen: string[] = [];
  let dupes = 0;
  for (const s of d.sections) {
    for (const k of ["asked", "practise"] as const) {
      s[k] = s[k].filter((q) => {
        if (seen.some((p) => near(p, q, k === "asked" ? 0.9 : 0.8))) {
          dupes++;
          return false;
        }
        seen.push(q);
        return true;
      });
    }
  }
  if (dupes) cuts.push(`${dupes} duplicate question${dupes === 1 ? "" : "s"} removed`);
  if (pagesOf(d) <= max) return { doc: d, cuts };

  // 2. Thin sections (one or two items, no real questions) merged into "A few smaller things".
  const thin = d.sections.filter((s) => !s.asked.length && s.topics.length + s.practise.length <= 2 && !s.tag);
  if (thin.length >= 2) {
    const merged: PrepSection = {
      title: "A few smaller things",
      tag: "",
      intro: "These came up less often. A short answer is enough for each.",
      topics: thin.flatMap((s) => (s.topics.length ? s.topics : [{ name: s.title, revise: s.intro }])).slice(0, 8),
      asked: [],
      practise: thin.flatMap((s) => s.practise).slice(0, 6),
      grid: null,
      box: null,
    };
    const at = d.sections.indexOf(thin[0]);
    d.sections = d.sections.filter((s) => !thin.includes(s));
    d.sections.splice(Math.min(at, d.sections.length), 0, merged);
    cuts.push(`${thin.length} thin sections merged`);
  }
  if (pagesOf(d) <= max) return { doc: d, cuts };

  // 3. Topic bullets compressed to one short line each.
  for (const s of d.sections) s.topics = s.topics.map((t) => ({ name: t.name, revise: t.revise.length > 110 ? `${t.revise.slice(0, 107).replace(/\s+\S*$/, "")}…` : t.revise }));
  cuts.push("topic bullets shortened");
  if (pagesOf(d) <= max) return { doc: d, cuts };

  // 4. Tier 4 ("questions to practise") before anything real.
  let removed = 0;
  for (let guard = 0; pagesOf(d) > max && guard < 200; guard++) {
    const s = [...d.sections].sort((a, b) => b.practise.length - a.practise.length)[0];
    if (!s || !s.practise.length) break;
    s.practise.pop();
    removed++;
  }
  if (removed) cuts.push(`${removed} practice question${removed === 1 ? "" : "s"} cut`);
  if (pagesOf(d) <= max) return { doc: d, cuts };

  // 5. The behavioural section down to a short list of prompts.
  const hr = d.sections.find((s) => /behaviou?ral|\bhr\b|culture/i.test(s.title));
  if (hr) {
    hr.topics = hr.topics.slice(0, 4).map((t) => ({ name: t.name, revise: "" }));
    hr.box = null;
    hr.grid = null;
    cuts.push("behavioural section shortened");
  }
  // Still over the ceiling: callouts, then topics, then whole sections without real questions —
  // always from the lowest priority (the end) up, never a real question.
  for (let i = d.sections.length - 1; i >= 0 && pagesOf(d) > max; i--) {
    const s = d.sections[i];
    if (s.box || s.grid) {
      s.box = null;
      s.grid = null;
      cuts.push(`"${s.title}" callouts removed`);
    }
  }
  for (const keep of [4, 2]) {
    for (let i = d.sections.length - 1; i >= 0 && pagesOf(d) > max; i--) {
      const s = d.sections[i];
      if (s.topics.length > keep) {
        s.topics = s.topics.slice(0, keep);
        cuts.push(`"${s.title}" topics cut to ${keep}`);
      }
    }
  }
  for (let i = d.sections.length - 1; i >= 0 && pagesOf(d) > max && d.sections.length > 5; i--) {
    if (!d.sections[i].asked.length) {
      cuts.push(`"${d.sections[i].title}" left out (no real questions)`);
      d.sections.splice(i, 1);
    }
  }
  return { doc: d, cuts };
}
