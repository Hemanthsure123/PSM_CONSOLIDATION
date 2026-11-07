import { NextResponse } from "next/server";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { syncMentorDropdown } from "@/lib/mobile/mentor-dropdown";
import { listRoster, replaceRoster, type RosterInput } from "@/lib/mobile/roster";

/**
 * GET /admin/roster: the team (admins). PUT: replace it — add people, make admins/leads, deactivate.
 * Also refreshes the control sheet's Mentor dropdown to the active names.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = (u: Awaited<ReturnType<typeof listRoster>>[number]) => ({
  email: u.email,
  name: u.name,
  aliases: u.aliases,
  role: u.role,
  lead: u.leadEmail,
  active: u.active,
  signInEmails: u.signInEmails ?? [],
});

export const GET = withUser(async () => NextResponse.json({ users: (await listRoster()).map(view) }), { admin: true });

export const PUT = withUser(
  async (req, { user }) => {
    const body = await readJson<{ users?: RosterInput[] }>(req);
    if (!Array.isArray(body?.users) || body.users.length > 200) return fail(400, "Send { users: [...] }.", "invalid_request");
    const roster = await replaceRoster(body.users, user);
    const dropdown = await syncMentorDropdown(roster);
    return NextResponse.json({ users: roster.map(view), mentorDropdown: dropdown });
  },
  { admin: true },
);
