import "server-only";
import { google, type docs_v1 } from "googleapis";
import { env } from "@/lib/env";
import { teamStatus, withTeam } from "@/lib/team/google";

/**
 * Google Docs tabs. A hiring-intelligence document often keeps one tab per round (TR1, TR2, HR…),
 * so a prep document for TR1 must be written from the TR1 tab only. Tabs are read with the Docs
 * API: first as the service account (the same identity that reads the drill-down links), then as
 * the team Google account when the service account can't (the API is off in its project, or the
 * document isn't shared with it). Without either, a document is read whole, as before.
 */

export interface DocTab {
  id: string;
  title: string;
  /** 0 for a top-level tab, 1 for a tab inside it, … */
  level: number;
}

const TTL = 10 * 60_000;
const g = globalThis as unknown as { __docsApi?: docs_v1.Docs; __docTabs?: Map<string, { at: number; tabs: DocTab[] | null }> };
const cache = (g.__docTabs ??= new Map());

function serviceDocs(): docs_v1.Docs {
  g.__docsApi ??= google.docs({
    version: "v1",
    auth: new google.auth.JWT({
      email: env.gcp.clientEmail,
      key: env.gcp.privateKey,
      scopes: ["https://www.googleapis.com/auth/documents.readonly"],
      ...(env.drive.impersonateUser ? { subject: env.drive.impersonateUser } : {}),
    }),
  });
  return g.__docsApi;
}

/** Runs [work] as the service account, then as the team account if that one can't. */
async function withDocs<T>(work: (docs: docs_v1.Docs) => Promise<T>): Promise<T> {
  try {
    return await work(serviceDocs());
  } catch (first) {
    const team = await teamStatus().catch(() => null);
    if (!team?.connected) throw first;
    return withTeam((auth) => work(google.docs({ version: "v1", auth })));
  }
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

/** The text of the chosen tabs only, each under its title. Throws when the document can't be read. */
export async function readTabsText(fileId: string, tabIds: string[]): Promise<{ title: string; modifiedAt: string | null; text: string }> {
  const res = await withDocs((docs) => docs.documents.get({ documentId: fileId, includeTabsContent: true }, { timeout: 30_000 }));
  const parts: { title: string; text: string }[] = [];
  collect(res.data.tabs, new Set(tabIds), parts);
  if (!parts.length) throw new Error("The chosen tabs are no longer in the document. Refresh and pick again.");
  return {
    title: `${res.data.title ?? ""} (${parts.map((p) => p.title).join(", ")})`,
    modifiedAt: null,
    text: parts.map((p) => `## ${p.title}\n${p.text.trim()}`).join("\n\n"),
  };
}
