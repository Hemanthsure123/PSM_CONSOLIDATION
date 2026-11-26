import "server-only";
import { query } from "@/lib/db/client";
import { deviceHealthReady } from "@/lib/mobile/task-schema";

/**
 * Notification health (PSM 1.11.0): what each phone reports with PUT /me/device (at sign-in, on
 * resume at most every 6 hours, after a Fix in Me → Notifications), stored on app.devices, shown to
 * admins per member in GET /admin/roster (the Team screen). No push is ever sent about it.
 */

export interface DeviceHealthInput {
  notificationsEnabled?: unknown;
  taskChannelEnabled?: unknown;
  batteryOptimized?: unknown;
  backgroundRestricted?: unknown;
  manufacturer?: unknown;
}

export interface DeviceHealth {
  notificationsEnabled: boolean | null;
  taskChannelEnabled: boolean | null;
  batteryOptimized: boolean | null;
  backgroundRestricted: boolean | null;
  manufacturer: string | null;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** The health fields as sent (anything that isn't a boolean is unknown), or null when the phone sent none (an older app). */
export function cleanHealth(d: DeviceHealthInput | null | undefined): DeviceHealth | null {
  if (!d) return null;
  const h: DeviceHealth = {
    notificationsEnabled: bool(d.notificationsEnabled),
    taskChannelEnabled: bool(d.taskChannelEnabled),
    batteryOptimized: bool(d.batteryOptimized),
    backgroundRestricted: bool(d.backgroundRestricted),
    manufacturer: typeof d.manufacturer === "string" && d.manufacturer.trim() ? d.manufacturer.trim().slice(0, 80) : null,
  };
  const reported = h.notificationsEnabled !== null || h.taskChannelEnabled !== null || h.batteryOptimized !== null || h.backgroundRestricted !== null;
  return reported ? h : null;
}

/**
 * Healthy: notifications are on, the task channel is on, and the app isn't background-restricted
 * (each as reported; unknown is not healthy). Battery optimisation is only a warning.
 */
export const deviceHealthy = (h: Pick<DeviceHealth, "notificationsEnabled" | "taskChannelEnabled" | "backgroundRestricted">) =>
  h.notificationsEnabled === true && h.taskChannelEnabled === true && h.backgroundRestricted === false;

export interface RosterDevice {
  model: string | null;
  manufacturer: string | null;
  appVersion: string | null;
  lastSeenAt: string;
  notificationsEnabled: boolean | null;
  taskChannelEnabled: boolean | null;
  batteryOptimized: boolean | null;
  backgroundRestricted: boolean | null;
  healthAt: string | null;
  healthy: boolean;
}

interface DeviceRow {
  user_email: string;
  model: string | null;
  app_version: string | null;
  last_seen_at: Date;
  notifications_enabled?: boolean | null;
  task_channel_enabled?: boolean | null;
  battery_optimized?: boolean | null;
  background_restricted?: boolean | null;
  manufacturer?: string | null;
  health_at?: Date | null;
}

/** Every signed-in phone per roster email, most recently seen first (health fields null before migration 021). */
export async function devicesByUser(): Promise<Map<string, RosterDevice[]>> {
  const extra = (await deviceHealthReady())
    ? ", notifications_enabled, task_channel_enabled, battery_optimized, background_restricted, manufacturer, health_at"
    : "";
  const rows = await query<DeviceRow>(`select user_email, model, app_version, last_seen_at${extra} from app.devices order by last_seen_at desc`);
  const out = new Map<string, RosterDevice[]>();
  for (const r of rows) {
    const h = {
      notificationsEnabled: r.notifications_enabled ?? null,
      taskChannelEnabled: r.task_channel_enabled ?? null,
      batteryOptimized: r.battery_optimized ?? null,
      backgroundRestricted: r.background_restricted ?? null,
    };
    const list = out.get(r.user_email) ?? [];
    list.push({
      model: r.model,
      manufacturer: r.manufacturer ?? null,
      appVersion: r.app_version,
      lastSeenAt: new Date(r.last_seen_at).toISOString(),
      ...h,
      healthAt: r.health_at ? new Date(r.health_at).toISOString() : null,
      healthy: deviceHealthy(h),
    });
    out.set(r.user_email, list);
  }
  return out;
}
