"use client";

import * as React from "react";
import { BarChart3, FileSpreadsheet, Link2, Loader2, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Panel } from "@/components/ui/panel";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/select";
import { SettingList, SettingRow } from "@/components/ui/setting-row";
import { InfoHint } from "@/components/ui/info-hint";
import { Notice } from "@/components/ui/notice";
import { Progress } from "@/components/ui/progress";
import { ActionBar } from "@/components/ui/action-bar";
import { useReportBusy } from "@/components/busy-context";
import { normalizeIdentifier } from "@/lib/utils";
import { listSubsheets, readSubsheet } from "@/actions/sheets";
import { enrichFromBigQuery } from "@/actions/bigquery";
import {
  buildFunnels,
  classifyTrack,
  suggestRoundColumns,
  type AnalyzedCandidate,
  type SheetAnalysis,
} from "@/lib/company-sheet";
import { saveAnalysis, newAnalysisId } from "@/lib/analysis-store";
import { AnalysisView } from "@/components/sheet-analyzer/analysis-view";
import type { IdentifierType } from "@/lib/types";

interface SheetAnalyzerProps {
  onDone: () => void;
}

/** Per-subsheet configuration for the analysis. */
interface SubConfig {
  name: string;
  headers: string[];
  rowCount: number;
  selected: boolean;
  nameColumn: string;
  identifierColumn: string;
  identifierType: IdentifierType;
  roundColumns: string[];
}

const ID_TYPES: { value: IdentifierType; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "uuid", label: "User ID" },
];

/** Find the first header matching any keyword, optionally excluding others. */
function findHeader(headers: string[], include: string[], exclude: string[] = []): string {
  const lower = headers.map((h) => h.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (include.some((s) => h.includes(s)) && !exclude.some((e) => h.includes(e))) {
      return headers[i];
    }
  }
  return "";
}

function detectSub(name: string, headers: string[], rowCount: number): SubConfig {
  const nameCol = findHeader(headers, ["full name", "name", "candidate"], [
    "college",
    "course",
    "department",
    "company",
    "user",
    "father",
    "guardian",
  ]);
  const emailCol = findHeader(headers, ["email", "mail"]);
  const phoneCol = findHeader(headers, ["mobile", "phone", "contact", "whatsapp"]);
  const uuidCol = findHeader(headers, ["user id", "uuid", "candidate id", "student id"]);

  let identifierColumn = emailCol;
  let identifierType: IdentifierType = "email";
  if (!identifierColumn && phoneCol) {
    identifierColumn = phoneCol;
    identifierType = "phone";
  } else if (!identifierColumn && uuidCol) {
    identifierColumn = uuidCol;
    identifierType = "uuid";
  }
  if (!identifierColumn) identifierColumn = headers[0] ?? "";

  return {
    name,
    headers,
    rowCount,
    selected: false,
    nameColumn: nameCol || headers[0] || "",
    identifierColumn,
    identifierType,
    roundColumns: suggestRoundColumns(headers),
  };
}

export function SheetAnalyzer({ onDone }: SheetAnalyzerProps) {
  const [companyName, setCompanyName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [sheetTitle, setSheetTitle] = React.useState("");
  const [subs, setSubs] = React.useState<SubConfig[]>([]);
  const [fetching, setFetching] = React.useState(false);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<SheetAnalysis | null>(null);
  useReportBusy(analyzing);

  const update = (name: string, partial: Partial<SubConfig>) =>
    setSubs((prev) => prev.map((s) => (s.name === name ? { ...s, ...partial } : s)));

  const fetchTabs = async () => {
    setError(null);
    setFetching(true);
    const res = await listSubsheets(url);
    setFetching(false);
    if (!res.ok) {
      setError(res.error);
      setSubs([]);
      setSheetTitle("");
      return;
    }
    setSheetTitle(res.data.title);
    const detected = res.data.subsheets.map((s) => detectSub(s.name, s.headers, s.rowCount));
    // Auto-include when there's only one tab.
    if (detected.length === 1) detected[0].selected = true;
    setSubs(detected);
    if (!companyName.trim()) setCompanyName(res.data.title);
  };

  const selected = subs.filter((s) => s.selected && s.identifierColumn);
  const canAnalyze = companyName.trim().length > 0 && selected.length > 0 && !analyzing;

  const analyze = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      // 1. Read each selected subsheet's rows.
      const loaded: { cfg: SubConfig; rows: Record<string, string>[] }[] = [];
      for (const cfg of selected) {
        const res = await readSubsheet(url, cfg.name);
        if (!res.ok) {
          setError(res.error);
          setAnalyzing(false);
          return;
        }
        loaded.push({ cfg, rows: res.data.rows });
      }

      // 2. Ordered union of the chosen round columns (first seen wins).
      const roundColumns: string[] = [];
      for (const { cfg } of loaded) {
        for (const r of cfg.roundColumns) if (!roundColumns.includes(r)) roundColumns.push(r);
      }

      // 3. Group identifiers by type, then match against BigQuery for source_track.
      const idsByType: Partial<Record<IdentifierType, Set<string>>> = {};
      for (const { cfg, rows } of loaded) {
        const set = idsByType[cfg.identifierType] ?? new Set<string>();
        for (const row of rows) {
          const v = (row[cfg.identifierColumn] ?? "").trim();
          if (v) set.add(v);
        }
        idsByType[cfg.identifierType] = set;
      }

      const lookup: Partial<Record<IdentifierType, Record<string, string>>> = {};
      const notes: string[] = [];
      for (const [type, set] of Object.entries(idsByType) as [IdentifierType, Set<string>][]) {
        if (!set || set.size === 0) continue;
        const res = await enrichFromBigQuery([...set], type, []);
        if (res.ok) {
          const map: Record<string, string> = {};
          for (const [key, enriched] of Object.entries(res.data.matches)) {
            map[key] = enriched.sourceTrack;
          }
          lookup[type] = map;
        } else {
          notes.push(res.error);
        }
      }

      // 4. Build the analysed candidate list.
      const candidates: AnalyzedCandidate[] = [];
      loaded.forEach(({ cfg, rows }) => {
        const typeMap = lookup[cfg.identifierType];
        rows.forEach((row, i) => {
          const identifier = (row[cfg.identifierColumn] ?? "").trim();
          const key = normalizeIdentifier(identifier, cfg.identifierType);
          const hasMatch = Boolean(typeMap && key && key in typeMap);
          const sourceTrack = hasMatch ? typeMap![key] : "";
          const rounds: Record<string, string> = {};
          for (const r of roundColumns) rounds[r] = row[r] ?? "";
          candidates.push({
            id: identifier || `${cfg.name}-${i}`,
            name: (row[cfg.nameColumn] ?? "").trim(),
            identifier,
            subsheet: cfg.name,
            bucket: classifyTrack(sourceTrack, hasMatch),
            matched: hasMatch,
            sourceTrack,
            rounds,
          });
        });
      });

      // 5. Funnels + persisted analysis.
      const { company, stages } = buildFunnels(candidates, roundColumns);
      const note =
        notes.length > 0
          ? `BigQuery lookup failed, so some/all candidates show as “Not tracked”. ${notes.join(" ")}`
          : undefined;

      const analysis: SheetAnalysis = {
        id: newAnalysisId(),
        companyName: companyName.trim(),
        sheetTitle: sheetTitle || "Company sheet",
        createdAt: new Date().toISOString(),
        subsheets: loaded.map(({ cfg }) => cfg.name),
        roundColumns,
        total: candidates.length,
        company,
        stages,
        candidates,
        note,
      };
      saveAnalysis(analysis);
      setResult(analysis);
    } finally {
      setAnalyzing(false);
    }
  };

  if (result) {
    return <AnalysisView analysis={result} onBack={onDone} backLabel="Done — back to dashboard" />;
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Source */}
      <Panel
        title="Company sheet"
        description="The sheet that tracks every candidate sent to the company."
        icon={<FileSpreadsheet />}
      >
        <div className="space-y-4">
          <Field label="Company name" htmlFor="an-company">
            <Input
              id="an-company"
              placeholder="e.g. Acme Corp"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label="Sheet link"
            htmlFor="an-url"
            info="The sheet must be shared with the service account as a Viewer."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="an-url"
                  className="pl-9"
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setSubs([]);
                    setSheetTitle("");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && url.trim() && !fetching && fetchTabs()}
                />
              </div>
              <Button
                variant={subs.length > 0 ? "outline" : "default"}
                onClick={fetchTabs}
                disabled={fetching || !url.trim()}
              >
                {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                {fetching ? "Loading…" : "Load sheet"}
              </Button>
            </div>
          </Field>

          {error && subs.length === 0 ? <Notice tone="danger">{error}</Notice> : null}

          {subs.length > 0 ? (
            <Notice tone="success">
              {sheetTitle} · <span className="tabular-nums">{subs.length}</span> subsheet{subs.length === 1 ? "" : "s"}{" "}
              found. Pick the ones that hold sent candidates below.
            </Notice>
          ) : null}
        </div>
      </Panel>

      {/* Mapping */}
      {subs.length > 0 ? (
        <Panel
          title="Subsheets and columns"
          description="Switch on each tab that holds sent candidates, then check its columns."
          icon={<Table2 />}
        >
          <SettingList>
            {subs.map((sub, i) => (
              <SettingRow
                key={sub.name}
                id={`an-sub-${i}`}
                title={sub.name}
                description={`${sub.rowCount} rows`}
                checked={sub.selected}
                onCheckedChange={(v) => update(sub.name, { selected: v })}
              >
                <div className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Name column" htmlFor={`an-sub-${i}-name`}>
                      <SelectBox
                        id={`an-sub-${i}-name`}
                        value={sub.nameColumn}
                        onChange={(v) => update(sub.name, { nameColumn: v })}
                        options={sub.headers}
                      />
                    </Field>
                    <Field
                      label="Identifier column"
                      htmlFor={`an-sub-${i}-id`}
                      info="Used to match each candidate to their source: Edge, Academy or External."
                    >
                      <SelectBox
                        id={`an-sub-${i}-id`}
                        value={sub.identifierColumn}
                        onChange={(v) => update(sub.name, { identifierColumn: v })}
                        options={sub.headers}
                      />
                    </Field>
                    <Field label="Identifier type" htmlFor={`an-sub-${i}-type`}>
                      <NativeSelect
                        id={`an-sub-${i}-type`}
                        value={sub.identifierType}
                        onChange={(e) => update(sub.name, { identifierType: e.target.value as IdentifierType })}
                      >
                        {ID_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  </div>

                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <Label>
                          Round columns <span className="tabular-nums text-muted-foreground">({sub.roundColumns.length})</span>
                        </Label>
                        <InfoHint align="start">
                          Each selected column becomes a funnel stage. A candidate counts as sent to that round when the
                          cell isn&apos;t blank.
                        </InfoHint>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => update(sub.name, { roundColumns: [...sub.headers] })}
                        >
                          All
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => update(sub.name, { roundColumns: [] })}>
                          None
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => update(sub.name, { roundColumns: suggestRoundColumns(sub.headers) })}
                        >
                          Auto
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {sub.headers.map((h) => {
                        const on = sub.roundColumns.includes(h);
                        return (
                          <label
                            key={h}
                            className={
                              "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px] transition-colors hover:bg-muted/60" +
                              (on ? " border-primary/30 bg-accent/50" : " bg-card")
                            }
                          >
                            <Checkbox
                              checked={on}
                              onCheckedChange={() =>
                                update(sub.name, {
                                  roundColumns: on
                                    ? sub.roundColumns.filter((r) => r !== h)
                                    : [...sub.roundColumns, h],
                                })
                              }
                            />
                            <span className="min-w-0 flex-1 truncate" title={h}>
                              {h}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </SettingRow>
            ))}
          </SettingList>
        </Panel>
      ) : null}

      {error && subs.length > 0 ? <Notice tone="danger">{error}</Notice> : null}

      {subs.length > 0 ? (
        <ActionBar
          status={
            analyzing ? (
              <div className="space-y-2">
                <p>Reading the subsheets and matching each candidate to a source…</p>
                <Progress label="Analyzing the sheet" />
              </div>
            ) : !companyName.trim() ? (
              "Add a company name to analyze."
            ) : selected.length > 0 ? (
              `${selected.length} subsheet${selected.length === 1 ? "" : "s"} selected.`
            ) : (
              "Include at least one subsheet to analyze."
            )
          }
        >
          <Button onClick={analyze} disabled={!canAnalyze}>
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
            {analyzing ? "Analyzing…" : "Analyze & visualize funnel"}
          </Button>
        </ActionBar>
      ) : null}
    </div>
  );
}

function SelectBox({
  id,
  value,
  onChange,
  options,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </NativeSelect>
  );
}
