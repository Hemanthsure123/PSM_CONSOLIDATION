"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionBar } from "@/components/ui/action-bar";
import { Stepper } from "@/components/ui/stepper";
import {
  WIZARD_STEPS,
  INITIAL_STATE,
  buildCompanySummary,
  type WizardState,
} from "@/components/wizard/wizard-shared";
import { saveCompany, newCompanyId } from "@/lib/company-store";
import { SetupStep } from "@/components/wizard/setup-step";
import { SubsheetStep } from "@/components/wizard/subsheet-step";
import { DatabaseStep } from "@/components/wizard/database-step";
import { PreviewStep } from "@/components/wizard/preview-step";
import { ExportStep } from "@/components/wizard/export-step";

interface PlacementWizardProps {
  /** Called after the run is saved to the dashboard. */
  onComplete: () => void;
  /** Called to abandon the run and return to the dashboard. */
  onCancel: () => void;
}

export function PlacementWizard({ onComplete, onCancel }: PlacementWizardProps) {
  const [step, setStep] = React.useState(0);
  const [state, setState] = React.useState<WizardState>(INITIAL_STATE);

  const patch = React.useCallback(
    (partial: Partial<WizardState>) => setState((prev) => ({ ...prev, ...partial })),
    [],
  );

  const selectedSubs = state.subsheets.filter((s) => s.selected);
  const subsReady =
    selectedSubs.length > 0 &&
    selectedSubs.every(
      (s) => s.loaded && s.selectedColumns.length > 0 && s.identifierColumn && s.resumeColumn,
    );

  const isLast = step === WIZARD_STEPS.length - 1;

  const canAdvance = (() => {
    switch (step) {
      case 0:
        return state.companyName.trim().length > 0 && state.subsheets.length > 0;
      case 1:
        return subsReady;
      case 2:
        return true;
      case 3:
        // Reports are optional + best-effort — only require a consolidated pool.
        return state.consolidated.length > 0;
      default:
        return false;
    }
  })();

  const next = () => setStep((s) => Math.min(s + 1, WIZARD_STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const finish = () => {
    const summary = buildCompanySummary(state, newCompanyId(), new Date().toISOString());
    saveCompany(summary);
    onComplete();
  };

  // What the current step still needs (or what it holds), shown beside the actions.
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const statusText = (() => {
    switch (step) {
      case 0:
        if (!state.companyName.trim()) return "Enter the company name to continue.";
        if (state.subsheets.length === 0) return "Fetch the sheet's subsheets to continue.";
        return `${plural(state.subsheets.length, "subsheet")} found.`;
      case 1:
        if (selectedSubs.length === 0) return "Include at least one subsheet to continue.";
        if (!subsReady) return "Map the columns and load the rows of every included subsheet.";
        return `${plural(selectedSubs.length, "subsheet")} ready · ${plural(
          selectedSubs.reduce((n, s) => n + s.rows.length, 0),
          "row",
        )}.`;
      case 2:
        return state.useBigQuery
          ? `${plural(state.selectedBqColumnIds.length, "BigQuery column")} selected.`
          : "No BigQuery columns. The sheet uses the internal sheet only.";
      case 3:
        return state.consolidated.length > 0
          ? `${plural(state.consolidated.length, "candidate")} in the company sheet.`
          : "No candidates consolidated yet.";
      default:
        return "Download the sheet, then save it to the dashboard.";
    }
  })();

  const current = WIZARD_STEPS[step];

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card px-4 py-4 shadow-surface sm:px-5">
        <Stepper steps={WIZARD_STEPS} current={step} />
        <p className="mt-3 text-[13px] sm:hidden">
          <span className="font-medium">
            Step {step + 1} of {WIZARD_STEPS.length}: {current.title}
          </span>
          {current.description ? <span className="text-muted-foreground"> · {current.description}</span> : null}
        </p>
      </div>

      <div>
        {step === 0 && <SetupStep state={state} patch={patch} />}
        {step === 1 && <SubsheetStep state={state} patch={patch} />}
        {step === 2 && <DatabaseStep state={state} patch={patch} />}
        {step === 3 && <PreviewStep state={state} patch={patch} />}
        {step === 4 && <ExportStep state={state} />}
      </div>

      <ActionBar
        status={
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onCancel} className="-ml-1 shrink-0">
              Cancel
            </Button>
            <span className="min-w-0" aria-live="polite">
              {statusText}
            </span>
          </div>
        }
      >
        {step > 0 ? (
          <Button variant="outline" onClick={back}>
            Back
          </Button>
        ) : null}
        {!isLast ? (
          <Button onClick={next} disabled={!canAdvance}>
            Continue
          </Button>
        ) : (
          <Button onClick={finish} disabled={state.consolidated.length === 0}>
            <Check /> Save and finish
          </Button>
        )}
      </ActionBar>
    </div>
  );
}
