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
  /** Other Google accounts this person may sign in with (admin-linked, app.user_logins). */
  signInEmails?: string[];
}

const SELECT = `select u.email, u.name, u.aliases, u.role, u.active, u.lead_email as "leadEmail",
  coalesce((select array_agg(l.login_email order by l.login_email) from app.user_logins l where l.user_email = u.email), '{}') as "signInEmails"
  from app.users u`;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const MAX_SIGN_IN_EMAILS = 5;

/**
 * The roster person a Google account signs in as: their roster email, or an account linked to
 * them. Null when the account isn't on the roster at all. Inactive people are returned (the
 * caller refuses them with a clear message).
 */
export function resolveSignIn(googleEmail: string, roster: RosterUser[]): RosterUser | null {
  const email = googleEmail.trim().toLowerCase();
  if (!email) return null;
  return roster.find((u) => u.email === email) ?? roster.find((u) => (u.signInEmails ?? []).includes(email)) ?? null;
}

/**
 * Cleans and checks every person's linked sign-in accounts. Each must be a real address, not
 * anyone's roster email, and linked to one person only. Returns them lower-cased, de-duplicated.
 */
export function cleanSignInEmails(entries: { email: string; signInEmails?: unknown }[]): Map<string, string[]> {
  const primaries = new Set(entries.map((e) => e.email));
  const owner = new Map<string, string>();
  const out = new Map<string, string[]>();
  for (const e of entries) {
    const raw = Array.isArray(e.signInEmails) ? e.signInEmails : [];
    const list = [...new Set(raw.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean))];
    if (list.length > MAX_SIGN_IN_EMAILS) throw new UserError(422, `${e.email} can have at most ${MAX_SIGN_IN_EMAILS} extra sign-in accounts.`, "invalid_roster");
    for (const l of list) {
      if (!EMAIL_RE.test(l) || l.length > 254) throw new UserError(422, `"${l}" isn't an email address.`, "invalid_roster");
      if (l === e.email) throw new UserError(422, `${l} is already ${e.email}'s roster email.`, "invalid_roster");
      if (primaries.has(l)) throw new UserError(422, `${l} is someone else's roster email, so it can't be linked to ${e.email}.`, "invalid_roster");
      const taken = owner.get(l);
      if (taken) throw new UserError(422, `${l} is linked to both ${taken} and ${e.email}. One Google account signs in as one person.`, "invalid_roster");
      owner.set(l, e.email);
    }
    out.set(e.email, list);
  }
  return out;
}

export const normName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The roster entry a Mentor cell names (name or alias, case and punctuation ignored), if any. */
export function matchMentor(cell: string, roster: RosterUser[]): RosterUser | null {
  const key = normName(cell);
  if (!key) return null;
  return (
    roster.find((u) => u.active && (normName(u.name) === key || u.aliases.some((a) => normName(a) === key))) ??
    // "hemanth" in a cell that says "Hemanth (PSM)" or an email typed by hand (roster or linked account).
    roster.find(
      (u) =>
        u.active &&
        (key.split(" ")[0] === normName(u.name) || key === normName(u.email) || (u.signInEmails ?? []).some((l) => key === normName(l))),
    ) ??
    null
  );
}

export async function listRoster(): Promise<RosterUser[]> {
  return query<RosterUser>(`${SELECT} order by u.active desc, u.role = 'admin' desc, u.name`);
}

/** One roster person by roster email, with their linked accounts. */
export async function rosterUser(email: string): Promise<RosterUser | null> {
  return (await query<RosterUser>(`${SELECT} where u.email = $1`, [email]))[0] ?? null;
}

/** The roster person a signed-in Google account maps to (roster email first, then linked accounts). */
export async function rosterUserForSignIn(googleEmail: string): Promise<RosterUser | null> {
  const rows = await query<RosterUser>(
    `${SELECT} where u.email = $1 or u.email = (select user_email from app.user_logins where login_email = $1)`,
    [googleEmail],
  );
  return resolveSignIn(googleEmail, rows);
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
  /** Linked Google accounts. Omitted = keep what's stored; [] = remove all. */
  signInEmails?: string[];
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
    keepLogins: e.signInEmails === undefined,
    signInEmails: e.signInEmails,
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
  // People who didn't send signInEmails keep their stored links (older app versions don't know the field).
  const stored = new Map((await listRoster()).map((u) => [u.email, u.signInEmails ?? []]));
  const logins = cleanSignInEmails(clean.map((e) => ({ email: e.email, signInEmails: e.keepLogins ? stored.get(e.email) ?? [] : e.signInEmails })));

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
    // Linked sign-in accounts: replaced for everyone in the request (a removed link signs out at once).
    const listed = clean.map((e) => e.email);
    const keep = clean.flatMap((e) => logins.get(e.email) ?? []);
    const dropped = await tx.query<{ login_email: string }>(
      "delete from app.user_logins where (user_email = any($1::text[]) or login_email = any($2::text[])) returning login_email",
      [listed, keep],
    );
    for (const e of clean) {
      for (const l of logins.get(e.email) ?? []) {
        await tx.query("insert into app.user_logins (login_email, user_email, created_by) values ($1, $2, $3)", [l, e.email, by.email]);
      }
    }
    const unlinked = dropped.rows.map((r) => r.login_email).filter((l) => !keep.includes(l));
    if (unlinked.length) {
      await tx.query("update app.sessions set revoked_at = now() where revoked_at is null and login_email = any($1::text[])", [unlinked]);
    }
    // Deactivated people lose their sessions and devices at once.
    await tx.query(
      `update app.sessions set revoked_at = now() where revoked_at is null and user_email in (select email from app.users where not active)`,
    );
    await tx.query("delete from app.devices where user_email in (select email from app.users where not active)");
  });
  return listRoster();
}
