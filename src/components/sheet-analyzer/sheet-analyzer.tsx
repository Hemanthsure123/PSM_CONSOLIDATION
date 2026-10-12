"use client";

import * as React from "react";
import {
  BarChart3,
  CheckCircle2,
  FileSpreadsheet,
  Home,
  Link2,
  Loader2,
  Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { cn, normalizeIdentifier } from "@/lib/utils";
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
    <div className="space-y-6">
      <Card>
        <CardContent className="flex items-center gap-4 py-4">
          <Button variant="ghost" size="sm" onClick={onDone} className="shrink-0">
            <Home className="h-4 w-4" /> Dashboard
          </Button>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <BarChart3 className="h-4 w-4 text-muted-foreground" /> Analyze Company Sheet
            </h2>
            <p className="text-sm text-muted-foreground">
              Visualize the Edge / Academy / External / Not-tracked funnel across every round.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4" /> Company sheet
          </CardTitle>
          <CardDescription>
            Paste the company sheet link (the drive that tracks every candidate sent to the
            company). It must be shared with the service account (Viewer).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="an-company">Company name</Label>
              <Input
                id="an-company"
                placeholder="e.g. Acme Corp"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
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
            <Button onClick={fetchTabs} disabled={fetching || !url.trim()}>
              {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              {fetching ? "Reading…" : "Fetch Subsheets"}
            </Button>
          </div>

          {error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          ) : null}

          {subs.length > 0 ? (
            <span className="inline-flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              {sheetTitle} · {subs.length} subsheet{subs.length === 1 ? "" : "s"} found. Pick which
              hold sent candidates below.
            </span>
          ) : null}
        </CardContent>
      </Card>

      {/* Configure */}
      {subs.map((sub) => (
        <Card key={sub.name} className={cn(sub.selected && "border-primary/40")}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Table2 className="h-4 w-4 text-muted-foreground" /> {sub.name}
                <Badge variant="secondary">{sub.rowCount} rows</Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {sub.selected ? "Included" : "Excluded"}
                </span>
                <Switch checked={sub.selected} onCheckedChange={(v) => update(sub.name, { selected: v })} />
              </div>
            </div>
          </CardHeader>

          {sub.selected ? (
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Name column">
                  <SelectBox
                    value={sub.nameColumn}
                    onChange={(v) => update(sub.name, { nameColumn: v })}
                    options={sub.headers}
                  />
                </Field>
                <Field label="Identifier column (for source match)">
                  <SelectBox
                    value={sub.identifierColumn}
                    onChange={(v) => update(sub.name, { identifierColumn: v })}
                    options={sub.headers}
                  />
                </Field>
                <Field label="Identifier type">
                  <select
                    value={sub.identifierType}
                    onChange={(e) => update(sub.name, { identifierType: e.target.value as IdentifierType })}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    {ID_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Round columns ({sub.roundColumns.length})</Label>
                  <div className="flex gap-2 text-xs">
                    <button
                      onClick={() => update(sub.name, { roundColumns: [...sub.headers] })}
                      className="text-primary hover:underline"
                    >
                      All
                    </button>
                    <button
                      onClick={() => update(sub.name, { roundColumns: [] })}
                      className="text-muted-foreground hover:underline"
                    >
                      None
                    </button>
                    <button
                      onClick={() => update(sub.name, { roundColumns: suggestRoundColumns(sub.headers) })}
                      className="text-muted-foreground hover:underline"
                    >
                      Auto
                    </button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Each selected column becomes a funnel stage — a candidate counts as “sent to” that
                  round when the cell isn&apos;t blank.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {sub.headers.map((h) => {
                    const on = sub.roundColumns.includes(h);
                    return (
                      <label
                        key={h}
                        className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent"
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
            </CardContent>
          ) : null}
        </Card>
      ))}

      {subs.length > 0 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {selected.length > 0
              ? `${selected.length} subsheet${selected.length === 1 ? "" : "s"} selected.`
              : "Include at least one subsheet to analyze."}
          </p>
          <Button size="lg" onClick={analyze} disabled={!canAnalyze}>
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
            {analyzing ? "Analyzing…" : "Analyze & visualize funnel"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function SelectBox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
