/**
 * Candidate feedback documents (PSM 1.13.0) — job skills and whether a resume shows them. Pure, no
 * I/O; tested in scripts/feedback-selftest.ts.
 *
 * A job's skills come from the CRPs master's Tech Stack cell as typed ("Python, SQL, Excel/Google
 * Sheets", "AWS, Azure, Google Cloud Platform (GCP)"). Before the document says a skill is missing,
 * the resume text is searched for it and its usual names (React js → React; AI/ML → machine learning,
 * scikit-learn, TensorFlow …): a skill is only "not shown" when none of them is anywhere in the text,
 * and only "not used in any project" when it is in the text but not in the projects / experience part
 * (resume-sections.ts takes the Skills list and the summary out). Soft or vague items ("operations",
 * "quantitative reasoning") are never called missing: they can't be checked by reading.
 */

export interface JobSkill {
  /** As shown in the document ("React", "SQL", "Excel or Google Sheets"). */
  label: string;
  /** Lower-case names that count as this skill (the item itself first). */
  terms: string[];
  /** A technology that can be checked by reading (not a soft skill). */
  checkable: boolean;
}

/** Usual names of common skills (keys and values lower case; the key itself always counts). */
const ALIASES: Record<string, string[]> = {
  "react js": ["react", "reactjs", "react.js"],
  react: ["react", "reactjs", "react.js"],
  reactjs: ["react", "react.js"],
  "react native": ["react native", "react-native"],
  "node js": ["node", "nodejs", "node.js", "express"],
  nodejs: ["node", "node.js", "express"],
  "node.js": ["node", "nodejs", "express"],
  node: ["node.js", "nodejs"],
  "express.js": ["express", "expressjs"],
  express: ["express.js", "expressjs"],
  "next.js": ["next.js", "nextjs", "next js"],
  "next js": ["next.js", "nextjs"],
  "vue.js": ["vue", "vuejs"],
  vue: ["vue.js", "vuejs"],
  angular: ["angular", "angularjs"],
  "mern stack": ["mern", "mongodb", "express", "react", "node"],
  mern: ["mongodb", "express", "react", "node"],
  "mean stack": ["mean", "mongodb", "express", "angular", "node"],
  javascript: ["javascript", "ecmascript", "es6", "typescript"],
  typescript: ["typescript"],
  html: ["html", "html5"],
  css: ["css", "css3", "tailwind", "bootstrap", "sass", "scss"],
  python: ["python"],
  java: ["java"],
  "c++": ["c++", "cpp"],
  "c#": ["c#", ".net", "dotnet"],
  ".net": [".net", "dotnet", "asp.net", "c#"],
  go: ["golang", "go lang"],
  golang: ["golang", "go lang"],
  rust: ["rust"],
  kotlin: ["kotlin"],
  swift: ["swift", "swiftui"],
  flutter: ["flutter", "dart"],
  dart: ["dart", "flutter"],
  php: ["php", "laravel"],
  django: ["django"],
  flask: ["flask"],
  fastapi: ["fastapi", "fast api"],
  "spring boot": ["spring boot", "springboot", "spring"],
  spring: ["spring", "spring boot"],
  sql: ["sql", "mysql", "postgresql", "postgres", "sqlite", "oracle", "t-sql", "pl/sql", "sql server", "mssql"],
  mysql: ["mysql", "sql"],
  postgresql: ["postgresql", "postgres"],
  "pl/sql": ["pl/sql", "plsql"],
  mongodb: ["mongodb", "mongo db", "mongoose"],
  nosql: ["nosql", "mongodb", "dynamodb", "cassandra", "redis", "firebase"],
  redis: ["redis"],
  kafka: ["kafka"],
  graphql: ["graphql"],
  "rest apis": ["rest", "restful", "rest api", "api"],
  "rest api": ["rest", "restful", "api"],
  apis: ["api", "rest", "restful"],
  aws: ["aws", "amazon web services", "ec2", "s3", "lambda", "dynamodb", "cloudformation"],
  azure: ["azure", "microsoft azure"],
  "google cloud platform (gcp)": ["gcp", "google cloud", "bigquery", "firebase"],
  gcp: ["gcp", "google cloud", "bigquery"],
  "google cloud": ["gcp", "google cloud"],
  cloudformation: ["cloudformation"],
  terraform: ["terraform"],
  ansible: ["ansible"],
  docker: ["docker", "container", "containerized", "containerised"],
  kubernetes: ["kubernetes", "k8s", "eks", "aks", "gke", "helm"],
  devops: ["devops", "docker", "kubernetes", "ci/cd", "jenkins", "github actions", "terraform", "ansible"],
  "ci/cd": ["ci/cd", "cicd", "jenkins", "github actions", "gitlab ci", "pipeline"],
  linux: ["linux", "ubuntu", "unix", "bash", "shell scripting", "shell script"],
  git: ["git", "github", "gitlab"],
  "ai/ml": ["machine learning", "deep learning", "artificial intelligence", "ml", "ai", "scikit-learn", "sklearn", "tensorflow", "pytorch", "keras", "neural network", "nlp", "computer vision", "xgboost", "regression", "classification"],
  "ai ml": ["machine learning", "deep learning", "artificial intelligence", "scikit-learn", "tensorflow", "pytorch"],
  "machine learning": ["machine learning", "ml", "scikit-learn", "sklearn", "tensorflow", "pytorch", "xgboost", "regression", "classification"],
  ml: ["machine learning", "scikit-learn", "sklearn", "tensorflow", "pytorch"],
  "deep learning": ["deep learning", "neural network", "cnn", "rnn", "lstm", "tensorflow", "pytorch", "keras"],
  ai: ["artificial intelligence", "machine learning", "llm", "genai"],
  genai: ["genai", "gen ai", "generative ai", "llm", "gpt", "openai", "gemini", "langchain", "rag", "prompt engineering", "hugging face", "transformers", "llama"],
  "generative ai": ["generative ai", "genai", "llm", "gpt", "openai", "langchain", "rag"],
  "ai native": ["genai", "generative ai", "llm", "ai agent", "agentic", "langchain", "openai", "gemini"],
  llm: ["llm", "large language model", "gpt", "openai", "gemini", "llama", "claude", "langchain", "rag", "prompt engineering", "hugging face"],
  "fine-tuning": ["fine-tuning", "fine tuning", "finetuning", "lora", "peft"],
  "fine tuning": ["fine-tuning", "fine tuning", "finetuning", "lora", "peft"],
  llms: ["llm", "large language model", "gpt", "openai", "gemini", "langchain"],
  rag: ["rag", "retrieval augmented", "retrieval-augmented", "vector database", "vector db", "embeddings", "faiss", "pinecone", "chroma", "chromadb", "weaviate"],
  langchain: ["langchain", "lang chain", "langgraph"],
  "agentic ai": ["agentic", "ai agent", "ai agents", "multi-agent", "langgraph", "crewai", "autogen", "tool calling", "function calling", "mcp"],
  "prompt engineering": ["prompt engineering", "prompting", "prompt design"],
  pytorch: ["pytorch", "torch"],
  tensorflow: ["tensorflow", "keras"],
  numpy: ["numpy"],
  pandas: ["pandas"],
  "scikit-learn": ["scikit-learn", "sklearn", "scikit learn"],
  nlp: ["nlp", "natural language processing", "spacy", "nltk", "transformers"],
  "computer vision": ["computer vision", "opencv", "image processing", "yolo", "cnn"],
  dsa: ["data structures", "algorithms", "dsa", "leetcode", "codeforces", "codechef", "competitive programming", "hackerrank"],
  "data structures": ["data structures", "dsa", "algorithms"],
  excel: ["excel", "ms excel", "microsoft excel", "spreadsheet", "google sheets"],
  "advanced excel": ["excel", "pivot table", "vlookup", "xlookup", "spreadsheet"],
  "excel/google sheets": ["excel", "google sheets", "spreadsheet"],
  "google sheets": ["google sheets", "excel", "spreadsheet"],
  "power bi": ["power bi", "powerbi"],
  tableau: ["tableau"],
  looker: ["looker"],
  "tableau/looker/power bi": ["tableau", "looker", "power bi", "powerbi"],
  "data analysis": ["data analysis", "data analytics", "analytics", "pandas", "excel", "dashboard", "power bi", "tableau", "eda"],
  "data analytics": ["data analytics", "data analysis", "analytics", "dashboard", "power bi", "tableau"],
  statistics: ["statistics", "statistical", "hypothesis testing", "regression"],
  snowflake: ["snowflake"],
  databricks: ["databricks"],
  spark: ["spark", "pyspark"],
  pyspark: ["pyspark", "spark"],
  airflow: ["airflow"],
  etl: ["etl", "elt", "data pipeline", "airflow"],
  selenium: ["selenium"],
  "automation testing": ["selenium", "cypress", "playwright", "automation testing", "test automation", "automated testing", "pytest", "junit", "testng", "appium"],
  "manual testing": ["manual testing", "test cases", "test case", "bug report", "jira"],
  testing: ["testing", "test cases", "selenium", "pytest", "junit", "jest"],
  figma: ["figma"],
  "ui/ux": ["ui/ux", "ux", "ui design", "figma", "wireframe", "prototype"],
  networking: ["networking", "tcp", "udp", "tcp/ip", "socket", "network"],
  "operating systems": ["operating system", "operating systems", "os", "process scheduling", "threads"],
  oops: ["oops", "oop", "object oriented", "object-oriented"],
  "system design": ["system design", "scalable", "microservices", "load balancer", "caching"],
  microservices: ["microservices", "microservice"],
  firebase: ["firebase"],
  android: ["android"],
  ios: ["ios", "swift"],
  c: ["c programming", "c language"],
  "c/c++": ["c++", "cpp"],
  jenkins: ["jenkins"],
  jira: ["jira"],
  postman: ["postman"],
  hadoop: ["hadoop"],
  dbt: ["dbt"],
  bigquery: ["bigquery", "big query"],
  opencv: ["opencv"],
  laravel: ["laravel"],
  ruby: ["ruby", "ruby on rails"],
  rails: ["rails", "ruby on rails"],
  scala: ["scala"],
  matlab: ["matlab"],
  r: ["r programming", "rstudio", "ggplot"],
  cypress: ["cypress"],
  playwright: ["playwright"],
  pytest: ["pytest"],
  junit: ["junit"],
  json: ["json"],
  "tailwind css": ["tailwind"],
  bootstrap: ["bootstrap"],
  redux: ["redux"],
  hibernate: ["hibernate"],
  "data visualization": ["data visualization", "data visualisation", "dashboard", "power bi", "tableau", "matplotlib", "seaborn", "plotly"],
  matplotlib: ["matplotlib"],
  seaborn: ["seaborn"],
  "hugging face": ["hugging face", "huggingface", "transformers"],
  openai: ["openai", "gpt"],
  "vector databases": ["vector database", "vector db", "faiss", "pinecone", "chroma", "weaviate", "qdrant"],
  "vector database": ["vector database", "vector db", "faiss", "pinecone", "chroma", "weaviate", "qdrant"],
  mcp: ["mcp", "model context protocol"],
  langgraph: ["langgraph"],
  crewai: ["crewai", "crew ai"],
};

/** Words that make an item a soft skill or a vague area (never reported as missing). */
const SOFT = /\b(reasoning|problem[- ]solving|governance|operations?|communication|management|stakeholder|leadership|teamwork|analytical|thinking|attitude|ownership|aptitude|logical|business acumen|presentation|negotiation|research|documentation|planning|strategy|coordination|interpersonal)\b/i;

/** Names written with a slash that are one thing, not alternatives. */
const COMPOUND = /^(ai\/ml|ci\/cd|pl\/sql|ui\/ux|tcp\/ip|i\/o|a\/b testing|excel\/google sheets|tableau\/looker\/power bi)$/;

/** Words around a skill that don't change it: "MS Excel", "Core Java", "Python programming", "HTML5". */
function bareKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^(ms|microsoft|core|basic|basics of|strong|good|knowledge of|proficiency in|hands-on|hands on|experience (?:with|in)|working knowledge of)\s+/, "")
    .replace(/\s+(programming|language|skills?|basics|fundamentals|concepts|framework|library)$/, "")
    .replace(/^(html|css|python|es)\s*(\d+)$/, "$1")
    .trim();
}

/**
 * Splits a Tech Stack cell into skills: "Python (Pandas, NumPy), HTML, CSS & JavaScript, React + Node.js,
 * Excel/Google Sheets, Python or Java" → Python · Pandas · NumPy · HTML · CSS · JavaScript · React ·
 * Node.js · Excel or Google Sheets · Python or Java. A skill can only be reported missing when every
 * name in it is a known skill (ALIASES): an unknown or vague item is never called missing.
 */
export function jobSkills(techStack: string): JobSkill[] {
  const expanded = techStack
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    // "Python (Pandas, NumPy)" → "Python, Pandas, NumPy"; "Google Cloud Platform (GCP)" stays one skill.
    .replace(/([^,;(]+?)\s*\(([^)]*[,/][^)]*)\)/g, (_m, head: string, inner: string) => `${head}, ${inner.replace(/\//g, ",")}`)
    // "CSS & JavaScript", "React + Node.js": two skills ("C++" keeps its pluses).
    .replace(/\s*&\s*/g, ", ")
    .replace(/\s+\+\s+/g, ", ");
  const raw = expanded
    .split(/\s*(?:,|;|\n|\||\band\b(?![-/]))\s*/i)
    .map((x) => x.replace(/^[\s•\-*·]+|[\s.]+$/g, "").trim())
    .filter((x) => x.length >= 1 && x.length <= 60);
  const out: JobSkill[] = [];
  for (const item of raw) {
    const key = item.toLowerCase();
    if (out.some((o) => o.terms[0] === key)) continue;
    // Alternatives: "Excel/Google Sheets", "Python or Java", "C/C++": any one of them is enough.
    const alternatives = COMPOUND.test(key) || ALIASES[key] ? [key] : key.split(/\s*(?:\/|\bor\b)\s*/).map((x) => x.trim()).filter(Boolean);
    const resolved = alternatives.map((a) => {
      const b = bareKey(a);
      const k = ALIASES[a] ? a : ALIASES[b] ? b : ALIASES[b.replace(/\s*\([^)]*\)\s*/g, " ").trim()] ? b.replace(/\s*\([^)]*\)\s*/g, " ").trim() : null;
      return { a, b, k };
    });
    const terms = [...new Set([key, ...resolved.flatMap((r) => [r.a, r.b, ...(r.k ? [r.k, ...ALIASES[r.k]] : [])])])].filter(Boolean);
    const checkable = !SOFT.test(item) && resolved.every((r) => r.k !== null);
    out.push({ label: displayLabel(item, alternatives.length > 1 ? alternatives : []), terms, checkable });
  }
  return out.slice(0, 20);
}

/** "React js" → "React", "Node js" → "Node.js", "Excel/Google Sheets" → "Excel or Google Sheets". */
function displayLabel(item: string, parts: string[]): string {
  const t = item.trim();
  if (/^react\s*js$/i.test(t)) return "React";
  if (/^node\s*js$/i.test(t)) return "Node.js";
  if (/^next\s*js$/i.test(t)) return "Next.js";
  if (/^express(\.js)?$/i.test(t)) return "Express";
  if (/^google cloud platform \(gcp\)$/i.test(t)) return "Google Cloud";
  if (/^excel\/google sheets$/i.test(t)) return "Excel or Google Sheets";
  if (/^tableau\/looker\/power bi$/i.test(t)) return "Tableau, Looker or Power BI";
  if (parts.length > 1) {
    const shown = t.split(/\s*(?:\/|\bor\b)\s*/i).map((p) => p.trim()).filter(Boolean);
    return shown.length === 2 ? `${shown[0]} or ${shown[1]}` : `${shown.slice(0, -1).join(", ")} or ${shown[shown.length - 1]}`;
  }
  return t;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One name of a skill in a text: as a whole word (so "java" isn't found in "javascript", "c" only as
 * the letter on its own, "react" not in "reactive"). Case-insensitive except for "c" and "r" (one
 * letter: only the capital letter alone counts).
 */
export function termInText(term: string, text: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  if (t === "c" || t === "r") {
    // "C", "C," "C Programming" — never "C++", "C#", "c/o", initials ("C. Ramesh") or "C-DAC".
    const re = new RegExp(String.raw`(?<![A-Za-z0-9+#./-])${t.toUpperCase()}(?![A-Za-z0-9+#.]|\s*\+\+|-[A-Za-z])`);
    return re.test(text) || new RegExp(String.raw`\b${t} (programming|language)\b`, "i").test(text);
  }
  if (t === "java") return /\bjava\b(?!\s*script)/i.test(text);
  // "Go" the language: the capitalised word on its own ("go" is an everyday word).
  if (t === "go") return /(?<![A-Za-z0-9])Go(?![A-Za-z0-9])/.test(text);
  if (t === "ml" || t === "ai" || t === "os" || t === "ux" || t === "api") {
    return new RegExp(String.raw`(?<![A-Za-z0-9])${t.toUpperCase()}(?![A-Za-z0-9])`).test(text) || new RegExp(String.raw`\b${t}s?\b`, "i").test(text) && t !== "ai" && t !== "os";
  }
  const left = /^[a-z0-9]/.test(t) ? String.raw`(?<![a-z0-9])` : "";
  const right = /[a-z0-9]$/.test(t) ? String.raw`(?![a-z0-9])` : "";
  return new RegExp(`${left}${esc(t).replace(/\s+/g, String.raw`[\s\-_.]*`)}${right}`, "i").test(text);
}

/** Any name of the skill in the text. */
export const skillInText = (s: Pick<JobSkill, "terms">, text: string) => s.terms.some((t) => termInText(t, text));

export type SkillShown = "in_projects" | "listed_only" | "not_shown";

/**
 * Where a resume shows a skill: in its projects / experience ([evidence]: the text without the Skills
 * list and the summary), only in the Skills list or summary, or nowhere.
 */
export function skillShown(skill: Pick<JobSkill, "terms">, fullText: string, evidence: string): SkillShown {
  if (skillInText(skill, evidence)) return "in_projects";
  if (skillInText(skill, fullText)) return "listed_only";
  return "not_shown";
}

/** "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/**
 * Skills a job lists as alternatives of each other (any one will do): when the resume shows one of
 * them, the others aren't reported as missing.
 */
const ALTERNATIVES: string[][] = [
  ["aws", "azure", "gcp", "google cloud", "google cloud platform (gcp)"],
  ["power bi", "powerbi", "tableau", "looker"],
  ["react", "react js", "reactjs", "angular", "vue", "vue.js"],
  ["django", "flask", "fastapi"],
  ["pytorch", "tensorflow", "keras"],
  ["excel", "google sheets", "excel/google sheets", "advanced excel"],
];

/**
 * The listed skills worth reporting as missing (or only listed): [where] is where the resume shows
 * each of the job's skills; a skill whose alternative is shown is dropped.
 */
/** The alternatives group of a skill's names (-1: none). */
export const alternativeGroup = (terms: string[]) => ALTERNATIVES.findIndex((g) => terms.some((t) => g.includes(t.toLowerCase())));

export function withoutShownAlternatives(skills: { skill: JobSkill; where: SkillShown }[], keep: SkillShown): JobSkill[] {
  const groupOf = (s: JobSkill) => alternativeGroup(s.terms);
  const better = (w: SkillShown) => (keep === "not_shown" ? w !== "not_shown" : w === "in_projects");
  return skills
    .filter((x) => x.where === keep)
    .filter((x) => {
      const g = groupOf(x.skill);
      return g < 0 || !skills.some((o) => o !== x && groupOf(o.skill) === g && better(o.where));
    })
    .map((x) => x.skill);
}

/** Areas of work, for "apply for … roles": from a job's role title. */
export function roleFamily(role: string): string | null {
  const t = role.toLowerCase();
  if (/\b(sdet|qa|quality|test(ing|er)?)\b/.test(t)) return "QA and testing";
  if (/\bdata engineer/.test(t)) return "data engineering";
  if (/\b(data analyst|data analytics|business intelligence|bi analyst|analyst intern|data apprentice)\b/.test(t)) return "data analytics";
  if (/\bbusiness analyst\b/.test(t)) return "business analysis";
  if (/\b(data scien|machine learning|\bml\b|\bai\b|genai|llm|agentic|prompt|nlp|computer vision|ai\/ml)/.test(t)) return "AI and machine learning";
  if (/\b(product manager|product management|apm|product intern|product analyst|founder'?s office)\b/.test(t)) return "product";
  if (/\b(devops|cloud|sre|site reliability|platform engineer|infrastructure)\b/.test(t)) return "cloud and DevOps";
  if (/\b(full ?stack|fullstack|fsd|mern)\b/.test(t)) return "full stack development";
  if (/\b(front ?end|frontend|ui developer|react)\b/.test(t)) return "frontend development";
  if (/\b(back ?end|backend|api developer|node|java developer|python developer)\b/.test(t)) return "backend development";
  if (/\b(android|ios|mobile|flutter|react native)\b/.test(t)) return "mobile development";
  if (/\b(network|embedded|systems?)\b/.test(t)) return "systems and networking";
  if (/\b(sde|software|developer|engineer|programmer|apprentice)\b/.test(t)) return "software development";
  return null;
}
