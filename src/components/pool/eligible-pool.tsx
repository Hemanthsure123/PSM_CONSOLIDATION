"use client";

import * as React from "react";
import {
  AlertCircle,
  Award,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  ExternalLink,
  FileSpreadsheet,
  FileUp,
  HelpCircle,
  Layers,
  RefreshCw,
  Sparkles,
  Upload,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useReportBusy } from "@/components/busy-context";
import { ActionBar } from "@/components/ui/action-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AssessmentScores } from "@/components/pool/assessment-scores";
import { CountBar, ORDINAL, PRODUCT_COLOR, SERIES_NEUTRAL, StackedBars, StageFunnel } from "@/components/pool/pool-charts";
import { SHORTLIST_ORDER, TIER_RULES } from "@/components/pool/pool-rules";
import { fetchPoolSummary, syncPoolProduct, uploadPoolCsv } from "@/lib/pool/client";
import {
  COMPETENCY_LABEL,
  PRODUCTS,
  PRODUCT_LABEL,
  TR2_TRACK_LABEL,
  type PoolSummary,
  type Product,
  type SyncResult,
} from "@/lib/pool/types";

const fmt = (n: number) => n.toLocaleString("en-IN");

/** "just now", "12 min ago", "3 h ago", "26 Oct". Exported for sibling components. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function failedResult(product: Product, mode: "sheet" | "csv", error: string): SyncResult {
  return { product, mode, ok: false, runId: null, rowsRead: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, issues: [], error, ms: 0 };
}

const LEVELS = [
  { label: "L5", color: ORDINAL[0] },
  { label: "L4", color: ORDINAL[1] },
  { label: "L3", color: ORDINAL[2] },
  { label: "L2", color: ORDINAL[3] },
  { label: "L1", color: ORDINAL[4] },
  { label: "Below L1", color: SERIES_NEUTRAL },
];

type ActiveTab = "overview" | "sync" | "rules" | "scores";

export function EligiblePool() {
  const [activeTab, setActiveTab] = React.useState<ActiveTab>("overview");
  const [summary, setSummary] = React.useState<PoolSummary | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [syncing, setSyncing] = React.useState<Product | null>(null);
  const [queue, setQueue] = React.useState<Product[]>([]);
  const [results, setResults] = React.useState<SyncResult[]>([]);
  const [uploadProduct, setUploadProduct] = React.useState<Product | "auto">("auto");
  const [file, setFile] = React.useState<File | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const [showEdge2Tracks, setShowEdge2Tracks] = React.useState(false);
  const [showAcademyDetails, setShowAcademyDetails] = React.useState(false);
  const [showColumnHelp, setShowColumnHelp] = React.useState(false);

  const fileRef = React.useRef<HTMLInputElement>(null);
  const busy = Boolean(syncing) || uploading;
  useReportBusy(busy);

  const load = React.useCallback(async () => {
    setLoading(true);
    const res = await fetchPoolSummary();
    if (res.ok) {
      setSummary(res.data);
      setLoadError(null);
    } else setLoadError(res.error);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const refetch = async (products: Product[]) => {
    setResults([]);
    setQueue(products);
    const out: SyncResult[] = [];
    for (const p of products) {
      setSyncing(p);
      const res = await syncPoolProduct(p);
      out.push(res.ok ? res.data : failedResult(p, "sheet", res.error));
      setResults([...out]);
    }
    setSyncing(null);
    setQueue([]);
    await load();
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setResults([]);
    const res = await uploadPoolCsv(file, uploadProduct);
    setResults([res.ok ? res.data : failedResult(uploadProduct === "auto" ? "edge2" : uploadProduct, "csv", res.error)]);
    if (res.ok && res.data.ok) {
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    }
    setUploading(false);
    await load();
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (/\.csv$/i.test(droppedFile.name) || droppedFile.type.includes("csv")) {
        setFile(droppedFile);
      }
    }
  };

  if (loading && !summary) {
    return (
      <div className="space-y-4 rounded-xl border bg-card p-8 shadow-surface">
        <div className="flex items-center gap-3">
          <RefreshCw className="h-5 w-5 animate-spin text-primary" />
          <p className="text-sm font-medium text-foreground">Loading candidate intelligence pool…</p>
        </div>
        <Progress label="Loading the eligible pool" />
      </div>
    );
  }

  if (!summary) {
    return (
      <Notice
        tone="danger"
        title="The eligible pool couldn't be loaded"
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw /> Try again
          </Button>
        }
      >
        {loadError}
      </Notice>
    );
  }

  if (!summary.configured) {
    return (
      <EmptyState
        icon={<Database />}
        title="Connect the database first"
        description="The eligible pool lives in Postgres. Set DATABASE_URL and DIRECT_URL in .env.local, run database migration once, then come back and refetch the pool."
      />
    );
  }

  const { people, products } = summary;
  const byProduct = Object.fromEntries(products.map((p) => [p.product, p])) as Record<Product, PoolSummary["products"][number]>;
  const lastRefetch = products
    .map((p) => p.lastSuccessAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  const anyTier4 = products.some((p) => p.byTier[4] > 0);
  const edge2 = byProduct.edge2;
  const edge1 = byProduct.edge1;
  const academy = byProduct.academy;
  const reached = (t: Record<1 | 2 | 3 | 4, number>) => ({ assessment: t[1] + t[2] + t[3], tr1: t[1] + t[2], tr2: t[1] });

  return (
    <div className="space-y-6">
      {/* ── Page Header & Quick Actions ── */}
      <div className="flex flex-col gap-4 border-b pb-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">Eligible Candidate Pool</h1>
            <Badge variant="outline" className="gap-1 border-primary/20 bg-primary/5 text-primary text-xs font-semibold">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" /> Live Database
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Central repository for assessed candidates across Edge 2.0, Edge 1.0, and Academy.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setActiveTab("sync");
            }}
            className="gap-1.5"
          >
            <Upload className="h-4 w-4" /> Upload CSV
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void refetch([...PRODUCTS])}
            className="gap-2 shadow-sm"
          >
            <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
            {syncing ? "Refetching…" : "Refetch All"}
          </Button>
        </div>
      </div>

      {loadError && (
        <Notice tone="warning" title="Showing cached numbers">
          {loadError}
        </Notice>
      )}

      {people.total === 0 && (
        <Notice tone="info" title="The pool is currently empty">
          Refetch the pool or upload a CSV to populate candidate intelligence across Edge 2.0, Edge 1.0, and Academy.
        </Notice>
      )}

      {/* ── Metric Cards ── */}
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-surface transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium uppercase tracking-wider">Total in Pool</span>
            <span className="rounded-lg bg-blue-500/10 p-2 text-blue-600">
              <Users className="h-4 w-4" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground">{fmt(people.total)}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Edge 2.0 · Edge 1.0 · Academy</span>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-surface transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium uppercase tracking-wider">TR-2 Cleared</span>
            <span className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600">
              <Award className="h-4 w-4" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-emerald-600">{fmt(people.byTier[1])}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-600/80 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" /> Tier 1 · Top Placement Priority
          </div>
        </div>

        <div className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-surface transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium uppercase tracking-wider">TR-1 Cleared</span>
            <span className="rounded-lg bg-indigo-500/10 p-2 text-indigo-600">
              <Sparkles className="h-4 w-4" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground">{fmt(people.byTier[2])}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
            <span>Tier 2 · Interview Qualified</span>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-surface transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium uppercase tracking-wider">Assessment Cleared</span>
            <span className="rounded-lg bg-purple-500/10 p-2 text-purple-600">
              <BarChart3 className="h-4 w-4" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground">{fmt(people.byTier[3])}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
            <span>Tier 3 · Foundational Pool</span>
          </div>
        </div>
      </div>

      {/* ── View Switcher Tabs ── */}
      <div className="flex border-b border-border">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setActiveTab("overview")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              activeTab === "overview"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-muted hover:text-foreground",
            )}
          >
            <BarChart3 className="h-4 w-4" /> Product Breakdown
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("sync")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              activeTab === "sync"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-muted hover:text-foreground",
            )}
          >
            <Upload className="h-4 w-4" /> Sync & CSV Upload
            {results.length > 0 && <span className="h-2 w-2 rounded-full bg-primary" />}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("rules")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              activeTab === "rules"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-muted hover:text-foreground",
            )}
          >
            <Layers className="h-4 w-4" /> Shortlisting Hierarchy & Rules
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("scores")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              activeTab === "scores"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-muted hover:text-foreground",
            )}
          >
            <Award className="h-4 w-4" /> Assessment Scores
          </button>
        </div>
      </div>

      {/* ── TAB 1: PRODUCT BREAKDOWN ── */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          <div className="grid gap-5 lg:grid-cols-3">
            {/* Edge 2.0 Card */}
            <Card className="flex flex-col border shadow-surface">
              <CardHeader className="border-b bg-muted/20 pb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-blue-600" />
                    <CardTitle className="text-base font-semibold">Edge 2.0</CardTitle>
                  </div>
                  <Badge variant="outline" className="font-semibold text-xs text-blue-700 bg-blue-50/50">
                    {fmt(edge2.total)} candidates
                  </Badge>
                </div>
                <CardDescription className="flex items-center justify-between text-xs pt-1">
                  <span>2027 Placement Drive</span>
                  <ProductSyncBadge summary={edge2} />
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 space-y-4 pt-5">
                <StageFunnel
                  color={PRODUCT_COLOR.edge2}
                  stages={[
                    { label: "Assessment Cleared", value: reached(edge2.byTier).assessment },
                    { label: "TR-1 Cleared", value: reached(edge2.byTier).tr1 },
                    {
                      label: "TR-2 Cleared",
                      value: reached(edge2.byTier).tr2,
                      note: summary.edge2CombinedTr2 ? `${fmt(summary.edge2CombinedTr2)} in general TR-2` : undefined,
                    },
                  ]}
                />

                <div className="pt-2 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => setShowEdge2Tracks(!showEdge2Tracks)}
                  >
                    <span>Track Verdicts Breakdown</span>
                    {showEdge2Tracks ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>

                  {showEdge2Tracks && (
                    <div className="mt-3 pt-3 border-t">
                      <StackedBars
                        legend={[
                          { label: "Strong hire", color: ORDINAL[0] },
                          { label: "Medium hire", color: ORDINAL[2] },
                        ]}
                        rows={summary.edge2Tracks
                          .filter((t) => t.strong + t.medium > 0)
                          .map((t) => ({
                            label: TR2_TRACK_LABEL[t.track],
                            parts: [
                              { label: "Strong hire", value: t.strong, color: ORDINAL[0] },
                              { label: "Medium hire", value: t.medium, color: ORDINAL[2] },
                            ],
                          }))}
                      />
                    </div>
                  )}
                </div>
              </CardContent>
              <div className="flex items-center justify-between border-t bg-muted/10 px-4 py-2.5 text-xs text-muted-foreground">
                <a
                  href={summary.sources.find((s) => s.product === "edge2")?.sheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  Open Sheet <ExternalLink className="h-3 w-3" />
                </a>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void refetch(["edge2"])}
                  className="h-7 px-2 text-xs"
                >
                  <RefreshCw className={cn("h-3 w-3 mr-1", syncing === "edge2" && "animate-spin")} /> Refetch
                </Button>
              </div>
            </Card>

            {/* Edge 1.0 Card */}
            <Card className="flex flex-col border shadow-surface">
              <CardHeader className="border-b bg-muted/20 pb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-teal-600" />
                    <CardTitle className="text-base font-semibold">Edge 1.0</CardTitle>
                  </div>
                  <Badge variant="outline" className="font-semibold text-xs text-teal-700 bg-teal-50/50">
                    {fmt(edge1.total)} candidates
                  </Badge>
                </div>
                <CardDescription className="flex items-center justify-between text-xs pt-1">
                  <span>Assessed Pool</span>
                  <ProductSyncBadge summary={edge1} />
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 space-y-4 pt-5">
                <StageFunnel
                  color={PRODUCT_COLOR.edge1}
                  stages={[
                    { label: "Assessment Cleared", value: reached(edge1.byTier).assessment },
                    { label: "TR-1 Cleared", value: reached(edge1.byTier).tr1 },
                    { label: "TR-2 Cleared (Shortlisted)", value: reached(edge1.byTier).tr2 },
                  ]}
                />
                {edge1.byTier[4] > 0 && (
                  <p className="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{fmt(edge1.byTier[4])}</span> assessed candidates were not selected and are treated as external.
                  </p>
                )}
              </CardContent>
              <div className="flex items-center justify-between border-t bg-muted/10 px-4 py-2.5 text-xs text-muted-foreground">
                <a
                  href={summary.sources.find((s) => s.product === "edge1")?.sheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  Open Sheet <ExternalLink className="h-3 w-3" />
                </a>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void refetch(["edge1"])}
                  className="h-7 px-2 text-xs"
                >
                  <RefreshCw className={cn("h-3 w-3 mr-1", syncing === "edge1" && "animate-spin")} /> Refetch
                </Button>
              </div>
            </Card>

            {/* Academy Card */}
            <Card className="flex flex-col border shadow-surface">
              <CardHeader className="border-b bg-muted/20 pb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-amber-600" />
                    <CardTitle className="text-base font-semibold">Academy</CardTitle>
                  </div>
                  <Badge variant="outline" className="font-semibold text-xs text-amber-700 bg-amber-50/50">
                    {fmt(academy.total)} candidates
                  </Badge>
                </div>
                <CardDescription className="flex items-center justify-between text-xs pt-1">
                  <span>&gt; 8 LPA Assessed Pool</span>
                  <ProductSyncBadge summary={academy} />
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 space-y-4 pt-5">
                <StageFunnel
                  color={PRODUCT_COLOR.academy}
                  stages={[
                    { label: "Eligible (Assessed)", value: academy.total - academy.byTier[4] },
                    { label: "TR-1 Cleared / Tier 2", value: academy.byTier[1] + academy.byTier[2] },
                    {
                      label: "Top Level / Tier 1",
                      value: academy.byTier[1],
                      note: `Bucket A TR-2: ${fmt(summary.academyTop.bucketATr2)} · L3+ Competency: ${fmt(summary.academyTop.competencyL3)}`,
                    },
                  ]}
                />

                <div className="pt-2 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
                    onClick={() => setShowAcademyDetails(!showAcademyDetails)}
                  >
                    <span>Competency Levels & Buckets</span>
                    {showAcademyDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>

                  {showAcademyDetails && (
                    <div className="mt-3 space-y-4 pt-3 border-t">
                      <div>
                        <p className="text-xs font-medium mb-1.5 text-foreground">Competency Interview Levels</p>
                        <StackedBars
                          legend={LEVELS.map((l) => ({ label: l.label, color: l.color }))}
                          rows={summary.academyCompetency
                            .filter((c) => c.taken > 0)
                            .map((c) => ({
                              label: COMPETENCY_LABEL[c.subject],
                              parts: LEVELS.map((l) => ({ label: l.label, value: c.byLevel[l.label] ?? 0, color: l.color })),
                              total: c.taken,
                            }))}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
              <div className="flex items-center justify-between border-t bg-muted/10 px-4 py-2.5 text-xs text-muted-foreground">
                <a
                  href={summary.sources.find((s) => s.product === "academy")?.sheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  Open Sheet <ExternalLink className="h-3 w-3" />
                </a>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void refetch(["academy"])}
                  className="h-7 px-2 text-xs"
                >
                  <RefreshCw className={cn("h-3 w-3 mr-1", syncing === "academy" && "animate-spin")} /> Refetch
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ── TAB 2: SYNC & CSV UPLOAD ── */}
      {activeTab === "sync" && (
        <div className="space-y-6">
          {results.length > 0 && (
            <div className="space-y-2">
              {results.map((r, i) => (
                <ResultNotice key={`${r.product}-${i}`} result={r} />
              ))}
            </div>
          )}

          {/* Modern CSV Upload Zone */}
          <Panel
            title="Upload CSV Export"
            description="Add or update eligible candidates directly from a downloaded CSV spreadsheet."
            icon={<FileSpreadsheet />}
          >
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground">Select Target Product:</span>
                  <div className="inline-flex rounded-lg border bg-card p-0.5 shadow-sm">
                    {(["auto", ...PRODUCTS] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setUploadProduct(p)}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                          uploadProduct === p ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {p === "auto" ? "Auto-Detect" : PRODUCT_LABEL[p]}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowColumnHelp(!showColumnHelp)}
                  className="inline-flex items-center gap-1 text-xs text-primary font-medium hover:underline"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                  {showColumnHelp ? "Hide format tips" : "Supported columns"}
                </button>
              </div>

              {showColumnHelp && (
                <div className="rounded-lg border border-blue-200/50 bg-blue-50/40 p-3.5 text-xs text-blue-900 leading-relaxed">
                  <p className="font-semibold mb-1">Expected CSV columns:</p>
                  <ul className="list-disc pl-4 space-y-1 text-blue-800">
                    <li>
                      <strong>Edge 2.0:</strong> Header row must include <code>FINAL STAGE</code> (or <code>Candidate Stage</code>) and <code>phone</code> or <code>bqCandidateId</code>, plus optional scores and TR-2 tracks.
                    </li>
                    <li>
                      <strong>Edge 1.0:</strong> Header row with <code>User ID</code>, <code>Assesment Selection Status</code>, and <code>Phone Number</code>.
                    </li>
                    <li>
                      <strong>Academy:</strong> Header row with <code>UID</code> and <code>Number</code> (or <code>StudentNumber</code>).
                    </li>
                  </ul>
                </div>
              )}

              {/* Drag & Drop Box */}
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                className={cn(
                  "relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-all",
                  dragActive ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/50",
                  file && "border-emerald-500/50 bg-emerald-50/20",
                )}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />

                {!file ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <FileUp className="h-6 w-6" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">
                      Drag & drop your CSV file here, or{" "}
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        className="text-primary underline hover:text-primary/80"
                      >
                        browse files
                      </button>
                    </p>
                    <p className="text-xs text-muted-foreground">Google Sheets › File › Download › Comma-separated values (.csv)</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                      <FileSpreadsheet className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB · Ready to sync</p>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        disabled={uploading}
                        onClick={() => void upload()}
                        className="gap-1.5"
                      >
                        <Upload className="h-4 w-4" /> {uploading ? "Syncing..." : "Upload & Sync into Database"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={uploading}
                        onClick={() => {
                          setFile(null);
                          if (fileRef.current) fileRef.current.value = "";
                        }}
                        className="h-8 w-8 p-0"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Panel>

          {/* Connected Google Sheets Table */}
          <Panel
            title="Connected Google Sheets"
            description="Live synchronization feeds configured for automatic updates and on-demand refetching."
            icon={<Database />}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Sheet / Tab</TableHead>
                  <TableHead>Last Sync Status</TableHead>
                  <TableHead className="text-right">Candidate Count</TableHead>
                  <TableHead className="w-0 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.sources.map((s) => {
                  const p = byProduct[s.product];
                  const inQueue = queue.includes(s.product);
                  return (
                    <TableRow key={s.product}>
                      <TableCell className="font-semibold">{PRODUCT_LABEL[s.product]}</TableCell>
                      <TableCell>
                        <a
                          href={s.sheetUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-primary font-medium hover:underline"
                        >
                          {s.tab} <ExternalLink className="h-3 w-3" />
                        </a>
                      </TableCell>
                      <TableCell>
                        {syncing === s.product ? (
                          <span className="inline-flex items-center gap-1.5 text-primary text-xs font-medium">
                            <RefreshCw className="h-3 w-3 animate-spin" /> Syncing…
                          </span>
                        ) : inQueue ? (
                          <span className="text-muted-foreground text-xs font-medium">In Queue…</span>
                        ) : (
                          <ProductSyncBadge summary={p} long />
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{fmt(p.total)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void refetch([s.product])}
                          className="h-8 gap-1.5 text-xs"
                        >
                          <RefreshCw className={cn("h-3.5 w-3.5", syncing === s.product && "animate-spin")} /> Refetch
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Panel>

          {/* Sync History */}
          {summary.recentRuns.length > 0 && (
            <Disclosure title="Sync Run History" summary={`Last ${summary.recentRuns.length} executions`}>
              <Table containerClassName="max-h-[360px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">New</TableHead>
                    <TableHead className="text-right">Updated</TableHead>
                    <TableHead className="text-right">Unchanged</TableHead>
                    <TableHead className="text-right">Issues</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.recentRuns.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {ago(r.startedAt)}
                      </TableCell>
                      <TableCell className="font-medium text-xs">{PRODUCT_LABEL[r.product]}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground" title={r.sourceRef}>
                        {r.mode === "csv" ? `CSV: ${r.sourceRef}` : "Google Sheet"}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-emerald-600 font-semibold">{fmt(r.inserted)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-blue-600">{fmt(r.updated)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmt(r.unchanged)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-amber-600">{fmt(r.issueCount)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={r.status === "succeeded" ? "success" : r.status === "failed" ? "destructive" : "secondary"}
                          className="text-[11px]"
                          title={r.error ?? undefined}
                        >
                          {r.status === "succeeded" ? "Success" : r.status === "failed" ? "Failed" : "Running"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Disclosure>
          )}
        </div>
      )}

      {/* ── TAB 3: SHORTLISTING HIERARCHY & RULES ── */}
      {activeTab === "rules" && (
        <div className="space-y-6">
          <Panel
            title="Standing Tiers & Eligibility Hierarchy"
            description="Candidates are matched by phone first, then by User ID. When a student belongs to multiple products, their strongest standing tier takes precedence."
            icon={<Layers />}
          >
            <div className="space-y-3">
              {TIER_RULES.map((tier) => (
                <div key={tier.tier} className="rounded-xl border bg-card p-4 transition-all hover:border-primary/40">
                  <div className="flex items-center justify-between border-b pb-3">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-white shadow-sm"
                        style={{ background: ORDINAL[tier.tier - 1] }}
                      >
                        T{tier.tier}
                      </span>
                      <div>
                        <h4 className="text-sm font-semibold text-foreground">{tier.title}</h4>
                        <p className="text-xs text-muted-foreground">Ranked {tier.tier === 1 ? "1st" : tier.tier === 2 ? "2nd" : "3rd"} in priority</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-bold text-foreground tabular-nums">{fmt(people.byTier[tier.tier])}</span>
                      <span className="ml-1 text-xs text-muted-foreground">candidates</span>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2.5 sm:grid-cols-3 text-xs">
                    <div className="rounded-lg bg-blue-50/50 p-2.5 dark:bg-blue-950/20">
                      <span className="font-semibold text-blue-700">Edge 2.0:</span>
                      <p className="mt-0.5 text-muted-foreground leading-relaxed">{tier.rules.edge2}</p>
                    </div>
                    <div className="rounded-lg bg-teal-50/50 p-2.5 dark:bg-teal-950/20">
                      <span className="font-semibold text-teal-700">Edge 1.0:</span>
                      <p className="mt-0.5 text-muted-foreground leading-relaxed">{tier.rules.edge1}</p>
                    </div>
                    <div className="rounded-lg bg-amber-50/50 p-2.5 dark:bg-amber-950/20">
                      <span className="font-semibold text-amber-700">Academy:</span>
                      <p className="mt-0.5 text-muted-foreground leading-relaxed">{tier.rules.academy}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 border-t pt-5">
              <h3 className="text-sm font-semibold mb-3">Domain Shortlisting Order</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                {SHORTLIST_ORDER.map((g) => (
                  <div key={g.group} className="rounded-xl border bg-muted/20 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                        {g.group}
                      </span>
                      <p className="text-sm font-semibold text-foreground">{g.title}</p>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{g.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </div>
      )}

      {/* ── TAB 4: ASSESSMENT SCORES ── */}
      {activeTab === "scores" && <AssessmentScores />}

      {/* ── Floating Action Bar ── */}
      <ActionBar
        status={
          syncing ? (
            <div className="flex items-center gap-2 text-xs">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" />
              <span>
                Refetching {PRODUCT_LABEL[syncing]}
                {queue.length > 1 ? ` (${queue.indexOf(syncing) + 1} of ${queue.length})` : ""}…
              </span>
            </div>
          ) : uploading ? (
            <div className="flex items-center gap-2 text-xs">
              <Upload className="h-3.5 w-3.5 animate-pulse text-primary" />
              <span>Uploading and verifying CSV data…</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>
                Last refetched {ago(lastRefetch)} · {fmt(people.total)} candidates in database
              </span>
            </div>
          )
        }
      >
        <Button size="sm" disabled={busy} onClick={() => void refetch([...PRODUCTS])} className="gap-2">
          <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} /> Refetch Eligible Pool
        </Button>
      </ActionBar>
    </div>
  );
}

/** Product status badge */
function ProductSyncBadge({ summary, long }: { summary: PoolSummary["products"][number]; long?: boolean }) {
  const s = summary.lastSync;
  if (!s) return <Badge variant="secondary">Never synced</Badge>;
  if (s.status === "running") return <Badge variant="secondary">Syncing…</Badge>;
  const failed = s.status === "failed";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {summary.lastSuccessAt ? (
        <span>
          Updated {ago(summary.lastSuccessAt)}
          {long && !failed ? ` · ${s.mode === "csv" ? "CSV" : "Sheet"} · ${fmt(s.inserted)} new, ${fmt(s.updated)} updated` : ""}
        </span>
      ) : null}
      {failed ? (
        <Badge variant="warning" className="gap-1 text-[11px]">
          <AlertCircle className="h-3 w-3" /> Last try failed {ago(s.at)}
        </Badge>
      ) : null}
    </span>
  );
}

function ResultNotice({ result: r }: { result: SyncResult }) {
  const label = PRODUCT_LABEL[r.product];
  if (!r.ok) {
    return (
      <Notice tone="danger" title={`${r.mode === "csv" ? "Upload" : label} Failed`}>
        {r.error}
      </Notice>
    );
  }
  return (
    <Notice tone={r.issues.length ? "warning" : "success"} title={`${label} ${r.mode === "csv" ? "CSV Uploaded" : "Refetched Successfully"}`}>
      <p className="tabular-nums text-xs">
        {fmt(r.rowsRead)} rows read · {fmt(r.inserted)} inserted · {fmt(r.updated)} updated · {fmt(r.unchanged)} unchanged
        {r.skipped ? ` · ${fmt(r.skipped)} skipped` : ""} · {(r.ms / 1000).toFixed(1)}s
      </p>
      {r.issues.length > 0 && (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer font-medium text-amber-700">{fmt(r.issues.length)} rows need attention</summary>
          <ul className="mt-1.5 max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-muted-foreground">
            {r.issues.slice(0, 50).map((issue, k) => (
              <li key={k}>
                {issue.row ? `Row ${issue.row}: ` : ""}
                {issue.problem}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Notice>
  );
}
