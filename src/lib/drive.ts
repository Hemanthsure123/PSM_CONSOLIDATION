import "server-only";
import { google, type drive_v3 } from "googleapis";
import { env } from "@/lib/env";

/**
 * Lazily-constructed singleton Google Drive v3 client, authenticated via the
 * GCP service account. Lazy + cached on `globalThis` (see bigquery.ts for the
 * rationale).
 */
const globalForDrive = globalThis as unknown as { drive?: drive_v3.Drive };

export function getDrive(): drive_v3.Drive {
  if (!globalForDrive.drive) {
    const subject = env.drive.impersonateUser;
    const auth = new google.auth.JWT({
      email: env.gcp.clientEmail,
      key: env.gcp.privateKey,
      scopes: ["https://www.googleapis.com/auth/drive"],
      // Domain-wide delegation: act as a real Workspace user (who has Drive
      // storage) so uploads to My Drive folders succeed and are shareable.
      ...(subject ? { subject } : {}),
    });
    globalForDrive.drive = google.drive({ version: "v3", auth });
  }
  return globalForDrive.drive;
}
