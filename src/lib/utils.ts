import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { IdentifierType } from "@/lib/types";

/** shadcn/ui className combiner. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Canonical identifier normalization, shared by the BigQuery enrichment query
 * (server) and the client-side consolidation so the two agree on match keys.
 *   phone → digits only · email → lowercased · uuid → trimmed as-is.
 */
export function normalizeIdentifier(value: string, type: IdentifierType): string {
  const v = (value ?? "").trim();
  if (type === "phone") return v.replace(/[^\d]/g, "");
  if (type === "email") return v.toLowerCase();
  return v;
}

/**
 * BigQuery rows frequently arrive "jagged" — missing keys, nulls, the strings
 * "null"/"NA"/"N/A", or BigQuery's own value wrappers. Normalize everything
 * the UI/export layer touches to a trimmed string ("" when absent).
 */
export function coerceCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  // BigQuery wraps DATE/TIMESTAMP/NUMERIC in objects exposing .value.
  if (typeof value === "object") {
    const v = value as { value?: unknown };
    if ("value" in v) return coerceCell(v.value);
    return "";
  }

  const s = String(value).trim();
  if (s === "" || ["null", "na", "n/a", "undefined", "-"].includes(s.toLowerCase())) {
    return "";
  }
  return s;
}

/** RFC-4180 CSV field escaping. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Build a CSV string from headers + rows of records keyed by header. */
export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const head = headers.map(csvEscape).join(",");
  const body = rows
    .map((row) => headers.map((h) => csvEscape(row[h] ?? "")).join(","))
    .join("\r\n");
  return `${head}\r\n${body}`;
}

/**
 * Parse CSV text into a matrix of rows. Handles quoted fields, escaped quotes
 * (""), and embedded commas/newlines. Trailing blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Strip a UTF-8 BOM if present.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      // Handle \r\n as a single break.
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Flush the last field/row if the file didn't end with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully-empty rows.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Calendar day of an ISO timestamp — "12 Aug 2026", or "2026-08-12" for CSV.
 * Pinned to IST so the server-rendered PDF and the browser table always agree,
 * and a late-night commit isn't shown on the previous UTC day. "" if unparseable.
 */
export function formatDay(iso: string, style: "display" | "iso" = "display"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return style === "iso"
    ? d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** Filesystem-safe slug for naming generated files. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "candidate"
  );
}
