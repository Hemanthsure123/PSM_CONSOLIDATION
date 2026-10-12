"use server";

import { htmlToPdf } from "@/lib/pdf";
import { buildProjectsReportHtml, type ProjectCardInput } from "@/lib/projects-template";
import { storePdf } from "@/lib/report-storage";
import { fetchResumeBytes } from "@/lib/resume";
import { collectResumeUrls } from "@/lib/resume-links";
import { slugify } from "@/lib/utils";
import { extractProjectsFromResume } from "@/actions/llm";
import type {
  ActionResult,
  CandidateProject,
  ProjectPriorities,
  ProjectsReportResult,
  ProjectSourceRow,
} from "@/lib/types";

/**
 * A project must clear BOTH bars to be shortlistable. The brief decides what is
 * relevant; the quality bar keeps tutorial-grade work out of the report even
 * when it matches the brief perfectly.
 */
const MIN_RELEVANCE = 55;
const MIN_QUALITY = 55;

/**
 * Priority bonuses (points added to a project's merit score).
 *
 * Merit (relevance+quality) is on a 0-100 scale and stays the dominant signal —
 * these bonuses are calibrated so that among genuinely good projects the ones
 * carrying proof (a live demo, a public repo, a placed author) rise to the top,
 * WITHOUT letting a mediocre project leapfrog a markedly stronger one. A working
 * live demo is the strongest signal for a business audience, so it weighs most.
 */
const BOOST_LIVE = 15;
const BOOST_GITHUB = 10;
const BOOST_PLACED = 12;

function isUrl(v: string): boolean {
  return /^https?:\/\//i.test((v ?? "").trim());
}

/** Base merit — relevance leads, quality breaks ties and punishes toy work. */
function meritScore(p: { relevance: number; quality: number }): number {
  return p.relevance * 0.6 + p.quality * 0.4;
}

/** Merit + the bonuses for whichever prioritised attributes this project has. */
function rankScore(p: CandidateProject, pr: ProjectPriorities): number {
  let s = meritScore(p);
  if (pr.live && isUrl(p.live)) s += BOOST_LIVE;
  if (pr.github && isUrl(p.github)) s += BOOST_GITHUB;
  if (pr.placed && p.placedCompany.trim()) s += BOOST_PLACED;
  return s;
}

/**
 * Strict mode keeps only projects that carry every enabled LINK proof. Placement
 * is never a strict requirement (it's candidate-level and would gut the list);
 * it only ever boosts ordering.
 */
function passesStrict(p: CandidateProject, pr: ProjectPriorities): boolean {
  if (!pr.strict) return true;
  if (pr.live && !isUrl(p.live)) return false;
  if (pr.github && !isUrl(p.github)) return false;
  return true;
}

/**
 * Read ONE candidate's resume and return the projects that clear the bars for
 * `brief`. Called per row by the client so the UI can show progress and a single
 * slow resume can't take the whole run down.
 */
export async function extractCandidateProjects(
  row: ProjectSourceRow,
  brief: string,
): Promise<ActionResult<CandidateProject[]>> {
  if (!brief.trim()) return { ok: false, error: "Describe the projects you want before running." };
  if (!/^https?:\/\//i.test((row.resumeUrl ?? "").trim())) {
    return { ok: false, error: "No resume link in the sheet." };
  }

  const resume = await fetchResumeBytes(row.resumeUrl);
  if (!resume) {
    return {
      ok: false,
      error:
        "Couldn't download the resume from the sheet link. Ensure the file is " +
        "shared with the service account (or publicly viewable).",
    };
  }

  // Ground the model's links in URLs that genuinely exist in the document —
  // including ones hidden behind a project title or an icon.
  const knownUrls = await collectResumeUrls(resume);

  const res = await extractProjectsFromResume(resume, brief, knownUrls);
  if (!res.ok) return res;

  const projects: CandidateProject[] = res.data
    .filter((p) => p.relevance >= MIN_RELEVANCE && p.quality >= MIN_QUALITY)
    .map((p) => ({
      ...p,
      candidateId: row.id,
      candidate: row.candidate || "Candidate",
      resumeUrl: row.resumeUrl,
      placedCompany: (row.placedCompany ?? "").trim(),
      ctc: (row.ctc ?? "").trim(),
    }));

  return { ok: true, data: projects };
}

/**
 * Rank every collected project, keep the best `topN`, render the consolidation
 * report and store it (Drive, falling back to a local file).
 *
 * At most 2 projects per candidate reach the shortlist so a single strong resume
 * cannot monopolise a "top 10" — the report is meant to survey the pool.
 */
export async function buildProjectsReport(
  projects: CandidateProject[],
  opts: {
    brief: string;
    topN: number;
    /** Label for the report (the run name). */
    runName: string;
    resumesScanned: number;
    /**
     * Show candidate names + resume links. Off when the report is shared
     * outside the team — a resume carries the candidate's phone and email.
     */
    showCandidates: boolean;
    priorities: ProjectPriorities;
  },
): Promise<ActionResult<ProjectsReportResult>> {
  const { brief, topN, runName, resumesScanned, showCandidates, priorities } = opts;
  const considered = projects.length;

  // Strict mode is the hard cut: drop projects missing a required link.
  const eligible = projects.filter((p) => passesStrict(p, priorities));
  const droppedByStrict = considered - eligible.length;

  const perCandidate = new Map<string, number>();
  const ranked = eligible
    .sort((a, b) => rankScore(b, priorities) - rankScore(a, priorities))
    .filter((p) => {
      const used = perCandidate.get(p.candidateId) ?? 0;
      if (used >= 2) return false;
      perCandidate.set(p.candidateId, used + 1);
      return true;
    })
    .slice(0, Math.max(1, topN));

  const cards: ProjectCardInput[] = ranked.map((p, i) => ({
    rank: i + 1,
    title: p.title,
    description: p.description,
    tech: p.tech,
    candidate: p.candidate,
    github: p.github,
    live: p.live,
    resumeUrl: p.resumeUrl,
    placedCompany: p.placedCompany,
    ctc: p.ctc,
  }));

  try {
    const html = buildProjectsReportHtml({
      runName,
      resumesScanned,
      projectsConsidered: considered,
      projects: cards,
      showCandidates,
    });
    // Multi-page: a top-10 will not fit on one A4 and must not be clipped.
    const pdf = await htmlToPdf(html, { singlePage: false });
    const fileName = `Projects-${slugify(runName || "shortlist")}-top${cards.length}.pdf`;
    const stored = await storePdf(pdf, fileName);
    return {
      ok: true,
      data: {
        link: stored.link,
        storage: stored.storage,
        shortlisted: cards.length,
        considered,
        droppedByStrict,
      },
    };
  } catch (err) {
    console.error("[buildProjectsReport] error:", err);
    const message = err instanceof Error ? err.message : "Unknown error.";
    return { ok: false, error: `Projects report failed: ${message}` };
  }
}
