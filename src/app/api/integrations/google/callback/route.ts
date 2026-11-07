import { query } from "@/lib/db/client";
import { callbackUrl, page, readOauthState } from "@/lib/team/connect";
import { completeConsent, TeamAccountError } from "@/lib/team/google";

/** GET /api/integrations/google/callback — Google sends the admin back here after consent. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const admin = readOauthState(url.searchParams.get("state"));
  if (!admin) return page("Link expired", "This sign-in link is no longer valid. Start again from the app (Me → Team).", false);
  const denied = url.searchParams.get("error");
  if (denied) return page("Not connected", `Google said: ${denied}. Nothing was changed.`, false);
  const code = url.searchParams.get("code");
  if (!code) return page("Not connected", "Google didn't send a sign-in code. Try again.", false);
  try {
    const { account } = await completeConsent(code, callbackUrl(req), admin);
    await query("insert into app.audit_log (actor_email, action, target) values ($1, 'team_account_connected', $2)", [admin, account]).catch(() => undefined);
    return page(
      "Team account connected",
      `${account} is connected. Prep documents, Meet links and invites will be created from it. You can close this page and go back to the app.`,
      true,
    );
  } catch (err) {
    if (!(err instanceof TeamAccountError)) console.error("[team] consent failed:", err instanceof Error ? err.message.slice(0, 300) : err);
    return page("Not connected", err instanceof TeamAccountError ? err.message : "Google refused the sign-in. Try again.", false);
  }
}
