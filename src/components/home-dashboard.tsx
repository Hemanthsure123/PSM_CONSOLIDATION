"use client";

import * as React from "react";
import {
  BarChart3,
  Briefcase,
  Building2,
  ClipboardCheck,
  Code2,
  FileSpreadsheet,
  FolderGit2,
  Layers,
  Plus,
  Send,
  ShieldCheck,
  Sigma,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DonutChart, Legend, StatTile, type Slice } from "@/components/charts";
import { CompanyDetail } from "@/components/company-detail";
import { AnalysisView } from "@/components/sheet-analyzer/analysis-view";
import { DsaResultsView } from "@/components/dsa-consolidation/dsa-results-view";
import { bucketColor, bucketLabel } from "@/lib/source-track";
import { listCompanies, deleteCompany } from "@/lib/company-store";
import { listAnalyses, deleteAnalysis } from "@/lib/analysis-store";
import { listDsaRuns, deleteDsaRun } from "@/lib/dsa-store";
import { listAssignmentRuns, deleteAssignmentRun } from "@/lib/assignment-store";
import { listExperienceRuns, deleteExperienceRun } from "@/lib/experience-store";
import type { ExperienceRun } from "@/lib/experience-types";
import { listQaRuns, deleteQaRun } from "@/lib/qa-store";
import type { QaRunMeta } from "@/lib/qa-types";
import { listBenchmarkRuns, deleteBenchmarkRun } from "@/lib/benchmark-store";
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
  /** Open Benchmark Projects — a saved run by id, or a new one. */
  onBenchmarks: (runId?: string) => void;
}

function toSlices(buckets: BucketCount[]): Slice[] {
  return buckets.map((b) => ({ label: bucketLabel(b.bucket), value: b.count, color: bucketColor(b.bucket) }));
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

export function HomeDashboard({
  onNew,
  onAnalyze,
  onDsa,
  onProjects,
  onDomain,
  onAssignment,
  onExperience,
  onQa,
  onBenchmarks,
}: HomeDashboardProps) {
  const [companies, setCompanies] = React.useState<CompanySummary[]>([]);
  const [analyses, setAnalyses] = React.useState<SheetAnalysis[]>([]);
  const [dsaRuns, setDsaRuns] = React.useState<DsaAnalysis[]>([]);
  const [assignmentRuns, setAssignmentRuns] = React.useState<AssignmentRun[]>([]);
  const [experienceRuns, setExperienceRuns] = React.useState<ExperienceRun[]>([]);
  // QA screening runs live in IndexedDB (too big for localStorage) — loaded async.
  const [qaRuns, setQaRuns] = React.useState<QaRunMeta[]>([]);
  // Benchmark-projects runs also live in IndexedDB.
  const [benchmarkRuns, setBenchmarkRuns] = React.useState<BenchmarkRunMeta[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [openAnalysisId, setOpenAnalysisId] = React.useState<string | null>(null);
  const [openDsaId, setOpenDsaId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setCompanies(listCompanies());
    setAnalyses(listAnalyses());
    setDsaRuns(listDsaRuns());
    setAssignmentRuns(listAssignmentRuns());
    setExperienceRuns(listExperienceRuns());
    void listQaRuns().then(setQaRuns);
    void listBenchmarkRuns().then(setBenchmarkRuns);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Company Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Every consolidated company drive and its source analytics.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => onBenchmarks()}>
            <Trophy className="h-4 w-4" /> Benchmark Projects
          </Button>
          <Button variant="outline" onClick={() => onQa()}>
            <ShieldCheck className="h-4 w-4" /> QA Resume Screening
          </Button>
          <Button variant="outline" onClick={() => onExperience()}>
            <Briefcase className="h-4 w-4" /> Experience Analysis
          </Button>
          <Button variant="outline" onClick={() => onAssignment()}>
            <ClipboardCheck className="h-4 w-4" /> Assignment Evaluation
          </Button>
          <Button variant="outline" onClick={onProjects}>
            <FolderGit2 className="h-4 w-4" /> Projects Consolidation
          </Button>
          <Button variant="outline" onClick={onDomain}>
            <Target className="h-4 w-4" /> Domain Shortlisting
          </Button>
          <Button variant="outline" onClick={onDsa}>
            <Code2 className="h-4 w-4" /> DSA Consolidation
          </Button>
          <Button variant="outline" onClick={onAnalyze}>
            <BarChart3 className="h-4 w-4" /> Analyze Company Sheet
          </Button>
          <Button onClick={onNew}>
            <Plus className="h-4 w-4" /> New Consolidation
          </Button>
        </div>
      </div>

      {companies.length === 0 && analyses.length === 0 && dsaRuns.length === 0 && assignmentRuns.length === 0 && experienceRuns.length === 0 && qaRuns.length === 0 && benchmarkRuns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <FileSpreadsheet className="h-7 w-7" />
            </div>
            <div>
              <p className="font-medium">Nothing here yet</p>
              <p className="text-sm text-muted-foreground">
                Start a consolidation to build a company sheet, or analyze an existing company
                sheet to visualize its source &amp; round funnel.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={onNew}>
                <Plus className="h-4 w-4" /> New Consolidation
              </Button>
              <Button variant="outline" onClick={onAnalyze}>
                <BarChart3 className="h-4 w-4" /> Analyze Company Sheet
              </Button>
              <Button variant="outline" onClick={onDsa}>
                <Code2 className="h-4 w-4" /> DSA Consolidation
              </Button>
              <Button variant="outline" onClick={onProjects}>
                <FolderGit2 className="h-4 w-4" /> Projects Consolidation
              </Button>
              <Button variant="outline" onClick={onDomain}>
                <Target className="h-4 w-4" /> Domain Shortlisting
              </Button>
              <Button variant="outline" onClick={() => onAssignment()}>
                <ClipboardCheck className="h-4 w-4" /> Assignment Evaluation
              </Button>
              <Button variant="outline" onClick={() => onExperience()}>
                <Briefcase className="h-4 w-4" /> Experience Analysis
              </Button>
              <Button variant="outline" onClick={() => onQa()}>
                <ShieldCheck className="h-4 w-4" /> QA Resume Screening
              </Button>
              <Button variant="outline" onClick={() => onBenchmarks()}>
                <Trophy className="h-4 w-4" /> Benchmark Projects
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {companies.length > 0 ? (
        <>
          {/* Overall roll-up across all companies. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className="h-4 w-4 text-muted-foreground" /> All companies
                <Badge variant="secondary">{companies.length}</Badge>
              </CardTitle>
              <CardDescription>Combined totals across every saved consolidation.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
              <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
                <StatTile icon={<Building2 className="h-5 w-5" />} label="Companies" value={companies.length} accent="#4f46e5" />
                <StatTile icon={<Send className="h-5 w-5" />} label="Candidates sent" value={agg.total} accent="#10b981" />
                <StatTile icon={<Sparkles className="h-5 w-5" />} label="Reports generated" value={agg.reports} accent="#f59e0b" />
              </div>
              <div className="flex flex-col items-center gap-6 rounded-xl border p-4 sm:flex-row">
                <DonutChart data={toSlices(agg.buckets)} total={agg.total} />
                <Legend data={toSlices(agg.buckets)} total={agg.total} />
              </div>
            </CardContent>
          </Card>

          {/* One card per company. */}
          <div className="grid gap-6 lg:grid-cols-2">
            {companies.map((c) => (
              <CompanyCard
                key={c.id}
                company={c}
                onDelete={() => remove(c.id)}
                onOpen={() => setSelectedId(c.id)}
              />
            ))}
          </div>
        </>
      ) : null}

      {/* Saved company-sheet funnel analyses. */}
      {analyses.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold">Company sheet funnels</h3>
            <Badge variant="secondary">{analyses.length}</Badge>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {analyses.map((a) => (
              <AnalysisCard
                key={a.id}
                analysis={a}
                onDelete={() => removeAnalysis(a.id)}
                onOpen={() => setOpenAnalysisId(a.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Saved QA screening runs — click to reopen / resume / add a batch / export. */}
      {qaRuns.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold">QA resume screenings</h3>
            <Badge variant="secondary">{qaRuns.length}</Badge>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {qaRuns.map((r) => (
              <QaCard key={r.id} run={r} onDelete={() => removeQa(r.id)} onOpen={() => onQa(r.id)} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Saved benchmark-projects runs — click to reopen / resume / add resumes / export. */}
      {benchmarkRuns.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold">Benchmark projects</h3>
            <Badge variant="secondary">{benchmarkRuns.length}</Badge>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {benchmarkRuns.map((r) => (
              <BenchmarkCard key={r.id} run={r} onDelete={() => removeBenchmark(r.id)} onOpen={() => onBenchmarks(r.id)} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Saved experience analyses — click to reopen / resume / export. */}
      {experienceRuns.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold">Experience analyses</h3>
            <Badge variant="secondary">{experienceRuns.length}</Badge>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {experienceRuns.map((r) => (
              <ExperienceCard
                key={r.id}
                run={r}
                onDelete={() => removeExperience(r.id)}
                onOpen={() => onExperience(r.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Saved assignment evaluation runs — click to reopen / resume / export. */}
      {assignmentRuns.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold">Assignment evaluations</h3>
            <Badge variant="secondary">{assignmentRuns.length}</Badge>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {assignmentRuns.map((r) => (
              <AssignmentCard
                key={r.id}
                run={r}
                onDelete={() => removeAssignment(r.id)}
                onOpen={() => onAssignment(r.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Saved DSA consolidation runs. */}
      {dsaRuns.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Code2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold">DSA consolidations</h3>
            <Badge variant="secondary">{dsaRuns.length}</Badge>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {dsaRuns.map((d) => (
              <DsaCard
                key={d.id}
                run={d}
                onDelete={() => removeDsa(d.id)}
                onOpen={() => setOpenDsaId(d.id)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title="View candidate-level source funnel"
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4 text-muted-foreground" /> {company.sheetName}
            </CardTitle>
            <CardDescription>{formatDate(company.createdAt)}</CardDescription>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete company"
            title="Remove from dashboard"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-3 text-sm">
          <Badge variant="secondary"><Send className="mr-1 h-3 w-3" /> {company.total} sent</Badge>
          <Badge variant="secondary"><Users className="mr-1 h-3 w-3" /> {company.matched} matched</Badge>
          <Badge variant="secondary"><Sparkles className="mr-1 h-3 w-3" /> {company.reportsGenerated} reports</Badge>
        </div>

        <div className="flex flex-col items-center gap-5 sm:flex-row">
          <DonutChart data={slices} total={company.total} />
          <Legend data={slices} total={company.total} />
        </div>

        {company.subsheets.length > 1 ? (
          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              By subsheet
            </p>
            {company.subsheets.map((s) => (
              <div key={s.name} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <div className="flex items-center gap-1.5">
                  {s.buckets.map((b) => (
                    <span
                      key={b.bucket}
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
                      style={{ background: bucketColor(b.bucket) }}
                      title={bucketLabel(b.bucket)}
                    >
                      {b.count}
                    </span>
                  ))}
                  <Badge variant="outline">{s.total}</Badge>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
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
    color: b.color,
  }));
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title="View source & round funnel"
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4 text-muted-foreground" /> {analysis.companyName}
            </CardTitle>
            <CardDescription>
              {formatDate(analysis.createdAt)} · {analysis.roundColumns.length} round
              {analysis.roundColumns.length === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete analysis"
            title="Remove from dashboard"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-3 text-sm">
          <Badge variant="secondary"><Send className="mr-1 h-3 w-3" /> {analysis.total} sent</Badge>
          <Badge variant="secondary">
            <Users className="mr-1 h-3 w-3" /> {analysis.total - analysis.company.untracked} tracked
          </Badge>
          <Badge variant="outline">{analysis.company.untracked} not tracked</Badge>
        </div>
        <div className="flex flex-col items-center gap-5 sm:flex-row">
          <DonutChart data={slices} total={analysis.total} />
          <Legend data={slices} total={analysis.total} />
        </div>
      </CardContent>
    </Card>
  );
}

function QaCard({ run, onDelete, onOpen }: { run: QaRunMeta; onDelete: () => void; onOpen: () => void }) {
  const total = run.candidates.length;
  const inProgress = run.stats.evaluated < total;
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={inProgress ? "Open to resume the screening" : "Open results"}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" /> {run.name}
            </CardTitle>
            <CardDescription>
              {formatDate(run.updatedAt)} · {run.batches.length} batch{run.batches.length === 1 ? "" : "es"} · min score{" "}
              {run.rules.minScore}%
            </CardDescription>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete QA screening"
            title="Remove from dashboard"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 text-sm">
          <Badge variant="secondary"><Users className="mr-1 h-3 w-3" /> {run.stats.evaluated}/{total} screened</Badge>
          <Badge variant="success">{run.stats.shortlisted} shortlisted</Badge>
          {run.stats.borderline ? <Badge variant="secondary">{run.stats.borderline} borderline</Badge> : null}
          {run.stats.errors ? <Badge variant="destructive">{run.stats.errors} errors</Badge> : null}
          {inProgress ? <Badge variant="outline">In progress — open to resume</Badge> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function BenchmarkCard({ run, onDelete, onOpen }: { run: BenchmarkRunMeta; onDelete: () => void; onOpen: () => void }) {
  const total = run.candidates.length;
  const inProgress = run.stats.screened < total;
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={inProgress ? "Open to resume the screening" : "Open projects / download the .md"}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Trophy className="h-4 w-4 text-muted-foreground" /> {run.name}
            </CardTitle>
            <CardDescription>
              {run.profile?.domain ? `${run.profile.domain} · ` : ""}
              {formatDate(run.updatedAt)} · {run.batches.length} batch{run.batches.length === 1 ? "" : "es"} · bar {run.minScore}/100
            </CardDescription>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete benchmark projects run"
            title="Remove from dashboard"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 text-sm">
          <Badge variant="secondary"><Users className="mr-1 h-3 w-3" /> {run.stats.screened}/{total} screened</Badge>
          <Badge variant="success">
            {run.stats.projects} {run.profile?.domain ?? "benchmark"} projects
          </Badge>
          {run.stats.errors ? <Badge variant="destructive">{run.stats.errors} errors</Badge> : null}
          {inProgress ? <Badge variant="outline">In progress — open to resume</Badge> : null}
        </div>
      </CardContent>
    </Card>
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
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={inProgress ? "Open to resume the analysis" : "Open results"}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Briefcase className="h-4 w-4 text-muted-foreground" /> {run.name}
            </CardTitle>
            <CardDescription>
              {formatDate(run.updatedAt)} · {run.sheetTitle}
              {run.subsheets.length ? ` · ${run.subsheets.join(", ")}` : ""}
            </CardDescription>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete experience analysis"
            title="Remove from dashboard"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 text-sm">
          <Badge variant="secondary"><Users className="mr-1 h-3 w-3" /> {stats.analysed}/{run.candidates.length} analysed</Badge>
          <Badge variant="success">{stats.withExp} with experience</Badge>
          <Badge variant="secondary">{stats.entries} internships / jobs</Badge>
          {inProgress ? <Badge variant="outline">In progress — open to resume</Badge> : null}
        </div>
      </CardContent>
    </Card>
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
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={inProgress ? "Open to resume the evaluation" : "Open results"}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" /> {run.name}
            </CardTitle>
            <CardDescription>
              {formatDate(run.updatedAt)}
              {run.config.company ? ` · ${run.config.company}` : ""} · {bandLabel(run.config.ctcBand)}
            </CardDescription>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete assignment run"
            title="Remove from dashboard"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 text-sm">
          <Badge variant="secondary"><Users className="mr-1 h-3 w-3" /> {stats.evaluated}/{run.candidates.length} evaluated</Badge>
          <Badge variant="success">{stats.shortlisted} shortlisted</Badge>
          {stats.review ? <Badge variant="secondary">{stats.review} to review</Badge> : null}
          {inProgress ? <Badge variant="outline">In progress — open to resume</Badge> : null}
        </div>
      </CardContent>
    </Card>
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
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title="View DSA solved counts"
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Code2 className="h-4 w-4 text-muted-foreground" /> {run.name}
            </CardTitle>
            <CardDescription>
              {formatDate(run.createdAt)} · {run.subsheets.join(", ")}
            </CardDescription>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete DSA run"
            title="Remove from dashboard"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 text-sm">
          <Badge variant="secondary"><Users className="mr-1 h-3 w-3" /> {run.total} candidates</Badge>
          <Badge variant="secondary"><Code2 className="mr-1 h-3 w-3" /> {stats.withLinks} with links</Badge>
          {run.complete === false ? <Badge variant="outline">Incomplete — stopped or interrupted</Badge> : null}
          <Badge variant="secondary"><Sigma className="mr-1 h-3 w-3" /> {stats.totalSolved} solved</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
