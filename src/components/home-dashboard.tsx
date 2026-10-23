"use client";

import * as React from "react";
import {
  Award,
  BarChart3,
  Briefcase,
  Building2,
  ClipboardCheck,
  Code2,
  FileCode2,
  FileSpreadsheet,
  GraduationCap,
  Layers,
  LayoutDashboard,
  Plus,
  Send,
  Sparkles,
  Star,
  Target,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Stat } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { DonutChart, Legend, SERIES, SERIES_NEUTRAL, type Slice } from "@/components/charts";
import { CompanyDetail } from "@/components/company-detail";
import { AnalysisView } from "@/components/sheet-analyzer/analysis-view";
import { DsaResultsView } from "@/components/dsa-consolidation/dsa-results-view";
import { bucketLabel } from "@/lib/source-track";
import { listCompanies, deleteCompany } from "@/lib/company-store";
import { listAnalyses, deleteAnalysis } from "@/lib/analysis-store";
import { listDsaRuns, deleteDsaRun } from "@/lib/dsa-store";
import { listAssignmentRuns, deleteAssignmentRun } from "@/lib/assignment-store";
import { listExperienceRuns, deleteExperienceRun } from "@/lib/experience-store";
import type { ExperienceRun } from "@/lib/experience-types";
import { listQaRuns, deleteQaRun } from "@/lib/qa-store";
import { listZgRuns, deleteZgRun } from "@/lib/zaggle/store";
import type { ZgRunMeta } from "@/lib/zaggle/types";
import type { QaRunMeta } from "@/lib/qa-types";
import { listBenchmarkRuns, deleteBenchmarkRun } from "@/lib/benchmark-store";
import { listBucketingRuns, deleteBucketingRun } from "@/lib/bucketing-store";
import { BUCKET_LABEL, BUCKETS } from "@/lib/bucketing/config";
import type { BucketingRunMeta } from "@/lib/bucketing/types";
import { listAcRuns, deleteAcRun } from "@/lib/academy/store";
import { AC_BUCKETS, AC_BUCKET_LABEL, type AcRunMeta } from "@/lib/academy/types";
import { listSpRuns, deleteSpRun } from "@/lib/showcase/store";
import type { SpRunMeta } from "@/lib/showcase/types";
import type { BenchmarkRunMeta } from "@/lib/benchmark-types";
import { bandLabel } from "@/lib/assignment-scoring";
import type { AssignmentRun } from "@/lib/assignment-types";
import { TRACK_BUCKETS, type SheetAnalysis } from "@/lib/company-sheet";
import type { DsaAnalysis } from "@/lib/dsa-types";
import type { BucketCount, CompanySummary } from "@/lib/types";

interface HomeDashboardProps {
  onNew: () => void;
  onAnalyze: () => void;
  onDsa: () => void;
  onProjects: () => void;
  onDomain: () => void;
  /** Open Assignment Evaluation — a saved run by id, or a new one. */
  onAssignment: (runId?: string) => void;
  /** Open Experience Analysis — a saved run by id, or a new one. */
  onExperience: (runId?: string) => void;
  /** Open QA Resume Screening — a saved run by id, or a new one. */
  onQa: (runId?: string) => void;
  /** Open the Zaggle (ZagMoney) SDE 1 screening — a saved run by id, or a new one. */
  onZaggle: (runId?: string) => void;
  /** Open Benchmark Projects — a saved run by id, or a new one. */
  onBenchmarks: (runId?: string) => void;
  /** Open Candidate Bucketing — a saved run by id, or a new one. */
  onBucketing: (runId?: string) => void;
  /** Open Academy bucketing — a saved run by id, or a new one. */
  onAcademy: (runId?: string) => void;
  /** Open Sample profiles — a saved run by id, or a new one. */
  onShowcase: (runId?: string) => void;
}

/**
 * Chart colour per source — a fixed series slot, so the same source always has the same colour
 * (never chosen by rank). "Not tracked" is the neutral.
 */
const SOURCE_COLOR: Record<string, string> = {
  edge: SERIES[0],
  academy: SERIES[1],
  external: SERIES[2],
  untracked: SERIES_NEUTRAL,
};

function toSlices(buckets: BucketCount[]): Slice[] {
  return buckets.map((b) => ({ label: bucketLabel(b.bucket), value: b.count, color: SOURCE_COLOR[b.bucket] }));
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The dashboard shows one category of saved work at a time. */
type DashTab = "companies" | "screenings" | "evaluations" | "analyses";

const TABS: { id: DashTab; label: string }[] = [
  { id: "companies", label: "Companies" },
  { id: "screenings", label: "Screenings" },
  { id: "evaluations", label: "Evaluations" },
  { id: "analyses", label: "Analyses & benchmarks" },
];

export function HomeDashboard({
  onNew,
  onAnalyze,
  onDsa,
  onDomain,
  onAssignment,
  onExperience,
  onQa,
  onZaggle,
  onBenchmarks,
  onBucketing,
  onAcademy,
  onShowcase,
}: HomeDashboardProps) {
  const [companies, setCompanies] = React.useState<CompanySummary[]>([]);
  const [analyses, setAnalyses] = React.useState<SheetAnalysis[]>([]);
  const [dsaRuns, setDsaRuns] = React.useState<DsaAnalysis[]>([]);
  const [assignmentRuns, setAssignmentRuns] = React.useState<AssignmentRun[]>([]);
  const [experienceRuns, setExperienceRuns] = React.useState<ExperienceRun[]>([]);
  // QA screening runs live in IndexedDB (too big for localStorage) — loaded async.
  const [qaRuns, setQaRuns] = React.useState<QaRunMeta[]>([]);
  // Zaggle SDE 1 screening runs live in IndexedDB too.
  const [zgRuns, setZgRuns] = React.useState<ZgRunMeta[]>([]);
  // Benchmark-projects runs also live in IndexedDB.
  const [benchmarkRuns, setBenchmarkRuns] = React.useState<BenchmarkRunMeta[]>([]);
  // Candidate-bucketing runs also live in IndexedDB.
  const [bucketingRuns, setBucketingRuns] = React.useState<BucketingRunMeta[]>([]);
  // Academy bucketing runs also live in IndexedDB.
  const [academyRuns, setAcademyRuns] = React.useState<AcRunMeta[]>([]);
  // Sample profiles runs also live in IndexedDB.
  const [showcaseRuns, setShowcaseRuns] = React.useState<SpRunMeta[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [openAnalysisId, setOpenAnalysisId] = React.useState<string | null>(null);
  const [openDsaId, setOpenDsaId] = React.useState<string | null>(null);
  // UI only: the tab the user picked (null = the first tab that has saved work). Lives here so it
  // survives opening and closing a company / analysis / DSA run.
  const [tab, setTab] = React.useState<DashTab | null>(null);

  React.useEffect(() => {
    setCompanies(listCompanies());
    setAnalyses(listAnalyses());
    setDsaRuns(listDsaRuns());
    setAssignmentRuns(listAssignmentRuns());
    setExperienceRuns(listExperienceRuns());
    void listQaRuns().then(setQaRuns);
    void listZgRuns().then(setZgRuns);
    void listBenchmarkRuns().then(setBenchmarkRuns);
    void listBucketingRuns().then(setBucketingRuns);
    void listAcRuns().then(setAcademyRuns);
    void listSpRuns().then(setShowcaseRuns);
  }, []);

  const remove = (id: string) => {
    deleteCompany(id);
    setCompanies(listCompanies());
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const removeAnalysis = (id: string) => {
    deleteAnalysis(id);
    setAnalyses(listAnalyses());
    setOpenAnalysisId((cur) => (cur === id ? null : cur));
  };

  const removeDsa = (id: string) => {
    deleteDsaRun(id);
    setDsaRuns(listDsaRuns());
    setOpenDsaId((cur) => (cur === id ? null : cur));
  };

  const removeZg = (id: string) => {
    void deleteZgRun(id)
      .catch((err) => console.warn("[dashboard] could not delete Zaggle run:", err))
      .then(() => listZgRuns())
      .then(setZgRuns);
  };

  const removeQa = (id: string) => {
    void deleteQaRun(id)
      .catch((err) => console.warn("[dashboard] could not delete QA run:", err))
      .then(() => listQaRuns())
      .then(setQaRuns);
  };

  const removeBenchmark = (id: string) => {
    void deleteBenchmarkRun(id)
      .catch((err) => console.warn("[dashboard] could not delete benchmark run:", err))
      .then(() => listBenchmarkRuns())
      .then(setBenchmarkRuns);
  };

  const removeBucketing = (id: string) => {
    void deleteBucketingRun(id)
      .catch((err) => console.warn("[dashboard] could not delete bucketing run:", err))
      .then(() => listBucketingRuns())
      .then(setBucketingRuns);
  };

  const removeAcademy = (id: string) => {
    void deleteAcRun(id)
      .catch((err) => console.warn("[dashboard] could not delete Academy bucketing run:", err))
      .then(() => listAcRuns())
      .then(setAcademyRuns);
  };

  const removeShowcase = (id: string) => {
    void deleteSpRun(id)
      .catch((err) => console.warn("[dashboard] could not delete Sample profiles run:", err))
      .then(() => listSpRuns())
      .then(setShowcaseRuns);
  };

  const removeExperience = (id: string) => {
    deleteExperienceRun(id);
    setExperienceRuns(listExperienceRuns());
  };

  const removeAssignment = (id: string) => {
    deleteAssignmentRun(id);
    setAssignmentRuns(listAssignmentRuns());
  };

  // Aggregate across every saved company.
  const agg = React.useMemo(() => {
    const counts: Record<string, number> = { edge: 0, academy: 0, external: 0 };
    let total = 0;
    let reports = 0;
    for (const c of companies) {
      total += c.total;
      reports += c.reportsGenerated;
      for (const b of c.buckets) counts[b.bucket] += b.count;
    }
    const buckets: BucketCount[] = [
      { bucket: "edge", count: counts.edge },
      { bucket: "academy", count: counts.academy },
      { bucket: "external", count: counts.external },
    ];
    return { total, reports, buckets };
  }, [companies]);

  // Drill into a single company's candidate-level source funnel.
  const selected = companies.find((c) => c.id === selectedId) ?? null;
  if (selected) {
    return <CompanyDetail company={selected} onBack={() => setSelectedId(null)} />;
  }

  // Drill into a saved company-sheet funnel analysis.
  const openAnalysis = analyses.find((a) => a.id === openAnalysisId) ?? null;
  if (openAnalysis) {
    return <AnalysisView analysis={openAnalysis} onBack={() => setOpenAnalysisId(null)} backLabel="Back to dashboard" />;
  }

  // Drill into a saved DSA consolidation run.
  const openDsa = dsaRuns.find((d) => d.id === openDsaId) ?? null;
  if (openDsa) {
    return (
      <DsaResultsView
        results={openDsa.results}
        title={openDsa.name}
        subtitle={`${openDsa.sheetTitle} · ${openDsa.subsheets.join(", ")}`}
        onBack={() => setOpenDsaId(null)}
        backLabel="Back to dashboard"
      />
    );
  }

  // Nothing saved anywhere yet: offer the three most common starting points.
  if (
    companies.length === 0 &&
    analyses.length === 0 &&
    dsaRuns.length === 0 &&
    assignmentRuns.length === 0 &&
    experienceRuns.length === 0 &&
    qaRuns.length === 0 &&
    zgRuns.length === 0 &&
    benchmarkRuns.length === 0 &&
    bucketingRuns.length === 0 &&
    academyRuns.length === 0 &&
    showcaseRuns.length === 0
  ) {
    return (
      <EmptyState
        icon={<LayoutDashboard />}
        title="Nothing saved yet"
        description="Company sheets you build and the runs you save from every tool appear here. Start with one of these, or pick any tool from the sidebar."
        action={
          <>
            <Button onClick={onNew}>
              <FileSpreadsheet /> Build company sheet
            </Button>
            <Button variant="outline" onClick={onDomain}>
              <Target /> Domain shortlisting
            </Button>
            <Button variant="outline" onClick={onAnalyze}>
              <BarChart3 /> Analyze company sheet
            </Button>
          </>
        }
      />
    );
  }

  const counts: Record<DashTab, number> = {
    companies: companies.length + showcaseRuns.length,
    screenings: qaRuns.length + zgRuns.length + bucketingRuns.length + academyRuns.length,
    evaluations: assignmentRuns.length + experienceRuns.length + dsaRuns.length,
    analyses: analyses.length + benchmarkRuns.length,
  };
  const activeTab: DashTab = tab ?? TABS.find((t) => counts[t.id] > 0)?.id ?? "companies";

  return (
    <div>
      <TabList
        label="Saved work"
        tabs={TABS.map((t) => ({ ...t, count: counts[t.id] }))}
        active={activeTab}
        onSelect={setTab}
      />

      <div
        role="tabpanel"
        id={`dashboard-panel-${activeTab}`}
        aria-labelledby={`dashboard-tab-${activeTab}`}
        className="space-y-10 pt-6"
      >
        {activeTab === "companies" ? (
          <>
            {companies.length > 0 ? (
              // Combined totals and source split across every saved company.
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-6">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-1 lg:grid-rows-3">
                  <Stat icon={<Building2 />} label="Companies" value={companies.length} />
                  <Stat icon={<Send />} label="Candidates sent" value={agg.total} />
                  <Stat icon={<Sparkles />} label="Reports generated" value={agg.reports} />
                </div>
                <Panel title="Source split" description="Candidates sent from each source, across all companies.">
                  <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
                    <DonutChart data={toSlices(agg.buckets)} total={agg.total} />
                    <div className="w-full min-w-0 flex-1 sm:max-w-sm">
                      <Legend data={toSlices(agg.buckets)} total={agg.total} />
                    </div>
                  </div>
                </Panel>
              </div>
            ) : null}

            <RunGroup
              icon={<FileSpreadsheet />}
              title="Company sheets"
              count={companies.length}
              newLabel="Build company sheet"
              onNew={onNew}
              emptyText="No company sheets saved yet."
            >
              {companies.map((c) => (
                <CompanyCard key={c.id} company={c} onDelete={() => remove(c.id)} onOpen={() => setSelectedId(c.id)} />
              ))}
            </RunGroup>

            {/* Saved Sample profiles runs — click to reopen / continue / reload the sheet / download. */}
            <RunGroup
              icon={<Star />}
              title="Sample profiles"
              count={showcaseRuns.length}
              newLabel="New sample profiles"
              onNew={() => onShowcase()}
              emptyText="No sample-profile runs saved yet."
            >
              {showcaseRuns.map((r) => (
                <ShowcaseCard key={r.id} run={r} onDelete={() => removeShowcase(r.id)} onOpen={() => onShowcase(r.id)} />
              ))}
            </RunGroup>
          </>
        ) : null}

        {activeTab === "screenings" ? (
          <>
            {/* Saved QA screening runs — click to reopen / resume / add a batch / export. */}
            <RunGroup
              icon={<ClipboardCheck />}
              title="QA screenings"
              count={qaRuns.length}
              newLabel="New QA screening"
              onNew={() => onQa()}
              emptyText="No QA screenings saved yet."
            >
              {qaRuns.map((r) => (
                <QaCard key={r.id} run={r} onDelete={() => removeQa(r.id)} onOpen={() => onQa(r.id)} />
              ))}
            </RunGroup>

            {/* Saved Zaggle SDE 1 screening runs — click to reopen / resume / add a batch / export. */}
            <RunGroup
              icon={<Building2 />}
              title="Zaggle SDE 1 screenings"
              count={zgRuns.length}
              newLabel="New Zaggle screening"
              onNew={() => onZaggle()}
              emptyText="No Zaggle SDE 1 screenings saved yet."
            >
              {zgRuns.map((r) => (
                <ZgCard key={r.id} run={r} onDelete={() => removeZg(r.id)} onOpen={() => onZaggle(r.id)} />
              ))}
            </RunGroup>

            {/* Saved candidate-bucketing runs — click to reopen / resume / add a batch / export. */}
            <RunGroup
              icon={<Layers />}
              title="Candidate bucketing"
              count={bucketingRuns.length}
              newLabel="New bucketing run"
              onNew={() => onBucketing()}
              emptyText="No bucketing runs saved yet."
            >
              {bucketingRuns.map((r) => (
                <BucketingCard key={r.id} run={r} onDelete={() => removeBucketing(r.id)} onOpen={() => onBucketing(r.id)} />
              ))}
            </RunGroup>

            {/* Saved Academy bucketing runs — click to reopen / resume / reload the sheets / export. */}
            <RunGroup
              icon={<GraduationCap />}
              title="Academy bucketing"
              count={academyRuns.length}
              newLabel="New academy bucketing"
              onNew={() => onAcademy()}
              emptyText="No academy bucketing runs saved yet."
            >
              {academyRuns.map((r) => (
                <AcademyCard key={r.id} run={r} onDelete={() => removeAcademy(r.id)} onOpen={() => onAcademy(r.id)} />
              ))}
            </RunGroup>
          </>
        ) : null}

        {activeTab === "evaluations" ? (
          <>
            {/* Saved assignment evaluation runs — click to reopen / resume / export. */}
            <RunGroup
              icon={<FileCode2 />}
              title="Assignment evaluations"
              count={assignmentRuns.length}
              newLabel="New assignment evaluation"
              onNew={() => onAssignment()}
              emptyText="No assignment evaluations saved yet."
            >
              {assignmentRuns.map((r) => (
                <AssignmentCard key={r.id} run={r} onDelete={() => removeAssignment(r.id)} onOpen={() => onAssignment(r.id)} />
              ))}
            </RunGroup>

            {/* Saved experience analyses — click to reopen / resume / export. */}
            <RunGroup
              icon={<Briefcase />}
              title="Experience analyses"
              count={experienceRuns.length}
              newLabel="New experience analysis"
              onNew={() => onExperience()}
              emptyText="No experience analyses saved yet."
            >
              {experienceRuns.map((r) => (
                <ExperienceCard key={r.id} run={r} onDelete={() => removeExperience(r.id)} onOpen={() => onExperience(r.id)} />
              ))}
            </RunGroup>

            {/* Saved DSA consolidation runs. */}
            <RunGroup
              icon={<Code2 />}
              title="DSA consolidations"
              count={dsaRuns.length}
              newLabel="New DSA consolidation"
              onNew={onDsa}
              emptyText="No DSA consolidations saved yet."
            >
              {dsaRuns.map((d) => (
                <DsaCard key={d.id} run={d} onDelete={() => removeDsa(d.id)} onOpen={() => setOpenDsaId(d.id)} />
              ))}
            </RunGroup>
          </>
        ) : null}

        {activeTab === "analyses" ? (
          <>
            {/* Saved company-sheet funnel analyses. */}
            <RunGroup
              icon={<BarChart3 />}
              title="Company sheet funnels"
              count={analyses.length}
              newLabel="Analyze company sheet"
              onNew={onAnalyze}
              emptyText="No company sheet analyses saved yet."
            >
              {analyses.map((a) => (
                <AnalysisCard key={a.id} analysis={a} onDelete={() => removeAnalysis(a.id)} onOpen={() => setOpenAnalysisId(a.id)} />
              ))}
            </RunGroup>

            {/* Saved benchmark-projects runs — click to reopen / resume / add resumes / export. */}
            <RunGroup
              icon={<Award />}
              title="Benchmark projects"
              count={benchmarkRuns.length}
              newLabel="New benchmark run"
              onNew={() => onBenchmarks()}
              emptyText="No benchmark project runs saved yet."
            >
              {benchmarkRuns.map((r) => (
                <BenchmarkCard key={r.id} run={r} onDelete={() => removeBenchmark(r.id)} onOpen={() => onBenchmarks(r.id)} />
              ))}
            </RunGroup>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ───────────────────────────── Layout pieces ───────────────────────────── */

/** An accessible tab list (arrow keys, Home and End move between tabs). */
function TabList({
  label,
  tabs,
  active,
  onSelect,
}: {
  label: string;
  tabs: { id: DashTab; label: string; count: number }[];
  active: DashTab;
  onSelect: (id: DashTab) => void;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onSelect(tabs[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b">
      {tabs.map((t, i) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`dashboard-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`dashboard-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md border-b-2 px-3 pb-2.5 pt-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-primary/25",
              selected
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            {t.label}
            <span
              className={cn(
                "rounded-md px-1.5 text-xs font-medium leading-5 tabular-nums",
                selected ? "bg-accent text-accent-foreground" : "bg-secondary text-muted-foreground",
              )}
            >
              {t.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** One kind of saved run: a heading with its count and "New …" action, then a grid of cards. */
function RunGroup({
  icon,
  title,
  count,
  newLabel,
  onNew,
  emptyText,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  newLabel: string;
  onNew: () => void;
  emptyText: string;
  children: React.ReactNode;
}) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="flex items-center gap-2 font-display text-[16px] font-semibold leading-6 tracking-[-0.01em]">
          <span className="flex text-muted-foreground [&_svg]:size-4" aria-hidden>
            {icon}
          </span>
          {title}
          <span className="rounded-md bg-secondary px-1.5 font-sans text-xs font-medium leading-5 tracking-normal text-muted-foreground tabular-nums">
            {count}
          </span>
        </h2>
        <Button variant="ghost" size="sm" onClick={onNew} className="-mr-2">
          <Plus /> {newLabel}
        </Button>
      </div>
      {count === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/60 px-4 py-6 text-center text-[13px] text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
      )}
    </section>
  );
}

interface Metric {
  label: string;
  value: React.ReactNode;
  /** Marks the shortlist count with the highlighter. */
  highlight?: boolean;
}

/** "12" with a quiet "/40" after it. */
function OfTotal({ n, total }: { n: number; total: number }) {
  return (
    <>
      {n}
      <span className="text-xs font-normal text-muted-foreground">/{total}</span>
    </>
  );
}

/**
 * The shared card for every saved run: title, date line, a few key numbers and status badges.
 * The title is the real button (its hit area stretches over the whole card); delete sits above it.
 */
function RunCard({
  title,
  meta,
  openHint,
  onOpen,
  deleteLabel,
  onDelete,
  metrics,
  badges,
  children,
}: {
  title: string;
  meta: string;
  openHint: string;
  onOpen: () => void;
  deleteLabel: string;
  onDelete: () => void;
  metrics: Metric[];
  badges?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <article className="relative flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 shadow-surface transition-[border-color,box-shadow] duration-150 hover:border-[hsl(218_20%_78%)] hover:shadow-raised">
      <div className="min-w-0 pr-8">
        <h3 className="font-display text-[15px] font-semibold leading-snug tracking-[-0.01em]">
          <button
            type="button"
            onClick={onOpen}
            title={openHint}
            className="break-words text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-[3px] focus-visible:after:ring-primary/25"
          >
            {title}
          </button>
        </h3>
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{meta}</p>
      </div>

      <dl className="grid items-end gap-3" style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}>
        {metrics.map((m) => (
          <div key={m.label} className="min-w-0">
            <dt className="break-words text-xs leading-4 text-muted-foreground">{m.label}</dt>
            <dd className="mt-0.5 text-[15px] font-semibold leading-6 tabular-nums">
              {m.highlight ? <span className="rounded-[4px] bg-highlight px-1 text-highlight-foreground">{m.value}</span> : m.value}
            </dd>
          </div>
        ))}
      </dl>

      {children}

      {badges ? <div className="flex flex-wrap gap-1.5">{badges}</div> : null}

      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={deleteLabel}
        title="Remove from dashboard"
        className="absolute right-2 top-2 z-10 h-8 w-8 hover:bg-destructive-soft hover:text-destructive"
      >
        <Trash2 />
      </Button>
    </article>
  );
}

/** A slim part-to-whole bar of a source split, with a legend that carries the values. */
function SplitBar({ data, total }: { data: Slice[]; total: number }) {
  const shown = data.filter((d) => d.value > 0);
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-secondary" aria-hidden>
        {total > 0
          ? shown.map((d) => <span key={d.label} className="h-full" style={{ flexGrow: d.value, flexBasis: 0, background: d.color }} />)
          : null}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {data.map((d) => (
          <li key={d.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: d.color }} aria-hidden />
            {d.label}
            <span className="font-medium text-foreground tabular-nums">{d.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────────────────────── One card per run type ───────────────────────────── */

function CompanyCard({
  company,
  onDelete,
  onOpen,
}: {
  company: CompanySummary;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const slices = toSlices(company.buckets);
  return (
    <RunCard
      title={company.sheetName}
      meta={`${formatDate(company.createdAt)}${company.subsheets.length > 1 ? ` · ${plural(company.subsheets.length, "subsheet", "subsheets")}` : ""}`}
      openHint="View candidate-level source funnel"
      onOpen={onOpen}
      deleteLabel="Delete company"
      onDelete={onDelete}
      metrics={[
        { label: "Sent", value: company.total },
        { label: "Matched", value: company.matched },
        { label: "Reports", value: company.reportsGenerated },
      ]}
    >
      <SplitBar data={slices} total={company.total} />
    </RunCard>
  );
}

function AnalysisCard({
  analysis,
  onDelete,
  onOpen,
}: {
  analysis: SheetAnalysis;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const slices: Slice[] = TRACK_BUCKETS.map((b) => ({
    label: b.label,
    value: analysis.company[b.id],
    color: SOURCE_COLOR[b.id],
  }));
  return (
    <RunCard
      title={analysis.companyName}
      meta={`${formatDate(analysis.createdAt)} · ${plural(analysis.roundColumns.length, "round", "rounds")}`}
      openHint="View source & round funnel"
      onOpen={onOpen}
      deleteLabel="Delete analysis"
      onDelete={onDelete}
      metrics={[
        { label: "Sent", value: analysis.total },
        { label: "Tracked", value: analysis.total - analysis.company.untracked },
        { label: "Not tracked", value: analysis.company.untracked },
      ]}
    >
      <SplitBar data={slices} total={analysis.total} />
    </RunCard>
  );
}

function BucketingCard({ run, onDelete, onOpen }: { run: BucketingRunMeta; onDelete: () => void; onOpen: () => void }) {
  const total = run.candidates.length;
  const inProgress = run.stats.evaluated < total;
  const bucketed = BUCKETS.filter((b) => run.stats.byBucket[b]);
  return (
    <RunCard
      title={run.name}
      meta={`${formatDate(run.updatedAt)} · ${plural(run.batches.length, "batch", "batches")}`}
      openHint={inProgress ? "Open to resume the run" : "Open the buckets"}
      onOpen={onOpen}
      deleteLabel="Delete bucketing run"
      onDelete={onDelete}
      metrics={[
        { label: "Evaluated", value: <OfTotal n={run.stats.evaluated} total={total} /> },
        { label: "Bucketed", value: run.stats.bucketed },
        { label: "Not bucketed", value: run.stats.notBucketed },
      ]}
      badges={
        bucketed.length || run.stats.retry || inProgress ? (
          <>
            {bucketed.map((b) => (
              <Badge key={b} variant="outline">
                {BUCKET_LABEL[b]} <span className="tabular-nums">{run.stats.byBucket[b]}</span>
              </Badge>
            ))}
            {run.stats.retry ? <Badge variant="destructive">{run.stats.retry} re-run</Badge> : null}
            {inProgress ? <Badge>In progress</Badge> : null}
          </>
        ) : null
      }
    />
  );
}

function AcademyCard({ run, onDelete, onOpen }: { run: AcRunMeta; onDelete: () => void; onOpen: () => void }) {
  const s = run.stats;
  const inProgress = s.toRead > 0;
  const filled = AC_BUCKETS.filter((b) => s.byPlacement[b]);
  return (
    <RunCard
      title={run.name}
      meta={`${formatDate(run.updatedAt)} · ${run.sheetTitle || "sheet 1"} · sheets read ${formatDate(run.loadedAt)}`}
      openHint={inProgress ? "Open to resume the run" : "Open the buckets"}
      onOpen={onOpen}
      deleteLabel="Delete Academy bucketing run"
      onDelete={onDelete}
      metrics={[
        { label: "In scope", value: s.inScope },
        { label: "Mixed", value: s.byPlacement.mixed, highlight: true },
        { label: "Needs evidence", value: s.needsEvidence },
      ]}
      badges={
        filled.length || s.errors || s.unreadable || inProgress ? (
          <>
            {filled.map((b) => (
              <Badge key={b} variant="outline">
                {AC_BUCKET_LABEL[b]} <span className="tabular-nums">{s.byPlacement[b]}</span>
              </Badge>
            ))}
            {s.errors ? <Badge variant="destructive">{s.errors} re-run</Badge> : null}
            {s.unreadable ? <Badge variant="warning">{s.unreadable} resumes unreadable</Badge> : null}
            {inProgress ? <Badge>In progress</Badge> : null}
          </>
        ) : null
      }
    />
  );
}

function ShowcaseCard({ run, onDelete, onOpen }: { run: SpRunMeta; onDelete: () => void; onOpen: () => void }) {
  const s = run.stats;
  const inProgress = (s.pending ?? 0) > 0;
  return (
    <RunCard
      title={run.name}
      meta={`${formatDate(run.updatedAt)} · ${run.sheetTitle || "sheet"} · ${plural(s.rows, "row", "rows")} · sheet read ${formatDate(run.loadedAt)}`}
      openHint={inProgress ? "Open to continue the run" : "Open the sample profiles"}
      onOpen={onOpen}
      deleteLabel="Delete Sample profiles run"
      onDelete={onDelete}
      metrics={[
        { label: "Showcase", value: s.showcase, highlight: true },
        { label: "Strong", value: s.strong },
        { label: "Roles", value: s.roles },
      ]}
      badges={
        <>
          <Badge variant="outline">
            DSA bar cleared <span className="tabular-nums">{s.dsaPassed}</span>
          </Badge>
          {s.nearMiss ? <Badge variant="warning">{s.nearMiss} near misses</Badge> : null}
          {inProgress ? <Badge>In progress · {s.pending} pending</Badge> : null}
        </>
      }
    />
  );
}

function ZgCard({ run, onDelete, onOpen }: { run: ZgRunMeta; onDelete: () => void; onOpen: () => void }) {
  const total = run.candidates.length;
  const inProgress = run.stats.evaluated < total;
  return (
    <RunCard
      title={run.name}
      meta={`${formatDate(run.updatedAt)} · ${plural(run.batches.length, "batch", "batches")} · ${run.rules.minMonths}–${run.rules.maxMonths} months`}
      openHint={inProgress ? "Open to resume the screening" : "Open results"}
      onOpen={onOpen}
      deleteLabel="Delete Zaggle screening"
      onDelete={onDelete}
      metrics={[
        { label: "Screened", value: <OfTotal n={run.stats.evaluated} total={total} /> },
        { label: "Shortlisted", value: run.stats.shortlisted, highlight: true },
        { label: "To review", value: run.stats.review },
      ]}
      badges={
        run.stats.errors || inProgress ? (
          <>
            {run.stats.errors ? <Badge variant="destructive">{run.stats.errors} errors</Badge> : null}
            {inProgress ? <Badge>In progress</Badge> : null}
          </>
        ) : null
      }
    />
  );
}

function QaCard({ run, onDelete, onOpen }: { run: QaRunMeta; onDelete: () => void; onOpen: () => void }) {
  const total = run.candidates.length;
  const inProgress = run.stats.evaluated < total;
  return (
    <RunCard
      title={run.name}
      meta={`${formatDate(run.updatedAt)} · ${plural(run.batches.length, "batch", "batches")} · min score ${run.rules.minScore}%`}
      openHint={inProgress ? "Open to resume the screening" : "Open results"}
      onOpen={onOpen}
      deleteLabel="Delete QA screening"
      onDelete={onDelete}
      metrics={[
        { label: "Screened", value: <OfTotal n={run.stats.evaluated} total={total} /> },
        { label: "Shortlisted", value: run.stats.shortlisted, highlight: true },
        { label: "Borderline", value: run.stats.borderline },
      ]}
      badges={
        run.stats.errors || inProgress ? (
          <>
            {run.stats.errors ? <Badge variant="destructive">{run.stats.errors} errors</Badge> : null}
            {inProgress ? <Badge>In progress</Badge> : null}
          </>
        ) : null
      }
    />
  );
}

function BenchmarkCard({ run, onDelete, onOpen }: { run: BenchmarkRunMeta; onDelete: () => void; onOpen: () => void }) {
  const total = run.candidates.length;
  const inProgress = run.stats.screened < total;
  return (
    <RunCard
      title={run.name}
      meta={`${run.profile?.domain ? `${run.profile.domain} · ` : ""}${formatDate(run.updatedAt)} · ${plural(run.batches.length, "batch", "batches")} · bar ${run.minScore}/100`}
      openHint={inProgress ? "Open to resume the screening" : "Open projects / download the .md"}
      onOpen={onOpen}
      deleteLabel="Delete benchmark projects run"
      onDelete={onDelete}
      metrics={[
        { label: "Screened", value: <OfTotal n={run.stats.screened} total={total} /> },
        { label: `${run.profile?.domain ?? "Benchmark"} projects`, value: run.stats.projects },
      ]}
      badges={
        run.stats.errors || inProgress ? (
          <>
            {run.stats.errors ? <Badge variant="destructive">{run.stats.errors} errors</Badge> : null}
            {inProgress ? <Badge>In progress</Badge> : null}
          </>
        ) : null
      }
    />
  );
}

function ExperienceCard({
  run,
  onDelete,
  onOpen,
}: {
  run: ExperienceRun;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const stats = React.useMemo(() => {
    const results = Object.values(run.results);
    return {
      analysed: results.length,
      withExp: results.filter((r) => r.status === "ok").length,
      entries: results.reduce((n, r) => n + r.entries.length, 0),
    };
  }, [run.results]);
  const inProgress = stats.analysed < run.candidates.length;

  return (
    <RunCard
      title={run.name}
      meta={`${formatDate(run.updatedAt)} · ${run.sheetTitle}${run.subsheets.length ? ` · ${run.subsheets.join(", ")}` : ""}`}
      openHint={inProgress ? "Open to resume the analysis" : "Open results"}
      onOpen={onOpen}
      deleteLabel="Delete experience analysis"
      onDelete={onDelete}
      metrics={[
        { label: "Analysed", value: <OfTotal n={stats.analysed} total={run.candidates.length} /> },
        { label: "With experience", value: stats.withExp },
        { label: "Internships / jobs", value: stats.entries },
      ]}
      badges={inProgress ? <Badge>In progress</Badge> : null}
    />
  );
}

function AssignmentCard({
  run,
  onDelete,
  onOpen,
}: {
  run: AssignmentRun;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const stats = React.useMemo(() => {
    const results = Object.values(run.results);
    return {
      evaluated: results.length,
      shortlisted: results.filter((r) => r.status === "Strongly Shortlisted" || r.status === "Shortlisted").length,
      review: results.filter((r) => r.status === "Borderline – Manual Review" || r.status === "AI Generated – Review Manually").length,
    };
  }, [run.results]);
  const inProgress = stats.evaluated < run.candidates.length;

  return (
    <RunCard
      title={run.name}
      meta={`${formatDate(run.updatedAt)}${run.config.company ? ` · ${run.config.company}` : ""} · ${bandLabel(run.config.ctcBand)}`}
      openHint={inProgress ? "Open to resume the evaluation" : "Open results"}
      onOpen={onOpen}
      deleteLabel="Delete assignment run"
      onDelete={onDelete}
      metrics={[
        { label: "Evaluated", value: <OfTotal n={stats.evaluated} total={run.candidates.length} /> },
        { label: "Shortlisted", value: stats.shortlisted, highlight: true },
        { label: "To review", value: stats.review },
      ]}
      badges={inProgress ? <Badge>In progress</Badge> : null}
    />
  );
}

function DsaCard({
  run,
  onDelete,
  onOpen,
}: {
  run: DsaAnalysis;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const stats = React.useMemo(() => {
    let withLinks = 0;
    let totalSolved = 0;
    for (const r of run.results) {
      if (r.leetcode?.url || r.codeforces?.url || r.codechef?.url) withLinks++;
      if (r.totalSolved) totalSolved += r.totalSolved;
    }
    return { withLinks, totalSolved };
  }, [run.results]);

  return (
    <RunCard
      title={run.name}
      meta={`${formatDate(run.createdAt)} · ${run.subsheets.join(", ")}`}
      openHint="View DSA solved counts"
      onOpen={onOpen}
      deleteLabel="Delete DSA run"
      onDelete={onDelete}
      metrics={[
        { label: "Candidates", value: run.total },
        { label: "With links", value: stats.withLinks },
        { label: "Solved", value: stats.totalSolved },
      ]}
      badges={
        run.complete === false ? (
          <Badge variant="warning" title="The run was stopped or interrupted">
            Incomplete
          </Badge>
        ) : null
      }
    />
  );
}
