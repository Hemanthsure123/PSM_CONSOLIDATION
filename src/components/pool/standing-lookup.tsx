"use client";

import * as React from "react";
import { Copy, Download, ExternalLink, Filter, Search, UserSearch, Users } from "lucide-react";
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
import { Segmented } from "@/components/ui/segmented";
import { Stat, StatGrid } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ago } from "@/components/pool/eligible-pool";
import { LookupFind, type FindFilter } from "@/components/pool/lookup-find";
import { LookupRequirements } from "@/components/pool/lookup-requirements";
import { fetchPoolSummary, findPoolPeople, lookupPoolStandings } from "@/lib/pool/client";
import {
  DEFAULT_LOOKUP_OPTIONS,
  cleanRequirementKeys,
  includesNeeded,
  lookupColumns,
  lookupRows,
  parseLookupInput,
  summarise,
  toHtmlTable,
  toTsv,
  type LookupData,
  type LookupInclude,
  type LookupInput,
  type LookupOptions,
  type OutputColumn,
} from "@/lib/pool/lookup";
import { PRODUCT_LABEL, type CandidateStanding, type PersonRecords, type Product } from "@/lib/pool/types";

const fmt = (n: number) => n.toLocaleString("en-IN");
const PAGE = 200;
const KEYS_STORAGE = "standing-lookup:requirements";
const OPTIONS_STORAGE = "standing-lookup:options";

function loadKeys(): string[] {
  try {
    const raw = window.localStorage.getItem(KEYS_STORAGE);
    return raw ? cleanRequirementKeys(JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function loadOptions(): LookupOptions {
  try {
    const o = JSON.parse(window.localStorage.getItem(OPTIONS_STORAGE) ?? "{}") as Partial<LookupOptions>;
    const d = DEFAULT_LOOKUP_OPTIONS;
    return {
      attempts: o.attempts === "latest" || o.attempts === "all" ? o.attempts : d.attempts,
      layout: o.layout === "columns" ? "columns" : d.layout,
      verdict: typeof o.verdict === "boolean" ? o.verdict : d.verdict,
      date: typeof o.date === "boolean" ? o.date : d.date,
      recording: typeof o.recording === "boolean" ? o.recording : d.recording,
    };
  } catch {
    return DEFAULT_LOOKUP_OPTIONS;
  }
}

function save(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
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

const INCLUDE_LABEL = (i: LookupInclude) => (i === "scores" ? "marks" : i === "profile" ? "college / year" : PRODUCT_LABEL[i as Product]);

type Mode = "paste" | "find";

/** One cell of the results table, styled by what the column holds. */
function ResultCell({ col, value, row }: { col: OutputColumn; value: string; row: { status: string; tier: number | null } }) {
  const empty = <span className="text-muted-foreground">—</span>;
  switch (col.kind) {
    case "id":
      return <TableCell className="whitespace-nowrap tabular-nums">{value || empty}</TableCell>;
    case "eligibility":
      return (
        <TableCell className="whitespace-nowrap">
          {value ? <Badge variant={row.status === "internal" ? "success" : "secondary"}>{value}</Badge> : null}
        </TableCell>
      );
    case "standing":
      if (col.header === "Internal Stage") {
        return <TableCell>{value ? <Badge variant={row.tier === 1 ? "success" : row.status === "internal" ? "default" : "secondary"}>{value}</Badge> : null}</TableCell>;
      }
      return <TableCell className={cn(col.header === "Internal Standing" ? "min-w-[220px]" : "whitespace-nowrap", row.status !== "internal" && "text-muted-foreground")}>{row.status === "blank" ? "" : value}</TableCell>;
    case "text":
      return (
        <TableCell className={cn("text-[13px] leading-relaxed", col.header === "Requirements" ? "min-w-[280px] whitespace-pre-line" : "min-w-[160px] max-w-[320px]")}>
          {value ? (/^https?:\/\//.test(value) ? <LinkOut href={value} label="Open" /> : value) : empty}
        </TableCell>
      );
    case "score":
      return <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">{value || empty}</TableCell>;
    case "verdict":
      return <TableCell className="min-w-[160px] max-w-[320px] text-[13px]">{value || empty}</TableCell>;
    case "date":
      return <TableCell className="whitespace-nowrap text-[13px] tabular-nums">{value || empty}</TableCell>;
    case "recording":
      return <TableCell className="whitespace-nowrap text-[13px]">{value ? <LinkOut href={value} label="Recording" /> : empty}</TableCell>;
  }
}

function LinkOut({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" title={href} className="inline-flex items-center gap-1 text-primary hover:underline">
      {label} <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/**
 * Standing lookup — paste UUIDs or phone numbers (or find everyone assessed from a college /
 * graduation year / above a mark / by job eligibility), get each candidate's internal standing
 * (Edge 2.0, Edge 1.0 and Academy assessments; no resume involved): Internal Standing, Stage and
 * Product, Job Eligibility (Eligible = in the eligible pool), plus the details picked. Marks — the Academy's exams and interviews, Edge 2.0's scores — always
 * get columns of their own ("DSA offline exam (130)" holding only the marks obtained), with the
 * verdict, date and recording beside them when asked for. Rows keep the pasted order, so the
 * result can be pasted straight back into the sheet.
 */
export function StandingLookup() {
  const [mode, setMode] = React.useState<Mode>("paste");
  const [text, setText] = React.useState("");
  const [keys, setKeys] = React.useState<string[]>([]);
  const [opts, setOpts] = React.useState<LookupOptions>(DEFAULT_LOOKUP_OPTIONS);
  const [looked, setLooked] = React.useState<{ text: string; input: LookupInput } | null>(null);
  const [data, setData] = React.useState<(LookupData & { fetched: LookupInclude[] }) | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [adding, setAdding] = React.useState<LookupInclude[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [notConfigured, setNotConfigured] = React.useState(false);
  const [freshness, setFreshness] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(PAGE);
  const [filter, setFilter] = React.useState<{ f: FindFilter; ready: boolean }>({ f: { colleges: [], yogs: [], eligibility: "all" }, ready: false });
  const [finding, setFinding] = React.useState(false);
  const [found, setFound] = React.useState<string | null>(null);
  useReportBusy(loading || finding || adding.length > 0);

  React.useEffect(() => {
    setKeys(loadKeys());
    setOpts(loadOptions());
  }, []);

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

  const setKeyList = (next: string[]) => {
    const clean = cleanRequirementKeys(next);
    save(KEYS_STORAGE, clean);
    return clean;
  };
  const toggleKey = (key: string) => setKeys((prev) => setKeyList(prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  const setMany = (add: string[], remove: string[]) => setKeys((prev) => setKeyList([...prev.filter((k) => !remove.includes(k)), ...add]));
  const clearKeys = () => setKeys(setKeyList([]));
  const setOption = (patch: Partial<LookupOptions>) =>
    setOpts((o) => {
      const next = { ...o, ...patch };
      save(OPTIONS_STORAGE, next);
      return next;
    });
  const onFilter = React.useCallback((f: FindFilter, ready: boolean) => setFilter({ f, ready }), []);

  const run = async (source: string = text) => {
    const input = parseLookupInput(source);
    const people = peopleOf(input);
    if (!people.length) return;
    const include = includesNeeded(keys);
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
    setLooked({ text: source, input });
    setData({ standings: res.data.standings, assessed: res.data.assessed, records: res.data.records, scores: res.data.scores, profiles: res.data.profiles, fetched: include });
    setLimit(PAGE);
  };

  // A requirement picked after the lookup that needs other data: fetch just that.
  React.useEffect(() => {
    if (!looked || !data || loading) return;
    const missing = includesNeeded(keys).filter((p) => !data.fetched.includes(p) && !adding.includes(p));
    if (!missing.length) return;
    setAdding((a) => [...a, ...missing]);
    lookupPoolStandings(peopleOf(looked.input), missing).then((res) => {
      setAdding((a) => a.filter((p) => !missing.includes(p)));
      if (!res.ok) {
        // Not retried on its own (no loop): "Look up again" fetches everything afresh.
        setError(`Couldn't add the ${missing.map(INCLUDE_LABEL).join(" / ")} details: ${res.error} Look up again to retry.`);
        setData((d) => (d ? { ...d, fetched: [...new Set([...d.fetched, ...missing])] } : d));
        return;
      }
      setData((d) => {
        if (!d) return d;
        const records: Record<string, PersonRecords> = { ...d.records };
        for (const [id, r] of Object.entries(res.data.records)) records[id] = { ...records[id], ...r };
        const standings: Record<string, CandidateStanding> = { ...d.standings, ...res.data.standings };
        return {
          standings,
          assessed: { ...d.assessed, ...res.data.assessed },
          records,
          scores: res.data.scores ? { ...d.scores, ...res.data.scores } : d.scores,
          profiles: res.data.profiles ? { ...d.profiles, ...res.data.profiles } : d.profiles,
          fetched: [...new Set([...d.fetched, ...missing])],
        };
      });
    });
  }, [keys, looked, data, loading, adding]);

  /** Find everyone matching the filter, put them in the list (UUID + phone) and look them up. */
  const find = async () => {
    setFinding(true);
    setError(null);
    setFound(null);
    const res = await findPoolPeople(filter.f);
    setFinding(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (!res.data.people.length) {
      setFound("Nobody assessed matches this filter — widen it and try again.");
      return;
    }
    const lines = ["UUID\tPhone", ...res.data.people.map((p) => `${p.userId ?? ""}\t${p.phone ?? ""}`)].join("\n");
    setText(lines);
    setMode("paste");
    setFound(
      `${fmt(res.data.total)} found${res.data.truncated ? ` — the first ${fmt(res.data.people.length)} are listed` : ""}${filter.f.assessment ? ", best mark first" : ""}. They are in the list below; pick the details you need.`,
    );
    await run(lines);
  };

  const rows = React.useMemo(() => (looked && data ? lookupRows(looked.input, data, keys) : []), [looked, data, keys]);
  const summary = React.useMemo(() => summarise(rows), [rows]);
  const phoneColumn = Boolean(looked?.input.counts.phones);
  const columns = React.useMemo(() => lookupColumns(rows, { phoneColumn, keys, options: opts }), [rows, phoneColumn, keys, opts]);
  const table = React.useMemo(() => ({ headers: columns.map((c) => c.header), rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c.header, c.value(r)]))) }), [columns, rows]);
  const resultHeaders = columns.filter((c) => c.kind !== "id").map((c) => c.header);

  const copy = async (resultsOnly: boolean) => {
    const headers = resultsOnly ? resultHeaders : table.headers;
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
        `Copied ${fmt(table.rows.length)} rows${withHeader ? " with the header" : ""}${resultsOnly ? ` (${headers.length} columns)` : ""} — paste them into the sheet${resultsOnly ? " beside your IDs" : ""}.`,
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
  ) : finding ? (
    <div className="grid gap-1.5">
      <span>Finding candidates…</span>
      <Progress label="Finding candidates" />
    </div>
  ) : adding.length ? (
    `Adding the ${adding.map(INCLUDE_LABEL).join(" / ")} details…`
  ) : mode === "find" ? (
    filter.ready ? "Finds everyone assessed who matches, then looks them up." : "Pick eligibility, a college, a year of graduation or a minimum mark."
  ) : looked && !changedSinceLookup ? (
    `${fmt(summary.looked)} looked up · ${fmt(summary.internal)} eligible · ${fmt(summary.notEligible + summary.assessedOnly)} not eligible · ${fmt(summary.external)} external`
  ) : c.ids ? (
    `${fmt(c.ids)} to look up${freshness ? ` · pool refetched: ${freshness}` : ""}`
  ) : (
    "Paste UUIDs or phone numbers to start."
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
        {notConfigured ? (
          <Notice tone="warning" title="The eligible pool isn't set up">
            There&apos;s no database connection, so standings can&apos;t be looked up. Set it up as described in docs/architecture.md.
          </Notice>
        ) : null}

        <Segmented
          ariaLabel="How to choose candidates"
          value={mode}
          onChange={setMode}
          options={[
            { value: "paste", label: "Paste IDs" },
            { value: "find", label: "Find by college / year / marks" },
          ]}
          className="justify-self-start"
        />

        <div className={cn(mode !== "paste" && "hidden")}>
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
            {found ? <p className="mt-2 text-xs text-muted-foreground">{found}</p> : null}
            {parsed.overflow ? (
              <Notice tone="warning" className="mt-3">
                Only the first 20,000 lines are looked up — {fmt(parsed.overflow)} more were left out. Split the list and look up the rest separately.
              </Notice>
            ) : null}
          </Panel>
        </div>
        <div className={cn(mode !== "find" && "hidden")}>
          <LookupFind onChange={onFilter} note={mode === "find" ? found : null} />
        </div>

        <LookupRequirements keys={keys} options={opts} onToggle={toggleKey} onSetMany={setMany} onClear={clearKeys} onOption={setOption} />

        <ActionBar status={status}>
          {mode === "find" ? (
            <Button onClick={() => void find()} disabled={finding || loading || !filter.ready || notConfigured}>
              <Filter /> Find candidates
            </Button>
          ) : (
            <Button onClick={() => void run()} disabled={loading || !c.ids || notConfigured}>
              <Search /> {looked && !changedSinceLookup ? "Look up again" : "Look up standings"}
            </Button>
          )}
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
            <Notice tone="info" action={<Button size="sm" variant="outline" onClick={() => void run()} disabled={loading || !c.ids}>Look up again</Button>}>
              The list changed since this lookup. The results below are for the earlier list.
            </Notice>
          ) : null}

          <StatGrid cols={4}>
            <Stat label="Looked up" value={fmt(summary.looked)} hint={summary.unrecognised ? `${fmt(summary.unrecognised)} line${summary.unrecognised === 1 ? "" : "s"} not recognised` : "every line recognised"} />
            <Stat
              label="Eligible for jobs"
              value={fmt(summary.internal)}
              tone="success"
              hint={`TR-2 / top ${fmt(summary.byTier[1])} · TR-1 ${fmt(summary.byTier[2])} · Assessment ${fmt(summary.byTier[3])}`}
            />
            <Stat
              label="Not eligible"
              value={fmt(summary.notEligible + summary.assessedOnly)}
              hint={`${fmt(summary.assessedOnly)} assessed, not in the pool · ${fmt(summary.notEligible)} didn't clear`}
            />
            <Stat label="External" value={fmt(summary.external)} hint="not assessed internally" />
          </StatGrid>

          <Panel
            flush
            icon={<UserSearch />}
            title="Standings"
            description={`${fmt(rows.length)} rows in the pasted order · ${fmt(columns.length)} columns${freshness ? ` · pool refetched: ${freshness}` : ""}`}
            actions={
              <>
                <Button size="sm" variant="outline" onClick={() => void copy(true)} title={`Copies ${resultHeaders.join(", ")} — to paste beside the IDs in your sheet`}>
                  <Copy /> Copy results
                </Button>
                <Button size="sm" variant="outline" onClick={() => void copy(false)} title="Copies every column, IDs included">
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
                      {columns.map((col) => (
                        <TableHead key={col.header} className={cn("whitespace-nowrap", col.kind === "score" && "text-right")}>
                          {col.header}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, limit).map((r) => (
                      <TableRow key={r.line}>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{r.line}</TableCell>
                        {columns.map((col) => (
                          <ResultCell key={col.header} col={col} value={col.value(r)} row={r} />
                        ))}
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
