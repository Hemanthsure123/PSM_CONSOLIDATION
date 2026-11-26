import "server-only";
import { matchMentor, normName, type RosterUser } from "@/lib/mobile/roster";

/**
 * The ISE (the control tab's "PC" column: "Sneha Padi", "Akanksha", "VISHAAL") → the PSM mentor
 * who looks after that ISE's tasks. That mentor gets more notifications about the ISE's
 * unassigned tasks (assignments.ts) and is shown as the task's "ISE owner" in the app.
 *
 * Compared on first names, case-insensitively, against the PC cell's first word. The mentor names
 * are matched to the roster like a Mentor cell (matchMentor). MOBILE_ISE_OWNERS replaces the
 * default mapping: "sneha=Gaurav;akanksha=Rakesh;vishaal|vishal=Faraaz".
 */

export const DEFAULT_ISE_OWNERS = "sneha=Gaurav;akanksha=Rakesh;vishaal|vishal=Faraaz";

/** "a|b=Name;c=Other" → { a: "Name", b: "Name", c: "Other" } (first names normalised). Bad parts are skipped. */
export function parseIseOwners(spec: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of spec.split(/[;\n]/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const mentor = part.slice(eq + 1).trim();
    if (!mentor) continue;
    for (const alias of part.slice(0, eq).split("|")) {
      const first = normName(alias).split(" ")[0];
      if (first) out.set(first, mentor);
    }
  }
  return out;
}

/** The mapping in force: MOBILE_ISE_OWNERS when set (and readable), else the default. */
export function iseOwnersFromEnv(value = process.env.MOBILE_ISE_OWNERS): Map<string, string> {
  const custom = value?.trim() ? parseIseOwners(value) : null;
  return custom && custom.size ? custom : parseIseOwners(DEFAULT_ISE_OWNERS);
}

/** The PC cell's first word, normalised ("Sneha Padi" → "sneha"); "" when blank. */
export const iseFirstName = (pc: string) => normName(pc).split(" ")[0] ?? "";

/** The roster person who owns this ISE's tasks, or null (no mapping, or the mentor isn't on the roster). */
export function iseOwnerOf(pc: string, roster: RosterUser[], owners: Map<string, string> = iseOwnersFromEnv()): RosterUser | null {
  const first = iseFirstName(pc);
  if (!first) return null;
  const mentor = owners.get(first);
  return mentor ? matchMentor(mentor, roster) : null;
}
