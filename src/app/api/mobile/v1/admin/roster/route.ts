import { NextResponse } from "next/server";
import { devicesByUser, type RosterDevice } from "@/lib/mobile/device-health";
import { fail, readJson, withUser } from "@/lib/mobile/http";
import { syncMentorDropdown } from "@/lib/mobile/mentor-dropdown";
import { listRoster, replaceRoster, type RosterInput } from "@/lib/mobile/roster";

/**
 * GET /admin/roster: the team (admins). PUT: replace it — add people, make admins/leads, deactivate.
 * Also refreshes the control sheet's Mentor dropdown to the active names.
 * 1.11.0: each person carries `devices` (their signed-in phones and notification health; [] when
 * none). A failure reading the devices answers the roster with empty lists.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = (u: Awaited<ReturnType<typeof listRoster>>[number], devices: Map<string, RosterDevice[]>) => ({
  email: u.email,
  name: u.name,
  aliases: u.aliases,
  role: u.role,
  lead: u.leadEmail,
  active: u.active,
  signInEmails: u.signInEmails ?? [],
  devices: devices.get(u.email) ?? [],
});

const loadDevices = () =>
  devicesByUser().catch((err) => {
    console.warn("[mobile] roster devices not read:", err instanceof Error ? err.message.slice(0, 200) : err);
    return new Map<string, RosterDevice[]>();
  });

export const GET = withUser(
  async () => {
    const [roster, devices] = await Promise.all([listRoster(), loadDevices()]);
    return NextResponse.json({ users: roster.map((u) => view(u, devices)) });
  },
  { admin: true },
);

export const PUT = withUser(
  async (req, { user }) => {
    const body = await readJson<{ users?: RosterInput[] }>(req);
    if (!Array.isArray(body?.users) || body.users.length > 200) return fail(400, "Send { users: [...] }.", "invalid_request");
    const roster = await replaceRoster(body.users, user);
    const [dropdown, devices] = await Promise.all([syncMentorDropdown(roster), loadDevices()]);
    return NextResponse.json({ users: roster.map((u) => view(u, devices)), mentorDropdown: dropdown });
  },
  { admin: true },
);
