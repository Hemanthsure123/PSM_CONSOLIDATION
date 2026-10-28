"use client";

import * as React from "react";
import { Copy, Download, ListChecks, Search, UserSearch, Users } from "lucide-react";
import { cn, toCsv } from "@/lib/utils";
import { useReportBusy } from "@/components/busy-context";
import { ActionBar } from "@/components/ui/action-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Panel } from "@/components/ui/panel";
import { Progress } from "@/components/ui/progress";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ago } from "@/components/pool/eligible-pool";
import { fetchPoolSummary, lookupPoolStandings } from "@/lib/pool/client";
import {
  REQUIREMENTS,
  REQUIREMENT_GROUPS,
  STANDING_HEADERS,
  cleanRequirementKeys,
  lookupRows,
  lookupTable,
  parseLookupInput,
  productsNeeded,
  summarise,
  toHtmlTable,
  toTsv,
  type LookupData,
  type LookupInput,
} from "@/lib/pool/lookup";
import { PRODUCT_LABEL, type CandidateStanding, type PersonRecords, type Product } from "@/lib/pool/types";

const fmt = (n: number) => n.toLocaleString("en-IN");
const PAGE = 200;
const KEYS_STORAGE = "standing-lookup:requirements";

function loadKeys(): string[] {
  try {
    const raw = window.localStorage.getItem(KEYS_STORAGE);
    return raw ? cleanRequirementKeys(JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveKeys(keys: string[]) {
  try {
    window.localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));
  } catch {
    // Private window / blocked storage: the choice just isn't remembered.
  }
}

/** One person per id, so a list with repeats costs one lookup each. */
function peopleOf(input: LookupInput) {
  const seen = new Set<string>();
  const people: { phone: string; userId: string }[] = [];
  for (const r of input.rows) {
    if (r.problem) continue;
    const key = `${r.phone ?? ""}|${r.userId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ phone: r.phone ?? "", userId: r.userId ?? "" });
  }
  return people;
}

/**
 * Standing lookup — paste UUIDs or phone numbers, get each candidate's internal standing from
 * the eligible pool (Edge 2.0, Edge 1.0 and Academy assessments; no resume involved): Internal
 * Standing, Stage and Product, plus one Requirements column with the assessment results picked.
 * Rows keep the pasted order, so the result can be pasted straight back into the sheet.
 */
export function StandingLookup() {
  const [text, setText] = React.useState("");
  const [keys, setKeys] = React.useState<string[]>([]);
  const [looked, setLooked] = React.useState<{ text: string; input: LookupInput } | null>(null);
  const [data, setData] = React.useState<(LookupData & { fetched: Product[] }) | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [adding, setAdding] = React.useState<Product[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [notConfigured, setNotConfigured] = React.useState(false);
  const [freshness, setFreshness] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(PAGE);
  useReportBusy(loading || adding.length > 0);

  React.useEffect(() => setKeys(loadKeys()), []);

  // How current the pool is — standings are only as fresh as its last refetch.
  React.useEffect(() => {
    let live = true;
    fetchPoolSummary().then((res) => {
      if (!live || !res.ok) return;
      if (!res.data.configured) {
        setNotConfigured(true);
        return;
      }
      setFreshness(
        res.data.products
          .map((p) => `${PRODUCT_LABEL[p.product]} ${ago(p.lastSuccessAt)}`)
          .join(" · "),
      );
    });
    return () => {
      live = false;
    };
  }, []);

  const parsed = React.useMemo(() => parseLookupInput(text), [text]);
  const changedSinceLookup = Boolean(looked && looked.text !== text);

  const toggleKey = (key: string) =>
    setKeys((prev) => {
      const next = cleanRequirementKeys(prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
      saveKeys(next);
      return next;
    });
  const clearKeys = () => {
    setKeys([]);
    saveKeys([]);
  };

  const run = async () => {
    const input = parsed;
    const people = peopleOf(input);
    if (!people.length) return;
    const include = productsNeeded(keys);
    setLoading(true);
    setError(null);
    setCopied(null);
    const res = await lookupPoolStandings(people, include);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (!res.data.configured) {
      setNotConfigured(true);
      return;
    }
    setLooked({ text, input });
    setData({ standings: res.data.standings, records: res.data.records, fetched: include });
    setLimit(PAGE);
  };

  // A requirement picked after the lookup that needs another product's records: fetch just those.
  React.useEffect(() => {
    if (!looked || !data || loading) return;
    const missing = productsNeeded(keys).filter((p) => !data.fetched.includes(p) && !adding.includes(p));
    if (!missing.length) return;
    setAdding((a) => [...a, ...missing]);
    lookupPoolStandings(peopleOf(looked.input), missing).then((res) => {
      setAdding((a) => a.filter((p) => !missing.includes(p)));
      if (!res.ok) {
        // Not retried on its own (no loop): "Look up again" fetches everything afresh.
        setError(`Couldn't add the ${missing.map((p) => PRODUCT_LABEL[p]).join(" / ")} details: ${res.error} Look up again to retry.`);
        setData((d) => (d ? { ...d, fetched: [...new Set([...d.fetched, ...missing])] } : d));
        return;
      }
      setData((d) => {
        if (!d) return d;
        const records: Record<string, PersonRecords> = { ...d.records };
        for (const [id, r] of Object.entries(res.data.records)) records[id] = { ...records[id], ...r };
        const standings: Record<string, CandidateStanding> = { ...d.standings, ...res.data.standings };
        return { standings, records, fetched: [...new Set([...d.fetched, ...missing])] };
      });
    });
  }, [keys, looked, data, loading, adding]);

  const rows = React.useMemo(() => (looked && data ? lookupRows(looked.input, data, keys) : []), [looked, data, keys]);
  const summary = React.useMemo(() => summarise(rows), [rows]);
  const phoneColumn = Boolean(looked?.input.counts.phones);
  const withRequirements = keys.length > 0;
  const table = React.useMemo(() => lookupTable(rows, { phoneColumn, requirements: withRequirements }), [rows, phoneColumn, withRequirements]);

  const copy = async (resultsOnly: boolean) => {
    const headers = resultsOnly ? table.headers.filter((h) => h !== "UUID" && h !== "Phone") : table.headers;
    // Mirror the paste: a header row only when the pasted list had one, so rows line up.
    const withHeader = Boolean(looked?.input.headerSkipped);
    const tsv = toTsv(headers, table.rows);
    const html = toHtmlTable(headers, table.rows);
    const body = withHeader ? tsv : tsv.slice(tsv.indexOf("\n") + 1);
    const htmlBody = withHeader ? html : html.replace(/<thead>.*?<\/thead>/, "");
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ "text/html": new Blob([htmlBody], { type: "text/html" }), "text/plain": new Blob([body], { type: "text/plain" }) }),
        ]);
      } else {
        await navigator.clipboard.writeText(body);
      }
      setCopied(
        `Copied ${fmt(table.rows.length)} rows${withHeader ? " with the header" : ""}${resultsOnly ? ` (${headers.join(", ")})` : ""} — paste them into the sheet${resultsOnly ? " beside your IDs" : ""}.`,
      );
    } catch {
      setCopied("The browser didn't allow copying — use Download CSV instead.");
    }
  };

  const download = () => {
    const blob = new Blob(["﻿" + toCsv(table.headers, table.rows)], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `internal-standing-${summary.looked}.csv`;
    a.click();
    URL.revokeObjectURL(href);
  };

  const c = parsed.counts;
  const inputLine = text.trim()
    ? [
        `${fmt(c.ids)} to look up`,
        c.userIds ? `${fmt(c.userIds)} UUID${c.userIds === 1 ? "" : "s"}` : "",
        c.phones ? `${fmt(c.phones)} phone number${c.phones === 1 ? "" : "s"}` : "",
        c.unrecognised ? `${fmt(c.unrecognised)} not recognised` : "",
        c.duplicates ? `${fmt(c.duplicates)} repeated` : "",
        parsed.headerSkipped ? "header row left out" : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const status = loading ? (
    <div className="grid gap-1.5">
      <span>Looking up {fmt(c.ids)} candidates…</span>
      <Progress label="Looking up standings" />
    </div>
  ) : adding.length ? (
    `Adding the ${adding.map((p) => PRODUCT_LABEL[p]).join(" / ")} details…`
  ) : looked && !changedSinceLookup ? (
    `${fmt(summary.looked)} looked up · ${fmt(summary.internal)} internally assessed · ${fmt(summary.external)} external`
  ) : c.ids ? (
    `${fmt(c.ids)} to look up${freshness ? ` · pool refetched: ${freshness}` : ""}`
  ) : (
    "Paste UUIDs or phone numbers to start."
  );

  return (
    <div className="grid gap-6">
      <div className="grid max-w-3xl gap-6">
        {notConfigured ? (
          <Notice tone="warning" title="The eligible pool isn't set up">
            There&apos;s no database connection, so standings can&apos;t be looked up. Set it up as described in docs/architecture.md.
          </Notice>
        ) : null}

        <Panel icon={<Users />} title="Candidates" description="UUIDs or phone numbers, one candidate per line — straight from a sheet column.">
          <Field
            label="UUIDs or phone numbers"
            htmlFor="sl-ids"
            info={
              <>
                Each line is matched with the eligible pool by phone number first, then UUID. A line copied from a sheet can hold both (tab or comma
                separated); other cells such as names are ignored. A header row is left out, and blank lines keep their place, so the result lines up
                with your sheet when pasted back.
              </>
            }
            hint={inputLine || "Up to 20,000 lines."}
          >
            <Textarea
              id="sl-ids"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              spellCheck={false}
              autoComplete="off"
              placeholder={"bf031394-f166-4408-8373-b2d7c85382fb\n9876543210\n…"}
              className="tabular-nums"
            />
          </Field>
          {parsed.overflow ? (
            <Notice tone="warning" className="mt-3">
              Only the first 20,000 lines are looked up — {fmt(parsed.overflow)} more were left out. Split the list and look up the rest separately.
            </Notice>
          ) : null}
        </Panel>

        <Panel
          icon={<ListChecks />}
          title={
            <>
              Requirements <span className="font-sans text-xs font-normal text-muted-foreground">(optional)</span>
            </>
          }
          description="Assessment results to add. They go into one Requirements column, listing only the results each candidate has."
          actions={
            keys.length ? (
              <>
                <span className="text-xs text-muted-foreground tabular-nums">{keys.length} picked</span>
                <Button variant="ghost" size="sm" onClick={clearKeys}>
                  Clear
                </Button>
              </>
            ) : null
          }
        >
          <div className="grid gap-3.5">
            {REQUIREMENT_GROUPS.map(({ group, label }) => (
              <div key={group} className="grid gap-1.5 sm:grid-cols-[96px_1fr] sm:items-start">
                <p className="pt-1 text-xs font-medium text-muted-foreground">{label}</p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${label} requirements`}>
                  {REQUIREMENTS.filter((r) => r.group === group).map((r) => {
                    const on = keys.includes(r.key);
                    return (
                      <button
                        key={r.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleKey(r.key)}
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25",
                          on ? "border-primary bg-accent font-medium text-accent-foreground" : "bg-card hover:bg-muted",
                        )}
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <ActionBar status={status}>
          <Button onClick={run} disabled={loading || !c.ids || notConfigured}>
            <Search /> {looked && !changedSinceLookup ? "Look up again" : "Look up standings"}
          </Button>
        </ActionBar>
      </div>

      {error ? (
        <Notice tone="danger" title="The lookup didn't finish">
          {error}
        </Notice>
      ) : null}

      {looked ? (
        <>
          {changedSinceLookup ? (
            <Notice tone="info" action={<Button size="sm" variant="outline" onClick={run} disabled={loading || !c.ids}>Look up again</Button>}>
              The list changed since this lookup. The results below are for the earlier list.
            </Notice>
          ) : null}

          <StatGrid cols={4}>
            <Stat label="Looked up" value={fmt(summary.looked)} hint={summary.unrecognised ? `${fmt(summary.unrecognised)} line${summary.unrecognised === 1 ? "" : "s"} not recognised` : "every line recognised"} />
            <Stat
              label="Internally assessed"
              value={fmt(summary.internal)}
              tone="success"
              hint={`TR-2 / top ${fmt(summary.byTier[1])} · TR-1 ${fmt(summary.byTier[2])} · Assessment ${fmt(summary.byTier[3])}`}
            />
            <Stat label="Assessed, not eligible" value={fmt(summary.notEligible)} hint="didn't clear the assessment" />
            <Stat label="External" value={fmt(summary.external)} hint="not in the eligible pool" />
          </StatGrid>

          <Panel
            flush
            icon={<UserSearch />}
            title="Standings"
            description={`${fmt(rows.length)} rows in the pasted order${freshness ? ` · pool refetched: ${freshness}` : ""}`}
            actions={
              <>
                <Button size="sm" variant="outline" onClick={() => copy(true)} title={`Copies ${[...STANDING_HEADERS, ...(withRequirements ? ["Requirements"] : [])].join(", ")} — to paste beside the IDs in your sheet`}>
                  <Copy /> Copy results
                </Button>
                <Button size="sm" variant="outline" onClick={() => copy(false)} title="Copies every column, IDs included">
                  <Copy /> Copy table
                </Button>
                <Button size="sm" variant="soft" onClick={download}>
                  <Download /> Download CSV
                </Button>
              </>
            }
          >
            {copied ? (
              <p className="border-t px-5 py-2 text-xs text-muted-foreground" role="status">
                {copied}
              </p>
            ) : null}
            {rows.length ? (
              <div className="border-t">
                <Table containerClassName="max-h-[560px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12 text-right">Line</TableHead>
                      <TableHead>UUID</TableHead>
                      {phoneColumn ? <TableHead>Phone</TableHead> : null}
                      <TableHead>Internal standing</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Product</TableHead>
                      {withRequirements ? <TableHead>Requirements</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, limit).map((r) => (
                      <TableRow key={r.line}>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{r.line}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{r.uuid || <span className="text-muted-foreground">—</span>}</TableCell>
                        {phoneColumn ? <TableCell className="whitespace-nowrap tabular-nums">{r.phone || <span className="text-muted-foreground">—</span>}</TableCell> : null}
                        <TableCell className={cn("min-w-[220px]", r.status !== "internal" && "text-muted-foreground")}>
                          {r.status === "blank" ? "" : (r.cells["Internal Standing"] ?? "")}
                        </TableCell>
                        <TableCell>
                          {r.cells["Internal Stage"] ? <Badge variant={r.tier === 1 ? "success" : r.status === "internal" ? "default" : "secondary"}>{r.cells["Internal Stage"]}</Badge> : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{r.cells["Internal Product"] ?? ""}</TableCell>
                        {withRequirements ? (
                          <TableCell className="min-w-[280px] whitespace-pre-line text-[13px] leading-relaxed">
                            {r.requirements.length ? r.requirements.join("\n") : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {rows.length > limit ? (
                  <div className="flex items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground">
                    <span>
                      Showing {fmt(limit)} of {fmt(rows.length)} — copy or download for every row.
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
                      Show {fmt(Math.min(PAGE, rows.length - limit))} more
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="border-t p-5">
                <EmptyState icon={<UserSearch />} title="Nothing to show" description="Paste UUIDs or phone numbers above and look them up." />
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
