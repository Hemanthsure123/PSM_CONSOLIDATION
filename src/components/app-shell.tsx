"use client";

import * as React from "react";
import { GraduationCap } from "lucide-react";
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

type View = "home" | "wizard" | "analyze" | "dsa" | "projects" | "domain" | "assignment" | "experience" | "qa" | "benchmarks";

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
  // A run just created for another domain starts screening as soon as it opens.
  const [benchmarkAutoStart, setBenchmarkAutoStart] = React.useState(false);

  return (
    <main className="container max-w-6xl py-8">
      <header className="mb-8 flex items-center gap-3">
        <button
          onClick={() => setView("home")}
          className="flex items-center gap-3 text-left"
          aria-label="Go to dashboard"
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <GraduationCap className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">NxtWave Placement Automation</h1>
            <p className="text-sm text-muted-foreground">
              {view === "home"
                ? "Company dashboard & source analytics"
                : view === "analyze"
                  ? "Analyze company sheet → Source & round funnels"
                  : view === "dsa"
                    ? "DSA consolidation → LeetCode, Codeforces & CodeChef — solved, contests, rating"
                    : view === "projects"
                      ? "Projects consolidation → Top real-world projects from all resumes"
                      : view === "domain"
                        ? "Domain shortlisting → Top candidates for a domain (report + CSV)"
                        : view === "assignment"
                          ? "Assignment evaluation → Rubric from the assignment, every repo reviewed end to end"
                          : view === "experience"
                            ? "Experience analysis → Internships & jobs: company, role, duration, tech stack"
                          : view === "qa"
                            ? "QA resume screening → Mandatory & good-to-have QA skills per section, ranked"
                          : view === "benchmarks"
                            ? "Benchmark projects → a domain's 15+ LPA-grade projects from pasted resumes (.md for Notion)"
                          : "Consolidate → Enrich → Screening Reports → Company Sheet"}
            </p>
          </div>
        </button>
      </header>

      {view === "home" ? (
        <HomeDashboard
          key={refresh}
          onNew={() => setView("wizard")}
          onAnalyze={() => setView("analyze")}
          onDsa={() => setView("dsa")}
          onProjects={() => setView("projects")}
          onDomain={() => setView("domain")}
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
          onBenchmarks={(runId) => {
            setBenchmarkRunId(runId ?? null);
            setBenchmarkAutoStart(false);
            setView("benchmarks");
          }}
        />
      ) : view === "analyze" ? (
        <SheetAnalyzer
          onDone={() => {
            setRefresh((n) => n + 1);
            setView("home");
          }}
        />
      ) : view === "projects" ? (
        <ProjectsConsolidation onDone={() => setView("home")} />
      ) : view === "domain" ? (
        <DomainShortlist onDone={() => setView("home")} />
      ) : view === "benchmarks" ? (
        <ProjectBenchmarks
          key={benchmarkRunId ?? "new"}
          runId={benchmarkRunId}
          autoStart={benchmarkAutoStart}
          onDone={() => {
            setRefresh((n) => n + 1);
            setView("home");
          }}
          onOpenRun={(runId, autoStart) => {
            setBenchmarkAutoStart(autoStart);
            setBenchmarkRunId(runId);
          }}
        />
      ) : view === "qa" ? (
        <QaScreening
          key={qaRunId ?? "new"}
          runId={qaRunId}
          onDone={() => {
            setRefresh((n) => n + 1);
            setView("home");
          }}
        />
      ) : view === "experience" ? (
        <ExperienceAnalysis
          key={experienceRunId ?? "new"}
          runId={experienceRunId}
          onDone={() => {
            setRefresh((n) => n + 1);
            setView("home");
          }}
        />
      ) : view === "assignment" ? (
        <AssignmentEval
          key={assignmentRunId ?? "new"}
          runId={assignmentRunId}
          onDone={() => {
            setRefresh((n) => n + 1);
            setView("home");
          }}
        />
      ) : view === "dsa" ? (
        <DsaConsolidation
          onDone={() => {
            setRefresh((n) => n + 1);
            setView("home");
          }}
        />
      ) : (
        <PlacementWizard
          onComplete={() => {
            setRefresh((n) => n + 1);
            setView("home");
          }}
          onCancel={() => setView("home")}
        />
      )}
    </main>
  );
}
