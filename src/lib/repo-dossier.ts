import "server-only";
import type { FetchedRepo, RepoFile } from "@/lib/github-repo";

/**
 * Turns a fetched repository into (a) deterministic facts — tests, CI, Docker,
 * committed secrets / dependency folders — and (b) a prompt "dossier" that fits
 * a character budget: full file tree, manifests, README, then source files in
 * architectural priority order. Files that don't fit are named explicitly so
 * the model marks related criteria "unverified" instead of "missing".
 */

const CODE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte", "astro",
  "py", "ipynb", "java", "kt", "kts", "scala", "go", "rs", "rb", "php", "cs", "fs", "vb",
  "c", "h", "cc", "cpp", "hpp", "m", "mm", "swift", "dart", "ex", "exs", "erl", "clj", "lua", "r", "jl",
  "sql", "prisma", "graphql", "gql", "proto", "sol",
  "html", "htm", "css", "scss", "sass", "less", "styl", "ejs", "hbs", "pug", "jinja", "j2", "twig", "cshtml", "razor",
  "sh", "bash", "zsh", "ps1", "bat",
]);

const TEXT_EXT = new Set([
  "json", "yml", "yaml", "toml", "xml", "ini", "cfg", "conf", "properties", "gradle", "md", "mdx", "txt", "rst",
  "env", "example", "sample", "template", "dockerfile", "makefile", "tf", "hcl", "csv", "lock",
]);

const MANIFEST_RE =
  /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|environment\.ya?ml|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|go\.mod|Cargo\.toml|pubspec\.yaml|composer\.json|Gemfile|[^/]+\.csproj|angular\.json|nest-cli\.json|manage\.py|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Procfile|vercel\.json|netlify\.toml|render\.yaml|\.env\.(example|sample|template)|tsconfig\.json|vite\.config\.[jt]s|next\.config\.[mc]?js|webpack\.config\.js|schema\.prisma)$/i;

const CI_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.gitlab-ci\.yml$|(^|\/)Jenkinsfile$|(^|\/)\.circleci\//i;
const README_RE = /(^|\/)readme(\.[a-z]+)?$/i;
const TEST_RE =
  /(^|\/)(__tests__|tests?|spec|specs|e2e|cypress|playwright)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Tests?\.(java|kt|cs)$/i;
const DOCKER_RE = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/i;

function ext(path: string): string {
  const base = path.split("/").pop() ?? "";
  if (/^dockerfile/i.test(base)) return "dockerfile";
  if (/^makefile$/i.test(base)) return "makefile";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

const isCode = (p: string) => CODE_EXT.has(ext(p));

// ── Deterministic signals ────────────────────────────────────────────────────

const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { kind: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { kind: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/ },
  { kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "Stripe live key", re: /\bsk_live_[A-Za-z0-9]{20,}/ },
  { kind: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    kind: "database URL with password",
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:@/'"]+:(?!password\b|pass\b|<|\*|\$\{|your)[^\s@/'"]{3,}@/i,
  },
];

export interface RepoSignals {
  hasReadme: boolean;
  hasTests: boolean;
  hasCi: boolean;
  hasDocker: boolean;
  committedJunk: string[];
  secrets: string[];
  readme: string;
}

export function repoSignals(repo: FetchedRepo): RepoSignals {
  const paths = repo.files.map((f) => f.path);
  const secrets: string[] = [];
  for (const f of repo.files) {
    const base = f.path.split("/").pop() ?? "";
    if (/^\.env(\.(local|production|prod|development|dev|staging))?$/i.test(base)) {
      secrets.push(`${f.path} — .env file committed`);
      continue;
    }
    if (!f.content || /\.(example|sample|template)$|\.md$/i.test(base)) continue;
    for (const { kind, re } of SECRET_PATTERNS) {
      if (re.test(f.content)) {
        secrets.push(`${f.path} — possible ${kind}`);
        break;
      }
    }
    if (secrets.length >= 8) break;
  }

  const committedJunk = Object.entries(repo.ignored)
    .filter(([dir]) => /(^|\/)(node_modules|venv|\.venv|site-packages|vendor|dist|build|\.next|target|__pycache__)$/.test(dir))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([dir, n]) => `${dir}/ (${n.toLocaleString("en-IN")} files)`);

  const readmeFile =
    repo.files.find((f) => README_RE.test(f.path) && !f.path.includes("/") && f.content) ??
    repo.files.find((f) => README_RE.test(f.path) && f.content);

  return {
    hasReadme: Boolean(readmeFile),
    hasTests: paths.some((p) => TEST_RE.test(p) && isCode(p)),
    hasCi: paths.some((p) => CI_RE.test(p)),
    hasDocker: paths.some((p) => DOCKER_RE.test(p)),
    committedJunk,
    secrets,
    readme: readmeFile?.content ?? "",
  };
}

// ── Dossier ──────────────────────────────────────────────────────────────────

/** Lower = earlier in the prompt. */
function priority(path: string): number {
  const p = path.toLowerCase();
  const base = p.split("/").pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  if (/^(main|index|app|server|manage|wsgi|asgi|program|startup|application|bootstrap)$/.test(stem) && p.split("/").length <= 3) return 0;
  if (/^(urls|routes?|router|settings|config)$/.test(stem)) return 0;
  if (/(^|\/)(routes?|routers?|controllers?|api|apis|handlers?|views|endpoints|resolvers|graphql)\//.test(p)) return 1;
  if (/(^|\/)(models?|schemas?|entities|entity|migrations?|db|database|prisma|repositories|repository|dao|dto)\//.test(p) || /\.(sql|prisma|graphql|gql)$/.test(p)) return 2;
  if (/(^|\/)(services?|lib|libs|utils?|helpers?|core|domain|store|stores|redux|slices|context|hooks|middlewares?|auth|providers|features|modules)\//.test(p)) return 3;
  if (/(^|\/)(components?|pages|screens|widgets|views|templates|layouts|app|ui)\//.test(p)) return 4;
  if (TEST_RE.test(p)) return 6;
  if (isCode(p)) return 5;
  return 7;
}

function kb(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** Notebook → code cells only. */
function notebookCode(content: string): string {
  try {
    const nb = JSON.parse(content) as { cells?: { cell_type?: string; source?: string | string[] }[] };
    return (nb.cells ?? [])
      .filter((c) => c.cell_type === "code")
      .map((c) => (Array.isArray(c.source) ? c.source.join("") : (c.source ?? "")))
      .join("\n\n# ---- cell ----\n");
  } catch {
    return content;
  }
}

function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const head = Math.floor(max * 0.8);
  const tail = max - head;
  return {
    text: `${text.slice(0, head)}\n\n/* … ${(text.length - max).toLocaleString("en-IN")} characters omitted … */\n\n${text.slice(-tail)}`,
    clipped: true,
  };
}

export interface Dossier {
  text: string;
  /** Every path in the repo tree (for evidence validation). */
  allPaths: Set<string>;
  includedCount: number;
  omittedCount: number;
}

/**
 * Build the prompt body for one repository within `budget` characters. The
 * tree and manifests come first because they are what the model needs to judge
 * architecture and stack; source files follow in priority order.
 */
export function buildDossier(repo: FetchedRepo, budget: number): Dossier {
  const allPaths = new Set(repo.files.map((f) => f.path));
  const sections: string[] = [];
  let used = 0;
  const add = (s: string) => {
    sections.push(s);
    used += s.length + 1;
  };

  // 1) Tree — capped so a huge repo can't eat the budget.
  const treeBudget = Math.min(Math.floor(budget * 0.12), 40_000);
  const sorted = [...repo.files].sort((a, b) => a.path.localeCompare(b.path));
  const treeLines: string[] = [];
  let treeLen = 0;
  for (const f of sorted) {
    const line = `${f.path} (${kb(f.size)}${f.note ? `, ${f.note}` : ""})`;
    if (treeLen + line.length > treeBudget) {
      treeLines.push(`… ${sorted.length - treeLines.length} more files not listed`);
      break;
    }
    treeLines.push(line);
    treeLen += line.length + 1;
  }
  add(`=== FILE TREE (${repo.files.length} files) ===\n${treeLines.join("\n")}`);
  const junk = Object.entries(repo.ignored);
  if (junk.length) {
    add(
      `=== COMMITTED BUT NOT SHOWN (dependency/build/tooling folders) ===\n${junk
        .map(([d, n]) => `${d}/ — ${n} files`)
        .join("\n")}`,
    );
  }

  const perFile = Math.max(3_000, Math.min(24_000, Math.floor(budget / 10)));
  const included = new Set<string>();

  // 2) Manifests + infra config.
  const manifests = repo.files.filter((f) => f.content && MANIFEST_RE.test(f.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  const manifestParts: string[] = [];
  for (const f of manifests.slice(0, 20)) {
    const { text } = clip(f.content!, 6_000);
    if (used + text.length > budget * 0.3) break;
    manifestParts.push(`--- ${f.path} ---\n${text}`);
    used += text.length + f.path.length + 10;
    included.add(f.path);
  }
  if (manifestParts.length) sections.push(`=== MANIFESTS & CONFIG ===\n${manifestParts.join("\n\n")}`);

  // 3) README (optional in most assignments, but often the deliverable).
  const readme =
    repo.files.find((f) => f.content && README_RE.test(f.path) && !f.path.includes("/")) ??
    repo.files.find((f) => f.content && README_RE.test(f.path));
  if (readme?.content) {
    const { text } = clip(readme.content, 15_000);
    add(`=== README (${readme.path}) ===\n${text}`);
    included.add(readme.path);
  }

  // 4) Source files by priority, shallow first.
  const candidates = repo.files
    .filter((f): f is RepoFile & { content: string } => f.content !== null && !included.has(f.path))
    .filter((f) => isCode(f.path) || (TEXT_EXT.has(ext(f.path)) && f.size < 20_000 && !/\.(md|txt|csv|lock)$/i.test(f.path)))
    .sort(
      (a, b) =>
        priority(a.path) - priority(b.path) ||
        a.path.split("/").length - b.path.split("/").length ||
        a.path.localeCompare(b.path),
    );

  const sourceParts: string[] = [];
  const omitted: string[] = [];
  for (const f of candidates) {
    const body = f.path.endsWith(".ipynb") ? notebookCode(f.content) : f.content;
    const { text, clipped } = clip(body, perFile);
    const block = `--- FILE: ${f.path} (${kb(f.size)})${clipped ? " [middle truncated]" : ""} ---\n${text}`;
    if (used + block.length > budget) {
      omitted.push(f.path);
      continue;
    }
    sourceParts.push(block);
    used += block.length + 1;
    included.add(f.path);
  }
  if (sourceParts.length) sections.push(`=== SOURCE FILES ===\n${sourceParts.join("\n\n")}`);
  if (omitted.length) {
    sections.push(
      `=== FILES NOT INCLUDED (prompt budget) — do NOT treat features that may live here as missing; mark them "unverified" ===\n${omitted
        .slice(0, 400)
        .join("\n")}${omitted.length > 400 ? `\n… and ${omitted.length - 400} more` : ""}`,
    );
  }

  return { text: sections.join("\n\n"), allPaths, includedCount: included.size, omittedCount: omitted.length };
}

// ── Fingerprint ──────────────────────────────────────────────────────────────

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Hashes of whitespace/comment-normalised source files (≥ 300 chars after
 * normalisation, so trivial files don't count). Two submissions sharing many
 * hashes share whole files verbatim. Capped at 300 per candidate.
 */
export function fingerprint(repo: FetchedRepo): string[] {
  const out = new Set<string>();
  for (const f of repo.files) {
    if (!f.content || !isCode(f.path) || /\.(css|scss|sass|less|html|htm)$/i.test(f.path)) continue;
    const norm = f.content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/^\s*#.*$/gm, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (norm.length < 300) continue;
    out.add(fnv1a(norm));
    if (out.size >= 300) break;
  }
  return Array.from(out);
}

// ── Code metrics ─────────────────────────────────────────────────────────────

const LANGUAGE: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", ipynb: "Python (notebook)", java: "Java", kt: "Kotlin", kts: "Kotlin", go: "Go", rs: "Rust",
  rb: "Ruby", php: "PHP", cs: "C#", c: "C", h: "C", cc: "C++", cpp: "C++", hpp: "C++", swift: "Swift",
  dart: "Dart", scala: "Scala", vue: "Vue", svelte: "Svelte", sql: "SQL", html: "HTML", htm: "HTML",
  css: "CSS", scss: "SCSS", sass: "SCSS", less: "LESS", sh: "Shell", prisma: "Prisma", graphql: "GraphQL",
};

export interface CodeMetrics {
  sourceFiles: number;
  sourceLines: number;
  testFiles: number;
  testLines: number;
  /** e.g. "TypeScript 2,140 lines / 18 files · CSS 420 / 4" (top 5). */
  languages: string;
  /** Three largest source files, "path (N lines)". */
  largestFiles: string[];
  maxDepth: number;
  /** TODO / FIXME / HACK markers left in source. */
  todos: number;
  envExample: boolean;
  usesEnvVars: boolean;
}

/** Deterministic size / shape metrics over the downloaded source — no model involved. */
export function codeMetrics(repo: FetchedRepo): CodeMetrics {
  const byLang = new Map<string, { lines: number; files: number }>();
  const sizes: { path: string; lines: number }[] = [];
  let sourceFiles = 0;
  let sourceLines = 0;
  let testFiles = 0;
  let testLines = 0;
  let todos = 0;
  let usesEnvVars = false;
  let maxDepth = 0;

  for (const f of repo.files) {
    maxDepth = Math.max(maxDepth, f.path.split("/").length - 1);
    if (!f.content || !isCode(f.path)) continue;
    const lines = f.content.split("\n").filter((l) => l.trim()).length;
    if (TEST_RE.test(f.path)) {
      testFiles++;
      testLines += lines;
      continue;
    }
    sourceFiles++;
    sourceLines += lines;
    sizes.push({ path: f.path, lines });
    const lang = LANGUAGE[ext(f.path)] ?? ext(f.path).toUpperCase();
    const agg = byLang.get(lang) ?? { lines: 0, files: 0 };
    agg.lines += lines;
    agg.files += 1;
    byLang.set(lang, agg);
    todos += (f.content.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length;
    if (!usesEnvVars && /process\.env\.|import\.meta\.env|os\.environ|os\.getenv|System\.getenv|dotenv|ConfigService/.test(f.content)) {
      usesEnvVars = true;
    }
  }

  const fmt = (n: number) => n.toLocaleString("en-IN");
  return {
    sourceFiles,
    sourceLines,
    testFiles,
    testLines,
    languages: Array.from(byLang.entries())
      .sort((a, b) => b[1].lines - a[1].lines)
      .slice(0, 5)
      .map(([lang, v]) => `${lang} ${fmt(v.lines)} lines / ${v.files} files`)
      .join(" · "),
    largestFiles: sizes
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 3)
      .map((s) => `${s.path} (${fmt(s.lines)} lines)`),
    maxDepth,
    todos,
    envExample: repo.files.some((f) => /(^|\/)\.?env\.(example|sample|template)$|(^|\/)example\.env$/i.test(f.path)),
    usesEnvVars,
  };
}
