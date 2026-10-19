"use client";

import * as React from "react";
import { Notice } from "@/components/ui/notice";
import { Stepper } from "@/components/ui/stepper";
import { useReportBusy } from "@/components/busy-context";
import { cn } from "@/lib/utils";
import { AssignmentStep } from "@/components/assignment-eval/assignment-step";
import { CriteriaStep } from "@/components/assignment-eval/criteria-step";
import { CandidatesStep } from "@/components/assignment-eval/candidates-step";
import { ResultsStep } from "@/components/assignment-eval/results-step";
import { deriveAssignmentCriteria } from "@/actions/assignment";
import { bandThresholds, blankEvaluation, DEFAULT_BAND, finalizeResults } from "@/lib/assignment-scoring";
import { getAssignmentRun, newAssignmentRunId, saveAssignmentRun } from "@/lib/assignment-store";
import type {
  AssignmentRun,
  AssignmentRunConfig,
  AssignmentSpec,
  CandidateEvaluation,
  CandidateInput,
} from "@/lib/assignment-types";

interface AssignmentEvalProps {
  /** Reopen a saved run; omit to start a new one. */
  runId?: string | null;
  onDone: () => void;
}

const STEPS = [
  { title: "Assignment", description: "Paste or upload" },
  { title: "Criteria", description: "Review the rubric" },
  { title: "Candidates", description: "Mobile and GitHub" },
  { title: "Evaluate", description: "Scores and CSV" },
];

const MAX_STORED_DOC = 150_000;

function defaultConfig(): AssignmentRunConfig {
  return {
    runName: "",
    company: "",
    ctcBand: DEFAULT_BAND,
    deadline: "",
    thresholds: bandThresholds(DEFAULT_BAND),
    concurrency: 4,
  };
}

/**
 * Assignment Evaluation — derive a rubric strictly from the assignment
 * document, then read every candidate's GitHub repository end to end and score
 * it against that rubric. Runs are saved after every batch, so a long run
 * (50–200 candidates) survives a refresh and can be resumed from the dashboard.
 */
export function AssignmentEval({ runId }: AssignmentEvalProps) {
  const [id, setId] = React.useState<string>(() => runId || newAssignmentRunId());
  const [createdAt, setCreatedAt] = React.useState(() => new Date().toISOString());
  const [step, setStep] = React.useState(0);
  const [config, setConfig] = React.useState<AssignmentRunConfig>(defaultConfig);
  const [assignmentText, setAssignmentText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [documentText, setDocumentText] = React.useState("");
  const [spec, setSpec] = React.useState<AssignmentSpec | null>(null);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [analyzeError, setAnalyzeError] = React.useState("");
  const [candidates, setCandidates] = React.useState<CandidateInput[]>([]);
  const [results, setResults] = React.useState<Record<string, CandidateEvaluation>>({});
  const [running, setRunning] = React.useState(false);
  const [active, setActive] = React.useState<string[]>([]);
  const [runError, setRunError] = React.useState("");
  const [storageFull, setStorageFull] = React.useState(false);
  const abortRef = React.useRef(false);
  useReportBusy(running || analyzing);

  // Reopen a saved run.
  React.useEffect(() => {
    if (!runId) return;
    const saved = getAssignmentRun(runId);
    if (!saved) return;
    setId(saved.id);
    setCreatedAt(saved.createdAt);
    setConfig(saved.config);
    setAssignmentText(saved.assignmentText);
    setDocumentText(saved.assignmentText);
    setSpec(saved.spec);
    setCandidates(saved.candidates);
    setResults(saved.results);
    setStep(Object.keys(saved.results).length || saved.candidates.length ? 3 : 1);
  }, [runId]);

  const locked = Object.keys(results).length > 0;

  /** Persist the run as it stands (overrides win over current state). */
  const persist = React.useCallback(
    (over: Partial<AssignmentRun> = {}) => {
      const s = over.spec ?? spec;
      if (!s) return;
      const ok = saveAssignmentRun({
        id,
        name: (over.config ?? config).runName || s.title,
        createdAt,
        updatedAt: new Date().toISOString(),
        config: over.config ?? config,
        assignmentText: (over.assignmentText ?? documentText ?? assignmentText).slice(0, MAX_STORED_DOC),
        spec: s,
        candidates: over.candidates ?? candidates,
        results: over.results ?? results,
      });
      setStorageFull(!ok);
    },
    [id, createdAt, config, spec, documentText, assignmentText, candidates, results],
  );

  const analyze = async () => {
    setAnalyzing(true);
    setAnalyzeError("");
    try {
      const fd = new FormData();
      fd.set("text", assignmentText);
      fd.set("ctcBand", config.ctcBand);
      fd.set("company", config.company);
      if (file) fd.set("file", file);
      const res = await deriveAssignmentCriteria(fd);
      if (!res.ok) {
        setAnalyzeError(res.error);
        return;
      }
      const nextConfig = { ...config, runName: config.runName || res.data.spec.title };
      setConfig(nextConfig);
      setSpec(res.data.spec);
      setDocumentText(res.data.documentText);
      persist({ spec: res.data.spec, config: nextConfig, assignmentText: res.data.documentText });
      setStep(1);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Could not analyse the assignment.");
    } finally {
      setAnalyzing(false);
    }
  };

  const updateSpec = (next: AssignmentSpec) => {
    setSpec(next);
    persist({ spec: next });
  };

  const updateConfig = (next: AssignmentRunConfig) => {
    setConfig(next);
    persist({ config: next });
  };

  const applyCandidates = (list: CandidateInput[]) => {
    setCandidates(list);
    // Keep results only for candidates still in the list.
    const kept: Record<string, CandidateEvaluation> = {};
    for (const c of list) if (results[c.id]) kept[c.id] = results[c.id];
    setResults(kept);
    persist({ candidates: list, results: kept });
    setStep(3);
  };

  /**
   * Evaluate `targets` with a sliding window of `concurrency` requests: as soon
   * as one repository finishes the next one starts, so a slow repo never holds
   * up the rest. The run is saved after every candidate.
   */
  const evaluate = async (targets: CandidateInput[]) => {
    if (!spec || !targets.length) return;
    abortRef.current = false;
    setRunning(true);
    setRunError("");
    let current = { ...results };
    const queue = [...targets];
    const width = Math.min(8, Math.max(1, config.concurrency));

    const worker = async () => {
      while (queue.length && !abortRef.current) {
        const c = queue.shift()!;
        setActive((a) => [...a, c.id]);
        let evaluation: CandidateEvaluation;
        try {
          const res = await fetch("/api/assignment/evaluate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ spec, config, candidate: c }),
          });
          const data = (await res.json().catch(() => ({}))) as { evaluation?: CandidateEvaluation; error?: string };
          if (!res.ok || !data.evaluation) throw new Error(data.error || `Server returned HTTP ${res.status}`);
          evaluation = data.evaluation;
        } catch (err) {
          evaluation = {
            ...blankEvaluation(c),
            error: err instanceof Error ? err.message : "Request failed — re-run this candidate.",
          };
        }
        current = finalizeResults({ ...current, [c.id]: evaluation }, spec, config.thresholds);
        setResults(current);
        persist({ results: current });
        setActive((a) => a.filter((id) => id !== c.id));
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Evaluation stopped unexpectedly.");
    } finally {
      setActive([]);
      setRunning(false);
    }
  };

  // Thresholds / similarity are re-applied on every change without new LLM calls.
  const finalized = React.useMemo(
    () => (spec ? finalizeResults(results, spec, config.thresholds) : results),
    [results, spec, config.thresholds],
  );

  return (
    <div className="space-y-6">
      {/* One step per view; the stepper shows where the run is and how far is left. */}
      <div className="max-w-3xl rounded-xl border bg-card px-5 py-4 shadow-surface">
        <Stepper steps={STEPS} current={step} />
      </div>

      {storageFull ? (
        <Notice tone="warning" title="This run is no longer being saved" className={cn(step < 3 && "max-w-3xl")}>
          Browser storage is full. Download the CSV now, then delete older assignment runs from the dashboard.
        </Notice>
      ) : null}

      {step === 0 ? (
        <AssignmentStep
          config={config}
          onConfig={setConfig}
          text={assignmentText}
          onText={setAssignmentText}
          file={file}
          onFile={setFile}
          analyzing={analyzing}
          error={analyzeError}
          locked={locked}
          hasSpec={Boolean(spec)}
          onAnalyze={analyze}
          onNext={() => setStep(1)}
        />
      ) : null}

      {step === 1 && spec ? (
        <CriteriaStep
          spec={spec}
          config={config}
          locked={locked}
          onSpec={updateSpec}
          onConfig={updateConfig}
          onBack={() => setStep(0)}
          onNext={() => setStep(2)}
        />
      ) : null}

      {step === 2 && spec ? (
        <CandidatesStep
          initial={candidates}
          config={config}
          onConfig={updateConfig}
          onBack={() => setStep(1)}
          onUse={applyCandidates}
        />
      ) : null}

      {step === 3 && spec ? (
        <ResultsStep
          spec={spec}
          config={config}
          candidates={candidates}
          results={finalized}
          running={running}
          active={active}
          error={runError}
          onEvaluate={evaluate}
          onStop={() => (abortRef.current = true)}
          onBack={() => setStep(2)}
          onCriteria={() => setStep(1)}
        />
      ) : null}
    </div>
  );
}
