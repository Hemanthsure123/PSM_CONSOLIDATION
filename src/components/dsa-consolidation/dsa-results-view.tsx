"use client";

import * as React from "react";
import { ArrowLeft, Code2, Download, ExternalLink, Link2Off, Sigma, Trophy, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatTile } from "@/components/charts";
import { cn, toCsv, slugify } from "@/lib/utils";
import { DSA_PLATFORMS, platformOf, type DsaPlatformResult, type DsaResult } from "@/lib/dsa-types";

interface DsaResultsViewProps {
  results: DsaResult[];
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backLabel?: string;
  /** Right-aligned header slot (progress / done actions in the live flow). */
  headerRight?: React.ReactNode;
}

type Field = "solved" | "contests" | "rating";

/**
 * One cell's text, with every "no number" case kept distinct:
 *   ""                   no profile link at all
 *   "Profile not found"  the link points at a profile that doesn't exist
 *   "Unrated"            profile read, but no rated contest yet
 *   "N/A"                the platform couldn't be read (blocked / timed out)
 */
function statText(p: DsaPlatformResult, field: Field): string {
  if (!p.url) return "";
  if (p.found === false) return "Profile not found";
  const value = p[field];
  if (typeof value === "number") return String(value);
  if (field === "rating" && p.found === true && p.contests !== null && p.contests !== undefined) return "Unrated";
  return "N/A";
}

const STATUS_LABEL: Record<DsaResult["status"], string> = {
  ok: "OK",
  partial: "Partial",
  "no-links": "No links",
  error: "Error",
};

const FIELD_LABEL: Record<Field, string> = {
  solved: "Solved",
  contests: "Contests Participated",
  rating: "Rating",
};

const ACCENT: Record<string, string> = { leetcode: "#f59e0b", codeforces: "#ef4444", codechef: "#8b5cf6" };

export function DsaResultsView({ results, title, subtitle, onBack, backLabel = "Back", headerRight }: DsaResultsViewProps) {
  const summary = React.useMemo(() => {
    const withLink: Record<string, number> = { leetcode: 0, codeforces: 0, codechef: 0 };
    let noLinks = 0;
    let totalSolved = 0;
    for (const r of results) {
      let any = false;
      for (const { key } of DSA_PLATFORMS) {
        if (platformOf(r, key).url) {
          withLink[key]++;
          any = true;
        }
      }
      if (!any) noLinks++;
      if (r.totalSolved) totalSolved += r.totalSolved;
    }
    return { withLink, noLinks, totalSolved };
  }, [results]);

  const download = () => {
    const headers = [
      "Mobile Number",
      "Resume",
      ...DSA_PLATFORMS.flatMap(({ label }) => (["solved", "contests", "rating"] as Field[]).map((f) => `${label} ${FIELD_LABEL[f]}`)),
      "Total Solved",
      "Total Contests",
      "Codeforces Max Rating",
      "CodeChef Highest Rating",
      "LeetCode URL",
      "Codeforces URL",
      "CodeChef URL",
      "Link Source",
      "Status",
      "Notes",
    ];
    const rows = results.map((r) => {
      const row: Record<string, string> = {
        "Mobile Number": r.mobile,
        Resume: r.resumeUrl,
        "Total Solved": r.totalSolved !== null ? String(r.totalSolved) : "",
        "Total Contests": typeof r.totalContests === "number" ? String(r.totalContests) : "",
        "Codeforces Max Rating": numberOrBlank(platformOf(r, "codeforces").maxRating),
        "CodeChef Highest Rating": numberOrBlank(platformOf(r, "codechef").maxRating),
        Status: STATUS_LABEL[r.status],
      };
      const sources: string[] = [];
      const notes: string[] = [];
      for (const { key, label } of DSA_PLATFORMS) {
        const p = platformOf(r, key);
        for (const f of ["solved", "contests", "rating"] as Field[]) row[`${label} ${FIELD_LABEL[f]}`] = statText(p, f);
        row[`${label} URL`] = p.url;
        if (p.url && p.source !== "none") sources.push(`${label}: ${p.source}`);
        if (p.url && p.note && p.note !== "OK") notes.push(`${label}: ${p.note}`);
      }
      if (r.error) notes.push(r.error);
      row["Link Source"] = sources.join(" / ");
      row.Notes = notes.join(" | ");
      return row;
    });
    const csv = toCsv(headers, rows);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(title)}-dsa-stats.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" /> {backLabel}
            </Button>
          ) : null}
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Code2 className="h-4 w-4 text-muted-foreground" /> {title}
            </h2>
            {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {headerRight}
          <Button onClick={download} disabled={results.length === 0}>
            <Download className="h-4 w-4" /> Download CSV
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile icon={<Users className="h-5 w-5" />} label="Candidates" value={results.length} accent="#4f46e5" />
        {DSA_PLATFORMS.map(({ key, label }) => (
          <StatTile
            key={key}
            icon={<Code2 className="h-5 w-5" />}
            label={`With ${label}`}
            value={summary.withLink[key]}
            accent={ACCENT[key]}
          />
        ))}
        <StatTile icon={<Sigma className="h-5 w-5" />} label="Total solved" value={summary.totalSolved} accent="#10b981" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="h-4 w-4 text-muted-foreground" /> Solved · contests · rating
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            <Link2Off className="h-3.5 w-3.5" /> {summary.noLinks} candidate
            {summary.noLinks === 1 ? "" : "s"} had no LeetCode / Codeforces / CodeChef link in the sheet or resume.
            Contests are rated contests; hover a cell for the handle and any fetch note.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead rowSpan={2} className="align-bottom">Mobile</TableHead>
                  <TableHead rowSpan={2} className="align-bottom">Resume</TableHead>
                  {DSA_PLATFORMS.map(({ key, label }) => (
                    <TableHead key={key} colSpan={3} className="border-l text-center">
                      {label}
                    </TableHead>
                  ))}
                  <TableHead rowSpan={2} className="border-l text-right align-bottom">Total solved</TableHead>
                  <TableHead rowSpan={2} className="align-bottom">Status</TableHead>
                </TableRow>
                <TableRow>
                  {DSA_PLATFORMS.map(({ key }) => (
                    <React.Fragment key={key}>
                      <TableHead className="border-l text-right text-xs">Solved</TableHead>
                      <TableHead className="text-right text-xs">Contests</TableHead>
                      <TableHead className="text-right text-xs">Rating</TableHead>
                    </React.Fragment>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {r.mobile || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {/^https?:\/\//i.test(r.resumeUrl) ? (
                        <a
                          href={r.resumeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    {DSA_PLATFORMS.map(({ key }) => (
                      <PlatformCells key={key} platform={platformOf(r, key)} />
                    ))}
                    <TableCell className="border-l text-right font-semibold tabular-nums">
                      {r.totalSolved !== null ? r.totalSolved : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function numberOrBlank(n: number | null | undefined): string {
  return typeof n === "number" ? String(n) : "";
}

/** Solved · contests · rating for one platform, with the handle / note on hover. */
function PlatformCells({ platform }: { platform: DsaPlatformResult }) {
  const tip = platform.url
    ? `${platform.handle || platform.url}${platform.note && platform.note !== "OK" ? ` — ${platform.note}` : ""}${
        typeof platform.maxRating === "number" ? ` · max rating ${platform.maxRating}` : ""
      }`
    : "No profile link found";
  return (
    <>
      {(["solved", "contests", "rating"] as Field[]).map((f, i) => {
        const text = statText(platform, f);
        const numeric = /^\d+$/.test(text);
        return (
          <TableCell key={f} className={cn("text-right tabular-nums", i === 0 && "border-l")} title={tip}>
            {!text ? (
              <span className="text-muted-foreground">—</span>
            ) : numeric ? (
              <span className={cn(f === "solved" && "font-medium")}>{text}</span>
            ) : (
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {text === "Profile not found" ? "Not found" : text}
              </span>
            )}
          </TableCell>
        );
      })}
    </>
  );
}

function StatusBadge({ status }: { status: DsaResult["status"] }) {
  const variant: "success" | "secondary" | "destructive" | "outline" =
    status === "ok" ? "success" : status === "partial" ? "secondary" : status === "error" ? "destructive" : "outline";
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}
