"use client";

import * as React from "react";
import { Check, FileText, Lightbulb, Loader2, Sparkles, Undo2, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import {
  AUTOFILL_ACCEPT,
  AUTOFILL_MAX_BYTES,
  BRIEF_MAX,
  MANDATORY_MAX,
  briefOf,
  type DomainAutofill,
} from "@/lib/domain-autofill-rules";
import { cn } from "@/lib/utils";

export interface DomainFields {
  domainName: string;
  definesIt: string;
  mandatory: string;
}

interface JdAutofillProps {
  /** The fields as they are now (the draft's brief length and the undo depend on them). */
  current: DomainFields;
  onApply: (next: DomainFields) => void;
  disabled?: boolean;
}

const CLIENT_TIMEOUT_MS = 170_000;
const ACCEPTED = AUTOFILL_ACCEPT.split(",");

/**
 * "Autofill from a job description": paste a JD (or any context about the role) or
 * upload it — PDF, Word, text or an image — and get a reviewed draft of "What defines
 * it" and "Mandatory skills". The draft is shown first; nothing changes until "Apply",
 * and "Undo" puts the previous values back. Every other setting stays the user's.
 */
export function JdAutofill({ current, onApply, disabled }: JdAutofillProps) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [draft, setDraft] = React.useState<DomainAutofill | null>(null);
  const [undo, setUndo] = React.useState<DomainFields | null>(null);
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
      fd.set("domainName", current.domainName);
      if (file) fd.set("file", file);
      const res = await fetch("/api/domain/autofill", { method: "POST", body: fd, signal: ctrl.signal });
      const data = (await res.json().catch(() => ({}))) as { result?: DomainAutofill; error?: string };
      if (!res.ok || !data.result) throw new Error(data.error || `The server returned HTTP ${res.status}.`);
      setDraft(data.result);
    } catch (err) {
      if (ctrl.signal.aborted && abortRef.current !== ctrl) return; // superseded by a newer request
      setError(
        ctrl.signal.aborted
          ? "It took too long — try again, or paste the text instead of a scanned file."
          : err instanceof Error
            ? err.message
            : "Could not read the job description.",
      );
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
    setUndo(current);
    onApply({
      // The name is the user's: only filled when they haven't typed one.
      domainName: current.domainName.trim() ? current.domainName : draft.domainName,
      definesIt: draft.definesIt,
      mandatory: draft.mandatory,
    });
    setDraft(null);
  };

  const hasCurrent = Boolean(current.definesIt.trim() || current.mandatory.trim());
  const name = current.domainName.trim() || draft?.domainName || "";
  const briefLength = draft ? briefOf(name, draft.definesIt).length : 0;
  const ready = Boolean(file || text.trim().length >= 40);

  return (
    <div className="rounded-lg border border-dashed bg-muted/30">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 basis-72">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Autofill from a job description
          </p>
          <p className="text-xs text-muted-foreground">
            Paste or upload the JD (or any context about the role) to fill &ldquo;What defines it&rdquo; and &ldquo;Mandatory skills&rdquo;. You
            review it first; everything else stays yours to set.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Autofill from JD"}
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
            Filled from the job description — review and edit the fields below.
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
          placeholder="Paste the job description — responsibilities, requirements, tech stack — or any notes about the role."
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
              <span className="shrink-0 tabular-nums text-muted-foreground">{Math.max(1, Math.round(file.size / 1024))} KB</span>
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
            {loading ? "Reading…" : "Draft the fields"}
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

        {draft ? <DraftPreview draft={draft} name={name} briefLength={briefLength} nameFilled={!current.domainName.trim()} /> : null}
        {draft ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button type="button" size="sm" onClick={apply}>
              <Check className="h-4 w-4" /> {hasCurrent ? "Replace the current values" : "Apply to the fields"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DraftPreview({ draft, name, briefLength, nameFilled }: { draft: DomainAutofill; name: string; briefLength: number; nameFilled: boolean }) {
  return (
    <div className="space-y-3 rounded-lg border bg-card px-4 py-3 text-[13px]">
      <p className="text-xs text-muted-foreground">
        Read {draft.source.name} ({draft.source.chars.toLocaleString("en-IN")} characters{draft.verified ? "" : ", scanned — requirements not checked word for word"}) ·{" "}
        {draft.model}
      </p>
      {draft.ignored.length ? (
        <p className="text-xs text-warning">
          Ignored {draft.ignored.length} sentence(s) in the document that gave instructions instead of describing the job: “{draft.ignored[0]}”
          {draft.ignored.length > 1 ? " …" : ""}
        </p>
      ) : null}
      {nameFilled && draft.domainName ? (
        <Row label="Domain name">
          {draft.domainName} <span className="text-xs text-muted-foreground">(filled because the field is empty)</span>
        </Row>
      ) : null}
      <Row
        label="What defines it"
        aside={
          <span className={cn("tabular-nums", briefLength > BRIEF_MAX && "text-destructive")}>
            {briefLength}/{BRIEF_MAX} with the name
          </span>
        }
      >
        <p className="whitespace-pre-wrap leading-relaxed">{draft.definesIt}</p>
        {name ? null : <p className="mt-1 text-xs text-warning">Type a domain name too — it leads the scoring brief.</p>}
      </Row>
      <Row
        label="Mandatory skills"
        aside={
          <span className="tabular-nums">
            {draft.mandatory.length}/{MANDATORY_MAX}
          </span>
        }
      >
        {draft.mandatoryItems.length ? (
          <div className="flex flex-wrap gap-1.5">
            {draft.mandatoryItems.map((m) => (
              <Badge key={m.item} variant="outline" title={m.quote ? `JD: “${m.quote}”` : undefined}>
                {m.item}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">None — the JD states no hard requirement a resume can show, so no one is gated out.</p>
        )}
        {draft.dropped.length ? <p className="mt-1.5 text-xs text-muted-foreground">Left out: {draft.dropped.join("; ")}</p> : null}
      </Row>
      {draft.github.required.length || draft.github.lookedFor.length ? (
        <Row label="GitHub check">
          <p className="text-xs leading-relaxed">
            {draft.github.required.length ? (
              <>
                <span className="text-muted-foreground">Required:</span> {draft.github.required.join(", ")}
                {draft.github.lookedFor.length ? " · " : ""}
              </>
            ) : null}
            {draft.github.lookedFor.length ? (
              <>
                <span className="text-muted-foreground">Looked for:</span> {draft.github.lookedFor.join(", ")}
              </>
            ) : null}
          </p>
          {draft.github.notInJd.length ? (
            <p className="mt-1 text-xs text-warning">
              Not named in the JD: {draft.github.notInJd.join(", ")} — a word in the draft triggers it; edit the wording if it isn&apos;t wanted.
            </p>
          ) : null}
        </Row>
      ) : null}
      {draft.notJudged.length ? (
        <Row label="Not judged from resumes">
          <p className="text-xs text-muted-foreground">{draft.notJudged.join(" · ")}</p>
        </Row>
      ) : null}
      {draft.settingsHints.length ? (
        <Row label="For your other settings">
          <ul className="space-y-0.5 text-xs">
            {draft.settingsHints.map((h) => (
              <li key={h} className="flex gap-1.5">
                <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                {h}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">Suggestions only — nothing here is switched on for you.</p>
        </Row>
      ) : null}
    </div>
  );
}

function Row({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {aside ? <span className="text-xs text-muted-foreground">{aside}</span> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
