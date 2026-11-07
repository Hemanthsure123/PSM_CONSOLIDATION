import "server-only";
import { signValue, verifyValue } from "@/lib/team/secret";

/** The public origin the browser sees (Render sits behind a proxy). */
export function publicOrigin(req: Request): string {
  const configured = (process.env.APP_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

export const callbackUrl = (req: Request) => `${publicOrigin(req)}/api/integrations/google/callback`;

/** A 10-minute link an admin opens from the app to connect the team account. */
export function adminConnectToken(adminEmail: string): string {
  return signValue({ purpose: "team-connect", admin: adminEmail }, 600);
}

export function readAdminConnectToken(t: string | null): string | null {
  if (!t) return null;
  const v = verifyValue<{ purpose?: string; admin?: string }>(t);
  return v?.purpose === "team-connect" && v.admin ? v.admin : null;
}

/** The same Basic sign-in as the web app (or none configured, as in local development). */
export function basicAuthAdmin(req: Request): string | null {
  const expected = process.env.APP_BASIC_AUTH?.trim();
  if (!expected) return "local-admin";
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return null;
  let given = "";
  try {
    given = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  return given === expected ? `web:${expected.split(":")[0]}` : null;
}

export function oauthState(admin: string): string {
  return signValue({ purpose: "team-oauth", admin }, 900);
}

export function readOauthState(state: string | null): string | null {
  if (!state) return null;
  const v = verifyValue<{ purpose?: string; admin?: string }>(state);
  return v?.purpose === "team-oauth" && v.admin ? v.admin : null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A small result page (the admin sees it in their browser after Google sign-in). [body] is plain text. */
export function page(title: string, body: string, ok: boolean): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f3f5f9;color:#152238;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border:1px solid #e1e6ee;border-radius:14px;padding:28px;max-width:440px;margin:16px}
h1{font-size:20px;margin:0 0 8px;color:${ok ? "#0f7b55" : "#c8372d"}}p{line-height:1.5;margin:0}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
