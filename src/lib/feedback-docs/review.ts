import "server-only";
import { SchemaType, type Schema } from "@google/generative-ai";
import { readJdSource } from "@/lib/jd-source";
import { runLlmChain } from "@/lib/llm-router";
import { loose } from "@/lib/qa-verify";
import { fetchResume } from "@/lib/resume";
import { OCR_READER_VERSION, readJudgement, readResumeCache, sha256, writeJudgement, writeResumeCache } from "@/lib/resume-cache";
import { contentFromBytes, DOC_LABEL, type DocType, looksLikeResume, transcribeDocument, visionTiers } from "@/lib/resume-content";
import { collectResumeUrls } from "@/lib/resume-links";
import { evidenceText, workText } from "@/lib/resume-sections";
import type { CoreShown, JobReview, ResumeReview } from "@/lib/feedback-docs/model";
import { alternativeGroup, jobSkills, skillInText, skillShown, termInText, withoutShownAlternatives } from "@/lib/feedback-docs/skills";

/**
 * Candidate feedback documents (PSM 1.13.0) — reading and reviewing the resumes a candidate used.
 *
 * Each distinct resume is downloaded once (a scan or photo is first identified and transcribed only
 * when it really is a resume), and one model call reviews it against every job it was used for: the
 * job's 1–3 core skills (taken only from the job's tech stack / description), where the resume shows
 * them, fit, a same-field internship, generic project points, spelling. Nothing the model says is used
 * unchecked:
 *  - a core skill must come from the job's own tech stack or description;
 *  - "shown in a project" needs the skill (or a quote that is really in the projects / experience
 *    text); "not shown" needs the skill to be nowhere in the resume text — when the model and the text
 *    disagree and its quote can't be found, the skill is left out ("unverified"), never reported;
 *  - generic points and spelling issues need their example to be in the text;
 *  - links are read from the file itself (link annotations and text), not by the model.
 * Verified results are cached per resume content and job (automation.judgement_cache), so another
 * period, a rebuild or another mentor never pays for the same review twice.
 */

const DEFAULT_CHAIN =
  "gemini:gemini-3-flash-preview,gemini:gemini-2.5-flash,gemini:gemini-3.5-flash,openai:gpt-5.4-mini,openai:gpt-5.5,mistral:ministral-14b-latest";
export const feedbackChain = () => process.env.FEEDBACK_LLM_CHAIN?.trim() || DEFAULT_CHAIN;

/** Bump when the prompt, the schema or the checks change (cached reviews are then redone). */
const REVIEW_VERSION = "fb-review-v1";
const MAX_RESUME_CHARS = 14_000;
const MAX_JD_CHARS = 2_500;
const CONCURRENCY = 3;

export interface JobToReview {
  key: string;
  company: string;
  role: string;
  techStack: string;
  jdUrl: string | null;
}

interface LoadedResume {
  url: string;
  ok: boolean;
  /**
   * Why not: "unavailable" — it couldn't be downloaded (a busy host, an expired or private link: not the
   * candidate's doing, never told to them); otherwise what the file is ("a photograph, not a resume",
   * "a scan that couldn't be read").
   */
  problem: string | null;
  unavailable: boolean;
  text: string;
  /** Without the Skills list and summary (where a skill being written at all is checked loosely). */
  evidence: string;
  /** Projects and work only, when the headings can be trusted ("used in a project" is checked here). */
  work: string;
  workTrusted: boolean;
  textHash: string;
  urls: string[];
  /** Link annotations could be read (PDF): no links found means none. */
  linksKnown: boolean;
}


/** Transcribe a scan / image once per file content (shared with Domain Shortlisting's cache). */
async function transcribeOnce(bytes: Buffer, inline: { mimeType: string; data: string }): Promise<{ ok: true; type: DocType; description: string; text: string } | { ok: false; error: string }> {
  const hash = sha256(bytes);
  const hit = await readResumeCache<{ type: DocType; description: string; text: string; model: string }>(hash, "ocr", OCR_READER_VERSION);
  if (hit?.type) return { ok: true, type: hit.type, description: hit.description, text: hit.text };
  const doc = await transcribeDocument(inline, { chain: visionTiers(feedbackChain()), label: "feedback-resume", timeoutMs: 90_000 });
  if (!doc.ok) return doc;
  await writeResumeCache(hash, "ocr", OCR_READER_VERSION, { type: doc.type, description: doc.description, text: doc.text, model: doc.model }, bytes.length);
  return { ok: true, type: doc.type, description: doc.description, text: doc.text };
}

/** A resume's text, its projects / experience part and its links — or why it can't be read. */
export async function loadResume(url: string): Promise<LoadedResume> {
  const fail = (problem: string, unavailable = false): LoadedResume => ({
    url,
    ok: false,
    problem,
    unavailable,
    text: "",
    evidence: "",
    work: "",
    workTrusted: false,
    textHash: "",
    urls: [],
    linksKnown: false,
  });
  // A busy file host (429 / 5xx / network) is tried again twice, after 2 and 6 seconds.
  let fetched = await fetchResume(url);
  for (const wait of [2_000, 6_000]) {
    if (fetched.ok || !fetched.transient) break;
    await new Promise((r) => setTimeout(r, wait));
    fetched = await fetchResume(url);
  }
  if (!fetched.ok) return fail("unavailable", true);
  const content = await contentFromBytes(fetched.bytes).catch(() => "unreadable");
  if (typeof content === "string") return fail(/docx|\.doc|word/i.test(content) ? "a Word file that can't be read" : "the file can't be read");
  let text = content.text;
  if (!looksLikeResume(text)) {
    if (!content.inline) return fail("it has no readable text");
    const t = await transcribeOnce(fetched.bytes.data, content.inline);
    if (!t.ok) return fail("it is a scan that couldn't be read");
    if (t.type !== "resume") return fail(DOC_LABEL[t.type as Exclude<DocType, "resume">] ?? "not a resume");
    text = t.text;
  }
  text = text.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  let urls: string[] = [];
  try {
    urls = await collectResumeUrls(fetched.bytes);
  } catch {
    urls = [];
  }
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s)>\]]+|\bgithub\.com\/[\w.-]+/gi)) urls.push(m[0]);
  const work = workText(text);
  return {
    url,
    ok: true,
    problem: null,
    unavailable: false,
    text,
    evidence: evidenceText(text).text,
    work: work.text,
    workTrusted: work.trusted,
    textHash: sha256(text),
    urls: [...new Set(urls)],
    // A Word file's hidden hyperlinks aren't read: "no links" is only said of PDFs or links written out.
    linksKnown: content.source === "pdf" || urls.length > 0,
  };
}

const PROFILE_ONLY = /linkedin\.com|mailto:|tel:|leetcode\.com|codechef\.com|codeforces\.com|hackerrank\.com|geeksforgeeks\.org|gmail\.com|instagram\.com|facebook\.com|twitter\.com|\bx\.com|wa\.me|credly\.com|coursera\.org|udemy\.com|nptel|naukri\.com/i;

/** No GitHub link and no other project link (profiles and contact links don't count). */
export const hasNoProjectLinks = (urls: string[]) => !urls.some((u) => /github\.com\/[\w.-]+/i.test(u)) && !urls.some((u) => !PROFILE_ONLY.test(u));

// ── JD text (best effort) ───────────────────────────────────────────────────

const g = globalThis as unknown as { __fbJd?: Map<string, { at: number; text: string | null }> };
const jdCache = (g.__fbJd ??= new Map());

async function jdText(url: string | null): Promise<string | null> {
  if (!url) return null;
  const hit = jdCache.get(url);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.text;
  let text: string | null = null;
  try {
    const f = await Promise.race([fetchResume(url), new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
    if (f && f.ok) {
      const src = await readJdSource({ text: "", file: { name: "jd", type: f.bytes.mimeType, data: f.bytes.data } });
      if (src.ok && src.text.trim().length >= 80) text = src.text.replace(/\s+/g, " ").trim().slice(0, MAX_JD_CHARS);
    }
  } catch {
    text = null;
  }
  jdCache.set(url, { at: Date.now(), text });
  return text;
}

// ── The model call ──────────────────────────────────────────────────────────

const SYSTEM = `You review ONE candidate's resume against the jobs they applied to with it, for a feedback document the candidate will read. Report only what the resume text shows. Never invent or guess anything, and never use outside knowledge about the candidate.

For each job (use its id):
- coreSkills: the 1 to 3 skills the job cannot do without, chosen ONLY from that job's tech stack and job description given below. Put the job's own words for the skill in "terms" (group alternatives such as AWS / Azure / GCP into one skill with all of them in "terms"). Soft skills, years of study and marks never count. When the job lists nothing technical, give [].
- For each core skill, "shown": "in_projects" when a project, internship or job in the resume uses it; "listed_only" when it appears only in a skills list, summary, coursework or certificate list; "not_shown" when the resume doesn't mention it at all. "quote": the exact words from the resume that show it, copied character for character (at most 160 characters); "" when not_shown.
- fit: how well the resume as a whole matches the role, 1 (a different field) to 5 (a strong match).
- fitNote: only when fit is 1 or 2: at most 8 plain words naming the mismatch the way a mentor would say it, for example "data profile, not frontend". Otherwise "".
- sameFieldInternship: true when the resume has an internship or a job in the job's field, else false. internshipQuote: its exact words, or "".

For the resume as a whole:
- isResume: false when the text is not a resume.
- genericProjectBullets: true when most project points only say what was built, without the tools, the scale or the result (like "Developed a website using React"). genericExample: one such point copied exactly, else "".
- spellingOrFormatIssues: true only for clear misspellings or broken text a reader would notice. spellingExamples: up to 3 exact words or short phrases as they are written in the resume.`;

const SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    isResume: { type: SchemaType.BOOLEAN },
    genericProjectBullets: { type: SchemaType.BOOLEAN },
    genericExample: { type: SchemaType.STRING },
    spellingOrFormatIssues: { type: SchemaType.BOOLEAN },
    spellingExamples: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    jobs: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id: { type: SchemaType.STRING },
          coreSkills: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                skill: { type: SchemaType.STRING },
                terms: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                shown: { type: SchemaType.STRING, format: "enum", enum: ["in_projects", "listed_only", "not_shown"] },
                quote: { type: SchemaType.STRING },
              },
              required: ["skill", "terms", "shown", "quote"],
            },
          },
          fit: { type: SchemaType.INTEGER },
          fitNote: { type: SchemaType.STRING },
          sameFieldInternship: { type: SchemaType.BOOLEAN },
          internshipQuote: { type: SchemaType.STRING },
        },
        required: ["id", "coreSkills", "fit", "fitNote", "sameFieldInternship", "internshipQuote"],
      },
    },
  },
  required: ["isResume", "genericProjectBullets", "genericExample", "spellingOrFormatIssues", "spellingExamples", "jobs"],
};

const SHAPE_HINT =
  'Answer with JSON only: {"isResume":true,"genericProjectBullets":false,"genericExample":"","spellingOrFormatIssues":false,"spellingExamples":[],"jobs":[{"id":"J1","coreSkills":[{"skill":"SQL","terms":["SQL"],"shown":"in_projects","quote":"..."}],"fit":4,"fitNote":"","sameFieldInternship":true,"internshipQuote":"..."}]}';

interface RawJob {
  id?: unknown;
  coreSkills?: { skill?: unknown; terms?: unknown; shown?: unknown; quote?: unknown }[];
  fit?: unknown;
  fitNote?: unknown;
  sameFieldInternship?: unknown;
  internshipQuote?: unknown;
}

interface RawReview {
  isResume?: unknown;
  genericProjectBullets?: unknown;
  genericExample?: unknown;
  spellingOrFormatIssues?: unknown;
  spellingExamples?: unknown;
  jobs?: RawJob[];
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The job's tech stack and description, for grounding the model's core skills. */
const groundText = (j: JobToReview, jd: string | null) => `${j.techStack}\n${jd ?? ""}`;

/** Names of a core skill to search for: the model's terms plus their usual names. */
function expand(terms: string[]): string[] {
  const out = new Set<string>();
  for (const t of terms) for (const s of jobSkills(t)) for (const x of s.terms) out.add(x);
  return [...out];
}

/**
 * A quote the model gave, checked strictly: at least 12 letters long, found word for word in [text]
 * (spacing and punctuation aside), and naming one of [names].
 */
export function quoteShows(quote: string, text: string, names: string[]): boolean {
  const q = loose(quote);
  return q.length >= 12 && loose(text).includes(q) && names.some((n) => termInText(n, quote));
}

/** "AWS or Azure or GCP" → "AWS, Azure or GCP". */
const orList = (xs: string[]) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

type ResumeText = Pick<LoadedResume, "text" | "evidence" | "work" | "workTrusted">;

/** Where the resume shows a skill: "used in a project" is checked on projects / work only when that part can be told apart. */
function shownIn(names: string[], r: ResumeText) {
  return skillShown({ terms: names }, r.text, r.workTrusted ? r.work : r.evidence);
}

/** The model's review of one job, checked against the resume text (see the module comment). */
export function verifyJob(raw: RawJob | undefined, job: JobToReview, jd: string | null, resume: ResumeText): JobReview {
  if (!raw) return fallbackJob(job, resume);
  const ground = groundText(job, jd);
  const core: JobReview["core"] = [];
  const coreTerms = new Set<string>();
  // Where the resume shows each listed skill (for alternatives: React in a project covers "Angular").
  const listed = jobSkills(job.techStack)
    .filter((s) => s.checkable)
    .map((s) => ({ skill: s, where: shownIn(s.terms, resume) }));
  const viaAlternative = (names: string[]) => {
    const g = alternativeGroup(names);
    if (g < 0) return null;
    const hits = listed.filter((x) => alternativeGroup(x.skill.terms) === g && x.where !== "not_shown").map((x) => x.where);
    return hits.includes("in_projects") ? "in_projects" : hits.length ? "listed_only" : null;
  };
  for (const c of (raw?.coreSkills ?? []).slice(0, 3)) {
    const terms = (Array.isArray(c.terms) ? c.terms : [])
      .map((t) => str(t, 60))
      .filter((t) => t && termInText(t, ground));
    if (!terms.length) continue; // not from this job's own requirements
    // The name printed is the verified terms' own (the model's label could add skills it never showed).
    const said0 = str(c.skill, 40);
    const label = said0 && terms.every((t) => termInText(t, said0)) && !/[&,]/.test(said0) ? said0 : orList(terms);
    const names = expand(terms);
    let det = shownIn(names, resume);
    const alt = det === "in_projects" ? null : viaAlternative(names);
    if (alt === "in_projects" || (alt === "listed_only" && det === "not_shown")) det = alt;
    const quote = str(c.quote, 200);
    const said = c.shown === "in_projects" || c.shown === "listed_only" || c.shown === "not_shown" ? c.shown : "not_shown";
    const workText_ = resume.workTrusted ? resume.work : resume.evidence;
    let shown: CoreShown;
    if (det === "in_projects" || (said === "in_projects" && quoteShows(quote, workText_, names))) shown = "in_projects";
    else if (det === "listed_only" || (said === "listed_only" && quoteShows(quote, resume.text, names))) shown = "listed_only";
    else if (said === "not_shown") shown = "not_shown";
    else shown = "unverified";
    core.push({ skill: label, shown });
    for (const n of names) coreTerms.add(n);
  }
  // The rest of the listed tech stack: only technologies, only where the text settles it, and not a
  // skill whose alternative the resume shows (AWS shown: Azure isn't "missing").
  const rest = (keep: "not_shown" | "listed_only") =>
    withoutShownAlternatives(listed, keep)
      .filter((s) => !s.terms.some((t) => coreTerms.has(t)))
      .map((s) => s.label);
  const mustNotShown = rest("not_shown");
  const listedOnly = rest("listed_only");
  const fitN = typeof raw?.fit === "number" && Number.isFinite(raw.fit) ? Math.min(5, Math.max(1, Math.round(raw.fit))) : null;
  let fitNote = fitN !== null && fitN <= 2 ? str(raw?.fitNote, 60).replace(/["“”.]+/g, "").trim() : "";
  if (fitNote.split(/\s+/).length > 8) fitNote = "";
  if (fitNote) fitNote = fitNote[0].toLowerCase() + fitNote.slice(1);
  // "No internship in the same field" is only said when the resume has no internship or job at all;
  // whether another internship is "the same field" is a judgement the document doesn't make.
  const anyWork = /\b(intern(ship)?s?|trainee|apprentice(ship)?|employment|worked (at|as|with)|full[- ]time|part[- ]time)\b/i.test(resume.text);
  const same: boolean | null = raw.sameFieldInternship === false && !anyWork ? false : null;
  // "… in your projects matched the role": only skills found in the projects / work part itself.
  const shownSkills = resume.workTrusted ? core.filter((c) => c.shown === "in_projects" && skillInText({ terms: expand([c.skill, ...c.skill.split(/,| or /)]) }, resume.work)).map((c) => c.skill) : [];
  return { core, mustNotShown: mustNotShown.slice(0, 5), listedOnly: listedOnly.slice(0, 5), shownSkills, fit: fitN, fitNote, sameFieldInternship: same, fallback: false };
}

/**
 * Without the model: the listed tech stack read against the text. Up to 3 technologies are the core
 * skills; with more, the core gap is only reported when most of them are nowhere in the resume.
 */
export function fallbackJob(job: JobToReview, resume: ResumeText): JobReview {
  const skills = jobSkills(job.techStack).filter((s) => s.checkable);
  const where = skills.map((s) => ({ skill: s, where: shownIn(s.terms, resume) }));
  const missing = withoutShownAlternatives(where, "not_shown");
  const onlyListed = withoutShownAlternatives(where, "listed_only");
  const shownOf = (s: (typeof skills)[number]) => where.find((x) => x.skill === s)!.where;
  let core: JobReview["core"] = [];
  if (skills.length && skills.length <= 3) core = skills.filter((s) => shownOf(s) === "in_projects" || missing.includes(s) || onlyListed.includes(s)).map((s) => ({ skill: s.label, shown: shownOf(s) }));
  else if (missing.length * 2 > where.length) core = missing.map((s) => ({ skill: s.label, shown: "not_shown" as const }));
  const inCore = new Set(core.map((c) => c.skill));
  return {
    core,
    mustNotShown: missing.filter((s) => !inCore.has(s.label)).map((s) => s.label).slice(0, 5),
    listedOnly: onlyListed.filter((s) => !inCore.has(s.label)).map((s) => s.label).slice(0, 5),
    shownSkills: resume.workTrusted ? core.filter((c) => c.shown === "in_projects").map((c) => c.skill) : [],
    fit: null,
    fitNote: "",
    sameFieldInternship: null,
    fallback: true,
  };
}

interface ResumeLevel {
  isResume: boolean;
  genericBullets: boolean | null;
  spellingIssues: boolean | null;
}

function verifyResumeLevel(raw: RawReview, resume: ResumeText): ResumeLevel {
  const example = str(raw.genericExample, 300);
  const generic =
    raw.genericProjectBullets === true
      ? example && loose(example).length >= 12 && loose(resume.workTrusted ? resume.work : resume.evidence).includes(loose(example))
        ? true
        : null
      : raw.genericProjectBullets === false
        ? false
        : null;
  const lower = resume.text.toLowerCase();
  const found = (Array.isArray(raw.spellingExamples) ? raw.spellingExamples : [])
    .map((e) => str(e, 60))
    .filter((e) => e.length >= 3 && lower.includes(e.toLowerCase()));
  const spelling = raw.spellingOrFormatIssues === true ? (found.length ? true : null) : raw.spellingOrFormatIssues === false ? false : null;
  // "Not a resume" from the model only counts when the text doesn't read like one either.
  return { isResume: raw.isResume !== false || looksLikeResume(resume.text), genericBullets: generic, spellingIssues: spelling };
}

const jobKeyHash = (resumeHash: string, j: JobToReview, jd: string | null) =>
  `fb:job:${sha256(JSON.stringify([REVIEW_VERSION, resumeHash, j.company.toLowerCase(), j.role.toLowerCase(), j.techStack.toLowerCase(), jd ? sha256(jd) : ""])).slice(0, 48)}`;
const resumeKeyHash = (resumeHash: string) => `fb:resume:${sha256(JSON.stringify([REVIEW_VERSION, resumeHash])).slice(0, 48)}`;

export interface ReviewOutcome {
  review: ResumeReview;
  model: string | null;
  cached: number;
  called: boolean;
}

/** Reviews one resume against its jobs (cached results first; one model call for the rest). */
export async function reviewResume(resume: LoadedResume, label: string, jobs: JobToReview[]): Promise<ReviewOutcome> {
  if (!resume.ok) {
    return {
      review: { url: resume.url, label, readable: false, unavailable: resume.unavailable, problem: resume.unavailable ? null : resume.problem, noLinks: null, genericBullets: null, spellingIssues: null, jobs: new Map() },
      model: null,
      cached: 0,
      called: false,
    };
  }
  const jds = new Map<string, string | null>();
  await Promise.all(jobs.map(async (j) => jds.set(j.key, await jdText(j.jdUrl))));
  const out = new Map<string, JobReview>();
  let cached = 0;
  const todo: JobToReview[] = [];
  for (const j of jobs) {
    const hit = await readJudgement<JobReview>(jobKeyHash(resume.textHash, j, jds.get(j.key) ?? null));
    if (hit?.data && Array.isArray(hit.data.core)) {
      out.set(j.key, hit.data);
      cached++;
    } else todo.push(j);
  }
  const levelHit = await readJudgement<ResumeLevel>(resumeKeyHash(resume.textHash));
  let level: ResumeLevel | null = levelHit?.data && typeof levelHit.data.isResume === "boolean" ? levelHit.data : null;
  let model: string | null = levelHit?.scoredBy ?? null;
  let called = false;

  if (todo.length || !level) {
    const ask = todo.length ? todo : jobs.slice(0, 1);
    const ids = new Map(ask.map((j, i) => [`J${i + 1}`, j]));
    const jobLines = [...ids.entries()]
      .map(([id, j]) => `[${id}] ${j.company} · ${j.role}\nTech stack: ${j.techStack || "(not given)"}\nJob description: ${jds.get(j.key) ?? "(not available)"}`)
      .join("\n\n");
    const res = await runLlmChain({
      label: "feedback-review",
      chain: feedbackChain(),
      system: SYSTEM,
      schema: SCHEMA,
      shapeHint: SHAPE_HINT,
      temperature: 0.1,
      // Low thinking: a long think used up the answer's tokens and cut the JSON short.
      thinking: "low",
      maxOutputTokens: 12_000,
      timeoutMs: 120_000,
      // Every job asked about must be answered (ids compared without case), or another model is tried.
      accept: (j) => {
        const r = j as RawReview;
        if (typeof r.isResume !== "boolean" || !Array.isArray(r.jobs)) return false;
        const got = new Set(r.jobs.map((x) => str(x?.id, 10).toUpperCase()));
        return [...ids.keys()].every((id) => got.has(id));
      },
      build: (_tier, budget) => {
        const text = `JOBS:\n${jobLines}\n\n=== RESUME TEXT ===\n${resume.text.slice(0, Math.min(MAX_RESUME_CHARS, Math.max(4000, budget - jobLines.length - 500)))}`;
        return { geminiParts: text, text };
      },
    });
    called = true;
    if (res.ok) {
      const raw = res.json as RawReview;
      model = `${res.provider}/${res.model}`;
      const verifiedLevel = verifyResumeLevel(raw, resume);
      if (!level) {
        level = verifiedLevel;
        await writeJudgement(resumeKeyHash(resume.textHash), model, level);
      }
      for (const [id, j] of ids) {
        if (!todo.includes(j)) continue;
        const answer = raw.jobs?.find((x) => str(x.id, 10).toUpperCase() === id);
        const jr = verifyJob(answer, j, jds.get(j.key) ?? null, resume);
        out.set(j.key, jr);
        // A job the model didn't answer is checked from the tech stack this time and never cached.
        if (answer) await writeJudgement(jobKeyHash(resume.textHash, j, jds.get(j.key) ?? null), model, jr);
      }
    } else {
      console.warn("[feedback] resume review unavailable, tech-stack check only:", res.error.slice(0, 200));
    }
  }
  for (const j of jobs) if (!out.has(j.key)) out.set(j.key, fallbackJob(j, resume));
  if (level && !level.isResume) {
    return { review: { url: resume.url, label, readable: false, unavailable: false, problem: "not a resume", noLinks: null, genericBullets: null, spellingIssues: null, jobs: new Map() }, model, cached, called };
  }
  return {
    review: {
      url: resume.url,
      label,
      readable: true,
      unavailable: false,
      problem: null,
      noLinks: resume.linksKnown ? hasNoProjectLinks(resume.urls) : null,
      genericBullets: level?.genericBullets ?? null,
      spellingIssues: level?.spellingIssues ?? null,
      jobs: out,
    },
    model,
    cached,
    called,
  };
}

/**
 * Reads and reviews every resume (at most CONCURRENCY at a time). [onProgress] reports "n of m".
 * Resumes with the same text under different links are reviewed once; `canonical` maps each link to
 * the first link with that text.
 */
export async function reviewResumes(
  items: { url: string; label: string; jobs: JobToReview[] }[],
  onProgress: (done: number, total: number) => Promise<void> | void,
): Promise<{ reviews: Map<string, ResumeReview>; canonical: Map<string, string>; models: string[]; cached: number; calls: number }> {
  const loaded = new Map<string, LoadedResume>();
  let done = 0;
  const queue = [...items];
  const work = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      loaded.set(
        it.url,
        await loadResume(it.url).catch(() => ({ url: it!.url, ok: false, problem: "unavailable", unavailable: true, text: "", evidence: "", work: "", workTrusted: false, textHash: "", urls: [], linksKnown: false })),
      );
      done++;
      await onProgress(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, work));

  // Same text under different links: one review, the first link stands for the others.
  const canonical = new Map<string, string>();
  const byHash = new Map<string, { url: string; label: string; jobs: JobToReview[] }>();
  for (const it of items) {
    const r = loaded.get(it.url)!;
    const key = r.ok ? r.textHash : `url:${it.url}`;
    const first = byHash.get(key);
    if (first) {
      canonical.set(it.url, first.url);
      for (const j of it.jobs) if (!first.jobs.some((x) => x.key === j.key)) first.jobs.push(j);
    } else {
      byHash.set(key, { url: it.url, label: it.label, jobs: [...it.jobs] });
      canonical.set(it.url, it.url);
    }
  }
  const reviews = new Map<string, ResumeReview>();
  const models = new Set<string>();
  let cached = 0;
  let calls = 0;
  const groups = [...byHash.values()];
  const runQueue = [...groups];
  const review = async () => {
    for (let gi = runQueue.shift(); gi; gi = runQueue.shift()) {
      const r = await reviewResume(loaded.get(gi.url)!, gi.label, gi.jobs);
      reviews.set(gi.url, r.review);
      if (r.model) models.add(r.model);
      cached += r.cached;
      if (r.called) calls++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, review));
  return { reviews, canonical, models: [...models], cached, calls };
}
