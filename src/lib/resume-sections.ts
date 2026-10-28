/**
 * Domain evidence comes only from PROJECTS, EXPERIENCE (internships, jobs), CERTIFICATIONS
 * and ACHIEVEMENTS. A Skills list and a profile summary / objective are claims, not
 * evidence — so they are taken out of the resume text that Domain Shortlisting's judgement
 * and its checks read (with coursework, interests and languages, which aren't evidence
 * either). Pure and client-safe; tested in scripts/resume-sections-selftest.ts.
 *
 * Sections are found by their headings on their own lines. A removed section runs until the
 * next recognised heading. When the layout can't be trusted — two headings on consecutive
 * lines (side-by-side columns read row by row) or a "section" that would swallow most of
 * the resume — only the labelled skill lines ("Skills: React, Node") are removed.
 */

export type DroppedSection = "Skills" | "Summary" | "Coursework" | "Interests" | "Languages";

export interface EvidenceText {
  /** The resume without its Skills / Summary / Coursework / Interests / Languages sections. */
  text: string;
  /** Which sections were taken out (empty = nothing found to remove). */
  removed: DroppedSection[];
  /** Section headings could be trusted, so whole sections were removed (not just labelled lines). */
  trusted: boolean;
}

/** "& Awards", "/ Relevant Coursework", "& Co-Curriculars" — one or more joined words after a heading. */
const JOIN = String.raw`(?:\s*(?:&|and|/|,|\+)\s*[a-z][a-z \-]*)*`;

const DROP: [DroppedSection, RegExp][] = [
  [
    "Skills",
    // Bare "Tools" / "Technologies" / "Tech stack" are left out: inside a project they label its stack.
    new RegExp(
      String.raw`^(?:technical |key |core |professional |it |relevant |software |soft |hard |programming |computer |personal )?(?:skills?|skill set|skillset|skills summary|core competenc(?:y|ies)|competenc(?:y|ies)|technical proficienc(?:y|ies)|technical expertise|areas? of expertise|tools (?:&|and) technologies|technologies (?:&|and) tools|technical stack)${JOIN}$`,
    ),
  ],
  [
    "Summary",
    new RegExp(
      String.raw`^(?:professional |career |profile |executive |personal )?(?:summary|objective|profile|about me)${JOIN}$`,
    ),
  ],
  ["Coursework", /^(?:relevant |related |key )?(?:course ?work|courses|subjects)(?: taken| studied)?$/],
  ["Interests", /^(?:interests|hobbies|hobbies (?:&|and) interests|areas? of interest)$/],
  ["Languages", /^languages(?: known| spoken)?$/],
];

/** Headings that START a section we keep — they end a removed one. */
const KEEP = new RegExp(
  String.raw`^(?:(?:academic |personal |key |major |minor |mini |main |final year |selected |technical |college |capstone |notable |other |relevant |software |web |freelance |team )?projects?(?: work| details| undertaken| highlights| experience)?|(?:(?:work|professional|internship|industry|industrial|relevant|research) )?(?:experience|experiences)|internships?(?: experience)?|employment(?: history)?|work history|career history|education(?:al)?(?: details| qualifications?| background)?|academic (?:details|qualifications?|background|profile|achievements)|qualifications?|certifications?(?: (?:&|and) (?:courses|trainings?|achievements))?|certificates|licenses? (?:&|and) certifications|trainings?|achievements?|accomplishments|awards?(?: (?:&|and) (?:honou?rs|achievements|recognitions?))?|honou?rs|recognitions?|publications?|research(?: work| papers?)?|hackathons?|competitions|open[ -]?source(?: contributions?)?|contributions|positions? of responsibility|leadership(?: experience)?|extra[ -]?curricular(?: activities)?|co[ -]?curricular(?: activities)?|volunteer(?:ing| experience| work)?|declaration|personal (?:details|information)|contact(?: details| info(?:rmation)?)?|references|strengths|links|profiles|coding profiles|online profiles)${JOIN}$`,
);

/** "Skills: React, Node" / "Technical Skills - Java" — a labelled skills line outside projects and experience. */
const SKILL_LABEL = /^\s*(?:[•\-*·▪●◦]\s*)?(?:technical |key |core |soft |programming |relevant )?skills?(?: set)?\s*[:\-–—|]/i;

/** A line's heading key: lower case, no leading icons / bullets / numbering, no trailing colon. */
function headingKey(line: string): string {
  return line
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[^a-z]+/, "")
    .replace(/[\s:.\-–—|]+$/, "")
    .replace(/\s+/g, " ");
}

type Kind = DroppedSection | "keep" | null;

function kindOf(line: string): Kind {
  const key = headingKey(line);
  if (!key || key.length > 48) return null;
  for (const [name, re] of DROP) if (re.test(key)) return name;
  return KEEP.test(key) ? "keep" : null;
}

/** Projects / experience — a labelled "Skills:" line there describes the work, so it stays. */
const WORK_SECTION = /^(?:.*projects?.*|.*experience.*|internships?.*|employment.*|work history|career history|open[ -]?source.*|contributions|hackathons?)$/;

export function evidenceText(resume: string): EvidenceText {
  const lines = (resume ?? "").split(/\r?\n/);
  const kinds = lines.map(kindOf);

  // Side-by-side columns read row by row put two headings on consecutive lines.
  const headingIdx = kinds.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
  const sideBySide = headingIdx.some((i, k) => k > 0 && i === headingIdx[k - 1] + 1 && kinds[i] !== kinds[headingIdx[k - 1]]);

  const keepLines: string[] = [];
  const removed = new Set<DroppedSection>();
  let dropping: DroppedSection | null = null;
  let inWork = false;
  let droppedChars = 0;
  const total = Math.max(1, resume.length);

  lines.forEach((line, i) => {
    // Inside projects / experience a bare "Summary" / "Objective" line is the item's own sub-heading.
    const kind = inWork && kinds[i] === "Summary" ? null : kinds[i];
    if (kind) {
      if (kind === "keep") {
        dropping = null;
        inWork = WORK_SECTION.test(headingKey(line));
        keepLines.push(line);
      } else {
        dropping = kind;
        inWork = false;
        removed.add(kind);
        droppedChars += line.length + 1;
      }
      return;
    }
    if (dropping) {
      droppedChars += line.length + 1;
      return;
    }
    if (!inWork && SKILL_LABEL.test(line)) {
      removed.add("Skills");
      droppedChars += line.length + 1;
      return;
    }
    keepLines.push(line);
  });

  // Untrusted layout, or a "section" that would take most of the resume: remove only labelled lines.
  if (sideBySide || droppedChars / total > 0.45) {
    const labelled = lines.filter((l) => SKILL_LABEL.test(l));
    return {
      text: lines.filter((l) => !SKILL_LABEL.test(l)).join("\n"),
      removed: labelled.length ? ["Skills"] : [],
      trusted: false,
    };
  }
  return { text: keepLines.join("\n"), removed: [...removed], trusted: true };
}
