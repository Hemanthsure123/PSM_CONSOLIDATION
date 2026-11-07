import "server-only";
import { query, transaction } from "@/lib/db/client";
import { env } from "@/lib/env";
import { UserError } from "@/lib/mobile/http";

/** One person on the roster. `name` is the value in the control sheet's Mentor dropdown. */
export interface RosterUser {
  email: string;
  name: string;
  aliases: string[];
  role: "member" | "lead" | "admin";
  active: boolean;
  leadEmail: string | null;
}

const SELECT = `select email, name, aliases, role, active, lead_email as "leadEmail" from app.users`;

export const normName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The roster entry a Mentor cell names (name or alias, case and punctuation ignored), if any. */
export function matchMentor(cell: string, roster: RosterUser[]): RosterUser | null {
  const key = normName(cell);
  if (!key) return null;
  return (
    roster.find((u) => u.active && (normName(u.name) === key || u.aliases.some((a) => normName(a) === key))) ??
    // "hemanth" in a cell that says "Hemanth (PSM)" or an email typed by hand.
    roster.find((u) => u.active && (key.split(" ")[0] === normName(u.name) || key === normName(u.email))) ??
    null
  );
}

export async function listRoster(): Promise<RosterUser[]> {
  return query<RosterUser>(`${SELECT} order by active desc, role = 'admin' desc, name`);
}

/** MOBILE_ADMIN_EMAILS are admins from their first sign-in, even before anyone adds them. */
export async function ensureBootstrapAdmin(email: string, googleName: string): Promise<void> {
  if (!env.mobile.adminEmails.includes(email)) return;
  await query(
    `insert into app.users (email, name, role, created_by) values ($1, $2, 'admin', 'MOBILE_ADMIN_EMAILS')
     on conflict (email) do update set role = 'admin', active = true, updated_at = now()`,
    [email, (googleName || email.split("@")[0]).slice(0, 80)],
  );
}

export interface RosterInput {
  email: string;
  name: string;
  aliases?: string[];
  role: "member" | "lead" | "admin";
  lead?: string | null;
  active: boolean;
}

/**
 * Replaces the roster with [entries] (admin only). People left out are deactivated, not deleted,
 * so their history stays. Refuses to leave the team without an active admin, or to let an
 * admin remove their own admin rights by accident.
 */
export async function replaceRoster(entries: RosterInput[], by: RosterUser): Promise<RosterUser[]> {
  const domains = env.mobile.allowedEmailDomains;
  const clean = entries.map((e) => ({
    email: String(e.email ?? "").trim().toLowerCase(),
    name: String(e.name ?? "").trim().slice(0, 80),
    aliases: (e.aliases ?? []).map((a) => String(a).trim()).filter(Boolean).slice(0, 10),
    role: (["member", "lead", "admin"].includes(e.role) ? e.role : "member") as RosterUser["role"],
    lead: e.lead ? String(e.lead).trim().toLowerCase() : null,
    active: e.active !== false,
  }));
  for (const e of clean) {
    if (!/^[^@\s]+@[^@\s]+$/.test(e.email)) throw new UserError(422, `"${e.email}" isn't an email address.`, "invalid_roster");
    if (!domains.includes(e.email.split("@")[1])) throw new UserError(422, `${e.email} isn't a NxtWave address (${domains.join(", ")}).`, "invalid_roster");
    if (!e.name) throw new UserError(422, `Give ${e.email} a name: it's what the Mentor dropdown shows.`, "invalid_roster");
  }
  const names = clean.filter((e) => e.active).map((e) => normName(e.name));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new UserError(422, `Two active people are named "${dup}". Names must be unique: they're the Mentor dropdown.`, "invalid_roster");
  if (new Set(clean.map((e) => e.email)).size !== clean.length) throw new UserError(422, "The same email is listed twice.", "invalid_roster");
  if (!clean.some((e) => e.active && e.role === "admin")) throw new UserError(422, "Keep at least one active admin.", "invalid_roster");
  const me = clean.find((e) => e.email === by.email);
  if (!me || !me.active || me.role !== "admin") {
    throw new UserError(422, "You can't remove your own admin access here. Ask another admin.", "invalid_roster");
  }

  await transaction(async (tx) => {
    for (const e of clean) {
      await tx.query(
        `insert into app.users (email, name, aliases, role, active, created_by)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (email) do update set name = excluded.name, aliases = excluded.aliases, role = excluded.role,
           active = excluded.active, updated_at = now()`,
        [e.email, e.name, e.aliases, e.role, e.active, by.email],
      );
    }
    await tx.query("update app.users set active = false, updated_at = now() where not (email = any($1::text[]))", [clean.map((e) => e.email)]);
    // Leads are set after everyone exists (a lead may be added in the same request).
    for (const e of clean) {
      const lead = e.lead && clean.some((x) => x.email === e.lead) ? e.lead : null;
      await tx.query("update app.users set lead_email = $2 where email = $1", [e.email, lead]);
    }
    // Deactivated people lose their sessions and devices at once.
    await tx.query(
      `update app.sessions set revoked_at = now() where revoked_at is null and user_email in (select email from app.users where not active)`,
    );
    await tx.query("delete from app.devices where user_email in (select email from app.users where not active)");
  });
  return listRoster();
}
