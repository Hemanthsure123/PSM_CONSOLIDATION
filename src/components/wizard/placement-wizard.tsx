"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, Home, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex items-center gap-4 py-6">
          <Button variant="ghost" size="sm" onClick={onCancel} className="shrink-0">
            <Home className="h-4 w-4" /> Dashboard
          </Button>
          <div className="min-w-0 flex-1">
            <Stepper steps={WIZARD_STEPS} current={step} />
          </div>
        </CardContent>
      </Card>

      <div>
        {step === 0 && <SetupStep state={state} patch={patch} />}
        {step === 1 && <SubsheetStep state={state} patch={patch} />}
        {step === 2 && <DatabaseStep state={state} patch={patch} />}
        {step === 3 && <PreviewStep state={state} patch={patch} />}
        {step === 4 && <ExportStep state={state} />}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={back} disabled={step === 0}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        {!isLast ? (
          <Button onClick={next} disabled={!canAdvance}>
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button onClick={finish} disabled={state.consolidated.length === 0}>
            <LayoutDashboard className="h-4 w-4" /> Save to Dashboard & Finish
          </Button>
        )}
      </div>
    </div>
  );
}
