/**
 * Publishes an app release for in-app updates (the phones download it through the API):
 *   npx tsx scripts/app-release-publish.ts <app.apk> <notes.md> [--min <versionCode>] [--no-notify] [--dry-run]
 *
 * Reads the version code / name and the package from the APK itself (aapt2 from the Android SDK),
 * refuses an APK of another package or one not newer than the latest release, stores it in
 * app.app_releases (only the newest 3 keep their file) and notifies every active team member.
 * --min forces phones below that version code to update before using the app.
 */
import "./server-only-shim";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* env from the environment */
}

const PACKAGE = "com.nxtwave.psm.debug";

function aapt2(): string {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
  const tools = join(sdk, "build-tools");
  if (!existsSync(tools)) throw new Error(`Android build-tools not found under ${sdk}.`);
  const versions = readdirSync(tools).sort().reverse();
  for (const v of versions) {
    for (const name of ["aapt2.exe", "aapt2"]) {
      const p = join(tools, v, name);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("aapt2 not found in the Android build-tools.");
}

async function main() {
  const args = process.argv.slice(2);
  const [apkPath, notesPath] = args.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
  if (!apkPath || !notesPath) throw new Error("Usage: app-release-publish.ts <app.apk> <notes.md> [--min <versionCode>] [--no-notify] [--dry-run]");
  const minAt = args.indexOf("--min");
  const minSupported = minAt >= 0 ? Number(args[minAt + 1]) : 0;
  if (!Number.isInteger(minSupported) || minSupported < 0) throw new Error("--min must be a version code.");

  const badging = execFileSync(aapt2(), ["dump", "badging", apkPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const m = badging.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
  if (!m) throw new Error("The APK's package line couldn't be read.");
  const [, pkg, code, name] = m;
  if (pkg !== PACKAGE) throw new Error(`This APK is ${pkg}, not ${PACKAGE} (the team's app).`);
  const apk = readFileSync(apkPath);
  const sha256 = createHash("sha256").update(apk).digest("hex");
  const notes = readFileSync(notesPath, "utf8").trim();
  const versionCode = Number(code);

  const { query } = await import("@/lib/db/client");
  const latest = await query<{ version_code: number }>("select max(version_code) as version_code from app.app_releases");
  if (latest[0]?.version_code && versionCode < latest[0].version_code) throw new Error(`Version ${versionCode} is older than the latest release (${latest[0].version_code}).`);
  console.log(`${pkg} ${name} (${versionCode}) · ${(apk.length / 1048576).toFixed(2)} MB · sha256 ${sha256.slice(0, 12)}… · min ${minSupported}`);
  if (args.includes("--dry-run")) {
    console.log("dry run: nothing published");
    process.exit(0);
  }
  const { publishRelease } = await import("@/lib/mobile/releases");
  const r = await publishRelease({
    versionCode,
    versionName: name,
    notes,
    apk,
    sha256,
    minSupported,
    publishedBy: "release-script",
    notify: !args.includes("--no-notify"),
  });
  console.log(`published ${r.release.versionName} (${r.release.versionCode}); notified ${r.notified} phone(s)`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Publish failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
