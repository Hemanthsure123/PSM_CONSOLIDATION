import "server-only";
import { query } from "@/lib/db/client";
import { UserError } from "@/lib/mobile/http";
import { pushToUser } from "@/lib/mobile/push";
import { listRoster } from "@/lib/mobile/roster";

/**
 * In-app updates without the Play Store. Each release's APK is kept in the database
 * (app.app_releases, private); a phone asks for the latest version, downloads the file through
 * the signed-in API and installs it over the old one (same package and signing key, so nothing
 * is uninstalled and no data is lost). Publishing (scripts/app-release-publish.ts) adds the
 * release and notifies every active team member. Only the newest KEEP_FILES releases keep
 * their file.
 */

const KEEP_FILES = 3;

export interface ReleaseDto {
  versionCode: number;
  versionName: string;
  notes: string;
  sizeBytes: number;
  sha256: string;
  /** Phones below this version code must update before using the app (0 = never forced). */
  minSupported: number;
  publishedAt: string;
  /** Relative to /api/mobile/v1. */
  downloadPath: string;
}

interface Row {
  version_code: number;
  version_name: string;
  notes: string;
  size_bytes: number;
  sha256: string;
  min_supported: number;
  published_at: Date;
}

const toDto = (r: Row): ReleaseDto => ({
  versionCode: r.version_code,
  versionName: r.version_name,
  notes: r.notes,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  minSupported: r.min_supported,
  publishedAt: r.published_at.toISOString(),
  downloadPath: `/app/releases/${r.version_code}/apk`,
});

/** The newest release that still has its file, or null. */
export async function latestRelease(): Promise<ReleaseDto | null> {
  const rows = await query<Row>(
    "select version_code, version_name, notes, size_bytes, sha256, min_supported, published_at from app.app_releases where apk is not null order by version_code desc limit 1",
  );
  return rows[0] ? toDto(rows[0]) : null;
}

/**
 * A release's APK bytes, whole or a byte range (a dropped download resumes where it stopped).
 * Postgres substring() reads only the asked-for part.
 */
export async function releaseBytes(versionCode: number, range: { start: number; end: number } | null): Promise<{ bytes: Buffer; total: number; sha256: string } | null> {
  const meta = await query<{ size_bytes: number; sha256: string; has: boolean }>(
    "select size_bytes, sha256, apk is not null as has from app.app_releases where version_code = $1",
    [versionCode],
  );
  const m = meta[0];
  if (!m || !m.has) return null;
  const start = range ? range.start : 0;
  const end = range ? Math.min(range.end, m.size_bytes - 1) : m.size_bytes - 1;
  if (start > end || start >= m.size_bytes) throw new UserError(416, "That part of the file doesn't exist.", "range_not_satisfiable");
  const rows = await query<{ part: Buffer }>("select substring(apk from $2 for $3) as part from app.app_releases where version_code = $1", [versionCode, start + 1, end - start + 1]);
  return { bytes: rows[0].part, total: m.size_bytes, sha256: m.sha256 };
}

/** Adds a release (the publish script), keeps the newest files only, and tells the team. */
export async function publishRelease(input: {
  versionCode: number;
  versionName: string;
  notes: string;
  apk: Buffer;
  sha256: string;
  minSupported: number;
  publishedBy: string;
  notify: boolean;
}): Promise<{ release: ReleaseDto; notified: number }> {
  const rows = await query<Row>(
    `insert into app.app_releases (version_code, version_name, notes, apk, size_bytes, sha256, min_supported, published_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (version_code) do update set version_name = excluded.version_name, notes = excluded.notes, apk = excluded.apk,
       size_bytes = excluded.size_bytes, sha256 = excluded.sha256, min_supported = excluded.min_supported,
       published_by = excluded.published_by, published_at = now()
     returning version_code, version_name, notes, size_bytes, sha256, min_supported, published_at`,
    [input.versionCode, input.versionName, input.notes.slice(0, 4000), input.apk, input.apk.length, input.sha256, input.minSupported, input.publishedBy],
  );
  await query(
    "update app.app_releases set apk = null where apk is not null and version_code not in (select version_code from app.app_releases order by version_code desc limit $1)",
    [KEEP_FILES],
  );
  let notified = 0;
  if (input.notify) {
    for (const u of (await listRoster()).filter((x) => x.active)) {
      const r = await pushToUser({
        email: u.email,
        kind: "app_update",
        data: { versionCode: String(input.versionCode), versionName: input.versionName, title: `Update available · ${input.versionName}`, body: "Tap to update the PSM app. Your data stays." },
        dedupeKey: `app_update:${input.versionCode}:${u.email}`,
      }).catch(() => ({ delivered: 0 }));
      notified += r.delivered;
    }
  }
  return { release: toDto(rows[0]), notified };
}
