import "server-only";
import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { extract as tarExtract } from "tar-stream";
import { env } from "@/lib/env";
import { auditRepoCommits } from "@/lib/github-analysis";

/**
 * Whole-repository fetch for Assignment Evaluation.
 *
 * One REST call downloads the repo as a tarball (GitHub redirects to codeload),
 * which is gunzipped and stream-parsed in memory: dependency/build folders and
 * binaries are drained without buffering, text files are kept. Nothing is
 * written to disk and nothing from the repository is ever executed. A handful
 * of extra REST calls fetch metadata and commit history (~5 per candidate).
 *
 * Links may be a repo (`github.com/o/r`), a scoped folder or branch
 * (`…/tree/<ref>/<path>`, `…/blob/<ref>/<file>`), or a bare profile — in which
 * case the repo that best matches the assignment is picked and flagged.
 */

const API = "https://api.github.com";
const MAX_REPO_KB = 400_000; // refuse to download repos over ~400 MB
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 25_000;
const DOWNLOAD_TIMEOUT_MS = 150_000;

const RESERVED_OWNERS = new Set([
  "orgs", "topics", "features", "marketplace", "settings", "sponsors", "about", "search",
  "collections", "explore", "login", "apps", "trending", "notifications", "pulls", "issues", "codespaces",
]);

/** Dependency / build / tooling folders: never read, but counted (they were committed). */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".angular", ".expo",
  "coverage", "vendor", "venv", ".venv", "site-packages", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".gradle", ".idea", ".vscode", "target", "obj", "Pods", ".dart_tool", ".turbo", ".cache",
  ".parcel-cache", "bower_components", "jspm_packages", ".terraform", "DerivedData", ".yarn",
]);

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "poetry.lock", "Pipfile.lock",
  "composer.lock", "Gemfile.lock", "Cargo.lock", "go.sum", "pubspec.lock", "Podfile.lock", "gradle.lockfile",
]);

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif", "tif", "tiff", "heic",
  "mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "ogg", "flac", "m4a",
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx",
  "zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz", "jar", "war", "ear", "class",
  "so", "dll", "exe", "bin", "dylib", "o", "a", "lib", "wasm",
  "woff", "woff2", "ttf", "otf", "eot",
  "psd", "ai", "sketch", "fig", "xd", "blend", "fbx", "glb", "gltf", "obj3d",
  "db", "sqlite", "sqlite3", "mdb", "pkl", "pickle", "pt", "pth", "h5", "hdf5", "onnx", "npy", "npz",
  "parquet", "feather", "arrow", "tflite", "ckpt", "safetensors", "joblib",
  "ipa", "apk", "aab", "keystore", "jks", "p12", "pfx",
]);

export interface RepoFile {
  path: string;
  size: number;
  /** Text content, or null when not kept (binary, oversized, generated, over budget). */
  content: string | null;
  /** Why content is null. */
  note?: "binary" | "too large" | "generated" | "lockfile" | "budget";
}

export interface CommitFacts {
  count: number;
  firstCommit: string;
  lastCommit: string;
  afterDeadline: number;
  authors: number;
  aiLikelihood: "none" | "low" | "medium" | "high" | "unknown";
  /** Commits carrying hard AI-agent evidence (vendor trailer, agent login / noreply email). */
  aiCommits: number;
  singleDumpRepo: boolean;
  signals: string[];
  /** Non-merge commits inspected (newest ≤ 100). */
  analysed: number;
  /** Distinct IST days with commits, and first→last commit span in days. */
  activeDays: number;
  spanDays: number;
  /** Share of inspected commits made on the single busiest day (0–1). */
  busiestDayShare: number;
  /** Messages that say nothing ("update", "Update index.js", "final"). */
  genericMessages: number;
  /** "Add files via upload" — code dropped in through the GitHub web UI. */
  webUploads: number;
  /** Conventional-commit style messages (feat:, fix(api): …). */
  conventional: number;
  /** Other human GitHub accounts with commits, "login (n)". */
  otherAuthors: string[];
  branches: number;
  /** Newest commit subjects, "YYYY-MM-DD · message". */
  recent: string[];
}

export interface FetchedRepo {
  owner: string;
  repo: string;
  ref: string;
  subPath: string;
  resolvedUrl: string;
  autoDetected: boolean;
  autoDetectNote: string;
  forkOf: string;
  sizeKb: number;
  language: string;
  homepage: string;
  files: RepoFile[];
  /** Ignored folder (with its parent path) → committed file count. */
  ignored: Record<string, number>;
  truncated: boolean;
  commits: CommitFacts;
}

export type FetchRepoResult =
  | { ok: true; repo: FetchedRepo }
  | { ok: false; invalid: boolean; error: string; resolvedUrl?: string };

// ── Link parsing ─────────────────────────────────────────────────────────────

export type GithubLink =
  | { kind: "repo"; owner: string; repo: string; mode: "root" | "tree" | "blob"; segments: string[] }
  | { kind: "profile"; owner: string }
  | { kind: "invalid"; reason: string };

export function parseGithubLink(url: string): GithubLink {
  const raw = (url ?? "").trim();
  if (/gist\.github\.com/i.test(raw)) return { kind: "invalid", reason: "Gist links are not supported — submit a repository." };
  const m = raw
    .replace(/^git@github\.com:/i, "github.com/")
    .replace(/^(?:https?:\/\/)?(?:www\.)?/i, "")
    .match(/^github\.com\/([^/?#\s]+)(?:\/([^/?#\s]+))?(?:\/([^?#\s]*))?/i);
  if (!m) return { kind: "invalid", reason: "Not a GitHub link." };
  const owner = decodeURIComponent(m[1]);
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return { kind: "invalid", reason: "Not a user or repository link." };
  if (!m[2]) return { kind: "profile", owner };
  const repo = decodeURIComponent(m[2]).replace(/\.git$/i, "");
  const rest = (m[3] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
  if (rest[0] === "tree" && rest.length > 1) return { kind: "repo", owner, repo, mode: "tree", segments: rest.slice(1) };
  if (rest[0] === "blob" && rest.length > 1) return { kind: "repo", owner, repo, mode: "blob", segments: rest.slice(1) };
  return { kind: "repo", owner, repo, mode: "root", segments: [] };
}

// ── REST helpers ─────────────────────────────────────────────────────────────

function token(): string {
  const t = env.github.token.trim();
  return t && !/^(ghp|github_pat)_REPLACE/i.test(t) ? t : "";
}

class GithubError extends Error {}

async function gh(path: string, accept = "application/vnd.github+json", timeoutMs = 20_000): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nxtwave-assignment-evaluator",
  };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  // no-store: Next.js caches server-side fetches by default — repo data must be live.
  const res = await fetch(`${API}${path}`, { headers, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const at = reset ? new Date(reset).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "later";
    throw new GithubError(`GitHub API rate limit reached (resets ${at} IST)${t ? "" : " — set GITHUB_TOKEN"}.`);
  }
  return res;
}

async function ghJson<T>(path: string): Promise<{ status: number; data: T | null; headers: Headers }> {
  const res = await gh(path);
  if (!res.ok) return { status: res.status, data: null, headers: res.headers };
  return { status: res.status, data: (await res.json()) as T, headers: res.headers };
}

const encRef = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

interface RepoMeta {
  default_branch: string;
  fork: boolean;
  parent?: { full_name: string };
  size: number;
  language: string | null;
  homepage: string | null;
  description: string | null;
  topics?: string[];
  name: string;
  pushed_at: string;
}

// ── Profile → repo ───────────────────────────────────────────────────────────

function tokens(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length >= 3),
  );
}

async function pickRepoFromProfile(
  owner: string,
  keywords: string[],
  deadline: string,
): Promise<{ repo: string; note: string } | { error: string; invalid: boolean }> {
  const { status, data } = await ghJson<RepoMeta[]>(`/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=pushed&type=owner`);
  if (status === 404) return { error: "GitHub user not found.", invalid: true };
  if (!data) return { error: `Could not list the profile's repositories (HTTP ${status}).`, invalid: false };
  const pool = data.filter((r) => !r.fork && r.size > 0 && r.name.toLowerCase() !== owner.toLowerCase());
  if (!pool.length) return { error: "Profile link given, and the profile has no public non-fork repositories.", invalid: true };

  const want = new Set(keywords.flatMap((k) => Array.from(tokens(k))));
  const pivot = deadline ? Date.parse(`${deadline}T23:59:59+05:30`) : Date.now();
  let best: { repo: RepoMeta; score: number; hits: string[] } | null = null;
  for (const r of pool) {
    const have = tokens(`${r.name} ${r.description ?? ""} ${(r.topics ?? []).join(" ")}`);
    const hits = Array.from(have).filter((w) => want.has(w));
    const recent = Math.abs(Date.parse(r.pushed_at) - pivot) < 120 * 86_400_000 ? 3 : 0;
    const score = hits.length * 10 + recent;
    if (!best || score > best.score) best = { repo: r, score, hits };
  }
  const chosen = best!;
  const note = chosen.hits.length
    ? `Profile link given — repo auto-detected as "${chosen.repo.name}" (matched: ${chosen.hits.slice(0, 5).join(", ")}).`
    : `Profile link given — no repo matched the assignment; used the most recently updated repo "${chosen.repo.name}". Verify manually.`;
  return { repo: chosen.repo.name, note };
}

// ── Ref / scope resolution ───────────────────────────────────────────────────

async function refExists(owner: string, repo: string, ref: string): Promise<boolean> {
  const res = await gh(`/repos/${owner}/${repo}/commits/${encRef(ref)}`, "application/vnd.github.sha");
  return res.ok;
}

/** `tree/feature/login/backend` is ambiguous — find the longest prefix that is a real ref. */
async function resolveScope(
  owner: string,
  repo: string,
  mode: "root" | "tree" | "blob",
  segments: string[],
  defaultBranch: string,
): Promise<{ ref: string; subPath: string }> {
  if (mode === "root" || !segments.length) return { ref: defaultBranch, subPath: "" };
  const pathOf = (rest: string[]) => (mode === "blob" ? rest.slice(0, -1) : rest).join("/");
  if (segments.length === 1) return { ref: segments[0], subPath: "" };
  for (let i = Math.min(segments.length, 4); i >= 1; i--) {
    const ref = segments.slice(0, i).join("/");
    if (i === 1 || (await refExists(owner, repo, ref))) return { ref, subPath: pathOf(segments.slice(i)) };
  }
  return { ref: segments[0], subPath: pathOf(segments.slice(1)) };
}

// ── Tarball ──────────────────────────────────────────────────────────────────

function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

function isGenerated(path: string): boolean {
  return /\.min\.(js|css)$|\.map$|\.bundle\.js$|\.chunk\.(js|css)$/i.test(path);
}

async function downloadFiles(
  owner: string,
  repo: string,
  ref: string,
  subPath: string,
): Promise<{ files: RepoFile[]; ignored: Record<string, number>; truncated: boolean }> {
  const res = await gh(`/repos/${owner}/${repo}/tarball/${encRef(ref)}`, "application/vnd.github+json", DOWNLOAD_TIMEOUT_MS);
  if (res.status === 404) throw new GithubError(`Branch/ref "${ref}" not found in the repository.`);
  if (!res.ok || !res.body) throw new GithubError(`Repository download failed (HTTP ${res.status}).`);

  const files: RepoFile[] = [];
  const ignored: Record<string, number> = {};
  let textBytes = 0;
  let truncated = false;
  let entries = 0;
  const scope = subPath.replace(/^\/+|\/+$/g, "");

  const source = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  const extract = tarExtract();
  let pipeError: Error | null = null;
  pipeline(source, createGunzip(), extract, (err) => {
    if (err) pipeError = err;
  });

  for await (const entry of extract) {
    const header = entry.header;
    // Strip the "<owner>-<repo>-<sha>/" wrapper folder.
    let path = header.name.split("/").slice(1).join("/");
    if (header.type !== "file" || !path) {
      entry.resume();
      continue;
    }
    if (scope) {
      if (!path.startsWith(`${scope}/`)) {
        entry.resume();
        continue;
      }
      path = path.slice(scope.length + 1);
    }
    entries++;
    const parts = path.split("/");
    const ignoredAt = parts.findIndex((p, i) => i < parts.length - 1 && IGNORED_DIRS.has(p));
    if (ignoredAt >= 0) {
      const key = parts.slice(0, ignoredAt + 1).join("/");
      ignored[key] = (ignored[key] ?? 0) + 1;
      entry.resume();
      continue;
    }
    const size = header.size ?? 0;
    const base = parts[parts.length - 1];
    const push = (note: RepoFile["note"]) => {
      if (files.length < MAX_ENTRIES) files.push({ path, size, content: null, note });
      entry.resume();
    };
    if (LOCKFILES.has(base)) { push("lockfile"); continue; }
    if (BINARY_EXT.has(extOf(path))) { push("binary"); continue; }
    if (isGenerated(path)) { push("generated"); continue; }
    if (size > MAX_FILE_BYTES) { push("too large"); continue; }
    if (textBytes + size > MAX_TEXT_BYTES || files.length >= MAX_ENTRIES) {
      truncated = true;
      push("budget");
      continue;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of entry) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);
    if (buf.subarray(0, 8000).includes(0)) {
      files.push({ path, size, content: null, note: "binary" });
      continue;
    }
    textBytes += buf.length;
    files.push({ path, size, content: buf.toString("utf8") });
  }
  if (pipeError) throw new GithubError(`Repository download was interrupted: ${(pipeError as Error).message}`);
  if (entries === 0 && scope) throw new GithubError(`Folder "${scope}" not found in the repository.`);
  return { files, ignored, truncated };
}

// ── Commits ──────────────────────────────────────────────────────────────────

interface CommitItem {
  commit?: {
    message?: string;
    author?: { date?: string; email?: string; name?: string } | null;
    committer?: { date?: string } | null;
  };
  author?: { login?: string } | null;
  parents?: { sha: string }[];
}

interface CommitData {
  items: CommitItem[];
  count: number;
  firstCommit: string;
  branches: number;
}

function lastPage(link: string | null): number {
  const m = (link ?? "").match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return m ? Number(m[1]) : 0;
}

/** Newest 100 commits + total count + oldest commit + branch count (2–4 REST calls, in parallel where possible). */
async function fetchCommitData(owner: string, repo: string, ref: string, subPath: string): Promise<CommitData | null> {
  const scope = subPath ? `&path=${encodeURIComponent(subPath)}` : "";
  const base = `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}${scope}`;
  const [first, branchesRes] = await Promise.all([
    ghJson<CommitItem[]>(`${base}&per_page=100`),
    ghJson<unknown[]>(`/repos/${owner}/${repo}/branches?per_page=1`),
  ]);
  if (!first.data) return null;
  const items = first.data;
  const branches = lastPage(branchesRes.headers.get("link")) || branchesRes.data?.length || 0;

  let count = items.length;
  let firstCommit = items[items.length - 1]?.commit?.author?.date ?? "";
  if (items.length === 100) {
    const probe = await ghJson<CommitItem[]>(`${base}&per_page=1`);
    const total = lastPage(probe.headers.get("link"));
    if (total > 0) {
      count = total;
      const oldest = await ghJson<CommitItem[]>(`${base}&per_page=1&page=${total}`);
      firstCommit = oldest.data?.[0]?.commit?.author?.date ?? firstCommit;
    }
  }
  return { items, count, firstCommit, branches };
}

const BOT_RE = /\[bot\]$|^dependabot|^github-actions|^renovate|^web-flow$/i;
/** GitHub web-editor defaults and throwaway messages — no information about the change. */
const GENERIC_MSG_RE =
  /^(initial commit|first commit|init|commit|changes?|updates?|updated?|fix(es|ed)?|wip|minor( changes| fix(es)?| update)?|done|final( commit)?|test(ing)?|new|added?|edit(ed)?|modified|misc|temp|asdf+|ok|\.+|-+|\d+)\.?$|^(create|update|delete|rename) [\w./-]+$/i;
const WEB_UPLOAD_RE = /^add files via upload/i;
const CONVENTIONAL_RE = /^(feat|fix|chore|docs|refactor|test|tests|style|perf|build|ci|revert)(\([^)]*\))?!?:\s/i;

const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Git-history analysis from the newest 100 commits: cadence (active days,
 * span, busiest-day share), message quality (generic / conventional), web
 * uploads, other authors, deadline breaches — plus the AI-authorship audit.
 */
function analyzeCommits(data: CommitData | null, owner: string, deadline: string, fileCount: number): CommitFacts {
  if (!data) {
    return {
      count: 0, firstCommit: "", lastCommit: "", afterDeadline: 0, authors: 0,
      aiLikelihood: "unknown", aiCommits: 0, singleDumpRepo: false, signals: [],
      analysed: 0, activeDays: 0, spanDays: 0, busiestDayShare: 0, genericMessages: 0,
      webUploads: 0, conventional: 0, otherAuthors: [], branches: 0, recent: [],
    };
  }
  const own = data.items.filter((c) => (c.parents?.length ?? 1) <= 1); // merges carry no authored work
  const dateOf = (c: CommitItem) => c.commit?.author?.date ?? c.commit?.committer?.date ?? "";
  const subject = (c: CommitItem) => (c.commit?.message ?? "").split("\n")[0].trim();

  const days = new Map<string, number>();
  for (const c of own) {
    const d = dateOf(c);
    if (d) days.set(istDay(d), (days.get(istDay(d)) ?? 0) + 1);
  }
  const busiest = Math.max(0, ...days.values());
  const span =
    data.firstCommit && data.items[0]
      ? Math.max(0, Math.round((Date.parse(dateOf(data.items[0])) - Date.parse(data.firstCommit)) / 86_400_000))
      : 0;

  const end = deadline ? Date.parse(`${deadline}T23:59:59+05:30`) : NaN;
  const afterDeadline = Number.isFinite(end)
    ? own.filter((c) => Date.parse(c.commit?.committer?.date ?? dateOf(c)) > end).length
    : 0;

  const authorKeys = new Set<string>();
  const others = new Map<string, number>();
  for (const c of own) {
    const login = c.author?.login ?? "";
    const key = (login || c.commit?.author?.email || c.commit?.author?.name || "").toLowerCase();
    if (!key || BOT_RE.test(login || key)) continue;
    authorKeys.add(key);
    if (login && login.toLowerCase() !== owner.toLowerCase()) others.set(login, (others.get(login) ?? 0) + 1);
  }

  let audit: ReturnType<typeof auditRepoCommits> | null = null;
  try {
    audit = auditRepoCommits(data.items, owner, fileCount);
  } catch {
    audit = null;
  }

  return {
    count: data.count,
    firstCommit: data.firstCommit,
    lastCommit: data.items[0] ? dateOf(data.items[0]) : "",
    afterDeadline,
    authors: authorKeys.size,
    aiLikelihood: audit?.aiLikelihood ?? "unknown",
    aiCommits: audit?.aiAttributed ?? 0,
    singleDumpRepo: audit?.singleDumpRepo ?? false,
    signals: audit?.signals ?? [],
    analysed: own.length,
    activeDays: days.size,
    spanDays: span,
    busiestDayShare: own.length ? Math.round((busiest / own.length) * 100) / 100 : 0,
    genericMessages: own.filter((c) => GENERIC_MSG_RE.test(subject(c))).length,
    webUploads: own.filter((c) => WEB_UPLOAD_RE.test(subject(c))).length,
    conventional: own.filter((c) => CONVENTIONAL_RE.test(subject(c))).length,
    otherAuthors: Array.from(others.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([login, n]) => `${login} (${n})`),
    branches: data.branches,
    recent: own.slice(0, 30).map((c) => `${dateOf(c).slice(0, 10)} · ${subject(c).slice(0, 90)}`),
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function fetchRepoForEvaluation(
  url: string,
  hint: { keywords: string[]; deadline: string; /** Refuse repos larger than this (KB); default ~400 MB. */ maxKb?: number },
): Promise<FetchRepoResult> {
  const link = parseGithubLink(url);
  if (link.kind === "invalid") return { ok: false, invalid: true, error: link.reason };

  try {
    let owner = link.owner;
    let repoName: string;
    let autoDetected = false;
    let autoDetectNote = "";
    let mode: "root" | "tree" | "blob" = "root";
    let segments: string[] = [];

    if (link.kind === "profile") {
      const pick = await pickRepoFromProfile(owner, hint.keywords, hint.deadline);
      if ("error" in pick) return { ok: false, invalid: pick.invalid, error: pick.error };
      repoName = pick.repo;
      autoDetected = true;
      autoDetectNote = pick.note;
    } else {
      repoName = link.repo;
      mode = link.mode;
      segments = link.segments;
    }

    const meta = await ghJson<RepoMeta>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);
    const plainUrl = `https://github.com/${owner}/${repoName}`;
    if (meta.status === 404 || meta.status === 451) {
      return { ok: false, invalid: true, error: "Repository not found or private.", resolvedUrl: plainUrl };
    }
    if (!meta.data) return { ok: false, invalid: false, error: `GitHub returned HTTP ${meta.status} for the repository.`, resolvedUrl: plainUrl };
    // Canonical casing / renamed repos.
    const full = (meta.data as unknown as { full_name?: string }).full_name;
    if (full && full.includes("/")) [owner, repoName] = full.split("/");
    if (meta.data.size === 0) return { ok: false, invalid: true, error: "Repository is empty.", resolvedUrl: plainUrl };
    if (meta.data.size > (hint.maxKb ?? MAX_REPO_KB)) {
      return {
        ok: false,
        invalid: false,
        error: `Repository is too large to analyse (${Math.round(meta.data.size / 1024)} MB). Review manually.`,
        resolvedUrl: plainUrl,
      };
    }

    const { ref, subPath } = await resolveScope(owner, repoName, mode, segments, meta.data.default_branch);
    const resolvedUrl =
      ref === meta.data.default_branch && !subPath
        ? `https://github.com/${owner}/${repoName}`
        : `https://github.com/${owner}/${repoName}/tree/${ref}${subPath ? `/${subPath}` : ""}`;

    // Tarball and commit history are independent — fetch them together.
    const commitData = fetchCommitData(owner, repoName, ref, subPath).catch(() => null);
    const [{ files, ignored, truncated }, history] = await Promise.all([
      downloadFiles(owner, repoName, ref, subPath),
      commitData,
    ]);
    const codeFiles = files.filter((f) => f.content !== null).length;
    if (files.length === 0) return { ok: false, invalid: true, error: "Repository has no files to analyse.", resolvedUrl };
    if (codeFiles === 0) return { ok: false, invalid: true, error: "Repository contains no readable source files.", resolvedUrl };

    const commits = analyzeCommits(history, owner, hint.deadline, files.length);

    return {
      ok: true,
      repo: {
        owner,
        repo: repoName,
        ref,
        subPath,
        resolvedUrl,
        autoDetected,
        autoDetectNote,
        forkOf: meta.data.fork ? (meta.data.parent?.full_name ?? "unknown upstream") : "",
        sizeKb: meta.data.size,
        language: meta.data.language ?? "",
        homepage: (meta.data.homepage ?? "").trim(),
        files,
        ignored,
        truncated,
        commits,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof GithubError) return { ok: false, invalid: /not found/i.test(msg), error: msg };
    if (/timeout|aborted/i.test(msg)) return { ok: false, invalid: false, error: "GitHub download timed out — re-run this candidate." };
    return { ok: false, invalid: false, error: `GitHub fetch failed: ${msg.slice(0, 200)}` };
  }
}

// ── Live link ────────────────────────────────────────────────────────────────

const DEPLOY_HOST_RE =
  /https?:\/\/[^\s)"'<>\]]*(?:vercel\.app|netlify\.app|onrender\.com|herokuapp\.com|railway\.app|github\.io|pages\.dev|fly\.dev|surge\.sh|firebaseapp\.com|web\.app|azurewebsites\.net|amplifyapp\.com|streamlit\.app|huggingface\.co\/spaces|koyeb\.app|deno\.dev|replit\.app|glitch\.me|cyclic\.app)[^\s)"'<>\]]*/gi;

/** First deploy-looking URL (repo homepage, then README) and whether it responds. */
export async function checkLiveLink(
  homepage: string,
  readme: string,
): Promise<{ url: string; status: "reachable" | "unreachable" | "none" }> {
  const candidates = [
    ...(/^https?:\/\//i.test(homepage) ? [homepage] : []),
    ...Array.from(readme.matchAll(DEPLOY_HOST_RE)).map((m) => m[0].replace(/[.,;]+$/, "")),
  ];
  const unique = Array.from(new Set(candidates)).slice(0, 2);
  if (!unique.length) return { url: "", status: "none" };
  const probes = await Promise.all(
    unique.map(async (url) => {
      try {
        const res = await fetch(url, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(5000) });
        return res.status < 400;
      } catch {
        return false;
      }
    }),
  );
  const up = unique.find((_, i) => probes[i]);
  return up ? { url: up, status: "reachable" } : { url: unique[0], status: "unreachable" };
}
