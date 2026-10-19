import { BUCKETS, TECH_CONF, type Bucket } from "@/lib/bucketing/config";

/**
 * Which of the 5 buckets a project satisfies — decided from technologies the
 * project's CODE proves (manifests, imports, config; see github-analysis.ts),
 * never from resume wording. Pure: safe to test on its own.
 *
 * Catalogue keys used here (github-analysis.ts TECHS): react, angular, vue,
 * nodejs, mongodb, sql, django, fastapi-or-flask, spring-boot, java, llm,
 * llm-finetuning, llm-inference, html-css, javascript, dotnet. The synthetic
 * keys below cover what the catalogue has no entry for and the tree shows.
 */

export const SYNTH = {
  /** Next.js API routes — a Node backend without Express. */
  NEXT_API: "next-api",
  /** Servlet / JSP web app. */
  SERVLET_JSP: "servlet-jsp",
  /** Thymeleaf / static pages served by a Java backend. */
  JAVA_TEMPLATES: "java-templates",
  /** Django / Flask / Jinja templates. */
  PY_TEMPLATES: "py-templates",
  /** A database the code owns (ORM models, migrations, schema, SQLite file). */
  DB_FILE: "db-file",
  FIREBASE: "firebase",
} as const;

const SYNTH_PATHS: [string, RegExp][] = [
  [SYNTH.NEXT_API, /(?:^|\/)pages\/api\/.+\.[jt]sx?$|(?:^|\/)app\/api\/(?:.+\/)?route\.[jt]sx?$/i],
  [SYNTH.SERVLET_JSP, /\.jsp$|(?:^|\/)WEB-INF\/web\.xml$/i],
  [SYNTH.JAVA_TEMPLATES, /(?:^|\/)src\/main\/resources\/(?:templates|static)\/.+\.(?:html|js)$/i],
  [SYNTH.PY_TEMPLATES, /(?:^|\/)templates\/.+\.html?$/i],
  [SYNTH.DB_FILE, /\.(?:sqlite3?|db)$|(?:^|\/)schema\.prisma$|(?:^|\/)models\.py$|(?:^|\/)migrations\/|(?:^|\/)models\/[^/]+\.(?:js|ts)$|(?:^|\/)entity\/[^/]+\.java$/i],
  [SYNTH.FIREBASE, /(?:^|\/)firebase\.json$|(?:^|\/)\.firebaserc$/i],
];

const SYNTH_DEPS: [string, RegExp][] = [
  [SYNTH.SERVLET_JSP, /^(?:javax\.servlet-api|jakarta\.servlet-api|javax-servlet-api|jakarta-servlet-api|servlet-api)$/i],
  [SYNTH.JAVA_TEMPLATES, /^spring-boot-starter-thymeleaf$/i],
  [SYNTH.FIREBASE, /^(?:firebase|firebase-admin|@firebase\/app)$/i],
];

/** Words in a resume's own project / role text that map to the synthetic keys (claims only). */
const SYNTH_WORDS: [string, RegExp][] = [
  [SYNTH.SERVLET_JSP, /\b(?:jsp|servlets?|j2ee)\b/i],
  [SYNTH.JAVA_TEMPLATES, /\bthymeleaf\b/i],
  [SYNTH.PY_TEMPLATES, /\b(?:jinja2?|django templates?)\b/i],
  [SYNTH.FIREBASE, /\bfirebase|firestore\b/i],
  [SYNTH.NEXT_API, /\bnext\.?js api|api routes\b/i],
];

export function synthFromRepo(paths: string[], deps: string[]): string[] {
  const out = new Set<string>();
  for (const [key, re] of SYNTH_PATHS) if (paths.some((p) => re.test(p))) out.add(key);
  for (const [key, re] of SYNTH_DEPS) if (deps.some((d) => re.test(d))) out.add(key);
  return [...out];
}

export function synthFromText(text: string): string[] {
  return SYNTH_WORDS.filter(([, re]) => re.test(text ?? "")).map(([key]) => key);
}

/** Proven catalogue technologies (confidence + hard evidence) plus the synthetic keys. */
export function provenTechSet(techs: { key: string; conf: number; hard: boolean }[], synth: string[]): Set<string> {
  const s = new Set<string>(synth);
  for (const t of techs) if (t.hard && t.conf >= TECH_CONF) s.add(t.key);
  return s;
}

const has = (s: Set<string>, ...keys: string[]) => keys.some((k) => s.has(k));

/** The project has a server of its own (BaaS such as Firebase does not count). */
export function hasBackend(s: Set<string>): boolean {
  return has(s, "nodejs", "django", "fastapi-or-flask", "spring-boot", "dotnet", SYNTH.NEXT_API, SYNTH.SERVLET_JSP);
}

const jsFrontend = (s: Set<string>) => has(s, "react", "angular", "vue");
const plainWebUi = (s: Set<string>) => s.has("html-css") && s.has("javascript");
const database = (s: Set<string>) => has(s, "sql", "mongodb", SYNTH.DB_FILE);

/** Every bucket rule (config.BUCKET_RULE) this technology set satisfies. */
export function bucketsFor(s: Set<string>): Bucket[] {
  const out: Bucket[] = [];
  if (s.has("react") && has(s, "nodejs", SYNTH.NEXT_API) && s.has("mongodb")) out.push("MERN");
  if (
    has(s, "django", "fastapi-or-flask") &&
    (jsFrontend(s) || s.has(SYNTH.PY_TEMPLATES) || s.has("html-css")) &&
    database(s)
  ) {
    out.push("PYTHON_FS");
  }
  if (
    has(s, "spring-boot", SYNTH.SERVLET_JSP) &&
    (jsFrontend(s) || has(s, SYNTH.JAVA_TEMPLATES, SYNTH.SERVLET_JSP) || s.has("html-css")) &&
    database(s)
  ) {
    out.push("JAVA_FS");
  }
  if (has(s, "llm", "llm-finetuning", "llm-inference")) out.push("GENAI");
  if ((jsFrontend(s) || plainWebUi(s)) && !hasBackend(s)) out.push("FRONTEND");
  return out.filter((b) => (BUCKETS as readonly string[]).includes(b));
}

/** Human-readable reason a technology set does / doesn't meet a bucket — for verifier issues and remarks. */
export function missingFor(bucket: Bucket, s: Set<string>): string[] {
  const miss: string[] = [];
  switch (bucket) {
    case "MERN":
      if (!s.has("react")) miss.push("React");
      if (!has(s, "nodejs", SYNTH.NEXT_API)) miss.push("Node/Express backend");
      if (!s.has("mongodb")) miss.push("MongoDB");
      break;
    case "PYTHON_FS":
      if (!has(s, "django", "fastapi-or-flask")) miss.push("Django/Flask/FastAPI backend");
      if (!(jsFrontend(s) || s.has(SYNTH.PY_TEMPLATES) || s.has("html-css"))) miss.push("frontend");
      if (!database(s)) miss.push("database");
      break;
    case "JAVA_FS":
      if (!has(s, "spring-boot", SYNTH.SERVLET_JSP)) miss.push("Spring Boot / Servlet backend");
      if (!(jsFrontend(s) || has(s, SYNTH.JAVA_TEMPLATES, SYNTH.SERVLET_JSP) || s.has("html-css"))) miss.push("frontend");
      if (!database(s)) miss.push("database");
      break;
    case "GENAI":
      if (!has(s, "llm", "llm-finetuning", "llm-inference")) miss.push("an LLM SDK / framework called in code");
      break;
    case "FRONTEND":
      if (!(jsFrontend(s) || plainWebUi(s))) miss.push("a UI framework or HTML+JS UI");
      if (hasBackend(s)) miss.push("no backend of its own (it has one)");
      break;
  }
  return miss;
}
