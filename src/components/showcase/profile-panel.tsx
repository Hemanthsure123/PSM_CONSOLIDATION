"use client";

import * as React from "react";
import { Check, FileText, Loader2, Plus, RotateCcw, Sparkles, Target, Trash2, Undo2, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import { Textarea } from "@/components/ui/textarea";
import { BarFields, NumberField } from "@/components/showcase/showcase-rules";
import { AUTOFILL_ACCEPT, AUTOFILL_MAX_BYTES } from "@/lib/domain-autofill-rules";
import { DEFINES_MAX, GOOD_TO_HAVE_MAX, MANDATORY_MAX_ITEMS, PROFILE_MAX, REASON_LABEL, newProfile, nextProfileId, profileReady } from "@/lib/showcase/profile-rules";
import type { SpMandatoryItem, SpProfileDef, SpProfileInputs, SpReasonKey } from "@/lib/showcase/types";
import { cn } from "@/lib/utils";

/** What /api/showcase/autofill returns (profile-autofill.ts). */
interface ProfileDraft {
  name: string;
  definesIt: string;
  mandatory: SpMandatoryItem[];
  goodToHave: string[];
  notJudged: string[];
  inputs: SpProfileInputs;
  reasons: Partial<Record<SpReasonKey, string>>;
  dropped: string[];
  verified: boolean;
  ignored: string[];
  source: { kind: string; name: string; chars: number };
  model: string;
}

const CLIENT_TIMEOUT_MS = 170_000;
const ACCEPTED = AUTOFILL_ACCEPT.split(",");

/** One line describing a profile's inputs (for closed panels and the review). */
export function inputsSummary(i: SpProfileInputs): string {
  return [
    i.dsaRequired ? `DSA CF ${i.dsa.codeforces} / CC ${i.dsa.codechef} / LC ${i.dsa.leetcode}+${i.dsa.leetcodeSolved}` : "DSA not required",
    `strong ≥ ${i.strongProject}`,
    i.requireVerified ? `verified in code (${i.proof.minOwnCommits}+ commits)` : "code proof off",
    i.minExperienceMonths ? `${i.minExperienceMonths}+ months experience` : "",
    `fit ≥ ${i.minFit}`,
    `top ${i.topN}`,
    i.trustAgent ? "" : "trust off",
  ]
    .filter(Boolean)
    .join(" · ");
}

async function techKeys(items: { item: string; quote: string }[]): Promise<SpMandatoryItem[] | null> {
  try {
    const res = await fetch("/api/showcase/techkeys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    const data = (await res.json().catch(() => ({}))) as { items?: SpMandatoryItem[] };
    return res.ok && Array.isArray(data.items) ? data.items : null;
  } catch {
    return null;
  }
}

interface PanelProps {
  profiles: SpProfileDef[];
  onChange: (next: SpProfileDef[]) => void;
  disabled?: boolean;
  /** Results screen: the cards start closed and say that edits re-rank instantly. */
  compact?: boolean;
}

/**
 * Sample profiles from job descriptions — the profiles of a run. Each one is drafted from a JD
 * or any context about the role (domain name, a strict "what defines it", mandatory items to
 * verify, good to have, and every input with the reason the JD gives), reviewed, and editable.
 */
export function ProfilePanel({ profiles, onChange, disabled, compact }: PanelProps) {
  const update = (id: string, next: SpProfileDef) => onChange(profiles.map((p) => (p.id === id ? next : p)));
  const ready = profiles.filter(profileReady).length;
  return (
    <Panel
      icon={<Target />}
      title={
        <span className="inline-flex items-center gap-1">
          Sample profiles from job descriptions
          <InfoHint label="How profiles work" align="start">
            Each profile is one job. Draft it from the JD (or any context about the role): the model fills the domain name, a strict definition of
            a showcase-grade candidate, the mandatory items that must be verified, the good-to-have items, and every input of the run — the DSA
            bar (or none), project and proof thresholds, experience, the fit bar, cut-offs and how many profiles to send — each with the reason
            the JD gives. You review and can change anything. Candidates are judged only from projects, experience, certifications and
            achievements (never the Skills list), mandatory technologies must be shown in their own code when the profile asks for it, and each
            profile gets its own tab, ranked by fit.
          </InfoHint>
        </span>
      }
      description={
        compact
          ? "Editing a definition re-checks the profile fit on Continue; editing an input re-ranks instantly."
          : `${profiles.length} profile${profiles.length === 1 ? "" : "s"} · ${ready} ready. Up to ${PROFILE_MAX} per run — one tab each.`
      }
      footer={
        profiles.length < PROFILE_MAX ? (
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...profiles, newProfile(nextProfileId(profiles))])}>
            <Plus className="h-4 w-4" /> Add a profile
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{PROFILE_MAX} profiles is the most one run takes.</span>
        )
      }
    >
      <div className="space-y-4">
        {profiles.map((p, n) => (
          <ProfileCard
            key={p.id}
            index={n + 1}
            profile={p}
            disabled={disabled}
            compact={compact}
            onChange={(next) => update(p.id, next)}
            onRemove={profiles.length > 1 ? () => onChange(profiles.filter((x) => x.id !== p.id)) : undefined}
          />
        ))}
      </div>
    </Panel>
  );
}

function ProfileCard({
  index,
  profile: p,
  onChange,
  onRemove,
  disabled,
  compact,
}: {
  index: number;
  profile: SpProfileDef;
  onChange: (p: SpProfileDef) => void;
  onRemove?: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = React.useState(!compact);
  const [mandatoryText, setMandatoryText] = React.useState(p.mandatory.map((m) => m.item).join("\n"));
  const [goodText, setGoodText] = React.useState(p.goodToHave.join(", "));
  const [keysBusy, setKeysBusy] = React.useState(false);
  const id = `sp-prof-${p.id}`;

  // Keep the text boxes in step when the profile changes from outside (autofill, undo).
  React.useEffect(() => setMandatoryText(p.mandatory.map((m) => m.item).join("\n")), [p.mandatory]);
  React.useEffect(() => setGoodText(p.goodToHave.join(", ")), [p.goodToHave]);

  const commitMandatory = async () => {
    const lines = [...new Set(mandatoryText.split(/\n+/).map((l) => l.replace(/^[\s•\-*\d.)]+/, "").trim()).filter(Boolean))].slice(0, MANDATORY_MAX_ITEMS);
    const same = lines.length === p.mandatory.length && lines.every((l, k) => l === p.mandatory[k].item);
    if (same) return;
    setKeysBusy(true);
    const quoted = lines.map((item) => ({ item, quote: p.mandatory.find((m) => m.item === item)?.quote ?? "" }));
    const items = (await techKeys(quoted)) ?? quoted.map((m) => ({ ...m, keys: [], labels: [], mode: /\bor\b|\//i.test(m.item) ? ("any" as const) : ("all" as const) }));
    setKeysBusy(false);
    onChange({ ...p, mandatory: items });
  };
  const commitGood = () => {
    const items = [...new Set(goodText.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean))].slice(0, GOOD_TO_HAVE_MAX);
    if (items.join("|") !== p.goodToHave.join("|")) onChange({ ...p, goodToHave: items });
  };

  const checkable = p.mandatory.filter((m) => m.keys.length);
  const title = p.name.trim() || `Profile ${index}`;
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <p className="truncate text-[14px] font-semibold">
            {index}. {title}
            {!profileReady(p) ? <span className="ml-2 text-xs font-normal text-warning">needs a name and a definition</span> : null}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {p.mandatory.length ? `Mandatory: ${p.mandatory.map((m) => m.item).join(", ")} · ` : ""}
            {inputsSummary(p.inputs)}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Edit"}
          </Button>
          {onRemove ? (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRemove} aria-label={`Remove ${title}`}>
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div hidden={!open} className="space-y-4 border-t px-4 py-4">
        <ProfileAutofill profile={p} onApply={onChange} disabled={disabled} startOpen={!p.definesIt.trim()} />

        <Field label="Domain name" htmlFor={`${id}-name`} hint="The tab's name, e.g. “Backend Engineer — Java / Spring Boot”.">
          <Input id={`${id}-name`} value={p.name} disabled={disabled} maxLength={80} onChange={(e) => onChange({ ...p, name: e.target.value })} />
        </Field>
        <Field
          label="What defines it"
          htmlFor={`${id}-def`}
          hint="What a showcase-grade candidate for this job has built and done. Stricter than a shortlist: the top few, not an average fit."
          aside={<span className={cn("tabular-nums", p.definesIt.length > DEFINES_MAX && "text-destructive")}>{p.definesIt.length}/{DEFINES_MAX}</span>}
        >
          <Textarea id={`${id}-def`} rows={5} value={p.definesIt} disabled={disabled} onChange={(e) => onChange({ ...p, definesIt: e.target.value.slice(0, DEFINES_MAX) })} className="text-[13px]" />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Mandatory — verified"
            htmlFor={`${id}-mand`}
            hint={`One per line, at most ${MANDATORY_MAX_ITEMS}. Each must be proven in the projects / experience; “React or Angular” accepts either.`}
            info="A candidate missing any mandatory item isn't shown. The judge must quote the resume's projects, experience, certifications or achievements — never the Skills list. Technologies named here are also looked for before the model read (a resume that never names them isn't read), and, when the profile requires code proof, must be shown in the candidate's own verified repositories."
          >
            <Textarea
              id={`${id}-mand`}
              rows={4}
              value={mandatoryText}
              disabled={disabled}
              onChange={(e) => setMandatoryText(e.target.value)}
              onBlur={() => void commitMandatory()}
              className="text-[13px]"
              placeholder={"e.g.\nReact or Angular\nNode.js REST APIs\nMongoDB"}
            />
          </Field>
          <Field label="Good to have" htmlFor={`${id}-good`} hint="Comma-separated. Looked for in the resume; they lift the fit, never gate.">
            <Textarea id={`${id}-good`} rows={4} value={goodText} disabled={disabled} onChange={(e) => setGoodText(e.target.value)} onBlur={commitGood} className="text-[13px]" />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          {keysBusy ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Checking which mandatory items code can prove…
            </span>
          ) : checkable.length ? (
            <>
              Checked in their code{p.inputs.requireVerified ? "" : " (code proof is off for this profile)"}:{" "}
              {[...new Set(checkable.map((m) => m.labels.join(m.mode === "any" ? " or " : " + ")))].map((label) => (
                <Badge key={label} variant="secondary" className="mr-1">
                  {label}
                </Badge>
              ))}
            </>
          ) : p.mandatory.length ? (
            "No mandatory item names a technology the code can show — they are checked in the resume's projects and experience only."
          ) : (
            "No mandatory items — candidates are judged on the definition and the inputs below."
          )}
        </p>
        {p.notJudged.length ? <p className="text-xs text-muted-foreground">Not judged from resumes: {p.notJudged.join(" · ")}</p> : null}

        <InputsEditor profile={p} onChange={onChange} disabled={disabled} />
      </div>
    </div>
  );
}

function Reason({ text }: { text?: string }) {
  return text ? <p className="text-xs italic text-muted-foreground">From the JD: {text}</p> : null;
}

/** Every input of one profile, with the reason the JD gave, and a reset to the JD's values. */
function InputsEditor({ profile: p, onChange, disabled }: { profile: SpProfileDef; onChange: (p: SpProfileDef) => void; disabled?: boolean }) {
  const i = p.inputs;
  const set = (patch: Partial<SpProfileInputs>) => onChange({ ...p, inputs: { ...i, ...patch } });
  const setProof = (patch: Partial<SpProfileInputs["proof"]>) => set({ proof: { ...i.proof, ...patch } });
  const setW = (patch: Partial<SpProfileInputs["weights"]>) => set({ weights: { ...i.weights, ...patch } });
  const changed = p.llmInputs && JSON.stringify(p.llmInputs) !== JSON.stringify(i);
  const id = `sp-in-${p.id}`;
  const r = p.reasons;
  return (
    <Disclosure title={p.llmInputs ? "Inputs set from the JD" : "Inputs"} summary={`${inputsSummary(i)}${changed ? " · edited" : ""}`}>
      <div className="space-y-6">
        {p.llmInputs ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-muted-foreground">{changed ? "You changed some of the JD's values." : "These are the values drafted from the JD."}</p>
            {changed ? (
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange({ ...p, inputs: structuredClone(p.llmInputs!) })}>
                <RotateCcw className="h-4 w-4" /> Reset to the JD&apos;s values
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2">
          <SettingList>
            <SettingRow id={`${id}-dsa`} title="DSA required" description="Cleared on any one platform, with the minimum rated contests." checked={i.dsaRequired} disabled={disabled} onCheckedChange={(v) => set({ dsaRequired: v })}>
              <BarFields prefix={`${id}-bar`} bar={i.dsa} onChange={(dsa) => set({ dsa })} />
            </SettingRow>
          </SettingList>
          <Reason text={r.dsa} />
        </div>

        <div className="space-y-2">
          <p className="text-[13px] font-medium">{REASON_LABEL.projects}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id={`${id}-strong`} label="Strong project at" hint="quality after caps" value={i.strongProject} min={50} max={95} onChange={(n) => set({ strongProject: n })} />
            <NumberField id={`${id}-exc`} label="Exceptional project at" hint="1 of these + experience" value={i.exceptionalProject} min={55} max={100} onChange={(n) => set({ exceptionalProject: n })} />
          </div>
          <Reason text={r.projects} />
        </div>

        <div className="space-y-2">
          <SettingList>
            <SettingRow
              id={`${id}-verified`}
              title="Verified in their own code"
              description="A strong relevant project, and every mandatory technology the code can show, proven in their own repositories."
              checked={i.requireVerified}
              disabled={disabled}
              onCheckedChange={(v) => set({ requireVerified: v })}
            >
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-4">
                  <NumberField id={`${id}-own`} label="Own commits ≥" value={i.proof.minOwnCommits} min={1} max={100} onChange={(n) => setProof({ minOwnCommits: n })} />
                  <NumberField id={`${id}-share`} label="Their share ≥ (%)" value={Math.round(i.proof.minShare * 100)} min={10} max={100} onChange={(n) => setProof({ minShare: n / 100 })} />
                  <NumberField id={`${id}-days`} label="Active days ≥" value={i.proof.minDays} min={1} max={60} onChange={(n) => setProof({ minDays: n })} />
                  <NumberField id={`${id}-src`} label="Source files ≥" value={i.proof.minSrcFiles} min={1} max={200} onChange={(n) => setProof({ minSrcFiles: n })} />
                </div>
                <SettingList>
                  <SettingRow
                    id={`${id}-ai`}
                    title="Accept repos with AI app-generator traces"
                    checked={i.proof.allowAiTraces}
                    disabled={disabled}
                    onCheckedChange={(v) => setProof({ allowAiTraces: v })}
                  />
                </SettingList>
              </div>
            </SettingRow>
          </SettingList>
          <Reason text={r.verified} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <NumberField id={`${id}-exp`} label="Relevant experience ≥ (months)" hint="0 = a bonus, not required" value={i.minExperienceMonths} min={0} max={60} onChange={(n) => set({ minExperienceMonths: n })} />
            <Reason text={r.experience} />
          </div>
          <div className="space-y-1">
            <NumberField id={`${id}-fit`} label="Fit to the profile ≥" hint="judged 0-100" value={i.minFit} min={40} max={95} onChange={(n) => set({ minFit: n })} />
            <Reason text={r.fit} />
          </div>
          <div className="space-y-1">
            <NumberField id={`${id}-topn`} label="Profiles to send" hint="company workbook" value={i.topN} min={1} max={30} onChange={(n) => set({ topN: n })} />
            <Reason text={r.topN} />
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[13px] font-medium">{REASON_LABEL.weights} and cut-offs</p>
          <div className="grid gap-3 sm:grid-cols-5">
            <NumberField id={`${id}-wp`} label="Projects" value={i.weights.projects} min={0} max={100} onChange={(n) => setW({ projects: n })} />
            <NumberField id={`${id}-wd`} label="DSA" value={i.weights.dsa} min={0} max={100} onChange={(n) => setW({ dsa: n })} />
            <NumberField id={`${id}-we`} label="GitHub" value={i.weights.engineering} min={0} max={100} onChange={(n) => setW({ engineering: n })} />
            <NumberField id={`${id}-wf`} label="Fit" value={i.weights.fit} min={0} max={100} onChange={(n) => setW({ fit: n })} />
            <NumberField id={`${id}-wx`} label="Experience bonus" hint="points" value={i.weights.experience} min={0} max={40} onChange={(n) => setW({ experience: n })} />
          </div>
          <Reason text={r.weights} />
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField id={`${id}-sc`} label="Showcase at" hint="profile score" value={i.showcaseAt} min={50} max={95} onChange={(n) => set({ showcaseAt: n, strongAt: Math.min(i.strongAt, n) })} />
            <NumberField id={`${id}-st`} label="Strong at" hint="below: not shown" value={i.strongAt} min={30} max={95} onChange={(n) => set({ strongAt: Math.min(n, i.showcaseAt) })} />
          </div>
          <Reason text={r.tiers} />
        </div>

        <div className="space-y-2">
          <SettingList>
            <SettingRow
              id={`${id}-trust`}
              title="Trust agent"
              description="A second model checks whether the profile can be trusted. Low trust is excluded; Showcase needs High."
              checked={i.trustAgent}
              disabled={disabled}
              onCheckedChange={(v) => set({ trustAgent: v })}
            />
          </SettingList>
          <Reason text={r.trust} />
        </div>
      </div>
    </Disclosure>
  );
}

/** "Draft the profile from a JD": paste or upload, review the draft, apply (with undo). */
function ProfileAutofill({ profile, onApply, disabled, startOpen }: { profile: SpProfileDef; onApply: (p: SpProfileDef) => void; disabled?: boolean; startOpen: boolean }) {
  const [open, setOpen] = React.useState(startOpen);
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [draft, setDraft] = React.useState<ProfileDraft | null>(null);
  const [undo, setUndo] = React.useState<SpProfileDef | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const regionId = React.useId();

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const pick = (f: File | null) => {
    setFileError("");
    if (!f) return setFile(null);
    const ext = `.${f.name.split(".").pop()?.toLowerCase() ?? ""}`;
    if (!ACCEPTED.includes(ext)) return setFileError("Upload a PDF, Word (.docx), text, HTML or image file.");
    if (f.size > AUTOFILL_MAX_BYTES) return setFileError(`The file is larger than ${AUTOFILL_MAX_BYTES / 1024 / 1024} MB.`);
    setFile(f);
  };

  const generate = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
    setLoading(true);
    setError("");
    setDraft(null);
    try {
      const fd = new FormData();
      fd.set("text", text);
      if (file) fd.set("file", file);
      const res = await fetch("/api/showcase/autofill", { method: "POST", body: fd, signal: ctrl.signal });
      const data = (await res.json().catch(() => ({}))) as { result?: ProfileDraft; error?: string };
      if (!res.ok || !data.result) throw new Error(data.error || `The server returned HTTP ${res.status}.`);
      setDraft(data.result);
    } catch (err) {
      if (ctrl.signal.aborted && abortRef.current !== ctrl) return;
      setError(ctrl.signal.aborted ? "It took too long — try again, or paste the text instead of a scanned file." : err instanceof Error ? err.message : "Could not read the job description.");
    } finally {
      clearTimeout(timer);
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  };

  const apply = () => {
    if (!draft) return;
    setUndo(profile);
    onApply({
      ...profile,
      name: draft.name || profile.name,
      definesIt: draft.definesIt,
      mandatory: draft.mandatory,
      goodToHave: draft.goodToHave,
      notJudged: draft.notJudged,
      inputs: structuredClone(draft.inputs),
      llmInputs: structuredClone(draft.inputs),
      reasons: draft.reasons,
      source: draft.source,
      model: draft.model,
      draftedAt: new Date().toISOString(),
    });
    setDraft(null);
    setOpen(false);
  };

  const ready = Boolean(file || text.trim().length >= 40);
  const filled = Boolean(profile.definesIt.trim());
  return (
    <div className="rounded-lg border border-dashed bg-muted/30">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 basis-72">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Draft from a job description
          </p>
          <p className="text-xs text-muted-foreground">
            Paste or upload the JD (or any context about the role). The model fills every field and input below, each with its reason; you review
            first.
            {profile.source ? ` Last drafted from ${profile.source.name} · ${profile.model}.` : ""}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : filled ? "Draft again" : "Draft from JD"}
        </Button>
      </div>

      {undo && !draft ? (
        <div className="border-t px-4 py-2.5">
          <Notice
            tone="success"
            action={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onApply(undo);
                  setUndo(null);
                }}
              >
                <Undo2 className="h-4 w-4" /> Undo
              </Button>
            }
          >
            Drafted from the job description — review the fields and inputs below.
          </Notice>
        </div>
      ) : null}

      <div id={regionId} hidden={!open} className="space-y-3 border-t px-4 py-3">
        <Textarea
          aria-label="Job description or context"
          rows={6}
          value={text}
          disabled={disabled || loading}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the job description — responsibilities, requirements, stack, CTC — or any notes about what the client wants."
          className="text-[13px]"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={AUTOFILL_ACCEPT}
            className="hidden"
            onChange={(e) => {
              pick(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={() => inputRef.current?.click()}>
            <Upload className="h-4 w-4" /> {file ? "Replace file" : "Upload JD"}
          </Button>
          {file ? (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-[13px]">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate" title={file.name}>
                {file.name}
              </span>
              <button
                type="button"
                aria-label="Remove the file"
                disabled={loading}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25"
                onClick={() => setFile(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">PDF, Word (.docx), text, HTML or an image — up to 10 MB</span>
          )}
          <Button type="button" size="sm" className="ml-auto" disabled={disabled || loading || !ready} onClick={() => void generate()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {loading ? "Reading…" : "Draft the profile"}
          </Button>
        </div>
        {fileError ? (
          <p className="text-xs text-destructive" role="alert">
            {fileError}
          </p>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {loading ? "Reading the job description" : draft ? "Draft ready for review" : ""}
        </p>
        {error ? (
          <Notice
            tone="danger"
            action={
              <Button type="button" variant="ghost" size="sm" onClick={() => void generate()} disabled={!ready}>
                Try again
              </Button>
            }
          >
            {error}
          </Notice>
        ) : null}

        {draft ? <DraftPreview draft={draft} /> : null}
        {draft ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button type="button" size="sm" onClick={apply}>
              <Check className="h-4 w-4" /> {filled ? "Replace this profile" : "Apply to the profile"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DraftPreview({ draft }: { draft: ProfileDraft }) {
  return (
    <div className="space-y-3 rounded-lg border bg-card px-4 py-3 text-[13px]">
      <p className="text-xs text-muted-foreground">
        Read {draft.source.name} ({draft.source.chars.toLocaleString("en-IN")} characters{draft.verified ? "" : ", scanned — mandatory items not checked word for word"}) · {draft.model}
      </p>
      {draft.ignored.length ? (
        <p className="text-xs text-warning">
          Ignored {draft.ignored.length} sentence(s) that gave instructions instead of describing the job: “{draft.ignored[0]}”{draft.ignored.length > 1 ? " …" : ""}
        </p>
      ) : null}
      <Row label="Domain name">{draft.name || <span className="text-muted-foreground">—</span>}</Row>
      <Row label="What defines it">
        <p className="whitespace-pre-wrap leading-relaxed">{draft.definesIt}</p>
      </Row>
      <Row label="Mandatory — verified">
        {draft.mandatory.length ? (
          <div className="flex flex-wrap gap-1.5">
            {draft.mandatory.map((m) => (
              <Badge key={m.item} variant="outline" title={m.quote ? `JD: “${m.quote}”` : undefined}>
                {m.item}
                {m.labels.length ? <span className="text-muted-foreground"> · code: {m.labels.join(m.mode === "any" ? " or " : " + ")}</span> : null}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">None — the JD states no hard requirement a resume or code can show.</p>
        )}
        {draft.dropped.length ? <p className="mt-1.5 text-xs text-muted-foreground">Left out: {draft.dropped.join("; ")}</p> : null}
      </Row>
      {draft.goodToHave.length ? <Row label="Good to have">{draft.goodToHave.join(", ")}</Row> : null}
      <Row label="Inputs">
        <p>{inputsSummary(draft.inputs)}</p>
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {(Object.keys(REASON_LABEL) as SpReasonKey[])
            .filter((k) => draft.reasons[k])
            .map((k) => (
              <li key={k}>
                <span className="font-medium text-foreground">{REASON_LABEL[k]}:</span> {draft.reasons[k]}
              </li>
            ))}
        </ul>
      </Row>
      {draft.notJudged.length ? (
        <Row label="Not judged from resumes">
          <p className="text-xs text-muted-foreground">{draft.notJudged.join(" · ")}</p>
        </Row>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
