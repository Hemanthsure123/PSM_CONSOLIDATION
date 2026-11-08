import "server-only";
import { UserError } from "@/lib/mobile/http";
import type { RosterUser } from "@/lib/mobile/roster";
import { TRACK_LABEL } from "@/lib/mobile/pool/parse";
import { poolMembersFor } from "@/lib/mobile/pool/service";
import { teamStatus } from "@/lib/team/google";
import { poolDraftsFor } from "@/lib/team/templates";

/**
 * POST /pool/meeting-setup: what the Schedule screen needs for a mock interview (one candidate) or a
 * guidance meet (several) with pool candidates: their emails (from the Academy sheet, never
 * guessed), the message drafts and the team Google account's state. The meeting itself is created
 * by POST /meetings with poolIds.
 */
export async function poolMeetingSetup(user: RosterUser, ids: unknown) {
  const members = await poolMembersFor(user, ids);
  if (!members.length) throw new UserError(422, "Pick at least one candidate.", "invalid_meeting");
  const one = members.length === 1 ? members[0] : null;
  const team = await teamStatus().catch(() => null);
  const drafts = poolDraftsFor({
    candidate: one?.name,
    track: one?.track ? TRACK_LABEL[one.track] : undefined,
    mentor: user.name,
  });
  return {
    members: members.map((m) => ({
      uid: m.uid,
      name: m.name,
      email: m.email,
      phone: m.phone,
      track: m.track,
      mentor: m.mentor,
    })),
    kinds: one ? ["mock", "guidance", "custom"] : ["guidance", "custom"],
    google: team ? { connected: team.connected, account: team.account, status: team.status } : { connected: false, account: "", status: "not_configured" },
    email: drafts.email,
    whatsapp: drafts.whatsapp,
    placeholders: ["{meet_link}", "{when}"],
  };
}
