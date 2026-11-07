import "server-only";
import type { NotionBlock } from "@/lib/prepdocs/render";

/**
 * Notion pages for prep documents (NOTION_API_TOKEN of an internal integration created by the team
 * account, NOTION_PREP_PARENT_PAGE_ID shared with it). Pages are created under the parent page; to
 * make them viewable by anyone with the link, the parent page is published once ("Share → Publish")
 * — child pages inherit it. The API itself can't publish pages.
 */

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export function notionConfigured(): boolean {
  return Boolean(process.env.NOTION_API_TOKEN?.trim() && process.env.NOTION_PREP_PARENT_PAGE_ID?.trim());
}

/** "4116cf31623f80598c97eaa8d1725f0d" or a page URL → the dashed page id. */
export function notionId(raw: string): string {
  const hex = (raw.match(/[0-9a-f]{32}/i)?.[0] ?? raw.replace(/-/g, "")).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("Not a Notion page id.");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function call<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_TOKEN?.trim()}`,
      "Notion-Version": VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429 && attempt < 4) {
    const wait = Number(res.headers.get("retry-after") ?? 1) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
    return call(method, path, body, attempt + 1);
  }
  const json = (await res.json().catch(() => ({}))) as T & { message?: string; code?: string };
  if (!res.ok) throw new Error(`Notion: ${json.message ?? res.status}${json.code ? ` (${json.code})` : ""}`);
  return json;
}

const titleProp = (title: string) => ({ title: [{ type: "text", text: { content: title.slice(0, 1900) } }] });

/** Appends blocks in batches of 100 (Notion's limit per request). Tables carry their rows inline. */
async function appendBlocks(pageId: string, blocks: NotionBlock[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += 100) {
    await call("PATCH", `/blocks/${pageId}/children`, { children: blocks.slice(i, i + 100) });
  }
}

export async function createNotionPage(title: string, blocks: NotionBlock[]): Promise<{ id: string; url: string }> {
  if (!notionConfigured()) throw new Error("Notion isn't set up on the server (NOTION_API_TOKEN, NOTION_PREP_PARENT_PAGE_ID).");
  const page = await call<{ id: string; url: string }>("POST", "/pages", {
    parent: { page_id: notionId(process.env.NOTION_PREP_PARENT_PAGE_ID!) },
    properties: { title: titleProp(title) },
    children: blocks.slice(0, 100),
  });
  await appendBlocks(page.id, blocks.slice(100));
  return { id: page.id, url: page.url };
}

/** Replaces a page's title and content (same page, same link). */
export async function replaceNotionPage(pageId: string, title: string, blocks: NotionBlock[]): Promise<{ id: string; url: string }> {
  const page = await call<{ id: string; url: string }>("PATCH", `/pages/${pageId}`, { properties: { title: titleProp(title) }, archived: false });
  let cursor: string | undefined;
  const old: string[] = [];
  do {
    const r = await call<{ results: { id: string }[]; next_cursor: string | null; has_more: boolean }>("GET", `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    old.push(...r.results.map((b) => b.id));
    cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
  } while (cursor);
  for (const id of old) await call("DELETE", `/blocks/${id}`);
  await appendBlocks(pageId, blocks);
  return { id: page.id, url: page.url };
}

/** The page's text (headings, paragraphs, bullets, callouts, table rows), for an update to build on. */
export async function readNotionText(pageId: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (id: string, depth: number) => {
    let cursor: string | undefined;
    do {
      const r = await call<{ results: Record<string, any>[]; next_cursor: string | null; has_more: boolean }>(
        "GET",
        `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      );
      for (const b of r.results) {
        const body = b[b.type] ?? {};
        if (b.type === "table_row") lines.push((body.cells ?? []).map((c: any[]) => c.map((t) => t.plain_text).join("")).join(" | "));
        else if (Array.isArray(body.rich_text)) lines.push(body.rich_text.map((t: any) => t.plain_text).join(""));
        if (b.has_children && depth < 2) await walk(b.id, depth + 1);
      }
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor);
  };
  await walk(pageId, 0);
  return lines.filter(Boolean).join("\n");
}

/** Health check: the integration can read the parent page. */
export async function notionCheck(): Promise<{ ok: boolean; message: string }> {
  if (!notionConfigured()) return { ok: false, message: "Not configured." };
  try {
    await call("GET", `/pages/${notionId(process.env.NOTION_PREP_PARENT_PAGE_ID!)}`);
    return { ok: true, message: "The parent page is reachable." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
