"use client";

import * as React from "react";
import { Code2, ShieldCheck } from "lucide-react";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import type { SpDsaBar, SpRules } from "@/lib/showcase/types";

const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

function NumberField({ id, label, hint, value, min, max, onChange }: { id: string; label: string; hint?: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input id={id} type="number" min={min} max={max} className="tabular-nums" value={value} onChange={(e) => onChange(num(e.target.value, min, max))} />
    </Field>
  );
}

function BarFields({ prefix, bar, onChange }: { prefix: string; bar: SpDsaBar; onChange: (b: SpDsaBar) => void }) {
  const set = (patch: Partial<SpDsaBar>) => onChange({ ...bar, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-5">
      <NumberField id={`${prefix}-cf`} label="Codeforces ≥" hint="highest rating" value={bar.codeforces} min={0} max={4000} onChange={(n) => set({ codeforces: n })} />
      <NumberField id={`${prefix}-cc`} label="CodeChef ≥" hint="highest rating" value={bar.codechef} min={0} max={4000} onChange={(n) => set({ codechef: n })} />
      <NumberField id={`${prefix}-lc`} label="LeetCode ≥" hint="contest rating" value={bar.leetcode} min={0} max={4000} onChange={(n) => set({ leetcode: n })} />
      <NumberField id={`${prefix}-lcs`} label="… with solved ≥" hint="LeetCode problems" value={bar.leetcodeSolved} min={0} max={5000} onChange={(n) => set({ leetcodeSolved: n })} />
      <NumberField id={`${prefix}-mc`} label="Rated contests ≥" hint="on that platform" value={bar.minContests} min={0} max={200} onChange={(n) => set({ minContests: n })} />
    </div>
  );
}

/** The DSA bar — mandatory for every role, cleared on any one platform. Always in view. */
export function SpDsaBarPanel({ rules, onChange, note }: { rules: SpRules; onChange: (r: SpRules) => void; note?: React.ReactNode }) {
  return (
    <Panel
      icon={<Code2 />}
      title={
        <span className="inline-flex items-center gap-1">
          DSA bar
          <InfoHint label="How the DSA bar works" align="start">
            Mandatory for every role. A candidate clears it on any one platform: Codeforces or CodeChef by their highest rating, or LeetCode by
            the current contest rating together with the problems solved — always with the minimum number of rated contests, so one lucky
            contest can&apos;t pass. Only profiles linked from the resume or the sheet count (a handle only written in the text counts once the
            profile&apos;s owner name matches). A profile whose owner name is someone else&apos;s, or a handle on two rows, counts for nobody.
            Profiles are read Codeforces → LeetCode → CodeChef and stop at the first that clears, so lowering the bar re-reads nothing known and
            raising it re-reads only what&apos;s needed.
          </InfoHint>
        </span>
      }
      description={note ?? "Codeforces OR CodeChef OR LeetCode (rating and solved). Changing it re-ranks instantly."}
    >
      <BarFields prefix="sp-bar" bar={rules.dsa} onChange={(dsa) => onChange({ ...rules, dsa })} />
    </Panel>
  );
}

/** Everything else — strict defaults, rarely changed, so closed. Changing a rule re-ranks instantly. */
export function SpRulesCard({ rules, onChange }: { rules: SpRules; onChange: (r: SpRules) => void }) {
  const set = (patch: Partial<SpRules>) => onChange({ ...rules, ...patch });
  const p = rules.proof;
  const setProof = (patch: Partial<SpRules["proof"]>) => set({ proof: { ...p, ...patch } });
  const w = rules.weights;
  const setW = (patch: Partial<SpRules["weights"]>) => set({ weights: { ...w, ...patch } });
  const summary = `strong ≥ ${rules.strongProject} · ${p.minOwnCommits}+ own commits · Showcase ≥ ${rules.showcaseAt} · top ${rules.topN}${rules.everyRole ? " · every role" : ""}${rules.trustAgent ? "" : " · trust off"}`;
  return (
    <Disclosure title="Profile rules" summary={summary}>
      <div className="space-y-6">
        <p className="text-[13px] text-muted-foreground">Changing a rule re-ranks instantly. Nothing is read again.</p>

        <div className="space-y-2">
          <p className="flex items-center gap-1 text-[13px] font-medium">
            Strong projects
            <InfoHint align="start">
              The model scores each project 0-100 against what a product company hiring at 15+ LPA expects in that role. The program then caps it:
              course / tutorial / clone work 40 (NxtWave course apps, ccbp.tech links, a title on 3+ resumes of the sheet), common tutorial builds
              45, basic depth 55, and by the complexity signals the resume quotes or the code backs — none 60, one 72, two 82, three 90.
              A role needs 2 strong projects, or 1 exceptional one plus 3+ months of in-role experience.
            </InfoHint>
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id="sp-strong" label="Strong project at" hint="quality after caps" value={rules.strongProject} min={0} max={100} onChange={(n) => set({ strongProject: n })} />
            <NumberField id="sp-exc" label="Exceptional project at" hint="1 of these + experience" value={rules.exceptionalProject} min={0} max={100} onChange={(n) => set({ exceptionalProject: n })} />
          </div>
        </div>

        <div className="space-y-2">
          <p className="flex items-center gap-1 text-[13px] font-medium">
            Verified in code
            <InfoHint align="start">
              At least one strong project must be proven by the candidate&apos;s own repository: the resume&apos;s link for that project, or a
              repo on their account whose name matches it. Forks never count. Commits are audited one by one (whose they are, AI coding-tool
              signatures); the code has to show the project&apos;s stack (manifests, imports, config). Below these thresholds the project is
              &ldquo;weak&rdquo; — it still counts, at a lower weight, but doesn&apos;t pass this gate.
            </InfoHint>
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <NumberField id="sp-own" label="Own commits ≥" value={p.minOwnCommits} min={0} max={500} onChange={(n) => setProof({ minOwnCommits: n })} />
            <NumberField id="sp-share" label="Their share ≥ (%)" value={Math.round(p.minShare * 100)} min={0} max={100} onChange={(n) => setProof({ minShare: n / 100 })} />
            <NumberField id="sp-days" label="Active days ≥" hint="not a one-day dump" value={p.minDays} min={0} max={365} onChange={(n) => setProof({ minDays: n })} />
            <NumberField id="sp-src" label="Source files ≥" value={p.minSrcFiles} min={0} max={1000} onChange={(n) => setProof({ minSrcFiles: n })} />
          </div>
          <SettingList>
            <SettingRow
              id="sp-ai"
              title="Accept repos with AI app-generator traces"
              description="Off: a repo with Lovable / Bolt / v0-style residue or AI coding-tool commits is weak, not verified."
              checked={p.allowAiTraces}
              onCheckedChange={(v) => setProof({ allowAiTraces: v })}
            />
          </SettingList>
        </div>

        <div className="space-y-2">
          <p className="flex items-center gap-1 text-[13px] font-medium">
            Score and tiers
            <InfoHint align="start">
              Profile score = weighted average of projects (best + 0.6 × second + 0.3 × third, each × how far GitHub proves it), DSA (the bar is
              40, Codeforces 1900 / CodeChef 2100 / LeetCode 2200 is 100) and GitHub engineering (proven projects, code-backed claims, active
              days) — plus experience as a bonus on top (a year of in-role, full-time, product-company work earns all of it). Then × trust
              (0.6 + 0.4 × trust/100). Showcase also needs High trust.
            </InfoHint>
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <NumberField id="sp-w-p" label="Projects weight" value={w.projects} min={0} max={100} onChange={(n) => setW({ projects: n })} />
            <NumberField id="sp-w-d" label="DSA weight" value={w.dsa} min={0} max={100} onChange={(n) => setW({ dsa: n })} />
            <NumberField id="sp-w-e" label="GitHub weight" value={w.engineering} min={0} max={100} onChange={(n) => setW({ engineering: n })} />
            <NumberField id="sp-w-x" label="Experience bonus (pts)" value={w.experience} min={0} max={40} onChange={(n) => setW({ experience: n })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <NumberField id="sp-showcase" label="Showcase at" hint="profile score" value={rules.showcaseAt} min={0} max={100} onChange={(n) => set({ showcaseAt: n })} />
            <NumberField id="sp-strongat" label="Strong at" hint="below: not shown" value={rules.strongAt} min={0} max={100} onChange={(n) => set({ strongAt: n })} />
            <NumberField id="sp-topn" label="Profiles per role" hint="company workbook" value={rules.topN} min={1} max={100} onChange={(n) => set({ topN: n })} />
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[13px] font-medium">SDE tab (any role, elite DSA)</p>
          <BarFields prefix="sp-sde" bar={rules.sdeBar} onChange={(sdeBar) => set({ sdeBar })} />
        </div>

        <SettingList>
          <SettingRow
            id="sp-trust"
            icon={<ShieldCheck />}
            title="Trust agent"
            description="A second model checks whether the profile can be trusted. Low trust is excluded; Showcase needs High."
            info="The program checks the resume carries the sheet's email / mobile and its name matches, the GitHub account's name, the DSA profiles' owners and AI-tool commits in the proven repos. The agent adds doubts (inflated claims, impossible dates, course projects passed off as original, contradictions with the code or the coding profiles), each with the exact words it rests on — flags whose words aren't there are dropped. Score: 100 minus the checks (agent flags high −15, medium −8, low −3, at most −45). High ≥ 80, Medium ≥ 60, Low below."
            checked={rules.trustAgent}
            onCheckedChange={(v) => set({ trustAgent: v })}
          />
          <SettingRow
            id="sp-every"
            title="List candidates in every role they qualify for"
            description="Off: once, in the role of their strongest projects (with “also strong for” the others)."
            checked={rules.everyRole}
            onCheckedChange={(v) => set({ everyRole: v })}
          />
          <SettingRow
            id="sp-links"
            title="Profile links in the company workbook"
            description="GitHub, DSA and project links. They show the candidate's name on those sites."
            checked={rules.companyLinks}
            onCheckedChange={(v) => set({ companyLinks: v })}
          />
        </SettingList>
      </div>
    </Disclosure>
  );
}
