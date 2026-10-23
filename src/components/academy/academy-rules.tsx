"use client";

import * as React from "react";
import { ArrowRightLeft, BadgeCheck, Code2, FileText, GitBranch, Heart, ShieldCheck } from "lucide-react";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import type { AcRules } from "@/lib/academy/types";

const SIGNALS: { key: keyof AcRules["signals"]; title: string; description: string; info: string; icon: React.ReactNode }[] = [
  {
    key: "resume",
    title: "Resume",
    description: "Projects, internships and jobs, each classified by the technologies the resume names for it.",
    info: "One model read per resume. Every item's title, technologies and quote are checked against the resume text; the program decides the stack from the technologies. A job counts more than an internship, an internship more than a project; tutorial-level projects count half.",
    icon: <FileText />,
  },
  {
    key: "github",
    title: "GitHub",
    description: "What the code of each repo proves (manifests, imports, config), never repo names.",
    info: "The deep GitHub inspection used by Domain shortlisting, reused for 24 hours. Practice / assignment repos count 0.3, the academy's own course projects 0.5, repos with AI-written commits half. A stack with no repo counts at half weight — not every project is on GitHub.",
    icon: <GitBranch />,
  },
  {
    key: "competency",
    title: "Competency TR levels",
    description: "Frontend / Backend interview levels from sheet 1 (L4 100 · L3 80 · L2 55 · L1 35).",
    info: "A frontend or backend interview also counts 0.8 toward Full Stack, and at half weight for the other stacks (it says little about them). DSA and SE Fundamentals levels name no stack, so they feed the ranking (assessment score) instead.",
    icon: <BadgeCheck />,
  },
  {
    key: "preference",
    title: "Student preference",
    description: "The roles and stacks the student asked for, in the order they named them.",
    info: "Read from the Student Preference note. Location, CTC, bond and joining details are ignored; a Skills list counts half. The lightest signal.",
    icon: <Heart />,
  },
  {
    key: "dsa",
    title: "DSA profiles",
    description: "LeetCode / Codeforces / CodeChef from the resume links — ranking inside a bucket only.",
    info: "The DSA consolidation's own lookup. DSA names no stack, so it never moves a candidate between buckets; it ranks them with the DSA interview, DSA Offline and the old coding exam (the best of them).",
    icon: <Code2 />,
  },
];

const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

/** Which evidence is used. Switching one off re-buckets instantly; switching GitHub / DSA on later asks for a re-read. */
export function AcSignalsPanel({ rules, onChange, collapsed }: { rules: AcRules; onChange: (r: AcRules) => void; collapsed?: boolean }) {
  const list = (
    <SettingList>
      {SIGNALS.map((s) => (
        <SettingRow
          key={s.key}
          id={`ac-sig-${s.key}`}
          icon={s.icon}
          title={s.key === "dsa" ? s.title : `${s.title} · weight ${rules.weights[s.key as keyof AcRules["weights"]]}`}
          description={s.description}
          info={s.info}
          checked={rules.signals[s.key]}
          onCheckedChange={(v) => onChange({ ...rules, signals: { ...rules.signals, [s.key]: v } })}
        />
      ))}
      <SettingRow
        id="ac-sig-trust"
        icon={<ShieldCheck />}
        title="Trust agent"
        description="A second model checks whether the profile can be trusted; the score shapes confidence, tags and ranking."
        info="The program checks the resume carries the sheet's email / mobile, AI-written commits on GitHub, the interviewers' integrity scores and notes, and resume claims against the interview level. The agent adds doubts (inflated claims, impossible dates, course projects passed off as original, contradictions with GitHub or the interviews), each with the exact words it rests on — flags whose words aren't there are dropped. Score: 100 minus the checks (agent flags high −15, medium −8, low −3, at most −45). High ≥ 80, Medium ≥ 60, Low below. Low trust: Low confidence, a verify-over-call tag, a lower rank, and never nudged."
        checked={rules.trust.enabled}
        onCheckedChange={(v) => onChange({ ...rules, trust: { ...rules.trust, enabled: v } })}
      >
        <Field label="Lean on resume and GitHub from trust" htmlFor="ac-trust-rely" hint="Below this, they count at half weight and the candidate is tagged" className="sm:max-w-xs">
          <Input
            id="ac-trust-rely"
            type="number"
            min={0}
            max={100}
            className="tabular-nums"
            value={rules.trust.relyAt}
            onChange={(e) => onChange({ ...rules, trust: { ...rules.trust, relyAt: num(e.target.value, 0, 100) } })}
          />
        </Field>
      </SettingRow>
    </SettingList>
  );
  if (collapsed) {
    const on = [...SIGNALS.filter((s) => rules.signals[s.key]).map((s) => s.title.replace(" levels", "")), ...(rules.trust.enabled ? ["Trust agent"] : [])];
    return (
      <Disclosure title="Signals" summary={on.length ? on.join(" · ") : "all off"}>
        <p className="mb-3 text-[13px] text-muted-foreground">Switching a signal re-buckets instantly. Weights renormalise over the signals a candidate has.</p>
        {list}
      </Disclosure>
    );
  }
  return (
    <Panel title="Signals" description="Everything is switchable. Weights renormalise over the signals a candidate has.">
      {list}
    </Panel>
  );
}

/** The bucketing rules — rarely changed, so closed by default. Changing one re-buckets instantly. */
export function AcRulesCard({ rules, onChange }: { rules: AcRules; onChange: (r: AcRules) => void }) {
  const set = (patch: Partial<AcRules>) => onChange({ ...rules, ...patch });
  const summary = `Mixed within ${rules.mixedMargin} pts (both ≥ ${rules.mixedMinScore})${rules.feBeAsFullStack ? " · FE + BE = Full Stack" : ""}${rules.includePlaced ? "" : " · placed left out"}`;
  return (
    <Disclosure title="Bucketing rules" summary={summary}>
      <div className="space-y-5">
        <p className="flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">
          Changing a rule re-buckets instantly. Nothing is read again.
          <InfoHint label="How a bucket is chosen" align="start">
            Each signal scores Frontend, Backend, AI-ML and Full Stack 0-100; they are averaged by weight. The highest bucket wins. When the
            runner-up is within the margin and both reach the minimum, the candidate goes to Mixed (tagged &ldquo;verify over call on
            priority&rdquo;). Frontend, Backend and Full Stack close together count as Full Stack: alone that makes the candidate Full
            Stack, beside a close AI-ML it makes Mixed (Full Stack + AI-ML).
          </InfoHint>
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mixed when within (points)" htmlFor="ac-margin" hint="Second bucket this close to the first">
            <Input id="ac-margin" type="number" min={0} max={50} className="tabular-nums" value={rules.mixedMargin} onChange={(e) => set({ mixedMargin: num(e.target.value, 0, 50) })} />
          </Field>
          <Field label="… and both at least" htmlFor="ac-minmix" hint="A weak runner-up never makes Mixed">
            <Input id="ac-minmix" type="number" min={0} max={100} className="tabular-nums" value={rules.mixedMinScore} onChange={(e) => set({ mixedMinScore: num(e.target.value, 0, 100) })} />
          </Field>
        </div>
        <SettingList>
          <SettingRow
            id="ac-febe"
            title="Frontend and Backend close together = Full Stack"
            description="Off: a near tie between Frontend, Backend and Full Stack goes to Mixed too."
            checked={rules.feBeAsFullStack}
            onCheckedChange={(v) => set({ feBeAsFullStack: v })}
          />
          <SettingRow
            id="ac-placed"
            title="Bucket already-placed candidates"
            description="Active Pool candidates who are placed are ranked after the not-placed ones (P2)."
            checked={rules.includePlaced}
            onCheckedChange={(v) => set({ includePlaced: v })}
          />
        </SettingList>
        <div className="space-y-2">
          <p className="text-[13px] font-medium">Signal weights</p>
          <div className="grid gap-3 sm:grid-cols-4">
            {(["resume", "github", "competency", "preference"] as const).map((k) => (
              <Field key={k} label={k === "competency" ? "Competency TR" : k[0].toUpperCase() + k.slice(1)} htmlFor={`ac-w-${k}`}>
                <Input
                  id={`ac-w-${k}`}
                  type="number"
                  min={0}
                  max={100}
                  className="tabular-nums"
                  value={rules.weights[k]}
                  onChange={(e) => set({ weights: { ...rules.weights, [k]: num(e.target.value, 0, 100) } })}
                />
              </Field>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="flex items-center gap-1 text-[13px] font-medium">
            Ranking inside a bucket
            <InfoHint align="start">
              P1 (Active, not placed) always comes before P2 (Active, placed). Inside each, the priority score is the weighted average of stack
              fit, the best internal assessment (competency score, DSA Offline, old bucket A 70 · B 45 · C 30 · D 15 moved by its TR rounds) and DSA.
              Fit is discounted when little evidence backs the bucket (only the preference note: 55%). Ties go to the better old bucket.
            </InfoHint>
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {(["fit", "assessment", "dsa"] as const).map((k) => (
              <Field key={k} label={k === "fit" ? "Stack fit" : k === "dsa" ? "DSA" : "Assessments"} htmlFor={`ac-r-${k}`}>
                <Input
                  id={`ac-r-${k}`}
                  type="number"
                  min={0}
                  max={100}
                  className="tabular-nums"
                  value={rules.rankWeights[k]}
                  onChange={(e) => set({ rankWeights: { ...rules.rankWeights, [k]: num(e.target.value, 0, 100) } })}
                />
              </Field>
            ))}
          </div>
        </div>
      </div>
    </Disclosure>
  );
}

export interface NudgePreview {
  /** Full Stack candidates the nudge moves now. */
  moves: number;
  fullstack: number;
  backend: number;
}

/**
 * Temporary rebalancing: Full Stack candidates whose own web work (projects, internships, repos)
 * is mostly backend move to Backend. Shown openly — it changes the distribution.
 */
export function AcNudgePanel({ rules, onChange, preview }: { rules: AcRules; onChange: (r: AcRules) => void; preview?: NudgePreview }) {
  const n = rules.nudge;
  const set = (patch: Partial<AcRules["nudge"]>) => onChange({ ...rules, nudge: { ...n, ...patch } });
  return (
    <Panel
      icon={<ArrowRightLeft />}
      title="Rebalance: Full Stack → Backend"
      description="Temporary. Moves Full Stack candidates whose own work is mostly backend into Backend, for a fairer spread across mentors."
    >
      <SettingList>
        <SettingRow
          id="ac-nudge"
          title="Nudge backend-leaning Full Stack candidates"
          description={
            preview && n.enabled
              ? `Moving ${preview.moves} now — Backend ${preview.backend}, Full Stack ${preview.fullstack}.`
              : "Off: every candidate stays in the bucket their evidence scored highest."
          }
          info="Backend share = the backend part of the candidate's own frontend + backend work: backend-only projects / internships / repos count fully, full-stack ones by the side the resume says they worked on (or, failing that, their technologies by layer — a MERN app is 50/50). Skills lists and interviews don't count. The most backend-leaning move first; low-trust candidates are never moved. Each moved candidate is tagged to verify over call."
          checked={n.enabled}
          onCheckedChange={(v) => set({ enabled: v })}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Backend share of their work (%)" htmlFor="ac-nudge-share" hint="At least">
              <Input id="ac-nudge-share" type="number" min={50} max={100} className="tabular-nums" value={n.minBackendShare} onChange={(e) => set({ minBackendShare: num(e.target.value, 50, 100) })} />
            </Field>
            <Field label="Backend score" htmlFor="ac-nudge-score" hint="At least (0-100)">
              <Input id="ac-nudge-score" type="number" min={0} max={100} className="tabular-nums" value={n.minBackendScore} onChange={(e) => set({ minBackendScore: num(e.target.value, 0, 100) })} />
            </Field>
            <Field label="Move at most" htmlFor="ac-nudge-max" hint="0 = half the Full Stack − Backend gap">
              <Input id="ac-nudge-max" type="number" min={0} max={500} className="tabular-nums" value={n.maxMoves} onChange={(e) => set({ maxMoves: num(e.target.value, 0, 500) })} />
            </Field>
          </div>
        </SettingRow>
      </SettingList>
    </Panel>
  );
}
