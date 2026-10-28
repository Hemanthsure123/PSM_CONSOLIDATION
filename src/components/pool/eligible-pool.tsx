"use client";

import * as React from "react";
import { Database, ExternalLink, FileUp, Layers, RefreshCw, Upload, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReportBusy } from "@/components/busy-context";
import { ActionBar } from "@/components/ui/action-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { InfoHint } from "@/components/ui/info-hint";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { NativeSelect } from "@/components/ui/select";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

/** "just now", "12 min ago", "3 h ago", "26 Oct". */
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

/**
 * Eligible pool — the internally assessed candidates of Edge 2.0, Edge 1.0 and Academy, kept
 * in the database: who is eligible at which stage, how that ranks them in Domain
 * shortlisting, and keeping it up to date (refetch from the sheets or upload a CSV).
 */
export function EligiblePool() {
  const [summary, setSummary] = React.useState<PoolSummary | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [syncing, setSyncing] = React.useState<Product | null>(null);
  const [queue, setQueue] = React.useState<Product[]>([]);
  const [results, setResults] = React.useState<SyncResult[]>([]);
  const [uploadProduct, setUploadProduct] = React.useState<Product | "auto">("auto");
  const [file, setFile] = React.useState<File | null>(null);
  const [uploading, setUploading] = React.useState(false);
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

  /** Refetch products from their sheets, one after another (each is its own short request). */
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

  if (loading && !summary) {
    return (
      <div className="space-y-3 rounded-xl border bg-card p-6 shadow-surface">
        <p className="text-[13px] text-muted-foreground">Loading the eligible pool…</p>
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
        description="The eligible pool lives in Postgres. Set DATABASE_URL and DIRECT_URL in .env.local (see .env.local.example), run npm run db:migrate once, then come back and refetch the pool."
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
      {loadError ? (
        <Notice tone="warning" title="Showing the last numbers loaded">
          {loadError}
        </Notice>
      ) : null}
      {people.total === 0 ? (
        <Notice tone="info" title="The pool is empty">
          Refetch the eligible pool to load Edge 2.0, Edge 1.0 and Academy from their sheets.
        </Notice>
      ) : null}

      <StatGrid cols={5}>
        <Stat icon={<Users />} label="People in the pool" value={fmt(people.total)} hint="Edge 2.0, Edge 1.0 and Academy, once each" />
        <Stat label="TR-2 cleared · top level" value={fmt(people.byTier[1])} tone="success" hint="Their best stage, any product" />
        <Stat label="TR-1 cleared" value={fmt(people.byTier[2])} hint="Best stage" />
        <Stat label="Assessment cleared" value={fmt(people.byTier[3])} hint="Best stage" />
        <Stat icon={<Layers />} label="In two or more products" value={fmt(people.inMoreThanOneProduct)} hint="Counted at their best stage" />
      </StatGrid>

      <Panel
        title="Eligibility and priority"
        description="Who is eligible at each stage, per product. Domain shortlisting ranks assessed people first, in this order."
        actions={
          <InfoHint label="How people are matched" align="end">
            A screened candidate is matched to the pool by phone number first, then by user id. Someone in more than one product counts at their best
            stage. Anyone not in the pool is external.
          </InfoHint>
        }
      >
        <div className="overflow-hidden rounded-lg border">
          <div className="hidden grid-cols-[minmax(0,1.05fr)_repeat(3,minmax(0,1fr))_minmax(0,0.55fr)] gap-4 border-b bg-muted px-4 py-2.5 text-xs font-medium text-muted-foreground lg:grid">
            <span>Stage</span>
            {PRODUCTS.map((p) => (
              <span key={p} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: PRODUCT_COLOR[p] }} aria-hidden />
                {PRODUCT_LABEL[p]} <span className="tabular-nums">({fmt(byProduct[p].total)})</span>
              </span>
            ))}
            <span className="text-right">People</span>
          </div>
          {TIER_RULES.map((row, i) => (
            <div
              key={row.tier}
              className={cn(
                "grid gap-3 px-4 py-3.5 lg:grid-cols-[minmax(0,1.05fr)_repeat(3,minmax(0,1fr))_minmax(0,0.55fr)] lg:gap-4",
                i > 0 && "border-t",
              )}
            >
              <div className="flex items-start gap-2.5">
                <span
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white"
                  style={{ background: ORDINAL[row.tier - 1] }}
                  aria-hidden
                >
                  {row.tier}
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-medium leading-6">{row.title}</p>
                  <p className="text-xs text-muted-foreground lg:hidden">
                    <span className="tabular-nums font-medium text-foreground">{fmt(people.byTier[row.tier])}</span> people at this stage
                  </p>
                </div>
              </div>
              {PRODUCTS.map((p) => (
                <div key={p} className="min-w-0 rounded-md bg-muted/40 p-2.5 lg:bg-transparent lg:p-0">
                  <p className="mb-1 text-xs font-medium lg:hidden">{PRODUCT_LABEL[p]}</p>
                  <p className="mb-1.5 text-xs leading-relaxed text-muted-foreground">{row.rules[p]}</p>
                  <CountBar value={byProduct[p].byTier[row.tier]} of={byProduct[p].total} color={PRODUCT_COLOR[p]} label={`${PRODUCT_LABEL[p]} · ${row.title}`} />
                </div>
              ))}
              <div className="hidden text-right font-display text-[20px] font-semibold tabular-nums lg:block">{fmt(people.byTier[row.tier])}</div>
            </div>
          ))}
          {anyTier4 ? (
            <div className="border-t bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
              Assessed but not eligible (e.g. Edge 1.0 assessment not cleared):{" "}
              {PRODUCTS.filter((p) => byProduct[p].byTier[4] > 0)
                .map((p) => `${PRODUCT_LABEL[p]} ${fmt(byProduct[p].byTier[4])}`)
                .join(" · ")}
              . They are treated as external.
            </div>
          ) : null}
        </div>

        <h3 className="mb-2 mt-5 text-[13px] font-medium">Order in Domain shortlisting</h3>
        <ol className="grid gap-3 md:grid-cols-3">
          {SHORTLIST_ORDER.map((g) => (
            <li key={g.group} className="flex gap-3 rounded-lg border bg-card p-3.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent font-display text-[14px] font-semibold text-accent-foreground">
                {g.group}
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-medium leading-6">{g.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{g.detail}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">
          The gates a run sets — mandatory skills, experience, DSA, GitHub commits, presentation — apply to everyone. Domain fit is judged only from
          projects, experience, certifications and achievements.
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Edge 2.0"
          description={`${fmt(edge2.total)} in the 2027 pool · ${fmt(edge2.eligible)} eligible`}
          actions={<ProductSyncBadge summary={edge2} />}
        >
          <StageFunnel
            color={PRODUCT_COLOR.edge2}
            stages={[
              { label: "Assessment cleared", value: reached(edge2.byTier).assessment },
              { label: "TR-1 cleared", value: reached(edge2.byTier).tr1 },
              {
                label: "TR-2 cleared",
                value: reached(edge2.byTier).tr2,
                note: summary.edge2CombinedTr2 ? `${fmt(summary.edge2CombinedTr2)} of them in a combined interview (no track verdict).` : undefined,
              },
            ]}
          />
          <h3 className="mb-2 mt-5 text-[13px] font-medium">TR-2 verdicts by track</h3>
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
        </Panel>

        <Panel title="Edge 1.0" description={`${fmt(edge1.total)} assessed · ${fmt(edge1.eligible)} eligible`} actions={<ProductSyncBadge summary={edge1} />}>
          <StageFunnel
            color={PRODUCT_COLOR.edge1}
            stages={[
              { label: "Assessment cleared", value: reached(edge1.byTier).assessment },
              { label: "TR-1 cleared (Strong / Medium hire)", value: reached(edge1.byTier).tr1 },
              { label: "TR-2 cleared (shortlisted)", value: reached(edge1.byTier).tr2 },
            ]}
          />
          {edge1.byTier[4] ? (
            <p className="mt-4 text-xs text-muted-foreground">
              {fmt(edge1.byTier[4])} assessed but not selected — not eligible.
            </p>
          ) : null}
        </Panel>
      </div>

      <Panel
        title="Academy"
        description={`${fmt(academy.total)} in the > 8 LPA assessed pool · everyone is eligible`}
        actions={<ProductSyncBadge summary={academy} />}
      >
        <div className="grid gap-8 lg:grid-cols-3">
          <div>
            <h3 className="mb-2 text-[13px] font-medium">Stage</h3>
            <StageFunnel
              color={PRODUCT_COLOR.academy}
              stages={[
                { label: "Eligible (assessed)", value: academy.total - academy.byTier[4] },
                { label: "TR-1 cleared or top level", value: academy.byTier[1] + academy.byTier[2] },
                {
                  label: "Top level",
                  value: academy.byTier[1],
                  note: `Bucket A TR-2 cleared ${fmt(summary.academyTop.bucketATr2)} · L3+ in a competency interview ${fmt(summary.academyTop.competencyL3)} (some have both).`,
                },
              ]}
            />
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-medium">Interviews by bucket</h3>
            <StackedBars
              legend={[
                { label: "Cleared", color: ORDINAL[1] },
                { label: "Not cleared", color: SERIES_NEUTRAL },
              ]}
              rows={summary.academyRounds.flatMap((b) => [
                {
                  label: `Bucket ${b.bucket} · TR-1`,
                  parts: [
                    { label: "Cleared", value: b.tr1Cleared, color: ORDINAL[1] },
                    { label: "Not cleared", value: b.tr1Taken - b.tr1Cleared, color: SERIES_NEUTRAL },
                  ],
                },
                ...(b.bucket === "C"
                  ? []
                  : [
                      {
                        label: `Bucket ${b.bucket} · TR-2`,
                        parts: [
                          { label: "Cleared", value: b.tr2Cleared, color: ORDINAL[1] },
                          { label: "Not cleared", value: b.tr2Taken - b.tr2Cleared, color: SERIES_NEUTRAL },
                        ],
                      },
                    ]),
              ])}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Old DSA offline buckets:{" "}
              {summary.academyOldBuckets
                .filter((b) => b.total > 0)
                .map((b) => `${b.bucket === "none" ? "none" : b.bucket} ${fmt(b.total)}`)
                .join(" · ")}
              . DSA competency exam cleared: {fmt(summary.academyDsaOfflineCleared)}.
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-medium">Competency interview levels</h3>
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
            <p className="mt-3 text-xs text-muted-foreground">L3, L4 or L5 in any competency interview puts a person at the top level.</p>
          </div>
        </div>
      </Panel>

      <Panel
        title="Keep the pool up to date"
        description="Refetch reads every product's sheet again. A CSV adds its new people and overwrites the records that changed; nobody is deleted."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Sheet</TableHead>
              <TableHead>Last sync</TableHead>
              <TableHead className="text-right">Records</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.sources.map((s) => {
              const p = byProduct[s.product];
              const inQueue = queue.includes(s.product);
              return (
                <TableRow key={s.product}>
                  <TableCell className="font-medium">{PRODUCT_LABEL[s.product]}</TableCell>
                  <TableCell>
                    <a href={s.sheetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      {s.tab} <ExternalLink className="h-3 w-3" />
                    </a>
                  </TableCell>
                  <TableCell>
                    {syncing === s.product ? (
                      <span className="text-primary">Syncing…</span>
                    ) : inQueue ? (
                      <span className="text-muted-foreground">Waiting</span>
                    ) : (
                      <ProductSyncBadge summary={p} long />
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.total)}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refetch([s.product])}>
                      <RefreshCw /> Refetch
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {results.length ? (
          <div className="mt-4 space-y-2">
            {results.map((r, i) => (
              <ResultNotice key={`${r.product}-${i}`} result={r} />
            ))}
          </div>
        ) : null}

        <div className="mt-5 rounded-lg border border-dashed p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Upload a CSV export" htmlFor="pool-csv-product" hint="Google Sheets › File › Download › Comma-separated values" className="min-w-0 flex-1">
              <NativeSelect
                id="pool-csv-product"
                value={uploadProduct}
                onChange={(e) => setUploadProduct(e.target.value as Product | "auto")}
                disabled={busy}
              >
                <option value="auto">Detect the product from the headers</option>
                {PRODUCTS.map((p) => (
                  <option key={p} value={p}>
                    {PRODUCT_LABEL[p]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <div className="flex shrink-0 flex-wrap gap-2 sm:pb-[22px]">
              <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                <FileUp /> {file ? "Change file" : "Choose CSV"}
              </Button>
              <Button variant="outline" disabled={busy || !file} onClick={() => void upload()}>
                <Upload /> {uploading ? "Uploading…" : "Upload"}
              </Button>
            </div>
          </div>
          {file ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024).toFixed(0)} KB
            </p>
          ) : null}
        </div>

        {summary.recentRuns.length ? (
          <Disclosure title="Sync history" summary={`Last ${summary.recentRuns.length} runs`} className="mt-5">
            <Table containerClassName="max-h-[360px]">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>From</TableHead>
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
                    <TableCell className="whitespace-nowrap" title={new Date(r.startedAt).toLocaleString("en-IN")}>
                      {ago(r.startedAt)}
                    </TableCell>
                    <TableCell>{PRODUCT_LABEL[r.product]}</TableCell>
                    <TableCell className="max-w-[220px] truncate" title={r.sourceRef}>
                      {r.mode === "csv" ? r.sourceRef : "Sheet"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(r.inserted)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(r.updated)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(r.unchanged)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(r.issueCount)}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "succeeded" ? "success" : r.status === "failed" ? "destructive" : "secondary"} title={r.error ?? undefined}>
                        {r.status === "succeeded" ? "Done" : r.status === "failed" ? "Failed" : "Running"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Disclosure>
        ) : null}
      </Panel>

      <ActionBar
        status={
          syncing ? (
            <div className="space-y-1.5">
              <span>
                Refetching {PRODUCT_LABEL[syncing]}
                {queue.length > 1 ? ` (${queue.indexOf(syncing) + 1} of ${queue.length})` : ""}…
              </span>
              <Progress label="Refetching the eligible pool" />
            </div>
          ) : uploading ? (
            "Uploading the CSV…"
          ) : (
            `Last refetched ${ago(lastRefetch)} · ${fmt(people.total)} people`
          )
        }
      >
        <Button disabled={busy} onClick={() => void refetch([...PRODUCTS])}>
          <RefreshCw className={cn(syncing && "animate-spin motion-reduce:animate-none")} /> Refetch eligible pool
        </Button>
      </ActionBar>
    </div>
  );
}

/** L5 (best) → Below L1; ordered levels on the sequential blue, "Below L1" neutral. */
const LEVELS = [
  { label: "L5", color: ORDINAL[0] },
  { label: "L4", color: ORDINAL[1] },
  { label: "L3", color: ORDINAL[2] },
  { label: "L2", color: ORDINAL[3] },
  { label: "L1", color: ORDINAL[4] },
  { label: "Below L1", color: SERIES_NEUTRAL },
];

/** When the data was last refreshed, and — if the latest attempt failed after that — say so. */
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
          {long && !failed ? ` · ${s.mode === "csv" ? "CSV" : "sheet"} · ${fmt(s.inserted)} new, ${fmt(s.updated)} updated` : ""}
        </span>
      ) : null}
      {failed ? <Badge variant="warning">Last try failed {ago(s.at)}</Badge> : null}
    </span>
  );
}

function ResultNotice({ result: r }: { result: SyncResult }) {
  const label = PRODUCT_LABEL[r.product];
  if (!r.ok) {
    return (
      <Notice tone="danger" title={`${r.mode === "csv" ? "Upload" : label} failed`}>
        {r.error}
      </Notice>
    );
  }
  return (
    <Notice tone={r.issues.length ? "warning" : "success"} title={`${label} ${r.mode === "csv" ? "CSV uploaded" : "refetched"}`}>
      <p className="tabular-nums">
        {fmt(r.rowsRead)} rows read · {fmt(r.inserted)} new · {fmt(r.updated)} updated · {fmt(r.unchanged)} unchanged
        {r.skipped ? ` · ${fmt(r.skipped)} skipped` : ""} · {(r.ms / 1000).toFixed(1)} s
      </p>
      {r.issues.length ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer">{fmt(r.issues.length)} rows need a look</summary>
          <ul className="mt-1.5 max-h-48 list-disc space-y-0.5 overflow-auto pl-5">
            {r.issues.slice(0, 100).map((i, k) => (
              <li key={k}>
                {i.row ? `Row ${i.row}: ` : ""}
                {i.problem}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Notice>
  );
}
