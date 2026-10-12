import {
  OTHER_CATEGORY,
  joinList,
  type BenchmarkCandidateInput,
  type BenchmarkDomainProfile,
  type BenchmarkProject,
  type BenchmarkResult,
} from "@/lib/benchmark-types";

/**
 * Benchmark Projects — consolidate every resume's projects in the run's domain
 * into one list per sub-area, merge the same project idea found in several
 * resumes, and render the Markdown export. Pure (no I/O), shared by the results
 * view and the download.
 */

export interface BenchmarkEntry {
  /** The strongest write-up of this project idea. */
  project: BenchmarkProject;
  /** Resumes it was found in (the representative's first). */
  sources: { id: string; label: string }[];
}

export interface BenchmarkGroup {
  category: string;
  entries: BenchmarkEntry[];
}

export interface BenchmarkTotals {
  /** Resumes with a result (ok / invalid / error). */
  screened: number;
  /** Resumes read successfully. */
  read: number;
  /** Read, but with no term of the domain — skipped without a model call. */
  skipped: number;
  /** Resumes with at least one project at the bars. */
  withProjects: number;
  /** Distinct projects after merging. */
  projects: number;
  /** Project mentions before merging. */
  mentions: number;
}

export interface BenchmarkFilters {
  minScore: number;
  minRelevance: number;
  /** Sub-areas to include ([] = all). */
  categories: string[];
}

/**
 * Words that say nothing about WHICH project it is — ignored when matching titles:
 * fillers ("app", "system", "platform") and the adjectives every write-up adds
 * ("distributed", "scalable", "real-time", "AI-powered").
 */
const STOP = new Set(
  (
    "a an the and or of for to in on with using via based by from into app apps application applications system systems " +
    "project projects platform web website site tool tools portal service services online smart simple solution solutions " +
    "management manager mini major minor final year " +
    "distributed scalable scalability high performance real time realtime live secure efficient advanced intelligent " +
    "automated automatic ai powered driven enabled end full stack production grade robust modern cloud native"
  ).split(" "),
);

/** Crude stem so "shortener" / "shortening" / "shorten" and "recommender" / "recommendation" meet. */
function stem(word: string): string {
  let w = word;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  for (const suffix of ["ation", "ing", "ers", "er", "ed", "ion", "ment"]) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.slice(0, 7);
}

function titleTokens(title: string): Set<string> {
  const words = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map(stem);
  return new Set(words);
}

function techTokens(tech: string[]): Set<string> {
  return new Set(tech.map((t) => t.toLowerCase().replace(/[^a-z0-9+#]+/g, "")).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

type MergeKey = { category: string; title: Set<string>; tech: Set<string> };

/**
 * The same project idea in two resumes (very common — students share course and
 * hackathon projects): the same core title words (the sub-area a model filed it
 * under can differ), or, in one sub-area, similar titles built on largely the
 * same stack.
 */
function sameProject(a: MergeKey, b: MergeKey): boolean {
  const t = jaccard(a.title, b.title);
  if (t >= 0.75) return true;
  if (a.category !== b.category) return false;
  return t >= 0.6 || (t >= 0.4 && jaccard(a.tech, b.tech) >= 0.5);
}

/**
 * Every project at or above the quality and domain-match bars (and in the chosen
 * sub-areas, when given), merged across resumes and grouped by sub-area — in the
 * profile's own order, "Other" last; strongest project first.
 */
export function consolidateBenchmarks(
  candidates: BenchmarkCandidateInput[],
  results: Record<string, BenchmarkResult>,
  profile: BenchmarkDomainProfile,
  filters: BenchmarkFilters,
): { groups: BenchmarkGroup[]; totals: BenchmarkTotals } {
  const wanted = filters.categories.length ? new Set(filters.categories) : null;
  const mentions: { p: BenchmarkProject; source: { id: string; label: string } }[] = [];
  let screened = 0;
  let read = 0;
  let skipped = 0;
  let withProjects = 0;
  for (const c of candidates) {
    const r = results[c.id];
    if (!r) continue;
    screened++;
    if (r.status !== "ok") continue;
    read++;
    if (r.skipped) skipped++;
    const kept = r.projects.filter(
      (p) => p.score >= filters.minScore && p.relevance >= filters.minRelevance && (!wanted || wanted.has(p.category)),
    );
    if (kept.length) withProjects++;
    for (const p of kept) mentions.push({ p, source: { id: c.id, label: c.label } });
  }

  // Strongest first, so each merged entry is represented by its best write-up.
  mentions.sort((x, y) => y.p.score - x.p.score || y.p.relevance - x.p.relevance || y.p.architecture.length - x.p.architecture.length);
  const clusters: { key: MergeKey; entry: BenchmarkEntry }[] = [];
  for (const m of mentions) {
    const key = { category: m.p.category, title: titleTokens(m.p.title), tech: techTokens(m.p.techStack) };
    const hit = clusters.find((c) => sameProject(c.key, key));
    if (hit) {
      if (!hit.entry.sources.some((s) => s.id === m.source.id)) hit.entry.sources.push(m.source);
      continue;
    }
    clusters.push({ key, entry: { project: m.p, sources: [m.source] } });
  }

  const byCategory = new Map<string, BenchmarkEntry[]>();
  for (const { entry } of clusters) {
    const list = byCategory.get(entry.project.category) ?? [];
    list.push(entry);
    byCategory.set(entry.project.category, list);
  }
  const order = [...profile.categories, OTHER_CATEGORY];
  const rank = (c: string) => {
    const i = order.indexOf(c);
    return i < 0 ? order.length : i;
  };
  const groups: BenchmarkGroup[] = Array.from(byCategory.entries())
    .map(([category, entries]) => ({
      category,
      entries: entries.sort(
        (a, b) =>
          b.project.score - a.project.score ||
          b.project.relevance - a.project.relevance ||
          b.sources.length - a.sources.length ||
          a.project.title.localeCompare(b.project.title),
      ),
    }))
    .sort((a, b) => rank(a.category) - rank(b.category));

  return {
    groups,
    totals: { screened, read, skipped, withProjects, projects: clusters.length, mentions: mentions.length },
  };
}

// ── Markdown (for Notion) ────────────────────────────────────────────────────

/** One line of inline Markdown: no line breaks, nothing that turns into a heading / quote / emphasis by accident. */
function inline(s: string): string {
  let t = s.replace(/\s+/g, " ").trim().replace(/^[#>]+\s*/, "");
  if ((t.match(/\*/g) ?? []).length >= 2) t = t.replace(/\*/g, "\\*");
  if ((t.match(/_/g) ?? []).length >= 2) t = t.replace(/_/g, "\\_");
  return t.replace(/`/g, "'");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 10)
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** "<sub-area> projects" heading text; the catch-all reads "Other <Domain> projects". */
function groupTitle(category: string, domain: string): string {
  return category === OTHER_CATEGORY ? `Other ${domain}` : category;
}

/**
 * The export, all about the run's domain: a title and summary, the sub-area
 * index, then one section per sub-area with one entry per project — the Project
 * Title as its heading, then Domain, Tech Stack, Core Features & Architecture and
 * Why it hits the 15+ LPA benchmark. Headings, bold labels and nested bullets
 * only, so it pastes / imports cleanly into Notion.
 */
export function buildBenchmarkMarkdown(
  groups: BenchmarkGroup[],
  totals: BenchmarkTotals,
  meta: {
    title: string;
    profile: BenchmarkDomainProfile;
    filters: BenchmarkFilters;
    generatedAt: string;
    showSources: boolean;
  },
): string {
  const { profile, filters } = meta;
  const d = profile.domain;
  const out: string[] = [];
  const projectWord = (n: number) => `${n} project${n === 1 ? "" : "s"}`;

  out.push(`# ${inline(meta.title || `Benchmark ${d} Projects for 15+ LPA Roles`)}`, "");
  out.push(
    `> **${projectWord(totals.projects)}** in **${inline(d)}**, selected from **${totals.screened} resume${totals.screened === 1 ? "" : "s"}** · quality bar ${filters.minScore}/100 · domain match ${filters.minRelevance}/100 · ${formatDate(meta.generatedAt)}`,
  );
  if (profile.summary) out.push(`> **Domain:** ${inline(profile.summary)}`);
  if (profile.focus) out.push(`> **Focus:** ${inline(profile.focus)}`);
  out.push(
    `> Only complex, production-grade ${inline(d)} projects are included; basic ${inline(d)} work and projects from other domains are excluded. The same project idea found in several resumes is listed once.`,
  );
  if (filters.categories.length) out.push(`> Sub-areas included: ${joinList(filters.categories.map(inline))}.`);
  out.push("");

  // The rubric the projects were judged against — useful on its own when training students.
  const item = (s: string) => `- ${inline(s).replace(/[.;]+$/, "")}`;
  if (profile.advancedSignals.length || profile.basicExamples.length) {
    out.push("## The bar", "");
    if (profile.advancedSignals.length) {
      out.push(`**What 15+ LPA ${inline(d)} work shows**`, "");
      out.push(...profile.advancedSignals.slice(0, 8).map(item), "");
    }
    if (profile.basicExamples.length) {
      out.push(`**What doesn't qualify**`, "");
      out.push(...profile.basicExamples.slice(0, 6).map(item), "");
    }
  }

  if (!groups.length) {
    out.push(`_No ${inline(d)} project in these resumes met the bar._`, "");
    return out.join("\n");
  }

  out.push(`## ${inline(d)} sub-areas`, "");
  for (const g of groups) out.push(`- **${inline(groupTitle(g.category, d))}** — ${projectWord(g.entries.length)}`);
  out.push("", "---", "");

  for (const g of groups) {
    out.push(`## ${inline(groupTitle(g.category, d))} (${g.entries.length})`, "");
    g.entries.forEach((e, i) => {
      const p = e.project;
      // The heading is the Project Title.
      out.push(`### ${i + 1}. ${inline(p.title)}`, "");
      out.push(`- **Domain:** ${inline(d)} → ${inline(groupTitle(p.category, d))}`);
      out.push(`- **Tech Stack:** ${p.techStack.length ? p.techStack.map(inline).join(", ") : "—"}`);
      out.push("- **Core Features & Architecture:**");
      for (const a of p.architecture) out.push(`  - ${inline(a)}`);
      out.push(`- **Why it hits the 15+ LPA benchmark:** ${inline(p.whyBenchmark)}`);
      out.push(
        `- **Benchmark score:** ${p.score}/100 · domain match ${p.relevance}/100${e.sources.length > 1 ? ` · found in ${e.sources.length} resumes` : ""}`,
      );
      if (meta.showSources) out.push(`- **Source resumes:** ${e.sources.map((s) => inline(s.label)).join(", ")}`);
      out.push("");
    });
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** "benchmark-<domain>-projects-<YYYY-MM-DD>.md" — the download's date, in IST like the document. */
export function benchmarkFileName(domain: string, date: Date = new Date()): string {
  const slug =
    (domain || "domain")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "domain";
  const day = date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return `benchmark-${slug}-projects-${day}.md`;
}
