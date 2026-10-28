"use client";

import * as React from "react";
import {
  Award,
  BarChart3,
  Briefcase,
  Building2,
  ClipboardCheck,
  Code2,
  Database,
  FileCode2,
  FileSpreadsheet,
  FolderKanban,
  GraduationCap,
  Layers,
  LayoutDashboard,
  Menu,
  Star,
  Target,
  UserSearch,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BusyProvider } from "@/components/busy-context";
import { ConfirmDialog } from "@/components/ui/dialog";
import { HomeDashboard } from "@/components/home-dashboard";
import { PlacementWizard } from "@/components/wizard/placement-wizard";
import { SheetAnalyzer } from "@/components/sheet-analyzer/sheet-analyzer";
import { DsaConsolidation } from "@/components/dsa-consolidation/dsa-consolidation";
import { ProjectsConsolidation } from "@/components/projects-consolidation/projects-consolidation";
import { DomainShortlist } from "@/components/domain-shortlist/domain-shortlist";
import { AssignmentEval } from "@/components/assignment-eval/assignment-eval";
import { ExperienceAnalysis } from "@/components/experience-analysis/experience-analysis";
import { QaScreening } from "@/components/qa-screening/qa-screening";
import { ProjectBenchmarks } from "@/components/project-benchmarks/project-benchmarks";
import { CandidateBucketing } from "@/components/bucketing/bucketing";
import { ZaggleScreening } from "@/components/zaggle/zaggle-screening";
import { AcademyBucketing } from "@/components/academy/academy-bucketing";
import { SampleProfiles } from "@/components/showcase/sample-profiles";
import { EligiblePool } from "@/components/pool/eligible-pool";
import { StandingLookup } from "@/components/pool/standing-lookup";

type View = "home" | "pool" | "lookup" | "wizard" | "analyze" | "showcase" | "dsa" | "projects" | "domain" | "assignment" | "experience" | "qa" | "benchmarks" | "bucketing" | "zaggle" | "academy";

interface ViewMeta {
  label: string;
  /** Page title (defaults to the label). */
  title?: string;
  description: string;
  icon: LucideIcon;
}

const VIEWS: Record<View, ViewMeta> = {
  home: { label: "Dashboard", description: "Your companies and every saved run, in one place.", icon: LayoutDashboard },
  pool: {
    label: "Eligible pool",
    description: "Candidates assessed internally in Edge 2.0, Edge 1.0 and Academy: who is eligible at each stage, and how they rank in Domain shortlisting.",
    icon: Database,
  },
  lookup: {
    label: "Standing lookup",
    description: "Paste UUIDs or phone numbers to get each candidate's internal standing, stage and product from the Edge 2.0, Edge 1.0 and Academy assessments, with any assessment results you pick.",
    icon: UserSearch,
  },
  wizard: {
    label: "Build company sheet",
    description: "Consolidate candidates, add AI screening reports and export a sheet for the company.",
    icon: FileSpreadsheet,
  },
  analyze: {
    label: "Analyze company sheet",
    description: "Where a company's candidates came from and how they moved through the interview rounds.",
    icon: BarChart3,
  },
  showcase: {
    label: "Sample profiles",
    description: "The strongest candidates per tech role, or per job description — proven by their resume, own GitHub code and DSA — to show a company's hiring manager.",
    icon: Star,
  },
  domain: {
    label: "Domain shortlisting",
    description: "Rank a sheet's candidates for one domain, backed by their resume, GitHub and DSA profiles.",
    icon: Target,
  },
  zaggle: {
    label: "Zaggle SDE 1",
    title: "Zaggle SDE 1 screening",
    description: "Screen candidates for Zaggle's SDE 1 Backend role against the job description.",
    icon: Building2,
  },
  qa: { label: "QA screening", description: "Check QA resumes for mandatory and good-to-have skills, section by section.", icon: ClipboardCheck },
  bucketing: {
    label: "Candidate bucketing",
    description: "Sort interview candidates into the six TR-2 track buckets: internal assessments first, then verified projects, experience and achievements.",
    icon: Layers,
  },
  academy: {
    label: "Academy bucketing",
    description: "Sort the academy-assessed pool into Frontend, Backend, AI-ML and Full Stack for mentor assignment.",
    icon: GraduationCap,
  },
  assignment: {
    label: "Assignment evaluation",
    description: "Review every submitted repository against a rubric built from the assignment.",
    icon: FileCode2,
  },
  experience: {
    label: "Experience analysis",
    description: "Internships and jobs from each resume: company, role, duration and tech stack.",
    icon: Briefcase,
  },
  dsa: {
    label: "DSA consolidation",
    description: "LeetCode, Codeforces and CodeChef for every candidate: problems solved, contests and rating.",
    icon: Code2,
  },
  projects: { label: "Projects consolidation", description: "The strongest real-world projects across all resumes.", icon: FolderKanban },
  benchmarks: {
    label: "Benchmark projects",
    description: "Projects that set the bar for a domain, collected from pasted resumes and exported for Notion.",
    icon: Award,
  },
};

/** Tools grouped by the job they do in the placement pipeline. */
const NAV: { group?: string; views: View[] }[] = [
  { views: ["home", "pool", "lookup"] },
  { group: "Company sheets", views: ["wizard", "analyze", "showcase"] },
  { group: "Screening", views: ["domain", "qa", "zaggle", "bucketing", "academy"] },
  { group: "Evaluation", views: ["assignment", "experience", "dsa", "projects"] },
  { group: "Reference", views: ["benchmarks"] },
];

export function AppShell() {
  const [view, setView] = React.useState<View>("home");
  // Bump to force the dashboard to re-read the store after a run completes.
  const [refresh, setRefresh] = React.useState(0);
  // Saved assignment run to reopen (null = start a new one).
  const [assignmentRunId, setAssignmentRunId] = React.useState<string | null>(null);
  // Saved experience-analysis run to reopen (null = start a new one).
  const [experienceRunId, setExperienceRunId] = React.useState<string | null>(null);
  // Saved QA screening run to reopen (null = start a new one).
  const [qaRunId, setQaRunId] = React.useState<string | null>(null);
  // Saved benchmark-projects run to reopen (null = start a new one).
  const [benchmarkRunId, setBenchmarkRunId] = React.useState<string | null>(null);
  // Saved candidate-bucketing run to reopen (null = start a new one).
  const [bucketingRunId, setBucketingRunId] = React.useState<string | null>(null);
  // Saved Zaggle SDE 1 screening run to reopen (null = start a new one).
  const [zaggleRunId, setZaggleRunId] = React.useState<string | null>(null);
  // Saved Academy bucketing run to reopen (null = start a new one).
  const [academyRunId, setAcademyRunId] = React.useState<string | null>(null);
  // Saved Sample profiles run to reopen (null = start a new one).
  const [showcaseRunId, setShowcaseRunId] = React.useState<string | null>(null);
  // A run just created for another domain starts screening as soon as it opens.
  const [benchmarkAutoStart, setBenchmarkAutoStart] = React.useState(false);

  // A screen with a run in progress (reported through useReportBusy) — leaving it asks first.
  const [busy, setBusy] = React.useState(false);
  const [pendingView, setPendingView] = React.useState<View | null>(null);
  const [navOpen, setNavOpen] = React.useState(false);
  const mainRef = React.useRef<HTMLElement>(null);

  /** Open a tool from the sidebar: a fresh run (saved runs reopen from the dashboard). */
  const openFresh = React.useCallback((v: View) => {
    if (v === "assignment") setAssignmentRunId(null);
    if (v === "experience") setExperienceRunId(null);
    if (v === "qa") setQaRunId(null);
    if (v === "bucketing") setBucketingRunId(null);
    if (v === "zaggle") setZaggleRunId(null);
    if (v === "academy") setAcademyRunId(null);
    if (v === "showcase") setShowcaseRunId(null);
    if (v === "benchmarks") {
      setBenchmarkRunId(null);
      setBenchmarkAutoStart(false);
    }
    setView(v);
    setNavOpen(false);
  }, []);

  const navigate = (v: View) => {
    if (v === view) {
      setNavOpen(false);
      return;
    }
    if (busy) {
      setPendingView(v);
      return;
    }
    openFresh(v);
  };

  // New screen → start at the top, and move focus to the page so keyboard users land there.
  React.useEffect(() => {
    window.scrollTo({ top: 0 });
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);

  const goHome = () => {
    setRefresh((n) => n + 1);
    setView("home");
  };

  const meta = VIEWS[view];

  const sidebar = (
    <nav aria-label="Tools" className="flex h-full flex-col">
      <button
        type="button"
        onClick={() => navigate("home")}
        className="mx-3 mt-4 flex items-center gap-3 rounded-lg px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
        aria-label="Go to dashboard"
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-primary font-display text-[15px] font-bold text-primary-foreground">
          Nx
          <span className="absolute inset-x-1.5 bottom-1.5 h-[3px] rounded-full bg-highlight" aria-hidden />
        </span>
        <span className="leading-tight">
          <span className="block font-display text-[15px] font-bold tracking-[-0.01em]">NxtWave</span>
          <span className="block text-xs text-muted-foreground">Placements</span>
        </span>
      </button>

      <div className="mt-4 flex-1 space-y-5 overflow-y-auto px-3 pb-6">
        {NAV.map((section, i) => (
          <div key={section.group ?? i}>
            {section.group ? <p className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">{section.group}</p> : null}
            <ul className="space-y-0.5">
              {section.views.map((v) => {
                const item = VIEWS[v];
                const Icon = item.icon;
                const active = v === view;
                return (
                  <li key={v}>
                    <button
                      type="button"
                      onClick={() => navigate(v)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                        active ? "bg-accent font-medium text-accent-foreground" : "text-[hsl(218_25%_32%)] hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {active ? <span className="absolute -left-3 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-primary" aria-hidden /> : null}
                      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                      <span className="truncate">{item.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );

  return (
    <BusyProvider onChange={setBusy}>
      <div className="min-h-screen lg:grid lg:grid-cols-[252px_minmax(0,1fr)]">
        {/* Sidebar — always visible on desktop */}
        <div className="hidden border-r bg-card lg:block">
          <aside className="sticky top-0 h-screen">{sidebar}</aside>
        </div>

        {/* Sidebar — drawer on small screens */}
        {navOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 animate-fade-in bg-[hsl(218_46%_15%/0.35)]" onClick={() => setNavOpen(false)} aria-hidden />
            <aside className="absolute inset-y-0 left-0 w-[272px] animate-pop-in border-r bg-card shadow-overlay">
              <button
                type="button"
                onClick={() => setNavOpen(false)}
                aria-label="Close menu"
                className="absolute right-3 top-5 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
              {sidebar}
            </aside>
          </div>
        ) : null}

        <div className="min-w-0">
          {/* Top bar — small screens only */}
          <div className="sticky top-0 z-30 flex items-center gap-3 border-b bg-card/95 px-4 py-2.5 backdrop-blur lg:hidden">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="font-display text-[15px] font-semibold">{meta.title ?? meta.label}</span>
          </div>

          <main ref={mainRef} tabIndex={-1} className="mx-auto w-full max-w-[1240px] px-4 pb-16 pt-6 outline-none sm:px-6 lg:px-10 lg:pt-9">
            <header className="mb-7 flex items-start gap-3.5">
              <span className="mt-1 hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-card text-primary shadow-surface sm:flex">
                <meta.icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.025em] sm:text-[28px]">{meta.title ?? meta.label}</h1>
                <p className="mt-1 max-w-[80ch] text-[14px] leading-relaxed text-muted-foreground">{meta.description}</p>
              </div>
            </header>

            {view === "home" ? (
              <HomeDashboard
                key={refresh}
                onNew={() => navigate("wizard")}
                onAnalyze={() => navigate("analyze")}
                onDsa={() => navigate("dsa")}
                onProjects={() => navigate("projects")}
                onDomain={() => navigate("domain")}
                onPool={() => navigate("pool")}
                onAssignment={(runId) => {
                  setAssignmentRunId(runId ?? null);
                  setView("assignment");
                }}
                onExperience={(runId) => {
                  setExperienceRunId(runId ?? null);
                  setView("experience");
                }}
                onQa={(runId) => {
                  setQaRunId(runId ?? null);
                  setView("qa");
                }}
                onBucketing={(runId) => {
                  setBucketingRunId(runId ?? null);
                  setView("bucketing");
                }}
                onZaggle={(runId) => {
                  setZaggleRunId(runId ?? null);
                  setView("zaggle");
                }}
                onAcademy={(runId) => {
                  setAcademyRunId(runId ?? null);
                  setView("academy");
                }}
                onShowcase={(runId) => {
                  setShowcaseRunId(runId ?? null);
                  setView("showcase");
                }}
                onBenchmarks={(runId) => {
                  setBenchmarkRunId(runId ?? null);
                  setBenchmarkAutoStart(false);
                  setView("benchmarks");
                }}
              />
            ) : view === "pool" ? (
              <EligiblePool />
            ) : view === "lookup" ? (
              <StandingLookup />
            ) : view === "analyze" ? (
              <SheetAnalyzer onDone={goHome} />
            ) : view === "projects" ? (
              <ProjectsConsolidation onDone={() => setView("home")} />
            ) : view === "domain" ? (
              <DomainShortlist onDone={() => setView("home")} />
            ) : view === "benchmarks" ? (
              <ProjectBenchmarks
                key={benchmarkRunId ?? "new"}
                runId={benchmarkRunId}
                autoStart={benchmarkAutoStart}
                onDone={goHome}
                onOpenRun={(runId, autoStart) => {
                  setBenchmarkAutoStart(autoStart);
                  setBenchmarkRunId(runId);
                }}
              />
            ) : view === "bucketing" ? (
              <CandidateBucketing key={bucketingRunId ?? "new"} runId={bucketingRunId} onDone={goHome} />
            ) : view === "zaggle" ? (
              <ZaggleScreening key={zaggleRunId ?? "new"} runId={zaggleRunId} onDone={goHome} />
            ) : view === "academy" ? (
              <AcademyBucketing key={academyRunId ?? "new"} runId={academyRunId} onDone={goHome} />
            ) : view === "showcase" ? (
              <SampleProfiles key={showcaseRunId ?? "new"} runId={showcaseRunId} onDone={goHome} />
            ) : view === "qa" ? (
              <QaScreening key={qaRunId ?? "new"} runId={qaRunId} onDone={goHome} />
            ) : view === "experience" ? (
              <ExperienceAnalysis key={experienceRunId ?? "new"} runId={experienceRunId} onDone={goHome} />
            ) : view === "assignment" ? (
              <AssignmentEval key={assignmentRunId ?? "new"} runId={assignmentRunId} onDone={goHome} />
            ) : view === "dsa" ? (
              <DsaConsolidation onDone={goHome} />
            ) : (
              <PlacementWizard onComplete={goHome} onCancel={() => setView("home")} />
            )}
          </main>
        </div>
      </div>

      <ConfirmDialog
        open={pendingView !== null}
        title="Leave this screen?"
        description="A run is still in progress here. If you leave, its progress on this screen is lost."
        confirmLabel="Leave"
        cancelLabel="Stay"
        tone="danger"
        onCancel={() => setPendingView(null)}
        onConfirm={() => {
          const next = pendingView;
          setPendingView(null);
          setBusy(false);
          if (next) openFresh(next);
        }}
      />
    </BusyProvider>
  );
}
