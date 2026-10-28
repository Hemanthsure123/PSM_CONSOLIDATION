"use client";

import * as React from "react";
import { ArrowRight, Database, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReportBusy } from "@/components/busy-context";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { ago } from "@/components/pool/eligible-pool";
import { ORDINAL, PRODUCT_COLOR } from "@/components/pool/pool-charts";
import { fetchPoolSummary, syncPoolProduct } from "@/lib/pool/client";
import { PRODUCTS, PRODUCT_LABEL, type PoolSummary, type Product } from "@/lib/pool/types";

const fmt = (n: number) => n.toLocaleString("en-IN");

/**
 * The eligible pool on the dashboard: how many internally assessed people there are at
 * each stage, when the pool was last refetched, and a button to refetch it from the sheets.
 */
export function PoolHomeCard({ onOpen }: { onOpen: () => void }) {
  const [summary, setSummary] = React.useState<PoolSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState<Product | null>(null);
  const [message, setMessage] = React.useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  useReportBusy(Boolean(syncing));

  const load = React.useCallback(async () => {
    const res = await fetchPoolSummary();
    if (res.ok) {
      setSummary(res.data);
      setError(null);
    } else setError(res.error);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const refetch = async () => {
    setMessage(null);
    let added = 0;
    let changed = 0;
    const failed: string[] = [];
    for (const p of PRODUCTS) {
      setSyncing(p);
      const res = await syncPoolProduct(p);
      if (res.ok && res.data.ok) {
        added += res.data.inserted;
        changed += res.data.updated;
      } else failed.push(`${PRODUCT_LABEL[p]}: ${res.ok ? res.data.error : res.error}`);
    }
    setSyncing(null);
    setMessage(
      failed.length
        ? { tone: "bad", text: `Some sheets failed — ${failed.join(" · ")}` }
        : { tone: "ok", text: `Refetched: ${fmt(added)} new, ${fmt(changed)} updated.` },
    );
    await load();
  };

  // No database configured: say so once, quietly — the rest of the dashboard works without it.
  if (summary && !summary.configured) {
    return (
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-card/60 px-4 py-3 text-[13px] text-muted-foreground">
        <Database className="h-4 w-4" />
        <span className="min-w-0 flex-1">The eligible pool needs the database — set DATABASE_URL in .env.local to turn it on.</span>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Learn more <ArrowRight />
        </Button>
      </div>
    );
  }

  const people = summary?.people;
  const last = summary?.products
    .map((p) => p.lastSuccessAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);

  return (
    <Panel
      className="mb-6"
      icon={<Database />}
      title="Eligible pool"
      description={
        error && !summary
          ? error
          : summary
            ? `Internally assessed in Edge 2.0, Edge 1.0 and Academy · last refetched ${ago(last)}`
            : "Loading…"
      }
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Open <ArrowRight />
          </Button>
          <Button variant="outline" size="sm" disabled={Boolean(syncing) || !summary} onClick={() => void refetch()}>
            <RefreshCw className={cn(syncing && "animate-spin motion-reduce:animate-none")} />
            {syncing ? `Refetching ${PRODUCT_LABEL[syncing]}…` : "Refetch eligible pool"}
          </Button>
        </>
      }
    >
      {people ? (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <dl className="grid grid-cols-4 gap-3">
            <div>
              <dt className="text-xs text-muted-foreground">People</dt>
              <dd className="font-display text-[22px] font-semibold tabular-nums">{fmt(people.total)}</dd>
            </div>
            {([1, 2, 3] as const).map((t) => (
              <div key={t}>
                <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: ORDINAL[t - 1] }} aria-hidden />
                  {t === 1 ? "TR-2 / top" : t === 2 ? "TR-1" : "Assessment"}
                </dt>
                <dd className="font-display text-[22px] font-semibold tabular-nums">{fmt(people.byTier[t])}</dd>
              </div>
            ))}
          </dl>
          <ul className="space-y-1.5 text-[13px]">
            {summary!.products.map((p) => (
              <li key={p.product} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: PRODUCT_COLOR[p.product] }} aria-hidden />
                <span className="w-20 shrink-0">{PRODUCT_LABEL[p.product]}</span>
                <span className="tabular-nums text-muted-foreground">
                  {fmt(p.byTier[1])} {p.product === "academy" ? "top level" : "TR-2"} · {fmt(p.byTier[2])} TR-1 · {fmt(p.byTier[3])} assessment
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {message ? (
        <p className={cn("mt-3 text-[13px]", message.tone === "ok" ? "text-success" : "text-destructive")} role="status">
          {message.text}
        </p>
      ) : null}
    </Panel>
  );
}
