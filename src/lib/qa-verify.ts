import { QA_SECTIONS, SECTION_LABEL, type QaItemDef, type QaSection, type SectionQuotes } from "@/lib/qa-types";

/**
 * QA Resume Screening — deterministic checks on the model's evidence.
 * Pure functions (no I/O) so they can be tested on their own.
 *
 *  1. A quote must be about the item (QaItemDef.must) and really be in the
 *     resume text (spacing / punctuation ignored).
 *  2. The quote must sit in the section it is credited to. Section headings
 *     ("SKILLS", "Academic Projects", "Work Experience", "Education"…) are found
 *     on their own lines; when the layout is trustworthy (see `confident`), a
 *     quote found only under ANOTHER section — e.g. "QA" from the company name
 *     "CheckPoint QA Labs" credited to Projects, or "Selenium" from a
 *     certificate credited to Skills — is dropped.
 *  3. Each credited section must point to its OWN place in the resume: if
 *     "Selenium" is written once, it can't count for Skills, Projects and
 *     Experience at the same time. The heading above the mention decides;
 *     without one, only the lowest-scoring section is kept.
 */

type Heading = QaSection | "other" | "unknown";

export interface TextCtx {
  /** Lower-cased text, runs of spaces collapsed, line breaks kept. */
  lined: string;
  /** Letters / digits / + / # only — for spacing-proof containment checks. */
  loose: string;
  words: Set<string>;
  /** Headings found on their own line, in order ("unknown" = an ALL-CAPS line we can't name). */
  headings: { pos: number; line: number; section: Heading }[];
  /**
   * Headings can be trusted to say which section a line is in: at least two of
   * Skills / Projects / Experience have a heading, and no two different
   * headings sit on consecutive lines (that happens when side-by-side columns
   * are read row by row and their text is interleaved).
   */
  confident: boolean;
}

export const loose = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9+#]+/g, "");
const wordsOf = (s: string) => s.normalize("NFKC").toLowerCase().match(/[a-z0-9+#]{2,}/g) ?? [];

const SUFFIX = "(?:\\s*(?:&|and|/)\\s*[a-z ]+)?";
const HEADINGS: [Exclude<Heading, "unknown">, RegExp][] = [
  [
    // Bare "Tools" / "Technologies" / "Tech stack" are left out on purpose: they are also used as
    // labels inside a project, and mistaking one for the Skills heading would misplace that project.
    "skills",
    new RegExp(
      `^(?:technical |key |core |professional |it |relevant |software )?(?:skills|skill set|skillset|core competencies|competencies|technical proficiency)${SUFFIX}$`,
    ),
  ],
  [
    "projects",
    new RegExp(
      `^(?:academic |personal |key |major |minor |mini |main |final year |selected |technical |college |capstone |notable |other |relevant |software |web )?projects?(?: work| details| undertaken| highlights| experience)?${SUFFIX}$`,
    ),
  ],
  [
    "experience",
    new RegExp(
      `^(?:(?:work|professional|internship|industry|industrial|relevant) )?(?:experience|experiences)${SUFFIX}$|^(?:internships?|internship experience|employment(?: history)?|work history|career history)${SUFFIX}$`,
    ),
  ],
  [
    "other",
    new RegExp(
      `^(?:education(?:al)?(?: details| qualifications?| background)?|academic (?:details|qualifications?|background|profile)|qualifications?|certifications?|certificates|courses?|coursework|trainings?|achievements|accomplishments|awards|honors|summary|professional summary|career objective|objective|profile|about me|languages(?: known)?|interests|hobbies|extra[ -]?curricular(?: activities)?|co[ -]?curricular(?: activities)?|positions? of responsibility|leadership|volunteer(?:ing)?|declaration|personal (?:details|information)|contact(?: details| info(?:rmation)?)?|references|publications|strengths)${SUFFIX}$`,
    ),
  ],
];

const MAIN = new Set<Heading>(["skills", "projects", "experience"]);

/** An ALL-CAPS short line ("SOFT SKILLS", "INDUSTRIAL TRAINING", "INFOSYS LIMITED") — a heading we can't name. */
function capsLine(line: string): boolean {
  const t = line.replace(/^[^A-Za-z]+/, "").replace(/[\s:.\-–—]+$/, "");
  return t.length >= 4 && t.length <= 35 && t.split(/\s+/).length <= 4 && /^[A-Z][A-Z &/]+$/.test(t);
}

export function textCtx(text: string): TextCtx {
  const cased = text
    .normalize("NFKC")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n");
  const lined = cased.toLowerCase();
  // Upper/lower forms line up character for character (true for resume text);
  // if not, skip the ALL-CAPS check rather than misplace a heading.
  const casedLines = cased.length === lined.length ? cased.split("\n") : null;
  const headings: TextCtx["headings"] = [];
  let pos = 0;
  lined.split("\n").forEach((line, i) => {
    // Drop icons / bullets / numbering before the heading word and a trailing colon.
    const t = line.replace(/^[^a-z]+/, "").replace(/[\s:.\-–—]+$/, "");
    if (t && t.length <= 40) {
      const hit = HEADINGS.find(([, re]) => re.test(t));
      if (hit) headings.push({ pos, line: i, section: hit[0] });
      else if (casedLines && capsLine(casedLines[i])) headings.push({ pos, line: i, section: "unknown" });
    }
    pos += line.length + 1;
  });

  const named = headings.filter((h) => h.section !== "unknown");
  const mains = new Set(named.filter((h) => MAIN.has(h.section)).map((h) => h.section));
  const sideBySide = named.some((h, k) => k > 0 && h.line === named[k - 1].line + 1 && h.section !== named[k - 1].section);
  return {
    lined,
    loose: loose(lined),
    words: new Set(wordsOf(lined)),
    headings,
    confident: mains.size >= 2 && !sideBySide,
  };
}

/**
 * Is the quote really in the resume? Contiguous match ignoring spacing and
 * punctuation; else (a phrase broken across columns / lines by the PDF text
 * layer) nearly all of its words must be present.
 */
export function inText(quote: string, ctx: TextCtx): boolean {
  const pieces = quote
    .split(/\.{3}|…/)
    .map(loose)
    .filter((p) => p.length >= 2);
  if (pieces.length && pieces.every((p) => ctx.loose.includes(p))) return true;
  const words = wordsOf(quote);
  if (words.length < 3) return false;
  return words.filter((w) => ctx.words.has(w)).length / words.length >= 0.85;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the quote occurs in the text, as [start, end) spans (spacing / punctuation between words ignored). */
export function spansOf(quote: string, ctx: TextCtx, max = 12): [number, number][] {
  const words = quote.normalize("NFKC").toLowerCase().match(/[a-z0-9+#]+/g) ?? [];
  if (!words.length) return [];
  const re = new RegExp(`(?<![a-z0-9])${words.map(escapeRe).join("[^a-z0-9+#]*")}(?![a-z0-9])`, "g");
  const out: [number, number][] = [];
  for (const m of ctx.lined.matchAll(re)) {
    out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    if (out.length >= max) break;
  }
  return out;
}

/** The heading closest above `pos` (null when no heading precedes it). */
export function sectionAt(ctx: TextCtx, pos: number): Heading | null {
  let found: Heading | null = null;
  for (const h of ctx.headings) {
    if (h.pos > pos) break;
    found = h.section;
  }
  return found;
}

/** Can this occurrence count for section `s`? Only a trustworthy heading for a DIFFERENT section says no. */
function eligible(ctx: TextCtx, span: [number, number], s: QaSection): boolean {
  if (!ctx.confident) return true;
  const at = sectionAt(ctx, span[0]);
  return at === null || at === "unknown" || at === s;
}

const AT_LABEL: Record<Exclude<Heading, "unknown">, string> = {
  skills: "Skills",
  projects: "Projects",
  experience: "Experience",
  other: "a section that doesn't count (education / certifications / summary…)",
};

/** Quote is about the item and is in the resume — else dropped with a note. */
export function checkQuotes(def: QaItemDef, q: SectionQuotes | undefined, ctx: TextCtx | null, checks: string[]): SectionQuotes {
  const out: SectionQuotes = { skills: "", projects: "", experience: "" };
  if (!q) return out;
  for (const s of QA_SECTIONS) {
    const quote = q[s];
    if (!quote) continue;
    if (!def.must.every((re) => re.test(quote))) {
      checks.push(`${def.label} / ${SECTION_LABEL[s]}: dropped — quote is not about ${def.label} ("${quote.slice(0, 80)}")`);
      continue;
    }
    if (ctx && !(inText(quote, ctx) && def.must.every((re) => re.test(ctx.lined)))) {
      checks.push(`${def.label} / ${SECTION_LABEL[s]}: dropped — quote not found in the resume ("${quote.slice(0, 80)}")`);
      continue;
    }
    out[s] = quote;
  }
  return out;
}

/** Tie-break when nothing else decides: keep the lowest-scoring section (Skills, then Projects). */
const KEEP_PREFERENCE: Record<QaSection, number> = { skills: 4, projects: 2, experience: 1 };

/**
 * Every credited section gets its own occurrence of its quote, inside that
 * section (when headings are trustworthy). Sections left without one are
 * dropped with a note. Quotes matched only by word coverage have no exact
 * place and are left as they are.
 */
export function distinctPlaces(def: QaItemDef, q: SectionQuotes, ctx: TextCtx, checks: string[]): SectionQuotes {
  const out = { ...q };
  const pool: { s: QaSection; spans: [number, number][] }[] = [];
  for (const s of QA_SECTIONS) {
    if (!q[s]) continue;
    const spans = spansOf(q[s], ctx);
    if (!spans.length) continue; // matched by word coverage only — no exact place to check
    const ok = spans.filter((span) => eligible(ctx, span, s));
    if (!ok.length) {
      const at = sectionAt(ctx, spans[0][0]);
      checks.push(
        `${def.label} / ${SECTION_LABEL[s]}: dropped — "${q[s].slice(0, 60)}" is written under ${at && at !== "unknown" ? AT_LABEL[at] : "another section"}, not ${SECTION_LABEL[s]}`,
      );
      out[s] = "";
      continue;
    }
    pool.push({ s, spans: ok });
  }
  if (pool.length < 2) return out;

  let best = { kept: -1, agree: -1, pref: -1, pick: [] as number[] };
  const pick: number[] = [];
  const chosen: [number, number][] = [];
  const walk = (i: number) => {
    if (i === pool.length) {
      let kept = 0;
      let agree = 0;
      let pref = 0;
      pool.forEach((o, k) => {
        if (pick[k] < 0) return;
        kept++;
        pref += KEEP_PREFERENCE[o.s];
        if (sectionAt(ctx, o.spans[pick[k]][0]) === o.s) agree++;
      });
      if (
        kept > best.kept ||
        (kept === best.kept && agree > best.agree) ||
        (kept === best.kept && agree === best.agree && pref > best.pref)
      ) {
        best = { kept, agree, pref, pick: [...pick] };
      }
      return;
    }
    pick[i] = -1;
    walk(i + 1);
    pool[i].spans.forEach((span, k) => {
      if (chosen.some(([a, b]) => span[0] < b && a < span[1])) return;
      pick[i] = k;
      chosen.push(span);
      walk(i + 1);
      chosen.pop();
    });
  };
  walk(0);

  pool.forEach((o, k) => {
    if (best.pick[k] >= 0) return;
    const kept = pool.filter((_, j) => best.pick[j] >= 0).map((x) => SECTION_LABEL[x.s]);
    checks.push(
      `${def.label} / ${SECTION_LABEL[o.s]}: dropped — "${q[o.s].slice(0, 60)}" is the same mention already counted for ${kept.join(" / ") || "another section"} (the resume says it only once)`,
    );
    out[o.s] = "";
  });
  return out;
}
