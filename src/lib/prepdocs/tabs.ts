import "server-only";
import { google, type docs_v1 } from "googleapis";
import { teamStatus, withTeam } from "@/lib/team/google";

/**
 * Google Docs tabs. A hiring-intelligence document often keeps one tab per round (TR1, TR2, HR…),
 * so a prep document for TR1 must be written from the TR1 tab only. The Docs API is called only as
 * the team Google account (mockinterviews2@…, OAuth client in the psm-team-workspace project, where
 * the Docs API is on and which can read the drill-down documents). Without that account connected,
 * tabs aren't listed and a document is read whole through Drive, as before.
 */

export interface DocTab {
  id: string;
  title: string;
  /** 0 for a top-level tab, 1 for a tab inside it, … */
  level: number;
}

const TTL = 10 * 60_000;
const g = globalThis as unknown as { __docTabs?: Map<string, { at: number; tabs: DocTab[] | null }> };
const cache = (g.__docTabs ??= new Map());

/** True when the team account can be used for the Docs API right now. */
export async function docsAvailable(): Promise<boolean> {
  const team = await teamStatus().catch(() => null);
  return Boolean(team?.connected);
}

/** Runs [work] with the Docs API as the team account (psm-team-workspace). */
function withDocs<T>(work: (docs: docs_v1.Docs) => Promise<T>): Promise<T> {
  return withTeam((auth) => work(google.docs({ version: "v1", auth })));
}

function flatten(tabs: docs_v1.Schema$Tab[] | undefined, level = 0, out: DocTab[] = []): DocTab[] {
  for (const t of tabs ?? []) {
    const id = t.tabProperties?.tabId;
    if (id) out.push({ id, title: (t.tabProperties?.title ?? "").trim() || "Untitled tab", level });
    flatten(t.childTabs, level + 1, out);
  }
  return out;
}

/**
 * The tabs of a Google Doc (with sub-tabs), or null when they can't be read. Cached 10 minutes per
 * document version ([modifiedAt]), so the documents screen stays fast.
 */
export async function docTabs(fileId: string, modifiedAt: string | null): Promise<DocTab[] | null> {
  const key = `${fileId}|${modifiedAt ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.tabs;
  let tabs: DocTab[] | null = null;
  if (!(await docsAvailable())) return null;
  try {
    const res = await withDocs((docs) =>
      docs.documents.get(
        {
          documentId: fileId,
          includeTabsContent: true,
          fields: "tabs(tabProperties(tabId,title,index),childTabs(tabProperties(tabId,title,index),childTabs(tabProperties(tabId,title,index))))",
        },
        { timeout: 8_000 },
      ),
    );
    tabs = flatten(res.data.tabs);
  } catch (err) {
    console.warn("[prep-docs] tabs not readable:", fileId.slice(0, 8), err instanceof Error ? err.message.slice(0, 160) : err);
    tabs = null;
  }
  cache.set(key, { at: Date.now(), tabs });
  if (cache.size > 2_000) cache.clear();
  return tabs;
}

/** Plain text of a structural element list (paragraphs and tables, in order). */
function textOf(content: docs_v1.Schema$StructuralElement[] | undefined): string {
  let out = "";
  for (const el of content ?? []) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements ?? []) out += pe.textRun?.content ?? "";
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        out += `${(row.tableCells ?? []).map((c) => textOf(c.content).replace(/\s+/g, " ").trim()).join(" | ")}\n`;
      }
    } else if (el.sectionBreak || el.tableOfContents) {
      out += "\n";
    }
  }
  return out;
}

function collect(tabs: docs_v1.Schema$Tab[] | undefined, wanted: Set<string>, out: { title: string; text: string }[]): void {
  for (const t of tabs ?? []) {
    const id = t.tabProperties?.tabId ?? "";
    if (wanted.has(id)) out.push({ title: (t.tabProperties?.title ?? "").trim(), text: textOf(t.documentTab?.body?.content) });
    collect(t.childTabs, wanted, out);
  }
}

/**
 * The text of the chosen tabs only (all tabs when [tabIds] is null), each under its title.
 * Throws when the document can't be read.
 */
export async function readTabsText(fileId: string, tabIds: string[] | null): Promise<{ title: string; modifiedAt: string | null; text: string }> {
  const res = await withDocs((docs) => docs.documents.get({ documentId: fileId, includeTabsContent: true }, { timeout: 30_000 }));
  const parts: { title: string; text: string }[] = [];
  const wanted = new Set(tabIds ?? flatten(res.data.tabs).map((t) => t.id));
  collect(res.data.tabs, wanted, parts);
  if (!parts.length) throw new Error("The chosen tabs are no longer in the document. Refresh and pick again.");
  return {
    title: tabIds ? `${res.data.title ?? ""} (${parts.map((p) => p.title).join(", ")})` : (res.data.title ?? ""),
    modifiedAt: null,
    text: parts.map((p) => `## ${p.title}\n${p.text.trim()}`).join("\n\n"),
  };
}
